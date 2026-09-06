export const STAGES = [
  "plan",
  "design",
  "build",
  "test",
  "deploy",
  "maintain",
] as const;
/** Node IDs are supplied by the pinned workflow; STAGES is the legacy SDD fallback. */
export type Stage = string;
export const STATUSES = [
  "backlog",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export type WorkStatus = (typeof STATUSES)[number];
export type Priority = "urgent" | "high" | "normal" | "low";
export const ARTIFACTS = [
  "intent",
  "spec",
  "plan",
  "verification",
  "release",
  "learning",
] as const;
/** Artifact roles are supplied by the pinned workflow; ARTIFACTS is the legacy fallback. */
export type ArtifactKind = string;
export type WorkbenchView =
  "overview" | "board" | "calendar" | "harness" | "knowledge" | "projects";
export const STAGE_LABELS: Record<string, string> = {
  plan: "의도",
  design: "설계",
  build: "구현",
  test: "검증",
  deploy: "배포",
  maintain: "학습",
};
export const STATUS_LABELS: Record<WorkStatus, string> = {
  backlog: "백로그",
  ready: "준비",
  running: "진행",
  review: "검토",
  blocked: "막힘",
  done: "완료",
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
  plan: "실행 계획",
  verification: "검증 근거",
  release: "배포 기록",
  learning: "운영·학습",
};
export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  dependsOn: string[];
  verifyCommands: string[];
  defaultAgent: string;
  defaultModel: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
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
export interface Document {
  workId: string;
  artifact: ArtifactKind;
  path: string;
  markdown: string;
  revision: string;
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
  agent: "claude" | "codex";
  model: string;
  instructions: string;
  parentRunId: string | null;
}
export interface HarnessRun {
  id: string;
  workId: string;
  projectId: string;
  role: AgentRole;
  agent: string;
  model: string;
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
export interface WorkflowDefinition {
  definitionVersion: number;
  id: string;
  label: string;
  description: string;
  version: string;
  entry: string;
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
  status: "running" | "waiting" | "completed" | "paused" | "failed" | "cancelled";
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
