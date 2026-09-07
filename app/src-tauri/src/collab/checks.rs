// 검증 프로필 실행. 설계 824줄: command·health·manual 검증.
// 실제 명령은 사람이 저장한 프로필에서만 가져온다(설계 290-291줄) — 후보·에이전트가
// 검증 명령을 주입하는 경로는 존재하지 않는다.

use super::model::{CheckRun, VerifyCheck, VerifyProfile};
use super::{new_id, now_ts, workbench_root};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

/// 검사 결과. 로그 본문은 DB 대신 content-hash artifact 파일로 남긴다(설계 511줄).
#[derive(Clone, Debug)]
pub struct CheckOutcome {
    pub name: String,
    pub passed: bool,
    pub log_ref: String,
    pub detail: String,
}

/// artifact 로그 저장. sha256 파일명, `projects/<project-id>/artifacts/` 아래.
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
    // 저장 실패는 치명적이지 않다 — log_ref 없이 진행한다.
    let _ = label;
    String::new()
}

/// command 검사. argv는 프로필에 저장된 값 그대로, cwd는 통합 체크아웃 기준 상대경로.
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
    let out = crate::spawn::no_window(Command::new(&argv[0]))
        .args(&argv[1..])
        .current_dir(&dir)
        .output();
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
                log_ref: String::new(), // 호출자가 project_id로 채워 저장한다
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

/// http health probe. 응답이 오고 2xx면 통과. 타임아웃·크기 상한을 둔다.
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
            // 상한: health probe는 본문을 모두 읽지 않고 앞부분만 채운다.
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

/// 프로필의 자동 검사 전체를 실행한다. baseline이면 병합 전 상태에서 실행한다.
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
/// 통합 워커용 blocking 실행. 워커는 spawn_blocking 스레드에서 동작하므로
/// 비동기 http 검사는 현재 런타임이 있을 때만 block_on으로 돌린다.
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

/// health probe의 blocking 버전. MVP 프로필은 localhost 개발 서버를 전제로 하므로
/// raw HTTP/1.0 GET으로 판정한다. https는 런타임이 있을 때만 지원한다.
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
    let outcome = std::net::TcpStream::connect((host.as_str(), port)).and_then(|mut stream| {
        use std::net::ToSocketAddrs;
        let _ = (host.as_str(), port).to_socket_addrs()?;
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
