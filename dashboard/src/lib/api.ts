import { invoke } from "@tauri-apps/api/core";
import type {
  AgentPresence,
  ConfigPatch,
  ConfigView,
  Diagnostics,
  HerdrDiag,
  HerdrSnapshot,
  InstallReport,
  IssueNote,
  Job,
  JobRequest,
  MissedRoutine,
  NavEntry,
  NoteView,
  PackAgentStatus,
  PackRegistryView,
  PluginBundle,
  ProvisionReport,
  QueryResult,
  RoutineName,
  ScheduleView,
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
  openPath: (path: string): Promise<void> => invoke("open_path", { path }),

  // 확장(pack)
  listPacks: (): Promise<PackRegistryView> => invoke("list_packs"),
  listNav: (): Promise<NavEntry[]> => invoke("list_nav"),
  setPackEnabled: (id: string, on: boolean): Promise<ConfigView> =>
    invoke("set_pack_enabled", { id, on }),
  savePackSettings: (packId: string, values: Record<string, unknown>): Promise<ConfigView> =>
    invoke("save_pack_settings", { packId, values }),
  queryPackView: (packId: string, viewId: string): Promise<QueryResult> =>
    invoke("query_pack_view", { packId, viewId }),
  runPackAction: (
    packId: string,
    actionId: string,
    params: Record<string, unknown> = {},
  ): Promise<Job> => invoke("run_pack_action", { packId, actionId, params }),
  readPackSkill: (packId: string, name: string): Promise<string> =>
    invoke("read_pack_skill", { packId, name }),

  // 에이전트 브리지
  listAgents: (): Promise<AgentPresence[]> => invoke("list_agents"),
  packAgentStatus: (packId: string): Promise<PackAgentStatus> =>
    invoke("pack_agent_status", { packId }),
  installPackSkills: (packId: string, agent: string, force: boolean): Promise<InstallReport> =>
    invoke("install_pack_skills", { packId, agent, force }),
  uninstallPackSkills: (packId: string, agent: string): Promise<InstallReport> =>
    invoke("uninstall_pack_skills", { packId, agent }),

  // 작업공간 프로비저닝
  workspacePlan: (): Promise<string[]> => invoke("workspace_plan"),
  provisionWorkspace: (vaultPath?: string): Promise<ProvisionReport> =>
    invoke("provision_workspace", { vaultPath: vaultPath ?? null }),

  // 예약
  listSchedules: (): Promise<ScheduleView[]> => invoke("list_schedules"),
  runScheduledNow: (key: string): Promise<Job> => invoke("run_scheduled_now", { key }),
  setSchedule: (key: string, enabled: boolean, time: string): Promise<ConfigView> =>
    invoke("set_schedule", { key, enabled, time }),

  // herdr 터미널
  herdrSnapshot: (): Promise<HerdrSnapshot> => invoke("herdr_snapshot"),
  herdrFocusWorkspace: (id: string): Promise<void> => invoke("herdr_focus_workspace", { id }),
  herdrFocusPane: (id: string): Promise<void> => invoke("herdr_focus_pane", { id }),
  herdrCloseTab: (id: string): Promise<void> => invoke("herdr_close_tab", { id }),
  herdrOpenTab: (cwd?: string, label?: string): Promise<{ tabId: string; paneId: string; workspaceId: string }> =>
    invoke("herdr_open_tab", { cwd: cwd ?? null, label: label ?? null }),
};

// Tauri event names (mirrored by Rust side)
export const EVENTS = {
  jobProgress: "job-progress", // { jobId, entry }
  jobFinished: "job-finished", // { job }
  vaultChanged: "vault-changed", // { areas: string[] }
  scheduleMissed: "schedule-missed", // { missed: MissedRoutine }
} as const;
