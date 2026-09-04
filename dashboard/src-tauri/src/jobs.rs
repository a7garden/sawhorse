// Job queue: FIFO, one claude process at a time. Progress is streamed to the
// frontend via the injected emit callback and mirrored to app-data logs.

use std::io::Write;
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::config::{self, ConfigView};
use crate::state::AppState;

pub const EXCEL_FILENAME: &str = "개선수정사항-체크리스트.xlsx";

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
        matches!(self, Self::Success | Self::Failed | Self::Cancelled | Self::Interrupted)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub status: JobStatus,
    pub project: Option<String>,
    pub created_at_ms: u64,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
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
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub kind: String,
    pub project: Option<String>,
    pub ids: Option<Vec<String>>,
    pub routine: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SpawnOpts {
    pub claude_bin: String,
    pub permission_mode: String,
    pub vault_path: String,
}

impl From<&ConfigView> for SpawnOpts {
    fn from(v: &ConfigView) -> Self {
        Self {
            claude_bin: v.dashboard.claude_bin.clone(),
            permission_mode: v.dashboard.permission_mode.clone(),
            vault_path: v.vault_path.clone(),
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
            let content = v.pointer("/message/content")?.as_array()?.clone();
            let mut entries = Vec::new();
            for item in content {
                let ty = item.get("type").and_then(Value::as_str).unwrap_or("");
                match ty {
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
            if entries.is_empty() { None } else { Some(Value::Array(entries)) }
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

pub struct JobManager {
    pub state: Arc<AppState>,
    tx: tokio::sync::mpsc::UnboundedSender<Job>,
    child: Mutex<Option<tokio::process::Child>>,
    running_id: Mutex<Option<String>>,
    cancel_requested: Mutex<Option<String>>,
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
        status: JobStatus::Queued,
        project: req.project.clone(),
        created_at_ms: now_ms(),
        started_at_ms: None,
        finished_at_ms: None,
        exit_code: None,
        error: None,
        prompt: String::new(),
        cwd: String::new(),
        claude_bin: opts.claude_bin.clone(),
        permission_mode: if config::PERMISSION_MODES.contains(&opts.permission_mode.as_str()) {
            opts.permission_mode.clone()
        } else {
            "bypassPermissions".into()
        },
        excel_out: None,
    };
    match req.kind.as_str() {
        "design" | "implement" => {
            let project_name = req.project.clone().unwrap_or_else(|| view.default_project.clone());
            let project = view
                .projects
                .iter()
                .find(|p| p.name == project_name)
                .ok_or_else(|| format!("등록되지 않은 사업입니다: {project_name}"))?;
            if project.path.is_empty() {
                return Err(format!("{project_name} 사업에 코드베이스 경로가 없습니다"));
            }
            let verb = if req.kind == "design" { "설계" } else { "구현" };
            Ok(Job {
                label: format!("{verb} {} ({project_name})", id_label(&req.kind, &req.ids)),
                prompt: format!("/si-workbench:improve {verb}{}", list_suffix(&req.ids)),
                cwd: project.path.clone(),
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
                prompt: format!("/si-workbench:{routine}"),
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
            let mut prompt = format!("/si-workbench:improve-excel --out \"{}\"", out.display());
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
                prompt: "/si-workbench:init-vault".into(),
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
                prompt: "/si-workbench:setup".into(),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
        "promote" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            let prompt = "볼트의 모든 사업 문제목록(사업/<사업명>/개선/<idPrefix> 문제목록.md)의 '## 신규 (미승격)' 항목을 검토하라.\n\
                1. 항목별로 승격 여부를 판단한다. 단순 메모·중복·실행 불가는 승격하지 않고 해당 항목 뒤에 한 줄 사유를 덧붙여 유지한다.\n\
                2. 승격 건은 개선 노트 템플릿으로 생성한다: status: 제안, approve: false, priority: 보통, id는 해당 사업 개선 폴더의 기존 id 최댓값+1, 파일명은 '<ID> <제목>.md', 개선/ 바로 아래 평면 배치.\n\
                3. 문제목록 문서는 base 뷰 임베드 + '## 신규 (미승격)' + '## 승격 이력' 구조로 재작성하고, 승격 건은 '## 승격 이력'에 '<ID> (<날짜>)'로 남긴다.\n\
                4. 마지막 출력에 승격 N건 / 유지 M건과 승격된 ID 목록을 보고한다.";
            Ok(Job {
                label: "인박스 승격 검토".into(),
                prompt: prompt.into(),
                cwd: opts.vault_path.clone(),
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
            child: Mutex::new(None),
            running_id: Mutex::new(None),
            cancel_requested: Mutex::new(None),
            emit,
        });
        let mgr2 = mgr.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(mut job) = rx.recv().await {
                mgr2.run_one(&mut job).await;
            }
        });
        mgr
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
        let job = build_job(req, &opts, view, &self.state)?;
        self.state.record_job(&job);
        self.tx.send(job.clone()).map_err(|_| "작업 큐가 닫혔습니다".to_string())?;
        Ok(job)
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let running = self.running_id.lock().clone();
        if running.as_deref() != Some(id) {
            return Err("실행 중인 작업이 아닙니다".into());
        }
        *self.cancel_requested.lock() = Some(id.to_string());
        let mut child = self.child.lock().take();
        if let Some(c) = child.as_mut() {
            let _ = c.kill().await;
        }
        if let Some(c) = child {
            *self.child.lock() = Some(c);
        }
        Ok(())
    }

    async fn run_one(&self, job: &mut Job) {
        job.status = JobStatus::Running;
        job.started_at_ms = Some(now_ms());
        self.state.record_job(job);
        (self.emit)("job-finished", &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}));

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

        *self.cancel_requested.lock() = None;
        let mut spawned = match cmd
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                self.finish(job, JobStatus::Failed, None, Some(format!("claude 실행 실패: {e}")), None);
                return;
            }
        };
        *self.running_id.lock() = Some(job.id.clone());

        let stdout = spawned.stdout.take();
        let stderr = spawned.stderr.take();
        *self.child.lock() = Some(spawned);

        let log_path = self.state.log_path(&job.id);
        let log_path_err = log_path.clone();
        let mut report: Option<String> = None;
        let mut result_is_error = false;

        let mut log = std::fs::OpenOptions::new().create(true).append(true).open(&log_path).ok();
        let mut log_err = std::fs::OpenOptions::new().create(true).append(true).open(&log_path_err).ok();

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
                                    (self.emit)("job-progress", &json!({"jobId": job.id, "entry": entry}));
                                }
                            } else {
                                track_entry(&entries, &mut report, &mut result_is_error);
                                (self.emit)("job-progress", &json!({"jobId": job.id, "entry": entries}));
                            }
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
        }

        let taken = self.child.lock().take();
        let exit = if let Some(mut c) = taken {
            c.wait().await.ok()
        } else {
            None
        };
        if let Some(t) = err_task {
            let _ = t.await;
        }

        let cancelled = self.cancel_requested.lock().as_deref() == Some(job.id.as_str());
        let exit_code = exit.as_ref().and_then(|s| s.code());
        if cancelled {
            self.finish(job, JobStatus::Cancelled, exit_code, None, report);
        } else if result_is_error {
            self.finish(job, JobStatus::Failed, exit_code, Some("claude가 오류로 종료했습니다".into()), report);
        } else {
            match exit {
                Some(s) if s.success() => self.finish(job, JobStatus::Success, exit_code, None, report),
                Some(_) => self.finish(job, JobStatus::Failed, exit_code, Some("비정상 종료".into()), report),
                None => self.finish(job, JobStatus::Failed, None, Some("프로세스 상태를 알 수 없습니다".into()), report),
            }
        }
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
        self.state.record_job(job);
        if let Some(r) = report {
            let _ = std::fs::write(self.state.report_path(&job.id), r);
        }
        if status == JobStatus::Success {
            if let Some(out) = &job.excel_out {
                let mut st = self.state.state.lock();
                st.excel_last_out = Some(out.clone());
                self.state.save_state();
            }
        }
        if self.running_id.lock().as_deref() == Some(job.id.as_str()) {
            *self.running_id.lock() = None;
        }
        (self.emit)("job-finished", &json!({"job": serde_json::to_value(&*job).unwrap_or(Value::Null)}));
    }
}

