//! Canonical, local SDD workbench store.
//!
//! The files in this module deliberately remain boring Markdown plus YAML
//! frontmatter.  They are intended to be useful outside the desktop app (for
//! example in Obsidian) and no database is authoritative for this domain.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use chrono::{NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::workflow::{self, ActiveNode, WorkflowDefinition};

static DOMAIN_MUTATION_LOCK: OnceLock<parking_lot::Mutex<()>> = OnceLock::new();

const SCHEMA_VERSION: u32 = 1;
#[cfg(test)]
const ARTIFACTS: [&str; 5] = ["intent", "spec", "plan", "verification", "release"];
const STATUSES: [&str; 8] = [
    "backlog",
    "ready",
    "running",
    "review",
    "blocked",
    "done",
    // 반려와 취소는 다른 사건이다. 반려는 요청을 받아들이지 않은 것이고, 취소는
    // 하기로 정한 뒤 그만둔 것이다. 볼트의 개선 노트가 이미 둘을 나눠 쓴다.
    "rejected",
    "cancelled",
];
const PRIORITIES: [&str; 4] = ["urgent", "high", "normal", "low"];
const EVENT_KINDS: [&str; 4] = ["milestone", "review", "release", "meeting"];
/// 무엇으로 분류되는 요청인가. GitHub 의 issue type 과 대응한다.
const ISSUE_TYPES: [&str; 4] = ["버그", "기능", "작업", "질문"];
/// 무엇을 실행해서 끝내는가. 실행 대상·증거·기본 workflow 를 이 값이 정한다.
const EXECUTION_TYPES: [&str; 5] = ["코드", "문서", "조사", "협의", "결정"];
/// `status` 가 닫힘을 뜻하는 값. `state` 와 `closed` 는 여기서 파생한다.
const CLOSED_STATUSES: [&str; 3] = ["done", "rejected", "cancelled"];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    pub repo_path: String,
    pub depends_on: Vec<String>,
    pub verify_commands: Vec<String>,
    pub default_agent: String,
    pub default_model: String,
    /// The definition selected for newly-created work. Existing work remains pinned.
    pub workflow_id: String,
    pub workflow_version: String,
    pub workflow_digest: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Decision {
    pub stage: String,
    pub at: String,
    pub note: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkItem {
    pub id: String,
    pub title: String,
    pub description: String,
    pub project_id: String,
    pub stage: String,
    pub status: String,
    pub priority: String,
    pub owner: String,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub depends_on: Vec<String>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub decisions: Vec<Decision>,
    pub artifacts: Vec<String>,
    /// Exact immutable definition selected when this work item was created.
    pub workflow_id: String,
    pub workflow_version: String,
    pub workflow_digest: String,
    /// Durable runtime identity. Older work starts one lazily on its next command.
    pub workflow_instance_id: Option<String>,
    /// The deepest active node; separate from the root compatibility `stage`.
    pub active_nodes: Vec<ActiveNode>,

    // ---- 이슈 축 ----
    // 이슈는 별개의 저장소가 아니라 같은 개발 항목을 요청·추적의 축으로 본 것이다.
    // 단계와 산출물은 위의 workflow 가, 요청 분류와 승인·외부 연결은 아래가 소유한다.
    /// 버그 / 기능 / 작업 / 질문.
    pub issue_type: String,
    /// 코드 / 문서 / 조사 / 협의 / 결정. 실행 대상과 증거의 성격을 정한다.
    pub execution_type: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    /// 소속 마일스톤. `calendar/<id>.md` 의 `kind: milestone` 일정 ID 다.
    pub milestone: String,
    /// 설계 승인 없이는 실행 단계로 넘어가지 못하게 할지. 새 항목은 항상 true 다.
    pub approval_required: bool,
    /// 사람만 켜는 실행 승인. 볼트에서 직접 켠 값도 같은 뜻으로 읽는다.
    pub approve: bool,
    pub approved: String,
    /// `status` 에서 파생한다. 직접 쓴 값은 저장 시 덮어쓴다.
    pub state: String,
    /// 닫힌 날짜. 열린 상태로 돌아가면 지워진다.
    pub closed: String,
    pub github_repo: String,
    pub github_number: String,
    pub github_url: String,
    pub github_state: String,
    pub github_updated: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub title: String,
    pub date: String,
    pub end_date: Option<String>,
    pub kind: String,
    pub project_id: Option<String>,
    pub work_id: Option<String>,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    pub schema_version: u32,
    pub initialized: bool,
    pub vault_path: String,
    pub projects: Vec<Project>,
    pub work: Vec<WorkItem>,
    pub events: Vec<CalendarEvent>,
    pub workflows: Vec<WorkflowDefinition>,
    pub diagnostics: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Document {
    pub work_id: String,
    pub artifact: String,
    pub path: String,
    pub markdown: String,
    pub revision: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub work_id: Option<String>,
    pub artifact: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowCommandInput {
    pub work_id: String,
    pub event: String,
    pub target_node_id: Option<String>,
    pub expected_node_id: String,
    pub note: String,
    pub event_id: String,
    pub input_digest: String,
    pub facts: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct LaunchInput {
    pub work_id: String,
    pub project_id: String,
    pub role: String,
    pub agent: String,
    pub model: String,
    pub instructions: String,
    pub parent_run_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct HarnessRun {
    pub id: String,
    pub work_id: String,
    pub project_id: String,
    pub role: String,
    pub agent: String,
    pub model: String,
    pub parent_run_id: Option<String>,
    pub stage: String,
    pub workflow_id: String,
    pub workflow_version: String,
    pub workflow_digest: String,
    pub workflow_instance_id: Option<String>,
    pub node_run_id: Option<String>,
    pub status: String,
    pub agent_name: String,
    pub pane_id: Option<String>,
    pub workspace_id: Option<String>,
    pub session: String,
    pub prompt: String,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
    /// The agent's own session id, kept so a closed run can be reopened as the
    /// same conversation instead of a fresh one.
    pub agent_session: Option<String>,
    /// Set once the herdr pane was closed for this run.
    pub tab_closed_at: Option<String>,
    /// The agent's closing output, captured before the pane was closed.
    pub final_report: Option<String>,
    /// Whether "reopen in herdr" can work: a recorded session on an agent whose
    /// CLI can resume it.
    pub resumable: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Schema {
    version: u32,
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_project_workflow(project: &mut Project) {
    if project.workflow_id.trim().is_empty() {
        project.workflow_id = workflow::DEFAULT_WORKFLOW_ID.into();
    }
    if project.workflow_version.trim().is_empty() {
        project.workflow_version = workflow::DEFAULT_WORKFLOW_VERSION.into();
    }
}

fn normalize_work_workflow(work: &mut WorkItem) {
    // Legacy work was created under the fixed SDD contract. Pin it to that
    // exact definition instead of silently inheriting a later project change.
    if work.workflow_id.trim().is_empty() {
        work.workflow_id = workflow::DEFAULT_WORKFLOW_ID.into();
    }
    if work.workflow_version.trim().is_empty() {
        work.workflow_version = workflow::DEFAULT_WORKFLOW_VERSION.into();
    }
}

/// A request-local workflow index. Snapshot used to call `workflow::catalog`
/// once per project/work item and once again during validation. Keeping the
/// definitions and their digests together makes every later lookup in the
/// request memory-only.
struct SnapshotWorkflowCatalog {
    definitions: Vec<WorkflowDefinition>,
    entries: HashMap<(String, String), (usize, String)>,
}

impl SnapshotWorkflowCatalog {
    fn load(root: &Path) -> Result<Self, String> {
        let definitions = workflow::catalog(Some(root))?;
        let mut entries = HashMap::with_capacity(definitions.len());
        for (index, definition) in definitions.iter().enumerate() {
            entries.insert(
                (definition.id.clone(), definition.version.clone()),
                (index, workflow::definition_digest(definition)?),
            );
        }
        Ok(Self {
            definitions,
            entries,
        })
    }

    fn resolve(&self, id: &str, version: &str) -> Result<(&WorkflowDefinition, &str), String> {
        let (index, digest) = self
            .entries
            .get(&(id.to_string(), version.to_string()))
            .ok_or_else(|| format!("workflow를 찾을 수 없습니다: {id}@{version}"))?;
        Ok((&self.definitions[*index], digest))
    }

    fn for_work(&self, work: &WorkItem) -> Result<&WorkflowDefinition, String> {
        let (definition, digest) = self.resolve(&work.workflow_id, &work.workflow_version)?;
        if !work.workflow_digest.is_empty() && work.workflow_digest != digest {
            return Err(format!(
                "고정한 workflow digest와 설치된 정의가 다릅니다: {}@{}",
                work.workflow_id, work.workflow_version
            ));
        }
        Ok(definition)
    }

    fn for_project(&self, project: &Project) -> Result<&WorkflowDefinition, String> {
        let (definition, digest) = self.resolve(&project.workflow_id, &project.workflow_version)?;
        if !project.workflow_digest.is_empty() && project.workflow_digest != digest {
            return Err(format!(
                "프로젝트 workflow digest와 설치된 정의가 다릅니다: {}@{}",
                project.workflow_id, project.workflow_version
            ));
        }
        Ok(definition)
    }

    fn digest(&self, definition: &WorkflowDefinition) -> &str {
        self.entries
            .get(&(definition.id.clone(), definition.version.clone()))
            .map(|(_, digest)| digest.as_str())
            .unwrap_or_default()
    }
}

pub fn workflow_definition_for_work(
    root: &Path,
    work: &WorkItem,
) -> Result<WorkflowDefinition, String> {
    let catalog = SnapshotWorkflowCatalog::load(root)?;
    catalog.for_work(work).cloned()
}

fn definition_for_project(root: &Path, project: &Project) -> Result<WorkflowDefinition, String> {
    let catalog = SnapshotWorkflowCatalog::load(root)?;
    catalog.for_project(project).cloned()
}

/// The configured vault root.  Kept public for the harness module and tests.
pub fn vault_root() -> Result<PathBuf, String> {
    let value = crate::config::load_view().vault_path;
    let value = value.trim();
    if value.is_empty() {
        return Err("볼트 경로가 설정되지 않았습니다".into());
    }
    Ok(PathBuf::from(value))
}

/// IDs are filenames, so accept only a deliberately small portable alphabet.
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("id는 1~128자의 영문, 숫자, -, _ 여야 합니다".into());
    }
    if id == "."
        || id == ".."
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(format!("안전하지 않은 id: {id}"));
    }
    Ok(())
}

fn validate_one(value: &str, allowed: &[&str], label: &str) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!("유효하지 않은 {label}: {value}"))
    }
}
fn validate_stage_in(definition: &WorkflowDefinition, stage: &str) -> Result<(), String> {
    if definition.nodes.iter().any(|node| node.id == stage) {
        Ok(())
    } else {
        Err(format!(
            "workflow {}@{}에 없는 stage입니다: {stage}",
            definition.id, definition.version
        ))
    }
}

fn schema_path(root: &Path) -> PathBuf {
    root.join(".sawhorse").join("schema.json")
}
fn project_path(root: &Path, id: &str) -> PathBuf {
    root.join("projects").join(id).join("project.md")
}
fn work_path(root: &Path, id: &str) -> PathBuf {
    root.join("work").join(id).join("work.md")
}
#[cfg(test)]
fn artifact_path(root: &Path, id: &str, artifact: &str) -> PathBuf {
    root.join("work").join(id).join(format!("{artifact}.md"))
}

fn resolved_artifact_path(
    root: &Path,
    work: &WorkItem,
    definition: &WorkflowDefinition,
    artifact: &str,
) -> Result<PathBuf, String> {
    validate_id(&work.id)?;
    if !artifact
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("안전하지 않은 artifact role: {artifact}"));
    }
    workflow::resolve_artifact_path(root, definition, &work.id, &work.project_id, artifact)
}
fn event_path(root: &Path, id: &str) -> PathBuf {
    root.join("calendar").join(format!("{id}.md"))
}

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("볼트 폴더가 없습니다: {}", root.display()));
    }
    root.canonicalize()
        .map_err(|e| format!("볼트 경로 확인 실패: {e}"))
}

/// Reject `..`, absolute paths, and existing symlinks which leave the vault.
fn safe_path(root: &Path, target: &Path) -> Result<(), String> {
    let canonical = canonical_root(root)?;
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "볼트 밖 경로입니다".to_string())?;
    if relative.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("볼트 밖 경로입니다".into());
    }
    let mut probe = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("안전하지 않은 경로입니다".into());
        };
        probe.push(name);
        if probe.exists() {
            let actual = probe
                .canonicalize()
                .map_err(|e| format!("경로 확인 실패: {e}"))?;
            if !actual.starts_with(&canonical) {
                return Err("심볼릭 링크가 볼트 밖을 가리킵니다".into());
            }
        }
    }
    Ok(())
}

fn ensure_initialized(root: &Path) -> Result<(), String> {
    match read_schema(root)? {
        Some(_) => Ok(()),
        None => Err("SDD 스키마가 초기화되지 않았습니다".into()),
    }
}

