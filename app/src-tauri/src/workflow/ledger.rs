use std::{
    path::Path,
    sync::{Mutex, OnceLock},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use super::{catalog, engine, model::*};

fn ledger_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn valid_key(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(format!("유효하지 않은 {label}입니다"));
    }
    Ok(())
}

fn open(root: &Path) -> Result<Connection, String> {
    let internal = root.join(".sawhorse");
    std::fs::create_dir_all(&internal)
        .map_err(|error| format!("runtime 장부 폴더 생성 실패: {error}"))?;
    let connection = Connection::open(internal.join("runtime.sqlite"))
        .map_err(|error| format!("runtime 장부 열기 실패: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS workflow_instances (
               id TEXT PRIMARY KEY,
               work_id TEXT NOT NULL,
               project_id TEXT NOT NULL,
               workflow_id TEXT NOT NULL,
               workflow_version TEXT NOT NULL,
               status TEXT NOT NULL,
               state_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS workflow_instances_work
               ON workflow_instances(work_id, updated_at DESC);
             CREATE TABLE IF NOT EXISTS workflow_events (
               instance_id TEXT NOT NULL,
               event_id TEXT NOT NULL,
               event_json TEXT NOT NULL,
               created_at TEXT NOT NULL,
               PRIMARY KEY(instance_id, event_id),
               FOREIGN KEY(instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE
             );",
        )
        .map_err(|error| format!("runtime 장부 초기화 실패: {error}"))?;
    Ok(connection)
}

fn status_text(status: &WorkflowInstanceStatus) -> &'static str {
    match status {
        WorkflowInstanceStatus::Running => "running",
        WorkflowInstanceStatus::Waiting => "waiting",
        WorkflowInstanceStatus::Completed => "completed",
        WorkflowInstanceStatus::Paused => "paused",
        WorkflowInstanceStatus::Failed => "failed",
        WorkflowInstanceStatus::Cancelled => "cancelled",
    }
}

fn encode(instance: &WorkflowInstance) -> Result<String, String> {
    serde_json::to_string(instance)
        .map_err(|error| format!("workflow instance 직렬화 실패: {error}"))
}

fn decode(json: String) -> Result<WorkflowInstance, String> {
    serde_json::from_str(&json)
        .map_err(|error| format!("workflow instance 장부 파싱 실패: {error}"))
}

fn insert(connection: &Connection, instance: &WorkflowInstance) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO workflow_instances
             (id, work_id, project_id, workflow_id, workflow_version, status, state_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                instance.id,
                instance.work_id,
                instance.project_id,
                instance.workflow_id,
                instance.workflow_version,
                status_text(&instance.status),
                encode(instance)?,
                instance.created_at,
                instance.updated_at,
            ],
        )
        .map(|_| ())
        .map_err(|error| format!("workflow instance 저장 실패: {error}"))
}

fn update(connection: &Connection, instance: &WorkflowInstance) -> Result<(), String> {
    let changed = connection
        .execute(
            "UPDATE workflow_instances SET status=?2, state_json=?3, updated_at=?4 WHERE id=?1",
            params![
                instance.id,
                status_text(&instance.status),
                encode(instance)?,
                instance.updated_at,
            ],
        )
        .map_err(|error| format!("workflow instance 갱신 실패: {error}"))?;
    if changed != 1 {
        return Err("workflow instance를 찾을 수 없습니다".into());
    }
    Ok(())
}

fn load(connection: &Connection, id: &str) -> Result<WorkflowInstance, String> {
    valid_key(id, "instance ID")?;
    connection
        .query_row(
            "SELECT state_json FROM workflow_instances WHERE id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("workflow instance 읽기 실패: {error}"))?
        .map(decode)
        .transpose()?
        .ok_or_else(|| format!("workflow instance를 찾을 수 없습니다: {id}"))
}

pub fn start_at(
    root: &Path,
    input: WorkflowInstanceStartInput,
) -> Result<WorkflowInstance, String> {
    start_for_work_at(root, input, None)
}

pub(crate) fn start_for_work_at(
    root: &Path,
    input: WorkflowInstanceStartInput,
    current_node: Option<&str>,
) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    if !input.work_id.is_empty() {
        valid_key(&input.work_id, "work ID")?;
    }
    if !input.project_id.is_empty() {
        valid_key(&input.project_id, "project ID")?;
    }
    valid_key(&input.workflow_id, "workflow ID")?;
    valid_key(&input.workflow_version, "workflow version")?;
    if input.input_digest.len() > 256 {
        return Err("input digest가 너무 깁니다".into());
    }
    let registry = catalog(Some(root))?;
    let instance = engine::start_from_node(&registry, input, current_node)?;
    insert(&open(root)?, &instance)?;
    Ok(instance)
}

