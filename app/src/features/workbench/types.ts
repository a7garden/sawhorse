export const STAGES = ["intent", "design", "build", "test", "deploy"] as const;
/** Node IDs are supplied by the pinned workflow; STAGES is the legacy SDD fallback. */
export type Stage = string;
export const STATUSES = [
  "backlog",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
  // Rejection and cancellation are different events. A rejection means the request was not
  // accepted; a cancellation means it was agreed to and then abandoned. Both are closed, but they must not be counted together.
  "rejected",
  "cancelled",
] as const;
export type WorkStatus = (typeof STATUSES)[number];
/**
 * Statuses meaning closed. The same list as Rust's `CLOSED_STATUSES`; `state` and
 * `closed` derive from here. Do not hand-list open checks — use this function,
 * or adding one more terminal status leaves a spot missed.
 */
export const CLOSED_STATUSES: readonly WorkStatus[] = [
  "done",
  "rejected",
  "cancelled",
];
export const isClosedStatus = (status: string) =>
  (CLOSED_STATUSES as readonly string[]).includes(status);
export type Priority = "urgent" | "high" | "normal" | "low";
export const ARTIFACTS = [
  "intent",
  "spec",
  "plan",
  "verification",
  "release",
] as const;
/** Artifact roles are supplied by the pinned workflow; ARTIFACTS is the legacy fallback. */
export type ArtifactKind = string;
export type WorkbenchView =
  | "work"
  | "overview"
  | "board"
  | "calendar"
  | "harness"
  | "knowledge"
  | "projects"
  // Legacy entry-point compatibility. Routes to the work screen.
  | "issues";
export const ISSUE_TYPES = ["기능", "버그", "리팩토링", "작업", "질문"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const EXECUTION_TYPES = [
  "코드",
  "문서",
  "조사",
  "협의",
  "결정",
] as const;
export type ExecutionType = (typeof EXECUTION_TYPES)[number];
export const STAGE_LABELS: Record<string, string> = {
  intent: "의도",
  design: "설계",
  build: "구현",
  test: "검증",
  deploy: "배포",
  // Stages of the issue flow. The request/design/perform trio is the vocabulary actually used.
  request: "요청",
  resolve: "수행",
  // Items pinned to an old revision still use these node ids.
  plan: "의도",
  execute: "수행",
  maintain: "학습",
};
export const STATUS_LABELS: Record<WorkStatus, string> = {
  backlog: "접수",
  ready: "예정",
  running: "진행",
  review: "결과 검토",
  // Not a block but a hold. The vault's issue, improvement, milestone, and project templates all
  // use "hold".
  blocked: "보류",
  done: "완료",
  rejected: "반려",
  cancelled: "취소",
};
export const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "긴급",
  high: "높음",
  normal: "보통",
  low: "낮음",
};
export const ARTIFACT_LABELS: Record<string, string> = {
  intent: "의도",
  spec: "명세",
  plan: "계획",
  verification: "검증 근거",
  release: "배포 기록",
  // Items pinned to an old revision can still carry this document.
  learning: "학습 기록",
};
export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  /** Folders the project views alongside the default one. Empty means a single-folder project. */
  extraPaths: string[];
  /** GitHub repositories linked to the project (owner/repo). Issue linking and sync follow these bindings. */
  githubRepos: string[];
  dependsOn: string[];
  verifyCommands: string[];
  defaultAgent: string;
  defaultModel: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  /** Exact additional workflows enabled for creation. The default is always enabled. */
  additionalWorkflows?: WorkflowRef[];
}
export interface Decision {
  stage: Stage;
  at: string;
  note: string;
}
export interface WorkItem {
  id: string;
  title: string;
  description: string;
  projectId: string;
  stage: Stage;
  status: WorkStatus;
  priority: Priority;
  owner: string;
  startDate: string | null;
  dueDate: string | null;
  dependsOn: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  decisions: Decision[];
  artifacts: ArtifactKind[];
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  workflowInstanceId: string | null;
  activeNodes: RuntimeActiveNode[];
  // The issue axis. Not a separate store — request, approval, and external-link info of the same development item.
  issueType: string;
  executionType: string;
  labels: string[];
  assignees: string[];
  /** Milestone membership. A `kind: milestone` calendar event ID in `calendar/<id>.md`. */
  milestone: string;
  approvalRequired: boolean;
  approve: boolean;
  approved: string;
  /** Derived from status. Not written directly. */
  state: string;
  closed: string;
  githubRepo: string;
  githubNumber: string;
  githubUrl: string;
  githubState: string;
  githubUpdated: string;
}
/** Migration plan for one legacy issue note. Movable only when `blocked` is empty. */
export interface IssueMigrationItem {
  path: string;
  project: string;
  issueId: string;
  title: string;
  workId: string;
  status: string;
  issueType: string;
  executionType: string;
  milestone: string;
  legacy: boolean;
  blocked: string;
  migrated: boolean;
}
export interface IssueMigrationReport {
  migrated: IssueMigrationItem[];
  skipped: IssueMigrationItem[];
}
export interface CalendarEvent {
  id: string;
  title: string;
  date: string;
  endDate: string | null;
  kind: "milestone" | "review" | "release" | "meeting";
  projectId: string | null;
  workId: string | null;
  notes: string;
}
export interface WorkspaceSnapshot {
  schemaVersion: number;
  initialized: boolean;
  vaultPath: string;
  projects: Project[];
  work: WorkItem[];
  events: CalendarEvent[];
  workflows: WorkflowDefinition[];
  diagnostics: string[];
}
/** One field-level fix applied by sdd_repair_documents. */
export interface DocumentRepair {
  path: string;
  field: string;
  from: string;
  to: string;
}
export interface RepairReport {
  repairs: DocumentRepair[];
  /** Snapshot diagnostics still remaining after the repair. */
  remaining: string[];
}
export interface Document {
  workId: string;
  artifact: ArtifactKind;
  path: string;
  markdown: string;
  revision: string;
}
export interface IntentCheckpoint {
  id: string;
  event: string;
  note: string;
  at: string;
  stage: Stage;
}
export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  workId: string | null;
  artifact: ArtifactKind | null;
}
export type AgentRole =
  "research" | "planner" | "implementer" | "verifier" | "reviewer";
