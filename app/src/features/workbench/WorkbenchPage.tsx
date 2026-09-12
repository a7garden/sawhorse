import { TaskBoard, IntentInbox, QuickDecision, type QuickAction } from "./TaskBoard";
import { workArea, isTaskRecord, taskStage, taskStages, workflowKey, workWorkflowKey, usesLifecycleBoard, workflowBoardStage, workflowBoardLanes, type WorkArea } from "./task-board";
import { MockupLibrary } from "@/features/mockups/MockupLibrary";
import { LifecyclePanel } from "./LifecyclePanel";
import { ResourceLibrary } from "./ResourceLibrary";
import { ProjectResourcePicker } from "./ProjectResourcePicker";
import { isLifecycleV2 } from "./lifecycle-v2";
import { JournalWidget } from "@/features/journal/JournalPage";
import { ShdocView } from "@/features/documents/ShdocView";
import { MockupReview } from "@/features/mockups/MockupReview";
import { GoalPanel } from "./GoalPanel";
import { GOAL_WORKFLOW, type GoalBatchItem } from "./goals";
import { DiagnosticsBanner } from "./DiagnosticsBanner";
import { WorkCreationDialog } from "./WorkCreationDialog";
import { ProjectWorkOverview } from "./ProjectWorkOverview";
import { creationWorkflow, projectWorkflowRefs, workflowIntake } from "./workflow-creation";
import { IntentFlowPanel } from "./IntentFlowPanel";
import { WorkCopilot } from "./WorkCopilot";
import { INTENT_WORKFLOW } from "./intent";
import {
  ChecklistWidget,
  JobsWidget,
  ReadingWidget,
  ScheduledTasksWidget,
  TodayActivity,
} from "@/features/dashboard/FeatureWidgets";
import OnboardingPage from "@/pages/OnboardingPage";
import { BrowseButton } from "@/components/ui/path-input";
import { Select } from "@/components/ui/select";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  AlertCircle,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUpNarrowWide,
  Bot,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  Eye,
  FilePenLine,
  FileText,
  Flag,
  Columns3,
  Github,
  Folder,
  FolderPlus,
  List,
  SquareCheck,
  X,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  StopCircle,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useContextMenu } from "@/components/ui/context-menu";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { api as vaultApi } from "@/lib/api";
import { workActions } from "./lifecycle";
import { sddApi, workflowApi, type HtmlDocumentView } from "./api";
import { useProjectScope } from "./project-scope";
import { latestWorkflowVersions, workflowChoices } from "./workflow-version";
import {
  acceptWorkspaceSnapshot,
  ensureWorkspaceSnapshot,
  refreshWorkspaceSnapshot,
  useWorkspaceSnapshot,
  watchWorkspaceSnapshot,
} from "./snapshot-store";
import { DashboardBoard } from "@/features/dashboard/DashboardBoard";
import type { DashboardWidgetId } from "@/features/dashboard/registry";
import {
  METRIC_BY_KEY,
  METRIC_PREFIX,
  isMetricWidgetId,
  type MetricKey,
} from "@/features/dashboard/metrics";
import {
  ARTIFACTS,
  ARTIFACT_LABELS,
  EXECUTION_TYPES,
  ISSUE_TYPES,
  PRIORITY_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUS_LABELS,
  isClosedStatus,
  type AgentRole,
  type ArtifactKind,
  type CalendarEvent,
  type Document,
  type ExecutionType,
  type HarnessRun,
  type IssueMigrationItem,
  type IssueType,
  type Priority,
  type Project,
  type SearchHit,
  type Stage,
  type WorkbenchView,
  type WorkItem,
  type WorkStatus,
  type WorkspaceSnapshot,
  type WorkflowDefinition,
  type WorkflowEventRecord,
  type WorkflowInstance,
} from "./types";
import { MarkdownView } from "@/pages/common";
import "./workbench.css";
import "./document-search.css";
import "./work-view.css";
import "./dashboard.css";
type Notice = {
  tone: "error" | "success";
  text: string;
} | null;
type AgendaEntry =
  | {
      date: string;
      title: string;
      event: CalendarEvent;
    }
  | {
      date: string;
      title: string;
      workId: string;
    };
/** Harness run statuses that are not finished yet. Duplicate-run detection and status refresh read the same list. */
const ACTIVE_RUN_STATUS = ["starting", "running", "blocked", "unknown"];
const ATTENTION_RUN_STATUS = ["failed", "stopped", "blocked", "unknown"];
function attentionRuns(runs: HarnessRun[], work: WorkItem[]) {
  const latest = new Map<string, HarnessRun>();
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = `${run.workId}:${run.role}`;
    if (!latest.has(key)) latest.set(key, run);
  }
  return [...latest.values()].filter((run) => ATTENTION_RUN_STATUS.includes(run.status)
    && !run.dismissedAt
    && !work.some((item) => item.id === run.workId && isClosedStatus(item.status)));
}


const AGENT_ROLES: AgentRole[] = [
  "research",
  "planner",
  "implementer",
  "verifier",
  "reviewer",
];
const EVENT_KINDS = ["milestone", "review", "release", "meeting"] as const;
const ISSUE_TYPE_KEYS: Record<IssueType, string> = {
  "버그": "bug",
  "리팩토링": "refactor",
  "기능": "feature",
  "작업": "task",
  "질문": "question",
};
const EXECUTION_TYPE_KEYS: Record<ExecutionType, string> = {
  "코드": "code",
  "문서": "document",
  "조사": "research",
  "협의": "discussion",
  "결정": "decision",
};
const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};
/**
 * Sort axes shared by the work list and the flow board. Values are the direction from when each axis was first chosen;
 * each axis has a different human expectation — due date is soonest-first, updated is most-recent-first.
 */
const WORK_SORTS: Record<string, "asc" | "desc"> = {
  priority: "asc",
  id: "asc",
  due: "asc",
  updated: "desc",
  title: "asc",
};
type WorkSort = { key: string; direction: "asc" | "desc" };
const WORK_SORT_KEY = "sawhorse.work-sort";
function readWorkSort(): WorkSort {
  try {
    const [key, direction] = (localStorage.getItem(WORK_SORT_KEY) ?? "").split(":");
    if (key && key in WORK_SORTS)
      return { key, direction: direction === "desc" ? "desc" : "asc" };
  } catch { /* Optional preference. */ }
  return { key: "priority", direction: WORK_SORTS.priority };
}
/**
 * Sort comparator. IDs compare their numeric fragments as numbers so `ISS-9` comes before `ISS-10` —
 * issue numbers read in numeric order, not string order. Whatever the axis, ties stay grouped by
 * ID ascending so the list and the board keep the same order.
 */
