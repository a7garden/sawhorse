use std::collections::BTreeMap;

use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

use super::{definition_digest, model::*, runtime::condition_matches, validation};

pub const INSTANCE_FORMAT_VERSION: u32 = 1;
const MAX_SUBWORKFLOW_DEPTH: usize = 8;
const MAX_TRANSITIONS: u32 = 10_000;

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn definition<'a>(
    registry: &'a [WorkflowDefinition],
    id: &str,
    version: &str,
) -> Result<&'a WorkflowDefinition, String> {
    registry
        .iter()
        .find(|candidate| candidate.id == id && candidate.version == version)
        .ok_or_else(|| format!("workflow definition이 없습니다: {id}@{version}"))
}

fn node<'a>(definition: &'a WorkflowDefinition, node_id: &str) -> Result<&'a WorkflowNode, String> {
    definition
        .nodes
        .iter()
        .find(|candidate| candidate.id == node_id)
        .ok_or_else(|| {
            format!(
                "workflow node가 없습니다: {}@{}:{node_id}",
                definition.id, definition.version
            )
        })
}

fn run_mut<'a>(instance: &'a mut WorkflowInstance, id: &str) -> Result<&'a mut NodeRun, String> {
    instance
        .node_runs
        .iter_mut()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| format!("node run이 없습니다: {id}"))
}

fn refresh_active_nodes(instance: &mut WorkflowInstance) {
    instance.active_nodes = instance
        .frames
        .last()
        .map(|frame| {
            vec![ActiveNode {
                workflow_id: frame.workflow_id.clone(),
                workflow_version: frame.workflow_version.clone(),
                node_id: frame.node_id.clone(),
                node_run_id: frame.node_run_id.clone(),
                depth: instance.frames.len().saturating_sub(1) as u32,
            }]
        })
        .unwrap_or_default();
}

