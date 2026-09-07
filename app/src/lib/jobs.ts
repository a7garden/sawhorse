// 중복 실행 방지 — 버튼 하나에 실행 하나.
//
// 호스트는 잡마다 "무엇을 대상으로 무엇을 하는가"를 나타내는 키(Job.dedupKey)를 붙이고,
// 같은 키의 잡이 대기·실행 중이면 새 요청을 받지 않는다(jobs.rs 의 dedup_key). 화면은
// 같은 키로 진행 중인 잡을 찾아 버튼을 "실행 중"으로 바꾸고, 다시 누르면 중단시킨다.
//
// 작업 정의·예약처럼 실행 경로가 여러 갈래인 것은 호스트가 계산한 키를 그대로 받아 쓴다
// (TaskRow.jobKey · ScheduleView.jobKey). 여기서 직접 만드는 것은 화면이 인자를 다 아는
// 팩 액션과 단순 잡뿐이다.
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

/** 팩 액션 버튼의 키. `run_pack_action` 이 만드는 요청과 같은 모양이어야 한다. */
export function actionJobKey(
  packId: string,
  actionId: string,
  params: Record<string, unknown> = {},
  projectId?: string | null,
): string {
  // 확장 팩(x-)은 호스트가 활성 프로젝트를 파라미터로 넣어 준다.
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

/** `enqueueJob` 으로 바로 던지는 잡의 키. */
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

/** 이 키로 지금 돌고 있는 잡. 없으면 null. */
export function activeJob(
  jobs: Job[],
  jobKey: string | null | undefined,
): Job | null {
  if (!jobKey) return null;
  return jobs.find((job) => job.dedupKey === jobKey && isActive(job)) ?? null;
}
