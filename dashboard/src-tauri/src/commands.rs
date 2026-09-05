// Tauri command layer. Thin wrappers: contract types live in config.rs / vault.rs / jobs.rs.

use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};
use crate::agents;
use crate::jobs::{Job, JobManager, JobRequest};
use crate::config;
use crate::herdr::{Herdr, HerdrSnapshot};
use crate::notes;
use crate::packs;
use crate::scheduler;
use crate::state::{AppState, MissedEntry};
use crate::plugin;
use crate::vault;
use crate::workspace;

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

// ---------- 확장(pack) ----------

fn registry() -> (packs::Registry, config::ConfigView) {
    let view = config::load_view();
    let reg = packs::load_registry(&view.packs.enabled);
    (reg, view)
}

#[tauri::command]
pub fn list_packs() -> packs::PackRegistryView {
    let (reg, view) = registry();
    packs::registry_view(&reg, &view)
}

/// 사이드바 구성. 코어 페이지(홈·작업·터미널·확장·설정)는 프론트엔드가 갖고 있고,
/// 그 사이에 들어가는 팩 기여 화면만 백엔드가 정한다.
#[tauri::command]
pub fn list_nav() -> Vec<packs::NavEntry> {
    let (reg, _) = registry();
    packs::nav_entries(&reg)
}

/// 활성 목록이 비어 있으면 "전부 활성" 이라는 뜻이므로, 하나를 끄는 순간
/// 나머지를 명시적으로 적어 둬야 의미가 유지된다.
#[tauri::command]
pub fn set_pack_enabled(id: String, on: bool) -> Result<config::ConfigView, String> {
    let (reg, view) = registry();
    if reg.get(&id).is_none() {
        return Err(format!("설치되지 않은 팩입니다: {id}"));
    }
    let mut enabled: Vec<String> = if view.packs.enabled.is_empty() {
        reg.packs.iter().map(|p| p.manifest.id.clone()).collect()
    } else {
        view.packs.enabled.clone()
    };
    enabled.retain(|e| e != &id);
    if on {
        enabled.push(id);
    }
    config::save_patch(&serde_json::json!({ "packs": { "enabled": enabled } }))
}

#[tauri::command]
pub fn save_pack_settings(
    pack_id: String,
    values: Map<String, Value>,
) -> Result<config::ConfigView, String> {
    config::save_patch(&serde_json::json!({ "packs": { "settings": { pack_id: values } } }))
}

#[tauri::command]
pub fn query_pack_view(pack_id: String, view_id: String) -> Result<notes::QueryResult, String> {
    let (reg, cfg) = registry();
    let (_, v) = reg
        .view(&pack_id, &view_id)
        .ok_or_else(|| format!("활성 팩에서 뷰를 찾지 못했습니다: {pack_id}.{view_id}"))?;
    if v.query.is_empty() {
        return Err(format!("{view_id} 뷰에 질의(folders)가 없습니다"));
    }
    Ok(notes::query(Path::new(&cfg.vault_path), &v.query))
}

#[tauri::command]
pub fn run_pack_action(
    pack_id: String,
    action_id: String,
    params: Map<String, Value>,
    mgr: State<'_, Arc<JobManager>>,
) -> Result<Job, String> {
    mgr.enqueue(JobRequest {
        kind: "action".into(),
        pack_id: Some(pack_id),
        action_id: Some(action_id),
        params,
        ..Default::default()
    })
}

#[tauri::command]
pub fn read_pack_skill(pack_id: String, name: String) -> Result<String, String> {
    let (reg, _) = registry();
    let pack = reg.get(&pack_id).ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
    plugin::read_skill_at(&pack.skills_dir, &name)
}

// ---------- 에이전트 브리지 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackAgentStatus {
    pub pack_id: String,
    pub claude: Vec<agents::SkillStatus>,
    pub codex: Vec<agents::SkillStatus>,
    /// 같은 내용이 Claude Code 플러그인으로도 깔려 있으면 개인 스킬 설치를 권하지 않는다
    pub plugin_installs: Vec<agents::PluginInstall>,
}

#[tauri::command]
pub async fn list_agents() -> Vec<agents::AgentPresence> {
    let view = config::load_view();
    agents::detect_agents(&view.dashboard.claude_bin, &view.dashboard.herdr.bin).await
}

#[tauri::command]
pub fn pack_agent_status(pack_id: String) -> Result<PackAgentStatus, String> {
    let (reg, _) = registry();
    let pack = reg.get(&pack_id).ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
    Ok(PackAgentStatus {
        claude: agents::pack_skill_status(pack, agents::CLAUDE),
        codex: agents::pack_skill_status(pack, agents::CODEX),
        plugin_installs: agents::plugin_installs(&plugin::plugin_name().unwrap_or_default()),
        pack_id,
    })
}

