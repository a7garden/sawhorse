// 에이전트 실행 드라이버 경계(설계 153-157줄).
//
// 세션 모델은 AgentDriver(start, status, cancel, reattach, collect_result)를 먼저 정의하고,
// 1단계 관리형 병렬 실행은 Claude headless/herdr lane으로 한정한다. Codex는 감지·수동
// 인박스 제출만 지원하며, driver가 구현되기 전에는 앱이 시작·취소·재연결을 보장한다고
// 표시하지 않는다.

use super::model::AgentRun;
use crate::jobs::{CollabLaneSpec, JobManager, JobRequest};
use std::sync::Arc;

pub trait AgentDriver: Send + Sync {
    /// 드라이버 식별자. agent_run.driver에 기록된다.
    fn id(&self) -> &'static str;
    /// 사람이 볼 수 있는 보장 수준 설명. UI가 그대로 표시한다(설계 856줄).
    fn guarantee(&self) -> &'static str;
    /// 레인을 시작한다. 성공 시 관련 잡 ID를 반환한다.
    fn start(&self, run: &AgentRun, lane: CollabLaneSpec) -> Result<String, String>;
    /// 실행 상태: pending | running | done | failed | cancelled | manual
    fn status(&self, run: &AgentRun) -> Result<String, String>;
    fn cancel(&self, run: &AgentRun) -> Result<(), String>;
    /// 앱 재시작 뒤 살아 있는 실행에 다시 붙는다. 붙었으면 true.
    fn reattach(&self, run: &AgentRun) -> Result<bool, String>;
    /// 실행 결과 보고서 경로. 아직 없으면 None.
    fn collect_result(&self, run: &AgentRun) -> Result<Option<String>, String>;
}

/// 관리형 Claude lane. 기존 JobManager(headless/herdr)를 그대로 재사용한다 —
/// 큐·로그·리포트·재연결 규칙이 잡과 동일하게 유지된다(설계 837-840줄).
pub struct ClaudeManagedDriver {
    jobs: Arc<JobManager>,
}

impl ClaudeManagedDriver {
    pub fn new(jobs: Arc<JobManager>) -> Self {
        ClaudeManagedDriver { jobs }
    }
}

impl AgentDriver for ClaudeManagedDriver {
    fn id(&self) -> &'static str {
        "claude-managed"
    }

    fn guarantee(&self) -> &'static str {
        "관리형 실행 — 시작·취소·재연결을 앱이 보장한다"
    }

    fn start(&self, run: &AgentRun, lane: CollabLaneSpec) -> Result<String, String> {
        let job = self.jobs.enqueue(JobRequest {
            kind: "collab".into(),
            collab: Some(lane),
            ..Default::default()
        })?;
        let _ = run; // run의 상태는 서비스가 job 이벤트로 갱신한다
        Ok(job.id)
    }

    fn status(&self, run: &AgentRun) -> Result<String, String> {
        if run.job_id.is_empty() {
            return Ok("pending".into());
        }
        let jobs = self.jobs.state.jobs.lock();
        Ok(jobs
            .iter()
            .find(|j| j.id == run.job_id)
            .map(|j| match j.status {
                crate::jobs::JobStatus::Queued => "pending".to_string(),
                crate::jobs::JobStatus::Running => "running".to_string(),
                crate::jobs::JobStatus::Success => "done".to_string(),
                crate::jobs::JobStatus::Failed | crate::jobs::JobStatus::Interrupted => {
                    "failed".to_string()
                }
                crate::jobs::JobStatus::Cancelled => "cancelled".to_string(),
            })
            .unwrap_or_else(|| "unknown".into()))
    }

    fn cancel(&self, run: &AgentRun) -> Result<(), String> {
        if run.job_id.is_empty() {
            return Ok(());
        }
        // cancel은 비동기다. 레인 취소는 즉시성이 덜 중요하므로 여기서 block하지 않고
        // 서비스가 tokio 런타임에서 호출하도록 한다 — 이 메서드는 try_current로 처리.
        if tokio::runtime::Handle::try_current().is_ok() {
            let jobs = self.jobs.clone();
            let id = run.job_id.clone();
            tokio::spawn(async move {
                let _ = jobs.cancel(&id).await;
            });
            Ok(())
        } else {
            Err("cancel은 tokio 런타임 안에서 호출해야 한다".into())
        }
    }

    fn reattach(&self, run: &AgentRun) -> Result<bool, String> {
        if run.job_id.is_empty() {
            return Ok(false);
        }
        let jobs = self.jobs.state.jobs.lock();
        Ok(jobs
            .iter()
            .any(|j| j.id == run.job_id && !j.status.finished()))
    }

    fn collect_result(&self, run: &AgentRun) -> Result<Option<String>, String> {
        if run.job_id.is_empty() {
            return Ok(None);
        }
        let path = self.jobs.state.report_path(&run.job_id);
        Ok(path.is_file().then(|| path.to_string_lossy().to_string()))
    }
}

/// Codex 수동 드라이버. 시작·취소를 보장하지 않는다(설계 156-157줄).
/// 에이전트가 직접 인박스에 후보 파일을 쓰는 것만 지원하며 UI는 이 사실을 그대로 표시한다.
pub struct CodexManualDriver;

impl AgentDriver for CodexManualDriver {
    fn id(&self) -> &'static str {
        "codex-manual"
    }

    fn guarantee(&self) -> &'static str {
        "수동 제출 전용 — 앱이 시작·취소·재연결을 보장하지 않는다. 에이전트가 직접 인박스에 후보를 쓴다"
    }

    fn start(&self, _run: &AgentRun, _lane: CollabLaneSpec) -> Result<String, String> {
        Err("Codex 드라이버는 아직 구현되지 않았다. 에이전트가 인박스에 직접 제출해야 한다".into())
    }

    fn status(&self, _run: &AgentRun) -> Result<String, String> {
        Ok("manual".into())
    }

    fn cancel(&self, _run: &AgentRun) -> Result<(), String> {
        Err("수동 제출 레인은 앱이 취소할 수 없다".into())
    }

    fn reattach(&self, _run: &AgentRun) -> Result<bool, String> {
        Ok(false)
    }

    fn collect_result(&self, _run: &AgentRun) -> Result<Option<String>, String> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JobManager 없이 Codex 드라이버의 계약만 확인한다.
    #[test]
    fn codex_manual_never_promises_management() {
        let driver = CodexManualDriver;
        let run = AgentRun::default();
        assert!(driver.start(&run, CollabLaneSpec::default()).is_err());
        assert_eq!(driver.status(&run).unwrap(), "manual");
        assert!(!driver.reattach(&run).unwrap());
        assert_eq!(driver.collect_result(&run).unwrap(), None);
        assert!(driver.cancel(&run).is_err());
        assert!(driver.guarantee().contains("보장하지 않는다"));
    }

    #[test]
    fn driver_ids_are_stable() {
        assert_eq!(CodexManualDriver.id(), "codex-manual");
    }
}
