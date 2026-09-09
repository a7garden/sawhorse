import { isSelectableWorkflow } from "@/features/workbench/workflow-version";
import { useApp } from "@/lib/store";
import { EVENTS } from "@/lib/api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { WorkflowBrief } from "./WorkflowBrief";
import { WorkflowGallery } from "./WorkflowGallery";
import "./studio.css";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ArrowLeft,
  Copy,
  Download,
  GitBranch,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PageHeader } from "@/pages/common";
import {
  workflowApi,
  sddApi,
  isWorkbenchPreview,
} from "@/features/workbench/api";
import { compareWorkflowVersions } from "@/features/workbench/workflow-version";
import type {
  SimulationResult,
  AgentRole,
  ValidationReport,
  WorkflowDefinition,
  WorkflowArtifact,
  WorkflowDraftRecord,
  WorkflowNode,
  WorkflowRequirement,
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

function blankRequirement(index: number): WorkflowRequirement {
  return {
    kind: "extension",
    id: `extension-${index}`,
    label: `Extension ${index}`,
    level: "required",
    reason: "",
    commands: [],
    versionArgs: [],
    minimumMajor: 0,
    version: "^1.0",
    installUrl: "",
    installHint: "",
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
  const defaultAgent = useApp((s) => s.defaultAgent);
  const localAgents = useApp((s) => s.agents);
  const generatorAgents = useMemo(
    () =>
      localAgents
        .filter(
          (candidate) =>
            candidate.detected && ["claude", "codex", "omp"].includes(candidate.id),
        )
        .map((candidate) => ({ value: candidate.id, label: candidate.name })),
    [localAgents],
  );
  const mainRef = useRef<HTMLElement>(null);
  const [catalog, setCatalog] = useState<WorkflowDefinition[]>([]);
  const [drafts, setDrafts] = useState<WorkflowDraftRecord[]>([]);
  const [draftId, setDraftId] = useState(`draft-${crypto.randomUUID()}`);
  const [draftRevision, setDraftRevision] = useState<string>();
  const [definition, setDefinition] = useState<WorkflowDefinition>(() =>
    initial ? clone(initial) : freshDefinition(),
  );
  const [selected, setSelected] = useState(initial?.entry ?? "start");
  const [editing, setEditing] = useState(false);
  const [browsing, setBrowsing] = useState(!initial);
  const [hasDraft, setHasDraft] = useState(!!initial);
  const [request, setRequest] = useState("");
  const [agent, setAgent] = useState(defaultAgent);
  const [advanced, setAdvanced] = useState(false);
  const [source, setSource] = useState("");
  const [events, setEvents] = useState("approved");
  const [validation, setValidation] = useState<ValidationReport | null>(null);
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const loadSequence = useRef(0);

  useEffect(() => {
    if (!generatorAgents.length) return;
    if (!generatorAgents.some((candidate) => candidate.value === agent)) {
      setAgent(
        generatorAgents.find((candidate) => candidate.value === defaultAgent)?.value ??
          generatorAgents[0].value,
      );
    }
  }, [agent, defaultAgent, generatorAgents]);

  async function load() {
    const sequence = ++loadSequence.current;
    const [nextCatalog, nextDrafts, nextSnapshot] = await Promise.all([
      workflowApi.catalog(),
      workflowApi.drafts().catch((error) => {
        if (!isWorkbenchPreview)
          setMessage(
            t("workflowStudio.loadDraftsFailed", { error: String(error) }),
          );
        return [];
      }),
      // For the library's "어디에 쓰이는지" (where used) display. Editing continues even if this fails.
      sddApi.snapshot().catch(() => null),
    ]);
    if (sequence !== loadSequence.current) return;
    setCatalog(nextCatalog);
    setDrafts(nextDrafts);
    setSnapshot(nextSnapshot);
  }

  useEffect(() => {
    const refresh = () => void load().catch((error) => setMessage(String(error)));
    refresh();
    // External CLI edits refresh the library, preserving the current editor and
    // its observed revision so unsaved changes still receive conflict checks.
    window.addEventListener("focus", refresh);
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    if (!isWorkbenchPreview) {
      void listen(EVENTS.vaultChanged, refresh).then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      }).catch((error) => setMessage(String(error)));
    }
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      unlisten?.();
    };
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

  // Groups published definitions by id so version history shows in one place.
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

  // Counts project default workflows and per-work pinned versions in one pass.
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
    nextRevision = nextDraftId === draftId ? draftRevision : undefined,
  ) {
    const value = clone(next);
    setBrowsing(false);
    setDefinition(value);
    setDraftId(nextDraftId);
    setDraftRevision(nextRevision);
    setSelected(value.entry);
    setHasDraft(true);
    setEditing(false);
    setRequest("");
    setMessage(null);
    setValidation(null);
    setSimulation(null);
    mainRef.current?.scrollTo({ top: 0 });
  }

  async function generate() {
    if (!request.trim() || busy) return;
    await action(async () => {
      const next = await workflowApi.generate(
        request.trim(),
        hasDraft ? definition : null,
        agent,
      );
      // Keep the current draft untouched until a complete response has arrived.
      const report = await workflowApi.validate(next);
      if (!report.valid) {
        setValidation(report);
        setMessage(t("studio.generationInvalid"));
        return;
      }
      // Preserve a complete generated design before navigating to another screen.
      const saved = await workflowApi.saveDraft(draftId, next, draftRevision);
      selectDefinition(next, draftId, saved.revision);
      setValidation(report);
      await load();
      setMessage(
        t(isWorkbenchPreview ? "studio.previewGenerated" : "studio.generated"),
      );
    });
  }

  async function publish() {
    await action(async () => {
      const report = await workflowApi.validate(definition);
      setValidation(report);
      if (!report.valid) return;
      let next = definition;
      const existing = catalog.find(
        (item) => item.id === next.id && item.version === next.version,
      );
      if (existing && JSON.stringify(existing) !== JSON.stringify(next)) {
        const versions = catalog
          .filter((item) => item.id === next.id)
          .map((item) => item.version)
          .sort(compareWorkflowVersions);
        const last = versions[versions.length - 1] || next.version;
        const parts = last.split(/[+-]/)[0].split(".").map(Number);
        next = {
          ...next,
          version: `${parts[0] ?? 1}.${parts[1] ?? 0}.${(parts[2] ?? 0) + 1}`,
        };
      }
      await workflowApi.publish(next);
      setDefinition(next);
      await load();
      setMessage(t("workflowStudio.publishedNew"));
    });
  }

  return (
    <div className="studio flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader title={t("workflowStudio.title")}>
        <Button size="sm" variant={browsing ? "outline" : "ghost"} disabled={busy} onClick={() => setBrowsing(true)}>
          <GitBranch />{t("gallery.browse")}
        </Button>
        {hasDraft && !browsing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await navigator.clipboard.writeText(
                  await workflowApi.export(definition),
                );
                setMessage(t("workflowStudio.copied"));
              })
            }
          >
            <Download />
            {t("workflowStudio.export")}
          </Button>
        )}
      </PageHeader>
      <div className="studio-layout">
        <aside
          className="studio-library"
          aria-label={t("workflowStudio.library")}
        >
          <Button
            className="w-full"
            variant="outline"
            disabled={busy}
            onClick={() => {
              selectDefinition(freshDefinition());
              setHasDraft(false);
              setEditing(false);
            }}
          >
            <Plus />
            {t("workflowStudio.newWorkflow")}
          </Button>
          <div className="studio-library-heading">
            {t("workflowStudio.published")}
            <span>{publishedGroups.length}</span>
          </div>
          {publishedGroups.map(([id, versions]) => {
            const item = versions[versions.length - 1];
            return (
              <div key={id}>
                <button
                  disabled={busy}
                  className={`studio-library-item ${hasDraft && definition.id === id ? "is-selected" : ""}`}
                  onClick={() => selectDefinition(item)}
                >
                  <GitBranch />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{!isSelectableWorkflow(item.id) && `${t("gallery.retired")} · `}{usageText(item.id, item.version)}</small>
                  </span>
                </button>
                {versions.length > 1 && (
                  <details className="studio-versions">
                    <summary>{t("studio.versionHistory")}</summary>
                    {versions
                      .slice(0, -1)
                      .reverse()
                      .map((version) => (
                        <button
                          disabled={busy}
                          key={version.version}
                          onClick={() => selectDefinition(version)}
                        >
                          v{version.version} · {usageText(id, version.version)}
                        </button>
                      ))}
                  </details>
                )}
              </div>
            );
          })}
          <div className="studio-library-heading">
            {t("workflowStudio.drafts")}
            <span>{drafts.length}</span>
          </div>
          {drafts.length === 0 && (
            <p className="studio-library-empty">{t("studio.noDrafts")}</p>
          )}
          {drafts.map((item) => (
            <button
              disabled={busy}
              key={item.draftId}
              className={`studio-library-item ${hasDraft && draftId === item.draftId ? "is-selected" : ""}`}
              onClick={() => selectDefinition(item.definition, item.draftId, item.revision)}
            >
              <span className="studio-draft-dot" />
              <span>
                <strong>{item.definition.label}</strong>
                <small>
                  {t(
                    item.validation.valid
                      ? "workflowStudio.valid"
                      : "workflowStudio.needsFix",
                  )}
                </small>
              </span>
            </button>
          ))}
        </aside>
        <main ref={mainRef} className="studio-main">
          {message && <p className="studio-notice studio-feedback" role="status">{message}</p>}
          {browsing ? (
            <WorkflowGallery
              catalog={catalog}
              projects={snapshot?.projects ?? []}
              busy={busy}
              usageText={usageText}
              onCreate={() => {
                selectDefinition(freshDefinition());
                setHasDraft(false);
              }}
              onSelect={selectDefinition}
              onCopy={(item) => void action(async () => {
                const copy = { ...clone(item), id: `team-${crypto.randomUUID()}`, label: t("gallery.copyName", { name: item.label }), version: "1.0.0" };
                const saved = await workflowApi.saveDraft(`draft-${crypto.randomUUID()}`, copy);
                selectDefinition(saved.definition, saved.draftId, saved.revision);
                setValidation(saved.validation);
                await load();
                setMessage(t("gallery.copied"));
              })}
              onImport={(json) => void action(async () => {
                const saved = await workflowApi.import(json);
                selectDefinition(saved.definition, saved.draftId, saved.revision);
                setValidation(saved.validation);
                await load();
                setMessage(t("gallery.imported"));
              })}
              onExport={(item) => void action(async () => {
                await navigator.clipboard.writeText(await workflowApi.export(item));
                setMessage(t("workflowStudio.copied"));
              })}
              onApply={(projectId, item) => void action(async () => {
                const project = await workflowApi.activate(projectId, item.id, item.version);
                await load();
                setMessage(t("gallery.applied", { name: project.name, workflow: item.label, version: item.version }));
              })}
              onExtensions={() => useApp.getState().setPage("packs")}
            />
          ) : editing ? (
            <>
              <div className="studio-editor-header">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setEditing(false)}
                >
                  <ArrowLeft />
                  {t("studio.backToOverview")}
                </Button>
                <span>{t("studio.advancedHint")}</span>
              </div>
              <fieldset disabled={busy} className="studio-editor-grid">
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
                          onChange={(e) =>
                            updateDefinition({ id: e.target.value })
                          }
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
                        {t("workflowStudio.requirements")}
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() =>
                            updateDefinition({
                              requirements: [
                                ...(definition.requirements ?? []),
                                blankRequirement(
                                  (definition.requirements?.length ?? 0) + 1,
                                ),
                              ],
                            })
                          }
                        >
                          <Plus /> {t("workflowStudio.addRequirement")}
                        </Button>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        {t("workflowStudio.requirementsHint")}
                      </p>
                      {(definition.requirements ?? []).map((requirement, index) => {
                        const updateRequirement = (
                          patch: Partial<WorkflowRequirement>,
                        ) =>
                          updateDefinition({
                            requirements: (definition.requirements ?? []).map(
                              (item, itemIndex) =>
                                itemIndex === index ? { ...item, ...patch } : item,
                            ),
                          });
                        return (
                          <div
                            key={`${requirement.kind}-${requirement.id}-${index}`}
                            className="grid gap-2 rounded-md border p-3 md:grid-cols-2"
                          >
                            <label className="text-xs">
                              {t("workflowStudio.requirementKind")}
                              <Select
                                className="mt-1"
                                value={requirement.kind}
                                onChange={(value) =>
                                  updateRequirement({
                                    kind: value as WorkflowRequirement["kind"],
                                    commands:
                                      value === "program" ? [requirement.id] : [],
                                    versionArgs:
                                      value === "program" ? ["--version"] : [],
                                    minimumMajor: 0,
                                    version:
                                      value === "extension" ? "^1.0" : "",
                                  })
                                }
                                options={[
                                  {
                                    value: "extension",
                                    label: t("workflowStudio.requirementKinds.extension"),
                                  },
                                  {
                                    value: "program",
                                    label: t("workflowStudio.requirementKinds.program"),
                                  },
                                ]}
                              />
                            </label>
                            <label className="text-xs">
                              {t("workflowStudio.requirementLevel")}
                              <Select
                                className="mt-1"
                                value={requirement.level}
                                onChange={(value) =>
                                  updateRequirement({
                                    level: value as WorkflowRequirement["level"],
                                  })
                                }
                                options={[
                                  "required",
                                  "recommended",
                                  "optional",
                                ].map((value) => ({
                                  value,
                                  label: t(`studio.requirementLevels.${value}`),
                                }))}
                              />
                            </label>
                            <label className="text-xs">
                              ID
                              <Input
                                value={requirement.id}
                                onChange={(event) =>
                                  updateRequirement({ id: event.target.value })
                                }
                              />
                            </label>
                            <label className="text-xs">
                              {t("workflowStudio.displayName")}
                              <Input
                                value={requirement.label}
                                onChange={(event) =>
                                  updateRequirement({ label: event.target.value })
                                }
                              />
                            </label>
                            <label className="text-xs md:col-span-2">
                              {requirement.kind === "program"
                                ? t("workflowStudio.commands")
                                : t("workflowStudio.versionRange")}
                              <Input
                                value={
                                  requirement.kind === "program"
                                    ? requirement.commands.join(", ")
                                    : requirement.version
                                }
                                onChange={(event) =>
                                  updateRequirement(
                                    requirement.kind === "program"
                                      ? { commands: comma(event.target.value) }
                                      : { version: event.target.value },
                                  )
                                }
                              />
                            </label>
                            {requirement.kind === "program" && (
                              <>
                                <label className="text-xs">
                                  {t("workflowStudio.versionArgs")}
                                  <Input
                                    value={requirement.versionArgs.join(", ")}
                                    onChange={(event) =>
                                      updateRequirement({
                                        versionArgs: comma(event.target.value),
                                      })
                                    }
                                  />
                                </label>
                                <label className="text-xs">
                                  {t("workflowStudio.minimumMajor")}
                                  <Input
                                    type="number"
                                    min={0}
                                    value={requirement.minimumMajor}
                                    onChange={(event) =>
                                      updateRequirement({
                                        minimumMajor: Math.max(
                                          0,
                                          Number(event.target.value) || 0,
                                        ),
                                      })
                                    }
                                  />
                                </label>
                              </>
                            )}
                            <label className="text-xs md:col-span-2">
                              {t("workflowStudio.requirementReason")}
                              <Input
                                value={requirement.reason}
                                onChange={(event) =>
                                  updateRequirement({ reason: event.target.value })
                                }
                              />
                            </label>
                            <label className="text-xs md:col-span-2">
                              {t("workflowStudio.installUrl")}
                              <Input
                                value={requirement.installUrl}
                                onChange={(event) =>
                                  updateRequirement({ installUrl: event.target.value })
                                }
                              />
                            </label>
                            <label className="text-xs md:col-span-2">
                              {t("workflowStudio.installHint")}
                              <Input
                                value={requirement.installHint}
                                onChange={(event) =>
                                  updateRequirement({ installHint: event.target.value })
                                }
                              />
                            </label>
                            <Button
                              className="justify-self-start"
                              size="xs"
                              variant="ghost"
                              onClick={() =>
                                updateDefinition({
                                  requirements: (definition.requirements ?? []).filter(
                                    (_, itemIndex) => itemIndex !== index,
                                  ),
                                })
                              }
                            >
                              <Trash2 /> {t("workflowStudio.delete")}
                            </Button>
                          </div>
                        );
                      })}
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
                            definition.nodes.some(
                              (n) => n.id === `step-${index}`,
                            )
                          )
                            index++;
                          const next = blankNode(index);
                          updateDefinition({
                            nodes: [...definition.nodes, next],
                          });
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
                        <CardTitle>
                          {t("workflowStudio.selectedStep")}
                        </CardTitle>
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
                                entry:
                                  current.entry === old ? id : current.entry,
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
                            onChange={(e) =>
                              updateNode({ label: e.target.value })
                            }
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
                                updateNode({
                                  artifactRole: e.target.value || null,
                                })
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
                                updateNode({
                                  actionRef: e.target.value || null,
                                })
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
                                      version:
                                        node.workflowRef?.version ?? "1.0.0",
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
                                allowedRoles: comma(
                                  e.target.value,
                                ) as AgentRole[],
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
                              updateNode({
                                requiresCompletedDependencies: value,
                              })
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
                              definition.nodes.find(
                                (item) => item.id !== node.id,
                              )?.id ?? "",
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
                      <CardTitle>
                        {t("workflowStudio.validatePublish")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <label className="text-xs">
                        {t("workflowStudio.draftId")}
                        <Input
                          value={draftId}
                          onChange={(e) => { setDraftId(e.target.value); setDraftRevision(undefined); }}
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
                                draftRevision,
                              );
                              setDraftRevision(saved.revision);
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
                              setValidation(
                                await workflowApi.validate(definition),
                              ),
                            )
                          }
                        >
                          {t("workflowStudio.validate")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy || validation?.valid === false}
                          onClick={() => void publish()}
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
                                events: comma(events).map((event) => ({
                                  event,
                                })),
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
                          {simulation.issues.map((issue, index) => (
                            <p
                              key={`issue-${index}`}
                              className={
                                issue.severity === "error" ? "text-destructive" : ""
                              }
                            >
                              {issue.path} · {issue.message}
                            </p>
                          ))}
                          <p>
                            {t("workflowStudio.activeNodes", {
                              nodes:
                                simulation.activeNodes.join(", ") ||
                                t("workflowStudio.none"),
                            })}
                          </p>
                          {simulation.trace.map((row, index) => (
                            <p key={index}>
                              {row.event ?? "start"} · {row.nodeId} ·{" "}
                              {row.outcome}
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
                        <>
                          <Textarea
                            aria-label="Workflow JSON"
                            className="min-h-72 font-mono text-xs"
                            value={source}
                            onChange={(event) => setSource(event.target.value)}
                          />
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const parsed = JSON.parse(
                                  source,
                                ) as WorkflowDefinition;
                                if (
                                  !parsed ||
                                  !Array.isArray(parsed.nodes) ||
                                  !Array.isArray(parsed.edges) ||
                                  !Array.isArray(parsed.artifacts) ||
                                  !Array.isArray(parsed.loops) ||
                                  parsed.nodes.some(
                                    (item) =>
                                      !item ||
                                      !Array.isArray(item.inputs) ||
                                      !Array.isArray(item.outputs) ||
                                      !Array.isArray(item.allowedRoles),
                                  )
                                )
                                  throw new Error(
                                    t("workflowStudio.jsonSyntaxError"),
                                  );
                                const report =
                                  await workflowApi.validate(parsed);
                                setValidation(report);
                                if (report.valid) {
                                  updateDefinition(parsed);
                                  setSelected(parsed.entry);
                                }
                              })
                            }
                          >
                            {t("studio.applyJson")}
                          </Button>
                        </>
                      )}
                    </CardContent>
                  </Card>
                </div>
              </fieldset>
            </>
          ) : (
            <WorkflowBrief
              definition={hasDraft ? definition : null}
              request={request}
              onRequest={setRequest}
              agent={agent}
              agentOptions={generatorAgents}
              onAgent={setAgent}
              busy={busy}
              onGenerate={() => void generate()}
              onEdit={() => {
                setHasDraft(true);
                setEditing(true);
              }}
              onSave={() =>
                void action(async () => {
                  const saved = await workflowApi.saveDraft(
                    draftId,
                    definition,
                    draftRevision,
                  );
                  setDraftRevision(saved.revision);
                  setValidation(saved.validation);
                  await load();
                  setMessage(t("studio.saved"));
                })
              }
              onPublish={() => void publish()}
              onName={(label) => updateDefinition({ label })}
            />
          )}
          {validation && !validation.valid && (
            <div className="studio-notice" role="alert">
              {validation.issues.map((issue, i) => (
                <p key={i}>
                  {issue.path}: {issue.message}
                </p>
              ))}
            </div>
          )}

        </main>
      </div>
    </div>
  );
}
