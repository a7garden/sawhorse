import type { WorkItem } from "./types";
export const isLifecycleV2 = (work: Pick<WorkItem, "workflowId" | "workflowVersion">) => work.workflowId === "intent-flow" && work.workflowVersion === "2.0.0";
export const lifecycleStages = ["inbox", "clarify", "design", "approval", "queued", "build", "unconfirmed", "done"];
export interface Interview { id: string; runId: string; stage: string; question: string; options: string[]; answer: string; answeredAt: string }
export interface LifecycleState {
  revision: number; clarified: boolean; queued: boolean; error: string; scope: string[];
  interviews: Interview[]; commits: string[]; revertCommits: string[]; runId: string;
  runRepo: string; baseCommit: string; processed: string[]; approvedInputs: string[];
  integrationPending: boolean; messages: Array<{ from: string; to: string; text: string; at: string }>;
}
export const emptyLifecycle = (): LifecycleState => ({ revision: 0, clarified: false, queued: false, error: "", scope: [], interviews: [], commits: [], revertCommits: [], runId: "", runRepo: "", baseCommit: "", processed: [], approvedInputs: [], integrationPending: false, messages: [] });
export interface ResourceDocument { id: string; kind: "template" | "design"; title: string; markdown: string; source: string; revision: string }
export interface ResourceAssignment { designId: string; templates: Record<string, string> }
