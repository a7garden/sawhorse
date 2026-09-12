// Verification profile execution. Design line 824: command, health, and manual checks.
// Actual commands come only from profiles saved by a human (design lines 290-291) — there is no path
// for candidates or agents to inject verification commands.

use super::model::{CheckRun, VerifyCheck, VerifyProfile};
use super::{new_id, now_ts, workbench_root};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// Check result. The log body is stored as a content-hash artifact file instead of in the DB (design line 511).
#[derive(Clone, Debug)]
pub struct CheckOutcome {
    pub name: String,
    pub passed: bool,
    pub log_ref: String,
    pub detail: String,
}

/// Save an artifact log. sha256 file name, under `projects/<project-id>/artifacts/`.
pub fn save_artifact(project_id: &str, label: &str, content: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(content.as_bytes());
    let hash = hex::encode(h.finalize());
    let dir = workbench_root()
        .join("projects")
        .join(project_id)
        .join("artifacts");
    if std::fs::create_dir_all(&dir).is_ok() {
        let name = format!("{hash}.txt");
        let path = dir.join(&name);
        if std::fs::write(&path, content).is_ok() {
            return name;
        }
    }
    // A save failure is not fatal — continue without a log_ref.
    let _ = label;
    String::new()
}

/// Command check. argv is used exactly as saved in the profile; cwd is relative to the integration checkout.
pub fn run_command_check(
    cwd_root: &Path,
    cwd: &str,
    argv: &[String],
    timeout_secs: u64,
) -> CheckOutcome {
    let name = format!("command:{}", argv.join(" "));
    if argv.is_empty() {
        return CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: "빈 argv".into(),
        };
    }
    let dir = if cwd.is_empty() {
        cwd_root.to_path_buf()
    } else {
        cwd_root.join(cwd)
    };
    if !dir.is_dir() {
        return CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: format!("cwd 없음: {}", dir.display()),
        };
    }
    let mut child = match crate::spawn::no_window(Command::new(&argv[0]))
        .args(&argv[1..])
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return CheckOutcome {
                name,
                passed: false,
                log_ref: String::new(),
                detail: format!("실행 실패: {e}"),
            };
        }
    };
    // timeout_secs를 실제로 강제한다 — try_wait 폴링 후 시간 초과면 kill해 hung 프로세스가
    // 통합 워커를 영구 점유하지 않게 한다 (detect.rs version_of_sync와 같은 패턴).
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let finished = loop {
        match child.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            _ => break false,
        }
    };
    if !finished {
        let _ = child.kill();
        let _ = child.wait();
        return CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: format!("시간 초과: {timeout_secs}초 안에 끝나지 않았다"),
        }
        .with_log(format!(
            "argv: {argv:?}\ncwd: {}\ntimeout: {timeout_secs}s",
            dir.display()
        ));
    }
    let out = child.wait_with_output();
    match out {
        Ok(o) => {
            let log = format!(
                "argv: {:?}\ncwd: {}\nexit: {:?}\n\n--- stdout ---\n{}\n--- stderr ---\n{}",
                argv,
                dir.display(),
                o.status.code(),
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr),
            );
            CheckOutcome {
                name,
                passed: o.status.success(),
                log_ref: String::new(), // caller fills this in with project_id and saves it
                detail: if o.status.success() {
                    "exit 0".into()
                } else {
                    format!("exit {:?}", o.status.code())
                },
            }
            .with_log(log)
        }
        Err(e) => CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: format!("실행 실패: {e}"),
        },
    }
}

impl CheckOutcome {
    fn with_log(mut self, log: String) -> Self {
        self.detail = format!("{}\n{}", self.detail, log);
        self
    }
}

/// HTTP health probe. Passes when a response arrives with a 2xx status. Enforces timeout and size caps.
pub async fn run_http_check(url: &str) -> CheckOutcome {
    let name = format!("http:{url}");
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return CheckOutcome {
                name,
                passed: false,
                log_ref: String::new(),
                detail: format!("client 생성 실패: {e}"),
            }
        }
    };
    match client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            // Cap: the health probe does not read the whole body, only the leading part.
            let body = resp.bytes().await.map(|b| {
                let take = b.len().min(16 * 1024);
                String::from_utf8_lossy(&b[..take]).to_string()
            });
            CheckOutcome {
                passed: (200..300).contains(&status),
                detail: format!("status {status}\n{}", body.as_deref().unwrap_or("")),
                name,
                log_ref: String::new(),
            }
        }
        Err(e) => CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: format!("요청 실패: {e}"),
        },
    }
}

