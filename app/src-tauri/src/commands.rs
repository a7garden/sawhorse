// Tauri command layer. Thin wrappers: contract types live in config.rs / vault.rs / jobs.rs.

use std::path::Path;
use std::sync::Arc;

use crate::agents;
use crate::config;
use crate::herdr::{Herdr, HerdrSnapshot};
use crate::jobs::{Job, JobManager, JobRequest};
use crate::notes;
use crate::packs;
use crate::plugin;
use crate::scheduler;
use crate::state::{AppState, MissedEntry};
use crate::vault;
use crate::workspace;
use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, State};

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
    vault::TodoSections {
        date,
        today: vec![],
        tomorrow: vec![],
        file_exists: false,
    }
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
    let configured: Vec<(String, String)> = view
        .projects
        .iter()
        .map(|p| (p.name.clone(), p.id_prefix.clone()))
        .collect();
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
    Ok(NoteView {
        frontmatter,
        markdown,
    })
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
    let configured: Vec<(String, String)> = view
        .projects
        .iter()
        .map(|p| (p.name.clone(), p.id_prefix.clone()))
        .collect();
    let pairs = vault::project_pairs(Path::new(&view.vault_path), &configured);
    vault::inbox_count(Path::new(&view.vault_path), &pairs, project.as_deref())
}

#[tauri::command]
pub fn list_unpromoted() -> Vec<vault::UnpromotedItem> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vec![];
    }
    let configured: Vec<(String, String)> = view
        .projects
        .iter()
        .map(|p| (p.name.clone(), p.id_prefix.clone()))
        .collect();
    let pairs = vault::project_pairs(Path::new(&view.vault_path), &configured);
    vault::list_unpromoted(Path::new(&view.vault_path), &pairs)
}

#[tauri::command]
pub fn audit_vault() -> vault::VaultAudit {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vault::VaultAudit {
            issues: vec![],
            journal: vault::JournalAudit {
                today_exists: false,
                missing: vec![],
            },
            scanned_at_ms: 0,
        };
    }
    let configured: Vec<(String, String)> = view
        .projects
        .iter()
        .map(|p| (p.name.clone(), p.id_prefix.clone()))
        .collect();
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
    let Ok(content) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let lines: Vec<String> = content.lines().map(str::to_string).collect();
    let start = lines.len().saturating_sub(500);
    lines[start..].to_vec()
}

#[tauri::command]
pub fn job_report(id: String, state: State<'_, Arc<AppState>>) -> Option<String> {
    std::fs::read_to_string(state.report_path(&id)).ok()
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
    let r = if on {
        autostart.enable()
    } else {
        autostart.disable()
    };
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
    let pack = reg
        .get(&pack_id)
        .ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
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

/// 목록과 "그중 어느 것이 기본인가" 는 늘 함께 읽힌다. 따로 부르면 설정을 두 번 읽고
/// 그 사이에 바뀔 수 있으므로 한 번에 돌려준다.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsView {
    pub agents: Vec<agents::AgentPresence>,
    /// 설정값을 정상화한 기본 에이전트 id (모르는 값이면 claude)
    pub default_agent: String,
}

#[tauri::command]
pub async fn list_agents() -> AgentsView {
    let view = config::load_view();
    AgentsView {
        default_agent: agents::effective_default(&view.dashboard),
        agents: agents::detect_agents(&view.dashboard).await,
    }
}

/// 제품이 실제로 쓰는 외부 프로그램이 이 PC 에 있는지. 마법사의 「프로그램」 단계와
/// 설정의 진단 화면이 같은 답을 쓴다.
#[tauri::command]
pub async fn check_requirements() -> Vec<crate::detect::RequirementStatus> {
    crate::detect::check_requirements().await
}

