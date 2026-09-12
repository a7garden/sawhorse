//! 실행 입력 고정 — ContextSnapshot (v2 설계 §8, R1 최소 형태).
//!
//! 실행 시점의 필수 산출물을 정확한 revision으로 고정해 "무엇을 전달했는가"를
//! 보존한다. 현재 `LaunchContext`+`build_prompt`가 프롬프트에 주입하는 산출물
//! 경로 목록 위에, 파일 내용 digest 스냅샷을 얹는 것이 R1 범위다. payload
//! bytes 보존(objects)은 후속 단위가 확장한다.

use std::fs;
use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

/// 한 번의 실행에 전달된 필수 입력의 고정 기록.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextSnapshot {
    pub format_version: u32,
    pub work_id: String,
    pub run_id: String,
    /// 필수 입력: 볼트 상대 경로와 그 시점의 SHA-256 revision.
    pub mandatory: Vec<MandatoryInput>,
    /// 전체 필수 입력을 함께 해시한 digest(순서 안정).
    pub payload_digest: String,
    /// 기록 시각(RFC 3339 UTC).
    pub recorded_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MandatoryInput {
    pub source_ref: String,
    pub revision: String,
}

/// 실행 직전 필수 산출물들의 revision을 수집한다. 없는 파일은 Err(실행 차단
/// 정신, 설계 §8 "필수 입력이 누락·손상되면 실행하지 않는다").
pub fn capture_at(
    root: &Path,
    work_id: &str,
    run_id: &str,
    artifact_paths: &[PathBuf],
) -> Result<ContextSnapshot, String> {
    let mut mandatory = Vec::with_capacity(artifact_paths.len());
    for artifact_path in artifact_paths {
        safe_path(root, artifact_path)?;
        let bytes = fs::read(artifact_path).map_err(|error| {
            let path = artifact_path.display();
            if error.kind() == std::io::ErrorKind::NotFound {
                format!("필수 입력 누락(실행 차단): {path}")
            } else {
                format!("필수 입력 읽기 실패: {path} ({error})")
            }
        })?;
        let source_ref = source_ref_of(root, artifact_path)?;
        mandatory.push(MandatoryInput {
            source_ref,
            revision: hex::encode(Sha256::digest(&bytes)),
        });
    }
    Ok(ContextSnapshot {
        format_version: 1,
        work_id: work_id.to_string(),
        run_id: run_id.to_string(),
        payload_digest: payload_digest_of(&mandatory),
        mandatory,
        recorded_at: Utc::now().to_rfc3339(),
    })
}

/// 스냅샷을 `runs/<run_id>.context.json`에 원자적으로 기록하고 경로를 반환한다
/// (`runs/<run_id>.transcript.md`와 같은 runs 메타데이터 관례).
pub fn record_at(root: &Path, snapshot: &ContextSnapshot) -> Result<PathBuf, String> {
    validate_run_id(&snapshot.run_id)?;
    let path = root
        .join("runs")
        .join(format!("{}.context.json", snapshot.run_id));
    let contents = serde_json::to_string_pretty(snapshot)
        .map_err(|error| format!("스냅샷 직렬화 실패: {error}"))?;
    write_atomic(root, &path, &contents)?;
    Ok(path)
}

fn source_ref_of(root: &Path, artifact_path: &Path) -> Result<String, String> {
    let relative = artifact_path
        .strip_prefix(root)
        .map_err(|_| "볼트 밖 경로입니다".to_string())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

/// 전체 필수 입력을 (source_ref + revision) 순서 결합 문자열의 SHA-256으로
/// 묶는다. 입력 순서가 바뀌면 digest도 바뀐다.
fn payload_digest_of(mandatory: &[MandatoryInput]) -> String {
    let combined: String = mandatory
        .iter()
        .map(|input| format!("{}{}", input.source_ref, input.revision))
        .collect();
    hex::encode(Sha256::digest(combined.as_bytes()))
}

fn validate_run_id(run_id: &str) -> Result<(), String> {
    if run_id.is_empty()
        || run_id == "."
        || run_id == ".."
        || run_id.contains('/')
        || run_id.contains('\\')
        || run_id.contains('\0')
    {
        return Err(format!("안전하지 않은 run_id: {run_id}"));
    }
    Ok(())
}

// 이하 세 헬퍼(canonical_root·safe_path·write_atomic)는 sdlc.rs의 동일 구현이
// 모듈 비공개라 R1에서 복제한 것이다. 문서 쪽 fs 관심사가 모이는 후속 단위에서
// 공유 지점으로 올린다.

fn canonical_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("볼트 폴더가 없습니다: {}", root.display()));
    }
    root.canonicalize()
        .map_err(|e| format!("볼트 경로 확인 실패: {e}"))
}

/// Reject `..`, absolute paths, and existing symlinks which leave the vault.
fn safe_path(root: &Path, target: &Path) -> Result<(), String> {
    let canonical = canonical_root(root)?;
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "볼트 밖 경로입니다".to_string())?;
    if relative.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("볼트 밖 경로입니다".into());
    }
    let mut probe = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("안전하지 않은 경로입니다".into());
        };
        probe.push(name);
        if probe.exists() {
            let actual = probe
                .canonicalize()
                .map_err(|e| format!("경로 확인 실패: {e}"))?;
            if !actual.starts_with(&canonical) {
                return Err("심볼릭 링크가 볼트 밖을 가리킵니다".into());
            }
        }
    }
    Ok(())
}

fn write_atomic(root: &Path, path: &Path, contents: &str) -> Result<(), String> {
    safe_path(root, path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "파일의 상위 폴더가 없습니다".to_string())?;
    safe_path(root, parent)?;
    fs::create_dir_all(parent).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    safe_path(root, parent)?;
    let temporary = parent.join(format!(".sawhorse-{}.tmp", Uuid::new_v4()));
    safe_path(root, &temporary)?;
    fs::write(&temporary, contents).map_err(|e| format!("파일 쓰기 실패: {e}"))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("파일 교체 실패: {e}")
    })
}

