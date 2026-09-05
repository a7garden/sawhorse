// Shared contract types — must stay 1:1 with src-tauri commands.rs payloads.

export interface RoutineSched {
  enabled: boolean;
  time: string; // "HH:MM"
}

export interface Schedules {
  morning: RoutineSched;
  lunch: RoutineSched;
  evening: RoutineSched;
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export type HerdrMode = "auto" | "herdr" | "headless";
export type HerdrCleanup = "closeOnSuccess" | "keep" | "closeAlways";

export interface HerdrCfg {
  mode: HerdrMode;
  bin: string;
  session: string; // "" = herdr 기본 세션
  workspaceLabel: string;
  cleanup: HerdrCleanup;
  maxParallel: number;
  startTimeoutSec: number;
  jobTimeoutMin: number; // 0 = 무제한
  notify: boolean;
}

/** 카탈로그에 없는 CLI 를 사용자가 직접 등록하는 항목. */
export interface CustomAgent {
  id: string;
  name: string;
  /** 실행 파일 이름 또는 절대 경로. 비면 id 를 이름으로 본다. */
  bin: string;
  installUrl: string;
}

export interface DashboardCfg {
  schedules: Schedules;
  excelOutputDir: string;
  claudeBin: string;
  permissionMode: PermissionMode;
  launchAtLogin: boolean;
  herdr: HerdrCfg;
  customAgents: CustomAgent[];
  /** 승인 정책·통합 방식. 새 세션의 초기값 계산에만 쓰인다. */
  collaboration: CollaborationPolicy;
}

export interface ProjectCfg {
  name: string;
  path: string;
  workBranch: string;
  portableBase: string;
  idPrefix: string;
  verify: string;
}

export interface ConfigView {
  exists: boolean;
  vaultPath: string;
  defaultProject: string;
  projects: ProjectCfg[];
  /** 새 코어 프로젝트 정본. key는 등록 때 만든 UUID projectId다. */
  coreProjects: Record<string, CoreProjectCfg>;
  dashboard: DashboardCfg;
}

export type ConfigPatch = Partial<DashboardCfg> & {
  vaultPath?: string;
  defaultProject?: string;
  projects?: ProjectCfg[];
  coreProjects?: Record<string, CoreProjectCfg>;
  /** 대시보드 블록 부분 갱신 — dashboard.collaboration 즉시 저장에 쓴다. */
  dashboard?: Partial<Omit<DashboardCfg, "collaboration">> & {
    collaboration?: Partial<CollaborationPolicy>;
  };
};

export interface IssueNote {
  project: string;
  path: string; // absolute
  id: string;
  title: string;
  url: string;
  category: string;
  issueType: string;
  executionType: string;
  labels: string[];
  assignees: string[];
  milestone: string;
  priority: string;
  status: string;
  state: "open" | "closed" | string;
  approvalRequired: boolean;
  approve: boolean;
  approved: string;
  verified: string;
  dependsOn: string[];
  dependents: string[];
  commits: string[];
  githubRepo: string;
  githubNumber: string;
  githubUrl: string;
  githubState: string;
  closed: string;
  legacy: boolean;
  mtimeMs: number;
}

/** @deprecated IssueNote is the preferred domain name. */
export type ImprovementNote = IssueNote;

export interface NoteView {
  markdown: string;
  frontmatter: Record<string, unknown>;
}

export interface TodoItem {
  index: number; // index within its section (0-based)
  text: string;
  checked: boolean;
}

export interface TodoSections {
  date: string;
  today: TodoItem[];
  tomorrow: TodoItem[];
  fileExists: boolean;
}

export type TodoSection = "today" | "tomorrow";

export interface VaultNode {
  name: string;
  rel: string; // vault-relative path, "/"-separated
  dir: boolean;
  size: number;
  mtimeMs: number;
}

export type RoutineName = "morning" | "lunch" | "evening";
export type JobStatus = "queued" | "running" | "success" | "failed" | "cancelled" | "interrupted";

export interface VaultCandidate {
  path: string;
  open: boolean;
}

export interface AuditIssue {
  severity: "error" | "warn" | "info";
  path: string;
  message: string;
}

export interface JournalAudit {
  todayExists: boolean;
  missing: string[];
}

export interface VaultAudit {
  issues: AuditIssue[];
  journal: JournalAudit;
  scannedAtMs: number;
}

export interface UnpromotedItem {
  project: string;
  idPrefix: string;
  text: string;
  listPath: string;
}
export type JobKind =
  | "design"
  | "implement"
  | "routine"
  | "excel"
  | "initVault"
  | "setup"
  | "promote"
  /** 팩이 선언한 액션 */
  | "action"
  | "task";

export interface JobRequest {
  kind: JobKind;
  project?: string;
  ids?: string[];
  routine?: RoutineName;
  packId?: string;
  actionId?: string;
  params?: Record<string, unknown>;
  taskId?: string | null;
}

export type JobRunner = "headless" | "herdr";
/// herdr가 본 세션의 생명주기. blocked = 사람이 herdr에서 승인/입력해야 함.
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  status: JobStatus;
  project?: string;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  exitCode?: number;
  error?: string;
  runner: JobRunner;
  agentStatus?: AgentStatus;
  sessionId?: string;
  herdrTabId?: string;
  herdrPaneId?: string;
  herdrAgent?: string;
}