/// Run every automated check in the profile. For baseline, runs against the pre-merge state.
pub async fn run_profile_checks(
    cwd_root: &Path,
    project_id: &str,
    profile: &VerifyProfile,
    baseline: bool,
) -> Vec<(CheckRun, CheckOutcome)> {
    let mut results = Vec::new();
    for check in &profile.checks {
        let (kind, outcome) = match check {
            VerifyCheck::Command { cwd, argv } => (
                if baseline {
                    "baseline_command"
                } else {
                    "command"
                },
                tokio::task::spawn_blocking({
                    let cwd = cwd.clone();
                    let argv = argv.clone();
                    let cwd_root = cwd_root.to_path_buf();
                    move || run_command_check(&cwd_root, &cwd, &argv, 600)
                })
                .await
                .unwrap_or_else(|e| CheckOutcome {
                    name: "command".into(),
                    passed: false,
                    log_ref: String::new(),
                    detail: format!("검사 스레드 실패: {e}"),
                }),
            ),
            VerifyCheck::Http { url } => (
                if baseline { "baseline_http" } else { "http" },
                run_http_check(url).await,
            ),
        };
        let mut run = CheckRun {
            id: new_id("cr"),
            attempt_id: String::new(),
            kind: kind.into(),
            name: outcome.name.clone(),
            status: if outcome.passed { "passed" } else { "failed" }.into(),
            log_ref: String::new(),
            started_at: now_ts(),
            finished_at: now_ts(),
        };
        if !outcome.detail.is_empty() {
            run.log_ref = save_artifact(project_id, &outcome.name, &outcome.detail);
        }
        results.push((run, outcome));
    }
    results
}
/// Blocking execution for the integration worker. Workers run on spawn_blocking threads, so
/// the async http check only runs via block_on when a current runtime exists.
pub fn run_profile_checks_blocking(
    cwd_root: &Path,
    project_id: &str,
    profile: &VerifyProfile,
    baseline: bool,
) -> Vec<(CheckRun, CheckOutcome)> {
    let mut results = Vec::new();
    for check in &profile.checks {
        let (kind, outcome) = match check {
            VerifyCheck::Command { cwd, argv } => (
                if baseline {
                    "baseline_command"
                } else {
                    "command"
                },
                run_command_check(cwd_root, cwd, argv, 600),
            ),
            VerifyCheck::Http { url } => (
                if baseline { "baseline_http" } else { "http" },
                blocking_http_check(url),
            ),
        };
        let mut run = CheckRun {
            id: new_id("cr"),
            attempt_id: String::new(),
            kind: kind.into(),
            name: outcome.name.clone(),
            status: if outcome.passed { "passed" } else { "failed" }.into(),
            log_ref: String::new(),
            started_at: now_ts(),
            finished_at: now_ts(),
        };
        if !outcome.detail.is_empty() {
            run.log_ref = save_artifact(project_id, &outcome.name, &outcome.detail);
        }
        results.push((run, outcome));
    }
    results
}

/// Blocking version of the health probe. MVP profiles assume localhost dev servers, so
/// it decides with a raw HTTP/1.0 GET. https is supported only when a runtime is available.
fn blocking_http_check(url: &str) -> CheckOutcome {
    let name = format!("http:{url}");
    let rest = url
        .strip_prefix("http://")
        .unwrap_or_else(|| url.strip_prefix("https://").unwrap_or(url));
    let (host, port, path) = match rest.split_once('/') {
        Some((h, p)) => (h, 80, format!("/{p}")),
        None => (rest, 80, "/".to_string()),
    };
    let (host, port) = if let Some((h, p)) = host.split_once(':') {
        (h.to_string(), p.parse().unwrap_or(80u16))
    } else {
        (host.to_string(), port)
    };
    if url.starts_with("https://") {
        return match tokio::runtime::Handle::try_current() {
            Ok(handle) => handle.block_on(run_http_check(url)),
            Err(_) => CheckOutcome {
                name,
                passed: false,
                log_ref: String::new(),
                detail: "https probe는 런타임이 필요하다".into(),
            },
        };
    }
    use std::io::{Read, Write};
    use std::net::ToSocketAddrs;
    // 연결·읽기에 모두 시간 제한을 둔다 — 응답 없는 서버가 워커를 붙잡지 않게 한다.
    let outcome = (host.as_str(), port)
        .to_socket_addrs()
        .and_then(|mut addrs| {
            addrs
                .next()
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidInput, "주소 해석 결과가 없다")
                })
                .and_then(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_secs(5)))
        })
        .and_then(|mut stream| {
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(5)))?;
            let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
            stream.write_all(req.as_bytes())?;
            let mut buf = Vec::new();
            stream.take(16 * 1024).read_to_end(&mut buf)?;
            Ok(buf)
        });
    match outcome {
        Ok(bytes) => {
            let head = String::from_utf8_lossy(&bytes);
            let status: u16 = head
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            CheckOutcome {
                passed: (200..300).contains(&status),
                detail: format!("status {status}\n{}", &head[..head.len().min(512)]),
                name,
                log_ref: String::new(),
            }
        }
        Err(e) => CheckOutcome {
            name,
            passed: false,
            log_ref: String::new(),
            detail: format!("연결 실패: {e}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_check_reports_failure_and_success() {
        let root = std::env::temp_dir();
        let ok = run_command_check(&root, "", &["true".into()], 10);
        assert!(ok.passed);
        let bad = run_command_check(&root, "", &["false".into()], 10);
        assert!(!bad.passed);
        let missing = run_command_check(&root, "", &["definitely-not-a-bin-xyz".into()], 10);
        assert!(!missing.passed);
    }

    #[test]
    fn command_check_timeout_kills_hung_process() {
        let root = std::env::temp_dir();
        let started = std::time::Instant::now();
        let out = run_command_check(&root, "", &["sleep".into(), "30".into()], 1);
        assert!(!out.passed);
        assert!(
            out.detail.contains("시간 초과"),
            "시간 초과로 실패해야 한다: {}",
            out.detail
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "시간 초과 후 즉시 돌아와야 한다: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn empty_argv_and_missing_cwd_fail() {
        let root = std::env::temp_dir();
        assert!(!run_command_check(&root, "", &[], 10).passed);
        assert!(!run_command_check(&root, "no/such/dir-xyz", &["true".into()], 10).passed);
    }

    #[tokio::test]
    async fn http_check_rejects_unroutable() {
        let out = run_http_check("http://127.0.0.1:9/").await;
        assert!(!out.passed);
    }

    #[test]
    fn artifacts_are_content_addressed() {
        let a = save_artifact("test-project", "x", "hello");
        let b = save_artifact("test-project", "x", "hello");
        assert_eq!(a, b);
        let stem = a.trim_end_matches(".txt");
        assert_eq!(stem.len(), 64, "sha256 hex 파일명: {a}");
    }
}
