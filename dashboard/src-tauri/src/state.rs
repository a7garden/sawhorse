// App-scoped persistent state: app data dir, job history, scheduler bookkeeping.

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::jobs::Job;

#[derive(Default, Serialize, Deserialize)]
pub struct PersistedState {
    /// routine name -> last run date (YYYY-MM-DD)
    #[serde(default)]
    pub last_run: HashMap<String, String>,
    /// outstanding missed-schedule cards awaiting user decision
    #[serde(default)]
    pub missed: Vec<MissedEntry>,
    /// last exported excel output path (used as --prev for the next export)
    #[serde(default)]
    pub excel_last_out: Option<String>,
    /// herdr workspace the dashboard owns; re-created when it no longer exists
    #[serde(default)]
    pub herdr_workspace_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissedEntry {
    /// "<예약 키>-<date>"
    pub key: String,
    /// 예약 키(`si.morning`). 구형 state.json 은 루틴 이름(`morning`)을 담고 있다.
    pub routine: String,
    /// 사람이 읽는 이름. 구형 기록에는 없다.
    #[serde(default)]
    pub label: String,
    pub date: String,
    pub scheduled_at: String,
}

pub struct AppState {
    pub data_dir: PathBuf,
    /// where Claude Code keeps session transcripts; the herdr runner tails them
    pub transcript_root: PathBuf,
    pub state: Mutex<PersistedState>,
    pub jobs: Mutex<Vec<Job>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self::new_with(data_dir, crate::transcript::projects_dir())
    }

    pub fn new_with(data_dir: PathBuf, transcript_root: PathBuf) -> Self {
        std::fs::create_dir_all(data_dir.join("logs")).ok();
        std::fs::create_dir_all(data_dir.join("reports")).ok();
        let state = Self::load_state(&data_dir);
        let jobs = Self::load_jobs(&data_dir);
        Self {
            data_dir,
            transcript_root,
            state: Mutex::new(state),
            jobs: Mutex::new(jobs),
        }
    }

    fn state_path(data_dir: &PathBuf) -> PathBuf {
        data_dir.join("state.json")
    }

    fn load_state(data_dir: &PathBuf) -> PersistedState {
        match std::fs::read_to_string(Self::state_path(data_dir)) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => PersistedState::default(),
        }
    }

    pub fn save_state(&self) {
        let guard = self.state.lock();
        let path = Self::state_path(&self.data_dir);
        let tmp = path.with_extension("json.tmp");
        if let Ok(json) = serde_json::to_string_pretty(&*guard) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    fn jobs_path(data_dir: &PathBuf) -> PathBuf {
        data_dir.join("jobs.jsonl")
    }

    /// jobs.jsonl is an append-only transition log: one line per `record_job`, so
    /// a job appears once per state change. Collapse to the last record per id and
    /// restore the in-memory invariant (most recent first, capped).
    fn load_jobs(data_dir: &PathBuf) -> Vec<Job> {
        let Ok(text) = std::fs::read_to_string(Self::jobs_path(data_dir)) else {
            return Vec::new();
        };
        let mut order: Vec<String> = Vec::new();
        let mut latest: HashMap<String, Job> = HashMap::new();
        for job in text
            .lines()
            .filter_map(|l| serde_json::from_str::<Job>(l).ok())
        {
            if !latest.contains_key(&job.id) {
                order.push(job.id.clone());
            }
            latest.insert(job.id.clone(), job);
        }
        let mut jobs: Vec<Job> = order
            .iter()
            .rev()
            .filter_map(|id| latest.remove(id))
            .collect();
        jobs.truncate(200);
        jobs
    }

    /// Persist one job record and update the in-memory list (most recent first, capped).
    pub fn record_job(&self, job: &Job) {
        {
            let mut jobs = self.jobs.lock();
            if let Some(existing) = jobs.iter_mut().find(|j| j.id == job.id) {
                *existing = job.clone();
            } else {
                jobs.insert(0, job.clone());
            }
            jobs.truncate(200);
        }
        // append history line
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Self::jobs_path(&self.data_dir))
        {
            use std::io::Write;
            if let Ok(line) = serde_json::to_string(job) {
                let _ = writeln!(f, "{line}");
            }
        }
    }

    /// Jobs still marked running after a restart are actually dead — except herdr
    /// jobs, whose panes outlive the dashboard. Those are returned untouched for
    /// `JobManager::reattach_herdr` to either resume watching or lay to rest.
    pub fn mark_stale_interrupted(&self) -> Vec<Job> {
        let mut jobs = self.jobs.lock();
        let mut resumable = Vec::new();
        for j in jobs.iter_mut() {
            let stale = j.status == crate::jobs::JobStatus::Running
                || j.status == crate::jobs::JobStatus::Queued;
            if !stale {
                continue;
            }
            if j.status == crate::jobs::JobStatus::Running
                && j.runner == crate::jobs::JobRunner::Herdr
                && j.herdr_pane_id.is_some()
                && j.session_id.is_some()
            {
                resumable.push(j.clone());
                continue;
            }
            j.status = crate::jobs::JobStatus::Interrupted;
            j.error = Some("앱 재시작으로 중단됨".into());
        }
        resumable
    }

    pub fn log_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("logs").join(format!("{id}.jsonl"))
    }

    pub fn report_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("reports").join(format!("{id}.md"))
    }
}
