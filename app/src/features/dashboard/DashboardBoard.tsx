import { useMemo, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { GripHorizontal, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import {
  Responsive,
  useContainerWidth,
  verticalCompactor,
} from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { createDashboardLayout } from "./layout-store";
import {
  DASHBOARD_BREAKPOINTS,
  DASHBOARD_COLS,
  WIDGET_REGISTRY,
  DEFAULT_WIDGET_IDS,
  PROJECT_DEFAULT_WIDGET_IDS,
  PROJECT_WIDGET_IDS,
  type DashboardBreakpoint,
  type DashboardWidgetDefinition,
  type DashboardWidgetId,
} from "./registry";
import { METRIC_PREFIX, isMetricWidgetId } from "./metrics";

/** 위젯 화면 문자열의 번들 키. 지표 카드는 metrics.<key>.* 를 쓴다. */
function widgetTextKeys(id: DashboardWidgetId) {
  if (isMetricWidgetId(id)) {
    const key = `metrics.${id.slice(METRIC_PREFIX.length)}`;
    return { title: `${key}.label`, description: `${key}.hint` };
  }
  return {
    title: `widgets.${id}.title`,
    description: `widgets.${id}.description`,
  };
}

/** 카탈로그가 길어졌으므로 카테고리로 묶는다. 등록 순서를 그대로 쓴다. */
function groupWidgets(query: string, t: TFunction, scope: string) {
  const needle = query.trim().toLowerCase();
  const groups: { categoryKey: string; widgets: typeof WIDGET_REGISTRY }[] =
    [];
  for (const widget of WIDGET_REGISTRY) {
    if (scope && !PROJECT_WIDGET_IDS.includes(widget.id)) continue;
    const keys = widgetTextKeys(widget.id);
    const haystack = [
      widget.title,
      widget.description,
      widget.category,
      t(keys.title),
      t(keys.description),
      t(`categories.${widget.categoryKey}`),
    ].join(" ");
    if (needle && !haystack.toLowerCase().includes(needle)) continue;
    const group = groups.find(
      (entry) => entry.categoryKey === widget.categoryKey,
    );
    if (group) group.widgets.push(widget);
    else groups.push({ categoryKey: widget.categoryKey, widgets: [widget] });
  }
  return groups;
}

/**
 * 미리보기 박스는 위젯의 실제 lg 종횡비를 그대로 쓴다. 보드 폭은 화면마다
 * 다르므로 대표값 하나를 기준으로 격자 픽셀을 계산해 비율만 남긴다.
 */
const PREVIEW_BOARD_WIDTH = 1160;
const GRID_MARGIN = 12;
const GRID_ROW_HEIGHT = 30;

function previewGeometry(widget: DashboardWidgetDefinition): CSSProperties {
  const { w, h } = widget.defaultLayout.lg;
  const colWidth =
    (PREVIEW_BOARD_WIDTH - GRID_MARGIN * (DASHBOARD_COLS.lg + 1)) /
    DASHBOARD_COLS.lg;
  const itemW = colWidth * w + GRID_MARGIN * (w - 1);
  const itemH = GRID_ROW_HEIGHT * h + GRID_MARGIN * (h - 1);
  return {
    aspectRatio: `${Math.round(itemW)} / ${Math.round(itemH)}`,
    minHeight: "5.5rem",
    maxHeight: "13rem",
  };
}

/** 카탈로그 한 장. 실제 데이터로 그린 위젯 모습을 보고 추가하게 한다. */
function CatalogCard({
  widget,
  enabled,
  onToggle,
  preview,
}: {
  widget: DashboardWidgetDefinition;
  enabled: boolean;
  onToggle: (next: boolean) => void;
  preview: ReactNode;
}) {
  const { t } = useTranslation("dashboard");
  const text = widgetTextKeys(widget.id);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border",
        enabled && "border-[var(--brand)]",
        widget.defaultLayout.lg.w >= DASHBOARD_COLS.lg && "sm:col-span-2",
      )}
    >
      <div
        className="dashboard-grid widget-catalog-preview"
        style={previewGeometry(widget)}
        aria-hidden
      >
        <div className="widget-host">{preview}</div>
      </div>
      <div className="flex items-center gap-3 p-3">
        <label
          className="min-w-0 flex-1 cursor-pointer"
          htmlFor={`widget-${widget.id}`}
        >
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">
              {t(text.title)}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
              {t(`categories.${widget.categoryKey}`)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(text.description)}
          </p>
        </label>
        <Switch
          id={`widget-${widget.id}`}
          checked={enabled}
          onCheckedChange={onToggle}
        />
      </div>
    </div>
  );
}

