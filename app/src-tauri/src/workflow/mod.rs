pub mod builtins;
pub mod engine;
pub mod ledger;
pub mod model;
pub mod runtime;
pub mod validation;

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub use model::*;

pub fn definition_digest(definition: &WorkflowDefinition) -> Result<String, String> {
    let bytes = serde_json::to_vec(definition)
        .map_err(|error| format!("workflow digest 직렬화 실패: {error}"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn definition_path(root: &Path, id: &str, version: &str) -> PathBuf {
    root.join(".sawhorse")
        .join("workflows")
        .join(id)
        .join(format!("{version}.json"))
}

fn valid_storage_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "저장 경로의 상위 폴더가 없습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("폴더 생성 실패: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let json =
        serde_json::to_vec_pretty(value).map_err(|error| format!("JSON 직렬화 실패: {error}"))?;
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("임시 파일 생성 실패: {error}"))?;
        file.write_all(&json)
            .map_err(|error| format!("임시 파일 쓰기 실패: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("임시 파일 동기화 실패: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("파일 교체 실패: {error}")
    })
}

fn draft_path(root: &Path, draft_id: &str) -> Result<PathBuf, String> {
    if !valid_storage_key(draft_id) {
        return Err("유효하지 않은 workflow draft ID입니다".into());
    }
    Ok(root
        .join(".sawhorse")
        .join("drafts")
        .join("workflows")
        .join(format!("{draft_id}.json")))
}

pub fn save_draft_at(
    root: &Path,
    input: WorkflowDraftSaveInput,
) -> Result<WorkflowDraftRecord, String> {
    let record = WorkflowDraftRecord {
        draft_id: input.draft_id,
        validation: validation::validate(&input.definition),
        definition: input.definition,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_json_atomic(&draft_path(root, &record.draft_id)?, &record)?;
    Ok(record)
}

pub fn list_drafts_at(root: &Path) -> Result<Vec<WorkflowDraftRecord>, String> {
    let directory = root.join(".sawhorse").join("drafts").join("workflows");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("workflow draft 목록 실패: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    let mut drafts = Vec::with_capacity(paths.len());
    for path in paths {
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("workflow draft 읽기 실패: {error}"))?;
        let mut record: WorkflowDraftRecord = serde_json::from_str(&text)
            .map_err(|error| format!("workflow draft 파싱 실패: {error}"))?;
        record.validation = validation::validate(&record.definition);
        drafts.push(record);
    }
    drafts.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(drafts)
}

pub fn delete_draft_at(root: &Path, draft_id: &str) -> Result<(), String> {
    let path = draft_path(root, draft_id)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("workflow draft 삭제 실패: {error}"))?;
    }
    Ok(())
}

pub fn publish_at(
    root: &Path,
    definition: WorkflowDefinition,
) -> Result<WorkflowDefinition, String> {
    let report = validation::validate(&definition);
    if !report.valid {
        return Err(format!(
            "유효하지 않은 workflow는 발행할 수 없습니다: {:?}",
            report.issues
        ));
    }
    let mut registry = catalog(Some(root))?;
    if let Some(existing) = registry
        .iter()
        .find(|candidate| candidate.id == definition.id && candidate.version == definition.version)
    {
        if existing == &definition {
            return Ok(definition);
        }
        return Err(format!(
            "이미 발행된 workflow {}@{}는 바꿀 수 없습니다. 새 버전을 사용하세요",
            definition.id, definition.version
        ));
    }
    registry.push(definition.clone());
    let issues = validation::validate_registry(&registry);
    if !issues.is_empty() {
        return Err(format!("workflow registry 검증 실패: {issues:?}"));
    }
    let path = definition_path(root, &definition.id, &definition.version);
    if path.exists() {
        return Err("같은 workflow revision 파일이 이미 있습니다".into());
    }
    write_json_atomic(&path, &definition)?;
    Ok(definition)
}

