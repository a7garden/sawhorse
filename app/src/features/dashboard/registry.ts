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
  | "checklist";
/** 목록형 패널 위젯과 낱개 지표 카드가 같은 보드 위에서 같은 자격으로 산다. */
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
// 카테고리는 사이드바 진입점과 같은 이름을 쓴다 — 개발(WorkItem) / 자동화(TaskDef) / 볼트.
// 지표만은 어느 화면에도 속하지 않는 숫자 한 장이므로 자기 이름을 쓴다.
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
 * 위젯의 고유 크기. 지표 카드는 숫자 한 장이라 작게 시작하고, 오늘 타임라인은
 * 가로로 길어야 읽히므로 폭을 통째로 쓰며 통계·할 일·목록이 겹쳐 있어 더 높다.
 */
function sizeOf(
  id: DashboardWidgetId,
  breakpoint: DashboardBreakpoint,
): { w: number; h: number; minW: number; minH: number } {
  const cols = DASHBOARD_COLS[breakpoint];
  if (isMetricWidgetId(id))
    return {
      w: breakpoint === "lg" ? 3 : 2,
      h: 4,
      minW: 2,
      minH: 3,
    };
  const full = id === "today";
  const half = breakpoint === "lg" ? cols / 2 : cols;
  if (breakpoint === "lg")
    return {
      w: full ? cols : half,
      h: id === "today" ? 9 : 8,
      minW: 3,
      minH: 3,
    };
  if (breakpoint === "md")
    return { w: cols, h: id === "today" ? 10 : 8, minW: 3, minH: 3 };
  return { w: cols, h: id === "today" ? 11 : 8, minW: 2, minH: 3 };
}

/**
 * 기본 배치는 순서대로 채운다. 전체폭 위젯은 자기 줄을 혼자 쓰고, 나머지는 두 칸씩
 * 짝지어 놓는다. 한 번에 훑어 계산해야 겹치는 좌표가 생기지 않는다.
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
  for (const id of ids) {
    const size = sizeOf(id, breakpoint);
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
    // 카탈로그에서 다시 켤 때는 크기만 쓰고 위치는 보드 맨 아래로 붙는다.
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
/** 예전 '핵심 지표' 묶음이 채우던 네 장. 이관과 기본 배치가 같은 목록을 본다. */
export const DEFAULT_METRIC_WIDGET_IDS: MetricWidgetId[] =
  DEFAULT_METRIC_KEYS.map(metricWidgetId);
/** 기본 표시 위젯 — 지표 네 장 뒤에 오늘·개발·이슈·기한·일정과 볼트 할 일. */
export const DEFAULT_WIDGET_IDS: DashboardWidgetId[] = [
  ...DEFAULT_METRIC_WIDGET_IDS,
  "projects",
  "today",
  "next",
  "issues",
  "due",
  "events",
  "checklist",
];
export function createDefaultLayouts(ids: DashboardWidgetId[] = DEFAULT_WIDGET_IDS): ResponsiveLayouts<DashboardBreakpoint> {
  return Object.fromEntries(
    (Object.keys(DASHBOARD_COLS) as DashboardBreakpoint[]).map((b) => [
      b,
      packLayout(ids, b),
    ]),
  );
}

/** Project dashboards use process context instead of personal feeds and daily checklists. */
export const PROJECT_WIDGET_IDS = WIDGET_REGISTRY.map((widget) => widget.id)
  .filter((id) => !["projects", "reading", "checklist", "schedules"].includes(id));
export const PROJECT_DEFAULT_WIDGET_IDS: DashboardWidgetId[] = [
  "metric:running", "metric:review", "metric:blocked", "metric:overdue",
  "stages", "next", "jobs", "documents", "due", "events",
];
