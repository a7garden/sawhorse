//! 앱 독립 문서 공간 — DocumentSpace·DocumentStore 모델과 기본 공간 래핑 (v2 설계 §4, R1A).
//!
//! [`DocumentSpace`]는 개인·회사·프로젝트 등 논리적·보안적 문서 영역이고, 공간 목록은
//! `<root>/.sawhorse/spaces.json`에 camelCase JSON으로 보존된다. 기존 볼트 루트는
//! [`default_space`]로 감싸 default DocumentStore가 되며(§9 이관 정책 첫 행), 설정 파일이
//! 없거나 손상된 경우에도 폴백 설정이 항상 공간 1개 이상을 보장한다.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// spaces.json 형식 버전.
const FORMAT_VERSION: u32 = 1;

/// 앱 독립 문서 공간. 문서의 논리적 영역이자 개인정보 경계 (설계 §4 소유권 표).
///
/// `root`는 문자열로 직렬화되며 `privacy_domain`의 예약어는
/// `personal` / `company` / `project`다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSpace {
    pub id: String,
    pub label: String,
    pub root: std::path::PathBuf,
    pub privacy_domain: String,
    pub default_app: Option<String>,
}

/// 공간 등록 설정. 항상 공간 1개 이상을 유지하며, 저장 시점의
/// `default_space_id`는 `spaces` 안의 id를 가리켜야 한다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpacesConfig {
    pub format_version: u32,
    pub default_space_id: Option<String>,
    pub spaces: Vec<DocumentSpace>,
}

/// 기존 볼트 루트를 default DocumentStore로 감싸는 래핑 (설계 §9 이관 정책 첫 행).
/// 기존 경로를 그대로 유지한다.
pub fn default_space(root: &std::path::Path) -> DocumentSpace {
    DocumentSpace {
        id: "default".into(),
        label: "기본 문서 공간".into(),
        root: root.to_path_buf(),
        privacy_domain: "personal".into(),
        default_app: None,
    }
}

/// `<root>/.sawhorse/spaces.json`을 읽는다. 파일이 없거나 읽기·JSON 파싱에 실패하거나
/// `format_version`이 불일치하거나 `spaces`가 비어 있으면 기본 공간 하나로 구성된
/// 설정을 반환한다(에러 아님, 폴백). 파싱에 성공한 경우에도 id 중복·빈 id가 있으면
/// 폴백한다. 반환값은 항상 공간 1개 이상이다.
pub fn load_at(root: &std::path::Path) -> SpacesConfig {
    let contents = match fs::read_to_string(spaces_path(root)) {
        Ok(contents) => contents,
        Err(_) => return fallback_config(root),
    };
    let config: SpacesConfig = match serde_json::from_str(&contents) {
        Ok(config) => config,
        Err(_) => return fallback_config(root),
    };
    if config.format_version != FORMAT_VERSION
        || config.spaces.is_empty()
        || has_invalid_ids(&config.spaces)
    {
        return fallback_config(root);
    }
    config
}

// R1A 후속: 여러 문서 공간 등록 UI가 `save_at`을 소개할 때까지 호출부가 없다.
// `vault_root()` 경유의 load_at/resolve_root는 이미 소비 중이다.
#[allow(dead_code)]
/// 검증을 통과한 설정을 `<root>/.sawhorse/spaces.json`에 원자적으로 저장한다
/// (tmp 파일 기록 후 rename — `sdlc.rs`의 `write_atomic`과 같은 패턴).
///
/// 검증 실패 조건: `spaces`가 비어 있음, id 중복, 빈 id, `default_space_id`가
/// 등록된 공간을 가리키지 않음, 공간의 루트 경로 문자열이 비어 있음.
pub fn save_at(root: &std::path::Path, config: &SpacesConfig) -> Result<(), String> {
    validate(config)?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("문서 공간 설정 직렬화 실패: {e}"))?;
    write_atomic(&spaces_path(root), &json)
}

/// `space_id`에 해당하는 공간의 루트 경로를 반환한다. `space_id`가 `None`이면
/// 설정의 `default_space_id`, 그것도 없으면 `spaces[0]`를 사용한다. 공간을 찾지
/// 못하면 요청한 id를 포함한 에러를, 공간의 루트 디렉터리가 실제로 없으면 에러를
/// 반환한다.
pub fn resolve_root(
    root: &std::path::Path,
    space_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    Ok(space_at(root, space_id)?.root)
}

/// [`resolve_root`]의 공간 버전. 해석된 [`DocumentSpace`] 전체를 반환한다.
pub fn space_at(root: &std::path::Path, space_id: Option<&str>) -> Result<DocumentSpace, String> {
    let config = load_at(root);
    let requested = match space_id {
        Some(id) => Some(id.to_string()),
        None => config.default_space_id.clone(),
    };
    let space = match requested {
        Some(id) => config
            .spaces
            .iter()
            .find(|space| space.id == id)
            .cloned()
            .ok_or_else(|| format!("문서 공간을 찾을 수 없습니다: {id}"))?,
        None => config.spaces[0].clone(),
    };
    if !space.root.is_dir() {
        return Err(format!(
            "문서 공간 '{}'의 루트 폴더가 없습니다: {}",
            space.id,
            space.root.display()
        ));
    }
    Ok(space)
}

