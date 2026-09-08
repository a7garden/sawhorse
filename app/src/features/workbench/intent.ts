import { isLifecycleV2 } from "./lifecycle-v2";
import { sddApi } from "./api";
import type { Project, WorkItem } from "./types";
export const INTENT_WORKFLOW = "intent-flow";
export interface IntentAttachment { name: string; dataUrl: string; reference?: string }
export const intentTitle = (markdown: string, fallback: string) =>
  markdown.split("\n").filter((line) => !/^\s*!\[/.test(line)).map((line) => line.replace(/^\s*[#>*-]+\s*/, "").trim()).find(Boolean)?.slice(0, 80) || fallback;

export async function launchIntent(work: WorkItem, project: Project, instructions = "") {
  const current = (await sddApi.snapshot()).work.find((item) => item.id === work.id);
  if (!current || current.stage !== work.stage || current.projectId !== project.id)
    throw new Error("The work changed. Refresh before starting the agent.");
  work = current;
  if (isLifecycleV2(work) && work.stage === "inbox") {
    const state = await sddApi.lifecycle(work.id);
    work = await sddApi.lifecycleAction({ workId: work.id, action: "clarify", expectedStage: work.stage, revision: state.revision, note: "의도 구체화 시작", inputDigest: "" });
  }
  return sddApi.launch({ workId: work.id, projectId: project.id,
    role: ["build", "discarding"].includes(work.stage) ? "implementer" : "planner",
    agent: project.defaultAgent, model: project.defaultModel,
    instructions: instructions || (work.stage === "build" ? "승인된 작업 단위를 모두 구현하고 검증까지 마무리하세요." : "현재 단계의 산출물을 작성하고 필요한 결정은 앱 인터뷰로 질문하세요. 단계별 완료 요청을 제출하세요."),
    parentRunId: null });
}
