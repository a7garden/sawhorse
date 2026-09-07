// Opt-in browser tour only. Failed desktop IPC never falls back to this store.
import i18n from "@/i18n";
import {
  ARTIFACTS,
  STAGES,
  isClosedStatus,
  type Document,
  type WorkItem,
  type WorkspaceSnapshot,
  type WorkflowDefinition,
} from "./types";
const KEY = "sawhorse.workflow.preview.v2";
const now = () => new Date().toISOString();
const previewWorkflows: WorkflowDefinition[] = [
  {
    definitionVersion: 1,
    id: "sdd-main",
    label: "기본 SDD",
    description: "의도에서 배포까지 이어지는 기본 흐름",
    version: "1.1.0",
    entry: "intent",
    artifacts: ARTIFACTS.map((role) => ({
      role,
      label: role,
      path: `work/{workId}/${role}.md`,
      template: `# ${role}\n`,
    })),
    nodes: STAGES.map((id, index) => ({
      id,
      label: ["의도", "설계", "구현", "검증", "배포"][index],
      kind: index === 0 ? "artifact" : "agent",
      artifactRole: index === 0 ? "intent" : null,
      actionRef: index === 0 ? null : `sdd-${id}`,
      workflowRef: null,
      decision: null,
      inputs: index ? [ARTIFACTS[index - 1]] : [],
      outputs: [ARTIFACTS[index]],
      allowedRoles: [
        "research",
        "planner",
        "implementer",
        "verifier",
        "reviewer",
      ],
      instructions: "현재 노드의 산출물과 근거를 작성합니다.",
      requiresCompletedDependencies: index >= 2,
    })),
    edges: STAGES.slice(0, -1).flatMap((from, index) => [
      {
        from,
        to: STAGES[index + 1],
        on: "approved",
        condition: null,
        loopRef: null,
      },
      {
        from: STAGES[index + 1],
        to: from,
        on: "revise",
        condition: null,
        loopRef: "sdd-revision",
      },
    ]),
    loops: [{ id: "sdd-revision", maxIterations: 20, onLimit: "pause" }],
  },
  {
    definitionVersion: 1,
    id: "tdd-cycle",
    label: "TDD 사이클",
    description: "Red, Green, 리팩터링과 회귀 검증을 잇는 흐름",
    version: "1.0.0",
    entry: "test-intent",
    artifacts: [
      ["test-intent", "테스트 의도"],
      ["red-evidence", "Red 근거"],
      ["implementation", "최소 구현"],
      ["green-evidence", "Green 근거"],
      ["refactor", "리팩터링"],
      ["regression", "회귀 검증"],
    ].map(([role, label]) => ({
      role,
      label,
      path: `work/{workId}/${role}.md`,
      template: `# ${label}\n`,
    })),
    nodes: [
      ["test-intent", "테스트 의도", "artifact"],
      ["red", "Red", "check"],
      ["green", "Green", "agent"],
      ["refactor", "리팩터링", "agent"],
      ["verify", "재검증", "check"],
      ["done", "완료", "end"],
    ].map(([id, label, kind], index) => ({
      id,
      label,
      kind: kind as "artifact" | "check" | "agent" | "end",
      artifactRole: index === 0 ? "test-intent" : null,
      actionRef: index > 0 && index < 5 ? `tdd-${id}` : null,
      workflowRef: null,
      decision: null,
      inputs: index
        ? [
            [
              "test-intent",
              "red-evidence",
              "green-evidence",
              "refactor",
              "regression",
            ][index - 1],
          ]
        : [],
      outputs:
        index < 5
          ? [
              [
                "test-intent",
                "red-evidence",
                "green-evidence",
                "refactor",
                "regression",
              ][index],
            ]
          : [],
      allowedRoles: ["implementer", "verifier"],
      instructions: "현재 TDD 증거를 실제 실행 결과와 함께 기록합니다.",
      requiresCompletedDependencies: index > 0,
    })),
    edges: [
      ["test-intent", "red"],
      ["red", "green"],
      ["green", "refactor"],
      ["refactor", "verify"],
      ["verify", "done"],
    ].map(([from, to]) => ({
      from,
      to,
      on: "approved",
      condition: null,
      loopRef: null,
    })),
    loops: [{ id: "tdd-iteration", maxIterations: 50, onLimit: "pause" }],
  },
];
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
    status,
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
      dependsOn: ["herdr"],
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
      dependsOn: ["sawhorse"],
      verifyCommands: ["npm test"],
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
  snapshot: WorkspaceSnapshot;
  documents: Record<string, Document>;
};
function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Store;
      if (p.snapshot?.schemaVersion === 1) return p;
    }
  } catch {
    /* disposable tour */
  }
  return { snapshot: structuredClone(seed), documents: {} };
}
let state = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(state));
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
      markdown: `# ${w.title}\n\n## ${artifact === "intent" ? "문제" : "기록"}\n개발 의도, 코드 변경, 검증 근거가 떨어져 있어 맥락을 다시 찾는 시간이 듭니다.\n\n## 원하는 결과\n하나의 작업에서 문서를 편집하고 에이전트를 실행하며 실제 근거를 확인합니다.\n\n## 제약\n- 기록은 로컬 마크다운으로 남깁니다.\n- 프로젝트 의존성을 확인한 뒤 구현합니다.\n\n## 수용 기준\n- [ ] 문서와 실행 이력이 작업에 연결됩니다.\n- [ ] 검증 결과를 다음 단계에서 확인합니다.\n`,
    };
  }
  return structuredClone(state.documents[key]);
}
export async function previewInvoke(
  command: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  state = load();
  const s = state.snapshot;
  const id = String(args.id ?? "");
  switch (command) {
    case "sdd_snapshot":
    case "workflow_snapshot":
      return structuredClone(s);
    // 브라우저 체험에는 레거시 볼트가 없다. 이관할 것이 없다는 사실 자체가 답이다.
    case "issue_migration_plan":
      return [];
    case "issue_migrate":
      return { migrated: [], skipped: [] };
    case "workflow_catalog":
      return structuredClone(s.workflows);
    case "workflow_validate":
      return { valid: true, issues: [] };
    case "workflow_activate": {
      const project = s.projects.find(
        (candidate) => candidate.id === id || candidate.id === args.projectId,
      );
      if (!project) throw new Error(i18n.t("workbench:preview.projectNotFound"));
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
      p.workflowDigest = `preview-${p.workflowId}-${p.workflowVersion}`;
      const i = s.projects.findIndex((v) => v.id === p.id);
      if (i < 0) s.projects.push(p);
      else s.projects[i] = p;
      save();
      return p;
    }
    case "sdd_save_work": {
      const w = structuredClone(args.input) as WorkItem;
      w.id ||= crypto.randomUUID();
      if (!w.title.trim())
        throw new Error(i18n.t("workbench:preview.workTitleRequired"));
      const i = s.work.findIndex((v) => v.id === w.id);
      if (i >= 0 && s.work[i].stage !== w.stage)
        throw new Error(i18n.t("workbench:preview.useTransitionButton"));
      w.createdAt ||= now();
      w.updatedAt = now();
      if (i < 0) {
        const project = s.projects.find(
          (project) => project.id === w.projectId,
        );
        w.workflowId = project?.workflowId ?? "sdd-main";
        w.workflowVersion = project?.workflowVersion ?? "1.0.0";
        w.workflowDigest = `preview-${w.workflowId}-${w.workflowVersion}`;
        w.workflowInstanceId = null;
        w.activeNodes = [];
        const definition = s.workflows.find(
          (candidate) =>
            candidate.id === w.workflowId &&
            candidate.version === w.workflowVersion,
        );
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
      if (!w) throw new Error(i18n.t("workbench:errors.workNotFound"));
      const next = args.stage as WorkItem["stage"];
      const definition = s.workflows.find(
        (candidate) =>
          candidate.id === w.workflowId &&
          candidate.version === w.workflowVersion,
      );
      if (
        !definition?.edges.some(
          (edge) => edge.from === w.stage && edge.to === next,
        )
      )
        throw new Error(i18n.t("workbench:errors.invalidTransition"));
      w.stage = next;
      w.updatedAt = now();
      w.decisions.push({
        stage: next,
        at: now(),
        note: String(args.note ?? "브라우저 체험에서 단계 전환"),
      });
      save();
      return structuredClone(w);
    }
    case "workflow_command": {
      const input = args.input as {
        workId: string;
        event: string;
        targetNodeId?: string;
        expectedNodeId: string;
        note: string;
      };
      const w = s.work.find((candidate) => candidate.id === input.workId);
      if (!w) throw new Error(i18n.t("workbench:errors.workNotFound"));
      if (w.stage !== input.expectedNodeId)
        throw new Error(i18n.t("workbench:preview.nodeMovedConcurrently"));
      const definition = s.workflows.find(
        (candidate) =>
          candidate.id === w.workflowId &&
          candidate.version === w.workflowVersion,
      );
      const edges = definition?.edges.filter(
        (edge) =>
          edge.from === w.stage &&
          edge.on === input.event &&
          (!input.targetNodeId || edge.to === input.targetNodeId),
      );
      if (edges?.length !== 1)
        throw new Error(i18n.t("workbench:preview.unhandledEvent"));
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
      if (!e.title.trim() || !e.date)
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
      return [];
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
