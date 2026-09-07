import "@/features/journal/journal.css";
import { jobsForProject } from "@/features/workbench/project-scope";
import type { Project } from "@/features/workbench/types";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { activeJob } from "@/lib/jobs";
import { useCoreExtensions } from "@/lib/core-extensions";
import {
  isFeedCfg,
  type ArticleRow,
  type Job,
  type TaskRow,
} from "@/lib/types";
import {
  STATUS_LABELS,
  type CalendarEvent,
  type WorkItem,
  type WorkStatus,
} from "@/features/workbench/types";

function cx(...names: Array<string | false | null | undefined>) {
  return names.filter(Boolean).join(" ");
}

/** 주기적으로 다시 그린다. null 이면 멈춘다 — 경과 시간·현재 시각 표시용. */
function useTicker(periodMs: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (periodMs == null) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), periodMs);
    return () => window.clearInterval(timer);
  }, [periodMs]);
}

function localDate(value = new Date()) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function clockText(ms: number) {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function durText(ms: number, t: TFunction) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t("duration.seconds", { n: total });
  if (total < 3600)
    return t("duration.minutes", { n: Math.floor(total / 60) });
  return t("duration.hoursMinutes", {
    h: Math.floor(total / 3600),
    m: Math.floor((total % 3600) / 60),
  });
}

/** 자정부터 흐른 비율. 타임라인 좌표의 단일 출처. */
function dayFraction(ms: number, dayStart: number) {
  return Math.min(1, Math.max(0, (ms - dayStart) / 86_400_000));
}

export interface DistSegment {
  key: string;
  label: string;
  value: number;
  tone: string;
}

