import {
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
  CircleDot,
  Clock3,
  FilePenLine,
  FileText,
  Filter,
  GripVertical,
  LayoutDashboard,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Send,
  SquareTerminal,
  StopCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api as vaultApi } from "@/lib/api";
import { sddApi, workflowApi } from "./api";
import {
  ARTIFACTS,
  ARTIFACT_LABELS,
  PRIORITY_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUSES,
  STATUS_LABELS,
  type AgentRole,
  type ArtifactKind,
  type CalendarEvent,
  type Document,
  type HarnessRun,
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
  work: Pick<
    WorkItem,
    "workflowId" | "workflowVersion" | "activeNodes"
  >,
) {
  const active = work.activeNodes?.[0];
  return (
    workflows.find(
      (definition) =>
        definition.id === (active?.workflowId ?? work.workflowId) &&
        definition.version === (active?.workflowVersion ?? work.workflowVersion),
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
function NoticeBar({
  notice,
  onClear,
}: {
  notice: Notice;
  onClear: () => void;
}) {
  if (!notice) return null;
  return (
    <div
      className={cx("wb-notice", `is-${notice.tone}`)}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <AlertCircle size={15} />
      <span>{notice.text}</span>
      <button onClick={onClear} aria-label="알림 닫기">
        <X size={14} />
      </button>
    </div>
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
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
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
  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await sddApi.snapshot());
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  // Refresh lists written by agents without interrupting an open draft.
  useEffect(() => {
    if (
      selectedWorkId ||
      workModal !== undefined ||
      projectModal !== undefined ||
      eventModal !== undefined
    )
      return;
    let alive = true;
    const timer = window.setInterval(() => {
      sddApi
        .snapshot()
        .then((next) => {
          if (alive) setSnapshot(next);
        })
        .catch((err) => {
          if (alive) setError(errorText(err));
        });
    }, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [selectedWorkId, workModal, projectModal, eventModal]);
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
    setSelectedArtifact(
      artifact ?? definition?.artifacts[0]?.role ?? "intent",
    );
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
          setSnapshot(next);
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
    notice,
    setNotice,
    reload,
    onNewWork: () => setWorkModal(null),
    onSelectWork: selectDocument,
    onEditWork: (item: WorkItem) => setWorkModal(item),
  };
  return (
    <div className="wb-page">
      <NoticeBar notice={notice} onClear={() => setNotice(null)} />
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
        <KnowledgeView onJump={selectDocument} onNotice={setNotice} />
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
            dependsOn: [currentWork.id],
            description: `“${currentWork.title}”의 운영·학습을 바탕으로 다음 의도를 정리합니다.\n\n연결된 학습 문서: work/${currentWork.id}/learning.md`,
          })
        }
      />
      <WorkFormDialog
        open={workModal !== undefined}
        initial={workModal ?? blankWork()}
        projects={projects}
        work={work}
        onClose={() => setWorkModal(undefined)}
        onSaved={(item) => {
          setWorkModal(undefined);
          selectDocument(item.id);
          void afterSave(
            item.id ? "작업을 저장했습니다." : "작업을 만들었습니다.",
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
        <p className="wb-eyebrow">SAWHORSE SDD</p>
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
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="wb-header">
      <div>
        <p className="wb-eyebrow">{eyebrow ?? "SAWHORSE SDD"}</p>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children && <div className="wb-header-actions">{children}</div>}
    </header>
  );
}
function OverviewView({
  work,
  projects,
  workflows,
  onNewWork,
  onSelectWork,
  onEditWork,
}: {
  work: WorkItem[];
  projects: Project[];
  workflows: WorkflowDefinition[];
  onNewWork: () => void;
  onSelectWork: (id: string) => void;
  onEditWork: (item: WorkItem) => void;
}) {
  const today = isoToday();
  const due = work.filter(
    (item) => item.dueDate && item.dueDate <= today && item.status !== "done",
  );
  const active = work.filter((item) => item.status === "running");
  const ready = work.filter((item) => item.status === "ready");
  const recent = [...work]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
  const stageEntries = workflows
    .filter((definition) =>
      work.some(
        (item) =>
          item.workflowId === definition.id &&
          item.workflowVersion === definition.version,
      ),
    )
    .flatMap((definition) =>
      definition.nodes.map((node) => ({ definition, node })),
    );
  return (
    <>
      <PageHeader
        title="작업의 흐름을 선명하게"
        subtitle={`${projects.length}개 프로젝트 · ${work.length}개 작업을 연결하고 있습니다.`}
      >
        <Button onClick={onNewWork}>
          <Plus /> 새 작업
        </Button>
      </PageHeader>
      <section className="wb-metric-grid">
        <Metric
          label="진행 중"
          value={active.length}
          hint="지금 집중할 항목"
          icon={<CircleDot />}
        />
        <Metric
          label="준비됨"
          value={ready.length}
          hint="바로 시작 가능"
          icon={<ArrowRight />}
        />
        <Metric
          label="기한 주의"
          value={due.length}
          hint={
            due.length
              ? due
                  .map((item) => item.title)
                  .slice(0, 2)
                  .join(" · ")
              : "차분하게 진행 중"
          }
          icon={<Clock3 />}
          warn={due.length > 0}
        />
        <Metric
          label="완료"
          value={work.filter((item) => item.status === "done").length}
          hint="축적된 결과"
          icon={<Check />}
        />
      </section>
      <section className="wb-two-column">
        <div className="wb-panel">
          <div className="wb-panel-title">
            <div>
              <h2>다음에 할 일</h2>
              <span>작업 흐름을 이어갈 항목</span>
            </div>
            <button
              onClick={onNewWork}
              className="wb-icon-button"
              aria-label="새 작업"
            >
              <Plus size={17} />
            </button>
          </div>
          {recent.length ? (
            <div className="wb-list">
              {recent.map((item) => (
                <WorkRow
                  key={item.id}
                  item={item}
                  project={projects.find(
                    (project) => project.id === item.projectId,
                  )}
                  workflows={workflows}
                  onClick={() => onSelectWork(item.id)}
                  onEdit={() => onEditWork(item)}
                />
              ))}
            </div>
          ) : (
            <EmptyState
              title="첫 작업을 만들어 보세요"
              description="의도부터 검증까지 하나의 흐름으로 남길 수 있습니다."
              action={
                <Button size="sm" onClick={onNewWork}>
                  <Plus /> 새 작업
                </Button>
              }
            />
          )}
        </div>
        <div className="wb-panel wb-stage-panel">
          <div className="wb-panel-title">
            <div>
              <h2>단계별 맥락</h2>
              <span>문서가 다음 결정을 준비합니다</span>
            </div>
          </div>
          <div className="wb-stage-summary">
            {(stageEntries.length
              ? stageEntries
              : STAGES.map((stage) => ({
                  definition: undefined,
                  node: { id: stage, label: STAGE_LABELS[stage] },
                })))
              .map(({ definition, node }) => (
              <div key={`${definition?.id ?? "legacy"}:${node.id}`}>
                <span>
                  {workflows.length > 1 && definition
                    ? `${definition.label} · ${node.label}`
                    : node.label}
                </span>
                <strong>
                  {work.filter(
                    (item) =>
                      item.stage === node.id &&
                      (!definition || item.workflowId === definition.id),
                  ).length}
                </strong>
                <i />
              </div>
            ))}
          </div>
          <div className="wb-project-brief">
            <span>프로젝트</span>
            <strong>
              {projects[0]?.name ?? "아직 연결된 프로젝트가 없습니다"}
            </strong>
            <p>
              {projects[0]?.description ||
                "프로젝트를 추가하면 저장소와 검증 명령을 작업에 연결할 수 있습니다."}
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
function Metric({
  label,
  value,
  hint,
  icon,
  warn,
}: {
  label: string;
  value: number;
  hint: string;
  icon: React.ReactNode;
  warn?: boolean;
}) {
  return (
    <div className={cx("wb-metric", warn && "is-warn")}>
      <div className="wb-metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </div>
  );
}
function WorkRow({
  item,
  project,
  workflows,
  onClick,
  onEdit,
}: {
  item: WorkItem;
  project?: Project;
  workflows: WorkflowDefinition[];
  onClick: () => void;
  onEdit: () => void;
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
        <button
          className="wb-icon-button"
          aria-label="작업 편집"
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
      <PageHeader
        title="흐름을 한눈에"
        subtitle="상태, 프로젝트, 단계 기준으로 흐름을 정리할 수 있습니다."
      >
        <div className="wb-filter">
          <Filter size={15} />
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as typeof filter)}
            aria-label="작업 필터"
          >
            <option value="all">모든 작업</option>
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
          <Plus /> 새 작업
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
                        aria-label="작업 편집"
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
      <PageHeader
        title="시간 위의 약속"
        subtitle="작업 기한과 프로젝트 일정을 같은 리듬으로 바라봅니다."
      >
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
                      {isEvent ? eventLabels[entry.event.kind] : "작업 기한"}
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
  onJump,
  onNotice,
}: {
  onJump: (workId: string, artifact: ArtifactKind, snippet: string) => void;
  onNotice: (notice: Notice) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
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
      setSearched(false);
      return;
    }
    setBusy(true);
    try {
      setHits(await sddApi.search(query.trim()));
      setSearched(true);
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="쌓인 맥락을 찾아서"
        subtitle="의도, 설계, 검증 근거 속의 정확한 문장으로 이동합니다."
      />
      <form className="wb-search-box" onSubmit={(event) => void search(event)}>
        <Search size={20} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="문서와 작업을 검색하세요"
          autoFocus
        />
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="wb-spin" /> : "검색"}
        </Button>
      </form>
      <div className="wb-search-results">
        {busy ? (
          <LoadingState />
        ) : searched && !hits.length ? (
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
  return (
    <>
      <PageHeader
        title="프로젝트의 경계와 연결"
        subtitle="저장소, 검증 명령, 선행 프로젝트를 명확하게 둡니다."
      >
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
                  개 작업
                </span>
                <span>{project.dependsOn.length}개 선행</span>
                <span>
                  {workflowForProject(workflows, project)?.label ??
                    `${project.workflowId}@${project.workflowVersion}`}
                </span>
              </div>
              <footer>{project.repoPath || "저장소 경로 없음"}</footer>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title="첫 프로젝트를 등록하세요"
          description="작업을 저장소·검증 절차와 함께 관리할 수 있습니다."
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
function WorkFormDialog({
  open,
  initial,
  projects,
  work,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial: WorkItem;
  projects: Project[];
  work: WorkItem[];
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
      setError("작업 이름을 입력해 주세요.");
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
      title={draft.id ? "작업 편집" : "새 작업"}
      wide
    >
      <form className="wb-form" onSubmit={(event) => void save(event)}>
        <label className="wb-field is-wide">
          작업 이름
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
            <legend>선행 작업</legend>
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
            {draft.id ? "변경 저장" : "작업 만들기"}
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
          <Input
            value={draft.repoPath}
            onChange={(event) => set("repoPath", event.target.value)}
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
          새 작업의 워크플로우
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
            변경해도 기존 작업은 시작 당시 버전을 유지합니다.
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
      await sddApi.saveEvent({ ...draft, title: draft.title.trim() });
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
        <label className="wb-field is-wide">
          작업 연결
          <select
            aria-label="작업 연결"
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
  const nodes = workflow?.nodes ??
    STAGES.map((id) => ({ id, label: STAGE_LABELS[id] }));
  const index = nodes.findIndex((node) => node.id === currentNodeId);
  const outgoing = workflow?.edges.filter((edge) => edge.from === currentNodeId);
  const previous = outgoing
    ?.map((edge) => edge.to)
    .find(
      (candidate) =>
        nodes.findIndex((node) => node.id === candidate) < index,
    ) ?? (workflow ? null : index > 0 ? nodes[index - 1]?.id : null);
  const next = outgoing
    ?.map((edge) => edge.to)
    .find(
      (candidate) =>
        nodes.findIndex((node) => node.id === candidate) > index,
    ) ?? (workflow ? null : index < nodes.length - 1 ? nodes[index + 1]?.id : null);
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
          note:
            reviewNote.trim() || "재검토를 위해 이전 노드로 이동",
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
                "설명이 아직 없습니다. 작업 편집에서 의도와 배경을 남겨 주세요."}
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
                    {stageLabel(
                      workflow ? [workflow] : [],
                      decision.stage,
                    )}
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
          {previous && (
            <Button
              variant="outline"
              size="sm"
              disabled={transitioning}
              onClick={() => void transition(previous)}
            >
              <ArrowLeft /> 재검토: {stageLabel(workflow ? [workflow] : [], previous)}
            </Button>
          )}
          <span />
          {next && (
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
    Promise.all([workflowApi.instance(instanceId), workflowApi.events(instanceId)])
      .then(([nextInstance, nextEvents]) => {
        if (!alive) return;
        setInstance(nextInstance);
        setEvents(nextEvents);
      })
      .catch((reason) => alive && setError(errorText(reason)));
    return () => { alive = false; };
  }, [instanceId]);
  return (
    <div className="wb-ledger">
      <h3>워크플로 실행 장부</h3>
      {error && <p className="wb-inline-error">{error}</p>}
      {instance && (
        <>
          <p className="text-xs text-muted-foreground">
            {instance.workflowId}@{instance.workflowVersion} · {instance.status} · 전환 {instance.transitionCount}회
          </p>
          {instance.nodeRuns.slice().reverse().map((run) => (
            <div key={run.id}>
              <span>{run.workflowId}:{run.nodeId}</span>
              <p>{run.status} · 시도 {run.attempt}{run.iteration > 0 ? ` · 반복 ${run.iteration}` : ""}{run.waitingReason ? ` · ${run.waitingReason}` : ""}</p>
              <time>{dateTimeText.format(new Date(run.updatedAt))}</time>
            </div>
          ))}
          {events.length > 0 && <p className="text-xs text-muted-foreground">중복 방지된 이벤트 {events.length}건</p>}
        </>
      )}
      {!instance && !error && <p className="text-xs text-muted-foreground">장부를 불러오는 중입니다.</p>}
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
        {(workflow?.artifacts.map((artifact) => artifact.role) ?? ARTIFACTS).map((artifact) => (
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
  const defaultRole = (stage: Stage): AgentRole =>
    stage === "plan"
      ? "research"
      : stage === "design"
        ? "planner"
        : stage === "build"
          ? "implementer"
          : stage === "test"
            ? "verifier"
            : "reviewer";
  const currentNodeId = activeNodeForWork(work);
  const node = workflow?.nodes.find((candidate) => candidate.id === currentNodeId);
  const availableRoles = node?.allowedRoles.length
    ? node.allowedRoles
    : (Object.keys(roleLabels) as AgentRole[]);
  const roleForNode = () => availableRoles[0] ?? defaultRole(currentNodeId);
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
        text: "에이전트 실행을 큐에 추가했습니다. 하네스에서 상태를 확인하세요.",
      });
    } catch (e) {
      onNotice({ tone: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="wb-run-launcher">
      <div>
        <p className="wb-eyebrow">HARNESS</p>
        <h3>맥락을 넘겨 실행</h3>
        <p>단계, 선행 작업, 저장소와 검증 명령이 프롬프트에 포함됩니다.</p>
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
        onClick={() => void launch()}
        disabled={busy || !work.projectId}
      >
        {busy ? <Loader2 className="wb-spin" /> : <Bot />} 실행 시작
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
    if (
      !runs.some((run) =>
        ["starting", "running", "blocked"].includes(run.status),
      )
    )
      return;
    const timer = window.setInterval(() => {
      void Promise.all(
        runs
          .filter((run) =>
            ["starting", "running", "blocked"].includes(run.status),
          )
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
      if (!item) throw new Error("연결된 작업을 찾을 수 없습니다.");
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
      <PageHeader
        title="실행의 흔적을 남기다"
        subtitle="하네스가 실행 문맥과 출력 증거를 보존합니다."
      >
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
          description="작업 상세에서 역할과 모델을 선택해 실행을 시작하세요."
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
                    <FileText /> 작업
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refresh()}
                    disabled={busy}
                  >
                    <RefreshCw />
                  </Button>
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
                {selected.parentRunId && (
                  <span>
                    상위 실행 <strong>{selected.parentRunId}</strong>
                  </span>
                )}
              </div>
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