export interface LaunchInput {
  workId: string;
  projectId: string;
  role: AgentRole;
  /** Herdr's canonical agent kind. */
  agent: string;
  model: string;
  instructions: string;
  parentRunId: string | null;
  modelAssessment?: { complexity: "routine" | "standard" | "complex"; reason: string };
}
export interface HarnessRun {
  runner?: "headless" | "herdr";
  instructions?: string;
  id: string;
  workId: string;
  projectId: string;
  role: AgentRole;
  agent: string;
  model: string;
  modelSelection?: {
    source: "auto" | "explicit" | "inherited" | "default";
    requestedModel: string;
    assessment: { complexity: "routine" | "standard" | "complex"; reason: string } | null;
    reason: string;
  } | null;
  childModelPolicy?: "auto" | "inherit";
  parentRunId: string | null;
  stage: Stage;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  workflowInstanceId: string | null;
  nodeRunId: string | null;
  status:
    | "starting"
    | "running"
    | "blocked"
    | "review"
    | "stopped"
    | "failed"
    | "unknown";
  agentName: string;
  paneId: string | null;
  workspaceId: string | null;
  session: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** The agent's own session id. The key to reopening a closed pane as the same conversation. */
  agentSession: string | null;
  /** When the herdr pane was closed after the run ended. Empty means the pane is still alive. */
  tabClosedAt: string | null;
  /** The agent's final report, captured just before closing the pane. */
  finalReport: string | null;
  /** When a person dismissed it from the attention list. The record remains, so it can be reverted anytime. */
  dismissedAt?: string | null;
  /** Whether the run supports session resume (a claude run with its session id recorded). */
  resumable: boolean;
}

