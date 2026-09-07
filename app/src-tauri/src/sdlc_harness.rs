//! Durable SDD harness runs.
//!
//! This module deliberately keeps the Herdr process as the source of truth for a
//! live pane, while the vault is the source of truth for ownership and history.
//! A run is written before any external process is touched, so a desktop restart
//! can safely reattach using the recorded session, agent name, kind, and pane.

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, OnceLock},
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    config,
    herdr::{self, AgentInfo, Herdr},
    sdlc::{self, HarnessRun, LaunchInput},
    workflow::{self, WorkflowDefinition, WorkflowNode},
};

const RUN_SCHEMA: u32 = 1;
const MAX_INBOX_PER_TICK: usize = 8;
const MAX_OUTPUT_SNAPSHOT: usize = 24_000;
/// The closing report is read in a panel, not a terminal: keep it short enough
/// to scan and leave the full history to the transcript.
const MAX_FINAL_REPORT: usize = 6_000;
/// A root, child, and grandchild are enough to retain useful decomposition
/// without allowing a run tree to fan out indefinitely.
const MAX_PARENT_DEPTH: usize = 2;
const RUN_LOCK_STRIPES: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    schema_version: u32,
    id: String,
    work_id: String,
    project_id: String,
    role: String,
    agent: String,
    model: String,
    parent_run_id: Option<String>,
    stage: String,
    #[serde(default)]
    workflow_id: String,
    #[serde(default)]
    workflow_version: String,
    #[serde(default)]
    workflow_digest: String,
    #[serde(default)]
    workflow_instance_id: Option<String>,
    #[serde(default)]
    node_run_id: Option<String>,
    status: String,
    agent_name: String,
    pane_id: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<String>,
    /// The configured Herdr session. Empty config is represented as `default`.
    session: String,
    /// A Claude session id when applicable. It is an extra identity check, never
    /// a replacement for the exact recorded pane/name/kind.
    agent_session: Option<String>,
    prompt: String,
    repo_path: String,
    /// 프로젝트가 launch 때 신뢰한 추가 디렉터리. `--add-dir` 인자는 여기서
    /// 다시 조립하므로 재시작 뒤에도 같은 스코프가 유지된다.
    #[serde(default)]
    extra_paths: Vec<String>,
    output_path: String,
    created_at: String,
    updated_at: String,
    error: Option<String>,
    owned: bool,
    #[serde(default)]
    inbox_request_id: Option<String>,
    #[serde(default)]
    cancel_requested: bool,
    /// When the pane was closed after the run settled. The record, the transcript,
    /// and the final report survive; only the terminal screen is gone.
    #[serde(default)]
    tab_closed_at: Option<String>,
    /// The last agent output captured immediately before closing the pane, so the
    /// human can read the agent's closing report without a live terminal.
    #[serde(default)]
    final_report: Option<String>,
    /// Last time the recorded session was reopened in herdr from the dashboard.
    #[serde(default)]
    resumed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildRequest {
    request_id: String,
    parent_run_id: String,
    work_id: String,
    project_id: String,
    role: String,
    #[serde(default)]
    agent: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    instructions: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    updated_at: String,
}

fn launch_mutex() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn run_lock(id: &str) -> &'static tokio::sync::Mutex<()> {
    use std::{
        collections::hash_map::DefaultHasher,
        hash::{Hash, Hasher},
    };
    static LOCKS: OnceLock<Vec<tokio::sync::Mutex<()>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| {
        (0..RUN_LOCK_STRIPES)
            .map(|_| tokio::sync::Mutex::new(()))
            .collect()
    });
    let mut hasher = DefaultHasher::new();
    id.hash(&mut hasher);
    &locks[(hasher.finish() as usize) % RUN_LOCK_STRIPES]
}

fn starting_runs() -> &'static Mutex<HashSet<String>> {
    static STARTING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    STARTING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn start_is_local(id: &str) -> bool {
    starting_runs()
        .lock()
        .map(|runs| runs.contains(id))
        .unwrap_or(false)
}

fn spawn_start(root: PathBuf, id: String) {
    let inserted = starting_runs()
        .lock()
        .map(|mut runs| runs.insert(id.clone()))
        .unwrap_or(false);
    if !inserted {
        return;
    }
    tauri::async_runtime::spawn(async move {
        start_record(root, id.clone()).await;
        if let Ok(mut runs) = starting_runs().lock() {
            runs.remove(&id);
        }
    });
}

impl RunRecord {
    fn public(&self) -> HarnessRun {
        HarnessRun {
            id: self.id.clone(),
            work_id: self.work_id.clone(),
            project_id: self.project_id.clone(),
            role: self.role.clone(),
            agent: self.agent.clone(),
            model: self.model.clone(),
            parent_run_id: self.parent_run_id.clone(),
            stage: self.stage.clone(),
            workflow_id: self.workflow_id.clone(),
            workflow_version: self.workflow_version.clone(),
            workflow_digest: self.workflow_digest.clone(),
            workflow_instance_id: self.workflow_instance_id.clone(),
            node_run_id: self.node_run_id.clone(),
            status: self.status.clone(),
            agent_name: self.agent_name.clone(),
            pane_id: self.pane_id.clone(),
            workspace_id: self.workspace_id.clone(),
            session: self.session.clone(),
            prompt: self.prompt.clone(),
            extra_paths: self.extra_paths.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            error: self.error.clone(),
            agent_session: self.agent_session.clone(),
            tab_closed_at: self.tab_closed_at.clone(),
            final_report: self.final_report.clone(),
            resumable: self.resumable(),
        }
    }

    /// Only `claude` is started with an id we minted (`--session-id`), so it is
    /// the only kind we can hand back to its CLI as `--resume`.
    fn resumable(&self) -> bool {
        self.agent == "claude" && self.agent_session.is_some()
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn run_agent_name(id: &str) -> String {
    // Herdr allows lower-case alphanumeric, `_`, and `-`, max 32 characters.
    let compact: String = id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    format!("sdd_{}", &compact[..compact.len().min(24)])
}

fn valid_role(role: &str) -> bool {
    matches!(
        role,
        "research" | "planner" | "implementer" | "verifier" | "reviewer"
    )
}

fn valid_agent(agent: &str) -> bool {
    matches!(agent, "claude" | "codex")
}

fn active_status(status: &str) -> bool {
    matches!(status, "starting" | "running" | "blocked")
}

fn refreshable_status(status: &str) -> bool {
    active_status(status) || status == "unknown"
}

fn occupies_slot(status: &str) -> bool {
    refreshable_status(status)
}

fn status_for_agent(agent_status: &str) -> &'static str {
    match agent_status {
        "working" => "running",
        "blocked" => "blocked",
        // Settling a terminal turn only queues a human review. It never says
        // that verification passed or that the work item is complete.
        "idle" | "done" => "review",
        _ => "unknown",
    }
}

fn can_continue(record_status: &str, agent_status: &str) -> bool {
    record_status == "review" && matches!(agent_status, "idle" | "done")
}

fn allowed_human_key(key: &str) -> bool {
    matches!(
        key,
        "enter" | "esc" | "up" | "down" | "left" | "right" | "tab" | "1" | "2" | "3" | "y" | "n"
    )
}

fn substantive(markdown: &str) -> bool {
    markdown
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("<!--"))
        .map(|line| line.trim_matches(|c: char| "-*`_ ".contains(c)))
        .any(|line| line.chars().count() >= 12)
}

fn checked_run_id(id: &str) -> Result<(), String> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "유효하지 않은 실행 ID입니다".into())
}

fn runs_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = root.join("runs");
    if let Ok(metadata) = fs::symlink_metadata(&dir) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("runs 경로가 안전한 디렉터리가 아닙니다".into());
        }
    } else {
        fs::create_dir_all(&dir).map_err(|e| format!("runs 디렉터리를 만들 수 없습니다: {e}"))?;
    }
    Ok(dir)
}

fn record_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    checked_run_id(id)?;
    Ok(runs_dir(root)?.join(format!("{id}.md")))
}

fn transcript_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    checked_run_id(id)?;
    Ok(runs_dir(root)?.join(format!("{id}.transcript.md")))
}

fn cancel_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    checked_run_id(id)?;
    Ok(runs_dir(root)?.join(format!("{id}.cancel")))
}

fn request_cancel(root: &Path, id: &str) -> Result<(), String> {
    atomic_write(
        &cancel_path(root, id)?,
        &format!("requestedAt: {}\n", now()),
    )
}

fn cancellation_requested(root: &Path, record: &RunRecord) -> Result<bool, String> {
    let path = cancel_path(root, &record.id)?;
    reject_symlink(&path)?;
    Ok(record.cancel_requested || path.is_file())
}

