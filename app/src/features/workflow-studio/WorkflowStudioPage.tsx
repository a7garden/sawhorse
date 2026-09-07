import { useApp } from "@/lib/store";
import { WorkflowCanvas, NODE_LABELS } from "./WorkflowCanvas";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  Copy,
  Download,
  GitBranch,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/pages/common";
import { workflowApi, isWorkbenchPreview } from "@/features/workbench/api";
import type {
  SimulationResult,
  AgentRole,
  ValidationReport,
  WorkflowDefinition,
  WorkflowArtifact,
  WorkflowDraftRecord,
  WorkflowNode,
} from "@/features/workbench/types";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function blankNode(index: number): WorkflowNode {
  return {
    id: `step-${index}`,
    label: `새 단계 ${index}`,
    kind: "artifact",
    artifactRole: null,
    actionRef: null,
    workflowRef: null,
    decision: null,
    inputs: [],
    outputs: [],
    allowedRoles: [],
    instructions: "",
    requiresCompletedDependencies: true,
  };
}

function freshDefinition(): WorkflowDefinition {
  return {
    definitionVersion: 1,
    id: "team-workflow",
    label: "팀 워크플로",
    description: "",
    version: "1.0.0",
    entry: "start",
    artifacts: [],
    nodes: [
      { ...blankNode(1), id: "start", label: "시작" },
      { ...blankNode(2), id: "done", label: "완료", kind: "end" },
    ],
    edges: [
      {
        from: "start",
        to: "done",
        on: "approved",
        condition: null,
        loopRef: null,
      },
    ],
    loops: [],
  };
}

function blankArtifact(index: number): WorkflowArtifact {
  return {
    role: `document-${index}`,
    label: `문서 ${index}`,
    path: `work/{workId}/document-${index}.md`,
    template: `# 문서 ${index}\n`,
  };
}

