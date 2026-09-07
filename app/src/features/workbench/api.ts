import { invoke, isTauri } from "@tauri-apps/api/core";
import i18n from "@/i18n";
import type {
  ArtifactKind,
  CalendarEvent,
  Document,
  HarnessRun,
  IssueMigrationItem,
  IssueMigrationReport,
  LaunchInput,
  Project,
  SearchHit,
  Stage,
  WorkItem,
  WorkspaceSnapshot,
  WorkflowDefinition,
  ValidationReport,
  SimulationInput,
  SimulationResult,
  WorkflowDraftRecord,
  WorkflowEventRecord,
  WorkflowInstance,
} from "./types";

export const isWorkbenchPreview =
  !isTauri() &&
  new URLSearchParams(window.location.search).get("preview") === "1";
async function call<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isWorkbenchPreview) {
    const { previewInvoke } = await import("./preview");
    return previewInvoke(command, args) as Promise<T>;
  }
  if (!isTauri())
    throw new Error(i18n.t("workbench:api.desktopOnly"));
  return invoke<T>(command, args);
}
export const sddApi = {
  snapshot: (): Promise<WorkspaceSnapshot> => call("sdd_snapshot"),
  initialize: (): Promise<WorkspaceSnapshot> => call("sdd_initialize"),
  saveProject: (input: Project): Promise<Project> =>
    call("sdd_save_project", { input }),
  saveWork: (input: WorkItem): Promise<WorkItem> =>
    call("sdd_save_work", { input }),
  transition: (id: string, stage: Stage, note?: string): Promise<WorkItem> =>
    call("sdd_transition", { id, stage, note: note ?? null }),
  readDocument: (workId: string, artifact: ArtifactKind): Promise<Document> =>
    call("sdd_read_document", { workId, artifact }),
  writeDocument: (
    workId: string,
    artifact: ArtifactKind,
    markdown: string,
    revision: string,
  ): Promise<Document> =>
    call("sdd_write_document", { workId, artifact, markdown, revision }),
  saveEvent: (input: CalendarEvent): Promise<CalendarEvent> =>
    call("sdd_save_event", { input }),
  deleteEvent: (id: string): Promise<void> => call("sdd_delete_event", { id }),
  search: (query: string): Promise<SearchHit[]> =>
    call("sdd_search", { query }),
  launch: (input: LaunchInput): Promise<HarnessRun> =>
    call("sdd_launch", { input }),
  runs: (): Promise<HarnessRun[]> => call("sdd_runs"),
  refreshRun: (id: string): Promise<HarnessRun> =>
    call("sdd_refresh_run", { id }),
  stopRun: (id: string): Promise<HarnessRun> => call("sdd_stop_run", { id }),
  /** 닫힌 실행의 에이전트 세션을 herdr 에서 같은 대화로 다시 연다. */
  resumeRun: (id: string): Promise<HarnessRun> =>
    call("sdd_resume_run", { id }),
  continueRun: (id: string, instructions: string): Promise<HarnessRun> =>
    call("sdd_continue_run", { id, instructions }),
  runKey: (id: string, key: string): Promise<HarnessRun> =>
    call("sdd_run_key", {
      id,
      key:
        (
          {
            ArrowUp: "up",
            ArrowDown: "down",
            Enter: "enter",
            Escape: "esc",
          } as Record<string, string>
        )[key] ?? key,
    }),
  runOutput: (id: string): Promise<string> => call("sdd_run_output", { id }),
  /** 아직 개발 항목으로 옮기지 않은 레거시 이슈 노트. 아무것도 쓰지 않는다. */
  issueMigrationPlan: (): Promise<IssueMigrationItem[]> =>
    call("issue_migration_plan"),
  issueMigrate: (paths: string[]): Promise<IssueMigrationReport> =>
    call("issue_migrate", { paths }),
};

/** General workflow API. The sddApi methods above remain compatibility wrappers. */
export const workflowApi = {
  catalog: (): Promise<WorkflowDefinition[]> => call("workflow_catalog"),
  validate: (definition: WorkflowDefinition): Promise<ValidationReport> =>
    call("workflow_validate", { definition }),
  simulate: (input: SimulationInput): Promise<SimulationResult> =>
    call("workflow_simulate", { input }),
  drafts: (): Promise<WorkflowDraftRecord[]> => call("workflow_draft_list"),
  saveDraft: (
    draftId: string,
    definition: WorkflowDefinition,
  ): Promise<WorkflowDraftRecord> =>
    call("workflow_draft_save", { input: { draftId, definition } }),
  deleteDraft: (draftId: string): Promise<void> =>
    call("workflow_draft_delete", { draftId }),
  publish: (definition: WorkflowDefinition): Promise<WorkflowDefinition> =>
    call("workflow_publish", { definition }),
  export: (definition: WorkflowDefinition): Promise<string> =>
    call("workflow_export", { definition }),
  import: (json: string): Promise<WorkflowDraftRecord> =>
    call("workflow_import", { json }),
  instance: (id: string): Promise<WorkflowInstance> =>
    call("workflow_instance_get", { id }),
  instances: (workId?: string): Promise<WorkflowInstance[]> =>
    call("workflow_instance_list", { workId: workId ?? null }),
  events: (id: string): Promise<WorkflowEventRecord[]> =>
    call("workflow_instance_events", { id }),
  activate: (
    projectId: string,
    workflowId: string,
    workflowVersion: string,
  ): Promise<Project> =>
    call("workflow_activate", { projectId, workflowId, workflowVersion }),
  snapshot: (): Promise<WorkspaceSnapshot> => call("workflow_snapshot"),
  command: (input: {
    workId: string;
    event: string;
    targetNodeId?: string | null;
    expectedNodeId: string;
    note: string;
    eventId?: string;
    inputDigest?: string;
    facts?: Record<string, unknown>;
  }): Promise<WorkItem> => call("workflow_command", { input }),
};