/// `<root>/.sawhorse/spaces.json` 경로. 통합 지점(`sdlc::vault_root`)이 설정 파일
/// 존재 여부를 검사할 때 사용한다.
pub fn spaces_config_path(root: &Path) -> PathBuf {
    spaces_path(root)
}

fn spaces_path(root: &Path) -> PathBuf {
    root.join(".sawhorse").join("spaces.json")
}

fn fallback_config(root: &Path) -> SpacesConfig {
    let space = default_space(root);
    SpacesConfig {
        format_version: FORMAT_VERSION,
        default_space_id: Some(space.id.clone()),
        spaces: vec![space],
    }
}

fn has_invalid_ids(spaces: &[DocumentSpace]) -> bool {
    let mut seen: HashSet<String> = HashSet::new();
    spaces
        .iter()
        .any(|space| space.id.is_empty() || !seen.insert(space.id.clone()))
}

fn validate(config: &SpacesConfig) -> Result<(), String> {
    if config.spaces.is_empty() {
        return Err("저장할 문서 공간이 없습니다".into());
    }
    let mut ids: HashSet<String> = HashSet::new();
    for space in &config.spaces {
        if space.id.is_empty() {
            return Err("문서 공간 id가 비어 있습니다".into());
        }
        if !ids.insert(space.id.clone()) {
            return Err(format!("중복된 문서 공간 id입니다: {}", space.id));
        }
        if space.root.as_os_str().is_empty() {
            return Err(format!(
                "문서 공간 '{}'의 루트 경로가 비어 있습니다",
                space.id
            ));
        }
    }
    if let Some(default_id) = &config.default_space_id {
        if !ids.contains(default_id) {
            return Err(format!(
                "기본 문서 공간 id가 등록된 공간을 가리키지 않습니다: {default_id}"
            ));
        }
    }
    Ok(())
}

