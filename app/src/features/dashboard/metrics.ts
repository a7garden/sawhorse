import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  Hourglass,
  Inbox,
  Pause,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  type LucideIcon,
} from "lucide-react";
import type { Job } from "@/lib/types";
import { isClosedStatus, type WorkItem, type HarnessRun } from "@/features/workbench/types";

/**
 * One metric card is one widget. Which number matters differs per person —
 * some want to know how many proposals piled up, others how many approvals
 * are backed up — so cards are not bundled or fixed; each can be toggled,
 * sized, and arranged individually from the catalog.
 */
export const METRIC_KEYS = [
  "backlog",
  "review",
  "ready",
  "running",
  "done",
  "hold",
  "overdue",
  "due-today",
  "due-week",
  "assigned",
  "needs-approval",
  "blocked",
  "done-today",
  "done-week",
  "jobs-live",
  "jobs-failed",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type MetricWidgetId = `metric:${MetricKey}`;

export const METRIC_PREFIX = "metric:";
export function metricWidgetId(key: MetricKey): MetricWidgetId {
  return `${METRIC_PREFIX}${key}`;
}
export function isMetricWidgetId(id: string): id is MetricWidgetId {
  return (
    id.startsWith(METRIC_PREFIX) &&
    (METRIC_KEYS as readonly string[]).includes(id.slice(METRIC_PREFIX.length))
  );
}

/** Ingredients the metrics count. Only uses what the dashboard already holds. */
export interface MetricSource {
  work: WorkItem[];
  jobs: Job[];
  runs?: HarnessRun[];
  /** YYYY-MM-DD local date. Passed in by the caller so it stays stable across renders. */
  today: string;
}

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  /** One line under the card. Also used verbatim as the catalog description. */
  hint: string;
  icon: LucideIcon;
  /** Screen to navigate to when the card is pressed. */
  page: string;
  /** Whether to paint in warning color when greater than 0. */
  warnWhenPositive?: boolean;
  count: (source: MetricSource) => number;
}

