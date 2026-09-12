//! DESIGN.md 표현 계층 바인딩 (v2 설계 §6, R1 최소 구성).
//!
//! HTML은 내용의 정본, DESIGN.md는 시각 지침의 정본. 작업이 어떤 디자인
//! 지침의 어느 revision에서 표현되는지 `DesignBinding`으로 기록하고,
//! 렌더에 필요한 의존성을 `PresentationLock`으로 고정한다. 새 기본 디자인이
//! 과거 작업을 자동 변경하지 않는다(설계 §6 "변경과 재현").

use std::fs;
use std::io;
use std::path::Path;

use uuid::Uuid;

/// 작업의 문서 표현이 따르는 디자인 지침 연결.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignBinding {
    /// 표현 목적. R1은 `document-view` 고정(app-shell/target-ui와 구분).
    pub purpose: String,
    /// 지침 출처 참조(예: `project:<project-id>/DESIGN.md`).
    pub source_ref: String,
    /// 지침 원문의 SHA-256 hex.
    pub revision: String,
}

/// 표현 재현에 필요한 의존성 고정(설계 §6 PresentationLock의 R1 최소 형태).
#[allow(dead_code)] // R1A 후속: 표현 lock UI·게시 파생이 소비한다.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentationLock {
    /// DESIGN.md 원문 digest.
    pub design_source_digest: String,
    /// 공통 문서 테마 revision(고정 테마, 초기 1).
    pub theme_revision: u32,
}

/// 작업의 디자인 바인딩을 해석한다. 프로젝트에 적용된 DESIGN.md가 있으면
/// 그 digest로 바인딩을 만들고, 없으면 `None`(무스타일 읽기만 허용).
/// 기존 `project_resources::design_digest` 경로를 재사용한다.
pub fn resolve_for_work(root: &Path, work_id: &str) -> Result<Option<DesignBinding>, String> {
    let project_id = work_project_id(root, work_id)?;
    if project_id.is_empty() {
        return Ok(None);
    }
    // `design_digest`는 디자인이 없어도 빈 문자열의 digest로 성공하므로,
    // 지침 존재 여부(project_context)로 무스타일(None)과 바인딩을 구분한다.
    if crate::sdlc::resources::project_context(root, &project_id)?.is_empty() {
        return Ok(None);
    }
    let revision = crate::sdlc::resources::design_digest(root, &project_id)?;
    Ok(Some(DesignBinding {
        purpose: "document-view".into(),
        source_ref: format!("project:{project_id}/DESIGN.md"),
        revision,
    }))
}

/// work.md frontmatter에서 `projectId`만 읽는다. `sdlc::work_by_id`가 비공개라
/// 같은 계약(id 검증 → frontmatter 파싱, 없음·깨짐은 Err)의 최소 형태로
/// 재현한다. 최상위 키만 본다(들여쓴 키는 중첩 구조).
fn work_project_id(root: &Path, work_id: &str) -> Result<String, String> {
    crate::sdlc::validate_id(work_id)?;
    let contents = fs::read_to_string(crate::sdlc::work_path(root, work_id))
        .map_err(|_| format!("존재하지 않는 작업: {work_id}"))?;
    let (rest, delimiter) = if let Some(rest) = contents.strip_prefix("---\r\n") {
        (rest, "\r\n---\r\n")
    } else if let Some(rest) = contents.strip_prefix("---\n") {
        (rest, "\n---\n")
    } else {
        return Err("YAML frontmatter가 없습니다".into());
    };
    let (yaml, _) = rest
        .split_once(delimiter)
        .ok_or_else(|| "YAML frontmatter 끝 표식이 없습니다".to_string())?;
    for line in yaml.lines() {
        if let Some(value) = line.strip_prefix("projectId:") {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            return Ok(value.trim().to_string());
        }
    }
    Ok(String::new())
}

#[allow(dead_code)] // R1A 후속: 표현 lock UI·게시 파생이 소비한다.
pub fn presentation_lock_for(binding: &DesignBinding) -> PresentationLock {
    PresentationLock {
        design_source_digest: binding.revision.clone(),
        theme_revision: 1,
    }
}

pub fn bind_at(root: &Path, work_id: &str, binding: &DesignBinding) -> Result<(), String> {
    crate::sdlc::validate_id(work_id)?;
    let path = crate::sdlc::work_path(root, work_id).with_file_name("design-binding.json");
    let contents = serde_json::to_string_pretty(binding).map_err(|e| e.to_string())?;
    write_binding_file(&path, &contents)
}

