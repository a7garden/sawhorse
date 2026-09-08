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
    loop {
        let step = async {
            let _guard = run_lock(&record.id).lock().await;
            let mut latest = load_record(root, &record.id)?;
            for (index, path) in [&turn_path, &stderr_path].iter().enumerate() {
                let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
                input
                    .seek(SeekFrom::Start(offsets[index]))
                    .map_err(|e| e.to_string())?;
                let mut chunk = Vec::new();
                input
                    .take(256_000)
                    .read_to_end(&mut chunk)
                    .map_err(|e| e.to_string())?;
                if !chunk.is_empty() {
                    use std::io::Write;
                    fs::OpenOptions::new()
                        .append(true)
                        .open(&output_path)
                        .and_then(|mut f| f.write_all(&chunk))
                        .map_err(|e| e.to_string())?;
                    offsets[index] += chunk.len() as u64;
                }
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
                    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
                    input
                        .seek(SeekFrom::Start(offsets[index]))
                        .map_err(|e| e.to_string())?;
                    let mut target = fs::OpenOptions::new()
                        .append(true)
                        .open(&output_path)
                        .map_err(|e| e.to_string())?;
                    std::io::copy(&mut input, &mut target).map_err(|e| e.to_string())?;
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
    let path = transcript_path(root, &record.id)?;
    reject_symlink(&path)?;
    let workspace = h
        .create_workspace(&format!("sdd-{}", &record.id[..8]))
        .await
        .map_err(|e| e.to_string())?;
    let tab = match h
        .create_tab(&workspace, "execution log", &record.repo_path)
        .await
    {
        Ok(tab) => tab,
        Err(e) => {
            let _ = h.close_workspace(&workspace).await;
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
        let _ = h.close_workspace(&workspace).await;
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
  "pane run"|"workspace focus"|"tab focus") echo '{"result":{}}' ;;
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
        let calls = fs::read_to_string(root.path().join("calls")).unwrap();
        assert_eq!(calls.matches("workspace create").count(), 1);
        assert_eq!(calls.matches("pane run").count(), 1);
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