/// 기본 에이전트 저장. 감지되지 않은 에이전트도 고를 수 있게 두되(설치 직후 재검사 없이
/// 넘어가는 흐름이 흔하다), 앱이 전혀 모르는 id 는 거절한다.
#[tauri::command]
pub fn set_default_agent(id: String) -> Result<config::ConfigView, String> {
    let id = id.trim().to_string();
    let view = config::load_view();
    let known = agents::spec(&id).is_some()
        || view
            .dashboard
            .custom_agents
            .iter()
            .any(|c| c.id.trim() == id);
    if !known {
        return Err(format!("모르는 에이전트입니다: {id}"));
    }
    config::save_patch(&serde_json::json!({"dashboard": {"defaultAgent": id}}))
}

/// 작업공간을 처음 만들 때 채워 넣을 경로 제안. 빈 절대경로 입력칸만 내미는 것보다
/// 하나라도 눌러 볼 수 있는 값이 있는 편이 낫다.
#[tauri::command]
pub fn suggest_vault_path() -> String {
    let home = dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."));
    let docs = dirs::document_dir().unwrap_or_else(|| home.join("Documents"));
    docs.join("sawhorse").display().to_string()
}

#[tauri::command]
pub fn pack_agent_status(pack_id: String) -> Result<PackAgentStatus, String> {
    let (reg, _) = registry();
    let pack = reg
        .get(&pack_id)
        .ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
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
    let pack = reg
        .get(&pack_id)
        .ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
    agents::install_pack_skills(pack, &agent, force)
}

