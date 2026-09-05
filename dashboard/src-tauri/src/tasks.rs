// tasks.rs — user-defined tasks: one JSON file per task, plus the agent inbox.
// The dashboard process is the ONLY writer of task files; terminal agents may
// write inbox requests and READ task files. Nothing else.

// Task 1 of 12: items below are the public store API consumed by later tasks
#![allow(dead_code)]
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

pub const TITLE_MAX: usize = 80;
pub const PROMPT_MAX: usize = 20_000;

pub fn workbench_root() -> PathBuf {
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
    let t = NaiveTime::parse_from_str(&s.time, "%H:%M")
        .map_err(|_| format!("잘못된 시간 형식: {} (HH:MM)", s.time))?;
    let _ = t;
    match s.kind {
        ScheduleKind::Once => {
            let date = s.date.as_deref().ok_or("once 스케줄에는 date가 필요합니다")?;
            let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .map_err(|_| format!("잘못된 날짜 형식: {date} (YYYY-MM-DD)"))?;
            let _ = d;
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
    let src = tasks_dir(root).join(format!("{id}.json"));
    let dst = archive_dir(root).join(format!("{}-{}.json", id, Local::now().format("%Y%m%d%H%M%S")));
    std::fs::rename(&src, &dst).map_err(|e| format!("작업 삭제(보관 이동) 실패: {e}"))
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
    }
}
