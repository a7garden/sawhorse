mod commands;
mod config;
mod jobs;
mod scheduler;
mod state;
mod vault;
mod watcher;

use std::sync::Arc;
use parking_lot::Mutex;

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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let state = Arc::new(state::AppState::new(data_dir));
            state.mark_stale_interrupted();

            let handle = app.handle().clone();
            let emit_fn: jobs::EmitFn = Arc::new(move |event, payload| {
                let _ = handle.emit(event, payload.clone());
            });
            let mgr = jobs::JobManager::start(state.clone(), emit_fn.clone());
            scheduler::start_tick(mgr.clone(), state.clone(), emit_fn.clone());

            // watch the vault for external changes (skip when not configured yet)
            {
                let view = config::load_view();
                if let Some(w) = watcher::start(&view.vault_path, emit_fn.clone()) {
                    app.manage(WatchKeeper(Mutex::new(vec![Box::new(w)])));
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
                        let _ = scheduler::run_routine_now(&jm, &st, event.id.as_ref());
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
            commands::read_note,
            commands::approve_note,
            commands::list_inbox_count,
            commands::list_todos,
            commands::toggle_todo,
            commands::add_todo,
            commands::list_vault_tree,
            commands::read_vault_note,
            commands::enqueue_job,
            commands::cancel_job,
            commands::list_jobs,
            commands::job_log,
            commands::job_report,
            commands::run_routine_now,
            commands::list_missed,
            commands::dismiss_missed,
            commands::set_launch_at_login,
            commands::get_launch_at_login,
        ])
        .run(tauri::generate_context!())
        .expect("si-workbench 대시보드 실행 실패");
}
