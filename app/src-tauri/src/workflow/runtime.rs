use std::collections::BTreeMap;

use serde_json::Value;

use super::{builtins, engine, model::*, validation};

pub(crate) fn condition_matches(
    condition: Option<&ConditionExpression>,
    facts: &BTreeMap<String, Value>,
) -> bool {
    let Some(condition) = condition else {
        return true;
    };
    let observed = facts.get(&condition.field);
    match condition.operator {
        ConditionOperator::Equals => observed == condition.value.as_ref(),
        ConditionOperator::NotEquals => observed != condition.value.as_ref(),
        ConditionOperator::Exists => observed.is_some(),
        ConditionOperator::Truthy => observed.is_some_and(|value| match value {
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(value) => !value.is_empty(),
            Value::Object(value) => !value.is_empty(),
            Value::Null => false,
        }),
    }
}

pub fn simulate(input: SimulationInput) -> SimulationResult {
    let report = validation::validate(&input.definition);
    if !report.valid {
        return SimulationResult {
            status: SimulationStatus::Invalid,
            issues: report.issues,
            ..Default::default()
        };
    }
    let root_id = input.definition.id.clone();
    let root_version = input.definition.version.clone();
    let mut registry = vec![input.definition];
    // The edited root is a simulation draft and intentionally shadows its published
    // revision. Other duplicate revisions still have to agree exactly.
    registry.extend(
        input
            .definitions
            .into_iter()
            .filter(|definition| definition.id != root_id || definition.version != root_version),
    );
    for definition in builtins::all() {
        if !registry.iter().any(|candidate| {
            candidate.id == definition.id && candidate.version == definition.version
        }) {
            registry.push(definition);
        }
    }
    let registry_issues = validation::validate_registry(&registry);
    if !registry_issues.is_empty() {
        return SimulationResult {
            status: SimulationStatus::Invalid,
            issues: registry_issues,
            ..Default::default()
        };
    }

    let mut instance = match engine::start(
        &registry,
        WorkflowInstanceStartInput {
            workflow_id: root_id,
            workflow_version: root_version,
            input_digest: "simulation".into(),
            ..Default::default()
        },
    ) {
        Ok(instance) => instance,
        Err(error) => return failed_simulation(error, report.issues),
    };
    let entered = instance
        .active_nodes
        .first()
        .map(|node| node.node_id.clone())
        .or_else(|| instance.node_runs.last().map(|run| run.node_id.clone()))
        .unwrap_or_default();
    let mut trace = vec![SimulationTraceEntry {
        node_id: entered,
        event: None,
        outcome: "entered".into(),
    }];
    let limit = input.max_steps.unwrap_or(1_000).clamp(1, 10_000) as usize;
    for (index, supplied) in input.events.into_iter().take(limit).enumerate() {
        let before = instance
            .active_nodes
            .first()
            .map(|node| node.node_id.clone())
            .unwrap_or_default();
        let command = WorkflowInstanceCommandInput {
            instance_id: instance.id.clone(),
            event_id: format!("simulation-{index}"),
            event: supplied.event.clone(),
            facts: supplied.facts,
            expected_node_id: before.clone(),
            input_digest: instance.input_digest.clone(),
        };
        if let Err(error) = engine::advance(&mut instance, &registry, &command) {
            trace.push(SimulationTraceEntry {
                node_id: before,
                event: Some(supplied.event),
                outcome: error,
            });
            instance.status = WorkflowInstanceStatus::Failed;
            break;
        }
        let entered = instance
            .active_nodes
            .first()
            .map(|node| node.node_id.clone())
            .or_else(|| instance.node_runs.last().map(|run| run.node_id.clone()))
            .unwrap_or(before);
        trace.push(SimulationTraceEntry {
            node_id: entered,
            event: Some(supplied.event),
            outcome: match instance.status {
                WorkflowInstanceStatus::Paused => "loop-limit",
                WorkflowInstanceStatus::Failed => "failed",
                WorkflowInstanceStatus::Completed => "completed",
                _ => "entered",
            }
            .into(),
        });
        if matches!(
            instance.status,
            WorkflowInstanceStatus::Completed
                | WorkflowInstanceStatus::Paused
                | WorkflowInstanceStatus::Failed
                | WorkflowInstanceStatus::Cancelled
        ) {
            break;
        }
    }
    let loop_iterations = instance
        .frames
        .iter()
        .flat_map(|frame| frame.loop_iterations.iter())
        .fold(BTreeMap::<String, u32>::new(), |mut values, (id, count)| {
            values
                .entry(id.clone())
                .and_modify(|value| *value = (*value).max(*count))
                .or_insert(*count);
            values
        });
    let active_nodes = if instance.active_nodes.is_empty() {
        instance
            .node_runs
            .last()
            .map(|run| vec![run.node_id.clone()])
            .unwrap_or_default()
    } else {
        instance
            .active_nodes
            .iter()
            .map(|node| node.node_id.clone())
            .collect()
    };
    SimulationResult {
        status: match instance.status {
            WorkflowInstanceStatus::Completed => SimulationStatus::Completed,
            WorkflowInstanceStatus::Paused => SimulationStatus::Paused,
            WorkflowInstanceStatus::Failed | WorkflowInstanceStatus::Cancelled => {
                SimulationStatus::Failed
            }
            WorkflowInstanceStatus::Running | WorkflowInstanceStatus::Waiting => {
                SimulationStatus::Waiting
            }
        },
        active_nodes,
        trace,
        loop_iterations,
        issues: report.issues,
    }
}

