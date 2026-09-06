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
    sync::{Mutex, OnceLock},
    time::Duration,
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::{
    config,
    herdr::{AgentInfo, Herdr},
    sdlc::{self, HarnessRun, LaunchInput},
    workflow::{self, WorkflowDefinition, WorkflowNode},
};

const RUN_SCHEMA: u32 = 1;
const MAX_INBOX_PER_TICK: usize = 8;
const MAX_OUTPUT_SNAPSHOT: usize = 24_000;
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
    output_path: String,
    created_at: String,
    updated_at: String,
    error: Option<String>,
    owned: bool,
    #[serde(default)]
    inbox_request_id: Option<String>,
    #[serde(default)]
    cancel_requested: bool,
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
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            error: self.error.clone(),
        }
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
        output_path: format!("runs/{id}.transcript.md"),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        error: None,
        owned: true,
        inbox_request_id: inbox_request_id.map(str::to_string),
        cancel_requested: false,
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
    save_record(root, record)?;
    clear_cancel(root, &record.id)?;
    Ok(true)
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
    // their cwd; this grants only the canonical vault required for artifacts.
    extra.extend(["--add-dir".to_string(), vault_dir.display().to_string()]);
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
    match h.agent_read(&record.agent_name, 200).await {
        Ok(output) => {
            append_output(root, &record, &output)?;
        }
        Err(error) => {
            append_output(root, &record, &format!("[output read failed: {error}]"))?;
        }
    }
    let status = status_for_agent(&info.status);
    update(&mut record, status, None);
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
            output_path: "runs/x.transcript.md".into(),
            created_at: now(),
            updated_at: now(),
            error: None,
            owned: true,
            inbox_request_id: None,
            cancel_requested: false,
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
}
