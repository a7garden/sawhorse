import {
  ChecklistWidget,
  IssuesWidget,
  JobsWidget,
  MiniAction,
  ReadingWidget,
  ScheduledTasksWidget,
  TodayActivity,
} from "@/features/dashboard/FeatureWidgets";
import OnboardingPage from "@/pages/OnboardingPage";
import { PathInput } from "@/components/ui/path-input";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FilePenLine,
  FileText,
  Filter,
  GripVertical,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  SquareTerminal,
  StopCircle,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { useApp } from "@/lib/store";
import { api as vaultApi } from "@/lib/api";
import { sddApi, workflowApi } from "./api";
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
  STATUSES,
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
import "./workbench.css";
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
/** 아직 끝나지 않은 harness 실행 상태. 중복 실행 판정과 상태 갱신이 같은 목록을 본다. */
const ACTIVE_RUN_STATUS = ["starting", "running", "blocked"];

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
const dateText = new Intl.DateTimeFormat("ko-KR", {
  month: "short",
  day: "numeric",
});
const dateTimeText = new Intl.DateTimeFormat("ko-KR", {
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
    approvalRequired: true,
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
function blankProject(): Project {
  return {
    id: "",
    name: "",
    description: "",
    repoPath: "",
    dependsOn: [],
    verifyCommands: [],
    defaultAgent: "codex",
    defaultModel: "",
    workflowId: "sdd-main",
    workflowVersion: "1.0.0",
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
  return value ? dateText.format(new Date(`${value}T00:00:00`)) : fallback;
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
    ) ?? workflows.find((definition) => definition.id === "sdd-main")
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
/** 단계별 기본 역할. 이슈 목록의 바로 실행과 상세의 실행 런처가 같은 값을 쓴다. */
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
/** 노드가 허용하는 역할 중 단계에 맞는 것을 고른다. 없으면 노드의 첫 역할이다. */
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
  // 알림은 화면 상단 토스트로 띄운다 — 페이지 레이아웃을 밀지 않는다.
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
  const work = snapshot?.work ?? [];
  const projects = snapshot?.projects ?? [];
  const workflows = snapshot?.workflows ?? [];
  const selectDocument = (
    workId: string,
    artifact?: ArtifactKind,
    snippet: string | null = null,
  ) => {
    const item = work.find((candidate) => candidate.id === workId);
    const definition = item ? workflowForWork(workflows, item) : undefined;
    setSelectedWorkId(workId);
    setSelectedArtifact(artifact ?? definition?.artifacts[0]?.role ?? "intent");
    setRevealText(snippet);
  };
  const afterSave = async (text: string) => {
    await reload();
    setNotice({ tone: "success", text });
  };
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
    ? (work.find((item) => item.id === selectedWorkId) ?? null)
    : null;
  const shared = {
    snapshot,
    work,
    projects,
    workflows,
    events: snapshot.events,
    setNotice,
    reload,
    onNewWork: () => setWorkModal(null),
    onSelectWork: selectDocument,
    onEditWork: (item: WorkItem) => setWorkModal(item),
  };
  return (
    <div className="wb-page">
      {error && (
        <div className="wb-inline-error" role="alert">
          {error}
        </div>
      )}
      {snapshot.diagnostics.length > 0 && (
        <div className="wb-diagnostics">
          <AlertCircle size={15} />{" "}
          <span>
            {t("common.diagnostics", {
              docs: snapshot.diagnostics.join(" · "),
            })}
          </span>
        </div>
      )}
      {view === "overview" && <OverviewView {...shared} />}
      {view === "board" && (
        <BoardView
          {...shared}
          onMoved={(next) =>
            next.tone === "success"
              ? void afterSave(next.text)
              : setNotice(next)
          }
        />
      )}
      {view === "issues" && (
        <IssuesView
          work={work}
          projects={projects}
          workflows={workflows}
          events={snapshot.events}
          reload={reload}
          setNotice={setNotice}
          // 이슈 화면은 처리 유형·워크플로를 미리 채운 초안을 넘긴다. 클릭
          // 이벤트가 시드 자리에 들어가지 않도록 보드와 핸들러를 나눠 둔다.
          onNewWork={(seed) => setWorkModal(seed ?? null)}
          onSelectWork={selectDocument}
          onNewMilestone={() =>
            setEventModal({ ...blankEvent(), kind: "milestone" })
          }
        />
      )}
      {view === "calendar" && (
        <CalendarView
          {...shared}
          events={snapshot.events}
          onNewEvent={() => setEventModal(null)}
          onEditEvent={(event) => setEventModal(event)}
        />
      )}
      {view === "harness" && (
        <HarnessView
          work={work}
          projects={projects}
          workflows={workflows}
          onNotice={setNotice}
          onSelectWork={selectDocument}
        />
      )}
      {view === "knowledge" && (
        <KnowledgeView
          work={work}
          projects={projects}
          onSelectWork={setSelectedWorkId}
          onJump={selectDocument}
          onNotice={setNotice}
        />
      )}
      {view === "projects" && (
        <ProjectsView
          projects={projects}
          work={work}
          workflows={workflows}
          onNew={() => setProjectModal(null)}
          onEdit={(project) => setProjectModal(project)}
        />
      )}
      <ProjectFormDialog
        open={projectModal !== undefined}
        initial={projectModal ?? blankProject()}
        projects={projects}
        workflows={workflows}
        onClose={() => setProjectModal(undefined)}
        onSaved={() => {
          setProjectModal(undefined);
          void afterSave(t("toast.projectSaved"));
        }}
      />
      <EventFormDialog
        open={eventModal !== undefined}
        initial={eventModal ?? blankEvent()}
        projects={projects}
        work={work}
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
            // 운영 관찰은 단계가 아니라 다음 항목의 입력이다. 끝나지 않는 일을
            // 단계로 두면 항목이 닫히지 않으므로, 항목 사이의 연결로 잇는다.
            dependsOn: [currentWork.id],
            description: t("work.followUpDescription", {
              title: currentWork.title,
              id: currentWork.id,
            }),
          })
        }
      />
      <WorkFormDialog
        open={workModal !== undefined}
        initial={workModal ?? blankWork()}
        projects={projects}
        work={work}
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
function OverviewView({
  work,
  projects,
  workflows,
  events,
  reload,
  onSelectWork,
  onEditWork,
}: {
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  events: CalendarEvent[];
  reload: () => Promise<void>;
  onNewWork: () => void;
  onSelectWork: (id: string) => void;
  onEditWork: (item: WorkItem) => void;
}) {
  const { t } = useTranslation("workbench");
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [busyWork, setBusyWork] = useState<string | null>(null);
  const setPage = useApp((s) => s.setPage);
  const jobs = useApp((s) => s.jobs);
  const today = isoToday();
  // 지표 위젯이 세는 재료. 어떤 카드를 켜 두었든 같은 스냅샷을 본다.
  const metricSource = { work, jobs, today };
  const open = work.filter((w) => w.status !== "done");
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
    <button className="wb-panel-link" onClick={() => setPage(page)}>
      {label} →
    </button>
  );
  // 위젯에서 바로 끝내는 한 줄짜리 변경. 상세 화면을 열지 않고 상태·기한만 움직인다.
  async function patchWork(item: WorkItem, patch: Partial<WorkItem>) {
    setBusyWork(item.id);
    try {
      await sddApi.saveWork({
        ...item,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      await reload();
    } catch {
      // 실패하면 다음 스냅샷이 원래 값을 다시 그린다
    } finally {
      setBusyWork(null);
    }
  }
  function renderWidget(id: DashboardWidgetId) {
    // 지표는 카드 한 장이 위젯 한 개다. 정의만 보고 그리므로 여기에 분기가 늘지 않는다.
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
          onClick={() => setPage(metric.page)}
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
            description={t("widgets.nextDesc")}
            action={link("board", t("widgets.openBoard"))}
          >
            {next.length ? (
              next.map((item) => (
                <WorkRow
                  key={item.id}
                  item={item}
                  project={projects.find((p) => p.id === item.projectId)}
                  workflows={workflows}
                  busy={busyWork === item.id}
                  onClick={() => onSelectWork(item.id)}
                  onEdit={() => onEditWork(item)}
                  onStatus={(status) => void patchWork(item, { status })}
                />
              ))
            ) : (
              <div className="wb-slot-empty">
                {t("widgets.nextEmpty")}
              </div>
            )}
          </SlotCard>
        );
      case "stages":
        return (
          <SlotCard
            title={t("widgets.stages")}
            action={link("board", t("widgets.openBoard"))}
          >
            <div className="wb-stage-tiles">
              {(
                workflows[0]?.nodes ??
                STAGES.map((id) => ({ id, label: stageText(id) }))
              ).map((node) => (
                <button
                  key={node.id}
                  className="wb-stage-tile"
                  onClick={() => setPage("board")}
                >
                  <span>{node.label}</span>
                  <strong>
                    {work.filter((w) => w.stage === node.id).length}
                  </strong>
                </button>
              ))}
            </div>
          </SlotCard>
        );
      case "due":
        return (
          <SlotCard
            title={t("widgets.due")}
            description={t("widgets.dueDesc")}
          >
            {due.length ? (
              due.map((item) => (
                <DueRow
                  key={item.id}
                  item={item}
                  busy={busyWork === item.id}
                  onClick={() => onSelectWork(item.id)}
                  onDefer={() =>
                    void patchWork(item, {
                      dueDate: plusDays(item.dueDate!, 1),
                    })
                  }
                  onDone={() => void patchWork(item, { status: "done" })}
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
            action={link("calendar", t("widgets.openCalendar"))}
          >
            {upcoming.length ? (
              upcoming.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
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
          <SlotCard title={t("widgets.done")}>
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
            action={link("jobs", t("widgets.openJobs"))}
          >
            <JobsWidget onOpen={() => setPage("jobs")} />
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
      case "issues":
        return (
          <SlotCard
            title={t("widgets.issues")}
            description={t("widgets.issuesDesc")}
            action={link("issues", t("widgets.openIssues"))}
          >
            <IssuesWidget
              work={work}
              onOpen={() => setPage("issues")}
              onChanged={reload}
            />
          </SlotCard>
        );
    }
  }
  return (
    <>
      <PageHeader title={t("overview.title")}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCatalogOpen(true)}
        >
          <Plus /> {t("overview.addWidgets")}
        </Button>
        <Button
          size="sm"
          variant={editing ? "default" : "outline"}
          onClick={() => setEditing(!editing)}
        >
          <SlidersHorizontal />
          {editing ? t("overview.layoutDone") : t("overview.layoutEdit")}
        </Button>
      </PageHeader>
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
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="wb-panel wb-slot-panel">
      <div className="wb-panel-title">
        <div>
          <h2>{title}</h2>
          {description && <span>{description}</span>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}
function DueRow({
  item,
  busy,
  onClick,
  onDefer,
  onDone,
}: {
  item: WorkItem;
  busy: boolean;
  onClick: () => void;
  onDefer: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation("workbench");
  const days = item.dueDate ? daysUntil(item.dueDate) : 0;
  return (
    <div className="wb-dense-row">
      <button className="wb-dense-open" onClick={onClick} title={item.title}>
        <span className={cx("wb-date-chip", days < 0 && "is-overdue")}>
          {dueChip(days)}
        </span>
        <span className="wb-dense-title">{item.title}</span>
        <span className="wb-dense-meta">{formatDate(item.dueDate)}</span>
      </button>
      <div className="wb-action-buttons">
        <MiniAction
          label={t("row.deferOneDay")}
          icon={<CalendarDays size={13} />}
          busy={busy}
          onClick={onDefer}
        />
        <MiniAction
          label={t("row.done")}
          primary
          icon={<Check size={13} />}
          busy={busy}
          onClick={onDone}
        />
      </div>
    </div>
  );
}
function EventRow({
  event,
  onClick,
}: {
  event: CalendarEvent;
  onClick: () => void;
}) {
  return (
    <button className="wb-dense-row" onClick={onClick} title={event.title}>
      <span className="wb-event-kind">{eventKindText(event.kind)}</span>
      <span className="wb-dense-title">{event.title}</span>
      <span className="wb-dense-meta">
        {formatDate(event.endDate ?? event.date)}
      </span>
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
  /** 대시보드에서 카드 한 장이 위젯 한 칸을 통째로 채울 때. */
  solo?: boolean;
  onClick?: () => void;
}) {
  const shell = cx("wb-metric", solo && "is-solo", warn && "is-warn");
  const body = (
    <>
      <div className="wb-metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </>
  );
  if (!onClick) return <div className={shell}>{body}</div>;
  return (
    <button
      type="button"
      className={cx(shell, "is-clickable")}
      onClick={onClick}
    >
      {body}
    </button>
  );
}
function WorkRow({
  item,
  project,
  workflows,
  busy,
  onClick,
  onEdit,
  onStatus,
}: {
  item: WorkItem;
  project?: Project;
  workflows: WorkflowDefinition[];
  busy: boolean;
  onClick: () => void;
  onEdit: () => void;
  onStatus: (status: WorkStatus) => void;
}) {
  const { t } = useTranslation("workbench");
  return (
    <div className="wb-work-row">
      <button className="wb-work-main" onClick={onClick}>
        <span className={statusClass(item.status)}>
          {statusText(item.status)}
        </span>
        <div>
          <strong>{item.title}</strong>
          <small>
            {project?.name ?? t("row.noProject")} ·{" "}
            {stageLabel(
              workflows,
              item.stage,
              item.workflowId,
              item.workflowVersion,
            )}
          </small>
        </div>
      </button>
      <div className="wb-row-meta">
        {item.dueDate && <span>{formatDate(item.dueDate)}</span>}
        {item.status !== "running" && item.status !== "done" && (
          <MiniAction
            label={t("row.start")}
            icon={<Play size={13} />}
            busy={busy}
            onClick={() => onStatus("running")}
          />
        )}
        {item.status !== "done" && (
          <MiniAction
            label={t("row.done")}
            primary
            icon={<Check size={13} />}
            busy={busy}
            onClick={() => onStatus("done")}
          />
        )}
        <button
          className="wb-icon-button"
          aria-label={t("row.editWork")}
          onClick={onEdit}
        >
          <MoreHorizontal size={17} />
        </button>
      </div>
    </div>
  );
}
function BoardView({
  work,
  projects,
  workflows,
  onNewWork,
  onSelectWork,
  onEditWork,
  onMoved,
}: {
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  onNewWork: () => void;
  onSelectWork: (id: string) => void;
  onEditWork: (item: WorkItem) => void;
  onMoved: (notice: Exclude<Notice, null>) => void;
}) {
  const { t } = useTranslation("workbench");
  const [filter, setFilter] = useState<"all" | Priority | "mine">("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [stageFilter, setStageFilter] = useState<"all" | Stage>("all");
  const [dragging, setDragging] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const stageOptions = Array.from(
    new Map(
      workflows
        .flatMap((definition) => definition.nodes)
        .map((node) => [node.id, node.label] as const),
    ),
  );
  const filtered = work.filter(
    (item) =>
      (filter === "all" || filter === "mine"
        ? filter === "all" || Boolean(item.owner)
        : item.priority === filter) &&
      (projectFilter === "all" || item.projectId === projectFilter) &&
      (stageFilter === "all" || item.stage === stageFilter),
  );
  const drop = async (event: DragEvent<HTMLDivElement>, status: WorkStatus) => {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/work-id") || dragging;
    setDragging(null);
    const item =
      filtered.find((candidate) => candidate.id === id) ??
      work.find((candidate) => candidate.id === id);
    if (!item || item.status === status) return;
    setMoving(item.id);
    try {
      await sddApi.saveWork({
        ...item,
        status,
        updatedAt: new Date().toISOString(),
      });
      onMoved({
        tone: "success",
        text: t("board.movedToast", {
          title: item.title,
          status: statusText(status),
        }),
      });
    } catch (e) {
      onMoved({ tone: "error", text: errorText(e) });
    } finally {
      setMoving(null);
    }
  };
  return (
    <>
      <PageHeader title={t("board.title")}>
        <div className="wb-filter">
          <Filter size={15} />
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            aria-label={t("board.filterWork")}
          >
            <option value="all">{t("board.filterAll")}</option>
            <option value="mine">{t("board.filterAssigned")}</option>
            {(["urgent", "high", "normal", "low"] as Priority[]).map(
              (priority) => (
                <option key={priority} value={priority}>
                  {priorityText(priority)}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label={t("board.filterProject")}
          >
            <option value="all">{t("board.filterAllProjects")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={stageFilter}
            onChange={(event) =>
              setStageFilter(event.target.value as "all" | Stage)
            }
            aria-label={t("board.filterStage")}
          >
            <option value="all">{t("board.filterAllStages")}</option>
            {(stageOptions.length
              ? stageOptions
              : STAGES.map((stage) => [stage, stageText(stage)] as const)
            ).map(([stage, label]) => (
              <option key={stage} value={stage}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={onNewWork}>
          <Plus /> {t("board.newWork")}
        </Button>
      </PageHeader>
      <div className="wb-board">
        {STATUSES.map((status) => {
          const items = filtered.filter((item) => item.status === status);
          return (
            <div
              key={status}
              className={cx("wb-board-column", dragging && "is-droppable")}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => void drop(event, status)}
            >
              <div className="wb-column-head">
                <span className={statusClass(status)}>
                  {statusText(status)}
                </span>
                <small>{items.length}</small>
              </div>
              <div className="wb-card-stack">
                {items.map((item) => (
                  <article
                    key={item.id}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/work-id", item.id);
                      event.dataTransfer.effectAllowed = "move";
                      setDragging(item.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    className={cx(
                      "wb-board-card",
                      dragging === item.id && "is-dragging",
                    )}
                  >
                    <div className="wb-card-top">
                      <GripVertical size={15} />
                      <span className={`wb-priority is-${item.priority}`}>
                        {priorityText(item.priority)}
                      </span>
                      {moving === item.id && (
                        <Loader2 className="wb-spin" size={14} />
                      )}
                    </div>
                    <button onClick={() => onSelectWork(item.id)}>
                      <strong>{item.title}</strong>
                      <p>
                        {item.description || t("board.descriptionPlaceholder")}
                      </p>
                    </button>
                    <footer>
                      <span>
                        {projects.find(
                          (project) => project.id === item.projectId,
                        )?.name ?? t("board.uncategorized")}
                      </span>
                      {item.dueDate && <time>{formatDate(item.dueDate)}</time>}
                      <button
                        onClick={() => onEditWork(item)}
                        aria-label={t("row.editWork")}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </footer>
                  </article>
                ))}
                {!items.length && (
                  <div className="wb-drop-hint">{t("board.dropHere")}</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
function CalendarView({
  work,
  projects,
  events,
  onNewEvent,
  onEditEvent,
  onSelectWork,
}: {
  work: WorkItem[];
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
function KnowledgeView({
  work,
  projects,
  onSelectWork,
  onJump,
  onNotice,
}: {
  work: WorkItem[];
  projects: Project[];
  onSelectWork: (id: string) => void;
  onJump: (workId: string, artifact: ArtifactKind, snippet: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const { t } = useTranslation("workbench");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const jobs = useApp((s) => s.jobs);
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [taskMatches, setTaskMatches] = useState<
    import("@/lib/types").TaskDef[]
  >([]);
  const matches = (text: string) =>
    !!submittedQuery &&
    text.toLowerCase().includes(submittedQuery.toLowerCase());
  const workMatches = work.filter((w) =>
    matches(`${w.title} ${w.description} ${w.tags.join(" ")}`),
  );
  const projectMatches = projects.filter((p) =>
    matches(`${p.name} ${p.description}`),
  );
  const jobMatches = jobs.filter((j) => matches(`${j.label} ${j.error ?? ""}`));
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [record, setRecord] = useState<{
    path: string;
    markdown: string;
  } | null>(null);
  const openHit = async (hit: SearchHit) => {
    if (hit.workId && hit.artifact) {
      onJump(hit.workId, hit.artifact, hit.snippet);
      return;
    }
    try {
      const note = await vaultApi.readVaultNote(hit.path);
      setRecord({ path: hit.path, markdown: note.markdown });
    } catch (error) {
      onNotice({ tone: "error", text: errorText(error) });
    }
  };
  const search = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim()) {
      setHits([]);
      setSubmittedQuery("");
      setTaskMatches([]);
      setSearched(false);
      return;
    }
    setBusy(true);
    try {
      const [documents, tasks] = await Promise.all([
        sddApi.search(query.trim()),
        vaultApi.listTasks().catch(() => null),
      ]);
      setHits(documents);
      setSubmittedQuery(query.trim());
      setTaskMatches(
        (tasks ? [...tasks.builtin, ...tasks.tasks] : [])
          .map((r) => r.def)
          .filter((t) =>
            `${t.title} ${t.prompt}`
              .toLowerCase()
              .includes(query.trim().toLowerCase()),
          ),
      );
      setSearched(true);
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title={t("search.title")} />
      <form className="wb-search-box" onSubmit={(event) => void search(event)}>
        <Search size={20} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder")}
          autoFocus
        />
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="wb-spin" /> : t("search.submit")}
        </Button>
      </form>
      <div className="wb-search-results">
        {!busy && (
          <>
            {workMatches.map((item) => (
              <button
                key={item.id}
                className="wb-search-hit"
                onClick={() => onSelectWork(item.id)}
              >
                <div>
                  <span>{t("search.categoryWork")}</span>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </div>
                <ChevronRight size={18} />
              </button>
            ))}
            {projectMatches.map((project) => (
              <button
                key={project.id}
                className="wb-search-hit"
                onClick={() =>
                  setRecord({
                    path: project.name,
                    markdown: `${project.description}\n\n${project.repoPath}`,
                  })
                }
              >
                <div>
                  <span>{t("search.categoryProject")}</span>
                  <strong>{project.name}</strong>
                  <p>{project.description}</p>
                </div>
              </button>
            ))}
            {taskMatches.map((task) => (
              <button
                key={task.id}
                className="wb-search-hit"
                onClick={() =>
                  setRecord({ path: task.title, markdown: task.prompt })
                }
              >
                <div>
                  <span>{t("search.categoryTask")}</span>
                  <strong>{task.title}</strong>
                  <p>{task.prompt.slice(0, 160)}</p>
                </div>
              </button>
            ))}
            {jobMatches.map((job) => (
              <button
                key={job.id}
                className="wb-search-hit"
                onClick={() =>
                  setRecord({
                    path: job.label,
                    markdown: `${job.status}\n\n${job.error ?? ""}`,
                  })
                }
              >
                <div>
                  <span>{t("search.categoryJob")}</span>
                  <strong>{job.label}</strong>
                  <p>{job.status}</p>
                </div>
              </button>
            ))}
          </>
        )}

        {busy ? (
          <LoadingState />
        ) : searched &&
          !hits.length &&
          !workMatches.length &&
          !projectMatches.length &&
          !jobMatches.length &&
          !taskMatches.length ? (
          <EmptyState
            icon={Search}
            title={t("search.emptyTitle")}
            description={t("search.emptyDescription")}
          />
        ) : (
          hits.map((hit, index) => (
            <button
              key={`${hit.path}-${index}`}
              className="wb-search-hit"
              onClick={() => void openHit(hit)}
            >
              <div>
                <span>
                  {hit.artifact
                    ? artifactText(hit.artifact)
                    : t("search.document")}
                </span>
                <strong>{hit.title}</strong>
                <p>{hit.snippet}</p>
                <small>{hit.path}</small>
              </div>
              <ChevronRight size={18} />
            </button>
          ))
        )}
      </div>
      <Dialog
        open={record !== null}
        onClose={() => setRecord(null)}
        title={record?.path}
        wide
      >
        <pre className="selectable whitespace-pre-wrap break-words text-xs leading-relaxed">
          {record?.markdown}
        </pre>
      </Dialog>
    </>
  );
}
function ProjectsView({
  projects,
  work,
  workflows,
  onNew,
  onEdit,
}: {
  projects: Project[];
  work: WorkItem[];
  workflows: WorkflowDefinition[];
  onNew: () => void;
  onEdit: (project: Project) => void;
}) {
  const { t } = useTranslation("workbench");
  const [documentProject, setDocumentProject] = useState<Project | null>(null);
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
                <div className="flex gap-2">
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
    </>
  );
}
/** 마일스톤에 넣을 개발 항목을 고른다. 소속은 항목의 `milestone` 필드에 적힌다. */
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
/**
 * 이슈 화면. 개발 칸반과 **같은 개발 항목 목록**을 요청·승인의 축으로 본다.
 * 별도의 이슈 저장소는 없다 — 여기서 승인한 값이 곧 `work/<id>/work.md` 의
 * `approve` 이고, 칸반에서 옮긴 상태가 곧 여기의 상태다.
 */
function IssuesView({
  work,
  projects,
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
  workflows: WorkflowDefinition[];
  events: CalendarEvent[];
  reload: () => Promise<void>;
  setNotice: (notice: Notice) => void;
  onNewWork: (seed?: WorkItem) => void;
  onSelectWork: (id: string) => void;
  onNewMilestone: () => void;
}) {
  const { t } = useTranslation("workbench");
  const [projectFilter, setProjectFilter] = useState("all");
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">(
    "open",
  );
  const [executionFilter, setExecutionFilter] = useState("all");
  const [milestoneFilter, setMilestoneFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
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

  // 이슈 축의 labels 와 개발 축의 tags 는 둘 다 문서에 적힌 분류다. 한 필터로 묶어 본다.
  const tagsOf = (item: WorkItem) => [
    ...new Set([...(item.labels ?? []), ...(item.tags ?? [])]),
  ];
  // 태그 후보는 태그를 뺀 나머지 조건까지 걸린 범위에서 뽑는다 — 고른 태그로 목록이 비지 않게.
  const tagPool = work.filter(
    (item) =>
      (projectFilter === "all" || item.projectId === projectFilter) &&
      (stateFilter === "all" || (item.state || "open") === stateFilter) &&
      (executionFilter === "all" || item.executionType === executionFilter) &&
      (milestoneFilter === "all" ||
        (milestoneFilter === "none"
          ? !item.milestone
          : item.milestone === milestoneFilter)),
  );
  const tagOptions = [...new Set(tagPool.flatMap(tagsOf))].sort();
  const rows = tagPool
    .filter((item) => tagFilter === "all" || tagsOf(item).includes(tagFilter))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
        a.id.localeCompare(b.id),
    );

  // 고른 태그가 다른 필터 때문에 사라지면 태그 필터를 풀어 준다.
  const tagKey = tagOptions.join("\n");
  useEffect(() => {
    if (tagFilter !== "all" && !tagKey.split("\n").includes(tagFilter))
      setTagFilter("all");
  }, [tagFilter, tagKey]);

  // 선택은 언제나 지금 보이는 행에만 걸린다. 필터를 좁히면 가려진 선택은 버린다.
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
    projects.find((project) => project.id === item.projectId)?.defaultAgent ===
    "claude"
      ? "claude"
      : "codex";
  // 끝난 항목에는 더 밟을 단계가 없다.
  const runnable = (item: WorkItem) => !isClosedStatus(item.status);

  const approve = async (item: WorkItem) => {
    setBusy(item.id);
    try {
      await sddApi.saveWork({
        ...item,
        approve: !item.approve,
        updatedAt: new Date().toISOString(),
      });
      await reload();
      setNotice({
        tone: "success",
        text: item.approve
          ? t("issues.unapprovedToast", { title: item.title })
          : t("issues.approvedToast", { title: item.title }),
      });
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  /** 선택분 일괄 승인. 이미 승인된 건은 건드리지 않는다. */
  const approveMany = async (items: WorkItem[]) => {
    const targets = items.filter((item) => !item.approve);
    if (!targets.length) return;
    setBusy("approve-many");
    try {
      for (const item of targets) {
        await sddApi.saveWork({
          ...item,
          approve: true,
          updatedAt: new Date().toISOString(),
        });
      }
      await reload();
      setNotice({
        tone: "success",
        text: t("issues.approvedManyToast", { count: targets.length }),
      });
    } catch (e) {
      setNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  };

  /** 항목의 현재 단계를 프로젝트 기본 역할·에이전트로 실행한다. */
  const launch = async (items: WorkItem[]) => {
    setBusy("launch");
    const failed: string[] = [];
    let done = 0;
    for (const item of items) {
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

  const pending = (legacy ?? []).filter((entry) => !entry.migrated);
  const movable = pending.filter((entry) => !entry.blocked);

  return (
    <>
      <PageHeader title={t("issues.title")}>
        <div className="wb-filter">
          <Filter size={15} />
          <select
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as typeof stateFilter)
            }
            aria-label={t("issues.stateAria")}
          >
            <option value="open">{t("issues.openIssues")}</option>
            <option value="closed">{t("issues.closedIssues")}</option>
            <option value="all">{t("issues.all")}</option>
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label={t("board.filterProject")}
          >
            <option value="all">{t("board.filterAllProjects")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={executionFilter}
            onChange={(event) => setExecutionFilter(event.target.value)}
            aria-label={t("issues.executionAria")}
          >
            <option value="all">{t("issues.allExecutionTypes")}</option>
            {EXECUTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {executionTypeText(type)}
              </option>
            ))}
          </select>
        </div>
        {tagOptions.length > 0 && (
          <div className="wb-filter">
            <select
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              aria-label={t("issues.tagAria")}
            >
              <option value="all">{t("issues.allTags")}</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button
          onClick={() =>
            onNewWork({
              ...blankWork(),
              executionType: "문서",
              workflowId: "issue-main",
              workflowVersion: "1.0.0",
            })
          }
        >
          <Plus /> {t("issues.register")}
        </Button>
      </PageHeader>

      <div className="wb-issue-layout">
        <aside className="wb-milestone-rail">
          <div className="wb-panel-title">
            <h2>{t("issues.milestonesHeading")}</h2>
            <Button size="sm" variant="outline" onClick={onNewMilestone}>
              {t("issues.addMilestone")}
            </Button>
          </div>
          <button
            type="button"
            className={cx(
              "wb-milestone-row",
              milestoneFilter === "all" && "is-active",
            )}
            onClick={() => setMilestoneFilter("all")}
          >
            <strong>{t("issues.allIssuesHeading")}</strong>
            <small>{t("issues.nCount", { count: work.length })}</small>
          </button>
          <button
            type="button"
            className={cx(
              "wb-milestone-row",
              milestoneFilter === "none" && "is-active",
            )}
            onClick={() => setMilestoneFilter("none")}
          >
            <strong>{t("issues.noMilestone")}</strong>
            <small>
              {t("issues.nCount", {
                count: work.filter((item) => !item.milestone).length,
              })}
            </small>
          </button>
          {milestones.map((event) => {
            const members = work.filter((item) => item.milestone === event.id);
            const closed = members.filter(
              (item) => (item.state || "open") === "closed",
            ).length;
            // 진행률은 구성 항목의 닫힘 비율이다. 손으로 적는 값이 아니다.
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
        </aside>
        <div className="wb-issue-main">
          {selectedRows.length > 0 && (
            <div className="wb-bulk-bar">
              <strong>{t("issues.nSelected", { count: selectedRows.length })}</strong>
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
                variant="outline"
                disabled={
                  busy !== null || selectedRows.every((item) => item.approve)
                }
                onClick={() => void approveMany(selectedRows)}
              >
                {busy === "approve-many" && <Loader2 className="wb-spin" />}
                {t("issues.approveSelected")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds([])}
              >
                {t("issues.clearSelection")}
              </Button>
            </div>
          )}
          {rows.length ? (
            <table className="wb-issue-table">
              <thead>
                <tr>
                  <th className="wb-issue-check">
                    <input
                      type="checkbox"
                      checked={allChecked}
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
                  <th>ID</th>
                  <th>{t("issues.colTitle")}</th>
                  <th>{t("issues.colType")}</th>
                  <th>{t("issues.colRun")}</th>
                  <th>{t("issues.colMilestone")}</th>
                  <th>{t("issues.colPriority")}</th>
                  <th>{t("issues.colStatus")}</th>
                  <th>{t("issues.colStageRun")}</th>
                  <th>{t("issues.colApprove")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id} onClick={() => onSelectWork(item.id)}>
                    <td
                      className="wb-issue-check"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedSet.has(item.id)}
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
                    <td className="wb-issue-id">{item.id}</td>
                    <td>
                      <strong>{item.title}</strong>
                      {item.labels.length > 0 && (
                        <small> {item.labels.join(" · ")}</small>
                      )}
                    </td>
                    <td>{issueTypeText(item.issueType)}</td>
                    <td>{executionTypeText(item.executionType)}</td>
                    <td>
                      {item.milestone ? milestoneName(item.milestone) : "-"}
                    </td>
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
                        <span className="wb-muted">-</span>
                      )}
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      <Button
                        size="sm"
                        variant={item.approve ? "success" : "outline"}
                        disabled={busy !== null}
                        onClick={() => void approve(item)}
                        title={
                          item.approve
                            ? t("issues.approvedOn", {
                                date: item.approved || t("issues.noRecord"),
                              })
                            : t("issues.approveHint")
                        }
                      >
                        {item.approve ? t("issues.approved") : t("issues.approve")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title={t("issues.emptyTitle")}
              description={t("issues.emptyDescription")}
              action={
                <Button onClick={() => onNewWork()}>
                  <Plus /> {t("issues.register")}
                </Button>
              }
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
                  {agentOf(item) === "claude" ? "Claude" : "Codex"}
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
          <select
            aria-label={t("form.project")}
            value={draft.projectId}
            onChange={(event) => set("projectId", event.target.value)}
          >
            <option value="">{t("form.linkNone")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
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
          {t("form.status")}
          <select
            aria-label={t("form.status")}
            value={draft.status}
            onChange={(event) =>
              set("status", event.target.value as WorkStatus)
            }
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {statusText(status)}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          {t("form.priority")}
          <select
            aria-label={t("form.priority")}
            value={draft.priority}
            onChange={(event) =>
              set("priority", event.target.value as Priority)
            }
          >
            {(["urgent", "high", "normal", "low"] as Priority[]).map(
              (priority) => (
                <option key={priority} value={priority}>
                  {priorityText(priority)}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="wb-field">
          {t("form.type")}
          <select
            aria-label={t("form.type")}
            value={draft.issueType}
            onChange={(event) => set("issueType", event.target.value)}
          >
            {ISSUE_TYPES.map((type) => (
              <option key={type} value={type}>
                {issueTypeText(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          {t("form.executionType")}
          <select
            aria-label={t("form.executionType")}
            value={draft.executionType}
            onChange={(event) => set("executionType", event.target.value)}
          >
            {EXECUTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {executionTypeText(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          {t("form.milestone")}
          <select
            aria-label={t("form.milestone")}
            value={draft.milestone}
            onChange={(event) => set("milestone", event.target.value)}
          >
            <option value="">{t("form.noMilestone")}</option>
            {events
              .filter((event) => event.kind === "milestone")
              .map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
          </select>
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
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(initial);
      setError(null);
    }
  }, [open, initial]);
  const set = <K extends keyof Project>(key: K, value: Project[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) {
      setError(t("validation.projectNameRequired"));
      return;
    }
    setBusy(true);
    try {
      await sddApi.saveProject({
        ...draft,
        name: draft.name.trim(),
        verifyCommands: draft.verifyCommands.filter(Boolean),
      });
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
        <label className="wb-field is-wide">
          {t("form.description")}
          <textarea
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder={t("form.descriptionPlaceholder")}
          />
        </label>
        <label className="wb-field is-wide">
          {t("form.repoPath")}
          <PathInput
            aria-label={t("form.repoPathAria")}
            value={draft.repoPath}
            onValueChange={(value) => set("repoPath", value)}
            placeholder="/path/to/repository"
          />
        </label>
        <label className="wb-field">
          {t("form.defaultAgent")}
          <select
            aria-label={t("form.defaultAgent")}
            value={draft.defaultAgent}
            onChange={(event) => set("defaultAgent", event.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label className="wb-field">
          {t("form.defaultModel")}
          <Input
            value={draft.defaultModel}
            onChange={(event) => set("defaultModel", event.target.value)}
            placeholder={t("form.optional")}
          />
        </label>
        <label className="wb-field is-wide">
          {t("form.workflow")}
          <select
            aria-label={t("form.workflowAria")}
            value={`${draft.workflowId}@${draft.workflowVersion}`}
            onChange={(event) => {
              const selected = workflows.find(
                (definition) =>
                  `${definition.id}@${definition.version}` ===
                  event.target.value,
              );
              if (selected)
                setDraft((previous) => ({
                  ...previous,
                  workflowId: selected.id,
                  workflowVersion: selected.version,
                }));
            }}
          >
            {workflows.map((definition) => (
              <option
                key={`${definition.id}@${definition.version}`}
                value={`${definition.id}@${definition.version}`}
              >
                {definition.label} · v{definition.version}
              </option>
            ))}
          </select>
          <small className="wb-muted">
            {t("form.workflowHint")}
          </small>
        </label>
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
        </label>
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
  // 마일스톤 구성원은 개발 항목의 milestone 필드가 정본이다. 이슈 노트를 따로
  // 뒤지지 않는다 — 두 곳에 소속이 적히던 것이 이 화면이 갈라져 보이던 이유였다.
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
        // 각 항목을 원자적으로 저장한다. 볼트 전체를 감싸는 트랜잭션은 아니다.
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
            onChange={(event) => set("date", event.target.value)}
            required
          />
        </label>
        <label className="wb-field">
          {t("form.endDate")}
          <Input
            type="date"
            value={draft.endDate ?? ""}
            onChange={(event) => set("endDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field">
          {t("form.kind")}
          <select
            aria-label={t("form.kindAria")}
            value={draft.kind}
            onChange={(event) =>
              set("kind", event.target.value as CalendarEvent["kind"])
            }
          >
            {EVENT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`eventKind.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          {t("form.project")}
          <select
            aria-label={t("form.eventProjectAria")}
            value={draft.projectId ?? ""}
            onChange={(event) => set("projectId", event.target.value || null)}
          >
            <option value="">{t("form.linkNone")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
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
            <select
              aria-label={t("form.linkWork")}
              value={draft.workId ?? ""}
              onChange={(event) => set("workId", event.target.value || null)}
            >
              <option value="">{t("form.linkNone")}</option>
              {work.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
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
  const [editorDirty, setEditorDirty] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const { t } = useTranslation("workbench");
  const activeNodeId = work ? activeNodeForWork(work) : null;
  useEffect(() => setReviewNote(""), [work?.id, activeNodeId]);
  if (!work) return null;
  const currentNodeId = activeNodeId ?? work.stage;
  const nodes =
    workflow?.nodes ?? STAGES.map((id) => ({ id, label: stageText(id) }));
  const index = nodes.findIndex((node) => node.id === currentNodeId);
  const outgoing = workflow?.edges.filter(
    (edge) => edge.from === currentNodeId,
  );
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
      className="wb-detail-dialog"
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
            <p>
              {work.description ||
                t("detail.noDescription")}
            </p>
          </div>
          <div className="wb-detail-actions">
            {work.workflowId === "sdd-main" && work.stage === "maintain" && (
              <Button size="sm" variant="outline" onClick={onFollowUp}>
                <Plus /> {t("detail.followUp")}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onEdit}>
              <FilePenLine /> {t("detail.edit")}
            </Button>
          </div>
        </div>
        <div className="wb-stepper">
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
                transitioning ||
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
        <div className="wb-detail-meta">
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
        <div className="wb-detail-split">
          <ArtifactEditor
            work={work}
            workflow={workflow}
            selected={selectedArtifact}
            revealText={revealText}
            onSelect={onArtifact}
            onNotice={onNotice}
            onDirtyChange={setEditorDirty}
          />
          <RunLauncher
            work={work}
            workflow={workflow}
            project={
              projects.find((project) => project.id === work.projectId) ?? null
            }
            onNotice={onNotice}
          />
        </div>
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
                  <time>{dateTimeText.format(new Date(decision.at))}</time>
                </div>
              ))}
          </div>
        )}
        {work.workflowInstanceId && (
          <RuntimeLedger instanceId={work.workflowInstanceId} />
        )}
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
      </div>
    </Dialog>
  );
}

function RuntimeLedger({ instanceId }: { instanceId: string }) {
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
  }, [instanceId]);
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
                <time>{dateTimeText.format(new Date(run.updatedAt))}</time>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latestMarkdown, setLatestMarkdown] = useState<string | null>(null);
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
      dirty &&
      !window.confirm(t("editor.confirmReload"))
    )
      return;
    const request = ++requestId.current;
    setBusy(true);
    setError(null);
    setLatestMarkdown(null);
    setDocument(null);
    setDraft("", "");
    try {
      const next = await sddApi.readDocument(work.id, selected);
      if (request === requestId.current) {
        setDocument(next);
        setDraft(next.markdown, next.markdown);
      }
    } catch (e) {
      if (request === requestId.current) setError(errorText(e));
    } finally {
      if (request === requestId.current) setBusy(false);
    }
  };
  useEffect(() => {
    void reloadDocument();
  }, [work.id, selected]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    const protectNavigation = (event: Event) => {
      if (
        dirty &&
        !window.confirm(
          t("editor.confirmNavigate"),
        )
      )
      event.preventDefault();
    };
    window.addEventListener("sawhorse:navigate", protectNavigation);
    return () =>
      window.removeEventListener("sawhorse:navigate", protectNavigation);
  }, [dirty]);
  useEffect(() => {
    const protectUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protectUnload);
    return () => window.removeEventListener("beforeunload", protectUnload);
  }, [dirty]);
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
      dirty &&
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
              {dirty ? t("editor.unsaved") : document ? t("editor.saved") : ""}
            </small>
          </div>
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
  const currentNodeId = activeNodeForWork(work);
  const node = workflow?.nodes.find(
    (candidate) => candidate.id === currentNodeId,
  );
  const availableRoles = node?.allowedRoles.length
    ? node.allowedRoles
    : AGENT_ROLES;
  const roleForNode = () => roleForStageNode(currentNodeId, availableRoles);
  const [role, setRole] = useState<AgentRole>(roleForNode);
  const [agent, setAgent] = useState<"codex" | "claude">(
    project?.defaultAgent === "claude" ? "claude" : "codex",
  );
  const [model, setModel] = useState(project?.defaultModel ?? "");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRole(roleForNode());
    setAgent(project?.defaultAgent === "claude" ? "claude" : "codex");
    setModel(project?.defaultModel ?? "");
  }, [project?.id, currentNodeId, workflow?.id, workflow?.version]);
  // 같은 항목·같은 역할로 이미 돌고 있는 실행. 호스트도 중복 실행을 거절하지만,
  // 버튼이 먼저 알려 줘야 사람이 두 번 누르지 않는다.
  const [active, setActive] = useState<HarnessRun | null>(null);
  const syncActive = useCallback(async () => {
    try {
      const rows = await sddApi.runs();
      setActive(
        rows.find(
          (run) =>
            run.workId === work.id &&
            run.role === role &&
            !run.parentRunId &&
            ACTIVE_RUN_STATUS.includes(run.status),
        ) ?? null,
      );
    } catch {
      setActive(null);
    }
  }, [work.id, role]);
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
        <select
          aria-label={t("launcher.roleAria")}
          value={role}
          onChange={(event) => setRole(event.target.value as AgentRole)}
        >
          {availableRoles.map((key) => (
            <option key={key} value={key}>
              {roleText(key)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("launcher.agent")}
        <select
          aria-label={t("launcher.agentAria")}
          value={agent}
          onChange={(event) =>
            setAgent(event.target.value as "codex" | "claude")
          }
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      <label>
        {t("launcher.model")}
        <Input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder={t("launcher.modelPlaceholder")}
        />
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
  work,
  projects: _projects,
  workflows,
  onNotice,
  onSelectWork,
}: {
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  onNotice: (notice: Notice) => void;
  onSelectWork: (id: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<HarnessRun | null>(null);
  const [output, setOutput] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const next = await sddApi.runs();
      setRuns(next);
      setSelected((current) =>
        current
          ? (next.find((run) => run.id === current.id) ?? null)
          : (next[0] ?? null),
      );
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!runs.some((run) => ACTIVE_RUN_STATUS.includes(run.status))) return;
    const timer = window.setInterval(() => {
      void Promise.all(
        runs
          .filter((run) => ACTIVE_RUN_STATUS.includes(run.status))
          .map((run) => sddApi.refreshRun(run.id)),
      )
        .then((fresh) => {
          setRuns((previous) =>
            previous.map(
              (run) => fresh.find((next) => next.id === run.id) ?? run,
            ),
          );
          setSelected((current) =>
            current
              ? (fresh.find((next) => next.id === current.id) ?? current)
              : current,
          );
        })
        .catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [runs]);
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
  }, [selected?.id]);
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
        agent: selected.agent === "claude" ? "claude" : "codex",
        model: selected.model,
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
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw /> {t("common.refresh")}
        </Button>
      </PageHeader>
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
            {runs.map((run) => (
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
                    {roleText(run.role)} · {run.agentName || run.agent}
                  </small>
                </div>
                {run.parentRunId && <span className="wb-child-mark">↳</span>}
              </button>
            ))}
          </aside>
          {selected && (
            <section className="wb-run-detail">
              <header>
                <div>
                  <p className="wb-eyebrow">{selected.status.toUpperCase()}</p>
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
                  {selected.tabClosedAt && selected.resumable && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void resume()}
                      disabled={busy}
                    >
                      <SquareTerminal /> {t("harness.resume")}
                    </Button>
                  )}
                  {["starting", "running", "blocked"].includes(
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
                </div>
              </header>
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
                    {dateTimeText.format(new Date(selected.createdAt))}
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
                      {dateTimeText.format(new Date(selected.tabClosedAt))}
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
              {selected.status === "blocked" && (
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
