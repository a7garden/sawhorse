// 예약 실행기. 하드코딩된 루틴 3개가 아니라 **활성 팩이 선언한 예약 가능 액션**을 돌린다.
// 놓친 예약은 절대 자동 보상 실행하지 않는다 — 알림 카드를 띄우고 사용자 확인을 기다린다
// (제품 결정).
//
// `decide()` 는 순수 함수로 그대로 둔다: 형제 작업(에이전트가 만드는 예약)이 같은 함수에
// 엔트리를 더 넣을 예정이라, 판정 규칙은 한 곳에 남아 있어야 한다.
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

/// `weekdays` 예약은 주말에 아예 대상이 아니다 — `decide()` 를 건드리지 않고 앞에서 거른다.
pub fn due_today(kind: &str, now: DateTime<Local>) -> bool {
    kind != "weekdays" || !matches!(now.weekday(), Weekday::Sat | Weekday::Sun)
}

/// 팩 이전 시절의 루틴 3종. 팩 레지스트리를 못 읽는 환경(플러그인 루트 미발견)에서
/// 예약이 조용히 멈추지 않도록 남겨 둔 안전망이다.
pub const LEGACY_ROUTINES: [&str; 3] = ["morning", "lunch", "evening"];

/// 호스트 내장 작업 엔트리의 pack_id. 팩이 선언한 예약과 구분하는 표식이다 —
/// 이 값이 붙은 엔트리는 예약 정본이 config 가 아니라 작업 정의 파일이다.
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
            }
        })
        .collect()
}

/// 호스트 내장 작업(사람이 승인한 에이전트 예약)을 팩 엔트리와 같은 모양으로.
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
            })
        })
        .collect()
}

/// 이번 틱이 볼 예약 목록.
pub fn entries(view: &config::ConfigView) -> Vec<ScheduledEntry> {
    let reg = packs::load_registry(&view.packs.enabled);
    let from_packs = packs::scheduled_entries(&reg, view);
    let mut all = if from_packs.is_empty() {
        legacy_entries(view)
    } else {
        from_packs
    };
    all.extend(tasks_entries());
    all
}

/// 예약 하나를 잡 요청으로. 팩 액션이면 `action`, 안전망 엔트리면 예전 `routine` 잡.
fn request_for(entry: &ScheduledEntry) -> JobRequest {
    if entry.pack_id == TASKS_PACK_ID {
        // 호스트 내장 작업 — 작업 정의 파일의 프롬프트를 그대로 돌린다.
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

/// `once` 예약 판정. 지정 날짜에 단 한 번; 그 날짜에 돌렸으면 끝난다.
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

/// 예전 state.json 은 `last_run["morning"]` 을 갖고 있다. 정규 키가 없으면 그 키를 본다 —
/// 업그레이드한 날 아침 루틴이 한 번 더 도는 것을 막는다.
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
        // 1회 작업은 소화 후 조용히 꺼진다 — 다음 날 같은 카드가 다시 생기지 않게.
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
        if !due_today(&entry.kind, now) {
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

/// 예약 키(`si.morning`) 또는 예전 루틴 이름(`morning`)으로 지금 실행.
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
        // 팩이 꺼져 있어도 트레이 메뉴는 동작해야 한다
        return mgr.enqueue(JobRequest {
            kind: "routine".into(),
            routine: Some(key.into()),
            ..Default::default()
        });
    }
    Err(format!("알 수 없는 예약: {key}"))
}

/// 이 키로 "지금 실행"하면 만들어질 잡 요청. 화면이 중복 판정 키를 계산할 때 쓴다 —
/// `run_scheduled_now` 과 같은 순서로 찾아야 버튼 상태와 실제 실행이 어긋나지 않는다.
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
    crate::tasks::get_task(root, id)?;
    Ok(JobRequest {
        kind: "task".into(),
        task_id: Some(id.into()),
        ..Default::default()
    })
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

/// 설정·홈 화면이 보여주는 예약 현황.
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
    /// 지금 실행했을 때 생길 잡의 중복 판정 키 — 화면이 "실행 중" 버튼을 찾는 데 쓴다.
    pub job_key: String,
}

/// 설정 화면의 예약 편집기가 실제로 바꿀 수 있는 엔트리인가.
///
/// 호스트 내장 작업은 예약 정본이 작업 정의 파일이고, 설정이 쓰는 `set_schedule` 은
/// config 에만 쓴다 — 목록에 두면 켜고 꺼도 아무 일이 없는 먹통 스위치가 된다.
/// 그쪽은 예약 페이지가 `set_task_enabled`·`save_task` 로 따로 다룬다.
fn editable_in_settings(entry: &ScheduledEntry) -> bool {
    entry.pack_id != TASKS_PACK_ID
}

/// 설정 화면이 보여줄 예약 목록. 편집이 닿지 않는 엔트리는 애초에 내보내지 않는다.
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
        // 안전망 엔트리는 예전 routine 잡을 만든다
        assert_eq!(request_for(lunch).kind, "routine");
        assert_eq!(request_for(lunch).routine.as_deref(), Some("lunch"));
    }

    #[test]
    fn pack_entries_produce_action_jobs() {
        let entry = ScheduledEntry {
            key: "si.morning".into(),
            pack_id: "si".into(),
            action_id: "morning".into(),
            label: "아침".into(),
            kind: "daily".into(),
            time: "09:00".into(),
            enabled: true,
            date: None,
        };
        let req = request_for(&entry);
        assert_eq!(req.kind, "action");
        assert_eq!(req.pack_id.as_deref(), Some("si"));
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
        }
    }

    /// 스케줄러는 내장 작업까지 돌리지만 설정 화면은 그걸 편집할 수 없다.
    /// 목록에 새어 나가면 사용자는 반응 없는 스위치를 만난다.
    #[test]
    fn settings_list_hides_builtin_tasks() {
        assert!(editable_in_settings(&entry("si", "si.morning")));
        assert!(editable_in_settings(&entry("", "morning")));
        assert!(!editable_in_settings(&entry(TASKS_PACK_ID, "t-abc123")));
    }

    /// 내장 작업 엔트리는 config 가 아니라 작업 정의를 도는 `task` 잡이 되어야 한다.
    #[test]
    fn builtin_task_entries_produce_task_jobs() {
        let req = request_for(&entry(TASKS_PACK_ID, "t-abc123"));
        assert_eq!(req.kind, "task");
        assert_eq!(req.task_id.as_deref(), Some("t-abc123"));
    }
}