#[tauri::command]
pub fn uninstall_pack_skills(
    pack_id: String,
    agent: String,
) -> Result<agents::InstallReport, String> {
    let (reg, _) = registry();
    let pack = reg
        .get(&pack_id)
        .ok_or_else(|| format!("없는 팩입니다: {pack_id}"))?;
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
pub fn provision_workspace(
    vault_path: Option<String>,
) -> Result<workspace::ProvisionReport, String> {
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
    herdr()
        .focus_workspace(&id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn herdr_focus_pane(id: String) -> Result<(), String> {
    herdr()
        .focus_pane(&id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 페인의 최근 출력. 앱을 떠나지 않고 승인 프롬프트 내용을 확인하기 위한 것이다.
#[tauri::command]
pub async fn herdr_read_pane(id: String, lines: Option<u32>) -> Result<String, String> {
    herdr()
        .agent_read(&id, lines.unwrap_or(40))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn herdr_close_tab(id: String) -> Result<(), String> {
    herdr()
        .close_tab(&id)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// 사람이 쓸 빈 탭 하나. cwd 를 주지 않으면 작업공간에서 연다.
#[tauri::command]
pub async fn herdr_open_tab(cwd: Option<String>, label: Option<String>) -> Result<Value, String> {
    let view = config::load_view();
    let h = Herdr::new(&view.dashboard.herdr);
    let dir = cwd
        .filter(|c| !c.is_empty())
        .unwrap_or(view.vault_path.clone());
    if dir.is_empty() {
        return Err("열 경로가 없습니다 (작업공간을 먼저 설정하세요)".into());
    }
    let label = label.unwrap_or_else(|| "sawhorse".into());
    let ws_label = view.dashboard.herdr.sanitized().workspace_label;
    let workspace = match h.find_workspace_by_label(&ws_label).await {
        Some(id) => id,
        None => h
            .create_workspace(&ws_label)
            .await
            .map_err(|e| e.to_string())?,
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

// ---------- 호스트 내장 작업 (에이전트가 승인 큐로 만드는 예약) ----------

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

fn builtin_rows(view: &config::ConfigView, state: &AppState) -> Vec<TaskRow> {
    let s = &view.dashboard.schedules;
    [
        ("morning", &s.morning, "아침 브리핑"),
        ("lunch", &s.lunch, "오전 결산"),
        ("evening", &s.evening, "퇴근 정산"),
    ]
    .into_iter()
    .map(|(id, sched, title)| TaskRow {
        last_run: state.state.lock().last_run.get(id).cloned(),
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
            source: crate::tasks::Source {
                kind: "builtin".into(),
                agent: None,
                request: None,
            },
            ..crate::tasks::TaskDef::default()
        },
    })
    .collect()
}

#[tauri::command]
pub fn list_tasks(state: State<'_, Arc<AppState>>) -> TasksView {
    let root = crate::tasks::workbench_root();
    let _ = crate::tasks::ensure_dirs(&root);
    crate::tasks::process_inbox(&root, &chrono::Local::now().format("%Y-%m-%d").to_string());
    let view = config::load_view();
    let builtin = builtin_rows(&view, &state);
    let tasks: Vec<TaskRow> = {
        let st = state.state.lock();
        let last_run = st.last_run.clone();
        drop(st);
        crate::tasks::list_tasks(&root)
            .into_iter()
            .map(|def| TaskRow {
                last_run: last_run.get(&def.id).cloned(),
                def,
            })
            .collect()
    };
    TasksView {
        builtin,
        tasks,
        pending: crate::tasks::list_pending(&root),
        rejected: crate::tasks::list_rejected(&root),
    }
}

#[tauri::command]
pub fn save_task(mut def: crate::tasks::TaskDef) -> Result<crate::tasks::TaskDef, String> {
    let root = crate::tasks::workbench_root();
    let _ = crate::tasks::ensure_dirs(&root);
    let is_new = def.created_at.is_empty();
    if def.id.is_empty() {
        def.id = crate::tasks::new_id();
    }
    if crate::scheduler::LEGACY_ROUTINES.contains(&def.id.as_str()) {
        return Err("내장 작업 ID는 사용할 수 없습니다".into());
    }
    def.builtin = false;
    def.skill = None;
    if is_new {
        def.source = crate::tasks::Source {
            kind: "gui".into(),
            agent: None,
            request: None,
        };
        def.created_at = crate::tasks::now_iso();
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    crate::tasks::validate_new(&def, &today)?;
    def.updated_at = crate::tasks::now_iso();
    crate::tasks::save_task(&root, &def)?;
    Ok(def)
}

#[tauri::command]
pub fn delete_task(id: String) -> Result<(), String> {
    if scheduler::LEGACY_ROUTINES.contains(&id.as_str()) {
        return Err("내장 작업은 삭제할 수 없습니다".into());
    }
    crate::tasks::delete_task(&crate::tasks::workbench_root(), &id)
}

#[tauri::command]
pub fn set_task_enabled(id: String, enabled: bool) -> Result<(), String> {
    let root = crate::tasks::workbench_root();
    if scheduler::LEGACY_ROUTINES.contains(&id.as_str()) {
        let scheds = &config::load_view().dashboard.schedules;
        let time = match id.as_str() {
            "morning" => scheds.morning.time.clone(),
            "lunch" => scheds.lunch.time.clone(),
            _ => scheds.evening.time.clone(),
        };
        return config::save_patch(&serde_json::json!({
            "dashboard": { "schedules": { id: { "time": time, "enabled": enabled } } }
        }))
        .map(|_| ());
    }
    crate::tasks::set_enabled(&root, &id, enabled)
}

#[tauri::command]
pub fn run_task_now(
    id: String,
    mgr: State<'_, Arc<JobManager>>,
    state: State<'_, Arc<AppState>>,
) -> Result<Job, String> {
    scheduler::run_scheduled_now(&mgr, &state, &id)
}

#[tauri::command]
pub fn approve_request(id: String, app: AppHandle) -> Result<crate::tasks::TaskDef, String> {
    use tauri::Emitter;
    let root = crate::tasks::workbench_root();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let agent = crate::tasks::list_pending(&root)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.agent)
        .unwrap_or_default();
    let def = crate::tasks::approve_request(&root, &id, &agent, &today);
    if def.is_ok() {
        let _ = app.emit("tasks-changed", serde_json::json!({}));
    }
    def
}

#[tauri::command]
pub fn reject_request(id: String, reason: Option<String>, app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let result = crate::tasks::reject_request(
        &crate::tasks::workbench_root(),
        &id,
        reason.as_deref().unwrap_or("사유 없음"),
    );
    if result.is_ok() {
        let _ = app.emit("tasks-changed", serde_json::json!({}));
    }
    result
}


// ---------- 협업(멀티에이전트 통합 레인) ----------

#[tauri::command]
pub fn collab_create_session(
    input: crate::collab::service::CreateSessionInput,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<crate::collab::model::Session, String> {
    let view = config::load_view();
    svc.create_session(&view, &input)
}

#[tauri::command]
pub fn collab_list_sessions(
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<Vec<crate::collab::model::Session>, String> {
    svc.store.list_sessions()
}

#[tauri::command]
pub fn collab_session_detail(
    id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<crate::collab::model::SessionView, String> {
    svc.session_view(&id)
}

#[tauri::command]
pub fn collab_session_audit(
    id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<Vec<crate::collab::model::AuditEvent>, String> {
    svc.store.list_audit_events(&id, 200)
}

/// 프로젝트 레지스트리 조회. 새 정본(UUID)과 legacy 후보를 함께 내려준다(설계 297줄).
#[tauri::command]
pub fn collab_projects_view() -> Result<serde_json::Value, String> {
    let view = config::load_view();
    let registered: Vec<serde_json::Value> = view
        .core_projects
        .iter()
        .map(|(id, p)| {
            serde_json::json!({ "id": id, "name": id, "path": p.path, "integration": {
                "path": p.integration.path, "branch": p.integration.branch,
                "verifyProfile": p.integration.verify_profile,
            }})
        })
        .collect();
    let legacy: Vec<serde_json::Value> = view
        .projects
        .iter()
        .map(|p| {
            serde_json::json!({ "name": p.name, "path": p.path, "workBranch": p.work_branch, "verify": p.verify })
        })
        .collect();
    Ok(serde_json::json!({ "registered": registered, "legacy": legacy }))
}

/// 사용자가 등록을 확인하면 UUID projectId를 만들어 새 블록으로 복사한다(설계 299-300줄).
#[tauri::command]
pub fn collab_register_project(
    name: String,
    path: String,
    branch: String,
    verify_profile: String,
) -> Result<serde_json::Value, String> {
    let mut view = config::load_view();
    let id = uuid::Uuid::new_v4().to_string();
    let project = crate::collab::model::CoreProject {
        path: path.clone(),
        integration: crate::collab::model::IntegrationTarget {
            path: String::new(), // 비어 두면 코어가 path로 해석한다
            branch: branch.clone(),
            verify_profile: verify_profile.clone(),
        },
        verify_profiles: Default::default(),
    };
    let mut map = serde_json::Map::new();
    for (existing_id, p) in &view.core_projects {
        map.insert(
            existing_id.clone(),
            serde_json::to_value(p).unwrap_or_default(),
        );
    }
    map.insert(
        id.clone(),
        serde_json::to_value(&project).unwrap_or_default(),
    );
    let config_path = config::config_path();
    let mut patch = serde_json::Map::new();
    patch.insert("coreProjects".into(), Value::Object(map));
    view = config::save_patch_at(&config_path, &Value::Object(patch))?;
    let _ = &view;
    Ok(serde_json::json!({ "id": id, "name": name, "path": path, "branch": branch }))
}

/// 프로젝트 검증 프로필 저장(argv 배열만 허용 — 임의 shell 문자열 금지, 설계 307줄).
#[tauri::command]
pub fn collab_save_verify_profile(
    project_id: String,
    profile_name: String,
    profile: crate::collab::model::VerifyProfile,
) -> Result<serde_json::Value, String> {
    let view = config::load_view();
    let mut map = serde_json::Map::new();
    for (existing_id, p) in &view.core_projects {
        let mut p = p.clone();
        if existing_id == &project_id {
            p.verify_profiles
                .insert(profile_name.clone(), profile.clone());
        }
        map.insert(
            existing_id.clone(),
            serde_json::to_value(&p).unwrap_or_default(),
        );
    }
    if !map.contains_key(&project_id) {
        return Err(format!("등록되지 않은 프로젝트: {project_id}"));
    }
    let config_path = config::config_path();
    let mut patch = serde_json::Map::new();
    patch.insert("coreProjects".into(), Value::Object(map));
    config::save_patch_at(&config_path, &Value::Object(patch))?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub fn collab_approve(
    candidate_id: String,
    decided_by: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.approve_candidate(&candidate_id, &decided_by)
}

#[tauri::command]
pub fn collab_reject(
    candidate_id: String,
    decided_by: String,
    reason: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.reject_candidate(&candidate_id, &decided_by, &reason)
}

#[tauri::command]
pub fn collab_request_changes(
    candidate_id: String,
    reason: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.request_changes(&candidate_id, &reason)
}

#[tauri::command]
pub fn collab_manual_ok(
    candidate_id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.confirm_manual_ok(&candidate_id)
}

#[tauri::command]
pub fn collab_manual_fail(
    candidate_id: String,
    reason: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.confirm_manual_failed(&candidate_id, &reason)
}

#[tauri::command]
pub fn collab_repair(
    candidate_id: String,
    instruction: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<crate::collab::model::AgentRun, String> {
    svc.create_repair_lane(&candidate_id, &instruction)
}

#[tauri::command]
pub fn collab_revert(
    candidate_id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<String, String> {
    let phase = svc.revert_candidate(&candidate_id)?;
    Ok(phase.as_str().to_string())
}

#[tauri::command]
pub fn collab_finalize(
    session_id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<crate::collab::model::Session, String> {
    svc.finalize_session(&session_id)
}

#[tauri::command]
pub fn collab_pause(
    session_id: String,
    reason: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.pause_session(&session_id, &reason)
}

#[tauri::command]
pub fn collab_resume(
    session_id: String,
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<(), String> {
    svc.resume_session(&session_id)
}

/// 큐 즉시 진행(검토 화면의 「큐 진행」 버튼).
#[tauri::command]
pub async fn collab_run_queue(
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<Option<String>, String> {
    let svc = svc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let view = config::load_view();
        svc.run_queue(&view)
            .map(|p| p.map(|phase| phase.as_str().to_string()))
    })
    .await
    .map_err(|e| format!("큐 스레드 실패: {e}"))?
}

/// 인박스 즉시 확인(에이전트 제출 수동 가져오기).
#[tauri::command]
pub fn collab_inbox_tick(
    svc: State<'_, Arc<crate::collab::service::CollabService>>,
) -> Result<Vec<crate::collab::inbox::InboxReport>, String> {
    let view = config::load_view();
    svc.tick(&view)
}

// ---------- 확장·소스(connector) ----------

/// 내장 bundle manifest. 앱 리소스에 두지 않고 프로그램 상수로 등록한다(설계 648줄).
pub fn builtin_extension_manifests() -> Vec<crate::extensions::manifest::ExtensionManifest> {
    let feeds = crate::extensions::manifest::ExtensionManifest {
        id: "core-feeds".into(),
        name: "읽을거리".into(),
        version: "0.1.0".into(),
        components: vec![crate::extensions::manifest::ExtensionComponent {
            id: "rss".into(),
            kind: "connector".into(),
            adapter: "builtin:rss".into(),
            requests: crate::extensions::manifest::PermissionRequests {
                network: vec![], // instance별 feed 도메인 grant
                ..Default::default()
            },
            contributes: crate::extensions::manifest::ComponentContribution {
                sources: vec![crate::extensions::manifest::SourceContribution {
                    id: "articles".into(),
                    kind: "article".into(),
                }],
                views: vec![crate::extensions::manifest::ViewContribution {
                    id: "reading".into(),
                    renderer: "reading-list".into(),
                }],
            },
            ..Default::default()
        }],
        ..Default::default()
    };
    let github = crate::extensions::manifest::ExtensionManifest {
        id: "github".into(),
        name: "GitHub".into(),
        version: "0.1.0".into(),
        components: vec![crate::extensions::manifest::ExtensionComponent {
            id: "issues".into(),
            kind: "connector".into(),
            adapter: "builtin:github".into(),
            requests: crate::extensions::manifest::PermissionRequests {
                repository: vec!["read".into()],
                issues: vec!["read".into()],
                network: vec!["api.github.com".into()],
                secrets: vec!["github.oauth".into()],
            },
            contributes: crate::extensions::manifest::ComponentContribution {
                sources: vec![crate::extensions::manifest::SourceContribution {
                    id: "issues".into(),
                    kind: "issue".into(),
                }],
                views: vec![crate::extensions::manifest::ViewContribution {
                    id: "github-sync".into(),
                    renderer: "sync-status".into(),
                }],
            },
            ..Default::default()
        }],
        ..Default::default()
    };
    vec![feeds, github]
}

#[tauri::command]
pub fn extensions_list() -> Result<serde_json::Value, String> {
    let user = crate::extensions::manifest::discover(None)?;
    let mut all: Vec<serde_json::Value> = builtin_extension_manifests()
        .into_iter()
        .map(|m| {
            serde_json::json!({ "manifest": serde_json::to_value(&m).unwrap_or_default(), "source": "builtin", "dir": "" })
        })
        .collect();
    for b in user {
        all.push(serde_json::json!({ "manifest": serde_json::to_value(&b.manifest).unwrap_or_default(), "source": b.source, "dir": b.dir }));
    }
    Ok(serde_json::json!({ "bundles": all }))
}

/// instance 생성/갱신. grant는 manifest 요청과 사용자 승인 결과를 합쳐 저장한다.
#[tauri::command]
pub fn sources_upsert_instance(
    instance_id: String,
    extension_id: String,
    component_id: String,
    config: Value,
    network: Vec<String>,
) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let manifests = builtin_extension_manifests();
    let known = manifests
        .iter()
        .find(|m| m.id == extension_id)
        .and_then(|m| m.component(&component_id))
        .ok_or_else(|| format!("알 수 없는 connector: {extension_id}.{component_id}"))?;
    // 권한은 manifest 요청 ∩ 사용자 승인. network는 사용자가 도메인을 승인한다.
    let mut grant = known.requests.clone();
    grant.network = network;
    let instance = crate::extensions::manifest::ConnectorInstance {
        instance_id: instance_id.clone(),
        extension_id,
        component_id,
        config,
        grant,
        paused: false,
        created_at: crate::collab::now_ts(),
        updated_at: crate::collab::now_ts(),
    };
    store.upsert_instance(&instance)?;
    Ok(serde_json::json!({ "ok": true, "instanceId": instance_id }))
}

#[tauri::command]
pub fn sources_list_instances() -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let mut instances = Vec::new();
    for id in store.list_instances()? {
        if let Some(config) = store.instance_config(&id)? {
            instances.push(serde_json::json!({ "instanceId": id, "config": config }));
        }
    }
    Ok(serde_json::json!({ "instances": instances, "deadLetters": store.list_dead_letters(50)? }))
}

#[tauri::command]
pub async fn sources_refresh(instance_id: String) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let config_value = store
        .instance_config(&instance_id)?
        .ok_or_else(|| format!("instance가 없다: {instance_id}"))?;
    let config: crate::extensions::feeds::FeedSourceConfig =
        serde_json::from_value(config_value).map_err(|e| format!("feed 설정 해석 실패: {e}"))?;
    let granted: Vec<String> = config
        .feeds
        .iter()
        .filter_map(|f| {
            crate::extensions::broker::validate_url_scheme(&f.url)
                .ok()
                .map(|(_, host)| host)
        })
        .collect();
    let ctx = crate::extensions::broker::ExtensionContext {
        instance_id,
        granted_domains: granted,
        capabilities: vec![],
    };
    let discovered = crate::extensions::feeds::discover(&store, &ctx, &config).await?;
    Ok(serde_json::json!({ "discovered": discovered }))
}

#[tauri::command]
pub fn articles_list(
    source_instance: String,
    limit: Option<i64>,
) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let rows = store.list_articles(&source_instance, limit.unwrap_or(200))?;
    Ok(serde_json::json!({ "articles": rows }))
}

#[tauri::command]
pub fn article_set_state(
    article_id: String,
    read: Option<bool>,
    archived: Option<bool>,
) -> Result<(), String> {
    let store = crate::collab::store::Store::open()?;
    store.set_article_state(&article_id, read, archived)
}

#[tauri::command]
pub async fn github_import_tick(instance_id: String) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let config_value = store
        .instance_config(&instance_id)?
        .ok_or_else(|| format!("instance가 없다: {instance_id}"))?;
    let config: crate::extensions::github::GitHubSourceConfig =
        serde_json::from_value(config_value).map_err(|e| format!("GitHub 설정 해석 실패: {e}"))?;
    let ctx = crate::extensions::broker::ExtensionContext {
        instance_id,
        granted_domains: vec!["api.github.com".into()],
        capabilities: vec!["secret_use".into()],
    };
    let report = crate::extensions::github::poll_issues(&store, &ctx, &config).await?;
    Ok(serde_json::to_value(&report).unwrap_or_default())
}

#[tauri::command]
pub fn inbound_list(state: String) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    Ok(serde_json::json!({ "inbound": store.list_inbound_changes(&state, 200)? }))
}

#[tauri::command]
pub fn inbound_accept_import(
    inbound_id: String,
    project_id: String,
    notes_dir: String,
    id_prefix: String,
) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let path = crate::extensions::github::accept_import(
        &store,
        &inbound_id,
        &project_id,
        std::path::Path::new(&notes_dir),
        &id_prefix,
    )?;
    Ok(serde_json::json!({ "notePath": path }))
}

#[tauri::command]
pub fn inbound_accept_update(inbound_id: String) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let path = crate::extensions::github::accept_field_update(&store, &inbound_id)?;
    Ok(serde_json::json!({ "notePath": path }))
}

#[tauri::command]
pub fn remote_operations_list(statuses: Vec<String>) -> Result<serde_json::Value, String> {
    let store = crate::collab::store::Store::open()?;
    let refs: Vec<&str> = statuses.iter().map(|s| s.as_str()).collect();
    Ok(serde_json::json!({ "operations": store.list_remote_operations(&refs, 100)? }))
}

/// 사람의 원격 쓰기 승인(issue_write·push·pr_create는 별도 승인이다, 설계 710줄).
#[tauri::command]
pub fn remote_operation_approve(operation_id: String, decided_by: String) -> Result<(), String> {
    let store = crate::collab::store::Store::open()?;
    crate::extensions::github_outbound::approve_operation(&store, &operation_id, &decided_by)
}

/// 승인된 원격 쓰기 실행. 네트워크 오류 시 uncertain으로 남고 reconcile을 기다린다.
#[tauri::command]
pub fn remote_operation_execute(operation_id: String, repo_dir: String) -> Result<String, String> {
    let store = crate::collab::store::Store::open()?;
    crate::extensions::github_outbound::execute_operation(
        &store,
        &operation_id,
        std::path::Path::new(&repo_dir),
    )
}

/// uncertain operation의 재조정 결과 기록(사후 조회로 이미 생성됐는지 확인 뒤).
#[tauri::command]
pub fn remote_operation_reconcile(
    operation_id: String,
    remote_created: bool,
    result: String,
) -> Result<(), String> {
    let store = crate::collab::store::Store::open()?;
    crate::extensions::github_outbound::mark_reconciled(
        &store,
        &operation_id,
        remote_created,
        &result,
    )
}