fn clear_cancel(root: &Path, id: &str) -> Result<(), String> {
    let path = cancel_path(root, id)?;
    reject_symlink(&path)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| format!("취소 표식을 지울 수 없습니다: {e}"))?;
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() {
            return Err("심볼릭 링크를 통해 실행 기록을 읽거나 쓸 수 없습니다".into());
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    reject_symlink(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "실행 기록 경로가 잘못되었습니다".to_string())?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("run"),
        Uuid::new_v4()
    ));
    fs::write(&tmp, content).map_err(|e| format!("실행 기록을 쓸 수 없습니다: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("실행 기록을 확정할 수 없습니다: {e}"))
}

fn record_markdown(record: &RunRecord) -> Result<String, String> {
    let yaml = serde_yaml::to_string(record)
        .map_err(|e| format!("실행 기록을 직렬화할 수 없습니다: {e}"))?;
    Ok(format!(
        "---\n{}---\n\n# SDD Harness Run\n\n이 파일은 Sawhorse가 소유한 Herdr 실행의 내구성 있는 기록입니다.\n\n- 상태: `{}`\n- 출력: `{}`\n- Herdr tab: `{}`\n",
        yaml, record.status, record.output_path, record.tab_id.as_deref().unwrap_or(""),
    ))
}

fn save_record(root: &Path, record: &RunRecord) -> Result<(), String> {
    let path = record_path(root, &record.id)?;
    atomic_write(&path, &record_markdown(record)?)
}

fn load_record(root: &Path, id: &str) -> Result<RunRecord, String> {
    let path = record_path(root, id)?;
    reject_symlink(&path)?;
    let body =
        fs::read_to_string(&path).map_err(|e| format!("실행 기록을 읽을 수 없습니다: {e}"))?;
    let Some(rest) = body.strip_prefix("---\n") else {
        return Err("실행 기록 frontmatter가 없습니다".into());
    };
    let Some((yaml, _)) = rest.split_once("\n---\n") else {
        return Err("실행 기록 frontmatter가 닫히지 않았습니다".into());
    };
    let record: RunRecord = serde_yaml::from_str(yaml)
        .map_err(|e| format!("실행 기록 frontmatter가 손상되었습니다: {e}"))?;
    if record.schema_version != RUN_SCHEMA || record.id != id || !record.owned {
        return Err("지원하지 않거나 Sawhorse 소유가 아닌 실행 기록입니다".into());
    }
    Ok(record)
}

fn list_records(root: &Path) -> Result<Vec<RunRecord>, String> {
    let dir = runs_dir(root)?;
    let mut records = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| format!("실행 목록을 읽을 수 없습니다: {e}"))?
    {
        let entry = entry.map_err(|e| format!("실행 목록 항목을 읽을 수 없습니다: {e}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.ends_with(".transcript.md") {
            continue;
        }
        let Some(id) = name.strip_suffix(".md") else {
            continue;
        };
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        records.push(load_record(root, id)?);
    }
    records.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(records)
}

fn capacity_available(records: &[RunRecord], max_parallel: usize) -> bool {
    records
        .iter()
        .filter(|run| occupies_slot(&run.status))
        .count()
        < max_parallel
}

fn inbox_run_by_request(root: &Path, request_id: &str) -> Result<Option<RunRecord>, String> {
    Ok(list_records(root)?
        .into_iter()
        .find(|run| run.inbox_request_id.as_deref() == Some(request_id)))
}

fn append_output(root: &Path, record: &RunRecord, output: &str) -> Result<(), String> {
    if output.trim().is_empty() {
        return Ok(());
    }
    let path = transcript_path(root, &record.id)?;
    reject_symlink(&path)?;
    let mut existing = fs::read_to_string(&path)
        .unwrap_or_else(|_| format!("# Harness transcript: {}\n\n", record.id));
    let clipped = if output.chars().count() > MAX_OUTPUT_SNAPSHOT {
        output
            .chars()
            .rev()
            .take(MAX_OUTPUT_SNAPSHOT)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
    } else {
        output.to_string()
    };
    // A blocked terminal can remain unchanged for hours. Preserve each changed
    // observation without duplicating the same screen on every polling tick.
    if existing.ends_with(&format!("\n{clipped}\n```\n")) {
        return Ok(());
    }
    existing.push_str(&format!(
        "\n## Snapshot {}\n\n```text\n{}\n```\n",
        now(),
        clipped
    ));
    atomic_write(&path, &existing)
}

fn append_audit(root: &Path, record: &RunRecord, action: &str, detail: &str) -> Result<(), String> {
    append_output(
        root,
        record,
        &format!("[human {action} at {}]\n{detail}", now()),
    )
}

#[derive(Debug)]
struct LaunchContext {
    stage: String,
    workflow_id: String,
    workflow_version: String,
    workflow_digest: String,
    workflow_instance_id: Option<String>,
    node_run_id: Option<String>,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    repo_path: String,
    extra_paths: Vec<String>,
    verification: Vec<String>,
    dependencies: String,
    project_dependencies: String,
}

fn artifact_paths(
    root: &Path,
    work: &sdlc::WorkItem,
    definition: &WorkflowDefinition,
) -> Result<String, String> {
    sdlc::validate_id(&work.id)?;
    definition
        .artifacts
        .iter()
        .map(|artifact| {
            workflow::resolve_artifact_path(
                root,
                definition,
                &work.id,
                &work.project_id,
                &artifact.role,
            )
            .map(|path| format!("{} ({})", path.display(), artifact.role))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|paths| paths.join("\n- "))
}

fn build_prompt(
    root: &Path,
    run_id: &str,
    input: &LaunchInput,
    work: &sdlc::WorkItem,
    context: &LaunchContext,
) -> Result<String, String> {
    let artifacts = artifact_paths(root, work, &context.definition)?;
    let verification = if context.verification.is_empty() {
        "(프로젝트에 등록된 검증 명령 없음 — 추측하지 말고 제안만 하세요.)".to_string()
    } else {
        context.verification.join("\n- ")
    };
    let deliverable = if context.node.outputs.is_empty() {
        "이 노드는 새 문서를 직접 만들지 않습니다. 판정 근거와 미확인 사항을 실행 결과에 제출하세요.".into()
    } else {
        format!(
            "허용된 출력 artifact role: {}",
            context.node.outputs.join(", ")
        )
    };
    let nested_workflow = context
        .node
        .workflow_ref
        .as_ref()
        .map(|reference| format!("{}@{}", reference.id, reference.version))
        .unwrap_or_else(|| "없음".into());
    let skill = if context.workflow_id.starts_with("tdd")
        || context
            .node
            .workflow_ref
            .as_ref()
            .is_some_and(|reference| reference.id.starts_with("tdd"))
    {
        "plugin/skills/tdd/SKILL.md"
    } else {
        "plugin/skills/sdd/SKILL.md"
    };
    Ok(format!(
        "You are the {role} agent for Sawhorse workflow item {work}.\n\n\
Harness run ID: {run_id}\n\
Workflow: {workflow_id}@{workflow_version} ({workflow_digest})\n\
Current node: {stage} ({node_label})\n\
Nested workflow: {nested_workflow}\n\
Project: {project}\n\
Repository path: {repo}\n\
Artifact paths (Markdown is canonical):\n- {artifacts}\n\n\
Dependencies:\n{dependencies}\n\n\
Transitive project dependency repositories (context only; do not edit unless authorized):\n{project_dependencies}\n\n\
Validation commands (run only when relevant; report results faithfully):\n- {verification}\n\n\
Permitted deliverable for this role:\n{deliverable}\n\n\
Workflow node instructions:\n{node_instructions}\n\n\
Instructions from the user:\n{instructions}\n\n\
Write real, durable evidence in the permitted canonical artifact files; terminal output alone is not a deliverable.\n\
Never change work.md stage/status/decisions, project metadata, schema, or any host-managed run identity to bypass a gate.\n\
Do not deploy, merge, or approve any dialog. If an approval/question is shown, stop and leave it for human review.\n\
When your turn becomes idle or done, it will be marked review; it is not verification passed.\n\
The matching Sawhorse workflow skill is available at {skill}; follow its artifact/evidence rules.\n\
To request a bounded child, write a JSON file `{inbox}/<requestId>.json` containing requestId,\n\
parentRunId `{run_id}`, workId, projectId, role (research or verifier), agent, model, and\n\
instructions. Only active parents are accepted; requestId makes retries idempotent.",
        run_id = run_id,
        role = input.role,
        work = input.work_id,
        workflow_id = context.workflow_id,
        workflow_version = context.workflow_version,
        workflow_digest = context.workflow_digest,
        stage = context.stage,
        node_label = context.node.label,
        nested_workflow = nested_workflow,
        project = input.project_id,
        repo = context.repo_path,
        artifacts = artifacts,
        dependencies = context.dependencies,
        project_dependencies = context.project_dependencies,
        verification = verification,
        deliverable = deliverable,
        node_instructions = context.node.instructions,
        instructions = input.instructions,
        inbox = runs_dir(root)?.join("inbox").display(),
        skill = skill,
    ))
}

fn launch_gate(root: &Path, input: &LaunchInput) -> Result<LaunchContext, String> {
    if !valid_role(&input.role) || !valid_agent(&input.agent) {
        return Err("지원하지 않는 역할 또는 에이전트입니다".into());
    }
    if input.instructions.len() > 32_000 || input.model.len() > 256 {
        return Err("실행 지시 또는 모델 이름이 너무 깁니다".into());
    }
    sdlc::validate_id(&input.work_id)?;
    sdlc::validate_id(&input.project_id)?;
    let snapshot = sdlc::snapshot(root)?;
    if !snapshot.initialized {
        return Err("SDD vault를 먼저 초기화해야 합니다".into());
    }
    let work = snapshot
        .work
        .iter()
        .find(|work| work.id == input.work_id)
        .ok_or_else(|| "작업을 찾을 수 없습니다".to_string())?;
    if work.project_id != input.project_id {
        return Err("작업과 프로젝트가 일치하지 않습니다".into());
    }
    let project = snapshot
        .projects
        .iter()
        .find(|project| project.id == input.project_id)
        .ok_or_else(|| "프로젝트를 찾을 수 없습니다".to_string())?;
    // 같은 작업의 같은 역할이 이미 돌고 있으면 하나 더 띄우지 않는다 — 버튼을 두 번
    // 눌렀거나 다른 화면에서 이미 시작한 경우이고, 두 에이전트가 같은 산출물을 동시에
    // 고치게 된다. 자식 실행은 부모가 활성인 채로 시작하는 것이 정상이라 걸지 않는다.
    if input.parent_run_id.is_none() {
        if let Some(running) = list_records(root)?.into_iter().find(|record| {
            record.work_id == input.work_id
                && record.role == input.role
                && record.parent_run_id.is_none()
                && active_status(&record.status)
        }) {
            return Err(format!(
                "{}의 {} 실행이 이미 진행 중입니다. 끝나기를 기다리거나 중단한 뒤 다시 시작하세요 (실행 {})",
                input.work_id, input.role, running.id
            ));
        }
    }
    let runtime_instance = work
        .workflow_instance_id
        .as_deref()
        .map(|id| workflow::ledger::get_at(root, id))
        .transpose()?;
    let active = runtime_instance
        .as_ref()
        .and_then(|instance| instance.active_nodes.first().cloned());
    let stage = active
        .as_ref()
        .map(|node| node.node_id.clone())
        .unwrap_or_else(|| work.stage.clone());
    let definition = if let Some(active) = &active {
        workflow::resolve(Some(root), &active.workflow_id, &active.workflow_version)?
    } else {
        sdlc::workflow_definition_for_work(root, work)?
    };
    let node = definition
        .nodes
        .iter()
        .find(|node| node.id == stage)
        .cloned()
        .ok_or_else(|| "작업 node가 고정한 workflow에 없습니다".to_string())?;
    if !node.allowed_roles.is_empty() && !node.allowed_roles.iter().any(|role| role == &input.role)
    {
        return Err(format!(
            "{} node에서 허용하지 않는 역할입니다: {}",
            node.id, input.role
        ));
    }
    // Re-check the node inputs at launch so an externally edited work record
    // cannot bypass the same durable-evidence gate as a transition.
    for artifact in &node.inputs {
        let document = sdlc::read_document(root, &input.work_id, artifact)?;
        if !substantive(&document.markdown) {
            return Err(format!(
                "{stage} 단계 실행 전 {artifact}.md에 실질적인 근거가 필요합니다"
            ));
        }
    }
    let mut dependencies = Vec::new();
    for dependency_id in &work.depends_on {
        let dependency = snapshot
            .work
            .iter()
            .find(|candidate| candidate.id == *dependency_id)
            .ok_or_else(|| format!("의존 작업을 찾을 수 없습니다: {dependency_id}"))?;
        dependencies.push(format!("- {} ({})", dependency.id, dependency.status));
        if node.requires_completed_dependencies && dependency.status != "done" {
            return Err(format!("build 이후 단계는 완료되지 않은 의존 작업 때문에 시작할 수 없습니다: {dependency_id}"));
        }
    }
    if let Some(parent_id) = input.parent_run_id.as_deref() {
        let parent = load_record(root, parent_id)?;
        if !active_status(&parent.status)
            || parent.work_id != input.work_id
            || parent.project_id != input.project_id
        {
            return Err(
                "활성이고 같은 작업/프로젝트인 부모 실행만 자식 실행을 만들 수 있습니다".into(),
            );
        }
        if !matches!(input.role.as_str(), "research" | "verifier") {
            return Err("자식 실행 역할은 research 또는 verifier만 가능합니다".into());
        }
        if parent_depth(root, &parent.id)? >= MAX_PARENT_DEPTH {
            return Err(format!(
                "자식 실행 깊이는 최대 {MAX_PARENT_DEPTH}단계입니다"
            ));
        }
    }
    if project.repo_path.trim().is_empty() {
        return Err("프로젝트 repoPath가 비어 있어 harness를 시작할 수 없습니다".into());
    }
    let repo_path = PathBuf::from(&project.repo_path);
    if !repo_path.is_dir() {
        return Err(format!(
            "프로젝트 저장소 경로가 디렉터리가 아닙니다: {}",
            repo_path.display()
        ));
    }
    Ok(LaunchContext {
        stage,
        workflow_id: definition.id.clone(),
        workflow_version: definition.version.clone(),
        workflow_digest: workflow::definition_digest(&definition)?,
        workflow_instance_id: runtime_instance
            .as_ref()
            .map(|instance| instance.id.clone()),
        node_run_id: active.as_ref().map(|node| node.node_run_id.clone()),
        node,
        definition,
        repo_path: repo_path.display().to_string(),
        extra_paths: project.extra_paths.clone(),
        verification: project.verify_commands.clone(),
        dependencies: if dependencies.is_empty() {
            "- 없음".into()
        } else {
            dependencies.join("\n")
        },
        project_dependencies: transitive_project_context(&snapshot.projects, &input.project_id)?,
    })
}

fn parent_depth(root: &Path, id: &str) -> Result<usize, String> {
    let mut current = Some(id.to_string());
    let mut seen = HashSet::new();
    let mut depth = 0;
    while let Some(run_id) = current {
        if !seen.insert(run_id.clone()) {
            return Err("실행 부모 관계에 순환이 있습니다".into());
        }
        let run = load_record(root, &run_id)?;
        current = run.parent_run_id;
        if current.is_some() {
            depth += 1;
        }
    }
    Ok(depth)
}

fn transitive_project_context(
    projects: &[sdlc::Project],
    project_id: &str,
) -> Result<String, String> {
    fn visit(
        projects: &[sdlc::Project],
        id: &str,
        seen: &mut HashSet<String>,
        rows: &mut Vec<String>,
    ) -> Result<(), String> {
        let project = projects
            .iter()
            .find(|project| project.id == id)
            .ok_or_else(|| format!("프로젝트 의존성을 찾을 수 없습니다: {id}"))?;
        for dependency in &project.depends_on {
            if !seen.insert(dependency.clone()) {
                continue;
            }
            let dependency_project = projects
                .iter()
                .find(|project| project.id == *dependency)
                .ok_or_else(|| format!("프로젝트 의존성을 찾을 수 없습니다: {dependency}"))?;
            rows.push(format!(
                "- {}: {}",
                dependency_project.id,
                if dependency_project.repo_path.trim().is_empty() {
                    "(repoPath not configured)"
                } else {
                    &dependency_project.repo_path
                }
            ));
            visit(projects, dependency, seen, rows)?;
        }
        Ok(())
    }
    let mut seen = HashSet::new();
    let mut rows = Vec::new();
    visit(projects, project_id, &mut seen, &mut rows)?;
    Ok(if rows.is_empty() {
        "- 없음".into()
    } else {
        rows.join("\n")
    })
}

fn record_launch(root: &Path, input: &LaunchInput) -> Result<RunRecord, String> {
    record_launch_with_request(root, input, None)
}

fn record_launch_with_request(
    root: &Path,
    input: &LaunchInput,
    inbox_request_id: Option<&str>,
) -> Result<RunRecord, String> {
    let _guard = launch_mutex()
        .lock()
        .map_err(|_| "harness launch lock이 손상되었습니다".to_string())?;
    if let Some(request_id) = inbox_request_id {
        if let Some(existing) = inbox_run_by_request(root, request_id)? {
            return Ok(existing);
        }
    }
    let cfg = config::load_view().dashboard.herdr.sanitized();
    if !capacity_available(&list_records(root)?, cfg.max_parallel as usize) {
        return Err(format!(
            "Herdr 동시 실행 한도({})에 도달했습니다",
            cfg.max_parallel
        ));
    }
    let context = launch_gate(root, input)?;
    let snapshot = sdlc::snapshot(root)?;
    let work = snapshot
        .work
        .iter()
        .find(|work| work.id == input.work_id)
        .ok_or_else(|| "작업을 찾을 수 없습니다".to_string())?;
    let id = Uuid::new_v4().to_string();
    let prompt = build_prompt(root, &id, input, work, &context)?;
    let timestamp = now();
    let record = RunRecord {
        schema_version: RUN_SCHEMA,
        id: id.clone(),
        work_id: input.work_id.clone(),
        project_id: input.project_id.clone(),
        role: input.role.clone(),
        agent: input.agent.clone(),
        model: input.model.trim().to_string(),
        parent_run_id: input.parent_run_id.clone(),
        stage: context.stage,
        workflow_id: context.workflow_id,
        workflow_version: context.workflow_version,
        workflow_digest: context.workflow_digest,
        workflow_instance_id: context.workflow_instance_id,
        node_run_id: context.node_run_id,
        status: "starting".into(),
        agent_name: run_agent_name(&id),
        pane_id: None,
        workspace_id: None,
        tab_id: None,
        session: if cfg.session.trim().is_empty() {
            "default".into()
        } else {
            cfg.session.trim().into()
        },
        agent_session: None,
        prompt,
        repo_path: context.repo_path,
        extra_paths: context.extra_paths,
        output_path: format!("runs/{id}.transcript.md"),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        error: None,
        owned: true,
        inbox_request_id: inbox_request_id.map(str::to_string),
        cancel_requested: false,
        tab_closed_at: None,
        final_report: None,
        resumed_at: None,
    };
    save_record(root, &record)?;
    if let (Some(instance_id), Some(node_run_id)) = (
        record.workflow_instance_id.as_deref(),
        record.node_run_id.as_deref(),
    ) {
        if let Err(error) =
            workflow::ledger::attach_execution_at(root, instance_id, node_run_id, &record.id)
        {
            let _ = fs::remove_file(record_path(root, &record.id)?);
            return Err(format!("workflow 실행 장부 연결 실패: {error}"));
        }
    }
    let transcript = transcript_path(root, &id)?;
    atomic_write(
        &transcript,
        &format!("# Harness transcript: {id}\n\nRun record: `runs/{id}.md`\n"),
    )?;
    Ok(record)
}

fn update(record: &mut RunRecord, status: &str, error: Option<String>) {
    record.status = status.into();
    record.error = error;
    record.updated_at = now();
}

fn identity_matches(record: &RunRecord, info: &AgentInfo) -> Result<(), String> {
    if !record.owned || info.agent.as_deref() != Some(record.agent.as_str()) {
        return Err("기록된 Herdr 에이전트 이름/종류와 현재 pane이 일치하지 않습니다".into());
    }
    if let Some(session) = record.agent_session.as_deref() {
        if info.contradicts_session(session) {
            return Err("기록된 Herdr 에이전트 세션과 현재 pane이 일치하지 않습니다".into());
        }
    }
    Ok(())
}

fn herdr_for(record: &RunRecord) -> Herdr {
    let mut cfg = config::load_view().dashboard.herdr.sanitized();
    // A named session is part of the ownership tuple. Do not drift to a newly
    // selected default session after an app configuration change or restart.
    cfg.session = if record.session == "default" {
        String::new()
    } else {
        record.session.clone()
    };
    Herdr::new(&cfg)
}

fn raw_identity_matches(record: &RunRecord, raw: &Value) -> Result<(), String> {
    let node = raw.get("agent").unwrap_or(raw);
    let expected_pane = record
        .pane_id
        .as_deref()
        .ok_or_else(|| "기록된 Herdr pane ID가 없습니다".to_string())?;
    let expected_workspace = record
        .workspace_id
        .as_deref()
        .ok_or_else(|| "기록된 Herdr workspace ID가 없습니다".to_string())?;
    let expected_tab = record
        .tab_id
        .as_deref()
        .ok_or_else(|| "기록된 Herdr tab ID가 없습니다".to_string())?;
    let matches =
        |key: &str, expected: &str| node.get(key).and_then(Value::as_str) == Some(expected);
    if !matches("name", &record.agent_name)
        || !matches("agent", &record.agent)
        || !matches("pane_id", expected_pane)
        || !matches("workspace_id", expected_workspace)
        || !matches("tab_id", expected_tab)
    {
        return Err(
            "Herdr agent get의 name/kind/workspace/tab/pane identity가 기록과 일치하지 않습니다"
                .into(),
        );
    }
    Ok(())
}

async fn owned_agent(h: &Herdr, record: &RunRecord) -> Result<AgentInfo, String> {
    // `AgentInfo` purposefully only exposes lifecycle fields. Use the raw
    // `agent get` payload as the authoritative identity tuple before asking the
    // wrapper for lifecycle status.
    let raw = h
        .call(&["agent", "get", &record.agent_name])
        .await
        .map_err(|e| format!("기록된 Herdr agent를 확인할 수 없습니다: {e}"))?;
    raw_identity_matches(record, &raw)?;
    let info = h
        .agent_get(&record.agent_name)
        .await
        .map_err(|e| format!("기록된 Herdr agent를 확인할 수 없습니다: {e}"))?;
    identity_matches(record, &info)?;
    let snapshot = h.snapshot().await;
    if !snapshot.available {
        return Err(snapshot
            .error
            .unwrap_or_else(|| "Herdr server를 찾을 수 없습니다".into()));
    }
    let exact = snapshot.agents.iter().any(|agent| {
        agent.name == record.agent_name
            && agent.agent == record.agent
            && agent.pane_id == record.pane_id.as_deref().unwrap_or_default()
            && agent.workspace_id == record.workspace_id.as_deref().unwrap_or_default()
            && agent.tab_id == record.tab_id.as_deref().unwrap_or_default()
    });
    if !exact {
        return Err(
            "기록된 Herdr workspace/tab/pane/name/kind과 현재 agent가 일치하지 않습니다".into(),
        );
    }
    Ok(info)
}

async fn prompt_agent(h: &Herdr, name: &str, prompt: &str) -> Result<(), String> {
    h.call_with_timeout(&["agent", "prompt", name, prompt], Duration::from_secs(15))
        .await
        .map(|_| ())
        .map_err(|e| format!("Herdr 프롬프트 전송 실패: {e}"))
}

async fn settle_cancel(
    root: &Path,
    record: &mut RunRecord,
    h: Option<&Herdr>,
) -> Result<bool, String> {
    if !cancellation_requested(root, record)? {
        return Ok(false);
    }
    record.cancel_requested = true;
    // The marker can arrive while `agent start` is still waiting for readiness.
    // Only send Ctrl-C after the complete owned identity can be observed.
    if let Some(h) = h {
        if record.pane_id.is_some() && owned_agent(h, record).await.is_ok() {
            let _ = h.agent_send_keys(&record.agent_name, &["ctrl+c"]).await;
        }
    }
    update(record, "stopped", None);
    append_output(
        root,
        record,
        "[user requested cancellation before prompt completion]",
    )?;
    if let Some(h) = h {
        settle_pane(root, record, h, None).await;
    }
    save_record(root, record)?;
    clear_cancel(root, &record.id)?;
    Ok(true)
}

/// Does the configured cleanup policy retire the pane at this status?
///
/// The dashboard-wide `herdr.cleanup` setting decides, with a settled turn
/// (`review`) counting as the harness equivalent of a successful job.
fn closes_pane_at(cleanup: &str, status: &str) -> bool {
    match cleanup {
        "keep" => false,
        "closeAlways" => matches!(status, "review" | "failed" | "stopped"),
        _ => status == "review",
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let tail: String = text
        .chars()
        .rev()
        .take(max)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    format!("…\n{tail}")
}

/// Retire the herdr screen of a run that is done working.
///
/// The agent's closing output is captured into the record and the transcript
/// first, so nothing a human would have read in the pane is lost with it. The
/// run keeps its recorded session id, which is what makes reopening possible.
/// `captured` is the output the caller has already read this tick, so a refresh
/// does not read the same pane twice.
async fn close_pane(root: &Path, record: &mut RunRecord, h: &Herdr, captured: Option<&str>) {
    if record.tab_closed_at.is_some() {
        return;
    }
    let Some(tab) = record.tab_id.clone() else {
        return;
    };
    let output = match captured {
        Some(text) => Some(text.to_string()),
        None => h.agent_read(&record.agent_name, 200).await.ok(),
    };
    if let Some(text) = output.as_deref() {
        let _ = append_output(root, record, text);
        if !text.trim().is_empty() {
            record.final_report = Some(tail_chars(text.trim(), MAX_FINAL_REPORT));
        }
    }
    // A pane that refuses to close is still on screen: leave the record pointing
    // at it rather than claiming a screen was retired that the human still sees.
    if h.close_tab(&tab).await.is_err() {
        return;
    }
    // Every run gets its own workspace at launch; closing only the tab would
    // leave an empty one behind in herdr's switcher.
    if let Some(workspace) = record.workspace_id.clone() {
        let _ = h.close_workspace(&workspace).await;
    }
    record.tab_closed_at = Some(now());
    record.updated_at = now();
}

/// Close the pane when the policy says this status is finished. Callers have
/// already written the status; this only settles the terminal side of it.
async fn settle_pane(root: &Path, record: &mut RunRecord, h: &Herdr, captured: Option<&str>) {
    let cleanup = config::load_view().dashboard.herdr.sanitized().cleanup;
    if closes_pane_at(&cleanup, &record.status) {
        close_pane(root, record, h, captured).await;
    }
}

/// 프로젝트가 추가로 신뢰하는 디렉터리를 vault 와 같은 방식으로 스코프에 넣는다.
/// launch 때 기록해 둔 값이라 빈 항목 방어만 하면 된다.
fn push_extra_dirs(extra: &mut Vec<String>, extra_paths: &[String]) {
    for dir in extra_paths {
        let dir = dir.trim();
        if !dir.is_empty() {
            extra.extend(["--add-dir".to_string(), dir.to_string()]);
        }
    }
}

/// Reopen a closed run's agent session in herdr as the same conversation.
///
/// `claude --resume <id>` restores the transcript the run was recorded with, so
/// the new pane is the old session — not a fresh agent that happens to share a
/// work item. The record is rebound to the new workspace/tab/pane, which is what
/// every later ownership check compares against.
async fn reopen_session(
    root: &Path,
    record: &mut RunRecord,
    h: &Herdr,
    focus: bool,
) -> Result<(), String> {
    if !record.resumable() {
        return Err("이 실행에는 이어할 세션 id가 없습니다 (claude 실행만 지원합니다)".into());
    }
    let session = record.agent_session.clone().unwrap_or_default();
    if let Some(why) = herdr::windows_launch_block(&record.agent) {
        return Err(why);
    }
    let label = format!("sdd-{}", &record.id[..8]);
    let workspace = match record.workspace_id.clone() {
        Some(id) if h.workspace_exists(&id).await => id,
        _ => h
            .create_workspace(&label)
            .await
            .map_err(|error| format!("Herdr workspace 생성 실패: {error}"))?,
    };
    let tab = h
        .create_tab(
            &workspace,
            &format!("{}-{}", record.role, &record.id[..8]),
            &record.repo_path,
        )
        .await
        .map_err(|error| format!("Herdr tab 생성 실패: {error}"))?;
    let mut extra = vec!["--resume".to_string(), session.clone()];
    if let Ok(vault) = root.canonicalize() {
        extra.extend(["--add-dir".to_string(), vault.display().to_string()]);
    }
    push_extra_dirs(&mut extra, &record.extra_paths);
    if !record.model.is_empty() {
        extra.extend(["--model".to_string(), record.model.clone()]);
    }
    let timeout = (config::load_view()
        .dashboard
        .herdr
        .sanitized()
        .start_timeout_sec as u64)
        * 1000;
    let started = h
        .agent_start(
            &record.agent_name,
            &record.agent,
            &tab.pane_id,
            timeout,
            &extra,
        )
        .await;
    let previous = (
        record.workspace_id.clone(),
        record.tab_id.clone(),
        record.pane_id.clone(),
    );
    record.workspace_id = Some(workspace.clone());
    record.tab_id = Some(tab.tab_id.clone());
    record.pane_id = Some(tab.pane_id.clone());
    if let Err(error) = started {
        // `agent start` can report failure while the agent is in fact already up.
        if owned_agent(h, record).await.is_err() {
            let _ = h.close_tab(&tab.tab_id).await;
            (record.workspace_id, record.tab_id, record.pane_id) = previous;
            return Err(format!("Herdr agent 이어하기 실패: {error}"));
        }
    }
    // A resumed CLI may report a different session id than the one we minted.
    // Record what herdr actually sees, or later ownership checks reject our pane.
    if let Ok(info) = h.agent_get(&record.agent_name).await {
        if let Some((kind, value)) = info.session_ref {
            if kind == "id" && value != session {
                record.agent_session = Some(value);
            }
        }
    }
    record.tab_closed_at = None;
    record.resumed_at = Some(now());
    // Reopening clears the recorded error, so keep what it said in the transcript.
    let carried = match record.error.as_deref() {
        Some(error) => format!("session {session} (직전 오류: {error})"),
        None => format!("session {session}"),
    };
    // The run is live again and waiting on the human, exactly like a settled turn.
    update(record, "review", None);
    append_audit(root, record, "resume", &carried)?;
    save_record(root, record)?;
    if focus {
        let _ = h.focus_workspace(&workspace).await;
        let _ = h.focus_tab(&tab.tab_id).await;
    }
    Ok(())
}

fn startup_expired(record: &RunRecord) -> bool {
    let timeout = config::load_view()
        .dashboard
        .herdr
        .sanitized()
        .start_timeout_sec as i64
        + 15;
    chrono::DateTime::parse_from_rfc3339(&record.created_at)
        .map(|started| (Utc::now() - started.with_timezone(&Utc)).num_seconds() > timeout)
        .unwrap_or(true)
}

async fn start_record(root: PathBuf, id: String) {
    let _run_guard = run_lock(&id).lock().await;
    let mut record = match load_record(&root, &id) {
        Ok(record) => record,
        Err(_) => return,
    };
    if record.status != "starting" {
        return;
    }
    let cfg = config::load_view().dashboard.herdr.sanitized();
    let h = herdr_for(&record);
    // Herdr types a PowerShell `Start-Process` to launch the agent; a PATH that
    // resolves the agent name to a shell shim fails there, minutes later and with
    // nothing readable in the pane. Say so before a workspace and tab exist.
    if let Some(why) = herdr::windows_launch_block(&record.agent) {
        update(&mut record, "failed", Some(why));
        let _ = save_record(&root, &record);
        return;
    }
    if settle_cancel(&root, &mut record, Some(&h))
        .await
        .unwrap_or(false)
    {
        return;
    }
    let label = format!("sdd-{}", &record.id[..8]);
    let workspace = match h.create_workspace(&label).await {
        Ok(workspace) => workspace,
        Err(error) => {
            update(
                &mut record,
                "failed",
                Some(format!("Herdr workspace 생성 실패: {error}")),
            );
            let _ = save_record(&root, &record);
            return;
        }
    };
    record.workspace_id = Some(workspace.clone());
    record.updated_at = now();
    if save_record(&root, &record).is_err() {
        return;
    }
    if settle_cancel(&root, &mut record, Some(&h))
        .await
        .unwrap_or(false)
    {
        return;
    }
    let tab = match h
        .create_tab(
            &workspace,
            &format!("{}-{}", record.role, &record.id[..8]),
            &record.repo_path,
        )
        .await
    {
        Ok(tab) => tab,
        Err(error) => {
            update(
                &mut record,
                "failed",
                Some(format!("Herdr tab 생성 실패: {error}")),
            );
            let _ = save_record(&root, &record);
            return;
        }
    };
    record.tab_id = Some(tab.tab_id);
    record.pane_id = Some(tab.pane_id.clone());
    record.updated_at = now();
    if save_record(&root, &record).is_err() {
        return;
    }
    if settle_cancel(&root, &mut record, Some(&h))
        .await
        .unwrap_or(false)
    {
        return;
    }
    let mut extra = Vec::new();
    let vault_dir = match root.canonicalize() {
        Ok(path) => path,
        Err(error) => {
            update(
                &mut record,
                "failed",
                Some(format!("vault 경로를 확인할 수 없습니다: {error}")),
            );
            let _ = save_record(&root, &record);
            return;
        }
    };
    // Both supported native CLIs accept this explicit scope. The project repo is
    // their cwd; the canonical vault is required for artifacts, and the project's
    // own extra directories complete the trusted workspace.
    extra.extend(["--add-dir".to_string(), vault_dir.display().to_string()]);
    push_extra_dirs(&mut extra, &record.extra_paths);
    if !record.model.is_empty() {
        extra.extend(["--model".to_string(), record.model.clone()]);
    }
    if record.agent == "claude" {
        let session = Uuid::new_v4().to_string();
        extra.extend(["--session-id".to_string(), session.clone()]);
        record.agent_session = Some(session);
        record.updated_at = now();
        if save_record(&root, &record).is_err() {
            return;
        }
    }
    let timeout = (cfg.start_timeout_sec as u64) * 1000;
    if let Err(error) = h
        .agent_start(
            &record.agent_name,
            &record.agent,
            &tab.pane_id,
            timeout,
            &extra,
        )
        .await
    {
        // `agent start` can return while a newly started agent is already working.
        match owned_agent(&h, &record).await {
            Ok(_) => {}
            _ => {
                update(
                    &mut record,
                    "failed",
                    Some(format!("Herdr agent 시작 실패: {error}")),
                );
                settle_pane(&root, &mut record, &h, None).await;
                let _ = save_record(&root, &record);
                return;
            }
        }
    }
    if settle_cancel(&root, &mut record, Some(&h))
        .await
        .unwrap_or(false)
    {
        return;
    }
    if let Err(error) = owned_agent(&h, &record).await {
        update(
            &mut record,
            "failed",
            Some(format!("Herdr agent identity 확인 실패: {error}")),
        );
        let _ = save_record(&root, &record);
        return;
    }
    if let Err(error) = prompt_agent(&h, &record.agent_name, &record.prompt).await {
        update(&mut record, "failed", Some(error));
        settle_pane(&root, &mut record, &h, None).await;
        let _ = save_record(&root, &record);
        return;
    }
    update(&mut record, "running", None);
    if let Ok(output) = h.agent_read(&record.agent_name, 200).await {
        let _ = append_output(&root, &record, &output);
    }
    let _ = save_record(&root, &record);
}

async fn refresh_run(root: &Path, id: &str) -> Result<RunRecord, String> {
    let _run_guard = run_lock(id).lock().await;
    let record = load_record(root, id)?;
    let h = herdr_for(&record);
    refresh_record_with(root, record, &h).await
}

async fn refresh_record_with(
    root: &Path,
    mut record: RunRecord,
    h: &Herdr,
) -> Result<RunRecord, String> {
    if !refreshable_status(&record.status) {
        return Ok(record);
    }
    if record.status == "starting" {
        if settle_cancel(root, &mut record, Some(h)).await? {
            return Ok(record);
        }
        // In-process startup owns all transition writes through prompt delivery.
        // Do not turn an observed initial idle into review before it is prompted.
        if start_is_local(&record.id) {
            return Ok(record);
        }
        // After restart, leave the durable start record alone for its recorded
        // startup window; Herdr may have created the pane before agent readiness.
        if !startup_expired(&record) {
            return Ok(record);
        }
        if record.pane_id.is_none() {
            update(
                &mut record,
                "failed",
                Some("재시작 뒤 startup 시간 안에 Herdr pane이 기록되지 않았습니다".into()),
            );
            save_record(root, &record)?;
            return Ok(record);
        }
    }
    let info = match owned_agent(h, &record).await {
        Ok(info) => info,
        Err(error) => {
            update(
                &mut record,
                "failed",
                Some(format!("기록된 Herdr agent를 복구할 수 없습니다: {error}")),
            );
            save_record(root, &record)?;
            return Ok(record);
        }
    };
    let captured = match h.agent_read(&record.agent_name, 200).await {
        Ok(output) => {
            append_output(root, &record, &output)?;
            Some(output)
        }
        Err(error) => {
            append_output(root, &record, &format!("[output read failed: {error}]"))?;
            None
        }
    };
    let status = status_for_agent(&info.status);
    update(&mut record, status, None);
    // A settled turn has nothing left to show in a terminal. Keep the closing
    // report on the record and retire the pane.
    settle_pane(root, &mut record, h, captured.as_deref()).await;
    save_record(root, &record)?;
    Ok(record)
}

async fn stop_record_with(
    root: &Path,
    mut record: RunRecord,
    h: &Herdr,
) -> Result<RunRecord, String> {
    if !refreshable_status(&record.status) {
        return Ok(record);
    }
    if settle_cancel(root, &mut record, Some(h)).await? {
        return Ok(record);
    }
    let _ = owned_agent(h, &record).await?;
    // This is an explicit user stop. It is not an answer to a blocked dialog.
    h.agent_send_keys(&record.agent_name, &["ctrl+c"])
        .await
        .map_err(|e| format!("Herdr agent 중단 실패: {e}"))?;
    update(&mut record, "stopped", None);
    append_output(
        root,
        &record,
        "[user requested stop; ctrl+c sent to recorded owned agent]",
    )?;
    settle_pane(root, &mut record, h, None).await;
    save_record(root, &record)?;
    Ok(record)
}

fn inbox_dir(root: &Path) -> Result<PathBuf, String> {
    let dir = runs_dir(root)?.join("inbox");
    if let Ok(metadata) = fs::symlink_metadata(&dir) {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("run inbox 경로가 안전하지 않습니다".into());
        }
    } else {
        fs::create_dir_all(&dir).map_err(|e| format!("run inbox를 만들 수 없습니다: {e}"))?;
    }
    Ok(dir)
}

fn parse_child_request(path: &Path) -> Result<ChildRequest, String> {
    reject_symlink(path)?;
    let text =
        fs::read_to_string(path).map_err(|e| format!("자식 요청을 읽을 수 없습니다: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("자식 요청 JSON이 손상되었습니다: {e}"))
}

fn save_child_request(path: &Path, request: &ChildRequest) -> Result<(), String> {
    let json = serde_json::to_string_pretty(request)
        .map_err(|e| format!("자식 요청을 직렬화할 수 없습니다: {e}"))?;
    atomic_write(path, &format!("{json}\n"))
}

fn pending_child_requests(paths: Vec<PathBuf>) -> Vec<(PathBuf, ChildRequest)> {
    paths
        .into_iter()
        .filter_map(|path| {
            parse_child_request(&path).ok().and_then(|request| {
                (request.status.is_empty() || request.status == "pending")
                    .then_some((path, request))
            })
        })
        .take(MAX_INBOX_PER_TICK)
        .collect()
}

async fn process_inbox(root: &Path) -> Result<(), String> {
    let dir = inbox_dir(root)?;
    let mut paths = fs::read_dir(dir)
        .map_err(|e| format!("run inbox를 읽을 수 없습니다: {e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|x| x.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    // Filter terminal requests before applying the work budget. Otherwise an
    // old accepted/rejected prefix can permanently starve later pending files.
    let pending = pending_child_requests(paths);
    for (path, mut request) in pending {
        if Uuid::parse_str(&request.request_id).is_err() {
            request.status = "rejected".into();
            request.error = Some("requestId는 UUID여야 합니다".into());
            request.updated_at = now();
            save_child_request(&path, &request)?;
            continue;
        }
        if path.file_stem().and_then(|name| name.to_str()) != Some(request.request_id.as_str()) {
            request.status = "rejected".into();
            request.error = Some("요청 파일명은 requestId.json이어야 합니다".into());
            request.updated_at = now();
            save_child_request(&path, &request)?;
            continue;
        }
        let parent = match load_record(root, &request.parent_run_id) {
            Ok(parent) => parent,
            Err(error) => {
                request.status = "rejected".into();
                request.error = Some(error);
                request.updated_at = now();
                save_child_request(&path, &request)?;
                continue;
            }
        };
        if !active_status(&parent.status)
            || parent.work_id != request.work_id
            || parent.project_id != request.project_id
            || !matches!(request.role.as_str(), "research" | "verifier")
        {
            request.status = "rejected".into();
            request.error = Some("활성 부모/작업/역할 검증에 실패했습니다".into());
            request.updated_at = now();
            save_child_request(&path, &request)?;
            continue;
        }
        let input = LaunchInput {
            work_id: request.work_id.clone(),
            project_id: request.project_id.clone(),
            role: request.role.clone(),
            agent: if request.agent.is_empty() {
                parent.agent.clone()
            } else {
                request.agent.clone()
            },
            model: if request.model.is_empty() {
                parent.model.clone()
            } else {
                request.model.clone()
            },
            instructions: request.instructions.clone(),
            parent_run_id: Some(parent.id.clone()),
        };
        match record_launch_with_request(root, &input, Some(&request.request_id)) {
            Ok(run) => {
                let root = root.to_path_buf();
                spawn_start(root, run.id.clone());
                request.status = "accepted".into();
                request.run_id = Some(run.id);
                request.error = None;
            }
            Err(error) => {
                request.status = "rejected".into();
                request.error = Some(error);
            }
        }
        request.updated_at = now();
        save_child_request(&path, &request)?;
    }
    Ok(())
}

/// Persist first, then start asynchronously. This command intentionally returns
/// `starting` without waiting for a Herdr workspace, pane, or agent process.
#[tauri::command]
pub async fn sdd_launch(input: LaunchInput) -> Result<HarnessRun, String> {
    let root = sdlc::vault_root()?;
    let record = record_launch(&root, &input)?;
    let result = record.public();
    spawn_start(root, record.id);
    Ok(result)
}

#[tauri::command]
pub fn sdd_runs() -> Result<Vec<HarnessRun>, String> {
    let root = sdlc::vault_root()?;
    // Browsing an uninitialized workbench must not create a `runs/` directory.
    if !sdlc::snapshot(&root)?.initialized {
        return Ok(Vec::new());
    }
    Ok(list_records(&root)?.iter().map(RunRecord::public).collect())
}

#[tauri::command]
pub async fn sdd_refresh_run(id: String) -> Result<HarnessRun, String> {
    let root = sdlc::vault_root()?;
    let record = refresh_run(&root, &id).await?;
    Ok(record.public())
}

#[tauri::command]
pub async fn sdd_stop_run(id: String) -> Result<HarnessRun, String> {
    let root = sdlc::vault_root()?;
    let record = load_record(&root, &id)?;
    if !refreshable_status(&record.status) {
        return Ok(record.public());
    }
    request_cancel(&root, &id)?;
    if record.status == "starting" && start_is_local(&id) {
        // The startup task will persist `stopped` before it can prompt. If its
        // agent is already discoverable, interrupt only after exact ownership.
        let h = herdr_for(&record);
        if owned_agent(&h, &record).await.is_ok() {
            let _ = h.agent_send_keys(&record.agent_name, &["ctrl+c"]).await;
        }
        return Ok(record.public());
    }
    let _run_guard = run_lock(&id).lock().await;
    let record = load_record(&root, &id)?;
    let h = herdr_for(&record);
    let record = stop_record_with(&root, record, &h).await?;
    Ok(record.public())
}

/// An explicit human follow-up after a settled turn. The periodic ticker never
/// calls this: only the UI action can send a new agent prompt.
#[tauri::command]
pub async fn sdd_continue_run(id: String, instructions: String) -> Result<HarnessRun, String> {
    let instructions = instructions.trim().to_string();
    if instructions.is_empty() || instructions.len() > 32_000 {
        return Err("후속 지시는 비어 있지 않은 32,000자 이하 문자열이어야 합니다".into());
    }
    let root = sdlc::vault_root()?;
    let _run_guard = run_lock(&id).lock().await;
    let mut record = load_record(&root, &id)?;
    let h = herdr_for(&record);
    if record.status != "review" {
        return Err("review 상태의 실행에만 후속 지시를 보낼 수 있습니다".into());
    }
    // The pane of a settled run is closed on purpose. A follow-up reopens the
    // recorded session first, so the human never has to think about the terminal.
    if record.tab_closed_at.is_some() {
        reopen_session(&root, &mut record, &h, false).await?;
    }
    let info = owned_agent(&h, &record).await?;
    if !can_continue(&record.status, &info.status) {
        return Err("review 상태의 idle/done 실행에만 후속 지시를 보낼 수 있습니다".into());
    }
    prompt_agent(&h, &record.agent_name, &instructions).await?;
    append_audit(&root, &record, "follow-up", &instructions)?;
    record.prompt = format!("{}\n\n[Human follow-up]\n{}", record.prompt, instructions);
    update(&mut record, "running", None);
    save_record(&root, &record)?;
    Ok(record.public())
}

/// Reopen a finished run's agent session in herdr and focus it.
///
/// One click for the human: the closed pane comes back as the same conversation,
/// ready for a follow-up typed either here or in the terminal itself.
#[tauri::command]
pub async fn sdd_resume_run(id: String) -> Result<HarnessRun, String> {
    let root = sdlc::vault_root()?;
    let _run_guard = run_lock(&id).lock().await;
    let mut record = load_record(&root, &id)?;
    if active_status(&record.status) && record.tab_closed_at.is_none() {
        return Err("아직 실행 중인 세션입니다".into());
    }
    let h = herdr_for(&record);
    if record.tab_closed_at.is_none() {
        // Nothing was closed: just bring the existing screen forward.
        if let Some(workspace) = record.workspace_id.as_deref() {
            let _ = h.focus_workspace(workspace).await;
        }
        if let Some(tab) = record.tab_id.as_deref() {
            let _ = h.focus_tab(tab).await;
        }
        return Ok(record.public());
    }
    reopen_session(&root, &mut record, &h, true).await?;
    Ok(record.public())
}

/// Sends one user-selected logical key only while the exact owned agent is in
/// Herdr's blocked state. This is a human UI control, never auto-approval.
#[tauri::command]
pub async fn sdd_run_key(id: String, key: String) -> Result<HarnessRun, String> {
    if !allowed_human_key(&key) {
        return Err("허용되지 않은 키입니다".into());
    }
    let root = sdlc::vault_root()?;
    let _run_guard = run_lock(&id).lock().await;
    let record = load_record(&root, &id)?;
    if record.status != "blocked" {
        return Err("blocked 상태의 실행에만 사용자 키를 보낼 수 있습니다".into());
    }
    let h = herdr_for(&record);
    let info = owned_agent(&h, &record).await?;
    if !info.blocked() {
        return Err("Herdr agent가 더 이상 blocked 상태가 아닙니다".into());
    }
    h.agent_send_keys(&record.agent_name, &[&key])
        .await
        .map_err(|e| format!("Herdr 사용자 키 전송 실패: {e}"))?;
    append_audit(&root, &record, "key", &key)?;
    // Retain `blocked` until a later observation sees an actual lifecycle
    // transition; a clicked key is never evidence of approval or completion.
    Ok(record.public())
}

#[tauri::command]
pub fn sdd_run_output(id: String) -> Result<String, String> {
    let root = sdlc::vault_root()?;
    let path = transcript_path(&root, &id)?;
    reject_symlink(&path)?;
    fs::read_to_string(path).map_err(|e| format!("실행 출력을 읽을 수 없습니다: {e}"))
}

// ---------- 에이전트별 모델 목록 ----------

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub label: String,
    pub source: ModelSource,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelSource {
    Catalog,
    Recent,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentModels {
    pub options: Vec<ModelOption>,
}

/// 최근 사용 모델은 제안일 뿐이다. 8개를 넘으면 소음이지 선택지가 아니다.
const MAX_RECENT_MODELS: usize = 8;

/// runs/ 기록에서 같은 에이전트가 최근에 쓴 모델을 모은다. created_at 내림차순으로
/// 중복을 걷어내고 최대 8개다. 손상된 기록 파일은 조용히 건너뛴다 — 모델 제안은
/// 사소한 부가 기능이라 기록 하나 때문에 함께 실패하지 않는다. runs/ 가 없으면
/// 빈 목록이고, 디렉터리를 만들지 않는다(읽기 전용 조회라서).
fn recent_models(root: &Path, agent: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root.join("runs")) else {
        return Vec::new();
    };
    let mut used: Vec<(String, String)> = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_suffix(".md") else {
            continue;
        };
        if name.ends_with(".transcript.md") || Uuid::parse_str(id).is_err() {
            continue;
        }
        let path = entry.path();
        if reject_symlink(&path).is_err() {
            continue;
        }
        let Ok(body) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(rest) = body.strip_prefix("---\n") else {
            continue;
        };
        let Some((yaml, _)) = rest.split_once("\n---\n") else {
            continue;
        };
        let Ok(record) = serde_yaml::from_str::<RunRecord>(yaml) else {
            continue;
        };
        if record.agent != agent {
            continue;
        }
        let model = record.model.trim().to_string();
        if !model.is_empty() {
            used.push((record.created_at, model));
        }
    }
    used.sort_by(|a, b| b.0.cmp(&a.0));
    let mut seen = HashSet::new();
    used.into_iter()
        .filter(|(_, model)| seen.insert(model.clone()))
        .take(MAX_RECENT_MODELS)
        .map(|(_, model)| model)
        .collect()
}

fn agent_models_at(root: &Path, agent: &str) -> AgentModels {
    let mut options: Vec<ModelOption> = Vec::new();
    if let Some((_, catalog)) = crate::agents::MODEL_CATALOGS
        .iter()
        .find(|(id, _)| *id == agent)
    {
        for spec in *catalog {
            options.push(ModelOption {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                source: ModelSource::Catalog,
            });
        }
    }
    for model in recent_models(root, agent) {
        if options.iter().any(|option| option.id == model) {
            continue;
        }
        options.push(ModelOption {
            id: model.clone(),
            label: model,
            source: ModelSource::Recent,
        });
    }
    AgentModels { options }
}

/// 에이전트별 모델 선택지. 정본 카탈로그 먼저, 그 뒤에 최근 사용 순으로.
/// vault 가 아직 초기화되지 않았어도 카탈로그는 답해야 한다 — recent 는 부가 정보다.
#[tauri::command]
pub fn agent_models(agent: String) -> Result<AgentModels, String> {
    let agent = agent.trim().to_lowercase();
    let models = match sdlc::vault_root() {
        Ok(root) => agent_models_at(&root, &agent),
        Err(_) => agent_models_at(Path::new(""), &agent),
    };
    Ok(models)
}

// ---------- 프로젝트 자동 분석 ----------

/// 분석 에이전트는 읽기만 한다. claude 의 variadic `--disallowedTools` 는 단일
/// 인자로 넘긴다 — 펼치면 뒤따르는 위치 인자를 삼킨다.
const ANALYZE_DISALLOWED_TOOLS: &str = "Bash,Write,Edit";
const ANALYZE_TIMEOUT: Duration = Duration::from_secs(180);

/// 프롬프트는 한국어로 고정한다. 프로젝트 설명은 한국어 볼트에서 읽힌다.
const ANALYZE_PROMPT: &str = "이 저장소를 분석해 1~2문장 한국어 프로젝트 설명과 검증 커맨드 후보를 JSON으로만 반환하라. 다른 텍스트 금지. 형식: {\"description\": string, \"verifyCommands\": string[]}";

/// 분석이 지금 돌고 있는 프로젝트. 같은 프로젝트를 두 번 띄우면 두 에이전트가
/// 같은 description을 경쟁하며 쓰게 되므로 애초에 막는다.
static ANALYZE_IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));

/// 분석 에이전트를 띄우기 위한 완성된 계획. 프로그램, 인자, 작업 디렉터리와
/// 입력·출력 경로가 어디로 가는지를 한데 모은다.
struct AnalyzePlan {
    program: &'static str,
    args: Vec<String>,
    cwd: PathBuf,
    /// claude 는 위치 프롬프트 대신 stdin 으로 프롬프트를 받는다.
    stdin_text: Option<String>,
    /// codex 만 최종 메시지를 파일로 받는다 — stdout 은 JSONL 이벤트 스트림이라
    /// 최종 답이 어느 줄인지 알 수 없다.
    last_message_path: Option<PathBuf>,
}

/// 분석 커맨드 조립. 프로젝트 필드만 보고 결정하는 순수 함수라 단위 테스트 대상이다.
/// 기본 에이전트가 비면 claude, 모델이 비면 모델 플래그를 뺀다.
fn analyze_plan(project: &sdlc::Project, last_message: &Path) -> AnalyzePlan {
    let repo = PathBuf::from(project.repo_path.trim());
    let model = project.default_model.trim().to_string();
    if project.default_agent.trim() == "codex" {
        let mut args = vec!["exec".to_string()];
        if !model.is_empty() {
            args.extend(["-m".to_string(), model]);
        }
        args.extend([
            "-C".to_string(),
            repo.display().to_string(),
            "-s".to_string(),
            "read-only".to_string(),
            // repoPath 가 git 저장소가 아닌 경우가 있어서 검사를 건너뛴다.
            "--skip-git-repo-check".to_string(),
            "-o".to_string(),
            last_message.display().to_string(),
            ANALYZE_PROMPT.to_string(),
        ]);
        AnalyzePlan {
            program: "codex",
            args,
            cwd: repo,
            // stdin 을 닫아야 codex 가 "Reading additional input from stdin..."
            // 에서 대기하지 않는다.
            stdin_text: None,
            last_message_path: Some(last_message.to_path_buf()),
        }
    } else {
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "json".to_string(),
        ];
        if !model.is_empty() {
            args.extend(["--model".to_string(), model]);
        }
        args.extend([
            "--disallowedTools".to_string(),
            ANALYZE_DISALLOWED_TOOLS.to_string(),
        ]);
        AnalyzePlan {
            program: "claude",
            args,
            cwd: repo,
            stdin_text: Some(ANALYZE_PROMPT.to_string()),
            last_message_path: None,
        }
    }
}

/// `claude -p --output-format json` 의 stdout 에서 최종 텍스트(`.result`)를 뽑는다.
fn claude_result(stdout: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("claude 응답을 JSON으로 읽을 수 없습니다: {e}"))?;
    value
        .get("result")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "claude 응답에 result 필드가 없습니다".to_string())
}

