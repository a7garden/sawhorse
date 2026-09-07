import { sddApi, workflowApi } from "./api";
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
  if (work.status === "backlog" || work.status === "ready") {
    await workflowApi.command({ workId: work.id, event: "work:start", expectedNodeId: work.stage,
      note: "의도를 바탕으로 에이전트 작업 시작", eventId: crypto.randomUUID(), facts: { expectedStatus: work.status } });
  }
  return sddApi.launch({ workId: work.id, projectId: project.id,
    role: work.stage === "build" ? "implementer" : "planner",
    agent: project.defaultAgent === "codex" ? "codex" : "claude", model: project.defaultModel,
    instructions: instructions || (work.stage === "build" ? "승인된 작업 단위를 모두 구현하고 검증까지 마무리하세요." : "메모와 첨부 이미지를 읽고 설계와 작업 단위를 준비하세요. 구현은 사람의 승인 뒤에 시작합니다."),
    parentRunId: null });
}