#[cfg(test)]
mod tests {
    // v2-ctx: 단위 테스트 —
    // - capture_at: 여러 산출물 revision 수집·순서 안정, 없는 파일 Err,
    //   볼트 밖 경로 거부
    // - payload_digest: 같은 입력 같은 값, 하나라도 바뀌면 다른 값
    // - record_at: 파일 생성·JSON 왕복, 두 번 기록(재시도)은 덮어쓰기
    use super::*;
    use tempfile::tempdir;

    fn write_artifact(root: &Path, relative: &str, body: &str) -> PathBuf {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn captures_revisions_in_input_order() {
        let root = tempdir().unwrap();
        let spec = write_artifact(root.path(), "work/w1/spec.md", "alpha");
        let goal = write_artifact(root.path(), "work/w1/goal.md", "beta");
        let snapshot =
            capture_at(root.path(), "w1", "run-1", &[goal.clone(), spec.clone()]).unwrap();
        assert_eq!(snapshot.format_version, 1);
        assert_eq!(snapshot.work_id, "w1");
        assert_eq!(snapshot.run_id, "run-1");
        assert_eq!(snapshot.mandatory[0].source_ref, "work/w1/goal.md");
        assert_eq!(
            snapshot.mandatory[0].revision,
            hex::encode(Sha256::digest(b"beta"))
        );
        assert_eq!(snapshot.mandatory[1].source_ref, "work/w1/spec.md");
        assert_eq!(
            snapshot.mandatory[1].revision,
            hex::encode(Sha256::digest(b"alpha"))
        );
        chrono::DateTime::parse_from_rfc3339(&snapshot.recorded_at).unwrap();
    }

    #[test]
    fn missing_mandatory_input_is_an_error() {
        let root = tempdir().unwrap();
        let absent = root.path().join("work/w/absent.md");
        assert!(capture_at(root.path(), "w", "run-1", &[absent]).is_err());
    }

    #[test]
    fn paths_outside_vault_are_rejected() {
        let root = tempdir().unwrap();
        assert!(capture_at(root.path(), "w", "run-1", &[PathBuf::from("../escape.md")]).is_err());
        let escape = root.path().join("../escape.md");
        assert!(capture_at(root.path(), "w", "run-1", &[escape]).is_err());
        let foreign = tempdir().unwrap();
        let outside = foreign.path().join("other.md");
        fs::write(&outside, "body").unwrap();
        assert!(capture_at(root.path(), "w", "run-1", &[outside]).is_err());
    }

    #[test]
    fn payload_digest_is_stable_and_input_sensitive() {
        let root = tempdir().unwrap();
        let a = write_artifact(root.path(), "work/w/a.md", "one");
        let b = write_artifact(root.path(), "work/w/b.md", "two");
        let first = capture_at(root.path(), "w", "run-1", &[a.clone(), b.clone()]).unwrap();
        let repeat = capture_at(root.path(), "w", "run-1", &[a.clone(), b.clone()]).unwrap();
        assert_eq!(first.payload_digest, repeat.payload_digest);
        let swapped = capture_at(root.path(), "w", "run-1", &[b.clone(), a.clone()]).unwrap();
        assert_ne!(first.payload_digest, swapped.payload_digest);
        fs::write(&b, "rewritten").unwrap();
        let changed = capture_at(root.path(), "w", "run-1", &[a, b]).unwrap();
        assert_ne!(first.payload_digest, changed.payload_digest);
    }

    #[test]
    fn record_at_writes_readable_json_and_roundtrips() {
        let root = tempdir().unwrap();
        let spec = write_artifact(root.path(), "work/w/spec.md", "body");
        let snapshot = capture_at(root.path(), "w", "run-42", &[spec]).unwrap();
        let path = record_at(root.path(), &snapshot).unwrap();
        assert_eq!(path, root.path().join("runs/run-42.context.json"));
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"formatVersion\""));
        let restored: ContextSnapshot = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            serde_json::to_string(&restored).unwrap(),
            serde_json::to_string(&snapshot).unwrap()
        );
    }

    #[test]
    fn record_at_rejects_unsafe_run_ids() {
        let root = tempdir().unwrap();
        let spec = write_artifact(root.path(), "work/w/spec.md", "body");
        let mut snapshot = capture_at(root.path(), "w", "run-1", &[spec]).unwrap();
        for bad in ["../x", "a/b", "a\\b", ".."] {
            snapshot.run_id = bad.to_string();
            assert!(
                record_at(root.path(), &snapshot).is_err(),
                "run_id {bad:?} must be rejected"
            );
        }
        assert!(!root.path().join("runs").exists());
    }

    #[test]
    fn record_at_rewrites_over_previous_record() {
        let root = tempdir().unwrap();
        let spec = write_artifact(root.path(), "work/w/spec.md", "v1");
        let first = capture_at(root.path(), "w", "run-7", &[spec.clone()]).unwrap();
        record_at(root.path(), &first).unwrap();
        fs::write(&spec, "v2").unwrap();
        let second = capture_at(root.path(), "w", "run-7", &[spec]).unwrap();
        assert_ne!(first.payload_digest, second.payload_digest);
        let path = record_at(root.path(), &second).unwrap();
        let restored: ContextSnapshot =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            serde_json::to_string(&restored).unwrap(),
            serde_json::to_string(&second).unwrap()
        );
        let entries: Vec<_> = fs::read_dir(root.path().join("runs")).unwrap().collect();
        assert_eq!(entries.len(), 1);
    }
}