/** 누적 막대 + 범례. 범례를 누르면 아래 목록이 그 구간으로 좁혀진다. */
export function DistBar({
  segments,
  active,
  onPick,
  label,
}: {
  segments: DistSegment[];
  active?: string | null;
  onPick?: (key: string | null) => void;
  label: string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div className="wb-dist">
      <div
        className="wb-dist-bar"
        role="img"
        aria-label={`${label}: ${segments
          .map((segment) => `${segment.label} ${segment.value}`)
          .join(", ")}`}
      >
        {total === 0 ? (
          <span className="wb-dist-seg is-empty" style={{ width: "100%" }} />
        ) : (
          segments
            .filter((segment) => segment.value > 0)
            .map((segment) => (
              <span
                key={segment.key}
                className={`wb-dist-seg is-${segment.tone}`}
                style={{ width: `${(segment.value / total) * 100}%` }}
              />
            ))
        )}
      </div>
      <div className="wb-dist-legend">
        {segments.map((segment) => (
          <button
            key={segment.key}
            type="button"
            className={cx(
              "wb-dist-chip",
              `is-${segment.tone}`,
              active === segment.key && "is-active",
            )}
            aria-pressed={onPick ? active === segment.key : undefined}
            disabled={!onPick}
            onClick={() =>
              onPick?.(active === segment.key ? null : segment.key)
            }
          >
            <i aria-hidden />
            {segment.label}
            <strong>{segment.value}</strong>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 행 안에서 바로 누르는 작은 버튼. 위젯이 열람이 아니라 처리 장소가 되게 한다. */
export function MiniAction({
  label,
  icon,
  primary,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx("wb-mini-action", primary && "is-primary")}
      title={label}
      disabled={busy || disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {busy ? <Loader2 size={13} className="wb-spin" /> : icon}
      <span>{label}</span>
    </button>
  );
}

/* ---------------------------------------------------------------- 이슈 */

/**
 * 상태 어휘는 개발 항목 하나뿐이다. 이슈 노트의 제안·승인대기·… 는 더 이상
 * 별도 축이 아니라 아래 묶음으로 읽힌다.
 */
const ISSUE_GROUPS: {
  key: string;
  label: string;
  tone: string;
  statuses: WorkStatus[];
}[] = [
  { key: "backlog", label: "제안", tone: "idea", statuses: ["backlog"] },
  { key: "review", label: "승인 대기", tone: "wait", statuses: ["review"] },
  { key: "ready", label: "실행 대기", tone: "ready", statuses: ["ready"] },
  { key: "running", label: "진행", tone: "run", statuses: ["running"] },
  { key: "done", label: "완료", tone: "done", statuses: ["done"] },
  { key: "blocked", label: "보류", tone: "hold", statuses: ["blocked"] },
  // 보류는 아직 열린 항목이고 반려·취소는 닫힌 항목이다. 한 묶음에 섞으면
  // 「보류 3건」이 실제로는 손댈 수 없는 건수를 뜻하게 된다.
  {
    key: "dropped",
    label: "반려·취소",
    tone: "hold",
    statuses: ["rejected", "cancelled"],
  },
];
const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

function issueGroup(status: string) {
  return (
    ISSUE_GROUPS.find((group) => group.statuses.includes(status as WorkStatus))
      ?.key ?? "blocked"
  );
}

/** Summary of the work lifecycle. Decisions always open the shared work detail. */
export function IssuesWidget({ work, onOpen }: {
  work: WorkItem[];
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const [filter, setFilter] = useState<string | null>(null);

  const segments = useMemo(
    () =>
      ISSUE_GROUPS.map((group) => ({
        key: group.key,
        label: t(`issues.groups.${group.key}`),
        tone: group.tone,
        value: work.filter((item) => issueGroup(item.status) === group.key)
          .length,
      })),
    [work, t],
  );
  const rows = useMemo(() => {
    const pool = filter
      ? work.filter((item) => issueGroup(item.status) === filter)
      : work.filter((item) => (item.state || "open") === "open");
    return [...pool]
      .sort(
        (a, b) =>
          (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, 8);
  }, [work, filter]);

  if (!work.length)
    return <div className="wb-slot-empty">{t("issues.empty")}</div>;

  return (
    <div className="wb-widget-body">
      <DistBar
        label={t("issues.distribution")}
        segments={segments}
        active={filter}
        onPick={setFilter}
      />
      <div className="wb-action-list">
        {rows.map((item) => {
          const group = issueGroup(item.status);
          return (
            <div key={item.id} className="wb-action-row">
              <button
                type="button"
                className="wb-action-main"
                onClick={() => onOpen(item.id)}
                title={item.title}
              >
                <span className={`wb-dot is-${group}`} />
                <span className="wb-action-text">
                  <strong>{item.title}</strong>
                  <small>
                    {item.id} · {STATUS_LABELS[item.status]}
                    {` · ${item.executionType}`}
                    {item.milestone ? ` · ${item.milestone}` : ""}
                  </small>
                </span>
              </button>
              <div className="wb-action-buttons">
                <MiniAction label={t("issues.actions.open")} icon={<CircleDot size={13} />} onClick={() => onOpen(item.id)} />
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <div className="wb-slot-empty">
            {t("issues.emptyFilter")}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 실행 현황 */

const JOB_TONE: Record<string, string> = {
  queued: "wait",
  running: "run",
  success: "done",
  failed: "fail",
  cancelled: "hold",
  interrupted: "hold",
};
const JOB_LABEL: Record<string, string> = {
  queued: "대기",
  running: "실행 중",
  success: "성공",
  failed: "실패",
  cancelled: "취소됨",
  interrupted: "중단됨",
};

/** 렌더 시점에 상태 라벨을 번들에서 꺼낸다. 모르는 상태는 원문 그대로. */
function jobStatusLabel(status: string, t: TFunction) {
  return JOB_LABEL[status] ? t(`jobs.status.${status}`) : status;
}

export function JobsWidget({ onOpen, project }: { onOpen: () => void; project?: Project }) {
  const { t } = useTranslation("dashboard");
  const allJobs = useApp((s) => s.jobs);
  const jobs = jobsForProject(allJobs, project);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const [busy, setBusy] = useState<string | null>(null);
  const live = jobs.filter(
    (job) => job.status === "running" || job.status === "queued",
  );
  useTicker(live.length ? 1000 : null);
  useEffect(() => {
    refreshJobs().catch(() => {});
  }, [refreshJobs]);

  const segments = (
    ["running", "queued", "success", "failed", "cancelled"] as const
  )
    .map((status) => ({
      key: status,
      label: jobStatusLabel(status, t),
      tone: JOB_TONE[status],
      value: jobs.filter((job) => job.status === status).length,
    }))
    .filter((segment) => segment.value > 0 || segment.key === "success");

  async function stop(job: Job) {
    setBusy(job.id);
    try {
      await api.cancelJob(job.id);
      await refreshJobs();
    } catch {
      // 취소 실패는 다음 새로고침에서 드러난다
    } finally {
      setBusy(null);
    }
  }

  if (!jobs.length)
    return <div className="wb-slot-empty">{t("jobs.empty")}</div>;

  const rows = [...live, ...jobs.filter((job) => !live.includes(job))].slice(
    0,
    7,
  );
  return (
    <div className="wb-widget-body">
      <DistBar label={t("jobs.distribution")} segments={segments} />
      <div className="wb-action-list">
        {rows.map((job) => {
          const running = job.status === "running" || job.status === "queued";
          const from = job.startedAtMs ?? job.createdAtMs;
          const elapsed = running
            ? Date.now() - from
            : (job.finishedAtMs ?? from) - from;
          return (
            <div key={job.id} className="wb-action-row">
              <button
                type="button"
                className="wb-action-main"
                onClick={onOpen}
                title={job.label}
              >
                <span
                  className={`wb-dot is-${JOB_TONE[job.status] ?? "run"}`}
                />
                <span className="wb-action-text">
                  <strong>{job.label}</strong>
                  <small>
                    {jobStatusLabel(job.status, t)} ·{" "}
                    {running
                      ? t("jobs.elapsed", { time: durText(elapsed, t) })
                      : durText(elapsed, t)}
                    {job.finishedAtMs
                      ? ` · ${clockText(job.finishedAtMs)}`
                      : ""}
                  </small>
                </span>
              </button>
              <div className="wb-action-buttons">
                {running && (
                  <MiniAction
                    label={t("jobs.actions.stop")}
                    icon={<Square size={13} />}
                    busy={busy === job.id}
                    onClick={() => void stop(job)}
                  />
                )}
                <MiniAction
                  label={t("jobs.actions.log")}
                  icon={<ChevronRight size={13} />}
                  onClick={onOpen}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ 예약과 반복 */

function scheduleText(row: TaskRow, t: TFunction) {
  const schedule = row.def.schedule;
  if (!schedule) return t("schedules.noSchedule");
  const kind =
    schedule.kind === "once"
      ? (schedule.date ?? t("schedules.onDate"))
      : schedule.kind === "weekdays"
        ? t("schedules.weekdays")
        : t("schedules.everyday");
  return `${kind} ${schedule.time}`;
}

export function ScheduledTasksWidget() {
  const { t } = useTranslation("dashboard");
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const jobs = useApp((s) => s.jobs);

  const load = async () => {
    const view = await api.listTasks();
    setRows([...view.builtin, ...view.tasks].filter((row) => row.def.schedule));
    setError("");
  };
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .listTasks()
        .then((view) => {
          if (!alive) return;
          setRows(
            [...view.builtin, ...view.tasks].filter((row) => row.def.schedule),
          );
          setError("");
        })
        .catch((cause) => {
          if (alive) setError(String(cause));
        });
    void tick();
    const timer = window.setInterval(() => void tick(), 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function run(row: TaskRow) {
    setBusy(`${row.def.id}:run`);
    setMessage(null);
    try {
      await api.runTaskNow(row.def.id);
      await refreshJobs();
      setMessage(
        t("schedules.messages.runRegistered", { title: row.def.title }),
      );
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(null);
    }
  }

  /** 돌고 있는 같은 작업을 멈춘다 — 버튼 하나가 실행과 중단을 겸한다. */
  async function stopRun(row: TaskRow, job: Job) {
    setBusy(`${row.def.id}:run`);
    setMessage(null);
    try {
      await api.cancelJob(job.id);
      await refreshJobs();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(row: TaskRow) {
    setBusy(`${row.def.id}:toggle`);
    setMessage(null);
    try {
      await api.setTaskEnabled(row.def.id, !row.def.enabled);
      await load();
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="wb-slot-empty">{error}</div>;
  if (!rows.length)
    return (
      <div className="wb-slot-empty">
        {t("schedules.empty")}
      </div>
    );

  return (
    <div className="wb-widget-body">
      {message && (
        <p className="wb-widget-note" role="status">
          {message}
        </p>
      )}
      <div className="wb-action-list">
        {rows.map((row) => {
          const active = activeJob(jobs, row.jobKey);
          return (
            <div key={row.def.id} className="wb-action-row">
              <span className="wb-action-main is-static">
                <span
                  className={cx(
                    "wb-dot",
                    row.def.enabled ? "is-ready" : "is-hold",
                  )}
                />
                <span className="wb-action-text">
                  <strong>{row.def.title}</strong>
                  <small>
                    {scheduleText(row, t)}
                    {row.lastRun
                      ? t("schedules.lastRun", { time: row.lastRun })
                      : ""}
                    {row.def.enabled ? "" : t("schedules.pausedSuffix")}
                  </small>
                </span>
              </span>
              <div className="wb-action-buttons">
                <MiniAction
                  label={
                    active
                      ? active.status === "running"
                        ? t("schedules.stopRunning")
                        : t("schedules.stopQueued")
                      : t("schedules.runNow")
                  }
                  primary
                  icon={active ? <Square size={13} /> : <Play size={13} />}
                  busy={busy === `${row.def.id}:run`}
                  onClick={() =>
                    void (active ? stopRun(row, active) : run(row))
                  }
                />
                <MiniAction
                  label={
                    row.def.enabled
                      ? t("schedules.pause")
                      : t("schedules.resume")
                  }
                  icon={
                    row.def.enabled ? <Pause size={13} /> : <Play size={13} />
                  }
                  busy={busy === `${row.def.id}:toggle`}
                  onClick={() => void toggle(row)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ 할 일 */

/** 오늘 일지의 체크리스트. 개발 항목이나 자동화 작업가 아니라 일지 문서의 한 줄이다. */
export function ChecklistWidget({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation("dashboard");
  const todos = useApp((s) => s.todos);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    refreshTodos().catch((cause) => setError(String(cause)));
  }, [refreshTodos]);

  async function toggle(index: number, checked: boolean) {
    setBusy(index);
    try {
      await api.toggleTodo("today", index, checked);
      await refreshTodos();
      setError("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(null);
    }
  }

  const { t: jt, i18n } = useTranslation("journal");
  const items = todos?.today ?? [];
  const done = items.filter((item) => item.checked).length;
  const percent = items.length ? Math.round(done / items.length * 100) : 0;
  const ordered = [...items].sort((a, b) => Number(a.checked) - Number(b.checked));
  return (
    <div className="journal-checklist">
      <div className="journal-checklist-summary">
        <div className="journal-checklist-ring" role="progressbar" aria-label={jt("checklistTitle")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="22" fill="none" stroke="var(--border)" strokeWidth="3" /><circle cx="26" cy="26" r="22" fill="none" stroke="var(--primary)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${percent * 1.3823} 138.23`} /></svg>
          <span>{percent}%</span>
        </div>
        <div><strong>{jt(!items.length ? "checklistTitle" : done === items.length ? "allDone" : "remaining", { count: items.length - done })}</strong><small>{new Date().toLocaleDateString(i18n.language, { month: "long", day: "numeric", weekday: "short" })} · {jt("checklistProgress", { done, total: items.length })}</small></div>
      </div>
      {error && <p className="wb-widget-note" role="alert">{error}</p>}
      {!items.length && <p className="journal-empty">{todos ? t(todos.fileExists ? "checklist.empty" : "checklist.noJournal") : jt("loading")}</p>}
      {ordered.slice(0, 5).map((item) => <label key={item.index} className={cx("journal-checklist-row", item.checked && "is-done")}>
        <input type="checkbox" checked={item.checked} disabled={busy !== null} onChange={(event) => void toggle(item.index, event.target.checked)} />
        <span>{item.text}</span>
      </label>)}
      <button className="journal-checklist-footer" onClick={onOpen}><span>{jt(items.length > 5 ? "more" : "viewChecklist", { count: items.length })}</span><ChevronRight size={14} /></button>
    </div>
  );
}

/* -------------------------------------------------------------- 읽을거리 */

export function ReadingWidget({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation("dashboard");
  const enabled = useCoreExtensions((s) => s.feeds);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = async () => {
      try {
        const { instances } = await api.sourcesListInstances();
        const groups = await Promise.all(
          instances
            .filter((instance) => isFeedCfg(instance.config))
            .map((instance) => api.articlesList(instance.instanceId)),
        );
        if (alive) {
          setArticles(
            groups
              .flatMap((group) => group.articles)
              .filter((article) => !article.archived && !article.read)
              .slice(0, 8),
          );
          setError("");
        }
      } catch (cause) {
        if (alive) setError(String(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  async function markRead(article: ArticleRow) {
    setBusy(article.id);
    try {
      await api.articleSetState({ articleId: article.id, read: true });
      setArticles((prev) => prev.filter((row) => row.id !== article.id));
    } catch {
      // 목록은 30초마다 다시 채워진다
    } finally {
      setBusy(null);
    }
  }

  if (!enabled)
    return (
      <div className="wb-slot-empty">
        {t("reading.disabled")}
      </div>
    );
  if (!articles.length)
    return (
      <div className="wb-slot-empty">
        {error || t("reading.empty")}
      </div>
    );

  return (
    <div className="wb-widget-body">
      <div className="wb-action-list">
        {articles.map((article) => (
          <div key={article.id} className="wb-action-row">
            <button
              type="button"
              className="wb-action-main"
              onClick={onOpen}
              title={article.title}
            >
              <span className="wb-dot is-idea" />
              <span className="wb-action-text">
                <strong>{article.title}</strong>
                <small>{article.publishedAt || article.discoveredAt}</small>
              </span>
            </button>
            <div className="wb-action-buttons">
              <MiniAction
                label={t("reading.markRead")}
                icon={<Check size={13} />}
                busy={busy === article.id}
                onClick={() => void markRead(article)}
              />
              <MiniAction
                label={t("reading.openSource")}
                icon={<ExternalLink size={13} />}
                onClick={() => void api.openExternal(article.url)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- 오늘 활동 */

/**
 * 오늘 하루를 24시간 타임라인 한 줄로 그린다. 실행은 시작·종료 시각 그대로 놓이고
 * 지금 시각에는 세로선이 선다 — "오늘 무슨 일이 있었나"를 목록이 아니라 위치로
 * 읽히게 하는 것이 이 위젯의 존재 이유다. 캘린더 화면 머리에서도 같은 것을 쓴다.
 */
export function TodayActivity({
  project,
  events,
  work,
  onOpenWork,
  onOpenEvent,
  onOpenJobs,
  compact,
}: {
  project?: Project;
  events: CalendarEvent[];
  work: WorkItem[];
  onOpenWork: (id: string) => void;
  onOpenEvent: (event: CalendarEvent) => void;
  onOpenJobs: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslation("dashboard");
  const allJobs = useApp((s) => s.jobs);
  const jobs = jobsForProject(allJobs, project);
  const allTodos = useApp((s) => s.todos);
  const todos = project ? null : allTodos;
  const refreshJobs = useApp((s) => s.refreshJobs);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const [busyTodo, setBusyTodo] = useState<number | null>(null);
  const today = localDate();
  const dayStart = new Date(`${today}T00:00:00`).getTime();
  const dayEnd = dayStart + 86_400_000;
  const anyLive = jobs.some(
    (job) => job.status === "running" || job.status === "queued",
  );
  // 실행이 없어도 "지금" 표시선은 움직여야 하므로 느리게라도 계속 돈다.
  useTicker(anyLive ? 1000 : 30000);

  useEffect(() => {
    if (!project && !todos) refreshTodos().catch(() => {});
  }, [project, todos, refreshTodos]);
  useEffect(() => {
    refreshJobs().catch(() => {});
  }, [refreshJobs]);

  const todayJobs = jobs.filter((job) => {
    const from = job.startedAtMs ?? job.createdAtMs;
    return from >= dayStart && from < dayEnd;
  });
  const todayEvents = events.filter(
    (event) => event.date <= today && (event.endDate ?? event.date) >= today,
  );
  const dueToday = work.filter(
    (item) => item.dueDate === today && item.status !== "done",
  );
  const doneToday = work.filter(
    (item) => item.status === "done" && item.updatedAt.slice(0, 10) === today,
  );
  const counts = {
    live: todayJobs.filter(
      (job) => job.status === "running" || job.status === "queued",
    ).length,
    success: todayJobs.filter((job) => job.status === "success").length,
    failed: todayJobs.filter((job) => job.status === "failed").length,
  };
  const todoDone = todos?.today.filter((todo) => todo.checked).length ?? 0;
  const todoTotal = todos?.today.length ?? 0;
  const nowPercent = dayFraction(Date.now(), dayStart) * 100;

  async function toggleTodo(index: number, checked: boolean) {
    setBusyTodo(index);
    try {
      await api.toggleTodo("today", index, checked);
      await refreshTodos();
    } catch {
      // 일지 문서가 없으면 토글은 조용히 실패한다
    } finally {
      setBusyTodo(null);
    }
  }

  return (
    <div className={cx("wb-today", compact && "is-compact")}>
      <div className="wb-today-stats">
        <button type="button" className="wb-today-stat" onClick={onOpenJobs}>
          <strong>{counts.live}</strong>
          <span>{t("today.live")}</span>
        </button>
        <button type="button" className="wb-today-stat" onClick={onOpenJobs}>
          <strong>{counts.success}</strong>
          <span>{t("today.successRuns")}</span>
        </button>
        <button
          type="button"
          className={cx("wb-today-stat", counts.failed > 0 && "is-warn")}
          onClick={onOpenJobs}
        >
          <strong>{counts.failed}</strong>
          <span>{t("today.failed")}</span>
        </button>
        {!project && <div className="wb-today-stat is-static">
          <strong>
            {todoDone}
            <small>/{todoTotal}</small>
          </strong>
          <span>{t("today.todos")}</span>
        </div>}
      </div>

      <div className="wb-today-timeline">
        <div className="wb-today-track">
          {[6, 12, 18].map((hour) => (
            <span
              key={hour}
              className="wb-today-tick"
              style={{ left: `${(hour / 24) * 100}%` }}
            />
          ))}
          {todayJobs.map((job) => {
            const from = job.startedAtMs ?? job.createdAtMs;
            const to = Math.max(job.finishedAtMs ?? Date.now(), from + 120_000);
            const left = dayFraction(from, dayStart) * 100;
            const width = Math.min(
              100 - left,
              Math.max(
                1.2,
                (dayFraction(to, dayStart) - dayFraction(from, dayStart)) * 100,
              ),
            );
            const text = `${clockText(from)} ${job.label} · ${jobStatusLabel(
              job.status,
              t,
            )}`;
            return (
              <button
                key={job.id}
                type="button"
                className={`wb-today-bar is-${JOB_TONE[job.status] ?? "run"}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={text}
                aria-label={text}
                onClick={onOpenJobs}
              />
            );
          })}
          <span
            className="wb-today-now"
            style={{ left: `${nowPercent}%` }}
            title={t("today.now", { time: clockText(Date.now()) })}
          />
        </div>
        <div className="wb-today-scale" aria-hidden>
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h}>{t("today.hour", { h })}</span>
          ))}
        </div>
        {!todayJobs.length && (
          <p className="wb-today-hint">{t("today.noRuns")}</p>
        )}
      </div>

      {todoTotal > 0 && (
        <div className="wb-today-todos">
          <div className="wb-progress" aria-hidden>
            <span style={{ width: `${(todoDone / todoTotal) * 100}%` }} />
          </div>
          {todos!.today.slice(0, compact ? 3 : 5).map((todo) => (
            <label key={todo.index} className="wb-today-todo">
              <input
                type="checkbox"
                checked={todo.checked}
                disabled={busyTodo === todo.index}
                onChange={(event) =>
                  void toggleTodo(todo.index, event.target.checked)
                }
              />
              <span className={todo.checked ? "is-done" : undefined}>
                {todo.text}
              </span>
            </label>
          ))}
        </div>
      )}

      {(todayEvents.length > 0 ||
        dueToday.length > 0 ||
        doneToday.length > 0) && (
        <div className="wb-today-list">
          {todayEvents.map((event) => (
            <button
              key={event.id}
              type="button"
              className="wb-today-item"
              onClick={() => onOpenEvent(event)}
            >
              <span className="wb-dot is-ready" />
              <span className="wb-action-text">
                <strong>{event.title}</strong>
                <small>{t("today.eventTag")}</small>
              </span>
            </button>
          ))}
          {dueToday.map((item) => (
            <button
              key={item.id}
              type="button"
              className="wb-today-item"
              onClick={() => onOpenWork(item.id)}
            >
              <span className="wb-dot is-wait" />
              <span className="wb-action-text">
                <strong>{item.title}</strong>
                <small>{t("today.dueTag")}</small>
              </span>
            </button>
          ))}
          {doneToday.slice(0, 3).map((item) => (
            <button
              key={item.id}
              type="button"
              className="wb-today-item"
              onClick={() => onOpenWork(item.id)}
            >
              <CircleCheck size={13} className="wb-done-check" />
              <span className="wb-action-text">
                <strong>{item.title}</strong>
                <small>{t("today.doneTag")}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
