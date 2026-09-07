import { useApp } from "@/lib/store";
import { useTranslation } from "react-i18next";
import { WorkflowCanvas } from "./WorkflowCanvas";
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
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/pages/common";
import { workflowApi, sddApi, isWorkbenchPreview } from "@/features/workbench/api";
import {
  compareWorkflowVersions,
  latestWorkflowVersions,
} from "@/features/workbench/workflow-version";
import type {
  SimulationResult,
  AgentRole,
  ValidationReport,
  WorkflowDefinition,
  WorkflowArtifact,
  WorkflowDraftRecord,
  WorkflowNode,
  WorkspaceSnapshot,
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
  const { t } = useTranslation("dashboard");
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
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);

  async function load() {
    const [nextCatalog, nextDrafts, nextSnapshot] = await Promise.all([
      workflowApi.catalog(),
      workflowApi.drafts().catch((error) => {
        if (!isWorkbenchPreview)
          setMessage(
            t("workflowStudio.loadDraftsFailed", { error: String(error) }),
          );
        return [];
      }),
      // 라이브러리의 "어디에 쓰이는지" 표시용. 실패해도 편집은 계속된다.
      sddApi.snapshot().catch(() => null),
    ]);
    setCatalog(nextCatalog);
    setDrafts(nextDrafts);
    setSnapshot(nextSnapshot);
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

  // 발행 정의를 id별로 묶어 버전 이력을 한 자리에 보여준다.
  const publishedGroups = useMemo(() => {
    const groups = new Map<string, WorkflowDefinition[]>();
    for (const item of catalog) {
      const versions = groups.get(item.id) ?? [];
      versions.push(item);
      groups.set(item.id, versions);
    }
    for (const versions of groups.values())
      versions.sort((a, b) => compareWorkflowVersions(a.version, b.version));
    return [...groups.entries()];
  }, [catalog]);
  const latestVersion = useMemo(() => latestWorkflowVersions(catalog), [catalog]);

  // 프로젝트 기본 워크플로와 개별 작업의 고정 버전을 한 번에 센다.
  const usage = useMemo(() => {
    const map = new Map<string, { projects: string[]; work: number }>();
    const entry = (id: string, version: string) => {
      const key = `${id}@${version}`;
      const current = map.get(key) ?? { projects: [], work: 0 };
      map.set(key, current);
      return current;
    };
    for (const project of snapshot?.projects ?? [])
      entry(project.workflowId, project.workflowVersion).projects.push(
        project.name,
      );
    for (const work of snapshot?.work ?? [])
      entry(work.workflowId, work.workflowVersion).work += 1;
    return map;
  }, [snapshot]);

  function usageText(id: string, version: string): string {
    const use = usage.get(`${id}@${version}`);
    if (!use || (use.projects.length === 0 && use.work === 0))
      return t("workflowStudio.unused");
    const parts: string[] = [];
    if (use.projects.length > 0)
      parts.push(
        t("workflowStudio.defaultOf", { names: use.projects.join(", ") }),
      );
    if (use.work > 0)
      parts.push(t("workflowStudio.workCount", { count: use.work }));
    return parts.join(" · ");
  }

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
      <PageHeader title={t("workflowStudio.title")}>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              const text = await workflowApi.export(definition);
              await navigator.clipboard.writeText(text);
              setMessage(t("workflowStudio.copied"));
            })
          }
        >
          <Download className="size-3" /> {t("workflowStudio.export")}
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto grid max-w-7xl gap-4 xl:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside>
            <Card>
              <CardHeader>
                <CardTitle>{t("workflowStudio.library")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Button
                  className="w-full"
                  variant="secondary"
                  onClick={() => selectDefinition(freshDefinition())}
                >
                  <Plus /> {t("workflowStudio.newWorkflow")}
                </Button>
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("workflowStudio.published")}
                  </p>
                  {publishedGroups.map(([id, versions]) => (
                    <div key={id} className="space-y-1">
                      <p className="truncate font-mono text-[10px] text-muted-foreground">
                        {id}
                      </p>
                      {versions.map((item) => {
                        const isLatest = latestVersion.get(item.id) === item.version;
                        return (
                          <button
                            key={`${item.id}@${item.version}`}
                            className="w-full rounded-md border p-2 text-left text-xs hover:bg-accent"
                            onClick={() => selectDefinition(item)}
                          >
                            <span className="flex items-baseline justify-between gap-2">
                              <strong className="truncate">{item.label}</strong>
                              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                {isLatest && (
                                  <span className="mr-1 rounded bg-primary/10 px-1 font-sans text-primary">
                                    {t("workflowStudio.latestBadge")}
                                  </span>
                                )}
                                v{item.version}
                              </span>
                            </span>
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">
                              {usageText(item.id, item.version)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-muted-foreground">
                    {t("workflowStudio.drafts")}
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
                        {item.validation.valid
                          ? t("workflowStudio.valid")
                          : t("workflowStudio.needsFix")}
                      </Badge>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </aside>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("workflowStudio.definition")}</CardTitle>
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
                  {t("workflowStudio.version")}
                  <Input
                    value={definition.version}
                    onChange={(e) =>
                      updateDefinition({ version: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs">
                  {t("workflowStudio.name")}
                  <Input
                    aria-label={t("workflowStudio.nameAria")}
                    value={definition.label}
                    onChange={(e) =>
                      updateDefinition({ label: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs">
                  {t("workflowStudio.entryStep")}
                  <Select
                    className="mt-1"
                    value={definition.entry}
                    onChange={(v) => updateDefinition({ entry: v })}
                    options={definition.nodes.map((n) => ({
                      value: n.id,
                      label: n.label,
                    }))}
                  />
                </label>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  {t("workflowStudio.documents")}
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
                    <Plus /> {t("workflowStudio.addDocument")}
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {definition.artifacts.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("workflowStudio.noDocuments")}
                  </p>
                )}
                {definition.artifacts.map((artifact, index) => (
                  <div
                    key={`${artifact.role}-${index}`}
                    className="grid gap-2 rounded-md border p-3 md:grid-cols-2"
                  >
                    <label className="text-xs">
                      {t("workflowStudio.roleId")}
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
                      {t("workflowStudio.displayName")}
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
                      {t("workflowStudio.docPath")}
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
                      {t("workflowStudio.initialTemplate")}
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
                      <Trash2 /> {t("workflowStudio.delete")}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitBranch className="size-4" />{" "}
                  {t("workflowStudio.stepsAndEdges")}
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
                  <Plus /> {t("workflowStudio.addStep")}
                </Button>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {node && (
              <Card>
                <CardHeader>
                  <CardTitle>{t("workflowStudio.selectedStep")}</CardTitle>
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
                    {t("workflowStudio.name")}
                    <Input
                      value={node.label}
                      onChange={(e) => updateNode({ label: e.target.value })}
                    />
                  </label>
                  <label className="text-xs">
                    {t("workflowStudio.kind")}
                    <Select
                      className="mt-1"
                      value={node.kind}
                      onChange={(v) =>
                        updateNode({
                          kind: v as WorkflowNode["kind"],
                        })
                      }
                      options={[
                        "artifact",
                        "agent",
                        "check",
                        "human",
                        "condition",
                        "subworkflow",
                        "end",
                      ].map((kind) => ({
                        value: kind,
                        label: t(`canvas.nodeKinds.${kind}`),
                      }))}
                    />
                  </label>
                  {node.kind === "artifact" && (
                    <label className="text-xs">
                      {t("workflowStudio.artifactRole")}
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
                      {t("workflowStudio.actionRef")}
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
                      {t("workflowStudio.decisionKey")}
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
                        {t("workflowStudio.subworkflowId")}
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
                        {t("workflowStudio.exactVersion")}
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
                    {t("workflowStudio.allowedRoles")}
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
                    {t("workflowStudio.inputRoles")}
                    <Input
                      value={node.inputs.join(", ")}
                      onChange={(e) =>
                        updateNode({ inputs: comma(e.target.value) })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    {t("workflowStudio.outputRoles")}
                    <Input
                      value={node.outputs.join(", ")}
                      onChange={(e) =>
                        updateNode({ outputs: comma(e.target.value) })
                      }
                    />
                  </label>
                  <label className="text-xs">
                    {t("workflowStudio.instructions")}
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
                    {t("workflowStudio.requiresDeps")}
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
                    <Trash2 /> {t("workflowStudio.delete")}
                  </Button>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader>
                <CardTitle>{t("workflowStudio.validatePublish")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="text-xs">
                  {t("workflowStudio.draftId")}
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
                    <Save /> {t("workflowStudio.saveDraft")}
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
                    {t("workflowStudio.validate")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy || validation?.valid === false}
                    onClick={() =>
                      void action(async () => {
                        await workflowApi.publish(definition);
                        await load();
                        setMessage(t("workflowStudio.publishedNew"));
                      })
                    }
                  >
                    <CheckCircle2 /> {t("workflowStudio.publish")}
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
                  {t("workflowStudio.simulationEvents")}
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
                  {t("workflowStudio.simulate")}
                </Button>
                {simulation && (
                  <div className="rounded-md bg-muted p-3 text-xs">
                    <strong>{simulation.status}</strong>
                    <p>
                      {t("workflowStudio.activeNodes", {
                        nodes:
                          simulation.activeNodes.join(", ") ||
                          t("workflowStudio.none"),
                      })}
                    </p>
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
                  <Copy />{" "}
                  {advanced
                    ? t("workflowStudio.toVisual")
                    : t("workflowStudio.advancedJson")}
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
                        setMessage(t("workflowStudio.jsonSyntaxError"));
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
