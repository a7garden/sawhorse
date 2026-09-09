import { isSelectableWorkflow } from "./workflow-version";
import type { Project, WorkflowDefinition, WorkflowRef } from "./types";

type WorkflowProject = Pick<Project, "workflowId" | "workflowVersion" | "additionalWorkflows">;

/** Old projects enable only their default; exact revisions never auto-upgrade. */
export function projectWorkflowRefs(project?: WorkflowProject): WorkflowRef[] {
  if (!project) return [];
  const references = [{ id: project.workflowId, version: project.workflowVersion }, ...(project.additionalWorkflows ?? [])];
  return references.filter((reference, index) => isSelectableWorkflow(reference.id) && references.findIndex((item) => item.id === reference.id && item.version === reference.version) === index);
}

export function creationWorkflow(catalog: WorkflowDefinition[], project?: WorkflowProject, selected?: WorkflowRef) {
  const reference = selected ?? (project && { id: project.workflowId, version: project.workflowVersion });
  if (!reference || !projectWorkflowRefs(project).some((item) => item.id === reference.id && item.version === reference.version)) return undefined;
  return catalog.find((workflow) => workflow.id === reference.id && workflow.version === reference.version);
}

/** The initial input is defined by the entry node, not by a universal SDD intent. */
export function workflowIntake(workflow: WorkflowDefinition) {
  const entry = workflow.nodes.find((node) => node.id === workflow.entry);
  const role = entry?.artifactRole ?? entry?.inputs.find((input) => workflow.artifacts.some((artifact) => artifact.role === input));
  const artifact = workflow.artifacts.find((item) => item.role === role);
  const composer = workflow.id === "intent-flow" && ["2.0.0", "2.0.1"].includes(workflow.version) ? "intent"
    : workflow.id === "goal-main" && ["1.0.0", "1.0.1"].includes(workflow.version) ? "goal" : "generic";
  return { composer, artifact, entry };
}
