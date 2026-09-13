//! 레거시 ID → UUIDv7 매핑 저장소 — Stage 0 동결.
//!
//! 매핑 규칙: UUID형이 아닌 work/project/artifact ID는 UUIDv7을 **한 번만**
//! 할당하고 참조 재기록 전에 이 저장소에 영속화한다. 저장소는 볼트당 하나,
//! `<root>/.sawhorse/pdc/id-map.json`뿐이다. 손상되면 조용히 새로 시작하지
//! 않고 오류를 낸다 — 매핑 유실은 곧 참조 유실이다.

#![allow(dead_code)] // Stage 0 동결물 — Stage 3/4 참조 재기록이 소비한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 볼트 루트 기준 저장소 경로.
pub const STORE_RELATIVE: &str = ".sawhorse/pdc/id-map.json";

/// 저장소 형식 버전. 부가 진화만 허용된다.
const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MappingEntry {
    /// 정규 표기(소문자 하이픈) UUIDv7.
    uuid: String,
    /// 할당 시각(유닉스 밀리초).
    allocated_at_ms: u64,
    /// 미래 부가 필드 보존 — v1 판독기는 해석하지 않고 그대로 되쓴다.
    #[serde(flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    format_version: u32,
    mappings: BTreeMap<String, MappingEntry>,
    /// 미래 부가 필드 보존.
    #[serde(default, flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

fn store_path(root: &Path) -> PathBuf {
    root.join(STORE_RELATIVE)
}

/// 저장소를 읽는다. 파일이 없으면 빈 저장소, 있으면 형식 검사 후 돌려준다.
/// 깨진 JSON과 미지 형식은 오류이지 폴백이 아니다.
fn load(root: &Path) -> Result<StoreFile, String> {
    let path = store_path(root);
    if !path.is_file() {
        return Ok(StoreFile {
            format_version: FORMAT_VERSION,
            ..StoreFile::default()
        });
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("매핑 저장소 읽기 실패({}): {e}", path.display()))?;
    let store: StoreFile = serde_json::from_str(&text)
        .map_err(|e| format!("매핑 저장소가 손상되었습니다({}): {e}", path.display()))?;
    if store.format_version != FORMAT_VERSION {
        return Err(format!(
            "매핑 저장소 형식 v{}은(는) 지원되지 않습니다(v{FORMAT_VERSION} 필요)",
            store.format_version
        ));
    }
    Ok(store)
}

/// 임시 파일 기록 후 rename — `document_spaces::write_atomic`과 같은 패턴.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "파일의 상위 폴더가 없습니다".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let temporary = parent.join(format!(".pdc-{}.tmp", Uuid::new_v4()));
    std::fs::write(&temporary, contents).map_err(|e| format!("파일 쓰기 실패: {e}"))?;
    std::fs::rename(&temporary, path).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        format!("파일 교체 실패: {e}")
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 저장 키로 쓸 수 있는 레거시 ID인지 — 세그먼트 하나짜리 비어 있지 않은
/// 식별자면 충분하다(알파벳 제한은 두지 않는다: 한글 ID가 실존한다).
fn validate_legacy_id(legacy_id: &str) -> Result<(), String> {
    if legacy_id.is_empty() || legacy_id.len() > 128 {
        return Err(format!("레거시 ID 길이가 부적절합니다: {}자", legacy_id.len()));
    }
    if legacy_id == "." || legacy_id == ".." {
        return Err(format!("안전하지 않은 레거시 ID: {legacy_id}"));
    }
    if legacy_id.contains(['/', '\\']) {
        return Err(format!("레거시 ID에 구분자가 있습니다: {legacy_id}"));
    }
    if legacy_id.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("레거시 ID에 제어 문자가 있습니다".into());
    }
    Ok(())
}

/// UUID를 정규 표기(소문자 하이픈)로 바꾼다. 파싱 불가면 `None`.
fn canonical(uuid: &str) -> Option<String> {
    Uuid::parse_str(uuid).ok().map(|parsed| parsed.to_string())
}

/// `legacy_id`의 매핑을 조회한다. 있으면 정규 표기 UUID를, 없으면 `None`.
pub fn lookup(root: &Path, legacy_id: &str) -> Result<Option<String>, String> {
    validate_legacy_id(legacy_id)?;
    Ok(load(root)?
        .mappings
        .get(legacy_id)
        .and_then(|entry| canonical(&entry.uuid)))
}

