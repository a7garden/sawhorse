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

export interface DashboardCfg {
  schedules: Schedules;
  excelOutputDir: string;
  claudeBin: string;
  permissionMode: PermissionMode;
  launchAtLogin: boolean;
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

export interface ImprovementNote {
  project: string;
  path: string; // absolute
  id: string;
  title: string;
  url: string;
  category: string;
  priority: string;
  status: string;
  approve: boolean;
  approved: string;
  verified: string;
  dependsOn: string[];
  dependents: string[];
  commits: string[];
  mtimeMs: number;
}

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
}

export interface ProgressEntry {
  tsMs: number;
  kind: "init" | "text" | "tool" | "result";
  text?: string;
  tool?: string;
  summary?: string;
  isError?: boolean;
}

export interface Diagnostics {
  configExists: boolean;
  vaultPathOk: boolean;
  claudeOk: boolean;
  claudeVersion?: string;
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