pub fn ensure_builtins(root: &Path) -> Result<(), String> {
    for definition in builtins::all() {
        let report = validation::validate(&definition);
        if !report.valid {
            return Err(format!(
                "번들 workflow {}가 유효하지 않습니다: {:?}",
                definition.id, report.issues
            ));
        }
        let path = definition_path(root, &definition.id, &definition.version);
        let parent = path
            .parent()
            .ok_or_else(|| "workflow 경로의 상위 폴더가 없습니다".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("workflow 폴더 생성 실패: {error}"))?;
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let json = serde_json::to_string_pretty(&definition)
                    .map_err(|error| format!("workflow 직렬화 실패: {error}"))?;
                file.write_all(json.as_bytes())
                    .map_err(|error| format!("workflow 쓰기 실패: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("workflow 동기화 실패: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                // Published revisions are immutable and are never overwritten by an app update.
                let existing = load_file(&path)?;
                let report = validation::validate(&existing);
                if !report.valid {
                    return Err(format!(
                        "저장된 workflow {}@{}가 손상되었습니다",
                        definition.id, definition.version
                    ));
                }
                if existing != definition {
                    return Err(format!(
                        "번들 workflow {}@{} 내용이 변경되었습니다. 새 버전으로 게시해야 합니다",
                        definition.id, definition.version
                    ));
                }
            }
            Err(error) => return Err(format!("workflow 쓰기 실패: {error}")),
        }
    }
    Ok(())
}

