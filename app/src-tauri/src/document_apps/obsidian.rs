//! Obsidian 문서 앱 어댑터 — 기존 detect_obsidian_vaults 구현의 이동처.

use std::path::Path;

use serde::Serialize;
use serde_json::Value as Json;

use super::registry::DocumentAppAdapter;

/// 볼트 후보 — 첫 실행 위자드가 보여주는 (경로, 마지막 열림 여부).
/// vault.rs 의 기존 모양과 동일하다(프론트 호환).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultCandidate {
    pub path: String,
    pub open: bool,
}

/// Obsidian 볼트 레지스트리 JSON 파싱: {"vaults": {"<id>": {"path": ..., "open": ...}}}.
/// path 없는 항목은 건너뛰고 open 은 기본 false 다.
fn parse_vault_registry(text: &str) -> Vec<(String, bool)> {
    let Ok(v) = serde_json::from_str::<Json>(text) else {
        return vec![];
    };
    let Some(vaults) = v.get("vaults").and_then(Json::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for entry in vaults.values() {
        let Some(p) = entry.get("path").and_then(Json::as_str) else {
            continue;
        };
        let open = entry.get("open").and_then(Json::as_bool).unwrap_or(false);
        out.push((p.to_string(), open));
    }
    out
}

/// Obsidian 자체 설정(`<config_dir>/obsidian/obsidian.json`)에서 알려진 볼트 후보.
/// 존재하는 디렉터리만 남기고 open=true 를 먼저 보여준다.
/// vault.rs detect_obsidian_vaults 와 동일 동작, 설정 디렉터리만 파라미터로 받는다(테스트 가능성).
pub fn detect_vaults_from(config_dir: &Path) -> Vec<VaultCandidate> {
    let registry = config_dir.join("obsidian").join("obsidian.json");
    let Ok(text) = std::fs::read_to_string(registry) else {
        return vec![];
    };
    let mut out: Vec<VaultCandidate> = parse_vault_registry(&text)
        .into_iter()
        .filter(|(p, _)| Path::new(p).is_dir())
        .map(|(path, open)| VaultCandidate { path, open })
        .collect();
    out.sort_by(|a, b| b.open.cmp(&a.open));
    out
}

/// 사용자 전역 설정 기준 볼트 후보. 설정 디렉터리를 못 찾으면 빈 목록.
pub fn detect_vaults() -> Vec<VaultCandidate> {
    let Some(cfg_dir) = dirs::config_dir() else {
        return vec![];
    };
    detect_vaults_from(&cfg_dir)
}

/// Obsidian 어댑터 — 볼트 탐지를 코어에서 숨긴다(v2 설계 §4.1).
pub struct ObsidianDocumentAppAdapter;

impl DocumentAppAdapter for ObsidianDocumentAppAdapter {
    fn id(&self) -> &'static str {
        "obsidian"
    }

    fn label(&self) -> &'static str {
        "Obsidian"
    }

    fn detect_vaults(&self) -> Vec<VaultCandidate> {
        detect_vaults()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// uuid 로 격리된 임시 설정 디렉터리(`<root>/obsidian` 까지 생성).
    fn temp_config_dir(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "swdash-docapps-obsidian-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("obsidian")).unwrap();
        root
    }

    /// 실제 존재하는 볼트 디렉터리를 만들고 절대경로 문자열을 돌려준다.
    fn make_vault_dir(config: &Path, name: &str) -> String {
        let dir = config.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn write_registry(config: &Path, text: &str) {
        std::fs::write(config.join("obsidian").join("obsidian.json"), text).unwrap();
    }

    /// open=true 가 먼저 오고, 존재하지 않는 디렉터리와 path 없는 항목은 제외된다.
    /// vault.rs 기존 detect_obsidian_vaults 의 정렬·필터 동작과 동일해야 한다.
    #[test]
    fn detect_vaults_from_sorts_open_first_and_filters_missing_dirs() {
        let config = temp_config_dir("sort");
        let closed = make_vault_dir(&config, "closed-vault");
        let open = make_vault_dir(&config, "open-vault");
        write_registry(
            &config,
            &format!(
                r#"{{"vaults": {{
                    "a": {{"path": {closed:?}, "open": false}},
                    "b": {{"path": {open:?}, "open": true}},
                    "c": {{"path": {:?}, "open": true}},
                    "d": {{"open": true}}
                }}}}"#,
                config.join("no-such-vault")
            ),
        );

        let found = detect_vaults_from(&config);
        assert_eq!(
            found.len(),
            2,
            "없는 디렉터리(c)와 path 없는 항목(d)은 제외"
        );
        assert_eq!(
            (found[0].path.as_str(), found[0].open),
            (open.as_str(), true),
            "open=true 가 먼저"
        );
        assert_eq!(
            (found[1].path.as_str(), found[1].open),
            (closed.as_str(), false)
        );

        std::fs::remove_dir_all(&config).unwrap();
    }

    /// open 필드가 없으면 false 다(parse_vault_registry 기본값).
    #[test]
    fn detect_vaults_from_defaults_open_to_false() {
        let config = temp_config_dir("defaults");
        let vault = make_vault_dir(&config, "vault");
        write_registry(
            &config,
            &format!(r#"{{"vaults": {{"id": {{"path": {vault:?}}}}}}}"#),
        );

        let found = detect_vaults_from(&config);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, vault);
        assert!(!found[0].open);

        std::fs::remove_dir_all(&config).unwrap();
    }

    /// 잘못된 JSON 이면 빈 목록(vault.rs 기존 동작).
    #[test]
    fn detect_vaults_from_invalid_json_returns_empty() {
        let config = temp_config_dir("invalid");
        write_registry(&config, "{not json");
        assert!(detect_vaults_from(&config).is_empty());

        // "vaults" 객체가 없어도 빈 목록.
        write_registry(&config, "{}");
        assert!(detect_vaults_from(&config).is_empty());

        std::fs::remove_dir_all(&config).unwrap();
    }

    /// 레지스트리 파일 자체가 없으면 빈 목록(vault.rs 기존 동작).
    #[test]
    fn detect_vaults_from_missing_file_returns_empty() {
        let config = temp_config_dir("missing");
        assert!(detect_vaults_from(&config).is_empty());

        std::fs::remove_dir_all(&config).unwrap();
    }
}