/// 에이전트 응답 텍스트에서 분석 JSON을 뽑아낸다. 코드펜스를 벗기고, 앞뒤 잡답
/// 사이의 JSON 도 찾아내며, description 이 비면 실패로 본다.
fn parse_analyze_output(raw: &str) -> Result<(String, Vec<String>), String> {
    let text = raw.trim();
    let text = text
        .strip_prefix("```")
        .map(|rest| {
            let without_lang = rest.split_once('\n').map(|(_, body)| body).unwrap_or(rest);
            without_lang.strip_suffix("```").unwrap_or(without_lang)
        })
        .unwrap_or(text)
        .trim();
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => {
            let Some(start) = text.find('{') else {
                return Err("분석 결과가 JSON이 아닙니다".into());
            };
            let Some(end) = text.rfind('}') else {
                return Err("분석 결과가 JSON이 아닙니다".into());
            };
            serde_json::from_str(&text[start..=end])
                .map_err(|e| format!("분석 결과가 JSON이 아닙니다: {e}"))?
        }
    };
    let description = value
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if description.is_empty() {
        return Err("분석 결과에 description이 비어 있습니다".into());
    }
    let verify = value
        .get("verifyCommands")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|row| !row.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Ok((description.to_string(), verify))
}

struct AnalyzeOutput {
    stdout: String,
    stderr: String,
    success: bool,
}

