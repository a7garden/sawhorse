use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFINITION_VERSION: u32 = 1;
pub const DEFAULT_WORKFLOW_ID: &str = "sdd-main";
/// 죽어 있던 `maintain`(학습) 노드를 빼고 노드 id `plan` 을 `intent` 로 옮긴 판.
pub const DEFAULT_WORKFLOW_VERSION: &str = "1.1.0";
/// 요청·설계·수행 세 단계로 끝내는 기본 흐름. 볼트의 개발 항목이 전부 이 흐름을
/// 쓴다. 개발 항목과 저장소는 같고 산출물만 가볍다.
pub const ISSUE_WORKFLOW_ID: &str = "issue-main";
/// 실사용 섹션에 맞춘 문서 골격과 `resolve` 노드를 담은 판. 앞선 1.0.0 은 이미
/// 만들어진 항목이 digest 로 고정하고 있어 정의를 그 자리에서 고칠 수 없다.
pub const ISSUE_WORKFLOW_VERSION: &str = "1.1.0";

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub definition_version: u32,
    pub id: String,
    pub label: String,
    pub description: String,
    pub version: String,
    pub entry: String,
    pub artifacts: Vec<ArtifactDefinition>,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub loops: Vec<LoopDefinition>,
}

impl Default for WorkflowDefinition {
    fn default() -> Self {
        Self {
            definition_version: DEFINITION_VERSION,
            id: String::new(),
            label: String::new(),
            description: String::new(),
            version: String::new(),
            entry: String::new(),
            artifacts: Vec::new(),
            nodes: Vec::new(),
            edges: Vec::new(),
            loops: Vec::new(),
        }
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactDefinition {
    /// Stable logical role used by nodes and the UI.
    pub role: String,
    pub label: String,
    /// Vault-relative path. Only `{workId}` and `{projectId}` placeholders are accepted.
    pub path: String,
    pub template: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Artifact,
    Agent,
    Check,
    Human,
    Condition,
    Subworkflow,
    End,
}

impl Default for NodeKind {
    fn default() -> Self {
        Self::Artifact
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: String,
    pub label: String,
    pub kind: NodeKind,
    pub artifact_role: Option<String>,
    pub action_ref: Option<String>,
    pub workflow_ref: Option<WorkflowRef>,
    pub decision: Option<String>,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub allowed_roles: Vec<String>,
    pub instructions: String,
    pub requires_completed_dependencies: bool,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowRef {
    pub id: String,
    pub version: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    pub on: String,
    pub condition: Option<ConditionExpression>,
    pub loop_ref: Option<String>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct ConditionExpression {
    /// A key in the simulation/command fact map. Dotted keys are data, not code.
    pub field: String,
    pub operator: ConditionOperator,
    pub value: Option<Value>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConditionOperator {
    Equals,
    NotEquals,
    Exists,
    Truthy,
}

impl Default for ConditionOperator {
    fn default() -> Self {
        Self::Equals
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct LoopDefinition {
    pub id: String,
    pub max_iterations: u32,
    pub on_limit: LoopLimitAction,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LoopLimitAction {
    Pause,
    Fail,
}

impl Default for LoopLimitAction {
    fn default() -> Self {
        Self::Pause
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum IssueSeverity {
    Error,
    Warning,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub severity: IssueSeverity,
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub valid: bool,
    pub issues: Vec<ValidationIssue>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SimulationInput {
    pub definition: WorkflowDefinition,
    /// Additional exact definitions used by subworkflow references.
    pub definitions: Vec<WorkflowDefinition>,
    pub events: Vec<SimulationEvent>,
    pub max_steps: Option<u32>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SimulationEvent {
    pub event: String,
    pub facts: BTreeMap<String, Value>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SimulationStatus {
    Completed,
    Waiting,
    Paused,
    Failed,
    Invalid,
}

impl Default for SimulationStatus {
    fn default() -> Self {
        Self::Invalid
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SimulationTraceEntry {
    pub node_id: String,
    pub event: Option<String>,
    pub outcome: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SimulationResult {
    pub status: SimulationStatus,
    pub active_nodes: Vec<String>,
    pub trace: Vec<SimulationTraceEntry>,
    pub loop_iterations: BTreeMap<String, u32>,
    pub issues: Vec<ValidationIssue>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkflowInstanceStatus {
    Running,
    Waiting,
    Completed,
    Paused,
    Failed,
    Cancelled,
}

impl Default for WorkflowInstanceStatus {
    fn default() -> Self {
        Self::Waiting
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum NodeRunStatus {
    Pending,
    Ready,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
    Stale,
    Unknown,
}

impl Default for NodeRunStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct RuntimeFrame {
    pub workflow_id: String,
    pub workflow_version: String,
    pub workflow_digest: String,
    pub node_id: String,
    pub node_run_id: String,
    pub parent_node_run_id: Option<String>,
    pub loop_iterations: BTreeMap<String, u32>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ActiveNode {
    pub workflow_id: String,
    pub workflow_version: String,
    pub node_id: String,
    pub node_run_id: String,
    pub depth: u32,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct NodeRun {
    pub id: String,
    pub workflow_id: String,
    pub workflow_version: String,
    pub node_id: String,
    pub status: NodeRunStatus,
    pub attempt: u32,
    pub iteration: u32,
    pub input_digest: String,
    pub parent_node_run_id: Option<String>,
    pub waiting_reason: Option<String>,
    /// Durable execution IDs (for example harness runs) associated with this node attempt.
    pub execution_refs: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowInstance {
    pub format_version: u32,
    pub id: String,
    pub work_id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub workflow_version: String,
    pub workflow_digest: String,
    pub status: WorkflowInstanceStatus,
    pub input_digest: String,
    pub frames: Vec<RuntimeFrame>,
    pub active_nodes: Vec<ActiveNode>,
    pub node_runs: Vec<NodeRun>,
    pub transition_count: u32,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowInstanceStartInput {
    pub work_id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub workflow_version: String,
    pub input_digest: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowInstanceCommandInput {
    pub instance_id: String,
    pub event_id: String,
    pub event: String,
    pub facts: BTreeMap<String, Value>,
    pub expected_node_id: String,
    pub input_digest: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowEventRecord {
    pub instance_id: String,
    pub event_id: String,
    pub event: String,
    pub node_id: String,
    pub facts: BTreeMap<String, Value>,
    pub created_at: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowDraftRecord {
    pub draft_id: String,
    pub definition: WorkflowDefinition,
    pub validation: ValidationReport,
    pub updated_at: String,
    pub revision: String,
}

#[derive(schemars::JsonSchema, Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkflowDraftSaveInput {
    pub draft_id: String,
    pub definition: WorkflowDefinition,
    /// Omit for a new draft; updates must match the revision returned by a read.
    pub expected_revision: Option<String>,
}
