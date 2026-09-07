import { invoke as tauriInvoke, isTauri } from "@tauri-apps/api/core";
import i18n from "@/i18n";
async function invoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (
    !isTauri() &&
    new URLSearchParams(window.location.search).get("preview") === "1"
  ) {
    const { corePreview } = await import("./core-preview");
    return corePreview(command, args) as Promise<T>;
  }
  if (!isTauri()) throw new Error(i18n.t("common:api.desktopOnly"));
  return tauriInvoke<T>(command, args);
}
import type {
  AgentsView,
  CollabAgentRun,
  CollabAuditEvent,
  CollabCreateSessionInput,
  CollabInboxReport,
  CollabProjectsView,
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
  RequirementStatus,
  ScheduleView,
  CollabSession,
  CollabSessionView,
  TaskDef,
  TasksView,
  TodoSection,
  TodoSections,
  UnpromotedItem,
  VaultAudit,
  VaultCandidate,
  VaultNode,
  VaultNoteView,
  CollabVerifyProfile,
  ArticlesListView,
  ExtensionsListView,
  FeedSourceCfg,
  GitHubPollReport,
  GitHubSourceCfg,
  InboundListView,
  RemoteOperationsView,
  SourcesInstancesView,
  InstalledExtensionPackage,
  PackageWorkflowSummary,
  ExtensionLock,
  IngestionJob,
} from "./types";

