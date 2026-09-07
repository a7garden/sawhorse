import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  WorkflowDefinition,
  WorkflowEdge,
} from "@/features/workbench/types";
import { Button } from "@/components/ui/button";
const EVENTS: Record<string, string> = {
  approved: "승인하면",
  completed: "완료하면",
  failed: "실패하면",
  rejected: "반려하면",
  next: "다음으로",
};
export function WorkflowCanvas({
  definition,
  selected,
  onSelect,
  onChange,
  layoutKey,
}: {
  layoutKey: string;
  definition: WorkflowDefinition;
  selected: string;
  onSelect: (id: string) => void;
  onChange: (patch: Partial<WorkflowDefinition>) => void;
}) {
  const { t } = useTranslation("dashboard");
  const [positions, setPositions] = useState<
    Record<string, { x: number; y: number }>
  >(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`sawhorse.workflow-layout.${layoutKey}`) ?? "{}",
      );
      return Object.fromEntries(
        Object.entries(saved).filter(
          ([, v]) =>
            v &&
            typeof v === "object" &&
            Number.isFinite((v as { x: number }).x) &&
            Number.isFinite((v as { y: number }).y),
        ),
      ) as Record<string, { x: number; y: number }>;
    } catch {
      return {};
    }
  });
  const point = (id: string) =>
    positions[id] ?? {
      x:
        30 +
        (Math.max(
          0,
          definition.nodes.findIndex((n) => n.id === id),
        ) %
          3) *
          220,
      y:
        30 +
        Math.floor(
          Math.max(
            0,
            definition.nodes.findIndex((n) => n.id === id),
          ) / 3,
        ) *
          150,
    };
  const patchEdge = (index: number, patch: Partial<WorkflowEdge>) =>
    onChange({
      edges: definition.edges.map((edge, i) =>
        i === index ? { ...edge, ...patch } : edge,
      ),
    });
  const width = Math.max(
    720,
    ...definition.nodes.map((n) => point(n.id).x + 210),
  );
  const height = Math.max(
    320,
    ...definition.nodes.map((n) => point(n.id).y + 130),
  );
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t("canvas.help")}
      </p>
      <div
        className="overflow-auto rounded-lg border bg-muted/30"
        aria-label={t("canvas.canvasLabel")}
      >
        <div
          className="relative"
          style={{
            width,
            height,
            backgroundImage:
              "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0"
            width={width}
            height={height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="workflow-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
              </marker>
            </defs>
            {definition.edges.map((edge, i) => {
              const a = point(edge.from),
                b = point(edge.to);
              return (
                <g key={i}>
                  <path
                    d={`M ${a.x + 180} ${a.y + 45} C ${a.x + 215} ${a.y + 45}, ${b.x - 35} ${b.y + 45}, ${b.x} ${b.y + 45}`}
                    stroke="var(--primary)"
                    fill="none"
                    strokeWidth="2"
                    markerEnd="url(#workflow-arrow)"
                  />
                  <text
                    x={(a.x + 180 + b.x) / 2}
                    y={(a.y + b.y) / 2 + 32}
                    fill="var(--muted-foreground)"
                    fontSize="10"
                  >
                    {EVENTS[edge.on]
                      ? t(`canvas.events.${edge.on}`)
                      : edge.on}
                  </text>
                </g>
              );
            })}
          </svg>
          {definition.nodes.map((node) => (
            <button
              key={node.id}
              aria-label={t("canvas.nodeAria", { label: node.label })}
              aria-pressed={selected === node.id}
              className={`absolute w-[180px] touch-none rounded-xl border bg-card p-4 text-left shadow-sm ${selected === node.id ? "border-primary ring-2 ring-primary/20" : ""}`}
              style={{ left: point(node.id).x, top: point(node.id).y }}
              onClick={() => onSelect(node.id)}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                onSelect(node.id);
                e.currentTarget.setPointerCapture(e.pointerId);
                const origin = point(node.id);
                e.currentTarget.dataset.drag = JSON.stringify({
                  x: e.clientX,
                  y: e.clientY,
                  origin,
                });
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const drag = JSON.parse(e.currentTarget.dataset.drag!);
                setPositions((p) => ({
                  ...p,
                  [node.id]: {
                    x: Math.max(10, drag.origin.x + e.clientX - drag.x),
                    y: Math.max(10, drag.origin.y + e.clientY - drag.y),
                  },
                }));
              }}
              onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
                try {
                  localStorage.setItem(
                    `sawhorse.workflow-layout.${layoutKey}`,
                    JSON.stringify(positions),
                  );
                } catch {
                  /* view preference */
                }
              }}
            >
              <small className="text-[10px] text-muted-foreground">
                {node.id === definition.entry ? t("canvas.entryPrefix") : ""}
                {t(`canvas.nodeKinds.${node.kind}`)}
              </small>
              <strong className="mt-1 block text-sm">{node.label}</strong>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2" aria-label={t("canvas.edgesLabel")}>
        {definition.edges.map((edge, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2 rounded-md border p-2"
          >
            <select
              aria-label={t("canvas.edgeFrom", { n: i + 1 })}
              className="min-w-0 rounded border bg-background p-2 text-xs"
              value={edge.from}
              onChange={(e) => patchEdge(i, { from: e.target.value })}
            >
              {definition.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
            <select
              aria-label={t("canvas.edgeOn", { n: i + 1 })}
              className="min-w-0 rounded border bg-background p-2 text-xs"
              value={edge.on}
              onChange={(e) => patchEdge(i, { on: e.target.value })}
            >
              {Object.entries(EVENTS).map(([id]) => (
                <option key={id} value={id}>
                  {t(`canvas.events.${id}`)}
                </option>
              ))}
              {!EVENTS[edge.on] && <option value={edge.on}>{edge.on}</option>}
            </select>
            <select
              aria-label={t("canvas.edgeTo", { n: i + 1 })}
              className="min-w-0 rounded border bg-background p-2 text-xs"
              value={edge.to}
              onChange={(e) => patchEdge(i, { to: e.target.value })}
            >
              {definition.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
            <Button
              size="xs"
              variant="ghost"
              aria-label={t("canvas.edgeDelete", { n: i + 1 })}
              onClick={() =>
                onChange({ edges: definition.edges.filter((_, j) => i !== j) })
              }
            >
              {t("canvas.delete")}
            </Button>
            {(edge.condition || edge.loopRef) && (
              <small className="col-span-4 text-muted-foreground">
                {t("canvas.edgeConditionHint")}
              </small>
            )}
          </div>
        ))}
        <datalist id="workflow-events">
          {Object.entries(EVENTS).map(([id]) => (
            <option key={id} value={id}>
              {t(`canvas.events.${id}`)}
            </option>
          ))}
        </datalist>
        <Button
          size="sm"
          variant="outline"
          disabled={definition.nodes.length < 2}
          onClick={() =>
            onChange({
              edges: [
                ...definition.edges,
                {
                  from: selected,
                  to: definition.nodes.find((n) => n.id !== selected)!.id,
                  on: "approved",
                  condition: null,
                  loopRef: null,
                },
              ],
            })
          }
        >
          {t("canvas.addEdge")}
        </Button>
      </div>
    </div>
  );
}
