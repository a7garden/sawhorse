import i18n from "@/i18n";
import type {
  WorkflowDefinition,
  WorkflowNode,
} from "@/features/workbench/types";

// Explicit sample for the browser tour. Desktop generation always uses the agent.
export function previewDraft(
  request: string,
  current: WorkflowDefinition | null,
): WorkflowDefinition {
  if (current)
    return {
      ...structuredClone(current),
      description: `${current.description}\n\n${request}`,
    };
  const ko = i18n.language.startsWith("ko");
  const labels = ko
    ? ["요청 정리와 설계", "설계 확인", "작업 수행과 검증", "결과 확인", "완료"]
    : [
        "Clarify & design",
        "Review the design",
        "Execute & verify",
        "Review the result",
        "Complete",
      ];
  const instructions = ko
    ? [
        "원하는 결과와 성공 기준을 정리하고 실행 계획을 준비합니다.",
        "진행 방향과 범위를 확인합니다. 승인하면 다음 단계로 진행합니다.",
        "승인된 계획을 수행하고 검증 근거를 남깁니다.",
        "결과와 검증 근거를 확인하고 완료 여부를 판단합니다.",
        "확인한 결과와 문서를 남기고 작업을 마칩니다.",
      ]
    : [
        "Clarify the outcome and success criteria, then prepare a plan.",
        "Review the direction and scope before moving on.",
        "Carry out the approved plan and record verification evidence.",
        "Review the result and evidence before accepting the work.",
        "Keep the reviewed results and finish the work.",
      ];
  const ids = ["design", "review-design", "execute", "review-result", "done"];
  const nodes: WorkflowNode[] = ids.map((id, index) => ({
    id,
    label: labels[index],
    kind: index === 4 ? "end" : index % 2 ? "human" : "agent",
    artifactRole: null,
    actionRef: index % 2 || index === 4 ? null : id,
    workflowRef: null,
    decision: index % 2 ? "approval" : null,
    inputs: index === 0 ? [] : [index < 3 ? "plan" : "result"],
    outputs: index === 0 ? ["plan"] : index === 2 ? ["result"] : [],
    allowedRoles:
      index === 0
        ? ["planner"]
        : index === 2
          ? ["implementer", "verifier"]
          : [],
    instructions: instructions[index],
    requiresCompletedDependencies: true,
  }));
  return {
    definitionVersion: 1,
    id: `workflow-${crypto.randomUUID()}`,
    label: ko ? "나의 워크플로" : "My workflow",
    description: request,
    version: "1.0.0",
    entry: ids[0],
    nodes,
    edges: ids
      .slice(0, -1)
      .map((id, index) => ({
        from: id,
        to: ids[index + 1],
        on: index % 2 ? "approved" : "completed",
        condition: null,
        loopRef: null,
      })),
    artifacts: ["plan", "result"].map((role, index) => ({
      role,
      label: ko
        ? ["실행 계획", "결과와 검증 근거"][index]
        : ["Execution plan", "Results & evidence"][index],
      path: `work/{workId}/${role}.md`,
      template: `# ${role}\n`,
    })),
    loops: [],
  };
}
