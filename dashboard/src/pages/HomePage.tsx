import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock3,
  FolderInput,
  ListTodo,
  Pencil,
  Play,
  Plus,
  Sparkles,
  TriangleAlert,
  Workflow,
  Zap,
} from "lucide-react";
import { DashboardBoard } from "@/features/dashboard/DashboardBoard";
import type { DashboardWidgetId } from "@/features/dashboard/registry";
import { api } from "@/lib/api";
import { useApp, type PageId } from "@/lib/store";
import type { Job, ProgressEntry, RoutineName, TodoSections, VaultAudit } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BadgeVariant } from "./common";
import {
  Empty,
  PageHeader,
  WARN_TEXT,
  entryText,
  fmtClock,
  fmtDate,
  fmtDur,
  jobStatusLabel,
  jobStatusVariant,
  useTicker,
} from "./common";

const ROUTINES: { key: RoutineName; label: string; description: string }[] = [
  { key: "morning", label: "아침", description: "오늘의 계획과 우선순위" },
  { key: "lunch", label: "점심", description: "진행 상황 중간 점검" },
  { key: "evening", label: "저녁", description: "업무 정리와 회고" },
];

const ROUTINE_LABEL_RE: Record<RoutineName, RegExp> = {
  morning: /morning|아침/i,
  lunch: /lunch|점심/i,
  evening: /evening|저녁/i,
};

export default function HomePage() {
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const improvements = useApp((s) => s.improvements);
  const jobs = useApp((s) => s.jobs);
  const progress = useApp((s) => s.progress);
  const missed = useApp((s) => s.missed);
  const setPage = useApp((s) => s.setPage);
  const openWizard = useApp((s) => s.openWizard);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const refreshMissed = useApp((s) => s.refreshMissed);
  const todos = useApp((s) => s.todos);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const audit = useApp((s) => s.audit);
  const inboxCount = useApp((s) => s.inboxCount);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);

  useTicker(jobs.some((job) => job.status === "running"));

  useEffect(() => {
    void refreshAudit();
    const timer = setInterval(() => void refreshJobs(), 10000);
    return () => clearInterval(timer);
  }, [refreshJobs, refreshAudit]);

  const activeJobs = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const today = fmtDate(Date.now());
  const completedToday = jobs.filter(
    (job) =>
      job.status === "success" && job.finishedAtMs != null && fmtDate(job.finishedAtMs) === today,
  ).length;
  const failedToday = jobs.filter(
    (job) =>
      job.status === "failed" && job.finishedAtMs != null && fmtDate(job.finishedAtMs) === today,
  ).length;
  const pendingTodos = todos?.today.filter((todo) => !todo.checked).length ?? 0;
  const completedTodos = todos?.today.filter((todo) => todo.checked).length ?? 0;
  const lastFailed = jobs
    .filter((job) => job.status === "failed")
    .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))[0];

  const problems = useMemo(() => {
    const next: string[] = [];
    if (config && !config.exists) {
      next.push(
        "설정 파일(~/.claude/sawhorse/config.json)이 없습니다. 볼트 경로만 지정해도 시작할 수 있습니다.",
      );
    }
    if (diag && !diag.vaultPathOk) {
      next.push("볼트 경로가 유효하지 않습니다. 설정에서 경로를 확인하세요.");
    }
    if (diag && !diag.claudeOk) {
      next.push("claude CLI를 실행할 수 없습니다. 설정에서 실행 파일 위치를 확인하세요.");
    }
    if (diag) {
      const bad = diag.projects.filter((project) => !project.pathOk).map((project) => project.name);
      if (bad.length > 0) next.push(`프로젝트 경로 확인 실패: ${bad.join(", ")}`);
    }
    return next;
  }, [config, diag]);

  const dateLabel = new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());

  async function toggleToday(index: number, checked: boolean) {
    if (!todos) return;
    try {
      await api.toggleTodo("today", index, checked);
      await refreshTodos();
    } catch (error) {
      console.error(error);
    }
  }

  async function runRoutine(routine: RoutineName) {
    setBusy(true);
    try {
      await api.runRoutineNow(routine);
      await refreshJobs();
    } finally {
      setBusy(false);
    }
  }

  async function dismissMissed(key: string, run: boolean) {
    setBusy(true);
    try {
      await api.dismissMissed(key, run);
      await refreshMissed();
      if (run) await refreshJobs();
    } finally {
      setBusy(false);
    }
  }

  function renderWidget(id: DashboardWidgetId) {
    switch (id) {
      case "overview":
        return (
          <OverviewWidget
            activeJobs={activeJobs.length}
            pendingTodos={pendingTodos}
            completedTodos={completedTodos}
            totalTodos={todos?.today.length ?? 0}
            completedToday={completedToday}
            failedToday={failedToday}
            inboxCount={inboxCount}
            setPage={setPage}
          />
        );
      case "todos":
        return <TodosWidget todos={todos} setPage={setPage} onToggle={toggleToday} />;
      case "jobs":
        return <JobsWidget jobs={activeJobs} progress={progress} setPage={setPage} />;
      case "routines":
        return (
          <RoutinesWidget
            config={config}
            jobs={jobs}
            missed={missed}
            today={today}
            busy={busy}
            setPage={setPage}
            onRun={runRoutine}
          />
        );
      case "issues":
        return <IssuesWidget improvements={improvements} setPage={setPage} />;
      case "operations":
        return <OperationsWidget audit={audit} lastFailed={lastFailed} setPage={setPage} />;
    }
  }

  return (
    <div className="min-h-full">
      <PageHeader title="운영 개요" desc="오늘의 흐름과 지금 필요한 액션을 한곳에서 확인합니다.">
        {!editing && (
          <div className="hidden items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-sm sm:flex">
            <CalendarDays className="size-3.5" />
            <span>{dateLabel}</span>
          </div>
        )}
        {editing && (
          <Button size="sm" variant="outline" onClick={() => setCatalogOpen(true)}>
            <Plus /> 위젯 추가
          </Button>
        )}
        <Button
          size="sm"
          variant={editing ? "default" : "outline"}
          onClick={() => setEditing((value) => !value)}
        >
          {editing ? <Check /> : <Pencil />}
          {editing ? "편집 완료" : "대시보드 편집"}
        </Button>
      </PageHeader>

      <div className="mx-auto max-w-[1480px] p-4 lg:p-5">
        <AttentionArea
          problems={problems}
          missed={missed}
          busy={busy}
          configExists={config?.exists === true}
          vaultPath={config?.vaultPath ?? ""}
          setPage={setPage}
          openWizard={openWizard}
          onDismiss={dismissMissed}
        />

        <DashboardBoard
          editing={editing}
          catalogOpen={catalogOpen}
          onCatalogClose={() => setCatalogOpen(false)}
          renderWidget={renderWidget}
        />
      </div>
    </div>
  );
}

