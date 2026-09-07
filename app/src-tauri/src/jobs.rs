// Job queue: FIFO admission into a small pool of runner slots. Progress is
// streamed to the frontend via the injected emit callback and mirrored to
// app-data logs, identically for both runners.
//
// Two runners produce the same progress stream:
//   headless — `claude -p … --output-format stream-json`, one at a time.
//   herdr    — an interactive `claude` inside a herdr pane the user can watch,
//              take over, and answer approval prompts in. Progress comes from
//              tailing that session's transcript (see transcript.rs).

use std::collections::HashMap;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::config::{self, ConfigView, HerdrCfg};
use crate::herdr::{self, Herdr};
use crate::state::AppState;
use crate::transcript;

pub const EXCEL_FILENAME: &str = "개선수정사항-체크리스트.xlsx";

/// herdr agent kind for a Claude Code pane — also the executable name herdr
/// launches, which is why the launch preflight keys off it.
const CLAUDE_AGENT: &str = "claude";

pub type EmitFn = Arc<dyn Fn(&str, &Value) + Send + Sync>;

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Success,
    Failed,
    Cancelled,
    Interrupted,
}

impl JobStatus {
    #[allow(dead_code)] // test seam
    pub fn finished(self) -> bool {
        matches!(
            self,
            Self::Success | Self::Failed | Self::Cancelled | Self::Interrupted
        )
    }
}

/// Which runner a job actually used. Decided at dequeue time, so a job recorded
/// before herdr existed still deserializes as headless.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub enum JobRunner {
    #[default]
    Headless,
    Herdr,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    /// 같은 일을 두 번 시키지 않기 위한 요청 식별자 — `dedup_key()` 참고. 같은 키의
    /// 잡이 대기·실행 중이면 새 잡을 받지 않고, 화면은 이 키로 "실행 중" 버튼을 찾는다.
    /// 히스토리에 남은 예전 기록에는 없으므로 기본값을 둔다.
    #[serde(default)]
    pub dedup_key: String,
    pub status: JobStatus,
    pub project: Option<String>,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    #[serde(default)]
    pub runner: JobRunner,
    /// live herdr agent lifecycle: idle | working | blocked | done | unknown.
    /// `blocked` is how "waiting for a human to approve in herdr" reaches the UI —
    /// the job is still Running, so no JobStatus variant is needed for it.
    #[serde(default)]
    pub agent_status: Option<String>,
    /// claude session id we minted, which fixes the transcript path
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub herdr_tab_id: Option<String>,
    #[serde(default)]
    pub herdr_pane_id: Option<String>,
    #[serde(default)]
    pub herdr_agent: Option<String>,
    // runtime-only fields (not part of the wire contract / history)
    #[serde(skip, default)]
    pub prompt: String,
    #[serde(skip, default)]
    pub cwd: String,
    #[serde(skip, default)]
    pub claude_bin: String,
    #[serde(skip, default)]
    pub permission_mode: String,
    #[serde(skip, default)]
    pub excel_out: Option<String>,
    #[serde(skip, default)]
    pub herdr_cfg: HerdrCfg,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct JobRequest {
    pub kind: String,
    pub project: Option<String>,
    pub ids: Option<Vec<String>>,
    pub routine: Option<String>,
    /// kind = "action" 일 때: 어느 팩의 어느 액션인가
    pub pack_id: Option<String>,
    pub action_id: Option<String>,
    #[serde(default)]
    pub params: Map<String, Value>,
    /// kind = "task" 일 때: 호스트 내장 작업 정의의 ID
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub collab: Option<CollabLaneSpec>,
}

/// kind = "collab" 일 때: 세션 레인 실행에 필요한 정보. prompt는 호스트가 이 정보로
/// 직접 조립하므로 잡 API에 임의 프롬프트 주입 경로가 생기지 않는다.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CollabLaneSpec {
    pub session_id: String,
    pub run_id: String,
    pub goal: String,
    /// 전용 worktree 절대경로. 에이전트는 여기서만 작업한다.
    pub worktree: String,
    pub branch: String,
    pub base_sha: String,
    /// 레인이 수행할 작업 설명(사람이 세션 생성 때 쓴 lane task).
    pub task_prompt: String,
    /// 후보 제출 파일을 쓸 인박스 경로.
    pub inbox_path: String,
}

#[derive(Clone, Debug)]
pub struct SpawnOpts {
    pub claude_bin: String,
    pub permission_mode: String,
    pub vault_path: String,
    pub herdr: HerdrCfg,
}

