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

/** Only two behaviors exist. "auto" in old config files is normalized to headless by the backend. */
export type HerdrMode = "herdr" | "headless";
export type HerdrCleanup = "closeOnSuccess" | "keep" | "closeAlways";

export interface HerdrCfg {
  mode: HerdrMode;
  bin: string;
  session: string; // "" = herdr default session
  workspaceLabel: string;
  cleanup: HerdrCleanup;
  maxParallel: number;
  startTimeoutSec: number;
  jobTimeoutMin: number; // 0 = unlimited
  notify: boolean;
  childModelPolicy: "auto" | "inherit";
}

/** A CLI not in the catalog, registered manually by the user. */
export interface CustomAgent {
  id: string;
  name: string;
  /** Executable name or absolute path. If empty, falls back to the id as the name. */
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
  /** Approval policy and integration method. Used only to compute a new session's initial value. */
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
  /** Canonical new-core-project. key is the UUID projectId created at registration. */
  coreProjects: Record<string, CoreProjectCfg>;
  dashboard: DashboardCfg;
}

export type ConfigPatch = Partial<DashboardCfg> & {
  vaultPath?: string;
  defaultProject?: string;
  projects?: ProjectCfg[];
  coreProjects?: Record<string, CoreProjectCfg>;
  /** Dashboard block partial update — used for instant saves of dashboard.collaboration. */
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
export type JobStatus =
  "queued" | "running" | "success" | "failed" | "cancelled" | "interrupted";

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

/** "What the user should do next" aggregates read by the top-level strip of the workbench. */
export interface VaultAttention {
  pendingSchemaMoves: number;
  schemaConflicts: number;
  schemaId: string;
  schemaRevision: number;
  pendingLegacyIssues: number;
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
  /** Actions declared by the pack */
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
/// Lifecycle of a session as seen by herdr. blocked = a human must approve/provide input in herdr.
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface Job {
  id: string;
  kind: JobKind;
  label: string;
  /** Dedup key. A new job is rejected while a job with the same key is queued or running. */
  dedupKey: string;
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
  reason?: string | null;
  /** Whether a headless run can be peeked at in a herdr window — governs the "herdr로 보기" (view in herdr) action */
  viewerOk: boolean;
}

export interface Diagnostics {
  configExists: boolean;
  vaultPathOk: boolean;
  claudeOk: boolean;
  claudeVersion?: string;
  herdr: HerdrDiag;
  projects: {
    name: string;
    pathOk: boolean;
    gitOk: boolean;
    branchOk: boolean | null;
  }[];
}

export interface MissedRoutine {
  key: string; // "<schedule key>-<date>"
  /** Schedule key (`si.morning`). Older records carry the routine name (`morning`). */
  routine: string;
  /** Human-readable name. Absent in older records. */
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

// ---------- Extensions (pack) ----------

export type SettingFieldType =
  "text" | "path" | "number" | "bool" | "select" | "table";
export type ScheduleKind = "daily" | "weekdays" | "weekly" | "once";
export type ViewKind =
  | "notes"
  | "native"
  | "table"
  | "board"
  | "form"
  | "document"
  | "timeline"
  | "review-queue"
  | "graph"
  | "metrics";
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
  /** "" | "title" | "mtime" — values coming from the note itself, not frontmatter */
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
  /** none | multiple. multiple passes only the checked rows as the view action's ids. */
  selection: "none" | "multiple";
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

export interface ExtensionPackageManifest {
  manifestVersion: number;
  id: string;
  publisher: string;
  name: string;
  version: string;
  engineApi: string;
  dependencies: Array<{ id: string; requirement: string; optional: boolean }>;
  provides: string[];
  contributions: Record<string, string[]>;
  permissions: string[];
  fileDigests: Record<string, string>;
}

export interface InstalledExtensionPackage {
  manifest: ExtensionPackageManifest;
  digest: string;
  path: string;
  source: string;
  commit: string | null;
  installedAt: string;
}

export interface PackageWorkflowEntry {
  id: string;
  label: string;
  version: string;
  description: string;
  nodes: number;
}

export interface PackageWorkflowSummary {
  packageId: string;
  packageName: string;
  packageVersion: string;
  source: string;
  workflows: PackageWorkflowEntry[];
}

export interface PortableExtensionPackage {
  manifest: ExtensionPackageManifest;
  files: Record<string, { encoding: "base64"; data: string } | string>;
}

export interface LockedExtensionPackage {
  id: string;
  version: string;
  digest: string;
  permissions: string[];
  source: string;
  commit: string | null;
}

export interface ExtensionLock {
  formatVersion: number;
  projects: Record<string, LockedExtensionPackage[]>;
}

export interface IngestionDraft {
  path: string;
  content: string;
  provenance: Array<{
    claim: string;
    snapshotFileId: string;
    evidencePath: string;
    location: string;
  }>;
  conflict: boolean;
  conflictReason: string | null;
}

export interface IngestionJob {
  formatVersion: number;
  id: string;
  key: string;
  projectId: string;
  outputPrefix: string;
  status:
    | "paused"
    | "running"
    | "waiting-review"
    | "applied"
    | "cancelled"
    | "failed";
  stage: string;
  processedFiles: number;
  totalFiles: number;
  processedBytes: number;
  snapshots: Array<{
    id: string;
    sourceLabel: string;
    originalPath: string;
    relativePath: string;
    evidencePath: string;
    digest: string;
    size: number;
    mediaType: string;
  }>;
  drafts: IngestionDraft[];
  changeSetId: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  autoApply: boolean;
}

export interface NavEntry {
  packId: string;
  packName: string;
  viewId: string;
  label: string;
  icon: string;
  type: ViewKind;
  component: string;
  /** Sidebar section tag: work | execution | vault | reading | automation (empty = other) */
  group: string;
}

// ---------- Note queries ----------

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

// ---------- Agent bridge ----------

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

export interface AgentSkillGroup {
  agent: string;
  skills: SkillStatus[];
}

export interface PackAgentStatus {
  packId: string;
  /** Per-target-agent skill install status — the schema stays the same as targets grow */
  agents: AgentSkillGroup[];
  pluginInstalls: PluginInstall[];
}

/** A skill actually found in an agent folder (browsable regardless of origin) */
export interface AgentSkillEntry {
  name: string;
  description: string;
  path: string;
  /** Top-level folder (plugin·collection) name. Codex slash prompts use "prompts" */
  group: string;
  /** Whether this is a copy managed by sawhorse */
  managed: boolean;
}

/** One skills.sh marketplace search result row */
export interface MarketSkill {
  id: string;
  skillId: string;
  name: string;
  source: string;
  installs: number;
}

export interface AgentPresence {
  id: string;
  name: string;
  detected: boolean;
  version?: string;
  /** Executable path actually found ("" = not found) */
  path: string;
  home: string;
  /** Whether this is a skill install target */
  installable: boolean;
  /** Whether the app can run jobs directly with this agent */
  runsJobs: boolean;
  /** If "", no install location is registered — the button is withheld. */
  installUrl: string;
  installHint: string;
  custom: boolean;
  note: string;
}

export interface AgentsView {
  agents: AgentPresence[];
  /** Default agent id with the setting value normalized */
  defaultAgent: string;
}

export type Need = "required" | "recommended" | "optional";

/** Status of one external program the product actually uses. */
export interface RequirementStatus {
  id: string;
  name: string;
  need: Need;
  why: string;
  detected: boolean;
  version?: string;
  path: string;
  /** Installed but below the minimum version */
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

// ---------- Schedules ----------

export interface ScheduleView {
  key: string;
  packId: string;
  actionId: string;
  label: string;
  kind: ScheduleKind;
  time: string;
  enabled: boolean;
  lastRun?: string;
  /** Dedup key of the job this would produce if run now (kept in sync with Job.dedupKey). */
  jobKey: string;
}

// ---------- herdr terminal ----------

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

// ---------- Automation tasks (TaskDef) — stored run definitions handled by the automation screen.
// A different concept from the board's work items (WorkItem, features/workbench/types.ts). ----------

export interface TaskSchedule {
  kind: ScheduleKind;
  time: string;
  date?: string | null;
  days?: number[];
}

export interface TaskSource {
  kind: string;
  agent?: string | null;
  request?: string | null;
}

export interface TaskDef {
  id: string;
  title: string;
  prompt: string;
  schedule: TaskSchedule | null;
  enabled: boolean;
  builtin: boolean;
  skill: string | null;
  project: string | null;
  action?: { id: string; params: Record<string, unknown> } | null;
  source: TaskSource;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRow {
  def: TaskDef;
  lastRun: string | null;
  /** Dedup key of the job this would produce if run now (kept in sync with Job.dedupKey). */
  jobKey: string;
}

export interface PendingTaskRequest {
  id: string;
  op: "create" | "update" | "pause" | "resume" | "delete";
  agent: string;
  note: string;
  targetTitle: string;
  summary: string[];
  duplicateOf: string | null;
}

export interface RejectedRequest {
  id: string;
  error: string;
}

export interface TasksView {
  builtin: TaskRow[];
  tasks: TaskRow[];
  pending: PendingTaskRequest[];
  rejected: RejectedRequest[];
}
// ---------- Collaboration (unified multi-agent lane) ----------

export type CollabSessionStatus =
  "active" | "paused" | "readyToFinalize" | "finalized";
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
  /** Absolute path of the primary checkout. */
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

/** Candidate snapshot for the review screen. Flattened CollabChangeSet + structured manifest. */
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

// Verification profiles — argv arrays only (arbitrary shell strings forbidden).
export interface CollabVerifyCheckCommand {
  kind: "command";
  cwd: string;
  argv: string[];
}

export interface CollabVerifyCheckHttp {
  kind: "http";
  url: string;
}

export type CollabVerifyCheck =
  CollabVerifyCheckCommand | CollabVerifyCheckHttp;

export interface CollabVerifyProfile {
  checks: CollabVerifyCheck[];
  manual: string[];
}

export type LocalIntegrationApproval = "required" | "autoAfterPreflight";

/** Approval policy. Used only to compute a new session's initial value — active sessions follow the snapshot taken at start. */
export interface CollaborationPolicy {
  localIntegrationApproval: LocalIntegrationApproval;
  verificationMode: string;
  failurePolicy: string;
  integrationStrategy: string;
  remoteWriteApproval: string;
}

/** Canonical new-core-project. key is the UUID projectId created at registration. */
export interface CoreProjectCfg {
  path: string;
  integration: CollabIntegrationTarget;
  verifyProfiles: Record<string, CollabVerifyProfile>;
}

// ---------- Source connectors · reading feed ----------

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
  /** e.g. ["read"], ["read", "write"] */
  repository: string[];
  issues: string[];
  /** Network domain allowlist request */
  network: string[];
  /** secret ref name — the token itself never arrives */
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
  enabled?: boolean;
  manifest: ExtensionManifest;
  source: ExtensionSourceKind;
  dir: string;
}

export interface ExtensionsListView {
  bundles: ExtensionBundle[];
}

/** Feed instance config (FeedSourceConfig, camelCase). */
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

/** GitHub source instance config (GitHubSourceConfig). */
export interface GitHubSourceCfg {
  account: string;
  repository: string;
  repositoryId: string;
  state: string;
  /** Project (sdlc id) this sync is bound to. Older instances may lack it. */
  projectId?: string;
}

export type SourceInstanceCfg = FeedSourceCfg | GitHubSourceCfg;

/** Feed config has a feeds array — the instance list omits the extension id, so discriminate by shape. */
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
  /** JSON string: string[] */
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
  /** Empty string = an import candidate (new issue); otherwise a field update candidate for the linked note. */
  linkId: string;
  sourceInstance: string;
  externalId: string;
  /** JSON string: GitHubIssuePayload */
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
  /** JSON string or short text */
  resultJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteOperationsView {
  operations: RemoteOperation[];
}

export interface GitHubRepository {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  language: string | null;
  updatedAt: string;
}

export interface ManagedTodo {
  id: string;
  text: string;
  checked: boolean;
  dueDate: string | null;
  priority: "high" | "normal" | "low";
  source: string;
}
export type ManagedTodoInput = Pick<ManagedTodo, "text" | "checked" | "dueDate" | "priority"> & { id?: string; deleted?: boolean };