function AttentionArea({
  problems,
  missed,
  busy,
  configExists,
  vaultPath,
  setPage,
  openWizard,
  onDismiss,
}: {
  problems: string[];
  missed: ReturnType<typeof useApp.getState>["missed"];
  busy: boolean;
  configExists: boolean;
  vaultPath: string;
  setPage: (page: PageId) => void;
  openWizard: () => void;
  onDismiss: (key: string, run: boolean) => Promise<void>;
}) {
  if (problems.length === 0 && missed.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {problems.length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-3">
          <div className={`flex items-center gap-2 text-[13px] font-semibold ${WARN_TEXT}`}>
            <TriangleAlert className="size-4" /> 시스템 확인이 필요합니다 · {problems.length}건
          </div>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-6 text-xs text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <div className="mt-2.5 flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => setPage("settings")}>
              설정 확인
            </Button>
            {(!configExists || vaultPath.length === 0) && (
              <Button size="xs" variant="outline" onClick={openWizard}>
                설정 마법사
              </Button>
            )}
          </div>
        </div>
      )}
      {missed.map((item) => {
        const label =
          ROUTINES.find((routine) => routine.key === item.routine)?.label ?? item.routine;
        return (
          <div
            key={item.key}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-3.5 py-2.5"
          >
            <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/15">
              <Clock3 className={`size-4 ${WARN_TEXT}`} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold">{label} 루틴을 놓쳤습니다</div>
              <div className="text-xs text-muted-foreground">
                {item.date} {item.scheduledAt} 예정 · 확인 후 지금 실행할 수 있습니다.
              </div>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void onDismiss(item.key, true)}>
              <Play /> 실행
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void onDismiss(item.key, false)}
            >
              건너뛰기
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function OverviewWidget({
  activeJobs,
  pendingTodos,
  completedTodos,
  totalTodos,
  completedToday,
  failedToday,
  inboxCount,
  setPage,
}: {
  activeJobs: number;
  pendingTodos: number;
  completedTodos: number;
  totalTodos: number;
  completedToday: number;
  failedToday: number;
  inboxCount: number;
  setPage: (page: PageId) => void;
}) {
  return (
    <div className="widget-overview-grid grid h-full min-h-0 gap-3 overflow-auto">
      <MetricCard
        icon={Activity}
        label="진행 중 작업"
        value={activeJobs}
        detail={activeJobs > 0 ? "작업 현황 열기" : "현재 대기열이 비어 있습니다"}
        tone={activeJobs > 0 ? "brand" : "neutral"}
        onClick={() => setPage("jobs")}
      />
      <MetricCard
        icon={ListTodo}
        label="남은 할 일"
        value={pendingTodos}
        detail={totalTodos ? `${completedTodos}/${totalTodos} 완료` : "오늘 등록된 항목 없음"}
        tone={pendingTodos > 0 ? "brand" : "success"}
        onClick={() => setPage("todos")}
      />
      <MetricCard
        icon={CheckCircle2}
        label="오늘 완료"
        value={completedToday}
        detail={failedToday > 0 ? `실패 ${failedToday}건 확인 필요` : "실패 없이 진행 중"}
        tone={failedToday > 0 ? "warning" : "success"}
        onClick={() => setPage("jobs")}
      />
      <MetricCard
        icon={FolderInput}
        label="정리할 인박스"
        value={inboxCount}
        detail={inboxCount > 0 ? "승격 대기 항목 확인" : "인박스가 정리되었습니다"}
        tone={inboxCount > 0 ? "warning" : "success"}
        onClick={() => setPage("vault")}
      />
    </div>
  );
}

function TodosWidget({
  todos,
  setPage,
  onToggle,
}: {
  todos: TodoSections | null;
  setPage: (page: PageId) => void;
  onToggle: (index: number, checked: boolean) => Promise<void>;
}) {
  return (
    <WidgetCard
      eyebrow="Focus"
      icon={Zap}
      title="오늘의 업무"
      action={<WidgetLink onClick={() => setPage("todos")}>전체 보기</WidgetLink>}
    >
      {!todos || !todos.fileExists || todos.today.length === 0 ? (
        <Empty className="h-full rounded-lg border border-dashed bg-muted/30">
          일지에 오늘 할 일이 없습니다.
        </Empty>
      ) : (
        <div className="space-y-1">
          {todos.today.map((todo) => (
            <label
              key={todo.index}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-accent"
            >
              <input
                type="checkbox"
                checked={todo.checked}
                onChange={(event) => void onToggle(todo.index, event.target.checked)}
                className="size-4 shrink-0 accent-[var(--primary)]"
              />
              <span className={todo.checked ? "text-muted-foreground line-through" : "font-medium"}>
                {todo.text}
              </span>
            </label>
          ))}
          {todos.tomorrow.length > 0 && (
            <div className="mt-3 flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
              <CalendarDays className="size-3.5" /> 내일 예정 {todos.tomorrow.length}건
            </div>
          )}
        </div>
      )}
    </WidgetCard>
  );
}

function JobsWidget({
  jobs,
  progress,
  setPage,
}: {
  jobs: Job[];
  progress: Record<string, ProgressEntry[]>;
  setPage: (page: PageId) => void;
}) {
  return (
    <WidgetCard
      eyebrow="Live"
      icon={Activity}
      title="실행 현황"
      titleAfter={jobs.length > 0 ? <Badge variant="default">{jobs.length}</Badge> : null}
      action={<WidgetLink onClick={() => setPage("jobs")}>작업 열기</WidgetLink>}
    >
      {jobs.length === 0 ? (
        <Empty className="h-full rounded-lg border border-dashed bg-muted/30">
          <CheckCircle2 className="mx-auto mb-2 size-5 text-success" />
          대기 중인 작업이 없습니다.
        </Empty>
      ) : (
        <div className="space-y-2">
          {jobs.map((job) => (
            <ActiveJobRow key={job.id} job={job} entries={progress[job.id] ?? []} />
          ))}
        </div>
      )}
    </WidgetCard>
  );
}

function RoutinesWidget({
  config,
  jobs,
  missed,
  today,
  busy,
  setPage,
  onRun,
}: {
  config: ReturnType<typeof useApp.getState>["config"];
  jobs: Job[];
  missed: ReturnType<typeof useApp.getState>["missed"];
  today: string;
  busy: boolean;
  setPage: (page: PageId) => void;
  onRun: (routine: RoutineName) => Promise<void>;
}) {
  return (
    <WidgetCard
      icon={Clock3}
      title="오늘의 루틴"
      description="정해진 흐름을 확인하고 필요할 때 바로 실행하세요."
      action={<WidgetLink onClick={() => setPage("settings")}>일정 설정</WidgetLink>}
    >
      <div className="widget-routines-grid grid gap-2">
        {ROUTINES.map((routine) => {
          const schedule = config?.dashboard.schedules[routine.key];
          const routineJobs = jobs.filter(
            (job) => job.kind === "routine" && ROUTINE_LABEL_RE[routine.key].test(job.label),
          );
          const running = routineJobs.find((job) => job.status === "running");
          const queued = routineJobs.find((job) => job.status === "queued");
          const doneToday = routineJobs.some(
            (job) =>
              job.status === "success" &&
              job.finishedAtMs != null &&
              fmtDate(job.finishedAtMs) === today,
          );
          const isMissed = missed.some(
            (item) => item.routine === routine.key && item.date === today,
          );
          let state: { label: string; variant: BadgeVariant } = {
            label: "예정",
            variant: "outline",
          };
          if (running) state = { label: "실행 중", variant: "default" };
          else if (queued) state = { label: "대기", variant: "secondary" };
          else if (isMissed) state = { label: "놓침", variant: "warning" };
          else if (doneToday) state = { label: "완료", variant: "success" };
          else if (schedule && !schedule.enabled) state = { label: "꺼짐", variant: "outline" };

          return (
            <div
              key={routine.key}
              className="flex items-center gap-3 rounded-xl border bg-muted/15 p-3"
            >
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]">
                {doneToday ? <CheckCircle2 className="size-4" /> : <Clock3 className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{routine.label}</span>
                  <Badge variant={state.variant}>{state.label}</Badge>
                </div>
                <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                  {schedule?.enabled ? `${schedule.time} · ${routine.description}` : "비활성"}
                </p>
              </div>
              <Button
                size="icon"
                variant={isMissed ? "default" : "ghost"}
                className="size-8"
                title={`${routine.label} 루틴 지금 실행`}
                aria-label={`${routine.label} 루틴 지금 실행`}
                disabled={busy || !!running || !!queued}
                onClick={() => void onRun(routine.key)}
              >
                <Play />
              </Button>
            </div>
          );
        })}
      </div>
    </WidgetCard>
  );
}

function IssuesWidget({
  improvements,
  setPage,
}: {
  improvements: ReturnType<typeof useApp.getState>["improvements"];
  setPage: (page: PageId) => void;
}) {
  const stages = [
    ["제안", improvements.filter((issue) => issue.status === "제안").length],
    ["승인 대기", improvements.filter((issue) => issue.status === "승인대기").length],
    ["실행 대기", improvements.filter((issue) => issue.status === "승인").length],
    [
      "진행 중",
      improvements.filter((issue) =>
        ["진행중", "구현중", "부분완료", "부분구현"].includes(issue.status),
      ).length,
    ],
  ] as const;

  return (
    <WidgetCard
      icon={Workflow}
      title="이슈 워크플로"
      description="제안에서 실행까지 현재 병목을 확인합니다."
      action={<WidgetLink onClick={() => setPage("improve")}>이슈 보드</WidgetLink>}
    >
      <div className="widget-stage-grid grid gap-2">
        {stages.map(([label, count], index) => (
          <button
            key={label}
            onClick={() => setPage("improve")}
            className="relative rounded-xl border bg-muted/20 p-3 text-left transition-colors hover:border-[var(--brand-border)] hover:bg-[var(--brand-soft)]"
          >
            {index < 3 && (
              <ArrowRight className="absolute right-2 top-2 size-3 text-muted-foreground/50" />
            )}
            <div className="text-xl font-bold tabular-nums">{count}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{label}</div>
          </button>
        ))}
      </div>
      <div className="mt-3 border-t pt-3">
        <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">최근 변경</div>
        {improvements.length === 0 ? (
          <p className="text-xs text-muted-foreground">등록된 이슈가 없습니다.</p>
        ) : (
          <div className="widget-recent-grid grid gap-1">
            {improvements.slice(0, 4).map((issue) => (
              <button
                key={issue.path}
                onClick={() => setPage("improve")}
                className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
                title={issue.title}
              >
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {issue.id}
                </span>
                <span className="truncate text-xs font-medium">{issue.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </WidgetCard>
  );
}

function OperationsWidget({
  audit,
  lastFailed,
  setPage,
}: {
  audit: VaultAudit | null;
  lastFailed?: Job;
  setPage: (page: PageId) => void;
}) {
  return (
    <WidgetCard
      icon={Sparkles}
      title="운영 상태"
      description="볼트와 최근 실행 결과를 점검합니다."
      action={<WidgetLink onClick={() => setPage("vault")}>볼트 관리</WidgetLink>}
    >
      <div className="grid grid-cols-2 gap-2">
        <StatusCell
          label="오늘 일지"
          value={audit == null ? "검사 전" : audit.journal.todayExists ? "준비됨" : "없음"}
          good={audit?.journal.todayExists === true}
        />
        <StatusCell
          label="볼트 검사"
          value={
            audit == null
              ? "검사 전"
              : audit.issues.length === 0
                ? "정상"
                : `${audit.issues.length}건`
          }
          good={audit != null && audit.issues.length === 0}
        />
      </div>
      {lastFailed ? (
        <button
          onClick={() => setPage("jobs")}
          className="mt-2.5 flex w-full items-center gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10"
        >
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{lastFailed.label}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              마지막 실패 {lastFailed.finishedAtMs ? fmtClock(lastFailed.finishedAtMs) : ""} · 로그
              확인
            </div>
          </div>
          <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      ) : (
        <div className="mt-2.5 flex items-center gap-3 rounded-xl border bg-success/5 p-3">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-success/10 text-success">
            <CheckCircle2 className="size-4" />
          </div>
          <div>
            <div className="text-xs font-semibold">최근 실패 없음</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              모든 작업이 안정적으로 실행되었습니다.
            </div>
          </div>
        </div>
      )}
      <Button size="sm" variant="outline" className="mt-2.5 w-full" onClick={() => setPage("docs")}>
        마지막 리포트 열기 <ArrowRight />
      </Button>
    </WidgetCard>
  );
}

function WidgetCard({
  eyebrow,
  icon: Icon,
  title,
  titleAfter,
  description,
  action,
  children,
}: {
  eyebrow?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  titleAfter?: React.ReactNode;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <CardHeader className="shrink-0 flex-row items-start justify-between space-y-0">
        <div className="min-w-0">
          {eyebrow && (
            <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              <Icon className="size-3.5" /> {eyebrow}
            </div>
          )}
          <CardTitle className="flex items-center gap-2 text-sm">
            {!eyebrow && <Icon className="size-4 text-[var(--brand)]" />}
            {title}
            {titleAfter}
          </CardTitle>
          {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto">{children}</CardContent>
    </Card>
  );
}

function WidgetLink({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button size="xs" variant="ghost" onClick={onClick}>
      {children} <ArrowRight />
    </Button>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  detail: string;
  tone: "brand" | "success" | "warning" | "neutral";
  onClick: () => void;
}) {
  const toneClass = {
    brand: "bg-[var(--brand-soft)] text-[var(--brand)]",
    success: "bg-success/10 text-success",
    warning: "bg-warning/15 text-warning-foreground",
    neutral: "bg-muted text-muted-foreground",
  }[tone];
  return (
    <button
      onClick={onClick}
      className="group flex min-h-0 min-w-0 items-center gap-3 rounded-xl border bg-card p-3 text-left shadow-sm transition-all hover:border-[var(--brand-border)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className={`grid size-9 shrink-0 place-items-center rounded-xl ${toneClass}`}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
        <div className="mt-0.5 flex items-baseline gap-2">
          <span className="text-xl font-bold tabular-nums leading-none">{value}</span>
          <span className="truncate text-[10px] text-muted-foreground">{detail}</span>
        </div>
      </div>
      <ArrowRight className="size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function StatusCell({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-center gap-2 text-xs font-semibold">
        <span className={`size-1.5 rounded-full ${good ? "bg-success" : "bg-warning"}`} />
        {value}
      </div>
    </div>
  );
}

function ActiveJobRow({ job, entries }: { job: Job; entries: ProgressEntry[] }) {
  const last = entries[entries.length - 1];
  const elapsed = Date.now() - (job.startedAtMs ?? job.createdAtMs);
  const isRunning = job.status === "running";
  return (
    <div className="rounded-xl border bg-muted/15 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${isRunning ? "animate-pulse bg-[var(--brand)]" : "bg-muted-foreground/50"}`}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{job.label}</span>
        <Badge variant={jobStatusVariant(job)}>{jobStatusLabel(job)}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 pl-3.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {last ? entryText(last) : "진행 이벤트를 기다리는 중…"}
        </span>
        <span className="shrink-0 tabular-nums">{fmtDur(elapsed)}</span>
      </div>
    </div>
  );
}