fn read_schema(root: &Path) -> Result<Option<Schema>, String> {
    if !root.exists() {
        return Ok(None);
    }
    if !root.is_dir() {
        return Err("볼트 경로가 폴더가 아닙니다".into());
    }
    let path = schema_path(root);
    if !path.exists() {
        return Ok(None);
    }
    safe_path(root, &path)?;
    let schema: Schema = serde_json::from_str(
        &fs::read_to_string(&path).map_err(|e| format!("스키마 읽기 실패: {e}"))?,
    )
    .map_err(|e| format!("SDD 스키마가 손상되었습니다: {e}"))?;
    if schema.version != SCHEMA_VERSION {
        return Err(format!("지원하지 않는 SDD 스키마 버전: {}", schema.version));
    }
    Ok(Some(schema))
}

fn write_atomic(root: &Path, path: &Path, contents: &str) -> Result<(), String> {
    safe_path(root, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "파일의 상위 폴더가 없습니다".to_string())?;
    safe_path(root, parent)?;
    fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    safe_path(root, parent)?;
    let temporary = parent.join(format!(".sawhorse-{}.tmp", Uuid::new_v4()));
    safe_path(root, &temporary)?;
    fs::write(&temporary, contents).map_err(|e| format!("파일 쓰기 실패: {e}"))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("파일 교체 실패: {e}")
    })
}

fn mutation_lock() -> parking_lot::MutexGuard<'static, ()> {
    DOMAIN_MUTATION_LOCK
        .get_or_init(|| parking_lot::Mutex::new(()))
        .lock()
}

fn markdown<T: Serialize>(header: &T, body: &str) -> Result<String, String> {
    let yaml =
        serde_yaml::to_string(header).map_err(|e| format!("frontmatter 직렬화 실패: {e}"))?;
    Ok(format!("---\n{}---\n\n{}", yaml, body.trim_end()))
}

fn parse_markdown<T: for<'de> Deserialize<'de>>(contents: &str) -> Result<(T, String), String> {
    let (rest, delimiter) = if let Some(rest) = contents.strip_prefix("---\r\n") {
        (rest, "\r\n---\r\n")
    } else if let Some(rest) = contents.strip_prefix("---\n") {
        (rest, "\n---\n")
    } else {
        return Err("YAML frontmatter가 없습니다".into());
    };
    let (yaml, body) = rest
        .split_once(delimiter)
        .ok_or_else(|| "YAML frontmatter 끝 표식이 없습니다".to_string())?;
    let value = serde_yaml::from_str(yaml).map_err(|e| format!("frontmatter 파싱 실패: {e}"))?;
    Ok((value, body.trim_start_matches(['\r', '\n']).to_string()))
}

fn read_markdown<T: for<'de> Deserialize<'de>>(
    root: &Path,
    path: &Path,
) -> Result<(T, String), String> {
    safe_path(root, path)?;
    let contents = fs::read_to_string(path).map_err(|e| format!("Markdown 읽기 실패: {e}"))?;
    parse_markdown(&contents)
}

fn date(value: &str, label: &str) -> Result<(), String> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return Err(format!(
            "{label} 날짜 형식은 YYYY-MM-DD 이어야 합니다: {value}"
        ));
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| format!("{label} 날짜 형식은 YYYY-MM-DD 이어야 합니다: {value}"))
}
fn optional_date(value: &Option<String>, label: &str) -> Result<(), String> {
    if let Some(v) = value {
        date(v, label)?;
    }
    Ok(())
}

#[cfg(test)]
fn artifact_template(artifact: &str) -> String {
    workflow::builtins::sdd()
        .artifacts
        .into_iter()
        .find(|candidate| candidate.role == artifact)
        .map(|candidate| candidate.template)
        .unwrap_or_else(|| "# 문서\n\n<!-- 유효하지 않은 artifact입니다. -->\n".into())
}
fn substantial(markdown: &str) -> bool {
    // Artifact metadata describes the record, not the human evidence inside it.
    // Without stripping frontmatter, an otherwise empty document passes every
    // workflow gate merely because `type:` or `workId:` is present.
    let markdown = if markdown
        .lines()
        .next()
        .is_some_and(|line| line.trim() == "---")
    {
        let first_line_end = markdown.find('\n').map_or(markdown.len(), |at| at + 1);
        let mut cursor = first_line_end;
        let mut body = markdown;
        for line in markdown[first_line_end..].split_inclusive('\n') {
            cursor += line.len();
            if line.trim() == "---" {
                body = &markdown[cursor..];
                break;
            }
        }
        body
    } else {
        markdown
    };
    // Comments are starter text, not evidence.  Remove them before looking at
    // visible body lines; doing this as a scan also handles a comment after a
    // heading without accidentally discarding the real paragraph below it.
    let mut without_comments = String::new();
    let mut remaining = markdown;
    while let Some(start) = remaining.find("<!--") {
        without_comments.push_str(&remaining[..start]);
        let after_start = &remaining[start + 4..];
        match after_start.find("-->") {
            Some(end) => remaining = &after_start[end + 3..],
            None => {
                remaining = "";
                break;
            }
        }
    }
    without_comments.push_str(remaining);
    without_comments.lines().any(|line| {
        let value = line.trim();
        !value.is_empty() && !value.starts_with('#') && !value.starts_with("---")
    })
}
fn revision(markdown: &str) -> String {
    hex::encode(Sha256::digest(markdown.as_bytes()))
}

fn validate_project(project: &Project) -> Result<(), String> {
    validate_id(&project.id)?;
    if project.name.trim().is_empty() {
        return Err("프로젝트 이름이 비어 있습니다".into());
    }
    let mut seen = HashSet::new();
    for id in &project.depends_on {
        validate_id(id)?;
        if id == &project.id {
            return Err("프로젝트는 자신에게 의존할 수 없습니다".into());
        }
        if !seen.insert(id) {
            return Err(format!("중복된 프로젝트 의존성: {id}"));
        }
    }
    if project.verify_commands.iter().any(|v| v.trim().is_empty()) {
        return Err("빈 검증 명령은 저장할 수 없습니다".into());
    }
    Ok(())
}
/// `status` 하나가 열림·닫힘의 정본이다. 이슈 노트에서는 `state`·`closed` 를
/// 사람이 따로 맞춰야 해서 늘 어긋났다. 저장할 때마다 다시 파생시켜 그 어긋남을
/// 구조적으로 없앤다.
fn apply_closure(work: &mut WorkItem) {
    if CLOSED_STATUSES.contains(&work.status.as_str()) {
        work.state = "closed".into();
        if work.closed.trim().is_empty() {
            work.closed = Utc::now().date_naive().to_string();
        }
    } else {
        work.state = "open".into();
        work.closed.clear();
    }
}

fn validate_work(work: &WorkItem) -> Result<(), String> {
    validate_id(&work.id)?;
    if work.title.trim().is_empty() {
        return Err("작업 제목이 비어 있습니다".into());
    }
    validate_one(&work.status, &STATUSES, "status")?;
    validate_one(&work.priority, &PRIORITIES, "priority")?;
    validate_one(&work.issue_type, &ISSUE_TYPES, "issueType")?;
    validate_one(&work.execution_type, &EXECUTION_TYPES, "executionType")?;
    if !work.approved.trim().is_empty() {
        date(&work.approved, "승인")?;
    }
    if !work.closed.trim().is_empty() {
        date(&work.closed, "종료")?;
    }
    optional_date(&work.start_date, "시작")?;
    optional_date(&work.due_date, "마감")?;
    if let (Some(start), Some(end)) = (&work.start_date, &work.due_date) {
        if start > end {
            return Err("마감일은 시작일보다 앞설 수 없습니다".into());
        }
    }
    let mut seen = HashSet::new();
    for id in &work.depends_on {
        validate_id(id)?;
        if id == &work.id {
            return Err("작업은 자신에게 의존할 수 없습니다".into());
        }
        if !seen.insert(id) {
            return Err(format!("중복된 의존성: {id}"));
        }
    }
    for decision in &work.decisions {
        if decision.note.trim().is_empty() {
            return Err("결정 기록의 note가 비어 있습니다".into());
        }
    }
    Ok(())
}

fn validate_work_definition(
    work: &WorkItem,
    definition: &WorkflowDefinition,
) -> Result<(), String> {
    validate_stage_in(definition, &work.stage)?;
    for decision in &work.decisions {
        validate_stage_in(definition, &decision.stage)?;
    }
    Ok(())
}
fn validate_event(event: &CalendarEvent) -> Result<(), String> {
    validate_id(&event.id)?;
    if event.title.trim().is_empty() {
        return Err("일정 제목이 비어 있습니다".into());
    }
    date(&event.date, "시작")?;
    optional_date(&event.end_date, "종료")?;
    if let Some(end) = &event.end_date {
        if end < &event.date {
            return Err("종료일은 시작일보다 앞설 수 없습니다".into());
        }
    }
    validate_one(&event.kind, &EVENT_KINDS, "일정 종류")?;
    if let Some(id) = &event.project_id {
        validate_id(id)?;
    }
    if let Some(id) = &event.work_id {
        validate_id(id)?;
    }
    Ok(())
}

fn ids_from_dir(root: &Path, folder: &str, filename: &str) -> Result<Vec<String>, String> {
    let dir = root.join(folder);
    safe_path(root, &dir)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut ids = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("{folder} 목록 읽기 실패: {e}"))? {
        let entry = entry.map_err(|e| format!("{folder} 목록 항목 실패: {e}"))?;
        let id = entry.file_name().to_string_lossy().to_string();
        if validate_id(&id).is_ok() && entry.path().join(filename).is_file() {
            ids.push(id);
        }
    }
    ids.sort();
    Ok(ids)
}
/// Snapshot needs to distinguish an empty canonical folder from a malformed
/// entry in it.  Search can use the smaller `ids_from_dir` helper, while this
/// variant retains every actionable filesystem diagnostic for the UI.
fn snapshot_ids_from_dir(
    root: &Path,
    folder: &str,
    filename: &str,
    diagnostics: &mut Vec<String>,
) -> Vec<String> {
    let dir = root.join(folder);
    if let Err(error) = safe_path(root, &dir) {
        diagnostics.push(format!("{folder} 경로: {error}"));
        return Vec::new();
    }
    if !dir.exists() {
        diagnostics.push(format!("{folder}/ 폴더가 없습니다"));
        return Vec::new();
    }
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) => {
            diagnostics.push(format!("{folder} 목록 읽기 실패: {error}"));
            return Vec::new();
        }
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                diagnostics.push(format!("{folder} 목록 항목 실패: {error}"));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let is_directory = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        if !is_directory {
            diagnostics.push(format!("{folder}/{name}: 작업 폴더여야 합니다"));
            continue;
        }
        if let Err(error) = validate_id(&name) {
            diagnostics.push(format!("{folder}/{name}: {error}"));
            continue;
        }
        let document = path.join(filename);
        if !document.is_file() {
            diagnostics.push(format!("{folder}/{name}: {filename} 문서가 없습니다"));
            continue;
        }
        ids.push(name);
    }
    ids.sort();
    ids
}
fn list_projects_from(
    root: &Path,
    catalog: Option<&SnapshotWorkflowCatalog>,
    diagnostics: &mut Vec<String>,
) -> Vec<Project> {
    let ids = snapshot_ids_from_dir(root, "projects", "project.md", diagnostics);
    ids.into_iter()
        .filter_map(
            |id| match read_markdown::<Project>(root, &project_path(root, &id)) {
                Ok((mut value, body)) => {
                    if value.id != id {
                        diagnostics.push(format!(
                            "projects/{id}/project.md: frontmatter id({})가 폴더 이름과 다릅니다",
                            value.id
                        ));
                        None
                    } else {
                        normalize_project_workflow(&mut value);
                        if let Some(catalog) = catalog {
                            if let Ok(definition) = catalog.for_project(&value) {
                                if value.workflow_digest.is_empty() {
                                    value.workflow_digest = catalog.digest(definition).to_string();
                                }
                            }
                        }
                        value.description = body;
                        Some(value)
                    }
                }
                Err(e) => {
                    diagnostics.push(format!("projects/{id}/project.md: {e}"));
                    None
                }
            },
        )
        .collect()
}

fn list_projects(root: &Path, diagnostics: &mut Vec<String>) -> Vec<Project> {
    match SnapshotWorkflowCatalog::load(root) {
        Ok(catalog) => list_projects_from(root, Some(&catalog), diagnostics),
        Err(error) => {
            diagnostics.push(error);
            list_projects_from(root, None, diagnostics)
        }
    }
}

