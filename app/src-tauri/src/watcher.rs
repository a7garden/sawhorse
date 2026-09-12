// Vault filesystem watcher → debounced "vault-changed" events.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;

use crate::jobs::EmitFn;

/// Watch the configured vault recursively; debounced "vault-changed" events.
pub fn start(vault: &str, emit: EmitFn) -> Option<RecommendedWatcher> {
    if vault.is_empty() {
        return None;
    }
    start_path(
        std::path::Path::new(vault),
        emit,
        "vault-changed",
        serde_json::json!({"areas": ["improvements", "todos", "docs"]}),
    )
}

/// Watch `path` recursively; coalesce fs events and emit `event` with a fixed
/// `payload` at most once per second. Keep the returned watcher alive for as
/// long as watching is wanted (dropping it stops the watch).
pub fn start_path(
    path: &std::path::Path,
    emit: EmitFn,
    event: &'static str,
    payload: serde_json::Value,
) -> Option<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).ok()?;
    watcher.watch(path, RecursiveMode::Recursive).ok()?;

    std::thread::spawn(move || {
        let pending = Mutex::new(false);
        let last_emit = Mutex::new(Instant::now() - Duration::from_secs(10));
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(_event) => {
                    *pending.lock() = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            // Flush in a common tail path: a steady event stream never lets
            // recv_timeout expire, so checking due only on Timeout would
            // suppress the emit indefinitely. The 1s spacing is preserved.
            if *pending.lock() && last_emit.lock().elapsed() >= Duration::from_secs(1) {
                *pending.lock() = false;
                *last_emit.lock() = Instant::now();
                emit(event, &payload);
            }
        }
    });

    Some(watcher)
}
