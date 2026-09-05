// tasks.rs — user-defined tasks: one JSON file per task, plus the agent inbox.
// The dashboard process is the ONLY writer of task files; terminal agents may
// write inbox requests and READ task files. Nothing else.

use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

pub const TITLE_MAX: usize = 80;
pub const PROMPT_MAX: usize = 20_000;

/// Test injection point: when set, `workbench_root()` returns this instead of
/// the real config dir. Production never sets it.
pub(crate) static TASKS_ROOT_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn workbench_root() -> PathBuf {
    if let Some(root) = TASKS_ROOT_OVERRIDE.get() {
        return root.clone();
    }
    crate::config::config_path().parent().map(Path::to_path_buf).unwrap_or_default()
}
pub fn tasks_dir(root: &Path) -> PathBuf { root.join("tasks") }

pub fn inbox_dir(root: &Path) -> PathBuf { tasks_dir(root).join("inbox") }
pub fn rejected_dir(root: &Path) -> PathBuf { tasks_dir(root).join("rejected") }
pub fn archive_dir(root: &Path) -> PathBuf { tasks_dir(root).join("archive") }

pub fn ensure_dirs(root: &Path) -> std::io::Result<()> {
    for d in [tasks_dir(root), inbox_dir(root), rejected_dir(root), archive_dir(root)] {
        std::fs::create_dir_all(d)?;
    }
    Ok(())
}
/// Shared test fixture: inject one process-wide temp store root. Parallel
/// tests (tasks/jobs/commands) share whichever dir wins the OnceLock race and
/// isolate from each other by unique task ids.
#[cfg(test)]
pub(crate) fn test_root() -> PathBuf {
    static SEED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    SEED.get_or_init(|| {
        let d = std::env::temp_dir().join(format!("swdash-tasks-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        TASKS_ROOT_OVERRIDE.set(d).ok();
    });
    TASKS_ROOT_OVERRIDE.get().cloned().expect("test root must be injected")
}

pub fn now_iso() -> String { Local::now().to_rfc3339() }

pub fn new_id() -> String {
    let tail = uuid::Uuid::new_v4().simple().to_string();
    format!("t-{}-{}", Local::now().format("%Y%m%d"), &tail[..4])
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScheduleKind { Daily, Weekdays, Once }

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub kind: ScheduleKind,
    pub time: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Source {
    pub kind: String,
    pub agent: Option<String>,
    pub request: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDef {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub schedule: Option<Schedule>,
    pub enabled: bool,
    pub builtin: bool,
    pub skill: Option<String>,
    pub project: Option<String>,
    pub source: Source,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for TaskDef {
    fn default() -> Self {
        Self {
            id: String::new(), title: String::new(), prompt: String::new(),
            schedule: None, enabled: true, builtin: false, skill: None, project: None,
            source: Source::default(), created_at: now_iso(), updated_at: now_iso(),
        }
    }
}

pub fn validate_schedule(s: &Schedule, today: &str) -> Result<(), String> {
    // Require strict HH:MM shape — chrono's `%H` accepts single digits, which
    // would let "9:0" through. The wire format must always be zero-padded.
    if s.time.len() != 5 || s.time.as_bytes()[2] != b':' {
        return Err(format!("잘못된 시간 형식: {} (HH:MM)", s.time));
    }
    if !s.time.as_bytes()[0].is_ascii_digit()
        || !s.time.as_bytes()[1].is_ascii_digit()
        || !s.time.as_bytes()[3].is_ascii_digit()
        || !s.time.as_bytes()[4].is_ascii_digit() {
        return Err(format!("잘못된 시간 형식: {} (HH:MM)", s.time));
    }
    NaiveTime::parse_from_str(&s.time, "%H:%M")
        .map_err(|_| format!("잘못된 시간 형식: {} (HH:MM)", s.time))?;
    match s.kind {
        ScheduleKind::Once => {
            let date = s.date.as_deref().ok_or("once 스케줄에는 date가 필요합니다")?;
            NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| format!("잘못된 날짜 형식: {date} (YYYY-MM-DD)"))?;
            if date < today {
                return Err(format!("과거 날짜입니다: {date}"));
            }
            Ok(())
        }
        ScheduleKind::Daily | ScheduleKind::Weekdays => {
            if s.date.is_some() {
                return Err("date는 once 스케줄에서만 사용합니다".into());
            }
            Ok(())
        }
    }
}

pub fn validate_new(def: &TaskDef, today: &str) -> Result<(), String> {
    let title_len = def.title.chars().count();
    if title_len == 0 || title_len > TITLE_MAX {
        return Err(format!("제목은 1~{TITLE_MAX}자"));
    }
    let p = def.prompt.chars().count();
    if p == 0 || p > PROMPT_MAX {
        return Err(format!("프롬프트는 1~{PROMPT_MAX}자"));
    }
    if let Some(s) = &def.schedule {
        validate_schedule(s, today)?;
    }
    if def.skill.is_some() && !def.builtin {
        return Err("skill은 내장 작업 전용입니다".into());
    }
    Ok(())
}

pub fn list_tasks(root: &Path) -> Vec<TaskDef> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(tasks_dir(root)) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let Ok(def) = serde_json::from_str::<TaskDef>(&text) else { continue };
        out.push(def);
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
    out
}

pub fn get_task(root: &Path, id: &str) -> Result<TaskDef, String> {
    if !valid_id(id) { return Err("잘못된 작업 ID".into()); }
    let p = tasks_dir(root).join(format!("{id}.json"));
    std::fs::read_to_string(&p)
        .map_err(|_| format!("작업을 찾을 수 없습니다: {id}"))
        .and_then(|t| serde_json::from_str(&t).map_err(|e| format!("작업 파일 파싱 실패: {e}")))
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.contains('/') && !id.contains('\\') && !id.contains("..")
}

pub fn save_task(root: &Path, def: &TaskDef) -> Result<(), String> {
    if !valid_id(&def.id) { return Err("잘못된 작업 ID".into()); }
    let bytes = serde_json::to_vec_pretty(def).map_err(|e| e.to_string())?;
    crate::config::write_atomic(&tasks_dir(root).join(format!("{}.json", def.id)), &bytes)
        .map_err(|e| format!("작업 저장 실패: {e}"))
}

pub fn delete_task(root: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) { return Err("잘못된 작업 ID".into()); }
    let src = tasks_dir(root).join(format!("{id}.json"));
    let dst = archive_dir(root).join(format!("{}-{}.json", id, Local::now().format("%Y%m%d%H%M%S")));
    std::fs::rename(&src, &dst).map_err(|e| format!("작업 삭제(보관 이동) 실패: {e}"))
}

/// 스케줄러가 once 작업을 소화한 뒤 조용히 꺼지게.
pub fn set_enabled(root: &Path, id: &str, enabled: bool) -> Result<(), String> {
    let mut def = get_task(root, id)?;
    if def.enabled == enabled {
        return Ok(());
    }
    def.enabled = enabled;
    def.updated_at = now_iso();
    save_task(root, &def)
}

// ---------- agent inbox ----------

pub use crate::scheduler::LEGACY_ROUTINES as ROUTINE_IDS;

/// Distinguishes JSON null (clear the value) from an absent key (keep it).
#[derive(Clone, Debug)]
pub struct NullableString(pub Option<String>);
impl<'de> Deserialize<'de> for NullableString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(NullableString(Option::<String>::deserialize(d)?))
    }
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskDraft {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<Schedule>,
    pub clear_schedule: bool,
    pub enabled: Option<bool>,
    pub project: Option<NullableString>,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxRequest {
    pub op: String,
    #[serde(default)] pub agent: String,
    #[serde(default)] pub note: String,
    #[serde(default)] pub task: Option<TaskDraft>,
    #[serde(default)] pub id: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingRequest {
    pub id: String,
    pub op: String,
    pub agent: String,
    pub note: String,
    pub target_title: String,
    pub summary: Vec<String>,
    pub duplicate_of: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RejectedRequest { pub id: String, pub error: String }

const OPS: [&str; 5] = ["create", "update", "pause", "resume", "delete"];

fn req_path(root: &Path, stem: &str) -> PathBuf { inbox_dir(root).join(format!("{stem}.json")) }
fn valid_stem(stem: &str) -> bool {
    !stem.is_empty() && stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !stem.contains("..")
}

fn move_to_rejected(root: &Path, stem: &str, error: &str) -> std::io::Result<()> {
    let src = req_path(root, stem);
    let payload = serde_json::json!({
        "error": error,
        "request": std::fs::read_to_string(&src).unwrap_or_default(),
    });
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // write_atomic creates rejected/ and is the same convention as task files.
    crate::config::write_atomic(&rejected_dir(root).join(format!("{stem}.rejected.json")), &bytes)?;
    // Drop the inbox original only after the rejected copy is safely on disk.
    // On failure the request stays in the inbox: process_inbox retries it on
    // the next tick instead of losing the agent's request.
    std::fs::remove_file(&src)?;
    Ok(())
}

fn parse_req(root: &Path, stem: &str) -> Result<InboxRequest, String> {
    let text = std::fs::read_to_string(req_path(root, stem))
        .map_err(|e| format!("요청 파일 읽기 실패: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("요청 JSON 파싱 실패: {e}"))
}

fn validate_req(root: &Path, req: &InboxRequest, today: &str) -> Result<(), String> {
    if !OPS.contains(&req.op.as_str()) {
        return Err(format!("알 수 없는 op: {}", req.op));
    }
    if req.op == "create" {
        let draft = req.task.as_ref().ok_or("create에는 task가 필요합니다")?;
        let cand = draft_to_def(draft, String::new())?;
        return validate_new(&cand, today);
    }
    let id = req.id.as_deref().ok_or("create 외 op에는 id가 필요합니다")?;
    if ROUTINE_IDS.contains(&id) {
        return Err("내장 작업(morning/lunch/evening)은 인박스로 바꿀 수 없습니다".into());
    }
    let cur = get_task(root, id)?;
    if let Some(draft) = &req.task {
        let merged = apply_draft(cur, draft)?;
        return validate_new(&merged, today);
    }
    if req.op == "update" {
        return Err("update에는 task가 필요합니다".into());
    }
    Ok(())
}

fn draft_to_def(d: &TaskDraft, id: String) -> Result<TaskDef, String> {
    let mut def = TaskDef { id, ..TaskDef::default() };
    if let Some(t) = &d.title { def.title = t.clone(); }
    if let Some(p) = &d.prompt { def.prompt = p.clone(); }
    def.schedule.clone_from(&d.schedule);
    def.enabled = d.enabled.unwrap_or(true);
    if let Some(NullableString(v)) = &d.project { def.project = v.clone(); }
    Ok(def)
}

fn apply_draft(mut cur: TaskDef, d: &TaskDraft) -> Result<TaskDef, String> {
    if let Some(t) = &d.title { cur.title = t.clone(); }
    if let Some(p) = &d.prompt { cur.prompt = p.clone(); }
    if d.clear_schedule { cur.schedule = None; }
    else if d.schedule.is_some() { cur.schedule.clone_from(&d.schedule); }
    if let Some(e) = d.enabled { cur.enabled = e; }
    if let Some(NullableString(v)) = &d.project { cur.project = v.clone(); }
    Ok(cur)
}

pub fn schedule_label(s: &Schedule) -> String {
    let kind = match s.kind {
        ScheduleKind::Daily => "매일",
        ScheduleKind::Weekdays => "평일",
        ScheduleKind::Once => return format!("{} {}", s.date.clone().unwrap_or_default(), s.time),
    };
    format!("{kind} {}", s.time)
}

fn summarize(req: &InboxRequest, root: &Path) -> Vec<String> {
    let mut rows = Vec::new();
    let Some(d) = &req.task else { return rows };
    if d.title.is_some() { rows.push(format!("제목: {}", d.title.clone().unwrap_or_default())); }
    if d.prompt.is_some() { rows.push("프롬프트 변경".into()); }
    if d.clear_schedule { rows.push("스케줄 제거 → 수동 작업".into()); }
    if let Some(s) = &d.schedule { rows.push(format!("스케줄: {}", schedule_label(s))); }
    if let Some(e) = d.enabled { rows.push(format!("활성: {e}")); }
    let _ = root;
    rows
}

pub fn process_inbox(root: &Path, today: &str) {
    let Ok(rd) = std::fs::read_dir(inbox_dir(root)) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        if p.extension().and_then(|x| x.to_str()) != Some("json") || !valid_stem(stem) { continue; }
        // skip files written too recently (agent may still be mid-write)
        if let Ok(meta) = p.metadata() {
            if let Ok(mtime) = meta.modified() {
                if std::time::SystemTime::now().duration_since(mtime)
                    .map(|age| age < std::time::Duration::from_secs(2)).unwrap_or(true) { continue; }
            }
        }
        match parse_req(root, stem).and_then(|req| validate_req(root, &req, today).map(|_| req)) {
            Ok(_) => {}
            // move failure keeps the request in the inbox for the next tick
            Err(err) => { let _ = move_to_rejected(root, stem, &err); }
        }
    }
}

fn summarize_for_list(root: &Path, stem: &str, req: &InboxRequest) -> PendingRequest {
    let target = if req.op == "create" {
        req.task.as_ref().and_then(|t| t.title.clone()).unwrap_or_default()
    } else {
        req.id.as_deref().and_then(|id| get_task(root, id).ok().map(|d| d.title)).unwrap_or_else(|| req.id.clone().unwrap_or_default())
    };
    let duplicate_of = if req.op == "create" {
        find_duplicate(root, &target, req.task.as_ref().and_then(|t| t.schedule.clone()))
    } else { None };
    PendingRequest {
        id: stem.into(), op: req.op.clone(), agent: req.agent.clone(), note: req.note.clone(),
        target_title: target, summary: summarize(req, root), duplicate_of,
    }
}

fn find_duplicate(root: &Path, title: &str, schedule: Option<Schedule>) -> Option<String> {
    let norm = |t: &str| t.trim().to_lowercase();
    list_tasks(root).into_iter().find(|d| {
        norm(&d.title) == norm(title) && d.schedule == schedule && d.enabled
    }).map(|d| d.id)
}

pub fn list_pending(root: &Path) -> Vec<PendingRequest> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(inbox_dir(root)) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        if p.extension().and_then(|x| x.to_str()) != Some("json") || !valid_stem(stem) { continue; }
        if let Ok(req) = parse_req(root, stem) {
            out.push(summarize_for_list(root, stem, &req));
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn list_rejected(root: &Path) -> Vec<RejectedRequest> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(rejected_dir(root)) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(id) = name.strip_suffix(".rejected.json") else { continue };
        let error = std::fs::read_to_string(e.path()).ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| "알 수 없는 사유".into());
        out.push(RejectedRequest { id: id.into(), error });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn reject_request(root: &Path, stem: &str, reason: &str) -> Result<(), String> {
    if !valid_stem(stem) || !req_path(root, stem).is_file() {
        return Err("해당 요청이 없습니다".into());
    }
    move_to_rejected(root, stem, &format!("사용자 거부: {reason}"))
        .map_err(|e| format!("반려 처리 실패: {e}"))
}

pub fn approve_request(root: &Path, stem: &str, agent: &str, today: &str) -> Result<TaskDef, String> {
    if !valid_stem(stem) { return Err("잘못된 요청 ID".into()); }
    let req = parse_req(root, stem)?;
    validate_req(root, &req, today)?;
    let applied = match req.op.as_str() {
        "create" => {
            let draft = req.task.clone().unwrap_or_default();
            let mut def = draft_to_def(&draft, new_id())?;
            def.source = Source { kind: "agent".into(), agent: Some(agent.into()), request: Some(stem.into()) };
            def.created_at = now_iso();
            def.updated_at = def.created_at.clone();
            save_task(root, &def)?;
            def
        }
        "update" => {
            let id = req.id.clone().ok_or("id가 필요합니다")?;
            let mut cur = get_task(root, &id)?;
            cur = apply_draft(cur, req.task.as_ref().ok_or("update에는 task가 필요합니다")?)?;
            cur.updated_at = now_iso();
            save_task(root, &cur)?;
            cur
        }
        "pause" | "resume" => {
            let id = req.id.clone().ok_or("id가 필요합니다")?;
            let mut cur = get_task(root, &id)?;
            cur.enabled = req.op == "resume";
            cur.updated_at = now_iso();
            save_task(root, &cur)?;
            cur
        }
        "delete" => {
            let id = req.id.clone().ok_or("id가 필요합니다")?;
            let cur = get_task(root, &id)?;
            delete_task(root, &id)?;
            cur
        }
        _ => unreachable!("validated"),
    };
    let _ = std::fs::remove_file(req_path(root, stem));
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("swdash-tasks-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn def(id: &str, title: &str) -> TaskDef {
        TaskDef { id: id.into(), title: title.into(), prompt: "본문".into(), ..TaskDef::default() }
    }

    #[test]
    fn save_list_get_delete_roundtrip() {
        let root = tempdir("round");
        ensure_dirs(&root).unwrap();
        let mut d = def("t-20260905-aaaa", "주간 정리");
        d.schedule = Some(Schedule { kind: ScheduleKind::Daily, time: "08:30".into(), date: None });
        save_task(&root, &d).unwrap();
        assert_eq!(list_tasks(&root).len(), 1);
        assert_eq!(get_task(&root, "t-20260905-aaaa").unwrap().title, "주간 정리");
        delete_task(&root, "t-20260905-aaaa").unwrap();
        assert!(list_tasks(&root).is_empty());
        assert_eq!(get_task(&root, "t-20260905-aaaa").unwrap_err(), "작업을 찾을 수 없습니다: t-20260905-aaaa");
        // archived, not gone
        assert!(std::fs::read_dir(archive_dir(&root)).unwrap().count() == 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn broken_files_are_skipped() {
        let root = tempdir("broken");
        ensure_dirs(&root).unwrap();
        std::fs::write(tasks_dir(&root).join("bad.json"), "{ nope").unwrap();
        save_task(&root, &def("t-20260905-bbbb", "정상")).unwrap();
        std::fs::write(tasks_dir(&root).join("note.txt"), "ignore").unwrap();
        assert_eq!(list_tasks(&root).len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn validate_rejects_out_of_range_and_bad_schedule() {
        let today = "2026-09-05";
        let mut d = def("x", &"가".repeat(81));
        assert!(validate_new(&d, today).is_err());
        d.title = "ok".into();
        d.prompt = String::new();
        assert!(validate_new(&d, today).is_err());
        d.prompt = "본문".into();
        d.schedule = Some(Schedule { kind: ScheduleKind::Once, time: "09:00".into(), date: None });
        assert!(validate_new(&d, today).is_err()); // once without date
        d.schedule = Some(Schedule { kind: ScheduleKind::Once, time: "09:00".into(), date: Some("2026-09-01".into()) });
        assert!(validate_new(&d, today).is_err()); // past date
        d.schedule = Some(Schedule { kind: ScheduleKind::Daily, time: "9:0".into(), date: None });
        assert!(validate_new(&d, today).is_err()); // bad time
        d.schedule = Some(Schedule { kind: ScheduleKind::Weekdays, time: "09:00".into(), date: None });
        assert!(validate_new(&d, today).is_ok());
    }

    #[test]
    fn id_validation_blocks_path_tricks() {
        for bad in ["", "../x", "a/b", "a\\b", ".."] {
            assert!(!valid_id(bad), "{bad}");
        }
        assert!(valid_id("t-20260905-ab12"));
        // delete_task must refuse path-traversal ids before touching the FS.
        let root = tempdir("idguard");
        ensure_dirs(&root).unwrap();
        for bad in ["../x", "a/b", "a\\b", ".."] {
            assert!(delete_task(&root, bad).is_err(), "delete accepted {bad}");
        }
        assert_eq!(
            delete_task(&root, "../x").unwrap_err(),
            "잘못된 작업 ID"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn write_req(root: &Path, stem: &str, body: &str) {
        std::fs::write(inbox_dir(root).join(format!("{stem}.json")), body).unwrap();
    }

    fn aged(root: &Path, stem: &str) {
        // process_inbox의 mtime 2초 안정화를 우회: 파일 시간을 10초 전으로
        let p = inbox_dir(root).join(format!("{stem}.json"));
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(10);
        filetime::set_file_mtime(&p, filetime::FileTime::from_unix_time(
            old.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64, 0)).unwrap();
    }

    #[test]
    fn process_inbox_validates_and_rejects_bad_requests() {
        let root = tempdir("inbox");
        ensure_dirs(&root).unwrap();
        write_req(&root, "req-ok", r#"{"op":"create","agent":"claude-code","note":"테스트","task":{"title":"주간 정리","prompt":"p","schedule":{"kind":"daily","time":"08:30"}}}"#);
        write_req(&root, "req-badsched", r#"{"op":"create","task":{"title":"x","prompt":"p","schedule":{"kind":"once","time":"09:00"}}}"#);
        write_req(&root, "req-builtin", r#"{"op":"delete","id":"morning"}"#);
        aged(&root, "req-ok"); aged(&root, "req-badsched"); aged(&root, "req-builtin");
        process_inbox(&root, "2026-09-05");
        let pend = list_pending(&root);
        assert_eq!(pend.len(), 1);
        assert_eq!(pend[0].op, "create");
        assert_eq!(pend[0].target_title, "주간 정리");
        let rej = list_rejected(&root);
        assert_eq!(rej.len(), 2);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn approve_create_makes_agent_sourced_task() {
        let root = tempdir("approve");
        ensure_dirs(&root).unwrap();
        write_req(&root, "req-1", r#"{"op":"create","agent":"codex","task":{"title":"야간 빌드","prompt":"빌드 돌려라"}}"#);
        aged(&root, "req-1");
        process_inbox(&root, "2026-09-05");
        let d = approve_request(&root, "req-1", "codex", "2026-09-05").unwrap();
        assert!(d.id.starts_with("t-"));
        assert_eq!(d.source.kind, "agent");
        assert_eq!(d.source.agent.as_deref(), Some("codex"));
        assert_eq!(d.source.request.as_deref(), Some("req-1"));
        assert!(d.enabled);
        assert!(get_task(&root, &d.id).is_ok());
        assert!(list_pending(&root).is_empty()); // 요청 소비됨
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn approve_update_pause_resume_delete_flow() {
        let root = tempdir("flow");
        ensure_dirs(&root).unwrap();
        let mut base = def("t-20260905-cccc", "원래 제목");
        base.schedule = Some(Schedule { kind: ScheduleKind::Daily, time: "09:00".into(), date: None });
        save_task(&root, &base).unwrap();
        for (stem, body) in [
            ("req-u", r#"{"op":"update","id":"t-20260905-cccc","task":{"title":"바꾼 제목","clearSchedule":true}}"#),
            ("req-p", r#"{"op":"pause","id":"t-20260905-cccc"}"#),
            ("req-r", r#"{"op":"resume","id":"t-20260905-cccc"}"#),
            ("req-d", r#"{"op":"delete","id":"t-20260905-cccc"}"#),
        ] { write_req(&root, stem, body); aged(&root, stem); }
        process_inbox(&root, "2026-09-05");

        let d = approve_request(&root, "req-u", "agent", "2026-09-05").unwrap();
        assert_eq!(d.title, "바꾼 제목");
        assert!(d.schedule.is_none());
        assert_eq!(approve_request(&root, "req-p", "agent", "2026-09-05").unwrap().enabled, false);
        assert_eq!(approve_request(&root, "req-r", "agent", "2026-09-05").unwrap().enabled, true);
        approve_request(&root, "req-d", "agent", "2026-09-05").unwrap();
        assert!(get_task(&root, "t-20260905-cccc").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn reject_request_moves_with_reason() {
        let root = tempdir("reject");
        ensure_dirs(&root).unwrap();
        write_req(&root, "req-9", r#"{"op":"create","task":{"title":"t","prompt":"p"}}"#);
        aged(&root, "req-9");
        process_inbox(&root, "2026-09-05");
        reject_request(&root, "req-9", "중복").unwrap();
        let rej = list_rejected(&root);
        assert_eq!(rej.len(), 1);
        assert!(rej[0].error.contains("사용자 거부"));
        assert!(list_pending(&root).is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn move_to_rejected_preserves_original_when_copy_write_fails() {
        let root = tempdir("rejectfail");
        std::fs::create_dir_all(inbox_dir(&root)).unwrap();
        write_req(&root, "req-f", r#"{"op":"create","task":{"title":"t","prompt":"p"}}"#);
        // occupy the rejected path with a regular file so the copy write fails
        std::fs::write(rejected_dir(&root), "blocker").unwrap();
        assert!(reject_request(&root, "req-f", "사유").is_err());
        assert!(req_path(&root, "req-f").is_file(), "쓰기 실패 시 원본 보존");

        // unblock: the retry writes the copy and only then drops the original
        std::fs::remove_file(rejected_dir(&root)).unwrap();
        reject_request(&root, "req-f", "사유").unwrap();
        assert!(!req_path(&root, "req-f").exists());
        assert_eq!(list_rejected(&root).len(), 1);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn approve_request_rejects_bad_stem() {
        let root = tempdir("stem");
        ensure_dirs(&root).unwrap();
        // a stem containing '..' or '/' must be refused before any FS path is built
        assert!(approve_request(&root, "../evil", "agent", "2026-09-05").is_err());
        assert!(approve_request(&root, "a/b", "agent", "2026-09-05").is_err());
        // and nothing must have been deleted outside the inbox
        assert!(!inbox_dir(&root).join("../evil.json").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }


}