impl From<&ConfigView> for SpawnOpts {
    fn from(v: &ConfigView) -> Self {
        Self {
            claude_bin: v.dashboard.claude_bin.clone(),
            permission_mode: v.dashboard.permission_mode.clone(),
            vault_path: v.vault_path.clone(),
            herdr: v.dashboard.herdr.sanitized(),
        }
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

fn summarize_tool(name: &str, input: &Value) -> Option<String> {
    let obj = input.as_object()?;
    let key = match name {
        "Bash" | "PowerShell" => "command",
        "Read" | "Write" | "Edit" | "NotebookEdit" => "file_path",
        "Task" => "description",
        "Grep" => "pattern",
        "Glob" => "pattern",
        "WebSearch" | "WebFetch" => "query",
        _ => obj.keys().next().map(String::as_str)?,
    };
    obj.get(key)
        .and_then(Value::as_str)
        .map(|s| truncate_chars(s, 120))
}

/// Map one assistant message's content blocks to timeline entries.
///
/// Shared by the headless stream-json reader and the herdr transcript tailer —
/// both carry the identical `message.content[]` shape, so the timeline looks the
/// same whichever runner produced it. `thinking` blocks are skipped.
pub fn map_assistant_content(content: &[Value]) -> Vec<Value> {
    let ts = now_ms();
    let mut entries = Vec::new();
    for item in content {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                let text = item.get("text").and_then(Value::as_str).unwrap_or("");
                if !text.trim().is_empty() {
                    entries.push(json!({
                        "tsMs": ts, "kind": "text", "text": truncate_chars(text, 2000)
                    }));
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                let summary = item
                    .get("input")
                    .and_then(|i| summarize_tool(name, i))
                    .unwrap_or_default();
                entries.push(json!({
                    "tsMs": ts, "kind": "tool", "tool": name, "summary": summary
                }));
            }
            _ => {}
        }
    }
    entries
}

/// Map one `claude --output-format stream-json` line to progress entries.
/// Returns either a single entry object or an array (assistant lines can hold
/// several content items). Unknown shapes are ignored — the raw line is always
/// kept in the job log.
pub fn map_stream_line(line: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = now_ms();
    let kind = v.get("type")?.as_str()?;
    match kind {
        "system" => {
            if v.get("subtype").and_then(Value::as_str) == Some("init") {
                Some(json!({"tsMs": ts, "kind": "init", "text": "세션 시작"}))
            } else {
                None
            }
        }
        "assistant" => {
            let content = v.pointer("/message/content")?.as_array()?;
            let entries = map_assistant_content(content);
            if entries.is_empty() {
                None
            } else {
                Some(Value::Array(entries))
            }
        }
        "result" => {
            let is_error = v.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            let text = v.get("result").and_then(Value::as_str).unwrap_or("");
            Some(json!({
                "tsMs": ts, "kind": "result", "isError": is_error,
                "text": truncate_chars(text, 20000)
            }))
        }
        _ => None,
    }
}

/// What a running job needs to be stopped. `Starting` reserves the slot between
/// admission and the runner actually having a handle, so the dispatcher cannot
/// over-admit.
enum RunCtl {
    Starting(JobRunner),
    Headless(tokio::process::Child),
    Herdr { agent: String },
}

impl RunCtl {
    fn runner(&self) -> JobRunner {
        match self {
            Self::Starting(r) => *r,
            Self::Headless(_) => JobRunner::Headless,
            Self::Herdr { .. } => JobRunner::Herdr,
        }
    }
}

pub struct JobManager {
    pub state: Arc<AppState>,
    tx: tokio::sync::mpsc::UnboundedSender<Job>,
    running: Mutex<HashMap<String, RunCtl>>,
    cancel_requested: Mutex<std::collections::HashSet<String>>,
    slot_free: tokio::sync::Notify,
    /// 중복 검사와 큐 등록 사이에 다른 요청이 끼어들지 못하게 하는 문. 버튼 연타는
    /// 두 요청이 거의 같은 순간에 도착하는 일이라, 검사만으로는 둘 다 통과한다.
    admit: Mutex<()>,
    emit: EmitFn,
}

fn build_spawn_command(bin: &str, args: &[&str], cwd: &str) -> tokio::process::Command {
    let mut c;
    #[cfg(windows)]
    {
        c = tokio::process::Command::new("cmd");
        c.arg("/c").arg(bin);
    }
    #[cfg(not(windows))]
    {
        c = tokio::process::Command::new(bin);
    }
    c.args(args);
    c.current_dir(cwd);
    c
}

/// herdr agent names must match `[a-z][a-z0-9_-]{0,31}` and be unique among live
/// agents; the job's uuid prefix satisfies both.
fn agent_name_for(job_id: &str) -> String {
    let short: String = job_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    format!("sw-{}", short.to_ascii_lowercase())
}

fn list_suffix(ids: &Option<Vec<String>>) -> String {
    match ids {
        Some(v) if !v.is_empty() => format!(" {}", v.join(" ")),
        _ => String::new(),
    }
}

fn id_label(kind: &str, ids: &Option<Vec<String>>) -> String {
    match ids {
        Some(v) if !v.is_empty() => match v.len() {
            1 => v[0].clone(),
            n => format!("{} 외 {}건", v[0], n - 1),
        },
        _ if kind == "design" => "전체 제안".into(),
        _ => "승인된 전체".into(),
    }
}

/// 중복 실행 판정 키 — "무엇을 대상으로 무엇을 하는가"만 담는다.
///
/// 버튼 한 번에 한 실행이 원칙이다. 개념 정리처럼 볼트 한 곳에 쓰는 작업이 겹쳐 돌면
/// 같은 문서를 두 에이전트가 동시에 고치고, 설계처럼 대상이 있는 작업은 대상별로는
/// 나란히 돌아도 된다. 그래서 종류·대상(팩 액션/작업 정의/루틴)·프로젝트·ID 목록까지만
/// 키에 넣고, 자유 입력 파라미터는 넣지 않는다.
pub fn dedup_key(req: &JobRequest) -> String {
    let param_str = |k: &str| {
        req.params
            .get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    let target = match req.kind.as_str() {
        "action" => format!(
            "{}.{}",
            req.pack_id.clone().unwrap_or_default(),
            req.action_id.clone().unwrap_or_default()
        ),
        "task" => req.task_id.clone().unwrap_or_default(),
        "routine" => req.routine.clone().unwrap_or_default(),
        // 레인은 매 실행이 다른 일이다. 같은 레인을 두 번 던지는 것만 막는다.
        "collab" => req
            .collab
            .as_ref()
            .map(|l| format!("{}/{}", l.session_id, l.run_id))
            .unwrap_or_default(),
        _ => String::new(),
    };
    let project = req
        .project
        .clone()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| param_str("project"))
        .or_else(|| param_str("projectId"))
        .unwrap_or_default();
    let mut ids = req.ids.clone().unwrap_or_default();
    if ids.is_empty() {
        if let Some(list) = req.params.get("ids").and_then(Value::as_array) {
            ids = list
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
        }
    }
    ids.sort();
    ids.dedup();
    format!("{}|{}|{}|{}", req.kind, target, project, ids.join(","))
}

fn build_job(
    req: JobRequest,
    opts: &SpawnOpts,
    view: &ConfigView,
    state: &AppState,
) -> Result<Job, String> {
    let base = Job {
        id: uuid::Uuid::new_v4().to_string(),
        kind: req.kind.clone(),
        label: String::new(),
        dedup_key: dedup_key(&req),
        status: JobStatus::Queued,
        project: req.project.clone(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        exit_code: None,
        error: None,
        runner: JobRunner::Headless,
        agent_status: None,
        session_id: None,
        herdr_tab_id: None,
        herdr_pane_id: None,
        herdr_agent: None,
        prompt: String::new(),
        cwd: String::new(),
        claude_bin: opts.claude_bin.clone(),
        permission_mode: if config::PERMISSION_MODES.contains(&opts.permission_mode.as_str()) {
            opts.permission_mode.clone()
        } else {
            "bypassPermissions".into()
        },
        excel_out: None,
        herdr_cfg: opts.herdr.sanitized(),
    };
    match req.kind.as_str() {
        "design" | "implement" => {
            let project_name = req
                .project
                .clone()
                .unwrap_or_else(|| view.default_project.clone());
            if project_name.is_empty() {
                return Err("실행할 프로젝트가 지정되지 않았습니다".into());
            }
            // Generic issues (documents, research, coordination, decisions) may
            // have no codebase configuration. Run them from the vault; configured
            // code projects retain their own working directory.
            let cwd = view
                .projects
                .iter()
                .find(|p| p.name == project_name)
                .and_then(|p| (!p.path.is_empty()).then(|| p.path.clone()))
                .unwrap_or_else(|| view.vault_path.clone());
            if cwd.is_empty() {
                return Err(format!(
                    "{project_name} 프로젝트에 작업 경로 또는 볼트 경로가 없습니다"
                ));
            }
            let verb = if req.kind == "design" {
                "설계"
            } else {
                "실행"
            };
            Ok(Job {
                label: format!("{verb} {} ({project_name})", id_label(&req.kind, &req.ids)),
                prompt: format!("/sawhorse:issues {verb}{}", list_suffix(&req.ids)),
                cwd,
                ..base
            })
        }
        "routine" => {
            let routine = req.routine.ok_or("루틴이 지정되지 않았습니다")?;
            if !matches!(routine.as_str(), "morning" | "lunch" | "evening") {
                return Err(format!("알 수 없는 루틴: {routine}"));
            }
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            let label = match routine.as_str() {
                "morning" => "아침 브리핑 (morning)",
                "lunch" => "오전 결산 (lunch)",
                _ => "퇴근 정산 (evening)",
            };
            Ok(Job {
                label: label.into(),
                prompt: format!("/sawhorse:{routine}"),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
        "excel" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            if view.dashboard.excel_output_dir.is_empty() {
                return Err("엑셀 저장 경로가 설정되지 않았습니다 (설정에서 지정하세요)".into());
            }
            let out = Path::new(&view.dashboard.excel_output_dir).join(EXCEL_FILENAME);
            let mut prompt = format!("/sawhorse:improve-excel --out \"{}\"", out.display());
            let prev = {
                let st = state.state.lock();
                st.excel_last_out.clone()
            };
            if let Some(p) = prev {
                if Path::new(&p).is_file() {
                    prompt = format!("{prompt} --prev \"{p}\"");
                }
            }
            Ok(Job {
                label: "개선 엑셀 뽑기".into(),
                prompt,
                cwd: opts.vault_path.clone(),
                excel_out: Some(out.to_string_lossy().to_string()),
                ..base
            })
        }
        "initVault" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            Ok(Job {
                label: "볼트 초기화 (init-vault)".into(),
                prompt: "/sawhorse:init-vault".into(),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
        "setup" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            Ok(Job {
                label: "환경 진단 (setup)".into(),
                prompt: "/sawhorse:setup".into(),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
        "promote" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            // 승격 결과는 개발 항목이다. 이슈 노트를 새로 만들면 정본이 다시 둘로
            // 갈라지므로, 인박스는 입력으로만 읽고 산출물은 work/ 에 남긴다.
            let prompt = "볼트의 모든 프로젝트 이슈목록(프로젝트|사업/<프로젝트명>/이슈/<idPrefix> 이슈목록.md)의 '## 신규 (미승격)' 항목을 검토하라. 레거시 개선/<idPrefix> 문제목록.md는 읽기 전용으로 표시만 하고 자동 이관하지 않는다.\n\
                1. 항목별로 승격 여부를 판단한다. 단순 메모·중복·실행 불가는 승격하지 않고 해당 항목 뒤에 한 줄 사유를 덧붙여 유지한다.\n\
                2. 승격 건은 개발 항목으로 만든다 — work/<id>/work.md 에 issueType: 작업, executionType: 적절한 값, status: backlog, approve: false, priority: normal 로 쓰고, 배경과 원하는 결과를 intent.md 에 남긴다. 새 이슈 노트를 이슈/ 폴더에 만들지 않는다.\n\
                3. 이슈목록 문서는 '## 신규 (미승격)' + '## 승격 이력' 구조로 재작성하고, 승격 건은 '## 승격 이력'에 '<work-id> (<날짜>)'로 남긴다.\n\
                4. 마지막 출력에 승격 N건 / 유지 M건과 승격된 ID 목록을 보고한다.";
            Ok(Job {
                label: "인박스 승격 검토".into(),
                prompt: prompt.into(),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
        // 팩이 선언한 액션. 앞의 arm 들은 SI 팩이 팩 구조 이전에 갖고 있던 잡들이고,
        // 히스토리(jobs.jsonl)가 그 kind 로 남아 있어 그대로 둔다.
        "action" => {
            let pack_id = req.pack_id.clone().ok_or("팩이 지정되지 않았습니다")?;
            let action_id = req.action_id.clone().ok_or("액션이 지정되지 않았습니다")?;
            let reg = crate::packs::load_registry(&view.packs.enabled);
            let (pack, action) = reg.action(&pack_id, &action_id).ok_or_else(|| {
                format!("활성 팩에서 액션을 찾지 못했습니다: {pack_id}.{action_id}")
            })?;
            let mut params = req.params.clone();
            if let Some(ids) = &req.ids {
                params
                    .entry("ids".to_string())
                    .or_insert_with(|| json!(ids));
            }
            if let Some(project) = &req.project {
                params
                    .entry("project".to_string())
                    .or_insert_with(|| json!(project));
            }
            for p in action.params.iter().filter(|p| p.required) {
                let given = params.get(&p.key).is_some_and(|v| match v {
                    Value::Null => false,
                    Value::String(s) => !s.trim().is_empty(),
                    Value::Array(a) => !a.is_empty(),
                    _ => true,
                });
                if !given {
                    return Err(format!("{} 값이 필요합니다", p.label));
                }
            }
            let prompt = crate::packs::render_prompt(
                &action.prompt,
                &crate::packs::namespace(pack),
                &params,
            );
            let cwd = crate::packs::resolve_cwd(action, &params, view)?;
            Ok(Job {
                label: format!("{} ({})", action.label, pack.manifest.name),
                project: params
                    .get("project")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                prompt,
                cwd,
                ..base
            })
        }
        // 협업 세션 레인. worktree에서 작업하고 후보 인박스 파일로만 제출한다.
        // 승인·병합은 대시보드가 하므로 에이전트에게 병합 권한을 알려주지 않는다.
        "collab" => {
            let lane = req.collab.clone().ok_or("collab 레인 정보가 없습니다")?;
            if lane.worktree.is_empty() {
                return Err("collab 레인에 worktree가 지정되지 않았습니다".into());
            }
            let prompt = format!(
                "협업 세션 {session}의 레인 작업을 수행한다.\n\
                 \n\
                 세션 목표: {goal}\n\
                 레인 작업: {task}\n\
                 \n\
                 규칙:\n\
                 - 작업은 반드시 지정된 worktree({worktree})의 branch {branch}에서만 한다. base는 {base}다.\n\
                 - lint·typecheck·단위 테스트를 worktree에서 실행하고 결과를 후보에 첨부한다.\n\
                 - 모든 변경을 커밋한 뒤 worktree를 clean으로 유지한다.\n\
                 - 완료하면 아래 JSON을 파일 하나로 써서 제출한다. 다른 제출 수단은 없다.\n\
                   경로: {inbox}<run_id>.json\n\
                   {{\n\
                     \"op\": \"propose\",\n\
                     \"sessionId\": \"{session}\",\n\
                     \"taskId\": \"{run}\",\n\
                     \"agent\": \"claude-code\",\n\
                     \"worktree\": \"{worktree}\",\n\
                     \"baseSha\": \"<작업 시작 시 base SHA>\",\n\
                     \"sourceSha\": \"<최종 커밋 SHA>\",\n\
                     \"summary\": \"변경 요약\",\n\
                     \"checks\": [{{ \"name\": \"typecheck\", \"status\": \"passed\" }}]\n\
                   }}\n\
                 - 대표 체크아웃을 건드리지 않는다. 병합은 사람이 검토·승인한 뒤 앱이 수행한다.",
                session = lane.session_id,
                goal = lane.goal,
                task = lane.task_prompt,
                worktree = lane.worktree,
                branch = lane.branch,
                base = lane.base_sha,
                inbox = lane.inbox_path,
                run = lane.run_id,
            );
            Ok(Job {
                label: format!(
                    "세션 레인 {}",
                    lane.task_prompt.chars().take(18).collect::<String>()
                ),
                prompt,
                cwd: lane.worktree.clone(),
                ..base
            })
        }
        // 호스트 내장 작업 — 승인된 작업 정의 파일의 프롬프트를 그대로 돌린다.
        "task" => {
            let task_id = req.task_id.clone().ok_or("작업 ID가 지정되지 않았습니다")?;
            let def = crate::tasks::get_task(&crate::tasks::workbench_root(), &task_id)?;
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            let cwd = def
                .project
                .as_deref()
                .and_then(|name| view.projects.iter().find(|p| p.name == name))
                .and_then(|p| (!p.path.is_empty()).then(|| p.path.clone()))
                .unwrap_or_else(|| opts.vault_path.clone());
            Ok(Job {
                label: def.title,
                prompt: def.prompt,
                cwd,
                ..base
            })
        }
        other => Err(format!("알 수 없는 작업 종류: {other}")),
    }
}

impl JobManager {
    pub fn start(state: Arc<AppState>, emit: EmitFn) -> Arc<Self> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Job>();
        let mgr = Arc::new(Self {
            state,
            tx,
            running: Mutex::new(HashMap::new()),
            cancel_requested: Mutex::new(std::collections::HashSet::new()),
            slot_free: tokio::sync::Notify::new(),
            admit: Mutex::new(()),
            emit,
        });
        let mgr2 = mgr.clone();
        tauri::async_runtime::spawn(async move {
            // Strict FIFO admission: the head of the queue decides which runner it
            // wants, then waits for a slot that runner can use.
            while let Some(mut job) = rx.recv().await {
                // 대기 중에 취소된 잡. cancel()이 이미 Cancelled 로 기록했으므로
                // 여기서는 흔적만 지우고 건너뛴다.
                if mgr2.take_cancel(&job.id) {
                    continue;
                }
                let runner = mgr2.decide_runner(&mut job).await;
                if !mgr2
                    .await_slot(&job.id, runner, job.herdr_cfg.max_parallel)
                    .await
                {
                    mgr2.take_cancel(&job.id);
                    continue;
                }
                let mgr3 = mgr2.clone();
                tauri::async_runtime::spawn(async move {
                    mgr3.run_one(&mut job, runner).await;
                    mgr3.release(&job.id);
                });
            }
        });
        mgr
    }

    /// Pick the runner for one job, honouring `mode` and falling back to headless
    /// when `auto` cannot reach a herdr server or cannot launch claude inside one.
    /// The reason lands in the job log so a surprising fallback is explainable
    /// after the fact.
    async fn decide_runner(&self, job: &mut Job) -> JobRunner {
        match job.herdr_cfg.mode.as_str() {
            "headless" => JobRunner::Headless,
            "herdr" => {
                // The setting forbids the fallback, so all we can do is say why
                // the herdr run is about to fail.
                if let Some(why) = herdr::windows_launch_block(CLAUDE_AGENT) {
                    self.log_line(job, &format!("herdr 실행 경고: {why}"));
                }
                JobRunner::Herdr
            }
            _ => {
                if !Herdr::new(&job.herdr_cfg).reachable().await {
                    self.log_line(
                        job,
                        "herdr 서버에 연결하지 못해 헤드리스로 실행합니다 (mode: auto)",
                    );
                    JobRunner::Headless
                } else if let Some(why) = herdr::windows_launch_block(CLAUDE_AGENT) {
                    self.log_line(job, &format!("{why} 헤드리스로 실행합니다 (mode: auto)"));
                    JobRunner::Headless
                } else {
                    JobRunner::Herdr
                }
            }
        }
    }

    /// Block until this job may start, then reserve its slot.
    ///
    /// A headless job wants the machine to itself (it is the pre-herdr contract and
    /// several job kinds write shared vault state). A herdr job may share with other
    /// herdr jobs up to `max_parallel`, but never with a headless one.
    ///
    /// 슬롯을 잡으면 true. 기다리는 동안 취소되면 false 를 돌려 실행을 접는다.
    async fn await_slot(&self, id: &str, runner: JobRunner, max_parallel: u32) -> bool {
        loop {
            if self.cancelled(id) {
                return false;
            }
            {
                let mut running = self.running.lock();
                let has_headless = running.values().any(|c| c.runner() == JobRunner::Headless);
                let admitted = match runner {
                    JobRunner::Headless => running.is_empty(),
                    JobRunner::Herdr => {
                        !has_headless && running.len() < max_parallel.max(1) as usize
                    }
                };
                if admitted {
                    running.insert(id.to_string(), RunCtl::Starting(runner));
                    return true;
                }
            }
            // Poll alongside the notify so a wake-up that lands between the check
            // and the await cannot strand the queue.
            let _ =
                tokio::time::timeout(Duration::from_millis(250), self.slot_free.notified()).await;
        }
    }

    fn set_ctl(&self, id: &str, ctl: RunCtl) {
        self.running.lock().insert(id.to_string(), ctl);
    }

    fn release(&self, id: &str) {
        self.running.lock().remove(id);
        self.cancel_requested.lock().remove(id);
        self.slot_free.notify_waiters();
    }

    fn cancelled(&self, id: &str) -> bool {
        self.cancel_requested.lock().contains(id)
    }

    /// 취소 표시를 지우면서 있었는지 알려준다 — 시작 전에 접힌 잡의 흔적 정리용.
    fn take_cancel(&self, id: &str) -> bool {
        self.cancel_requested.lock().remove(id)
    }

    fn job_by_id(&self, id: &str) -> Option<Job> {
        self.state.jobs.lock().iter().find(|j| j.id == id).cloned()
    }

    /// 같은 키로 이미 대기·실행 중인 잡. 재시작 때 남은 잡은 부팅 시
    /// `mark_stale_interrupted` 가 정리하므로 상태만 보면 된다.
    pub fn active_with_key(&self, key: &str) -> Option<Job> {
        self.state
            .jobs
            .lock()
            .iter()
            .find(|j| {
                j.dedup_key == key && matches!(j.status, JobStatus::Queued | JobStatus::Running)
            })
            .cloned()
    }

    /// Append one operational note to the job's log file (same file the stream /
    /// transcript lines are mirrored to, so the 로그 dialog shows it in order).
    fn log_line(&self, job: &Job, text: &str) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.state.log_path(&job.id))
        {
            let _ = writeln!(f, "# {text}");
        }
    }

    /// Production enqueue: reads the current config for spawn options.
    pub fn enqueue(&self, req: JobRequest) -> Result<Job, String> {
        let view = config::load_view();
        let opts = SpawnOpts::from(&view);
        self.enqueue_with(req, opts, &view)
    }

    pub fn enqueue_with(
        &self,
        req: JobRequest,
        opts: SpawnOpts,
        view: &ConfigView,
    ) -> Result<Job, String> {
        // 같은 일이 이미 큐에 있으면 받지 않는다. 검사부터 등록까지 한 손에 쥐고 한다.
        let _admit = self.admit.lock();
        if let Some(active) = self.active_with_key(&dedup_key(&req)) {
            return Err(format!(
                "이미 실행 중입니다: {} — 끝나기를 기다리거나 중단한 뒤 다시 실행하세요",
                active.label
            ));
        }
        let job = build_job(req, &opts, view, &self.state)?;
        self.state.record_job(&job);
        self.tx
            .send(job.clone())
            .map_err(|_| "작업 큐가 닫혔습니다".to_string())?;
        Ok(job)
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let ctl = {
            let running = self.running.lock();
            match running.get(id) {
                None => None,
                Some(RunCtl::Herdr { agent, .. }) => Some(Some(agent.clone())),
                _ => Some(None),
            }
        };
        // 아직 시작하지 않은 잡 — 큐에서 바로 접는다. 디스패처가 뒤늦게 꺼내면
        // 취소 표시를 보고 건너뛴다.
        let Some(herdr_target) = ctl else {
            let mut job = self
                .job_by_id(id)
                .filter(|j| j.status == JobStatus::Queued)
                .ok_or_else(|| "실행 중인 작업이 아닙니다".to_string())?;
            self.cancel_requested.lock().insert(id.to_string());
            self.finish(&mut job, JobStatus::Cancelled, None, None, None);
            return Ok(());
        };
        self.cancel_requested.lock().insert(id.to_string());

        if let Some(agent) = herdr_target {
            // Interrupt the interactive session the way a person would: dismiss any
            // dialog, then interrupt the turn. The pane itself is left to cleanup.
            let cfg = self.herdr_cfg_for(id);
            let h = Herdr::new(&cfg);
            let _ = h.agent_send_keys(&agent, &["esc"]).await;
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = h.agent_send_keys(&agent, &["ctrl+c"]).await;
            return Ok(());
        }

        // NOTE: the guard must be released before the arms run — a `match` on
        // `self.running.lock().remove(id)` would hold it through the body, and the
        // Starting arm re-locks the same (non-reentrant) mutex.
        let taken = { self.running.lock().remove(id) };
        let mut child = match taken {
            Some(RunCtl::Headless(c)) => Some(c),
            Some(other) => {
                self.running.lock().insert(id.to_string(), other);
                None
            }
            None => None,
        };
        if let Some(c) = child.as_mut() {
            let _ = c.kill().await;
        }
        if let Some(c) = child {
            self.running
                .lock()
                .insert(id.to_string(), RunCtl::Headless(c));
        }
        Ok(())
    }

    /// The herdr settings to address a live job with. Prefer the snapshot the job
    /// was launched under; jobs restored from history carry only defaults, so fall
    /// back to what is configured now.
    fn herdr_cfg_for(&self, id: &str) -> HerdrCfg {
        let snapshot = {
            let jobs = self.state.jobs.lock();
            jobs.iter()
                .find(|j| j.id == id)
                .map(|j| j.herdr_cfg.clone())
        };
        match snapshot {
            Some(c) if c != HerdrCfg::default() => c,
            _ => config::load_view().dashboard.herdr.sanitized(),
        }
    }

    /// Bring a herdr-run job's session to the front so the user can take it over —
    /// answer an approval, ask a follow-up, or just watch.
    pub async fn focus(&self, id: &str) -> Result<(), String> {
        let job = {
            let jobs = self.state.jobs.lock();
            jobs.iter().find(|j| j.id == id).cloned()
        }
        .ok_or_else(|| "작업을 찾을 수 없습니다".to_string())?;
        if job.runner != JobRunner::Herdr {
            return Err("herdr로 실행한 작업이 아닙니다".into());
        }
        let h = Herdr::new(&self.herdr_cfg_for(id));
        if let Some(target) = job.herdr_agent.as_deref().or(job.herdr_pane_id.as_deref()) {
            if h.agent_focus(target).await.is_ok() {
                return Ok(());
            }
        }
        // the agent may already be gone; the tab it ran in usually is not
        let tab = job
            .herdr_tab_id
            .as_deref()
            .ok_or_else(|| "herdr 세션 정보가 없습니다".to_string())?;
        h.focus_tab(tab)
            .await
            .map(|_| ())
            .map_err(|e| format!("herdr 포커스 실패: {e}"))
    }

    async fn run_one(&self, job: &mut Job, runner: JobRunner) {
        // 슬롯을 잡은 뒤 시작 직전에 취소된 잡은 아예 띄우지 않는다.
        if self.take_cancel(&job.id) {
            job.runner = runner;
            self.finish(job, JobStatus::Cancelled, None, None, None);
            return;
        }
        job.runner = runner;
        job.status = JobStatus::Running;
        job.started_at_ms = Some(now_ms());
        self.state.record_job(job);
        (self.emit)(
            "job-finished",
            &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}),
        );
        match runner {
            JobRunner::Headless => self.run_headless(job).await,
            JobRunner::Herdr => self.run_herdr(job).await,
        }
    }

    async fn run_headless(&self, job: &mut Job) {
        let args: Vec<String> = vec![
            "-p".into(),
            job.prompt.clone(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
            "--permission-mode".into(),
            job.permission_mode.clone(),
        ];
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut cmd = build_spawn_command(&job.claude_bin, &arg_refs, &job.cwd);

        let mut spawned = match cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                self.finish(
                    job,
                    JobStatus::Failed,
                    None,
                    Some(format!("claude 실행 실패: {e}")),
                    None,
                );
                return;
            }
        };

        let stdout = spawned.stdout.take();
        let stderr = spawned.stderr.take();
        self.set_ctl(&job.id, RunCtl::Headless(spawned));

        let log_path = self.state.log_path(&job.id);
        let log_path_err = log_path.clone();
        let mut report: Option<String> = None;
        let mut result_is_error = false;

        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        let mut log_err = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path_err)
            .ok();

        let err_task = stderr.map(|mut st| {
            tokio::spawn(async move {
                let reader = BufReader::new(&mut st);
                let mut lines = reader.lines();
                while let Ok(Some(l)) = lines.next_line().await {
                    if let Some(f) = log_err.as_mut() {
                        let _ = writeln!(f, "STDERR: {l}");
                    }
                }
            })
        });

        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            let mut lines = reader.lines();
            loop {
                match lines.next_line().await {
                    Ok(Some(raw)) => {
                        if let Some(f) = log.as_mut() {
                            let _ = writeln!(f, "{raw}");
                        }
                        if let Some(entries) = map_stream_line(&raw) {
                            if let Some(arr) = entries.as_array() {
                                for entry in arr {
                                    track_entry(entry, &mut report, &mut result_is_error);
                                    (self.emit)(
                                        "job-progress",
                                        &json!({"jobId": job.id, "entry": entry}),
                                    );
                                }
                            } else {
                                track_entry(&entries, &mut report, &mut result_is_error);
                                (self.emit)(
                                    "job-progress",
                                    &json!({"jobId": job.id, "entry": entries}),
                                );
                            }
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }

        let taken = self.running.lock().remove(&job.id);
        let exit = if let Some(RunCtl::Headless(mut c)) = taken {
            c.wait().await.ok()
        } else {
            None
        };
        if let Some(t) = err_task {
            let _ = t.await;
        }

        let cancelled = self.cancelled(&job.id);
        let exit_code = exit.as_ref().and_then(|s| s.code());
        if cancelled {
            self.finish(job, JobStatus::Cancelled, exit_code, None, report);
        } else if result_is_error {
            self.finish(
                job,
                JobStatus::Failed,
                exit_code,
                Some("claude가 오류로 종료했습니다".into()),
                report,
            );
        } else {
            match exit {
                Some(s) if s.success() => {
                    self.finish(job, JobStatus::Success, exit_code, None, report)
                }
                Some(_) => self.finish(
                    job,
                    JobStatus::Failed,
                    exit_code,
                    Some("비정상 종료".into()),
                    report,
                ),
                None => self.finish(
                    job,
                    JobStatus::Failed,
                    None,
                    Some("프로세스 상태를 알 수 없습니다".into()),
                    report,
                ),
            }
        }
    }

    // ---------- herdr runner ----------

    /// The dashboard owns exactly one herdr workspace, remembered across restarts.
    async fn ensure_workspace(&self, h: &Herdr) -> Result<String, crate::herdr::HerdrError> {
        let existing = { self.state.state.lock().herdr_workspace_id.clone() };
        if let Some(id) = existing {
            if h.workspace_exists(&id).await {
                return Ok(id);
            }
        }
        let label = h.cfg().workspace_label.clone();
        let id = match h.find_workspace_by_label(&label).await {
            Some(id) => id,
            None => h.create_workspace(&label).await?,
        };
        {
            self.state.state.lock().herdr_workspace_id = Some(id.clone());
        }
        self.state.save_state();
        Ok(id)
    }

    /// Run the job as an interactive `claude` inside a fresh herdr tab.
    ///
    /// The prompt is handed to claude as its positional argument rather than typed
    /// into the running UI: most job prompts are slash commands, and the input box's
    /// completion menu would otherwise swallow the submitting Enter. `agent start`
    /// passes everything after `--` as argv, so no shell quoting is involved either.
    async fn run_herdr(&self, job: &mut Job) {
        let h = Herdr::new(&job.herdr_cfg);
        let session_id = uuid::Uuid::new_v4().to_string();
        job.session_id = Some(session_id.clone());

        let workspace = match self.ensure_workspace(&h).await {
            Ok(w) => w,
            Err(e) => {
                self.finish(
                    job,
                    JobStatus::Failed,
                    None,
                    Some(format!("herdr 워크스페이스 준비 실패: {e}")),
                    None,
                );
                return;
            }
        };
        let tab = match h.create_tab(&workspace, &job.label, &job.cwd).await {
            Ok(t) => t,
            Err(e) => {
                self.finish(
                    job,
                    JobStatus::Failed,
                    None,
                    Some(format!("herdr 탭 생성 실패: {e}")),
                    None,
                );
                return;
            }
        };

        let name = agent_name_for(&job.id);
        job.herdr_tab_id = Some(tab.tab_id.clone());
        job.herdr_pane_id = Some(tab.pane_id.clone());
        job.herdr_agent = Some(name.clone());
        self.set_ctl(
            &job.id,
            RunCtl::Herdr {
                agent: name.clone(),
            },
        );
        self.state.record_job(job);
        (self.emit)(
            "job-finished",
            &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}),
        );

        let extra = vec![
            "--session-id".to_string(),
            session_id.clone(),
            "--permission-mode".to_string(),
            job.permission_mode.clone(),
            job.prompt.clone(),
        ];
        let start_ms = (job.herdr_cfg.start_timeout_sec as u64) * 1000;
        let target = match h
            .agent_start(&name, CLAUDE_AGENT, &tab.pane_id, start_ms, &extra)
            .await
        {
            Ok(_) => name.clone(),
            Err(e) => {
                // `agent start` only returns once herdr calls the agent ready for
                // input; a session that starts working on its prompt immediately can
                // trip that. Trust the pane over the error.
                match h.agent_get(&tab.pane_id).await {
                    Ok(a) if a.agent.is_some() => {
                        self.log_line(
                            job,
                            &format!(
                                "herdr agent start 경고: {e} — 페인에서 에이전트를 확인했습니다"
                            ),
                        );
                        tab.pane_id.clone()
                    }
                    _ => {
                        self.herdr_cleanup(job, &h, JobStatus::Failed).await;
                        self.finish(
                            job,
                            JobStatus::Failed,
                            None,
                            Some(format!("herdr 세션 시작 실패: {e}")),
                            None,
                        );
                        return;
                    }
                }
            }
        };
        if target != name {
            job.herdr_agent = Some(target.clone());
            self.set_ctl(
                &job.id,
                RunCtl::Herdr {
                    agent: target.clone(),
                },
            );
        }
        self.log_line(
            job,
            &format!(
                "herdr {} / {} / session {session_id}",
                tab.tab_id, tab.pane_id
            ),
        );
        self.emit_entry(
            job,
            &json!({"tsMs": now_ms(), "kind": "init", "text": "herdr 세션 시작"}),
        );

        self.watch_herdr(job, &h, &target, &session_id, true).await;
    }

    /// Poll a live herdr session until it settles, streaming its transcript.
    ///
    /// `fresh` marks a session we just launched: it gets a startup grace period,
    /// while a reattached session is already past that.
    async fn watch_herdr(
        &self,
        job: &mut Job,
        h: &Herdr,
        target: &str,
        session_id: &str,
        fresh: bool,
    ) {
        const POLL: Duration = Duration::from_millis(1000);
        // idle must hold for a few consecutive polls: claude briefly looks idle
        // between a tool result and the next assistant block.
        const SETTLE_TICKS: u32 = 3;

        let projects = self.state.transcript_root.clone();
        let started = std::time::Instant::now();
        let start_grace = Duration::from_secs(job.herdr_cfg.start_timeout_sec as u64);
        let job_deadline = match job.herdr_cfg.job_timeout_min {
            0 => None,
            m => Some(Duration::from_secs(m as u64 * 60)),
        };

        let mut tailer: Option<transcript::Tailer> = None;
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.state.log_path(&job.id))
            .ok();
        let mut report: Option<String> = None;
        // Two different questions. `saw_transcript` gates the timeline and the
        // report; `saw_activity` gates "is this session actually doing anything",
        // which must not depend on transcripts — Claude Code writes none when its
        // environment carries CLAUDE_CODE_CHILD_SESSION, and the job still runs.
        let mut saw_transcript = false;
        let mut saw_activity = !fresh;
        let mut settled_ticks = 0u32;
        let mut missing_ticks = 0u32;

        loop {
            if self.cancelled(&job.id) {
                self.herdr_cleanup(job, h, JobStatus::Cancelled).await;
                self.finish(job, JobStatus::Cancelled, None, None, report);
                return;
            }

            if tailer.is_none() {
                if let Some(path) = transcript::find_session_file(&projects, session_id) {
                    self.log_line(job, &format!("트랜스크립트: {}", path.display()));
                    tailer = Some(transcript::Tailer::new(path));
                }
            }
            if let Some(t) = tailer.as_mut() {
                for raw in t.read_new_lines() {
                    if let Some(f) = log.as_mut() {
                        let _ = writeln!(f, "{raw}");
                    }
                    let Some(entries) = transcript::map_transcript_line(&raw) else {
                        continue;
                    };
                    for entry in entries.as_array().into_iter().flatten() {
                        saw_transcript = true;
                        saw_activity = true;
                        if entry.get("kind").and_then(Value::as_str) == Some("text") {
                            report = entry
                                .get("text")
                                .and_then(Value::as_str)
                                .map(str::to_string);
                        }
                        self.emit_entry(job, entry);
                    }
                }
            }

            match h.agent_get(target).await {
                Ok(info) => {
                    missing_ticks = 0;
                    if matches!(info.status.as_str(), "working" | "blocked") {
                        saw_activity = true;
                    }
                    if job.agent_status.as_deref() != Some(info.status.as_str()) {
                        job.agent_status = Some(info.status.clone());
                        self.state.record_job(job);
                        (self.emit)(
                            "job-finished",
                            &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}),
                        );
                        if info.blocked() {
                            self.log_line(job, "herdr에서 승인/입력을 기다리는 중입니다");
                            h.notify(
                                "승인 대기",
                                &format!("{} — herdr에서 확인하세요", job.label),
                            )
                            .await;
                        }
                    }
                    settled_ticks = if info.settled() && saw_activity {
                        settled_ticks + 1
                    } else {
                        0
                    };
                    if settled_ticks >= SETTLE_TICKS {
                        self.finish_herdr(job, h, saw_transcript, report).await;
                        return;
                    }
                }
                Err(e) if e.code == "not_found" => {
                    // The pane closed or claude exited. Treat a session that produced
                    // output as done; one that never did as a failed launch.
                    missing_ticks += 1;
                    if missing_ticks >= 2 {
                        if saw_activity {
                            self.finish_herdr(job, h, saw_transcript, report).await;
                        } else {
                            self.finish(
                                job,
                                JobStatus::Failed,
                                None,
                                Some("herdr 세션이 아무 것도 하지 못하고 사라졌습니다".into()),
                                None,
                            );
                        }
                        return;
                    }
                }
                Err(_) => {} // transient server hiccup — keep polling
            }

            if fresh && !saw_activity && started.elapsed() > start_grace {
                self.herdr_cleanup(job, h, JobStatus::Failed).await;
                self.finish(
                    job,
                    JobStatus::Failed,
                    None,
                    Some("herdr 세션이 시간 안에 응답하지 않았습니다".into()),
                    None,
                );
                return;
            }
            if let Some(d) = job_deadline {
                if started.elapsed() > d {
                    self.herdr_cleanup(job, h, JobStatus::Failed).await;
                    self.finish(
                        job,
                        JobStatus::Failed,
                        None,
                        Some(format!(
                            "herdr 세션이 {}분을 넘겨 중단했습니다",
                            job.herdr_cfg.job_timeout_min
                        )),
                        report,
                    );
                    return;
                }
            }
            tokio::time::sleep(POLL).await;
        }
    }

    /// Settle a herdr job that finished its turn. A session that ran without a
    /// readable transcript still succeeded — it just leaves no timeline, and saying
    /// so beats an unexplained blank panel.
    async fn finish_herdr(
        &self,
        job: &mut Job,
        h: &Herdr,
        saw_transcript: bool,
        report: Option<String>,
    ) {
        if saw_transcript {
            self.emit_result(job, report.as_deref(), false);
        } else {
            let note = "herdr 세션은 끝났지만 트랜스크립트를 읽지 못해 진행 내역이 없습니다.                         herdr 서버가 Claude Code 세션 안에서 시작되었는지 확인하세요                         (CLAUDE_CODE_CHILD_SESSION이 있으면 기록이 꺼집니다).";
            self.log_line(job, note);
            self.emit_result(job, Some(note), false);
        }
        self.herdr_cleanup(job, h, JobStatus::Success).await;
        self.finish(job, JobStatus::Success, None, None, report);
    }

    /// Close the job's tab according to the cleanup policy. A failed or cancelled
    /// session is worth keeping around by default — that is where the evidence is.
    async fn herdr_cleanup(&self, job: &Job, h: &Herdr, status: JobStatus) {
        let Some(tab) = job.herdr_tab_id.as_deref() else {
            return;
        };
        let close = match job.herdr_cfg.cleanup.as_str() {
            "closeAlways" => true,
            "keep" => false,
            _ => status == JobStatus::Success,
        };
        if status != JobStatus::Success {
            let where_to_look = if close {
                "기록은 잡 상세에 남습니다"
            } else {
                "herdr 탭에 세션이 남아 있습니다"
            };
            h.notify("작업 실패", &format!("{} — {where_to_look}", job.label))
                .await;
        }
        if !close {
            return;
        }
        let _ = h.close_tab(tab).await;
    }

    fn emit_entry(&self, job: &Job, entry: &Value) {
        (self.emit)("job-progress", &json!({"jobId": job.id, "entry": entry}));
    }

    /// Transcripts hold no `result` record; synthesize one so the timeline ends the
    /// same way a headless run's does.
    fn emit_result(&self, job: &Job, text: Option<&str>, is_error: bool) {
        self.emit_entry(
            job,
            &json!({
                "tsMs": now_ms(), "kind": "result", "isError": is_error,
                "text": truncate_chars(text.unwrap_or(""), 20000)
            }),
        );
    }

    /// After a restart, herdr sessions may still be alive. Resume watching the ones
    /// that are; mark the rest interrupted like before.
    pub async fn reattach_herdr(self: &Arc<Self>, resumable: Vec<Job>) {
        if resumable.is_empty() {
            return;
        }
        let cfg = config::load_view().dashboard.herdr.sanitized();
        let h = Herdr::new(&cfg);
        let reachable = h.reachable().await;
        for mut job in resumable {
            job.herdr_cfg = cfg.clone();
            let target = job
                .herdr_agent
                .clone()
                .or_else(|| job.herdr_pane_id.clone())
                .unwrap_or_default();
            let session_id = job.session_id.clone().unwrap_or_default();
            let alive = reachable
                && !target.is_empty()
                && matches!(h.agent_get(&target).await,
                            Ok(a) if a.agent.is_some() && !a.contradicts_session(&session_id));
            if !alive {
                self.finish_detached(&mut job, "앱 재시작으로 중단됨");
                continue;
            }
            self.log_line(&job, "herdr 세션이 살아 있어 감시를 재개합니다");
            self.set_ctl(
                &job.id,
                RunCtl::Herdr {
                    agent: target.clone(),
                },
            );
            let mgr = self.clone();
            tauri::async_runtime::spawn(async move {
                let h = Herdr::new(&job.herdr_cfg);
                mgr.watch_herdr(&mut job, &h, &target, &session_id, false)
                    .await;
                mgr.release(&job.id);
            });
        }
    }

    fn finish_detached(&self, job: &mut Job, reason: &str) {
        job.status = JobStatus::Interrupted;
        job.error = Some(reason.to_string());
        job.finished_at_ms = Some(now_ms());
        self.state.record_job(job);
        (self.emit)(
            "job-finished",
            &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}),
        );
    }

    fn finish(
        &self,
        job: &mut Job,
        status: JobStatus,
        exit_code: Option<i32>,
        error: Option<String>,
        report: Option<String>,
    ) {
        job.status = status;
        job.exit_code = exit_code;
        job.error = error;
        job.finished_at_ms = Some(now_ms());
        if status != JobStatus::Running {
            job.agent_status = None;
        }
        self.state.record_job(job);
        if let Some(r) = report {
            let _ = std::fs::write(self.state.report_path(&job.id), r);
        }
        if status == JobStatus::Success {
            if let Some(out) = &job.excel_out {
                // the guard must be dropped before save_state re-locks the same mutex
                {
                    self.state.state.lock().excel_last_out = Some(out.clone());
                }
                self.state.save_state();
            }
        }
        self.running.lock().remove(&job.id);
        (self.emit)(
            "job-finished",
            &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}),
        );
    }
}