export interface ProgressEntry {
  tsMs: number;
  kind: "init" | "text" | "tool" | "result";
  text?: string;
  tool?: string;
  summary?: string;
  isError?: boolean;
}

export interface HerdrDiag {
  mode: HerdrMode;
  binOk: boolean;
  version?: string;
  serverOk: boolean;
  effectiveRunner: JobRunner;
}

export interface Diagnostics {
  configExists: boolean;
  vaultPathOk: boolean;
  claudeOk: boolean;
  claudeVersion?: string;
  herdr: HerdrDiag;
  projects: { name: string; pathOk: boolean; gitOk: boolean; branchOk: boolean | null }[];
}

export interface MissedRoutine {
  key: string; // "<예약 키>-<date>"
  /** 예약 키(`si.morning`). 구형 기록은 루틴 이름(`morning`)을 담고 있다. */
  routine: string;
  /** 사람이 읽는 이름. 구형 기록에는 없다. */
  label?: string;
  date: string; // YYYY-MM-DD
  scheduledAt: string; // HH:MM
}

export interface JobProgressPayload {
  jobId: string;
  entry: ProgressEntry;
}

export interface VaultNoteView {
  title: string;
  markdown: string;
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface PluginBundle {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
  repository: string;
  keywords: string[];
  root: string;
  skills: SkillInfo[];
}

// ---------- 확장(pack) ----------

export type SettingFieldType = "text" | "path" | "number" | "bool" | "select" | "table";
export type ScheduleKind = "daily" | "weekdays" | "once";
export type ViewKind = "notes" | "native";
export type ActionParamType = "text" | "list" | "select" | "project";

export interface Choice {
  value: string;
  label: string;
}

export interface PackColumn {
  key: string;
  label: string;
  type: string;
}

export interface SettingField {
  key: string;
  type: SettingFieldType;
  label: string;
  description: string;
  placeholder: string;
  options: Choice[];
  columns: PackColumn[];
}

export interface ActionParam {
  key: string;
  type: ActionParamType;
  label: string;
  options: Choice[];
  required: boolean;
}

export interface ActionSchedule {
  kind: ScheduleKind;
  time: string;
  enabled: boolean;
}

export interface PackAction {
  id: string;
  label: string;
  description: string;
  prompt: string;
  cwd: string;
  params: ActionParam[];
  schedule: ActionSchedule | null;
  featured: boolean;
}

export interface ViewColumn {
  field: string;
  label: string;
  /** "" | "title" | "mtime" — 프론트매터가 아니라 노트 자체에서 오는 값 */
  source: string;
  type: string;
  width: number;
}

export interface PackView {
  id: string;
  label: string;
  icon: string;
  type: ViewKind;
  component: string;
  columns: ViewColumn[];
  groupBy: string;
  actions: string[];
  empty: string;
}

export interface FileSeed {
  src: string;
  dest: string;
}

export interface PackInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  skills: string[];
  workspace: { folders: string[]; files: FileSeed[] };
  settings: SettingField[];
  actions: PackAction[];
  views: PackView[];
  dir: string;
  source: "builtin" | "user";
  enabled: boolean;
  availableSkills: string[];
  settingsValues: Record<string, unknown>;
}

export interface BrokenPack {
  dir: string;
  error: string;
}

export interface PackRegistryView {
  packs: PackInfo[];
  broken: BrokenPack[];
}

export interface NavEntry {
  packId: string;
  packName: string;
  viewId: string;
  label: string;
  icon: string;
  type: ViewKind;
  component: string;
}

// ---------- 노트 질의 ----------

export interface NoteRow {
  path: string;
  rel: string;
  title: string;
  mtimeMs: number;
  fields: Record<string, unknown>;
}

export interface QueryResult {
  rows: NoteRow[];
  folders: string[];
  truncated: boolean;
}

// ---------- 에이전트 브리지 ----------

