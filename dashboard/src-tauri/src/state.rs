// App-scoped persistent state: app data dir, job history, scheduler bookkeeping.

use std::collections::HashMap;
use std::path::PathBuf;
use parking_lot::Mutex;

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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissedEntry {
    /// "<routine>-<date>"
    pub key: String,
    pub routine: String,
    pub date: String,
    pub scheduled_at: String,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub state: Mutex<PersistedState>,
    pub jobs: Mutex<Vec<Job>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        std::fs::create_dir_all(data_dir.join("logs")).ok();
        std::fs::create_dir_all(data_dir.join("reports")).ok();
        let state = Self::load_state(&data_dir);
        let jobs = Self::load_jobs(&data_dir);
        Self {
            data_dir,
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

    fn load_jobs(data_dir: &PathBuf) -> Vec<Job> {
        match std::fs::read_to_string(Self::jobs_path(data_dir)) {
            Ok(s) => s
                .lines()
                .filter_map(|l| serde_json::from_str::<Job>(l).ok())
                .collect(),
            Err(_) => Vec::new(),
        }
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

    /// Jobs still marked running after a restart are actually dead.
    pub fn mark_stale_interrupted(&self) {
        let mut jobs = self.jobs.lock();
        for j in jobs.iter_mut() {
            if j.status == crate::jobs::JobStatus::Running
                || j.status == crate::jobs::JobStatus::Queued
            {
                j.status = crate::jobs::JobStatus::Interrupted;
                j.error = Some("앱 재시작으로 중단됨".into());
            }
        }
    }

    pub fn log_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("logs").join(format!("{id}.jsonl"))
    }

    pub fn report_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("reports").join(format!("{id}.md"))
    }
}
