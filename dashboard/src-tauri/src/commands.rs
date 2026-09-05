// Tauri command layer. Thin wrappers: contract types live in config.rs / vault.rs / jobs.rs.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use crate::jobs::{Job, JobManager, JobRequest};
use crate::config;
use crate::scheduler;
use crate::state::{AppState, MissedEntry};
use crate::plugin;
use crate::tasks;
use crate::vault;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub frontmatter: Value,
    pub markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultNoteView {
    pub title: String,
    pub markdown: String,
}

fn empty_todos(date: String) -> vault::TodoSections {
    vault::TodoSections { date, today: vec![], tomorrow: vec![], file_exists: false }
}

#[tauri::command]
pub fn get_config() -> config::ConfigView {
    config::load_view()
}

#[tauri::command]
pub fn save_config(patch: Value) -> Result<config::ConfigView, String> {
    config::save_patch(&patch)
}

#[tauri::command]
pub async fn diagnostics() -> config::Diagnostics {
    let view = config::load_view();
    config::run_diagnostics(&view).await
}

#[tauri::command]
pub fn list_improvements(project: Option<String>) -> Vec<vault::ImprovementNote> {
    let view = config::load_view();
    let vault_path = Path::new(&view.vault_path);
    if view.vault_path.is_empty() {
        return vec![];
    }
    let configured: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    let names: Vec<String> = vault::project_pairs(vault_path, &configured)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    vault::scan_improvements(vault_path, project.as_deref(), &names)
}

/// Preferred issue-oriented command. `list_improvements` stays for older UI clients.
#[tauri::command]
pub fn list_issues(project: Option<String>) -> Vec<vault::ImprovementNote> {
    list_improvements(project)
}

#[tauri::command]
pub fn read_note(path: String) -> Result<NoteView, String> {
    let (frontmatter, markdown) = vault::read_note(Path::new(&path))?;
    Ok(NoteView { frontmatter, markdown })
}

#[tauri::command]
pub fn approve_note(path: String) -> Result<(), String> {
    vault::approve_note(Path::new(&path))
}

#[tauri::command]
pub fn approve_issue(path: String) -> Result<(), String> {
    approve_note(path)
}

#[tauri::command]
pub fn list_obsidian_vaults() -> Vec<vault::VaultCandidate> {
    vault::detect_obsidian_vaults()
}
#[tauri::command]
pub fn list_inbox_count(project: Option<String>) -> u64 {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return 0;
    }
    let configured: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    let pairs = vault::project_pairs(Path::new(&view.vault_path), &configured);
    vault::inbox_count(Path::new(&view.vault_path), &pairs, project.as_deref())
}

#[tauri::command]
pub fn list_unpromoted() -> Vec<vault::UnpromotedItem> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vec![];
    }
    let configured: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    let pairs = vault::project_pairs(Path::new(&view.vault_path), &configured);
    vault::list_unpromoted(Path::new(&view.vault_path), &pairs)
}

#[tauri::command]
pub fn audit_vault() -> vault::VaultAudit {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vault::VaultAudit {
            issues: vec![],
            journal: vault::JournalAudit { today_exists: false, missing: vec![] },
            scanned_at_ms: 0,
        };
    }
    let configured: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    let pairs = vault::project_pairs(Path::new(&view.vault_path), &configured);
    vault::audit_vault(Path::new(&view.vault_path), &pairs)
}

#[tauri::command]
pub fn list_todos() -> vault::TodoSections {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return empty_todos(chrono::Local::now().format("%Y-%m-%d").to_string());
    }
    vault::list_todos(Path::new(&view.vault_path))
}

#[tauri::command]
pub fn toggle_todo(section: String, index: usize, checked: bool) -> Result<(), String> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return Err("볼트 경로가 설정되지 않았습니다".into());
    }
    vault::toggle_todo(Path::new(&view.vault_path), &section, index, checked)
}

