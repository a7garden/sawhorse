import { isSelectableWorkflow } from "./workflow-version";
import type { GoalState } from "./goals";
import { projectWorkflowRefs } from "./workflow-creation";
import bundledDefinitions from "./samples/workflows.json";
import { isLifecycleV2, lifecycleStages, emptyLifecycle, type LifecycleState, type ResourceDocument, type ResourceAssignment } from "./lifecycle-v2";
// Opt-in browser tour only. Failed desktop IPC never falls back to this store.
import i18n from "@/i18n";
import { demoHtml, mockupDemo } from "@/features/mockups/preview";
import mockupWorkflow from "../../../../plugin/extension-packages/ui-mockup/workflows/mockup-review.json";
import type { Mockup } from "@/features/mockups/types";
import { isFinalWorkNode, workActions } from "./lifecycle";
import {
  ARTIFACTS,
  isClosedStatus,
  type Document,
  type WorkItem,
  type WorkspaceSnapshot,
  type WorkflowDefinition,
  type WorkflowDraftRecord,
  type HarnessRun,
  type IntentCheckpoint,
} from "./types";
const KEY = "sawhorse.workflow.preview.v2";
const now = () => new Date().toISOString();
const previewWorkflows = bundledDefinitions as WorkflowDefinition[];
const intentWorkflowV2 = previewWorkflows.find((item) => item.id === "intent-flow" && item.version === "2.0.0")!;
const date = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function work(
  id: string,
  title: string,
  stage: WorkItem["stage"],
  status: WorkItem["status"],
  projectId: string,
  offset: number,
): WorkItem {
  return {
    id,
    title,
    description:
      "문제와 원하는 결과를 정의하고, 근거를 남기며 다음 단계로 이어갑니다.",
    projectId,
    stage,
    status: stage !== "intent" && ["backlog", "ready", "review"].includes(status) ? "running" : status,
    priority: offset < 2 ? "high" : "normal",
    owner: "나",
    startDate: date(-2),
    dueDate: date(offset),
    dependsOn: [],
    tags: ["제품"],
    createdAt: now(),
    updatedAt: now(),
    decisions: [],
    artifacts: [...ARTIFACTS],
    workflowId: "sdd-main",
    workflowVersion: "1.1.0",
    workflowDigest: "preview-sdd-main-1.1.0",
    workflowInstanceId: null,
    activeNodes: [],
    issueType: offset < 2 ? "기능" : "작업",
    executionType: offset === 1 ? "문서" : "코드",
    labels: [],
    assignees: [],
    milestone: "",
    approvalRequired: true,
    approve: status === "running" || status === "done",
    approved: status === "running" || status === "done" ? date(-1) : "",
    state: isClosedStatus(status) ? "closed" : "open",
    closed: status === "done" ? date(-1) : "",
    githubRepo: "",
    githubNumber: "",
    githubUrl: "",
    githubState: "",
    githubUpdated: "",
  };
}
const seed: WorkspaceSnapshot = {
  schemaVersion: 1,
  initialized: true,
  vaultPath: "브라우저 체험 작업공간",
  diagnostics: [],
  workflows: previewWorkflows,
  projects: [
    {
      id: "sawhorse",
      name: "Sawhorse",
      description: "의도를 실행과 기록으로 연결하는 개발 작업대",
      repoPath: "/projects/sawhorse",
      extraPaths: ["/projects/sawhorse-docs"],
      githubRepos: ["a7garden/sawhorse"],
      dependsOn: [],
      verifyCommands: ["npm run build", "cargo test"],
      defaultAgent: "codex",
      defaultModel: "",
      workflowId: "sdd-main",
      workflowVersion: "1.1.0",
      workflowDigest: "preview-sdd-main-1.1.0",
    },
    {
      id: "herdr",
      name: "Herdr",
      description: "지속되는 에이전트 터미널과 오케스트레이션",
      repoPath: "/projects/herdr",
      extraPaths: [],
      githubRepos: [],
      dependsOn: [],
      verifyCommands: ["cargo test"],
      defaultAgent: "codex",
      defaultModel: "",
      workflowId: "sdd-main",
      workflowVersion: "1.1.0",
      workflowDigest: "preview-sdd-main-1.1.0",
    },
    {
      id: "knowledge",
      name: "Knowledge",
      description: "프로젝트 간에 연결되는 마크다운 지식",
      repoPath: "/projects/knowledge",
      extraPaths: [],
      dependsOn: ["sawhorse"],
      verifyCommands: ["npm test"],
      githubRepos: [],
      defaultAgent: "claude",
      defaultModel: "",
      workflowId: "sdd-main",
      workflowVersion: "1.1.0",
      workflowDigest: "preview-sdd-main-1.1.0",
    },
  ],
  work: [
    work(
      "work-intent",
      "의도에서 시작하는 개발 흐름",
      "design",
      "review",
      "sawhorse",
      1,
    ),
    work(
      "work-harness",
      "Herdr 실행과 기록 연결",
      "build",
      "running",
      "herdr",
      3,
    ),
    work(
      "work-editor",
      "마크다운 라이브 편집기",
      "test",
      "ready",
      "sawhorse",
      4,
    ),
    work(
      "work-search",
      "프로젝트를 넘나드는 지식 검색",
      "intent",
      "backlog",
      "knowledge",
      7,
    ),
    work(
      "work-calendar",
      "마일스톤과 개발 일정 연결",
      "intent",
      "backlog",
      "sawhorse",
      5,
    ),
    work(
      "work-session",
      "세션 재시작 복구 검증",
      "test",
      "blocked",
      "herdr",
      -1,
    ),
    work(
      "work-release",
      "첫 작업대 배포 기록",
      "deploy",
      "done",
      "sawhorse",
      -2,
    ),
  ],
  events: [
    {
      id: "event-review",
      title: "SDD 명세 검토",
      date: date(1),
      endDate: null,
      kind: "review",
      projectId: "sawhorse",
      workId: "work-intent",
      notes: "수용 기준과 프로젝트 의존성 확인",
    },
    {
      id: "event-release",
      title: "작업대 마일스톤",
      date: date(5),
      endDate: null,
      kind: "milestone",
      projectId: "sawhorse",
      workId: null,
      notes: "문서 · 백로그 · 실행 · 검증 연결",
    },
  ],
};
type Store = {
  goalSources?: Record<string, WorkItem>;
  goals?: Record<string, GoalState>;
  lifecycle?: Record<string, LifecycleState>;
  resources?: ResourceDocument[];
  resourceAssignments?: Record<string, ResourceAssignment>;
  mockups?: Record<string, { manifest: Mockup; html: Record<string, string> }>;
  snapshot: WorkspaceSnapshot;
  documents: Record<string, Document>;
  drafts?: WorkflowDraftRecord[];
  /** Optional historical fixtures for the browser tour; execution stays desktop-only. */
  runs?: HarnessRun[];
  history?: Record<string, Array<IntentCheckpoint & { documents: Document[] }>>;
  approvals?: Record<string, string[]>;
};
function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Store;
      if (p.snapshot?.schemaVersion === 1) {
        for (const definition of previewWorkflows) {
          if (!p.snapshot.workflows.some((item) => item.id === definition.id && item.version === definition.version))
            p.snapshot.workflows.push(structuredClone(definition));
        }
        for (const project of p.snapshot.projects) {
          if (!isSelectableWorkflow(project.workflowId)) {
            project.workflowId = "sdd-main"; project.workflowVersion = "1.1.1"; project.workflowDigest = "";
          }
          project.additionalWorkflows = (project.additionalWorkflows ?? []).filter((reference) => isSelectableWorkflow(reference.id));
        }
        return p;
      }
    }
  } catch {
    /* disposable tour */
  }
  const snapshot = structuredClone(seed);
  const documents: Record<string, Document> = {};
  if (new URLSearchParams(window.location.search).get("mockups") === "1") {
    snapshot.workflows.push(mockupWorkflow as WorkflowDefinition);
    for (const id of ["mockup-demo", "mockup-v1"]) {
      snapshot.work.unshift({ ...work(id, id === "mockup-demo" ? mockupDemo.title : "작업 검토 경험 개선 · 첫 개정", "review", "review", "sawhorse", 0), status: "review", workflowId: "mockup-review", workflowVersion: "1.1.0", workflowDigest: "", artifacts: mockupWorkflow.artifacts.map((artifact) => artifact.role), dueDate: null, priority: "normal" });
      for (const artifact of mockupWorkflow.artifacts) documents[`${id}/${artifact.role}`] = { workId: id, artifact: artifact.role, path: `work/${id}/${artifact.role}.md`, markdown: artifact.template, revision: "0" };
    }
    localStorage.setItem(KEY, JSON.stringify({ snapshot, documents }));
  }
  if (new URLSearchParams(window.location.search).get("lifecycle") === "1") {
    const lifecycle: Record<string, LifecycleState> = {};
    for (const stage of lifecycleStages) {
      const item = { ...work(`lifecycle-${stage}`, i18n.t(`workbench:lifecycle.stages.${stage}`), stage, stage === "done" ? "done" : ["approval", "unconfirmed"].includes(stage) ? "review" : "ready", "sawhorse", 0), workflowId: "intent-flow", workflowVersion: "2.0.0", workflowDigest: "", status: stage === "done" ? "done" as const : ["approval", "unconfirmed"].includes(stage) ? "review" as const : stage === "inbox" ? "backlog" as const : "ready" as const, artifacts: intentWorkflowV2.artifacts.map((a) => a.role), activeNodes: [] };
      snapshot.work.unshift(item);
      lifecycle[item.id] = { ...emptyLifecycle(), clarified: stage !== "inbox", scope: ["src/search.ts"], commits: ["unconfirmed", "done"].includes(stage) ? ["a".repeat(40)] : [] };
      for (const artifact of intentWorkflowV2.artifacts) documents[`${item.id}/${artifact.role}`] = { workId: item.id, artifact: artifact.role, path: `work/${item.id}/${artifact.role}.md`, markdown: `# ${artifact.role}\n\n검색 필터를 저장하고 다음 방문에 복원합니다. 테스트: 필터 저장·복원 확인.`, revision: "1" };
      if (stage === "clarify") lifecycle[item.id].interviews = [{ id: "audience", runId: "demo", stage, question: "필터 설정을 어디에 저장할까요?", options: ["이 기기에만", "계정에 동기화"], answer: "", answeredAt: "" }];
    }
    const result = { snapshot, documents, lifecycle }; localStorage.setItem(KEY, JSON.stringify(result)); return result;
  }
  return { snapshot, documents };
}
let state = load();
const save = () => {
  for (const work of state.snapshot.work) {
    work.state = isClosedStatus(work.status) ? "closed" : "open";
    work.closed = work.state === "closed" ? work.closed || now().slice(0, 10) : "";
  }
  localStorage.setItem(KEY, JSON.stringify(state));
};
function substantive(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/<!--[\s\S]*?-->/g, "")
    .split("\n").some((line) => line.trim() && !/^\s*(#|[-*] \[ \])/.test(line));
}
function doc(workId: string, artifact: string): Document {
  const key = `${workId}/${artifact}`;
  if (!state.documents[key]) {
    const w = state.snapshot.work.find((w) => w.id === workId);
    if (!w) throw new Error(i18n.t("workbench:errors.workNotFound"));
    state.documents[key] = {
      workId,
      artifact: artifact as Document["artifact"],
      path: `work/${workId}/${artifact}.md`,
      revision: "0",
      markdown: (artifact !== "intent" ? state.resources?.find((r) => r.id === state.resourceAssignments?.[w.projectId]?.templates[artifact])?.markdown : undefined) ?? (w.workflowId === "intent-flow" ? (artifact === "intent" ? "" : `# ${artifact}\n`) : `# ${w.title}\n\n## ${artifact === "intent" ? "문제" : "기록"}\n개발 의도, 코드 변경, 검증 근거가 떨어져 있어 맥락을 다시 찾는 시간이 듭니다.\n\n## 원하는 결과\n하나의 작업에서 문서를 편집하고 에이전트를 실행하며 실제 근거를 확인합니다.\n\n## 제약\n- 기록은 로컬 마크다운으로 남깁니다.\n- 프로젝트 의존성을 확인한 뒤 구현합니다.\n\n## 수용 기준\n- [ ] 문서와 실행 이력이 작업에 연결됩니다.\n- [ ] 검증 결과를 다음 단계에서 확인합니다.\n`),
    };
  }
  return structuredClone(state.documents[key]);
}
function checkpoint(work: WorkItem, event: string, note = "") {
  if (work.workflowId !== "intent-flow") return;
  state.history ??= {};
  state.history[work.id] ??= [];
  state.history[work.id].unshift({ id: crypto.randomUUID(), event, note, at: now(), stage: work.stage,
    documents: (isLifecycleV2(work) ? ["intent", "brief", "spec", "plan", "verification", "rollback"] : ["intent", "spec", "plan", "verification"]).map((role) => doc(work.id, role)) });
}
export async function previewInvoke(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  state = load();
  const s = state.snapshot;
  const id = String(args.id ?? "");
  const bindProjectWorkflow = (item: Pick<WorkItem, "projectId" | "workflowId" | "workflowVersion">) => {
    const project = s.projects.find((candidate) => candidate.id === item.projectId);
    if (!project) throw new Error(i18n.t("workbench:creation.projectRequired"));
    item.workflowId ||= project.workflowId;
    if (!item.workflowVersion && item.workflowId === project.workflowId) item.workflowVersion = project.workflowVersion;
    if (!isSelectableWorkflow(item.workflowId)) throw new Error(i18n.t("workbench:creation.retiredWorkflow"));
    if (!projectWorkflowRefs(project).some((reference) => reference.id === item.workflowId && reference.version === item.workflowVersion))
      throw new Error(i18n.t("workbench:creation.projectWorkflowChanged"));
    if (!s.workflows.some((definition) => definition.id === item.workflowId && definition.version === item.workflowVersion))
      throw new Error(i18n.t("workbench:creation.workflowUnavailable"));
  };
  switch (command) {
    case "goal_start_selected": {
      const ids = [...new Set(args.workIds as string[])];
      if (!ids.length || ids.length > 100) throw new Error("한 번에 1~100개 작업을 선택하세요");
      state.goals ??= {};
      state.goalSources ??= {};
      const results = ids.map((id) => {
        const item = s.work.find((w) => w.id === id);
        const goal = state.goals![id];
        const reason = !item ? "작업을 찾을 수 없습니다" : isClosedStatus(item.status) ? "완료하거나 취소한 작업입니다"
          : state.runs?.some((r) => r.workId === id && ["starting", "running", "blocked", "unknown"].includes(r.status)) ? "다른 에이전트가 실행 중인 작업입니다"
          : goal?.parentId ? "하위 작업은 부모 목표에서 관리합니다"
          : item.workflowId === "mockup-review" ? "목업 검토 항목은 작업 상세에서 진행하세요"
          : !goal && isLifecycleV2(item) && ["build", "unconfirmed", "discarding"].includes(item.stage) ? "이미 구현한 작업의 통합·결과 확인을 먼저 마쳐 주세요"
          : !s.projects.some((p) => p.id === item.projectId) ? "프로젝트가 필요합니다" : "";
        if (reason || !item) return { workId: id, outcome: "skipped", reason };
        if (goal && ["ready", "running", "waiting-quota"].includes(goal.status)) return { workId: id, outcome: "already-queued", reason: "" };
        if (!goal) {
          state.goalSources![id] = structuredClone(item);
          state.goals![id] = { workId: id, parentId: null, objective: `${item.title}\n\n${item.description}`, status: "paused", phase: "plan", maxParallel: 3, iteration: 0, runId: null, nextRetryAt: null, lastError: "", evidence: "", scope: ["."], tasks: [] };
          item.decisions.push({ stage: item.stage, at: now(), note: "선택한 작업을 골 모드로 전환하여 자율 실행" });
          item.workflowId = "goal-main"; item.workflowVersion = "1.0.0"; item.workflowDigest = "preview-goal";
          item.workflowInstanceId = null; item.activeNodes = []; item.artifacts = ["evidence"];
        }
        const current = state.goals![id];
        const members = [current, ...current.tasks.map((t) => state.goals![t.id])].filter(Boolean);
        if (members.some((g) => state.runs?.some((r) => r.workId === g.workId && ["starting", "running", "blocked", "unknown"].includes(r.status)))) return { workId: id, outcome: "skipped", reason: "실행 중단이 끝나면 목표를 재개할 수 있습니다" };
        for (const member of members) {
          if (["completed", "cancelled"].includes(member.status)) continue;
          member.status = "ready"; member.iteration++; member.runId = null;
          const w = s.work.find((w) => w.id === member.workId);
          if (w) { w.status = "ready"; w.stage = "pursue"; w.updatedAt = now(); }
        }
        return { workId: id, outcome: "queued", reason: "" };
      });
      save(); return results;
    }
    case "goal_create": {
      const input = args.input as { id: string; projectId: string; objective: string; maxParallel: number; start: boolean; workflowVersion?: string; issueType?: string };
      if (input.start) throw new Error(i18n.t("workbench:api.desktopOnly"));
      if (!input.objective.trim() || !s.projects.some((p) => p.id === input.projectId) || input.maxParallel < 1 || input.maxParallel > 16) throw new Error("Invalid goal");
      if (state.goals?.[input.id]) return structuredClone(s.work.find((w) => w.id === input.id));
      const project = s.projects.find((item) => item.id === input.projectId)!;
      const selection = { projectId: input.projectId, workflowId: "goal-main", workflowVersion: input.workflowVersion || (project.workflowId === "goal-main" ? project.workflowVersion : "") };
      if (!["1.0.0", "1.0.1"].includes(selection.workflowVersion)) throw new Error(i18n.t("workbench:creation.projectWorkflowChanged"));
      bindProjectWorkflow(selection);
      const item = { ...work(input.id, input.objective.split("\n")[0].slice(0, 100), "pursue", "blocked", input.projectId, 0), description: input.objective,
        issueType: input.issueType || "작업", workflowId: "goal-main", workflowVersion: selection.workflowVersion, workflowDigest: "", artifacts: ["evidence"], activeNodes: [] };
      s.work.push(item);
      state.goals ??= {};
      state.goals[item.id] = { workId: item.id, parentId: null, objective: input.objective, status: "paused", phase: "plan", maxParallel: input.maxParallel, iteration: 0, runId: null, nextRetryAt: null, lastError: "", evidence: "", scope: ["."], tasks: [] };
      save(); return structuredClone(item);
    }
    case "goal_state": {
      const goal = state.goals?.[String(args.workId)];
      if (!goal) throw new Error("Goal not found");
      return structuredClone([goal, ...goal.tasks.map((t) => state.goals![t.id])]);
    }
    case "goal_control": {
      if (args.action === "resume") throw new Error(i18n.t("workbench:api.desktopOnly"));
      const goal = state.goals?.[String(args.workId)];
      if (!goal) throw new Error("Goal not found");
      for (const id of [goal.workId, ...goal.tasks.map((t) => t.id)]) {
        const member = state.goals![id];
        if (["completed", "cancelled"].includes(member.status)) continue;
        member.status = args.action === "cancel" ? "cancelled" : "paused";
        const item = s.work.find((w) => w.id === id)!;
        item.status = args.action === "cancel" ? "cancelled" : "blocked";
      }
      save(); return;
    }
    case "sdd_lifecycle": return structuredClone(state.lifecycle?.[String(args.workId)] ?? emptyLifecycle());
    case "sdd_discard_impact": {
      const ids = new Set([String(args.workId)]);
      let count = 0;
      while (count !== ids.size) { count = ids.size; for (const w of s.work) if (!["cancelled", "discarded"].includes(w.stage) && w.dependsOn.some((d) => ids.has(d))) ids.add(w.id); }
      return s.work.filter((w) => w.id !== args.workId && ids.has(w.id));
    }
    case "sdd_lifecycle_action": {
      const input = args.input as { workId: string; action: string; expectedStage: string; revision: number; note: string; inputDigest: string };
      const w = s.work.find((w) => w.id === input.workId)!;
      if (!w || !isLifecycleV2(w)) throw new Error("SDD v2 work required");
      state.lifecycle ??= {}; const current = state.lifecycle[w.id] ??= emptyLifecycle();
      if (w.stage !== input.expectedStage || current.revision !== input.revision) throw new Error("Work changed. Refresh first.");
      const routes: Record<string, Record<string, string>> = { clarify: { inbox: "clarify" }, design: { clarify: "design" }, approve: { approval: "queued" }, revise: { approval: "design", queued: "design" }, confirm: { unconfirmed: "done" }, cancel: Object.fromEntries(["inbox", "clarify", "design", "approval", "queued"].map((s) => [s, "cancelled"])) };
      const next = routes[input.action]?.[w.stage]; if (!next) throw new Error("Invalid lifecycle action");
      if (input.action === "design" && (!current.clarified || current.interviews.some((q) => !q.answer))) throw new Error("Clarify and answer questions first");
      if (input.action === "approve") {
        const docs = ["intent", "brief", "spec", "plan", "verification", "rollback"].map((r) => doc(w.id, r));
        if (input.inputDigest !== docs.map((d) => d.revision).join(":")) throw new Error("Design changed. Refresh first.");
        if (["intent", "brief", "spec", "plan"].some((r) => !substantive(doc(w.id, r).markdown))) throw new Error("Design evidence required");
        checkpoint(w, "design-review", input.note);
      }
      w.decisions.push({ stage: w.stage, at: now(), note: input.note }); w.stage = next;
      w.status = next === "done" ? "done" : next === "cancelled" ? "cancelled" : "ready";
      w.updatedAt = now(); current.revision++; save(); return structuredClone(w);
    }
    case "sdd_answer_interview": {
      state.lifecycle ??= {}; const current = state.lifecycle[String(args.workId)] ??= emptyLifecycle();
      if (current.revision !== args.revision) throw new Error("Interview changed");
      const q = current.interviews.find((q) => q.id === args.questionId && !q.answer); if (!q || !String(args.answer).trim()) throw new Error("Answer required");
      q.answer = String(args.answer).trim(); q.answeredAt = now(); current.revision++;
      const w = s.work.find((w) => w.id === args.workId)!; if (!current.interviews.some((q) => !q.answer)) w.status = "ready";
      save(); return structuredClone(current);
    }
    case "sdd_queue_implementation":
    case "sdd_generate_resource":
    case "sdd_design_source": throw new Error(i18n.t("workbench:preview.launchNeedsDesktop"));
    case "sdd_resources": return structuredClone(state.resources ?? []);
    case "sdd_project_resources": return structuredClone(state.resourceAssignments?.[String(args.projectId)] ?? { designId: "", templates: {} });
    case "sdd_save_resource": {
      const doc = structuredClone(args.input) as ResourceDocument; state.resources ??= [];
      const old = state.resources.find((r) => r.id === doc.id);
      if (old && old.revision !== doc.revision) throw new Error("Document changed");
      if (!doc.title.trim() || !doc.markdown.trim()) throw new Error("Name and content required");
      doc.id ||= crypto.randomUUID(); doc.revision = crypto.randomUUID(); state.resources = [...state.resources.filter((r) => r.id !== doc.id), doc]; save(); return doc;
    }
    case "sdd_assign_resource": {
      state.resourceAssignments ??= {}; const assignment = state.resourceAssignments[String(args.projectId)] ??= { designId: "", templates: {} };
      if (args.role === "design") assignment.designId = String(args.resourceId); else if (args.resourceId) assignment.templates[String(args.role)] = String(args.resourceId); else delete assignment.templates[String(args.role)];
      save(); return structuredClone(assignment);
    }

    case "sdd_read_mockup": {
      const workId = String(args.workId);
      if (state.mockups?.[workId]) return structuredClone(state.mockups[workId].manifest);
      if (!s.work.some((work) => work.id === workId && work.workflowId === "mockup-review") || !["mockup-demo", "mockup-v1"].includes(workId)) throw new Error("목업 정보를 찾을 수 없습니다");
      return { ...structuredClone(mockupDemo), id: workId, revision: workId === "mockup-v1" ? 1 : 2, parentMockupId: workId === "mockup-v1" ? "" : "mockup-v1" };
    }
    case "sdd_read_mockup_html": {
      const workId = String(args.workId);
      const screenId = String(args.screenId);
      if (state.mockups?.[workId]) {
        const source = state.mockups[workId].html[screenId];
        if (source == null) throw new Error("목업 HTML 파일을 찾을 수 없습니다");
        return source;
      }
      if (!s.work.some((work) => work.id === workId && work.workflowId === "mockup-review") || !["mockup-demo", "mockup-v1"].includes(workId)) throw new Error("목업 정보를 찾을 수 없습니다");
      return demoHtml(screenId);
    }
    case "sdd_snapshot":
    case "workflow_snapshot":
      return structuredClone(s);
    // Demo data is always well-formed. A report of nothing to fix is the correct answer.
    case "sdd_repair_documents":
      return { repairs: [], remaining: structuredClone(s.diagnostics ?? []) };
    // The browser demo has no legacy vault. The fact that there is nothing to migrate is itself the answer.
    case "issue_migration_plan":
      return [];
    case "issue_migrate":
      return { migrated: [], skipped: [] };
    case "workflow_catalog":
      return structuredClone(s.workflows);
    case "workflow_generate": {
      const { previewDraft } = await import("../workflow-studio/preview-draft");
      return previewDraft(String(args.request), args.definition as WorkflowDefinition | null);
    }
    case "workflow_draft_list":
      return structuredClone(state.drafts ?? []);
    case "workflow_draft_save": {
      const input = args.input as { draftId: string; definition: WorkflowDefinition; expectedRevision?: string };
      const existing = state.drafts?.find(draft => draft.draftId === input.draftId);
      if (existing && input.expectedRevision !== existing.revision) throw new Error("revision-conflict: draft changed; read it again before saving");
      const record = { draftId: input.draftId, definition: structuredClone(input.definition), revision: crypto.randomUUID(), validation: { valid: true, issues: [] }, updatedAt: now() };
      state.drafts = [record, ...(state.drafts ?? []).filter(draft => draft.draftId !== input.draftId)];
      save();
      return record;
    }
    case "workflow_import": {
      const definition = JSON.parse(String(args.json)) as WorkflowDefinition;
      if (!definition || typeof definition.id !== "string" || typeof definition.label !== "string" ||
          typeof definition.version !== "string" || typeof definition.entry !== "string" ||
          !Array.isArray(definition.nodes) || !Array.isArray(definition.edges) ||
          !Array.isArray(definition.artifacts) || !Array.isArray(definition.loops) ||
          definition.nodes.some(node => !node || typeof node.id !== "string" ||
            !Array.isArray(node.inputs) || !Array.isArray(node.outputs) || !Array.isArray(node.allowedRoles)))
        throw new Error(i18n.t("dashboard:workflowStudio.jsonSyntaxError"));
      return previewInvoke("workflow_draft_save", { input: {
        draftId: `import-${crypto.randomUUID()}`, definition,
      } });
    }
    case "workflow_publish": {
      const definition = structuredClone(args.definition) as WorkflowDefinition;
      const existing = s.workflows.find(item => item.id === definition.id && item.version === definition.version);
      if (existing && JSON.stringify(existing) !== JSON.stringify(definition)) throw new Error("This version is already published.");
      if (!existing) s.workflows.push(definition);
      save();
      return definition;
    }
    case "workflow_export":
      return JSON.stringify(args.definition, null, 2);
    case "workflow_validate":
      return { valid: true, issues: [] };
    case "workflow_activate": {
      const project = s.projects.find(
        (candidate) => candidate.id === id || candidate.id === args.projectId,
      );
      if (!project) throw new Error(i18n.t("workbench:preview.projectNotFound"));
      const nextId = String(args.workflowId), nextVersion = String(args.workflowVersion);
      if (!isSelectableWorkflow(nextId)) throw new Error(i18n.t("workbench:creation.retiredWorkflow"));
      if (!s.workflows.some((definition) => definition.id === nextId && definition.version === nextVersion))
        throw new Error(i18n.t("workbench:creation.workflowUnavailable"));
      project.additionalWorkflows = projectWorkflowRefs(project).filter((reference) => reference.id !== nextId || reference.version !== nextVersion);
      project.workflowId = String(args.workflowId);
      project.workflowVersion = String(args.workflowVersion);
      project.workflowDigest = `preview-${project.workflowId}-${project.workflowVersion}`;
      save();
      return structuredClone(project);
    }
    case "sdd_initialize":
      s.initialized = true;
      save();
      return structuredClone(s);
    case "sdd_save_project": {
      const p = structuredClone(
        args.input,
      ) as WorkspaceSnapshot["projects"][number];
      p.id ||= crypto.randomUUID();
      if (!p.name.trim())
        throw new Error(i18n.t("workbench:preview.projectNameRequired"));
      if (![p.workflowId, ...(p.additionalWorkflows ?? []).map((reference) => reference.id)].every(isSelectableWorkflow))
        throw new Error(i18n.t("workbench:creation.retiredWorkflow"));
      const references = projectWorkflowRefs(p);
      if (references.some((reference) => !s.workflows.some((definition) => definition.id === reference.id && definition.version === reference.version)))
        throw new Error(i18n.t("workbench:creation.workflowUnavailable"));
      p.additionalWorkflows = references.slice(1);
      p.workflowDigest = `preview-${p.workflowId}-${p.workflowVersion}`;
      const i = s.projects.findIndex((v) => v.id === p.id);
      if (i < 0) s.projects.push(p);
      else s.projects[i] = p;
      save();
      return p;
    }
    case "sdd_capture_intent": {
      const input = args.input as { work: WorkItem; markdown: string; attachments: Array<{ name: string; dataUrl: string; reference?: string }> };
      if (!input.markdown.trim() && !input.attachments.length) throw new Error("Add a note or image");
      let markdown = input.markdown;
      for (const image of input.attachments) {
        if (image.reference) {
          const destination = `(${image.reference})`;
          if (!markdown.includes(destination)) throw new Error("Embedded image was removed");
          markdown = markdown.replaceAll(destination, `(${image.dataUrl})`);
        } else markdown += `\n\n![${image.name.replace(/[\[\]\n\r]/g, "")}](${image.dataUrl})`;
      }
      const existing = s.work.find((work) => work.id === input.work.id);
      if (existing) {
        if (existing.workflowId === "intent-flow" && existing.projectId === input.work.projectId && doc(existing.id, "intent").markdown === markdown) return existing;
        throw new Error("An intent with this ID already exists");
      }
      const work = await previewInvoke("sdd_save_work", { input: { ...input.work, description: input.markdown.slice(0, 180), workflowId: "intent-flow", workflowVersion: input.work.workflowVersion || "2.0.0" } }) as WorkItem;
      state.documents[`${work.id}/intent`] = { workId: work.id, artifact: "intent", path: `work/${work.id}/intent.md`, markdown, revision: crypto.randomUUID() };
      checkpoint(work, "captured");
      save(); return work;
    }
    case "sdd_intent_review": {
      const work = s.work.find((w) => w.id === args.workId)!;
      const documents = (isLifecycleV2(work) ? ["intent", "brief", "spec", "plan", "verification", "rollback"] : ["intent", "spec", "plan", "verification"]).map((role) => doc(String(args.workId), role));
      return { documents, inputDigest: documents.map((document) => document.revision).join(":"),
        history: (state.history?.[String(args.workId)] ?? []).map(({ documents: _, ...entry }) => entry) };
    }
    case "sdd_intent_checkpoint": {
      const entry = state.history?.[String(args.workId)]?.find((entry) => entry.id === args.checkpointId);
      if (!entry) throw new Error("기록을 찾을 수 없습니다");
      return structuredClone(entry.documents);
    }
    case "sdd_save_work": {
      const w = structuredClone(args.input) as WorkItem;
      w.id ||= crypto.randomUUID();
      if (!w.title.trim())
        throw new Error(i18n.t("workbench:preview.workTitleRequired"));
      const i = s.work.findIndex((v) => v.id === w.id);
      if (i >= 0 && s.work[i].stage !== w.stage)
        throw new Error(i18n.t("workbench:preview.useTransitionButton"));
      if (i >= 0) {
        const old = s.work[i];
        Object.assign(w, { status: old.status, approve: old.approve, approved: old.approved,
          approvalRequired: old.approvalRequired, decisions: old.decisions,
          workflowId: old.workflowId, workflowVersion: old.workflowVersion,
          workflowDigest: old.workflowDigest, workflowInstanceId: old.workflowInstanceId, activeNodes: old.activeNodes });
      }
      w.createdAt ||= now();
      w.updatedAt = now();
      if (i < 0) {
        bindProjectWorkflow(w);
        w.status = "backlog";
        w.approve = false;
        w.approved = "";
        w.approvalRequired = false;
        w.decisions = [];
        w.workflowDigest = `preview-${w.workflowId}-${w.workflowVersion}`;
        w.workflowInstanceId = null;
        w.activeNodes = [];
        const definition = s.workflows.find(
          (candidate) =>
            candidate.id === w.workflowId &&
            candidate.version === w.workflowVersion,
        );
        if (!definition) throw new Error(i18n.t("workbench:creation.workflowUnavailable"));
        w.stage = definition?.entry ?? "intent";
        w.artifacts = definition?.artifacts.map(
          (artifact) => artifact.role,
        ) ?? [...ARTIFACTS];
        s.work.unshift(w);
      } else s.work[i] = w;
      save();
      return w;
    }
    case "sdd_transition": {
      const w = s.work.find((v) => v.id === id);
      const definition = s.workflows.find((candidate) => candidate.id === w?.workflowId && candidate.version === w.workflowVersion);
      const edge = definition?.edges.find((candidate) => candidate.from === w?.stage && candidate.to === args.stage);
      if (!w || !edge) throw new Error(i18n.t("workbench:errors.invalidTransition"));
      return previewInvoke("workflow_command", { input: { workId: id, event: edge.on, targetNodeId: edge.to, expectedNodeId: w.stage, note: args.note } });
    }
    case "workflow_command": {
      const input = args.input as {
        workId: string;
        event: string;
        targetNodeId?: string;
        expectedNodeId: string;
        note: string;
        inputDigest?: string;
        facts?: Record<string, unknown>;
      };
      const w = s.work.find((candidate) => candidate.id === input.workId);
      if (!w) throw new Error(i18n.t("workbench:errors.workNotFound"));
      if (w.workflowId === "intent-flow" && input.inputDigest && input.inputDigest !== ["intent", "spec", "plan", "verification"].map((role) => doc(w.id, role).revision).join(":"))
        throw new Error("The design changed. Refresh and review again.");
      if (w.stage !== input.expectedNodeId)
        throw new Error(i18n.t("workbench:preview.nodeMovedConcurrently"));
      const definition = s.workflows.find(
        (candidate) =>
          candidate.id === w.workflowId &&
          candidate.version === w.workflowVersion,
      );
      if (!input.note?.trim()) throw new Error(i18n.t("workbench:detail.reviewNoteRequired"));
      if (isClosedStatus(w.status)) throw new Error(i18n.t("workbench:work.closedError"));
      if (input.event.startsWith("work:")) {
        const action = input.event.slice(5);
        if ((input.facts?.expectedStatus && input.facts.expectedStatus !== w.status) || !workActions(w, definition).includes(action))
          throw new Error(i18n.t("workbench:work.invalidAction"));
        if (["submit", "complete"].includes(action)) {
          if (w.workflowId === "intent-flow" && JSON.stringify(state.approvals?.[w.id]) !== JSON.stringify(["intent", "spec", "plan"].map((role) => doc(w.id, role).revision)))
            throw new Error("The intent or design changed after approval. Revisit and approve the design.");
          if (!isFinalWorkNode(w, definition)) throw new Error(i18n.t("workbench:work.invalidAction"));
          const node = definition!.nodes.find((node) => node.id === w.stage)!;
          for (const role of [...node.inputs, ...node.outputs]) {
            if (!substantive(doc(w.id, role).markdown)) throw new Error(i18n.t("workbench:work.evidenceRequired", { role }));
          }
          if (w.dependsOn.some((id) => s.work.find((item) => item.id === id)?.status !== "done"))
            throw new Error(i18n.t("workbench:work.invalidAction"));
        }
        const statuses: Record<string, WorkItem["status"]> = { accept: "ready", start: "running", reject: "rejected", cancel: "cancelled", pause: "blocked", resume: "running", revise: "running", submit: "review", complete: "done" };
        if (action === "complete") checkpoint(w, "result-review", input.note);
        w.status = statuses[action];
        if (["accept", "start"].includes(action)) { w.approve = true; w.approved ||= now().slice(0, 10); }
        w.updatedAt = now();
        w.decisions.push({ stage: w.stage, at: now(), note: `${input.event}: ${input.note}` });
        save();
        return structuredClone(w);
      }
      if (w.status === "blocked") throw new Error(i18n.t("workbench:work.closedError"));
      const edges = definition?.edges.filter(
        (edge) =>
          edge.from === w.stage &&
          edge.on === input.event &&
          (!input.targetNodeId || edge.to === input.targetNodeId),
      );
      if (edges?.length !== 1)
        throw new Error(i18n.t("workbench:preview.unhandledEvent"));
      const target = definition!.nodes.find((node) => node.id === edges[0].to)!;
      for (const role of target.inputs) {
        if (!substantive(doc(w.id, role).markdown)) throw new Error(i18n.t("workbench:work.evidenceRequired", { role }));
      }
      if (target.requiresCompletedDependencies && w.dependsOn.some((id) => s.work.find((item) => item.id === id)?.status !== "done"))
        throw new Error(i18n.t("workbench:work.invalidAction"));
      if (input.event === "approved") {
        checkpoint(w, "design-review", input.note);
        if (w.workflowId === "intent-flow") {
          state.approvals ??= {};
          state.approvals[w.id] = ["intent", "spec", "plan"].map((role) => doc(w.id, role).revision);
        }
      }
      w.status = target.kind === "end" ? "done" : "running";
      w.approve = true;
      w.approvalRequired = false;
      w.approved ||= now().slice(0, 10);
      w.stage = edges[0].to;
      w.updatedAt = now();
      w.decisions.push({ stage: w.stage, at: now(), note: input.note });
      save();
      return structuredClone(w);
    }
    case "sdd_read_document":
      return doc(String(args.workId), String(args.artifact));
    case "sdd_write_document": {
      const d = doc(String(args.workId), String(args.artifact));
      if (d.revision !== args.revision)
        throw new Error(
          i18n.t("workbench:preview.documentChangedElsewhere"),
        );
      const work = s.work.find((work) => work.id === d.workId);
      if (work && d.markdown !== String(args.markdown)) checkpoint(work, "before-edit", d.artifact);
      d.markdown = String(args.markdown);
      d.revision = crypto.randomUUID();
      state.documents[`${d.workId}/${d.artifact}`] = d;
      save();
      return d;
    }
    case "sdd_save_event": {
      const e = structuredClone(
        args.input,
      ) as WorkspaceSnapshot["events"][number];
      e.id ||= crypto.randomUUID();
      if (!e.title.trim() || (!e.date && (e.kind !== "milestone" || e.endDate != null)))
        throw new Error(i18n.t("workbench:preview.titleAndDateRequired"));
      const i = s.events.findIndex((v) => v.id === e.id);
      if (i < 0) s.events.push(e);
      else s.events[i] = e;
      save();
      return e;
    }
    case "sdd_delete_event":
      s.events = s.events.filter((v) => v.id !== id);
      save();
      return null;
    case "sdd_search": {
      const q = String(args.query).trim().toLowerCase();
      if (!q) return [];
      return s.work
        .flatMap((w) => {
          const definition = s.workflows.find(
            (candidate) =>
              candidate.id === w.workflowId &&
              candidate.version === w.workflowVersion,
          );
          return (
            definition?.artifacts.map((artifact) => artifact.role) ?? ARTIFACTS
          ).map((artifact) => doc(w.id, artifact));
        })
        .filter((d) => d.markdown.toLowerCase().includes(q))
        .map((d) => ({
          path: d.path,
          title: s.work.find((w) => w.id === d.workId)?.title ?? d.workId,
          snippet: d.markdown.slice(0, 200),
          workId: d.workId,
          artifact: d.artifact,
        }));
    }
    case "sdd_runs":
      return state.runs ?? [];
    case "sdd_refresh_run": {
      const run = state.runs?.find((run) => run.id === id);
      if (!run) throw new Error("실행 기록을 찾을 수 없습니다");
      return structuredClone(run);
    }
    case "sdd_dismiss_run": {
      // A flag change that keeps the record, so it can be tried as-is in demo mode too.
      const run = state.runs?.find((run) => run.id === id);
      if (!run) throw new Error("실행 기록을 찾을 수 없습니다");
      if (["starting", "running"].includes(run.status)) throw new Error("진행 중인 실행은 닫을 수 없습니다");
      run.dismissedAt = args.dismissed ? now() : null;
      save();
      return structuredClone(run);
    }
    case "sdd_work_copilot": {
      // Demo mode has no agent to call. It only shows how a question would flow.
      const input = (args.input ?? {}) as { workId?: string; question?: string };
      const work = s.work.find((candidate) => candidate.id === input.workId);
      if (!work) throw new Error(i18n.t("workbench:errors.workNotFound"));
      const project = s.projects.find((candidate) => candidate.id === work.projectId);
      return {
        answer: i18n.t("workbench:preview.copilotAnswer", {
          question: (input.question ?? "").trim(),
          title: work.title,
          stage: i18n.t(`workbench:stage.${work.stage}`, { defaultValue: work.stage }),
        }),
        agent: project?.defaultAgent || "claude",
        model: project?.defaultModel || "",
      };
    }
    case "sdd_launch":
      throw new Error(i18n.t("workbench:preview.launchNeedsDesktop"));
    case "sdd_run_output":
      return "";
    default:
      throw new Error(
        i18n.t("workbench:preview.unsupportedCommand", { command }),
      );
  }
}
