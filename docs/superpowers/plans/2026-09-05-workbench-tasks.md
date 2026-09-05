# 워크벤치 작업 시스템 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 터미널 에이전트가 파일 인박스로 예약 작업 생성을 요청하고 대시보드 승인 후 스케줄 실행되는 작업 시스템을 만든다. morning/lunch/evening 루틴을 동일 모델로 통합하고, 워크벤치 스킬(SKILL.md)을 에이전트에 배포한다.

**Architecture:** 신규 Rust 모듈 `tasks.rs`(작업 스토어 = 파일 1개당 작업 1개, 인박스 검증·승인) + `scheduler.rs` 일반화(ScheduleSpec, 엔트리 통합 tick) + `jobs.rs` kind:"task" arm. 프론트엔드는 TasksPage 신설과 HomePage missed/루틴 위젯의 타입 교체. 에이전트는 `tasks/inbox/`에만 쓰고 정식 스토어는 대시보드 프로세스만 쓴다(단일 작성자).

**Tech Stack:** Tauri 2 command, serde_json, chrono, notify(watcher), React 18 + zustand, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-05-workbench-tasks-design.md`

## Global Constraints

- UI 문구·에러 메시지 한국어. 코드·커밋 영어.
- Rust wire 타입: `#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]`. TS 타입과 필드명 1:1.
- 정식 작업 파일(`tasks/*.json`)을 쓰는 프로세스는 대시보드뿐이다. 에이전트 경로는 `inbox/` 쓰기 + 스토어 읽기만 허용. 인박스 op에 `run` 없음.
- 에이전트 요청은 전부 승인 카드를 경유한다(GUI/수동 생성은 예외 — 즉시 저장). 승인 우회 경로를 만들지 않는다.
- 제목 1~80자, 프롬프트 1~20,000자, schedule kind는 `daily|weekdays|once`만, `once`는 `date` 필수이고 과거 날짜 거부. builtin(morning/lunch/evening) 대상 인박스 op는 거부.
- 미싱 정책 유지: 놓친 스케줄 자동 실행 금지, 카드 확인 후 실행. GRACE 2분.
- `decide()`는 순수 함수 유지(시간 인자만, I/O 없음).
- 기존 `~/.claude/sawhorse/config.json` 스키마 무변경. 루틴 스케줄 정본은 그대로 `dashboard.schedules.*`.
- 구형 state.json 호환: `MissedEntry.task_id`에 `#[serde(alias = "routine")]`, `title`은 `#[serde(default)]`.
- 커밋: conventional(feat:), 영어, **경로 한정**(`git add <내 파일> && git commit -m ... -- <내 파일>`). 기존 미커밋 WIP를 내 커밋에 섞지 않는다.
- 전제 파일(스냅샷 기준): `dashboard/src-tauri/src/{config,jobs,scheduler,state,watcher,commands,lib,plugin}.rs`, `dashboard/src/{App.tsx,lib/{types,api,store}.tsx?ts}`, `dashboard/src/pages/{HomePage,SettingsPage}.tsx`.

---

### Task 0: 베이스라인 확인 (WIP 좌표)

**Files:** 커밋 없음. 게이트만.

현재 트리에 형제 세션의 진행형 WIP가 있다(`dashboard/src/features/` 신규 + `App.tsx`·`HomePage.tsx`·`index.css` 등 수정 — HomePage가 이미 `@/features/dashboard/DashboardBoard`를 import). 이 상태로 `App.tsx`/`HomePage.tsx`를 고치면 내 커밋에 남의 변경이 섞인다.

- [ ] **Step 1: 트리 상태 확인** — `git status --porcelain`. 비어 있으면 Step 3으로.
- [ ] **Step 2: WIP가 있으면 중단·보고** — 사용자(또는 형제 세션)가 WIP를 커밋/정리하도록 보고하고, 트리가 클린해진 뒤 Task 1부터 재개한다. 임의로 `git add -A` 커밋하지 않는다(진행형 작업을 통째로 확정하는 판단은 소유자 몫).
- [ ] **Step 3: 빌드 그린 확인** — `cd dashboard/src-tauri && cargo check`와 `cd dashboard && npx tsc --noEmit` 통과. 실패 시 중단·보고.

### Task 1: `tasks.rs` — 타입·스토어·검증

**Files:**
- Create: `dashboard/src-tauri/src/tasks.rs`
- Modify: `dashboard/src-tauri/src/lib.rs` (mod 목록에 `mod tasks;` 추가 — 1-10행 mod 블록)
- Test: `tasks.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `config::write_atomic(path, bytes)`, `config::config_path()`(workbench 루트 유도), `uuid`, `chrono`.
- Produces (이후 모든 태스크가 소비):
  - `pub fn workbench_root() -> PathBuf` — `config_path().parent()` = `~/.claude/sawhorse`
  - `pub fn tasks_dir(root: &Path) -> PathBuf` / `inbox_dir` / `rejected_dir` / `archive_dir` — root 아래 `tasks{,/inbox,/rejected,/archive}`
  - `pub fn ensure_dirs(root: &Path) -> std::io::Result<()>` — 4개 디렉터리 생성(존재 시 무시)
  - `#[derive(...)] pub struct Schedule { pub kind: ScheduleKind, pub time: String, pub date: Option<String> }`, `pub enum ScheduleKind { Daily, Weekdays, Once }` (serde rename_all camelCase, kind는 `#[serde(rename_all = "lowercase")]`)
  - `pub struct Source { pub kind: String, pub agent: Option<String>, pub request: Option<String> }`
  - `pub struct TaskDef { pub id, title, prompt: String, pub schedule: Option<Schedule>, pub enabled: bool, pub builtin: bool, pub skill: Option<String>, pub project: Option<String>, pub source: Source, pub created_at: String, pub updated_at: String }` — 모두 camelCase wire, `default` 있음
  - `pub fn validate_schedule(s: &Schedule, today: &str) -> Result<(), String>` / `pub fn validate_new(def: &TaskDef) -> Result<(), String>`(제목 1..=80자, prompt 1..=20_000자, schedule 검증, skill은 builtin 전용)
  - `pub fn list_tasks(root: &Path) -> Vec<TaskDef>`(깨진 파일 skip, createdAt 오름차순) / `get_task(root, id) -> Result<TaskDef, String>` / `save_task(root, &TaskDef) -> Result<(), String>`(원자적 쓰기) / `delete_task(root, id) -> Result<(), String>`(archive 이동) / `new_id() -> String`(`t-YYYYMMDD-<uuid4>`)
  - `pub fn now_iso() -> String` — `Local::now().to_rfc3339()`

- [ ] **Step 1: 실패하는 테스트 + 골격 작성** — 아래 전체를 `tasks.rs`로 생성한다. `lib.rs`에 mod 선언이 없어 컴파일이 실패한다.

```rust
// tasks.rs — user-defined tasks: one JSON file per task, plus the agent inbox.
// The dashboard process is the ONLY writer of task files; terminal agents may
// write inbox requests and READ task files. Nothing else.

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
    let t = NaiveTime::parse_from_str(&s.time, "%H:%M")
        .map_err(|_| format!("잘못된 시간 형식: {} (HH:MM)", s.time))?;
    let _ = t;
    match s.kind {
        ScheduleKind::Once => {
            let date = s.date.as_deref().ok_or("once 스케줄에는 date가 필요합니다")?;
            let d = NaiveDate::parse_from_str(date, "%Y-%m-%d")
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
        std::fs::write(tasks_dir(root).join("bad.json"), "{ nope").unwrap();
        save_task(&root, &def("t-20260905-bbbb", "정상")).unwrap();
        std::fs::write(tasks_dir(root).join("note.txt"), "ignore").unwrap();
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
```

- [ ] **Step 2: mod 선언 추가** — `lib.rs` mod 블록(1-10행)에 `mod tasks;` 삽입(알파벳순 `scheduler` 뒤).
- [ ] **Step 3: 테스트 통과** — `cd dashboard/src-tauri && cargo test tasks::` → 4개 PASS.
- [ ] **Step 4: 커밋**

```bash
git add dashboard/src-tauri/src/tasks.rs dashboard/src-tauri/src/lib.rs
git commit -m "feat(dashboard): task store types and validation" -- dashboard/src-tauri/src/tasks.rs dashboard/src-tauri/src/lib.rs
```

### Task 2: `tasks.rs` — 인박스 처리기

**Files:**
- Modify: `dashboard/src-tauri/src/tasks.rs` (아래 코드 추가 + tests 확장)

