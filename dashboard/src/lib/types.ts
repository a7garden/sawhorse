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
  | "promote";

export interface JobRequest {
  kind: JobKind;
  project?: string;
  ids?: string[];
  routine?: RoutineName;
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
  key: string; // "<routine>-<date>"
  routine: RoutineName;
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
