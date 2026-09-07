//! Immutable document checkpoints. Decision authority remains in work.md.
use super::*;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IntentCheckpoint {
    pub id: String,
    pub event: String,
    pub note: String,
    pub at: String,
    pub stage: String,
}

fn directory(root: &Path, work_id: &str) -> Result<PathBuf, String> {
    validate_id(work_id)?;
    let path = work_path(root, work_id).with_file_name("history");
    safe_path(root, &path)?;
    Ok(path)
}

pub fn capture(root: &Path, work: &WorkItem, event: &str, note: &str) -> Result<(), String> {
    if work.workflow_id != "intent-flow" { return Ok(()); }
    let documents = ["intent", "spec", "plan", "verification"].iter()
        .map(|role| read_document(root, &work.id, role)).collect::<Result<Vec<_>, _>>()?;
    let checkpoint = IntentCheckpoint {
        id: Uuid::new_v4().to_string(), event: event.into(), note: note.into(),
        at: now(), stage: work.stage.clone(),
    };
    let parent = directory(root, &work.id)?;
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    let pending = parent.join(format!(".pending-{}", checkpoint.id));
    fs::create_dir(&pending).map_err(|error| error.to_string())?;
    let result = (|| {
        for document in documents {
            write_atomic(root, &pending.join(format!("{}.md", document.artifact)), &document.markdown)?;
        }
        write_atomic(root, &pending.join("record.json"),
            &serde_json::to_string_pretty(&checkpoint).map_err(|error| error.to_string())?)?;
        fs::rename(&pending, parent.join(&checkpoint.id)).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = fs::remove_dir_all(&pending); }
    result
}

pub fn list(root: &Path, work_id: &str) -> Result<Vec<IntentCheckpoint>, String> {
    let parent = directory(root, work_id)?;
    if !parent.exists() { return Ok(Vec::new()); }
    let mut checkpoints = Vec::new();
    for entry in fs::read_dir(parent).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with('.') { continue; }
        validate_id(&id)?;
        let path = entry.path().join("record.json");
        safe_path(root, &path)?;
        let checkpoint: IntentCheckpoint = serde_json::from_str(
            &fs::read_to_string(path).map_err(|error| error.to_string())?
        ).map_err(|error| error.to_string())?;
        if checkpoint.id != id { return Err("기록 ID가 일치하지 않습니다".into()); }
        checkpoints.push(checkpoint);
    }
    checkpoints.sort_by(|a, b| b.at.cmp(&a.at));
    Ok(checkpoints)
}

pub fn read(root: &Path, work_id: &str, id: &str) -> Result<Vec<Document>, String> {
    validate_id(id)?;
    let parent = directory(root, work_id)?.join(id);
    ["intent", "spec", "plan", "verification"].iter().map(|role| {
        let path = parent.join(format!("{role}.md"));
        safe_path(root, &path)?;
        let markdown = fs::read_to_string(path).map_err(|error| error.to_string())?;
        // Attachment links are relative to the original document, whose assets persist.
        let original = read_document(root, work_id, role)?;
        Ok(Document { revision: revision(&markdown), markdown, ..original })
    }).collect()
}