fn load_file(path: &Path) -> Result<WorkflowDefinition, String> {
    let text = fs::read_to_string(path).map_err(|error| format!("workflow 읽기 실패: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("workflow JSON 파싱 실패: {error}"))
}

pub fn catalog(root: Option<&Path>) -> Result<Vec<WorkflowDefinition>, String> {
    let mut definitions = builtins::all();
    let Some(root) = root else {
        return Ok(definitions);
    };
    let directory = root.join(".sawhorse").join("workflows");
    if !directory.is_dir() {
        return Ok(definitions);
    }
    let mut paths = Vec::new();
    for package in
        fs::read_dir(&directory).map_err(|error| format!("workflow 목록 실패: {error}"))?
    {
        let package = package.map_err(|error| format!("workflow 목록 항목 실패: {error}"))?;
        if !package
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        for entry in fs::read_dir(package.path())
            .map_err(|error| format!("workflow 버전 목록 실패: {error}"))?
        {
            let entry = entry.map_err(|error| format!("workflow 버전 항목 실패: {error}"))?;
            if entry.path().extension().and_then(|value| value.to_str()) == Some("json") {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    for path in paths {
        let definition = load_file(&path)?;
        let report = validation::validate(&definition);
        if !report.valid {
            return Err(format!(
                "workflow {}가 유효하지 않습니다: {:?}",
                path.display(),
                report.issues
            ));
        }
        if let Some(index) = definitions.iter().position(|candidate| {
            candidate.id == definition.id && candidate.version == definition.version
        }) {
            if definitions[index] != definition {
                return Err(format!(
                    "같은 id/version의 workflow 내용이 다릅니다: {}@{}",
                    definition.id, definition.version
                ));
            }
        } else {
            definitions.push(definition);
        }
    }
    definitions.sort_by(|left, right| {
        left.label
            .cmp(&right.label)
            .then(left.id.cmp(&right.id))
            .then(left.version.cmp(&right.version))
    });
    let registry_issues = validation::validate_registry(&definitions);
    if !registry_issues.is_empty() {
        return Err(format!(
            "workflow registry가 유효하지 않습니다: {registry_issues:?}"
        ));
    }
    Ok(definitions)
}

pub fn resolve(root: Option<&Path>, id: &str, version: &str) -> Result<WorkflowDefinition, String> {
    catalog(root)?
        .into_iter()
        .find(|definition| definition.id == id && definition.version == version)
        .ok_or_else(|| format!("workflow를 찾을 수 없습니다: {id}@{version}"))
}

pub fn resolve_artifact_path(
    root: &Path,
    definition: &WorkflowDefinition,
    work_id: &str,
    project_id: &str,
    role: &str,
) -> Result<PathBuf, String> {
    let artifact = definition
        .artifacts
        .iter()
        .find(|artifact| artifact.role == role)
        .ok_or_else(|| format!("workflow에 artifact role이 없습니다: {role}"))?;
    let relative = artifact
        .path
        .replace("{workId}", work_id)
        .replace("{projectId}", project_id);
    let path = Path::new(&relative);
    if path.is_absolute()
        || path.components().any(|component| {
            !matches!(component, Component::Normal(_))
                || matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
        })
        || relative.starts_with(".sawhorse/")
    {
        return Err("workflow artifact 경로가 볼트 밖을 가리킵니다".into());
    }
    Ok(root.join(path))
}

#[tauri::command]
pub fn workflow_catalog() -> Result<Vec<WorkflowDefinition>, String> {
    let root = crate::sdlc::vault_root().ok();
    catalog(root.as_deref())
}

#[tauri::command]
pub fn workflow_validate(definition: WorkflowDefinition) -> ValidationReport {
    validation::validate(&definition)
}

#[tauri::command]
pub fn workflow_simulate(input: SimulationInput) -> SimulationResult {
    runtime::simulate(input)
}

#[tauri::command]
pub fn workflow_draft_list() -> Result<Vec<WorkflowDraftRecord>, String> {
    list_drafts_at(&crate::sdlc::vault_root()?)
}

#[tauri::command]
pub fn workflow_draft_save(input: WorkflowDraftSaveInput) -> Result<WorkflowDraftRecord, String> {
    save_draft_at(&crate::sdlc::vault_root()?, input)
}

#[tauri::command]
pub fn workflow_draft_delete(draft_id: String) -> Result<(), String> {
    delete_draft_at(&crate::sdlc::vault_root()?, &draft_id)
}

#[tauri::command]
pub fn workflow_publish(definition: WorkflowDefinition) -> Result<WorkflowDefinition, String> {
    publish_at(&crate::sdlc::vault_root()?, definition)
}

#[tauri::command]
pub fn workflow_export(definition: WorkflowDefinition) -> Result<String, String> {
    let report = validation::validate(&definition);
    if !report.valid {
        return Err("유효한 workflow만 내보낼 수 있습니다".into());
    }
    serde_json::to_string_pretty(&definition)
        .map(|value| format!("{value}\n"))
        .map_err(|error| format!("workflow 내보내기 실패: {error}"))
}

#[tauri::command]
pub fn workflow_import(json: String) -> Result<WorkflowDraftRecord, String> {
    let definition: WorkflowDefinition = serde_json::from_str(&json)
        .map_err(|error| format!("workflow JSON 가져오기 실패: {error}"))?;
    save_draft_at(
        &crate::sdlc::vault_root()?,
        WorkflowDraftSaveInput {
            draft_id: format!("import-{}", Uuid::new_v4()),
            definition,
        },
    )
}

#[tauri::command]
pub fn workflow_activate(
    project_id: String,
    workflow_id: String,
    workflow_version: String,
) -> Result<crate::sdlc::Project, String> {
    let root = crate::sdlc::vault_root()?;
    crate::sdlc::activate_project_workflow_at(&root, &project_id, &workflow_id, &workflow_version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn tempdir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("sawhorse-workflow-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn published_builtins_are_idempotent_and_not_overwritten() {
        let root = tempdir();
        ensure_builtins(&root).unwrap();
        let path = definition_path(&root, DEFAULT_WORKFLOW_ID, DEFAULT_WORKFLOW_VERSION);
        let original = fs::read_to_string(&path).unwrap();
        ensure_builtins(&root).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn artifact_resolver_is_binding_based_and_stays_in_vault() {
        let root = tempdir();
        let definition = builtins::tdd();
        let path = resolve_artifact_path(&root, &definition, "w-1", "p-1", "red-evidence").unwrap();
        assert_eq!(path, root.join("work/w-1/red-evidence.md"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn drafts_are_mutable_but_published_versions_are_immutable() {
        let root = tempdir();
        let mut definition = builtins::tdd();
        definition.id = "team-tdd".into();
        definition.version = "2.0.0".into();
        let draft = save_draft_at(
            &root,
            WorkflowDraftSaveInput {
                draft_id: "team-tdd-draft".into(),
                definition: definition.clone(),
            },
        )
        .unwrap();
        assert!(draft.validation.valid);
        assert_eq!(list_drafts_at(&root).unwrap().len(), 1);
        publish_at(&root, definition.clone()).unwrap();
        let mut changed = definition;
        changed.label = "changed".into();
        assert!(publish_at(&root, changed).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