/// `sdlc::write_atomic`과 같은 tmp+rename 패턴(비공개라 재사용 불가).
/// 경로는 검증된 work id로 조립되므로 볼트 밖으로 나갈 수 없다.
fn write_binding_file(path: &Path, contents: &str) -> Result<(), String> {
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

#[allow(dead_code)] // 작업 상세의 표현 근거 표시(후속 UI)가 소비한다.
pub fn binding_at(root: &Path, work_id: &str) -> Result<Option<DesignBinding>, String> {
    crate::sdlc::validate_id(work_id)?;
    let path = crate::sdlc::work_path(root, work_id).with_file_name("design-binding.json");
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    // 바인딩은 부가 메타데이터다: 깨진 기록은 "기록 없음"으로 대우해 문서
    // 읽기를 막지 않는다(resolve_for_work로 다시 계산 가능).
    Ok(serde_json::from_str(&contents).ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    use sha2::Digest;

    fn write_work(root: &Path, id: &str, project_id: &str) {
        let dir = root.join("work").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("work.md"),
            format!("---\nid: {id}\nprojectId: {project_id}\ntitle: {id}\n---\n\n# {id}\n"),
        )
        .unwrap();
    }

    fn write_project(root: &Path, id: &str) {
        let dir = root.join("projects").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("project.md"),
            format!("---\nid: {id}\nname: {id}\n---\n\n# {id}\n"),
        )
        .unwrap();
    }

    fn sample_binding(revision: &str) -> DesignBinding {
        DesignBinding {
            purpose: "document-view".into(),
            source_ref: "project:p/DESIGN.md".into(),
            revision: revision.into(),
        }
    }

    #[test]
    fn resolve_for_work_is_none_without_design_and_err_without_work() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_project(root, "p");
        write_work(root, "w1", "p");
        assert_eq!(resolve_for_work(root, "w1").unwrap(), None);
        assert!(resolve_for_work(root, "missing").is_err());
    }

    #[test]
    fn resolve_for_work_binds_applied_design_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_project(root, "p");
        write_work(root, "w1", "p");
        let project = root.join("projects/p");
        fs::write(
            project.join("resources.json"),
            r#"{"designId":"d1","templates":{}}"#,
        )
        .unwrap();
        fs::write(project.join("DESIGN.md"), "# Applied design\n").unwrap();
        let binding = resolve_for_work(root, "w1").unwrap().unwrap();
        assert_eq!(binding.purpose, "document-view");
        assert_eq!(binding.source_ref, "project:p/DESIGN.md");
        assert_eq!(
            binding.revision,
            hex::encode(sha2::Sha256::digest("# Applied design\n".as_bytes()))
        );
        fs::write(project.join("DESIGN.md"), "# Updated design\n").unwrap();
        let updated = resolve_for_work(root, "w1").unwrap().unwrap();
        assert_ne!(updated.revision, binding.revision);
        assert_eq!(
            updated.revision,
            hex::encode(sha2::Sha256::digest("# Updated design\n".as_bytes()))
        );
    }

    #[test]
    fn presentation_lock_freezes_design_digest_and_theme() {
        let lock = presentation_lock_for(&sample_binding("abc123"));
        assert_eq!(lock.design_source_digest, "abc123");
        assert_eq!(lock.theme_revision, 1);
    }

    #[test]
    fn bind_at_and_binding_at_roundtrip_tolerates_absent_and_broken() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_work(root, "w1", "p");
        assert_eq!(binding_at(root, "w1").unwrap(), None);
        let binding = sample_binding("deadbeef");
        bind_at(root, "w1", &binding).unwrap();
        assert_eq!(binding_at(root, "w1").unwrap(), Some(binding));
        let dir = root.join("work/w1");
        let stored = fs::read_to_string(dir.join("design-binding.json")).unwrap();
        assert!(
            stored.contains("\n  \"purpose\""),
            "pretty JSON으로 기록한다: {stored}"
        );
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".sawhorse-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "tmp 파일이 남지 않는다: {leftovers:?}"
        );
        fs::write(dir.join("design-binding.json"), "{ broken").unwrap();
        assert_eq!(binding_at(root, "w1").unwrap(), None);
        assert!(binding_at(root, "../escape").is_err());
    }
}
