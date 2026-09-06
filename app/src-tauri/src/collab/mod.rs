// collab — 멀티에이전트 협업·통합 레인.
//
// 불변식(설계 908-917줄): 대표 체크아웃 병합은 통합 워커 하나만, 승인 없는 후보는
// 대표 경로에 닿지 않고, 승인은 SHA·digest에 묶이며, dirty/stale/conflict는 큐를 멈춘다.
// 에이전트는 파일 인박스(`collab/inbox/changesets/`)만 쓰고 장부(SQLite)와 대표
// 체크아웃은 대시보드 프로세스만 쓴다. tasks.rs의 단일 작성자 패턴을 그대로 따른다.

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

/// 작업 디렉터리(`~/.claude/sawhorse`). config.json과 같은 부모다.
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

/// 후보 요청 인박스. 에이전트는 여기에 JSON 파일 하나만 쓴다.
pub fn inbox_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/changesets")
}

/// 정규화가 끝난(수용되거나 거부된) 인박스 파일이 이동하는 곳.
pub fn inbox_done_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/processed")
}

/// 스키마·검증 실패로 거부된 인박스 파일이 이동하는 곳. 원본을 보존해 진단에 쓴다.
pub fn inbox_rejected_dir() -> std::path::PathBuf {
    workbench_root().join("collab/inbox/rejected")
}

/// 통합 체크아웃 identity 잠금 파일이 놓이는 곳.
pub fn locks_dir() -> std::path::PathBuf {
    workbench_root().join("collab/locks")
}

/// 날짜가 들어간 짧은 ID. `s-20260905-a1b2` 형태. 하루 접두사당 충돌 확률 1/65536.
pub fn new_id(prefix: &str) -> String {
    let date = Utc::now().format("%Y%m%d");
    let hex = uuid::Uuid::new_v4().simple().to_string();
    format!("{prefix}-{date}-{}", &hex[..4])
}

/// 장부에 쓰는 시각 표현. RFC3339 UTC 문자열로 통일한다.
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
