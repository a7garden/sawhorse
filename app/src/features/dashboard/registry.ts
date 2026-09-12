import type { LayoutItem, ResponsiveLayouts } from "react-grid-layout";
import {
  DEFAULT_METRIC_KEYS,
  METRIC_DEFINITIONS,
  isMetricWidgetId,
  metricWidgetId,
  type MetricWidgetId,
} from "./metrics";
export type DashboardBreakpoint = "lg" | "md" | "sm";
export type PanelWidgetId =
  | "projects"
  | "documents"
  | "today"
  | "next"
  | "stages"
  | "due"
  | "events"
  | "done"
  | "jobs"
  | "schedules"
  | "issues"
  | "reading"
  | "checklist"
  | "journal";
/** List-style panel widgets and individual metric cards live on the same board as equals. */
export type DashboardWidgetId = PanelWidgetId | MetricWidgetId;
export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  title: string;
  description: string;
  category: string;
  categoryKey: string;
  defaultLayout: Record<DashboardBreakpoint, Omit<LayoutItem, "i">>;
}
export const DASHBOARD_BREAKPOINTS = { lg: 900, md: 620, sm: 0 };
export const DASHBOARD_COLS = { lg: 12, md: 8, sm: 4 };
// Categories reuse the sidebar entry names — work (WorkItem) / automation (TaskDef) / vault.
// Metrics alone belong to no screen, being a single card of numbers, so they use their own name.
const panelEntries: [PanelWidgetId, string, string, string, string][] = [
  ["projects", "프로젝트 현황", "프로젝트별 진행·검토·보류", "개발", "dev"],
  ["documents", "작업 문서", "워크플로우별 산출물과 문서 열기", "워크플로", "workflow"],
  [
    "today",
    "오늘 활동",
    "오늘 실행·일정·할 일의 24시간 타임라인",
    "캘린더",
    "calendar",
  ],
  ["next", "다음 개발 항목", "기한과 우선순위순", "개발", "dev"],
  ["issues", "이슈", "상태 분포와 승인·설계·실행", "이슈", "issues"],
  ["due", "기한 임박", "일주일 안에 마감되는 개발 항목", "개발", "dev"],
  ["events", "임박 일정", "다가오는 약속과 마일스톤", "캘린더", "calendar"],
  ["stages", "단계별 맥락", "개발 흐름의 진행 상황", "워크플로", "workflow"],
  ["done", "최근 완료", "완료한 개발 항목과 결과", "개발", "dev"],
  ["jobs", "실행 현황", "에이전트의 최근 실행과 중지", "실행", "jobs"],
  [
    "schedules",
    "예약과 반복",
    "등록된 자동화 작업의 시간과 즉시 실행",
    "자동화",
    "automation",
  ],
  [
    "reading",
    "읽을거리",
    "RSS로 받아온 읽지 않은 새 글",
    "코어 확장",
    "extensions",
  ],
  ["journal", "일지", "달력과 최근 일지 모아보기", "볼트", "vault"],
  ["checklist", "할 일", "오늘 일지에 적어 둔 체크리스트", "볼트", "vault"],
];
const metricEntries: [DashboardWidgetId, string, string, string, string][] =
  METRIC_DEFINITIONS.map((metric) => [
    metricWidgetId(metric.key),
    metric.label,
    metric.hint,
    "지표",
    "metrics",
  ]);
const entries = [...metricEntries, ...panelEntries];

/**
 * Intrinsic widget sizes. A metric card is a single number so it starts small;
 * the timeline needs a broad column, and project and calendar lists each get
 * half a desktop row. Narrow screens preserve the same reading order.
 */