export type SkillState = "installed" | "modified" | "missing" | "noSource";

export interface SkillStatus {
  skill: string;
  agent: string;
  state: SkillState;
  target: string;
}

export interface PluginInstall {
  key: string;
  version: string;
  installPath: string;
}

export interface PackAgentStatus {
  packId: string;
  claude: SkillStatus[];
  codex: SkillStatus[];
  pluginInstalls: PluginInstall[];
}

export interface AgentPresence {
  id: string;
  name: string;
  detected: boolean;
  version?: string;
  /** 실제로 찾은 실행 파일 경로 ("" = 못 찾음) */
  path: string;
  home: string;
  /** 스킬 설치 대상인가 */
  installable: boolean;
  /** 앱이 이 에이전트로 잡을 직접 돌릴 수 있는가 */
  runsJobs: boolean;
  /** "" 이면 설치 위치가 등록돼 있지 않다 — 버튼을 내지 않는다. */
  installUrl: string;
  installHint: string;
  custom: boolean;
  note: string;
}

export interface AgentsView {
  agents: AgentPresence[];
  /** 설정값을 정상화한 기본 에이전트 id */
  defaultAgent: string;
}

export type Need = "required" | "recommended" | "optional";

/** 제품이 실제로 쓰는 외부 프로그램 하나의 상태. */
export interface RequirementStatus {
  id: string;
  name: string;
  need: Need;
  why: string;
  detected: boolean;
  version?: string;
  path: string;
  /** 깔려는 있는데 최소 버전에 못 미친다 */
  outdated: boolean;
  minMajor: number;
  installUrl: string;
  installHint: string;
}

export interface InstallReport {
  installed: string[];
  skipped: string[];
  failed: string[];
}

export interface ProvisionReport {
  created: string[];
  skipped: string[];
  failed: string[];
}

// ---------- 예약 ----------

export interface ScheduleView {
  key: string;
  packId: string;
  actionId: string;
  label: string;
  kind: ScheduleKind;
  time: string;
  enabled: boolean;
  lastRun?: string;
}

// ---------- herdr 터미널 ----------

export interface HerdrWorkspace {
  workspaceId: string;
  label: string;
  number: number;
  focused: boolean;
  tabCount: number;
  paneCount: number;
  agentStatus: string;
}

export interface HerdrTab {
  tabId: string;
  workspaceId: string;
  label: string;
  number: number;
  focused: boolean;
  paneCount: number;
  agentStatus: string;
}

export interface HerdrAgentRow {
  paneId: string;
  tabId: string;
  workspaceId: string;
  name: string;
  agent: string;
  agentStatus: string;
  cwd: string;
  focused: boolean;
  terminalTitle: string;
}

export interface HerdrSnapshot {
  available: boolean;
  error?: string;
  session: string;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  agents: HerdrAgentRow[];
}

// ---------- 호스트 내장 작업 (에이전트가 승인 큐로 만드는 예약) ----------

export interface TaskSchedule { kind: ScheduleKind; time: string; date?: string | null }

export interface TaskSource { kind: string; agent?: string | null; request?: string | null }

