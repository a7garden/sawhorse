//! Background harness execution. Herdr is an optional log viewer, never the owner.
use super::*;
use std::io::{Read, Seek, SeekFrom};
use std::process::Stdio;

fn args(root: &Path, record: &mut RunRecord) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = match record.agent.as_str() {
        "claude" => {
            let mut args = vec!["-p".into(), "--output-format".into(), "stream-json".into(), "--verbose".into()];
            if let Some(session) = &record.agent_session {
                args.extend(["--resume".into(), session.clone()]);
            } else {
                let session = Uuid::new_v4().to_string();
                args.extend(["--session-id".into(), session.clone()]);
                record.agent_session = Some(session);
            }
            args
        }
        "codex" => vec!["exec".into(), "--json".into(), "--sandbox".into(), "workspace-write".into()],
        "omp" => vec!["-p".into()],
        agent => return Err(format!("{agent}의 백그라운드 실행은 아직 지원하지 않습니다. Claude, Codex 또는 OMP를 선택하거나 실행 설정에서 herdr를 선택하세요.")),
    };
    if record.workflow_id == sdlc::goals::WORKFLOW {
        match record.agent.as_str() {
            "claude" => args.extend(["--permission-mode".into(), "bypassPermissions".into()]),
            "codex" => args.extend(["-c".into(), "approval_policy=\"never\"".into()]),
            _ => return Err("골 모드는 Codex 또는 Claude 실행이 필요합니다".into()),
        }
    }
    args.extend([
        "--add-dir".into(),
        root.canonicalize()
            .map_err(|e| e.to_string())?
            .display()
            .to_string(),
    ]);
    push_extra_dirs(&mut args, &record.extra_paths);
    if !record.model.is_empty() {
        args.extend(["--model".into(), record.model.clone()]);
    }
    args.push(record.prompt.clone());
    Ok(args)
}

/// 사람이 따라 읽는 진행 로그.
///
/// transcript 는 에이전트의 stream-json 원문이라 그대로 tail 하면 JSON 한 줄씩만
/// 흘러간다. 같은 내용을 한 줄씩 사람 말로 옮겨 두고 「herdr로 보기」는 이 파일을 tail 한다.
/// 원문은 `report()` 가 파싱해야 하므로 손대지 않는다.
fn view_log_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    checked_run_id(id)?;
    Ok(runs_dir(root)?.join(format!("{id}.view.log")))
}

/// 터미널 한 줄을 넘기면 따라 읽기 어렵다. 도구 인자·결과는 앞부분만 남긴다.
const VIEW_LINE_MAX: usize = 400;

/// 여러 줄짜리 값을 한 줄로 접고 길면 자른다.
fn one_line(text: &str, max: usize) -> String {
    let folded = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if folded.chars().count() <= max {
        folded
    } else {
        format!("{} …", folded.chars().take(max).collect::<String>())
    }
}

/// 도구 호출에서 사람이 알아볼 만한 인자 하나. 못 고르면 입력 전체를 줄여 쓴다.
fn tool_brief(input: &Value) -> String {
    for key in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "description",
        "prompt",
        "query",
    ] {
        if let Some(value) = input[key].as_str().filter(|s| !s.trim().is_empty()) {
            return one_line(value, VIEW_LINE_MAX);
        }
    }
    match input {
        Value::Null => String::new(),
        other => one_line(&other.to_string(), VIEW_LINE_MAX),
    }
}

/// 도구 결과는 문자열이거나 블록 배열이다.
fn result_text(content: &Value) -> String {
    match content {
        Value::String(text) => one_line(text, VIEW_LINE_MAX),
        Value::Array(blocks) => one_line(
            &blocks
                .iter()
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join(" "),
            VIEW_LINE_MAX,
        ),
        _ => String::new(),
    }
}