function sizeOf(
  id: DashboardWidgetId,
  breakpoint: DashboardBreakpoint,
): { w: number; h: number; minW: number; minH: number } {
  const cols = DASHBOARD_COLS[breakpoint];
  if (isMetricWidgetId(id))
    return {
      w: breakpoint === "lg" ? 3 : 2,
      h: 3,
      minW: 2,
      minH: 2,
    };
  if (breakpoint === "lg")
    return {
      w: id === "today" ? 8 : id === "jobs" ? 4 : 6,
      h: ["projects", "events", "due", "schedules"].includes(id) ? 8 : 9,
      minW: 3,
      minH: 3,
    };
  if (breakpoint === "md")
    return { w: ["jobs", "projects", "events", "due"].includes(id) ? 4 : cols, h: id === "today" ? 10 : 8, minW: 3, minH: 3 };
  return { w: cols, h: id === "today" ? 11 : 8, minW: 2, minH: 3 };
}

/**
 * The default layout fills in order. Full-width widgets take their own row;
 * the rest are paired two columns at a time. Computing in one sweep avoids
 * overlapping coordinates.
 */
function packLayout(
  ids: DashboardWidgetId[],
  breakpoint: DashboardBreakpoint,
): LayoutItem[] {
  const cols = DASHBOARD_COLS[breakpoint];
  const items: LayoutItem[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  for (const [index, id] of ids.entries()) {
    const size = sizeOf(id, breakpoint);
    // The personal desk pairs a broad work list with a smaller project index.
    // Project desks and catalog additions keep the regular two-column rhythm.
    if (breakpoint === "lg") {
      if (id === "next" && ids[index + 1] === "projects") size.w = 8;
      if (id === "projects" && ids[index - 1] === "next") size.w = 4;
    }
    if (x > 0 && x + size.w > cols) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    items.push({ i: id, x, y, ...size });
    rowHeight = Math.max(rowHeight, size.h);
    x += size.w;
    if (x >= cols) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
  }
  return items;
}

export const WIDGET_REGISTRY: DashboardWidgetDefinition[] = entries.map(
  ([id, title, description, category, categoryKey]) => ({
    id,
    title,
    description,
    category,
    categoryKey,
    // When re-enabled from the catalog only the size is used; position snaps to the bottom of the board.
    defaultLayout: {
      lg: { x: 0, y: 0, ...sizeOf(id, "lg") },
      md: { x: 0, y: 0, ...sizeOf(id, "md") },
      sm: { x: 0, y: 0, ...sizeOf(id, "sm") },
    },
  }),
);
export const WIDGET_BY_ID = Object.fromEntries(
  WIDGET_REGISTRY.map((w) => [w.id, w]),
) as Record<DashboardWidgetId, DashboardWidgetDefinition>;
/** The four cards the old 'core metrics' bundle filled. Migration and the default layout read the same list. */
export const DEFAULT_METRIC_WIDGET_IDS: MetricWidgetId[] =
  DEFAULT_METRIC_KEYS.map(metricWidgetId);
/** Shared activity first, project and calendar context next, then upcoming work. */
export const DEFAULT_WIDGET_IDS: DashboardWidgetId[] = [
  "metric:jobs-live", "metric:jobs-failed", "metric:due-today", "metric:done-today",
  "today",
  "jobs",
  "projects",
  "events",
  "due",
  "schedules",
];
export function createDefaultLayouts(ids: DashboardWidgetId[] = DEFAULT_WIDGET_IDS): ResponsiveLayouts<DashboardBreakpoint> {
  return Object.fromEntries(
    (Object.keys(DASHBOARD_COLS) as DashboardBreakpoint[]).map((b) => [
      b,
      packLayout(ids, b),
    ]),
  );
}

/** The shared dashboard observes activity. Workflow decisions belong to project workbenches.
 * Retain legacy definitions above so saved sizes can still be safely read during migration. */
export const GLOBAL_WIDGET_IDS = WIDGET_REGISTRY.map((widget) => widget.id).filter((id) => ![
  "stages", "issues", "metric:backlog", "metric:review", "metric:ready", "metric:running",
  "metric:hold", "metric:assigned", "metric:needs-approval", "metric:blocked",
].includes(id));