pub fn get_at(root: &Path, id: &str) -> Result<WorkflowInstance, String> {
    load(&open(root)?, id)
}

pub fn list_at(root: &Path, work_id: Option<&str>) -> Result<Vec<WorkflowInstance>, String> {
    if let Some(work_id) = work_id {
        valid_key(work_id, "work ID")?;
    }
    let connection = open(root)?;
    let sql = if work_id.is_some() {
        "SELECT state_json FROM workflow_instances WHERE work_id=?1 ORDER BY updated_at DESC"
    } else {
        "SELECT state_json FROM workflow_instances ORDER BY updated_at DESC"
    };
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("workflow instance 목록 준비 실패: {error}"))?;
    let mut instances = Vec::new();
    if let Some(work_id) = work_id {
        let rows = statement
            .query_map([work_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("workflow instance 목록 실패: {error}"))?;
        for row in rows {
            instances.push(decode(
                row.map_err(|error| format!("workflow instance row 실패: {error}"))?,
            )?);
        }
    } else {
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("workflow instance 목록 실패: {error}"))?;
        for row in rows {
            instances.push(decode(
                row.map_err(|error| format!("workflow instance row 실패: {error}"))?,
            )?);
        }
    }
    Ok(instances)
}

pub fn command_at(
    root: &Path,
    input: WorkflowInstanceCommandInput,
) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    valid_key(&input.instance_id, "instance ID")?;
    valid_key(&input.event_id, "event ID")?;
    valid_key(&input.event, "event")?;
    let mut connection = open(root)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("workflow event transaction 실패: {error}"))?;
    let mut instance = load(&transaction, &input.instance_id)?;
    let duplicate = transaction
        .query_row(
            "SELECT 1 FROM workflow_events WHERE instance_id=?1 AND event_id=?2",
            params![input.instance_id, input.event_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("workflow event 중복 확인 실패: {error}"))?
        .is_some();
    if duplicate {
        transaction
            .commit()
            .map_err(|error| format!("workflow event transaction 종료 실패: {error}"))?;
        return Ok(instance);
    }
    let registry = catalog(Some(root))?;
    let node_id = instance
        .active_nodes
        .first()
        .map(|node| node.node_id.clone())
        .unwrap_or_default();
    engine::advance(&mut instance, &registry, &input)?;
    let record = WorkflowEventRecord {
        instance_id: input.instance_id.clone(),
        event_id: input.event_id.clone(),
        event: input.event.clone(),
        node_id,
        facts: input.facts,
        created_at: now(),
    };
    transaction
        .execute(
            "INSERT INTO workflow_events(instance_id, event_id, event_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                record.instance_id,
                record.event_id,
                serde_json::to_string(&record)
                    .map_err(|error| format!("workflow event 직렬화 실패: {error}"))?,
                record.created_at,
            ],
        )
        .map_err(|error| format!("workflow event 저장 실패: {error}"))?;
    update(&transaction, &instance)?;
    transaction
        .commit()
        .map_err(|error| format!("workflow event commit 실패: {error}"))?;
    Ok(instance)
}

pub fn mark_stale_at(
    root: &Path,
    id: &str,
    new_input_digest: &str,
) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    if new_input_digest.len() > 256 {
        return Err("input digest가 너무 깁니다".into());
    }
    let connection = open(root)?;
    let mut instance = load(&connection, id)?;
    engine::mark_stale(&mut instance, new_input_digest);
    update(&connection, &instance)?;
    Ok(instance)
}

pub fn attach_execution_at(
    root: &Path,
    instance_id: &str,
    node_run_id: &str,
    execution_ref: &str,
) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    valid_key(instance_id, "instance ID")?;
    valid_key(node_run_id, "node run ID")?;
    valid_key(execution_ref, "execution ref")?;
    let connection = open(root)?;
    let mut instance = load(&connection, instance_id)?;
    let node_run = instance
        .node_runs
        .iter_mut()
        .find(|run| run.id == node_run_id)
        .ok_or_else(|| format!("workflow node run을 찾을 수 없습니다: {node_run_id}"))?;
    if !node_run
        .execution_refs
        .iter()
        .any(|existing| existing == execution_ref)
    {
        node_run.execution_refs.push(execution_ref.into());
        node_run.updated_at = now();
        instance.updated_at = now();
        update(&connection, &instance)?;
    }
    Ok(instance)
}

pub fn cancel_at(root: &Path, id: &str) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut instance = load(&connection, id)?;
    engine::cancel(&mut instance);
    update(&connection, &instance)?;
    Ok(instance)
}

