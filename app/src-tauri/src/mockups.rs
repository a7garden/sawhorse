//! Read registered mockup assets, never the generator's original source paths.
use crate::{sdlc, workspace_io};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs::File, io::Read, path::Path};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mockup {
    id: String,
    title: String,
    project_id: String,
    #[serde(default = "first_revision")]
    revision: u32,
    #[serde(default)]
    parent_mockup_id: String,
    issues: Vec<Issue>,
    screens: Vec<Screen>,
}

fn first_revision() -> u32 {
    1
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Issue {
    id: String,
    title: String,
    screen_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct Screen {
    id: String,
    label: String,
    context: String,
    #[serde(default)]
    baseline: Vec<String>,
    #[serde(default)]
    evidence: Vec<String>,
    #[serde(default)]
    proposal: Vec<String>,
    #[serde(default)]
    acceptance: Vec<String>,
}

fn read_text(root: &Path, path: &Path, limit: u64) -> Result<String, String> {
    workspace_io::check_path(root, path)?;
    let file = File::open(path).map_err(|e| format!("목업 파일을 읽을 수 없습니다: {e}"))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("목업 경로는 파일이어야 합니다".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("목업 파일의 크기 제한을 초과했습니다".into());
    }
    String::from_utf8(bytes).map_err(|e| format!("목업 파일은 UTF-8이어야 합니다: {e}"))
}

pub fn read_at(root: &Path, work_id: &str) -> Result<Mockup, String> {
    sdlc::validate_id(work_id)?;
    let path = sdlc::work_path(root, work_id).with_file_name("mockup-manifest.json");
    let mockup: Mockup = serde_json::from_str(&read_text(root, &path, 1024 * 1024)?)
        .map_err(|e| format!("목업 정보의 형식이 올바르지 않습니다: {e}"))?;
    if mockup.id != work_id || mockup.revision == 0 || mockup.screens.is_empty() {
        return Err("목업 ID, 개정 번호 또는 화면 목록이 올바르지 않습니다".into());
    }
    sdlc::validate_id(&mockup.project_id)?;
    if !mockup.parent_mockup_id.is_empty() {
        sdlc::validate_id(&mockup.parent_mockup_id)?;
        if mockup.parent_mockup_id == mockup.id {
            return Err("목업이 자신을 이전 개정으로 가리킵니다".into());
        }
    }
    let mut screens = HashSet::new();
    for screen in &mockup.screens {
        sdlc::validate_id(&screen.id)?;
        if !screens.insert(&screen.id) {
            return Err("중복된 목업 화면 ID입니다".into());
        }
    }
    let mut issues = HashSet::new();
    for issue in &mockup.issues {
        sdlc::validate_id(&issue.id)?;
        if !issues.insert(&issue.id) || !screens.contains(&issue.screen_id) {
            return Err("목업의 이슈와 화면 연결이 올바르지 않습니다".into());
        }
    }
    Ok(mockup)
}

pub fn html_at(root: &Path, work_id: &str, screen_id: &str) -> Result<String, String> {
    sdlc::validate_id(screen_id)?;
    let mockup = read_at(root, work_id)?;
    if !mockup.screens.iter().any(|screen| screen.id == screen_id) {
        return Err("목업에 등록되지 않은 화면입니다".into());
    }
    // Older manifests retain absolute html source paths. The registered copy is
    // always assets/<screen-id>.html, including when those sources no longer exist.
    let path = sdlc::work_path(root, work_id)
        .with_file_name("assets")
        .join(format!("{screen_id}.html"));
    read_text(root, &path, 4 * 1024 * 1024)
}

#[tauri::command]
pub fn sdd_read_mockup(work_id: String) -> Result<Mockup, String> {
    read_at(&sdlc::vault_root()?, &work_id)
}

#[tauri::command]
pub fn sdd_read_mockup_html(work_id: String, screen_id: String) -> Result<String, String> {
    html_at(&sdlc::vault_root()?, &work_id, &screen_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work/mockup-demo");
        fs::create_dir_all(work.join("assets")).unwrap();
        fs::write(work.join("mockup-manifest.json"), serde_json::json!({
            "id": "mockup-demo", "title": "Demo", "projectId": "demo", "revision": 2,
            "parentMockupId": "mockup-v1", "issues": [{ "id": "DEMO-1", "title": "Settings", "screenId": "settings" }],
            "screens": [{ "id": "settings", "label": "Settings", "context": "Account", "html": "/deleted/source.html" }]
        }).to_string()).unwrap();
        fs::write(
            work.join("assets/settings.html"),
            "<h1>Registered copy</h1>",
        )
        .unwrap();
        dir
    }

    #[test]
    fn reads_registered_copy_and_legacy_manifest() {
        let dir = fixture();
        let mockup = read_at(dir.path(), "mockup-demo").unwrap();
        assert_eq!(mockup.revision, 2);
        assert!(mockup.screens[0].proposal.is_empty());
        assert_eq!(
            html_at(dir.path(), "mockup-demo", "settings").unwrap(),
            "<h1>Registered copy</h1>"
        );
        assert!(!serde_json::to_string(&mockup)
            .unwrap()
            .contains("/deleted/"));
    }

    #[test]
    fn rejects_unknown_screens_invalid_ids_and_oversized_html() {
        let dir = fixture();
        assert!(read_at(dir.path(), "../outside").is_err());
        assert!(html_at(dir.path(), "mockup-demo", "../outside").is_err());
        assert!(html_at(dir.path(), "mockup-demo", "unknown").is_err());
        fs::write(
            dir.path().join("work/mockup-demo/assets/settings.html"),
            vec![b'x'; 4 * 1024 * 1024 + 1],
        )
        .unwrap();
        assert!(html_at(dir.path(), "mockup-demo", "settings")
            .unwrap_err()
            .contains("크기 제한"));
    }

    #[test]
    fn rejects_mismatched_manifest_and_broken_issue_coverage() {
        let dir = fixture();
        let path = dir.path().join("work/mockup-demo/mockup-manifest.json");
        let original: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        for (field, value) in [
            ("id", serde_json::json!("other")),
            ("revision", serde_json::json!(0)),
            (
                "issues",
                serde_json::json!([{ "id": "DEMO-1", "title": "Issue", "screenId": "unknown" }]),
            ),
        ] {
            let mut data = original.clone();
            data[field] = value;
            fs::write(&path, data.to_string()).unwrap();
            assert!(read_at(dir.path(), "mockup-demo").is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_assets() {
        let dir = fixture();
        let html = dir.path().join("work/mockup-demo/assets/settings.html");
        fs::remove_file(&html).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), html).unwrap();
        assert!(html_at(dir.path(), "mockup-demo", "settings")
            .unwrap_err()
            .contains("symbolic link"));
    }
}