#[tauri::command]
pub fn install_pack_skills(
    pack_id: String,
    agent: String,
    force: bool,
) -> Result<agents::InstallReport, String> {
    let (reg, _) = registry();
    let pack = reg.get(&pack_id).ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
    agents::install_pack_skills(pack, &agent, force)
}

#[tauri::command]
pub fn uninstall_pack_skills(
    pack_id: String,
    agent: String,
) -> Result<agents::InstallReport, String> {
    let (reg, _) = registry();
    let pack = reg.get(&pack_id).ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
    agents::uninstall_pack_skills(pack, &agent)
}

// ---------- 작업공간 프로비저닝 ----------

#[tauri::command]
pub fn workspace_plan() -> Vec<String> {
    let (reg, view) = registry();
    let enabled: Vec<&packs::Pack> = reg.enabled().collect();
    workspace::plan(Path::new(&view.vault_path), &enabled)
}

/// 활성 팩의 폴더·템플릿을 작업공간에 만든다. 기존 파일은 덮지 않는다.
#[tauri::command]
pub fn provision_workspace(vault_path: Option<String>) -> Result<workspace::ProvisionReport, String> {
    let (reg, view) = registry();
    let root = vault_path.unwrap_or(view.vault_path.clone());
    if root.is_empty() {
        return Err("작업공간 경로가 설정되지 않았습니다".into());
    }
    let enabled: Vec<&packs::Pack> = reg.enabled().collect();
    workspace::provision(Path::new(&root), &enabled)
}

// ---------- 예약 ----------

#[tauri::command]
pub fn list_schedules(state: State<'_, Arc<AppState>>) -> Vec<scheduler::ScheduleView> {
    scheduler::list_schedules(&state)
}

#[tauri::command]
pub fn run_scheduled_now(
    key: String,
    mgr: State<'_, Arc<JobManager>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Job, String> {
    scheduler::run_scheduled_now(&mgr, &state, &key)
}

#[tauri::command]
pub fn set_schedule(
    key: String,
    enabled: bool,
    time: String,
) -> Result<config::ConfigView, String> {
    if !packs::validate_hhmm(&time) {
        return Err(format!("시각 형식은 HH:MM 이어야 합니다: {time}"));
    }
    config::save_patch(&serde_json::json!({
        "dashboard": { "schedules": { key: { "enabled": enabled, "time": time } } }
    }))
}

// ---------- herdr 터미널 ----------

fn herdr() -> Herdr {
    Herdr::new(&config::load_view().dashboard.herdr)
}

#[tauri::command]
pub async fn herdr_snapshot() -> HerdrSnapshot {
    herdr().snapshot().await
}

#[tauri::command]
pub async fn herdr_focus_workspace(id: String) -> Result<(), String> {
    herdr().focus_workspace(&id).await.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn herdr_focus_pane(id: String) -> Result<(), String> {
    herdr().focus_pane(&id).await.map(|_| ()).map_err(|e| e.to_string())
}

/// 페인의 최근 출력. 앱을 떠나지 않고 승인 프롬프트 내용을 확인하기 위한 것이다.
#[tauri::command]
pub async fn herdr_read_pane(id: String, lines: Option<u32>) -> Result<String, String> {
    herdr().agent_read(&id, lines.unwrap_or(40)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn herdr_close_tab(id: String) -> Result<(), String> {
    herdr().close_tab(&id).await.map(|_| ()).map_err(|e| e.to_string())
}

/// 사람이 쓸 빈 탭 하나. cwd 를 주지 않으면 작업공간에서 연다.
#[tauri::command]
pub async fn herdr_open_tab(
    cwd: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    let view = config::load_view();
    let h = Herdr::new(&view.dashboard.herdr);
    let dir = cwd.filter(|c| !c.is_empty()).unwrap_or(view.vault_path.clone());
    if dir.is_empty() {
        return Err("열 경로가 없습니다 (작업공간을 먼저 설정하세요)".into());
    }
    let label = label.unwrap_or_else(|| "sawhorse".into());
    let ws_label = view.dashboard.herdr.sanitized().workspace_label;
    let workspace = match h.find_workspace_by_label(&ws_label).await {
        Some(id) => id,
        None => h.create_workspace(&ws_label).await.map_err(|e| e.to_string())?,
    };
    let tab = h
        .open_shell_tab(&workspace, &label, &dir)
        .await
        .map_err(|e| e.to_string())?;
    let _ = h.focus_tab(&tab.tab_id).await;
    Ok(serde_json::json!({ "tabId": tab.tab_id, "paneId": tab.pane_id, "workspaceId": workspace }))
}

// ---------- 기타 ----------

/// 폴더/파일을 OS 파일 관리자로 연다 (팩 폴더·작업공간 열기).
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if path.trim().is_empty() {
        return Err("경로가 비어 있습니다".into());
    }
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("경로 열기 실패: {e}"))
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