function localDate(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function shiftDays(date: string, days: number) {
  const next = new Date(`${date}T00:00:00`);
  next.setDate(next.getDate() + days);
  return localDate(next);
}
/** Open items — anything not done/rejected/cancelled. All due-date and assignee metrics use this baseline. */
function isOpen(item: WorkItem) {
  return !isClosedStatus(item.status);
}
function countWork(
  work: WorkItem[],
  predicate: (item: WorkItem) => boolean,
): number {
  return work.filter(predicate).length;
}

export const METRIC_DEFINITIONS: MetricDefinition[] = [
  {
    key: "backlog",
    label: "제안",
    hint: "아직 검토 전인 요청",
    icon: Inbox,
    page: "issues",
    count: ({ work }) => countWork(work, (item) => item.status === "backlog"),
  },
  {
    key: "review",
    label: "승인 대기",
    hint: "검토·승인을 기다리는 항목",
    icon: Hourglass,
    page: "issues",
    count: ({ work }) => countWork(work, (item) => item.status === "review"),
  },
  {
    key: "ready",
    label: "실행 대기",
    hint: "바로 시작할 개발 항목",
    icon: ArrowRight,
    page: "board",
    count: ({ work }) => countWork(work, (item) => item.status === "ready"),
  },
  {
    key: "running",
    label: "진행 중",
    hint: "지금 손대고 있는 항목",
    icon: CircleDot,
    page: "board",
    count: ({ work }) => countWork(work, (item) => item.status === "running"),
  },
  {
    key: "done",
    label: "완료",
    hint: "축적된 결과",
    icon: Check,
    page: "board",
    count: ({ work }) => countWork(work, (item) => item.status === "done"),
  },
  // The single `hold` card below counts these. This card is closed-but-not-done.
  {
    key: "hold",
    label: "반려·취소",
    hint: "받아들이지 않았거나 중간에 그만둔 항목",
    icon: Pause,
    page: "issues",
    count: ({ work }) =>
      countWork(
        work,
        (item) => item.status === "rejected" || item.status === "cancelled",
      ),
  },
  {
    key: "overdue",
    label: "기한 초과",
    hint: "마감일이 지난 항목",
    icon: AlertTriangle,
    page: "board",
    warnWhenPositive: true,
    count: ({ work, today }) =>
      countWork(
        work,
        (item) => isOpen(item) && !!item.dueDate && item.dueDate < today,
      ),
  },
  {
    key: "due-today",
    label: "오늘 마감",
    hint: "오늘까지 끝내야 하는 항목",
    icon: Clock3,
    page: "board",
    warnWhenPositive: true,
    count: ({ work, today }) =>
      countWork(work, (item) => isOpen(item) && item.dueDate === today),
  },
  {
    key: "due-week",
    label: "7일 내 마감",
    hint: "이번 주 안에 닥치는 기한",
    icon: CalendarClock,
    page: "board",
    count: ({ work, today }) => {
      const limit = shiftDays(today, 7);
      return countWork(
        work,
        (item) =>
          isOpen(item) &&
          !!item.dueDate &&
          item.dueDate > today &&
          item.dueDate <= limit,
      );
    },
  },
  {
    key: "assigned",
    label: "담당 지정",
    hint: "담당자가 정해진 열린 항목",
    icon: UserCheck,
    page: "board",
    count: ({ work }) =>
      countWork(
        work,
        (item) =>
          isOpen(item) && (!!item.owner || (item.assignees?.length ?? 0) > 0),
      ),
  },
  {
    key: "needs-approval",
    label: "승인 필요",
    hint: "승인 없이는 못 넘어가는 항목",
    icon: ShieldCheck,
    page: "issues",
    warnWhenPositive: true,
    count: ({ work }) =>
      countWork(
        work,
        (item) => item.status === "backlog" || item.status === "review",
      ),
  },
  {
    key: "blocked",
    label: "보류",
    hint: "누군가 풀어줘야 움직이는 항목",
    icon: Ban,
    page: "board",
    warnWhenPositive: true,
    count: ({ work }) => countWork(work, (item) => item.status === "blocked"),
  },
  {
    key: "done-today",
    label: "오늘 완료",
    hint: "오늘 끝낸 개발 항목",
    icon: CircleCheck,
    page: "board",
    count: ({ work, today }) =>
      countWork(
        work,
        (item) =>
          item.status === "done" && item.updatedAt.slice(0, 10) === today,
      ),
  },
  {
    key: "done-week",
    label: "최근 7일 완료",
    hint: "일주일간 처리한 양",
    icon: TrendingUp,
    page: "board",
    count: ({ work, today }) => {
      const from = shiftDays(today, -6);
      return countWork(
        work,
        (item) => item.status === "done" && item.updatedAt.slice(0, 10) >= from,
      );
    },
  },
  {
    key: "jobs-live",
    label: "실행 중",
    hint: "대기·실행 중인 에이전트 작업",
    icon: Activity,
    page: "jobs",
    count: ({ jobs, runs = [] }) =>
      jobs.filter((job) => job.status === "running" || job.status === "queued").length +
      runs.filter((run) => run.status === "starting" || run.status === "running").length,
  },
  {
    key: "jobs-failed",
    label: "실행 실패",
    hint: "오늘 실패한 에이전트 작업",
    icon: CircleX,
    page: "jobs",
    warnWhenPositive: true,
    count: ({ jobs, runs = [], today }) => {
      const dayStart = new Date(`${today}T00:00:00`).getTime();
      return jobs.filter(
        (job) =>
          job.status === "failed" &&
          (job.startedAtMs ?? job.createdAtMs) >= dayStart,
      ).length + runs.filter((run) => run.status === "failed" && new Date(run.updatedAt).getTime() >= dayStart).length;
    },
  },
];

export const METRIC_BY_KEY = Object.fromEntries(
  METRIC_DEFINITIONS.map((metric) => [metric.key, metric]),
) as Record<MetricKey, MetricDefinition>;

/** The four cards the old 'core metrics' bundle showed. Baseline for the default dashboard and for migration. */
export const DEFAULT_METRIC_KEYS: MetricKey[] = [
  "running",
  "ready",
  "overdue",
  "done",
];
