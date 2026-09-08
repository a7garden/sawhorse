import {
  ArrowDown,
  ArrowRight,
  Bot,
  Check,
  FileText,
  GitBranch,
  Loader2,
  PackageCheck,
  Save,
  SlidersHorizontal,
  FilePenLine,
  UserRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { isWorkbenchPreview } from "@/features/workbench/api";
import type { WorkflowDefinition } from "@/features/workbench/types";

export function WorkflowBrief({
  definition,
  request,
  onRequest,
  agent,
  agentOptions,
  onAgent,
  busy,
  onGenerate,
  onEdit,
  onSave,
  onPublish,
  onName,
}: {
  definition: WorkflowDefinition | null;
  request: string;
  onRequest: (value: string) => void;
  agent: string;
  agentOptions: { value: string; label: string }[];
  onAgent: (value: string) => void;
  busy: boolean;
  onGenerate: () => void;
  onEdit: () => void;
  onSave: () => void;
  onPublish: () => void;
  onName: (value: string) => void;
}) {
  const { t } = useTranslation("dashboard");
  const examples = ["development", "review", "research"];
  const approvals =
    definition?.nodes.filter((node) => node.kind === "human" || definition.edges.some(edge => edge.from === node.id && edge.on === "approved")) ?? [];
  const composer = (
    <form
      className="studio-composer"
      onSubmit={(event) => {
        event.preventDefault();
        onGenerate();
      }}
    >
      <label htmlFor="workflow-request" className="studio-composer-label">
        <FilePenLine />
        {t(definition ? "studio.refineLabel" : "studio.requestLabel")}
      </label>
      <Textarea
        id="workflow-request"
        value={request}
        disabled={busy}
        onChange={(event) => onRequest(event.target.value)}
        placeholder={t(
          definition ? "studio.refinePlaceholder" : "studio.placeholder",
        )}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key === "Enter" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            onGenerate();
          }
        }}
      />
      <div className="studio-composer-footer">
        <div className="studio-agent">
          <span className="studio-agent-dot" />
          <select
            aria-label={t("studio.agent")}
            value={agent}
            disabled={busy}
            onChange={(event) => onAgent(event.target.value)}
          >
            {agentOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span>
            {t(isWorkbenchPreview ? "studio.preview" : "studio.agentReady")}
          </span>
        </div>
        <Button type="submit" disabled={busy || !request.trim()}>
          {busy && <Loader2 className="animate-spin" />}
          {t(
            busy
              ? "studio.generating"
              : definition
                ? "studio.refine"
                : "studio.generate",
          )}{" "}
          {!busy && <ArrowRight />}
        </Button>
      </div>
      {busy && (
        <p className="studio-progress" role="status">
          {t("studio.progress")}
        </p>
      )}
    </form>
  );

  if (!definition)
    return (
      <div className="studio-welcome">
        <h2>{t("workflowStudio.newWorkflow")}</h2>
        <p className="studio-intro">{t("studio.intro")}</p>
        {composer}
        <div className="studio-examples-label">{t("studio.examplesLabel")}</div>
        <div className="studio-examples">
          {examples.map((example, i) => {
            const Icon = [GitBranch, Check, FileText][i];
            return (
              <button
                key={example}
                disabled={busy}
                onClick={() =>
                  onRequest(t(`studio.examples.${example}.prompt`))
                }
              >
                <Icon />
                <strong>{t(`studio.examples.${example}.title`)}</strong>
                <p>{t(`studio.examples.${example}.description`)}</p>
                <ArrowRight className="studio-example-arrow" />
              </button>
            );
          })}
        </div>
        <button className="studio-manual" disabled={busy} onClick={onEdit}>
          <SlidersHorizontal />
          {t("studio.manual")}
        </button>
      </div>
    );

  return (
    <div className="studio-overview">
      <div className="studio-overview-top">
        <div>
          <div className="studio-eyebrow">
            <span />
            {t("studio.overview")}
          </div>
          <Input
            className="studio-name"
            aria-label={t("workflowStudio.nameAria")}
            value={definition.label}
            disabled={busy}
            onChange={(event) => onName(event.target.value)}
          />
        </div>
        <div className="studio-actions">
          <Button variant="outline" disabled={busy} onClick={onSave}>
            <Save />
            {t("workflowStudio.saveDraft")}
          </Button>
          <Button disabled={busy} onClick={onPublish}>
            <Check />
            {t("studio.publish")}
          </Button>
        </div>
      </div>
      <p className="studio-description">
        {definition.description || t("studio.defaultDescription")}
      </p>
      <div className="studio-review-grid">
        <section className="studio-flow">
          <div className="studio-section-title">
            <h3>{t("studio.flow")}</h3>
            <Button size="xs" variant="ghost" disabled={busy} onClick={onEdit}>
              <SlidersHorizontal />
              {t("studio.details")}
            </Button>
          </div>
          <p className="studio-section-hint">{t("studio.flowHint")}</p>
          <div className="studio-steps">
            {definition.nodes.map((node) => {
              const human = node.kind === "human";
              const Icon = human
                ? UserRound
                : node.kind === "end"
                  ? Check
                  : Bot;
              const outgoing = definition.edges.filter(
                (edge) => edge.from === node.id,
              );
              return (
                <div className="studio-step-wrap" key={node.id}>
                  <div className={`studio-step ${human ? "is-human" : ""}`}>
                    <div className="studio-step-icon">
                      <Icon />
                    </div>
                    <div className="studio-step-content">
                      <div className="studio-step-title">
                        <strong>{node.label}</strong>
                        <span>
                          {t(
                            human
                              ? "studio.human"
                              : node.kind === "end"
                                ? "studio.done"
                                : "studio.agentStep",
                          )}
                        </span>
                      </div>
                      <p>
                        {node.instructions ||
                          t(`canvas.nodeKinds.${node.kind}`)}
                      </p>
                      {node.outputs.length > 0 && (
                        <div className="studio-output-tags">
                          {node.outputs.map((role) => (
                            <span key={role}>
                              <FileText />
                              {definition.artifacts.find(
                                (artifact) => artifact.role === role,
                              )?.label || role}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {outgoing.length > 0 && (
                    <div className="studio-transition">
                      <ArrowDown />
                      <span>
                        {outgoing
                          .map(
                            (edge) =>
                              `${t(`canvas.events.${edge.on}`, { defaultValue: edge.on })} → ${definition.nodes.find((next) => next.id === edge.to)?.label || edge.to}`,
                          )
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
        <aside className="studio-responsibilities">
          <div className="studio-human-note">
            <UserRound />
            <h3>{t("studio.yourPart")}</h3>
            <p>
              {t(
                approvals.length ? "studio.approvalHint" : "studio.noApproval",
              )}
            </p>
            {approvals.map((node) => (
              <div key={node.id}>
                <Check />
                {node.label}
              </div>
            ))}
          </div>
          <div className="studio-artifact-note">
            <FileText />
            <h3>{t("studio.deliverables")}</h3>
            {definition.artifacts.length ? (
              definition.artifacts.map((artifact) => (
                <p key={artifact.role}>{artifact.label}</p>
              ))
            ) : (
              <p>{t("workflowStudio.noDocuments")}</p>
            )}
          </div>
          {(definition.requirements?.length ?? 0) > 0 && (
            <div className="studio-artifact-note">
              <PackageCheck />
              <h3>{t("studio.requirements")}</h3>
              <p>{t("studio.requirementsHint")}</p>
              {definition.requirements?.map((requirement) => (
                <p key={`${requirement.kind}:${requirement.id}`}>
                  {requirement.label} · {t(`studio.requirementLevels.${requirement.level}`)}
                </p>
              ))}
            </div>
          )}
        </aside>
      </div>
      {composer}
      <p className="studio-publish-hint">{t("studio.publishHint")}</p>
    </div>
  );
}