/// stream-json 한 줄을 사람이 읽는 줄로 옮긴다. JSON 이 아닌 줄(stderr, 머리말)은
/// 그대로 흘려보내고, 화면에 남길 게 없는 이벤트는 버린다.
fn render_line(line: &str) -> Option<String> {
    let line = line.trim_end_matches(['\n', '\r']);
    if line.trim().is_empty() {
        return None;
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Some(line.to_string());
    };
    let mut out: Vec<String> = Vec::new();
    match value["type"].as_str().unwrap_or_default() {
        "system" if value["subtype"] == "init" => out.push(format!(
            "── 세션 시작 · {}",
            value["model"].as_str().unwrap_or("모델 미상")
        )),
        "assistant" | "user" => {
            for block in value["message"]["content"].as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or_default() {
                    "text" => {
                        let text = one_line(block["text"].as_str().unwrap_or_default(), VIEW_LINE_MAX);
                        if !text.is_empty() {
                            out.push(format!("● {text}"));
                        }
                    }
                    "thinking" => out.push("● (생각 중)".into()),
                    "tool_use" => out.push(format!(
                        "⏺ {}({})",
                        block["name"].as_str().unwrap_or("tool"),
                        tool_brief(&block["input"])
                    )),
                    "tool_result" => {
                        let text = result_text(&block["content"]);
                        if !text.is_empty() {
                            out.push(format!("  ↳ {text}"));
                        }
                    }
                    _ => {}
                }
            }
        }
        "result" => out.push(if value["is_error"] == true {
            format!(
                "✖ 실패: {}",
                one_line(value["result"].as_str().unwrap_or("오류"), VIEW_LINE_MAX)
            )
        } else {
            format!(
                "✔ 완료: {}",
                one_line(value["result"].as_str().unwrap_or_default(), VIEW_LINE_MAX)
            )
        }),
        // codex 의 이벤트 이름
        "item.completed" => {
            let item = &value["item"];
            match item["type"].as_str().unwrap_or_default() {
                "agent_message" => out.push(format!(
                    "● {}",
                    one_line(item["text"].as_str().unwrap_or_default(), VIEW_LINE_MAX)
                )),
                "command_execution" => out.push(format!(
                    "⏺ {}",
                    one_line(item["command"].as_str().unwrap_or_default(), VIEW_LINE_MAX)
                )),
                _ => {}
            }
        }
        "turn.completed" => out.push("✔ 턴 완료".into()),
        "turn.failed" | "error" => out.push(format!(
            "✖ {}",
            one_line(
                value["error"]["message"]
                    .as_str()
                    .or(value["message"].as_str())
                    .unwrap_or("에이전트 실행 오류"),
                VIEW_LINE_MAX,
            )
        )),
        _ => {}
    }
    (!out.is_empty()).then(|| out.join("\n"))
}

/// 파일에서 읽어 온 덩어리는 줄 가운데서 잘린다. 완성된 줄만 옮기고 나머지는
/// 다음 덩어리까지 들고 있는다. 바이트로 모으는 이유는 256KB 경계가 한글 한 글자를
/// 반으로 자를 수 있기 때문이다.
#[derive(Default)]
struct ViewLog {
    pending: Vec<u8>,
}

impl ViewLog {
    fn write(path: &Path, text: &str) -> Result<(), String> {
        use std::io::Write;
        reject_symlink(path)?;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| file.write_all(text.as_bytes()))
            .map_err(|e| format!("진행 로그를 쓸 수 없습니다: {e}"))
    }

    fn push(&mut self, path: &Path, chunk: &[u8]) -> Result<(), String> {
        self.pending.extend_from_slice(chunk);
        let mut rendered = String::new();
        while let Some(index) = self.pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=index).collect();
            if let Some(text) = render_line(&String::from_utf8_lossy(&line)) {
                rendered.push_str(&text);
                rendered.push('\n');
            }
        }
        if rendered.is_empty() {
            return Ok(());
        }
        Self::write(path, &rendered)
    }

    /// 마지막 줄에 개행이 없을 수 있다.
    fn flush(&mut self, path: &Path) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let line = std::mem::take(&mut self.pending);
        match render_line(&String::from_utf8_lossy(&line)) {
            Some(text) => Self::write(path, &format!("{text}\n")),
            None => Ok(()),
        }
    }
}

/// 이 변경 전에 시작했거나 이미 끝난 실행에는 진행 로그가 없다. 그때는 transcript 를
/// 한 번 옮겨 담아 만들어 준다 — tail 대상 파일이 없으면 pane 에 오류만 뜬다.
fn ensure_view_log(root: &Path, id: &str) -> Result<PathBuf, String> {
    let path = view_log_path(root, id)?;
    reject_symlink(&path)?;
    if path.is_file() {
        return Ok(path);
    }
    let transcript = transcript_path(root, id)?;
    reject_symlink(&transcript)?;
    // 원문이 비어 있어도 파일 자체는 있어야 tail 이 붙는다. 먼저 만들고 채운다.
    ViewLog::write(&path, "")?;
    let raw = fs::read(&transcript).unwrap_or_default();
    let mut view = ViewLog::default();
    view.push(&path, &raw)?;
    view.flush(&path)?;
    Ok(path)
}

