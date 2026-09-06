import type { LayoutItem, ResponsiveLayouts } from "react-grid-layout";
export type DashboardBreakpoint = "lg" | "md" | "sm";
export type DashboardWidgetId =
  | "metrics"
  | "next"
  | "stages"
  | "due"
  | "events"
  | "done"
  | "jobs"
  | "schedules"
  | "issues"
  | "reading";
export interface DashboardWidgetDefinition {
  id: DashboardWidgetId;
  title: string;
  description: string;
  category: string;
  defaultLayout: Record<DashboardBreakpoint, Omit<LayoutItem, "i">>;
}
export const DASHBOARD_BREAKPOINTS = { lg: 900, md: 620, sm: 0 };
export const DASHBOARD_COLS = { lg: 12, md: 8, sm: 4 };
const entries: [DashboardWidgetId, string, string, string][] = [
  ["metrics", "핵심 지표", "진행·준비·기한·완료", "작업"],
  ["next", "다음에 할 일", "기한과 우선순위순 작업", "작업"],
  ["stages", "단계별 맥락", "작업 흐름의 진행 상황", "워크플로"],
  ["due", "기한 임박", "일주일 안에 마감되는 작업", "작업"],
  ["events", "임박 일정", "다가오는 약속과 마일스톤", "캘린더"],
  ["done", "최근 완료", "완료한 작업과 결과", "작업"],
  ["jobs", "실행 현황", "에이전트의 최근 실행", "실행"],
  ["schedules", "예약과 반복", "등록된 작업의 실행 시간", "작업"],
  ["issues", "이슈", "처리할 이슈", "이슈"],
  ["reading", "읽을거리", "RSS로 받아온 읽지 않은 새 글", "코어 확장"],
];
export const WIDGET_REGISTRY: DashboardWidgetDefinition[] = entries.map(
  ([id, title, description, category], index) => ({
    id,
    title,
    description,
    category,
    defaultLayout: {
      lg: {
        x: index === 0 ? 0 : ((index - 1) % 2) * 6,
        y: index === 0 ? 0 : 4 + Math.floor((index - 1) / 2) * 8,
        w: index === 0 ? 12 : 6,
        h: index === 0 ? 4 : 8,
        minW: 3,
        minH: 3,
      },
      md: {
        x: 0,
        y: index * 8,
        w: 8,
        h: index === 0 ? 5 : 8,
        minW: 3,
        minH: 3,
      },
      sm: { x: 0, y: index * 8, w: 4, h: 8, minW: 2, minH: 3 },
    },
  }),
);
export const WIDGET_BY_ID = Object.fromEntries(
  WIDGET_REGISTRY.map((w) => [w.id, w]),
) as Record<DashboardWidgetId, DashboardWidgetDefinition>;
export const DEFAULT_WIDGET_IDS = entries.slice(0, 6).map(([id]) => id);
export function createDefaultLayouts(): ResponsiveLayouts<DashboardBreakpoint> {
  return Object.fromEntries(
    (Object.keys(DASHBOARD_COLS) as DashboardBreakpoint[]).map((b) => [
      b,
      WIDGET_REGISTRY.filter((w) => DEFAULT_WIDGET_IDS.includes(w.id)).map(
        (w) => ({ i: w.id, ...w.defaultLayout[b] }),
      ),
    ]),
  );
}
