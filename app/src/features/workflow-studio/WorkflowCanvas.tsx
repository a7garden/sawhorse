import { useState } from "react";
import type {
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
} from "@/features/workbench/types";
import { Button } from "@/components/ui/button";
export const NODE_LABELS: Record<WorkflowNode["kind"], string> = {
  artifact: "문서 작성",
  agent: "에이전트 실행",
  check: "자동 검증",
  human: "사람의 검토",
  condition: "조건 분기",
  subworkflow: "다른 워크플로",
  end: "완료",
};
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
        단계를 눌러 내용을 편집하고, 끌어서 배치하세요. 아래에서 다음 단계와
        실행 조건을 연결합니다.
      </p>
      <div
        className="overflow-auto rounded-lg border bg-muted/30"
        aria-label="워크플로 캔버스"
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
                    {EVENTS[edge.on] ?? edge.on}
                  </text>
                </g>
              );
            })}
          </svg>
          {definition.nodes.map((node) => (
            <button
              key={node.id}
              aria-label={`단계 ${node.label}`}
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
                {node.id === definition.entry ? "시작 · " : ""}
                {NODE_LABELS[node.kind]}
              </small>
              <strong className="mt-1 block text-sm">{node.label}</strong>
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-2" aria-label="단계 연결">
        {definition.edges.map((edge, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2 rounded-md border p-2"
          >
            <select
              aria-label={`연결 ${i + 1} 시작 단계`}
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
              aria-label={`연결 ${i + 1} 조건`}
              className="min-w-0 rounded border bg-background p-2 text-xs"
              value={edge.on}
              onChange={(e) => patchEdge(i, { on: e.target.value })}
            >
              {Object.entries(EVENTS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
              {!EVENTS[edge.on] && <option value={edge.on}>{edge.on}</option>}
            </select>
            <select
              aria-label={`연결 ${i + 1} 다음 단계`}
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
              aria-label={`연결 ${i + 1} 삭제`}
              onClick={() =>
                onChange({ edges: definition.edges.filter((_, j) => i !== j) })
              }
            >
              삭제
            </Button>
            {(edge.condition || edge.loopRef) && (
              <small className="col-span-4 text-muted-foreground">
                추가 조건 또는 반복 제한이 있습니다. 고급 JSON에서 확인할 수
                있습니다.
              </small>
            )}
          </div>
        ))}
        <datalist id="workflow-events">
          {Object.entries(EVENTS).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
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
          연결 추가
        </Button>
      </div>
    </div>
  );
}