function workComparator({ key, direction }: WorkSort) {
  const text = new Intl.Collator(i18n.language, { numeric: true, sensitivity: "base" });
  const byId = (a: WorkItem, b: WorkItem) => text.compare(a.id, b.id);
  const axis: Record<string, (a: WorkItem, b: WorkItem) => number> = {
    priority: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    id: byId,
    due: (a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""),
    updated: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
    title: (a, b) => text.compare(a.title, b.title),
  };
  const compare = axis[key] ?? axis.priority;
  return (a: WorkItem, b: WorkItem) => {
    // Items without a due date go last regardless of direction. Empty values must not take the top spot.
    if (key === "due" && !a.dueDate !== !b.dueDate) return a.dueDate ? -1 : 1;
    const primary = compare(a, b);
    return (direction === "desc" ? -primary : primary) || byId(a, b);
  };
}
const dateText = () => new Intl.DateTimeFormat(i18n.language, {
  month: "short",
  day: "numeric",
});
const dateTimeText = () => new Intl.DateTimeFormat(i18n.language, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function isoToday() {
  return localDate();
}
function plusDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return localDate(next);
}
function daysUntil(date: string) {
  const target = new Date(`${date}T00:00:00`);
  const today = new Date(`${isoToday()}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
function dueChip(days: number) {
  if (days < 0) return `D+${-days}`;
  if (days === 0) return i18n.t("workbench:common.today");
  return `D-${days}`;
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
/** Last segment of a path. Trailing separators are stripped before looking. */
function pathBasename(path: string) {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}
function blankWork(): WorkItem {
  const now = new Date().toISOString();
  return {
    id: "",
    title: "",
    description: "",
    projectId: "",
    stage: "plan",
    status: "backlog",
    priority: "normal",
    owner: "",
    startDate: null,
    dueDate: null,
    dependsOn: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
    decisions: [],
    artifacts: [],
    workflowId: "",
    workflowVersion: "",
    workflowDigest: "",
    workflowInstanceId: null,
    activeNodes: [],
    issueType: "작업",
    executionType: "코드",
    labels: [],
    assignees: [],
    milestone: "",
    approvalRequired: false,
    approve: false,
    approved: "",
    state: "open",
    closed: "",
    githubRepo: "",
    githubNumber: "",
    githubUrl: "",
    githubState: "",
    githubUpdated: "",
  };
}
function blankProject(defaultAgent: string): Project {
  return {
    id: "",
    name: "",
    description: "",
    repoPath: "",
    extraPaths: [],
    githubRepos: [],
    dependsOn: [],
    verifyCommands: [],
    defaultAgent,
    defaultModel: "",
    workflowId: "intent-flow",
    workflowVersion: "2.0.0",
    workflowDigest: "",
  };
}
function blankEvent(): CalendarEvent {
  return {
    id: "",
    title: "",
    date: isoToday(),
    endDate: null,
    kind: "milestone",
    projectId: null,
    workId: null,
    notes: "",
  };
}
function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}
function formatDate(
  value: string | null,
  fallback = i18n.t("workbench:common.noDate"),
) {
  return value ? dateText().format(new Date(`${value}T00:00:00`)) : fallback;
}
function statusClass(status: WorkStatus) {
  return `wb-status wb-status-${status}`;
}
function workflowForWork(
  workflows: WorkflowDefinition[],
  work: Pick<WorkItem, "workflowId" | "workflowVersion" | "activeNodes">,
) {
  const active = work.activeNodes?.[0];
  return (
    workflows.find(
      (definition) =>
        definition.id === (active?.workflowId ?? work.workflowId) &&
        definition.version ===
          (active?.workflowVersion ?? work.workflowVersion),
    )
  );
}
function activeNodeForWork(work: WorkItem) {
  return work.activeNodes?.[0]?.nodeId ?? work.stage;
}
function workflowForProject(
  workflows: WorkflowDefinition[],
  project: Pick<Project, "workflowId" | "workflowVersion">,
) {
  return workflows.find(
    (definition) =>
      definition.id === project.workflowId &&
      definition.version === project.workflowVersion,
  );
}
function stageLabel(
  workflows: WorkflowDefinition[],
  stage: string,
  workflowId?: string,
  workflowVersion?: string,
) {
  if (workflowId === "intent-flow" && ["2.0.0", "2.0.1"].includes(workflowVersion ?? "")) return i18n.t(`workbench:lifecycle.stages.${stage}`);
  const selected = workflows.find(
    (definition) =>
      (!workflowId || definition.id === workflowId) &&
      (!workflowVersion || definition.version === workflowVersion) &&
      definition.nodes.some((node) => node.id === stage),
  );
  return (
    selected?.nodes.find((node) => node.id === stage)?.label ??
    stageText(stage)
  );
}
function transitionActionLabel(event: string, targetLabel: string) {
  switch (event) {
    case "approved":
      return targetLabel === "완료"
        ? i18n.t("workbench:workflow.approveAndFinish")
        : i18n.t("workbench:workflow.reviewThenNext", {
            target: targetLabel,
          });
    case "changes-requested":
    case "revise":
      return i18n.t("workbench:workflow.requestChanges");
    case "revised":
      return i18n.t("workbench:workflow.revisedTo", { target: targetLabel });
    case "rejected":
      return i18n.t("workbench:status.rejected");
    case "cancelled":
      return i18n.t("workbench:status.cancelled");
    default:
      return i18n.t("workbench:workflow.reviewThenNext", {
        target: targetLabel,
      });
  }
}
/** Default role per stage. The issue list's run-now and the detail's run launcher use the same values. */
function defaultRoleForStage(stage: Stage): AgentRole {
  return stage === "plan"
    ? "research"
    : stage === "design"
      ? "planner"
      : stage === "build"
        ? "implementer"
        : stage === "test"
          ? "verifier"
          : "reviewer";
}
/** Picks the stage-appropriate role among those the node allows. Falls back to the node's first role. */
function roleForStageNode(stage: Stage, allowedRoles: AgentRole[]): AgentRole {
  const preferred = defaultRoleForStage(stage);
  if (!allowedRoles.length) return preferred;
  return allowedRoles.includes(preferred) ? preferred : allowedRoles[0];
}
function artifactLabel(
  workflow: WorkflowDefinition | undefined,
  artifact: string,
) {
  return (
    workflow?.artifacts.find((candidate) => candidate.role === artifact)
      ?.label ?? artifactText(artifact)
  );
}
function statusText(status: WorkStatus) {
  return i18n.t(`workbench:status.${status}`, {
    defaultValue: STATUS_LABELS[status],
  });
}
function priorityText(priority: Priority) {
  return i18n.t(`workbench:priority.${priority}`, {
    defaultValue: PRIORITY_LABELS[priority],
  });
}
function stageText(stage: string) {
  return i18n.t(`workbench:stage.${stage}`, {
    defaultValue: STAGE_LABELS[stage] ?? stage,
  });
}
function artifactText(artifact: string) {
  return i18n.t(`workbench:artifact.${artifact}`, {
    defaultValue: ARTIFACT_LABELS[artifact] ?? artifact,
  });
}
function issueTypeText(value: string) {
  const key = ISSUE_TYPE_KEYS[value as IssueType];
  return i18n.t(`workbench:issueType.${key}`, { defaultValue: value });
}
function executionTypeText(value: string) {
  const key = EXECUTION_TYPE_KEYS[value as ExecutionType];
  return i18n.t(`workbench:executionType.${key}`, { defaultValue: value });
}
function roleText(role: AgentRole) {
  return i18n.t(`workbench:role.${role}`);
}
function eventKindText(kind: CalendarEvent["kind"]) {
  return i18n.t(`workbench:eventKind.${kind}`);
}
function LoadingState() {
  const { t } = useTranslation("workbench");
  return (
    <div className="wb-loading">
      <Loader2 size={20} className="wb-spin" /> {t("common.loading")}
    </div>
  );
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  const { t } = useTranslation("workbench");
  return (
    <div className="wb-empty">
      <AlertCircle size={28} />
      <strong>{t("common.loadFailed")}</strong>
      <span>{error}</span>
      <Button variant="outline" size="sm" onClick={retry}>
        <RefreshCw /> {t("common.retry")}
      </Button>
    </div>
  );
}
function EmptyState({
  icon: Icon = FileText,
  title,
  description,
  action,
}: {
  icon?: typeof FileText;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="wb-empty">
      <Icon size={30} />
      <strong>{title}</strong>
      <span>{description}</span>
      {action}
    </div>
  );
}
export function WorkbenchPage({ view }: { view: WorkbenchView }) {
  const snapshot = useWorkspaceSnapshot((state) => state.snapshot);
  const loading = useWorkspaceSnapshot((state) => state.loading);
  const error = useWorkspaceSnapshot((state) => state.error);
  const { t } = useTranslation("workbench");
  // A new project draft's default agent follows the app settings' default agent.
  const defaultAgent = useApp((s) => s.defaultAgent);
  // Notices surface as a top-of-screen toast — it does not push the page layout around.
  const setNotice = useCallback((next: Notice) => {
    if (next) toast(next);
  }, []);
  const [workModal, setWorkModal] = useState<WorkItem | null | undefined>(
    undefined,
  );
  const [projectModal, setProjectModal] = useState<Project | null | undefined>(
    undefined,
  );
  const [eventModal, setEventModal] = useState<
    CalendarEvent | null | undefined
  >(undefined);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] =
    useState<ArtifactKind>("intent");
  const [revealText, setRevealText] = useState<string | null>(null);
  const reload = useCallback(async () => {
    await refreshWorkspaceSnapshot();
  }, []);
  useEffect(() => {
    void ensureWorkspaceSnapshot();
    return watchWorkspaceSnapshot();
  }, []);
  // Background project analysis finished. Re-read the snapshot and report the result via a toast.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ projectId: string; ok: boolean; error: string | null }>(
      "project-analyzed",
      (event) => {
        if (event.payload.ok) {
          void reload();
          setNotice({ tone: "success", text: t("toast.projectAnalyzed") });
        } else {
          setNotice({
            tone: "error",
            text: t("toast.projectAnalyzeFailed", {
              error: event.payload.error ?? "",
            }),
          });
        }
      },
    )
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload, setNotice, t]);
  const allWork = snapshot?.work ?? [];
  const selectedProjectId = useProjectScope((state) => state.projectId);
  const selectProject = useProjectScope((state) => state.selectProject);
  const selectedProject = snapshot?.projects.find((project) => project.id === selectedProjectId);
  const globalView = view === "overview" || view === "calendar";
  const scopeId = globalView ? "" : selectedProject?.id ?? "";
  const work = scopeId ? allWork.filter((item) => item.projectId === scopeId) : allWork;
  const events = scopeId ? (snapshot?.events ?? []).filter((event) =>
    event.projectId === scopeId || (!!event.workId && work.some((item) => item.id === event.workId))) : snapshot?.events ?? [];
  useEffect(() => {
    if (snapshot && selectedProjectId && !selectedProject) selectProject("");
  }, [snapshot, selectedProjectId, selectedProject, selectProject]);
  const projects = snapshot?.projects ?? [];
  const workflows = snapshot?.workflows ?? [];
  const selectDocument = (
    workId: string,
    artifact?: ArtifactKind,
    snippet: string | null = null,
  ) => {
    const item = allWork.find((candidate) => candidate.id === workId);
    const definition = item ? workflowForWork(workflows, item) : undefined;
    if (item && projects.some((project) => project.id === item.projectId)) selectProject(item.projectId);
    setSelectedWorkId(workId);
    setSelectedArtifact(artifact ?? (item?.workflowId === "mockup-review" ? "mockup" : definition?.artifacts[0]?.role ?? "intent"));
    setRevealText(snippet);
  };
  const afterSave = async (text: string) => {
    await reload();
    setNotice({ tone: "success", text });
  };
  // Detail-open request raised from outside the workbench, like the command palette. Open and clear it once the snapshot is ready.
  const openWorkRequest = useApp((s) => s.openWorkRequest);
  const clearOpenWork = useApp((s) => s.clearOpenWork);
  // selectDocument is re-created every render; pin the latest one so this effect
  // re-runs only when the request, the snapshot, or the work list changes.
  const selectDocumentRef = useRef(selectDocument);
  useEffect(() => {
    selectDocumentRef.current = selectDocument;
  });
  useEffect(() => {
    if (!openWorkRequest || !snapshot) return;
    if (allWork.some((item) => item.id === openWorkRequest.workId)) {
      selectDocumentRef.current(
        openWorkRequest.workId,
        openWorkRequest.artifact,
        openWorkRequest.snippet ?? null,
      );
      // Clear only when consumed, so an unmatched request can land after the next reload.
      clearOpenWork();
    }
  }, [openWorkRequest, snapshot, allWork, clearOpenWork]);
  if (loading && !snapshot)
    return (
      <div className="wb-page">
        <LoadingState />
      </div>
    );
  if (error && !snapshot)
    return (
      <div className="wb-page">
        <ErrorState error={error} retry={() => void reload()} />
      </div>
    );
  if (!snapshot) return null;
  if (!snapshot.initialized)
    return (
      <InitializeView
        onInitialized={(next) => {
          acceptWorkspaceSnapshot(next);
          setNotice({ tone: "success", text: t("toast.workspaceReady") });
        }}
      />
    );
  const currentWork = selectedWorkId
    ? (allWork.find((item) => item.id === selectedWorkId) ?? null)
    : null;
  const shared = {
    snapshot,
    work,
    projects,
    workflows,
    events,
    project: globalView ? undefined : selectedProject,
    setNotice,
    reload,
    onNewWork: () => setWorkModal({ ...blankWork(), projectId: scopeId }),
    onSelectWork: selectDocument,
    onEditWork: (item: WorkItem) => setWorkModal(item),
  };
  return (
    <div className={cx("wb-page", view === "overview" && "wb-overview-page", ["work", "board", "issues"].includes(view) && "wb-work-page")}>
      {error && (
        <div className="wb-inline-error" role="alert">
          {error}
        </div>
      )}
      {snapshot.diagnostics.length > 0 && (
        <DiagnosticsBanner
          diagnostics={snapshot.diagnostics}
          reload={reload}
          setNotice={setNotice}
        />
      )}
      {selectedProject && view === "harness" && (
        <div className="wb-project-scope">
          <span>{t("scope.defaultWorkflow", { workflow: workflowForProject(workflows, selectedProject)?.label ?? selectedProject.workflowId })}</span>
        </div>
      )}
      {view === "overview" && <OverviewView work={allWork} projects={projects} workflows={workflows} events={snapshot.events}
        onSelectWork={(id) => {
          const item = allWork.find((entry) => entry.id === id);
          if (item) selectProject(projects.some((entry) => entry.id === item.projectId) ? item.projectId : "");
          useApp.getState().openWork({ workId: id });
          useApp.getState().setPage("work");
        }} /> }
      {["work", "board", "issues"].includes(view) && !selectedProject && <ProjectWorkOverview
        projects={projects} work={allWork} workflows={workflows} onProject={selectProject}
        onWork={selectDocument} onNewProject={() => setProjectModal(null)}
      />}
      {["work", "board", "issues"].includes(view) && selectedProject && (
        <WorkView
          key={scopeId}
          work={work}
          projects={projects}
          project={selectedProject}
          onProjectSettings={() => setProjectModal(selectedProject)}
          workflows={workflows}
          events={events}
          reload={reload}
          setNotice={setNotice}
          onNewWork={(seed) => setWorkModal(seed ?? { ...blankWork(), projectId: scopeId })}
          onSelectWork={selectDocument}
          onNewMilestone={() =>
            setEventModal({ ...blankEvent(), kind: "milestone", projectId: scopeId || null })
          }
        />
      )}
      {view === "calendar" && (
        <CalendarView
          key={scopeId}
          {...shared}
          onNewEvent={() => setEventModal({ ...blankEvent(), projectId: scopeId || null })}
          onEditEvent={(event) => setEventModal(event)}
        />
      )}
      {view === "harness" && (
        <HarnessView
          key={scopeId}
          projectId={scopeId}
          work={work}
          projects={projects}
          workflows={workflows}
          onNotice={setNotice}
          onSelectWork={selectDocument}
        />
      )}
      {view === "knowledge" && (
        <KnowledgeView
          key={scopeId}
          project={selectedProject}
          work={work}
          projects={selectedProject ? [selectedProject] : projects}
          onSelectWork={selectDocument}
          onJump={selectDocument}
          onNotice={setNotice}
        />
      )}
      {view === "project-library" && <ResourceLibrary projects={projects} />}
      {view === "projects" && (
        <ProjectsView
          projects={projects}
          work={allWork}
          workflows={workflows}
          onReload={reload}
          onNotice={setNotice}
          onNew={() => setProjectModal(null)}
          onEdit={(project) => setProjectModal(project)}
        />
      )}
      {projectModal !== undefined && <ProjectFormDialog
        open
        initial={projectModal ?? blankProject(defaultAgent)}
        projects={projects}
        workflows={workflows}
        onClose={() => setProjectModal(undefined)}
        onSaved={() => {
          setProjectModal(undefined);
          void afterSave(t("toast.projectSaved"));
        }}
      />}
      <EventFormDialog
        open={eventModal !== undefined}
        initial={eventModal ?? blankEvent()}
        projects={projects}
        work={allWork}
        onClose={() => setEventModal(undefined)}
        onSaved={() => {
          setEventModal(undefined);
          void afterSave(t("toast.eventSaved"));
        }}
        onDeleted={() => {
          setEventModal(undefined);
          void afterSave(t("toast.eventDeleted"));
        }}
      />
      <WorkDetailDialog
        work={currentWork}
        projects={projects}
        workflow={
          currentWork ? workflowForWork(workflows, currentWork) : undefined
        }
        selectedArtifact={selectedArtifact}
        revealText={revealText}
        onClose={() => setSelectedWorkId(null)}
        onArtifact={setSelectedArtifact}
        onReload={reload}
        onNotice={setNotice}
        onEdit={() => currentWork && setWorkModal(currentWork)}
        onFollowUp={() =>
          currentWork &&
          setWorkModal({
            ...blankWork(),
            title: t("work.followUpTitle", { title: currentWork.title }),
            projectId: currentWork.projectId,
            // Operational observation is not a stage but input to the next item. Making it a
            // stage would leave the item open, so it is wired as a link between items.
            dependsOn: [currentWork.id],
            description: t("work.followUpDescription", {
              title: currentWork.title,
              id: currentWork.id,
            }),
          })
        }
      />
      {workModal !== undefined && !workModal?.id && <WorkCreationDialog
        initial={workModal ?? { ...blankWork(), projectId: scopeId }}
        workflows={workflows}
        projects={projects}
        onClose={() => { setWorkModal(undefined); void reload(); }}
        onSaved={(item, artifact) => {
          selectProject(item.projectId);
          setWorkModal(undefined); setSelectedWorkId(item.id); setSelectedArtifact(artifact ?? workflowForWork(workflows, item)?.artifacts[0]?.role ?? "intent");
          void afterSave(t("toast.workSaved"));
        }}
      />}
      <WorkFormDialog
        open={!!workModal?.id}
        initial={workModal ?? { ...blankWork(), projectId: scopeId }}
        projects={projects}
        work={allWork}
        events={snapshot.events}
        onClose={() => setWorkModal(undefined)}
        onSaved={(item) => {
          setWorkModal(undefined);
          selectDocument(item.id);
          void afterSave(
            item.id ? t("toast.workSaved") : t("toast.workCreated"),
          );
        }}
      />
    </div>
  );
}
export default WorkbenchPage;
function InitializeView({
  onInitialized,
}: {
  onInitialized: (snapshot: WorkspaceSnapshot) => void;
}) {
  const { t } = useTranslation("workbench");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialize = async () => {
    setBusy(true);
    setError(null);
    try {
      onInitialized(await sddApi.initialize());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wb-page wb-initialize">
      <div className="wb-initialize-card">
        <div className="wb-orb">
          <LayoutDashboard size={26} />
        </div>
        <h1>
          {t("init.title1")}
          <br />
          {t("init.title2")}
        </h1>
        <p>{t("init.description")}</p>
        {error && <div className="wb-inline-error">{error}</div>}
        <Button onClick={() => void initialize()} disabled={busy}>
          {busy ? <Loader2 className="wb-spin" /> : <Plus />}{" "}
          {t("init.submit")}
        </Button>
      </div>
    </div>
  );
}
function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="wb-header">
      <div>
        <h1>{title}</h1>
      </div>
      {children && <div className="wb-header-actions">{children}</div>}
    </header>
  );
}
function OverviewView({ work, projects, workflows, events, onSelectWork }: {
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  events: CalendarEvent[];
  onSelectWork: (id: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const setPage = useApp((s) => s.setPage);
  const jobs = useApp((s) => s.jobs);
  const selectProject = useProjectScope((state) => state.selectProject);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => sddApi.runs().then((next) => {
      if (alive) { setRuns(next); setRunsError(null); }
    }).catch((error) => { if (alive) setRunsError(errorText(error)); });
    void load();
    const timer = window.setInterval(load, 8000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const openProject = (id: string) => { selectProject(id); setPage("work"); };
  const projectName = (id: string) => projects.find((entry) => entry.id === id)?.name ?? t("row.noProject");
  const today = isoToday();
  // Ingredients the metric widgets count. Every card sees the same snapshot regardless of which cards are enabled.
  const metricSource = { work, jobs, runs, today };
  const open = work.filter((w) => !isClosedStatus(w.status));
  const next = [...open]
    .sort(
      (a, b) =>
        (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority],
    )
    .slice(0, 8);
  const due = open
    .filter((w) => w.dueDate && w.dueDate <= plusDays(today, 7))
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const done = work
    .filter((w) => w.status === "done")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 8);
  const upcoming = events
    .filter((e) => (e.endDate ?? e.date) >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 8);
  const link = (page: string, label: string) => (
    <button className="wb-panel-link" aria-label={label} title={label} onClick={() => setPage(page)}>
      <span>{label}</span><ArrowRight size={13} aria-hidden />
    </button>
  );
  function renderWidget(id: DashboardWidgetId) {
    // Each metric is one widget per card. Rendered from the definition alone, so no branching accumulates here.
    if (isMetricWidgetId(id)) {
      const metric = METRIC_BY_KEY[id.slice(METRIC_PREFIX.length) as MetricKey];
      const value = metric.count(metricSource);
      return (
        <Metric
          solo
          label={t(`dashboard:metrics.${metric.key}.label`)}
          value={value}
          hint={t(`dashboard:metrics.${metric.key}.hint`)}
          icon={<metric.icon />}
          warn={metric.warnWhenPositive === true && value > 0}
        />
      );
    }
    switch (id) {
      case "today":
        return (
          <SlotCard
            title={t("widgets.today")}
            description={today}
            action={link("calendar", t("widgets.openCalendar"))}
          >
            <TodayActivity
              projects={projects}
              runs={runs}
              events={events}
              work={work}
              onOpenWork={onSelectWork}
              onOpenEvent={() => setPage("calendar")}
              onOpenJobs={() => setPage("jobs")}
            />
          </SlotCard>
        );
      case "next":
        return (
          <SlotCard
            title={t("widgets.next")}
            count={next.length}
            description={t("widgets.nextDesc")}
          >
            {next.length ? (
              next.map((item) => (
                <WorkRow
                  key={item.id}
                  item={item}
                  project={projects.find((p) => p.id === item.projectId)}
                  onClick={() => onSelectWork(item.id)}
                />
              ))
            ) : (
              <div className="wb-slot-empty">
                {t("widgets.nextEmpty")}
              </div>
            )}
          </SlotCard>
        );
      case "projects":
        return <SlotCard title={t("scope.projectsTitle")} count={projects.length} action={link("projects", t("overview.manageProjects"))}>
          {projects.map((entry) => {
            const items = work.filter((item) => item.projectId === entry.id);
            const count = (status: string) => items.filter((item) => item.status === status).length;
            return <button className="wb-project-summary wb-overview-project" key={entry.id} onClick={() => openProject(entry.id)}>
              <span className="wb-project-initial" aria-hidden>{entry.name.slice(0, 1).toUpperCase()}</span>
              <span className="wb-project-info">
                <strong>{entry.name}</strong>
                <span>{t("scope.projectCounts", { running: count("running"), review: count("review"), blocked: count("blocked") })}</span>
              </span>
              <ArrowRight size={14} aria-hidden />
            </button>;
          })}
          {!projects.length && <div className="wb-slot-empty">{t("projects.emptyTitle")}</div>}
        </SlotCard>;
      case "documents":
        return <SlotCard title={t("scope.documentsTitle")} action={link("docs", t("scope.searchDocuments"))}>
          {work.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8).map((item) => {
            const definition = workflowForWork(workflows, item);
            return <button key={item.id} className="wb-project-summary" onClick={() => onSelectWork(item.id)}>
              <strong>{item.title}</strong>
              <span>{definition?.artifacts.map((artifact) => artifact.label === artifact.role ? artifactText(artifact.role) : artifact.label).join(" · ")}</span>
              <FileText size={14} />
            </button>;
          })}
          {!work.length && <div className="wb-slot-empty">{t("widgets.nextEmpty")}</div>}
        </SlotCard>;
      case "due":
        return (
          <SlotCard
            title={t("widgets.due")}
            count={due.length}
            description={t("widgets.dueDesc")}
          >
            {due.length ? (
              due.map((item) => (
                <DueRow
                  key={item.id}
                  item={item}
                  projectName={projectName(item.projectId)}
                  onClick={() => onSelectWork(item.id)}
                />
              ))
            ) : (
              <div className="wb-slot-empty">
                {t("widgets.dueEmpty")}
              </div>
            )}
          </SlotCard>
        );
      case "events":
        return (
          <SlotCard
            title={t("widgets.events")}
            count={upcoming.length}
            action={link("calendar", t("widgets.openCalendar"))}
          >
            {upcoming.length ? (
              upcoming.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  projectName={event.projectId ? projectName(event.projectId) : undefined}
                  onClick={() => setPage("calendar")}
                />
              ))
            ) : (
              <div className="wb-slot-empty">{t("widgets.eventsEmpty")}</div>
            )}
          </SlotCard>
        );
      case "done":
        return (
          <SlotCard title={t("widgets.done")} count={done.length}>
            {done.length ? (
              done.map((item) => (
                <DoneRow
                  key={item.id}
                  item={item}
                  onClick={() => onSelectWork(item.id)}
                />
              ))
            ) : (
              <div className="wb-slot-empty">
                {t("widgets.doneEmpty")}
              </div>
            )}
          </SlotCard>
        );
      case "jobs":
        return (
          <SlotCard
            title={t("widgets.jobs")}
            description={t("overview.runsHint")}
          >
            <JobsWidget runs={runs} work={work} projects={projects} onOpen={() => setPage("jobs")} />

          </SlotCard>
        );
      case "schedules":
        return (
          <SlotCard
            title={t("widgets.schedules")}
            action={link("tasks", t("widgets.openTasks"))}
          >
            <ScheduledTasksWidget />
          </SlotCard>
        );
      case "journal":
        return <SlotCard title={i18n.t("journal:title")}><JournalWidget /></SlotCard>;
      case "checklist":
        return (
          <SlotCard
            title={t("widgets.checklist")}
            action={link("todos", t("widgets.openTodos"))}
          >
            <ChecklistWidget onOpen={() => setPage("todos")} />
          </SlotCard>
        );
      case "reading":
        return (
          <SlotCard
            title={t("widgets.reading")}
            action={link("reading", t("widgets.openReading"))}
          >
            <ReadingWidget onOpen={() => setPage("reading")} />
          </SlotCard>
        );

    }
  }
  return (
    <>
      <header className="wb-header wb-overview-header">
        <div>
          <time className="wb-overview-date" dateTime={today}>{new Intl.DateTimeFormat(i18n.language, { month: "long", day: "numeric", weekday: "long" }).format(new Date(`${today}T12:00:00`))}</time>
          <div className="wb-dashboard-title"><h1>{t("overview.title")}</h1><span>{t("scope.all")}</span></div>
          <p>{t("overview.description")}</p>
        </div>
        <div className="wb-header-actions">
          <Button size="sm" variant="ghost" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            <SlidersHorizontal />
            {editing ? t("overview.layoutDone") : t("overview.layoutEdit")}
          </Button>
          <Button onClick={() => setCatalogOpen(true)}><Plus />{t("overview.addWidgets")}</Button>
        </div>
      </header>
      {runsError && <div className="wb-inline-error" role="alert">{runsError}</div>}
      <div className="wb-overview-tools">
        <span>{t("overview.workspaceSummary")}</span>
        <span>{t("overview.scopeHint")}</span>
      </div>
      <DashboardBoard
        editing={editing}
        catalogOpen={catalogOpen}
        onCatalogClose={() => setCatalogOpen(false)}
        renderWidget={renderWidget}
      />
    </>
  );
}
function SlotCard({
  title,
  count,
  description,
  action,
  children,
}: {
  title: string;
  count?: number;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="wb-panel wb-slot-panel" aria-label={title}>
      <header className="wb-panel-title">
        <div className="wb-widget-heading">
          <div className="wb-widget-title"><h2>{title}</h2>{count != null && <span className="wb-widget-count">{count}</span>}</div>
          {description && <p className="wb-widget-description" title={description}>{description}</p>}
        </div>
        {action}
      </header>
      <div className="wb-slot-content" tabIndex={0} role="group" aria-label={title}>{children}</div>
    </section>
  );
}
function DueRow({ item, projectName, onClick }: { item: WorkItem; projectName?: string; onClick: () => void }) {
  const days = item.dueDate ? daysUntil(item.dueDate) : 0;
  return <button className="wb-dense-row wb-due-row" onClick={onClick} title={item.title}>
    <span className={cx("wb-date-chip", days < 0 && "is-overdue")}>{dueChip(days)}</span>
    <span className="wb-due-copy"><span className="wb-dense-title">{item.title}</span><span className="wb-dense-meta">{projectName && <>{projectName} · </>}<time dateTime={item.dueDate ?? undefined}>{formatDate(item.dueDate)}</time></span></span>
    <ArrowRight size={13} aria-hidden />
  </button>;
}
function EventRow({
  event,
  projectName,
  onClick,
}: {
  event: CalendarEvent;
  projectName?: string;
  onClick: () => void;
}) {
  const date = new Date(`${event.date}T12:00:00`);
  return (
    <button className="wb-dense-row wb-agenda-row" onClick={onClick} title={event.title}>
      <time className="wb-agenda-date" dateTime={event.date} aria-label={formatDate(event.date)}>
        <span>{date.toLocaleDateString(i18n.language, { month: "short" })}</span><strong>{date.getDate()}</strong>
      </time>
      <span className="wb-agenda-copy"><span className="wb-dense-title">{event.title}</span><span className="wb-dense-meta">{projectName && `${projectName} · `}{eventKindText(event.kind)}{event.endDate && event.endDate !== event.date ? ` · ${formatDate(event.date)} – ${formatDate(event.endDate)}` : ""}</span></span>
      <ArrowRight size={13} aria-hidden />
    </button>
  );
}
function DoneRow({ item, onClick }: { item: WorkItem; onClick: () => void }) {
  return (
    <button className="wb-dense-row" onClick={onClick} title={item.title}>
      <CircleCheck size={14} className="wb-done-check" />
      <span className="wb-dense-title">{item.title}</span>
      <span className="wb-dense-meta">
        {formatDate(item.updatedAt.slice(0, 10))}
      </span>
    </button>
  );
}
function Metric({
  label,
  value,
  hint,
  icon,
  warn,
  solo,
  onClick,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  warn?: boolean;
  /** When a single card fills an entire widget cell on the dashboard. */
  solo?: boolean;
  onClick?: () => void;
}) {
  const shell = cx("wb-metric", solo && "is-solo", warn && "is-warn");
  const body = (
    <>
      <div className="wb-metric-top"><span>{label}</span><div className="wb-metric-icon" aria-hidden>{icon}</div></div>
      <strong>{value}</strong>
      <small>{hint}</small>
    </>
  );
  if (!onClick) return <div className={shell}>{body}</div>;
  return (
    <button
      type="button"
      className={cx(shell, "is-clickable")}
      title={hint}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
function WorkRow({ item, project, onClick }: { item: WorkItem; project?: Project; onClick: () => void }) {
  const { t } = useTranslation("workbench");
  return <button className="wb-work-row" onClick={onClick} title={item.title}>
    <span className="wb-work-main"><span className="wb-work-state" data-status={item.status} aria-hidden />
      <span><strong>{item.title}</strong><small>{project?.name ?? t("row.noProject")} · {statusText(item.status)}</small></span>
    </span>
    {item.dueDate && <time className="wb-dense-meta" dateTime={item.dueDate}>{formatDate(item.dueDate)}</time>}
    <ArrowRight size={13} aria-hidden />
  </button>;
}
function CalendarView({
  work,
  project,
  projects,
  events,
  onNewEvent,
  onEditEvent,
  onSelectWork,
}: {
  work: WorkItem[];
  project?: Project;
  projects: Project[];
  events: CalendarEvent[];
  onNewEvent: () => void;
  onEditEvent: (event: CalendarEvent) => void;
  onSelectWork: (id: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const setPage = useApp((s) => s.setPage);
  const [cursor, setCursor] = useState(() => new Date());
  const [agenda, setAgenda] = useState(false);
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  const derived = work
    .filter((item) => item.dueDate)
    .map((item) => ({
      date: item.dueDate!,
      title: item.title,
      workId: item.id,
    }));
  const agendaItems: AgendaEntry[] = [
    ...events.map((event) => ({ date: event.date, title: event.title, event })),
    ...derived,
  ].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <>
      <PageHeader title={t("calendar.title")}>
        <div className="wb-segment">
          <button
            className={!agenda ? "active" : ""}
            onClick={() => setAgenda(false)}
          >
            {t("calendar.monthTab")}
          </button>
          <button
            className={agenda ? "active" : ""}
            onClick={() => setAgenda(true)}
          >
            {t("calendar.agendaTab")}
          </button>
        </div>
        <Button onClick={onNewEvent}>
          <Plus /> {t("calendar.addEvent")}
        </Button>
      </PageHeader>
      {agenda ? (
        <div className="wb-panel wb-agenda">
          {agendaItems.length ? (
            agendaItems.map((entry, index) => {
              const isEvent = "event" in entry;
              return (
                <button
                  key={`${entry.date}-${entry.title}-${index}`}
                  className="wb-agenda-row"
                  onClick={() =>
                    isEvent
                      ? onEditEvent(entry.event)
                      : onSelectWork(entry.workId)
                  }
                >
                  <time>{formatDate(entry.date)}</time>
                  <span
                    className={
                      isEvent
                        ? `wb-event-dot is-${entry.event.kind}`
                        : "wb-event-dot is-due"
                    }
                  />
                  <div>
                    <strong>{entry.title}</strong>
                    <small>
                      {isEvent
                        ? eventKindText(entry.event.kind)
                        : t("calendar.workDue")}
                      {isEvent && entry.event.projectId
                        ? ` · ${
                            projects.find(
                              (p) => p.id === entry.event.projectId,
                            )?.name ?? t("calendar.projectFallback")
                          }`
                        : ""}
                    </small>
                  </div>
                  <ChevronRight size={16} />
                </button>
              );
            })
          ) : (
            <EmptyState
              icon={CalendarDays}
              title={t("calendar.emptyTitle")}
              description={t("calendar.emptyDescription")}
              action={
                <Button size="sm" onClick={onNewEvent}>
                  <Plus /> {t("calendar.addEvent")}
                </Button>
              }
            />
          )}
        </div>
      ) : (
        <div className="wb-calendar">
          <TodayActivity
            compact
            project={project}
            events={events}
            work={work}
            onOpenWork={onSelectWork}
            onOpenEvent={onEditEvent}
            onOpenJobs={() => setPage("jobs")}
          />
          <div className="wb-calendar-toolbar">
            <div>
              <button
                className="wb-icon-button"
                onClick={() => setCursor(new Date(year, month - 1, 1))}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="wb-icon-button"
                onClick={() => setCursor(new Date(year, month + 1, 1))}
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <strong>
              {t("calendar.monthTitle", { year, month: month + 1 })}
            </strong>
            <button className="wb-today" onClick={() => setCursor(new Date())}>
              {t("common.today")}
            </button>
          </div>
          <div className="wb-calendar-week">
            {(
              ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
            ).map((day) => (
              <span key={day}>{t(`weekday.${day}`)}</span>
            ))}
          </div>
          <div className="wb-calendar-grid">
            {days.map((day) => {
              const key = localDate(day);
              const dayEvents = events.filter(
                (event) =>
                  event.date <= key && (event.endDate ?? event.date) >= key,
              );
              const dayDue = derived.filter((item) => item.date === key);
              const today = key === isoToday();
              return (
                <div
                  key={key}
                  className={cx(
                    "wb-day",
                    day.getMonth() !== month && "is-outside",
                    today && "is-today",
                  )}
                >
                  <span>{day.getDate()}</span>
                  {dayEvents.slice(0, 2).map((event) => (
                    <button
                      key={event.id}
                      className={`wb-calendar-event is-${event.kind}`}
                      onClick={() => onEditEvent(event)}
                    >
                      {event.title}
                    </button>
                  ))}
                  {dayDue.slice(0, 2).map((item) => (
                    <button
                      key={item.workId}
                      className="wb-calendar-event is-due"
                      onClick={() => onSelectWork(item.workId)}
                    >
                      {item.title}
                    </button>
                  ))}
                  {dayEvents.length + dayDue.length > 2 && (
                    <small>
                      {t("calendar.moreEvents", {
                        count: dayEvents.length + dayDue.length - 2,
                      })}
                    </small>
                  )}
                  {dayEvents.length + dayDue.length > 0 && (
                    <div
                      className="wb-day-load"
                      aria-label={t("calendar.nItems", {
                        count: dayEvents.length + dayDue.length,
                      })}
                    >
                      {Array.from({
                        length: Math.min(4, dayEvents.length + dayDue.length),
                      }).map((_, index) => (
                        <span key={index} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
function SearchHighlight({ text, query }: { text: string; query: string }) {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (!query || index < 0) return <>{text}</>;
  return <>{text.slice(0, index)}<mark>{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

function KnowledgeView({ work, project, projects, onSelectWork, onJump, onNotice }: {
  work: WorkItem[];
  project?: Project;
  projects: Project[];
  onSelectWork: (id: string) => void;
  onJump: (workId: string, artifact: ArtifactKind, snippet: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const { t } = useTranslation("workbench");
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [record, setRecord] = useState<{ path: string; title: string; markdown: string } | null>(null);
  const [opening, setOpening] = useState("");
  const request = useRef(0);
  const noteRequest = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => () => { request.current++; noteRequest.current++; }, []);

  const recentWork = [...work].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const kinds = [...new Set(hits.map((hit) => hit.artifact ?? "document"))];
  const filteredHits = hits.filter((hit) => filter === "all" || (hit.artifact ?? "document") === filter);
  const kindLabel = (kind: string) => kind === "document" ? t("search.document") : artifactText(kind);
  const clear = () => {
    request.current++;
    setQuery(""); setSubmittedQuery(""); setHits([]); setFilter("all"); setBusy(false); setError("");
    input.current?.focus();
  };
  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    const term = query.trim();
    if (!term) { clear(); return; }
    const id = ++request.current;
    setBusy(true); setError(""); setSubmittedQuery(term); setFilter("all"); setHits([]);
    try {
      const documents = await sddApi.search(term);
      if (id !== request.current) return;
      setHits(project ? documents.filter((hit) => hit.workId && work.some((item) => item.id === hit.workId)) : documents);
    } catch (e) {
      if (id === request.current) setError(errorText(e));
    } finally {
      if (id === request.current) setBusy(false);
    }
  };
  const openHit = async (hit: SearchHit) => {
    if (hit.workId && hit.artifact) { onJump(hit.workId, hit.artifact, hit.snippet); return; }
    const id = ++noteRequest.current;
    setOpening(hit.path);
    setRecord({ path: hit.path, title: hit.title, markdown: "" });
    try {
      const note = await vaultApi.readVaultNote(hit.path);
      if (id === noteRequest.current) setRecord({ path: hit.path, title: hit.title, markdown: note.markdown });
    } catch (e) {
      if (id === noteRequest.current) { setRecord(null); onNotice({ tone: "error", text: errorText(e) }); }
    } finally {
      if (id === noteRequest.current) setOpening("");
    }
  };
  return (
    <section className="doc-search" aria-label={t("search.pageTitle")}>
      <header className="doc-search-header">
        <div><h1>{t("search.pageTitle")}</h1><p>{t("search.description")}</p></div>
        <span className="doc-search-scope"><Folder size={14} />{project?.name ?? t("search.allProjects")}</span>
      </header>
      <form className="doc-search-form" role="search" onSubmit={(event) => void search(event)}>
        <Search size={19} aria-hidden="true" />
        <input ref={input} value={query} onChange={(event) => { if (!event.target.value) clear(); else setQuery(event.target.value); }} aria-label={t("search.inputLabel")} placeholder={t("search.documentPlaceholder")} autoFocus />
        {query && <button type="button" className="doc-search-clear" onClick={clear} aria-label={t("search.clear")}><X size={16} /></button>}
        <Button type="submit" disabled={busy || !query.trim()}>{busy && <Loader2 size={14} className="wb-spin" />}{t("search.submit")}</Button>
      </form>
      <p className="doc-search-hint">{t(project ? "search.projectHint" : "search.scopeHint")}</p>

      {!submittedQuery && !error && <div className="doc-search-start">
        <div className="doc-search-guide"><FileText size={24} /><h2>{t("search.startTitle")}</h2><p>{t("search.startDescription")}</p></div>
        {recentWork.length > 0 && <section className="doc-search-recent" aria-label={t("search.recentWork")}>
          <div className="doc-search-section-heading"><h2>{t("search.recentWork")}</h2><span>{t("search.recentHint")}</span></div>
          <div className="doc-search-recent-list">{recentWork.map((item) => <button key={item.id} onClick={() => onSelectWork(item.id)}>
            <FileText size={17} /><span><strong>{item.title}</strong><small>{projects.find((p) => p.id === item.projectId)?.name ?? item.projectId} · {item.id}</small></span><ChevronRight size={15} />
          </button>)}</div>
        </section>}
      </div>}

      {error && <div className="doc-search-error" role="alert"><AlertCircle size={17} /><span>{error}</span><Button variant="outline" size="sm" onClick={() => void search()}>{t("search.retry")}</Button></div>}
      {submittedQuery && !error && <section className="doc-search-results" aria-label={t("search.results")} aria-busy={busy}>
        <div className="doc-search-section-heading"><h2>{t("search.results")}</h2><span role="status">{busy ? t("search.searching") : t("search.resultCount", { query: submittedQuery, count: filteredHits.length })}</span></div>
        {!busy && hits.length > 0 && <div className="doc-search-filters" role="group" aria-label={t("search.filterLabel")}>
          {["all", ...kinds].map((kind) => <button key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === "all" ? t("search.allDocuments") : kindLabel(kind)}<span>{kind === "all" ? hits.length : hits.filter((hit) => (hit.artifact ?? "document") === kind).length}</span></button>)}
        </div>}
        {busy ? <LoadingState /> : hits.length === 0 ? <div className="doc-search-empty"><EmptyState icon={Search} title={t("search.emptyTitle")} description={t("search.emptyDescription")} /><Button variant="outline" onClick={clear}>{t("search.startOver")}</Button></div> : <div className="doc-search-list">{filteredHits.map((hit, index) => {
          const item = work.find((item) => item.id === hit.workId);
          const projectName = projects.find((p) => p.id === item?.projectId)?.name;
          return <button key={`${hit.path}-${index}`} className="doc-search-hit" onClick={() => void openHit(hit)}>
            <span className="doc-search-file"><FileText size={19} /></span>
            <span className="doc-search-hit-content"><span className="doc-search-hit-meta"><span className="doc-search-kind">{kindLabel(hit.artifact ?? "document")}</span>{projectName && <span>{projectName}</span>}{item && <span>{item.id}</span>}</span>
              <strong><SearchHighlight text={hit.title} query={submittedQuery} /></strong>
              <span className="doc-search-snippet"><SearchHighlight text={hit.snippet.replace(/\s+/g, " ").trim()} query={submittedQuery} /></span>
              <small>{hit.path}</small>
            </span><ChevronRight size={17} />
          </button>;
        })}</div>}
      </section>}
      <Dialog open={record !== null} onClose={() => { noteRequest.current++; setRecord(null); setOpening(""); }} title={record?.title} wide>
        <p className="doc-search-record-path">{record?.path}</p>
        {opening ? <LoadingState /> : <MarkdownView src={record?.markdown ?? ""} notePath={record?.path} />}
      </Dialog>
    </section>
  );
}
function ProjectsView({
  projects,
  work,
  workflows,
  onNew,
  onEdit,
  onReload,
  onNotice,
}: {
  projects: Project[];
  work: WorkItem[];
  workflows: WorkflowDefinition[];
  onNew: () => void;
  onEdit: (project: Project) => void;
  onReload: () => Promise<void>;
  onNotice: (message: Notice) => void;
}) {
  const { t } = useTranslation("workbench");
  const selectProject = useProjectScope((state) => state.selectProject);
  const setPage = useApp((state) => state.setPage);
  const [resourceProject, setResourceProject] = useState<Project | null>(null);
  const [documentProject, setDocumentProject] = useState<Project | null>(null);
  const [addingSamples, setAddingSamples] = useState(false);
  const addSamples = async () => {
    setAddingSamples(true);
    try {
      const report = await sddApi.createSamples();
      await onReload();
      onNotice({ tone: "success", text: report.createdProjects.length ? t("projects.samplesAdded", { count: report.createdProjects.length }) : t("projects.samplesExist") });
    } catch (error) {
      onNotice({ tone: "error", text: errorText(error) });
    } finally {
      setAddingSamples(false);
    }
  };
  if (documentProject)
    return (
      <OnboardingPage
        project={documentProject}
        onBack={() => setDocumentProject(null)}
      />
    );
  return (
    <>
      <PageHeader title={t("projects.title")}>
        <Button variant="outline" disabled={addingSamples} onClick={() => void addSamples()}>
          {t(addingSamples ? "projects.addingSamples" : "projects.addSamples")}
        </Button>
        <Button onClick={onNew}>
          <Plus /> {t("projects.add")}
        </Button>
      </PageHeader>
      {projects.length ? (
        <div className="wb-project-grid">
          {projects.map((project) => (
            <article className="wb-project-card" key={project.id}>
              <div className="wb-project-card-top">
                <div className="wb-project-mark">
                  {project.name.slice(0, 1)}
                </div>
                <button
                  className="wb-icon-button"
                  onClick={() => onEdit(project)}
                  aria-label={t("projects.editAria")}
                >
                  <MoreHorizontal size={17} />
                </button>
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || t("projects.noDescription")}</p>
              <div className="wb-project-card-meta">
                <span>
                  {t("projects.nItems", {
                    count: work.filter((item) => item.projectId === project.id)
                      .length,
                  })}
                </span>
                <span>
                  {t("projects.nPredecessors", {
                    count: project.dependsOn.length,
                  })}
                </span>
                <span>
                  {workflowForProject(workflows, project)?.label ??
                    `${project.workflowId}@${project.workflowVersion}`}
                </span>
              </div>
              <footer className="space-y-3">
                <span className="block truncate">
                  {project.repoPath || t("projects.noRepoPath")}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => { selectProject(project.id); setPage("work"); }}>{t("scope.openWorkbench")}</Button>
                  <Button size="sm" variant="outline" onClick={() => setResourceProject(project)}>{t("resources.selectLibrary")}</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDocumentProject(project)}
                  >
                    {t("projects.createDocs")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(project)}
                  >
                    {t("projects.settings")}
                  </Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={t("projects.emptyTitle")}
          description={t("projects.emptyDescription")}
          action={
            <Button onClick={onNew}>
              <Plus /> {t("projects.add")}
            </Button>
          }
        />
      )}
      <Dialog open={!!resourceProject} onClose={() => setResourceProject(null)} title={resourceProject ? t("resources.projectSelection", { project: resourceProject.name }) : undefined}>
        {resourceProject && <ProjectResourcePicker key={resourceProject.id} projectId={resourceProject.id} />}
      </Dialog>
    </>
  );
}
/** Picks development items to put into a milestone. Membership is written in the item's `milestone` field. */
function MilestoneWorkPicker({
  work,
  selected,
  onChange,
}: {
  work: WorkItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { t } = useTranslation("workbench");
  const [query, setQuery] = useState("");
  const visible = work.filter((item) =>
    `${item.id} ${item.title}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="wb-milestone-picker">
      <div className="wb-milestone-picker-head">
        <span>{t("picker.title")}</span>
        <span>{t("picker.nSelected", { count: selected.length })}</span>
      </div>
      <Input
        aria-label={t("picker.searchAria")}
        placeholder={t("picker.searchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="wb-milestone-picker-list">
        {visible.map((item) => (
          <label key={item.id}>
            <input
              type="checkbox"
              aria-label={`${item.id} ${item.title}`}
              checked={selected.includes(item.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, item.id]
                    : selected.filter((id) => id !== item.id),
                )
              }
            />
            <span>
              <strong>{item.title}</strong>
              <small>
                {item.id} · {executionTypeText(item.executionType)}
                {item.milestone && !selected.includes(item.id)
                  ? t("picker.otherMilestone")
                  : ""}
              </small>
            </span>
          </label>
        ))}
        {visible.length === 0 && (
          <p className="wb-muted">{t("picker.empty")}</p>
        )}
      </div>
    </div>
  );
}
/** One work collection, shared filters, and the same detail actions in both views. */
function WorkView({
  work,
  projects,
  project,
  onProjectSettings,
  workflows,
  events,
  reload,
  setNotice,
  onNewWork,
  onSelectWork,
  onNewMilestone,
}: {
  work: WorkItem[];
  projects: Project[];
  project: Project;
  onProjectSettings: () => void;
  workflows: WorkflowDefinition[];
  events: CalendarEvent[];
  reload: () => Promise<void>;
  setNotice: (notice: Notice) => void;
  onNewWork: (seed?: WorkItem) => void;
  onSelectWork: (id: string) => void;
  onNewMilestone: () => void;
}) {
  const { t } = useTranslation("workbench");
  const appDefaultAgent = useApp((state) => state.defaultAgent);
  const knownAgents = useApp((state) => state.agents);
  const [display, setDisplay] = useState<"board" | "list">(() => {
    try { return localStorage.getItem("sawhorse.work-view.v2") === "list" ? "list" : "board"; }
    catch { return "board"; }
  });
  const chooseDisplay = (next: "board" | "list") => {
    setDisplay(next);
    try { localStorage.setItem("sawhorse.work-view.v2", next); } catch { /* Optional preference. */ }
  };
  // The sort is remembered together with the view. The list and the flow board line up by the same criterion.
  const [sort, setSort] = useState<WorkSort>(readWorkSort);
  const chooseSort = (next: WorkSort) => {
    setSort(next);
    try { localStorage.setItem(WORK_SORT_KEY, `${next.key}:${next.direction}`); } catch { /* Optional preference. */ }
  };
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [showMilestones, setShowMilestones] = useState(false);
  const filtersId = useId();
  const milestonesId = useId();
  const [stageFilter, setStageFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const projectId = project.id;
  const projectWorkflowKey = workWorkflowKey(project);
  const enabledWorkflowRefs = projectWorkflowRefs(project);
  const enabledWorkflowKeys = new Set(enabledWorkflowRefs.map(workflowKey));
  const availableWorkflowKeys = new Set([...enabledWorkflowKeys, ...work.map(workWorkflowKey)]);
  const workflowViewStorage = `sawhorse.project-workflow-view.v1:${projectId}`;
  const initialWorkflowView = availableWorkflowKeys.size > 1 ? "all" : projectWorkflowKey;
  const [workflowFilter, setWorkflowFilter] = useState(() => {
    try {
      const saved = localStorage.getItem(workflowViewStorage);
      return saved && (saved === "all" || availableWorkflowKeys.has(saved)) ? saved : initialWorkflowView;
    } catch { return initialWorkflowView; }
  });
  const selectedWorkflow = workflows.find((workflow) => workflowKey(workflow) === workflowFilter);
  const defaultWorkflow = creationWorkflow(workflows, project);
  const newWorkflow = workflowFilter === "all" ? defaultWorkflow
    : selectedWorkflow && creationWorkflow(workflows, project, { id: selectedWorkflow.id, version: selectedWorkflow.version });
  const allWorkflows = workflowFilter === "all";
  const boardDisplay = !allWorkflows && display === "board";
  const intake = newWorkflow && workflowIntake(newWorkflow);
  const unit = intake?.composer === "intent" ? t("artifact.intent") : intake?.composer === "goal" ? t("creation.goal")
    : intake?.artifact ? (intake.artifact.label === intake.artifact.role ? t(`artifact.${intake.artifact.role}`, { defaultValue: intake.artifact.label }) : intake.artifact.label) : t("creation.item");
  const createLabel = newWorkflow && !allWorkflows ? t("creation.newUnit", { unit }) : t("creation.newItem");
  const createWork = () => {
    if (newWorkflow) {
      onNewWork({ ...blankWork(), projectId, workflowId: newWorkflow.id, workflowVersion: newWorkflow.version, stage: newWorkflow.entry });
    }
  };
  const selectedStage = (item: WorkItem) => allWorkflows ? item.status : selectedWorkflow && !usesLifecycleBoard(selectedWorkflow)
    ? workflowBoardStage(item, selectedWorkflow) : taskStage(item, workflows);
  const stageOptions = allWorkflows ? (["backlog", "ready", "running", "review", "blocked", "done", "rejected", "cancelled"] as const).map((status) => [status, statusText(status)]) : selectedWorkflow && !usesLifecycleBoard(selectedWorkflow)
    ? workflowBoardLanes(selectedWorkflow, work.filter((item) => workWorkflowKey(item) === workflowFilter)).map((node) => [node.id, node.id === "done" ? t("status.done") : node.label])
    : [...taskStages, "discarding", "other"].map((stage) => [stage, t(`taskBoard.stages.${stage}`)]);
  const changeWorkflow = (key: string) => {
    setWorkflowFilter(key); setStageFilter("all"); setSelectedIds([]); setArea("flow");
    try { localStorage.setItem(workflowViewStorage, key); } catch { /* Optional preference. */ }
  };
  const availableWorkflowSignature = [...availableWorkflowKeys].join("|");
  const previousWorkflowCount = useRef(availableWorkflowKeys.size);
  useEffect(() => {
    if (previousWorkflowCount.current === 1 && availableWorkflowKeys.size > 1) changeWorkflow("all");
    else if (workflowFilter !== "all" && !availableWorkflowKeys.has(workflowFilter)) changeWorkflow(initialWorkflowView);
    else if (availableWorkflowKeys.size === 1 && workflowFilter === "all") changeWorkflow(projectWorkflowKey);
    previousWorkflowCount.current = availableWorkflowKeys.size;
  }, [availableWorkflowSignature, workflowFilter, projectWorkflowKey]);
  const [area, setArea] = useState<WorkArea>("flow");
  const changeArea = (next: WorkArea) => { setArea(next); setStageFilter("all"); setSelectedIds([]); };
  const workflowWork = work.filter((item) => workflowFilter === "all" || workWorkflowKey(item) === workflowFilter);
  const lifecycleAreas = !!selectedWorkflow && usesLifecycleBoard(selectedWorkflow);
  const taskWork = lifecycleAreas ? workflowWork.filter(isTaskRecord) : workflowWork;
  const areaWork = allWorkflows || !lifecycleAreas ? workflowWork : workflowWork.filter((item) => workArea(item) === area);
  const [executionFilter, setExecutionFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [milestoneFilter, setMilestoneFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [goalBatch, setGoalBatch] = useState<GoalBatchItem[] | null>(null);
  const goalSubmitting = useRef(false);
  const [launchTargets, setLaunchTargets] = useState<WorkItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [legacy, setLegacy] = useState<IssueMigrationItem[] | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const milestones = events.filter((event) => event.kind === "milestone");
  const milestoneName = (id: string) =>
    milestones.find((event) => event.id === id)?.title ?? id;

  const loadLegacy = async () => {
    try {
      setLegacy(await sddApi.issueMigrationPlan());
      setLegacyError(null);
    } catch (e) {
      setLegacy([]);
      setLegacyError(errorText(e));
    }
  };
  useEffect(() => {
    void loadLegacy();
  }, []);

  // The issue axis's labels and the development axis's tags are both classifications written on the document. View them under one filter.
  const tagsOf = (item: WorkItem) => [
    ...new Set([...(item.labels ?? []), ...(item.tags ?? [])]),
  ];
  // Tag candidates are drawn from the range already narrowed by every condition except the tag — so choosing a tag never empties the list.
  const tagPool = areaWork.filter(
    (item) =>
      (stageFilter === "all" || selectedStage(item) === stageFilter) &&
      (priorityFilter === "all" || item.priority === priorityFilter) &&
      (executionFilter === "all" || item.executionType === executionFilter) &&
      (typeFilter === "all" || item.issueType === typeFilter) &&
      (milestoneFilter === "all" ||
        (milestoneFilter === "none"
          ? !item.milestone
          : item.milestone === milestoneFilter)),
  );
  const tagOptions = [...new Set(tagPool.flatMap(tagsOf))].sort();
  const search = query.trim().toLocaleLowerCase();
  const rows = tagPool
    .filter((item) => tagFilter === "all" || tagsOf(item).includes(tagFilter))
    .filter((item) => !search || [item.title, item.id, item.description, item.owner,
      ...item.assignees, ...tagsOf(item)].join(" ").toLocaleLowerCase().includes(search))
    .sort(workComparator(sort));

  // If the chosen tag disappears because of other filters, release the tag filter.
  const tagKey = tagOptions.join("\n");
  useEffect(() => {
    if (tagFilter !== "all" && !tagKey.split("\n").includes(tagFilter))
      setTagFilter("all");
  }, [tagFilter, tagKey]);

  // Selection always applies only to the rows currently visible. Narrowing a filter discards hidden selections.
  const visibleKey = rows.map((item) => item.id).join("\n");
  useEffect(() => {
    const visible = new Set(visibleKey.split("\n"));
    setSelectedIds((prev) => prev.filter((id) => visible.has(id)));
  }, [visibleKey]);
  const selectedSet = new Set(selectedIds);
  const selectedRows = rows.filter((item) => selectedSet.has(item.id));
  const allChecked = rows.length > 0 && selectedRows.length === rows.length;

  const workflowForWork = (item: WorkItem) =>
    workflows.find(
      (definition) =>
        definition.id === item.workflowId &&
        definition.version === item.workflowVersion,
    );
  const stageOf = (item: WorkItem) => activeNodeForWork(item);
  const stageNameOf = (item: WorkItem) =>
    stageLabel(workflows, stageOf(item), item.workflowId, item.workflowVersion);
  const roleOf = (item: WorkItem) => {
    const node = workflowForWork(item)?.nodes.find(
      (candidate) => candidate.id === stageOf(item),
    );
    return roleForStageNode(stageOf(item), node?.allowedRoles ?? []);
  };
  const agentOf = (item: WorkItem) =>
    projects.find((project) => project.id === item.projectId)?.defaultAgent ||
    appDefaultAgent;
  const agentName = (id: string) =>
    knownAgents.find((candidate) => candidate.id === id)?.name ?? id;
  // Finished items have no further stage to advance to.
  const runnable = (item: WorkItem) => item.workflowId !== GOAL_WORKFLOW && workArea(item) === "flow" && (!isLifecycleV2(item) || item.stage === "queued") && !isClosedStatus(item.status) && !["blocked", "review"].includes(item.status);
  const toggleSelection = (id: string, checked: boolean) => setSelectedIds((prev) => checked ? [...new Set([...prev, id])] : prev.filter((item) => item !== id));
  const startGoals = async () => {
    const goals = selectedRows.filter((item) => item.workflowId === GOAL_WORKFLOW);
    if (goalSubmitting.current || !goals.length) return;
    goalSubmitting.current = true; setBusy("goals"); setGoalBatch(null);
    try {
      const results = await sddApi.startSelectedGoals(goals.map((w) => w.id));
      setGoalBatch(results);
      const accepted = new Set(results.filter((r) => r.outcome !== "skipped").map((r) => r.workId));
      setSelectedIds((prev) => prev.filter((id) => !accepted.has(id)));
      await reload();
    } catch (error) { setNotice({ tone: "error", text: errorText(error) }); }
    finally { goalSubmitting.current = false; setBusy(null); }
  };

  const launch = async (items: WorkItem[]) => {
    setBusy("launch");
    const failed: string[] = [];
    let done = 0;
    const queued = items.filter(isLifecycleV2);
    if (queued.length) {
      try { await sddApi.queueImplementation(queued.map((w) => w.id)); done += queued.length; }
      catch (e) { failed.push(errorText(e)); }
    }
    for (const item of items.filter((w) => !isLifecycleV2(w))) {
      const project =
        projects.find((candidate) => candidate.id === item.projectId) ?? null;
      try {
        await sddApi.launch({
          workId: item.id,
          projectId: item.projectId,
          role: roleOf(item),
          agent: agentOf(item),
          model: project?.defaultModel ?? "",
          instructions: "",
          parentRunId: null,
        });
        done += 1;
      } catch (e) {
        failed.push(`${item.id} ${errorText(e)}`);
      }
    }
    await reload();
    setLaunchTargets(null);
    setBusy(null);
    setNotice(
      failed.length
        ? {
            tone: "error",
            text: t("issues.launchFailedToast", {
              done,
              failed: failed.length,
              detail: failed.join(" · "),
            }),
          }
        : {
            tone: "success",
            text: t("issues.launchedToast", { count: done }),
          },
    );
  };

  const migrate = async (paths: string[]) => {
    setBusy("migrate");
    try {
      const report = await sddApi.issueMigrate(paths);
      await reload();
      await loadLegacy();
      setNotice(
        report.skipped.length
          ? {
              tone: "error",
              text: t("issues.migratePartialToast", {
                migrated: report.migrated.length,
                skipped: report.skipped.length,
                detail: report.skipped
                  .map((entry) => `${entry.issueId} ${entry.blocked}`)
                  .join(" · "),
              }),
            }
          : {
              tone: "success",
              text: t("issues.migratedToast", {
                count: report.migrated.length,
              }),
            },
      );
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  const pending = (legacy ?? []).filter((entry) => !entry.migrated &&
    (!projectId || entry.project === projectId || entry.project === projects.find((project) => project.id === projectId)?.name));
  const movable = pending.filter((entry) => !entry.blocked);

  const activeFilters = [stageFilter, priorityFilter, executionFilter, typeFilter, milestoneFilter, tagFilter]
    .filter((value) => value !== "all").length;
  const resetFilters = () => {
    setQuery("");
    setStageFilter("all");
    setPriorityFilter("all");
    setExecutionFilter("all"); setTypeFilter("all");
    setMilestoneFilter("all");
    setTagFilter("all");
  };
  const areaCounts = Object.fromEntries((["flow", "inbox", "archive", "mockups"] as WorkArea[]).map((entry) => [entry, workflowWork.filter((w) => workArea(w) === entry).length]));
  const attention = (stage: "approval" | "unconfirmed") => workflowWork.filter((w) => workArea(w) === "flow" && taskStage(w, workflows) === stage).length;
  const showAttention = (stage: "approval" | "unconfirmed") => { resetFilters(); setArea("flow"); setStageFilter(stage); };
  const queueable = rows.filter((w) => isLifecycleV2(w) && w.stage === "queued");

  // Context menu. Cards, list rows, and inbox notes share one builder; actions such as run, select,
  // or priority attach or drop out depending on the item's area and status.
  const workMenu = useContextMenu();
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", text: t("menu.copied") });
    } catch (e) {
      toast({ tone: "error", text: errorText(e) });
    }
  };
  const patchWork = async (item: WorkItem, patch: Partial<WorkItem>) => {
    try {
      await sddApi.saveWork({ ...item, ...patch, updatedAt: new Date().toISOString() });
      await reload();
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    }
  };
  const openWorkMenu = (event: MouseEvent, item: WorkItem) => {
    const inFlow = workArea(item) === "flow";
    const selected = selectedSet.has(item.id);
    const closed = isClosedStatus(item.status);
    workMenu.open(event, [
      { type: "label", label: `${item.id} · ${statusText(item.status)}` },
      { label: t("menu.openDetail"), icon: <FileText />, onSelect: () => onSelectWork(item.id) },
      inFlow && runnable(item) && { label: t("menu.run"), icon: <Play />, disabled: busy !== null, onSelect: () => setLaunchTargets([item]) },
      inFlow && area === "flow" && { label: t(selected ? "menu.deselect" : "menu.select"), icon: <SquareCheck />, disabled: busy !== null, onSelect: () => toggleSelection(item.id, !selected) },
      { type: "separator" },
      !closed && {
        type: "submenu" as const,
        label: t("menu.priority"),
        icon: <Flag />,
        disabled: busy !== null,
        items: (["urgent", "high", "normal", "low"] as Priority[]).map((priority) => ({
          label: priorityText(priority),
          checked: item.priority === priority,
          onSelect: () => void patchWork(item, { priority }),
        })),
      },
      !closed && milestones.length > 0 && {
        type: "submenu" as const,
        label: t("menu.milestone"),
        icon: <CalendarDays />,
        disabled: busy !== null,
        items: [
          { label: t("issues.noMilestone"), checked: !item.milestone, onSelect: () => void patchWork(item, { milestone: "" }) },
          ...milestones.map((entry) => ({
            label: entry.title,
            checked: item.milestone === entry.id,
            onSelect: () => void patchWork(item, { milestone: entry.id }),
          })),
        ],
      },
      !closed && { type: "separator" as const },
      { label: t("menu.copyId"), icon: <Copy />, onSelect: () => void copyText(item.id) },
      { label: t("menu.copyTitle"), icon: <Copy />, onSelect: () => void copyText(item.title) },
    ]);
  };
  // Decisions made straight from the list. Approve, request changes, or confirm without opening the detail.
  // Approving only moves to awaiting-implementation — the agent does not start until it is queued.
  const [deciding, setDeciding] = useState<string | null>(null);
  const decisionLock = useRef(false);
  const decideNow = async (item: WorkItem, action: QuickAction) => {
    if (decisionLock.current) return;
    decisionLock.current = true; setDeciding(item.id);
    try {
      if (action === "queue") await sddApi.queueImplementation([item.id]);
      else {
        // revision and inputDigest must be the latest values at the moment of the press. The list snapshot may already be stale.
        const [state, review] = await Promise.all([sddApi.lifecycle(item.id), sddApi.intentReview(item.id)]);
        await sddApi.lifecycleAction({
          workId: item.id, action, expectedStage: item.stage, revision: state.revision,
          inputDigest: review.inputDigest, note: t(`lifecycle.actions.${action}`),
        });
      }
      await reload();
      setNotice({ tone: "success", text: t(`taskBoard.decide.toast.${action}`) });
    } catch (error) {
      // Something may have changed elsewhere first. Notify and re-read the latest list.
      setNotice({ tone: "error", text: t("taskBoard.decide.failed", { error: errorText(error) }) });
      await reload();
    } finally {
      setDeciding(null); decisionLock.current = false;
    }
  };
  const quickDecision = (item: WorkItem) => <QuickDecision item={item} stage={taskStage(item, workflows)}
    busy={deciding === item.id} disabled={busy !== null || deciding !== null} onDecide={(target, action) => void decideNow(target, action)} />;

  return (
    <>
      <header className="wb-work-header">
        <div>
          <div className="wb-work-heading"><h1>{t("scope.workbenchTitle", { project: project.name })}</h1><span>{allWorkflows ? work.length : taskWork.length}</span></div>
          <p>{t("taskBoard.description")}</p>
        </div>
        <div className="wb-lifecycle-actions">
          {area === "flow" && queueable.length > 0 && <Button variant="outline" disabled={!!busy} onClick={() => void launch(queueable)}><Play />{t("lifecycle.batch", { count: queueable.length })}</Button>}
          <Button disabled={!newWorkflow} onClick={createWork}><Plus /> {createLabel}</Button>
        </div>
      </header>

      <section className="wb-workflow-context" aria-label={t("scope.projectWorkflow")}>
        <div><span>{t("scope.projectWorkflow")}</span><strong>{defaultWorkflow?.label ?? project.workflowId} · v{project.workflowVersion}</strong></div>
        <p>{t("scope.inheritWorkflow")}</p>
        <Button size="sm" variant="ghost" onClick={onProjectSettings}>{t("projects.settings")}</Button>
      </section>
      {availableWorkflowKeys.size > 1 && <section className="wb-workflow-views" aria-label={t("scope.workflowViews")}>
        <label><span>{t("scope.workflowViews")}</span>
          <Select aria-label={t("scope.workflowViews")} value={workflowFilter} onChange={changeWorkflow}
            options={[{ value: "all", label: `${t("scope.allWork")} (${work.length})` }, ...[...availableWorkflowKeys].map((key) => {
              const [id, version] = JSON.parse(key) as [string, string];
              const definition = workflows.find((item) => workflowKey(item) === key);
              const count = work.filter((item) => workWorkflowKey(item) === key).length;
              return { value: key, label: `${definition?.label ?? id} · v${version} (${count})${enabledWorkflowKeys.has(key) ? "" : ` · ${t("scope.historyOnly")}`}` };
            })]} />
        </label>
        <p>{t(allWorkflows ? "scope.allWorkHint" : "scope.flowWorkHint")}</p>
      </section>}
      {!newWorkflow && <p className="wb-inline-error" role="alert">{t(selectedWorkflow ? "scope.historyOnlyHint" : "creation.workflowUnavailable")}</p>}

      {!allWorkflows && usesLifecycleBoard(selectedWorkflow) && <section className="wb-task-overview" aria-label={t("taskBoard.attention")}>
        <button aria-pressed={area === "inbox"} onClick={() => { resetFilters(); changeArea("inbox"); }}><span><strong>{t("taskBoard.inbox")}</strong><small>{t("taskBoard.notYetTask")}</small></span><b>{areaCounts.inbox}</b></button>
        <button aria-pressed={area === "flow" && stageFilter === "approval"} onClick={() => showAttention("approval")}><span><strong>{t("taskBoard.reviewDesign")}</strong><small>{t("taskBoard.reviewDesignHint")}</small></span><b>{attention("approval")}</b></button>
        <button aria-pressed={area === "flow" && stageFilter === "unconfirmed"} onClick={() => showAttention("unconfirmed")}><span><strong>{t("taskBoard.reviewResult")}</strong><small>{t("taskBoard.reviewResultHint")}</small></span><b>{attention("unconfirmed")}</b></button>
      </section>}
      {!allWorkflows && <div className="wb-work-navigation">
        {lifecycleAreas && <div className="wb-work-area-tabs" role="group" aria-label={t("taskBoard.areas")}>
          {(["flow", "inbox", "archive", "mockups"] as WorkArea[]).map((entry) => <button key={entry} aria-pressed={area === entry} onClick={() => changeArea(entry)}>{t(`taskBoard.${entry}`)}<span>{areaCounts[entry]}</span></button>)}
        </div>}
        {area === "flow" && <div className="wb-view-switch" role="group" aria-label={t("work.view")}>
          <Button variant="ghost" aria-pressed={display === "board"} onClick={() => chooseDisplay("board")}><Columns3 />{t("taskBoard.board")}</Button>
          <Button variant="ghost" aria-pressed={display === "list"} onClick={() => chooseDisplay("list")}><List />{t("work.list")}</Button>
        </div>}
      </div>}

      <div className="wb-work-toolbar">
        <div className="wb-work-search">
          <Search size={16} aria-hidden="true" />
          <input aria-label={t("work.search")} placeholder={t("work.searchPlaceholder")}
            value={query} onChange={(event) => setQuery(event.target.value)} />
          {query && <button type="button" aria-label={t("work.clearSearch")} onClick={() => setQuery("")}><X size={14} /></button>}
        </div>
        <Button variant="outline" aria-expanded={showFilters} aria-controls={filtersId}
          onClick={() => setShowFilters((value) => !value)}>
          <SlidersHorizontal />{t("work.filters")}{activeFilters > 0 && <span className="wb-work-filter-count">{activeFilters}</span>}
        </Button>
        <Button variant="ghost" aria-expanded={showMilestones} aria-controls={milestonesId}
          onClick={() => setShowMilestones((value) => !value)}>
          <CalendarDays />{t("issues.milestonesHeading")}
        </Button>
      </div>

      {showFilters && <section id={filtersId} className="wb-work-filters" aria-label={t("work.filters")}>
        {area === "flow" && <label><span>{t(allWorkflows ? "issues.colStatus" : "issues.colStageRun")}</span><Select size="sm" aria-label={t("board.filterStage")} value={stageFilter} onChange={setStageFilter}
          options={[{ value: "all", label: t("board.filterAllStages") }, ...stageOptions.map(([id, label]) => ({ value: id, label }))]} /></label>}
        <label><span>{t("issues.colPriority")}</span><Select size="sm" aria-label={t("board.filterWork")} value={priorityFilter} onChange={setPriorityFilter}
          options={[{ value: "all", label: t("board.filterAll") }, ...(["urgent", "high", "normal", "low"] as Priority[]).map((priority) => ({ value: priority, label: priorityText(priority) }))]} /></label>
        <label><span>{t("workType.label")}</span><Select size="sm" aria-label={t("workType.filter")} value={typeFilter} onChange={setTypeFilter}
          options={[{ value: "all", label: t("workType.all") }, ...ISSUE_TYPES.map((type) => ({ value: type, label: issueTypeText(type) }))]} /></label>
        <label><span>{t("issues.executionAria")}</span><Select size="sm" aria-label={t("issues.executionAria")} value={executionFilter} onChange={setExecutionFilter}
          options={[{ value: "all", label: t("issues.allExecutionTypes") }, ...EXECUTION_TYPES.map((type) => ({ value: type, label: executionTypeText(type) }))]} /></label>
        <label><span>{t("issues.tagAria")}</span><Select size="sm" value={tagFilter} onChange={setTagFilter} aria-label={t("issues.tagAria")}
          options={[{ value: "all", label: t("issues.allTags") }, ...tagOptions.map((tag) => ({ value: tag, label: tag }))]} /></label>
        <label><span>{t("issues.milestonesHeading")}</span><Select size="sm" value={milestoneFilter} onChange={setMilestoneFilter} aria-label={t("work.milestoneFilter")}
          options={[{ value: "all", label: t("work.allMilestones") }, { value: "none", label: t("issues.noMilestone") }, ...milestones.map((event) => ({ value: event.id, label: event.title }))]} /></label>
      </section>}

      {showMilestones && <div id={milestonesId}>
        <aside className="wb-milestone-rail">
          <div className="wb-panel-title">
            <h2>{t("issues.milestonesHeading")}</h2>
            <Button size="sm" variant="ghost" onClick={onNewMilestone}>
              <Plus />{t("issues.addMilestone")}
            </Button>
          </div>
          <div className="wb-work-milestones">
          <button
            type="button"
            aria-pressed={milestoneFilter === "all"}
            className={cx(
              "wb-milestone-row",
              milestoneFilter === "all" && "is-active",
            )}
            onClick={() => setMilestoneFilter("all")}
          >
            <strong>{t("issues.allIssuesHeading")}</strong>
            <small>{t("issues.nCount", { count: taskWork.length })}</small>
          </button>
          <button
            type="button"
            className={cx(
              "wb-milestone-row",
              milestoneFilter === "none" && "is-active",
            )}
            aria-pressed={milestoneFilter === "none"}
            onClick={() => setMilestoneFilter("none")}
          >
            <strong>{t("issues.noMilestone")}</strong>
            <small>
              {t("issues.nCount", {
                count: taskWork.filter((item) => !item.milestone).length,
              })}
            </small>
          </button>
          {milestones.map((event) => {
            const members = taskWork.filter((item) => item.milestone === event.id);
            const closed = members.filter(
              (item) => (item.state || "open") === "closed",
            ).length;
            // Progress is the closed ratio of member items. Not a hand-written value.
            const percent = members.length
              ? Math.round((closed / members.length) * 100)
              : 0;
            return (
              <button
                key={event.id}
                type="button"
                className={cx(
                  "wb-milestone-row",
                  milestoneFilter === event.id && "is-active",
                )}
                aria-pressed={milestoneFilter === event.id}
                onClick={() => setMilestoneFilter(event.id)}
              >
                <strong>{event.title}</strong>
                <small>
                  {t("issues.progress", { closed, total: members.length })}
                </small>
                <span
                  className="wb-milestone-bar"
                  role="progressbar"
                  aria-label={t("issues.progressAria", { title: event.title })}
                  aria-valuenow={percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <i style={{ width: `${percent}%` }} />
                </span>
              </button>
            );
          })}
          </div>
        </aside>
      </div>}

      <div className="wb-work-results">
        {area === "flow" && boardDisplay && rows.length > 0 && <label className="wb-task-card-select"><input type="checkbox" aria-label={t("issues.selectAll")} checked={allChecked} disabled={busy !== null} ref={(el) => { if (el) el.indeterminate = !allChecked && selectedRows.length > 0; }} onChange={(e) => setSelectedIds(e.target.checked ? rows.map((w) => w.id) : [])} />{t("issues.selectAll")}</label>}
        <p role="status">{t(area === "inbox" ? "taskBoard.intentResults" : area === "mockups" ? "taskBoard.mockupResults" : "work.results", { count: rows.length })}
          {milestoneFilter !== "all" && <span> · {milestoneFilter === "none" ? t("issues.noMilestone") : milestoneName(milestoneFilter)}</span>}
        </p>
        {(activeFilters > 0 || search) && <Button size="sm" variant="ghost" onClick={resetFilters}><X />{t("work.resetFilters")}</Button>}
        <div className="wb-work-sort">
          <Select size="sm" value={sort.key} aria-label={t("work.sortAria")}
            onChange={(key) => chooseSort({ key, direction: WORK_SORTS[key] ?? "asc" })}
            options={Object.keys(WORK_SORTS).map((key) => ({ value: key, label: t(`work.sort.${key}`) }))} />
          <Button size="sm" variant="ghost"
            aria-label={t("work.sortDirection", {
              direction: t(sort.direction === "asc" ? "work.sortAscending" : "work.sortDescending"),
            })}
            onClick={() => chooseSort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}>
            {sort.direction === "asc" ? <ArrowUpNarrowWide size={14} /> : <ArrowDownWideNarrow size={14} />}
          </Button>
        </div>
      </div>
      <div className="wb-issue-layout">
        <div className="wb-issue-main">
          {area === "flow" && selectedRows.length > 0 && (
            <div className="wb-bulk-bar">
              <strong>{t("issues.nSelected", { count: selectedRows.length })}</strong>
              {selectedRows.some((item) => item.workflowId === GOAL_WORKFLOW) && <Button size="sm" disabled={busy !== null || !selectedRows.some((w) => w.workflowId === GOAL_WORKFLOW && !isClosedStatus(w.status))} onClick={() => void startGoals()}><Play size={14} />{t(busy === "goals" ? "goal.batchStarting" : "goal.batchStart")}</Button>}
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !selectedRows.some(runnable)}
                onClick={() => setLaunchTargets(selectedRows.filter(runnable))}
              >
                <Play size={14} /> {t("issues.runSelected")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setSelectedIds([])}
              >
                {t("issues.clearSelection")}
              </Button>
            </div>
          )}
          {area === "flow" && goalBatch && <div className="wb-goal-batch-results" role="status">
            <p>{t("goal.batchResult", { queued: goalBatch.filter((r) => r.outcome === "queued").length, existing: goalBatch.filter((r) => r.outcome === "already-queued").length, skipped: goalBatch.filter((r) => r.outcome === "skipped").length })}</p>
            {goalBatch.some((r) => r.outcome === "skipped") && <ul>{goalBatch.filter((r) => r.outcome === "skipped").map((r) => <li key={r.workId}>{work.find((w) => w.id === r.workId)?.title ?? r.workId}: {r.reason}</li>)}</ul>}
          </div>}
          {area === "archive" && <p className="wb-task-archive-hint">{t("taskBoard.archiveHint")}</p>}
          {area === "inbox" ? <IntentInbox work={rows} projects={projects} onSelectWork={onSelectWork} onNewWork={createWork} createLabel={createLabel} onWorkMenu={openWorkMenu} /> : area === "mockups" ? <MockupLibrary work={rows} projects={projects} onSelectWork={onSelectWork} /> : area === "flow" && boardDisplay ? <>
            {(activeFilters > 0 || search) && !rows.length && <EmptyState title={t("issues.emptyTitle")} description={t("work.emptyFiltered")} action={<Button variant="outline" onClick={resetFilters}>{t("work.resetFilters")}</Button>} />}
            {[workflowFilter].map((key) => {
              const definition = workflows.find((item) => workflowKey(item) === key);
              const [id, version] = JSON.parse(key) as [string, string];
              return <section className="wb-process-group" key={key} data-workflow={`${id}@${version}`}>
                <TaskBoard workflow={definition} work={rows.filter((item) => workWorkflowKey(item) === key)} projects={projects} workflows={workflows} onSelectWork={onSelectWork} selectedIds={selectedSet} onToggle={toggleSelection} selectionDisabled={busy !== null} onWorkMenu={openWorkMenu}
                  onDecide={(item, action) => void decideNow(item, action)} decidingId={deciding} decisionsDisabled={busy !== null} />
              </section>;
            })}
          </> : rows.length ? (
            <table className="wb-issue-table">
              <thead>
                <tr>
                  <th className="wb-issue-check">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      disabled={busy !== null}
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            !allChecked && selectedRows.length > 0;
                      }}
                      onChange={(event) =>
                        setSelectedIds(
                          event.target.checked
                            ? rows.map((item) => item.id)
                            : [],
                        )
                      }
                      aria-label={t("issues.selectAll")}
                    />
                  </th>
                  <th className="wb-work-title-column">{t("work.itemTitle")}</th>
                  {allWorkflows && <th>{t("creation.workflow")}</th>}
                  <th>{t("issues.colPriority")}</th>
                  <th>{t("issues.colStatus")}</th>
                  <th>{t("issues.colStageRun")}</th>
                  <th>{t("form.owner")}</th>
                  <th>{t("form.dueDate")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id} data-selected={selectedSet.has(item.id) || undefined} onClick={() => onSelectWork(item.id)} onContextMenu={(event) => openWorkMenu(event, item)}>
                    <td
                      className="wb-issue-check"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSet.has(item.id)}
                        disabled={busy !== null}
                        onChange={(event) =>
                          setSelectedIds((prev) =>
                            event.target.checked
                              ? [...prev, item.id]
                              : prev.filter((id) => id !== item.id),
                          )
                        }
                        aria-label={t("issues.selectRowAria", {
                          id: item.id,
                          title: item.title,
                        })}
                      />
                    </td>
                    <td className="wb-work-title-cell">
                      <button className="wb-work-title-link" onClick={(event) => { event.stopPropagation(); onSelectWork(item.id); }}>{item.title}</button>
                      <div className="wb-work-row-meta">
                        <span className="wb-issue-id">{item.id}</span>
                        <span>{projects.find((project) => project.id === item.projectId)?.name ?? t("board.uncategorized")}</span>
                        <span>{issueTypeText(item.issueType)} · {executionTypeText(item.executionType)}</span>
                        {item.milestone && <span>{milestoneName(item.milestone)}</span>}
                        {tagsOf(item).map((tag) => <span className="wb-work-tag" key={tag}>{tag}</span>)}
                      </div>
                    </td>
                    {allWorkflows && <td className="wb-workflow-cell"><strong>{workflowForWork(item)?.label ?? item.workflowId}</strong><small>v{item.workflowVersion}</small></td>}
                    <td>
                      <span className={`wb-priority is-${item.priority}`}>
                        {priorityText(item.priority)}
                      </span>
                    </td>
                    <td>
                      <span className={statusClass(item.status)}>
                        {statusText(item.status)}
                      </span>
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      {runnable(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setLaunchTargets([item])}
                          title={t("issues.stageRunTitle", {
                            stage: stageNameOf(item),
                            role: roleText(roleOf(item)),
                          })}
                        >
                          <Play size={14} /> {stageNameOf(item)}
                        </Button>
                      ) : (
                        <>
                          <span className="wb-muted">{stageNameOf(item)}</span>
                          {area === "flow" && quickDecision(item)}
                        </>
                      )}
                    </td>
                    <td>{item.owner || item.assignees.join(", ") || "-"}</td>
                    <td>{formatDate(item.dueDate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title={t("issues.emptyTitle")}
              description={t(activeFilters > 0 || search ? "work.emptyFiltered" : "issues.emptyDescription")}
              action={activeFilters > 0 || search ? (
                <Button variant="outline" onClick={resetFilters}>{t("work.resetFilters")}</Button>
              ) : (
                <Button onClick={createWork}><Plus /> {createLabel}</Button>
              )}
            />
          )}
        </div>
      </div>

      {(pending.length > 0 || legacyError) && (
        <section className="wb-panel wb-legacy-issues">
          <div className="wb-panel-title">
            <h2>{t("issues.legacyHeading", { count: pending.length })}</h2>
            {movable.length > 0 && (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void migrate(movable.map((entry) => entry.path))}
              >
                {busy === "migrate" && <Loader2 className="wb-spin" />}
                {t("issues.migrateAll", { count: movable.length })}
              </Button>
            )}
          </div>
          {legacyError ? (
            <p className="wb-muted">{legacyError}</p>
          ) : (
            <>
              <p className="wb-muted">
                {t("issues.legacyDescBefore")} <code>migrated_to</code>
                {t("issues.legacyDescAfter")}
              </p>
              <ul className="wb-legacy-list">
                {pending.map((entry) => (
                  <li key={entry.path}>
                    <div>
                      <strong>
                        {entry.issueId} {entry.title}
                      </strong>
                      <small>
                        {entry.project} · {entry.executionType}
                        {entry.blocked ? ` · ${entry.blocked}` : ""}
                      </small>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || Boolean(entry.blocked)}
                      onClick={() => void migrate([entry.path])}
                    >
                      {t("issues.migrateOne")}
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <Dialog
        open={launchTargets !== null}
        onClose={() => setLaunchTargets(null)}
        title={
          launchTargets?.length === 1
            ? t("issues.launchConfirmOne", {
                stage: stageNameOf(launchTargets[0]),
              })
            : t("issues.launchConfirmMany", {
                count: launchTargets?.length ?? 0,
              })
        }
      >
        <div className="wb-launch-confirm">
          <ul className="wb-launch-list">
            {(launchTargets ?? []).map((item) => (
              <li key={item.id}>
                <strong>
                  {item.id} {item.title}
                </strong>
                <small>
                  {stageNameOf(item)} · {roleText(roleOf(item))} ·{" "}
                  {agentName(agentOf(item))}
                  {projects.find((candidate) => candidate.id === item.projectId)
                    ?.defaultModel
                    ? ` · ${
                        projects.find(
                          (candidate) => candidate.id === item.projectId,
                        )?.defaultModel
                      }`
                    : ""}
                </small>
              </li>
            ))}
          </ul>
          <p className="wb-muted">{t("issues.launchHint")}</p>
          <div className="wb-form-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLaunchTargets(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void launch(launchTargets ?? [])}
            >
              {busy === "launch" && <Loader2 className="wb-spin" />}
              {t("issues.run")}
            </Button>
          </div>
        </div>
      </Dialog>
      {workMenu.element}
    </>
  );
}
function WorkFormDialog({
  open,
  initial,
  projects,
  work,
  events,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: WorkItem;
  projects: Project[];
  work: WorkItem[];
  events: CalendarEvent[];
  onClose: () => void;
  onSaved: (item: WorkItem) => void;
}) {
  const { t } = useTranslation("workbench");
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setError(null);
    }
  }, [open, initial]);
  const set = <K extends keyof WorkItem>(key: K, value: WorkItem[K]) =>
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      updatedAt: new Date().toISOString(),
    }));
  const toggle = (id: string) =>
    set(
      "dependsOn",
      draft.dependsOn.includes(id)
        ? draft.dependsOn.filter((value) => value !== id)
        : [...draft.dependsOn, id],
    );
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setError(t("validation.workTitleRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(
        await sddApi.saveWork({
          ...draft,
          title: draft.title.trim(),
          tags: draft.tags.filter(Boolean),
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={draft.id ? t("form.editWork") : t("form.newWork")}
      wide
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          {t("form.workName")}
          <Input
            value={draft.title}
            onChange={(event) => set("title", event.target.value)}
            placeholder={t("form.workNamePlaceholder")}
            autoFocus
          />
        </label>
        <label className="wb-field is-wide">
          {t("form.context")}
          <textarea
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder={t("form.contextPlaceholder")}
          />
        </label>
        <label className="wb-field">
          {t("form.project")}
          <Select
            aria-label={t("form.project")}
            value={draft.projectId}
            onChange={(value) => set("projectId", value)}
            options={[
              { value: "", label: t("form.linkNone") },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </label>
        <label className="wb-field">
          {t("form.owner")}
          <Input
            value={draft.owner}
            onChange={(event) => set("owner", event.target.value)}
            placeholder={t("form.ownerPlaceholder")}
          />
        </label>
        <label className="wb-field">
          {t("form.priority")}
          <Select
            aria-label={t("form.priority")}
            value={draft.priority}
            onChange={(value) => set("priority", value as Priority)}
            options={(["urgent", "high", "normal", "low"] as Priority[]).map(
              (priority) => ({ value: priority, label: priorityText(priority) }),
            )}
          />
        </label>
        <label className="wb-field">
          {t("form.type")}
          <Select
            aria-label={t("form.type")}
            value={draft.issueType}
            onChange={(value) => set("issueType", value)}
            options={ISSUE_TYPES.map((type) => ({ value: type, label: issueTypeText(type) }))}
          />
        </label>
        <label className="wb-field">
          {t("form.executionType")}
          <Select
            aria-label={t("form.executionType")}
            value={draft.executionType}
            onChange={(value) => set("executionType", value)}
            options={EXECUTION_TYPES.map((type) => ({ value: type, label: executionTypeText(type) }))}
          />
        </label>
        <label className="wb-field">
          {t("form.milestone")}
          <Select
            aria-label={t("form.milestone")}
            value={draft.milestone}
            onChange={(value) => set("milestone", value)}
            options={[
              { value: "", label: t("form.noMilestone") },
              ...events
                .filter((event) => event.kind === "milestone")
                .map((event) => ({ value: event.id, label: event.title })),
            ]}
          />
        </label>
        <label className="wb-field">
          {t("form.startDate")}
          <Input
            type="date"
            value={draft.startDate ?? ""}
            onChange={(event) => set("startDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field">
          {t("form.dueDate")}
          <Input
            type="date"
            value={draft.dueDate ?? ""}
            onChange={(event) => set("dueDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field is-wide">
          {t("form.tags")}
          <Input
            value={draft.tags.join(", ")}
            onChange={(event) =>
              set(
                "tags",
                event.target.value.split(",").map((tag) => tag.trim()),
              )
            }
            placeholder={t("form.tagsPlaceholder")}
          />
        </label>
        {work.filter((item) => item.id !== draft.id).length > 0 && (
          <fieldset className="wb-check-field is-wide">
            <legend>{t("form.predecessors")}</legend>
            <div>
              {work
                .filter((item) => item.id !== draft.id)
                .map((item) => (
                  <label key={item.id}>
                    <input
                      type="checkbox"
                      checked={draft.dependsOn.includes(item.id)}
                      onChange={() => toggle(item.id)}
                    />{" "}
                    {item.title}
                  </label>
                ))}
            </div>
          </fieldset>
        )}
        {error && <div className="wb-inline-error">{error}</div>}
        <div className="wb-form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />}
            {draft.id ? t("form.saveChanges") : t("form.createWork")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
type AgentModelOption = {
  id: string;
  label: string;
  source: "catalog" | "recent";
};
/**
 * Reads agent model candidates. On first load it respects the existing value; later, if moving
 * between agents changes the list, models absent from that agent's list are cleared.
 */
function useAgentModelOptions(
  agent: string,
  value: string,
  onValueChange: (value: string) => void,
): AgentModelOption[] {
  const [options, setOptions] = useState<AgentModelOption[]>([]);
  const stateRef = useRef({ value, onValueChange, initialized: false });
  stateRef.current.value = value;
  stateRef.current.onValueChange = onValueChange;
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const wasInitialized = stateRef.current.initialized;
    stateRef.current.initialized = true;
    sddApi
      .agentModels(agent)
      .then((result) => {
        if (!alive) return;
        setOptions(result.options);
        const current = stateRef.current;
        if (
          wasInitialized &&
          current.value &&
          !result.options.some((option) => option.id === current.value)
        )
          current.onValueChange("");
      })
      .catch(() => {
        if (alive) setOptions([]);
      });
    return () => {
      alive = false;
    };
  }, [agent]);
  return options;
}
/**
 * A free-input field with a model-candidate datalist on top. Arbitrary model names can be typed
 * as-is, and per-agent catalog and recent-use entries can be picked.
 */
function ModelInput({
  agent,
  value,
  onValueChange,
  placeholder,
}: {
  agent: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation("workbench");
  const options = useAgentModelOptions(agent, value, onValueChange);
  const listId = useId();
  return (
    <>
      <Input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        list={listId}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
            {option.source === "recent"
              ? t("form.modelRecentSuffix")
              : undefined}
          </option>
        ))}
      </datalist>
    </>
  );
}
/**
 * Collects folder selection into one place. The first folder becomes the project's default folder
 * (the agent's working directory); the rest are additional folders opened alongside. The browse
 * button picks several at once, and paths can also be pasted directly.
 */
function FolderPicker({
  repoPath,
  extraPaths,
  onChange,
}: {
  repoPath: string;
  extraPaths: string[];
  onChange: (repoPath: string, extraPaths: string[]) => void;
}) {
  const { t } = useTranslation("workbench");
  const [typed, setTyped] = useState("");
  const add = (paths: string[]) => {
    const additions = paths
      .map((path) => path.trim())
      .filter(
        (path) =>
          path &&
          path !== repoPath &&
          !extraPaths.includes(path),
      );
    if (!additions.length) return;
    if (!repoPath) onChange(additions[0], [...extraPaths, ...additions.slice(1)]);
    else onChange(repoPath, [...extraPaths, ...additions]);
    setTyped("");
  };
  const removeAt = (index: number) => {
    if (index === 0) onChange(extraPaths[0] ?? "", extraPaths.slice(1));
    else onChange(repoPath, extraPaths.filter((_, at) => at !== index - 1));
  };
  const rows = repoPath ? [repoPath, ...extraPaths] : extraPaths;
  return (
    <div className="wb-field is-wide">
      <span>{t("form.folders")}</span>
      {rows.length === 0 ? (
        <div className="wb-folder-empty">
          <FolderPlus size={22} />
          <p>{t("form.foldersEmpty")}</p>
          <small className="wb-muted">{t("form.foldersHint")}</small>
        </div>
      ) : (
        <div className="wb-folder-list">
          {rows.map((path, index) => (
            <div key={`${path}-${index}`} className="wb-folder-row">
              <Folder size={14} className="wb-folder-icon" />
              <span className="wb-folder-path" title={path}>
                {path}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("form.removeFolder")}
                onClick={() => removeAt(index)}
              >
                <X size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="wb-folder-add">
        <BrowseButton
          multiple
          label={t(rows.length ? "form.addFolders" : "form.pickFolders")}
          onSelect={add}
        />
        <Input
          aria-label={t("form.folderPathAria")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add([typed]);
            }
          }}
          placeholder={t("form.folderPathPlaceholder")}
        />
      </div>
    </div>
  );
}
function GithubReposPicker({
  repos,
  onChange,
}: {
  repos: string[];
  onChange: (repos: string[]) => void;
}) {
  const { t } = useTranslation("workbench");
  const [typed, setTyped] = useState("");
  const add = () => {
    // A pasted github.com URL is normalized to owner/repo as-is.
    const value = typed
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "");
    if (!value || repos.includes(value)) return;
    onChange([...repos, value]);
    setTyped("");
  };
  return (
    <div className="wb-field is-wide">
      <span>{t("form.githubRepos")}</span>
      {repos.length > 0 && (
        <div className="wb-folder-list">
          {repos.map((repo) => (
            <div key={repo} className="wb-folder-row">
              <Github size={14} className="wb-folder-icon" />
              <span className="wb-folder-path" title={repo}>
                {repo}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t("form.removeGithubRepo")}
                onClick={() => onChange(repos.filter((r) => r !== repo))}
              >
                <X size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      <div className="wb-folder-add">
        <Input
          aria-label={t("form.githubRepoAria")}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder={t("form.githubRepoPlaceholder")}
        />
      </div>
      <small className="wb-muted">{t("form.githubReposHint")}</small>
    </div>
  );
}

function ProjectFormDialog({
  open,
  initial,
  projects,
  workflows,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: Project;
  projects: Project[];
  workflows: WorkflowDefinition[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation("workbench");
  const installedAgents = useApp((state) => state.agents).filter(
    (agent) => agent.detected && agent.runsJobs,
  );
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      const version = !initial.id ? latestWorkflowVersions(workflows).get(initial.workflowId) : undefined;
      setDraft(version ? { ...initial, workflowVersion: version } : initial);
      setError(null);
    }
  }, [open, initial]);
  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const [analyzing, setAnalyzing] = useState(false);
  // Re-analysis only fires — completion arrives via the `project-analyzed` event.
  const reanalyze = async () => {
    if (!isTauri() || !draft.id) return;
    setAnalyzing(true);
    try {
      await sddApi.analyzeProject(draft.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setAnalyzing(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setError(t("validation.projectNameRequired"));
      return;
    }
    setBusy(true);
    try {
      const saved = await sddApi.saveProject({
        ...draft,
        name: draft.name.trim(),
        verifyCommands: draft.verifyCommands.filter(Boolean),
        githubRepos: (draft.githubRepos ?? []).map((repo) => repo.trim()).filter(Boolean),
      });
      // A new project fires analysis at save time. The agent fills in the description and
      // verify commands; completion arrives via the `project-analyzed` event.
      if (!draft.id && isTauri() && saved.id)
        void sddApi.analyzeProject(saved.id).catch(() => undefined);
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={draft.id ? t("form.editProject") : t("form.addProject")}
      wide
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          {t("form.projectName")}
          <Input
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            autoFocus
          />
        </label>
        {draft.id ? (
          <div className="wb-field is-wide">
            <div className="flex items-center justify-between gap-2">
              <span>{t("form.description")}</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={analyzing}
                onClick={() => void reanalyze()}
              >
                {analyzing ? (
                  <Loader2 className="wb-spin" />
                ) : (
                  <RefreshCw size={13} />
                )}{" "}
                {t("form.reanalyze")}
              </Button>
            </div>
            <textarea
              value={draft.description}
              onChange={(event) => set("description", event.target.value)}
              placeholder={t("form.descriptionPlaceholder")}
            />
          </div>
        ) : (
          // A new project does not take a hand-written description. Analysis fills it in after saving.
          <div className="wb-field is-wide">
            <small className="wb-muted">{t("form.analyzeHint")}</small>
          </div>
        )}
        <FolderPicker
          repoPath={draft.repoPath}
          extraPaths={draft.extraPaths}
          onChange={(repoPath, extraPaths) =>
            setDraft((previous) => {
              const next = { ...previous, repoPath, extraPaths };
              // Follows along while the name is empty or still mirroring the previous
              // path's basename. Once the user touches the name, it stops overriding.
              if (
                !previous.name.trim() ||
                previous.name === pathBasename(previous.repoPath)
              )
                next.name = pathBasename(repoPath);
              return next;
            })
          }
        />
        <GithubReposPicker
          repos={draft.githubRepos ?? []}
          onChange={(githubRepos) => set("githubRepos", githubRepos)}
        />
        <label className="wb-field">
          {t("form.defaultAgent")}
          <Select
            aria-label={t("form.defaultAgent")}
            value={draft.defaultAgent}
            onChange={(value) => set("defaultAgent", value)}
            options={[
              ...installedAgents.map((agent) => ({ value: agent.id, label: agent.name })),
              ...(draft.defaultAgent && !installedAgents.some((agent) => agent.id === draft.defaultAgent)
                ? [{ value: draft.defaultAgent, label: draft.defaultAgent }]
                : []),
            ]}
          />
        </label>
        <label className="wb-field">
          {t("form.defaultModel")}
          <ModelInput
            agent={draft.defaultAgent}
            value={draft.defaultModel}
            onValueChange={(value) => set("defaultModel", value)}
            placeholder={t("form.optional")}
          />
        </label>
        <label className="wb-field is-wide">
          {t("form.workflow")}
          <Select
            aria-label={t("form.workflowAria")}
            value={`${draft.workflowId}@${draft.workflowVersion}`}
            onChange={(value) => {
              const selected = workflows.find(
                (definition) => `${definition.id}@${definition.version}` === value,
              );
              if (selected)
                setDraft((previous) => ({
                  ...previous,
                  workflowId: selected.id,
                  workflowVersion: selected.version,
                  additionalWorkflows: projectWorkflowRefs(previous).filter((reference) => reference.id !== selected.id || reference.version !== selected.version),
                }));
            }}
            options={workflowChoices(workflows, initial.id ? { id: initial.workflowId, version: initial.workflowVersion } : undefined).map((definition) => ({
              value: `${definition.id}@${definition.version}`,
              label: `${definition.label} · v${definition.version}`,
            }))}
          />
          <small className="wb-muted">
            {t("form.workflowHint")}
          </small>
        </label>
        <fieldset className="wb-check-field wb-project-workflows is-wide">
          <legend>{t("form.additionalWorkflows")}</legend>
          <p className="wb-muted">{t("form.additionalWorkflowsHint")}</p>
          {(() => {
            const references = projectWorkflowRefs(draft);
            const choices = [...references, ...projectWorkflowRefs(initial), ...workflowChoices(workflows).map(({ id, version }) => ({ id, version }))]
              .filter((reference, index, all) => all.findIndex((item) => item.id === reference.id && item.version === reference.version) === index);
            return choices.map((reference) => {
              const isDefault = reference.id === draft.workflowId && reference.version === draft.workflowVersion;
              const definition = workflows.find((item) => item.id === reference.id && item.version === reference.version);
              const checked = references.some((item) => item.id === reference.id && item.version === reference.version);
              return <label key={workflowKey(reference)}>
                <input type="checkbox" checked={checked} disabled={isDefault || busy} onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  setDraft((previous) => ({
                    ...previous,
                    additionalWorkflows: enabled ? [...(previous.additionalWorkflows ?? []), reference]
                      : (previous.additionalWorkflows ?? []).filter((item) => item.id !== reference.id || item.version !== reference.version),
                  }));
                }} />
                <span>{definition?.label ?? reference.id} · v{reference.version}{isDefault ? ` · ${t("form.defaultWorkflowBadge")}` : ""}</span>
              </label>;
            });
          })()}
        </fieldset>
        {draft.id && (
          <label className="wb-field is-wide">
            {t("form.verifyCommands")}
            <textarea
              value={draft.verifyCommands.join("\n")}
              onChange={(event) =>
                set(
                  "verifyCommands",
                  event.target.value.split("\n").map((command) => command.trim()),
                )
              }
              placeholder={"npm run build\nnpm test"}
            />
            <small className="wb-muted">{t("form.verifyHint")}</small>
          </label>
        )}
        <fieldset className="wb-check-field is-wide">
          <legend>{t("form.prerequisiteProjects")}</legend>
          <div>
            {projects.filter((project) => project.id !== draft.id).length ? (
              projects
                .filter((project) => project.id !== draft.id)
                .map((project) => (
                  <label key={project.id}>
                    <input
                      type="checkbox"
                      checked={draft.dependsOn.includes(project.id)}
                      onChange={() =>
                        set(
                          "dependsOn",
                          draft.dependsOn.includes(project.id)
                            ? draft.dependsOn.filter((id) => id !== project.id)
                            : [...draft.dependsOn, project.id],
                        )
                      }
                    />{" "}
                    {project.name}
                  </label>
                ))
            ) : (
              <span className="wb-muted">{t("form.noPrerequisites")}</span>
            )}
          </div>
        </fieldset>
        {error && <div className="wb-inline-error">{error}</div>}
        <div className="wb-form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />} {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
function EventFormDialog({
  open,
  initial,
  projects,
  work,
  onClose,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  initial: CalendarEvent;
  projects: Project[];
  work: WorkItem[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  // The development items' milestone field is the source of truth for milestone membership.
  // Issue notes are not searched separately — membership written in two places was why this screen looked split.
  const { t } = useTranslation("workbench");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  useEffect(() => {
    if (open)
      setMemberIds(
        initial.id
          ? work
              .filter((item) => item.milestone === initial.id)
              .map((item) => item.id)
          : [],
      );
  }, [open, initial, work]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setError(null);
    }
  }, [open, initial]);
  const set = <K extends keyof CalendarEvent>(
    key: K,
    value: CalendarEvent[K],
  ) => setDraft((previous) => ({ ...previous, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      setError(t("validation.eventTitleRequired"));
      return;
    }
    setBusy(true);
    try {
      if (
        draft.kind !== "milestone" &&
        work.some((item) => item.milestone === draft.id)
      )
        throw new Error(t("validation.removeMembersFirst"));
      const saved = await sddApi.saveEvent({
        ...draft,
        title: draft.title.trim(),
        workId: draft.kind === "milestone" ? null : draft.workId,
      });
      setDraft(saved);
      if (draft.kind === "milestone") {
        // Saves each item atomically. Not a transaction wrapping the whole vault.
        for (const item of work) {
          const belongs = memberIds.includes(item.id);
          if (belongs === (item.milestone === saved.id)) continue;
          await sddApi.saveWork({
            ...item,
            milestone: belongs ? saved.id : "",
            updatedAt: new Date().toISOString(),
          });
        }
      }
      onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!draft.id) return;
    setBusy(true);
    try {
      if (work.some((item) => item.milestone === draft.id))
        throw new Error(
          t("validation.removeMembersBeforeDelete"),
        );
      await sddApi.deleteEvent(draft.id);
      onDeleted();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={draft.id ? t("form.editEvent") : t("form.addEvent")}
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          {t("form.eventName")}
          <Input
            value={draft.title}
            onChange={(event) => set("title", event.target.value)}
            autoFocus
          />
        </label>
        <label className="wb-field">
          {t("form.date")}
          <Input
            type="date"
            value={draft.date}
            onChange={(event) => setDraft((previous) => ({
              ...previous,
              date: event.target.value,
              endDate: event.target.value ? previous.endDate : null,
            }))}
            required={draft.kind !== "milestone"}
          />
        </label>
        <label className="wb-field">
          {t("form.endDate")}
          <Input
            type="date"
            value={draft.endDate ?? ""}
            disabled={!draft.date}
            onChange={(event) => set("endDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field">
          {t("form.kind")}
          <Select
            aria-label={t("form.kindAria")}
            value={draft.kind}
            onChange={(value) => set("kind", value as CalendarEvent["kind"])}
            options={EVENT_KINDS.map((kind) => ({ value: kind, label: t(`eventKind.${kind}`) }))}
          />
        </label>
        <label className="wb-field">
          {t("form.project")}
          <Select
            aria-label={t("form.eventProjectAria")}
            value={draft.projectId ?? ""}
            onChange={(value) => set("projectId", value || null)}
            options={[
              { value: "", label: t("form.linkNone") },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </label>
        {draft.kind === "milestone" ? (
          <div className="wb-field is-wide">
            <MilestoneWorkPicker
              work={work}
              selected={memberIds}
              onChange={setMemberIds}
            />
          </div>
        ) : (
          <label className="wb-field is-wide">
            {t("form.linkWork")}
            <Select
              aria-label={t("form.linkWork")}
              value={draft.workId ?? ""}
              onChange={(value) => set("workId", value || null)}
              options={[
                { value: "", label: t("form.linkNone") },
                ...work.map((item) => ({ value: item.id, label: item.title })),
              ]}
            />
          </label>
        )}
        <label className="wb-field is-wide">
          {t("form.notes")}
          <textarea
            value={draft.notes}
            onChange={(event) => set("notes", event.target.value)}
          />
        </label>
        {error && <div className="wb-inline-error">{error}</div>}
        <div className="wb-form-actions">
          {draft.id && (
            <Button
              type="button"
              variant="ghost"
              className="wb-danger-text"
              onClick={() => void remove()}
              disabled={busy}
            >
              {t("common.delete")}
            </Button>
          )}
          <span />
          <Button type="button" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />} {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
/** Whether the copilot rail stays open. A choice to collapse on a narrow screen carries into the next detail view. */
const COPILOT_PANEL_KEY = "sawhorse.workbench.copilot";
function WorkDetailDialog({
  work,
  projects,
  workflow,
  selectedArtifact,
  revealText,
  onClose,
  onArtifact,
  onReload,
  onNotice,
  onEdit,
  onFollowUp,
}: {
  work: WorkItem | null;
  projects: Project[];
  workflow?: WorkflowDefinition;
  selectedArtifact: ArtifactKind;
  revealText: string | null;
  onClose: () => void;
  onArtifact: (artifact: ArtifactKind) => void;
  onReload: () => Promise<void>;
  onNotice: (notice: Notice) => void;
  onEdit: () => void;
  onFollowUp: () => void;
}) {
  const [transitioning, setTransitioning] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(() => {
    try {
      return localStorage.getItem(COPILOT_PANEL_KEY) !== "off";
    } catch { /* Optional preference. */ }
    return true;
  });
  const [editorDirty, setEditorDirty] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const { t } = useTranslation("workbench");
  const activeNodeId = work ? activeNodeForWork(work) : null;
  useEffect(() => setReviewNote(""), [work?.id, activeNodeId]);
  if (!work) return null;
  const goalMode = work.workflowId === GOAL_WORKFLOW;
  const intentFlow = work.workflowId === INTENT_WORKFLOW;
  const closed = isClosedStatus(work.status);
  const canTransition = !closed && work.status !== "blocked";
  const actions = workActions(work, workflow);
  const currentNodeId = activeNodeId ?? work.stage;
  const nodes =
    workflow?.nodes ?? STAGES.map((id) => ({ id, label: stageText(id) }));
  const index = nodes.findIndex((node) => node.id === currentNodeId);
  const outgoing = canTransition ? workflow?.edges.filter(
    (edge) => edge.from === currentNodeId,
  ) : [];
  const previous =
    outgoing
      ?.map((edge) => edge.to)
      .find(
        (candidate) => nodes.findIndex((node) => node.id === candidate) < index,
      ) ?? (workflow ? null : index > 0 ? nodes[index - 1]?.id : null);
  const next =
    outgoing
      ?.map((edge) => edge.to)
      .find(
        (candidate) => nodes.findIndex((node) => node.id === candidate) > index,
      ) ??
    (workflow ? null : index < nodes.length - 1 ? nodes[index + 1]?.id : null);
  const transition = async (stage: Stage) => {
    if (editorDirty) {
      onNotice({
        tone: "error",
        text: t("detail.saveBeforeReview"),
      });
      return;
    }
    const targetIndex = nodes.findIndex((node) => node.id === stage);
    if (targetIndex > index && !reviewNote.trim()) {
      onNotice({
        tone: "error",
        text: t("detail.reviewNoteRequired"),
      });
      return;
    }
    setTransitioning(true);
    try {
      const edge = workflow?.edges.find(
        (candidate) =>
          candidate.from === currentNodeId && candidate.to === stage,
      );
      if (workflow && !edge)
        throw new Error(t("errors.invalidTransition"));
      if (edge) {
        await workflowApi.command({
          workId: work.id,
          event: edge.on,
          targetNodeId: stage,
          expectedNodeId: currentNodeId,
          note: reviewNote.trim() || "재검토를 위해 이전 노드로 이동",
          eventId: crypto.randomUUID(),
        });
      } else {
        await sddApi.transition(
          work.id,
          stage,
          reviewNote.trim() || "재검토를 위해 이전 단계로 이동",
        );
      }
      await onReload();
      onNotice({
        tone: "success",
        text: t("detail.transitionedToast", {
          stage: stageLabel(workflow ? [workflow] : [], stage),
        }),
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setTransitioning(false);
    }
  };
  const decide = async (action: string) => {
    if (editorDirty || !reviewNote.trim()) {
      onNotice({ tone: "error", text: t(editorDirty ? "detail.saveBeforeReview" : "detail.reviewNoteRequired") });
      return;
    }
    setTransitioning(true);
    try {
      await workflowApi.command({
        workId: work.id, event: `work:${action}`, expectedNodeId: currentNodeId,
        note: reviewNote.trim(), eventId: crypto.randomUUID(), facts: { expectedStatus: work.status },
      });
      await onReload();
      setReviewNote("");
      onNotice({ tone: "success", text: t("work.decisionSaved") });
    } catch (error) { onNotice({ tone: "error", text: errorText(error) }); }
    finally { setTransitioning(false); }
  };
  const requestClose = () => {
    if (
      !editorDirty ||
      window.confirm(t("detail.confirmClose"))
    )
      onClose();
  };
  return (
    <Dialog
      open
      onClose={requestClose}
      wide
      className={cx("wb-detail-dialog", work.workflowId === "mockup-review" && "wb-mockup-detail")}
      title={
        <div className="wb-detail-title">
          <span className={statusClass(work.status)}>
            {statusText(work.status)}
          </span>
          <span>{work.id}</span>
        </div>
      }
    >
      <div className="wb-detail">
        <div className="wb-detail-head">
          <div>
            <h2>{work.title}</h2>
            {!intentFlow && work.workflowId !== "mockup-review" && <p>
              {work.description ||
                t("detail.noDescription")}
            </p>}
          </div>
          <div className="wb-detail-actions">
            {(closed || work.stage === "maintain") && (
              <Button size="sm" variant="outline" onClick={onFollowUp}>
                <Plus /> {t("detail.followUp")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              aria-pressed={copilotOpen}
              onClick={() => {
                const next = !copilotOpen;
                setCopilotOpen(next);
                try {
                  localStorage.setItem(COPILOT_PANEL_KEY, next ? "on" : "off");
                } catch { /* Optional preference. */ }
              }}
            >
              <Bot /> {t("copilot.title")}
            </Button>
            {!goalMode && <Button size="sm" variant="outline" onClick={onEdit}>
              <FilePenLine /> {t("detail.edit")}
            </Button>}
          </div>
        </div>
        <div className="wb-detail-body">
        <div className="wb-detail-main">
        {!intentFlow && !goalMode && <div className="wb-stepper">
          {nodes.map((node, stageIndex) => (
            <button
              key={node.id}
              className={cx(
                node.id === currentNodeId && "is-current",
                stageIndex < index && "is-complete",
              )}
              onClick={() =>
                node.id !== currentNodeId &&
                outgoing?.some((edge) => edge.to === node.id) &&
                void transition(node.id)
              }
              disabled={
                transitioning || !canTransition ||
                node.id === currentNodeId ||
                (workflow
                  ? !outgoing?.some((edge) => edge.to === node.id)
                  : Math.abs(stageIndex - index) > 1)
              }
              title={
                workflow && !outgoing?.some((edge) => edge.to === node.id)
                  ? t("detail.noTransition")
                  : undefined
              }
            >
              <i>{stageIndex < index ? <Check size={11} /> : stageIndex + 1}</i>
              <span>{node.label}</span>
            </button>
          ))}
        </div>
        }
        {!intentFlow && <div className="wb-detail-meta">
          <span>
            {t("detail.project")}{" "}
            <strong>
              {projects.find((project) => project.id === work.projectId)
                ?.name ?? t("detail.none")}
            </strong>
          </span>
          <span>
            {t("detail.due")} <strong>{formatDate(work.dueDate)}</strong>
          </span>
          <span>
            {t("detail.owner")}{" "}
            <strong>{work.owner || t("detail.unassigned")}</strong>
          </span>
          {work.dependsOn.length > 0 && (
            <span>
              {t("detail.predecessorsLabel")}{" "}
              <strong>
                {t("common.nCount", { count: work.dependsOn.length })}
              </strong>
            </span>
          )}
        </div>
        }
        {goalMode ? <GoalPanel key={work.id} work={work} onReload={onReload} /> : isLifecycleV2(work) ? <LifecyclePanel key={work.id} onDirtyChange={setEditorDirty} work={work} project={projects.find((project) => project.id === work.projectId)} onReload={onReload} /> : intentFlow ? <IntentFlowPanel key={work.id} onDirtyChange={setEditorDirty} work={work} project={projects.find((project) => project.id === work.projectId)} onReload={onReload} /> : <div className="wb-detail-split">
          <ArtifactEditor
            work={work}
            workflow={workflow}
            selected={selectedArtifact}
            revealText={revealText}
            onSelect={onArtifact}
            onNotice={onNotice}
            onDirtyChange={setEditorDirty}
          />
          {!closed && !["blocked", "review"].includes(work.status) && (
          <RunLauncher
            work={work}
            workflow={workflow}
            project={
              projects.find((project) => project.id === work.projectId) ?? null
            }
            onNotice={onNotice}
          />
          )}
        </div>
        }
        {work.decisions.length > 0 && (
          <div className="wb-ledger">
            <h3>{t("detail.decisions")}</h3>
            {work.decisions
              .slice()
              .reverse()
              .map((decision, itemIndex) => (
                <div key={`${decision.at}-${itemIndex}`}>
                  <span>
                    {stageLabel(workflow ? [workflow] : [], decision.stage)}
                  </span>
                  <p>{decision.note}</p>
                  <time>{dateTimeText().format(new Date(decision.at))}</time>
                </div>
              ))}
          </div>
        )}
        {work.workflowInstanceId && (
          <RuntimeLedger instanceId={work.workflowInstanceId} revision={work.updatedAt} />
        )}
        {!closed && !intentFlow && !goalMode && <>
        <label className="wb-review-note">
          {t("detail.reviewNote")}
          <textarea
            aria-label={t("detail.reviewNote")}
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder={t("detail.reviewNotePlaceholder")}
          />
        </label>
        <div className="wb-step-actions">
          {actions.map((action) => <Button key={action} size="sm"
            variant={["accept", "start", "submit", "complete", "resume"].includes(action) ? "default" : "outline"}
            disabled={transitioning} onClick={() => void decide(action)}>
            {t(`work.actions.${action}`)}
          </Button>)}
          {!workflow && previous && (
            <Button
              variant="outline"
              size="sm"
              disabled={transitioning}
              onClick={() => void transition(previous)}
            >
              <ArrowLeft /> {t("detail.reReview")}{" "}
              {stageLabel(workflow ? [workflow] : [], previous)}
            </Button>
          )}
          <span />
          {workflow &&
            outgoing?.map((edge) => {
              const targetLabel = stageLabel(
                [workflow],
                edge.to,
                workflow.id,
                workflow.version,
              );
              return (
                <Button
                  key={`${edge.on}:${edge.to}`}
                  variant={edge.on === "approved" ? "default" : "outline"}
                  size="sm"
                  disabled={transitioning}
                  onClick={() => void transition(edge.to)}
                >
                  {transitioning ? (
                    <Loader2 className="wb-spin" />
                  ) : edge.on === "approved" ? (
                    <CircleCheck />
                  ) : (
                    <ArrowLeft />
                  )}
                  {transitionActionLabel(edge.on, targetLabel)}
                </Button>
              );
            })}
          {!workflow && next && (
            <Button
              size="sm"
              disabled={transitioning}
              onClick={() => void transition(next)}
            >
              {transitioning ? (
                <Loader2 className="wb-spin" />
              ) : (
                <>
                  {t("workflow.reviewThenNext", {
                    target: stageLabel(workflow ? [workflow] : [], next),
                  })}{" "}
                  <ArrowRight />
                </>
              )}
            </Button>
          )}
        </div>
        </>}
        </div>
        {copilotOpen && (
          <WorkCopilot
            work={work}
            project={projects.find((project) => project.id === work.projectId)}
          />
        )}
        </div>
      </div>
    </Dialog>
  );
}

function RuntimeLedger({ instanceId, revision }: { instanceId: string; revision: string }) {
  const { t } = useTranslation("workbench");
  const [instance, setInstance] = useState<WorkflowInstance | null>(null);
  const [events, setEvents] = useState<WorkflowEventRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([
      workflowApi.instance(instanceId),
      workflowApi.events(instanceId),
    ])
      .then(([nextInstance, nextEvents]) => {
        if (!alive) return;
        setInstance(nextInstance);
        setEvents(nextEvents);
      })
      .catch((reason) => alive && setError(errorText(reason)));
    return () => {
      alive = false;
    };
  }, [instanceId, revision]);
  return (
    <div className="wb-ledger">
      <h3>{t("ledger.title")}</h3>
      {error && <p className="wb-inline-error">{error}</p>}
      {instance && (
        <>
          <p className="text-xs text-muted-foreground">
            {instance.workflowId}@{instance.workflowVersion} · {instance.status}{" "}
            · {t("ledger.transitions", { count: instance.transitionCount })}
          </p>
          {instance.nodeRuns
            .slice()
            .reverse()
            .map((run) => (
              <div key={run.id}>
                <span>
                  {run.workflowId}:{run.nodeId}
                </span>
                <p>
                  {run.status} · {t("ledger.attempts", { count: run.attempt })}
                  {run.iteration > 0
                    ? ` · ${t("ledger.iterations", { count: run.iteration })}`
                    : ""}
                  {run.waitingReason ? ` · ${run.waitingReason}` : ""}
                </p>
                <time>{dateTimeText().format(new Date(run.updatedAt))}</time>
              </div>
            ))}
          {events.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("ledger.dedupedEvents", { count: events.length })}
            </p>
          )}
        </>
      )}
      {!instance && !error && (
        <p className="text-xs text-muted-foreground">
          {t("ledger.loading")}
        </p>
      )}
    </div>
  );
}
function ArtifactEditor({
  work,
  workflow,
  selected,
  revealText,
  onSelect,
  onNotice,
  onDirtyChange,
}: {
  work: WorkItem;
  workflow?: WorkflowDefinition;
  selected: ArtifactKind;
  revealText: string | null;
  onSelect: (artifact: ArtifactKind) => void;
  onNotice: (notice: Notice) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("workbench");
  const [document, setDocument] = useState<Document | null>(null);
  const [markdown, setMarkdown] = useState("");
  const [dirty, setDirty] = useState(false);
  const [feedbackDirty, setFeedbackDirty] = useState(false);
  const [previewMockup, setPreviewMockup] = useState(true);
  const isMockup = work.workflowId === "mockup-review" && selected === "mockup";
  const hasUnsavedChanges = dirty || feedbackDirty;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestMarkdown, setLatestMarkdown] = useState<string | null>(null);
  const [htmlView, setHtmlView] = useState<HtmlDocumentView | null>(null);
  const requestId = useRef(0);
  const markdownRef = useRef("");
  const setDraft = (value: string, baseline = document?.markdown ?? "") => {
    markdownRef.current = value;
    setMarkdown(value);
    setDirty(value !== baseline);
  };
  const reloadDocument = async (confirmDiscard = false) => {
    if (
      confirmDiscard &&
      hasUnsavedChanges &&
      !window.confirm(t("editor.confirmReload"))
    )
      return;
    const request = ++requestId.current;
    setBusy(true);
    setError(null);
    setLatestMarkdown(null);
    setDocument(null);
    setHtmlView(null);
    setDraft("", "");
    try {
      const next = await sddApi.readDocument(work.id, selected);
      const nextView = /\.html?$/i.test(next.path)
        ? await sddApi.readHtmlDocument(work.id, selected)
        : null;
      if (request === requestId.current) {
        setDocument(next);
        setDraft(next.markdown, next.markdown);
        setHtmlView(nextView);
      }
    } catch (e) {
      if (request === requestId.current) setError(errorText(e));
    } finally {
      if (request === requestId.current) setBusy(false);
    }
  };
  useEffect(() => {
    void reloadDocument();
    setPreviewMockup(true);
    setFeedbackDirty(false);
  }, [work.id, selected]);
  useEffect(() => {
    onDirtyChange(hasUnsavedChanges);
  }, [hasUnsavedChanges, onDirtyChange]);
  useEffect(() => {
    const protectNavigation = (event: Event) => {
      if (
        hasUnsavedChanges &&
        !window.confirm(
          t("editor.confirmNavigate"),
        )
      )
      event.preventDefault();
    };
    window.addEventListener("sawhorse:navigate", protectNavigation);
    return () =>
      window.removeEventListener("sawhorse:navigate", protectNavigation);
  }, [hasUnsavedChanges]);
  useEffect(() => {
    const protectUnload = (event: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protectUnload);
    return () => window.removeEventListener("beforeunload", protectUnload);
  }, [hasUnsavedChanges]);
  const compareLatest = async () => {
    setBusy(true);
    try {
      setLatestMarkdown(
        (await sddApi.readDocument(work.id, selected)).markdown,
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(markdownRef.current);
      onNotice({
        tone: "success",
        text: t("editor.copied"),
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    }
  };
  const save = async () => {
    if (!document) return;
    const request = requestId.current;
    const savedDocument = document;
    const submitted = markdownRef.current;
    setBusy(true);
    setError(null);
    try {
      const next = await sddApi.writeDocument(
        work.id,
        selected,
        submitted,
        savedDocument.revision,
      );
      if (request !== requestId.current) return;
      setDocument(next);
      if (markdownRef.current === submitted)
        setDraft(next.markdown, next.markdown);
      else setDirty(true);
      // Re-run the shdoc validation read so banners reflect what was saved.
      if (/\.html?$/i.test(next.path)) {
        setHtmlView(
          await sddApi
            .readHtmlDocument(work.id, selected)
            .catch(() => htmlView),
        );
      }
      onNotice({
        tone: "success",
        text: t("editor.savedToast", {
          artifact: artifactLabel(workflow, selected),
        }),
      });
    } catch (e) {
      if (request !== requestId.current) return;
      const message = errorText(e);
      setError(message);
      onNotice({
        tone: "error",
        text:
          message.includes("revision") || message.includes("충돌")
            ? t("editor.conflictNotice")
            : message,
      });
    } finally {
      if (request === requestId.current) setBusy(false);
    }
  };
  const changeArtifact = (artifact: ArtifactKind) => {
    if (
      artifact !== selected &&
      hasUnsavedChanges &&
      !window.confirm(t("editor.confirmSwitch"))
    )
      return;
    onSelect(artifact);
  };
  return (
    <section className="wb-artifact">
      <div className="wb-artifact-nav">
        {(
          workflow?.artifacts.map((artifact) => artifact.role) ?? ARTIFACTS
        ).map((artifact) => (
          <button
            key={artifact}
            className={artifact === selected ? "active" : ""}
            onClick={() => changeArtifact(artifact)}
          >
            <span>{artifactLabel(workflow, artifact)}</span>
            {work.artifacts.includes(artifact) && <Check size={13} />}
          </button>
        ))}
      </div>
      <div className="wb-editor-wrap">
        <div className="wb-editor-toolbar">
          <div>
            <FileText size={16} />
            <strong>{artifactLabel(workflow, selected)}</strong>
            <small>
              {hasUnsavedChanges ? t("editor.unsaved") : document ? t("editor.saved") : ""}
            </small>
          </div>
          {isMockup && <Button size="xs" variant="ghost" onClick={() => {
            if (feedbackDirty && !window.confirm(t("editor.confirmSwitch"))) return;
            setPreviewMockup((value) => !value);
          }}>{t(previewMockup ? "mockups:editDocument" : "mockups:preview")}</Button>}
          <Button
            size="xs"
            variant="ghost"
            aria-label={t("editor.refreshAria")}
            onClick={() => void reloadDocument(true)}
            disabled={busy}
          >
            <RefreshCw size={13} />
          </Button>
          <Button
            size="xs"
            onClick={() => void save()}
            disabled={busy || !dirty}
          >
            {busy ? <Loader2 className="wb-spin" /> : t("common.save")}
          </Button>
        </div>
        {error && (
          <div className="wb-editor-error">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button onClick={() => void compareLatest()} disabled={busy}>
              {t("editor.compareLatest")}
            </button>
            <button onClick={() => void copyDraft()}>{t("editor.copyDraft")}</button>
            <button onClick={() => void reloadDocument(true)} disabled={busy}>
              {t("editor.reload")}
            </button>
          </div>
        )}
        {latestMarkdown !== null && (
          <details className="wb-compare" open>
            <summary>{t("editor.compareSummary")}</summary>
            <pre>{latestMarkdown}</pre>
          </details>
        )}
        {busy && !document ? (
          <LoadingState />
        ) : document && isMockup && previewMockup ? (
          <MockupReview key={work.id} workId={work.id} onDirtyChange={setFeedbackDirty} onOpenWork={(workId, artifact) => {
            if (hasUnsavedChanges && !window.confirm(t("editor.confirmSwitch"))) return;
            useApp.getState().openWork({ workId, artifact });
          }} />
        ) : document && htmlView ? (
          <ShdocView
            view={htmlView}
            draft={markdown}
            busy={busy}
            dirty={dirty}
            onDraftChange={(value) => setDraft(value)}
            onSave={() => void save()}
          />
        ) : document ? (
          <div className="wb-atomic-editor">
            <AtomicCodeMirrorEditor
              documentId={`${work.id}:${selected}:${document.revision}`}
              markdownSource={markdown}
              initialRevealText={revealText}
              readOnly={busy}
              onMarkdownChange={(value) => setDraft(value)}
            />
          </div>
        ) : !error ? (
          <LoadingState />
        ) : (
          <div className="wb-editor-state">
            <AlertCircle size={20} />
            {t("editor.cannotLoad")}
          </div>
        )}
      </div>
    </section>
  );
}
function RunLauncher({
  work,
  project,
  workflow,
  onNotice,
}: {
  work: WorkItem;
  project: Project | null;
  workflow?: WorkflowDefinition;
  onNotice: (notice: Notice) => void;
}) {
  const { t } = useTranslation("workbench");
  const installedAgents = useApp((state) => state.agents).filter(
    (candidate) => candidate.detected && candidate.runsJobs,
  );
  const fallbackAgent = useApp((state) => state.defaultAgent);
  const currentNodeId = activeNodeForWork(work);
  const node = workflow?.nodes.find(
    (candidate) => candidate.id === currentNodeId,
  );
  const availableRoles = node?.allowedRoles.length
    ? node.allowedRoles
    : AGENT_ROLES;
  const roleForNode = () => roleForStageNode(currentNodeId, availableRoles);
  const [role, setRole] = useState<AgentRole>(roleForNode);
  const [agent, setAgent] = useState(project?.defaultAgent || fallbackAgent);
  const [model, setModel] = useState(project?.defaultModel ?? "");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRole(roleForNode());
    setAgent(project?.defaultAgent || fallbackAgent);
    setModel(project?.defaultModel ?? "");
  }, [project?.id, project?.defaultAgent, project?.defaultModel, fallbackAgent, currentNodeId, workflow?.id, workflow?.version]);
  // A run already holding the same work regardless of role. The host also rejects duplicate runs,
  // but the button must warn first so a person does not press twice.
  const [active, setActive] = useState<HarnessRun | null>(null);
  const syncActive = useCallback(async () => {
    try {
      const rows = await sddApi.runs();
      setActive(
        rows.find(
          (run) =>
            run.workId === work.id &&
            ACTIVE_RUN_STATUS.includes(run.status),
        ) ?? null,
      );
    } catch {
      setActive(null);
    }
  }, [work.id]);
  useEffect(() => {
    void syncActive();
    const timer = window.setInterval(() => void syncActive(), 10000);
    return () => window.clearInterval(timer);
  }, [syncActive]);

  const launch = async () => {
    setBusy(true);
    try {
      await sddApi.launch({
        workId: work.id,
        projectId: work.projectId,
        role,
        agent,
        model,
        instructions,
        parentRunId: null,
      });
      onNotice({
        tone: "success",
        text: t("launcher.queuedToast"),
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      await syncActive();
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await sddApi.stopRun(active.id);
      onNotice({ tone: "success", text: t("launcher.stoppedToast") });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      await syncActive();
      setBusy(false);
    }
  };
  return (
    <aside className="wb-run-launcher">
      <div>
        <h3>{t("launcher.title")}</h3>
        <p>{t("launcher.description")}</p>
      </div>
      <label>
        {t("launcher.role")}
        <Select
          aria-label={t("launcher.roleAria")}
          value={role}
          onChange={(value) => setRole(value as AgentRole)}
          options={availableRoles.map((key) => ({ value: key, label: roleText(key) }))}
        />
      </label>
      <label>
        {t("launcher.agent")}
        <Select
          aria-label={t("launcher.agentAria")}
          value={agent}
          onChange={setAgent}
          options={[
            ...installedAgents.map((candidate) => ({ value: candidate.id, label: candidate.name })),
            ...(agent && !installedAgents.some((candidate) => candidate.id === agent)
              ? [{ value: agent, label: agent }]
              : []),
          ]}
        />
      </label>
      <label>
        {t("launcher.model")}
        <ModelInput
          agent={agent}
          value={model}
          onValueChange={setModel}
          placeholder={t("launcher.modelPlaceholder")}
        />
        <small>{t("launcher.childModelHint")}</small>
      </label>
      <label>
        {t("launcher.instructions")}
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder={t("launcher.instructionsPlaceholder")}
        />
      </label>
      <Button
        size="sm"
        variant={active ? "secondary" : "default"}
        title={
          active
            ? t("launcher.stopHint")
            : undefined
        }
        onClick={() => void (active ? stop() : launch())}
        disabled={busy || (!active && !work.projectId)}
      >
        {busy ? (
          <Loader2 className="wb-spin" />
        ) : active ? (
          <StopCircle />
        ) : (
          <Bot />
        )}{" "}
        {active ? t("launcher.stop") : t("launcher.start")}
      </Button>
      {!work.projectId && <small>{t("launcher.needsProject")}</small>}
    </aside>
  );
}
function HarnessView({
  projectId,
  work,
  projects: _projects,
  workflows,
  onNotice,
  onSelectWork,
}: {
  projectId: string;
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  onNotice: (notice: Notice) => void;
  onSelectWork: (id: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const requestedRun = useApp((state) => state.openRunRequest);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [selected, setSelected] = useState<HarnessRun | null>(null);
  const [output, setOutput] = useState("");
  const [pollError, setPollError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  // 「herdr로 보기」 (View in herdr) needs a herdr server to show progress logs. If the probe is missing
  // or fails, assume it can open and leave it enabled — a visible failure reason beats silently blocking.
  const [viewerOk, setViewerOk] = useState(true);
  useEffect(() => {
    let alive = true;
    void vaultApi
      .herdrProbe()
      .then((diag) => {
        if (alive && diag) setViewerOk(diag.viewerOk);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const load = async () => {
    setLoading(true);
    try {
      const next = (await sddApi.runs()).filter((run) => !projectId || run.projectId === projectId);
      setRuns(next);
      setSelected((current) =>
        requestedRun
          ? (next.find((run) => run.id === requestedRun.id) ?? null)
          : current
          ? (next.find((run) => run.id === current.id) ?? null)
          : (next[0] ?? null),
      );
      if (requestedRun) useApp.getState().clearOpenRun();
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [projectId, requestedRun?.id]);
  useEffect(() => {
    let alive = true;
    let polling = false;
    const timer = window.setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const rows = (await sddApi.runs()).filter((run) => !projectId || run.projectId === projectId);
        const results = await Promise.allSettled(rows.map((run) =>
          [...ACTIVE_RUN_STATUS, "unknown"].includes(run.status) ? sddApi.refreshRun(run.id) : Promise.resolve(run)));
        if (!alive) return;
        const fresh = results.map((result, index) => result.status === "fulfilled" ? result.value : rows[index]);
        const failure = results.find((result) => result.status === "rejected");
        setPollError(failure?.status === "rejected" ? errorText(failure.reason) : null);
        setRuns(fresh);
        setSelected((current) => current ? fresh.find((run) => run.id === current.id) ?? null : fresh[0] ?? null);
      } catch (error) { if (alive) setPollError(errorText(error)); }
      finally { polling = false; }
    }, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [projectId]);
  useEffect(() => {
    if (!selected) {
      setOutput("");
      return;
    }
    let alive = true;
    sddApi
      .runOutput(selected.id)
      .then((text) => alive && setOutput(text))
      .catch(
        (e) =>
          alive &&
          setOutput(t("harness.outputReadFailed", { error: errorText(e) })),
      );
    return () => {
      alive = false;
    };
  }, [selected?.id, selected?.updatedAt]);
  const refresh = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await sddApi.refreshRun(selected.id);
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await sddApi.stopRun(selected.id);
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const continueRun = async () => {
    if (!selected || !followUp.trim()) return;
    setBusy(true);
    try {
      const next = await sddApi.continueRun(selected.id, followUp.trim());
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
      setFollowUp("");
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const resume = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await sddApi.resumeRun(selected.id);
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
      onNotice({
        tone: "success",
        text: t("harness.resumedToast"),
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await sddApi.launch({ workId: selected.workId, projectId: selected.projectId,
        role: selected.role, agent: selected.agent, model: selected.model,
        instructions: selected.instructions ?? "", parentRunId: selected.parentRunId });
      setRuns((previous) => [next, ...previous]);
      setSelected(next);
      setAttentionOnly(false);
    } catch (e) { onNotice({ tone: "error", text: errorText(e) }); }
    finally { setBusy(false); }
  };
  /** Dismisses from the needs-attention list only, without re-running. To revert, use 「다시 표시」 (Show again) in the same spot. */
  const dismiss = async (dismissed: boolean) => {
    if (!selected) return;
    // The run may have come back to life between 5-second refreshes. Then there is still something to see.
    if (dismissed && ["starting", "running"].includes(selected.status)) {
      onNotice({ tone: "error", text: t("harness.dismissRunning") });
      return;
    }
    setBusy(true);
    try {
      const next = await sddApi.dismissRun(selected.id, dismissed);
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
      onNotice({
        tone: "success",
        text: t(dismissed ? "harness.dismissedToast" : "harness.restoredToast"),
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const sendKey = async (key: string) => {
    if (!selected) return;
    setBusy(true);
    try {
      const next = await sddApi.runKey(selected.id, key);
      setSelected(next);
      setRuns((previous) =>
        previous.map((run) => (run.id === next.id ? next : run)),
      );
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const launchChild = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const item = work.find((candidate) => candidate.id === selected.workId);
      if (!item) throw new Error(t("harness.workNotFound"));
      const run = await sddApi.launch({
        workId: item.id,
        projectId: item.projectId,
        role: "research",
        agent: selected.agent,
        model: "",
        instructions: "상위 실행을 위한 조사 결과와 근거를 정리해 주세요.",
        parentRunId: selected.id,
      });
      setRuns((previous) => [run, ...previous]);
      onNotice({ tone: "success", text: t("harness.childStartedToast") });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={t("harness.title")}>
        <Button variant="outline" aria-pressed={attentionOnly} onClick={() => setAttentionOnly(!attentionOnly)}>
          {t("harness.attention")} · {attentionRuns(runs, work).length}
        </Button>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw /> {t("common.refresh")}
        </Button>
      </PageHeader>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("harness.description")}</p>
      {pollError && <div className="wb-inline-error" role="alert">{pollError}</div>}
      {loading ? (
        <LoadingState />
      ) : !runs.length ? (
        <EmptyState
          icon={SquareTerminal}
          title={t("harness.emptyTitle")}
          description={t("harness.emptyDescription")}
        />
      ) : (
        <div className="wb-harness">
          <aside className="wb-run-list">
            {attentionOnly && !attentionRuns(runs, work).length && <p>{t("harness.noAttention")}</p>}
            {(attentionOnly ? attentionRuns(runs, work) : runs).map((run) => (
              <button
                key={run.id}
                className={cx(selected?.id === run.id && "active")}
                onClick={() => setSelected(run)}
              >
                <span className={`wb-run-status is-${run.status}`} />
                <div>
                  <strong>
                    {work.find((item) => item.id === run.workId)?.title ??
                      run.workId}
                  </strong>
                  <small>
                    {t(`runStatus.${run.status}`)} · {roleText(run.role)} · {run.agentName || run.agent}
                    {run.model && ` · ${run.model}`}
                    {run.modelSelection?.source === "auto" && ` · ${t("harness.modelAuto")}`}
                  </small>
                  {run.error && <small className="wb-run-error">{run.error}</small>}
                </div>
                {run.parentRunId && <span className="wb-child-mark">↳</span>}
              </button>
            ))}
          </aside>
          {selected && (
            <section className="wb-run-detail">
              <header>
                <div>
                  <p className="wb-eyebrow">{t(`runStatus.${selected.status}`)} · {t(selected.runner === "headless" ? "harness.background" : "harness.terminal")}</p>
                  <h2>
                    {work.find((item) => item.id === selected.workId)?.title ??
                      selected.workId}
                  </h2>
                  <p>
                    {roleText(selected.role)} · {selected.agent}{" "}
                    {selected.model && `· ${selected.model}`} ·{" "}
                    {stageLabel(
                      workflows,
                      selected.stage,
                      selected.workflowId,
                      selected.workflowVersion,
                    )}
                  </p>
                  {selected.modelSelection && (
                    <p data-testid="model-selection" className="text-sm text-muted-foreground">
                      {t(`harness.modelSource.${selected.modelSelection.source}`)}
                      {selected.modelSelection.assessment && (
                        <> · {t(`harness.modelComplexity.${selected.modelSelection.assessment.complexity}`)}
                          {" — "}{selected.modelSelection.assessment.reason}</>
                      )}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {t("harness.childModelPolicy", { policy: t(`harness.childPolicy.${selected.childModelPolicy ?? "inherit"}`) })}
                  </p>
                </div>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onSelectWork(selected.workId)}
                  >
                    <FileText /> {t("harness.openWork")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refresh()}
                    disabled={busy}
                  >
                    <RefreshCw />
                  </Button>
                  {(selected.runner === "headless" || selected.paneId || (selected.tabClosedAt && selected.resumable)) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void resume()}
                      disabled={busy || !viewerOk}
                      title={viewerOk ? undefined : t("sessions:herdrViewerOff")}
                    >
                      <SquareTerminal /> {t("harness.viewHerdr")}
                    </Button>
                  )}
                  {["failed", "stopped"].includes(selected.status) && (
                    <Button variant="outline" size="sm" onClick={() => void retry()} disabled={busy}>
                      <RefreshCw /> {t("harness.retry")}
                    </Button>
                  )}
                  {["starting", "running", "blocked", "unknown"].includes(
                    selected.status,
                  ) && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void stop()}
                      disabled={busy}
                    >
                      <StopCircle /> {t("harness.stop")}
                    </Button>
                  )}
                  {selected.dismissedAt ? (
                    <Button variant="outline" size="sm" onClick={() => void dismiss(false)} disabled={busy}>
                      <Eye /> {t("harness.restore")}
                    </Button>
                  ) : ATTENTION_RUN_STATUS.includes(selected.status) && (
                    <Button variant="outline" size="sm" title={t("harness.dismissHint")} onClick={() => void dismiss(true)} disabled={busy}>
                      <X /> {t("harness.dismiss")}
                    </Button>
                  )}
                </div>
              </header>
              {selected.runner === "headless" && <p className="text-sm text-muted-foreground">{t("harness.backgroundHint")}</p>}
              {selected.error && (
                <div className="wb-inline-error">{selected.error}</div>
              )}
              <div className="wb-run-metadata">
                <span>
                  {t("harness.session")}{" "}
                  <strong>{selected.session || t("harness.noRecord")}</strong>
                </span>
                <span>
                  {t("harness.createdAt")}{" "}
                  <strong>
                    {dateTimeText().format(new Date(selected.createdAt))}
                  </strong>
                </span>
                {selected.agentSession && (
                  <span>
                    {t("harness.agentSession")}{" "}
                    <strong>{selected.agentSession}</strong>
                  </span>
                )}
                {selected.tabClosedAt && (
                  <span>
                    {t("harness.tabClosed")}{" "}
                    <strong>
                      {dateTimeText().format(new Date(selected.tabClosedAt))}
                    </strong>
                  </span>
                )}
                {selected.parentRunId && (
                  <span>
                    {t("harness.parentRun")}{" "}
                    <strong>{selected.parentRunId}</strong>
                  </span>
                )}
              </div>
              {selected.finalReport && (
                <div className="wb-run-report">
                  <strong>{t("harness.finalReport")}</strong>
                  <pre>{selected.finalReport}</pre>
                </div>
              )}
              <div className="wb-run-prompt">
                <strong>{t("harness.prompt")}</strong>
                <pre>{selected.prompt}</pre>
              </div>
              <div className="wb-output">
                <div>
                  <strong>{t("harness.output")}</strong>
                  <button
                    onClick={() =>
                      selected &&
                      void sddApi
                        .runOutput(selected.id)
                        .then(setOutput)
                        .catch(() => undefined)
                    }
                  >
                    <RefreshCw size={14} />
                  </button>
                </div>
                <pre>{output || t("harness.noOutput")}</pre>
              </div>
              {selected.status === "review" && (
                <div className="wb-followup">
                  <label>
                    {t("harness.reviewMemo")}
                    <textarea
                      aria-label={t("harness.reviewMemo")}
                      value={followUp}
                      onChange={(event) => setFollowUp(event.target.value)}
                      placeholder={t("harness.reviewMemoPlaceholder")}
                    />
                  </label>
                  <Button
                    size="sm"
                    onClick={() => void continueRun()}
                    disabled={busy || !followUp.trim()}
                  >
                    <Send /> {t("harness.sendFollowUp")}
                  </Button>
                  {selected.tabClosedAt && (
                    <small>
                      {t("harness.followUpHint")}
                    </small>
                  )}
                </div>
              )}
              {selected.status === "blocked" && selected.runner !== "headless" && (
                <div className="wb-terminal-controls">
                  <strong>{t("harness.terminalKeysTitle")}</strong>
                  <span>
                    {t("harness.terminalKeysHint")}
                  </span>
                  <div>
                    {[
                      "ArrowUp",
                      "ArrowDown",
                      "1",
                      "2",
                      "3",
                      "Enter",
                      "Escape",
                    ].map((key) => (
                      <Button
                        key={key}
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        aria-label={t("harness.terminalKeyAria", { key })}
                        onClick={() => void sendKey(key)}
                      >
                        {key === "ArrowUp"
                          ? "↑"
                          : key === "ArrowDown"
                            ? "↓"
                            : key === "Enter"
                              ? "Enter"
                              : key === "Escape"
                                ? "Esc"
                                : key}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
              <footer>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void launchChild()}
                  disabled={busy}
                >
                  <Send /> {t("harness.launchChild")}
                </Button>
                <small>{t("harness.childHint")}</small>
              </footer>
            </section>
          )}
        </div>
      )}
    </>
  );
}
