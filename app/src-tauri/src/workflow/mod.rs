pub mod builtins;
pub mod engine;
pub mod ledger;
pub mod model;
pub mod runtime;
pub mod validation;

use std::{
    fs,
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

/// Enforce only workflow-owned hard dependencies at execution time. Recommended
/// and optional entries stay visible metadata and never turn Sawhorse itself into
/// a feature-specific installer.
pub fn preflight_requirements(
    root: &Path,
    project_id: &str,
    definition: &WorkflowDefinition,
) -> Result<(), String> {
    let locked = crate::extensions::package::read_lock(root)?;
    let project_extensions = locked.projects.get(project_id);
    let mut missing = Vec::new();
    for requirement in definition
        .requirements
        .iter()
        .filter(|requirement| requirement.level == WorkflowRequirementLevel::Required)
    {
        let ready = match requirement.kind {
            WorkflowRequirementKind::Program => requirement.commands.iter().any(|command| {
                let Some(path) = crate::detect::resolve_bin(command) else {
                    return false;
                };
                requirement.minimum_major == 0
                    || crate::detect::version_of_sync(&path, &requirement.version_args)
                        .as_deref()
                        .and_then(crate::detect::major_of)
                        .is_some_and(|major| major >= requirement.minimum_major)
            }),
            WorkflowRequirementKind::Extension => {
                let range = semver::VersionReq::parse(&requirement.version)
                    .map_err(|error| format!("workflow extension 버전 범위 오류: {error}"))?;
                project_extensions
                    .and_then(|packages| {
                        packages.iter().find(|package| package.id == requirement.id)
                    })
                    .and_then(|package| semver::Version::parse(&package.version).ok())
                    .is_some_and(|version| range.matches(&version))
            }
        };
        if !ready {
            let hint = if !requirement.install_hint.trim().is_empty() {
                format!(" — {}", requirement.install_hint.trim())
            } else if !requirement.install_url.trim().is_empty() {
                format!(" — {}", requirement.install_url.trim())
            } else {
                String::new()
            };
            missing.push(format!(
                "{} ({}){hint}",
                requirement.label, requirement.reason
            ));
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "이 워크플로우에 필요한 확장 또는 프로그램이 준비되지 않았습니다: {}",
            missing.join("; ")
        ))
    }
}

fn definition_path(root: &Path, id: &str, version: &str) -> PathBuf {
    root.join(".sawhorse")
        .join("workflows")
        .join(id)
        .join(format!("{version}.json"))
}

fn valid_storage_key(value: &str) -> bool {
    !value.is_empty()
        && crate::workspace_io::portable_component(value)
        && !matches!(value, "." | "..")
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("JSON 직렬화 실패: {e}"))?;
    crate::workspace_io::write_atomic(path, &bytes, true)
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
    let path = draft_path(root, &input.draft_id)?;
    let _guard = crate::workspace_io::lock(root, "workflow")?;
    crate::workspace_io::check_path(root, &path)?;
    if path.exists() {
        let existing = get_draft_at(root, &input.draft_id)?;
        if input.expected_revision.as_deref() != Some(existing.revision.as_str()) {
            return Err("revision-conflict: draft changed; read it again before saving".into());
        }
    } else if input
        .expected_revision
        .as_deref()
        .is_some_and(|v| !v.is_empty())
    {
        return Err("revision-conflict: draft no longer exists".into());
    }
    let record = WorkflowDraftRecord {
        draft_id: input.draft_id,
        validation: validate_draft_at(Some(root), &input.definition),
        revision: definition_digest(&input.definition)?,
        definition: input.definition,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_json_atomic(&path, &record)?;
    Ok(record)
}

pub fn list_drafts_at(root: &Path) -> Result<Vec<WorkflowDraftRecord>, String> {
    let directory = root.join(".sawhorse").join("drafts").join("workflows");
    crate::workspace_io::check_path(root, &directory)?;
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
        crate::workspace_io::check_path(root, &path)?;
        let text = fs::read_to_string(&path)
            .map_err(|error| format!("workflow draft 읽기 실패: {error}"))?;
        let mut record: WorkflowDraftRecord = serde_json::from_str(&text)
            .map_err(|error| format!("workflow draft 파싱 실패: {error}"))?;
        record.validation = validate_draft_at(Some(root), &record.definition);
        record.revision = definition_digest(&record.definition)?;
        drafts.push(record);
    }
    drafts.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(drafts)
}

