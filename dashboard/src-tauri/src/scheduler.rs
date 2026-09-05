// Unified scheduler: builtin routines (morning/lunch/evening) and scheduled
// task-file entries share one tick. Never auto-runs a missed schedule — it
// queues a notification card and waits for the user to confirm (explicit
// product decision).
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Timelike};
use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use crate::config;
use crate::jobs::{JobManager, JobRequest};
use crate::state::{AppState, MissedEntry};
use crate::tasks;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Decision {
    Run,
    Missed,
    Idle,
}

pub const GRACE: Duration = Duration::minutes(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedKind {
    Daily,
    Weekdays,
    Once,
}

#[derive(Clone, Copy, Debug)]
pub struct SchedSpec {
    pub kind: SchedKind,
    pub time: NaiveTime,
    pub date: Option<NaiveDate>,
}

impl SchedSpec {
    pub fn daily(time: NaiveTime) -> Self {
        Self { kind: SchedKind::Daily, time, date: None }
    }
}

/// Pure decision used by the tick. `last_run` is the YYYY-MM-DD of the last run.
pub fn decide(
    now: DateTime<Local>,
    spec: &SchedSpec,
    enabled: bool,
    last_run: Option<&str>,
    today: &str,
    booted_at: DateTime<Local>,
) -> Decision {
    if !enabled {
        return Decision::Idle;
    }
    if spec.date.is_none() && last_run == Some(today) {
        return Decision::Idle;
    }
    if let Some(date) = spec.date {
        if spec.kind == SchedKind::Once && last_run == Some(date.format("%Y-%m-%d").to_string().as_str()) {
            return Decision::Idle;
        }
    }
    if spec.kind == SchedKind::Weekdays {
        let wd = now.weekday();
        if wd == chrono::Weekday::Sat || wd == chrono::Weekday::Sun {
            return Decision::Idle;
        }
    }
    let target_day = spec.date.unwrap_or_else(|| now.date_naive());
    let target = target_day.and_time(spec.time);
    let now_naive = now.naive_local();
    if now_naive < target {
        return Decision::Idle;
    }
    let overdue = now_naive - target;
    let passed_before_boot = target <= booted_at.naive_local();
    if passed_before_boot && overdue > GRACE {
        Decision::Missed
    } else {
        Decision::Run
    }
}

pub const ROUTINE_IDS: [&str; 3] = ["morning", "lunch", "evening"];

/// One schedulable entry: either a builtin routine or a task file with a schedule.
pub struct SchedEntry {
    pub id: String,
    pub title: String,
    pub spec: SchedSpec,
    pub enabled: bool,
    pub builtin: bool,
    pub project: Option<String>,
}

fn builtin_title(id: &str) -> &'static str {
    match id {
        "morning" => "아침 브리핑",
        "lunch" => "오전 결산",
        _ => "퇴근 정산",
    }
}

/// Task-file schedule -> spec. Unparseable files are skipped, never guessed.
fn parse_spec(s: &tasks::Schedule) -> Option<SchedSpec> {
    let time = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
    let date = s.date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let kind = match s.kind {
        tasks::ScheduleKind::Daily => SchedKind::Daily,
        tasks::ScheduleKind::Weekdays => SchedKind::Weekdays,
        tasks::ScheduleKind::Once => SchedKind::Once,
    };
    Some(SchedSpec { kind, time, date })
}

/// Builtin routines from the config plus every task file that carries a
/// schedule. Disabled entries stay listed — `decide` keeps them Idle.
fn collect_entries(scheds: &config::Schedules, root: &Path) -> Vec<SchedEntry> {
    let mut out = Vec::new();
    for id in ROUTINE_IDS {
        let s = match id {
            "morning" => &scheds.morning,
            "lunch" => &scheds.lunch,
            _ => &scheds.evening,
        };
        let Ok(time) = NaiveTime::parse_from_str(&s.time, "%H:%M") else { continue };
        out.push(SchedEntry {
            id: id.into(),
            title: builtin_title(id).into(),
            spec: SchedSpec::daily(time),
            enabled: s.enabled,
            builtin: true,
            project: None,
        });
    }
    for def in tasks::list_tasks(root) {
        let Some(s) = &def.schedule else { continue };
        let Some(spec) = parse_spec(s) else { continue };
        out.push(SchedEntry {
            id: def.id,
            title: def.title,
            spec,
            enabled: def.enabled,
            builtin: false,
            project: def.project,
        });
    }
    out
}