/// 매핑을 조회해 없으면 UUIDv7을 새로 할당한다.
///
/// 반환값은 `(정규 표기 uuid, 이번에 새로 할당했는가)`다. 기존 매핑은
/// 절대 재할당하지 않고, 새 할당은 반환 전에 원자적으로 영속화한다(계약:
/// "Allocate once and persist the mapping before rewriting references").
pub fn allocate(root: &Path, legacy_id: &str) -> Result<(String, bool), String> {
    validate_legacy_id(legacy_id)?;
    let mut store = load(root)?;
    if let Some(entry) = store.mappings.get(legacy_id) {
        let uuid = canonical(&entry.uuid).ok_or_else(|| {
            format!(
                "레거시 ID `{legacy_id}`의 매핑 UUID가 손상되었습니다: {}",
                entry.uuid
            )
        })?;
        return Ok((uuid, false));
    }
    let entry = MappingEntry {
        uuid: Uuid::now_v7().to_string(),
        allocated_at_ms: now_ms(),
        extra: BTreeMap::new(),
    };
    let uuid = entry.uuid.clone();
    store.mappings.insert(legacy_id.to_string(), entry);
    let text = serde_json::to_string_pretty(&store)
        .map_err(|e| format!("매핑 저장소 직렬화 실패: {e}"))?;
    write_atomic(&store_path(root), &text)?;
    Ok((uuid, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tempdir(tag: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sawhorse-pdc-idmap-{tag}-{}",
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn allocate_is_once_and_persisted() {
        let root = tempdir("allocate-once");
        let (first, allocated_first) = allocate(&root, "proj-a").unwrap();
        assert!(allocated_first);
        // 영속화는 반환 전에 끝난다.
        assert!(store_path(&root).is_file());

        let (second, allocated_second) = allocate(&root, "proj-a").unwrap();
        assert!(!allocated_second);
        assert_eq!(first, second, "재할당은 계약 위반이다");

        // 서로 다른 레거시 ID는 서로 다른 UUID를 받는다.
        let (other, _) = allocate(&root, "proj-b").unwrap();
        assert_ne!(first, other);
        assert_eq!(lookup(&root, "proj-a").unwrap().as_deref(), Some(first.as_str()));
    }

    #[test]
    fn uuids_are_version7_and_canonically_spelled() {
        let root = tempdir("v7");
        let (uuid, _) = allocate(&root, "w-1").unwrap();
        let parsed = Uuid::parse_str(&uuid).unwrap();
        assert_eq!(parsed.get_version_num(), 7);
        assert_eq!(uuid, uuid.to_lowercase());
        assert!(uuid.contains('-'), "하이픈 표기가 정규 표기다");
    }

    #[test]
    fn canonicalizes_existing_store_entries_on_read() {
        let root = tempdir("canonical");
        let path = store_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
  "formatVersion": 1,
  "mappings": {
    "old-id": { "uuid": "018F0000000000007000800000000000", "allocatedAtMs": 1 }
  }
}"#,
        )
        .unwrap();
        // 무낸 하이픈·대문자도 정규 표기로 돌아온다.
        assert_eq!(
            lookup(&root, "old-id").unwrap().as_deref(),
            Some("018f0000-0000-0000-7000-800000000000")
        );
        let (uuid, allocated) = allocate(&root, "old-id").unwrap();
        assert!(!allocated);
        assert_eq!(uuid, "018f0000-0000-0000-7000-800000000000");
    }

    #[test]
    fn corrupt_store_errors_instead_of_resetting() {
        let root = tempdir("corrupt");
        let path = store_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ not json").unwrap();
        assert!(allocate(&root, "w-1").is_err());
        assert!(lookup(&root, "w-1").is_err());
        // 오류 후에도 원본 bytes는 그대로다 — 조용한 재시작이 최악의 결과다.
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn wrong_format_version_is_rejected() {
        let root = tempdir("future-format");
        let path = store_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, r#"{ "formatVersion": 2, "mappings": {} }"#).unwrap();
        let error = allocate(&root, "w-1").unwrap_err();
        assert!(error.contains("v2"), "미지 형식은 오류다: {error}");
    }

    #[test]
    fn unknown_fields_survive_reallocation() {
        let root = tempdir("preserve");
        let path = store_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            r#"{
  "formatVersion": 1,
  "mappings": {
    "kept": { "uuid": "018f0000-0000-0000-7000-800000000000", "allocatedAtMs": 1, "futureNote": "keep me" }
  },
  "futureSection": { "a": 1 }
}"#,
        )
        .unwrap();
        // 기존 항목은 건드리지 않는다.
        allocate(&root, "newcomer").unwrap();
        let store: serde_json::Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(store["futureSection"]["a"], 1);
        assert_eq!(store["mappings"]["kept"]["futureNote"], "keep me");
        assert!(store["mappings"]["newcomer"]["uuid"].is_string());
    }

    #[test]
    fn unsafe_legacy_ids_are_rejected() {
        let root = tempdir("unsafe");
        for bad in ["", ".", "..", "a/b", "a\\b", "x\x01y"] {
            assert!(allocate(&root, bad).is_err(), "{bad:?}는 거부되어야 한다");
        }
        // 한글 ID는 실존하는 레거시 ID다 — 받아야 한다.
        assert!(allocate(&root, "골든-프로젝트").is_ok());
    }

    #[test]
    fn store_lives_at_the_frozen_stage_zero_path() {
        assert_eq!(STORE_RELATIVE, ".sawhorse/pdc/id-map.json");
        let root = tempdir("path");
        allocate(&root, "w-9").unwrap();
        assert!(root.join(".sawhorse").join("pdc").join("id-map.json").is_file());
    }
}
