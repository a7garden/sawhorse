//! Additive, repeatable sample content shared with the browser preview.
use super::*;
use chrono::{Days, Local};
use serde_json::Value;
use std::io::Write;

const DATA: &str = include_str!("../../src/features/workbench/samples/data.json");

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleReport {
    pub created_projects: Vec<String>,
    pub skipped_projects: Vec<String>,
    pub work_items: usize,
    pub documents: usize,
    pub events: usize,
}

fn materialize(value: &mut Value, today: NaiveDate) -> Result<(), String> {
    match value {
        Value::String(text) => {
            while let Some(start) = text.find("{{day:") {
                let end = start + text[start..].find("}}").ok_or("Invalid sample date")? + 2;
                let offset: i64 = text[start + 6..end - 2]
                    .parse()
                    .map_err(|_| "Invalid sample offset")?;
                let date = if offset < 0 {
                    today.checked_sub_days(Days::new(offset.unsigned_abs()))
                } else {
                    today.checked_add_days(Days::new(offset as u64))
                }
                .ok_or("Invalid sample date")?;
                text.replace_range(start..end, &date.to_string());
            }
        }
        Value::Array(values) => {
            for child in values {
                materialize(child, today)?;
            }
        }
        Value::Object(values) => {
            for child in values.values_mut() {
                materialize(child, today)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// Exclusive creation preserves edited samples, unrelated content, and partially
/// written batches. A project is made visible only after its content is written.
fn create_file(root: &Path, path: &Path, content: &str) -> Result<bool, String> {
    safe_path(root, path)?;
    fs::create_dir_all(path.parent().ok_or("Invalid sample path")?).map_err(|e| e.to_string())?;
    safe_path(root, path)?;
    let mut file = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(true)
}

fn record(value: &Value, body_key: &str) -> Result<String, String> {
    let mut header = value.clone();
    let body = header[body_key].as_str().unwrap_or("").to_string();
    header
        .as_object_mut()
        .ok_or("Invalid sample record")?
        .remove(body_key);
    markdown(&header, &body)
}

pub fn create_at(root: &Path) -> Result<SampleReport, String> {
    let _guard = mutation_lock();
    let _file_guard = crate::workspace_io::lock(root, "sample-projects")?;
    read_schema(root)?;
    workflow::ensure_builtins(root)?;
    let mut data: Value = serde_json::from_str(DATA).map_err(|e| e.to_string())?;
    materialize(&mut data, Local::now().date_naive())?;
    let projects = data["projects"]
        .as_array()
        .ok_or("Invalid sample projects")?;
    let work = data["work"].as_array().ok_or("Invalid sample work")?;
    let events = data["events"].as_array().ok_or("Invalid sample events")?;
    let documents = data["documents"]
        .as_object()
        .ok_or("Invalid sample documents")?;
    // Validate every record before the first write.
    for value in projects {
        let project: Project = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        validate_project(&project)?;
        definition_for_project(root, &project)?;
    }
    for value in work {
        let mut item: WorkItem =
            serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
        normalize_work_workflow(&mut item);
        validate_work(&item)?;
        validate_work_definition(&item, &workflow_definition_for_work(root, &item)?)?;
    }
    let mut report = SampleReport::default();
    for project in projects {
        let id = project["id"].as_str().ok_or("Missing sample project ID")?;
        let path = project_path(root, id);
        safe_path(root, &path)?;
        if path.exists() {
            report.skipped_projects.push(id.into());
            continue;
        }
        for item in work.iter().filter(|item| item["projectId"] == id) {
            let work_id = item["id"].as_str().ok_or("Missing sample work ID")?;
            for document in documents
                .values()
                .filter(|document| document["workId"] == work_id)
            {
                let doc_path = root.join(
                    document["path"]
                        .as_str()
                        .ok_or("Missing sample document path")?,
                );
                if create_file(
                    root,
                    &doc_path,
                    document["markdown"]
                        .as_str()
                        .ok_or("Missing sample content")?,
                )? {
                    report.documents += 1;
                }
            }
            for (key, filename) in [("goals", "goal.json"), ("lifecycle", "lifecycle.json")] {
                if let Some(state) = data[key].get(work_id) {
                    create_file(
                        root,
                        &root.join("work").join(work_id).join(filename),
                        &serde_json::to_string_pretty(state).map_err(|e| e.to_string())?,
                    )?;
                }
            }
            if create_file(
                root,
                &work_path(root, work_id),
                &record(item, "description")?,
            )? {
                report.work_items += 1;
            }
        }
        for event in events.iter().filter(|event| event["projectId"] == id) {
            let event_id = event["id"].as_str().ok_or("Missing sample event ID")?;
            if create_file(
                root,
                &root.join("calendar").join(format!("{event_id}.md")),
                &record(event, "notes")?,
            )? {
                report.events += 1;
            }
        }
        create_file(root, &path, &record(project, "description")?)?;
        report.created_projects.push(id.into());
    }
    Ok(report)
}

#[tauri::command]
pub fn sdd_create_samples() -> Result<SampleReport, String> {
    create_at(&vault_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_are_complete_english_and_preserve_edits() -> Result<(), String> {
        let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        initialize(dir.path())?;
        let report = create_at(dir.path())?;
        assert_eq!(
            (
                report.created_projects.len(),
                report.work_items,
                report.documents,
                report.events
            ),
            (6, 31, 166, 18)
        );
        let snapshot = snapshot(dir.path())?;
        assert!(
            snapshot.diagnostics.is_empty(),
            "{:?}",
            snapshot.diagnostics
        );
        assert_eq!(snapshot.work.len(), 31);
        assert!(!DATA.chars().any(|c| ('\u{ac00}'..='\u{d7a3}').contains(&c)));
        for work in &snapshot.work {
            assert!(!work.artifacts.is_empty());
            for role in &work.artifacts {
                let document = read_document(dir.path(), &work.id, role)?;
                assert!(document.markdown.contains("Fictional sample content"));
            }
            if work.workflow_id == "goal-main" {
                let raw =
                    fs::read_to_string(dir.path().join("work").join(&work.id).join("goal.json"))
                        .map_err(|e| e.to_string())?;
                let goal: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                assert!(matches!(
                    goal["status"].as_str(),
                    Some("paused" | "completed")
                ));
            }
        }
        let edited = dir.path().join("work/sample-atlas-01/intent.md");
        fs::write(&edited, "My edited sample").map_err(|e| e.to_string())?;
        let second = create_at(dir.path())?;
        assert_eq!(second.skipped_projects.len(), 6);
        assert_eq!(second.work_items, 0);
        assert_eq!(
            fs::read_to_string(edited).map_err(|e| e.to_string())?,
            "My edited sample"
        );
        Ok(())
    }
}