fn req_for(e: &SchedEntry) -> JobRequest {
    if e.builtin {
        JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some(e.id.clone()) }
    } else {
        // Task 5 adds `task_id` to JobRequest; until then build_job rejects a
        // kind:"task" request, so the tick retries with state untouched.
        JobRequest { kind: "task".into(), project: e.project.clone(), ids: None, routine: None }
    }
}

/// Record today's run for `id` and drop today's missed card for it.
fn mark_ran(state: &AppState, id: &str, today: &str) {
    // scope the guard: save_state re-locks state.state, and parking_lot
    // Mutex is non-reentrant — saving under the guard would deadlock
    {
        let mut st = state.state.lock();
        st.last_run.insert(id.into(), today.into());
        st.missed.retain(|m| !(m.task_id == id && m.date == today));
    }
    state.save_state();
}

/// After a successful run: a one-shot task file never refires.
fn disable_finished_once(root: &Path, id: &str) {
    let Ok(mut def) = tasks::get_task(root, id) else { return };
    let is_once = def.schedule.as_ref().map(|s| s.kind == tasks::ScheduleKind::Once).unwrap_or(false);
    if is_once && def.enabled {
        def.enabled = false;
        def.updated_at = tasks::now_iso();
        let _ = tasks::save_task(root, &def);
    }
}

/// One scheduler pass. Runs every 20s from `start_tick`; also directly callable
/// right after boot. Drains the agent inbox first, then walks builtin + task
/// entries through one decide loop.
pub fn tick_once(mgr: &JobManager, state: &AppState, emit: &crate::jobs::EmitFn, booted_at: DateTime<Local>) {
    let view = config::load_view();
    let root = tasks::workbench_root();
    let _ = tasks::ensure_dirs(&root);
    let today = Local::now().format("%Y-%m-%d").to_string();
    tasks::process_inbox(&root, &today);
    if view.vault_path.is_empty() {
        return;
    }
    let now = Local::now();
    let mut missed_events: Vec<MissedEntry> = Vec::new();

    for e in collect_entries(&view.dashboard.schedules, &root) {
        let last = state.state.lock().last_run.get(&e.id).cloned();
        match decide(now, &e.spec, e.enabled, last.as_deref(), &today, booted_at) {
            Decision::Idle => {}
            Decision::Run => {
                // state moves only when the enqueue actually took the job
                if mgr.enqueue(req_for(&e)).is_ok() {
                    mark_ran(state, &e.id, &today);
                    if !e.builtin {
                        disable_finished_once(&root, &e.id);
                    }
                }
            }
            Decision::Missed => {
                let key = format!("{}-{}", e.id, today);
                let mut st = state.state.lock();
                if !st.missed.iter().any(|m| m.key == key) {
                    let entry = MissedEntry {
                        key,
                        task_id: e.id.clone(),
                        title: e.title.clone(),
                        date: today.clone(),
                        scheduled_at: format!("{:02}:{:02}", e.spec.time.hour(), e.spec.time.minute()),
                    };
                    st.missed.push(entry.clone());
                    missed_events.push(entry);
                }
            }
        }
    }

    if !missed_events.is_empty() {
        state.save_state();
    }
    for m in missed_events {
        emit("schedule-missed", &json!({"missed": m}));
    }
}

pub fn start_tick(mgr: Arc<JobManager>, state: Arc<AppState>, emit: crate::jobs::EmitFn) {
    let booted = Local::now();
    tauri::async_runtime::spawn(async move {
        loop {
            tick_once(&mgr, &state, &emit, booted);
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        }
    });
}

/// Manual run from the UI (missed card button / task card button). Builtin ids
/// take the routine path; everything else loads the task file and enqueues a
/// task job. Counts as today's run and clears today's missed card. State moves
/// only after the enqueue succeeds; a successful one-shot disables itself.
pub fn run_task_now(mgr: &JobManager, state: &AppState, id: &str) -> Result<crate::jobs::Job, String> {
    let root = tasks::workbench_root();
    let today = Local::now().format("%Y-%m-%d").to_string();
    let req = if ROUTINE_IDS.contains(&id) {
        JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some(id.into()) }
    } else {
        let def = tasks::get_task(&root, id)?;
        JobRequest { kind: "task".into(), project: def.project.clone(), ids: None, routine: None }
    };
    // enqueue BEFORE mutating state so a failed enqueue leaves state untouched
    let job = mgr.enqueue(req)?;
    mark_ran(state, id, &today);
    disable_finished_once(&root, id);
    Ok(job)
}

