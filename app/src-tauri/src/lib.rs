mod agents;
mod collab;
mod commands;
mod config;
mod detect;
mod extensions;
mod herdr;
mod jobs;
mod notes;
mod packs;
mod plugin;
mod scheduler;
mod state;
mod tasks;
mod transcript;
mod vault;
mod watcher;
mod workspace;

use parking_lot::Mutex;
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::MacosLauncher;

#[allow(dead_code)] // held so the watcher is not dropped
struct WatchKeeper(Mutex<Vec<Box<dyn notify::Watcher + Send>>>);
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// tauri dev runs the raw binary (no .app bundle), so macOS shows no Dock icon.
// Set it at runtime from the packaged source icon; production bundles carry the
// same artwork via icon.icns.
#[cfg(target_os = "macos")]
fn apply_dock_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    const ICON_PNG: &[u8] = include_bytes!("../icons/icon.png");
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    // SAFETY: static PNG bytes; main-thread AppKit call.
    unsafe {
        let data = NSData::dataWithBytes_length(ICON_PNG.as_ptr().cast(), ICON_PNG.len() as _);
        if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
            NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image));
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_dock_icon() {}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            apply_dock_icon();
            // 번들은 plugin/ 통째로 실는다 — 리소스 디렉터리의 plugin 이 플러그인 루트다.
            if let Ok(res) = app.path().resource_dir() {
                plugin::set_root_override(res.join("plugin"));
            }
            let data_dir = app.path().app_data_dir()?;
            let state = Arc::new(state::AppState::new(data_dir));
            // herdr sessions outlive the app, so these are candidates for resuming
            // rather than corpses.
            let resumable = state.mark_stale_interrupted();

            let handle = app.handle().clone();
            let emit_fn: jobs::EmitFn = Arc::new(move |event, payload| {
                let _ = handle.emit(event, payload.clone());
            });
            let mgr = jobs::JobManager::start(state.clone(), emit_fn.clone());
            // 협업 서비스: 장부 열기 + 인박스 감시 + 큐 틱.
            let collab_tick_emit = emit_fn.clone();
            match collab::store::Store::open() {
                Ok(store) => {
                    let svc = collab::service::CollabService::new(store, mgr.clone());
                    app.manage(svc.clone());
                    // 재시작 복구(설계 479-486줄) — 앱이 뜨자마자 미종료 시도를 복구한다.
                    {
                        let svc = svc.clone();
                        let emit = collab_tick_emit.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Ok(actions) = collab::integration::recover_on_startup(&svc.store) {
                                if !actions.is_empty() {
                                    emit("collab-changed", &serde_json::json!({ "reason": "recovery", "actions": actions }));
                                }
                            }
                        });
                    }
                    // 인박스+큐 틱. tasks 스케줄러 틱과 별개로 협업 상태를 앞으로 민다.
                    {
                        let svc = svc.clone();
                        let emit = collab_tick_emit.clone();
                        tauri::async_runtime::spawn(async move {
                            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
                            loop {
                                interval.tick().await;
                                let svc = svc.clone();
                                let emit = emit.clone();
                                let _ = tauri::async_runtime::spawn_blocking(move || {
                                    let view = config::load_view();
                                    if let Ok(reports) = svc.tick(&view) {
                                        if !reports.is_empty() {
                                            emit("collab-changed", &serde_json::json!({ "reason": "inbox" }));
                                        }
                                    }
                                })
                                .await;
                            }
                        });
                    }
                }
                Err(e) => {
                    eprintln!("협업 장부 열기 실패: {e}");
                }
            }
            {
                let mgr = mgr.clone();
                tauri::async_runtime::spawn(async move { mgr.reattach_herdr(resumable).await });
            }

            // watch the vault for external changes (skip when not configured yet)
            {
                let view = config::load_view();
                if let Some(w) = watcher::start(&view.vault_path, emit_fn.clone()) {
                    app.manage(WatchKeeper(Mutex::new(vec![Box::new(w)])));
                }
            }

            // watch the task store for agent inbox activity
            {
                let root = tasks::workbench_root();
                let _ = tasks::ensure_dirs(&root);
                if let Some(w) = watcher::start_path(
                    &tasks::tasks_dir(&root),
                    emit_fn.clone(),
                    "tasks-changed",
                    serde_json::json!({}),
                ) {
                    if let Some(keeper) = app.try_state::<WatchKeeper>() {
                        keeper.0.lock().push(Box::new(w));
                    } else {
                        app.manage(WatchKeeper(Mutex::new(vec![Box::new(w)])));
                    }
                }
            }

            app.manage(state);
            app.manage(mgr);

            // tray: quick routine runs while the window is hidden
            let open = MenuItem::with_id(app, "open", "대시보드 열기", true, None::<&str>)?;
            let m = MenuItem::with_id(app, "morning", "morning 지금 실행", true, None::<&str>)?;
            let l = MenuItem::with_id(app, "lunch", "lunch 지금 실행", true, None::<&str>)?;
            let e = MenuItem::with_id(app, "evening", "evening 지금 실행", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &m, &l, &e, &quit])?;
            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or_else(|| tauri::Error::AssetNotFound("window icon".into()))?,
                )
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "morning" | "lunch" | "evening" => {
                        let st = app.state::<Arc<state::AppState>>();
                        let jm = app.state::<Arc<jobs::JobManager>>();
                        let _ = scheduler::run_scheduled_now(&jm, &st, event.id.as_ref());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // closing the window keeps the app (and schedules) alive in the tray
            if let Some(w) = app.get_webview_window("main") {
                let w2 = w.clone();
                w.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        api.prevent_close();
                        let _ = w2.hide();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::diagnostics,
            commands::list_improvements,
            commands::list_issues,
            commands::read_note,
            commands::approve_note,
            commands::approve_issue,
            commands::list_inbox_count,
            commands::list_unpromoted,
            commands::audit_vault,
            commands::list_obsidian_vaults,
            commands::list_todos,
            commands::toggle_todo,
            commands::add_todo,
            commands::list_vault_tree,
            commands::read_vault_note,
            commands::enqueue_job,
            commands::cancel_job,
            commands::focus_job,
            commands::herdr_probe,
            commands::list_jobs,
            commands::job_log,
            commands::job_report,
            commands::list_tasks,
            commands::save_task,
            // 협업(멀티에이전트 통합 레인)
            commands::collab_create_session,
            commands::collab_list_sessions,
            commands::collab_session_detail,
            commands::collab_session_audit,
            commands::collab_projects_view,
            commands::collab_register_project,
            commands::collab_save_verify_profile,
            commands::collab_approve,
            commands::collab_reject,
            commands::collab_request_changes,
            commands::collab_manual_ok,
            commands::collab_manual_fail,
            commands::collab_repair,
            commands::collab_revert,
            commands::collab_finalize,
            commands::collab_pause,
            commands::collab_resume,
            commands::collab_run_queue,
            commands::collab_inbox_tick,
            // 확장·소스(connector)
            commands::extensions_list,
            commands::sources_upsert_instance,
            commands::sources_list_instances,
            commands::sources_refresh,
            commands::articles_list,
            commands::article_set_state,
            commands::github_import_tick,
            commands::inbound_list,
            commands::inbound_accept_import,
            commands::inbound_accept_update,
            commands::remote_operations_list,
            commands::remote_operation_approve,
            commands::remote_operation_execute,
            commands::remote_operation_reconcile,
            commands::delete_task,
            commands::set_task_enabled,
            commands::run_task_now,
            commands::approve_request,
            commands::reject_request,
            commands::list_missed,
            commands::dismiss_missed,
            commands::set_launch_at_login,
            commands::get_launch_at_login,
            commands::plugin_info,
            commands::open_external,
            commands::open_path,
            // 확장(pack) 레지스트리
            commands::list_packs,
            commands::list_nav,
            commands::set_pack_enabled,
            commands::save_pack_settings,
            commands::query_pack_view,
            commands::run_pack_action,
            commands::read_pack_skill,
            // 에이전트 브리지
            commands::list_agents,
            commands::check_requirements,
            commands::set_default_agent,
            commands::suggest_vault_path,
            commands::pack_agent_status,
            commands::install_pack_skills,
            commands::uninstall_pack_skills,
            // 작업공간 프로비저닝
            commands::workspace_plan,
            commands::provision_workspace,
            // 예약
            commands::list_schedules,
            commands::run_scheduled_now,
            commands::set_schedule,
            // herdr 터미널
            commands::herdr_snapshot,
            commands::herdr_focus_workspace,
            commands::herdr_focus_pane,
            commands::herdr_close_tab,
            commands::herdr_read_pane,
            commands::herdr_open_tab,
        ])
        .run(tauri::generate_context!())
        .expect("sawhorse 대시보드 실행 실패");
}
