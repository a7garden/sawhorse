import type { ReactNode, RefObject } from "react";
import { GripHorizontal, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { Responsive, useContainerWidth, verticalCompactor } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useDashboardLayout } from "./layout-store";
import {
  DASHBOARD_BREAKPOINTS,
  DASHBOARD_COLS,
  WIDGET_BY_ID,
  WIDGET_REGISTRY,
  type DashboardBreakpoint,
  type DashboardWidgetId,
} from "./registry";

const BREAKPOINT_LABEL: Record<DashboardBreakpoint, string> = {
  lg: "넓은 화면",
  md: "중간 화면",
  sm: "좁은 화면",
};

export function DashboardBoard({
  editing,
  catalogOpen,
  onCatalogClose,
  renderWidget,
}: {
  editing: boolean;
  catalogOpen: boolean;
  onCatalogClose: () => void;
  renderWidget: (id: DashboardWidgetId) => ReactNode;
}) {
  const enabled = useDashboardLayout((state) => state.enabled);
  const layouts = useDashboardLayout((state) => state.layouts);
  const setLayouts = useDashboardLayout((state) => state.setLayouts);
  const setWidgetEnabled = useDashboardLayout((state) => state.setWidgetEnabled);
  const reset = useDashboardLayout((state) => state.reset);
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true });
  const currentBreakpoint: DashboardBreakpoint =
    width >= DASHBOARD_BREAKPOINTS.lg ? "lg" : width >= DASHBOARD_BREAKPOINTS.md ? "md" : "sm";

  return (
    <>
      {editing && (
        <div className="mb-2.5 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-[var(--brand-soft)] px-3 py-2 text-xs">
          <SlidersHorizontal className="size-3.5 text-[var(--brand)]" />
          <span className="font-medium">편집 모드</span>
          <span className="text-muted-foreground">
            상단 손잡이로 이동하고 모서리로 크기를 조절하세요. 화면 크기별 배치는 따로 저장됩니다.
          </span>
          <span className="rounded-md border border-[var(--brand-border)] bg-card/70 px-2 py-1 text-[10px] font-semibold text-[var(--brand)]">
            {BREAKPOINT_LABEL[currentBreakpoint]}
          </span>
          <Button className="ml-auto" size="xs" variant="ghost" onClick={reset}>
            <RotateCcw /> 모든 화면 기본 배치 복원
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
              cancel: ".widget-host button, .widget-remove-button, input, label, a",
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
                      aria-label={`${WIDGET_BY_ID[id].title} 위젯 이동`}
                      title="드래그하여 이동"
                    >
                      <GripHorizontal className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="widget-remove-button"
                      onClick={() => setWidgetEnabled(id, false)}
                      aria-label={`${WIDGET_BY_ID[id].title} 위젯 숨기기`}
                      title="위젯 숨기기"
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
              <p className="text-sm font-semibold">표시할 위젯이 없습니다.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                상단의 위젯 추가 버튼에서 필요한 항목을 선택하세요.
              </p>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={catalogOpen}
        onClose={onCatalogClose}
        title="위젯 카탈로그"
        className="max-w-xl"
      >
        <p className="mb-3 text-xs text-muted-foreground">
          대시보드에 표시할 위젯을 선택합니다. 다시 추가한 위젯은 보드의 마지막에 배치됩니다.
        </p>
        <div className="space-y-2">
          {WIDGET_REGISTRY.map((widget) => {
            const checked = enabled.includes(widget.id);
            return (
              <div key={widget.id} className="flex items-center gap-3 rounded-xl border p-3">
                <label className="min-w-0 flex-1 cursor-pointer" htmlFor={`widget-${widget.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold">{widget.title}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {widget.category}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{widget.description}</p>
                </label>
                <Switch
                  id={`widget-${widget.id}`}
                  checked={checked}
                  onCheckedChange={(next) => setWidgetEnabled(widget.id, next)}
                />
              </div>
            );
          })}
        </div>
      </Dialog>
    </>
  );
}