export type WorkflowNodeKind =
  | "artifact"
  | "agent"
  | "check"
  | "human"
  | "condition"
  | "subworkflow"
  | "end";
export interface WorkflowArtifact {
  role: string;
  label: string;
  path: string;
  template: string;
}
export interface WorkflowRef {
  id: string;
  version: string;
}
export interface RuntimeActiveNode {
  workflowId: string;
  workflowVersion: string;
  nodeId: string;
  nodeRunId: string;
  depth: number;
}
export interface WorkflowNode {
  id: string;
  label: string;
  kind: WorkflowNodeKind;
  artifactRole: string | null;
  actionRef: string | null;
  workflowRef: WorkflowRef | null;
  decision: string | null;
  inputs: string[];
  outputs: string[];
  allowedRoles: AgentRole[];
  instructions: string;
  requiresCompletedDependencies: boolean;
}
export interface WorkflowCondition {
  field: string;
  operator: "equals" | "not-equals" | "exists" | "truthy";
  value?: unknown;
}
export interface WorkflowEdge {
  from: string;
  to: string;
  on: string;
  condition: WorkflowCondition | null;
  loopRef: string | null;
}
export interface WorkflowLoop {
  id: string;
  maxIterations: number;
  onLimit: "pause" | "fail";
}
export type WorkflowRequirementKind = "program" | "extension";
export type WorkflowRequirementLevel = "required" | "recommended" | "optional";
export interface WorkflowRequirement {
  kind: WorkflowRequirementKind;
  id: string;
  label: string;
  level: WorkflowRequirementLevel;
  reason: string;
  /** Alternative executable names for a program requirement. */
  commands: string[];
  /** Safe arguments used only to read a program version. */
  versionArgs: string[];
  minimumMajor: number;
  /** SemVer range for an extension requirement; empty for programs. */
  version: string;
  installUrl: string;
  installHint: string;
}
export interface WorkflowDefinition {
  definitionVersion: number;
  id: string;
  label: string;
  description: string;
  version: string;
  entry: string;
  /** Feature-specific dependencies pinned with this immutable workflow revision. */
  requirements?: WorkflowRequirement[];
  artifacts: WorkflowArtifact[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  loops: WorkflowLoop[];
}
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}
export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}
export interface SimulationInput {
  definition: WorkflowDefinition;
  definitions?: WorkflowDefinition[];
  events: Array<{ event: string; facts?: Record<string, unknown> }>;
  maxSteps?: number;
}
export interface SimulationResult {
  status: "completed" | "waiting" | "paused" | "failed" | "invalid";
  activeNodes: string[];
  trace: Array<{ nodeId: string; event: string | null; outcome: string }>;
  loopIterations: Record<string, number>;
  issues: ValidationIssue[];
}

export interface WorkflowDraftRecord {
  draftId: string;
  definition: WorkflowDefinition;
  validation: ValidationReport;
  updatedAt: string;
  revision: string;
}

export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale"
  | "unknown";

export interface WorkflowNodeRun {
  id: string;
  workflowId: string;
  workflowVersion: string;
  nodeId: string;
  status: NodeRunStatus;
  attempt: number;
  iteration: number;
  inputDigest: string;
  parentNodeRunId: string | null;
  waitingReason: string | null;
  executionRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInstance {
  formatVersion: number;
  id: string;
  workId: string;
  projectId: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  status:
    "running" | "waiting" | "completed" | "paused" | "failed" | "cancelled";
  inputDigest: string;
  activeNodes: RuntimeActiveNode[];
  nodeRuns: WorkflowNodeRun[];
  transitionCount: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface WorkflowEventRecord {
  instanceId: string;
  eventId: string;
  event: string;
  nodeId: string;
  facts: Record<string, unknown>;
  createdAt: string;
}
/** One turn of the work copilot. Questions and answers stack in one list, in time order. */
export interface CopilotTurn {
  role: "question" | "answer";
  text: string;
}

export interface CopilotAnswer {
  answer: string;
  /** The engine that actually answered. Uses the agent the user configured as-is. */
  agent: string;
  model: string;
}
