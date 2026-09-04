// Tauri command layer. Thin wrappers: contract types live in config.rs / vault.rs / jobs.rs.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use crate::jobs::{Job, JobManager, JobRequest};
use crate::config;
use crate::scheduler;
use crate::state::{AppState, MissedEntry};
use crate::plugin;
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
    let names: Vec<String> = view.projects.iter().map(|p| p.name.clone()).collect();
    vault::scan_improvements(vault_path, project.as_deref(), &names)
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
pub fn list_obsidian_vaults() -> Vec<vault::VaultCandidate> {
    vault::detect_obsidian_vaults()
}
#[tauri::command]
pub fn list_inbox_count(project: Option<String>) -> u64 {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return 0;
    }
    let pairs: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    vault::inbox_count(Path::new(&view.vault_path), &pairs, project.as_deref())
}

#[tauri::command]
pub fn list_unpromoted() -> Vec<vault::UnpromotedItem> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vec![];
    }
    let pairs: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
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
    let projects: Vec<String> = view.projects.iter().map(|p| p.name.clone()).collect();
    vault::audit_vault(Path::new(&view.vault_path), &projects)
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
pub fn run_routine_now(
    routine: String,
    mgr: State<'_, Arc<JobManager>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Job, String> {
    scheduler::run_routine_now(&mgr, &state, &routine)
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
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") {
        return Err("https URL만 허용".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("링크 열기 실패: {e}"))
}
