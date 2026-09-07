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
  type HarnessRun,
  type IssueMigrationItem,
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

const roleLabels: Record<AgentRole, string> = {
  research: "조사",
  planner: "계획",
  implementer: "구현",
  verifier: "검증",
  reviewer: "리뷰",
};
const eventLabels: Record<CalendarEvent["kind"], string> = {
  milestone: "마일스톤",
  review: "리뷰",
  release: "릴리스",
  meeting: "회의",
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
  if (days === 0) return "오늘";
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
function formatDate(value: string | null, fallback = "날짜 없음") {
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
    STAGE_LABELS[stage] ??
    stage
  );
}
function transitionActionLabel(event: string, targetLabel: string) {
  switch (event) {
    case "approved":
      return targetLabel === "완료"
        ? "승인하고 완료"
        : `검토 후 다음: ${targetLabel}`;
    case "changes-requested":
    case "revise":
      return "수정 요청";
    case "revised":
      return `개정 완료: ${targetLabel}`;
    case "rejected":
      return "반려";
    case "cancelled":
      return "취소";
    default:
      return `검토 후 다음: ${targetLabel}`;
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
      ?.label ??
    ARTIFACT_LABELS[artifact] ??
    artifact
  );
}
function LoadingState() {
  return (
    <div className="wb-loading">
      <Loader2 size={20} className="wb-spin" /> 작업공간을 불러오는 중입니다…
    </div>
  );
}
function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="wb-empty">
      <AlertCircle size={28} />
      <strong>작업공간을 불러오지 못했습니다</strong>
      <span>{error}</span>
      <Button variant="outline" size="sm" onClick={retry}>
        <RefreshCw /> 다시 시도
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
          setNotice({ tone: "success", text: "SDD 작업공간을 준비했습니다." });
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
            일부 문서를 읽지 못했습니다: {snapshot.diagnostics.join(" · ")}
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
          void afterSave("프로젝트를 저장했습니다.");
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
          void afterSave("일정을 저장했습니다.");
        }}
        onDeleted={() => {
          setEventModal(undefined);
          void afterSave("일정을 삭제했습니다.");
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
            title: `${currentWork.title} 후속 의도`,
            projectId: currentWork.projectId,
            // 운영 관찰은 단계가 아니라 다음 항목의 입력이다. 끝나지 않는 일을
            // 단계로 두면 항목이 닫히지 않으므로, 항목 사이의 연결로 잇는다.
            dependsOn: [currentWork.id],
            description: `“${currentWork.title}”의 회고를 바탕으로 다음 의도를 정리합니다.\n\n앞선 항목: work/${currentWork.id}/`,
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
            item.id ? "개발 항목을 저장했습니다." : "개발 항목을 만들었습니다.",
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
          프로젝트의 맥락을
          <br />한 곳에 쌓아보세요.
        </h1>
        <p>
          아직 SDD 작업공간이 준비되지 않았습니다. 초기화하면 기존 파일을
          건드리지 않고 표준 폴더만 추가합니다.
        </p>
        {error && <div className="wb-inline-error">{error}</div>}
        <Button onClick={() => void initialize()} disabled={busy}>
          {busy ? <Loader2 className="wb-spin" /> : <Plus />} 작업공간 초기화
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
          label={metric.label}
          value={value}
          hint={metric.hint}
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
            title="오늘 활동"
            description={today}
            action={link("calendar", "캘린더 열기")}
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
            title="다음 개발 항목"
            description="기한과 우선순위순"
            action={link("board", "개발 보드")}
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
                개발 보드에서 첫 항목을 추가하세요.
              </div>
            )}
          </SlotCard>
        );
      case "stages":
        return (
          <SlotCard title="단계별 맥락" action={link("board", "개발 보드")}>
            <div className="wb-stage-tiles">
              {(
                workflows[0]?.nodes ??
                STAGES.map((id) => ({ id, label: STAGE_LABELS[id] }))
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
            title="기한 임박"
            description="지난 것 포함 일주일 안에 마감"
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
                기한이 임박한 개발 항목이 없습니다.
              </div>
            )}
          </SlotCard>
        );
      case "events":
        return (
          <SlotCard title="임박 일정" action={link("calendar", "캘린더 열기")}>
            {upcoming.length ? (
              upcoming.map((event) => (
                <EventRow
                  key={event.id}
                  event={event}
                  onClick={() => setPage("calendar")}
                />
              ))
            ) : (
              <div className="wb-slot-empty">등록된 일정이 없습니다.</div>
            )}
          </SlotCard>
        );
      case "done":
        return (
          <SlotCard title="최근 완료">
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
                아직 완료한 개발 항목이 없습니다.
              </div>
            )}
          </SlotCard>
        );
      case "jobs":
        return (
          <SlotCard title="실행 현황" action={link("jobs", "실행 기록")}>
            <JobsWidget onOpen={() => setPage("jobs")} />
          </SlotCard>
        );
      case "schedules":
        return (
          <SlotCard title="예약과 반복" action={link("tasks", "예약 관리")}>
            <ScheduledTasksWidget />
          </SlotCard>
        );
      case "checklist":
        return (
          <SlotCard title="할 일" action={link("todos", "일지 열기")}>
            <ChecklistWidget onOpen={() => setPage("todos")} />
          </SlotCard>
        );
      case "reading":
        return (
          <SlotCard title="읽을거리" action={link("reading", "읽을거리 열기")}>
            <ReadingWidget onOpen={() => setPage("reading")} />
          </SlotCard>
        );
      case "issues":
        return (
          <SlotCard
            title="이슈"
            description="막대를 눌러 상태별로 좁힐 수 있습니다"
            action={link("issues", "이슈 열기")}
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
      <PageHeader title="작업대">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCatalogOpen(true)}
        >
          <Plus /> 위젯 추가
        </Button>
        <Button
          size="sm"
          variant={editing ? "default" : "outline"}
          onClick={() => setEditing(!editing)}
        >
          <SlidersHorizontal />
          {editing ? "배치 완료" : "배치 편집"}
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
          label="하루 미루기"
          icon={<CalendarDays size={13} />}
          busy={busy}
          onClick={onDefer}
        />
        <MiniAction
          label="완료"
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
      <span className="wb-event-kind">{eventLabels[event.kind]}</span>
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
  return (
    <div className="wb-work-row">
      <button className="wb-work-main" onClick={onClick}>
        <span className={statusClass(item.status)}>
          {STATUS_LABELS[item.status]}
        </span>
        <div>
          <strong>{item.title}</strong>
          <small>
            {project?.name ?? "프로젝트 없음"} ·{" "}
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
            label="시작"
            icon={<Play size={13} />}
            busy={busy}
            onClick={() => onStatus("running")}
          />
        )}
        {item.status !== "done" && (
          <MiniAction
            label="완료"
            primary
            icon={<Check size={13} />}
            busy={busy}
            onClick={() => onStatus("done")}
          />
        )}
        <button
          className="wb-icon-button"
          aria-label="개발 항목 편집"
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
        text: `“${item.title}”을(를) ${STATUS_LABELS[status]}으로 옮겼습니다.`,
      });
    } catch (e) {
      onMoved({ tone: "error", text: errorText(e) });
    } finally {
      setMoving(null);
    }
  };
  return (
    <>
      <PageHeader title="개발">
        <div className="wb-filter">
          <Filter size={15} />
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            aria-label="개발 항목 필터"
          >
            <option value="all">모든 항목</option>
            <option value="mine">담당자 있음</option>
            {(["urgent", "high", "normal", "low"] as Priority[]).map(
              (priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label="프로젝트 필터"
          >
            <option value="all">모든 프로젝트</option>
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
            aria-label="단계 필터"
          >
            <option value="all">모든 단계</option>
            {(stageOptions.length
              ? stageOptions
              : STAGES.map((stage) => [stage, STAGE_LABELS[stage]] as const)
            ).map(([stage, label]) => (
              <option key={stage} value={stage}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={onNewWork}>
          <Plus /> 새 개발 항목
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
                  {STATUS_LABELS[status]}
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
                        {PRIORITY_LABELS[item.priority]}
                      </span>
                      {moving === item.id && (
                        <Loader2 className="wb-spin" size={14} />
                      )}
                    </div>
                    <button onClick={() => onSelectWork(item.id)}>
                      <strong>{item.title}</strong>
                      <p>
                        {item.description || "설명을 추가해 맥락을 남겨보세요."}
                      </p>
                    </button>
                    <footer>
                      <span>
                        {projects.find(
                          (project) => project.id === item.projectId,
                        )?.name ?? "미분류"}
                      </span>
                      {item.dueDate && <time>{formatDate(item.dueDate)}</time>}
                      <button
                        onClick={() => onEditWork(item)}
                        aria-label="개발 항목 편집"
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </footer>
                  </article>
                ))}
                {!items.length && (
                  <div className="wb-drop-hint">여기로 옮기기</div>
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
      <PageHeader title="캘린더">
        <div className="wb-segment">
          <button
            className={!agenda ? "active" : ""}
            onClick={() => setAgenda(false)}
          >
            월
          </button>
          <button
            className={agenda ? "active" : ""}
            onClick={() => setAgenda(true)}
          >
            목록
          </button>
        </div>
        <Button onClick={onNewEvent}>
          <Plus /> 일정 추가
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
                        ? eventLabels[entry.event.kind]
                        : "개발 항목 기한"}
                      {isEvent && entry.event.projectId
                        ? ` · ${projects.find((p) => p.id === entry.event.projectId)?.name ?? "프로젝트"}`
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
              title="표시할 일정이 없습니다"
              description="마일스톤이나 리뷰 일정을 추가해 보세요."
              action={
                <Button size="sm" onClick={onNewEvent}>
                  <Plus /> 일정 추가
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
              {year}년 {month + 1}월
            </strong>
            <button className="wb-today" onClick={() => setCursor(new Date())}>
              오늘
            </button>
          </div>
          <div className="wb-calendar-week">
            {["일", "월", "화", "수", "목", "금", "토"].map((day) => (
              <span key={day}>{day}</span>
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
                    <small>+{dayEvents.length + dayDue.length - 2}개</small>
                  )}
                  {dayEvents.length + dayDue.length > 0 && (
                    <div
                      className="wb-day-load"
                      aria-label={`${dayEvents.length + dayDue.length}건`}
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
      <PageHeader title="검색" />
      <form className="wb-search-box" onSubmit={(event) => void search(event)}>
        <Search size={20} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="문서와 개발 항목을 검색하세요"
          autoFocus
        />
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="wb-spin" /> : "검색"}
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
                  <span>개발 항목</span>
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
                  <span>프로젝트</span>
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
                  <span>자동화 작업</span>
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
                  <span>실행 기록</span>
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
            title="일치하는 문서가 없습니다"
            description="다른 단어로 검색해 보세요."
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
                    ? (ARTIFACT_LABELS[hit.artifact] ?? hit.artifact)
                    : "문서"}
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
      <PageHeader title="프로젝트">
        <Button onClick={onNew}>
          <Plus /> 프로젝트 추가
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
                  aria-label="프로젝트 편집"
                >
                  <MoreHorizontal size={17} />
                </button>
              </div>
              <h2>{project.name}</h2>
              <p>{project.description || "프로젝트 설명이 아직 없습니다."}</p>
              <div className="wb-project-card-meta">
                <span>
                  {work.filter((item) => item.projectId === project.id).length}
                  개 항목
                </span>
                <span>{project.dependsOn.length}개 선행</span>
                <span>
                  {workflowForProject(workflows, project)?.label ??
                    `${project.workflowId}@${project.workflowVersion}`}
                </span>
              </div>
              <footer className="space-y-3">
                <span className="block truncate">
                  {project.repoPath || "저장소 경로 없음"}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDocumentProject(project)}
                  >
                    자료로 문서 만들기
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(project)}
                  >
                    프로젝트 설정
                  </Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="첫 프로젝트를 등록하세요"
          description="개발 항목을 저장소·검증 절차와 함께 관리할 수 있습니다."
          action={
            <Button onClick={onNew}>
              <Plus /> 프로젝트 추가
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
  const [query, setQuery] = useState("");
  const visible = work.filter((item) =>
    `${item.id} ${item.title}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="wb-milestone-picker">
      <div className="wb-milestone-picker-head">
        <span>포함할 이슈</span>
        <span>{selected.length}개 선택</span>
      </div>
      <Input
        aria-label="마일스톤 이슈 검색"
        placeholder="이슈 검색"
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
                {item.id} · {item.executionType}
                {item.milestone && !selected.includes(item.id)
                  ? " · 다른 마일스톤 소속"
                  : ""}
              </small>
            </span>
          </label>
        ))}
        {visible.length === 0 && (
          <p className="wb-muted">조건에 맞는 개발 항목이 없습니다.</p>
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
          ? `“${item.title}” 승인을 해제했습니다.`
          : `“${item.title}”을(를) 승인했습니다.`,
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
        text: `${targets.length}건을 승인했습니다.`,
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
            text: `${done}건 실행, ${failed.length}건 실패: ${failed.join(" · ")}`,
          }
        : {
            tone: "success",
            text: `${done}건을 실행 큐에 추가했습니다. 실행 화면에서 상태를 확인하세요.`,
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
              text: `${report.migrated.length}건 이관, ${report.skipped.length}건 보류: ${report.skipped
                .map((entry) => `${entry.issueId} ${entry.blocked}`)
                .join(" · ")}`,
            }
          : {
              tone: "success",
              text: `이슈 노트 ${report.migrated.length}건을 개발 항목으로 옮겼습니다.`,
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
      <PageHeader title="이슈">
        <div className="wb-filter">
          <Filter size={15} />
          <select
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as typeof stateFilter)
            }
            aria-label="열림 상태"
          >
            <option value="open">열린 이슈</option>
            <option value="closed">닫힌 이슈</option>
            <option value="all">전체</option>
          </select>
        </div>
        <div className="wb-filter">
          <select
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
            aria-label="프로젝트 필터"
          >
            <option value="all">모든 프로젝트</option>
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
            aria-label="처리 유형 필터"
          >
            <option value="all">모든 처리 유형</option>
            {EXECUTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
        {tagOptions.length > 0 && (
          <div className="wb-filter">
            <select
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              aria-label="태그 필터"
            >
              <option value="all">모든 태그</option>
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
          <Plus /> 이슈 등록
        </Button>
      </PageHeader>

      <div className="wb-issue-layout">
        <aside className="wb-milestone-rail">
          <div className="wb-panel-title">
            <h2>마일스톤</h2>
            <Button size="sm" variant="outline" onClick={onNewMilestone}>
              마일스톤 추가
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
            <strong>전체 이슈</strong>
            <small>{work.length}건</small>
          </button>
          <button
            type="button"
            className={cx(
              "wb-milestone-row",
              milestoneFilter === "none" && "is-active",
            )}
            onClick={() => setMilestoneFilter("none")}
          >
            <strong>소속 없음</strong>
            <small>{work.filter((item) => !item.milestone).length}건</small>
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
                  {closed}/{members.length} 완료
                </small>
                <span
                  className="wb-milestone-bar"
                  role="progressbar"
                  aria-label={`${event.title} 진행률`}
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
              <strong>{selectedRows.length}건 선택</strong>
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null || !selectedRows.some(runnable)}
                onClick={() => setLaunchTargets(selectedRows.filter(runnable))}
              >
                <Play size={14} /> 선택 실행
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
                선택 승인
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds([])}
              >
                선택 해제
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
                      aria-label="전체 선택"
                    />
                  </th>
                  <th>ID</th>
                  <th>제목</th>
                  <th>유형</th>
                  <th>실행</th>
                  <th>마일스톤</th>
                  <th>중요도</th>
                  <th>상태</th>
                  <th>단계 실행</th>
                  <th>승인</th>
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
                        aria-label={`${item.id} ${item.title} 선택`}
                      />
                    </td>
                    <td className="wb-issue-id">{item.id}</td>
                    <td>
                      <strong>{item.title}</strong>
                      {item.labels.length > 0 && (
                        <small> {item.labels.join(" · ")}</small>
                      )}
                    </td>
                    <td>{item.issueType}</td>
                    <td>{item.executionType}</td>
                    <td>
                      {item.milestone ? milestoneName(item.milestone) : "-"}
                    </td>
                    <td>
                      <span className={`wb-priority is-${item.priority}`}>
                        {PRIORITY_LABELS[item.priority]}
                      </span>
                    </td>
                    <td>
                      <span className={statusClass(item.status)}>
                        {STATUS_LABELS[item.status]}
                      </span>
                    </td>
                    <td onClick={(event) => event.stopPropagation()}>
                      {runnable(item) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() => setLaunchTargets([item])}
                          title={`${stageNameOf(item)} 단계를 ${roleLabels[roleOf(item)]} 역할로 실행합니다.`}
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
                            ? `승인일 ${item.approved || "기록 없음"}`
                            : "설계를 검토한 뒤 실행을 승인합니다."
                        }
                      >
                        {item.approve ? "승인됨" : "승인"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState
              title="조건에 맞는 이슈가 없습니다"
              description="이슈와 개발 항목은 같은 목록입니다. 필터를 넓히거나 새 이슈를 등록해 보세요."
              action={
                <Button onClick={() => onNewWork()}>
                  <Plus /> 이슈 등록
                </Button>
              }
            />
          )}
        </div>
      </div>

      {(pending.length > 0 || legacyError) && (
        <section className="wb-panel wb-legacy-issues">
          <div className="wb-panel-title">
            <h2>이관하지 않은 이슈 노트 {pending.length}건</h2>
            {movable.length > 0 && (
              <Button
                size="sm"
                disabled={busy !== null}
                onClick={() => void migrate(movable.map((entry) => entry.path))}
              >
                {busy === "migrate" && <Loader2 className="wb-spin" />}
                {movable.length}건 모두 이관
              </Button>
            )}
          </div>
          {legacyError ? (
            <p className="wb-muted">{legacyError}</p>
          ) : (
            <>
              <p className="wb-muted">
                이름을 바꾸기 전 볼트에 남은 이슈 노트입니다. 이관해도 원본
                파일은 지우지 않고 <code>migrated_to</code> 표시만 남깁니다.
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
                      이관
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
            ? `${stageNameOf(launchTargets[0])} 단계를 실행할까요?`
            : `${launchTargets?.length ?? 0}건을 실행할까요?`
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
                  {stageNameOf(item)} · {roleLabels[roleOf(item)]} ·{" "}
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
          <p className="wb-muted">
            프로젝트 기본 역할·에이전트로 실행합니다. 역할이나 지시문을 바꾸려면
            항목을 열어 실행 런처를 쓰세요.
          </p>
          <div className="wb-form-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setLaunchTargets(null)}
            >
              취소
            </Button>
            <Button
              type="button"
              disabled={busy !== null}
              onClick={() => void launch(launchTargets ?? [])}
            >
              {busy === "launch" && <Loader2 className="wb-spin" />}
              실행
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
      setError("개발 항목 이름을 입력해 주세요.");
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
      title={draft.id ? "개발 항목 편집" : "새 개발 항목"}
      wide
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          개발 항목 이름
          <Input
            value={draft.title}
            onChange={(event) => set("title", event.target.value)}
            placeholder="무엇을 끝내고 싶나요?"
            autoFocus
          />
        </label>
        <label className="wb-field is-wide">
          맥락
          <textarea
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder="결과와 배경을 짧게 남겨 주세요."
          />
        </label>
        <label className="wb-field">
          프로젝트
          <select
            aria-label="프로젝트"
            value={draft.projectId}
            onChange={(event) => set("projectId", event.target.value)}
          >
            <option value="">연결 안 함</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          담당자
          <Input
            value={draft.owner}
            onChange={(event) => set("owner", event.target.value)}
            placeholder="이름 또는 역할"
          />
        </label>
        <label className="wb-field">
          상태
          <select
            aria-label="상태"
            value={draft.status}
            onChange={(event) =>
              set("status", event.target.value as WorkStatus)
            }
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          우선순위
          <select
            aria-label="우선순위"
            value={draft.priority}
            onChange={(event) =>
              set("priority", event.target.value as Priority)
            }
          >
            {(["urgent", "high", "normal", "low"] as Priority[]).map(
              (priority) => (
                <option key={priority} value={priority}>
                  {PRIORITY_LABELS[priority]}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="wb-field">
          유형
          <select
            aria-label="유형"
            value={draft.issueType}
            onChange={(event) => set("issueType", event.target.value)}
          >
            {ISSUE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          처리 유형
          <select
            aria-label="처리 유형"
            value={draft.executionType}
            onChange={(event) => set("executionType", event.target.value)}
          >
            {EXECUTION_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          마일스톤
          <select
            aria-label="마일스톤"
            value={draft.milestone}
            onChange={(event) => set("milestone", event.target.value)}
          >
            <option value="">소속 없음</option>
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
          시작일
          <Input
            type="date"
            value={draft.startDate ?? ""}
            onChange={(event) => set("startDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field">
          기한
          <Input
            type="date"
            value={draft.dueDate ?? ""}
            onChange={(event) => set("dueDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field is-wide">
          태그
          <Input
            value={draft.tags.join(", ")}
            onChange={(event) =>
              set(
                "tags",
                event.target.value.split(",").map((tag) => tag.trim()),
              )
            }
            placeholder="예: frontend, release (쉼표로 구분)"
          />
        </label>
        {work.filter((item) => item.id !== draft.id).length > 0 && (
          <fieldset className="wb-check-field is-wide">
            <legend>선행 항목</legend>
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
            취소
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />}
            {draft.id ? "변경 저장" : "개발 항목 만들기"}
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
      setError("프로젝트 이름을 입력해 주세요.");
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
      title={draft.id ? "프로젝트 편집" : "프로젝트 추가"}
      wide
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          프로젝트 이름
          <Input
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            autoFocus
          />
        </label>
        <label className="wb-field is-wide">
          설명
          <textarea
            value={draft.description}
            onChange={(event) => set("description", event.target.value)}
            placeholder="이 프로젝트가 해결하는 문제"
          />
        </label>
        <label className="wb-field is-wide">
          저장소 경로
          <PathInput
            aria-label="저장소 경로"
            value={draft.repoPath}
            onValueChange={(value) => set("repoPath", value)}
            placeholder="/path/to/repository"
          />
        </label>
        <label className="wb-field">
          기본 에이전트
          <select
            aria-label="기본 에이전트"
            value={draft.defaultAgent}
            onChange={(event) => set("defaultAgent", event.target.value)}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </label>
        <label className="wb-field">
          기본 모델
          <Input
            value={draft.defaultModel}
            onChange={(event) => set("defaultModel", event.target.value)}
            placeholder="선택 사항"
          />
        </label>
        <label className="wb-field is-wide">
          새 개발 항목의 워크플로우
          <select
            aria-label="프로젝트 워크플로우"
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
            변경해도 기존 항목은 시작 당시 버전을 유지합니다.
          </small>
        </label>
        <label className="wb-field is-wide">
          검증 명령
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
          <legend>선행 프로젝트</legend>
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
              <span className="wb-muted">연결할 다른 프로젝트가 없습니다.</span>
            )}
          </div>
        </fieldset>
        {error && <div className="wb-inline-error">{error}</div>}
        <div className="wb-form-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />} 저장
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
      setError("일정 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    try {
      if (
        draft.kind !== "milestone" &&
        work.some((item) => item.milestone === draft.id)
      )
        throw new Error("연결된 이슈를 먼저 마일스톤에서 제거해 주세요.");
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
          "마일스톤에 포함된 이슈를 먼저 제거하고 저장해 주세요.",
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
      title={draft.id ? "일정 편집" : "일정 추가"}
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          일정 이름
          <Input
            value={draft.title}
            onChange={(event) => set("title", event.target.value)}
            autoFocus
          />
        </label>
        <label className="wb-field">
          날짜
          <Input
            type="date"
            value={draft.date}
            onChange={(event) => set("date", event.target.value)}
            required
          />
        </label>
        <label className="wb-field">
          종료일
          <Input
            type="date"
            value={draft.endDate ?? ""}
            onChange={(event) => set("endDate", event.target.value || null)}
          />
        </label>
        <label className="wb-field">
          종류
          <select
            aria-label="일정 종류"
            value={draft.kind}
            onChange={(event) =>
              set("kind", event.target.value as CalendarEvent["kind"])
            }
          >
            {Object.entries(eventLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="wb-field">
          프로젝트
          <select
            aria-label="일정 프로젝트"
            value={draft.projectId ?? ""}
            onChange={(event) => set("projectId", event.target.value || null)}
          >
            <option value="">연결 안 함</option>
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
            개발 항목 연결
            <select
              aria-label="개발 항목 연결"
              value={draft.workId ?? ""}
              onChange={(event) => set("workId", event.target.value || null)}
            >
              <option value="">연결 안 함</option>
              {work.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="wb-field is-wide">
          메모
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
              삭제
            </Button>
          )}
          <span />
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="wb-spin" />} 저장
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
  const activeNodeId = work ? activeNodeForWork(work) : null;
  useEffect(() => setReviewNote(""), [work?.id, activeNodeId]);
  if (!work) return null;
  const currentNodeId = activeNodeId ?? work.stage;
  const nodes =
    workflow?.nodes ?? STAGES.map((id) => ({ id, label: STAGE_LABELS[id] }));
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
        text: "문서를 먼저 저장한 뒤 검토 결정을 남겨 주세요.",
      });
      return;
    }
    const targetIndex = nodes.findIndex((node) => node.id === stage);
    if (targetIndex > index && !reviewNote.trim()) {
      onNotice({
        tone: "error",
        text: "다음 단계로 이동할 검토 근거를 입력해 주세요.",
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
        throw new Error("현재 워크플로우에 정의된 전환이 아닙니다.");
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
        text: `${stageLabel(workflow ? [workflow] : [], stage)} 단계로 전환했습니다.`,
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
      window.confirm("저장하지 않은 문서 변경이 있습니다. 닫을까요?")
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
            {STATUS_LABELS[work.status]}
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
                "설명이 아직 없습니다. 개발 항목 편집에서 의도와 배경을 남겨 주세요."}
            </p>
          </div>
          <div className="wb-detail-actions">
            {work.workflowId === "sdd-main" && work.stage === "maintain" && (
              <Button size="sm" variant="outline" onClick={onFollowUp}>
                <Plus /> 후속 의도 만들기
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onEdit}>
              <FilePenLine /> 편집
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
                  ? "현재 노드에서 연결된 전환이 없습니다"
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
            프로젝트{" "}
            <strong>
              {projects.find((project) => project.id === work.projectId)
                ?.name ?? "없음"}
            </strong>
          </span>
          <span>
            기한 <strong>{formatDate(work.dueDate)}</strong>
          </span>
          <span>
            담당 <strong>{work.owner || "미지정"}</strong>
          </span>
          {work.dependsOn.length > 0 && (
            <span>
              선행 <strong>{work.dependsOn.length}개</strong>
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
            <h3>결정 기록</h3>
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
          검토 결정
          <textarea
            aria-label="검토 결정"
            value={reviewNote}
            onChange={(event) => setReviewNote(event.target.value)}
            placeholder="확인한 산출물과 다음 단계로 진행해도 되는 근거를 기록하세요."
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
              <ArrowLeft /> 재검토:{" "}
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
                  검토 후 다음: {stageLabel(workflow ? [workflow] : [], next)}{" "}
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
      <h3>워크플로 실행 장부</h3>
      {error && <p className="wb-inline-error">{error}</p>}
      {instance && (
        <>
          <p className="text-xs text-muted-foreground">
            {instance.workflowId}@{instance.workflowVersion} · {instance.status}{" "}
            · 전환 {instance.transitionCount}회
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
                  {run.status} · 시도 {run.attempt}
                  {run.iteration > 0 ? ` · 반복 ${run.iteration}` : ""}
                  {run.waitingReason ? ` · ${run.waitingReason}` : ""}
                </p>
                <time>{dateTimeText.format(new Date(run.updatedAt))}</time>
              </div>
            ))}
          {events.length > 0 && (
            <p className="text-xs text-muted-foreground">
              중복 방지된 이벤트 {events.length}건
            </p>
          )}
        </>
      )}
      {!instance && !error && (
        <p className="text-xs text-muted-foreground">
          장부를 불러오는 중입니다.
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
      !window.confirm("저장하지 않은 변경을 버리고 최신 문서를 불러올까요?")
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
          "저장하지 않은 문서 변경이 있습니다. 페이지를 이동할까요?",
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
        text: "현재 초안을 클립보드에 복사했습니다.",
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
        text: `${artifactLabel(workflow, selected)} 문서를 저장했습니다.`,
      });
    } catch (e) {
      if (request !== requestId.current) return;
      const message = errorText(e);
      setError(message);
      onNotice({
        tone: "error",
        text:
          message.includes("revision") || message.includes("충돌")
            ? "다른 변경이 먼저 저장되었습니다. 아래에서 최신본을 비교하거나 초안을 복사한 뒤 다시 불러오세요."
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
      !window.confirm("저장하지 않은 변경이 있습니다. 문서를 전환할까요?")
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
              {dirty ? "저장되지 않은 변경" : document ? "저장됨" : ""}
            </small>
          </div>
          <Button
            size="xs"
            variant="ghost"
            aria-label="문서 새로고침"
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
            {busy ? <Loader2 className="wb-spin" /> : "저장"}
          </Button>
        </div>
        {error && (
          <div className="wb-editor-error">
            <AlertCircle size={14} />
            <span>{error}</span>
            <button onClick={() => void compareLatest()} disabled={busy}>
              최신본 비교
            </button>
            <button onClick={() => void copyDraft()}>초안 복사</button>
            <button onClick={() => void reloadDocument(true)} disabled={busy}>
              다시 불러오기
            </button>
          </div>
        )}
        {latestMarkdown !== null && (
          <details className="wb-compare" open>
            <summary>디스크의 최신본 비교</summary>
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
            문서 초안을 불러올 수 없습니다.
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
  const currentNodeId = activeNodeForWork(work);
  const node = workflow?.nodes.find(
    (candidate) => candidate.id === currentNodeId,
  );
  const availableRoles = node?.allowedRoles.length
    ? node.allowedRoles
    : (Object.keys(roleLabels) as AgentRole[]);
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
        text: "에이전트 실행을 큐에 추가했습니다. 실행 화면에서 상태를 확인하세요.",
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
      onNotice({ tone: "success", text: "실행을 중단했습니다." });
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
        <h3>맥락을 넘겨 실행</h3>
        <p>단계, 선행 항목, 저장소와 검증 명령이 프롬프트에 포함됩니다.</p>
      </div>
      <label>
        역할
        <select
          aria-label="실행 역할"
          value={role}
          onChange={(event) => setRole(event.target.value as AgentRole)}
        >
          {availableRoles.map((key) => (
            <option key={key} value={key}>
              {roleLabels[key]}
            </option>
          ))}
        </select>
      </label>
      <label>
        에이전트
        <select
          aria-label="실행 에이전트"
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
        모델
        <Input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          placeholder="기본 모델 사용"
        />
      </label>
      <label>
        추가 지시
        <textarea
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="이번 실행에서 특히 확인할 점"
        />
      </label>
      <Button
        size="sm"
        variant={active ? "secondary" : "default"}
        title={
          active
            ? "이 역할의 실행이 진행 중입니다. 누르면 중단합니다."
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
        {active ? "실행 중 · 중단" : "실행 시작"}
      </Button>
      {!work.projectId && <small>실행하려면 프로젝트를 연결해 주세요.</small>}
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
        (e) => alive && setOutput(`출력을 읽지 못했습니다: ${errorText(e)}`),
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
        text: "herdr 에서 이 실행의 세션을 다시 열었습니다.",
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
      if (!item) throw new Error("연결된 개발 항목을 찾을 수 없습니다.");
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
      onNotice({ tone: "success", text: "자식 조사 실행을 시작했습니다." });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="개발 실행">
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw /> 새로 고침
        </Button>
      </PageHeader>
      {loading ? (
        <LoadingState />
      ) : !runs.length ? (
        <EmptyState
          icon={SquareTerminal}
          title="아직 실행 기록이 없습니다"
          description="개발 항목 상세에서 역할과 모델을 선택해 실행을 시작하세요."
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
                    {roleLabels[run.role]} · {run.agentName || run.agent}
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
                    {roleLabels[selected.role]} · {selected.agent}{" "}
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
                    <FileText /> 개발 항목
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
                      <SquareTerminal /> herdr 에서 이어하기
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
                      <StopCircle /> 중지
                    </Button>
                  )}
                </div>
              </header>
              {selected.error && (
                <div className="wb-inline-error">{selected.error}</div>
              )}
              <div className="wb-run-metadata">
                <span>
                  세션 <strong>{selected.session || "기록 없음"}</strong>
                </span>
                <span>
                  생성{" "}
                  <strong>
                    {dateTimeText.format(new Date(selected.createdAt))}
                  </strong>
                </span>
                {selected.agentSession && (
                  <span>
                    에이전트 세션 <strong>{selected.agentSession}</strong>
                  </span>
                )}
                {selected.tabClosedAt && (
                  <span>
                    화면 닫힘{" "}
                    <strong>
                      {dateTimeText.format(new Date(selected.tabClosedAt))}
                    </strong>
                  </span>
                )}
                {selected.parentRunId && (
                  <span>
                    상위 실행 <strong>{selected.parentRunId}</strong>
                  </span>
                )}
              </div>
              {selected.finalReport && (
                <div className="wb-run-report">
                  <strong>최종 보고</strong>
                  <pre>{selected.finalReport}</pre>
                </div>
              )}
              <div className="wb-run-prompt">
                <strong>실행 프롬프트</strong>
                <pre>{selected.prompt}</pre>
              </div>
              <div className="wb-output">
                <div>
                  <strong>최신 출력</strong>
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
                <pre>{output || "아직 기록된 출력이 없습니다."}</pre>
              </div>
              {selected.status === "review" && (
                <div className="wb-followup">
                  <label>
                    검토 메모
                    <textarea
                      aria-label="검토 메모"
                      value={followUp}
                      onChange={(event) => setFollowUp(event.target.value)}
                      placeholder="검토 결과와 다음 지시를 남겨 이어서 실행하세요."
                    />
                  </label>
                  <Button
                    size="sm"
                    onClick={() => void continueRun()}
                    disabled={busy || !followUp.trim()}
                  >
                    <Send /> 후속 지시 보내기
                  </Button>
                  {selected.tabClosedAt && (
                    <small>
                      끝난 herdr 화면은 닫혀 있습니다. 후속 지시를 보내면 기록된
                      세션을 같은 대화로 다시 엽니다.
                    </small>
                  )}
                </div>
              )}
              {selected.status === "blocked" && (
                <div className="wb-terminal-controls">
                  <strong>현재 터미널 프롬프트에 직접 선택</strong>
                  <span>
                    자동 전송하지 않습니다. 필요한 키만 직접 누르세요.
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
                        aria-label={`터미널 키 ${key}`}
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
                  <Send /> 조사 자식 실행
                </Button>
                <small>자식 실행도 독립된 기록과 출력으로 보존됩니다.</small>
              </footer>
            </section>
          )}
        </div>
      )}
    </>
  );
}