fn list_work_from(
    root: &Path,
    catalog: Option<&SnapshotWorkflowCatalog>,
    diagnostics: &mut Vec<String>,
) -> Vec<WorkItem> {
    let ids = snapshot_ids_from_dir(root, "work", "work.md", diagnostics);
    ids.into_iter()
        .filter_map(
            |id| match read_markdown::<WorkItem>(root, &work_path(root, &id)) {
                Ok((mut value, body)) => {
                    if value.id != id {
                        diagnostics.push(format!(
                            "work/{id}/work.md: frontmatter id({})가 폴더 이름과 다릅니다",
                            value.id
                        ));
                        None
                    } else {
                        normalize_work_workflow(&mut value);
                        value.description = body;
                        if let Some(catalog) = catalog {
                            match catalog.for_work(&value) {
                                Ok(definition) => {
                                    if value.workflow_digest.is_empty() {
                                        value.workflow_digest =
                                            catalog.digest(definition).to_string();
                                    }
                                    value.artifacts = existing_artifacts(root, &value, definition);
                                }
                                Err(error) => {
                                    diagnostics.push(format!("work/{id}/work.md: {error}"))
                                }
                            }
                        }
                        Some(value)
                    }
                }
                Err(e) => {
                    diagnostics.push(format!("work/{id}/work.md: {e}"));
                    None
                }
            },
        )
        .collect()
}

fn list_work(root: &Path, diagnostics: &mut Vec<String>) -> Vec<WorkItem> {
    match SnapshotWorkflowCatalog::load(root) {
        Ok(catalog) => list_work_from(root, Some(&catalog), diagnostics),
        Err(error) => {
            diagnostics.push(error);
            list_work_from(root, None, diagnostics)
        }
    }
}
fn list_events(root: &Path, diagnostics: &mut Vec<String>) -> Vec<CalendarEvent> {
    let dir = root.join("calendar");
    if !dir.is_dir() {
        return Vec::new();
    }
    if let Err(error) = safe_path(root, &dir) {
        diagnostics.push(format!("calendar 경로: {error}"));
        return Vec::new();
    }
    let mut output = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(v) => v,
        Err(e) => {
            diagnostics.push(format!("calendar 목록 읽기 실패: {e}"));
            return output;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            diagnostics.push(format!(
                "calendar 항목 이름을 읽을 수 없습니다: {}",
                path.display()
            ));
            continue;
        };
        if path.extension().and_then(|v| v.to_str()) != Some("md") {
            continue;
        }
        if let Err(error) = validate_id(id) {
            diagnostics.push(format!("calendar/{id}.md: {error}"));
            continue;
        }
        match read_markdown::<CalendarEvent>(root, &path) {
            Ok((mut value, body)) => {
                if value.id != id {
                    diagnostics.push(format!(
                        "calendar/{id}.md: frontmatter id({})가 파일 이름과 다릅니다",
                        value.id
                    ));
                    continue;
                }
                value.notes = body;
                output.push(value);
            }
            Err(e) => diagnostics.push(format!("calendar/{}.md: {e}", id)),
        }
    }
    output.sort_by(|a, b| a.date.cmp(&b.date).then(a.id.cmp(&b.id)));
    output
}
fn existing_artifacts(
    root: &Path,
    work: &WorkItem,
    definition: &WorkflowDefinition,
) -> Vec<String> {
    definition
        .artifacts
        .iter()
        .filter_map(|artifact| {
            let p = resolved_artifact_path(root, work, definition, &artifact.role).ok()?;
            safe_path(root, &p).ok()?;
            let contents = fs::read_to_string(p).ok()?;
            substantial(&contents).then(|| artifact.role.clone())
        })
        .collect()
}