fn track_entry(entry: &Value, report: &mut Option<String>, result_is_error: &mut bool) {
    if entry.get("kind").and_then(Value::as_str) == Some("result") {
        *result_is_error = entry
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        *report = entry
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string);
    }
}

/// 중복 실행 방지 — 러너를 띄우지 않으므로 어느 OS 에서나 돈다.
#[cfg(test)]
mod dedup_tests {
    use super::*;
    use crate::state::AppState;

    fn req(kind: &str) -> JobRequest {
        JobRequest {
            kind: kind.into(),
            ..Default::default()
        }
    }

    #[test]
    fn key_separates_targets_but_ignores_free_params() {
        let action = |pack: &str, id: &str| JobRequest {
            pack_id: Some(pack.into()),
            action_id: Some(id.into()),
            ..req("action")
        };
        assert_eq!(dedup_key(&action("si", "wiki")), "action|si.wiki||");
        assert_ne!(
            dedup_key(&action("si", "wiki")),
            dedup_key(&action("si", "daily-log"))
        );

        // 자유 입력은 같은 버튼의 같은 실행으로 본다 — 볼트 한 곳에 겹쳐 쓰지 않도록.
        let mut with_topic = action("si", "wiki");
        with_topic.params.insert("topic".into(), json!("리트라이"));
        assert_eq!(dedup_key(&with_topic), dedup_key(&action("si", "wiki")));

        // 대상이 다르면 나란히 돌아도 된다.
        let issue = |ids: &[&str]| JobRequest {
            project: Some("포탈".into()),
            ids: Some(ids.iter().map(|s| s.to_string()).collect()),
            ..req("design")
        };
        assert_eq!(dedup_key(&issue(&["A-1"])), "design||포탈|A-1");
        assert_ne!(dedup_key(&issue(&["A-1"])), dedup_key(&issue(&["A-2"])));
        // 순서만 다른 같은 목록은 같은 키다.
        assert_eq!(
            dedup_key(&issue(&["A-2", "A-1"])),
            dedup_key(&issue(&["A-1", "A-2"]))
        );

        // 종류가 다르면 다른 일이다.
        assert_ne!(dedup_key(&req("promote")), dedup_key(&req("excel")));
    }

