export const GOAL_WORKFLOW = "goal-main";
export interface GoalBatchItem { workId: string; outcome: "queued" | "already-queued" | "skipped"; reason: string }
export interface GoalTask {
  id: string; title: string; objective: string; scope: string[]; dependsOn: string[];
}
export interface GoalState {
  workId: string; parentId: string | null; objective: string;
  status: "ready" | "running" | "paused" | "cancelled" | "completed" | "waiting-quota";
  phase: "plan" | "work" | "wait" | "verify";
  maxParallel: number; iteration: number; runId: string | null; nextRetryAt: string | null;
  lastError: string; evidence: string; scope: string[]; tasks: GoalTask[];
}
