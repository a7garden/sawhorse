// Scheduled-run executor. It runs the **schedulable actions declared by active packs**, not three
// hardcoded routines. Missed schedules are never auto-compensated — a notification card is shown
// and user confirmation awaited (product decision).
//
// `decide()` stays a pure function: sibling work (agent-created schedules) will add more entries
// to the same function, so the decision rules must remain in one place.
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveTime, Timelike, Weekday};
use std::sync::Arc;

use serde_json::json;

use crate::config;
use crate::jobs::{JobManager, JobRequest};
use crate::packs::{self, ScheduledEntry};
use crate::state::{AppState, MissedEntry};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Decision {
    Run,
    Missed,
    Idle,
}

pub const GRACE: Duration = Duration::minutes(2);

/// Pure decision used by the tick. `last_run` is the YYYY-MM-DD of the last run.
pub fn decide(
    now: DateTime<Local>,
    sched: NaiveTime,
    enabled: bool,
    last_run: Option<&str>,
    today: &str,
    booted_at: DateTime<Local>,
) -> Decision {
    if !enabled {
        return Decision::Idle;
    }
    if last_run == Some(today) {
        return Decision::Idle;
    }
    let target = now.date_naive().and_time(sched);
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

/// `weekdays` schedules are not due at all on weekends — filtered out up front, without touching `decide()`.
pub fn due_today(kind: &str, now: DateTime<Local>) -> bool {
    kind != "weekdays" || !matches!(now.weekday(), Weekday::Sat | Weekday::Sun)
}

fn due_on_day(entry: &ScheduledEntry, now: DateTime<Local>) -> bool {
    due_today(&entry.kind, now)
        && (entry.kind != "weekly" || entry.days.contains(&now.weekday().num_days_from_monday()))
}

/// The three pre-pack-era routines. A safety net kept so scheduling does not silently stop in
/// environments that cannot read the pack registry (plugin root not found).
pub const LEGACY_ROUTINES: [&str; 3] = ["morning", "lunch", "evening"];

/// The pack_id of host built-in task entries. A marker distinguishing them from pack-declared
/// schedules — entries carrying this value take their schedule truth from the task definition
/// file, not config.
pub const TASKS_PACK_ID: &str = "tasks";

fn legacy_entries(view: &config::ConfigView) -> Vec<ScheduledEntry> {
    LEGACY_ROUTINES
        .iter()
        .map(|r| {
            let s = match *r {
                "morning" => &view.dashboard.schedules.morning,
                "lunch" => &view.dashboard.schedules.lunch,
                _ => &view.dashboard.schedules.evening,
            };
            ScheduledEntry {
                key: (*r).to_string(),
                pack_id: String::new(),
                action_id: (*r).to_string(),
                label: (*r).to_string(),
                kind: "daily".into(),
                time: s.time.clone(),
                enabled: s.enabled,
                date: None,
                days: vec![],
            }
        })
        .collect()
}

/// Host built-in tasks (human-approved agent schedules) shaped like pack entries.
fn tasks_entries() -> Vec<ScheduledEntry> {
    let root = crate::tasks::workbench_root();
    crate::tasks::list_tasks(&root)
        .into_iter()
        .filter_map(|t| {
            let s = t.schedule?;
            NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
            let kind = match s.kind {
                crate::tasks::ScheduleKind::Daily => "daily",
                crate::tasks::ScheduleKind::Weekdays => "weekdays",
                crate::tasks::ScheduleKind::Weekly => "weekly",
                crate::tasks::ScheduleKind::Once => "once",
            };
            Some(ScheduledEntry {
                key: t.id.clone(),
                pack_id: TASKS_PACK_ID.into(),
                action_id: t.id,
                label: t.title,
                kind: kind.into(),
                time: s.time,
                enabled: t.enabled,
                date: s.date,
                days: s.days,
            })
        })
        .collect()
}

/// The schedule list this tick examines.
pub fn entries(view: &config::ConfigView) -> Vec<ScheduledEntry> {
    let reg = packs::load_registry(&view.packs.enabled);
    let from_packs = packs::scheduled_entries(&reg, view);
    let all = if from_packs.is_empty() {
        legacy_entries(view)
    } else {
        from_packs
    };
    let saved = crate::tasks::list_tasks(&crate::tasks::workbench_root());
    // Even an override with no schedule must suppress the pack's default schedule.
    let saved_entries = tasks_entries()
        .into_iter()
        .filter(|entry| {
            let Some(action) = saved
                .iter()
                .find(|task| task.id == entry.key)
                .and_then(|task| task.action.as_ref())
            else {
                return true;
            };
            if action.id == "core.promote" || LEGACY_ROUTINES.contains(&action.id.as_str()) {
                return true;
            }
            action.id.split_once('.').is_some_and(|(pack, action)| {
                reg.enabled().any(|p| p.manifest.id == pack) && reg.action(pack, action).is_some()
            })
        })
        .collect();
    apply_saved_entries(all, &saved, saved_entries)
}

fn apply_saved_entries(
    mut all: Vec<ScheduledEntry>,
    saved: &[crate::tasks::TaskDef],
    entries: Vec<ScheduledEntry>,
) -> Vec<ScheduledEntry> {
    all.retain(|entry| !saved.iter().any(|task| task.id == entry.key));
    all.extend(entries);
    all
}

/// One schedule as a job request. Pack actions become `action` jobs; safety-net entries become the legacy `routine` job.
fn request_for(entry: &ScheduledEntry) -> JobRequest {
    if entry.pack_id == TASKS_PACK_ID {
        if let Ok(task) = crate::tasks::get_task(&crate::tasks::workbench_root(), &entry.action_id)
        {
            return request_for_task(&task);
        }
        // Host built-in task — runs the prompt from the task definition file as is.
        JobRequest {
            kind: "task".into(),
            task_id: Some(entry.action_id.clone()),
            ..Default::default()
        }
    } else if entry.pack_id.is_empty() {
        JobRequest {
            kind: "routine".into(),
            routine: Some(entry.action_id.clone()),
            ..Default::default()
        }
    } else {
        JobRequest {
            kind: "action".into(),
            pack_id: Some(entry.pack_id.clone()),
            action_id: Some(entry.action_id.clone()),
            ..Default::default()
        }
    }
}

/// `once` schedule decision. Runs exactly once on the given date; once run on that date, it is done.
fn decide_once(
    now: DateTime<Local>,
    entry: &ScheduledEntry,
    time: NaiveTime,
    last_run: Option<&str>,
    booted_at: DateTime<Local>,
) -> Decision {
    if !entry.enabled {
        return Decision::Idle;
    }
    let Some(date) = &entry.date else {
        return Decision::Idle;
    };
    let Ok(target_date) = NaiveDate::parse_from_str(date, "%Y-%m-%d") else {
        return Decision::Idle;
    };
    if last_run == Some(date.as_str()) {
        return Decision::Idle;
    }
    let target = target_date.and_time(time);
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

/// The old state.json carries `last_run["morning"]`. When the canonical key is absent, look at that
/// key — it prevents the morning routine from running twice on the day of the upgrade.
fn last_run_of(state: &AppState, entry: &ScheduledEntry) -> Option<String> {
    let st = state.state.lock();
    st.last_run
        .get(&entry.key)
        .or_else(|| st.last_run.get(&entry.action_id))
        .cloned()
}

fn mark_ran(state: &AppState, entry: &ScheduledEntry, today: &str) {
    {
        let mut st = state.state.lock();
        st.last_run.insert(entry.key.clone(), today.to_string());
        st.missed
            .retain(|m| !(m.routine == entry.key && m.date == today));
    }
    if entry.kind == "once" && entry.pack_id == TASKS_PACK_ID {
        // One-shot tasks switch themselves off after firing — so the same card does not reappear the next day.
        let _ = crate::tasks::set_enabled(&crate::tasks::workbench_root(), &entry.action_id, false);
    }
}

/// One scheduler pass. Runs every 20s from `start_tick`; also directly callable
/// right after boot.
pub fn tick_once(
    mgr: &JobManager,
    state: &AppState,
    emit: &crate::jobs::EmitFn,
    booted_at: DateTime<Local>,
) {
    if !crate::upgrade::ready() {
        return;
    }
    let tasks_root = crate::tasks::workbench_root();
    let _ = crate::tasks::ensure_dirs(&tasks_root);
    crate::tasks::process_inbox(&tasks_root, &Local::now().format("%Y-%m-%d").to_string());

    let view = config::load_view();
    if view.vault_path.is_empty() {
        return;
    }
    let now = Local::now();
    let today = now.format("%Y-%m-%d").to_string();
    let mut changed = false;
    let mut missed_events: Vec<MissedEntry> = Vec::new();

    for entry in entries(&view) {
        let Ok(time) = NaiveTime::parse_from_str(&entry.time, "%H:%M") else {
            continue;
        };
        let last = last_run_of(state, &entry);
        if entry.kind == "once" {
            match decide_once(now, &entry, time, last.as_deref(), booted_at) {
                Decision::Idle => {}
                Decision::Run => {
                    if mgr.enqueue(request_for(&entry)).is_ok() {
                        mark_ran(state, &entry, &today);
                        changed = true;
                    }
                }
                Decision::Missed => {
                    let key = format!("{}-{today}", entry.key);
                    let mut st = state.state.lock();
                    if !st.missed.iter().any(|m| m.key == key) {
                        let e = MissedEntry {
                            key,
                            routine: entry.key.clone(),
                            label: entry.label.clone(),
                            date: today.clone(),
                            scheduled_at: format!("{:02}:{:02}", time.hour(), time.minute()),
                        };
                        st.missed.push(e.clone());
                        missed_events.push(e);
                        changed = true;
                    }
                }
            }
            continue;
        }
        if !due_on_day(&entry, now) {
            continue;
        }
        match decide(now, time, entry.enabled, last.as_deref(), &today, booted_at) {
            Decision::Idle => {}
            Decision::Run => {
                if mgr.enqueue(request_for(&entry)).is_ok() {
                    mark_ran(state, &entry, &today);
                    changed = true;
                }
            }
            Decision::Missed => {
                let key = format!("{}-{today}", entry.key);
                let mut st = state.state.lock();
                if !st.missed.iter().any(|m| m.key == key) {
                    let e = MissedEntry {
                        key,
                        routine: entry.key.clone(),
                        label: entry.label.clone(),
                        date: today.clone(),
                        scheduled_at: format!("{:02}:{:02}", time.hour(), time.minute()),
                    };
                    st.missed.push(e.clone());
                    missed_events.push(e);
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

fn enqueue_entry(
    mgr: &JobManager,
    state: &AppState,
    entry: &ScheduledEntry,
) -> Result<crate::jobs::Job, String> {
    let job = mgr.enqueue(request_for(entry))?;
    let today = Local::now().format("%Y-%m-%d").to_string();
    mark_ran(state, entry, &today);
    state.save_state();
    Ok(job)
}

/// Runs now by schedule key (`si.morning`) or legacy routine name (`morning`).
pub fn run_scheduled_now(
    mgr: &JobManager,
    state: &AppState,
    key: &str,
) -> Result<crate::jobs::Job, String> {
    let view = config::load_view();
    let list = entries(&view);
    if let Some(entry) = list.iter().find(|e| e.key == key || e.action_id == key) {
        return enqueue_entry(mgr, state, entry);
    }
    if let Ok(request) = manual_task_request(&crate::tasks::workbench_root(), key) {
        let job = mgr.enqueue(request)?;
        state
            .state
            .lock()
            .last_run
            .insert(key.into(), Local::now().format("%Y-%m-%d").to_string());
        state.save_state();
        return Ok(job);
    }
    if LEGACY_ROUTINES.contains(&key) {
        // The tray menu must work even when packs are disabled
        return mgr.enqueue(JobRequest {
            kind: "routine".into(),
            routine: Some(key.into()),
            ..Default::default()
        });
    }
    Err(format!("알 수 없는 예약: {key}"))
}

/// The job request that "run now" with this key would create. Used by the UI to compute the
/// dedup key — it must look up in the same order as `run_scheduled_now` or button state and
/// actual execution drift apart.
pub fn request_for_key(key: &str) -> Option<JobRequest> {
    let view = config::load_view();
    if let Some(entry) = entries(&view)
        .iter()
        .find(|e| e.key == key || e.action_id == key)
    {
        return Some(request_for(entry));
    }
    if let Ok(request) = manual_task_request(&crate::tasks::workbench_root(), key) {
        return Some(request);
    }
    LEGACY_ROUTINES.contains(&key).then(|| JobRequest {
        kind: "routine".into(),
        routine: Some(key.into()),
        ..Default::default()
    })
}

fn manual_task_request(root: &std::path::Path, id: &str) -> Result<JobRequest, String> {
    Ok(request_for_task(&crate::tasks::get_task(root, id)?))
}

pub fn request_for_task(task: &crate::tasks::TaskDef) -> JobRequest {
    if let Some(action) = &task.action {
        let mut request = JobRequest {
            project: task.project.clone(),
            params: action.params.clone(),
            ..Default::default()
        };
        if action.id == "core.promote" {
            request.kind = "promote".into();
        } else if LEGACY_ROUTINES.contains(&action.id.as_str()) {
            request.kind = "routine".into();
            request.routine = Some(action.id.clone());
        } else if let Some((pack, action)) = action.id.split_once('.') {
            request.kind = "action".into();
            request.pack_id = Some(pack.into());
            request.action_id = Some(action.into());
        }
        return request;
    }
    JobRequest {
        kind: "task".into(),
        task_id: Some(task.id.clone()),
        ..Default::default()
    }
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
        st.missed
            .iter()
            .find(|m| m.key == key)
            .map(|m| (m.routine.clone(), m.date.clone()))
    };
    let Some((entry_key, date)) = found else {
        return Err("해당 알림이 없습니다".into());
    };
    if run {
        // enqueue BEFORE mutating state so a failed enqueue leaves the card intact
        run_scheduled_now(mgr, state, &entry_key)?;
        let mut st = state.state.lock();
        st.missed
            .retain(|m| !(m.routine == entry_key && m.date == date));
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

/// Schedule status shown by the settings and home screens.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleView {
    pub key: String,
    pub pack_id: String,
    pub action_id: String,
    pub label: String,
    pub kind: String,
    pub time: String,
    pub enabled: bool,
    pub last_run: Option<String>,
    /// Dedup key of the job a "run now" would create — the UI uses it to find the "running" button.
    pub job_key: String,
}

/// Whether the settings-screen schedule editor can actually change this entry.
///
/// Host built-in tasks take their schedule truth from the task definition file, while the
/// settings' `set_schedule` writes only config — listed together they would become dead
/// switches that do nothing when toggled. The schedule page handles those separately via
/// `set_task_enabled` and `save_task`.
fn editable_in_settings(entry: &ScheduledEntry) -> bool {
    entry.pack_id != TASKS_PACK_ID
}

/// Schedule list for the settings screen. Entries the editor cannot touch are not exported at all.
pub fn list_schedules(state: &AppState) -> Vec<ScheduleView> {
    let view = config::load_view();
    entries(&view)
        .into_iter()
        .filter(editable_in_settings)
        .map(|e| ScheduleView {
            last_run: last_run_of(state, &e),
            job_key: crate::jobs::dedup_key(&request_for(&e)),
            key: e.key,
            pack_id: e.pack_id,
            action_id: e.action_id,
            label: e.label,
            kind: e.kind,
            time: e.time,
            enabled: e.enabled,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    fn sched(h: u32, mi: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, mi, 0).unwrap()
    }

    #[test]
    fn manual_task_can_run_without_a_schedule() {
        let root = std::env::temp_dir().join(format!("sawhorse-manual-{}", uuid::Uuid::new_v4()));
        let def = crate::tasks::TaskDef {
            id: "manual-task".into(),
            title: "Summarize".into(),
            prompt: "Summarize notes".into(),
            ..Default::default()
        };
        crate::tasks::save_task(&root, &def).unwrap();
        let request = manual_task_request(&root, &def.id).unwrap();
        assert_eq!(request.kind, "task");
        assert_eq!(request.task_id.as_deref(), Some("manual-task"));
        assert!(manual_task_request(&root, "missing").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn run_when_time_passes_while_app_open() {
        let booted = at(2026, 9, 4, 8, 0);
        let now = at(2026, 9, 4, 9, 0); // 1min after target
        assert_eq!(
            decide(now, sched(8, 59), true, None, "2026-09-04", booted),
            Decision::Run
        );
    }

    #[test]
    fn missed_when_booted_well_past_time() {
        let booted = at(2026, 9, 4, 14, 0);
        let now = at(2026, 9, 4, 14, 0);
        assert_eq!(
            decide(now, sched(9, 0), true, None, "2026-09-04", booted),
            Decision::Missed
        );
    }

    #[test]
    fn idle_before_time_and_after_run_and_disabled() {
        let booted = at(2026, 9, 4, 8, 0);
        let now = at(2026, 9, 4, 8, 30);
        assert_eq!(
            decide(now, sched(9, 0), true, None, "2026-09-04", booted),
            Decision::Idle
        );

        // already ran today
        let now2 = at(2026, 9, 4, 10, 0);
        assert_eq!(
            decide(
                now2,
                sched(9, 0),
                true,
                Some("2026-09-04"),
                "2026-09-04",
                booted
            ),
            Decision::Idle
        );

        // disabled
        assert_eq!(
            decide(now2, sched(9, 0), false, None, "2026-09-04", booted),
            Decision::Idle
        );
    }

    #[test]
    fn grace_window_still_runs_after_boot() {
        // app started 1 minute after the scheduled time → within grace → run
        let booted = at(2026, 9, 4, 9, 1);
        let now = at(2026, 9, 4, 9, 2);
        assert_eq!(
            decide(now, sched(9, 0), true, None, "2026-09-04", booted),
            Decision::Run
        );
        // 10 minutes late → missed
        let booted2 = at(2026, 9, 4, 9, 10);
        let now2 = at(2026, 9, 4, 9, 11);
        assert_eq!(
            decide(now2, sched(9, 0), true, None, "2026-09-04", booted2),
            Decision::Missed
        );
    }

    #[test]
    fn weekdays_entries_skip_the_weekend() {
        let saturday = at(2026, 9, 5, 10, 0);
        assert_eq!(saturday.weekday(), Weekday::Sat);
        assert!(!due_today("weekdays", saturday));
        assert!(due_today("daily", saturday));
        let monday = at(2026, 9, 7, 10, 0);
        assert!(due_today("weekdays", monday) && due_today("daily", monday));
    }

    #[test]
    fn legacy_entries_used_when_no_pack_declares_a_schedule() {
        let view = config::view(
            &serde_json::json!({"vaultPath": "/v",
                                "dashboard": {"schedules": {"lunch": {"enabled": false, "time": "13:00"}}}}),
            true,
        );
        let list = legacy_entries(&view);
        assert_eq!(list.len(), 3);
        let lunch = list.iter().find(|e| e.key == "lunch").unwrap();
        assert_eq!(lunch.time, "13:00");
        assert!(!lunch.enabled);
        // Safety-net entries create the legacy routine job
        assert_eq!(request_for(lunch).kind, "routine");
        assert_eq!(request_for(lunch).routine.as_deref(), Some("lunch"));
    }

    #[test]
    fn pack_entries_produce_action_jobs() {
        let entry = ScheduledEntry {
            key: "journal.morning".into(),
            pack_id: "journal".into(),
            action_id: "morning".into(),
            label: "아침".into(),
            kind: "daily".into(),
            time: "09:00".into(),
            enabled: true,
            date: None,
            days: vec![],
        };
        let req = request_for(&entry);
        assert_eq!(req.kind, "action");
        assert_eq!(req.pack_id.as_deref(), Some("journal"));
        assert_eq!(req.action_id.as_deref(), Some("morning"));
    }

    fn entry(pack_id: &str, key: &str) -> ScheduledEntry {
        ScheduledEntry {
            key: key.into(),
            pack_id: pack_id.into(),
            action_id: key.into(),
            label: key.into(),
            kind: "daily".into(),
            time: "09:00".into(),
            enabled: true,
            date: None,
            days: vec![],
        }
    }

    /// The scheduler runs built-in tasks too, but the settings screen cannot edit them.
    /// If they leaked into the list, users would meet switches that do nothing.
    #[test]
    fn settings_list_hides_builtin_tasks() {
        assert!(editable_in_settings(&entry("journal", "journal.morning")));
        assert!(editable_in_settings(&entry("", "morning")));
        assert!(!editable_in_settings(&entry(TASKS_PACK_ID, "t-abc123")));
    }

    /// Built-in task entries must become `task` jobs running the task definition, not config.
    #[test]
    fn builtin_task_entries_produce_task_jobs() {
        let req = request_for(&entry(TASKS_PACK_ID, "t-abc123"));
        assert_eq!(req.kind, "task");
        assert_eq!(req.task_id.as_deref(), Some("t-abc123"));
    }
    #[test]
    fn selected_weekdays_use_monday_based_days() {
        let mut scheduled = entry(TASKS_PACK_ID, "weekly");
        scheduled.kind = "weekly".into();
        scheduled.days = vec![0, 2, 6];
        assert!(due_on_day(&scheduled, at(2026, 9, 7, 10, 0)));
        assert!(!due_on_day(&scheduled, at(2026, 9, 8, 10, 0)));
        assert!(due_on_day(&scheduled, at(2026, 9, 9, 10, 0)));
        assert!(due_on_day(&scheduled, at(2026, 9, 13, 10, 0)));
        scheduled.days.clear();
        assert!(!due_on_day(&scheduled, at(2026, 9, 7, 10, 0)));
    }

    #[test]
    fn saved_tool_invocation_retains_action_parameters_and_project() {
        let root = std::env::temp_dir().join(format!("sawhorse-action-{}", uuid::Uuid::new_v4()));
        let mut task = crate::tasks::TaskDef {
            id: "si.milestone".into(),
            builtin: true,
            project: Some("Demo".into()),
            action: Some(crate::tasks::TaskAction {
                id: "si.milestone".into(),
                params: serde_json::from_value(json!({"goal": "Release", "ids": ["one", "two"]}))
                    .unwrap(),
            }),
            ..Default::default()
        };
        crate::tasks::save_task(&root, &task).unwrap();
        let req = manual_task_request(&root, &task.id).unwrap();
        assert_eq!(req.kind, "action");
        assert_eq!(req.pack_id.as_deref(), Some("si"));
        assert_eq!(req.action_id.as_deref(), Some("milestone"));
        assert_eq!(req.project.as_deref(), Some("Demo"));
        assert_eq!(req.params["ids"], json!(["one", "two"]));
        task.action.as_mut().unwrap().id = "core.promote".into();
        assert_eq!(request_for_task(&task).kind, "promote");
        task.action.as_mut().unwrap().id = "morning".into();
        assert_eq!(request_for_task(&task).routine.as_deref(), Some("morning"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn saved_schedule_replaces_default_and_removal_does_not_restore_it() {
        let task = crate::tasks::TaskDef {
            id: "journal.morning".into(),
            builtin: true,
            ..Default::default()
        };
        let mut custom = entry(TASKS_PACK_ID, &task.id);
        custom.time = "11:30".into();
        let merged = apply_saved_entries(
            vec![entry("journal", &task.id)],
            &[task.clone()],
            vec![custom],
        );
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].time, "11:30");
        assert!(apply_saved_entries(vec![entry("journal", &task.id)], &[task], vec![]).is_empty());
    }
}