fn read_tail(path: &Path) -> Result<String, String> {
    reject_symlink(path)?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(256_000)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Exit zero alone does not prove an agent completed a turn.
fn report(agent: &str, output: &str) -> Result<String, String> {
    if agent == "omp" {
        return if output.trim().is_empty() {
            Err("에이전트가 결과 없이 조기 종료했습니다".into())
        } else {
            Ok(tail_chars(output, MAX_FINAL_REPORT))
        };
    }
    let mut completed = false;
    let mut result = String::new();
    for line in output.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value["error"].as_str().is_some_and(sdlc::goals::quota_error)
            || value["error"]["code"].as_str().is_some_and(sdlc::goals::quota_error)
        {
            return Err(value["error"].to_string());
        }
        match value["type"].as_str().unwrap_or_default() {
            "result" => {
                if value["permission_denials"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
                {
                    return Err(format!(
                        "도구 권한이 거부되어 작업을 완료하지 못했습니다: {}",
                        value["result"].as_str().unwrap_or_default()
                    ));
                }
                if value["is_error"] == true {
                    if let Some(errors) = value["errors"].as_array().filter(|errors| !errors.is_empty()) {
                        return Err(errors.iter().map(|error| error.as_str().map(str::to_string).unwrap_or_else(|| error.to_string())).collect::<Vec<_>>().join("\n"));
                    }
                    return Err(value["result"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("에이전트 오류 또는 도구 권한 거부로 작업을 마치지 못했습니다")
                        .into());
                }
                completed = true;
                result = value["result"].as_str().unwrap_or_default().into();
            }
            "turn.completed" => completed = true,
            "turn.failed" | "error" => {
                return Err(value["error"]["message"]
                    .as_str()
                    .or(value["message"].as_str())
                    .unwrap_or("에이전트 실행 오류")
                    .into())
            }
            "item.completed" if value["item"]["type"] == "agent_message" => {
                result = value["item"]["text"].as_str().unwrap_or_default().into();
            }
            _ => {}
        }
    }
    if !completed || result.trim().is_empty() {
        Err(
            "완료 보고 없이 에이전트가 조기 종료했습니다. 실행 출력을 확인하고 다시 실행하세요."
                .into(),
        )
    } else {
        Ok(tail_chars(&result, MAX_FINAL_REPORT))
    }
}

fn process_alive(pid: u32) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let output = crate::spawn::platform_command("/bin/ps", &["-p", &pid.to_string(), "-o", "pid="])
            .output().map_err(|e| e.to_string())?;
        if output.status.success() { return Ok(!output.stdout.is_empty()); }
        if output.status.code() == Some(1) && output.stderr.is_empty() { return Ok(false); }
        Err("백그라운드 프로세스 생존 여부를 확인할 수 없습니다".into())
    }
    #[cfg(windows)]
    {
        let output = crate::spawn::platform_command("tasklist.exe", &["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err("백그라운드 프로세스 생존 여부를 확인할 수 없습니다".into()); }
        Ok(String::from_utf8_lossy(&output.stdout).contains(&format!("\",\"{pid}\",")))
    }
}

pub(super) fn refresh(root: &Path, mut record: RunRecord) -> Result<RunRecord, String> {
    if refreshable_status(&record.status) && !start_is_local(&record.id) {
        let _owner = match crate::workspace_io::lock(root, &format!("run-owner-{}", record.id)) {
            Ok(owner) => owner,
            Err(error) if error.starts_with("workspace-busy") => return Ok(record),
            Err(error) => return Err(error),
        };
        if record.worker_pid.is_some_and(|pid| process_alive(pid).unwrap_or(true)) {
            update(&mut record, "unknown", Some("이전 백그라운드 프로세스가 살아 있어 작업 점유를 유지합니다. 종료를 확인한 뒤 이어갑니다.".into()));
            save_record(root, &record)?;
            return Ok(record);
        }
        // The launch transaction may have persisted the run just before its owner
        // acquired the lifetime lock. Allow that short dispatch window.
        if record.status == "starting" && chrono::DateTime::parse_from_rfc3339(&record.updated_at)
            .is_ok_and(|time| (Utc::now() - time.with_timezone(&Utc)).num_seconds() < 30) {
            return Ok(record);
        }
        // A durable record exists briefly before spawn_start registers its owner.
        if record.status == "starting" && !startup_expired(&record) {
            return Ok(record);
        }
        update(&mut record, "failed", Some("앱 재시작 또는 실행 감시 중단으로 백그라운드 작업이 끊겼습니다. 출력을 확인한 뒤 다시 실행하세요.".into()));
        record.final_report = read_tail(&transcript_path(root, &record.id)?)
            .ok()
            .map(|s| tail_chars(&s, MAX_FINAL_REPORT));
        save_record(root, &record)?;
    }
    Ok(record)
}

async fn kill_tree(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        #[cfg(unix)]
        let _ =
            crate::spawn::platform_command_async("/bin/kill", &["-KILL", "--", &format!("-{pid}")])
                .status()
                .await;
        #[cfg(windows)]
        let _ = crate::spawn::platform_command_async(
            "taskkill",
            &["/PID", &pid.to_string(), "/T", "/F"],
        )
        .status()
        .await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

pub(super) async fn run(root: &Path, mut record: RunRecord) {
    let outcome = execute(root, &mut record).await;
    let _guard = run_lock(&record.id).lock().await;
    // An explicit viewer open may have added pane identity while this task ran.
    let mut latest = load_record(root, &record.id).unwrap_or(record);
    latest.worker_pid = None;
    match outcome {
        Ok(Some(report)) => {
            latest.final_report = Some(report);
            update(&mut latest, "review", None);
        }
        Ok(None) => update(
            &mut latest,
            "stopped",
            Some("사용자가 실행을 중단했습니다. 작업은 완료되지 않았습니다.".into()),
        ),
        Err(error) => update(&mut latest, "failed", Some(error)),
    }
    // 뷰어를 열어 둔 사람이 끝을 보고 알 수 있어야 한다 — 진행 로그는 tail 중이다.
    if let Ok(path) = view_log_path(root, &latest.id) {
        let _ = ViewLog::write(
            &path,
            &match &latest.error {
                Some(error) => format!("── 실행 종료 ({}) · {error}\n", latest.status),
                None => format!("── 실행 종료 ({})\n", latest.status),
            },
        );
    }
    if let Some(error) = &latest.error {
        let _ = append_output(root, &latest, &format!("[{}] {error}", latest.status));
        latest.final_report = read_tail(&transcript_path(root, &latest.id).unwrap_or_default())
            .ok()
            .map(|text| tail_chars(&text, MAX_FINAL_REPORT));
    }
    if let Err(error) = save_record(root, &latest) {
        eprintln!("harness {}: {error}", latest.id);
    }
    let _ = clear_cancel(root, &latest.id);
}

async fn execute(root: &Path, record: &mut RunRecord) -> Result<Option<String>, String> {
    if cancellation_requested(root, record)? {
        return Ok(None);
    }
    let args = args(root, record)?;
    let cmd = crate::spawn::platform_command_async(
        &record.agent,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    let timeout = config::load_view()
        .dashboard
        .herdr
        .sanitized()
        .job_timeout_min;
    execute_command(
        root,
        record,
        cmd,
        (timeout > 0).then(|| Duration::from_secs(timeout as u64 * 60)),
    )
    .await
}

/// 에이전트가 쓰고 있는 로그에서 아직 안 옮긴 부분을 transcript(원문)와
/// 진행 로그(사람이 읽는 쪽) 양쪽으로 옮기고, 이번에 옮긴 바이트 수를 돌려준다.
fn drain(
    source: &Path,
    offset: &mut u64,
    transcript: &Path,
    view_path: &Path,
    view: &mut ViewLog,
) -> Result<usize, String> {
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    input
        .seek(SeekFrom::Start(*offset))
        .map_err(|e| e.to_string())?;
    let mut chunk = Vec::new();
    input
        .take(256_000)
        .read_to_end(&mut chunk)
        .map_err(|e| e.to_string())?;
    if chunk.is_empty() {
        return Ok(0);
    }
    use std::io::Write;
    fs::OpenOptions::new()
        .append(true)
        .open(transcript)
        .and_then(|mut file| file.write_all(&chunk))
        .map_err(|e| e.to_string())?;
    *offset += chunk.len() as u64;
    view.push(view_path, &chunk)?;
    Ok(chunk.len())
}

async fn execute_command(
    root: &Path,
    record: &mut RunRecord,
    mut cmd: tokio::process::Command,
    timeout: Option<Duration>,
) -> Result<Option<String>, String> {
    let output_path = transcript_path(root, &record.id)?;
    reject_symlink(&output_path)?;
    let output = fs::OpenOptions::new()
        .append(true)
        .open(&output_path)
        .map_err(|e| e.to_string())?;
    // Store this turn separately: a prior successful result must never mask an early exit.
    let turn_path = runs_dir(root)?.join(format!("{}.stdout.log", record.id));
    let stderr_path = runs_dir(root)?.join(format!("{}.stderr.log", record.id));
    reject_symlink(&turn_path)?;
    reject_symlink(&stderr_path)?;
    let stdout = fs::File::create(&turn_path).map_err(|e| e.to_string())?;
    let stderr = fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    drop(output);
    // 이 턴이 시작되기 전에 진행 로그가 있어야 「herdr로 보기」가 곧바로 붙는다.
    let view_path = ensure_view_log(root, &record.id)?;
    {
        let _guard = run_lock(&record.id).lock().await;
        let mut latest = load_record(root, &record.id)?;
        latest.agent_session = record.agent_session.clone();
        save_record(root, &latest)?;
    }
    cmd.current_dir(&record.repo_path)
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_CHILD_SESSION")
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} 백그라운드 시작 실패: {e}", record.agent))?;
    record.worker_pid = child.id();
    if let Err(error) = save_record(root, record) {
        kill_tree(&mut child).await;
        return Err(error);
    }
    let start = Instant::now();
    let mut offsets = [0_u64; 2];
    let mut views = [ViewLog::default(), ViewLog::default()];
    loop {
        let step = async {
            let _guard = run_lock(&record.id).lock().await;
            let mut latest = load_record(root, &record.id)?;
            for (index, path) in [&turn_path, &stderr_path].iter().enumerate() {
                drain(
                    path,
                    &mut offsets[index],
                    &output_path,
                    &view_path,
                    &mut views[index],
                )?;
            }
            if latest.parent_run_id.is_none()
                && latest.workflow_id == "intent-flow"
                && latest.workflow_version == "2.0.0"
            {
                sdlc::lifecycle::process_requests(
                    root,
                    &latest.work_id,
                    &latest.id,
                    &latest.stage,
                    false,
                )?;
            }
            update(&mut latest, "running", None);
            save_record(root, &latest)?;
            cancellation_requested(root, &latest)
        }
        .await;
        match step {
            Ok(true) => {
                kill_tree(&mut child).await;
                return Ok(None);
            }
            Err(error) => {
                kill_tree(&mut child).await;
                return Err(error);
            }
            _ => {}
        }
        if timeout.is_some_and(|timeout| start.elapsed() > timeout) {
            kill_tree(&mut child).await;
            return Err("실행 제한 시간을 초과해 중단했습니다. 작업은 완료되지 않았습니다.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                for (index, path) in [&turn_path, &stderr_path].iter().enumerate() {
                    while drain(
                        path,
                        &mut offsets[index],
                        &output_path,
                        &view_path,
                        &mut views[index],
                    )? > 0
                    {}
                    views[index].flush(&view_path)?;
                }
                let stderr = read_tail(&stderr_path)?;
                let stdout = read_tail(&turn_path)?;
                if !status.success() {
                    // Provider errors often arrive on stdout even with a nonzero exit.
                    let detail = report(&record.agent, &stdout).err().unwrap_or_default();
                    return Err(format!(
                        "에이전트 비정상 종료 ({status}): {detail}\n{}",
                        tail_chars(&stderr, MAX_FINAL_REPORT)
                    ));
                }
                let report = report(&record.agent, &stdout)?;
                if record.parent_run_id.is_none()
                    && record.workflow_id == "intent-flow"
                    && record.workflow_version == "2.0.0"
                {
                    sdlc::lifecycle::process_requests(
                        root,
                        &record.work_id,
                        &record.id,
                        &record.stage,
                        true,
                    )?;
                }
                return Ok(Some(report));
            }
            Err(error) => {
                kill_tree(&mut child).await;
                return Err(format!("프로세스 상태 확인 실패: {error}"));
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
        }
    }
}

pub(super) async fn open_viewer(root: &Path, record: &mut RunRecord) -> Result<(), String> {
    let h = herdr_for(record);
    open_viewer_with(root, record, &h).await
}

async fn open_viewer_with(root: &Path, record: &mut RunRecord, h: &Herdr) -> Result<(), String> {
    if let Some(tab) = &record.tab_id {
        if h.focus_tab(tab).await.is_ok() {
            if let Some(workspace) = &record.workspace_id {
                h.focus_workspace(workspace)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
    }
    // 원문(stream-json)이 아니라 사람이 읽는 진행 로그를 따라간다.
    let path = ensure_view_log(root, &record.id)?;
    // 같은 실행을 다시 열 때 워크스페이스를 새로 만들면 herdr 전환기에 계속 쌓인다.
    // 기록해 둔 것 → 라벨이 같은 것 → 없으면 그때 새로 만든다.
    let label = format!("sdd-{}", &record.id[..8]);
    let (workspace, created) = match record.workspace_id.as_deref() {
        Some(id) if h.workspace_exists(id).await => (id.to_string(), false),
        _ => match h.find_workspace_by_label(&label).await {
            Some(id) => (id, false),
            None => (
                h.create_workspace(&label).await.map_err(|e| e.to_string())?,
                true,
            ),
        },
    };
    let tab = match h
        .create_tab(&workspace, "execution log", &record.repo_path)
        .await
    {
        Ok(tab) => tab,
        Err(e) => {
            // 남의 워크스페이스는 닫지 않는다. 방금 내가 만든 것만 치운다.
            if created {
                let _ = h.close_workspace(&workspace).await;
            }
            return Err(e.to_string());
        }
    };
    // Quote the literal file path for the pane's platform shell. No prompt is executed.
    #[cfg(not(windows))]
    let command = format!(
        "tail -n 200 -f '{}'",
        path.display().to_string().replace('\'', "'\\''")
    );
    #[cfg(windows)]
    let command = format!(
        "Get-Content -LiteralPath '{}' -Tail 200 -Wait",
        path.display().to_string().replace('\'', "''")
    );
    if let Err(e) = h.call(&["pane", "run", &tab.pane_id, &command]).await {
        let _ = h.close_tab(&tab.tab_id).await;
        if created {
            let _ = h.close_workspace(&workspace).await;
        }
        return Err(e.to_string());
    }
    record.workspace_id = Some(workspace.clone());
    record.tab_id = Some(tab.tab_id.clone());
    record.pane_id = Some(tab.pane_id);
    record.tab_closed_at = None;
    save_record(root, record)?;
    h.focus_workspace(&workspace)
        .await
        .map_err(|e| e.to_string())?;
    h.focus_tab(&tab.tab_id).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, RunRecord) {
        let root = tempfile::tempdir().unwrap();
        let mut record = super::super::tests::record(Uuid::new_v4().to_string(), None, "starting");
        record.runner = "headless".into();
        record.pane_id = None;
        record.tab_id = None;
        record.workspace_id = None;
        record.agent = "claude".into();
        record.repo_path = root.path().display().to_string();
        record.workflow_id = "sdd-main".into();
        save_record(root.path(), &record).unwrap();
        fs::write(transcript_path(root.path(), &record.id).unwrap(), "").unwrap();
        (root, record)
    }

    #[test]
    fn background_args_keep_scope_and_claude_session_and_reject_unknown_drivers() {
        let (root, mut record) = fixture();
        record.extra_paths = vec!["/trusted library".into()];
        record.model = "sonnet".into();
        let first = args(root.path(), &mut record).unwrap();
        assert!(first.contains(&"--session-id".into()));
        assert!(first.contains(&"/trusted library".into()));
        let session = record.agent_session.clone().unwrap();
        let next = args(root.path(), &mut record).unwrap();
        assert!(next.contains(&"--resume".into()));
        assert!(next.contains(&session));
        record.agent = "unsupported".into();
        assert!(args(root.path(), &mut record).is_err());
    }

    /// 뷰어가 tail 하는 파일은 사람이 읽을 수 있어야 한다. JSON 이 아닌 줄
    /// (stderr, 머리말)은 그대로 두고, 화면에 남길 게 없는 이벤트는 버린다.
    #[test]
    fn stream_json_renders_as_readable_progress() {
        assert_eq!(
            render_line(r#"{"type":"system","subtype":"init","model":"opus"}"#).unwrap(),
            "── 세션 시작 · opus"
        );
        assert_eq!(
            render_line(
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"저장소를\n살펴봅니다"}]}}"#
            )
            .unwrap(),
            "● 저장소를 살펴봅니다"
        );
        assert_eq!(
            render_line(
                r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}]}}"#
            )
            .unwrap(),
            "⏺ Bash(cargo test)"
        );
        assert_eq!(
            render_line(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#
            )
            .unwrap(),
            "  ↳ ok"
        );
        assert_eq!(
            render_line(r#"{"type":"result","is_error":false,"result":"끝"}"#).unwrap(),
            "✔ 완료: 끝"
        );
        assert_eq!(
            render_line(r#"{"type":"turn.failed","error":{"message":"quota"}}"#).unwrap(),
            "✖ quota"
        );
        assert_eq!(
            render_line(
                r#"{"type":"item.completed","item":{"type":"agent_message","text":"done"}}"#
            )
            .unwrap(),
            "● done"
        );
        // 원문이 아닌 줄은 손대지 않는다
        assert_eq!(
            render_line("# Harness transcript: x").unwrap(),
            "# Harness transcript: x"
        );
        // 사람이 볼 게 없는 이벤트와 빈 줄은 흘리지 않는다
        assert!(render_line(r#"{"type":"stream_event","event":{}}"#).is_none());
        assert!(render_line("   ").is_none());
    }

    /// 덩어리 경계가 줄 가운데(한글 한 글자 가운데까지)에 떨어져도 글자가 깨지면 안 된다.
    #[test]
    fn view_log_buffers_partial_lines_across_chunks() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("view.log");
        let full =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"진행 상황"}]}}"#
                .as_bytes()
                .to_vec();
        let cut = full.len() - 12;
        let mut view = ViewLog::default();
        view.push(&path, &full[..cut]).unwrap();
        assert!(!path.exists() || fs::read_to_string(&path).unwrap().is_empty());
        view.push(&path, &full[cut..]).unwrap();
        view.flush(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "● 진행 상황\n");
    }

    /// 이 변경 전에 돌았거나 이미 끝난 실행을 처음 뷰어로 열면, 그때까지의 원문이
    /// 사람이 읽는 형태로 그대로 채워져 있어야 한다.
    #[test]
    fn first_viewer_open_backfills_existing_transcript() {
        let (root, record) = fixture();
        fs::write(
            transcript_path(root.path(), &record.id).unwrap(),
            "# Harness transcript: x\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"이미 지나간 진행\"}]}}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"끝\"}\n",
        )
        .unwrap();
        let path = ensure_view_log(root.path(), &record.id).unwrap();
        let rendered = fs::read_to_string(&path).unwrap();
        assert!(rendered.contains("● 이미 지나간 진행"), "{rendered}");
        assert!(rendered.contains("✔ 완료: 끝"), "{rendered}");
        // 두 번째 호출은 이미 있는 파일을 그대로 쓴다 — 내용이 겹쳐 쌓이지 않는다
        assert_eq!(
            ensure_view_log(root.path(), &record.id).unwrap(),
            path
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), rendered);
    }

    #[test]
    fn restart_marks_abandoned_background_runs_for_attention() {
        let (root, mut record) = fixture();
        record.status = "running".into();
        let result = refresh(root.path(), record).unwrap();
        assert_eq!(result.status, "failed");
        assert!(result.error.unwrap().contains("재시작"));
        assert_eq!(
            load_record(root.path(), &result.id).unwrap().status,
            "failed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_viewer_opens_once_without_starting_another_agent() {
        use std::os::unix::fs::PermissionsExt;
        let (root, mut record) = fixture();
        record.status = "running".into();
        let script = root.path().join("fake-herdr");
        fs::write(
            &script,
            r#"#!/bin/sh
cd "$(dirname "$0")"
echo "$1 $2" >> calls
case "$1 $2" in
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"w1:t1"},"root_pane":{"pane_id":"w1:p1"}}}' ;;
  "workspace get") echo '{"result":{"workspace":{"workspace_id":"w1"}}}' ;;
  "tab focus") [ "$3" = "gone" ] && exit 1; echo '{"result":{}}' ;;
  "pane run"|"workspace focus") echo '{"result":{}}' ;;
  *) exit 1 ;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let h = Herdr::new(&config::HerdrCfg {
            bin: script.display().to_string(),
            ..Default::default()
        });
        open_viewer_with(root.path(), &mut record, &h)
            .await
            .unwrap();
        open_viewer_with(root.path(), &mut record, &h)
            .await
            .unwrap();
        // 탭이 사라진 뒤 다시 열어도 워크스페이스는 기록해 둔 것을 그대로 쓴다 —
        // 볼 때마다 새로 만들면 herdr 전환기에 sdd-* 워크스페이스가 쌓인다.
        record.tab_id = Some("gone".into());
        save_record(root.path(), &record).unwrap();
        open_viewer_with(root.path(), &mut record, &h)
            .await
            .unwrap();
        let calls = fs::read_to_string(root.path().join("calls")).unwrap();
        assert_eq!(calls.matches("workspace create").count(), 1);
        assert_eq!(calls.matches("tab create").count(), 2);
        assert_eq!(calls.matches("pane run").count(), 2);
        assert!(!calls.contains("agent start"));
        assert_eq!(record.runner, "headless");
        assert_eq!(record.status, "running");
        assert_eq!(
            load_record(root.path(), &record.id)
                .unwrap()
                .pane_id
                .as_deref(),
            Some("w1:p1")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_process_captures_both_streams_and_rejects_empty_followup() {
        let (root, mut record) = fixture();
        let cmd = crate::spawn::platform_command_async("/bin/sh", &["-c", "echo diagnostic >&2; echo '{\"type\":\"result\",\"is_error\":false,\"result\":\"completed report\"}'"]);
        let result = execute_command(root.path(), &mut record, cmd, Some(Duration::from_secs(3)))
            .await
            .unwrap();
        assert_eq!(result.as_deref(), Some("completed report"));
        let output = fs::read_to_string(transcript_path(root.path(), &record.id).unwrap()).unwrap();
        assert!(output.contains("diagnostic"));
        assert!(output.contains("completed report"));
        assert!(load_record(root.path(), &record.id)
            .unwrap()
            .pane_id
            .is_none());
        let empty = crate::spawn::platform_command_async("/bin/sh", &["-c", "exit 0"]);
        assert!(execute_command(
            root.path(),
            &mut record,
            empty,
            Some(Duration::from_secs(3))
        )
        .await
        .unwrap_err()
        .contains("조기 종료"));
        let failure =
            crate::spawn::platform_command_async("/bin/sh", &["-c", "echo auth-error >&2; exit 7"]);
        assert!(execute_command(
            root.path(),
            &mut record,
            failure,
            Some(Duration::from_secs(3))
        )
        .await
        .unwrap_err()
        .contains("auth-error"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_process_honors_cancellation_and_timeout() {
        let (root, mut record) = fixture();
        request_cancel(root.path(), &record.id).unwrap();
        let cmd = crate::spawn::platform_command_async("/bin/sh", &["-c", "sleep 30"]);
        assert!(
            execute_command(root.path(), &mut record, cmd, Some(Duration::from_secs(3)))
                .await
                .unwrap()
                .is_none()
        );
        clear_cancel(root.path(), &record.id).unwrap();
        let cmd = crate::spawn::platform_command_async("/bin/sh", &["-c", "sleep 30"]);
        assert!(execute_command(
            root.path(),
            &mut record,
            cmd,
            Some(Duration::from_millis(20))
        )
        .await
        .unwrap_err()
        .contains("제한 시간"));
    }
    #[test]
    fn requires_completion_and_reports_permissions_and_errors() {
        assert!(sdlc::goals::quota_error(&report("claude", r#"{"type":"assistant","error":"rate_limit"}"#).unwrap_err()));
        assert!(sdlc::goals::quota_error(&report("claude", r#"{"type":"result","is_error":true,"errors":["usage limit reached"]}"#).unwrap_err()));
        assert!(report("claude", "").is_err());
        assert!(report(
            "codex",
            r#"{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}"#
        )
        .is_err());
        assert_eq!(
            report(
                "claude",
                r#"{"type":"result","is_error":false,"result":"done"}"#
            )
            .unwrap(),
            "done"
        );
        assert!(report(
            "claude",
            r#"{"type":"result","is_error":false,"result":"denied","permission_denials":[{}]}"#
        )
        .is_err());
        assert!(report(
            "codex",
            r#"{"type":"turn.failed","error":{"message":"quota"}}"#
        )
        .unwrap_err()
        .contains("quota"));
        assert_eq!(report("codex", "{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n{\"type\":\"turn.completed\"}").unwrap(), "done");
    }
}