export function DashboardBoard({
  scope = "",
  editing,
  catalogOpen,
  onCatalogClose,
  renderWidget,
}: {
  scope?: string;
  editing: boolean;
  catalogOpen: boolean;
  onCatalogClose: () => void;
  renderWidget: (id: DashboardWidgetId) => ReactNode;
}) {
  const { t } = useTranslation("dashboard");
  const useDashboardLayout = useMemo(() => createDashboardLayout(scope, scope ? PROJECT_DEFAULT_WIDGET_IDS : DEFAULT_WIDGET_IDS), [scope]);
  const enabled = useDashboardLayout((state) => state.enabled);
  const layouts = useDashboardLayout((state) => state.layouts);
  const setLayouts = useDashboardLayout((state) => state.setLayouts);
  const setWidgetEnabled = useDashboardLayout(
    (state) => state.setWidgetEnabled,
  );
  const reset = useDashboardLayout((state) => state.reset);
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupWidgets(query, t, scope), [query, t, scope]);
  const { width, containerRef, mounted } = useContainerWidth({
    measureBeforeMount: true,
  });
  const currentBreakpoint: DashboardBreakpoint =
    width >= DASHBOARD_BREAKPOINTS.lg
      ? "lg"
      : width >= DASHBOARD_BREAKPOINTS.md
        ? "md"
        : "sm";

  return (
    <>
      {editing && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3 py-2 text-xs">
          <SlidersHorizontal className="size-3.5 text-[var(--brand)]" />
          <span className="font-medium">{t("board.editMode")}</span>
          <span className="text-muted-foreground">
            {t("board.editHint")}
          </span>
          <span className="rounded-md border border-[var(--brand-border)] bg-card/70 px-2 py-1 text-[10px] font-semibold text-[var(--brand)]">
            {t(`board.breakpoint.${currentBreakpoint}`)}
          </span>
          <Button className="ml-auto" size="xs" variant="ghost" onClick={reset}>
            <RotateCcw /> {t("board.resetLayouts")}
          </Button>
        </div>
      )}

      <div
        ref={containerRef as RefObject<HTMLDivElement>}
        className={cn("dashboard-grid", editing && "dashboard-grid-editing")}
      >
        {mounted && enabled.length > 0 && (
          <Responsive
            width={width}
            layouts={layouts}
            breakpoints={DASHBOARD_BREAKPOINTS}
            cols={DASHBOARD_COLS}
            rowHeight={30}
            margin={[12, 12]}
            containerPadding={[0, 0]}
            compactor={verticalCompactor}
            dragConfig={{
              enabled: editing,
              handle: ".widget-drag-handle",
              cancel:
                ".widget-host button, .widget-remove-button, input, label, a",
              bounded: false,
            }}
            resizeConfig={{ enabled: editing, handles: ["se"] }}
            onLayoutChange={(_, nextLayouts) => setLayouts(nextLayouts)}
          >
            {enabled.map((id) => (
              <div key={id} className="widget-grid-item">
                {editing && (
                  <div className="widget-edit-bar">
                    <button
                      type="button"
                      className="widget-drag-handle"
                      aria-label={t("board.moveWidget", {
                        title: t(widgetTextKeys(id).title),
                      })}
                      title={t("board.moveHandleHint")}
                      onKeyDown={(event) => {
                        const delta = (
                          {
                            ArrowLeft: [-1, 0],
                            ArrowRight: [1, 0],
                            ArrowUp: [0, -1],
                            ArrowDown: [0, 1],
                          } as Record<string, number[]>
                        )[event.key];
                        if (!delta) return;
                        event.preventDefault();
                        setLayouts({
                          ...layouts,
                          [currentBreakpoint]: (
                            layouts[currentBreakpoint] ?? []
                          ).map((item) =>
                            item.i === id
                              ? {
                                  ...item,
                                  x: Math.max(
                                    0,
                                    Math.min(
                                      DASHBOARD_COLS[currentBreakpoint] -
                                        item.w,
                                      item.x + delta[0],
                                    ),
                                  ),
                                  y: Math.max(0, item.y + delta[1]),
                                }
                              : item,
                          ),
                        });
                      }}
                    >
                      <GripHorizontal className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="widget-remove-button"
                      onClick={() => setWidgetEnabled(id, false)}
                      aria-label={t("board.hideWidget", {
                        title: t(widgetTextKeys(id).title),
                      })}
                      title={t("board.hideWidgetHint")}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                )}
                <div className="widget-host">{renderWidget(id)}</div>
              </div>
            ))}
          </Responsive>
        )}
        {mounted && enabled.length === 0 && (
          <div className="grid min-h-80 place-items-center rounded-xl border border-dashed bg-card/50 text-center">
            <div>
              <p className="text-sm font-semibold">{t("board.emptyTitle")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("board.emptyHint")}
              </p>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={catalogOpen}
        onClose={onCatalogClose}
        title={t("board.catalogTitle")}
        wide
      >
        <p className="mb-3 text-xs text-muted-foreground">
          {t("board.catalogIntro")}
        </p>
        <Input
          className="mb-3"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("board.searchPlaceholder")}
          aria-label={t("board.searchLabel")}
        />
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {groups.map((group) => (
            <section key={group.categoryKey} className="space-y-2">
              <h3 className="sticky top-0 z-10 bg-card/95 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground">
                {t(`categories.${group.categoryKey}`)}
                <span className="ml-1.5 font-normal">
                  {
                    group.widgets.filter((widget) =>
                      enabled.includes(widget.id),
                    ).length
                  }
                  /{group.widgets.length}
                </span>
              </h3>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {group.widgets.map((widget) => (
                  <CatalogCard
                    key={widget.id}
                    widget={widget}
                    enabled={enabled.includes(widget.id)}
                    onToggle={(next) => setWidgetEnabled(widget.id, next)}
                    preview={renderWidget(widget.id)}
                  />
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="rounded-xl border border-dashed p-6 text-center text-xs text-muted-foreground">
              {t("board.noResults")}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
