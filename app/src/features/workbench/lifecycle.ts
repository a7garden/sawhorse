import { isClosedStatus, type WorkItem, type WorkflowDefinition } from "./types";

export const currentNode = (work: WorkItem) => work.activeNodes?.[0]?.nodeId ?? work.stage;

export function isFinalWorkNode(work: WorkItem, workflow?: WorkflowDefinition) {
  if (!workflow) return false;
  const active = work.activeNodes?.[0];
  if (active && (active.workflowId !== work.workflowId || active.workflowVersion !== work.workflowVersion)) return false;
  const nodeId = currentNode(work);
  return workflow.nodes.some((node) => node.id === nodeId) &&
    !workflow.edges.some((edge) => edge.from === nodeId && edge.on !== "revise" && !edge.loopRef);
}

/** These actions change the work lifecycle; agent run signals never do. */
export function workActions(work: WorkItem, workflow?: WorkflowDefinition): string[] {
  if (isClosedStatus(work.status)) return [];
  if (work.status === "blocked") return ["resume", "cancel"];
  if (work.status === "backlog") return ["accept", "start", "reject"];
  if (work.status === "ready") return ["start", "cancel"];
  if (work.status === "review") return isFinalWorkNode(work, workflow)
    ? ["complete", "revise", "cancel"] : ["resume", "cancel"];
  return [...(isFinalWorkNode(work, workflow) ? ["submit"] : []), "pause", "cancel"];
}