fn track_entry(entry: &Value, report: &mut Option<String>, result_is_error: &mut bool) {
    if entry.get("kind").and_then(Value::as_str) == Some("result") {
        *result_is_error = entry.get("isError").and_then(Value::as_bool).unwrap_or(false);
        *report = entry.get("text").and_then(Value::as_str).map(str::to_string);
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
        let state = Arc::new(AppState::new(dir.join("data")));
        let events: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let ev2 = events.clone();
        let emit: EmitFn = Arc::new(move |name, payload| {
            ev2.lock().push((name.to_string(), payload.to_string()));
        });
        let mgr = JobManager::start(state.clone(), emit);
        let view = config::view(&serde_json::json!({"vaultPath": dir.to_string_lossy()}), true);
        TestRig { mgr, state, events, dir, view }
    }

    fn opts(bin: String, vault: &Path) -> SpawnOpts {
        SpawnOpts {
            claude_bin: bin,
            permission_mode: "bypassPermissions".into(),
            vault_path: vault.to_string_lossy().to_string(),
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
        };
        let job = rig.mgr.enqueue_with(req, opts(bin, &rig.dir), &rig.view).unwrap();
        assert_eq!(job.prompt, "/si-workbench:morning");
        let done = wait_finished(&rig.state, &job.id, 300).await.expect("job did not finish");
        assert_eq!(done.status, JobStatus::Success, "error: {:?}", done.error);
        assert_eq!(done.exit_code, Some(0));

        let events = rig.events.lock();
        let progress: Vec<&str> = events
            .iter()
            .filter(|(n, _)| n == "job-progress")
            .map(|(_, p)| p.as_str())
            .collect();
        assert!(progress.len() >= 4, "expected init/text/tool/result, got {progress:?}");
        let joined = progress.join(" ");
        let init_pos = joined.find("\"kind\":\"init\"").unwrap();
        let text_pos = joined.find("\"kind\":\"text\"").unwrap();
        let tool_pos = joined.find("\"kind\":\"tool\"").unwrap();
        let result_pos = joined.find("\"kind\":\"result\"").unwrap();
        assert!(init_pos < text_pos && text_pos < tool_pos && tool_pos < result_pos);
        assert!(joined.contains("git status"), "tool summary missing: {joined}");

        let report = std::fs::read_to_string(rig.state.report_path(&job.id)).unwrap();
        assert!(report.contains("결과 보고"));
        let log = std::fs::read_to_string(rig.state.log_path(&job.id)).unwrap();
        assert!(log.contains("\"subtype\":\"init\""));
        assert!(events.iter().any(|(n, p)| n == "job-finished" && p.contains(&job.id)));
    }

    #[tokio::test]
    async fn failure_without_result_marks_failed() {
        let rig = rig("fail");
        let bin = write_script(&rig.dir, "echo 'boom' >&2\nexit 1\n");
        let req = JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some("lunch".into()) };
        let job = rig.mgr.enqueue_with(req, opts(bin, &rig.dir), &rig.view).unwrap();
        let done = wait_finished(&rig.state, &job.id, 300).await.expect("job did not finish");
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
        let req = JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some("evening".into()) };
        let job = rig.mgr.enqueue_with(req, opts(bin, &rig.dir), &rig.view).unwrap();
        for _ in 0..100 {
            {
                let jobs = rig.state.jobs.lock();
                if jobs.iter().any(|j| j.id == job.id && j.status == JobStatus::Running) {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        rig.mgr.cancel(&job.id).await.unwrap();
        let done = wait_finished(&rig.state, &job.id, 300).await.expect("job did not finish");
        assert_eq!(done.status, JobStatus::Cancelled);
    }

    #[tokio::test]
    async fn missing_binary_fails_fast() {
        let rig = rig("nobin");
        let req = JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some("morning".into()) };
        let job = rig
            .mgr
            .enqueue_with(req, opts("/nonexistent/claude-bin".into(), &rig.dir), &rig.view)
            .unwrap();
        let done = wait_finished(&rig.state, &job.id, 300).await.expect("job did not finish");
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
            JobRequest { kind: "excel".into(), project: None, ids: None, routine: None },
            &SpawnOpts::from(&view),
            &view,
            &state,
        )
        .unwrap();
        assert!(job.prompt.contains(&format!("--out \"{}\"", out_dir.join(EXCEL_FILENAME).display())));
        assert!(job.prompt.contains("--prev"), "prev must be included: {}", job.prompt);
        assert_eq!(job.excel_out.as_deref(), Some(out_dir.join(EXCEL_FILENAME).to_str().unwrap()));

        let view2 = config::view(&serde_json::json!({"vaultPath": rig_dir.to_string_lossy()}), true);
        let err = build_job(
            JobRequest { kind: "excel".into(), project: None, ids: None, routine: None },
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
            },
            &opts, &view, &state,
        )
        .unwrap();
        assert_eq!(j.prompt, "/si-workbench:improve 설계 FDR-001 FDR-002");
        assert_eq!(j.cwd, "/w");
        assert_eq!(j.label, "설계 FDR-001 외 1건 (FDR)");
        let j2 = build_job(
            JobRequest { kind: "implement".into(), project: None, ids: None, routine: None },
            &opts, &view, &state,
        )
        .unwrap();
        assert_eq!(j2.prompt, "/si-workbench:improve 구현");
        assert_eq!(j2.label, "구현 승인된 전체 (FDR)");
        let err = build_job(
            JobRequest { kind: "design".into(), project: Some("없는사업".into()), ids: None, routine: None },
            &opts, &view, &state,
        )
        .unwrap_err();
        assert!(err.contains("등록되지 않은"));
    }


    #[tokio::test]
    async fn build_promote_job_targets_vault() {
        let rig = rig("promote");
        let view = rig.view.clone();
        let mut opts = opts("/bin/claude-fake".into(), &rig.dir);
        opts.vault_path = rig.dir.join("vault").to_string_lossy().to_string();
        let job = build_job(
            JobRequest { kind: "promote".into(), project: None, ids: None, routine: None },
            &opts, &view, &rig.state,
        )
        .unwrap();
        assert_eq!(job.label, "인박스 승격 검토");
        assert!(job.prompt.contains("신규 (미승격)"));
        assert_eq!(job.cwd, opts.vault_path);

        let mut empty_vault = opts.clone();
        empty_vault.vault_path = String::new();
        let err = build_job(
            JobRequest { kind: "promote".into(), project: None, ids: None, routine: None },
            &empty_vault, &view, &rig.state,
        )
        .unwrap_err();
        assert!(err.contains("볼트 경로"));
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
