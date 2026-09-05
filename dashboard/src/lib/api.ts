import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigPatch,
  ConfigView,
  Diagnostics,
  HerdrDiag,
  IssueNote,
  Job,
  JobRequest,
  MissedRoutine,
  NoteView,
  PluginBundle,
  RoutineName,
  TodoSection,
  TodoSections,
  UnpromotedItem,
  VaultAudit,
  VaultCandidate,
  VaultNode,
  VaultNoteView,
} from "./types";

export const api = {
  getConfig: (): Promise<ConfigView> => invoke("get_config"),
  listObsidianVaults: (): Promise<VaultCandidate[]> => invoke("list_obsidian_vaults"),
  saveConfig: (patch: ConfigPatch): Promise<void> => invoke("save_config", { patch }),
  diagnostics: (): Promise<Diagnostics> => invoke("diagnostics"),

  listIssues: (project?: string): Promise<IssueNote[]> =>
    invoke("list_issues", { project: project ?? null }),
  /** @deprecated kept for pre-issue dashboard clients. */
  listImprovements: (project?: string): Promise<IssueNote[]> =>
    invoke("list_improvements", { project: project ?? null }),
  readNote: (path: string): Promise<NoteView> => invoke("read_note", { path }),
  approveNote: (path: string): Promise<void> => invoke("approve_note", { path }),
  approveIssue: (path: string): Promise<void> => invoke("approve_issue", { path }),
  inboxCount: (project?: string): Promise<number> =>
    invoke("list_inbox_count", { project: project ?? null }),
  auditVault: (): Promise<VaultAudit> => invoke("audit_vault"),
  listUnpromoted: (): Promise<UnpromotedItem[]> => invoke("list_unpromoted"),

  listTodos: (): Promise<TodoSections> => invoke("list_todos"),
  toggleTodo: (section: TodoSection, index: number, checked: boolean): Promise<void> =>
    invoke("toggle_todo", { section, index, checked }),
  addTodo: (section: TodoSection, text: string): Promise<void> =>
    invoke("add_todo", { section, text }),

  listVaultTree: (): Promise<VaultNode[]> => invoke("list_vault_tree"),
  readVaultNote: (rel: string): Promise<VaultNoteView> => invoke("read_vault_note", { rel }),

  enqueueJob: (req: JobRequest): Promise<Job> => invoke("enqueue_job", { req }),
  cancelJob: (id: string): Promise<void> => invoke("cancel_job", { id }),
  focusJob: (id: string): Promise<void> => invoke("focus_job", { id }),
  herdrProbe: (): Promise<HerdrDiag> => invoke("herdr_probe"),
  listJobs: (): Promise<Job[]> => invoke("list_jobs"),
  jobLog: (id: string): Promise<string[]> => invoke("job_log", { id }),
  jobReport: (id: string): Promise<string | null> => invoke("job_report", { id }),

  runRoutineNow: (routine: RoutineName): Promise<Job> => invoke("run_routine_now", { routine }),
  listMissed: (): Promise<MissedRoutine[]> => invoke("list_missed"),
  dismissMissed: (key: string, run: boolean): Promise<MissedRoutine[]> =>
    invoke("dismiss_missed", { key, run }),

  setLaunchAtLogin: (on: boolean): Promise<void> => invoke("set_launch_at_login", { on }),

  pluginInfo: (): Promise<PluginBundle> => invoke("plugin_info"),
  readSkill: (name: string): Promise<string> => invoke("read_skill", { name }),
  openExternal: (url: string): Promise<void> => invoke("open_external", { url }),
};

// Tauri event names (mirrored by Rust side)
export const EVENTS = {
  jobProgress: "job-progress", // { jobId, entry }
  jobFinished: "job-finished", // { job }
  vaultChanged: "vault-changed", // { areas: string[] }
  scheduleMissed: "schedule-missed", // { missed: MissedRoutine }
} as const;