/// `sdlc.rs`의 `write_atomic`과 같은 패턴: 임시 파일 기록 후 rename.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "파일의 상위 폴더가 없습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let temporary = parent.join(format!(".sawhorse-{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, contents).map_err(|e| format!("파일 쓰기 실패: {e}"))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("파일 교체 실패: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("sawhorse-spaces-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn unique_space(root: &Path, id_prefix: &str) -> DocumentSpace {
        DocumentSpace {
            id: format!("{id_prefix}-{}", Uuid::new_v4().simple()),
            label: format!("{id_prefix} 공간"),
            root: root.to_path_buf(),
            privacy_domain: "company".into(),
            default_app: Some("obsidian".into()),
        }
    }

    #[test]
    fn load_at_without_file_wraps_root_as_default_space() {
        let root = tempdir("load-missing");
        let config = load_at(&root);
        assert_eq!(config.format_version, FORMAT_VERSION);
        assert_eq!(config.default_space_id.as_deref(), Some("default"));
        assert_eq!(config.spaces, vec![default_space(&root)]);
        assert_eq!(config.spaces[0].root, root);
    }

    #[test]
    fn save_at_then_load_at_round_trips_two_spaces() {
        let root = tempdir("roundtrip");
        let first = unique_space(&root, "first");
        let second = DocumentSpace {
            id: format!("second-{}", Uuid::new_v4().simple()),
            label: "두 번째 공간".into(),
            root: root.join("second"),
            privacy_domain: "project".into(),
            default_app: None,
        };
        let config = SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: Some(first.id.clone()),
            spaces: vec![first, second],
        };
        save_at(&root, &config).unwrap();
        assert_eq!(load_at(&root), config);
    }

    #[test]
    fn save_at_rejects_invalid_configs() {
        let root = tempdir("save-invalid");
        let space = unique_space(&root, "only");
        let config_for = |spaces: Vec<DocumentSpace>, default: Option<String>| SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: default,
            spaces,
        };

        assert_eq!(
            save_at(&root, &config_for(vec![], None)).unwrap_err(),
            "저장할 문서 공간이 없습니다"
        );

        let duplicated = unique_space(&root, "dup");
        let same_id = DocumentSpace {
            id: duplicated.id.clone(),
            ..unique_space(&root, "dup-other")
        };
        let err = save_at(
            &root,
            &config_for(
                vec![duplicated.clone(), same_id],
                Some(duplicated.id.clone()),
            ),
        )
        .unwrap_err();
        assert_eq!(err, format!("중복된 문서 공간 id입니다: {}", duplicated.id));

        let empty_id = DocumentSpace {
            id: String::new(),
            ..unique_space(&root, "empty")
        };
        assert_eq!(
            save_at(&root, &config_for(vec![empty_id], None)).unwrap_err(),
            "문서 공간 id가 비어 있습니다"
        );

        let missing_default = unique_space(&root, "no-default");
        let err = save_at(
            &root,
            &config_for(vec![missing_default], Some("ghost".into())),
        )
        .unwrap_err();
        assert_eq!(
            err,
            "기본 문서 공간 id가 등록된 공간을 가리키지 않습니다: ghost"
        );

        let blank_root = DocumentSpace {
            root: PathBuf::new(),
            ..unique_space(&root, "blank-root")
        };
        let err = save_at(&root, &config_for(vec![blank_root], None)).unwrap_err();
        assert!(err.contains("루트 경로가 비어 있습니다"));

        // 검증 실패로는 파일이 생기지 않는다.
        assert!(!spaces_path(&root).exists());
    }

    #[test]
    fn resolve_root_picks_default_specific_and_errors_on_unknown_id() {
        let root = tempdir("resolve");
        assert_eq!(resolve_root(&root, None).unwrap(), root);

        let other_root = root.join("other");
        fs::create_dir_all(&other_root).unwrap();
        let other = DocumentSpace {
            id: "work".into(),
            label: "작업 공간".into(),
            root: other_root.clone(),
            privacy_domain: "company".into(),
            default_app: None,
        };
        let config = SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: Some("default".into()),
            spaces: vec![default_space(&root), other],
        };
        save_at(&root, &config).unwrap();

        assert_eq!(resolve_root(&root, None).unwrap(), root);
        assert_eq!(resolve_root(&root, Some("work")).unwrap(), other_root);
        assert_eq!(space_at(&root, Some("work")).unwrap().label, "작업 공간");
        assert_eq!(
            resolve_root(&root, Some("ghost")).unwrap_err(),
            "문서 공간을 찾을 수 없습니다: ghost"
        );
    }

    #[test]
    fn resolve_root_falls_back_to_first_space_without_default_id() {
        let root = tempdir("resolve-first");
        let only = unique_space(&root, "only");
        let config = SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: None,
            spaces: vec![only],
        };
        save_at(&root, &config).unwrap();
        assert_eq!(resolve_root(&root, None).unwrap(), root);
    }

    #[test]
    fn resolve_root_errors_when_space_root_missing_on_disk() {
        let root = tempdir("resolve-missing-root");
        let missing = DocumentSpace {
            id: "void".into(),
            label: "없는 폴더".into(),
            root: root.join("void"),
            privacy_domain: "personal".into(),
            default_app: None,
        };
        let config = SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: Some("void".into()),
            spaces: vec![missing],
        };
        save_at(&root, &config).unwrap();
        let err = resolve_root(&root, None).unwrap_err();
        assert!(err.contains("루트 폴더가 없습니다"));
        assert!(err.contains("void"));
    }

    fn write_config_value(root: &Path, value: &serde_json::Value) {
        fs::create_dir_all(root.join(".sawhorse")).unwrap();
        fs::write(spaces_path(root), value.to_string()).unwrap();
    }

    fn single_space_config(root: &Path) -> SpacesConfig {
        SpacesConfig {
            format_version: FORMAT_VERSION,
            default_space_id: Some("a".into()),
            spaces: vec![DocumentSpace {
                id: "a".into(),
                label: "a".into(),
                root: root.to_path_buf(),
                privacy_domain: "personal".into(),
                default_app: None,
            }],
        }
    }

    #[test]
    fn load_at_falls_back_on_corrupted_json() {
        let root = tempdir("corrupt");
        fs::create_dir_all(root.join(".sawhorse")).unwrap();
        fs::write(spaces_path(&root), r#"{"formatVersion":1,"spaces":["#).unwrap();
        assert_eq!(load_at(&root).spaces, vec![default_space(&root)]);
    }

    #[test]
    fn load_at_falls_back_on_future_format_version() {
        let root = tempdir("version");
        let mut value = serde_json::to_value(single_space_config(&root)).unwrap();
        value["formatVersion"] = serde_json::Value::from(2u32);
        write_config_value(&root, &value);
        assert_eq!(load_at(&root).spaces, vec![default_space(&root)]);
    }

    #[test]
    fn load_at_falls_back_on_duplicate_or_empty_ids() {
        let root = tempdir("load-invalid");
        let mut value = serde_json::to_value(single_space_config(&root)).unwrap();
        let first = value["spaces"][0].clone();
        value["spaces"].as_array_mut().unwrap().push(first);
        write_config_value(&root, &value);
        assert_eq!(load_at(&root).spaces, vec![default_space(&root)]);

        let mut value = serde_json::to_value(single_space_config(&root)).unwrap();
        value["spaces"][0]["id"] = serde_json::Value::from(String::new());
        write_config_value(&root, &value);
        assert_eq!(load_at(&root).spaces, vec![default_space(&root)]);
    }
}
