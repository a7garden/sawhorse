// collab — multi-agent collaboration and integration lane.
//
// Invariants (design lines 908-917): only one integration worker merges into the main checkout, candidates without
// approval never reach the main path, approvals bind to SHA and digest, and dirty/stale/conflict halts the queue.
// Agents write only the file inbox (`collab/inbox/changesets/`); only the dashboard process touches the ledger (SQLite)
// and the main checkout. Follows the single-writer pattern from tasks.rs unchanged.

pub mod batch;
pub mod checks;
pub mod drivers;
pub mod events;
pub mod git;
pub mod inbox;
pub mod integration;
pub mod model;
pub mod policy;
pub mod service;
pub mod store;

use chrono::Utc;

/// Working directory (`~/.sawhorse`). Same parent as config.json.
#[cfg(test)]
thread_local! {
    static TEST_ROOT: std::path::PathBuf = {
        let path = std::env::temp_dir().join(format!("sawhorse-collab-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create isolated test root");
        path
    };
}
#[cfg(test)]
pub fn workbench_root() -> std::path::PathBuf {
    TEST_ROOT.with(Clone::clone)
}

#[cfg(not(test))]
pub fn workbench_root() -> std::path::PathBuf {
    crate::config::config_path()
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

/// Candidate request inbox. Agents write exactly one JSON file here.
pub fn inbox_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/changesets")
}

/// Where normalized (accepted or rejected) inbox files are moved.
pub fn inbox_done_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/processed")
}

/// Where inbox files rejected for schema or validation failures are moved. Preserves the original for diagnosis.
pub fn inbox_rejected_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/rejected")
}

/// Where integration checkout identity lock files live.
pub fn locks_dir() -> std::path::PathBuf {
    workbench_root().join("collab/locks")
}

/// Short date-stamped ID. Format `s-20260905-a1b2`. Collision odds 1/65536 per day per prefix.
pub fn new_id(prefix: &str) -> String {
    let date = Utc::now().format("%Y%m%d");
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("{prefix}-{date}-{}", &hex[..4])
}

/// Timestamp representation written to the ledger. Normalized to RFC3339 UTC strings.
pub fn now_ts() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_id_has_prefix_date_and_four_chars() {
        let id = new_id("c");
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0], "c");
        assert_eq!(parts[1].len(), 8);
        assert_eq!(parts[2].len(), 4);
        assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn new_ids_are_unique() {
        let a = new_id("s");
        let b = new_id("s");
        assert_ne!(a, b);
    }
}