#[tauri::command]
pub fn add_todo(section: String, text: String) -> Result<(), String> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return Err("볼트 경로가 설정되지 않았습니다".into());
    }
    vault::add_todo(Path::new(&view.vault_path), &section, &text)
}

#[tauri::command]
pub fn list_vault_tree() -> Vec<vault::VaultNode> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vec![];
    }
    vault::vault_tree(Path::new(&view.vault_path))
}

#[tauri::command]
pub fn read_vault_note(rel: String) -> Result<VaultNoteView, String> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return Err("볼트 경로가 설정되지 않았습니다".into());
    }
    let (title, markdown) = vault::read_vault_note(Path::new(&view.vault_path), &rel)?;
    Ok(VaultNoteView { title, markdown })
}

#[tauri::command]
pub fn enqueue_job(req: JobRequest, mgr: State<'_, Arc<JobManager>>) -> Result<Job, String> {
    mgr.enqueue(req)
}

#[tauri::command]
pub async fn cancel_job(id: String, mgr: State<'_, Arc<JobManager>>) -> Result<(), String> {
    mgr.cancel(&id).await
}

/// Bring a herdr-run job's pane to the front (errors for headless jobs).
#[tauri::command]
pub async fn focus_job(id: String, mgr: State<'_, Arc<JobManager>>) -> Result<(), String> {
    mgr.focus(&id).await
}

/// Cheap runner check for the settings screen — `diagnostics` also shells out per
/// project, which is too slow to re-run while editing herdr options.
#[tauri::command]
pub async fn herdr_probe() -> config::HerdrDiag {
    let view = config::load_view();
    config::herdr_diagnostics(&view.dashboard.herdr).await
}

#[tauri::command]
pub fn list_jobs(state: State<'_, Arc<AppState>>) -> Vec<Job> {
    state.jobs.lock().clone()
}

#[tauri::command]
pub fn job_log(id: String, state: State<'_, Arc<AppState>>) -> Vec<String> {
    let path = state.log_path(&id);
    let Ok(content) = std::fs::read_to_string(path) else { return vec![] };
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let start = lines.len().saturating_sub(500);
    lines[start..].to_vec()
}

#[tauri::command]
pub fn job_report(id: String, state: State<'_, Arc<AppState>>) -> Option<String> {
    std::fs::read_to_string(state.report_path(&id)).ok()
}

#[tauri::command]
pub fn run_task_now(
    id: String,
    mgr: State<'_, Arc<JobManager>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Job, String> {
    scheduler::run_task_now(&mgr, &state, &id)
}

#[tauri::command]
pub fn list_missed(state: State<'_, Arc<AppState>>) -> Vec<MissedEntry> {
    scheduler::list_missed(&state)
}

#[tauri::command]
pub fn dismiss_missed(
    key: String,
    run: bool,
    mgr: State<'_, Arc<JobManager>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<MissedEntry>, String> {
    scheduler::dismiss_missed(&mgr, &state, &key, run)
}

// ---------- tasks (user-defined + builtin routines) ----------

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

