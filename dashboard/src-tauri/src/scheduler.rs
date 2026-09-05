// Routine scheduler: morning/lunch/evening at configured times.
// Never auto-runs a missed schedule — it queues a notification card and waits
// for the user to confirm (explicit product decision).
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Timelike};
use std::sync::Arc;

use serde_json::json;

use crate::config;
use crate::jobs::{JobManager, JobRequest};
use crate::state::{AppState, MissedEntry};

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

const ROUTINES: [&str; 3] = ["morning", "lunch", "evening"];

fn schedule_time(view: &config::ConfigView, routine: &str) -> Option<(bool, NaiveTime)> {
    let s = match routine {
        "morning" => &view.dashboard.schedules.morning,
        "lunch" => &view.dashboard.schedules.lunch,
        "evening" => &view.dashboard.schedules.evening,
        _ => return None,
    };
    let t = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
    Some((s.enabled, t))
}

/// One scheduler pass. Runs every 20s from `start_tick`; also directly callable
/// right after boot.
pub fn tick_once(mgr: &JobManager, state: &AppState, emit: &crate::jobs::EmitFn, booted_at: DateTime<Local>) {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return;
    }
    let today = Local::now().format("%Y-%m-%d").to_string();
    let now = Local::now();
    let mut changed = false;
    let mut missed_events: Vec<MissedEntry> = Vec::new();

    for routine in ROUTINES {
        let Some((enabled, time)) = schedule_time(&view, routine) else { continue };
        let last = state.state.lock().last_run.get(routine).cloned();
        let spec = SchedSpec::daily(time);
        match decide(now, &spec, enabled, last.as_deref(), &today, booted_at) {
            crate::scheduler::Decision::Idle => {}
            crate::scheduler::Decision::Run => {
                let req = JobRequest {
                    kind: "routine".into(),
                    project: None,
                    ids: None,
                    routine: Some(routine.into()),
                };
                if mgr.enqueue(req).is_ok() {
                    let mut st = state.state.lock();
                    st.last_run.insert(routine.into(), today.clone());
                    let before = st.missed.len();
                    st.missed.retain(|m| !(m.routine == routine && m.date == today));
                    changed = true;
                    if before != st.missed.len() {
                        changed = true;
                    }
                }
            }
            crate::scheduler::Decision::Missed => {
                let key = format!("{routine}-{today}");
                let mut st = state.state.lock();
                if !st.missed.iter().any(|m| m.key == key) {
                    let entry = MissedEntry {
                        key,
                        routine: routine.into(),
                        date: today.clone(),
                        scheduled_at: format!("{:02}:{:02}", time.hour(), time.minute()),
                    };
                    st.missed.push(entry.clone());
                    missed_events.push(entry);
                    changed = true;
                }
            }
        }
    }

    if changed {
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

/// Manual run from the UI (missed card button / routine card button).
/// Counts as today's run and clears today's missed card.
pub fn run_routine_now(
    mgr: &JobManager,
    state: &AppState,
    routine: &str,
) -> Result<crate::jobs::Job, String> {
    if !ROUTINES.contains(&routine) {
        return Err(format!("알 수 없는 루틴: {routine}"));
    }
    let job = mgr.enqueue(JobRequest {
        kind: "routine".into(),
        project: None,
        ids: None,
        routine: Some(routine.into()),
    })?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    {
        let mut st = state.state.lock();
        st.last_run.insert(routine.into(), today.clone());
        st.missed.retain(|m| !(m.routine == routine && m.date == today));
    }
    state.save_state();
    Ok(job)
}

/// Missed-card dismissal. `run=true` also enqueues the routine immediately.
pub fn dismiss_missed(
    mgr: &JobManager,
    state: &AppState,
    key: &str,
    run: bool,
) -> Result<Vec<MissedEntry>, String> {
    let routine_and_date = {
        let st = state.state.lock();
        st.missed
            .iter()
            .find(|m| m.key == key)
            .map(|m| (m.routine.clone(), m.date.clone()))
    };
    let Some((routine, date)) = routine_and_date else {
        return Err("해당 알림이 없습니다".into());
    };
    if run {
        // enqueue BEFORE mutating state so a failed enqueue leaves the card intact
        let today = Local::now().format("%Y-%m-%d").to_string();
        mgr.enqueue(JobRequest {
            kind: "routine".into(),
            project: None,
            ids: None,
            routine: Some(routine.clone()),
        })?;
        let mut st = state.state.lock();
        st.last_run.insert(routine.clone(), today);
        st.missed
            .retain(|m| !(m.routine == routine && m.date == date));
    } else {
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
}
