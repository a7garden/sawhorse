import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Copy,
  Download,
  GitBranch,
  Layers,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { groupWorkflowVersions, isSelectableWorkflow } from "@/features/workbench/workflow-version";
import type { Project, WorkflowDefinition } from "@/features/workbench/types";

// Editorial guidance lives outside immutable runtime definitions and their digests.
const guides: Record<string, string> = {
  "sdd-main": "sdd",
  "intent-flow": "intent",
  "tdd-cycle": "tdd",
  "sdd-with-tdd": "composed",
  "issue-main": "issue",
  "goal-main": "goal",
};
export function workflowFacts(definition: WorkflowDefinition) {
  return {
    human: definition.nodes.filter((node) => node.kind === "human").length,
    children: definition.nodes.filter((node) => node.kind === "subworkflow"),
    loops: definition.loops.length,
  };
}

export function WorkflowGallery({
  catalog,
  projects,
  busy,
  usageText,
  onCreate,
  onSelect,
  onCopy,
  onImport,
  onExport,
  onApply,
  onExtensions,
}: {
  catalog: WorkflowDefinition[];
  projects: Project[];
  busy: boolean;
  usageText: (id: string, version: string) => string;
  onCreate: () => void;
  onSelect: (definition: WorkflowDefinition) => void;
  onCopy: (definition: WorkflowDefinition) => void;
  onImport: (json: string) => void;
  onExport: (definition: WorkflowDefinition) => void;
  onApply: (projectId: string, definition: WorkflowDefinition) => void;
  onExtensions: () => void;
}) {
  const { t } = useTranslation("dashboard");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [compared, setCompared] = useState<string[]>([]);
  const [opened, setOpened] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [importing, setImporting] = useState(false);
  const [json, setJson] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (opened) detailRef.current?.scrollIntoView({ block: "start" });
  }, [opened]);
  const groups = useMemo(() => groupWorkflowVersions(catalog.filter((item) => isSelectableWorkflow(item.id))), [catalog]);
  const latest = groups.map((versions) => versions[0]);
  const visible = latest.filter((definition) => {
    const facts = workflowFacts(definition);
    const text = `${definition.label} ${definition.id} ${definition.description} ${guides[definition.id] ? t(`gallery.guides.${guides[definition.id]}`) : ""}`;
    return (
      text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
      (filter === "all" ||
        (filter === "human" && facts.human > 0) ||
        (filter === "loops" && facts.loops > 0) ||
        (filter === "composed" && facts.children.length > 0))
    );
  });
  const selections = latest.filter((item) => compared.includes(item.id));
  const detail = latest.find((item) => item.id === opened);
  const fit = (item: WorkflowDefinition) =>
    guides[item.id]
      ? t(`gallery.guides.${guides[item.id]}`)
      : item.description || t("gallery.customGuide");
  const factRows = (item: WorkflowDefinition) => {
    const facts = workflowFacts(item);
    return [
      fit(item),
      t("gallery.humanCount", { count: facts.human }),
      item.artifacts.map((artifact) => artifact.label).join(" · ") ||
        t("workflowStudio.noDocuments"),
      item.loops
        .map(
          (loop) =>
            `${loop.id} · ${t("gallery.maxLoops", { count: loop.maxIterations })}`,
        )
        .join(" / ") || t("gallery.noLoops"),
      facts.children
        .map(
          (node) =>
            `${node.label} (${node.workflowRef?.id} @ ${node.workflowRef?.version})`,
        )
        .join(" · ") || t("gallery.noChildren"),
    ];
  };
  return (
    <div className="workflow-gallery">
      <header className="gallery-hero">
        <div className="studio-eyebrow">
          <span />
          {t("gallery.eyebrow")}
        </div>
        <h2>{t("gallery.title")}</h2>
        <p>{t("gallery.intro")}</p>
        <div className="gallery-actions">
          <Button onClick={onCreate} disabled={busy}>
            <Plus />
            {t("workflowStudio.newWorkflow")}
          </Button>
          <Button
            variant="outline"
            onClick={() => setImporting(!importing)}
            disabled={busy}
          >
            <Upload />
            {t("gallery.import")}
          </Button>
          <Button variant="ghost" onClick={onExtensions} disabled={busy}>
            <Layers />
            {t("gallery.extensions")}
          </Button>
        </div>
      </header>
      {importing && (
        <section className="gallery-import" aria-label={t("gallery.import")}>
          <h3>{t("gallery.importTitle")}</h3>
          <p>{t("gallery.importHint")}</p>
          <Textarea
            aria-label={t("gallery.json")}
            value={json}
            onChange={(event) => setJson(event.target.value)}
            disabled={busy}
            placeholder={'{ "id": "team-workflow", ... }'}
          />
          <Button
            disabled={busy || !json.trim()}
            onClick={() => onImport(json)}
          >
            <Upload />
            {t("gallery.importDraft")}
          </Button>
        </section>
      )}
      <div className="gallery-toolbar">
        <div className="gallery-filters" aria-label={t("gallery.filter")}>
          {["all", "human", "loops", "composed"].map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(`gallery.filters.${value}`)}
            </button>
          ))}
        </div>
        <label className="gallery-search">
          <Search size={15} />
          <Input
            aria-label={t("gallery.search")}
            placeholder={t("gallery.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div className="gallery-catalog-note">
        <span>{t("gallery.count", { count: visible.length })}</span>
        <span>{t("gallery.latestOnly")}</span>
      </div>
      <div className="gallery-grid">
        {visible.map((item) => {
          const facts = workflowFacts(item);
          return (
            <article
              key={item.id}
              className={`gallery-card ${opened === item.id ? "is-selected" : ""}`}
            >
              <div className="gallery-card-top">
                <span className="gallery-icon">
                  <GitBranch />
                </span>
                <span className="gallery-version">v{item.version}</span>
                <label className="gallery-compare-check">
                  <input
                    type="checkbox"
                    checked={compared.includes(item.id)}
                    disabled={
                      !compared.includes(item.id) && compared.length >= 3
                    }
                    onChange={(event) =>
                      setCompared(
                        event.target.checked
                          ? [...compared, item.id]
                          : compared.filter((id) => id !== item.id),
                      )
                    }
                    aria-label={t("gallery.compareNamed", { name: item.label })}
                  />
                  {t("gallery.compare")}
                </label>
              </div>
              <h3>{item.label}</h3>
              <p className="gallery-fit">{fit(item)}</p>
              <div
                className="gallery-node-chips"
                aria-label={t("gallery.stages")}
              >
                {item.nodes.slice(0, 5).map((node) => (
                  <span
                    key={node.id}
                    className={node.kind === "human" ? "is-human" : ""}
                  >
                    {node.label}
                  </span>
                ))}
                {item.nodes.length > 5 && <span>+{item.nodes.length - 5}</span>}
              </div>
              <div className="gallery-facts">
                <span>{t("gallery.steps", { count: item.nodes.length })}</span>
                <span>{t("gallery.humanCount", { count: facts.human })}</span>
                <span>
                  {t("gallery.artifacts", { count: item.artifacts.length })}
                </span>
              </div>
              <button
                className="gallery-open"
                disabled={busy}
                onClick={() => {
                  setOpened(item.id);
                  setProjectId("");
                }}
              >
                {t("gallery.details")}
                <ArrowRight size={16} />
              </button>
            </article>
          );
        })}
      </div>
      {!visible.length && <p className="gallery-empty">{t("gallery.empty")}</p>}
      {selections.length > 0 && (
        <section
          className="gallery-comparison"
          aria-label={t("gallery.comparison")}
        >
          <div className="gallery-section-heading">
            <h3>{t("gallery.comparison")}</h3>
            <Button size="xs" variant="ghost" onClick={() => setCompared([])}>
              <X />
              {t("gallery.clear")}
            </Button>
          </div>
          <p>{t("gallery.compareHint")}</p>
          <div className="gallery-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("gallery.criteria")}</th>
                  {selections.map((item) => (
                    <th scope="col" key={item.id}>
                      {item.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {["fit", "human", "artifacts", "loops", "children"].map(
                  (key, index) => (
                    <tr key={key}>
                      <th scope="row">{t(`gallery.rows.${key}`)}</th>
                      {selections.map((item) => (
                        <td key={item.id}>{factRows(item)[index]}</td>
                      ))}
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {detail && (
        <section
          ref={detailRef}
          className="gallery-detail"
          aria-label={t("gallery.detailNamed", { name: detail.label })}
        >
          <div className="gallery-section-heading">
            <div>
              <span className="gallery-version">
                {detail.id} · v{detail.version}
              </span>
              <h3>{detail.label}</h3>
            </div>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setOpened(null)}
              aria-label={t("gallery.close")}
            >
              <X />
            </Button>
          </div>
          <p>{detail.description}</p>
          <dl className="gallery-detail-facts">
            {["fit", "human", "artifacts", "loops", "children"].map(
              (key, index) => (
                <div key={key}>
                  <dt>{t(`gallery.rows.${key}`)}</dt>
                  <dd>{factRows(detail)[index]}</dd>
                </div>
              ),
            )}
          </dl>
          {(detail.requirements?.length ?? 0) > 0 && (
            <p>
              {t("studio.requirements")}:{" "}
              {detail.requirements
                ?.map(
                  (requirement) =>
                    `${requirement.label} (${t(`studio.requirementLevels.${requirement.level}`)})`,
                )
                .join(" · ")}
            </p>
          )}
          <p>{usageText(detail.id, detail.version)}</p>
          <div className="gallery-apply">
            <select
              aria-label={t("gallery.project")}
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              disabled={busy}
            >
              <option value="">{t("gallery.project")}</option>
              {projects.map((project) => (
                <option value={project.id} key={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <Button
              disabled={busy || !projectId}
              onClick={() => onApply(projectId, detail)}
            >
              {t("gallery.apply")}
            </Button>
          </div>
          <p className="gallery-muted">{t("gallery.applyHint")}</p>
          <div className="gallery-actions">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onCopy(detail)}
            >
              <Copy />
              {t("gallery.copy")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onSelect(detail)}
            >
              {t("gallery.edit")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => onExport(detail)}
            >
              <Download />
              {t("workflowStudio.export")}
            </Button>
          </div>
          <details className="gallery-history">
            <summary>
              {t("studio.versionHistory")} ·{" "}
              {(groups.find((versions) => versions[0].id === detail.id)
                ?.length ?? 1) - 1}
            </summary>
            <p>{t("gallery.historyHint")}</p>
            {groups
              .find((versions) => versions[0].id === detail.id)
              ?.slice(1)
              .map((item) => (
                <div key={item.version}>
                  <span>
                    v{item.version} · {usageText(item.id, item.version)}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onSelect(item)}
                  >
                    {t("gallery.inspect")}
                  </Button>
                </div>
              ))}
          </details>
        </section>
      )}
      <footer className="gallery-footer">
        <Layers />
        <div>
          <h3>{t("gallery.shareTitle")}</h3>
          <p>{t("gallery.shareHint")}</p>
        </div>
      </footer>
    </div>
  );
}
