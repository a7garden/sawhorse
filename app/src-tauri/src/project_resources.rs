//! Reusable Markdown templates and project design assignments, independent of industry packs.
use super::*;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Resource {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub markdown: String,
    pub source: String,
    pub revision: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Assignment {
    pub design_id: String,
    pub templates: HashMap<String, String>,
}
fn directory(root: &Path) -> PathBuf {
    root.join(".sawhorse/resources")
}
fn resource_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let path = directory(root).join(format!("{id}.json"));
    safe_path(root, &path)?;
    Ok(path)
}
fn assignment_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    let path = project_path(root, id).with_file_name("resources.json");
    safe_path(root, &path)?;
    Ok(path)
}
fn get(root: &Path, id: &str) -> Result<Resource, String> {
    serde_json::from_str(&fs::read_to_string(resource_path(root, id)?).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub fn assignment(root: &Path, id: &str) -> Result<Assignment, String> {
    if id.is_empty() {
        return Ok(Assignment::default());
    }
    let path = assignment_path(root, id)?;
    if !path.exists() {
        return Ok(Assignment::default());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn sdd_resources() -> Result<Vec<Resource>, String> {
    let root = vault_root()?;
    let dir = directory(&root);
    safe_path(&root, &dir)?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut items = Vec::new();
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "json") {
            let id = entry
                .path()
                .file_stem()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            items.push(get(&root, &id)?);
        }
    }
    items.sort_by(|a, b| a.title.cmp(&b.title));
    Ok(items)
}
#[tauri::command]
pub fn sdd_save_resource(input: Resource) -> Result<Resource, String> {
    save_at(&vault_root()?, input)
}
fn save_at(root: &Path, mut input: Resource) -> Result<Resource, String> {
    let _guard = mutation_lock();
    ensure_initialized(&root)?;
    if input.id.is_empty() {
        input.id = format!("resource-{}", Uuid::new_v4());
    }
    if !matches!(input.kind.as_str(), "template" | "design")
        || input.title.trim().is_empty()
        || input.markdown.trim().is_empty()
        || input.markdown.len() > 512_000
    {
        return Err("종류·이름·문서 내용을 확인하세요 (최대 512KB)".into());
    }
    let path = resource_path(&root, &input.id)?;
    if path.exists() && get(&root, &input.id)?.revision != input.revision {
        return Err("문서가 변경되었습니다. 새로고침하세요".into());
    }
    input.revision = revision(&format!(
        "{}:{}:{}",
        input.title,
        input.markdown,
        Uuid::new_v4()
    ));
    write_atomic(
        &root,
        &path,
        &serde_json::to_string_pretty(&input).map_err(|e| e.to_string())?,
    )?;
    Ok(input)
}
#[tauri::command]
pub fn sdd_project_resources(project_id: String) -> Result<Assignment, String> {
    assignment(&vault_root()?, &project_id)
}
#[tauri::command]
pub fn sdd_assign_resource(
    project_id: String,
    resource_id: String,
    role: String,
) -> Result<Assignment, String> {
    assign_at(&vault_root()?, &project_id, &resource_id, &role)
}
fn assign_at(
    root: &Path,
    project_id: &str,
    resource_id: &str,
    role: &str,
) -> Result<Assignment, String> {
    let _guard = mutation_lock();
    project_by_id(root, project_id)?;
    let mut assignment = assignment(&root, &project_id)?;
    if resource_id.is_empty() {
        if role == "design" {
            assignment.design_id.clear();
        } else {
            assignment.templates.remove(role);
        }
    } else {
        let resource = get(&root, &resource_id)?;
        if role == "design" {
            if resource.kind != "design" {
                return Err("디자인 문서를 선택하세요".into());
            }
            write_atomic(
                &root,
                &project_path(&root, &project_id).with_file_name("DESIGN.md"),
                &resource.markdown,
            )?;
            assignment.design_id = resource.id;
        } else {
            validate_id(&role)?;
            if resource.kind != "template" || role == "intent" {
                return Err("원본 의도를 제외한 산출물에 템플릿을 적용하세요".into());
            }
            assignment.templates.insert(role.into(), resource.id);
        }
    }
    write_atomic(
        &root,
        &assignment_path(&root, &project_id)?,
        &serde_json::to_string_pretty(&assignment).map_err(|e| e.to_string())?,
    )?;
    Ok(assignment)
}
fn design_content(root: &Path, project_id: &str) -> Result<String, String> {
    if project_id.is_empty() {
        return Ok(String::new());
    }
    let assigned = assignment(root, project_id)?;
    if !assigned.design_id.is_empty() {
        let path = project_path(root, project_id).with_file_name("DESIGN.md");
        safe_path(root, &path)?;
        return fs::read_to_string(path).map_err(|e| e.to_string());
    }
    let project = project_by_id(root, project_id)?;
    let path = Path::new(&project.repo_path).join("DESIGN.md");
    if path.is_file() {
        if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 512_000 {
            return Err("DESIGN.md가 512KB를 초과합니다".into());
        }
        return fs::read_to_string(path).map_err(|e| e.to_string());
    }
    Ok(String::new())
}
pub fn design_digest(root: &Path, project_id: &str) -> Result<String, String> {
    Ok(revision(&design_content(root, project_id)?))
}
pub fn project_context(root: &Path, project_id: &str) -> Result<String, String> {
    let content = design_content(root, project_id)?;
    if content.is_empty() {
        return Ok(String::new());
    }
    Ok(format!("Project DESIGN.md (follow these design tokens, voice, principles, states and motion for UI work):\n{content}\n"))
}
pub fn template(root: &Path, project_id: &str, role: &str) -> Result<Option<String>, String> {
    if role == "intent" {
        return Ok(None);
    }
    assignment(root, project_id)?
        .templates
        .get(role)
        .map(|id| get(root, id).map(|r| r.markdown))
        .transpose()
}
#[tauri::command]
pub fn sdd_export_resource(resource_id: String, path: String) -> Result<(), String> {
    let resource = get(&vault_root()?, &resource_id)?;
    let target = Path::new(&path);
    if !target.is_absolute() || target.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("Markdown 파일의 절대 경로를 선택하세요".into());
    }
    // Export creates a new file so a stale dialog cannot overwrite another document.
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| format!("파일 내보내기 실패 (기존 파일은 보존됩니다): {e}"))?;
    file.write_all(resource.markdown.as_bytes())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn sdd_design_source(project_id: String) -> Result<String, String> {
    let root = vault_root()?;
    let design = design_content(&root, &project_id)?;
    if !design.is_empty() {
        return Ok(design);
    }
    let project = project_by_id(&root, &project_id)?;
    let mut pending = vec![PathBuf::from(&project.repo_path)];
    let mut source = String::new();
    let mut count = 0;
    while let Some(dir) = pending.pop() {
        if count >= 1000 || source.len() > 120_000 {
            break;
        }
        let mut entries = fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .collect::<Vec<_>>();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            count += 1;
            let path = entry.path();
            let ty = entry.file_type().map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if ty.is_symlink()
                || name.starts_with('.')
                || matches!(name.as_str(), "node_modules" | "target" | "dist" | "vendor")
            {
                continue;
            }
            if ty.is_dir() {
                pending.push(path);
                continue;
            }
            if !matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("css" | "scss")
            ) && !name.starts_with("tailwind.config")
            {
                continue;
            }
            if entry.metadata().map_err(|e| e.to_string())?.len() > 64_000 {
                continue;
            }
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            source.push_str(&format!(
                "\n<!-- {} -->\n{}\n",
                path.strip_prefix(&project.repo_path)
                    .unwrap_or(&path)
                    .display(),
                text
            ));
            if source.len() > 120_000 {
                break;
            }
        }
    }
    if source.is_empty() {
        return Err(
            "추출할 DESIGN.md·스타일 파일을 찾지 못했습니다. 참조 문서를 직접 불러오세요".into(),
        );
    }
    Ok(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn assignments_freeze_design_and_templates_preserve_original_intent() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        initialize(root).unwrap();
        let repo = root.join("repository");
        fs::create_dir(&repo).unwrap();
        fs::write(repo.join("DESIGN.md"), "# Repository fallback").unwrap();
        save_project_at(
            root,
            Project {
                id: "p".into(),
                name: "Project".into(),
                repo_path: repo.to_string_lossy().into_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        let design = save_at(
            root,
            Resource {
                kind: "design".into(),
                title: "Design".into(),
                markdown: "# Applied design".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assign_at(root, "p", &design.id, "design").unwrap();
        let digest = design_digest(root, "p").unwrap();
        let mut changed = design.clone();
        changed.markdown = "# Updated library design".into();
        let changed = save_at(root, changed).unwrap();
        assert!(save_at(root, design).is_err(), "stale edits must fail");
        assert_eq!(design_content(root, "p").unwrap(), "# Applied design");
        assert_eq!(design_digest(root, "p").unwrap(), digest);
        assign_at(root, "p", &changed.id, "design").unwrap();
        assert_ne!(design_digest(root, "p").unwrap(), digest);
        assign_at(root, "p", "", "design").unwrap();
        assert_eq!(design_content(root, "p").unwrap(), "# Repository fallback");
        let template_doc = save_at(
            root,
            Resource {
                kind: "template".into(),
                title: "Brief".into(),
                markdown: "# Goal\n\n## Acceptance criteria".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(assign_at(root, "p", &template_doc.id, "intent").is_err());
        assert!(assign_at(root, "p", &template_doc.id, "design").is_err());
        assign_at(root, "p", &template_doc.id, "brief").unwrap();
        assert_eq!(
            template(root, "p", "brief").unwrap(),
            Some(template_doc.markdown)
        );
        assert_eq!(template(root, "p", "intent").unwrap(), None);
        assert!(get(root, "../escape").is_err());
    }
}