/// Missed-card dismissal. `run=true` also enqueues the entry immediately.
pub fn dismiss_missed(
    mgr: &JobManager,
    state: &AppState,
    key: &str,
    run: bool,
) -> Result<Vec<MissedEntry>, String> {
    let found = {
        let st = state.state.lock();
        st.missed.iter().find(|m| m.key == key).cloned()
    };
    let Some(entry) = found else {
        return Err("해당 알림이 없습니다".into());
    };
    if run {
        // run_task_now enqueues first, so a failed enqueue keeps the card intact
        run_task_now(mgr, state, &entry.task_id)?;
    }
    {
        // guard dropped before save_state — see mark_ran (non-reentrant re-lock)
        let mut st = state.state.lock();
        st.missed.retain(|m| m.key != key);
    }
    state.save_state();
    Ok(state.state.lock().missed.clone())
}

pub fn list_missed(state: &AppState) -> Vec<MissedEntry> {
    state.state.lock().missed.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }
    use chrono::NaiveDate;

    fn spec(kind: SchedKind, h: u32, mi: u32) -> SchedSpec {
        SchedSpec {
            kind,
            time: NaiveTime::from_hms_opt(h, mi, 0).unwrap(),
            date: None,
        }
    }

    #[test]
    fn run_when_time_passes_while_app_open() {
        let booted = at(2026, 9, 4, 8, 0);
        let now = at(2026, 9, 4, 9, 0); // 1min after target
        assert_eq!(
            decide(now, &spec(SchedKind::Daily, 8, 59), true, None, "2026-09-04", booted),
            Decision::Run
        );
    }

    #[test]
    fn missed_when_booted_well_past_time() {
        let booted = at(2026, 9, 4, 14, 0);
        let now = at(2026, 9, 4, 14, 0);
        assert_eq!(
            decide(now, &spec(SchedKind::Daily, 9, 0), true, None, "2026-09-04", booted),
            Decision::Missed
        );
    }

    #[test]
    fn idle_before_time_and_after_run_and_disabled() {
        let booted = at(2026, 9, 4, 8, 0);
        let now = at(2026, 9, 4, 8, 30);
        assert_eq!(decide(now, &spec(SchedKind::Daily, 9, 0), true, None, "2026-09-04", booted), Decision::Idle);

        // already ran today
        let now2 = at(2026, 9, 4, 10, 0);
        assert_eq!(
            decide(now2, &spec(SchedKind::Daily, 9, 0), true, Some("2026-09-04"), "2026-09-04", booted),
            Decision::Idle
        );

        // disabled
        assert_eq!(decide(now2, &spec(SchedKind::Daily, 9, 0), false, None, "2026-09-04", booted), Decision::Idle);
    }

    #[test]
    fn grace_window_still_runs_after_boot() {
        // app started 1 minute after the scheduled time → within grace → run
        let booted = at(2026, 9, 4, 9, 1);
        let now = at(2026, 9, 4, 9, 2);
        assert_eq!(
            decide(now, &spec(SchedKind::Daily, 9, 0), true, None, "2026-09-04", booted),
            Decision::Run
        );
        // 10 minutes late → missed
        let booted2 = at(2026, 9, 4, 9, 10);
        let now2 = at(2026, 9, 4, 9, 11);
        assert_eq!(
            decide(now2, &spec(SchedKind::Daily, 9, 0), true, None, "2026-09-04", booted2),
            Decision::Missed
        );
    }

    #[test]
    fn weekdays_skips_weekend() {
        let booted = at(2026, 9, 5, 9, 2); // 2026-09-05 is Saturday
        let now = at(2026, 9, 5, 9, 2);
        assert_eq!(decide(now, &spec(SchedKind::Weekdays, 9, 0), true, None, "2026-09-05", booted), Decision::Idle);
        let mon_boot = at(2026, 9, 7, 9, 1); // Monday within grace
        let mon = at(2026, 9, 7, 9, 2);
        assert_eq!(decide(mon, &spec(SchedKind::Weekdays, 9, 0), true, None, "2026-09-07", mon_boot), Decision::Run);
    }

    #[test]
    fn once_fires_until_ran_then_stays_idle() {
        let booted = at(2026, 9, 10, 8, 0);
        let now = at(2026, 9, 10, 8, 31);
        let mut s = spec(SchedKind::Once, 8, 30);
        s.date = Some(NaiveDate::from_ymd_opt(2026, 9, 10).unwrap());
        assert_eq!(decide(now, &s, true, None, "2026-09-10", booted), Decision::Run);
        assert_eq!(decide(now, &s, true, Some("2026-09-10"), "2026-09-10", booted), Decision::Idle);
    }

    #[test]
    fn once_past_date_with_last_run_stays_idle() {
        // once dated 09-10 already ran that day; a 09-11 tick must stay Idle —
        // it must never resurface as Missed on later days.
        let booted = at(2026, 9, 11, 8, 0);
        let now = at(2026, 9, 11, 9, 11);
        let mut s = spec(SchedKind::Once, 9, 0);
        s.date = Some(NaiveDate::from_ymd_opt(2026, 9, 10).unwrap());
        assert_eq!(decide(now, &s, true, Some("2026-09-10"), "2026-09-11", booted), Decision::Idle);
    }

    #[test]
    fn collect_entries_merges_builtins_and_task_files() {
        let root = std::env::temp_dir().join(format!("sw-sched-{}", uuid::Uuid::new_v4()));
        crate::tasks::ensure_dirs(&root).unwrap();
        let scheds = config::Schedules::default(); // morning/lunch/evening defaults
        let mut t = crate::tasks::TaskDef {
            id: "t-20260905-dddd".into(), title: "주간 정리".into(), prompt: "p".into(),
            schedule: Some(crate::tasks::Schedule { kind: crate::tasks::ScheduleKind::Daily, time: "08:30".into(), date: None }),
            ..crate::tasks::TaskDef::default()
        };
        crate::tasks::save_task(&root, &t).unwrap();
        t.enabled = false; t.id = "t-20260905-eeee".into();
        crate::tasks::save_task(&root, &t).unwrap();
        let mut manual = t.clone(); manual.id = "t-20260905-ffff".into(); manual.schedule = None; manual.enabled = true;
        crate::tasks::save_task(&root, &manual).unwrap();
        let entries = collect_entries(&scheds, &root);
        assert_eq!(entries.len(), 5); // builtin 3 + scheduled tasks 2 (manual excluded)
        let by_id = |id: &str| entries.iter().find(|e| e.id == id).unwrap();
        assert!(by_id("t-20260905-dddd").enabled);
        assert!(!by_id("t-20260905-eeee").enabled); // disabled stays listed; decide keeps it Idle
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn disable_finished_once_turns_off_ran_once_task() {
        let root = std::env::temp_dir().join(format!("sw-sched-{}", uuid::Uuid::new_v4()));
        crate::tasks::ensure_dirs(&root).unwrap();
        let t = crate::tasks::TaskDef {
            id: "t-20260905-aaaa".into(), title: "마감 정리".into(), prompt: "p".into(),
            schedule: Some(crate::tasks::Schedule { kind: crate::tasks::ScheduleKind::Once, time: "23:00".into(), date: Some("2026-09-05".into()) }),
            ..crate::tasks::TaskDef::default()
        };
        crate::tasks::save_task(&root, &t).unwrap();
        disable_finished_once(&root, &t.id);
        let done = crate::tasks::get_task(&root, &t.id).unwrap();
        assert!(!done.enabled);
        assert_ne!(done.updated_at, t.updated_at);

        // daily tasks are never touched
        let mut d = t.clone();
        d.id = "t-20260905-bbbb".into();
        d.schedule = Some(crate::tasks::Schedule { kind: crate::tasks::ScheduleKind::Daily, time: "08:30".into(), date: None });
        crate::tasks::save_task(&root, &d).unwrap();
        disable_finished_once(&root, &d.id);
        assert!(crate::tasks::get_task(&root, &d.id).unwrap().enabled);

        // already-disabled once task stays untouched (no updated_at churn)
        let before = crate::tasks::get_task(&root, &t.id).unwrap();
        disable_finished_once(&root, &t.id);
        assert_eq!(crate::tasks::get_task(&root, &t.id).unwrap(), before);

        // missing task file is a silent no-op
        disable_finished_once(&root, "t-20260905-zzzz");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
