// Vault filesystem watcher → debounced "vault-changed" events.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::json;

use crate::jobs::EmitFn;

/// Keep the returned watcher alive for as long as watching is wanted
/// (dropping it stops the watch).
pub fn start(vault: &str, emit: EmitFn) -> Option<RecommendedWatcher> {
    if vault.is_empty() {
        return None;
    }
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx).ok()?;
    watcher.watch(std::path::Path::new(vault), RecursiveMode::Recursive).ok()?;

    std::thread::spawn(move || {
        let pending = Mutex::new(false);
        let last_emit = Mutex::new(Instant::now() - Duration::from_secs(10));
        loop {
            match rx.recv_timeout(Duration::from_millis(300)) {
                Ok(_event) => {
                    *pending.lock() = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let due = last_emit.lock().elapsed() >= Duration::from_secs(1);
                    if *pending.lock() && due {
                        *pending.lock() = false;
                        *last_emit.lock() = Instant::now();
                        emit(
                            "vault-changed",
                            &json!({"areas": ["improvements", "todos", "docs"]}),
                        );
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Some(watcher)
}