    #[tokio::test]
    async fn enqueue_refuses_while_the_same_job_is_in_flight() {
        let dir = std::env::temp_dir().join(format!("swdash-dedup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(AppState::new_with(dir.join("data"), dir.join("projects")));
        let emit: EmitFn = Arc::new(|_, _| {});
        let mgr = JobManager::start(state.clone(), emit);
        let view = config::view(
            &serde_json::json!({"vaultPath": dir.to_string_lossy()}),
            true,
        );
        let opts = SpawnOpts {
            claude_bin: dir.join("no-such-claude").to_string_lossy().to_string(),
            permission_mode: "bypassPermissions".into(),
            vault_path: dir.to_string_lossy().to_string(),
            herdr: HerdrCfg {
                mode: "headless".into(),
                ..HerdrCfg::default()
            },
        };
        let request = JobRequest {
            routine: Some("morning".into()),
            ..req("routine")
        };

        // 실행 중인 잡을 손으로 세워 둔다 — 디스패처 타이밍에 기대지 않기 위해서.
        let mut running = build_job(request.clone(), &opts, &view, &state).unwrap();
        running.status = JobStatus::Running;
        state.record_job(&running);

        let err = mgr
            .enqueue_with(request.clone(), opts.clone(), &view)
            .unwrap_err();
        assert!(err.contains("이미 실행 중입니다"), "{err}");

        // 다른 루틴은 막지 않는다.
        let other = JobRequest {
            routine: Some("evening".into()),
            ..req("routine")
        };
        assert!(mgr.enqueue_with(other, opts.clone(), &view).is_ok());

        // 끝난 뒤에는 다시 실행할 수 있다.
        running.status = JobStatus::Success;
        state.record_job(&running);
        assert!(mgr.enqueue_with(request, opts, &view).is_ok());

        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::state::AppState;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("swdash-jobs-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_script(dir: &Path, body: &str) -> String {
        let path = dir.join(format!("fake-claude-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    struct TestRig {
        mgr: Arc<JobManager>,
        state: Arc<AppState>,
        events: Arc<Mutex<Vec<(String, String)>>>,
        view: ConfigView,
        dir: PathBuf,
    }

    fn rig(tag: &str) -> TestRig {
        let dir = temp_dir(tag);
        let state = Arc::new(AppState::new_with(dir.join("data"), dir.join("projects")));
        std::fs::create_dir_all(dir.join("projects").join("proj")).unwrap();
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev2 = events.clone();
        let emit: EmitFn = Arc::new(move |name, payload| {
            ev2.lock().push((name.to_string(), payload.to_string()));
        });
        let mgr = JobManager::start(state.clone(), emit);
        let view = config::view(
            &serde_json::json!({"vaultPath": dir.to_string_lossy()}),
            true,
        );
        TestRig {
            mgr,
            state,
            events,
            dir,
            view,
        }
    }

    /// Headless spawn options — the default for tests that do not exercise herdr.
    fn opts(bin: String, vault: &Path) -> SpawnOpts {
        SpawnOpts {
            claude_bin: bin,
            permission_mode: "bypassPermissions".into(),
            vault_path: vault.to_string_lossy().to_string(),
            herdr: HerdrCfg {
                mode: "headless".into(),
                ..HerdrCfg::default()
            },
        }
    }

    async fn wait_finished(state: &AppState, id: &str, tries: usize) -> Option<Job> {
        for _ in 0..tries {
            {
                let jobs = state.jobs.lock();
                if let Some(j) = jobs.iter().find(|j| j.id == id) {
                    if j.status.finished() {
                        return Some(j.clone());
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        None
    }

    #[tokio::test]
    async fn success_lifecycle_streams_and_reports() {
        let rig = rig("success");
        let bin = write_script(
            &rig.dir,
            r###"echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"분석 중"}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}'
echo '{"type":"result","is_error":false,"result":"## 결과 보고"}'
"###,
        );
        let req = JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some("morning".into()),
            ..Default::default()
        };
        let job = rig
            .mgr
            .enqueue_with(req, opts(bin, &rig.dir), &rig.view)
            .unwrap();
        assert_eq!(job.prompt, "/sawhorse:morning");
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);
        assert_eq!(done.exit_code, Some(0));

        let events = rig.events.lock();
        let progress: Vec<&str> = events
            .iter()
            .filter(|(n, _)| n == "job-progress")
            .map(|(_, p)| p.as_str())
            .collect();
        assert!(
            progress.len() >= 4,
            "expected init/text/tool/result, got {progress:?}"
        );
        let joined = progress.join(" ");
        let init_pos = joined.find("\"kind\":\"init\"").unwrap();
        let text_pos = joined.find("\"kind\":\"text\"").unwrap();
        let tool_pos = joined.find("\"kind\":\"tool\"").unwrap();
        let result_pos = joined.find("\"kind\":\"result\"").unwrap();
        assert!(init_pos < text_pos && text_pos < tool_pos && tool_pos < result_pos);
        assert!(
            joined.contains("git status"),
            "tool summary missing: {joined}"
        );

        let report = std::fs::read_to_string(rig.state.report_path(&job.id)).unwrap();
        assert!(report.contains("결과 보고"));
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(log.contains("\"subtype\":\"init\""));
        assert!(events
            .iter()
            .any(|(n, p)| n == "job-finished" && p.contains(&job.id)));
    }

    #[tokio::test]
    async fn failure_without_result_marks_failed() {
        let rig = rig("fail");
        let bin = write_script(&rig.dir, "echo 'boom' >&2\nexit 1\n");
        let req = JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some("lunch".into()),
            ..Default::default()
        };
        let job = rig
            .mgr
            .enqueue_with(req, opts(bin, &rig.dir), &rig.view)
            .unwrap();
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Failed);
        assert_eq!(done.exit_code, Some(1));
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(log.contains("STDERR: boom"));
    }

    #[tokio::test]
    async fn cancel_kills_running_job() {
        let rig = rig("cancel");
        let bin = write_script(
            &rig.dir,
            "echo '{\"type\":\"system\",\"subtype\":\"init\"}'\nsleep 30\n",
        );
        let req = JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some("evening".into()),
            ..Default::default()
        };
        let job = rig
            .mgr
            .enqueue_with(req, opts(bin, &rig.dir), &rig.view)
            .unwrap();
        for _ in 0..100 {
            {
                let jobs = rig.state.jobs.lock();
                if jobs
                    .iter()
                    .any(|j| j.id == job.id && j.status == JobStatus::Running)
                {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        rig.mgr.cancel(&job.id).await.unwrap();
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Cancelled);
    }

    #[tokio::test]
    async fn missing_binary_fails_fast() {
        let rig = rig("nobin");
        let req = JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some("morning".into()),
            ..Default::default()
        };
        let job = rig
            .mgr
            .enqueue_with(
                req,
                opts("/nonexistent/claude-bin".into(), &rig.dir),
                &rig.view,
            )
            .unwrap();
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Failed);
        assert!(done.error.unwrap_or_default().contains("claude 실행 실패"));
    }

    #[test]
    fn excel_prompt_carries_out_and_prev() {
        let rig_dir = temp_dir("excel");
        let state = AppState::new(rig_dir.join("data"));
        let out_dir = temp_dir("excelout");
        {
            let mut st = state.state.lock();
            st.excel_last_out = Some(out_dir.join("prev.xlsx").to_string_lossy().to_string());
            std::fs::write(out_dir.join("prev.xlsx"), b"x").unwrap();
        }
        let view = config::view(
            &serde_json::json!({
                "vaultPath": rig_dir.to_string_lossy(),
                "dashboard": {"excelOutputDir": out_dir.to_string_lossy()}
            }),
            true,
        );
        let job = build_job(
            JobRequest {
                kind: "excel".into(),
                project: None,
                ids: None,
                routine: None,
                ..Default::default()
            },
            &SpawnOpts::from(&view),
            &view,
            &state,
        )
        .unwrap();
        assert!(job.prompt.contains(&format!(
            "--out \"{}\"",
            out_dir.join(EXCEL_FILENAME).display()
        )));
        assert!(
            job.prompt.contains("--prev"),
            "prev must be included: {}",
            job.prompt
        );
        assert_eq!(
            job.excel_out.as_deref(),
            Some(out_dir.join(EXCEL_FILENAME).to_str().unwrap())
        );

        let view2 = config::view(
            &serde_json::json!({"vaultPath": rig_dir.to_string_lossy()}),
            true,
        );
        let err = build_job(
            JobRequest {
                kind: "excel".into(),
                project: None,
                ids: None,
                routine: None,
                ..Default::default()
            },
            &SpawnOpts::from(&view2),
            &view2,
            &state,
        )
        .unwrap_err();
        assert!(err.contains("엑셀 저장 경로"));
    }

    #[test]
    fn design_prompt_uses_project_and_ids() {
        let state = AppState::new(temp_dir("prompt").join("data"));
        let raw = serde_json::json!({
            "vaultPath": "/v",
            "improve": {"defaultProject": "FDR", "projects": {"FDR": {
                "path": "/w", "workBranch": "improve/fdr", "portableBase": "", "idPrefix": "FDR", "verify": ""
            }}}
        });
        let view = config::view(&raw, true);
        let opts = SpawnOpts::from(&view);
        let j = build_job(
            JobRequest {
                kind: "design".into(),
                project: Some("FDR".into()),
                ids: Some(vec!["FDR-001".into(), "FDR-002".into()]),
                routine: None,
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap();
        assert_eq!(j.prompt, "/sawhorse:issues 설계 FDR-001 FDR-002");
        assert_eq!(j.cwd, "/w");
        assert_eq!(j.label, "설계 FDR-001 외 1건 (FDR)");
        let j2 = build_job(
            JobRequest {
                kind: "implement".into(),
                project: None,
                ids: None,
                routine: None,
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap();
        assert_eq!(j2.prompt, "/sawhorse:issues 실행");
        assert_eq!(j2.label, "실행 승인된 전체 (FDR)");
        let generic = build_job(
            JobRequest {
                kind: "design".into(),
                project: Some("없는프로젝트".into()),
                ids: None,
                routine: None,
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap();
        assert_eq!(generic.cwd, "/v");
    }

    /// 팩 액션 잡: 동봉한 SI 팩의 선언이 그대로 프롬프트·cwd·라벨이 된다.
    ///
    /// 레지스트리는 `plugin::resolve_root()` 로 찾는다 — 테스트에서는 tauri-build 가
    /// `bundle.resources` 를 target 디렉터리에 복사해 둔 것을 쓰게 되고, 번들 앱에서
    /// 실제로 일어나는 일과 같은 경로다.
    #[test]
    fn pack_action_job_renders_from_the_manifest() {
        let reg = crate::packs::load_registry(&[]);
        assert!(
            reg.get("si").is_some() && reg.get("starter").is_some(),
            "동봉 팩을 찾지 못했다 (플러그인 루트: {:?})",
            crate::plugin::resolve_root()
        );
        let state = AppState::new(temp_dir("action").join("data"));
        let raw = serde_json::json!({
            "vaultPath": "/v",
            "improve": {"defaultProject": "FDR", "projects": {"FDR": {"path": "/w", "idPrefix": "FDR"}}}
        });
        let view = config::view(&raw, true);
        let opts = SpawnOpts::from(&view);

        // cwd: workspace 인 예약 액션
        let j = build_job(
            JobRequest {
                kind: "action".into(),
                pack_id: Some("si".into()),
                action_id: Some("morning".into()),
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap();
        assert_eq!(j.prompt, "/sawhorse:morning");
        assert_eq!(j.cwd, "/v");
        assert!(j.label.contains("아침 브리핑"), "{}", j.label);

        // cwd: project + ids 파라미터
        let d = build_job(
            JobRequest {
                kind: "action".into(),
                pack_id: Some("si".into()),
                action_id: Some("design".into()),
                ids: Some(vec!["FDR-001".into()]),
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap();
        assert_eq!(d.prompt, "/sawhorse:issues 설계 FDR-001");
        assert_eq!(d.cwd, "/w");

        // 없는 액션 / 없는 팩은 오류
        for (pack, action) in [("si", "없는액션"), ("없는팩", "morning")] {
            let err = build_job(
                JobRequest {
                    kind: "action".into(),
                    pack_id: Some(pack.into()),
                    action_id: Some(action.into()),
                    ..Default::default()
                },
                &opts,
                &view,
                &state,
            )
            .unwrap_err();
            assert!(err.contains("액션을 찾지 못했습니다"), "{err}");
        }

        // required 파라미터가 비면 실행 전에 막는다 (starter 의 capture)
        let err = build_job(
            JobRequest {
                kind: "action".into(),
                pack_id: Some("starter".into()),
                action_id: Some("capture".into()),
                ..Default::default()
            },
            &opts,
            &view,
            &state,
        )
        .unwrap_err();
        assert!(err.contains("값이 필요합니다"), "{err}");
    }

    #[tokio::test]
    async fn build_promote_job_targets_vault() {
        let rig = rig("promote");
        let view = rig.view.clone();
        let mut opts = opts("/bin/claude-fake".into(), &rig.dir);
        opts.vault_path = rig.dir.join("vault").to_string_lossy().to_string();
        let job = build_job(
            JobRequest {
                kind: "promote".into(),
                project: None,
                ids: None,
                routine: None,
                ..Default::default()
            },
            &opts,
            &view,
            &rig.state,
        )
        .unwrap();
        assert_eq!(job.label, "인박스 승격 검토");
        assert!(job.prompt.contains("신규 (미승격)"));
        assert_eq!(job.cwd, opts.vault_path);

        let mut empty_vault = opts.clone();
        empty_vault.vault_path = String::new();
        let err = build_job(
            JobRequest {
                kind: "promote".into(),
                project: None,
                ids: None,
                routine: None,
                ..Default::default()
            },
            &empty_vault,
            &view,
            &rig.state,
        )
        .unwrap_err();
        assert!(err.contains("볼트 경로"));
    }

    // ---------- herdr runner ----------

    /// A stand-in for the herdr CLI: answers the control commands the runner uses
    /// and, on `agent start`, plays the part of claude by writing a transcript.
    fn write_fake_herdr(dir: &Path, transcript_dir: &Path, statuses: &str) -> String {
        write_fake_herdr_opt(dir, transcript_dir, statuses, true)
    }

    fn write_fake_herdr_opt(
        dir: &Path,
        transcript_dir: &Path,
        statuses: &str,
        transcript: bool,
    ) -> String {
        let td = transcript_dir.to_string_lossy().to_string();
        let guard = if transcript { "" } else { "false && " };
        let d = dir.to_string_lossy().to_string();
        write_script(
            dir,
            &format!(
                r###"GROUP="$1"; SUB="$2"
case "$GROUP $SUB" in
  "workspace list") echo '{{"result":{{"workspaces":[]}}}}' ;;
  "workspace get") echo '{{"error":{{"code":"not_found","message":"no"}}}}' >&2; exit 1 ;;
  "workspace create") echo '{{"result":{{"workspace":{{"workspace_id":"w1"}}}}}}' ;;
  "tab create") echo '{{"result":{{"tab":{{"tab_id":"w1:t2"}},"root_pane":{{"pane_id":"w1:p2"}}}}}}' ;;
  "tab close") echo "$3" > "{d}/closed-tab"; echo '{{"result":{{}}}}' ;;
  "agent start")
      sid=""; prev=""
      for a in "$@"; do
        if [ "$prev" = "--session-id" ]; then sid="$a"; fi
        prev="$a"
      done
      {guard}mkdir -p "{td}/proj"
      f="{td}/proj/$sid.jsonl"
      {guard}echo '{{"type":"assistant","message":{{"content":[{{"type":"thinking","thinking":"음"}}]}}}}' >> "$f"
      {guard}echo '{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Bash","input":{{"command":"git status"}}}}]}}}}' >> "$f"
      {guard}echo '{{"type":"assistant","message":{{"content":[{{"type":"text","text":"## 결과 보고"}}]}}}}' >> "$f"
      echo '{{"result":{{"agent":{{"agent":"claude","agent_status":"working"}}}}}}' ;;
  "agent get")
      n=$(cat "{d}/gets" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "{d}/gets"
      st=$(echo "{statuses}" | cut -d, -f"$n"); [ -n "$st" ] || st="idle"
      echo "{{\"result\":{{\"agent\":{{\"agent\":\"claude\",\"agent_status\":\"$st\"}}}}}}" ;;
  "agent send-keys"|"notification show"|"agent focus") echo '{{"result":{{}}}}' ;;
  *) echo '{{"error":{{"code":"not_found","message":"unhandled"}}}}' >&2; exit 1 ;;
esac
"###
            ),
        )
    }

    fn herdr_opts(claude: &str, vault: &Path, herdr_bin: String) -> SpawnOpts {
        SpawnOpts {
            claude_bin: claude.to_string(),
            permission_mode: "bypassPermissions".into(),
            vault_path: vault.to_string_lossy().to_string(),
            herdr: HerdrCfg {
                mode: "herdr".into(),
                bin: herdr_bin,
                start_timeout_sec: 10,
                job_timeout_min: 1,
                ..HerdrCfg::default()
            },
        }
    }

    fn routine_req(routine: &str) -> JobRequest {
        JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some(routine.into()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn herdr_runner_streams_transcript_and_closes_tab() {
        let rig = rig("herdr-ok");
        let bin = write_fake_herdr(&rig.dir, &rig.dir.join("projects"), "idle,idle,idle,idle");
        let job = rig
            .mgr
            .enqueue_with(
                routine_req("morning"),
                herdr_opts("claude", &rig.dir, bin),
                &rig.view,
            )
            .unwrap();

        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);
        assert_eq!(done.runner, JobRunner::Herdr);
        assert_eq!(done.herdr_tab_id.as_deref(), Some("w1:t2"));
        assert_eq!(done.herdr_pane_id.as_deref(), Some("w1:p2"));
        assert!(
            done.session_id.is_some(),
            "session id must be minted up front"
        );
        assert!(
            done.agent_status.is_none(),
            "finished jobs carry no live agent status"
        );

        let events = rig.events.lock();
        let joined: String = events
            .iter()
            .filter(|(n, _)| n == "job-progress")
            .map(|(_, p)| p.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let init = joined.find("\"kind\":\"init\"").expect("init entry");
        let tool = joined.find("\"kind\":\"tool\"").expect("tool entry");
        let text = joined.find("\"kind\":\"text\"").expect("text entry");
        let result = joined
            .find("\"kind\":\"result\"")
            .expect("synthesized result entry");
        assert!(init < tool && tool < text && text < result);
        assert!(joined.contains("git status"));
        assert!(
            !joined.contains("thinking"),
            "thinking blocks stay out of the timeline"
        );

        // report comes from the last assistant text, like the headless runner
        let report = std::fs::read_to_string(rig.state.report_path(&job.id)).unwrap();
        assert!(report.contains("결과 보고"), "report: {report}");
        // default cleanup closes the tab on success
        let closed = std::fs::read_to_string(rig.dir.join("closed-tab")).unwrap();
        assert_eq!(closed.trim(), "w1:t2");
        // the workspace is remembered for the next job
        assert_eq!(
            rig.state.state.lock().herdr_workspace_id.as_deref(),
            Some("w1")
        );
    }

    #[tokio::test]
    async fn herdr_blocked_agent_surfaces_then_finishes() {
        let rig = rig("herdr-blocked");
        // blocked twice, then the "user" answers and the session settles
        let bin = write_fake_herdr(
            &rig.dir,
            &rig.dir.join("projects"),
            "blocked,blocked,idle,idle,idle",
        );
        let job = rig
            .mgr
            .enqueue_with(
                routine_req("lunch"),
                herdr_opts("claude", &rig.dir, bin),
                &rig.view,
            )
            .unwrap();

        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);

        // the blocked state must have reached the UI while the job was still running
        let events = rig.events.lock();
        assert!(
            events
                .iter()
                .any(|(n, p)| n == "job-finished" && p.contains("\"agentStatus\":\"blocked\"")),
            "blocked status never emitted"
        );
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(log.contains("승인/입력을 기다리는 중"), "log: {log}");
    }

    #[tokio::test]
    async fn auto_mode_falls_back_to_headless_without_herdr() {
        let rig = rig("herdr-fallback");
        let claude = write_script(
            &rig.dir,
            r###"echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","is_error":false,"result":"ok"}'
"###,
        );
        let mut opts = herdr_opts(&claude, &rig.dir, "/nonexistent/herdr".into());
        opts.herdr.mode = "auto".into();
        let job = rig
            .mgr
            .enqueue_with(routine_req("evening"), opts, &rig.view)
            .unwrap();

        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);
        assert_eq!(done.runner, JobRunner::Headless);
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(
            log.contains("헤드리스로 실행합니다"),
            "fallback reason missing: {log}"
        );
    }

    #[tokio::test]
    async fn cancel_interrupts_herdr_session() {
        let rig = rig("herdr-cancel");
        // stays working until interrupted
        let bin = write_fake_herdr(
            &rig.dir,
            &rig.dir.join("projects"),
            "working,working,working,working,working,working,working,working",
        );
        let job = rig
            .mgr
            .enqueue_with(
                routine_req("evening"),
                herdr_opts("claude", &rig.dir, bin),
                &rig.view,
            )
            .unwrap();
        for _ in 0..100 {
            {
                let jobs = rig.state.jobs.lock();
                if jobs
                    .iter()
                    .any(|j| j.id == job.id && j.herdr_agent.is_some())
                {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        rig.mgr.cancel(&job.id).await.unwrap();
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Cancelled);
        assert_eq!(done.runner, JobRunner::Herdr);
    }

    #[tokio::test]
    async fn herdr_start_failure_fails_the_job() {
        let rig = rig("herdr-nostart");
        // every command errors: workspace creation already fails in herdr-only mode
        let bin = write_script(
            &rig.dir,
            "echo '{\"error\":{\"code\":\"boom\",\"message\":\"안됨\"}}' >&2\nexit 1\n",
        );
        let job = rig
            .mgr
            .enqueue_with(
                routine_req("morning"),
                herdr_opts("claude", &rig.dir, bin),
                &rig.view,
            )
            .unwrap();
        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Failed);
        assert!(done
            .error
            .unwrap_or_default()
            .contains("herdr 워크스페이스 준비 실패"));
    }

    #[tokio::test]
    async fn herdr_job_without_transcript_still_succeeds() {
        let rig = rig("herdr-notranscript");
        // Claude Code writes no transcript when its env carries
        // CLAUDE_CODE_CHILD_SESSION; the job itself still runs to completion.
        let bin = write_fake_herdr_opt(
            &rig.dir,
            &rig.dir.join("projects"),
            "working,working,idle,idle,idle",
            false,
        );
        let job = rig
            .mgr
            .enqueue_with(
                routine_req("morning"),
                herdr_opts("claude", &rig.dir, bin),
                &rig.view,
            )
            .unwrap();

        let done = wait_finished(&rig.state, &job.id, 300)
            .await
            .expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(
            log.contains("트랜스크립트를 읽지 못해"),
            "no explanation logged: {log}"
        );
        // and the user is told why the timeline is empty rather than left guessing
        let events = rig.events.lock();
        assert!(events.iter().any(|(n, p)| n == "job-progress"
            && p.contains("\"kind\":\"result\"")
            && p.contains("트랜스크립트")));
    }

    #[test]
    fn agent_names_satisfy_herdr_rules() {
        let name = agent_name_for("3F2A91BC-dead-beef-0000-000000000000");
        assert_eq!(name, "sw-3f2a91bc");
        assert!(name.len() <= 32);
        assert!(name.starts_with(|c: char| c.is_ascii_lowercase()));
        assert!(name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
    }

    #[test]
    fn map_stream_line_shapes() {
        let e = map_stream_line(r#"{"type":"system","subtype":"init","session_id":"s"}"#).unwrap();
        assert_eq!(e["kind"], "init");

        let e = map_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"안녕"}]}}"#,
        )
        .unwrap();
        assert_eq!(e[0]["kind"], "text");
        assert_eq!(e[0]["text"], "안녕");

        let e = map_stream_line(
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/a/b.java"}}]}}"#,
        )
        .unwrap();
        assert_eq!(e[0]["kind"], "tool");
        assert_eq!(e[0]["tool"], "Read");
        assert_eq!(e[0]["summary"], "/a/b.java");

        let e = map_stream_line(r#"{"type":"result","is_error":true,"result":"실패함"}"#).unwrap();
        assert_eq!(e["kind"], "result");
        assert_eq!(e["isError"], true);

        assert!(map_stream_line("not json").is_none());
        assert!(map_stream_line(r#"{"type":"other"}"#).is_none());
        assert!(map_stream_line(r#"{"type":"user","message":{}}"#).is_none());
    }
}
