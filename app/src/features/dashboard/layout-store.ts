import { create } from "zustand";
import type { Layout, LayoutItem, ResponsiveLayouts } from "react-grid-layout";
import {
  DASHBOARD_COLS,
  DEFAULT_METRIC_WIDGET_IDS,
  DEFAULT_WIDGET_IDS,
  WIDGET_BY_ID,
  createDefaultLayouts,
  type DashboardBreakpoint,
  type DashboardWidgetId,
} from "./registry";

const STORAGE_KEY = "sawhorse.dashboard-layout";
const LAYOUT_VERSION = 4;
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

function defaultDocument(defaultIds = DEFAULT_WIDGET_IDS): DashboardLayoutDocument {
  return {
    version: LAYOUT_VERSION,
    enabled: [...defaultIds],
    layouts: createDefaultLayouts(defaultIds),
  };
}

function isWidgetId(value: unknown): value is DashboardWidgetId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(WIDGET_BY_ID, value)
  );
}

/** 이름만 바뀐 위젯. 자리도 크기도 그대로 이어받는다. */
const LEGACY_ALIASES: Record<string, DashboardWidgetId> = {
  todos: "next",
  routines: "schedules",
  operations: "events",
};
/** 묶음이던 핵심 지표 위젯이 서 있던 자리 — 여기서 낱개 카드로 펼친다. */
const LEGACY_METRIC_IDS = ["metrics", "overview"];

/** 켜져 있던 위젯 목록을 현재 어휘로 옮긴다. 묶음 지표는 낱개 네 장이 된다. */
function migrateEnabled(value: unknown[]): DashboardWidgetId[] {
  return value.flatMap((id) => {
    if (typeof id !== "string") return [];
    if (LEGACY_METRIC_IDS.includes(id)) return DEFAULT_METRIC_WIDGET_IDS;
    const mapped = LEGACY_ALIASES[id] ?? id;
    return isWidgetId(mapped) ? [mapped] : [];
  });
}

/**
 * v3까지의 핵심 지표 한 칸을 낱개 지표 위젯 네 칸으로 편다. 원래 칸이 있던 줄에서
 * 시작해 폭이 모자라면 다음 줄로 접고, 아래에 있던 위젯은 세로 압축이 밀어낸다.
 */
function expandLegacyMetrics(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = { ...source };
  for (const breakpoint of Object.keys(
    DASHBOARD_COLS,
  ) as DashboardBreakpoint[]) {
    const raw = source[breakpoint];
    if (!Array.isArray(raw)) continue;
    const index = raw.findIndex(
      (item) =>
        item &&
        typeof item === "object" &&
        LEGACY_METRIC_IDS.includes((item as { i?: string }).i ?? ""),
    );
    if (index < 0) continue;
    const base = raw[index] as { y?: number };
    const cols = DASHBOARD_COLS[breakpoint];
    let x = 0;
    let y = typeof base.y === "number" ? Math.max(0, Math.round(base.y)) : 0;
    const cards = DEFAULT_METRIC_WIDGET_IDS.map((id) => {
      const size = WIDGET_BY_ID[id].defaultLayout[breakpoint];
      if (x > 0 && x + size.w > cols) {
        x = 0;
        y += size.h;
      }
      const card = { ...size, i: id, x, y };
      x += size.w;
      return card;
    });
    result[breakpoint] = [
      ...raw.slice(0, index),
      ...cards,
      ...raw.slice(index + 1),
    ];
  }
  return result;
}

function sanitizeItem(
  item: unknown,
  breakpoint: DashboardBreakpoint,
): LayoutItem | null {
  if (!item || typeof item !== "object") return null;
  const value = { ...item } as Partial<LayoutItem>;
  if (value.i && LEGACY_ALIASES[value.i]) value.i = LEGACY_ALIASES[value.i];
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

function loadDocument(storageKey = STORAGE_KEY, defaultIds = DEFAULT_WIDGET_IDS): DashboardLayoutDocument {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(storageKey) ?? "null",
    ) as Partial<DashboardLayoutDocument> | null;
    if (!parsed || ![1, 2, 3, LAYOUT_VERSION].includes(parsed.version ?? 0)) {
      const legacy = JSON.parse(
        (storageKey === STORAGE_KEY ? localStorage.getItem("sawhorse.overview-slots") : null) ?? "null",
      );
      const next = defaultDocument(defaultIds);
      if (legacy?.version === 1 && Array.isArray(legacy.enabled))
        next.enabled = migrateEnabled(legacy.enabled);
      return next;
    }
    const enabled = Array.isArray(parsed.enabled)
      ? migrateEnabled(parsed.enabled)
      : [...defaultIds];
    const migrated =
      parsed.version === 1 ? migrateV1Layouts(parsed.layouts) : parsed.layouts;
    return {
      version: LAYOUT_VERSION,
      enabled: [...new Set(enabled)],
      layouts: sanitizeLayouts(
        (parsed.version ?? 0) < LAYOUT_VERSION
          ? expandLegacyMetrics(migrated)
          : migrated,
      ),
    };
  } catch {
    return defaultDocument(defaultIds);
  }
}

function saveDocument(document: DashboardLayoutDocument, storageKey = STORAGE_KEY) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(document));
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

export function createDashboardLayout(scope = "", defaultIds = DEFAULT_WIDGET_IDS) {
  const storageKey = scope ? `${STORAGE_KEY}.project:${encodeURIComponent(scope)}` : STORAGE_KEY;
  const initial = loadDocument(storageKey, defaultIds);
  // Save normalized preferences once, including intentionally empty boards.
  saveDocument(initial, storageKey);
  return create<DashboardLayoutState>((set, get) => ({
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
      }, storageKey);
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
      }, storageKey);
    },
    reset: () => {
      const next = defaultDocument(defaultIds);
      set(next);
      saveDocument(next, storageKey);
    },
  }));

}