**Interfaces:**
- Consumes: Task 1의 타입·스토어 함수.
- Produces (Task 4, Task 6, Task 7가 소비):
  - `#[derive(Deserialize)] #[serde(rename_all="camelCase")] pub struct TaskDraft { pub title: Option<String>, pub prompt: Option<String>, pub schedule: Option<Schedule>, #[serde(default)] pub clear_schedule: bool, pub enabled: Option<bool>, pub project: Option<NullableString> }` — `pub struct NullableString(pub Option<String>)`(명시적 null과 absent 구분, `Deserialize` 수동 구현: null→Some(None), string→Some(Some))
  - `#[derive(Deserialize)] #[serde(rename_all="camelCase")] pub struct InboxRequest { pub op: String, #[serde(default)] pub agent: String, #[serde(default)] pub note: String, pub task: Option<TaskDraft>, pub id: Option<String> }`
  - `#[derive(Serialize, Clone)] #[serde(rename_all="camelCase")] pub struct PendingRequest { pub id: String /*파일 stem*/, pub op: String, pub agent: String, pub note: String, pub target_title: String, pub summary: Vec<String>, pub duplicate_of: Option<String> }`
  - `#[derive(Serialize, Clone)] #[serde(rename_all="camelCase")] pub struct RejectedRequest { pub id: String, pub error: String }`
  - `pub fn process_inbox(root: &Path, today: &str) -> ()` — 유효 요청은 inbox에 두고(=승인대기 큐), 무효 요청은 `rejected/<stem>.rejected.json`(`{error, request}`)으로 이동. mtime 2초 미만 파일은 이번 패스에서 skip(쓰기 레이스), 파싱 실패는 mtime이 안정된 후 재검사 1회.
  - `pub fn list_pending(root: &Path) -> Vec<PendingRequest>` / `pub fn list_rejected(root: &Path) -> Vec<RejectedRequest>`
  - `pub fn approve_request(root: &Path, stem: &str, agent: &str, today: &str) -> Result<TaskDef, String>` — op별 적용 후 요청 파일 삭제. create→`source{kind:"agent",agent,request:stem}`로 파일 생성(enabled 기본 true), update→지정 키만 패치+`updated_at`, pause/resume→enabled 토글, delete→archive 이동. builtin id 대상은 Err.
  - `pub fn reject_request(root: &Path, stem: &str, reason: &str) -> Result<(), String>` — rejected로 이동(사유 "사용자 거부: {reason}").

- [ ] **Step 1: 실패하는 테스트 먼저** — tests 모듈에 추가:

```rust

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
```

참고: `filetime` 크레이트가 dev-dependency에 없으면 `[dev-dependencies] filetime = "0.2"` 추가(Cargo.toml).

- [ ] **Step 2: 테스트 실패 확인** — `cargo test tasks::tests::` → 미정의 함수로 FAIL.
- [ ] **Step 3: 구현** — tasks.rs에 추가:

```rust
// ---------- agent inbox ----------

/// Distinguishes JSON null (clear the value) from an absent key (keep it).
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

fn move_to_rejected(root: &Path, stem: &str, error: &str) {
    let src = req_path(root, stem);
    let payload = serde_json::json!({
        "error": error,
        "request": std::fs::read_to_string(&src).unwrap_or_default(),
    });
    let _ = std::fs::create_dir_all(rejected_dir(root));
    let _ = std::fs::write(
        rejected_dir(root).join(format!("{stem}.rejected.json")),
        serde_json::to_vec_pretty(&payload).unwrap_or_default(),
    );
    let _ = std::fs::remove_file(&src);
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
            Err(err) => move_to_rejected(root, stem, &err),
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
    move_to_rejected(root, stem, &format!("사용자 거부: {reason}"));
    Ok(())
}

pub fn approve_request(root: &Path, stem: &str, agent: &str, today: &str) -> Result<TaskDef, String> {
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
```

`ROUTINE_IDS`는 Task 4에서 scheduler가 공개하는 `pub const ROUTINE_IDS: [&str; 3] = ["morning", "lunch", "evening"];`을 가리킨다 — Task 2 단계에서는 컴파일을 위해 tasks.rs 상단에 임시 `pub const ROUTINE_IDS: [&str; 3] = ["morning", "lunch", "evening"];`를 두고, Task 4에서 `pub use crate::scheduler::ROUTINE_IDS;`로 교체한다(또는 역방향: Task 4가 scheduler에 두고 tasks.rs가 re-export — 둘 중 최종 형태는 re-export).

- [ ] **Step 4: 테스트 통과** — `cargo test tasks::` → 전부 PASS. (`filetime` dev-dep 추가 확인)
- [ ] **Step 5: 커밋**

```bash
git add dashboard/src-tauri/src/tasks.rs dashboard/src-tauri/Cargo.toml dashboard/src-tauri/Cargo.lock
git commit -m "feat(dashboard): agent inbox processing" -- dashboard/src-tauri/src/tasks.rs dashboard/src-tauri/Cargo.toml dashboard/src-tauri/Cargo.lock
```

### Task 3: `scheduler.rs` — ScheduleSpec 일반화 (decide)

**Files:**
- Modify: `dashboard/src-tauri/src/scheduler.rs` (decide 시그니처·구현, tests)
- Modify: `dashboard/src-tauri/src/tasks.rs` (`pub use crate::scheduler::ROUTINE_IDS;`는 Task 4에서 — 이 태스크에선 tasks.rs의 임시 const 유지)

**Interfaces:**
- Produces:
  - `#[derive(Clone, Copy, Debug, PartialEq)] pub enum SchedKind { Daily, Weekdays, Once }`
  - `#[derive(Clone, Copy, Debug)] pub struct SchedSpec { pub kind: SchedKind, pub time: NaiveTime, pub date: Option<chrono::NaiveDate> }` + `impl SchedSpec { pub fn daily(t: NaiveTime) -> Self }`
  - `pub fn decide(now, spec: &SchedSpec, enabled, last_run: Option<&str>, today, booted_at) -> Decision` — 기존 로직 + weekdays는 주말 Idle, once는 `last_run == Some(date)`면 Idle.

- [ ] **Step 1: 실패하는 테스트로 교체** — 기존 tests의 `sched(h, mi)` 헬퍼를 아래로 바꾸고 새 케이스 추가:

```rust
    fn spec(kind: SchedKind, h: u32, mi: u32) -> SchedSpec {
        SchedSpec { kind, time: NaiveTime::from_hms_opt(h, mi, 0).unwrap(), date: None }
    }

    #[test]
    fn weekdays_skips_weekend() {
        let booted = at(2026, 9, 5, 9, 2); // 2026-09-05 is Saturday
        let now = at(2026, 9, 5, 9, 2);
        assert_eq!(decide(now, spec(SchedKind::Weekdays, 9, 0), true, None, "2026-09-05", booted), Decision::Idle);
        let mon_boot = at(2026, 9, 7, 9, 1); // Monday within grace
        let mon = at(2026, 9, 7, 9, 2);
        assert_eq!(decide(mon, spec(SchedKind::Weekdays, 9, 0), true, None, "2026-09-07", mon_boot), Decision::Run);
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
```

기존 4개 테스트의 `sched(h, mi)` 호출을 `spec(SchedKind::Daily, h, mi)`로 교체(검증 내용 불변 — 기존 루틴 회귀).

- [ ] **Step 2: 구현 교체** — decide와 헬퍼:

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchedKind { Daily, Weekdays, Once }

#[derive(Clone, Copy, Debug)]
pub struct SchedSpec {
    pub kind: SchedKind,
    pub time: NaiveTime,
    pub date: Option<NaiveDate>,
}

impl SchedSpec {
    pub fn daily(time: NaiveTime) -> Self { Self { kind: SchedKind::Daily, time, date: None } }
}