export interface TaskDef {
  id: string;
  title: string;
  prompt: string;
  schedule: TaskSchedule | null;
  enabled: boolean;
  builtin: boolean;
  skill: string | null;
  project: string | null;
  source: TaskSource;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRow { def: TaskDef; lastRun: string | null }

export interface PendingTaskRequest {
  id: string;
  op: "create" | "update" | "pause" | "resume" | "delete";
  agent: string;
  note: string;
  targetTitle: string;
  summary: string[];
  duplicateOf: string | null;
}

export interface RejectedRequest { id: string; error: string }

export interface TasksView {
  builtin: TaskRow[];
  tasks: TaskRow[];
  pending: PendingTaskRequest[];
  rejected: RejectedRequest[];
}

export interface SkillInstall { target: string; path: string; written: boolean }

// ---------- 협업(멀티에이전트 통합 레인) ----------

export type CollabSessionStatus = "active" | "paused" | "readyToFinalize" | "finalized";
export type CollabSessionMode = "direct" | "isolated";
export type CollabDriver = "claude" | "codex";

export type CollabChangeSetStatus =
  | "working"
  | "review_pending"
  | "changes_requested"
  | "approved"
  | "authorized_by_policy"
  | "queued"
  | "integrating"
  | "conflicted"
  | "integrated"
  | "automated_verifying"
  | "manual_verification_pending"
  | "verification_failed"
  | "fix_forward"
  | "reverting"
  | "reverted"
  | "verified"
  | "superseded"
  | "stale_context"
  | "baseline_failed"
  | "redundant"
  | "resolved_with_repair"
  | "recovery_required"
  | "revert_conflicted"
  | "rejected";

export interface CollabSession {
  id: string;
  projectId: string;
  goal: string;
  status: CollabSessionStatus;
  mode: CollabSessionMode;
  /** 대표 체크아웃 절대경로. */
  integrationPath: string;
  integrationBranch: string;
  targetStartSha: string;
  policyVersion: number;
  verificationProfile: string;
  createdAt: string;
  finalizedAt: string;
  pausedReason: string;
}

export interface CollabAgentRun {
  id: string;
  sessionId: string;
  jobId: string;
  taskId: string;
  branch: string;
  worktreePath: string;
  driver: string;
  status: string;
  createdAt: string;
  finishedAt: string;
}

export interface CollabManifestEntry {
  path: string;
  oldBlob: string;
  newBlob: string;
  mode: string;
  renameFrom: string;
  binary: boolean;
}

export interface CollabApproval {
  id: string;
  candidateId: string;
  digest: string;
  expectedHead: string;
  policyVersion: number;
  decision: string;
  decidedBy: string;
  reason: string;
  createdAt: string;
}

export interface CollabChangeSet {
  id: string;
  sessionId: string;
  taskId: string;
  repositoryId: string;
  baseSha: string;
  sourceSha: string;
  baseTreeSha: string;
  sourceTreeSha: string;
  manifestJson: string;
  dependencyJson: string;
  verificationPlanHash: string;
  digest: string;
  status: CollabChangeSetStatus;
  summary: string;
  supersededBy: string;
  remediatedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** 검토 화면용 후보 스냅샷. CollabChangeSet 평탄화 + 구조화된 manifest. */
export interface CollabChangeSetView {
  id: string;
  sessionId: string;
  taskId: string;
  repositoryId: string;
  baseSha: string;
  sourceSha: string;
  baseTreeSha: string;
  sourceTreeSha: string;
  manifestJson: string;
  dependencyJson: string;
  verificationPlanHash: string;
  digest: string;
  status: CollabChangeSetStatus;
  summary: string;
  supersededBy: string;
  remediatedBy: string;
  createdAt: string;
  updatedAt: string;
  manifest: CollabManifestEntry[];
  dependsOn: string[];
  sessionGoal: string;
  overlapPaths: string[];
  expectedHead: string;
  approvals: CollabApproval[];
}

export interface CollabSessionView {
  id: string;
  projectId: string;
  goal: string;
  status: CollabSessionStatus;
  mode: CollabSessionMode;
  integrationPath: string;
  integrationBranch: string;
  targetStartSha: string;
  policyVersion: number;
  verificationProfile: string;
  createdAt: string;
  finalizedAt: string;
  pausedReason: string;
  agentRuns: CollabAgentRun[];
  changeSets: CollabChangeSetView[];
  integrationHead: string;
  integrationClean: boolean;
}

export interface CollabAuditEvent {
  id: string;
  kind: string;
  projectId: string;
  sessionId: string;
  payloadJson: string;
  createdAt: string;
}

export interface CollabLaneInput {
  taskId: string;
  taskPrompt: string;
  driver: CollabDriver;
}

export interface CollabCreateSessionInput {
  projectId: string;
  goal: string;
  mode: CollabSessionMode;
  branch: string;
  lanes: CollabLaneInput[];
}

export interface CollabIntegrationTarget {
  path: string;
  branch: string;
  verifyProfile: string;
}

export interface CollabRegisteredProject {
  id: string;
  name: string;
  path: string;
  integration: CollabIntegrationTarget;
}

export interface CollabLegacyProject {
  name: string;
  path: string;
  workBranch: string;
  verify: string;
}

export interface CollabProjectsView {
  registered: CollabRegisteredProject[];
  legacy: CollabLegacyProject[];
}

export interface CollabInboxReport {
  file: string;
  accepted: boolean;
  candidateId: string;
  reason: string;
}

// 검증 프로필 — argv 배열만 허용(임의 shell 문자열 금지).
export interface CollabVerifyCheckCommand {
  kind: "command";
  cwd: string;
  argv: string[];
}

export interface CollabVerifyCheckHttp {
  kind: "http";
  url: string;
}

export type CollabVerifyCheck = CollabVerifyCheckCommand | CollabVerifyCheckHttp;

export interface CollabVerifyProfile {
  checks: CollabVerifyCheck[];
  manual: string[];
}

export type LocalIntegrationApproval = "required" | "autoAfterPreflight";

/** 승인 정책. 새 세션 초기값 계산에만 쓰인다 — 활성 세션은 시작 때 찍은 snapshot을 따른다. */
export interface CollaborationPolicy {
  localIntegrationApproval: LocalIntegrationApproval;
  verificationMode: string;
  failurePolicy: string;
  integrationStrategy: string;
  remoteWriteApproval: string;
}

/** 새 코어 프로젝트 정본. key는 등록 때 만든 UUID projectId다. */
export interface CoreProjectCfg {
  path: string;
  integration: CollabIntegrationTarget;
  verifyProfiles: Record<string, CollabVerifyProfile>;
}

// ---------- 소스 커넥터 · 읽을거리 ----------

export type ExtensionSourceKind = "builtin" | "user";

export interface ExtensionSourceContribution {
  id: string;
  /** issue | article */
  type: string;
}

export interface ExtensionViewContribution {
  id: string;
  renderer: string;
}

export interface ExtensionPermissionRequests {
  /** 예: ["read"], ["read", "write"] */
  repository: string[];
  issues: string[];
  /** 네트워크 도메인 allowlist 요청 */
  network: string[];
  /** secret ref 이름 — 토큰 자체는 오지 않는다 */
  secrets: string[];
}

export interface ExtensionComponentManifest {
  id: string;
  /** connector | pack */
  type: string;
  /** builtin:github | builtin:rss */
  adapter: string;
  requests: ExtensionPermissionRequests;
  subscriptions: string[];
  commands: string[];
  contributes: {
    sources: ExtensionSourceContribution[];
    views: ExtensionViewContribution[];
  };
}

export interface ExtensionManifest {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  minCoreVersion: string;
  components: ExtensionComponentManifest[];
}

export interface ExtensionBundle {
  manifest: ExtensionManifest;
  source: ExtensionSourceKind;
  dir: string;
}

export interface ExtensionsListView {
  bundles: ExtensionBundle[];
}

/** feed instance 설정(FeedSourceConfig, camelCase). */
export interface FeedEntryCfg {
  name: string;
  url: string;
  tags: string[];
}

export interface FeedSourceCfg {
  feeds: FeedEntryCfg[];
  refreshMinutes: number;
  storeContent: boolean;
}

/** GitHub source instance 설정(GitHubSourceConfig). */
export interface GitHubSourceCfg {
  account: string;
  repository: string;
  repositoryId: string;
  /** open | closed | all */
  state: string;
}

export type SourceInstanceCfg = FeedSourceCfg | GitHubSourceCfg;

/** feed 설정은 feeds 배열이 있다 — instance 목록이 확장 id를 안 주므로 형태로 판별한다. */
export function isFeedCfg(c: SourceInstanceCfg): c is FeedSourceCfg {
  return "feeds" in c;
}

export function isGitHubCfg(c: SourceInstanceCfg): c is GitHubSourceCfg {
  return !("feeds" in c);
}

export interface SourceInstanceRow {
  instanceId: string;
  config: SourceInstanceCfg;
}

export interface DeadLetter {
  id: string;
  source: string;
  kind: string;
  error: string;
  createdAt: string;
}

export interface SourcesInstancesView {
  instances: SourceInstanceRow[];
  deadLetters: DeadLetter[];
}

export interface ArticleRow {
  id: string;
  url: string;
  title: string;
  summary: string;
  /** JSON 문자열: string[] */
  tags: string;
  publishedAt: string;
  discoveredAt: string;
  /** 0 | 1 */
  read: number;
  /** 0 | 1 */
  archived: number;
}

export interface ArticlesListView {
  articles: ArticleRow[];
}

export interface GitHubPollReport {
  fetched: number;
  stagedNew: number;
  stagedUpdates: number;
  skippedPullRequests: number;
  cursor: string;
}

export interface GitHubIssuePayload {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  updatedAt: string;
}

export interface InboundChange {
  id: string;
  /** 빈 문자열이면 가져오기 후보(새 이슈), 아니면 연결된 노트의 field update 후보. */
  linkId: string;
  sourceInstance: string;
  externalId: string;
  /** JSON 문자열: GitHubIssuePayload */
  payload: string;
  targetPath: string;
  createdAt: string;
}

export interface InboundListView {
  inbound: InboundChange[];
}

/** prepared → approved → sending → succeeded | uncertain → reconciled | failed | stale */
export interface RemoteOperation {
  id: string;
  kind: string;
  capability: string;
  payloadHash: string;
  status: string;
  observedRevision: string;
  /** JSON 문자열 또는 짧은 텍스트 */
  resultJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteOperationsView {
  operations: RemoteOperation[];
}
