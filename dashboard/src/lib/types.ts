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

export interface DashboardCfg {
  schedules: Schedules;
  excelOutputDir: string;
  claudeBin: string;
  permissionMode: PermissionMode;
  launchAtLogin: boolean;
  herdr: HerdrCfg;
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
  dashboard: DashboardCfg;
}

export type ConfigPatch = Partial<DashboardCfg> & {
  vaultPath?: string;
  defaultProject?: string;
  projects?: ProjectCfg[];
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
  home: string;
  installable: boolean;
  note: string;
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