fn failed_simulation(error: String, mut issues: Vec<ValidationIssue>) -> SimulationResult {
    issues.push(ValidationIssue {
        severity: IssueSeverity::Error,
        code: "simulation-error".into(),
        path: "$".into(),
        message: error,
    });
    SimulationResult {
        status: SimulationStatus::Failed,
        issues,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::builtins;

    #[test]
    fn simulation_uses_the_edited_root_without_replacing_published_definitions() {
        let mut draft = builtins::tdd();
        draft.label = "Edited draft".into();
        let result = simulate(SimulationInput {
            definition: draft,
            definitions: builtins::all(),
            ..Default::default()
        });
        assert_eq!(
            result.status,
            SimulationStatus::Waiting,
            "{:?}",
            result.issues
        );
    }

    #[test]
    fn simulation_rejects_invalid_children_and_recursion_before_running() {
        let mut child = builtins::tdd();
        child.entry = "missing".into();
        let result = simulate(SimulationInput {
            definition: builtins::sdd_with_tdd(),
            definitions: vec![child],
            ..Default::default()
        });
        assert_eq!(result.status, SimulationStatus::Invalid);
        assert!(result.trace.is_empty());

        let mut recursive = builtins::sdd_with_tdd();
        recursive.id = "cycle-parent".into();
        let mut child = recursive.clone();
        child.id = "cycle-child".into();
        recursive
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap()
            .workflow_ref = Some(WorkflowRef {
            id: child.id.clone(),
            version: child.version.clone(),
        });
        child
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap()
            .workflow_ref = Some(WorkflowRef {
            id: recursive.id.clone(),
            version: recursive.version.clone(),
        });
        let result = simulate(SimulationInput {
            definition: recursive,
            definitions: vec![child],
            ..Default::default()
        });
        assert_eq!(result.status, SimulationStatus::Invalid);
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.code == "recursive-subworkflow"));
        assert!(result.trace.is_empty());
    }

    #[test]
    fn tdd_happy_path_finishes_without_running_actions() {
        let result = simulate(SimulationInput {
            definition: builtins::tdd(),
            events: [
                "approved",
                "red-confirmed",
                "green-confirmed",
                "succeeded",
                "verified",
            ]
            .into_iter()
            .map(|event| SimulationEvent {
                event: event.into(),
                ..Default::default()
            })
            .collect(),
            ..Default::default()
        });
        assert_eq!(result.status, SimulationStatus::Completed);
        assert_eq!(result.active_nodes, ["done"]);
    }

    #[test]
    fn loop_limit_pauses_deterministically() {
        let mut definition = builtins::tdd();
        definition.loops[0].max_iterations = 1;
        let result = simulate(SimulationInput {
            definition,
            events: [
                "approved",
                "red-confirmed",
                "failed",
                "red-confirmed",
                "failed",
            ]
            .into_iter()
            .map(|event| SimulationEvent {
                event: event.into(),
                ..Default::default()
            })
            .collect(),
            ..Default::default()
        });
        assert_eq!(result.status, SimulationStatus::Paused);
        assert_eq!(result.loop_iterations.get("tdd-iteration"), Some(&2));
    }

    #[test]
    fn composed_workflow_simulates_the_tdd_child() {
        let result = simulate(SimulationInput {
            definition: builtins::sdd_with_tdd(),
            events: ["approved", "approved", "approved"]
                .into_iter()
                .map(|event| SimulationEvent {
                    event: event.into(),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        });
        assert_eq!(result.status, SimulationStatus::Waiting);
        assert_eq!(result.active_nodes, ["red"]);
    }
}