/// Final human acceptance for pinned workflows whose last node predates End nodes.
pub(crate) fn complete_at(root: &Path, id: &str) -> Result<WorkflowInstance, String> {
    let _guard = ledger_lock()
        .lock()
        .map_err(|_| "workflow ledger lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut instance = load(&connection, id)?;
    let timestamp = now();
    for active in &instance.active_nodes {
        if let Some(run) = instance
            .node_runs
            .iter_mut()
            .find(|run| run.id == active.node_run_id)
        {
            run.status = NodeRunStatus::Succeeded;
            run.waiting_reason = None;
            run.updated_at = timestamp.clone();
        }
    }
    instance.status = WorkflowInstanceStatus::Completed;
    instance.active_nodes.clear();
    instance.frames.clear();
    instance.updated_at = timestamp;
    update(&connection, &instance)?;
    Ok(instance)
}

pub fn events_at(root: &Path, id: &str) -> Result<Vec<WorkflowEventRecord>, String> {
    valid_key(id, "instance ID")?;
    let connection = open(root)?;
    let mut statement = connection
        .prepare("SELECT event_json FROM workflow_events WHERE instance_id=?1 ORDER BY rowid ASC")
        .map_err(|error| format!("workflow event 목록 준비 실패: {error}"))?;
    let events = statement
        .query_map([id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("workflow event 목록 실패: {error}"))?
        .map(|row| {
            let json = row.map_err(|error| format!("workflow event row 실패: {error}"))?;
            serde_json::from_str(&json)
                .map_err(|error| format!("workflow event 장부 파싱 실패: {error}"))
        })
        .collect();
    events
}

#[tauri::command]
pub fn workflow_instance_start(
    input: WorkflowInstanceStartInput,
) -> Result<WorkflowInstance, String> {
    let root = crate::sdlc::vault_root()?;
    start_at(&root, input)
}

#[tauri::command]
pub fn workflow_instance_get(id: String) -> Result<WorkflowInstance, String> {
    let root = crate::sdlc::vault_root()?;
    get_at(&root, &id)
}

#[tauri::command]
pub fn workflow_instance_list(work_id: Option<String>) -> Result<Vec<WorkflowInstance>, String> {
    let root = crate::sdlc::vault_root()?;
    list_at(&root, work_id.as_deref())
}

#[tauri::command]
pub fn workflow_instance_command(
    input: WorkflowInstanceCommandInput,
) -> Result<WorkflowInstance, String> {
    let root = crate::sdlc::vault_root()?;
    command_at(&root, input)
}

#[tauri::command]
pub fn workflow_instance_mark_stale(
    id: String,
    input_digest: String,
) -> Result<WorkflowInstance, String> {
    let root = crate::sdlc::vault_root()?;
    mark_stale_at(&root, &id, &input_digest)
}

#[tauri::command]
pub fn workflow_instance_cancel(id: String) -> Result<WorkflowInstance, String> {
    let root = crate::sdlc::vault_root()?;
    cancel_at(&root, &id)
}

#[tauri::command]
pub fn workflow_instance_events(id: String) -> Result<Vec<WorkflowEventRecord>, String> {
    let root = crate::sdlc::vault_root()?;
    events_at(&root, &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn tempdir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("sawhorse-runtime-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join(".sawhorse")).unwrap();
        super::super::ensure_builtins(&path).unwrap();
        path
    }

    #[test]
    fn events_are_durable_and_idempotent() {
        let root = tempdir();
        let instance = start_at(
            &root,
            WorkflowInstanceStartInput {
                workflow_id: "tdd-cycle".into(),
                workflow_version: "1.0.0".into(),
                input_digest: "a".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let input = WorkflowInstanceCommandInput {
            instance_id: instance.id.clone(),
            event_id: "evt-1".into(),
            event: "approved".into(),
            expected_node_id: "test-intent".into(),
            input_digest: "a".into(),
            ..Default::default()
        };
        let first = command_at(&root, input.clone()).unwrap();
        let duplicate = command_at(&root, input).unwrap();
        assert_eq!(first.active_nodes, duplicate.active_nodes);
        let node_run_id = first.active_nodes[0].node_run_id.clone();
        let linked = attach_execution_at(&root, &instance.id, &node_run_id, "run-1").unwrap();
        let linked_again = attach_execution_at(&root, &instance.id, &node_run_id, "run-1").unwrap();
        assert_eq!(
            linked
                .node_runs
                .iter()
                .find(|run| run.id == node_run_id)
                .unwrap()
                .execution_refs,
            ["run-1"]
        );
        assert_eq!(linked.node_runs, linked_again.node_runs);
        assert_eq!(events_at(&root, &instance.id).unwrap().len(), 1);
        assert!(root.join(".sawhorse/runtime.sqlite").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