/// 커맨드를 타임아웃 180초로 돌린다. 타임아웃으로 미래가 버려질 때
/// `kill_on_drop` 이 자식 프로세스도 함께 정리한다.
async fn run_analyze_plan(plan: &AnalyzePlan) -> Result<AnalyzeOutput, String> {
    let mut cmd = tokio::process::Command::new(plan.program);
    cmd.args(&plan.args)
        .current_dir(&plan.cwd)
        .stdin(if plan.stdin_text.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("분석 에이전트 실행 실패: {e}"))?;
    if let Some(prompt) = &plan.stdin_text {
        use tokio::io::AsyncWriteExt;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "분석 에이전트 stdin을 열 수 없습니다".to_string())?;
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("분석 프롬프트 전송 실패: {e}"))?;
        stdin
            .shutdown()
            .await
            .map_err(|e| format!("분석 프롬프트 전송 실패: {e}"))?;
        drop(stdin);
    }
    let output = match tokio::time::timeout(ANALYZE_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("분석 에이전트 실행 실패: {e}")),
        Err(_) => {
            return Err(format!(
                "분석이 {}초 안에 끝나지 않았습니다",
                ANALYZE_TIMEOUT.as_secs()
            ))
        }
    };
    Ok(AnalyzeOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

/// 프로젝트를 읽고, 읽기 전용 에이전트로 돌려, description 만 교체 저장한다.
/// verifyCommands 후보는 저장하지 않고 이벤트로만 전달한다.
async fn analyze_project(project_id: String) -> Result<(String, Vec<String>), String> {
    let root = sdlc::vault_root()?;
    let project = sdlc::project_by_id(&root, &project_id)?;
    if project.repo_path.trim().is_empty() {
        return Err("프로젝트 repoPath가 비어 있어 분석할 수 없습니다".into());
    }
    if !Path::new(&project.repo_path.trim()).is_dir() {
        return Err(format!(
            "프로젝트 저장소 경로가 디렉터리가 아닙니다: {}",
            project.repo_path.trim()
        ));
    }
    let last_message =
        std::env::temp_dir().join(format!("sawhorse-analyze-{}.md", Uuid::new_v4()));
    let plan = analyze_plan(&project, &last_message);
    let output = match run_analyze_plan(&plan).await {
        Ok(output) => output,
        Err(error) => {
            let _ = fs::remove_file(&last_message);
            return Err(error);
        }
    };
    if !output.success {
        let _ = fs::remove_file(&last_message);
        return Err(format!(
            "분석 에이전트가 실패로 끝났습니다: {}",
            tail_chars(output.stderr.trim(), 200)
        ));
    }
    let raw = match plan.last_message_path.as_deref() {
        Some(path) => {
            let read = fs::read_to_string(path)
                .map_err(|e| format!("codex 최종 메시지 파일을 읽을 수 없습니다: {e}"));
            let _ = fs::remove_file(path);
            read?
        }
        None => claude_result(&output.stdout)?,
    };
    let (description, verify) = parse_analyze_output(&raw)?;
    // 방금 읽은 프로젝트를 그대로 되저장해 description 외의 필드가 보존된다.
    let mut updated = project;
    updated.description = description.clone();
    sdlc::save_project_at(&root, updated)?;
    Ok((description, verify))
}

/// 프로젝트 설명 자동 생성. 백그라운드로 스폰하고 완료 때 `project-analyzed`
/// 이벤트를 앱에 보낸다 — 분석은 분 단위로 걸릴 수 있으므로 커맨드는 즉시 돌아온다.
#[tauri::command]
pub async fn sdd_analyze_project(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let project_id = project_id.trim().to_string();
    sdlc::validate_id(&project_id)?;
    let acquired = ANALYZE_IN_FLIGHT
        .lock()
        .map(|mut set| set.insert(project_id.clone()))
        .unwrap_or(false);
    if !acquired {
        return Err(format!("이미 분석이 진행 중입니다: {project_id}"));
    }
    tauri::async_runtime::spawn(async move {
        let outcome = analyze_project(project_id.clone()).await;
        let payload = match &outcome {
            Ok((description, verify)) => serde_json::json!({
                "projectId": project_id,
                "ok": true,
                "error": Value::Null,
                "description": description,
                "verifyCommands": verify,
            }),
            Err(error) => serde_json::json!({
                "projectId": project_id,
                "ok": false,
                "error": error,
                "description": Value::Null,
                "verifyCommands": Value::Null,
            }),
        };
        use tauri::Emitter;
        let _ = app.emit("project-analyzed", payload);
        if let Ok(mut set) = ANALYZE_IN_FLIGHT.lock() {
            set.remove(&project_id);
        }
    });
    Ok(())
}

/// Parent-owned app setup may call this periodically. It performs no UI action,
/// sends no approval response, and bounds child inbox processing to eight files.
pub async fn tick() -> Result<(), String> {
    let root = sdlc::vault_root()?;
    // A missing schema must remain an explicit initialization state. Polling the
    // harness must not create `runs/` or an inbox in an untouched user vault.
    if !sdlc::snapshot(&root)?.initialized {
        return Ok(());
    }
    for record in list_records(&root)?
        .into_iter()
        .filter(|run| refreshable_status(&run.status))
    {
        let _ = refresh_run(&root, &record.id).await?;
    }
    process_inbox(&root).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sawhorse-harness-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn record(id: String, parent_run_id: Option<String>, status: &str) -> RunRecord {
        RunRecord {
            schema_version: RUN_SCHEMA,
            id,
            work_id: "work-1".into(),
            project_id: "project-1".into(),
            role: "research".into(),
            agent: "codex".into(),
            model: "gpt".into(),
            parent_run_id,
            stage: "plan".into(),
            workflow_id: workflow::DEFAULT_WORKFLOW_ID.into(),
            workflow_version: workflow::DEFAULT_WORKFLOW_VERSION.into(),
            workflow_digest: workflow::definition_digest(&workflow::builtins::sdd()).unwrap(),
            workflow_instance_id: None,
            node_run_id: None,
            status: status.into(),
            agent_name: "sdd_test".into(),
            pane_id: Some("w1:p1".into()),
            workspace_id: Some("w1".into()),
            tab_id: Some("w1:t1".into()),
            session: "default".into(),
            agent_session: None,
            prompt: "do work".into(),
            repo_path: "/repo".into(),
            extra_paths: Vec::new(),
            output_path: "runs/x.transcript.md".into(),
            created_at: now(),
            updated_at: now(),
            error: None,
            owned: true,
            inbox_request_id: None,
            cancel_requested: false,
            tab_closed_at: None,
            final_report: None,
            resumed_at: None,
        }
    }

    #[test]
    fn unchanged_terminal_snapshots_do_not_grow_the_transcript() {
        let root = tempdir("output-dedupe");
        let run = record(Uuid::new_v4().to_string(), None, "blocked");
        append_output(&root, &run, "Waiting for approval").unwrap();
        let first = fs::read_to_string(transcript_path(&root, &run.id).unwrap()).unwrap();
        append_output(&root, &run, "Waiting for approval").unwrap();
        assert_eq!(
            first,
            fs::read_to_string(transcript_path(&root, &run.id).unwrap()).unwrap()
        );
        append_output(&root, &run, "Resumed with user input").unwrap();
        let changed = fs::read_to_string(transcript_path(&root, &run.id).unwrap()).unwrap();
        assert!(changed.starts_with(&first));
        assert!(changed.contains("Resumed with user input"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_name_is_a_valid_bounded_herdr_name() {
        let name = run_agent_name("6d7c2d99-05c7-4a94-afd2-2019ddcc997a");
        assert!(name.starts_with("sdd_"));
        assert!(name.len() <= 32);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-'));
    }

    #[test]
    fn substantive_ignores_empty_template_chrome() {
        assert!(!substantive("# Plan\n\n<!-- Fill this in -->\n\n- _"));
        assert!(substantive(
            "# Plan\n\nImplement the bounded durable launch record and its recovery behavior."
        ));
    }

    #[test]
    fn initial_idle_is_review_never_complete() {
        assert_eq!(status_for_agent("idle"), "review");
        assert_eq!(status_for_agent("done"), "review");
        assert_ne!(status_for_agent("idle"), "done");
    }

    #[test]
    fn human_key_allowlist_and_continue_constraints_are_strict() {
        for key in [
            "enter", "esc", "up", "down", "left", "right", "tab", "1", "2", "3", "y", "n",
        ] {
            assert!(allowed_human_key(key));
        }
        for key in ["ctrl+c", "ENTER", "space", "yes", "4"] {
            assert!(!allowed_human_key(key));
        }
        assert!(can_continue("review", "idle"));
        assert!(can_continue("review", "done"));
        assert!(!can_continue("running", "idle"));
        assert!(!can_continue("review", "blocked"));
    }

    #[test]
    fn raw_agent_get_requires_full_owned_identity() {
        let record = record(Uuid::new_v4().to_string(), None, "running");
        let raw = serde_json::json!({"agent": {"name":"sdd_test", "agent":"codex", "pane_id":"w1:p1", "workspace_id":"w1", "tab_id":"w1:t1"}});
        assert!(raw_identity_matches(&record, &raw).is_ok());
        let wrong_pane = serde_json::json!({"agent": {"name":"sdd_test", "agent":"codex", "pane_id":"w1:p2", "workspace_id":"w1", "tab_id":"w1:t1"}});
        assert!(raw_identity_matches(&record, &wrong_pane).is_err());
    }

    #[test]
    fn parent_depth_is_bounded_and_cycle_safe() {
        let root = tempdir("depth");
        let root_run = record(Uuid::new_v4().to_string(), None, "running");
        let child = record(
            Uuid::new_v4().to_string(),
            Some(root_run.id.clone()),
            "running",
        );
        let grandchild = record(
            Uuid::new_v4().to_string(),
            Some(child.id.clone()),
            "running",
        );
        save_record(&root, &root_run).unwrap();
        save_record(&root, &child).unwrap();
        save_record(&root, &grandchild).unwrap();
        assert_eq!(parent_depth(&root, &root_run.id).unwrap(), 0);
        assert_eq!(parent_depth(&root, &child.id).unwrap(), 1);
        assert_eq!(
            parent_depth(&root, &grandchild.id).unwrap(),
            MAX_PARENT_DEPTH
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_lock_and_starting_records_enforce_max_parallel_under_race() {
        use std::sync::{Arc, Barrier};
        let root = Arc::new(tempdir("parallel"));
        let barrier = Arc::new(Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let root = root.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let _guard = launch_mutex().lock().unwrap();
                if capacity_available(&list_records(&root).unwrap(), 1) {
                    save_record(&root, &record(Uuid::new_v4().to_string(), None, "starting"))
                        .unwrap();
                    true
                } else {
                    false
                }
            }));
        }
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|accepted| *accepted)
                .count(),
            1
        );
        assert_eq!(list_records(&root).unwrap().len(), 1);
        fs::remove_dir_all(&*root).unwrap();
    }

    #[test]
    fn pending_inbox_retry_reuses_durable_request_run_after_crash() {
        let root = tempdir("inbox-retry");
        let request_id = Uuid::new_v4().to_string();
        let mut durable = record(Uuid::new_v4().to_string(), None, "starting");
        durable.inbox_request_id = Some(request_id.clone());
        save_record(&root, &durable).unwrap();
        // Simulates a crash after run persistence and before the JSON request is
        // rewritten from pending to accepted.
        let found = inbox_run_by_request(&root, &request_id).unwrap().unwrap();
        assert_eq!(found.id, durable.id);
        assert!(capacity_available(&[found], 2));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_agent_ready_is_durable_and_prevents_prompt() {
        let root = tempdir("cancel-starting");
        let mut run = record(Uuid::new_v4().to_string(), None, "starting");
        run.pane_id = None;
        run.workspace_id = None;
        run.tab_id = None;
        save_record(&root, &run).unwrap();
        request_cancel(&root, &run.id).unwrap();
        assert!(settle_cancel(&root, &mut run, None).await.unwrap());
        assert_eq!(load_record(&root, &run.id).unwrap().status, "stopped");
        assert!(!cancel_path(&root, &run.id).unwrap().exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn local_startup_cannot_be_refreshed_to_idle_before_prompt() {
        let root = tempdir("local-start");
        let run = record(Uuid::new_v4().to_string(), None, "starting");
        save_record(&root, &run).unwrap();
        starting_runs().lock().unwrap().insert(run.id.clone());
        let h = Herdr::new(&crate::config::HerdrCfg::default());
        let observed = refresh_record_with(&root, run.clone(), &h).await.unwrap();
        starting_runs().lock().unwrap().remove(&run.id);
        assert_eq!(observed.status, "starting");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stale_start_without_pane_is_failed_after_restart_window() {
        let root = tempdir("stale-start");
        let mut run = record(Uuid::new_v4().to_string(), None, "starting");
        run.pane_id = None;
        run.workspace_id = None;
        run.tab_id = None;
        run.created_at = "2000-01-01T00:00:00Z".into();
        save_record(&root, &run).unwrap();
        let h = Herdr::new(&crate::config::HerdrCfg::default());
        let recovered = refresh_record_with(&root, run, &h).await.unwrap();
        assert_eq!(recovered.status, "failed");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn fake_herdr(dir: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-herdr");
        fs::write(&path, r#"#!/bin/sh
case "$1 $2" in
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "agent start"|"agent prompt"|"agent send-keys") echo '{"result":{}}' ;;
  "tab close"|"workspace close") echo '{"result":{}}' ;;
  "agent get") echo '{"result":{"agent":{"name":"sdd_test","agent":"codex","pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","agent_status":"working"}}}' ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "tab list") echo '{"result":{"tabs":[]}}' ;;
  "agent list") echo '{"result":{"agents":[{"name":"sdd_test","agent":"codex","pane_id":"w1:p1","workspace_id":"w1","tab_id":"w1:t1","agent_status":"working"}]}}' ;;
  "agent read") echo 'captured mock agent output' ;;
  *) echo '{"error":{"code":"unexpected","message":"unexpected fake command"}}' >&2; exit 1 ;;
esac
"#).unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path.display().to_string()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mock_cli_covers_launch_read_refresh_and_owned_stop() {
        let root = tempdir("mock-cli");
        let cfg = crate::config::HerdrCfg {
            bin: fake_herdr(&root),
            ..Default::default()
        };
        let h = Herdr::new(&cfg);
        let mut run = record(Uuid::new_v4().to_string(), None, "starting");
        let workspace = h.create_workspace("sdd-test").await.unwrap();
        let tab = h.create_tab(&workspace, "test", "/tmp").await.unwrap();
        run.workspace_id = Some(workspace);
        run.tab_id = Some(tab.tab_id);
        run.pane_id = Some(tab.pane_id.clone());
        run.status = "running".into();
        save_record(&root, &run).unwrap();
        h.agent_start(&run.agent_name, &run.agent, &tab.pane_id, 10_000, &[])
            .await
            .unwrap();
        owned_agent(&h, &run).await.unwrap();
        prompt_agent(&h, &run.agent_name, &run.prompt)
            .await
            .unwrap();
        let refreshed = refresh_record_with(&root, run, &h).await.unwrap();
        assert_eq!(refreshed.status, "running");
        assert!(sdd_output_for_test(&root, &refreshed.id).contains("captured mock agent output"));
        let stopped = stop_record_with(&root, refreshed, &h).await.unwrap();
        assert_eq!(stopped.status, "stopped");
        fs::remove_dir_all(root).unwrap();
    }

    /// The pane is the disposable part: what a human still needs after a settled
    /// turn is the closing report and the session id, both on the record.
    #[cfg(unix)]
    #[tokio::test]
    async fn settled_run_closes_its_pane_and_keeps_the_closing_report() {
        let root = tempdir("settle-pane");
        let cfg = crate::config::HerdrCfg {
            bin: fake_herdr(&root),
            ..Default::default()
        };
        let h = Herdr::new(&cfg);
        let mut run = record(Uuid::new_v4().to_string(), None, "review");
        run.workspace_id = Some("w1".into());
        run.tab_id = Some("w1:t1".into());
        run.pane_id = Some("w1:p1".into());
        save_record(&root, &run).unwrap();
        close_pane(&root, &mut run, &h, Some("final agent report")).await;
        assert!(run.tab_closed_at.is_some(), "the pane is retired");
        assert_eq!(run.final_report.as_deref(), Some("final agent report"));
        assert!(sdd_output_for_test(&root, &run.id).contains("final agent report"));
        // Closing twice must not run a second time against a reused tab id.
        let closed_at = run.tab_closed_at.clone();
        close_pane(&root, &mut run, &h, Some("later noise")).await;
        assert_eq!(run.tab_closed_at, closed_at);
        assert_eq!(run.final_report.as_deref(), Some("final agent report"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_policy_decides_which_finished_panes_close() {
        // A settled turn is the harness equivalent of a successful job.
        assert!(closes_pane_at("closeOnSuccess", "review"));
        assert!(!closes_pane_at("closeOnSuccess", "failed"));
        assert!(!closes_pane_at("closeOnSuccess", "stopped"));
        assert!(closes_pane_at("closeAlways", "failed"));
        assert!(closes_pane_at("closeAlways", "stopped"));
        assert!(!closes_pane_at("keep", "review"));
        // Live runs are never touched, whatever the policy says.
        for status in ["starting", "running", "blocked"] {
            for cleanup in ["closeOnSuccess", "closeAlways", "keep"] {
                assert!(!closes_pane_at(cleanup, status), "{cleanup}/{status}");
            }
        }
    }

    #[test]
    fn closing_report_keeps_the_end_of_a_long_output() {
        assert_eq!(tail_chars("짧은 보고", 32), "짧은 보고");
        let long: String = std::iter::repeat_n('가', MAX_FINAL_REPORT + 10).collect();
        let clipped = tail_chars(&long, MAX_FINAL_REPORT);
        assert!(clipped.starts_with("…\n"));
        assert_eq!(clipped.chars().count(), MAX_FINAL_REPORT + 2);
    }

    fn sdd_output_for_test(root: &Path, id: &str) -> String {
        fs::read_to_string(transcript_path(root, id).unwrap()).unwrap()
    }

    #[test]
    fn run_record_markdown_round_trips_without_shell_output() {
        let record = record(Uuid::new_v4().to_string(), None, "starting");
        let markdown = record_markdown(&record).unwrap();
        let yaml = markdown
            .strip_prefix("---\n")
            .unwrap()
            .split_once("\n---\n")
            .unwrap()
            .0;
        let parsed: RunRecord = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(parsed.id, record.id);
        assert_eq!(parsed.agent, "codex");
    }

    #[test]
    fn run_record_extra_paths_round_trip_and_default() {
        let root = tempdir("record-extra-paths");
        let mut run = record(Uuid::new_v4().to_string(), None, "starting");
        run.extra_paths = vec!["/lib".into(), " /docs ".into()];
        save_record(&root, &run).unwrap();
        assert_eq!(
            load_record(&root, &run.id).unwrap().extra_paths,
            vec!["/lib".to_string(), " /docs ".to_string()]
        );
        let legacy: String = fs::read_to_string(record_path(&root, &run.id).unwrap())
            .unwrap()
            .lines()
            .filter(|line| {
                !line.contains("extraPaths") && !line.contains("/lib") && !line.contains("/docs")
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(record_path(&root, &run.id).unwrap(), legacy).unwrap();
        assert!(load_record(&root, &run.id).unwrap().extra_paths.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recent_models_scan_runs_descending_and_deduplicate() {
        let root = tempdir("recent-models");
        // runs/ 가 없으면 디렉터리를 만들지 않고 빈 목록이다.
        assert!(recent_models(&root, "claude").is_empty());
        fs::create_dir_all(root.join("runs")).unwrap();

        let claude_run = |model: &str, at: &str| {
            let mut run = record(Uuid::new_v4().to_string(), None, "review");
            run.agent = "claude".into();
            run.model = model.into();
            run.created_at = at.into();
            save_record(&root, &run).unwrap();
        };
        claude_run("opus", "2026-01-01T00:00:00+00:00");
        claude_run("sonnet", "2026-01-02T00:00:00+00:00");
        claude_run("opus", "2026-01-03T00:00:00+00:00");
        claude_run("   ", "2026-01-04T00:00:00+00:00");
        let mut codex_run = record(Uuid::new_v4().to_string(), None, "review");
        codex_run.agent = "codex".into();
        codex_run.model = "gpt-5-codex".into();
        save_record(&root, &codex_run).unwrap();
        // 파싱이 깨진 파일 하나는 목록 전체를 망가뜨리지 않는다.
        fs::write(root.join("runs/not-a-record.md"), "깨진 내용").unwrap();

        assert_eq!(
            recent_models(&root, "claude"),
            vec!["opus".to_string(), "sonnet".to_string()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn agent_models_lists_catalog_first_then_recent_without_duplicates() {
        let root = tempdir("agent-models");
        fs::create_dir_all(root.join("runs")).unwrap();
        let mut run = record(Uuid::new_v4().to_string(), None, "review");
        run.agent = "claude".into();
        run.model = "opus".into();
        save_record(&root, &run).unwrap();
        let mut run = record(Uuid::new_v4().to_string(), None, "review");
        run.agent = "claude".into();
        run.model = "my-finetune".into();
        save_record(&root, &run).unwrap();

        let models = agent_models_at(&root, "claude");
        let catalog: Vec<&str> = models
            .options
            .iter()
            .filter(|option| option.source == ModelSource::Catalog)
            .map(|option| option.id.as_str())
            .collect();
        assert_eq!(
            catalog,
            vec!["opus", "sonnet", "fable", "haiku"],
            "정본 카탈로그가 순서대로 먼저 온다"
        );
        assert_eq!(
            serde_json::to_value(&models.options[0]).unwrap()["source"],
            "catalog"
        );
        let recent: Vec<&str> = models
            .options
            .iter()
            .filter(|option| option.source == ModelSource::Recent)
            .map(|option| option.id.as_str())
            .collect();
        assert_eq!(recent, vec!["my-finetune"], "카탈로그에 있는 opus 는 중복 제거");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn analyze_plan_builds_read_only_commands() {
        let base = |default_agent: &str, default_model: &str| sdlc::Project {
            repo_path: "/repo".into(),
            default_agent: default_agent.into(),
            default_model: default_model.into(),
            ..Default::default()
        };

        let plan = analyze_plan(&base("codex", "gpt-5.1-codex"), Path::new("/tmp/last.md"));
        assert_eq!(plan.program, "codex");
        assert_eq!(
            plan.args,
            vec![
                "exec",
                "-m",
                "gpt-5.1-codex",
                "-C",
                "/repo",
                "-s",
                "read-only",
                "--skip-git-repo-check",
                "-o",
                "/tmp/last.md",
                ANALYZE_PROMPT,
            ]
        );
        assert!(plan.stdin_text.is_none(), "codex 는 stdin 을 닫아야 대기하지 않는다");
        assert_eq!(plan.cwd, PathBuf::from("/repo"));
        assert_eq!(plan.last_message_path.as_deref(), Some(Path::new("/tmp/last.md")));

        let plan = analyze_plan(&base("claude", "opus"), Path::new("/tmp/last.md"));
        assert_eq!(plan.program, "claude");
        assert_eq!(
            plan.args,
            vec![
                "-p",
                "--output-format",
                "json",
                "--model",
                "opus",
                "--disallowedTools",
                ANALYZE_DISALLOWED_TOOLS,
            ]
        );
        assert_eq!(plan.stdin_text.as_deref(), Some(ANALYZE_PROMPT));
        assert!(plan.last_message_path.is_none(), "claude 답은 stdout .result 로 온다");

        // 기본 에이전트·모델이 비면 claude 로 가고 모델 플래그를 생략한다.
        let plan = analyze_plan(&base("", ""), Path::new("/tmp/last.md"));
        assert_eq!(plan.program, "claude");
        assert!(!plan.args.contains(&"--model".to_string()));
    }

    #[test]
    fn claude_print_json_yields_result_field() {
        let stdout = r#"{"type":"result","result":"{\"description\":\"한줄 설명\",\"verifyCommands\":[\"cargo test\"]}","is_error":false}"#;
        let raw = claude_result(stdout).unwrap();
        let (description, verify) = parse_analyze_output(&raw).unwrap();
        assert_eq!(description, "한줄 설명");
        assert_eq!(verify, vec!["cargo test".to_string()]);
        assert!(claude_result("출력이 JSON이 아니다").is_err());
        assert!(claude_result(r#"{"is_error":false}"#).is_err());
    }

    #[test]
    fn analyze_parser_strips_code_fences_and_rejects_garbage() {
        let (description, verify) =
            parse_analyze_output("```json\n{\"description\":\"설명\",\"verifyCommands\":[\"a\",\" \"]}\n```")
                .unwrap();
        assert_eq!(description, "설명");
        assert_eq!(verify, vec!["a".to_string()], "빈 후보는 버린다");

        // 답 앞뒤로 잡답이 섞여도 JSON 만 뽑는다.
        let (description, _) = parse_analyze_output("여기 결과입니다:\n{\"description\":\"  설명  \"}")
            .unwrap();
        assert_eq!(description, "설명");

        assert!(parse_analyze_output("완전히 엉터리 답").is_err());
        assert!(parse_analyze_output("{\"verifyCommands\":[]}").is_err(), "빈 description은 실패");
    }
}
