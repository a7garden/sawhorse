import type { LayoutItem, ResponsiveLayouts } from "react-grid-layout";

export type DashboardBreakpoint = "lg" | "md" | "sm";
export type DashboardWidgetId =
  | "overview"
  | "todos"
  | "jobs"
  | "routines"
  | "issues"
  | "operations";

export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  title: string;
  description: string;
  category: "업무" | "자동화" | "운영";
  defaultLayout: Record<DashboardBreakpoint, Omit<LayoutItem, "i">>;
}

export const DASHBOARD_BREAKPOINTS: Record<DashboardBreakpoint, number> = {
  lg: 900,
  md: 620,
  sm: 0,
};

export const DASHBOARD_COLS: Record<DashboardBreakpoint, number> = {
  lg: 12,
  md: 8,
  sm: 4,
};

export const WIDGET_REGISTRY: readonly DashboardWidgetDefinition[] = [
  {
    id: "overview",
    title: "오늘의 핵심 지표",
    description: "실행 작업, 할 일, 완료 결과와 인박스를 요약합니다.",
    category: "운영",
    defaultLayout: {
      lg: { x: 0, y: 0, w: 12, h: 3, minW: 6, minH: 3 },
      md: { x: 0, y: 0, w: 8, h: 4, minW: 4, minH: 3 },
      sm: { x: 0, y: 0, w: 4, h: 5, minW: 2, minH: 4 },
    },
  },
  {
    id: "todos",
    title: "오늘의 업무",
    description: "오늘 할 일을 확인하고 바로 완료 처리합니다.",
    category: "업무",
    defaultLayout: {
      lg: { x: 0, y: 3, w: 7, h: 7, minW: 4, minH: 4 },
      md: { x: 0, y: 4, w: 8, h: 7, minW: 4, minH: 4 },
      sm: { x: 0, y: 5, w: 4, h: 7, minW: 2, minH: 4 },
    },
  },
  {
    id: "jobs",
    title: "실행 현황",
    description: "실행 중이거나 대기 중인 작업의 진행 상황입니다.",
    category: "자동화",
    defaultLayout: {
      lg: { x: 7, y: 3, w: 5, h: 7, minW: 4, minH: 4 },
      md: { x: 0, y: 11, w: 8, h: 7, minW: 4, minH: 4 },
      sm: { x: 0, y: 12, w: 4, h: 7, minW: 2, minH: 4 },
    },
  },
  {
    id: "routines",
    title: "오늘의 루틴",
    description: "예약된 아침, 점심, 저녁 루틴을 관리합니다.",
    category: "자동화",
    defaultLayout: {
      lg: { x: 0, y: 10, w: 12, h: 4, minW: 6, minH: 3 },
      md: { x: 0, y: 18, w: 8, h: 4, minW: 4, minH: 3 },
      sm: { x: 0, y: 19, w: 4, h: 8, minW: 2, minH: 5 },
    },
  },
  {
    id: "issues",
    title: "이슈 워크플로",
    description: "제안부터 실행까지 현재 병목과 최근 변경을 보여줍니다.",
    category: "업무",
    defaultLayout: {
      lg: { x: 0, y: 14, w: 7, h: 7, minW: 4, minH: 5 },
      md: { x: 0, y: 22, w: 8, h: 7, minW: 4, minH: 5 },
      sm: { x: 0, y: 27, w: 4, h: 8, minW: 2, minH: 5 },
    },
  },
  {
    id: "operations",
    title: "운영 상태",
    description: "볼트와 일지 상태, 최근 실패 결과를 점검합니다.",
    category: "운영",
    defaultLayout: {
      lg: { x: 7, y: 14, w: 5, h: 7, minW: 4, minH: 5 },
      md: { x: 0, y: 29, w: 8, h: 7, minW: 4, minH: 5 },
      sm: { x: 0, y: 35, w: 4, h: 7, minW: 2, minH: 5 },
    },
  },
] as const;

export const WIDGET_BY_ID = Object.fromEntries(
  WIDGET_REGISTRY.map((widget) => [widget.id, widget]),
) as Record<DashboardWidgetId, DashboardWidgetDefinition>;

export function createDefaultLayouts(): ResponsiveLayouts<DashboardBreakpoint> {
  return Object.fromEntries(
    (Object.keys(DASHBOARD_COLS) as DashboardBreakpoint[]).map((breakpoint) => [
      breakpoint,
      WIDGET_REGISTRY.map((widget) => ({
        i: widget.id,
        ...widget.defaultLayout[breakpoint],
      })),
    ]),
  ) as ResponsiveLayouts<DashboardBreakpoint>;
}

export const DEFAULT_WIDGET_IDS = WIDGET_REGISTRY.map((widget) => widget.id);
