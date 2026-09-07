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
  // 반려와 취소는 다른 사건이다. 반려는 요청을 받아들이지 않은 것이고, 취소는
  // 하기로 정한 뒤 그만둔 것이다. 둘 다 닫힘이지만 함께 세면 안 된다.
  "rejected",
  "cancelled",
] as const;
export type WorkStatus = (typeof STATUSES)[number];
/**
 * 닫힘을 뜻하는 상태. Rust 의 `CLOSED_STATUSES` 와 같은 목록이며 `state` 와
 * `closed` 가 여기서 파생한다. 열림 판정을 손으로 나열하지 말고 이 함수를 쓴다 —
 * 종료 상태를 하나 더할 때 빠뜨리는 곳이 생긴다.
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
  // 이전 진입점 호환용. work 화면으로 연결한다.
  | "issues";
export const ISSUE_TYPES = ["버그", "기능", "작업", "질문"] as const;
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
  // 이슈 흐름의 단계. 요청·설계·수행 셋이 실제로 쓰는 어휘다.
  request: "요청",
  resolve: "수행",
  // 옛 판을 고정한 항목이 아직 이 노드 id 를 쓴다.
  plan: "의도",
  execute: "수행",
  maintain: "학습",
};
export const STATUS_LABELS: Record<WorkStatus, string> = {
  backlog: "접수",
  ready: "예정",
  running: "진행",
  review: "결과 검토",
  // 막힘이 아니라 보류다. 볼트의 이슈·개선·마일스톤·프로젝트 템플릿이 모두
  // 보류를 쓴다.
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
  // 옛 판을 고정한 항목이 아직 이 문서를 가질 수 있다.
  learning: "학습 기록",
};
export interface Project {
  id: string;
  name: string;
  description: string;
  repoPath: string;
  /** 기본 폴더 외에 프로젝트가 같이 보는 폴더들. 비어 있으면 단일 폴더 프로젝트다. */
  extraPaths: string[];
  /** 프로젝트에 연결된 GitHub 저장소(owner/repo). 이슈 연결·동기화가 이 바인딩을 따른다. */
  githubRepos: string[];
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
  // 이슈 축. 별도 저장소가 아니라 같은 개발 항목의 요청·승인·외부 연결 정보다.
  issueType: string;
  executionType: string;
  labels: string[];
  assignees: string[];
  /** 소속 마일스톤. `calendar/<id>.md`의 `kind: milestone` 일정 ID. */
  milestone: string;
  approvalRequired: boolean;
  approve: boolean;
  approved: string;
  /** status에서 파생한다. 직접 쓰지 않는다. */
  state: string;
  closed: string;
  githubRepo: string;
  githubNumber: string;
  githubUrl: string;
  githubState: string;
  githubUpdated: string;
}
/** 레거시 이슈 노트 한 건의 이관 계획. `blocked`가 비어 있을 때만 옮길 수 있다. */
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
  agent: "claude" | "codex";
  model: string;
  instructions: string;
  parentRunId: string | null;
  modelAssessment?: { complexity: "routine" | "standard" | "complex"; reason: string };
}
export interface HarnessRun {
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
  /** 에이전트 자신의 세션 id. 닫힌 화면을 같은 대화로 다시 여는 열쇠다. */
  agentSession: string | null;
  /** 실행이 끝나 herdr 화면을 닫은 시각. 비어 있으면 화면이 살아 있다. */
  tabClosedAt: string | null;
  /** 화면을 닫기 직전에 갈무리한 에이전트의 마지막 보고. */
  finalReport: string | null;
  /** 세션 이어하기가 가능한 실행인지 (세션 id 가 기록된 claude 실행). */
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