/// The three config-defined routines rendered as TaskRows so the frontend can
/// treat builtin and user tasks uniformly. Not persisted — synthesized live.
fn builtin_rows(scheds: &config::Schedules) -> Vec<TaskRow> {
    [
        ("morning", &scheds.morning, "아침 브리핑"),
        ("lunch", &scheds.lunch, "오전 결산"),
        ("evening", &scheds.evening, "퇴근 정산"),
    ]
    .into_iter()
    .map(|(id, sched, title)| TaskRow {
        last_run: None,
        def: crate::tasks::TaskDef {
            id: id.into(),
            title: title.into(),
            skill: Some(format!("sawhorse:{id}")),
            builtin: true,
            enabled: sched.enabled,
            schedule: Some(crate::tasks::Schedule {
                kind: crate::tasks::ScheduleKind::Daily,
                time: sched.time.clone(),
                date: None,
            }),
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
    // refresh pending list from the agent inbox before reading it
    tasks::process_inbox(&root, &chrono::Local::now().format("%Y-%m-%d").to_string());
    let mut builtin = builtin_rows(&config::load_view().dashboard.schedules);
    let tasks_list: Vec<TaskRow> = {
        let st = state.state.lock();
        for row in &mut builtin {
            row.last_run = st.last_run.get(&row.def.id).cloned();
        }
        tasks::list_tasks(&root)
            .into_iter()
            .map(|def| TaskRow { last_run: st.last_run.get(&def.id).cloned(), def })
            .collect()
    };
    TasksView {
        builtin,
        tasks: tasks_list,
        pending: tasks::list_pending(&root),
        rejected: tasks::list_rejected(&root),
    }
}

/// GUI-authored save: no approval gate (a person wrote it). The backend owns id
/// assignment and forces gui source so agents can't be impersonated from here.
#[tauri::command]
pub fn save_task(mut def: crate::tasks::TaskDef) -> Result<crate::tasks::TaskDef, String> {
    if def.id.is_empty() {
        def.id = tasks::new_id();
    }
    def.builtin = false;
    def.skill = None;
    def.source.kind = "gui".into();
    // same protection as delete_task: a user task shadowing "morning" etc.
    // would collide with the builtin routine's state and be undeletable
    if scheduler::ROUTINE_IDS.contains(&def.id.as_str()) {
        return Err("내장 작업 ID는 사용할 수 없습니다".into());
    }
    let root = tasks::workbench_root();
    let _ = tasks::ensure_dirs(&root);
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    tasks::validate_new(&def, &today)?;
    def.updated_at = tasks::now_iso();
    if def.created_at.is_empty() {
        def.created_at = tasks::now_iso();
    }
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
        // builtin: toggle config.json schedules.<id>.enabled, keeping the config
        // file the source of truth. save_patch replaces each schedule entry
        // wholesale (no deep merge), so send the full routine object with the
        // current time preserved — the same shape the settings page patches.
        let scheds = &config::load_view().dashboard.schedules;
        let rs = match id.as_str() {
            "morning" => &scheds.morning,
            "lunch" => &scheds.lunch,
            _ => &scheds.evening,
        };
        return config::save_patch(&serde_json::json!({
            "dashboard": { "schedules": { id: { "time": rs.time, "enabled": enabled } } }
        }))
        .map(|_| ());
    }
    let mut def = tasks::get_task(&root, &id)?;
    def.enabled = enabled;
    def.updated_at = tasks::now_iso();
    tasks::save_task(&root, &def)
}

#[tauri::command]
pub fn approve_request(id: String, app: AppHandle) -> Result<crate::tasks::TaskDef, String> {
    let root = tasks::workbench_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    // the request file's agent field becomes the approving actor of record
    let agent = tasks::list_pending(&root)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.agent)
        .unwrap_or_default();
    let def = tasks::approve_request(&root, &id, &agent, &today)?;
    let _ = app.emit("tasks-changed", serde_json::json!({}));
    Ok(def)
}

#[tauri::command]
pub fn reject_request(id: String, reason: Option<String>, app: AppHandle) -> Result<(), String> {
    tasks::reject_request(&tasks::workbench_root(), &id, reason.as_deref().unwrap_or("사유 없음"))?;
    let _ = app.emit("tasks-changed", serde_json::json!({}));
    Ok(())
}

#[tauri::command]
pub fn set_launch_at_login(app: AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    let r = if on { autostart.enable() } else { autostart.disable() };
    r.map_err(|e| format!("자동 시작 설정 실패: {e}"))
}

#[tauri::command]
pub fn get_launch_at_login(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn plugin_info() -> Result<plugin::PluginBundle, String> {
    plugin::plugin_info()
}

#[tauri::command]
pub fn read_skill(name: String) -> Result<String, String> {
    let root = plugin::resolve_root()?;
    plugin::read_skill(&root, &name)
}

#[tauri::command]
pub fn install_skill(target: String) -> Result<plugin::SkillInstall, String> {
    plugin::install_skill(&target)
}

#[tauri::command]
pub fn skill_status() -> Vec<plugin::SkillInstall> {
    plugin::skill_status()
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") {
        return Err("https URL만 허용".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("링크 열기 실패: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_rows_mirror_config_schedules() {
        let scheds = config::Schedules::default();
        let rows = builtin_rows(&scheds);
        assert_eq!(rows.len(), 3);
        let ids: Vec<&str> = rows.iter().map(|r| r.def.id.as_str()).collect();
        assert_eq!(ids, ["morning", "lunch", "evening"]);
        let m = &rows[0].def;
        assert!(m.builtin);
        assert_eq!(m.skill.as_deref(), Some("sawhorse:morning"));
        assert_eq!(m.title, "아침 브리핑");
        assert_eq!(m.source.kind, "builtin");
        assert_eq!(m.prompt, "");
        let s = m.schedule.as_ref().unwrap();
        assert_eq!(s.kind, crate::tasks::ScheduleKind::Daily);
        assert_eq!(s.time, "09:00");
        assert!(s.date.is_none());
        assert!(m.enabled);
        assert!(rows[0].last_run.is_none());
    }

    #[test]
    fn builtin_rows_reflect_disabled_schedule() {
        let mut scheds = config::Schedules::default();
        scheds.lunch.enabled = false;
        scheds.evening.time = "19:45".into();
        let rows = builtin_rows(&scheds);
        assert!(!rows[1].def.enabled, "disabled lunch must surface as disabled");
        assert!(rows[0].def.enabled);
        assert_eq!(rows[2].def.schedule.as_ref().unwrap().time, "19:45");
    }

    #[test]
    fn save_task_rejects_builtin_ids() {
        // guard fires before any fs access, so this is hermetic
        for id in scheduler::ROUTINE_IDS {
            let def = crate::tasks::TaskDef {
                id: id.into(),
                title: "사칭 작업".into(),
                prompt: "p".into(),
                ..crate::tasks::TaskDef::default()
            };
            let err = save_task(def).unwrap_err();
            assert!(err.contains("내장 작업"), "id {id}: got {err}");
        }
    }

    /// One-shot injection, same trick as jobs.rs tests: the override is
    /// process-wide, so parallel tests share one root and isolate by unique ids.
    fn tasks_root_for_test() -> std::path::PathBuf {
        static ROOT: std::sync::LazyLock<std::path::PathBuf> = std::sync::LazyLock::new(|| {
            let d = std::env::temp_dir().join(format!("swdash-cmds-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&d).unwrap();
            crate::tasks::TASKS_ROOT_OVERRIDE.set(d.clone()).ok();
            d
        });
        ROOT.clone()
    }

    #[test]
    fn save_task_stamps_created_at_on_new_and_preserves_on_edit() {
        let root = tasks_root_for_test();
        // TasksPage sends createdAt:"" for a brand-new GUI task; the backend
        // must fill it, or list_tasks sorting by created_at breaks.
        let fresh = crate::tasks::TaskDef {
            id: String::new(),
            title: format!("생성 시각 확인 {}", uuid::Uuid::new_v4().simple()),
            prompt: "p".into(),
            created_at: String::new(),
            updated_at: String::new(),
            ..crate::tasks::TaskDef::default()
        };
        let saved = save_task(fresh).unwrap();
        assert!(!saved.created_at.is_empty(), "신규 생성 시 created_at이 채워져야 한다");
        assert_eq!(
            crate::tasks::get_task(&root, &saved.id).unwrap().created_at,
            saved.created_at
        );

        // Editing an existing task must keep its original created_at.
        let mut edit = saved.clone();
        edit.title = "이름만 바꾼 편집".into();
        let edited = save_task(edit).unwrap();
        assert_eq!(edited.created_at, saved.created_at, "편집 시 created_at 보존");
        assert_eq!(
            crate::tasks::get_task(&root, &edited.id).unwrap().created_at,
            saved.created_at
        );
    }
}

