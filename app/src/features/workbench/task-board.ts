import { isLifecycleV2 } from "./lifecycle-v2";
import { currentNode, isFinalWorkNode } from "./lifecycle";
import type { WorkItem, WorkflowDefinition } from "./types";

export const taskStages = ["clarify", "design", "approval", "queued", "build", "unconfirmed", "done"] as const;
export type TaskStage = typeof taskStages[number] | "discarding" | "other";
export type WorkArea = "flow" | "inbox" | "archive" | "mockups";
export const workflowKey = (workflow: { id: string; version: string }) => JSON.stringify([workflow.id, workflow.version]);
export const workWorkflowKey = (work: Pick<WorkItem, "workflowId" | "workflowVersion">) => workflowKey({ id: work.workflowId, version: work.workflowVersion });
export const usesLifecycleBoard = (workflow?: WorkflowDefinition) => !workflow || (workflow.id === "intent-flow" && ["2.0.0", "2.0.1"].includes(workflow.version));

/** Keep child execution inside its parent stage and retain unknown stages for old revisions. */
export function workflowBoardStage(work: WorkItem, workflow: WorkflowDefinition): string {
  if (work.status === "done") return "done";
  const active = work.activeNodes?.find((node) => node.workflowId === workflow.id && node.workflowVersion === workflow.version);
  return active?.nodeId ?? work.stage;
}

export function workflowBoardLanes(workflow: WorkflowDefinition, work: WorkItem[]) {
  const lanes = workflow.nodes.map((node) => ({ id: node.id, label: node.label, kind: node.kind }));
  for (const item of work) {
    const id = workflowBoardStage(item, workflow);
    if (!lanes.some((lane) => lane.id === id)) lanes.push({ id, label: id, kind: id === "done" ? "end" : "agent" });
  }
  return lanes;
}
export const isMockupWork = (work: WorkItem) => work.workflowId === "mockup-review" || work.artifacts.includes("mockup");
export const isArchivedWork = (work: WorkItem) => ["cancelled", "rejected"].includes(work.status) || ["cancelled", "discarded"].includes(work.stage);
export function isTaskRecord(work: WorkItem) {
  if (isMockupWork(work)) return false;
  if (isLifecycleV2(work)) {
    if (work.stage === "inbox") return false;
    if (work.stage === "cancelled") return work.decisions.some((d) => [...taskStages, "discarding"].includes(d.stage));
  }
  return !(work.workflowId === "sdd-main" && currentNode(work) === "intent");
}
export function isInboxIntent(work: WorkItem) {
  if (isArchivedWork(work) || work.status === "done" || isMockupWork(work)) return false;
  if (isLifecycleV2(work)) return work.stage === "inbox";
  return work.workflowId === "sdd-main" && currentNode(work) === "intent";
}
export function workArea(work: WorkItem): WorkArea {
  if (isMockupWork(work)) return "mockups";
  if (isArchivedWork(work)) return "archive";
  if (isInboxIntent(work)) return "inbox";
  return "flow";
}

/** Display projection only. Never changes a pinned workflow, approval, or stored stage. */
export function taskStage(work: WorkItem, workflows: WorkflowDefinition[]): TaskStage {
  if (work.status === "done") return "done";
  if (isLifecycleV2(work)) return [...taskStages, "discarding"].includes(work.stage) ? work.stage as TaskStage : "other";
  const node = currentNode(work);
  const active = work.activeNodes?.[0];
  const workflow = workflows.find((w) => w.id === work.workflowId && w.version === work.workflowVersion);
  if (work.status === "review" && isFinalWorkNode(work, workflow)) return "unconfirmed";
  if (active?.workflowId === "tdd-cycle" || ["tdd-cycle", "goal-main"].includes(work.workflowId)) return "build";
  if (["sdd-main", "intent-flow"].includes(work.workflowId)) {
    if (node === "design") return work.status === "review" ? "approval" : "design";
    if (node === "build") return work.status === "ready" ? "queued" : "build";
    if (["test", "verify", "deploy", "release"].includes(node)) return "build";
  }
  // Extension stages without a known lifecycle meaning remain explicitly identified.
  return "other";
}