export const api = {
  getConfig: (): Promise<ConfigView> => invoke("get_config"),
  listObsidianVaults: (): Promise<VaultCandidate[]> =>
    invoke("list_obsidian_vaults"),
  saveConfig: (patch: ConfigPatch): Promise<void> =>
    invoke("save_config", { patch }),
  diagnostics: (): Promise<Diagnostics> => invoke("diagnostics"),

  listIssues: (project?: string): Promise<IssueNote[]> =>
    invoke("list_issues", { project: project ?? null }),
  /** @deprecated kept for pre-issue dashboard clients. */
  listImprovements: (project?: string): Promise<IssueNote[]> =>
    invoke("list_improvements", { project: project ?? null }),
  readNote: (path: string): Promise<NoteView> => invoke("read_note", { path }),
  /** Embedded image in a note, returned as a data: URL (webviews cannot read files). */
  readNoteAsset: (notePath: string, src: string): Promise<string> =>
    invoke("read_note_asset", { notePath, src }),
  approveNote: (path: string): Promise<void> =>
    invoke("approve_note", { path }),
  approveIssue: (path: string): Promise<void> =>
    invoke("approve_issue", { path }),
  inboxCount: (project?: string): Promise<number> =>
    invoke("list_inbox_count", { project: project ?? null }),
  auditVault: (): Promise<VaultAudit> => invoke("audit_vault"),
  listUnpromoted: (): Promise<UnpromotedItem[]> => invoke("list_unpromoted"),

  listTodos: (): Promise<TodoSections> => invoke("list_todos"),
  toggleTodo: (
    section: TodoSection,
    index: number,
    checked: boolean,
  ): Promise<void> => invoke("toggle_todo", { section, index, checked }),
  addTodo: (section: TodoSection, text: string): Promise<void> =>
    invoke("add_todo", { section, text }),

  listVaultTree: (): Promise<VaultNode[]> => invoke("list_vault_tree"),
  readVaultNote: (rel: string): Promise<VaultNoteView> =>
    invoke("read_vault_note", { rel }),

  enqueueJob: (req: JobRequest): Promise<Job> => invoke("enqueue_job", { req }),
  cancelJob: (id: string): Promise<void> => invoke("cancel_job", { id }),
  focusJob: (id: string): Promise<void> => invoke("focus_job", { id }),
  herdrProbe: (): Promise<HerdrDiag> => invoke("herdr_probe"),
  listJobs: (): Promise<Job[]> => invoke("list_jobs"),
  jobLog: (id: string): Promise<string[]> => invoke("job_log", { id }),
  jobReport: (id: string): Promise<string | null> =>
    invoke("job_report", { id }),

  listTasks: (): Promise<TasksView> => invoke("list_tasks"),
  saveTask: (def: TaskDef): Promise<TaskDef> => invoke("save_task", { def }),
  deleteTask: (id: string): Promise<void> => invoke("delete_task", { id }),
  setTaskEnabled: (id: string, enabled: boolean): Promise<void> =>
    invoke("set_task_enabled", { id, enabled }),
  runTaskNow: (id: string): Promise<Job> => invoke("run_task_now", { id }),
  approveTaskRequest: (id: string): Promise<TaskDef> =>
    invoke("approve_request", { id }),
  rejectTaskRequest: (id: string, reason?: string): Promise<void> =>
    invoke("reject_request", { id, reason: reason ?? null }),

  listMissed: (): Promise<MissedRoutine[]> => invoke("list_missed"),
  dismissMissed: (key: string, run: boolean): Promise<MissedRoutine[]> =>
    invoke("dismiss_missed", { key, run }),

  setLaunchAtLogin: (on: boolean): Promise<void> =>
    invoke("set_launch_at_login", { on }),

  pluginInfo: (): Promise<PluginBundle> => invoke("plugin_info"),
  openExternal: (url: string): Promise<void> =>
    invoke("open_external", { url }),
  openPath: (path: string): Promise<void> => invoke("open_path", { path }),

  // 확장(pack)
  listPacks: (): Promise<PackRegistryView> => invoke("list_packs"),
  listExtensionPackages: (): Promise<InstalledExtensionPackage[]> =>
    invoke("extension_package_list"),
  resolveExtensionPackage: (
    packageId: string,
    version: string,
  ): Promise<InstalledExtensionPackage[]> =>
    invoke("extension_package_resolve", { packageId, version }),
  installExtensionPackage: (input: {
    kind: "local-directory" | "local-file" | "git" | "https";
    location: string;
    commit?: string | null;
    subdir?: string | null;
  }): Promise<InstalledExtensionPackage> =>
    invoke("extension_package_install", { input }),
  extensionLock: (): Promise<ExtensionLock> => invoke("extension_package_lock"),
  exportExtensionPackage: (
    packageId: string,
    version: string,
    digest: string,
  ): Promise<import("./types").PortableExtensionPackage> =>
    invoke("extension_package_export", { packageId, version, digest }),
  activateExtensionPackage: (input: {
    projectId: string;
    packageId: string;
    version: string;
    grants: Record<string, string[]>;
  }): Promise<ExtensionLock> => invoke("extension_package_activate", { input }),
  extensionPackageWorkflows: (): Promise<PackageWorkflowSummary[]> =>
    invoke("extension_package_workflows"),
  ingestionStart: (input: {
    projectId: string;
    sources: Array<{ path: string; label: string }>;
    outputPrefix: string;
    autoApply: boolean;
  }): Promise<IngestionJob> => invoke("ingestion_start", { input }),
  ingestionList: (): Promise<IngestionJob[]> => invoke("ingestion_list"),
  ingestionResume: (id: string, maxFiles = 200): Promise<IngestionJob> =>
    invoke("ingestion_resume", { id, maxFiles }),
  ingestionPause: (id: string): Promise<IngestionJob> =>
    invoke("ingestion_pause", { id }),
  ingestionCancel: (id: string): Promise<IngestionJob> =>
    invoke("ingestion_cancel", { id }),
  ingestionApply: (id: string): Promise<IngestionJob> =>
    invoke("ingestion_apply", { id }),
  listNav: (): Promise<NavEntry[]> => invoke("list_nav"),
  setPackEnabled: (id: string, on: boolean): Promise<ConfigView> =>
    invoke("set_pack_enabled", { id, on }),
  savePackSettings: (
    packId: string,
    values: Record<string, unknown>,
  ): Promise<ConfigView> => invoke("save_pack_settings", { packId, values }),
  queryPackView: (
    packId: string,
    viewId: string,
    projectId?: string | null,
  ): Promise<QueryResult> =>
    invoke("query_pack_view", { packId, viewId, projectId: projectId ?? null }),
  runPackAction: (
    packId: string,
    actionId: string,
    params: Record<string, unknown> = {},
    projectId?: string | null,
  ): Promise<Job> =>
    invoke("run_pack_action", {
      packId,
      actionId,
      params,
      projectId: projectId ?? null,
    }),
  readPackSkill: (packId: string, name: string): Promise<string> =>
    invoke("read_pack_skill", { packId, name }),

  // 에이전트 브리지
  listAgents: (): Promise<AgentsView> => invoke("list_agents"),
  checkRequirements: (): Promise<RequirementStatus[]> =>
    invoke("check_requirements"),
  setDefaultAgent: (id: string): Promise<ConfigView> =>
    invoke("set_default_agent", { id }),
  packAgentStatus: (packId: string): Promise<PackAgentStatus> =>
    invoke("pack_agent_status", { packId }),
  installPackSkills: (
    packId: string,
    agent: string,
    force: boolean,
  ): Promise<InstallReport> =>
    invoke("install_pack_skills", { packId, agent, force }),
  uninstallPackSkills: (
    packId: string,
    agent: string,
  ): Promise<InstallReport> =>
    invoke("uninstall_pack_skills", { packId, agent }),

  // 작업공간 프로비저닝
  suggestVaultPath: (): Promise<string> => invoke("suggest_vault_path"),
  workspacePlan: (): Promise<string[]> => invoke("workspace_plan"),
  provisionWorkspace: (vaultPath?: string): Promise<ProvisionReport> =>
    invoke("provision_workspace", { vaultPath: vaultPath ?? null }),

  // 예약
  listSchedules: (): Promise<ScheduleView[]> => invoke("list_schedules"),
  runScheduledNow: (key: string): Promise<Job> =>
    invoke("run_scheduled_now", { key }),
  setSchedule: (
    key: string,
    enabled: boolean,
    time: string,
  ): Promise<ConfigView> => invoke("set_schedule", { key, enabled, time }),

  // herdr 터미널
  herdrSnapshot: (): Promise<HerdrSnapshot> => invoke("herdr_snapshot"),
  herdrFocusWorkspace: (id: string): Promise<void> =>
    invoke("herdr_focus_workspace", { id }),
  herdrFocusPane: (id: string): Promise<void> =>
    invoke("herdr_focus_pane", { id }),
  herdrCloseTab: (id: string): Promise<void> =>
    invoke("herdr_close_tab", { id }),
  herdrReadPane: (id: string, lines = 40): Promise<string> =>
    invoke("herdr_read_pane", { id, lines }),
  herdrOpenTab: (
    cwd?: string,
    label?: string,
  ): Promise<{ tabId: string; paneId: string; workspaceId: string }> =>
    invoke("herdr_open_tab", { cwd: cwd ?? null, label: label ?? null }),
  // 협업(멀티에이전트 통합 레인)
  collabProjectsView: (): Promise<CollabProjectsView> =>
    invoke("collab_projects_view"),
  collabRegisterProject: (
    name: string,
    path: string,
    branch: string,
    verifyProfile: string,
  ): Promise<{ id: string; name: string; path: string; branch: string }> =>
    invoke("collab_register_project", { name, path, branch, verifyProfile }),
  collabSaveVerifyProfile: (
    projectId: string,
    profileName: string,
    profile: CollabVerifyProfile,
  ): Promise<{ ok: boolean }> =>
    invoke("collab_save_verify_profile", { projectId, profileName, profile }),
  collabCreateSession: (
    input: CollabCreateSessionInput,
  ): Promise<CollabSession> => invoke("collab_create_session", { input }),
  collabListSessions: (): Promise<CollabSession[]> =>
    invoke("collab_list_sessions"),
  collabSessionDetail: (id: string): Promise<CollabSessionView> =>
    invoke("collab_session_detail", { id }),
  collabSessionAudit: (id: string): Promise<CollabAuditEvent[]> =>
    invoke("collab_session_audit", { id }),
  collabApprove: (candidateId: string, decidedBy: string): Promise<void> =>
    invoke("collab_approve", { candidateId, decidedBy }),
  collabReject: (
    candidateId: string,
    decidedBy: string,
    reason: string,
  ): Promise<void> =>
    invoke("collab_reject", { candidateId, decidedBy, reason }),
  collabRequestChanges: (candidateId: string, reason: string): Promise<void> =>
    invoke("collab_request_changes", { candidateId, reason }),
  collabManualOk: (candidateId: string): Promise<void> =>
    invoke("collab_manual_ok", { candidateId }),
  collabManualFail: (candidateId: string, reason: string): Promise<void> =>
    invoke("collab_manual_fail", { candidateId, reason }),
  collabRepair: (
    candidateId: string,
    instruction: string,
  ): Promise<CollabAgentRun> =>
    invoke("collab_repair", { candidateId, instruction }),
  collabRevert: (candidateId: string): Promise<string> =>
    invoke("collab_revert", { candidateId }),
  collabFinalize: (sessionId: string): Promise<CollabSession> =>
    invoke("collab_finalize", { sessionId }),
  collabPause: (sessionId: string, reason: string): Promise<void> =>
    invoke("collab_pause", { sessionId, reason }),
  collabResume: (sessionId: string): Promise<void> =>
    invoke("collab_resume", { sessionId }),
  collabRunQueue: (): Promise<string | null> => invoke("collab_run_queue"),
  collabInboxTick: (): Promise<CollabInboxReport[]> =>
    invoke("collab_inbox_tick"),
  // 소스 커넥터 · 읽을거리
  fetchExtensionCatalog: (url: string): Promise<unknown> =>
    invoke("fetch_extension_catalog", { url }),
  setConnectorEnabled: (id: string, enabled: boolean): Promise<void> =>
    invoke("set_connector_enabled", { id, enabled }),
  githubAccount: (): Promise<{ login: string; name: string | null } | null> =>
    invoke("github_account"),
  githubOAuthStart: (): Promise<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  }> => invoke("github_oauth_start"),
  githubOAuthPoll: (
    flowId: string,
  ): Promise<
    | { status: "pending"; retryAfter: number }
    | {
        status: "complete";
        account: { login: string; name: string | null };
      }
  > => invoke("github_oauth_poll", { flowId }),
  githubOAuthCancel: (flowId: string): Promise<void> =>
    invoke("github_oauth_cancel", { flowId }),
  githubDisconnect: (): Promise<void> => invoke("github_disconnect"),
  githubRepositories: (
    page: number,
  ): Promise<{
    repositories: import("./types").GitHubRepository[];
    hasMore: boolean;
  }> => invoke("github_repositories", { page }),
  githubCloneProject: (
    repository: string,
    parentPath: string,
  ): Promise<import("@/features/workbench/types").Project> =>
    invoke("github_clone_project", { repository, parentPath }),
  setIssueMilestone: (paths: string[], milestone: string): Promise<void> =>
    invoke("set_issue_milestone", { paths, milestone }),
  extensionsList: (): Promise<ExtensionsListView> => invoke("extensions_list"),
  sourcesUpsertInstance: (input: {
    instanceId: string;
    extensionId: string;
    componentId: string;
    config: FeedSourceCfg | GitHubSourceCfg;
    network: string[];
  }): Promise<{ ok: boolean; instanceId: string }> =>
    invoke("sources_upsert_instance", { ...input }),
  sourcesListInstances: (): Promise<SourcesInstancesView> =>
    invoke("sources_list_instances"),
  sourcesRefresh: (instanceId: string): Promise<{ discovered: number }> =>
    invoke("sources_refresh", { instanceId }),
  articlesList: (
    sourceInstance: string,
    limit?: number,
  ): Promise<ArticlesListView> =>
    invoke("articles_list", { sourceInstance, limit: limit ?? null }),
  articleSetState: (input: {
    articleId: string;
    read?: boolean;
    archived?: boolean;
  }): Promise<void> =>
    invoke("article_set_state", {
      articleId: input.articleId,
      read: input.read ?? null,
      archived: input.archived ?? null,
    }),
  githubImportTick: (instanceId: string): Promise<GitHubPollReport> =>
    invoke("github_import_tick", { instanceId }),
  inboundList: (state: "staged"): Promise<InboundListView> =>
    invoke("inbound_list", { state }),
  inboundAcceptImport: (input: {
    inboundId: string;
    projectId: string;
  }): Promise<{ notePath: string }> =>
    invoke("inbound_accept_import", { ...input }),
  inboundAcceptUpdate: (inboundId: string): Promise<{ notePath: string }> =>
    invoke("inbound_accept_update", { inboundId }),
  remoteOperationsList: (statuses: string[]): Promise<RemoteOperationsView> =>
    invoke("remote_operations_list", { statuses }),
  remoteOperationApprove: (
    operationId: string,
    decidedBy: string,
  ): Promise<void> =>
    invoke("remote_operation_approve", { operationId, decidedBy }),
  remoteOperationExecute: (
    operationId: string,
    repoDir: string,
  ): Promise<string> =>
    invoke("remote_operation_execute", { operationId, repoDir }),
  remoteOperationReconcile: (
    operationId: string,
    remoteCreated: boolean,
    result: string,
  ): Promise<void> =>
    invoke("remote_operation_reconcile", {
      operationId,
      remoteCreated,
      result,
    }),
};

// Tauri event names (mirrored by Rust side)
export const EVENTS = {
  jobProgress: "job-progress", // { jobId, entry }
  jobFinished: "job-finished", // { job }
  collabChanged: "collab-changed", // { reason?: string }
  vaultChanged: "vault-changed", // { areas: string[] }
  scheduleMissed: "schedule-missed", // { missed: MissedEntry }
  tasksChanged: "tasks-changed", // {}
} as const;
