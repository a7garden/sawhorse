// Agent run driver boundary (design lines 153-157).
//
// The session model first defines AgentDriver(start, status, cancel, reattach, collect_result);
// phase-1 managed parallel execution is limited to the Claude headless/herdr lane. Codex supports only
// detection and manual inbox submission, and until a driver exists the app must not display itself as
// guaranteeing start, cancel, or reattach.

use super::model::AgentRun;
use crate::jobs::{CollabLaneSpec, JobManager, JobRequest};
use std::sync::Arc;

pub trait AgentDriver: Send + Sync {
    /// Driver identifier. Recorded in agent_run.driver.
    fn id(&self) -> &'static str;
    /// Human-readable description of the guarantee level. The UI shows it verbatim (design line 856).
    fn guarantee(&self) -> &'static str;
    /// Start the lane. On success, returns the related job ID.
    fn start(&self, run: &AgentRun, lane: CollabLaneSpec) -> Result<String, String>;
    /// Run status: pending | running | done | failed | cancelled | manual
    fn status(&self, run: &AgentRun) -> Result<String, String>;
    fn cancel(&self, run: &AgentRun) -> Result<(), String>;
    /// Reattach to a run that survived an app restart. True if attached.
    fn reattach(&self, run: &AgentRun) -> Result<bool, String>;
    /// Path to the run result report. None if not available yet.
    fn collect_result(&self, run: &AgentRun) -> Result<Option<String>, String>;
}

/// Managed Claude lane. Reuses the existing JobManager (headless/herdr) as-is —
/// queue, log, report, and reattach rules stay identical to regular jobs (design lines 837-840).
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
        let _ = run; // the service updates the run state from job events
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
        // cancel is asynchronous. Lane cancellation is not latency-critical, so instead of blocking here
        // let the service call it from the tokio runtime — this method handles that via try_current.
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

/// Manual Codex driver. Does not guarantee start or cancel (design lines 156-157).
/// Supports only the agent writing candidate files to the inbox itself, and the UI displays this fact verbatim.
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

    /// Checks only the Codex driver's contract, without a JobManager.
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
