import { create } from "zustand";
import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout";
import {
  DASHBOARD_COLS,
  DEFAULT_WIDGET_IDS,
  WIDGET_BY_ID,
  createDefaultLayouts,
  type DashboardBreakpoint,
  type DashboardWidgetId,
} from "./registry";

const STORAGE_KEY = "sawhorse.dashboard-layout";
const LAYOUT_VERSION = 3;
const LEGACY_ROW_PITCH = 60;
const ROW_PITCH = 42;

interface DashboardLayoutDocument {
  version: number;
  enabled: DashboardWidgetId[];
  layouts: ResponsiveLayouts<DashboardBreakpoint>;
}

interface DashboardLayoutState extends DashboardLayoutDocument {
  setLayouts: (layouts: ResponsiveLayouts<DashboardBreakpoint>) => void;
  setWidgetEnabled: (id: DashboardWidgetId, enabled: boolean) => void;
  reset: () => void;
}

function defaultDocument(): DashboardLayoutDocument {
  return {
    version: LAYOUT_VERSION,
    enabled: [...DEFAULT_WIDGET_IDS],
    layouts: createDefaultLayouts(),
  };
}

function isWidgetId(value: unknown): value is DashboardWidgetId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WIDGET_BY_ID, value)
  );
}

function sanitizeItem(
  item: unknown,
  breakpoint: DashboardBreakpoint,
): LayoutItem | null {
  if (!item || typeof item !== "object") return null;
  const value = { ...item } as Partial<LayoutItem>;
  const aliases: Record<string, DashboardWidgetId> = {
    overview: "metrics",
    todos: "next",
    routines: "schedules",
    operations: "events",
  };
  if (value.i && aliases[value.i]) value.i = aliases[value.i];
  if (!isWidgetId(value.i)) return null;
  if (
    ![value.x, value.y, value.w, value.h].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    )
  ) {
    return null;
  }
  const cols = DASHBOARD_COLS[breakpoint];
  const fallback = WIDGET_BY_ID[value.i].defaultLayout[breakpoint];
  const minW = Math.min(cols, fallback.minW ?? 1);
  const maxW = Math.min(cols, fallback.maxW ?? cols);
  const minH = fallback.minH ?? 1;
  const maxH = fallback.maxH ?? Number.POSITIVE_INFINITY;
  const w = Math.max(minW, Math.min(maxW, Math.round(value.w!)));
  const h = Math.max(minH, Math.min(maxH, Math.round(value.h!)));
  return {
    ...fallback,
    i: value.i,
    x: Math.max(0, Math.min(cols - w, Math.round(value.x!))),
    y: Math.max(0, Math.round(value.y!)),
    w,
    h,
  };
}

function migrateV1Layouts(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(source).map(([breakpoint, layout]) => [
      breakpoint,
      Array.isArray(layout)
        ? layout.map((item) => {
            if (!item || typeof item !== "object") return item;
            const value = item as Record<string, unknown>;
            return {
              ...value,
              y:
                typeof value.y === "number"
                  ? Math.round((value.y * LEGACY_ROW_PITCH) / ROW_PITCH)
                  : value.y,
              h:
                typeof value.h === "number"
                  ? Math.max(
                      1,
                      Math.round((value.h * LEGACY_ROW_PITCH) / ROW_PITCH),
                    )
                  : value.h,
            };
          })
        : layout,
    ]),
  );
}

function sanitizeLayouts(
  value: unknown,
): ResponsiveLayouts<DashboardBreakpoint> {
  const fallback = createDefaultLayouts();
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  const result: ResponsiveLayouts<DashboardBreakpoint> = {};
  for (const breakpoint of Object.keys(
    DASHBOARD_COLS,
  ) as DashboardBreakpoint[]) {
    const raw = source[breakpoint];
    const items = Array.isArray(raw)
      ? raw
          .map((item) => sanitizeItem(item, breakpoint))
          .filter((item): item is LayoutItem => item != null)
      : [];
    result[breakpoint] = Array.isArray(raw) ? items : fallback[breakpoint];
  }
  return result;
}

function loadDocument(): DashboardLayoutDocument {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "null",
    ) as Partial<DashboardLayoutDocument> | null;
    if (!parsed || ![1, 2, LAYOUT_VERSION].includes(parsed.version ?? 0)) {
      const legacy = JSON.parse(
        localStorage.getItem("sawhorse.overview-slots") ?? "null",
      );
      const next = defaultDocument();
      if (legacy?.version === 1 && Array.isArray(legacy.enabled))
        next.enabled = legacy.enabled.filter(isWidgetId);
      return next;
    }
    const enabled = Array.isArray(parsed.enabled)
      ? parsed.enabled
          .map(
            (id) =>
              (
                ({
                  overview: "metrics",
                  todos: "next",
                  routines: "schedules",
                  operations: "events",
                }) as Record<string, string>
              )[id] ?? id,
          )
          .filter(isWidgetId)
      : [...DEFAULT_WIDGET_IDS];
    return {
      version: LAYOUT_VERSION,
      enabled: [...new Set(enabled)],
      layouts: sanitizeLayouts(
        parsed.version === 1
          ? migrateV1Layouts(parsed.layouts)
          : parsed.layouts,
      ),
    };
  } catch {
    return defaultDocument();
  }
}

function saveDocument(document: DashboardLayoutDocument) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(document));
  } catch {
    // UI preferences are best-effort and never block dashboard operation.
  }
}

function sameLayouts(
  left: ResponsiveLayouts<DashboardBreakpoint>,
  right: ResponsiveLayouts<DashboardBreakpoint>,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendWidget(
  layout: Layout,
  id: DashboardWidgetId,
  breakpoint: DashboardBreakpoint,
): Layout {
  if (layout.some((item) => item.i === id)) return layout;
  const bottom = layout.reduce(
    (max, item) => Math.max(max, item.y + item.h),
    0,
  );
  return [
    ...layout,
    {
      i: id,
      ...WIDGET_BY_ID[id].defaultLayout[breakpoint],
      x: 0,
      y: bottom,
    },
  ];
}

const initial = loadDocument();

export const useDashboardLayout = create<DashboardLayoutState>((set, get) => ({
  ...initial,
  setLayouts: (layouts) => {
    const sanitized = sanitizeLayouts(layouts);
    if (sameLayouts(get().layouts, sanitized)) return;
    const next = { ...get(), layouts: sanitized };
    set({ layouts: sanitized });
    saveDocument({
      version: LAYOUT_VERSION,
      enabled: next.enabled,
      layouts: sanitized,
    });
  },
  setWidgetEnabled: (id, enabled) => {
    const current = get();
    const nextEnabled = enabled
      ? [...new Set([...current.enabled, id])]
      : current.enabled.filter((widgetId) => widgetId !== id);
    const nextLayouts: ResponsiveLayouts<DashboardBreakpoint> = {};
    for (const breakpoint of Object.keys(
      DASHBOARD_COLS,
    ) as DashboardBreakpoint[]) {
      const layout = current.layouts[breakpoint] ?? [];
      nextLayouts[breakpoint] = enabled
        ? appendWidget(layout, id, breakpoint)
        : layout.filter((item) => item.i !== id);
    }
    set({ enabled: nextEnabled, layouts: nextLayouts });
    saveDocument({
      version: LAYOUT_VERSION,
      enabled: nextEnabled,
      layouts: nextLayouts,
    });
  },
  reset: () => {
    const next = defaultDocument();
    set(next);
    saveDocument(next);
  },
}));