pub fn get_draft_at(root: &Path, draft_id: &str) -> Result<WorkflowDraftRecord, String> {
    let path = draft_path(root, draft_id)?;
    crate::workspace_io::check_path(root, &path)?;
    let bytes = fs::read(path).map_err(|e| format!("draft-not-found: {e}"))?;
    let mut record: WorkflowDraftRecord =
        serde_json::from_slice(&bytes).map_err(|e| format!("draft-invalid: {e}"))?;
    if record.draft_id != draft_id {
        return Err(
            "revision-conflict: draft ID differs from the stored ID (including case)".into(),
        );
    }
    record.validation = validate_draft_at(Some(root), &record.definition);
    record.revision = definition_digest(&record.definition)?;
    Ok(record)
}

pub fn delete_draft_at(root: &Path, draft_id: &str) -> Result<(), String> {
    let path = draft_path(root, draft_id)?;
    let _guard = crate::workspace_io::lock(root, "workflow")?;
    crate::workspace_io::check_path(root, &path)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| format!("workflow draft 삭제 실패: {error}"))?;
    }
    Ok(())
}

pub fn publish_at(
    root: &Path,
    definition: WorkflowDefinition,
) -> Result<WorkflowDefinition, String> {
    publish_all_at(root, vec![definition]).map(|mut definitions| definitions.remove(0))
}

/// Validate the complete composition before writing, then publish children first.
/// A filesystem failure may leave valid immutable revisions; retrying is idempotent.
pub fn publish_all_at(
    root: &Path,
    definitions: Vec<WorkflowDefinition>,
) -> Result<Vec<WorkflowDefinition>, String> {
    // Reject malformed storage keys before creating even a lock directory.
    for definition in &definitions {
        let report = validation::validate(definition);
        if !report.valid {
            return Err(format!("workflow registry 검증 실패: {:?}", report.issues));
        }
    }
    let _guard = crate::workspace_io::lock(root, "workflow")?;
    let pending = publication_plan_at(root, &definitions)?;
    for definition in pending {
        let path = definition_path(root, &definition.id, &definition.version);
        crate::workspace_io::check_path(root, &path)?;
        let bytes = serde_json::to_vec_pretty(&definition).map_err(|e| e.to_string())?;
        crate::workspace_io::write_atomic(&path, &bytes, false)?;
    }
    Ok(definitions)
}

/// The same complete preflight is used for publication and CLI --dry-run.
pub fn publication_plan_at(
    root: &Path,
    definitions: &[WorkflowDefinition],
) -> Result<Vec<WorkflowDefinition>, String> {
    let mut registry = catalog(Some(root))?;
    let existing_count = registry.len();
    for definition in definitions {
        if let Some(existing) = registry.iter().find(|candidate| {
            candidate.id == definition.id && candidate.version == definition.version
        }) {
            if existing != definition {
                return Err(format!(
                    "이미 발행된 workflow {}@{}는 바꿀 수 없습니다. 새 버전을 사용하세요",
                    definition.id, definition.version
                ));
            }
        } else {
            registry.push(definition.clone());
        }
    }
    let issues = validation::validate_registry(&registry);
    if !issues.is_empty() {
        return Err(format!("workflow registry 검증 실패: {issues:?}"));
    }
    let order = validation::dependency_order(&registry).map_err(|issue| issue.message)?;
    Ok(order
        .into_iter()
        .filter(|index| *index >= existing_count)
        .map(|index| registry[index].clone())
        .collect())
}

