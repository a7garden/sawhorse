import { invoke } from "@tauri-apps/api/core";
import type {
  ConfigPatch,
  ConfigView,
  Diagnostics,
  ImprovementNote,
  Job,
  JobRequest,
  MissedRoutine,
  NoteView,
  RoutineName,
  TodoSection,
  TodoSections,
  VaultNode,
  VaultNoteView,
} from "./types";

export const api = {
  getConfig: (): Promise<ConfigView> => invoke("get_config"),
  saveConfig: (patch: ConfigPatch): Promise<void> => invoke("save_config", { patch }),
  diagnostics: (): Promise<Diagnostics> => invoke("diagnostics"),

  listImprovements: (project?: string): Promise<ImprovementNote[]> =>
    invoke("list_improvements", { project: project ?? null }),
  readNote: (path: string): Promise<NoteView> => invoke("read_note", { path }),
  approveNote: (path: string): Promise<void> => invoke("approve_note", { path }),
  inboxCount: (project?: string): Promise<number> =>
    invoke("list_inbox_count", { project: project ?? null }),

  listTodos: (): Promise<TodoSections> => invoke("list_todos"),
  toggleTodo: (section: TodoSection, index: number, checked: boolean): Promise<void> =>
    invoke("toggle_todo", { section, index, checked }),
  addTodo: (section: TodoSection, text: string): Promise<void> =>
    invoke("add_todo", { section, text }),

  listVaultTree: (): Promise<VaultNode[]> => invoke("list_vault_tree"),
  readVaultNote: (rel: string): Promise<VaultNoteView> => invoke("read_vault_note", { rel }),

  enqueueJob: (req: JobRequest): Promise<Job> => invoke("enqueue_job", { req }),
  cancelJob: (id: string): Promise<void> => invoke("cancel_job", { id }),
  listJobs: (): Promise<Job[]> => invoke("list_jobs"),
  jobLog: (id: string): Promise<string[]> => invoke("job_log", { id }),
  jobReport: (id: string): Promise<string | null> => invoke("job_report", { id }),

  runRoutineNow: (routine: RoutineName): Promise<Job> => invoke("run_routine_now", { routine }),
  listMissed: (): Promise<MissedRoutine[]> => invoke("list_missed"),
  dismissMissed: (key: string, run: boolean): Promise<MissedRoutine[]> =>
    invoke("dismiss_missed", { key, run }),

  setLaunchAtLogin: (on: boolean): Promise<void> => invoke("set_launch_at_login", { on }),
};

// Tauri event names (mirrored by Rust side)
export const EVENTS = {
  jobProgress: "job-progress", // { jobId, entry }
  jobFinished: "job-finished", // { job }
  vaultChanged: "vault-changed", // { areas: string[] }
  scheduleMissed: "schedule-missed", // { missed: MissedRoutine }
} as const;