fn push_frame(
    instance: &mut WorkflowInstance,
    registry: &[WorkflowDefinition],
    workflow_id: &str,
    workflow_version: &str,
    parent_node_run_id: Option<String>,
    input_digest: &str,
) -> Result<(), String> {
    if instance.frames.len() >= MAX_SUBWORKFLOW_DEPTH {
        return Err(format!(
            "하위 workflow 깊이는 최대 {MAX_SUBWORKFLOW_DEPTH}단계입니다"
        ));
    }
    if instance
        .frames
        .iter()
        .any(|frame| frame.workflow_id == workflow_id && frame.workflow_version == workflow_version)
    {
        return Err(format!(
            "재귀 workflow 참조는 지원하지 않습니다: {workflow_id}@{workflow_version}"
        ));
    }
    let definition = definition(registry, workflow_id, workflow_version)?;
    let timestamp = now();
    let run_id = Uuid::new_v4().to_string();
    instance.node_runs.push(NodeRun {
        id: run_id.clone(),
        workflow_id: definition.id.clone(),
        workflow_version: definition.version.clone(),
        node_id: definition.entry.clone(),
        status: NodeRunStatus::Ready,
        attempt: 1,
        iteration: 0,
        input_digest: input_digest.into(),
        parent_node_run_id: parent_node_run_id.clone(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        ..Default::default()
    });
    instance.frames.push(RuntimeFrame {
        workflow_id: definition.id.clone(),
        workflow_version: definition.version.clone(),
        workflow_digest: definition_digest(definition)?,
        node_id: definition.entry.clone(),
        node_run_id: run_id,
        parent_node_run_id,
        loop_iterations: BTreeMap::new(),
    });
    refresh_active_nodes(instance);
    Ok(())
}

fn begin_node(
    instance: &mut WorkflowInstance,
    registry: &[WorkflowDefinition],
    workflow_id: &str,
    workflow_version: &str,
    node_id: &str,
    parent_node_run_id: Option<String>,
    input_digest: &str,
    iteration: u32,
) -> Result<(), String> {
    let definition = definition(registry, workflow_id, workflow_version)?;
    node(definition, node_id)?;
    let timestamp = now();
    let run_id = Uuid::new_v4().to_string();
    instance.node_runs.push(NodeRun {
        id: run_id.clone(),
        workflow_id: workflow_id.into(),
        workflow_version: workflow_version.into(),
        node_id: node_id.into(),
        status: NodeRunStatus::Ready,
        attempt: 1,
        iteration,
        input_digest: input_digest.into(),
        parent_node_run_id,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        ..Default::default()
    });
    let frame = instance
        .frames
        .last_mut()
        .ok_or_else(|| "활성 workflow frame이 없습니다".to_string())?;
    frame.node_id = node_id.into();
    frame.node_run_id = run_id;
    refresh_active_nodes(instance);
    Ok(())
}

fn event_status(event: &str) -> NodeRunStatus {
    match event {
        "failed" | "rejected" => NodeRunStatus::Failed,
        "cancelled" => NodeRunStatus::Cancelled,
        _ => NodeRunStatus::Succeeded,
    }
}

fn transition(
    instance: &mut WorkflowInstance,
    registry: &[WorkflowDefinition],
    event: &str,
    facts: &BTreeMap<String, Value>,
    input_digest: &str,
) -> Result<bool, String> {
    if instance.transition_count >= MAX_TRANSITIONS {
        instance.status = WorkflowInstanceStatus::Paused;
        instance.error = Some(format!("전체 전환 상한 {MAX_TRANSITIONS}회에 도달했습니다"));
        return Ok(false);
    }
    let frame = instance
        .frames
        .last()
        .cloned()
        .ok_or_else(|| "활성 workflow frame이 없습니다".to_string())?;
    let definition = definition(registry, &frame.workflow_id, &frame.workflow_version)?;
    let candidates: Vec<_> = definition
        .edges
        .iter()
        .filter(|edge| {
            edge.from == frame.node_id
                && edge.on == event
                && condition_matches(edge.condition.as_ref(), facts)
        })
        .collect();
    if candidates.len() != 1 {
        return Err(if candidates.is_empty() {
            format!(
                "{}@{}:{}에서 event를 처리할 연결이 없습니다: {event}",
                frame.workflow_id, frame.workflow_version, frame.node_id
            )
        } else {
            format!("event와 조건이 일치하는 연결이 여러 개입니다: {event}")
        });
    }
    let edge = candidates[0].clone();
    let mut iteration = 0;
    if let Some(loop_id) = &edge.loop_ref {
        let frame_mut = instance.frames.last_mut().expect("checked frame");
        let count = frame_mut
            .loop_iterations
            .entry(loop_id.clone())
            .or_insert(0);
        *count += 1;
        iteration = *count;
        let loop_definition = definition
            .loops
            .iter()
            .find(|candidate| candidate.id == *loop_id)
            .expect("validated loop reference");
        if *count > loop_definition.max_iterations {
            let timestamp = now();
            let current = run_mut(instance, &frame.node_run_id)?;
            current.status = NodeRunStatus::Failed;
            current.waiting_reason = Some("loop-limit".into());
            current.updated_at = timestamp.clone();
            instance.status = match loop_definition.on_limit {
                LoopLimitAction::Pause => WorkflowInstanceStatus::Paused,
                LoopLimitAction::Fail => WorkflowInstanceStatus::Failed,
            };
            instance.error = Some(format!("loop 상한에 도달했습니다: {loop_id}"));
            instance.updated_at = timestamp;
            refresh_active_nodes(instance);
            return Ok(false);
        }
    }
    let timestamp = now();
    let current = run_mut(instance, &frame.node_run_id)?;
    current.status = event_status(event);
    current.waiting_reason = None;
    current.updated_at = timestamp;
    instance.transition_count += 1;
    begin_node(
        instance,
        registry,
        &frame.workflow_id,
        &frame.workflow_version,
        &edge.to,
        frame.parent_node_run_id,
        input_digest,
        iteration,
    )?;
    Ok(true)
}

fn settle(
    instance: &mut WorkflowInstance,
    registry: &[WorkflowDefinition],
    input_digest: &str,
) -> Result<(), String> {
    loop {
        let frame = match instance.frames.last().cloned() {
            Some(frame) => frame,
            None => {
                instance.status = WorkflowInstanceStatus::Completed;
                instance.active_nodes.clear();
                return Ok(());
            }
        };
        let definition = definition(registry, &frame.workflow_id, &frame.workflow_version)?;
        let node = node(definition, &frame.node_id)?.clone();
        match node.kind {
            NodeKind::Subworkflow => {
                let reference = node.workflow_ref.ok_or_else(|| {
                    format!("subworkflow node에 workflowRef가 없습니다: {}", node.id)
                })?;
                let timestamp = now();
                let run = run_mut(instance, &frame.node_run_id)?;
                run.status = NodeRunStatus::Waiting;
                run.waiting_reason = Some("subworkflow".into());
                run.updated_at = timestamp;
                push_frame(
                    instance,
                    registry,
                    &reference.id,
                    &reference.version,
                    Some(frame.node_run_id),
                    input_digest,
                )?;
            }
            NodeKind::End => {
                let timestamp = now();
                let run = run_mut(instance, &frame.node_run_id)?;
                run.status = NodeRunStatus::Succeeded;
                run.waiting_reason = None;
                run.updated_at = timestamp;
                instance.frames.pop();
                if instance.frames.is_empty() {
                    instance.status = WorkflowInstanceStatus::Completed;
                    instance.active_nodes.clear();
                    return Ok(());
                }
                let parent = instance.frames.last().cloned().expect("checked parent");
                let parent_run = run_mut(instance, &parent.node_run_id)?;
                parent_run.status = NodeRunStatus::Succeeded;
                parent_run.waiting_reason = None;
                parent_run.updated_at = now();
                if !transition(
                    instance,
                    registry,
                    "succeeded",
                    &BTreeMap::new(),
                    input_digest,
                )? {
                    return Ok(());
                }
            }
            _ => {
                let timestamp = now();
                let run = run_mut(instance, &frame.node_run_id)?;
                run.status = NodeRunStatus::Waiting;
                run.waiting_reason = Some(
                    match node.kind {
                        NodeKind::Human | NodeKind::Artifact => "user-input",
                        NodeKind::Agent | NodeKind::Check => "external-result",
                        NodeKind::Condition => "condition-facts",
                        _ => "event",
                    }
                    .into(),
                );
                run.updated_at = timestamp.clone();
                instance.status = WorkflowInstanceStatus::Waiting;
                instance.updated_at = timestamp;
                instance.error = None;
                refresh_active_nodes(instance);
                return Ok(());
            }
        }
    }
}

pub fn start(
    registry: &[WorkflowDefinition],
    input: WorkflowInstanceStartInput,
) -> Result<WorkflowInstance, String> {
    let issues = validation::validate_registry(registry);
    if !issues.is_empty() {
        return Err(format!("workflow registry가 유효하지 않습니다: {issues:?}"));
    }
    let root = definition(registry, &input.workflow_id, &input.workflow_version)?;
    let timestamp = now();
    let mut instance = WorkflowInstance {
        format_version: INSTANCE_FORMAT_VERSION,
        id: Uuid::new_v4().to_string(),
        work_id: input.work_id,
        project_id: input.project_id,
        workflow_id: root.id.clone(),
        workflow_version: root.version.clone(),
        workflow_digest: definition_digest(root)?,
        status: WorkflowInstanceStatus::Running,
        input_digest: input.input_digest.clone(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        ..Default::default()
    };
    push_frame(
        &mut instance,
        registry,
        &root.id,
        &root.version,
        None,
        &input.input_digest,
    )?;
    settle(&mut instance, registry, &input.input_digest)?;
    Ok(instance)
}

pub fn advance(
    instance: &mut WorkflowInstance,
    registry: &[WorkflowDefinition],
    input: &WorkflowInstanceCommandInput,
) -> Result<(), String> {
    if instance.format_version != INSTANCE_FORMAT_VERSION {
        return Err("지원하지 않는 workflow instance 형식입니다".into());
    }
    if !matches!(
        instance.status,
        WorkflowInstanceStatus::Waiting | WorkflowInstanceStatus::Running
    ) {
        return Err(format!(
            "현재 상태에서는 workflow event를 처리할 수 없습니다: {:?}",
            instance.status
        ));
    }
    if input.input_digest != instance.input_digest {
        return Err("입력 digest가 변경되었습니다. 먼저 stale 처리를 수행하세요".into());
    }
    let current = instance
        .active_nodes
        .first()
        .ok_or_else(|| "활성 node가 없습니다".to_string())?;
    if current.node_id != input.expected_node_id {
        return Err(format!(
            "활성 node가 변경되었습니다. 예상 {}, 현재 {}",
            input.expected_node_id, current.node_id
        ));
    }
    if !transition(
        instance,
        registry,
        &input.event,
        &input.facts,
        &input.input_digest,
    )? {
        return Ok(());
    }
    settle(instance, registry, &input.input_digest)
}

pub fn mark_stale(instance: &mut WorkflowInstance, new_input_digest: &str) {
    let timestamp = now();
    let active = instance.active_nodes.first().cloned();
    for run in &mut instance.node_runs {
        if run.input_digest != new_input_digest
            && matches!(
                run.status,
                NodeRunStatus::Succeeded
                    | NodeRunStatus::Ready
                    | NodeRunStatus::Running
                    | NodeRunStatus::Waiting
            )
        {
            run.status = NodeRunStatus::Stale;
            run.waiting_reason = None;
            run.updated_at = timestamp.clone();
        }
    }
    instance.input_digest = new_input_digest.into();
    if let Some(active) = active {
        let prior = instance
            .node_runs
            .iter()
            .find(|run| run.id == active.node_run_id)
            .cloned();
        let replacement_id = Uuid::new_v4().to_string();
        instance.node_runs.push(NodeRun {
            id: replacement_id.clone(),
            workflow_id: active.workflow_id,
            workflow_version: active.workflow_version,
            node_id: active.node_id,
            status: NodeRunStatus::Waiting,
            attempt: prior.as_ref().map(|run| run.attempt + 1).unwrap_or(1),
            iteration: prior.as_ref().map(|run| run.iteration).unwrap_or(0),
            input_digest: new_input_digest.into(),
            parent_node_run_id: prior.and_then(|run| run.parent_node_run_id),
            waiting_reason: Some("input-changed".into()),
            execution_refs: Vec::new(),
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
        });
        if let Some(frame) = instance.frames.last_mut() {
            frame.node_run_id = replacement_id;
        }
        refresh_active_nodes(instance);
        instance.status = WorkflowInstanceStatus::Waiting;
        instance.error = None;
    } else {
        instance.status = WorkflowInstanceStatus::Paused;
        instance.error = Some("입력이 변경되어 이전 성공 근거가 stale 상태입니다".into());
    }
    instance.updated_at = timestamp;
}

pub fn cancel(instance: &mut WorkflowInstance) {
    let timestamp = now();
    if let Some(active) = instance.active_nodes.first() {
        if let Some(run) = instance
            .node_runs
            .iter_mut()
            .find(|candidate| candidate.id == active.node_run_id)
        {
            run.status = NodeRunStatus::Cancelled;
            run.waiting_reason = None;
            run.updated_at = timestamp.clone();
        }
    }
    instance.status = WorkflowInstanceStatus::Cancelled;
    instance.active_nodes.clear();
    instance.frames.clear();
    instance.updated_at = timestamp;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::builtins;

    fn event(instance: &WorkflowInstance, id: &str, event: &str) -> WorkflowInstanceCommandInput {
        WorkflowInstanceCommandInput {
            instance_id: instance.id.clone(),
            event_id: id.into(),
            event: event.into(),
            expected_node_id: instance.active_nodes[0].node_id.clone(),
            input_digest: instance.input_digest.clone(),
            ..Default::default()
        }
    }

    #[test]
    fn composed_workflow_enters_and_returns_from_tdd() {
        let registry = builtins::all();
        let mut instance = start(
            &registry,
            WorkflowInstanceStartInput {
                workflow_id: "sdd-with-tdd".into(),
                workflow_version: "1.0.0".into(),
                input_digest: "input-a".into(),
                ..Default::default()
            },
        )
        .unwrap();
        for (id, name) in [("1", "approved"), ("2", "approved")] {
            let command = event(&instance, id, name);
            advance(&mut instance, &registry, &command).unwrap();
        }
        assert_eq!(instance.frames.len(), 2);
        assert_eq!(instance.active_nodes[0].workflow_id, "tdd-cycle");
        assert_eq!(instance.active_nodes[0].node_id, "test-intent");
        for (id, name) in [
            ("3", "approved"),
            ("4", "red-confirmed"),
            ("5", "green-confirmed"),
            ("6", "succeeded"),
            ("7", "verified"),
        ] {
            let command = event(&instance, id, name);
            advance(&mut instance, &registry, &command).unwrap();
        }
        assert_eq!(instance.frames.len(), 1);
        assert_eq!(instance.active_nodes[0].workflow_id, "sdd-with-tdd");
        assert_eq!(instance.active_nodes[0].node_id, "test");
    }

    #[test]
    fn changed_input_marks_old_success_as_stale() {
        let registry = builtins::all();
        let mut instance = start(
            &registry,
            WorkflowInstanceStartInput {
                workflow_id: "tdd-cycle".into(),
                workflow_version: "1.0.0".into(),
                input_digest: "old".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let command = event(&instance, "1", "approved");
        advance(&mut instance, &registry, &command).unwrap();
        mark_stale(&mut instance, "new");
        assert!(instance
            .node_runs
            .iter()
            .any(|run| run.status == NodeRunStatus::Stale));
        assert_eq!(instance.status, WorkflowInstanceStatus::Waiting);
        assert_eq!(instance.node_runs.last().unwrap().attempt, 2);
    }
}