pub fn ensure_builtins(root: &Path) -> Result<(), String> {
    let _guard = crate::workspace_io::lock(root, "workflow")?;
    for definition in builtins::all() {
        let report = validation::validate(&definition);
        if !report.valid {
            return Err(format!(
                "번들 workflow {}가 유효하지 않습니다: {:?}",
                definition.id, report.issues
            ));
        }
        let path = definition_path(root, &definition.id, &definition.version);
        crate::workspace_io::check_path(root, &path)?;
        let parent = path
            .parent()
            .ok_or_else(|| "workflow 경로의 상위 폴더가 없습니다".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("workflow 폴더 생성 실패: {error}"))?;
        if path.exists() {
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
        } else {
            let bytes = serde_json::to_vec_pretty(&definition)
                .map_err(|e| format!("workflow 직렬화 실패: {e}"))?;
            crate::workspace_io::write_atomic(&path, &bytes, false)?;
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
    crate::workspace_io::check_path(root, &directory)?;
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
        crate::workspace_io::check_path(root, &path)?;
        let definition = load_file(&path)?;
        if path.file_stem().and_then(|v| v.to_str()) != Some(definition.version.as_str())
            || path
                .parent()
                .and_then(Path::file_name)
                .and_then(|v| v.to_str())
                != Some(definition.id.as_str())
        {
            return Err(format!(
                "workflow storage path does not match ID/version: {}",
                path.display()
            ));
        }
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
    validate_draft_at(crate::sdlc::vault_root().ok().as_deref(), &definition)
}

pub fn validate_draft_at(root: Option<&Path>, definition: &WorkflowDefinition) -> ValidationReport {
    let mut report = validation::validate(definition);
    if !report.valid {
        return report;
    }
    match catalog(root) {
        Ok(mut registry) => {
            // Editing an existing revision is allowed; immutable publication is checked
            // when publishing. References must resolve against the edited composition.
            registry.retain(|existing| {
                existing.id != definition.id || existing.version != definition.version
            });
            registry.push(definition.clone());
            report
                .issues
                .extend(validation::validate_registry(&registry));
        }
        Err(message) => report.issues.push(ValidationIssue {
            severity: IssueSeverity::Error,
            code: "workflow-catalog-unavailable".into(),
            path: "workflowRef".into(),
            message,
        }),
    }
    report.valid = !report
        .issues
        .iter()
        .any(|issue| issue.severity == IssueSeverity::Error);
    report
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
            expected_revision: None,
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
    fn empty_requirements_preserve_legacy_json_and_workflow_digests() {
        let definition = builtins::sdd();
        let json = serde_json::to_string(&definition).unwrap();
        assert!(!json.contains("\"requirements\""));
        let restored: WorkflowDefinition = serde_json::from_str(&json).unwrap();
        assert!(restored.requirements.is_empty());
        assert_eq!(
            definition_digest(&definition).unwrap(),
            definition_digest(&restored).unwrap()
        );
    }

    #[test]
    fn execution_preflight_enforces_only_required_workflow_dependencies() {
        let root = tempdir();
        let mut definition = builtins::sdd();
        definition.requirements.push(WorkflowRequirement {
            kind: WorkflowRequirementKind::Program,
            id: "missing-tool".into(),
            label: "Missing tool".into(),
            level: WorkflowRequirementLevel::Optional,
            reason: "only one optional export step uses it".into(),
            commands: vec!["sawhorse-definitely-missing-command".into()],
            ..Default::default()
        });
        assert!(preflight_requirements(&root, "project", &definition).is_ok());
        definition.requirements[0].level = WorkflowRequirementLevel::Required;
        let error = preflight_requirements(&root, "project", &definition).unwrap_err();
        assert!(error.contains("Missing tool"), "{error}");
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
                expected_revision: None,
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

    #[test]
    fn batch_publication_resolves_children_before_parents_and_preflights_all_definitions() {
        let root = tempdir();
        let mut child = builtins::tdd();
        child.id = "team-child".into();
        let mut parent = builtins::sdd_with_tdd();
        parent.id = "team-parent".into();
        parent
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap()
            .workflow_ref = Some(WorkflowRef {
            id: child.id.clone(),
            version: child.version.clone(),
        });
        let mut invalid = child.clone();
        invalid.entry = "missing".into();
        assert!(publish_all_at(&root, vec![parent.clone(), invalid]).is_err());
        assert!(!definition_path(&root, &parent.id, &parent.version).exists());
        assert!(!definition_path(&root, &child.id, &child.version).exists());

        let definitions = vec![parent.clone(), child.clone()];
        publish_all_at(&root, definitions.clone()).unwrap();
        publish_all_at(&root, definitions).unwrap();
        assert_eq!(
            resolve(Some(&root), &parent.id, &parent.version).unwrap(),
            parent
        );
        assert_eq!(
            resolve(Some(&root), &child.id, &child.version).unwrap(),
            child
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn draft_validation_checks_the_composition_without_changing_published_content() {
        let root = tempdir();
        let mut definition = builtins::sdd_with_tdd();
        definition.label = "Draft title".into();
        assert!(validate_draft_at(Some(&root), &definition).valid);
        definition
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap()
            .workflow_ref
            .as_mut()
            .unwrap()
            .id = "missing-child".into();
        let report = validate_draft_at(Some(&root), &definition);
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.code == "missing-subworkflow"));
        assert_eq!(
            resolve(Some(&root), &definition.id, &definition.version).unwrap(),
            builtins::sdd_with_tdd()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_revision_paths_are_rejected_before_any_publication() {
        let root = tempdir();
        let mut definition = builtins::tdd();
        definition.id = "team-flow".into();
        definition.version = "1.0.0-../../outside".into();
        assert!(publish_at(&root, definition).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }
}