pub fn decide(
    now: DateTime<Local>,
    spec: &SchedSpec,
    enabled: bool,
    last_run: Option<&str>,
    today: &str,
    booted_at: DateTime<Local>,
) -> Decision {
    if !enabled { return Decision::Idle; }
    if spec.date.is_none() && last_run == Some(today) { return Decision::Idle; }
    if let Some(date) = spec.date {
        if spec.kind == SchedKind::Once && last_run == Some(date.format("%Y-%m-%d").to_string().as_str()) {
            return Decision::Idle;
        }
    }
    if spec.kind == SchedKind::Weekdays {
        use chrono::Datelike;
        let wd = now.weekday();
        if wd == chrono::Weekday::Sat || wd == chrono::Weekday::Sun { return Decision::Idle; }
    }
    let target_day = spec.date.unwrap_or_else(|| now.date_naive());
    let target = target_day.and_time(spec.time);
    let now_naive = now.naive_local();
    if now_naive < target { return Decision::Idle; }
    let overdue = now_naive - target;
    let passed_before_boot = target <= booted_at.naive_local();
    if passed_before_boot && overdue > GRACE { Decision::Missed } else { Decision::Run }
}
```

기존 `last_run == Some(today)` 검사는 once가 date를 가지므로 위 once 분기로 흡수되고, daily/weekdays는 `target_day == today`라 기존과 동일하다. 단, 기존 `last_run == Some(today)` 조건이 decide에서 사라지므로 daily에서 `last_run == Some(today)`여도 target 지난 뒤 Run이 나올 수 있다 — tick의 Run 분기는 last_run을 갱신하므로 재발 없음을 기존 테스트 `idle_before_time_and_after_run_and_disabled`가 잡는다. 안전을 위해 decide 상단에 daily/weekdays용 `if spec.date.is_none() && last_run == Some(today) { return Decision::Idle; }`을 유지한다.

- [ ] **Step 3: 전체 스케줄러 테스트 통과** — `cargo test scheduler::`.
- [ ] **Step 4: 커밋**

```bash
git add dashboard/src-tauri/src/scheduler.rs
git commit -m "feat(dashboard): generalize scheduler decide to schedule specs" -- dashboard/src-tauri/src/scheduler.rs
```

### Task 4: `scheduler.rs` — 엔트리 통합 tick + `run_task_now` + MissedEntry 일반화

**Files:**
- Modify: `dashboard/src-tauri/src/scheduler.rs` (tick_once·run_routine_now→run_task_now·dismiss_missed·MissedEntry)
- Modify: `dashboard/src-tauri/src/state.rs` (MissedEntry 필드 교체)
- Modify: `dashboard/src-tauri/src/tasks.rs` (임시 `ROUTINE_IDS` const를 re-export로 교체)

**Interfaces:**
- Consumes: Task 1-3 전부.
- Produces (Task 5·6·7이 소비):
  - `pub const ROUTINE_IDS: [&str; 3] = ["morning", "lunch", "evening"];` (scheduler.rs)
  - `struct SchedEntry { id: String, title: String, spec: SchedSpec, enabled: bool, builtin: bool, project: Option<String> }` + `fn collect_entries(view: &config::ConfigView, root: &Path) -> Vec<SchedEntry>` — builtin 3개(config `dashboard.schedules.*`, 제목 "아침 브리핑|오전 결산|퇴근 정산") + `tasks::list_tasks` 중 `schedule.is_some()`인 것(schedule→SchedSpec 변환; 파싱 실패 파일은 skip)
  - `pub fn tick_once(mgr, state, emit, booted_at)` — process_inbox 선실행 + 엔트리 순회. Run→ builtin이면 `JobRequest{kind:"routine", routine:Some(id)}` else `JobRequest{kind:"task", task_id:Some(id), project}`; once Run 성공 시 해당 파일 enabled=false 저장.
  - `pub struct MissedEntry { pub key: String, #[serde(alias = "routine")] pub task_id: String, #[serde(default)] pub title: String, pub date: String, pub scheduled_at: String }` (state.rs에서 이동 없이 필드만 교체)
  - `pub fn run_task_now(mgr, state, id) -> Result<Job, String>` — builtin이면 기존 routine 경로, 아니면 task 파일 읽어 `kind:"task"` enqueue. 공통: last_run[today] 기록, 오늘 missed 제거, once면 enabled=false 저장. enqueue 실패 시 상태 미변경(기존 규칙).
  - `pub fn dismiss_missed(mgr, state, key, run)` — entry.task_id로 run_task_now 재사용(run=true).
  - `tasks.rs`: `pub use crate::scheduler::ROUTINE_IDS;`로 교체(임시 const 삭제).

- [ ] **Step 1: 실패하는 테스트 추가** — scheduler tests에:

```rust
    #[test]
    fn collect_entries_merges_builtins_and_task_files() {
        let root = std::env::temp_dir().join(format!("sw-sched-{}", uuid::Uuid::new_v4()));
        crate::tasks::ensure_dirs(&root).unwrap();
        let scheds = config::Schedules::default(); // morning/lunch/evening 기본값
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
        assert_eq!(entries.len(), 5); // builtin 3 + 스케줄 있는 task 2 (수동 1개 제외)
        std::fs::remove_dir_all(&root).unwrap();
    }
```

주의: `collect_entries`는 enabled=false인 스케줄 작업도 포함한다(decide가 Idle 처리) — 단언은 5(builtin 3 + 스케줄 있는 task 2)이고 수동 작업 1개는 제외다.

- [ ] **Step 2: 구현** — state.rs MissedEntry 교체:

```rust
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissedEntry {
    /// "<task_id>-<date>"
    pub key: String,
    /// builtin ids: morning | lunch | evening. Old state files used `routine`.
    #[serde(alias = "routine")]
    pub task_id: String,
    #[serde(default)]
    pub title: String,
    pub date: String,
    pub scheduled_at: String,
}
```

scheduler.rs 전면 교체(핵심부):

```rust
pub const ROUTINE_IDS: [&str; 3] = ["morning", "lunch", "evening"];

pub struct SchedEntry {
    pub id: String,
    pub title: String,
    pub spec: SchedSpec,
    pub enabled: bool,
    pub builtin: bool,
    pub project: Option<String>,
}

fn builtin_title(id: &str) -> &'static str {
    match id { "morning" => "아침 브리핑", "lunch" => "오전 결산", _ => "퇴근 정산" }
}

fn parse_spec(s: &crate::tasks::Schedule) -> Option<SchedSpec> {
    let time = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
    let date = s.date.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let kind = match s.kind {
        crate::tasks::ScheduleKind::Daily => SchedKind::Daily,
        crate::tasks::ScheduleKind::Weekdays => SchedKind::Weekdays,
        crate::tasks::ScheduleKind::Once => SchedKind::Once,
    };
    Some(SchedSpec { kind, time, date })
}

fn collect_entries(scheds: &config::Schedules, root: &Path) -> Vec<SchedEntry> {
    let mut out = Vec::new();
    for id in ROUTINE_IDS {
        let s = match id { "morning" => &scheds.morning, "lunch" => &scheds.lunch, _ => &scheds.evening };
        let Some(spec) = (|| {
            let t = NaiveTime::parse_from_str(&s.time, "%H:%M").ok()?;
            Some(SchedSpec::daily(t))
        })() else { continue };
        out.push(SchedEntry { id: id.into(), title: builtin_title(id).into(), spec, enabled: s.enabled, builtin: true, project: None });
    }
    for def in crate::tasks::list_tasks(root) {
        let Some(s) = &def.schedule else { continue };
        let Some(spec) = parse_spec(s) else { continue };
        out.push(SchedEntry { id: def.id, title: def.title, spec, enabled: def.enabled, builtin: false, project: def.project });
    }
    out
}

fn req_for(e: &SchedEntry) -> JobRequest {
    if e.builtin {
        JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some(e.id.clone()), task_id: None }
    } else {
        JobRequest { kind: "task".into(), project: e.project.clone(), ids: None, routine: None, task_id: Some(e.id.clone()) }
    }
}

fn mark_ran(state: &AppState, id: &str, today: &str) {
    let mut st = state.state.lock();
    st.last_run.insert(id.into(), today.into());
    st.missed.retain(|m| !(m.task_id == id && m.date == today));
    state.save_state();
}

pub fn tick_once(mgr: &JobManager, state: &AppState, emit: &crate::jobs::EmitFn, booted_at: DateTime<Local>) {
    let view = config::load_view();
    let root = crate::tasks::workbench_root();
    let _ = crate::tasks::ensure_dirs(&root);
    crate::tasks::process_inbox(&root, &Local::now().format("%Y-%m-%d").to_string());
    if view.vault_path.is_empty() { return; }
    let today = Local::now().format("%Y-%m-%d").to_string();
    let now = Local::now();
    let mut changed = false;
    let mut missed_events: Vec<MissedEntry> = Vec::new();

    for e in collect_entries(&view.dashboard.schedules, &root) {
        let last = state.state.lock().last_run.get(&e.id).cloned();
        match decide(now, &e.spec, e.enabled, last.as_deref(), &today, booted_at) {
            Decision::Idle => {}
            Decision::Run => {
                if mgr.enqueue(req_for(&e)).is_ok() {
                    mark_ran(state, &e.id, &today);
                    changed = true;
                    if !e.builtin {
                        if let Ok(mut def) = crate::tasks::get_task(&root, &e.id) {
                            let once_done = def.schedule.as_ref()
                                .map(|s| s.kind == crate::tasks::ScheduleKind::Once).unwrap_or(false);
                            if once_done && def.enabled {
                                def.enabled = false;
                                def.updated_at = crate::tasks::now_iso();
                                let _ = crate::tasks::save_task(&root, &def);
                            }
                        }
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
                    changed = true;
                }
            }
        }
    }
    if changed { state.save_state(); }
    for m in missed_events { emit("schedule-missed", &json!({ "missed": m })); }
}

pub fn run_task_now(mgr: &JobManager, state: &AppState, id: &str) -> Result<crate::jobs::Job, String> {
    let root = crate::tasks::workbench_root();
    let today = Local::now().format("%Y-%m-%d").to_string();
    let req = if ROUTINE_IDS.contains(&id) {
        JobRequest { kind: "routine".into(), project: None, ids: None, routine: Some(id.into()), task_id: None }
    } else {
        let def = crate::tasks::get_task(&root, id)?;
        JobRequest { kind: "task".into(), project: def.project.clone(), ids: None, routine: None, task_id: Some(id.into()) }
    };
    let job = mgr.enqueue(req)?; // enqueue BEFORE mutating state (기존 규칙)
    mark_ran(state, id, &today);
    if !ROUTINE_IDS.contains(&id) {
        if let Ok(mut def) = crate::tasks::get_task(&root, id) {
            let once = def.schedule.as_ref().map(|s| s.kind == crate::tasks::ScheduleKind::Once).unwrap_or(false);
            if once && def.enabled {
                def.enabled = false;
                def.updated_at = crate::tasks::now_iso();
                let _ = crate::tasks::save_task(&root, &def);
            }
        }
    }
    Ok(job)
}

pub fn dismiss_missed(mgr: &JobManager, state: &AppState, key: &str, run: bool) -> Result<Vec<MissedEntry>, String> {
    let found = {
        let st = state.state.lock();
        st.missed.iter().find(|m| m.key == key).cloned()
    };
    let Some(entry) = found else { return Err("해당 알림이 없습니다".into()); };
    if run {
        run_task_now(mgr, state, &entry.task_id)?;
    }
    {
        let mut st = state.state.lock();
        st.missed.retain(|m| m.key != key);
        state.save_state();
    }
    Ok(state.state.lock().missed.clone())
}
```

`run_routine_now`/구 `schedule_time`/구 decide 시그니처 사용처 제거. `tasks.rs` 임시 const 삭제 후 `pub use crate::scheduler::ROUTINE_IDS;`.

- [ ] **Step 3: 전체 Rust 테스트** — `cargo test` (기존 jobs/state 테스트 포함 회귀). MissedEntry를 쓰는 scheduler 테스트가 `routine:` 필드명으로 초기화하면 `task_id:`+`title:`로 교체.
- [ ] **Step 4: 커밋**

```bash
git add dashboard/src-tauri/src/scheduler.rs dashboard/src-tauri/src/state.rs dashboard/src-tauri/src/tasks.rs
git commit -m "feat(dashboard): unified task scheduling and missed cards" -- dashboard/src-tauri/src/scheduler.rs dashboard/src-tauri/src/state.rs dashboard/src-tauri/src/tasks.rs
```

### Task 5: `jobs.rs` — kind:"task" arm

**Files:**
- Modify: `dashboard/src-tauri/src/jobs.rs:107-114` (JobRequest에 task_id) 및 `build_job` match(327행 영역)에 arm 추가
- Test: jobs.rs 기존 tests 모듈에 케이스 추가

**Interfaces:**
- Consumes: `tasks::{workbench_root, get_task}`.
- Produces: `JobRequest { ..., #[serde(default)] pub task_id: Option<String> }`, `build_job`의 `"task"` arm → `label = def.title`, `prompt = def.prompt`, `cwd = 프로젝트 경로 → 볼트 폴백`(design/implement arm 336-341행과 동일 탐색).

- [ ] **Step 1: 실패하는 테스트** — jobs tests에 fixture task 파일을 만들고 build_job 호출:

```rust
    #[test]
    fn build_job_task_uses_prompt_and_project_cwd() {
        // fixture: config view with one project + a task file targeting it
        // (jobs tests의 기존 view/state fixture 재사용 — 프로젝트 path는 temp dir)
        let root = std::env::temp_dir().join(format!("sw-job-{}", uuid::Uuid::new_v4()));
        crate::tasks::ensure_dirs(&root).unwrap();
        let mut def = crate::tasks::TaskDef {
            id: "t-20260905-gggg".into(), title: "야간 빌드".into(), prompt: "빌드해라".into(),
            project: Some("사업A".into()), ..crate::tasks::TaskDef::default()
        };
        crate::tasks::save_task(&root, &def).unwrap();
        def.project = None; def.id = "t-20260905-hhhh".into();
        crate::tasks::save_task(&root, &def).unwrap();
        // view는 이 모듈 테스트의 기존 헬퍼로 구성 (projects: [사업A → /tmp/projA], vault_path: /tmp/vault)
        let view = fixture_view_with_project("/tmp/projA", "/tmp/vault");
        let opts = SpawnOpts::from(&view);
        let state = fixture_state();
        let req = JobRequest { kind: "task".into(), project: None, ids: None, routine: None, task_id: Some("t-20260905-gggg".into()) };
        let job = build_job(req, &opts, &view, &state).unwrap();
        assert_eq!(job.label, "야간 빌드");
        assert_eq!(job.prompt, "빌드해라");
        assert_eq!(job.cwd, "/tmp/projA");
        let req2 = JobRequest { kind: "task".into(), project: None, ids: None, routine: None, task_id: Some("t-20260905-hhhh".into()) };
        assert_eq!(build_job(req2, &opts, &view, &state).unwrap().cwd, "/tmp/vault");
        assert!(build_job(JobRequest { kind: "task".into(), project: None, ids: None, routine: None, task_id: Some("없음".into()) }, &opts, &view, &state).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
```

주의: build_job이 스토어를 `tasks::workbench_root()`(실제 홈)에서 읽으면 테스트가 못 한다. `build_job`은 스토어 루트를 인자로 받지 않으므로, task arm이 읽는 위치를 주입 가능하게 한다: `pub(crate) static TASKS_ROOT_OVERRIDE: OnceLock<PathBuf>`를 tasks.rs에 두고 `workbench_root()`가 override를 우선 반환(테스트에서 세팅, 프로덕션에서는 None). jobs 테스트의 `fixture_view_with_project`/`fixture_state`는 이 모듈 테스트의 기존 fixture 스타일을 따라 작성(없으면 인라인 구성).

- [ ] **Step 2: 구현** — JobRequest에 `#[serde(default)] pub task_id: Option<String>,` 추가. build_job match에:

```rust
        "task" => {
            let task_id = req.task_id.clone().ok_or("작업 ID가 지정되지 않았습니다")?;
            let def = crate::tasks::get_task(&crate::tasks::workbench_root(), &task_id)?;
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            let cwd = def
                .project
                .as_deref()
                .and_then(|name| view.projects.iter().find(|p| p.name == name))
                .and_then(|p| (!p.path.is_empty()).then(|| p.path.clone()))
                .unwrap_or_else(|| view.vault_path.clone());
            Ok(Job { label: def.title, prompt: def.prompt, cwd, ..base })
        }
```

모든 기존 JobRequest 생성부(routine/design/implement/excel)에 `task_id: None` 추가 — 컴파일러가 전부 알려준다.
- tasks.rs에 `pub(crate) static TASKS_ROOT_OVERRIDE: std::sync::OnceLock<std::path::PathBuf>` 추가 — `workbench_root()`는 override가 Some이면 그것을 반환한다(테스트가 스토어 위치를 주입, 프로덕션은 None).
- [ ] **Step 3: 테스트 통과** — `cargo test jobs::`.
- [ ] **Step 4: 커밋**

```bash
git add dashboard/src-tauri/src/jobs.rs dashboard/src-tauri/src/tasks.rs
git commit -m "feat(dashboard): task job kind" -- dashboard/src-tauri/src/jobs.rs dashboard/src-tauri/src/tasks.rs
```

### Task 6: watcher 확장 + commands + lib 와이어링

**Files:**
- Modify: `dashboard/src-tauri/src/watcher.rs` (start_path 일반화)
- Modify: `dashboard/src-tauri/src/commands.rs` (래퍼 추가)
- Modify: `dashboard/src-tauri/src/lib.rs` (tasks watcher 기동, tray를 run_task_now로, invoke_handler 등록)

**Interfaces:**
- Produces (Task 7 프론트가 소비하는 command JSON 계약):
  - `watcher::start_path(path: &Path, emit: EmitFn, event: &'static str, payload: serde_json::Value) -> Option<RecommendedWatcher>` — 기존 `start`는 이를 감싼다.
  - `commands::list_tasks(state) -> TasksView { builtin: TaskRow[], tasks: TaskRow[], pending: PendingRequest[], rejected: RejectedRequest[] }`, `TaskRow { def: TaskDef, lastRun: Option<String> }` — builtin은 `config::load_view().dashboard.schedules`에서 합성(id=morning 등, builtin:true, skill="sawhorse:<id>", prompt:"").
  - `commands::save_task(def: TaskDef) -> Result<(), String>` — `validate_new` + GUI 소스 저장(`source.kind="gui"`, 없던 id면 `new_id()`는 프론트가 아닌 백엔드에서: def.id 비었으면 채움), 승인 게이트 없음(사람이 직접 씀).
  - `commands::delete_task(id)`, `commands::set_task_enabled(id, enabled)`(enabled 저장+updated_at), `commands::run_task_now(id) -> Job`, `commands::approve_request(id: String)`, `commands::reject_request(id: String, reason: Option<String>)`, `commands::install_skill(target: String)`(Task 8), `commands::skill_status()`(Task 8) — approve/reject 후 스토어 변화이므로 프론트가 `tasks-changed` 이벤트를 수신해 재조회. 승인/거부 시 `emit("tasks-changed", {})`도 호출.

- [ ] **Step 1: watcher.rs 일반화** — 기존 start 본문을 start_path로 이동:

```rust
pub fn start(vault: &str, emit: EmitFn) -> Option<RecommendedWatcher> {
    if vault.is_empty() { return None; }
    start_path(
        std::path::Path::new(vault),
        emit,
        "vault-changed",
        serde_json::json!({"areas": ["improvements", "todos", "docs"]}),
    )
}

pub fn start_path(path: &std::path::Path, emit: EmitFn, event: &'static str, payload: serde_json::Value) -> Option<RecommendedWatcher> {
    // (기존 start의 watcher·스레드 본문 그대로. emit 지점만:)
    //   emit(event, &payload);
}
```

- [ ] **Step 2: commands.rs 래퍼 작성** — 기존 래퍼 스타일 그대로:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    pub def: crate::tasks::TaskDef,
    pub last_run: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksView {
    pub builtin: Vec<TaskRow>,
    pub tasks: Vec<TaskRow>,
    pub pending: Vec<crate::tasks::PendingRequest>,
    pub rejected: Vec<crate::tasks::RejectedRequest>,
}

fn builtin_rows(view: &config::ConfigView) -> Vec<TaskRow> {
    let s = &view.dashboard.schedules;
    [("morning", &s.morning, "아침 브리핑"), ("lunch", &s.lunch, "오전 결산"), ("evening", &s.evening, "퇴근 정산")]
        .into_iter()
        .map(|(id, sched, title)| TaskRow {
            last_run: None, // 아래에서 채움
            def: crate::tasks::TaskDef {
                id: id.into(), title: title.into(),
                skill: Some(format!("sawhorse:{id}")),
                builtin: true, enabled: sched.enabled,
                schedule: Some(crate::tasks::Schedule { kind: crate::tasks::ScheduleKind::Daily, time: sched.time.clone(), date: None }),
                source: crate::tasks::Source { kind: "builtin".into(), agent: None, request: None },
                ..crate::tasks::TaskDef::default()
            },
        })
        .collect()
}

#[tauri::command]
pub fn list_tasks(state: State<'_, Arc<AppState>>) -> TasksView {
    let root = tasks::workbench_root();
    let _ = tasks::ensure_dirs(&root);
    tasks::process_inbox(&root, &chrono::Local::now().format("%Y-%m-%d").to_string());
    let view = config::load_view();
    let mut builtin = builtin_rows(&view);
    {
        let st = state.state.lock();
        for row in &mut builtin {
            row.last_run = st.last_run.get(&row.def.id).cloned();
        }
    }
    let tasks_list: Vec<TaskRow> = {
        let st = state.state.lock();
        tasks::list_tasks(&root).into_iter()
            .map(|def| TaskRow { last_run: st.last_run.get(&def.id).cloned(), def })
            .collect()
    };
    TasksView { builtin, tasks: tasks_list, pending: tasks::list_pending(&root), rejected: tasks::list_rejected(&root) }
}

#[tauri::command]
pub fn save_task(mut def: crate::tasks::TaskDef) -> Result<crate::tasks::TaskDef, String> {
    let root = tasks::workbench_root();
    let _ = tasks::ensure_dirs(&root);
    if def.id.is_empty() { def.id = tasks::new_id(); }
    def.builtin = false;
    def.skill = None;
    def.source.kind = "gui".into();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    tasks::validate_new(&def, &today)?;
    def.updated_at = tasks::now_iso();
    tasks::save_task(&root, &def)?;
    Ok(def)
}

#[tauri::command]
pub fn delete_task(id: String) -> Result<(), String> {
    if scheduler::ROUTINE_IDS.contains(&id.as_str()) {
        return Err("내장 작업은 삭제할 수 없습니다".into());
    }
    tasks::delete_task(&tasks::workbench_root(), &id)
}

#[tauri::command]
pub fn set_task_enabled(id: String, enabled: bool) -> Result<(), String> {
    let root = tasks::workbench_root();
    if scheduler::ROUTINE_IDS.contains(&id.as_str()) {
        // builtin: config.json schedules.<id>.enabled 토글 (기존 설정 정본 유지)
        return config::save_patch(&serde_json::json!({
            "dashboard": { "schedules": { id: { "enabled": enabled } } }
        }))
        .map(|_| ());
    }
    let mut def = tasks::get_task(&root, &id)?;
    def.enabled = enabled;
    def.updated_at = tasks::now_iso();
    tasks::save_task(&root, &def)
}

#[tauri::command]
pub fn run_task_now(id: String, mgr: State<'_, Arc<JobManager>>, state: State<'_, Arc<AppState>>) -> Result<Job, String> {
    scheduler::run_task_now(&mgr, &state, &id)
}

#[tauri::command]
pub fn approve_request(id: String) -> Result<crate::tasks::TaskDef, String> {
    let root = tasks::workbench_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let agent = {
        // 요청 파일의 agent 필드를 승인 주체로 기록
        tasks::list_pending(&root).into_iter().find(|p| p.id == id).map(|p| p.agent).unwrap_or_default()
    };
    tasks::approve_request(&root, &id, &agent, &today)
}

#[tauri::command]
pub fn reject_request(id: String, reason: Option<String>) -> Result<(), String> {
    tasks::reject_request(&tasks::workbench_root(), &id, reason.as_deref().unwrap_or("사유 없음"))
}
```

주의: `set_task_enabled`의 config 패치 키 경로는 기존 `save_patch`가 중첩 병합을 지원하는지 확인(config.rs save_patch_at 265-371행 — 중첩 patch 병합 구현 확인 후, 미지원이면 `{"dashboard":{"schedules":{...}}}` 전체 대신 SettingsPage가 쓰는 기존 패치 형태를 따른다). `approve_request`의 `state` 인자는 쓰지 않으면 제거(래퍼 시그니처 최소화). 컴파일 경고 zero 목표.

- [ ] **Step 3: lib.rs 와이어링** — (a) invoke_handler에 `commands::list_tasks, commands::save_task, commands::delete_task, commands::set_task_enabled, commands::run_task_now, commands::approve_request, commands::reject_request` 추가. (b) 기존 `commands::run_routine_now`·`commands::list_missed`·`commands::dismiss_missed`는 유지하되 `run_routine_now` 명령은 제거(프론트 Task 7에서 runTaskNow로 일원화 — clean cutover). (c) setup에서 watcher 추가:

```rust
            // watch the task store for agent inbox activity
            {
                let root = tasks::workbench_root();
                let _ = tasks::ensure_dirs(&root);
                if let Some(w) = watcher::start_path(&tasks::tasks_dir(&root), emit_fn.clone(), "tasks-changed", serde_json::json!({})) {
                    if let Some(keeper) = app.try_state::<WatchKeeper>() {
                        keeper.0.lock().push(Box::new(w));
                    } else {
                        app.manage(WatchKeeper(Mutex::new(vec![Box::new(w)])));
                    }
                }
            }
```

(d) tray 메뉴 핸들러 114행 `scheduler::run_routine_now(...)` → `scheduler::run_task_now(...)`. (e) `scheduler::start_tick`의 tick이 process_inbox를 하므로 별도 루프 불필요.
- [ ] **Step 4: cargo check + 전체 테스트** — `cargo check && cargo test`. 경고 0.
- [ ] **Step 5: 커밋**

```bash
git add dashboard/src-tauri/src/watcher.rs dashboard/src-tauri/src/commands.rs dashboard/src-tauri/src/lib.rs
git commit -m "feat(dashboard): task commands and inbox watcher wiring" -- dashboard/src-tauri/src/watcher.rs dashboard/src-tauri/src/commands.rs dashboard/src-tauri/src/lib.rs
```

### Task 7: 프론트 타입·api·store·NAV

**Files:**
- Modify: `dashboard/src/lib/types.ts` (신규 타입 + MissedRoutine→MissedEntry + JobRequest.taskId + JobKind "task")
- Modify: `dashboard/src/lib/api.ts` (api 함수 + EVENTS.tasksChanged)
- Modify: `dashboard/src/lib/store.ts` (PageId "tasks", missed 타입 교체)
- Modify: `dashboard/src/App.tsx` (NAV: tasks 추가, jobs 라벨 "작업"→"잡")

**Interfaces:**
- Consumes: Task 6 command JSON 계약.
- Produces: Task 8 TasksPage와 Task 9 HomePage가 소비하는 타입.

- [ ] **Step 1: types.ts** — 추가/교체:

```ts
export type ScheduleKind = "daily" | "weekdays" | "once";

export interface TaskSchedule { kind: ScheduleKind; time: string; date?: string | null }

export interface TaskSource { kind: string; agent?: string | null; request?: string | null }

export interface TaskDef {
  id: string;
  title: string;
  prompt: string;
  schedule: TaskSchedule | null;
  enabled: boolean;
  builtin: boolean;
  skill: string | null;
  project: string | null;
  source: TaskSource;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRow { def: TaskDef; lastRun: string | null }

export interface PendingTaskRequest {
  id: string;
  op: "create" | "update" | "pause" | "resume" | "delete";
  agent: string;
  note: string;
  targetTitle: string;
  summary: string[];
  duplicateOf: string | null;
}

export interface RejectedRequest { id: string; error: string }

export interface TasksView {
  builtin: TaskRow[];
  tasks: TaskRow[];
  pending: PendingTaskRequest[];
  rejected: RejectedRequest[];
}

/** Generalized missed card. Old field name `routine` is aliased server-side. */
export interface MissedEntry {
  key: string;
  taskId: string;
  title: string;
  date: string;
  scheduledAt: string;
}
```

기존 `MissedRoutine` 인터페이스(226-231행 영역)는 삭제하고 사용처를 `MissedEntry`로(store.ts 9행·29행 등). `JobKind` 유니언(156-163행)에 `| "task"` 추가. `JobRequest`(165-170행)에 `taskId?: string | null` 추가. `RoutineName` 타입(125행)은 유지(홈 위젯 라벨용).

- [ ] **Step 2: api.ts** — 추가:

```ts
  listTasks: (): Promise<TasksView> => invoke("list_tasks"),
  saveTask: (def: TaskDef): Promise<TaskDef> => invoke("save_task", { def }),
  deleteTask: (id: string): Promise<void> => invoke("delete_task", { id }),
  setTaskEnabled: (id: string, enabled: boolean): Promise<void> =>
    invoke("set_task_enabled", { id, enabled }),
  runTaskNow: (id: string): Promise<Job> => invoke("run_task_now", { id }),
  approveTaskRequest: (id: string): Promise<TaskDef> => invoke("approve_request", { id }),
  rejectTaskRequest: (id: string, reason?: string): Promise<void> =>
    invoke("reject_request", { id, reason: reason ?? null }),
```

runRoutineNow(59행)·dismissMissed는 유지(dismiss는 그대로, runRoutineNow는 삭제 — HomePage가 runTaskNow로 전환). EVENTS에 `tasksChanged: "tasks-changed"` 추가.

- [ ] **Step 3: store.ts** — `PageId`에 `"tasks"`(17행). `missed: MissedEntry[]` 타입 교체. refreshMissed는 그대로(list_missed 응답이 새 필드명).
- [ ] **Step 4: App.tsx** — NAV(29-38행): `{ id: "jobs", label: "잡", ... }` 라벨 교체, `{ id: "tasks", label: "작업", icon: CalendarClock }`을 jobs 뒤에 추가(CalendarClock import). body switch(55-74행)에 `case "tasks": return <TasksPage />;` + import. **TasksPage가 Task 8에서 생기기 전까지는 tsc가 실패하므로, 이 태스크에서 TasksPage를 최소 스텁(`export default function TasksPage(){ return null }`)으로 생성**하고 Task 8이 대체한다.
- [ ] **Step 5: tsc 확인** — `cd dashboard && npx tsc --noEmit` → 통과(HomePage가 아직 MissedRoutine 필드를 쓰면 Task 9 전까지 컴파일 에러 → 이 태스크에서 HomePage의 `item.routine` 2곳(287, 498행)을 `item.taskId`로, `MissedRoutine` import를 `MissedEntry`로만 선교체한다. label 폴백은 Task 9에서 title 기반으로 개선).

수정(287행): `const label = ROUTINES.find((r) => r.key === item.taskId)?.label ?? item.taskId;`
수정(498행): `(item) => item.taskId === routine.key && item.date === today`

- [ ] **Step 6: tsc 재확인 후 커밋**

```bash
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts dashboard/src/lib/store.ts dashboard/src/App.tsx dashboard/src/pages/TasksPage.tsx dashboard/src/pages/HomePage.tsx
git commit -m "feat(dashboard): task types, api and navigation" -- dashboard/src/lib/types.ts dashboard/src/lib/api.ts dashboard/src/lib/store.ts dashboard/src/App.tsx dashboard/src/pages/TasksPage.tsx dashboard/src/pages/HomePage.tsx
```

### Task 8: TasksPage

**Files:**
- Modify: `dashboard/src/pages/TasksPage.tsx` (스텁을 실제 페이지로 교체)

**Interfaces:**
- Consumes: Task 7 타입·api, `common.tsx`의 `PageHeader`/`Empty`, ui(card/button/badge/dialog/input/select/switch/textarea — textarea는 ui에 없으면 `<textarea className="...">` 네이티브 사용).
- Produces: 없음(말단 페이지).

- [ ] **Step 1: 페이지 구현** — 전체 교체:

```tsx
// TasksPage — approved tasks (builtin + user), pending agent requests, manual tasks.
import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { api, EVENTS } from "@/lib/api";
import type { ScheduleKind, TaskDef, TaskRow, TasksView } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Empty, PageHeader, WARN_TEXT } from "./common";

const OP_KO: Record<string, string> = {
  create: "생성", update: "수정", pause: "일시정지", resume: "재개", delete: "삭제",
};

function scheduleLabel(t: TaskDef): string {
  const s = t.schedule;
  if (!s) return "수동";
  const kind: Record<ScheduleKind, string> = { daily: "매일", weekdays: "평일", once: s.date ?? "" };
  return `${kind[s.kind]} ${s.time}`;
}

export default function TasksPage() {
  const [view, setView] = useState<TasksView | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TaskDef | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => setView(await api.listTasks()), []);
  useEffect(() => {
    void refresh();
    let un: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen(EVENTS.tasksChanged, () => void refresh()).then((u) => (un = u)),
    );
    return () => un?.();
  }, [refresh]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); await refresh(); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="작업" desc="예약·수동 작업을 등록하고 에이전트 요청을 승인합니다.">
        <Button size="sm" onClick={() => { setEditing(null); setOpen(true); }}>
          <Plus /> 작업 추가
        </Button>
      </PageHeader>

      {view && view.pending.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">승인대기 · {view.pending.length}건</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {view.pending.map((p) => (
              <div key={p.id} className="rounded-xl border bg-muted/15 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{OP_KO[p.op] ?? p.op}</Badge>
                  <span className="text-[13px] font-semibold">{p.targetTitle}</span>
                  <Badge variant="outline">{p.agent || "agent"}</Badge>
                  {p.duplicateOf && <Badge variant="warning">중복 의심 · {p.duplicateOf}</Badge>}
                </div>
                {p.note && <p className="mt-1 text-xs text-muted-foreground">비고: {p.note}</p>}
                {p.summary.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                    {p.summary.map((s, i) => <li key={i}>{s}</li>)}
                  </ul>
                )}
                <div className="mt-2 flex gap-2">
                  <Button size="sm" disabled={busy} onClick={() => void guard(() => api.approveTaskRequest(p.id))}>승인</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void guard(() => api.rejectTaskRequest(p.id))}>거부</Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {view && view.rejected.length > 0 && (
        <Card>
          <CardHeader><CardTitle className={`text-sm ${WARN_TEXT}`}>반려됨 · {view.rejected.length}건</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {view.rejected.map((r) => (
              <div key={r.id} className="text-xs text-muted-foreground">
                <span className="font-mono">{r.id}</span> — {r.error}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">예약 작업</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {view && [...view.builtin, ...view.tasks].length === 0 && <Empty>등록된 작업이 없습니다.</Empty>}
          {view && [...view.builtin, ...view.tasks.filter((r) => r.def.schedule)].map((row) => (
            <TaskLine key={row.def.id} row={row} busy={busy} guard={guard}
              onEdit={row.def.builtin ? undefined : (d) => { setEditing(d); setOpen(true); }} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">수동 작업</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {view && view.tasks.filter((r) => !r.def.schedule).length === 0 && <Empty>수동 작업이 없습니다.</Empty>}
          {view && view.tasks.filter((r) => !r.def.schedule).map((row) => (
            <TaskLine key={row.def.id} row={row} busy={busy} guard={guard}
              onEdit={(d) => { setEditing(d); setOpen(true); }} />
          ))}
        </CardContent>
      </Card>

      <TaskDialog open={open} setOpen={setOpen} editing={editing} busy={busy} guard={guard} />
    </div>
  );
}

function TaskLine({ row, busy, guard, onEdit }: {
  row: TaskRow;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  onEdit?: (def: TaskDef) => void;
}) {
  const t = row.def;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/15 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{t.title}</span>
          {t.builtin && <Badge variant="outline">내장</Badge>}
          {!t.enabled && <Badge variant="warning">꺼짐</Badge>}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {scheduleLabel(t)}{row.lastRun ? ` · 마지막 실행 ${row.lastRun}` : ""}
        </p>
      </div>
      <Switch checked={t.enabled} disabled={busy}
        onCheckedChange={(v) => void guard(() => api.setTaskEnabled(t.id, v))} />
      <Button size="icon" variant="ghost" className="size-8" disabled={busy}
        title="지금 실행" onClick={() => void guard(() => api.runTaskNow(t.id))}>
        <Play />
      </Button>
      {onEdit && (
        <Button size="icon" variant="ghost" className="size-8" title="편집" onClick={() => onEdit(t)}>
          <Pencil />
        </Button>
      )}
      {!t.builtin && (
        <Button size="icon" variant="ghost" className="size-8" disabled={busy} title="삭제"
          onClick={() => void guard(() => api.deleteTask(t.id))}>
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function TaskDialog({ open, setOpen, editing, busy, guard }: {
  open: boolean;
  setOpen: (v: boolean) => void;
  editing: TaskDef | null;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind | "none">("none");
  const [time, setTime] = useState("09:00");
  const [date, setDate] = useState("");

  useEffect(() => {
    if (!open) return;
    const d = editing;
    setTitle(d?.title ?? "");
    setPrompt(d?.prompt ?? "");
    setKind(d?.schedule?.kind ?? "none");
    setTime(d?.schedule?.time ?? "09:00");
    setDate(d?.schedule?.date ?? "");
  }, [open, editing]);

  const submit = async () => {
    const base: TaskDef = editing ?? {
      id: "", title: "", prompt: "", schedule: null, enabled: true, builtin: false,
      skill: null, project: null, source: { kind: "gui" }, createdAt: "", updatedAt: "",
    };
    const schedule = kind === "none" ? null
      : kind === "once" ? { kind, time, date } : { kind, time, date: null };
    await guard(async () => {
      const saved = await api.saveTask({ ...base, title, prompt, schedule });
      void saved;
    });
    setOpen(false);
  };

  const askAgent = () => {
    const scheduleText = kind === "none" ? "예약 없이 수동 작업으로"
      : kind === "once" ? `${date} ${time}에 1회 실행` : `${kind === "daily" ? "매일" : "평일마다"} ${time}에 실행`;
    const text = `워크벤치에 작업 만들어줘.\n제목: ${title || "(제목)"}\n내용: ${prompt || "(내용)"}\n주기: ${scheduleText}\n워크벤치 스킬 규격대로 승인 큐에 넣어줘.`;
    void navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "작업 편집" : "작업 추가"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input placeholder="제목" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className="min-h-40 w-full rounded-xl border bg-transparent p-3 text-sm"
            placeholder="무인 실행 프롬프트 (자기완결로 — 사용자 질문 없이 끝까지 실행되게)"
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <select className="rounded-lg border bg-transparent px-2 py-1 text-sm" value={kind}
              onChange={(e) => setKind(e.target.value as ScheduleKind | "none")}>
              <option value="none">수동</option>
              <option value="daily">매일</option>
              <option value="weekdays">평일</option>
              <option value="once">1회</option>
            </select>
            {kind !== "none" && (
              <Input type="time" className="w-28" value={time} onChange={(e) => setTime(e.target.value)} />
            )}
            {kind === "once" && (
              <Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
            )}
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" size="sm" onClick={askAgent}>
              <ClipboardCopy /> 에이전트에게 시키기
            </Button>
            <Button size="sm" disabled={busy || !title || !prompt} onClick={() => void submit()}>
              저장
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

참고: ui/textarea·ui/dialog-select가 없으면 네이티브 요소 사용(위 코드 기준). `Dialog` 임포트 경로는 기존 사용처(ImprovePage 등)에서 확인해 맞춘다. `CalendarClock` import는 App.tsx(NAV)에서 쓰고 이 파일에서는 미사용이면 제거.

- [ ] **Step 2: tsc + vite build** — `npx tsc --noEmit && npx vite build` → 통과.
- [ ] **Step 3: 커밋**

```bash
git add dashboard/src/pages/TasksPage.tsx
git commit -m "feat(dashboard): tasks page" -- dashboard/src/pages/TasksPage.tsx
```

### Task 9: HomePage 교체 정리

**Files:**
- Modify: `dashboard/src/pages/HomePage.tsx` (missed 라벨, onRun 경로)

**Interfaces:**
- Consumes: `MissedEntry`(taskId/title), `api.runTaskNow`.

- [ ] **Step 1: missed 카드 라벨을 title 기반으로** — 286-287행 교체:

```tsx
        const label = item.title || item.taskId;
```

287행의 기존 `ROUTINES.find(...)` 폴백은 제거(백엔드가 title을 채운다). 297행 ` {label} 루틴을 놓쳤습니다` → ` {label} 작업을 놓쳤습니다`.

- [ ] **Step 2: 루틴 카드 실행 경로** — HomePage의 onRun 핸들러(53-194행 내 `api.runRoutineNow(...)` 호출부)를 `api.runTaskNow(routine.key)`로 교체. api.ts에서 `runRoutineNow` 제거(Task 7에서 유지했다면 여기서 삭제).
- [ ] **Step 3: tsc + 스모크** — `npx tsc --noEmit` 통과.
- [ ] **Step 4: 커밋**

```bash
git add dashboard/src/pages/HomePage.tsx dashboard/src/lib/api.ts
git commit -m "feat(dashboard): missed cards and routine runs on unified task model" -- dashboard/src/pages/HomePage.tsx dashboard/src/lib/api.ts
```

### Task 10: 워크벤치 스킬 + 문서

**Files:**
- Create: `skills/workbench/SKILL.md`
- Modify: `docs/design.md` (스킬 표 193-220행 영역에 workbench 행 추가, "스킬 (12개...)" → 13개)

- [ ] **Step 1: SKILL.md 작성** —

```markdown
---
name: workbench
description: Use when the user asks to register or manage a scheduled task in the workbench — "워크벤치에 작업 만들어줘", "매일 아침 X 돌려줘", "작업 등록해줘", "workbench task", "예약 작업". 대화에서 제목·내용·주기를 파악해 sawhorse 대시보드의 승인 큐에 작업 생성 요청을 넣는다.
---

# workbench — 워크벤치 작업 등록

터미널 에이전트(너)가 sawhorse 대시보드에 예약 작업 생성을 요청하는 스킬이다.
**너는 정식 작업을 만들 수 없다.** 승인 큐(inbox)에 요청을 넣을 뿐이고, 사람이
대시보드에서 승인해야 작업이 태어나고 스케줄이 가동된다.

## 경로

스토어 루트: `%USERPROFILE%\.claude\sawhorse\` (Windows) / `~/.claude/sawhorse/` (macOS·Linux).
아래 표기는 `<ROOT>`로 줄인다.

| 위치 | 용도 | 너의 권한 |
|---|---|---|
| `<ROOT>/tasks/*.json` | 승인된 작업 정의 | **읽기만** — 절대 생성·수정 금지 |
| `<ROOT>/tasks/inbox/` | 생성 요청 대기 큐 | 요청 파일 **작성** |
| `<ROOT>/tasks/inbox/rejected/` | 반려된 요청 + 사유 | **읽기만** — 재제출 전 사유 확인 |
| `<ROOT>/config.json` | 플러그인 설정 | 손대지 않는다 |

## 절차

1. **요청 파악** — 대화에서 제목·무엇을 할지·주기를 끌어낸다. 사용자가 모호하게 말하면 여기서만 질문한다(이 스킬은 대화형 실행이다).
2. **기존 스킬 우선** — 요청이 기존 스킬로 커버되면 prompt는 그 스킬의 실행 지시 한 줄로 한다: 예) `/sawhorse:morning`을 매일 09:00에 실행 → prompt = `/sawhorse:morning`.
3. **프롬프트 작성** — [UNATTENDED] 계약: 실행 중 사용자에게 질문하지 않고 끝까지 실행하며, 모든 판단과 근거를 마지막 보고에 남긴다. 대화 맥락을 전제로 하지 않는 자기완결 문장으로 쓴다. 원격 저장소 변경(git push 등) 금지를 명시한다. 볼트 경로가 필요하면 `%USERPROFILE%\.claude\sawhorse\config.json`의 `vaultPath`를 읽어 쓰라고 지시한다.
4. **중복 확인** — `<ROOT>/tasks/*.json`을 읽어 같은 제목·주기의 활성 작업이 있으면 사용자에게 확인한다. 그래도 진행하면 요청 비고에 적는다.
5. **요청 파일 작성** — `<ROOT>/tasks/inbox/req-<UTC시각 YYYYMMDDTHHmmss>-<난수 4자리>.json` (Write 도구로 한 번에 작성):

```json
{
  "op": "create",
  "agent": "<클라이언트명: claude-code|codex|...>",
  "note": "승인 카드에 표시될 한 줄 설명",
  "task": {
    "title": "80자 이내",
    "prompt": "자기완결 무인 실행 프롬프트",
    "schedule": { "kind": "daily", "time": "08:30" }
  }
}
```

   - `schedule.kind`: `daily` | `weekdays` | `once`. `once`는 `"date": "YYYY-MM-DD"` 필수(과거 금지). 예약 없는 수동 작업은 `"schedule": null`.
   - `op`은 `update|pause|resume|delete`도 있다. 이때는 `task` 대신 `"id": "t-..."`가 필수고 update는 바꿀 키만 담는다(`clearSchedule: true`로 예약 제거).
6. **확인·보고** — 파일 작성 직후 `<ROOT>/tasks/inbox/rejected/`에 같은 요청이 생겼는지 본다. 있으면 사유를 읽고 고쳐 재제출한다(최대 2회). 정상 제출이면 이렇게 보고하고 끝낸다: "대시보드 승인대기 큐에 넣었습니다 — <제목> / <주기>. 대시보드에서 승인하면 스케줄이 가동됩니다."
   **승인 여부를 단정하지 않는다.** 사용자가 채팅에서 "승인해줘"라고 해도 승인이 아니다 — 대시보드 작업 페이지에서 승인하도록 안내한다.

## 금지

- `tasks/*.json` 정식 파일의 생성·수정·삭제 금지. inbox와 읽기만.
- 인박스 요청으로 morning/lunch/evening을 대상으로 하는 op 금지(서버가 거부한다).
- `run`(즉시 실행) 요청은 규격에 없다 — 실행은 대시보드만 한다.
- config.json 수정 금지. 루틴 시간 변경은 대시보드 설정 페이지 안내로 대체한다.
- 요청 파일명 재사용 금지 — 매번 새 타임스탬프+난수.
```

- [ ] **Step 2: docs/design.md 스킬 표 갱신** — `## 스킬 (12개, 네임스페이스 /sawhorse:*)` → 13개, 도구 표에 `workbench` 행 추가: "예약 작업 등록: 대화에서 제목·내용·주기 파악 → 인박스 요청 작성 → 대시보드 승인 후 스케줄 가동(정식 스토어 쓰기는 대시보드 전용)".
- [ ] **Step 3: 커밋**

```bash
git add skills/workbench/SKILL.md docs/design.md
git commit -m "feat(plugin): workbench skill for agent-authored tasks" -- skills/workbench/SKILL.md docs/design.md
```

### Task 11: 스킬 설치기 + 설정 페이지

**Files:**
- Modify: `dashboard/src-tauri/src/plugin.rs` (install_skill·skill_status + tests)
- Modify: `dashboard/src-tauri/src/commands.rs` (래퍼 2개)
- Modify: `dashboard/src-tauri/src/lib.rs` (invoke_handler 2개 등록)
- Modify: `dashboard/src/pages/SettingsPage.tsx` (워크벤치 스킬 카드)

**Interfaces:**
- Consumes: `plugin::resolve_root()`, `plugin::read_skill`, Task 6 commands 패턴.
- Produces: `plugin::install_skill(target: &str) -> Result<SkillInstall, String>`, `SkillInstall { target, path, written }`(camelCase); `plugin::skill_status() -> Vec<SkillInstall>`(written=false = 미설치). commands: `install_skill(target: String)`, `skill_status()`.

- [ ] **Step 1: 실패하는 테스트** — plugin.rs tests에:

```rust
    #[test]
    fn install_skill_writes_claude_and_codex_variants() {
        // 홈 디렉터리를 흉내낼 수 있어야 한다: install_skill은 홈 유도를
        // config::config_path().ancestors() 대신 주입 가능한 fn으로:
        //   fn install_skill_at(home: &Path, root: &Path, target: &str)
        let home = tempdir("home");
        let repo = tempdir("repo");
        std::fs::create_dir_all(repo.join("skills/workbench")).unwrap();
        std::fs::write(repo.join("skills/workbench/SKILL.md"), "---\nname: workbench\ndescription: d\n---\n본문").unwrap();

        let s = install_skill_at(&home, &repo, "claude").unwrap();
        assert!(s.written);
        assert!(home.join(".claude/skills/workbench/SKILL.md").is_file());

        let c = install_skill_at(&home, &repo, "codex").unwrap();
        assert!(c.written);
        let codex = std::fs::read_to_string(home.join(".codex/prompts/workbench.md")).unwrap();
        assert!(!codex.starts_with("---")); // 프론트매터 제거 + 안내 헤더
        assert!(codex.contains("본문"));

        assert!(install_skill_at(&home, &repo, "unknown").is_err());
    }
```

- [ ] **Step 2: 구현** — plugin.rs에 추가:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    pub target: String,
    pub path: String,
    pub written: bool,
}

fn strip_frontmatter(text: &str) -> &str {
    let text = text.replace("\r\n", "\n");
    match text.strip_prefix("---\n") {
        Some(rest) => rest.find("\n---").map(|i| &rest[i + 4..]).unwrap_or(&text),
        None => &text,
    }
}

fn install_skill_at(home: &Path, root: &Path, target: &str) -> Result<SkillInstall, String> {
    let source = read_skill(root, "workbench")?;
    let (rel, body) = match target {
        "claude" => (".claude/skills/workbench/SKILL.md".to_string(), source),
        "codex" => (
            ".codex/prompts/workbench.md".to_string(),
            format!(
                "# workbench — 워크벤치 작업 등록 (사용자가 워크벤치 작업을 만들자고 하면 이 절차를 따른다)\n\n{}",
                strip_frontmatter(&source)
            ),
        ),
        _ => return Err(format!("알 수 없는 대상: {target} (claude|codex)")),
    };
    let dest = home.join(&rel);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("디렉터리 생성 실패: {e}"))?;
    }
    std::fs::write(&dest, body).map_err(|e| format!("스킬 설치 실패: {e}"))?;
    Ok(SkillInstall { target: target.into(), path: dest.display().to_string(), written: true })
}

pub fn install_skill(target: &str) -> Result<SkillInstall, String> {
    let root = resolve_root()?;
    let home = crate::config::config_path().ancestors().nth(2)
        .map(Path::to_path_buf)
        .ok_or("홈 디렉터리를 찾지 못했다")?;
    install_skill_at(&home, &root, target)
}

pub fn skill_status() -> Vec<SkillInstall> {
    let Ok(root) = resolve_root() else { return vec![] };
    let home = match crate::config::config_path().ancestors().nth(2) {
        Some(h) => h.to_path_buf(),
        None => return vec![],
    };
    ["claude", "codex"].into_iter().map(|t| {
        install_skill_at(&home, &root, t)
            .map(|mut s| { s.written = false; s }) // status 모드: 실제로는 덮어쓰지 않음
            .unwrap_or(SkillInstall { target: t.into(), path: String::new(), written: false })
    }).collect()
}
```

주의: 위 `skill_status` 초안은 쓰기를 유발한다 — 최종 구현은 `install_skill_at`을 `write: bool` 인자로 분리해 status에서는 파일 존재 여부만 검사한다:

```rust
fn skill_dest(home: &Path, target: &str) -> Result<PathBuf, String> {
    match target {
        "claude" => Ok(home.join(".claude/skills/workbench/SKILL.md")),
        "codex" => Ok(home.join(".codex/prompts/workbench.md")),
        _ => Err(format!("알 수 없는 대상: {target}")),
    }
}
// skill_status: skill_dest 존재 여부만 반환(written = 존재)
```

- [ ] **Step 3: commands + 등록** — commands.rs에 얇은 래퍼 2개, lib.rs invoke_handler에 추가.
- [ ] **Step 4: SettingsPage 카드** — 페이지 컴포넌트 하단에 카드 1개 추가(기존 페이지의 Card/배지 스타일 따름):

```tsx
function WorkbenchSkillCard() {
  const [status, setStatus] = useState<SkillInstall[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setStatus(await api.skillStatus()), []);
  useEffect(() => { void refresh(); }, [refresh]);
  const install = async (target: string) => {
    setBusy(true);
    try { await api.installSkill(target); await refresh(); } finally { setBusy(false); }
  };
  const label: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">워크벤치 스킬</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          터미널 에이전트에 &quot;워크벤치에 작업 만들어줘&quot;로 작업을 등록시키는 스킬을 설치한다.
        </p>
        {["claude", "codex"].map((t) => {
          const s = status?.find((x) => x.target === t);
          return (
            <div key={t} className="flex items-center gap-3">
              <span className="w-24 text-[13px] font-semibold">{label[t]}</span>
              <Badge variant={s?.written ? "success" : "outline"}>{s?.written ? "설치됨" : "미설치"}</Badge>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void install(t)}>설치</Button>
              {s?.path && <span className="truncate text-[10px] text-muted-foreground">{s.path}</span>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

types.ts에 `SkillInstall { target, path, written }`, api.ts에 `installSkill(target)`/`skillStatus()` 추가. `useCallback` import 확인.
- [ ] **Step 5: 테스트·빌드** — `cargo test plugin::` + `npx tsc --noEmit && npx vite build`.
- [ ] **Step 6: 커밋**

```bash
git add dashboard/src-tauri/src/plugin.rs dashboard/src-tauri/src/commands.rs dashboard/src-tauri/src/lib.rs dashboard/src/pages/SettingsPage.tsx dashboard/src/lib/types.ts dashboard/src/lib/api.ts
git commit -m "feat(dashboard): workbench skill installer" -- dashboard/src-tauri/src/plugin.rs dashboard/src-tauri/src/commands.rs dashboard/src-tauri/src/lib.rs dashboard/src/pages/SettingsPage.tsx dashboard/src/lib/types.ts dashboard/src/lib/api.ts
```

### Task 12: 전체 검증 + 스모크

- [ ] **Step 1: 전체 게이트** — `cd dashboard/src-tauri && cargo test` (기존 54 + 신규 전부 PASS, 경고 0), `cd dashboard && npx tsc --noEmit && npx vite build`.
- [ ] **Step 2: 부팅 스모크** — 실행 중 인스턴스 `pgrep -f sawhorse` 확인(single-instance 오탐 방지) 후 없으면 디버그 바이너리 기동, 수 초 생존 확인.
- [ ] **Step 3: 엔드투엔드 인박스 스모크** — 앱 실행 중:
  1. `~/.claude/sawhorse/tasks/inbox/req-smoke-0001.json` 작성: `{"op":"create","agent":"smoke","note":"스모크","task":{"title":"스모크 작업","prompt":"/sawhorse:daily-report","schedule":{"kind":"daily","time":"23:59"}}}`
  2. 작업 페이지에 승인대기 카드 표시 확인(≤20s).
  3. 승인 → 예약 작업 목록에 "스모크 작업" 표시 + `tasks/t-*.json` 생성 확인.
  4. "지금 실행" → 잡 페이지에 kind:task 잡 생성 확인 → 취소.
  5. 잘못된 요청 1개(`{"op":"create"}` 빈 task) 투입 → 반려됨 목록에 사유 표시 확인.
  6. 스모크 작업 삭제(archive 이동 확인) + 반려 파일 정리.
- [ ] **Step 4: 커밋(있다면) 및 최종 보고** — 워킹트리에 내 파일 잔여 없음 확인.

---

## Self-Review 기록 (계획 작성자 검증)

1. **스펙 커버리지**: 스토어 레이아웃·스키마→Task 1, 인박스 프로토콜(검증·반려·승인·모든 op 게이트)→Task 2·6, 스케줄러 통합(어댑터·decide 일반화·once·미싱)→Task 3·4, build_job kind:"task"→Task 5, 명령·이벤트·watcher·트레이→Task 6, 프론트 타입·api→Task 7, TasksPage(승인대기·예약·수동·다이얼로그·에이전트에게 시키기)→Task 8, HomePage 교체→Task 9, 스킬+문서→Task 10, 설치기(claude/codex)→Task 11, 검증→Task 12. 스펙 비목표(run op, cron, runner 오버라이드)는 구현하지 않음.
2. **플레이스홀더**: 없음 — 모든 코드 단계에 실제 코드 제공. jobs.rs 테스트의 fixture 헬퍼는 기존 테스트 모듈 재사용 지시(해당 모듈 내 실존 확인 후 사용).
3. **타입 일관성**: `ScheduleKind`(Rust lowercase serde)↔`ScheduleKind`(TS literal) 일치, `TaskRow{def,lastRun}`↔`TaskRow`, `PendingRequest.id`=파일 stem이며 approve/reject command가 같은 id 사용, `MissedEntry.taskId`(alias routine)↔TS `taskId`, `run_task_now`가 builtin/task 분기하며 tray·command·프론트가 동일 id 공간("morning" | "t-*") 사용.
