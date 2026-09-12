// Dedup for runs — one run per button.
//
// The host attaches a key (Job.dedupKey) to each job expressing "what runs against what target";
// a new request with the same key is rejected while a job with that key is queued or running
// (dedup_key in jobs.rs). The UI finds the in-progress job by key, flips the button to
// "실행 중" (running), and pressing it again aborts the job.
//
// Execution paths with multiple entry routes, like task definitions and schedules, reuse
// the host-computed key (TaskRow.jobKey · ScheduleView.jobKey). Only pack actions, where the
// UI knows all the params, and simple jobs compose keys here.
import type { Job, JobRequest } from "./types";

function text(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : "";
}

function idList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function compose(
  kind: string,
  target: string,
  project: string,
  ids: string[],
): string {
  return `${kind}|${target}|${project}|${[...new Set(ids)].sort().join(",")}`;
}

/** Key for a pack action button. Must match the request built by `run_pack_action`. */
export function actionJobKey(
  packId: string,
  actionId: string,
  params: Record<string, unknown> = {},
  projectId?: string | null,
): string {
  // Extension packs (x-) get the active project as a host-provided param.
  const project =
    text(params.project) ||
    text(params.projectId) ||
    (packId.startsWith("x-") ? text(projectId) : "");
  return compose(
    "action",
    `${packId}.${actionId}`,
    project,
    idList(params.ids),
  );
}

/** Key for jobs thrown straight via `enqueueJob`. */
export function jobRequestKey(req: JobRequest): string {
  const target =
    req.kind === "action"
      ? `${req.packId ?? ""}.${req.actionId ?? ""}`
      : req.kind === "task"
        ? (req.taskId ?? "")
        : req.kind === "routine"
          ? (req.routine ?? "")
          : "";
  const params = req.params ?? {};
  const project =
    text(req.project) || text(params.project) || text(params.projectId);
  const ids = req.ids?.length ? req.ids : idList(params.ids);
  return compose(req.kind, target, project, ids);
}

export function isActive(job: Job): boolean {
  return job.status === "queued" || job.status === "running";
}

/** The job currently running with this key. null if none. */
export function activeJob(
  jobs: Job[],
  jobKey: string | null | undefined,
): Job | null {
  if (!jobKey) return null;
  return jobs.find((job) => job.dedupKey === jobKey && isActive(job)) ?? null;
}
