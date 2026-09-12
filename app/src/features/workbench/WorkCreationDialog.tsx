import { WorkTypeField } from "./WorkTypeField";
import { useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { sddApi } from "./api";
import { GoalComposer } from "./GoalPanel";
import { IntentComposer } from "./IntentComposer";
import { creationWorkflow, projectWorkflowRefs, workflowIntake } from "./workflow-creation";
import type { Document, Project, WorkItem, WorkflowDefinition } from "./types";

export function WorkCreationDialog({ initial, workflows, projects, onClose, onSaved }: {
  initial: WorkItem; workflows: WorkflowDefinition[]; projects: Project[];
  onClose: () => void; onSaved: (item: WorkItem, artifact?: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const initialProject = projects.find((item) => item.id === initial.projectId) ?? (projects.length === 1 ? projects[0] : undefined);
  const [projectId, setProjectId] = useState(initialProject?.id ?? "");
  const [selected, setSelected] = useState(() => {
    const requested = { id: initial.workflowId, version: initial.workflowVersion };
    return creationWorkflow(workflows, initialProject, requested) ? requested
      : { id: initialProject?.workflowId ?? "", version: initialProject?.workflowVersion ?? "" };
  });
  // Freeze the selected contract while composing. A settings refresh must not
  // unmount an in-progress form; the host validates availability on submission.
  const [confirmed, setConfirmed] = useState<{ project: Project; workflow: WorkflowDefinition } | undefined>(() => {
    const workflow = creationWorkflow(workflows, initialProject);
    return initialProject && workflow && projectWorkflowRefs(initialProject).length === 1 ? { project: initialProject, workflow } : undefined;
  });
  const project = projects.find((item) => item.id === projectId);
  const references = projectWorkflowRefs(project);
  const workflow = creationWorkflow(workflows, project, selected);
  if (confirmed) {
    const { project: chosenProject, workflow: chosenWorkflow } = confirmed;
    const intake = workflowIntake(chosenWorkflow);
    const seed = { ...initial, projectId: chosenProject.id, workflowId: chosenWorkflow.id, workflowVersion: chosenWorkflow.version, stage: chosenWorkflow.entry };
    if (intake.composer === "intent") return <IntentComposer initial={seed} projects={[chosenProject]} onClose={onClose} onSaved={(item) => onSaved(item, "intent")} />;
    if (intake.composer === "goal") return <GoalComposer initial={seed} projects={[chosenProject]} onClose={onClose} onSaved={(item) => onSaved(item, "evidence")} />;
    return <WorkflowInputComposer initial={seed} workflow={chosenWorkflow} projects={[chosenProject]} onClose={onClose} onSaved={onSaved} />;
  }
  return <Dialog open title={t("creation.newItem")} onClose={onClose}>
    <div className="wb-form">
      <p className="wb-field is-wide">{t("creation.chooseHint")}</p>
      <label className="wb-field is-wide">{t("form.project")}
        <Select aria-label={t("form.project")} value={projectId} onChange={(id) => {
          setProjectId(id);
          const next = projects.find((item) => item.id === id);
          setSelected({ id: next?.workflowId ?? "", version: next?.workflowVersion ?? "" });
        }} options={[{ value: "", label: t("intent.chooseProject") }, ...projects.map((item) => ({ value: item.id, label: item.name }))]} />
      </label>
      {project && <label className="wb-field is-wide">{t("creation.workflow")}
        <Select aria-label={t("creation.workflow")} value={JSON.stringify([selected.id, selected.version])}
          onChange={(value) => { const [id, version] = JSON.parse(value) as [string, string]; setSelected({ id, version }); }}
          options={references.map((reference) => {
            const definition = workflows.find((item) => item.id === reference.id && item.version === reference.version);
            return { value: JSON.stringify([reference.id, reference.version]), label: `${definition?.label ?? reference.id} · v${reference.version}` };
          })} />
        <small className="wb-muted">{t("creation.workflowHint")}</small>
      </label>}
      {workflow && <p className="wb-field is-wide">{workflow.description}</p>}
      {project && !workflow && <p className="wb-inline-error is-wide" role="alert">{t("creation.workflowUnavailable")}</p>}
      {!projects.length && <p className="wb-field is-wide">{t("creation.projectRequired")}</p>}
      <div className="wb-form-actions"><Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
        <Button disabled={!workflow || !project} onClick={() => { if (project && workflow) setConfirmed({ project, workflow }); }}>{t("creation.continue")}</Button></div>
    </div>
  </Dialog>;
}

function WorkflowInputComposer({ initial, workflow, projects, onClose, onSaved }: {
  initial: WorkItem; workflow: WorkflowDefinition; projects: Project[];
  onClose: () => void; onSaved: (item: WorkItem, artifact?: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const { artifact, entry } = workflowIntake(workflow);
  const unit = artifact ? (artifact.label === artifact.role ? t(`artifact.${artifact.role}`, { defaultValue: artifact.label }) : artifact.label) : t("creation.item");
  const [title, setTitle] = useState(initial.title);
  const [issueType, setIssueType] = useState(initial.issueType || "작업");
  const [markdown, setMarkdown] = useState(initial.description);
  const project = projects.find((item) => item.id === initial.projectId)!;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<WorkItem | null>(null);
  const id = useRef(`work-${crypto.randomUUID()}`);
  const submitting = useRef(false);
  const inputDocument = useRef<Document | null>(null);
  const close = () => { if (!busy && (saved || (!title.trim() && !markdown.trim()) || window.confirm(t("creation.discard")))) onClose(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || !title.trim() || !markdown.trim()) return;
    submitting.current = true; setBusy(true); setError("");
    let item = saved;
    try {
      if (!item) {
        item = await sddApi.saveWork({ ...initial, issueType, id: id.current, title: title.trim(), description: markdown,
          projectId: project.id, workflowId: workflow.id, workflowVersion: workflow.version, stage: workflow.entry });
        setSaved(item);
      }
      if (artifact) {
        // Retain the expected revision when retrying; never overwrite a concurrent edit.
        inputDocument.current ??= await sddApi.readDocument(item.id, artifact.role);
        await sddApi.writeDocument(item.id, artifact.role, markdown, inputDocument.current.revision);
      }
      onSaved(item, artifact?.role);
    } catch (error) {
      setError(`${item ? t("creation.savedInputFailed") + " " : ""}${error instanceof Error ? error.message : String(error)}`);
    } finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog open wide title={t("creation.newUnit", { unit })} onClose={close}>
    <form className="wb-form" onSubmit={(event) => void submit(event)}>
      <p className="wb-field is-wide">{t("creation.route", { workflow: workflow.label, stage: entry?.label ?? workflow.entry })}</p>
      <WorkTypeField value={issueType} onChange={setIssueType} disabled={busy || !!saved} empty={!markdown.trim()} onTemplate={setMarkdown} />
      <label className="wb-field is-wide">{t("form.workName")}<Input autoFocus value={title} disabled={busy || !!saved} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="wb-field is-wide">{unit}<textarea aria-label={unit} rows={9} value={markdown} disabled={busy || !!saved}
        placeholder={t("creation.inputHint", { unit })} onChange={(event) => setMarkdown(event.target.value)} /></label>
      <p className="wb-field is-wide">{t("form.project")}: {project.name}</p>
      {error && <p className="wb-inline-error is-wide" role="alert">{error}</p>}
      <div className="wb-form-actions">
        {saved && <Button type="button" variant="outline" disabled={busy} onClick={() => onSaved(saved, artifact?.role)}>{t("creation.openSaved")}</Button>}
        <Button type="button" variant="ghost" disabled={busy} onClick={close}>{t("common.cancel")}</Button>
        <Button type="submit" disabled={busy || !title.trim() || !markdown.trim()}>{t(saved ? "common.retry" : "creation.create")}</Button>
      </div>
    </form>
  </Dialog>;
}