function comma(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export default function WorkflowStudioPage() {
  const initial = useApp((s) => s.workflowToEdit);
  const [catalog, setCatalog] = useState<WorkflowDefinition[]>([]);
  const [drafts, setDrafts] = useState<WorkflowDraftRecord[]>([]);
  const [draftId, setDraftId] = useState(`draft-${crypto.randomUUID()}`);
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    initial ? clone(initial) : freshDefinition(),
  );
  const [selected, setSelected] = useState(initial?.entry ?? "start");
  const [advanced, setAdvanced] = useState(false);
  const [source, setSource] = useState("");
  const [events, setEvents] = useState("approved");
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [nextCatalog, nextDrafts] = await Promise.all([
      workflowApi.catalog(),
      workflowApi.drafts().catch((error) => {
        if (!isWorkbenchPreview)
          setMessage(`초안을 불러오지 못했습니다: ${String(error)}`);
        return [];
      }),
    ]);
    setCatalog(nextCatalog);
    setDrafts(nextDrafts);
  }

  useEffect(() => {
    void load().catch((error) => setMessage(String(error)));
  }, []);
  useEffect(() => {
    setSource(`${JSON.stringify(definition, null, 2)}\n`);
  }, [definition]);

  const node = useMemo(
    () =>
      definition.nodes.find((candidate) => candidate.id === selected) ??
      definition.nodes[0],
    [definition, selected],
  );

  function updateDefinition(patch: Partial<WorkflowDefinition>) {
    setDefinition((current) => ({ ...current, ...patch }));
    setValidation(null);
    setSimulation(null);
  }

  function updateNode(patch: Partial<WorkflowNode>) {
    setDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((candidate) =>
        candidate.id === node?.id ? { ...candidate, ...patch } : candidate,
      ),
    }));
    setValidation(null);
    setSimulation(null);
  }

  async function action(work: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function selectDefinition(
    next: WorkflowDefinition,
    nextDraftId = `draft-${crypto.randomUUID()}`,
  ) {
    const value = clone(next);
    setDefinition(value);
    setDraftId(nextDraftId);
    setSelected(value.entry);
    setValidation(null);
    setSimulation(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader title="워크플로 스튜디오">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const text = await workflowApi.export(definition);
              await navigator.clipboard.writeText(text);
              setMessage("워크플로 JSON을 클립보드에 복사했습니다.");
            })
          }
        >
          <Download className="size-3" /> 내보내기
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto grid max-w-7xl gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <details className="xl:col-span-2 rounded-xl border bg-card p-4">
            <summary className="cursor-pointer text-sm font-semibold">
              워크플로 라이브러리 · 기존 흐름 선택
            </summary>
            <Card className="mt-3">
              <CardHeader>
                <CardTitle>라이브러리</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  className="w-full"
                  variant="secondary"
                  onClick={() => selectDefinition(freshDefinition())}
                >
                  <Plus /> 새 워크플로
                </Button>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground">
                    발행됨
                  </p>
                  {catalog.map((item) => (
                    <button
                      key={`${item.id}@${item.version}`}
                      className="w-full rounded-md border p-2 text-left text-xs hover:bg-accent"
                      onClick={() => selectDefinition(item)}
                    >
                      <strong className="block">{item.label}</strong>
                      <span className="text-muted-foreground">
                        {item.id}@{item.version}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground">
                    초안
                  </p>
                  {drafts.map((item) => (
                    <button
                      key={item.draftId}
                      className="w-full rounded-md border p-2 text-left text-xs hover:bg-accent"
                      onClick={() =>
                        selectDefinition(item.definition, item.draftId)
                      }
                    >
                      <strong>{item.definition.label || item.draftId}</strong>
                      <Badge
                        className="ml-2"
                        variant={
                          item.validation.valid ? "success" : "destructive"
                        }
                      >
                        {item.validation.valid ? "유효" : "수정"}
                      </Badge>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </details>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>정의</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-2">
                <label className="text-xs">
                  ID
                  <Input
                    value={definition.id}
                    onChange={(e) => updateDefinition({ id: e.target.value })}
                  />
                </label>
                <label className="text-xs">
                  버전
                  <Input
                    value={definition.version}
                    onChange={(e) =>
                      updateDefinition({ version: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs">
                  이름
                  <Input
                    aria-label="워크플로 이름"
                    value={definition.label}
                    onChange={(e) =>
                      updateDefinition({ label: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs">
                  시작 단계
                  <select
                    className="mt-1 h-9 w-full rounded-md border bg-background px-3"
                    value={definition.entry}
                    onChange={(e) =>
                      updateDefinition({ entry: e.target.value })
                    }
                  >
                    {definition.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  작성할 문서
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateDefinition({
                        artifacts: [
                          ...definition.artifacts,
                          blankArtifact(definition.artifacts.length + 1),
                        ],
                      })
                    }
                  >
                    <Plus /> 문서
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {definition.artifacts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    각 단계에서 작성하거나 참고할 문서를 추가하세요.
                  </p>
                )}
                {definition.artifacts.map((artifact, index) => (
                  <div
                    key={`${artifact.role}-${index}`}
                    className="grid gap-2 rounded-md border p-3 md:grid-cols-2"
                  >
                    <label className="text-xs">
                      역할 ID
                      <Input
                        value={artifact.role}
                        onChange={(e) =>
                          updateDefinition({
                            artifacts: definition.artifacts.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, role: e.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs">
                      표시 이름
                      <Input
                        value={artifact.label}
                        onChange={(e) =>
                          updateDefinition({
                            artifacts: definition.artifacts.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, label: e.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs md:col-span-2">
                      문서 저장 위치
                      <Input
                        value={artifact.path}
                        onChange={(e) =>
                          updateDefinition({
                            artifacts: definition.artifacts.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, path: e.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs md:col-span-2">
                      초기 템플릿
                      <Textarea
                        className="min-h-24 font-mono text-xs"
                        value={artifact.template}
                        onChange={(e) =>
                          updateDefinition({
                            artifacts: definition.artifacts.map(
                              (item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, template: e.target.value }
                                  : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <Button
                      className="justify-self-start"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        updateDefinition({
                          artifacts: definition.artifacts.filter(
                            (_, itemIndex) => itemIndex !== index,
                          ),
                        })
                      }
                    >
                      <Trash2 /> 삭제
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitBranch className="size-4" /> 단계와 연결
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <WorkflowCanvas
                  key={draftId}
                  layoutKey={draftId}
                  definition={definition}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={updateDefinition}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    let index = definition.nodes.length + 1;
                    while (
                      definition.nodes.some((n) => n.id === `step-${index}`)
                    )
                      index++;
                    const next = blankNode(index);
                    updateDefinition({ nodes: [...definition.nodes, next] });
                    setSelected(next.id);
                  }}
                >
                  <Plus /> 단계 추가
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {node && (
              <Card>
                <CardHeader>
                  <CardTitle>선택한 단계</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <label className="text-xs">
                    ID
                    <Input
                      value={node.id}
                      onChange={(e) => {
                        const old = node.id;
                        const id = e.target.value;
                        setSelected(id);
                        setDefinition((current) => ({
                          ...current,
                          entry: current.entry === old ? id : current.entry,
                          nodes: current.nodes.map((n) =>
                            n.id === old ? { ...n, id } : n,
                          ),
                          edges: current.edges.map((edge) => ({
                            ...edge,
                            from: edge.from === old ? id : edge.from,
                            to: edge.to === old ? id : edge.to,
                          })),
                        }));
                      }}
                    />
                  </label>
                  <label className="text-xs">
                    이름
                    <Input
                      value={node.label}
                      onChange={(e) => updateNode({ label: e.target.value })}
                    />
                  </label>
                  <label className="text-xs">
                    종류
                    <select
                      className="mt-1 h-9 w-full rounded-md border bg-background px-3"
                      value={node.kind}
                      onChange={(e) =>
                        updateNode({
                          kind: e.target.value as WorkflowNode["kind"],
                        })
                      }
                    >
                      {[
                        "artifact",
                        "agent",
                        "check",
                        "human",
                        "condition",
                        "subworkflow",
                        "end",
                      ].map((kind) => (
                        <option key={kind} value={kind}>
                          {NODE_LABELS[kind as WorkflowNode["kind"]]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {node.kind === "artifact" && (
                    <label className="text-xs">
                      편집할 산출물 역할
                      <Input
                        value={node.artifactRole ?? ""}
                        onChange={(e) =>
                          updateNode({ artifactRole: e.target.value || null })
                        }
                      />
                    </label>
                  )}
                  {(node.kind === "agent" || node.kind === "check") && (
                    <label className="text-xs">
                      실행할 기능 ID
                      <Input
                        value={node.actionRef ?? ""}
                        onChange={(e) =>
                          updateNode({ actionRef: e.target.value || null })
                        }
                      />
                    </label>
                  )}
                  {node.kind === "human" && (
                    <label className="text-xs">
                      결정 키
                      <Input
                        value={node.decision ?? ""}
                        onChange={(e) =>
                          updateNode({ decision: e.target.value || null })
                        }
                      />
                    </label>
                  )}
                  {node.kind === "subworkflow" && (
                    <div className="grid grid-cols-2 gap-2 rounded-md border p-2">
                      <label className="text-xs">
                        하위 workflow ID
                        <Input
                          list="workflow-library"
                          value={node.workflowRef?.id ?? ""}
                          onChange={(e) =>
                            updateNode({
                              workflowRef: {
                                id: e.target.value,
                                version: node.workflowRef?.version ?? "1.0.0",
                              },
                            })
                          }
                        />
                      </label>
                      <label className="text-xs">
                        정확한 버전
                        <Input
                          value={node.workflowRef?.version ?? ""}
                          onChange={(e) =>
                            updateNode({
                              workflowRef: {
                                id: node.workflowRef?.id ?? "",
                                version: e.target.value,
                              },
                            })
                          }
                        />
                      </label>
                      <datalist id="workflow-library">
                        {catalog.map((item) => (
                          <option
                            key={`${item.id}@${item.version}`}
                            value={item.id}
                          >
                            {item.version}
                          </option>
                        ))}
                      </datalist>
                    </div>
                  )}
                  <label className="text-xs">
                    담당 역할(쉼표)
                    <Input
                      value={node.allowedRoles.join(", ")}
                      onChange={(e) =>
                        updateNode({
                          allowedRoles: comma(e.target.value) as AgentRole[],
                        })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    입력 역할(쉼표)
                    <Input
                      value={node.inputs.join(", ")}
                      onChange={(e) =>
                        updateNode({ inputs: comma(e.target.value) })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    출력 역할(쉼표)
                    <Input
                      value={node.outputs.join(", ")}
                      onChange={(e) =>
                        updateNode({ outputs: comma(e.target.value) })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    지침
                    <Textarea
                      value={node.instructions}
                      onChange={(e) =>
                        updateNode({ instructions: e.target.value })
                      }
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={node.requiresCompletedDependencies}
                      onCheckedChange={(value) =>
                        updateNode({ requiresCompletedDependencies: value })
                      }
                    />{" "}
                    선행 항목 완료 필요
                  </label>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={definition.nodes.length <= 1}
                    onClick={() => {
                      updateDefinition({
                        entry:
                          definition.entry === node.id
                            ? definition.nodes.find(
                                (item) => item.id !== node.id,
                              )!.id
                            : definition.entry,
                        nodes: definition.nodes.filter(
                          (item) => item.id !== node.id,
                        ),
                        edges: definition.edges.filter(
                          (edge) =>
                            edge.from !== node.id && edge.to !== node.id,
                        ),
                      });
                      setSelected(
                        definition.nodes.find((item) => item.id !== node.id)
                          ?.id ?? "",
                      );
                    }}
                  >
                    <Trash2 /> 삭제
                  </Button>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle>검증과 발행</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="text-xs">
                  초안 ID
                  <Input
                    value={draftId}
                    onChange={(e) => setDraftId(e.target.value)}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const saved = await workflowApi.saveDraft(
                          draftId,
                          definition,
                        );
                        setValidation(saved.validation);
                        await load();
                      })
                    }
                  >
                    <Save /> 초안 저장
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void action(async () =>
                        setValidation(await workflowApi.validate(definition)),
                      )
                    }
                  >
                    검증
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || validation?.valid === false}
                    onClick={() =>
                      void action(async () => {
                        await workflowApi.publish(definition);
                        await load();
                        setMessage("새 불변 버전을 발행했습니다.");
                      })
                    }
                  >
                    <CheckCircle2 /> 버전 발행
                  </Button>
                </div>
                {validation?.issues.map((issue, index) => (
                  <p
                    key={index}
                    className={`text-xs ${issue.severity === "error" ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {issue.path}: {issue.message}
                  </p>
                ))}
                <label className="text-xs">
                  시뮬레이션 이벤트(쉼표)
                  <Input
                    value={events}
                    onChange={(e) => setEvents(e.target.value)}
                  />
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () =>
                      setSimulation(
                        await workflowApi.simulate({
                          definition,
                          definitions: catalog,
                          events: comma(events).map((event) => ({ event })),
                        }),
                      ),
                    )
                  }
                >
                  가상 실행
                </Button>
                {simulation && (
                  <div className="rounded-md bg-muted p-3 text-xs">
                    <strong>{simulation.status}</strong>
                    <p>활성: {simulation.activeNodes.join(", ") || "없음"}</p>
                    {simulation.trace.map((row, index) => (
                      <p key={index}>
                        {row.event ?? "start"} · {row.nodeId} · {row.outcome}
                      </p>
                    ))}
                  </div>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAdvanced((value) => !value)}
                >
                  <Copy /> {advanced ? "시각 편집으로" : "고급 JSON"}
                </Button>
                {advanced && (
                  <Textarea
                    className="min-h-72 font-mono text-xs"
                    value={source}
                    onChange={(e) => {
                      setSource(e.target.value);
                      try {
                        setDefinition(
                          JSON.parse(e.target.value) as WorkflowDefinition,
                        );
                        setMessage(null);
                      } catch {
                        setMessage("JSON 구문을 확인하세요.");
                      }
                    }}
                  />
                )}
                {message && (
                  <p className="text-xs text-muted-foreground">{message}</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