fn validate_snapshot_records(
    catalog: &SnapshotWorkflowCatalog,
    projects: &[Project],
    work: &[WorkItem],
    events: &[CalendarEvent],
    diagnostics: &mut Vec<String>,
) {
    let project_ids: HashSet<&str> = projects.iter().map(|project| project.id.as_str()).collect();
    let work_ids: HashSet<&str> = work.iter().map(|item| item.id.as_str()).collect();
    for project in projects {
        if let Err(error) = validate_project(project) {
            diagnostics.push(format!("projects/{}/project.md: {error}", project.id));
        }
        if let Err(error) = catalog.for_project(project) {
            diagnostics.push(format!("projects/{}/project.md: {error}", project.id));
        }
        for dependency in &project.depends_on {
            if !project_ids.contains(dependency.as_str()) {
                diagnostics.push(format!(
                    "projects/{}/project.md: 존재하지 않는 프로젝트 의존성: {dependency}",
                    project.id
                ));
            }
        }
    }
    if let Err(error) = graph_acyclic(
        projects.iter().map(|project| project.id.as_str()),
        |id| {
            projects
                .iter()
                .find(|project| project.id == id)
                .map(|project| project.depends_on.clone())
                .unwrap_or_default()
        },
        "프로젝트",
    ) {
        diagnostics.push(error);
    }
    for item in work {
        // Snapshot diagnostics are deliberately cumulative.  A manually edited
        // work.md can have several bad fields; reporting only the first one
        // hides the remaining repair work from the user.
        if let Err(error) = validate_id(&item.id) {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if item.title.trim().is_empty() {
            diagnostics.push(format!(
                "work/{}/work.md: 작업 제목이 비어 있습니다",
                item.id
            ));
        }
        match catalog.for_work(item) {
            Ok(definition) => {
                if let Err(error) = validate_work_definition(item, &definition) {
                    diagnostics.push(format!("work/{}/work.md: {error}", item.id));
                }
            }
            Err(error) => diagnostics.push(format!("work/{}/work.md: {error}", item.id)),
        }
        if let Err(error) = validate_one(&item.status, &STATUSES, "status") {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if let Err(error) = validate_one(&item.priority, &PRIORITIES, "priority") {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if let Err(error) = optional_date(&item.start_date, "시작") {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if let Err(error) = optional_date(&item.due_date, "마감") {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if let Err(error) = validate_work(item) {
            diagnostics.push(format!("work/{}/work.md: {error}", item.id));
        }
        if !item.project_id.is_empty() && !project_ids.contains(item.project_id.as_str()) {
            diagnostics.push(format!(
                "work/{}/work.md: 존재하지 않는 projectId: {}",
                item.id, item.project_id
            ));
        }
        for dependency in &item.depends_on {
            if !work_ids.contains(dependency.as_str()) {
                diagnostics.push(format!(
                    "work/{}/work.md: 존재하지 않는 작업 의존성: {dependency}",
                    item.id
                ));
            }
        }
    }
    if let Err(error) = graph_acyclic(
        work.iter().map(|item| item.id.as_str()),
        |id| {
            work.iter()
                .find(|item| item.id == id)
                .map(|item| item.depends_on.clone())
                .unwrap_or_default()
        },
        "작업",
    ) {
        diagnostics.push(error);
    }
    for event in events {
        if let Err(error) = validate_event(event) {
            diagnostics.push(format!("calendar/{}.md: {error}", event.id));
        }
        if let Some(project_id) = &event.project_id {
            if !project_ids.contains(project_id.as_str()) {
                diagnostics.push(format!(
                    "calendar/{}.md: 존재하지 않는 projectId: {project_id}",
                    event.id
                ));
            }
        }
        if let Some(work_id) = &event.work_id {
            match work.iter().find(|item| item.id == *work_id) {
                None => diagnostics.push(format!(
                    "calendar/{}.md: 존재하지 않는 workId: {work_id}",
                    event.id
                )),
                Some(item)
                    if event
                        .project_id
                        .as_deref()
                        .is_some_and(|id| id != item.project_id) =>
                {
                    diagnostics.push(format!(
                        "calendar/{}.md: projectId와 workId 프로젝트가 다릅니다",
                        event.id
                    ));
                }
                Some(_) => {}
            }
        }
    }
}

/// Read a snapshot without ever dropping malformed individual records.
pub fn snapshot(root: &Path) -> Result<WorkspaceSnapshot, String> {
    let vault_path = root.to_string_lossy().to_string();
    if read_schema(root)?.is_none() {
        return Ok(WorkspaceSnapshot {
            schema_version: SCHEMA_VERSION,
            initialized: false,
            vault_path,
            ..Default::default()
        });
    }
    let mut diagnostics = Vec::new();
    // Definitions and their digests are immutable for the duration of this
    // read. Build one index and pass it through every list/validation phase.
    let catalog = SnapshotWorkflowCatalog::load(root)?;
    let projects = list_projects_from(root, Some(&catalog), &mut diagnostics);
    let mut work = list_work_from(root, Some(&catalog), &mut diagnostics);
    for item in &mut work {
        let Some(instance_id) = item.workflow_instance_id.as_deref() else {
            continue;
        };
        match workflow::ledger::get_at(root, instance_id) {
            Ok(instance) => {
                let root_stage = instance
                    .frames
                    .first()
                    .map(|frame| frame.node_id.clone())
                    .unwrap_or_else(|| item.stage.clone());
                if item.stage != root_stage || item.active_nodes != instance.active_nodes {
                    item.stage = root_stage;
                    item.active_nodes = instance.active_nodes;
                    diagnostics.push(format!(
                        "work/{}/work.md: runtime 장부 상태를 snapshot에 복구했습니다",
                        item.id
                    ));
                }
            }
            Err(error) => diagnostics.push(format!(
                "work/{}/work.md: runtime 장부를 읽을 수 없습니다: {error}",
                item.id
            )),
        }
    }
    let events = list_events(root, &mut diagnostics);
    validate_snapshot_records(&catalog, &projects, &work, &events, &mut diagnostics);
    Ok(WorkspaceSnapshot {
        schema_version: SCHEMA_VERSION,
        initialized: true,
        vault_path,
        projects,
        work,
        events,
        workflows: catalog.definitions,
        diagnostics,
    })
}

fn initialize(root: &Path) -> Result<WorkspaceSnapshot, String> {
    let _guard = mutation_lock();
    if root.as_os_str().is_empty() {
        return Err("볼트 경로가 비어 있습니다".into());
    }
    if root.exists() && !root.is_dir() {
        return Err("볼트 경로가 폴더가 아닙니다".into());
    }
    fs::create_dir_all(root).map_err(|e| format!("볼트 생성 실패: {e}"))?;
    // A future schema must be rejected before this build creates any canonical
    // folders in a vault it does not understand.
    let schema = schema_path(root);
    if schema.exists() {
        let _ = read_schema(root)?;
    }
    for dir in [
        ".sawhorse",
        ".sawhorse/workflows",
        "projects",
        "work",
        "calendar",
        "runs",
    ] {
        let path = root.join(dir);
        safe_path(root, &path)?;
        fs::create_dir_all(path).map_err(|e| format!("{dir} 생성 실패: {e}"))?;
    }
    if schema.exists() {
        let _ = read_schema(root)?;
    } else {
        write_atomic(
            root,
            &schema,
            &serde_json::to_string_pretty(&Schema {
                version: SCHEMA_VERSION,
            })
            .map_err(|e| e.to_string())?,
        )?;
    }
    workflow::ensure_builtins(root)?;
    snapshot(root)
}

fn project_by_id(root: &Path, id: &str) -> Result<Project, String> {
    validate_id(id)?;
    let (mut project, body) = read_markdown::<Project>(root, &project_path(root, id))?;
    normalize_project_workflow(&mut project);
    let definition = definition_for_project(root, &project)?;
    if project.workflow_digest.is_empty() {
        project.workflow_digest = workflow::definition_digest(&definition)?;
    }
    project.description = body;
    Ok(project)
}
fn work_by_id(root: &Path, id: &str) -> Result<WorkItem, String> {
    validate_id(id)?;
    let (mut work, body) = read_markdown::<WorkItem>(root, &work_path(root, id))?;
    normalize_work_workflow(&mut work);
    work.description = body;
    let definition = workflow_definition_for_work(root, &work)?;
    if work.workflow_digest.is_empty() {
        work.workflow_digest = workflow::definition_digest(&definition)?;
    }
    work.artifacts = existing_artifacts(root, &work, &definition);
    Ok(work)
}

fn graph_acyclic<'a>(
    nodes: impl Iterator<Item = &'a str>,
    edges: impl Fn(&str) -> Vec<String>,
    label: &str,
) -> Result<(), String> {
    fn visit(
        id: &str,
        edges: &impl Fn(&str) -> Vec<String>,
        marks: &mut HashMap<String, u8>,
        label: &str,
    ) -> Result<(), String> {
        match marks.get(id).copied() {
            Some(1) => return Err(format!("{label} 의존성 순환이 있습니다: {id}")),
            Some(2) => return Ok(()),
            _ => {}
        }
        marks.insert(id.to_string(), 1);
        for dep in edges(id) {
            visit(&dep, edges, marks, label)?;
        }
        marks.insert(id.to_string(), 2);
        Ok(())
    }
    let mut marks = HashMap::new();
    for node in nodes {
        visit(node, &edges, &mut marks, label)?;
    }
    Ok(())
}

fn validate_project_graph(root: &Path, candidate: &Project) -> Result<(), String> {
    let mut all: HashMap<String, Project> = list_projects(root, &mut Vec::new())
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    all.insert(candidate.id.clone(), candidate.clone());
    for p in all.values() {
        for dep in &p.depends_on {
            if !all.contains_key(dep) {
                return Err(format!("존재하지 않는 프로젝트 의존성: {dep}"));
            }
        }
    }
    graph_acyclic(
        all.keys().map(String::as_str),
        |id| {
            all.get(id)
                .map(|p| p.depends_on.clone())
                .unwrap_or_default()
        },
        "프로젝트",
    )
}
fn validate_work_graph(root: &Path, candidate: &WorkItem) -> Result<(), String> {
    let mut all: HashMap<String, WorkItem> = list_work(root, &mut Vec::new())
        .into_iter()
        .map(|w| (w.id.clone(), w))
        .collect();
    all.insert(candidate.id.clone(), candidate.clone());
    for w in all.values() {
        for dep in &w.depends_on {
            if !all.contains_key(dep) {
                return Err(format!("존재하지 않는 작업 의존성: {dep}"));
            }
        }
    }
    graph_acyclic(
        all.keys().map(String::as_str),
        |id| {
            all.get(id)
                .map(|w| w.depends_on.clone())
                .unwrap_or_default()
        },
        "작업",
    )
}

fn save_project_at(root: &Path, mut input: Project) -> Result<Project, String> {
    let _guard = mutation_lock();
    ensure_initialized(root)?;
    if input.id.trim().is_empty() {
        input.id = format!("project-{}", Uuid::new_v4().simple());
    }
    normalize_project_workflow(&mut input);
    validate_project(&input)?;
    let definition = workflow::resolve(Some(root), &input.workflow_id, &input.workflow_version)?;
    input.workflow_digest = workflow::definition_digest(&definition)?;
    validate_project_graph(root, &input)?;
    let body = input.description.clone();
    input.description.clear();
    write_atomic(
        root,
        &project_path(root, &input.id),
        &markdown(&input, &body)?,
    )?;
    input.description = body;
    Ok(input)
}

pub fn activate_project_workflow_at(
    root: &Path,
    project_id: &str,
    workflow_id: &str,
    workflow_version: &str,
) -> Result<Project, String> {
    validate_id(project_id)?;
    let _ = workflow::resolve(Some(root), workflow_id, workflow_version)?;
    let mut project = project_by_id(root, project_id)?;
    project.workflow_id = workflow_id.into();
    project.workflow_version = workflow_version.into();
    save_project_at(root, project)
}

fn save_work_at(root: &Path, mut input: WorkItem) -> Result<WorkItem, String> {
    let _guard = mutation_lock();
    ensure_initialized(root)?;
    if input.id.trim().is_empty() {
        input.id = format!("work-{}", Uuid::new_v4().simple());
    }
    let previous = if work_path(root, &input.id).exists() {
        Some(work_by_id(root, &input.id)?)
    } else {
        None
    };
    let is_new = previous.is_none();
    if let Some(old) = &previous {
        input.stage = old.stage.clone();
        input.created_at = old.created_at.clone();
        input.decisions = old.decisions.clone();
        input.workflow_id = old.workflow_id.clone();
        input.workflow_version = old.workflow_version.clone();
        input.workflow_digest = old.workflow_digest.clone();
        input.workflow_instance_id = old.workflow_instance_id.clone();
        input.active_nodes = old.active_nodes.clone();
    } else {
        // 호출자가 명시한 workflow 를 프로젝트 기본값보다 우선한다. 문서·조사
        // 이슈는 6종 산출물이 필요 없어 더 가벼운 정의를 골라야 한다.
        if !input.workflow_id.trim().is_empty() {
            normalize_work_workflow(&mut input);
        } else if input.project_id.trim().is_empty() {
            normalize_work_workflow(&mut input);
        } else {
            let project = project_by_id(root, &input.project_id)
                .map_err(|_| format!("존재하지 않는 프로젝트: {}", input.project_id))?;
            input.workflow_id = project.workflow_id;
            input.workflow_version = project.workflow_version;
        }
        let definition = workflow_definition_for_work(root, &input)?;
        input.workflow_digest = workflow::definition_digest(&definition)?;
        // Stage movement and its decision ledger are owned by workflow_transition.
        // Do not allow imports or a stale UI client to create work mid-flight.
        input.stage = definition.entry;
        input.decisions.clear();
        input.workflow_instance_id = None;
        input.active_nodes.clear();
    }
    if input.created_at.trim().is_empty() {
        input.created_at = now();
    }
    input.updated_at = now();
    if input.status.trim().is_empty() {
        input.status = "backlog".into();
    }
    if input.priority.trim().is_empty() {
        input.priority = "normal".into();
    }
    if input.issue_type.trim().is_empty() {
        input.issue_type = "작업".into();
    }
    if input.execution_type.trim().is_empty() {
        input.execution_type = "코드".into();
    }
    if is_new {
        // 새 항목은 예외 없이 승인 게이트를 갖는다. 필드가 없는 기존 work.md 는
        // false 로 읽히므로 진행 중인 작업이 소급해서 막히지는 않는다.
        input.approval_required = true;
    }
    if !input.approve {
        input.approved.clear();
    } else if input.approved.trim().is_empty() {
        input.approved = Utc::now().date_naive().to_string();
    }
    apply_closure(&mut input);
    if !input.milestone.trim().is_empty() {
        milestone_by_id(root, &input.milestone)?;
    }
    normalize_work_workflow(&mut input);
    if !input.project_id.trim().is_empty() {
        let _ = project_by_id(root, &input.project_id)
            .map_err(|_| format!("존재하지 않는 프로젝트: {}", input.project_id))?;
    }
    validate_work(&input)?;
    let definition = workflow_definition_for_work(root, &input)?;
    if input.workflow_digest.is_empty() {
        input.workflow_digest = workflow::definition_digest(&definition)?;
    }
    validate_work_definition(&input, &definition)?;
    validate_work_graph(root, &input)?;
    input.artifacts = existing_artifacts(root, &input, &definition);
    let body = input.description.clone();
    input.description.clear();
    write_atomic(root, &work_path(root, &input.id), &markdown(&input, &body)?)?;
    if is_new {
        // Make templates immediately visible to agents and Obsidian without
        // replacing a file an importer happened to create first.
        for artifact in &definition.artifacts {
            let path = resolved_artifact_path(root, &input, &definition, &artifact.role)?;
            if !path.exists() {
                write_atomic(root, &path, &artifact.template)?;
            }
        }
    }
    input.description = body;
    Ok(input)
}
/// 마일스톤은 `calendar/` 일정이 정본이다. 이슈가 개발 항목으로 합쳐지면서
/// 참조하는 쪽이 `work/` 로 옮겨졌으므로 존재 확인도 여기서 한 번만 한다.
fn milestone_by_id(root: &Path, id: &str) -> Result<CalendarEvent, String> {
    validate_id(id).map_err(|_| format!("유효하지 않은 마일스톤 ID: {id}"))?;
    let path = event_path(root, id);
    if !path.is_file() {
        return Err(format!("존재하지 않는 마일스톤: {id}"));
    }
    let (event, notes): (CalendarEvent, String) = read_markdown(root, &path)?;
    if event.kind != "milestone" {
        return Err(format!("마일스톤이 아닌 일정입니다: {id}"));
    }
    Ok(CalendarEvent { notes, ..event })
}

/// 마일스톤을 지우거나 일반 일정으로 바꿔도 되는지 판단한다. 개발 항목과 아직
/// 이관하지 않은 레거시 이슈 노트를 모두 본다.
fn milestone_has_issues(root: &Path, id: &str) -> bool {
    let mut diagnostics = Vec::new();
    if list_work(root, &mut diagnostics)
        .iter()
        .any(|item| item.milestone == id)
    {
        return true;
    }
    let names = crate::vault::project_pairs(root, &[])
        .into_iter()
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    crate::vault::scan_improvements(root, None, &names)
        .iter()
        .any(|n| n.milestone == id)
}

fn save_event_at(root: &Path, mut input: CalendarEvent) -> Result<CalendarEvent, String> {
    let _guard = mutation_lock();
    ensure_initialized(root)?;
    if input.id.trim().is_empty() {
        input.id = format!("event-{}", Uuid::new_v4().simple());
    }
    if input.kind != "milestone" && milestone_has_issues(root, &input.id) {
        return Err("마일스톤에 포함된 이슈를 먼저 제거해 주세요.".into());
    }
    validate_event(&input)?;
    if let Some(project) = &input.project_id {
        let _ = project_by_id(root, project)
            .map_err(|_| format!("존재하지 않는 프로젝트: {project}"))?;
    }
    if let Some(work) = &input.work_id {
        let work = work_by_id(root, work).map_err(|_| format!("존재하지 않는 작업: {work}"))?;
        if let Some(project) = &input.project_id {
            if work.project_id != *project {
                return Err("일정의 projectId와 workId 프로젝트가 다릅니다".into());
            }
        }
    }
    let body = input.notes.clone();
    input.notes.clear();
    write_atomic(
        root,
        &event_path(root, &input.id),
        &markdown(&input, &body)?,
    )?;
    input.notes = body;
    Ok(input)
}

/// Get an artifact, returning a deterministic empty template when it has not yet
/// been written.  A template alone never satisfies a stage gate.
pub fn read_document(root: &Path, work_id: &str, artifact: &str) -> Result<Document, String> {
    ensure_initialized(root)?;
    validate_id(work_id)?;
    let work = work_by_id(root, work_id)?;
    let definition = workflow_definition_for_work(root, &work)?;
    let artifact_definition = definition
        .artifacts
        .iter()
        .find(|candidate| candidate.role == artifact)
        .ok_or_else(|| format!("workflow에 artifact role이 없습니다: {artifact}"))?;
    let path = resolved_artifact_path(root, &work, &definition, artifact)?;
    let markdown = if path.exists() {
        safe_path(root, &path)?;
        fs::read_to_string(&path).map_err(|e| format!("문서 읽기 실패: {e}"))?
    } else {
        artifact_definition.template.clone()
    };
    Ok(Document {
        work_id: work_id.into(),
        artifact: artifact.into(),
        path: path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/"),
        revision: revision(&markdown),
        markdown,
    })
}
fn write_document_at(
    root: &Path,
    work_id: &str,
    artifact: &str,
    markdown_value: String,
    expected_revision: &str,
) -> Result<Document, String> {
    let _guard = mutation_lock();
    if markdown_value.len() > 4 * 1024 * 1024 {
        return Err("문서는 4 MiB를 넘을 수 없습니다".into());
    }
    let current = read_document(root, work_id, artifact)?;
    if current.revision != expected_revision {
        return Err("문서가 다른 편집으로 변경되었습니다. 새 버전을 읽고 다시 시도하세요".into());
    }
    let mut work = work_by_id(root, work_id)?;
    let definition = workflow_definition_for_work(root, &work)?;
    let path = resolved_artifact_path(root, &work, &definition, artifact)?;
    write_atomic(root, &path, &markdown_value)?;
    work.artifacts = existing_artifacts(root, &work, &definition);
    work.updated_at = now();
    let body = work.description.clone();
    work.description.clear();
    write_atomic(root, &work_path(root, work_id), &markdown(&work, &body)?)?;
    if let Some(instance_id) = work.workflow_instance_id.clone() {
        work.description = body.clone();
        let input_digest = work_input_digest(root, &work)?;
        let instance = workflow::ledger::mark_stale_at(root, &instance_id, &input_digest)?;
        work.active_nodes = instance.active_nodes;
        work.description.clear();
        write_atomic(root, &work_path(root, work_id), &markdown(&work, &body)?)?;
    }
    Ok(Document {
        revision: revision(&markdown_value),
        markdown: markdown_value,
        ..current
    })
}

fn ensure_dependencies_complete(root: &Path, work: &WorkItem) -> Result<(), String> {
    for id in &work.depends_on {
        let dep = work_by_id(root, id)?;
        if dep.status != "done" {
            return Err(format!("미완료 의존 작업이 있습니다: {id}"));
        }
    }
    Ok(())
}
fn ensure_stage_gate(
    root: &Path,
    work: &WorkItem,
    definition: &WorkflowDefinition,
    next: &str,
) -> Result<(), String> {
    let node = definition
        .nodes
        .iter()
        .find(|node| node.id == next)
        .ok_or_else(|| format!("workflow에 없는 stage입니다: {next}"))?;
    for artifact in &node.inputs {
        let doc = read_document(root, &work.id, artifact)?;
        if !substantial(&doc.markdown) {
            return Err(format!(
                "{next} 단계로 이동하려면 {artifact}.md에 실질적인 근거가 필요합니다"
            ));
        }
    }
    if node.requires_completed_dependencies {
        ensure_dependencies_complete(root, work)?;
    }
    ensure_tdd_evidence(root, work, definition, next)?;
    Ok(())
}

fn evidence_field<'a>(markdown: &'a str, key: &str) -> Option<&'a str> {
    markdown.lines().find_map(|line| {
        let line = line.trim();
        if line.starts_with("<!--") {
            return None;
        }
        line.strip_prefix(key)
            .and_then(|value| value.strip_prefix(':'))
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

fn revision_evidence(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn ensure_passing_evidence(markdown: &str, artifact: &str) -> Result<(), String> {
    if evidence_field(markdown, "result") != Some("passed")
        || evidence_field(markdown, "exitCode") != Some("0")
        || evidence_field(markdown, "command").is_none()
        || !evidence_field(markdown, "codeRevision").is_some_and(revision_evidence)
    {
        return Err(format!(
            "{artifact}에는 result: passed, 실제 command, exitCode: 0, 7자 이상의 codeRevision이 필요합니다"
        ));
    }
    Ok(())
}

fn ensure_tdd_evidence(
    root: &Path,
    work: &WorkItem,
    definition: &WorkflowDefinition,
    next: &str,
) -> Result<(), String> {
    if !definition.id.starts_with("tdd") {
        return Ok(());
    }
    match next {
        "green" => {
            let markdown = read_document(root, &work.id, "red-evidence")?.markdown;
            let exit_code =
                evidence_field(&markdown, "exitCode").and_then(|value| value.parse::<i32>().ok());
            if evidence_field(&markdown, "result") != Some("failed")
                || evidence_field(&markdown, "failureKind") != Some("assertion")
                || evidence_field(&markdown, "command").is_none()
                || !exit_code.is_some_and(|value| value != 0)
                || !evidence_field(&markdown, "testRevision").is_some_and(revision_evidence)
            {
                return Err("Red 근거에는 result: failed, failureKind: assertion, 실제 command, 0이 아닌 exitCode, 7자 이상의 testRevision이 필요합니다. 빌드·명령·환경 오류는 Red가 아닙니다".into());
            }
        }
        "refactor" => {
            ensure_passing_evidence(
                &read_document(root, &work.id, "green-evidence")?.markdown,
                "Green 근거",
            )?;
        }
        "done" => {
            ensure_passing_evidence(
                &read_document(root, &work.id, "regression")?.markdown,
                "회귀 검증",
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn ensure_node_gate(
    root: &Path,
    work: &WorkItem,
    definition: &WorkflowDefinition,
    next: &str,
) -> Result<(), String> {
    let node = definition
        .nodes
        .iter()
        .find(|node| node.id == next)
        .ok_or_else(|| format!("workflow에 없는 node입니다: {next}"))?;
    for artifact in &node.inputs {
        let doc = read_document(root, &work.id, artifact)?;
        if !substantial(&doc.markdown) {
            return Err(format!(
                "{next} node로 이동하려면 {artifact}.md에 실질적인 근거가 필요합니다"
            ));
        }
    }
    if node.requires_completed_dependencies {
        ensure_dependencies_complete(root, work)?;
    }
    ensure_tdd_evidence(root, work, definition, next)?;
    Ok(())
}

fn work_input_digest(root: &Path, work: &WorkItem) -> Result<String, String> {
    let definition = workflow_definition_for_work(root, work)?;
    let mut digest = Sha256::new();
    digest.update(work.workflow_digest.as_bytes());
    for artifact in &definition.artifacts {
        digest.update(artifact.role.as_bytes());
        let document = read_document(root, &work.id, &artifact.role)?;
        digest.update(document.revision.as_bytes());
    }
    Ok(hex::encode(digest.finalize()))
}
fn transition_at(
    root: &Path,
    id: &str,
    next: &str,
    requested_note: Option<String>,
) -> Result<WorkItem, String> {
    let work = work_by_id(root, id)?;
    if let Some(instance_id) = work.workflow_instance_id.as_deref() {
        let instance = workflow::ledger::get_at(root, instance_id)?;
        let active = instance
            .active_nodes
            .first()
            .ok_or_else(|| "완료된 workflow는 전환할 수 없습니다".to_string())?;
        let definition =
            workflow::resolve(Some(root), &active.workflow_id, &active.workflow_version)?;
        let edge = definition
            .edges
            .iter()
            .find(|edge| edge.from == active.node_id && edge.to == next && edge.condition.is_none())
            .ok_or_else(|| {
                format!(
                    "활성 runtime node에서 정의된 workflow 연결이 아닙니다: {} → {next}",
                    active.node_id
                )
            })?;
        let note = requested_note
            .filter(|note| !note.trim().is_empty())
            .ok_or_else(|| "runtime workflow 전환에는 검토 결정이 필요합니다".to_string())?;
        return workflow_command_at(
            root,
            WorkflowCommandInput {
                work_id: id.into(),
                event: edge.on.clone(),
                target_node_id: Some(next.into()),
                expected_node_id: active.node_id.clone(),
                note,
                event_id: Uuid::new_v4().to_string(),
                input_digest: work_input_digest(root, &work)?,
                facts: Default::default(),
            },
        );
    }
    transition_with_constraints_at(root, id, next, requested_note, None, None)
}

fn transition_with_constraints_at(
    root: &Path,
    id: &str,
    next: &str,
    requested_note: Option<String>,
    requested_event: Option<&str>,
    expected_node: Option<&str>,
) -> Result<WorkItem, String> {
    let _guard = mutation_lock();
    ensure_initialized(root)?;
    validate_id(id)?;
    let mut work = work_by_id(root, id)?;
    if expected_node.is_some_and(|expected| expected != work.stage) {
        return Err(format!(
            "workflow node가 변경되었습니다. 예상 {}, 현재 {}",
            expected_node.unwrap_or_default(),
            work.stage
        ));
    }
    let definition = workflow_definition_for_work(root, &work)?;
    validate_stage_in(&definition, next)?;
    let current = definition
        .nodes
        .iter()
        .position(|node| node.id == work.stage)
        .ok_or_else(|| "현재 stage가 유효하지 않습니다".to_string())?;
    let target = definition
        .nodes
        .iter()
        .position(|node| node.id == next)
        .expect("validated target node");
    let edge = definition
        .edges
        .iter()
        .find(|edge| {
            edge.from == work.stage
                && edge.to == next
                && requested_event.is_none_or(|event| edge.on == event)
                && edge.condition.is_none()
        })
        .ok_or_else(|| format!("정의된 workflow 연결이 아닙니다: {} → {next}", work.stage))?;
    if target > current {
        ensure_stage_gate(root, &work, &definition, next)?;
    }
    let old = work.stage.clone();
    let review_note = match requested_note {
        Some(note) if note.trim().is_empty() && target > current => {
            return Err("앞으로 전환할 때 검토 결정 note는 비어 있을 수 없습니다".into())
        }
        Some(note) if note.trim().is_empty() => "이전 단계로 이동하여 재검토".into(),
        Some(note) => note.trim().to_string(),
        None if target > current => return Err("다음 단계로 이동할 검토 결정이 필요합니다".into()),
        None => format!("이전 단계로 이동하여 재검토: {old} → {next}"),
    };
    let timestamp = now();
    work.decisions.push(Decision {
        stage: old.clone(),
        at: timestamp.clone(),
        note: review_note,
    });
    work.stage = next.into();
    work.updated_at = timestamp;
    work.decisions.push(Decision {
        stage: next.into(),
        at: work.updated_at.clone(),
        note: format!("Workflow event {}: {old} → {next}", edge.on),
    });
    work.artifacts = existing_artifacts(root, &work, &definition);
    let body = work.description.clone();
    work.description.clear();
    write_atomic(root, &work_path(root, id), &markdown(&work, &body)?)?;
    work.description = body;
    Ok(work)
}

fn workflow_command_at(root: &Path, input: WorkflowCommandInput) -> Result<WorkItem, String> {
    let _guard = mutation_lock();
    validate_id(&input.work_id)?;
    if input.event.trim().is_empty() {
        return Err("workflow event가 비어 있습니다".into());
    }
    let note = input.note.trim();
    if note.is_empty() {
        return Err("workflow 전환 note는 비어 있을 수 없습니다".into());
    }
    let mut work = work_by_id(root, &input.work_id)?;
    let current_digest = work_input_digest(root, &work)?;
    if !input.input_digest.is_empty() && input.input_digest != current_digest {
        return Err(
            "작업 입력이 화면을 연 뒤 변경되었습니다. 새 상태를 읽고 다시 시도하세요".into(),
        );
    }
    let existing_instance = work
        .workflow_instance_id
        .as_deref()
        .map(|id| workflow::ledger::get_at(root, id))
        .transpose()?;
    let active = existing_instance
        .as_ref()
        .and_then(|instance| instance.active_nodes.first())
        .cloned()
        .unwrap_or_else(|| ActiveNode {
            workflow_id: work.workflow_id.clone(),
            workflow_version: work.workflow_version.clone(),
            node_id: work.stage.clone(),
            ..Default::default()
        });
    if active.node_id != input.expected_node_id {
        return Err(format!(
            "workflow node가 변경되었습니다. 예상 {}, 현재 {}",
            input.expected_node_id, active.node_id
        ));
    }
    let definition = workflow::resolve(Some(root), &active.workflow_id, &active.workflow_version)?;
    let candidates: Vec<_> = definition
        .edges
        .iter()
        .filter(|edge| {
            edge.from == active.node_id
                && edge.on == input.event
                && workflow::runtime::condition_matches(edge.condition.as_ref(), &input.facts)
                && input
                    .target_node_id
                    .as_deref()
                    .is_none_or(|target| target == edge.to)
        })
        .collect();
    if candidates.len() != 1 {
        return Err(if candidates.is_empty() {
            format!(
                "{} node에서 처리할 수 없는 event입니다: {}",
                active.node_id, input.event
            )
        } else {
            "여러 전환이 일치합니다. targetNodeId 또는 구조화된 조건 fact가 필요합니다".into()
        });
    }
    ensure_node_gate(root, &work, &definition, &candidates[0].to)?;
    let instance = match existing_instance {
        Some(instance) => instance,
        None => workflow::ledger::start_at(
            root,
            workflow::WorkflowInstanceStartInput {
                work_id: work.id.clone(),
                project_id: work.project_id.clone(),
                workflow_id: work.workflow_id.clone(),
                workflow_version: work.workflow_version.clone(),
                input_digest: current_digest.clone(),
            },
        )?,
    };
    let instance = workflow::ledger::command_at(
        root,
        workflow::WorkflowInstanceCommandInput {
            instance_id: instance.id.clone(),
            event_id: if input.event_id.is_empty() {
                Uuid::new_v4().to_string()
            } else {
                input.event_id.clone()
            },
            event: input.event.clone(),
            facts: input.facts,
            expected_node_id: input.expected_node_id.clone(),
            input_digest: current_digest,
        },
    )?;
    let old = active.node_id;
    let next = instance
        .active_nodes
        .first()
        .map(|node| node.node_id.clone())
        .unwrap_or_else(|| candidates[0].to.clone());
    let timestamp = now();
    work.workflow_instance_id = Some(instance.id);
    work.active_nodes = instance.active_nodes;
    work.stage = instance
        .frames
        .first()
        .map(|frame| frame.node_id.clone())
        .unwrap_or_else(|| candidates[0].to.clone());
    work.updated_at = timestamp.clone();
    work.decisions.push(Decision {
        stage: old.clone(),
        at: timestamp.clone(),
        note: note.into(),
    });
    work.decisions.push(Decision {
        stage: next.clone(),
        at: timestamp,
        note: format!("Workflow event {}: {old} → {next}", input.event),
    });
    let pinned = workflow_definition_for_work(root, &work)?;
    work.artifacts = existing_artifacts(root, &work, &pinned);
    let body = work.description.clone();
    work.description.clear();
    write_atomic(root, &work_path(root, &work.id), &markdown(&work, &body)?)?;
    work.description = body;
    Ok(work)
}

fn canonical_markdown_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for id in ids_from_dir(root, "projects", "project.md")? {
        paths.push(project_path(root, &id));
    }
    for id in ids_from_dir(root, "work", "work.md")? {
        paths.push(work_path(root, &id));
        let work = work_by_id(root, &id)?;
        let definition = workflow_definition_for_work(root, &work)?;
        for artifact in &definition.artifacts {
            let p = resolved_artifact_path(root, &work, &definition, &artifact.role)?;
            if p.is_file() {
                paths.push(p);
            }
        }
    }
    let calendar = root.join("calendar");
    if calendar.is_dir() {
        safe_path(root, &calendar)?;
        for entry in fs::read_dir(calendar).map_err(|e| e.to_string())?.flatten() {
            if entry.path().extension().and_then(|v| v.to_str()) == Some("md") {
                paths.push(entry.path());
            }
        }
    }
    let runs = root.join("runs");
    if runs.is_dir() {
        safe_path(root, &runs)?;
        for entry in fs::read_dir(runs).map_err(|e| e.to_string())?.flatten() {
            if entry.path().extension().and_then(|v| v.to_str()) == Some("md") {
                paths.push(entry.path());
            }
        }
    }
    Ok(paths)
}
fn first_title(markdown: &str, fallback: &str) -> String {
    markdown
        .lines()
        .find_map(|line| line.strip_prefix("# "))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}
fn search_title(root: &Path, path: &Path, relative: &str, text: &str) -> String {
    if let Some(id) = relative
        .strip_prefix("projects/")
        .and_then(|v| v.strip_suffix("/project.md"))
    {
        if let Ok(project) = project_by_id(root, id) {
            return project.name;
        }
    }
    if let Some(id) = relative
        .strip_prefix("work/")
        .and_then(|v| v.strip_suffix("/work.md"))
    {
        if let Ok(work) = work_by_id(root, id) {
            return work.title;
        }
    }
    if relative.starts_with("calendar/") {
        if let Ok((event, _)) = read_markdown::<CalendarEvent>(root, path) {
            return event.title;
        }
    }
    let fallback = path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("document");
    first_title(text, fallback)
}
fn snippet(markdown: &str, offset: usize, len: usize) -> String {
    let start = markdown[..offset].rfind('\n').map(|v| v + 1).unwrap_or(0);
    let end = markdown[offset + len..]
        .find('\n')
        .map(|v| offset + len + v)
        .unwrap_or(markdown.len());
    markdown[start..end].trim().chars().take(280).collect()
}
fn search_at(root: &Path, query: &str) -> Result<Vec<SearchHit>, String> {
    ensure_initialized(root)?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut ranked: Vec<(usize, SearchHit)> = Vec::new();
    for path in canonical_markdown_paths(root)? {
        safe_path(root, &path)?;
        let text = match fs::read_to_string(&path) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let lower = text.to_lowercase();
        let Some(index) = lower.find(&needle) else {
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let title = search_title(root, &path, &relative, &text);
        let work_id = relative
            .strip_prefix("work/")
            .and_then(|v| v.split('/').next())
            .map(str::to_string);
        let artifact = work_id.as_ref().and_then(|work_id| {
            let work = work_by_id(root, work_id).ok()?;
            let definition = workflow_definition_for_work(root, &work).ok()?;
            definition.artifacts.iter().find_map(|artifact| {
                let resolved =
                    resolved_artifact_path(root, &work, &definition, &artifact.role).ok()?;
                (resolved == path).then(|| artifact.role.clone())
            })
        });
        let title_lower = title.to_lowercase();
        let occurrences = lower.match_indices(&needle).count();
        let score = if title_lower.starts_with(&needle) {
            0
        } else if title_lower.contains(&needle) {
            1
        } else {
            2
        } + 100usize.saturating_sub(occurrences.min(100));
        ranked.push((
            score,
            SearchHit {
                path: relative,
                title,
                snippet: snippet(&text, index, needle.len()),
                work_id,
                artifact,
            },
        ));
    }
    ranked.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.path.cmp(&b.1.path)));
    Ok(ranked.into_iter().map(|(_, hit)| hit).collect())
}

// ---------- 레거시 이슈 노트 이관 ----------
//
// 이슈와 개발 항목이 하나의 저장소가 된 뒤에도, 이름을 바꾸기 전 볼트에 쌓인
// `<프로젝트>/<이름>/이슈/*.md` 는 그대로 남는다. 이 절은 그 노트를 개발 항목으로
// 옮기되, 원본을 지우거나 옮기지 않고 `migrated_to` 표시만 남긴다. 되돌릴 수
// 있어야 사용자가 실제 볼트에서 이관을 시도할 수 있다.

/// 이관 계획 한 줄. `blocked` 가 비어 있을 때만 실제로 옮길 수 있다.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueMigrationItem {
    pub path: String,
    pub project: String,
    pub issue_id: String,
    pub title: String,
    pub work_id: String,
    pub status: String,
    pub issue_type: String,
    pub execution_type: String,
    pub milestone: String,
    pub legacy: bool,
    pub blocked: String,
    pub migrated: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IssueMigrationReport {
    pub migrated: Vec<IssueMigrationItem>,
    pub skipped: Vec<IssueMigrationItem>,
}

/// 이슈 노트의 상태 어휘를 개발 항목의 상태 하나로 접는다. 두 어휘를 나란히
/// 두는 것이 이슈·개발이 갈라져 보이던 가장 큰 이유였다.
fn work_status_from_note(status: &str) -> &'static str {
    match status {
        "제안" | "접수" | "" => "backlog",
        "승인대기" => "review",
        "승인" => "ready",
        "진행중" | "구현중" | "부분완료" | "부분구현" => "running",
        "보류" => "blocked",
        "완료" | "구현완료" => "done",
        "반려" => "rejected",
        "취소" => "cancelled",
        _ => "backlog",
    }
}

fn work_priority_from_note(priority: &str) -> &'static str {
    match priority {
        "긴급" => "urgent",
        "중요" | "높음" => "high",
        "낮음" => "low",
        _ => "normal",
    }
}

fn one_of<'a>(value: &'a str, allowed: &[&str], fallback: &'a str) -> String {
    if allowed.contains(&value) {
        value.to_string()
    } else {
        fallback.to_string()
    }
}

/// `## 제목` 절을 본문째 잘라낸다. 다음 같은 수준 이상의 헤더 직전까지가 범위다.
fn section_of(markdown: &str, heading: &str) -> String {
    let mut out = String::new();
    let mut collecting = false;
    for line in markdown.lines() {
        let trimmed = line.trim_end();
        if collecting {
            let level = trimmed.len() - trimmed.trim_start_matches('#').len();
            if trimmed.starts_with('#') && level > 0 && level <= 2 {
                break;
            }
            out.push_str(trimmed);
            out.push('\n');
            continue;
        }
        if trimmed.trim_start_matches('#').trim() == heading && trimmed.starts_with("##") {
            collecting = true;
        }
    }
    out.trim().to_string()
}

/// 볼트 폴더 이름을 코어 프로젝트 ID 로 바꾼다. 이미 같은 이름의 프로젝트가
/// 있으면 그것을 쓰고, 없으면 만든다 — 이관 결과가 프로젝트 화면에서도 같은
/// 프로젝트로 보여야 한다.
fn ensure_project_for(root: &Path, folder: &str) -> Result<String, String> {
    let mut diagnostics = Vec::new();
    let existing = list_projects(root, &mut diagnostics);
    if let Some(found) = existing
        .iter()
        .find(|project| project.id == folder || project.name == folder)
    {
        return Ok(found.id.clone());
    }
    let sanitized: String = folder
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        .collect();
    let id = if validate_id(&sanitized).is_ok() && !existing.iter().any(|p| p.id == sanitized) {
        sanitized
    } else {
        format!("project-{}", Uuid::new_v4().simple())
    };
    let project = save_project_at(
        root,
        Project {
            id: id.clone(),
            name: folder.to_string(),
            description: "레거시 이슈 노트를 이관하면서 만든 프로젝트입니다.".into(),
            ..Default::default()
        },
    )?;
    Ok(project.id)
}

fn migration_item(root: &Path, note: &crate::vault::ImprovementNote) -> IssueMigrationItem {
    let work_id = note.id.trim().to_string();
    let mut blocked = String::new();
    let migrated = !note.migrated_to.trim().is_empty();
    if migrated {
        blocked = format!("이미 {} 로 이관했습니다", note.migrated_to);
    } else if work_id.is_empty() {
        blocked = "이슈 ID가 없어 개발 항목 ID를 정할 수 없습니다".into();
    } else if validate_id(&work_id).is_err() {
        blocked = "이슈 ID에 영문·숫자·-·_ 외의 문자가 있습니다".into();
    } else if work_path(root, &work_id).exists() {
        blocked = format!("같은 ID의 개발 항목이 이미 있습니다: {work_id}");
    }
    IssueMigrationItem {
        path: note.path.clone(),
        project: note.project.clone(),
        issue_id: note.id.clone(),
        title: note.title.clone(),
        work_id,
        status: work_status_from_note(&note.status).to_string(),
        issue_type: one_of(&note.issue_type, &ISSUE_TYPES, "작업"),
        execution_type: one_of(&note.execution_type, &EXECUTION_TYPES, "코드"),
        milestone: note.milestone.clone(),
        legacy: note.legacy,
        blocked,
        migrated,
    }
}

fn legacy_issue_notes(root: &Path) -> Vec<crate::vault::ImprovementNote> {
    let names: Vec<String> = crate::vault::project_pairs(root, &[])
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    crate::vault::scan_issues(root, None, &names)
}

/// 무엇이 옮겨지고 무엇이 막혀 있는지 먼저 보여준다. 이 함수는 아무것도 쓰지 않는다.
pub fn plan_issue_migration(root: &Path) -> Result<Vec<IssueMigrationItem>, String> {
    ensure_initialized(root)?;
    let mut items: Vec<IssueMigrationItem> = legacy_issue_notes(root)
        .iter()
        .map(|note| migration_item(root, note))
        .collect();
    items.sort_by(|a, b| {
        a.project
            .cmp(&b.project)
            .then(a.issue_id.cmp(&b.issue_id))
            .then(a.path.cmp(&b.path))
    });
    Ok(items)
}

fn migrate_one(
    root: &Path,
    note: &crate::vault::ImprovementNote,
    item: &IssueMigrationItem,
) -> Result<(), String> {
    let markdown = fs::read_to_string(&note.path).map_err(|e| format!("노트 읽기 실패: {e}"))?;
    let project_id = if note.project.trim().is_empty() {
        String::new()
    } else {
        ensure_project_for(root, &note.project)?
    };

    let work = save_work_at(
        root,
        WorkItem {
            id: item.work_id.clone(),
            title: if note.title.trim().is_empty() {
                item.work_id.clone()
            } else {
                note.title.clone()
            },
            project_id,
            status: item.status.clone(),
            priority: work_priority_from_note(&note.priority).to_string(),
            issue_type: item.issue_type.clone(),
            execution_type: item.execution_type.clone(),
            labels: note.labels.clone(),
            assignees: note.assignees.clone(),
            milestone: note.milestone.clone(),
            approve: note.approve,
            approved: note.approved.clone(),
            github_repo: note.github_repo.clone(),
            github_number: note.github_number.clone(),
            github_url: note.github_url.clone(),
            github_state: note.github_state.clone(),
            github_updated: note.github_updated.clone(),
            // 원본 노트가 가진 절은 요청·설계·결과 셋뿐이다. 실행 유형과 무관하게
            // 같은 모양의 경량 흐름에 얹는 편이 없는 산출물을 지어내지 않는다.
            workflow_id: workflow::ISSUE_WORKFLOW_ID.into(),
            workflow_version: workflow::DEFAULT_WORKFLOW_VERSION.into(),
            ..Default::default()
        },
    )?;

    let request = [
        section_of(&markdown, "배경 및 요청"),
        section_of(&markdown, "문제상황"),
        section_of(&markdown, "근거 및 분석"),
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join("\n\n");
    let design = section_of(&markdown, "설계");
    let result = section_of(&markdown, "결과");

    let definition = workflow_definition_for_work(root, &work)?;
    for (role, heading, body) in [
        ("intent", "요청", request),
        ("spec", "설계", design),
        ("verification", "결과", result),
    ] {
        if body.trim().is_empty() {
            continue;
        }
        let path = resolved_artifact_path(root, &work, &definition, role)?;
        let contents = format!(
            "# {heading}\n\n{body}\n\n---\n\n<!-- {} 에서 이관했습니다. -->\n",
            note.path
        );
        write_atomic(root, &path, &contents)?;
    }

    // 원본은 지우지 않는다. 표시만 남겨 두 곳에 같은 이슈가 살아 있는 상태를 막는다.
    let stamped =
        crate::extensions::github::update_frontmatter_field(&markdown, "migrated_to", &work.id)?;
    crate::config::write_atomic(Path::new(&note.path), stamped.as_bytes())
        .map_err(|e| format!("이관 표시 실패: {e}"))?;
    Ok(())
}

/// 선택한 노트만 옮긴다. 하나가 실패해도 나머지는 계속하고 사유를 함께 돌려준다.
pub fn migrate_issues(root: &Path, paths: &[String]) -> Result<IssueMigrationReport, String> {
    ensure_initialized(root)?;
    // 경로는 문자열이 아니라 실제 파일로 비교한다. 구분자와 대소문자가 호출자마다
    // 다르게 들어오는 것이 이 경로에서 조용히 아무것도 안 하는 원인이 된다.
    let resolve = |value: &str| fs::canonicalize(value).unwrap_or_else(|_| PathBuf::from(value));
    let wanted: HashSet<PathBuf> = paths.iter().map(|p| resolve(p)).collect();
    let mut report = IssueMigrationReport::default();
    for note in legacy_issue_notes(root) {
        if !wanted.contains(&resolve(&note.path)) {
            continue;
        }
        let mut item = migration_item(root, &note);
        if !item.blocked.is_empty() {
            report.skipped.push(item);
            continue;
        }
        match migrate_one(root, &note, &item) {
            Ok(()) => report.migrated.push(item),
            Err(error) => {
                item.blocked = error;
                report.skipped.push(item);
            }
        }
    }
    Ok(report)
}

// Tauri command wrappers.  The UI intentionally receives domain errors rather
// than a fabricated in-memory fallback when its vault or runner is unavailable.
#[tauri::command]
pub fn sdd_snapshot() -> Result<WorkspaceSnapshot, String> {
    let root = vault_root()?;
    snapshot(&root)
}
#[tauri::command]
pub fn issue_migration_plan() -> Result<Vec<IssueMigrationItem>, String> {
    let root = vault_root()?;
    plan_issue_migration(&root)
}
#[tauri::command]
pub fn issue_migrate(paths: Vec<String>) -> Result<IssueMigrationReport, String> {
    let root = vault_root()?;
    migrate_issues(&root, &paths)
}
#[tauri::command]
pub fn workflow_snapshot() -> Result<WorkspaceSnapshot, String> {
    sdd_snapshot()
}
#[tauri::command]
pub fn workflow_command(input: WorkflowCommandInput) -> Result<WorkItem, String> {
    let root = vault_root()?;
    workflow_command_at(&root, input)
}
#[tauri::command]
pub fn artifact_read(work_id: String, artifact_role: String) -> Result<Document, String> {
    let root = vault_root()?;
    read_document(&root, &work_id, &artifact_role)
}
#[tauri::command]
pub fn artifact_write(
    work_id: String,
    artifact_role: String,
    markdown: String,
    revision: String,
) -> Result<Document, String> {
    let root = vault_root()?;
    write_document_at(&root, &work_id, &artifact_role, markdown, &revision)
}
#[tauri::command]
pub fn sdd_initialize() -> Result<WorkspaceSnapshot, String> {
    let root = vault_root()?;
    initialize(&root)
}
#[tauri::command]
pub fn sdd_save_project(input: Project) -> Result<Project, String> {
    let root = vault_root()?;
    save_project_at(&root, input)
}
#[tauri::command]
pub fn sdd_save_work(input: WorkItem) -> Result<WorkItem, String> {
    let root = vault_root()?;
    save_work_at(&root, input)
}
#[tauri::command]
pub fn sdd_transition(id: String, stage: String, note: Option<String>) -> Result<WorkItem, String> {
    let root = vault_root()?;
    transition_at(&root, &id, &stage, note)
}
#[tauri::command]
pub fn sdd_read_document(work_id: String, artifact: String) -> Result<Document, String> {
    let root = vault_root()?;
    read_document(&root, &work_id, &artifact)
}
#[tauri::command]
pub fn sdd_write_document(
    work_id: String,
    artifact: String,
    markdown: String,
    revision: String,
) -> Result<Document, String> {
    let root = vault_root()?;
    write_document_at(&root, &work_id, &artifact, markdown, &revision)
}
#[tauri::command]
pub fn sdd_save_event(input: CalendarEvent) -> Result<CalendarEvent, String> {
    let root = vault_root()?;
    save_event_at(&root, input)
}
#[tauri::command]
pub fn sdd_delete_event(id: String) -> Result<(), String> {
    let _guard = mutation_lock();
    let root = vault_root()?;
    ensure_initialized(&root)?;
    validate_id(&id)?;
    if milestone_has_issues(&root, &id) {
        return Err("마일스톤에 포함된 이슈를 먼저 제거해 주세요.".into());
    }
    let path = event_path(&root, &id);
    if !path.exists() {
        return Err(format!("일정을 찾을 수 없습니다: {id}"));
    }
    safe_path(&root, &path)?;
    fs::remove_file(path).map_err(|e| format!("일정 삭제 실패: {e}"))
}
#[tauri::command]
pub fn sdd_search(query: String) -> Result<Vec<SearchHit>, String> {
    let root = vault_root()?;
    search_at(&root, &query)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tempdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sawhorse-sdd-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }
    fn project(id: &str) -> Project {
        Project {
            id: id.into(),
            name: id.into(),
            ..Default::default()
        }
    }
    fn work(id: &str, project_id: &str) -> WorkItem {
        WorkItem {
            id: id.into(),
            title: id.into(),
            project_id: project_id.into(),
            stage: "intent".into(),
            status: "backlog".into(),
            priority: "normal".into(),
            ..Default::default()
        }
    }
    /// 이슈와 개발 항목이 한 저장소가 된 뒤로 `status` 하나가 열림·닫힘의 정본이다.
    /// 손으로 `state` 를 적어 넣어도 저장하면 상태에서 다시 파생되어야 한다.
    #[test]
    fn status_is_the_single_source_of_open_and_closed() {
        let root = tempdir("closure");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();

        let open = save_work_at(
            &root,
            WorkItem {
                state: "closed".into(),
                closed: "2020-01-01".into(),
                ..work("a", "p")
            },
        )
        .unwrap();
        assert_eq!(open.state, "open");
        assert_eq!(open.closed, "");
        assert!(open.approval_required, "새 항목은 승인 게이트를 갖는다");
        assert_eq!(open.issue_type, "작업");
        assert_eq!(open.execution_type, "코드");

        let done = save_work_at(
            &root,
            WorkItem {
                status: "done".into(),
                ..open.clone()
            },
        )
        .unwrap();
        assert_eq!(done.state, "closed");
        assert!(!done.closed.is_empty());

        let cancelled = save_work_at(
            &root,
            WorkItem {
                status: "cancelled".into(),
                closed: String::new(),
                ..done.clone()
            },
        )
        .unwrap();
        assert_eq!(cancelled.state, "closed");

        let reopened = save_work_at(
            &root,
            WorkItem {
                status: "running".into(),
                ..cancelled
            },
        )
        .unwrap();
        assert_eq!(reopened.state, "open");
        assert_eq!(reopened.closed, "", "다시 열면 종료일이 남지 않는다");

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn work_rejects_unknown_milestone_and_execution_type() {
        let root = tempdir("work-issue-fields");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();

        assert!(save_work_at(
            &root,
            WorkItem {
                milestone: "없는마일스톤".into(),
                ..work("a", "p")
            },
        )
        .is_err());
        assert!(save_work_at(
            &root,
            WorkItem {
                execution_type: "잡담".into(),
                ..work("b", "p")
            },
        )
        .is_err());

        save_event_at(
            &root,
            CalendarEvent {
                id: "m1".into(),
                title: "M1".into(),
                date: "2026-10-01".into(),
                kind: "milestone".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let ok = save_work_at(
            &root,
            WorkItem {
                milestone: "m1".into(),
                execution_type: "문서".into(),
                ..work("c", "p")
            },
        )
        .unwrap();
        assert_eq!(ok.milestone, "m1");
        assert!(milestone_has_issues(&root, "m1"));

        fs::remove_dir_all(root).unwrap();
    }

    /// 레거시 이슈 노트는 개발 항목이 되고 원본은 표시만 남는다. 되돌릴 수 없는
    /// 이동이었다면 실제 볼트에서 이관을 시도할 수 없다.
    #[test]
    fn legacy_issue_note_becomes_a_work_item_without_losing_the_original() {
        let root = tempdir("issue-migration");
        initialize(&root).unwrap();
        let dir = root.join("프로젝트/FDR/이슈");
        fs::create_dir_all(&dir).unwrap();
        let note = dir.join("FDR-001 검색 오류.md");
        fs::write(
            &note,
            "---\ntype: 이슈\nid: FDR-001\nissue_type: 버그\nexecution_type: 코드\npriority: 중요\nstatus: 승인\napprove: true\nlabels: [검색]\n---\n\n## 배경 및 요청\n\n검색 버튼이 동작하지 않는다.\n\n## 설계\n\n### 실행 대상\n\nSearchDAO.java\n\n## 결과\n\n아직 없음\n",
        )
        .unwrap();

        let plan = plan_issue_migration(&root).unwrap();
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].work_id, "FDR-001");
        assert_eq!(plan[0].status, "ready");
        assert_eq!(plan[0].blocked, "");

        let report = migrate_issues(&root, &[note.to_string_lossy().to_string()]).unwrap();
        assert_eq!(report.migrated.len(), 1, "{report:?}");
        assert!(report.skipped.is_empty());

        let item = work_by_id(&root, "FDR-001").unwrap();
        assert_eq!(item.title, "검색 오류");
        assert_eq!(item.issue_type, "버그");
        assert_eq!(item.priority, "high");
        assert_eq!(item.status, "ready");
        assert!(item.approve);
        assert_eq!(item.workflow_id, workflow::ISSUE_WORKFLOW_ID);
        assert_eq!(item.labels, vec!["검색"]);
        // 폴더 이름이 코어 프로젝트로 승격되어 프로젝트 화면과 같은 것을 가리킨다.
        assert_eq!(item.project_id, "FDR");

        let intent = read_document(&root, "FDR-001", "intent").unwrap();
        assert!(intent.markdown.contains("검색 버튼이 동작하지 않는다"));
        let spec = read_document(&root, "FDR-001", "spec").unwrap();
        assert!(spec.markdown.contains("SearchDAO.java"));

        let original = fs::read_to_string(&note).unwrap();
        assert!(
            original.contains("검색 버튼이 동작하지 않는다"),
            "원본 보존"
        );
        assert!(original.contains("migrated_to: \"FDR-001\""));

        // 두 번째 계획은 이미 옮긴 것으로 막혀 중복 생성이 없다.
        let again = plan_issue_migration(&root).unwrap();
        assert!(again[0].migrated);
        assert!(again[0].blocked.contains("이미"));
        let repeat = migrate_issues(&root, &[note.to_string_lossy().to_string()]).unwrap();
        assert!(repeat.migrated.is_empty());
        assert_eq!(repeat.skipped.len(), 1);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn milestone_kind_preserves_issue_membership() {
        let root = tempdir("milestone-membership");
        initialize(&root).unwrap();
        let event = save_event_at(
            &root,
            CalendarEvent {
                id: "release-1".into(),
                title: "Release".into(),
                date: "2026-09-10".into(),
                kind: "milestone".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let dir = root.join("프로젝트/FDR/이슈");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("FDR-001 Task.md"),
            "---\ntype: 이슈\nid: FDR-001\nstate: open\nmilestone: release-1\n---\nBody\n",
        )
        .unwrap();
        assert!(milestone_has_issues(&root, &event.id));
        assert!(save_event_at(
            &root,
            CalendarEvent {
                kind: "meeting".into(),
                ..event.clone()
            }
        )
        .is_err());
        assert!(save_event_at(
            &root,
            CalendarEvent {
                title: "Renamed".into(),
                ..event
            }
        )
        .is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn initialization_is_idempotent_and_preserves_content() {
        let root = tempdir("init");
        initialize(&root).unwrap();
        fs::write(root.join("projects/keep.md"), "mine").unwrap();
        initialize(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("projects/keep.md")).unwrap(),
            "mine"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn document_cas_and_templates_are_not_evidence() {
        let root = tempdir("cas");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        save_work_at(&root, work("w", "p")).unwrap();
        for artifact in ARTIFACTS {
            let path = artifact_path(&root, "w", artifact);
            assert!(path.is_file(), "{artifact} template was not seeded");
            assert!(!substantial(&fs::read_to_string(path).unwrap()));
        }
        let doc = read_document(&root, "w", "intent").unwrap();
        assert!(!substantial(&doc.markdown));
        let written = write_document_at(
            &root,
            "w",
            "intent",
            "# Intent\n\nA user need.".into(),
            &doc.revision,
        )
        .unwrap();
        assert!(substantial(&written.markdown));
        assert!(write_document_at(&root, "w", "intent", "other".into(), &doc.revision).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn frontmatter_and_comments_do_not_satisfy_artifact_gates() {
        assert!(!substantial(
            "---\ntype: mockup-feedback\nworkId: demo\n---\n\n# 검토 의견\n\n<!-- 내용을 적으세요. -->\n"
        ));
        assert!(substantial(
            "---\ntype: mockup-feedback\n---\n\n# 검토 의견\n\n- [ ] 실제 수정 요청\n"
        ));
    }
    #[test]
    fn artifact_templates_have_only_structured_korean_placeholders() {
        for artifact in ARTIFACTS {
            let template = artifact_template(artifact);
            assert!(template.starts_with('#'), "{artifact}");
            assert!(template.contains("<!--"), "{artifact}");
            assert!(!substantial(&template), "{artifact}");
        }
    }
    #[test]
    fn rejects_path_escape_and_symlink_escape() {
        let root = tempdir("safe");
        initialize(&root).unwrap();
        assert!(validate_id("../no").is_err());
        let outside = tempdir("outside");
        #[cfg(unix)]
        {
            fs::remove_dir_all(root.join("work")).unwrap();
            std::os::unix::fs::symlink(&outside, root.join("work")).unwrap();
            assert!(safe_path(&root, &work_path(&root, "x")).is_err());
        }
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn frontmatter_roundtrip_cycle_dates_and_gates() {
        let root = tempdir("gates");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        let mut a = work("a", "p");
        a.due_date = Some("2026-02-02".into());
        a.start_date = Some("2026-02-03".into());
        assert!(save_work_at(&root, a).is_err());
        let mut non_padded = work("non-padded", "p");
        non_padded.start_date = Some("2026-2-03".into());
        assert!(save_work_at(&root, non_padded).is_err());
        let a = save_work_at(&root, work("a", "p")).unwrap();
        let mut b = work("b", "p");
        b.depends_on = vec![a.id.clone()];
        save_work_at(&root, b).unwrap();
        let mut cycle = work("a", "p");
        cycle.depends_on = vec!["b".into()];
        assert!(save_work_at(&root, cycle).is_err());
        assert!(transition_at(&root, "a", "design", None).is_err());
        let d = read_document(&root, "a", "intent").unwrap();
        write_document_at(
            &root,
            "a",
            "intent",
            "# Intent\n\nUseful evidence.".into(),
            &d.revision,
        )
        .unwrap();
        assert!(transition_at(&root, "a", "design", Some("   ".into())).is_err());
        assert!(transition_at(&root, "a", "design", None).is_err());
        let moved = transition_at(&root, "a", "design", Some("의도 검토 완료".into())).unwrap();
        assert_eq!(moved.stage, "design");
        assert_eq!(work_by_id(&root, "a").unwrap().description, "");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn forward_lifecycle_reaches_deploy_with_review_notes() {
        let root = tempdir("lifecycle");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        save_work_at(&root, work("w", "p")).unwrap();
        for (next, evidence) in [
            ("design", "intent"),
            ("build", "spec"),
            ("test", "plan"),
            ("deploy", "verification"),
        ] {
            let document = read_document(&root, "w", evidence).unwrap();
            write_document_at(
                &root,
                "w",
                evidence,
                format!("# 근거\n\n{evidence}에 대한 실제 검토 근거입니다."),
                &document.revision,
            )
            .unwrap();
            let item = transition_at(
                &root,
                "w",
                next,
                Some(format!("{next} 전환을 검토하고 승인함")),
            )
            .unwrap();
            assert_eq!(item.stage, next);
        }
        let item = work_by_id(&root, "w").unwrap();
        assert_eq!(item.stage, "deploy");
        assert!(item
            .decisions
            .iter()
            .any(|d| d.note.contains("deploy 전환")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn work_edits_cannot_create_or_erase_stage_decisions() {
        let root = tempdir("work-ledger");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        let mut imported = work("w", "p");
        imported.stage = "deploy".into();
        imported.decisions.push(Decision {
            stage: "deploy".into(),
            at: now(),
            note: "forged import".into(),
        });
        let created = save_work_at(&root, imported).unwrap();
        assert_eq!(created.stage, "intent");
        assert!(created.decisions.is_empty());
        let doc = read_document(&root, "w", "intent").unwrap();
        write_document_at(
            &root,
            "w",
            "intent",
            "# 의도\n\n실제 근거".into(),
            &doc.revision,
        )
        .unwrap();
        let transitioned = transition_at(&root, "w", "design", Some("의도 검토".into())).unwrap();
        let mut stale_edit = transitioned.clone();
        stale_edit.stage = "maintain".into();
        stale_edit.decisions.clear();
        stale_edit.decisions.push(Decision {
            stage: "maintain".into(),
            at: now(),
            note: "forged edit".into(),
        });
        let saved = save_work_at(&root, stale_edit).unwrap();
        assert_eq!(saved.stage, "design");
        assert_eq!(saved.decisions, transitioned.decisions);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn crlf_frontmatter_roundtrips() {
        let (project, body) =
            parse_markdown::<Project>("---\r\nid: project\r\nname: CRLF\r\n---\r\n\r\n설명\r\n")
                .unwrap();
        assert_eq!(project.name, "CRLF");
        assert_eq!(body, "설명\r\n");
    }
    #[test]
    fn concurrent_document_cas_has_exactly_one_winner() {
        use std::sync::{Arc, Barrier};
        let root = Arc::new(tempdir("concurrent-cas"));
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        save_work_at(&root, work("w", "p")).unwrap();
        let revision = read_document(&root, "w", "intent").unwrap().revision;
        let barrier = Arc::new(Barrier::new(2));
        let left_root = root.clone();
        let left_barrier = barrier.clone();
        let left_revision = revision.clone();
        let left = std::thread::spawn(move || {
            left_barrier.wait();
            write_document_at(
                &left_root,
                "w",
                "intent",
                "# 의도\n\n첫 번째".into(),
                &left_revision,
            )
        });
        let right_root = root.clone();
        let right_barrier = barrier;
        let right = std::thread::spawn(move || {
            right_barrier.wait();
            write_document_at(
                &right_root,
                "w",
                "intent",
                "# 의도\n\n두 번째".into(),
                &revision,
            )
        });
        assert_eq!(
            [left.join().unwrap(), right.join().unwrap()]
                .iter()
                .filter(|r| r.is_ok())
                .count(),
            1
        );
        fs::remove_dir_all(&*root).unwrap();
    }
    #[test]
    fn corrupt_records_are_diagnostics_and_future_schema_is_rejected() {
        let root = tempdir("schema");
        initialize(&root).unwrap();
        fs::create_dir_all(root.join("work/bad")).unwrap();
        fs::write(work_path(&root, "bad"), "not frontmatter").unwrap();
        let snap = snapshot(&root).unwrap();
        assert!(snap.diagnostics.iter().any(|v| v.contains("bad")));
        fs::write(schema_path(&root), r#"{"version":2}"#).unwrap();
        assert!(snapshot(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn snapshot_reports_invalid_refs_status_and_canonical_folders() {
        let root = tempdir("snapshot-invalid");
        initialize(&root).unwrap();
        fs::create_dir_all(root.join("work/missing-record")).unwrap();
        fs::create_dir_all(root.join("work/bad")).unwrap();
        let invalid = WorkItem {
            id: "bad".into(),
            title: "broken".into(),
            project_id: "missing-project".into(),
            stage: "not-a-stage".into(),
            status: "not-a-status".into(),
            priority: "normal".into(),
            depends_on: vec!["missing-work".into()],
            ..Default::default()
        };
        write_atomic(
            &root,
            &work_path(&root, "bad"),
            &markdown(&invalid, "").unwrap(),
        )
        .unwrap();
        let snapshot = snapshot(&root).unwrap();
        assert!(snapshot.work.iter().any(|item| item.id == "bad"));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|line| line.contains("missing-record")));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|line| line.contains("not-a-status")));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|line| line.contains("missing-project")));
        assert!(snapshot
            .diagnostics
            .iter()
            .any(|line| line.contains("missing-work")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn future_schema_initialization_creates_no_core_directories() {
        let root = tempdir("future-before-init");
        fs::create_dir_all(root.join(".sawhorse")).unwrap();
        fs::write(schema_path(&root), r#"{"version":2}"#).unwrap();
        assert!(initialize(&root).is_err());
        for directory in ["projects", "work", "calendar", "runs"] {
            assert!(!root.join(directory).exists(), "{directory} was created");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn exact_search_ranks_title_before_body() {
        let root = tempdir("search");
        initialize(&root).unwrap();
        save_project_at(&root, project("alpha")).unwrap();
        let mut p = project("beta");
        p.name = "alpha in body".into();
        p.description = "needle".into();
        save_project_at(&root, p).unwrap();
        let results = search_at(&root, "alpha").unwrap();
        assert_eq!(results[0].path, "projects/alpha/project.md");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_workflow_switch_pins_existing_work_and_seeds_tdd_artifacts() {
        let root = tempdir("workflow-switch");
        initialize(&root).unwrap();
        let project = save_project_at(&root, project("p")).unwrap();
        assert_eq!(project.workflow_id, workflow::DEFAULT_WORKFLOW_ID);
        let legacy = save_work_at(&root, work("legacy", "p")).unwrap();
        assert_eq!(legacy.stage, "intent");
        assert_eq!(legacy.workflow_id, "sdd-main");

        let activated = activate_project_workflow_at(&root, "p", "tdd-cycle", "1.0.0").unwrap();
        assert_eq!(activated.workflow_id, "tdd-cycle");
        let tdd = save_work_at(&root, work("tdd", "p")).unwrap();
        assert_eq!(tdd.workflow_id, "tdd-cycle");
        assert_eq!(tdd.workflow_version, "1.0.0");
        assert_eq!(tdd.stage, "test-intent");
        assert!(root.join("work/tdd/red-evidence.md").is_file());
        assert!(!root.join("work/tdd/intent.md").exists());

        let intent = read_document(&root, "tdd", "test-intent").unwrap();
        write_document_at(
            &root,
            "tdd",
            "test-intent",
            "# 테스트 의도\n\n한 번에 하나의 행동을 실제 assertion으로 검증합니다.".into(),
            &intent.revision,
        )
        .unwrap();
        let moved = transition_at(&root, "tdd", "red", Some("테스트 의도 검토".into())).unwrap();
        assert_eq!(moved.stage, "red");

        activate_project_workflow_at(&root, "p", "sdd-with-tdd", "1.1.0").unwrap();
        assert_eq!(work_by_id(&root, "legacy").unwrap().workflow_id, "sdd-main");
        assert_eq!(work_by_id(&root, "tdd").unwrap().workflow_id, "tdd-cycle");
        // sdd-main, tdd-cycle, sdd-with-tdd, issue-main@1.1.0, 동결된 issue-main@1.0.0
        assert_eq!(snapshot(&root).unwrap().workflows.len(), 5);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tdd_red_gate_rejects_build_failures_and_requires_revision_bound_assertion_failure() {
        let root = tempdir("tdd-red-gate");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        activate_project_workflow_at(&root, "p", "tdd-cycle", "1.0.0").unwrap();
        save_work_at(&root, work("tdd", "p")).unwrap();
        let intent = read_document(&root, "tdd", "test-intent").unwrap();
        write_document_at(
            &root,
            "tdd",
            "test-intent",
            "# 테스트 의도\n\n사용자 행동 하나를 assertion으로 검증합니다.".into(),
            &intent.revision,
        )
        .unwrap();
        transition_at(&root, "tdd", "red", Some("테스트 의도 승인".into())).unwrap();

        let red = read_document(&root, "tdd", "red-evidence").unwrap();
        let build_failure = "# Red 근거\n\nresult: failed\nfailureKind: build\ncommand: cargo test\nexitCode: 101\ntestRevision: abcdef1234\n";
        let written = write_document_at(
            &root,
            "tdd",
            "red-evidence",
            build_failure.into(),
            &red.revision,
        )
        .unwrap();
        assert!(transition_at(&root, "tdd", "green", Some("Red 확인".into())).is_err());

        let assertion_failure = "# Red 근거\n\nresult: failed\nfailureKind: assertion\ncommand: cargo test target_behavior\nexitCode: 1\ntestRevision: abcdef1234\n";
        write_document_at(
            &root,
            "tdd",
            "red-evidence",
            assertion_failure.into(),
            &written.revision,
        )
        .unwrap();
        let green = transition_at(
            &root,
            "tdd",
            "green",
            Some("의도한 assertion 실패 확인".into()),
        )
        .unwrap();
        assert_eq!(green.stage, "green");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_projects_runtime_ledger_after_a_partial_work_record_write() {
        let root = tempdir("runtime-recovery");
        initialize(&root).unwrap();
        save_project_at(&root, project("p")).unwrap();
        let created = save_work_at(&root, work("w", "p")).unwrap();
        let intent = read_document(&root, "w", "intent").unwrap();
        write_document_at(
            &root,
            "w",
            "intent",
            "# 의도\n\n재시작 뒤 runtime 장부를 기준으로 복구합니다.".into(),
            &intent.revision,
        )
        .unwrap();
        let moved = workflow_command_at(
            &root,
            WorkflowCommandInput {
                work_id: "w".into(),
                event: "approved".into(),
                expected_node_id: "intent".into(),
                note: "의도 승인".into(),
                event_id: "runtime-recovery-event".into(),
                input_digest: work_input_digest(&root, &created).unwrap(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(moved.stage, "design");

        let mut stale = moved.clone();
        stale.stage = "intent".into();
        stale.active_nodes.clear();
        let body = stale.description.clone();
        stale.description.clear();
        write_atomic(
            &root,
            &work_path(&root, "w"),
            &markdown(&stale, &body).unwrap(),
        )
        .unwrap();

        let recovered = snapshot(&root).unwrap();
        let work = recovered.work.iter().find(|item| item.id == "w").unwrap();
        assert_eq!(work.stage, "design");
        assert_eq!(work.active_nodes[0].node_id, "design");
        assert!(recovered
            .diagnostics
            .iter()
            .any(|line| line.contains("runtime 장부 상태")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composed_work_enters_the_durable_tdd_child_runtime() {
        let root = tempdir("composed-runtime");
        initialize(&root).unwrap();
        let mut parent = project("p");
        parent.workflow_id = "sdd-with-tdd".into();
        parent.workflow_version = "1.1.0".into();
        save_project_at(&root, parent).unwrap();
        save_work_at(&root, work("w", "p")).unwrap();

        for (artifact, body) in [
            ("intent", "# 의도\n\n검증 가능한 사용자 문제와 성공 기준"),
            ("spec", "# 명세\n\n승인할 수 있는 요구사항과 수용 기준"),
        ] {
            let document = read_document(&root, "w", artifact).unwrap();
            write_document_at(&root, "w", artifact, body.into(), &document.revision).unwrap();
        }
        let design = workflow_command_at(
            &root,
            WorkflowCommandInput {
                work_id: "w".into(),
                event: "approved".into(),
                target_node_id: Some("design".into()),
                expected_node_id: "intent".into(),
                note: "의도 승인".into(),
                event_id: "event-1".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(design.active_nodes[0].node_id, "design");

        let child = workflow_command_at(
            &root,
            WorkflowCommandInput {
                work_id: "w".into(),
                event: "approved".into(),
                target_node_id: Some("build".into()),
                expected_node_id: "design".into(),
                note: "명세 승인".into(),
                event_id: "event-2".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(child.stage, "build");
        assert_eq!(child.active_nodes[0].workflow_id, "tdd-cycle");
        assert_eq!(child.active_nodes[0].node_id, "test-intent");
        assert!(child.workflow_instance_id.is_some());
        fs::remove_dir_all(root).unwrap();
    }
}
