import type { WorkflowDefinition } from "@/features/workbench/types";
import { create } from "zustand";
import { useProjectScope } from "@/features/workbench/project-scope";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, EVENTS } from "./api";
import type {
  AgentPresence,
  ConfigView,
  Diagnostics,
  IssueNote,
  Job,
  MissedRoutine,
  NavEntry,
  PackRegistryView,
  ProgressEntry,
  RequirementStatus,
  ScheduleView,
  CollabSession,
  TodoSections,
  UnpromotedItem,
  VaultAttention,
  VaultAudit,
  VaultNode,
} from "./types";

// vault-changed 마다 볼트 전체 스캔을 하지 않도록 어텐션 갱신을 모은다.
let attentionTimer: number | undefined;

/**
 * 코어 페이지는 호스트가 항상 들고 있고, 그 사이의 화면은 팩이 기여한다.
 * 팩 화면의 id 는 `view:<packId>:<viewId>`.
 */
export const CORE_PAGES = [
  "work",
  "github",
  "issues",
  "docs",
  "todos",
  "task-library",
  "home",
  "overview",
  "board",
  "calendar",
  "harness",
  "knowledge",
  "projects",
  "workflows",
  "schemas",
  "onboarding",
  "jobs",
  "tasks",
  "sessions",
  "review",
  "sources",
  "reading",
  "terminal",
  "packs",
  "settings",
] as const;
export type CorePage = (typeof CORE_PAGES)[number];
export type PageId = CorePage | `view:${string}:${string}`;

/** 팩 이전 코드가 부르던 화면 이름 → 그 화면을 가진 네이티브 뷰. */
const LEGACY_PAGE_ALIASES = ["improve", "issues", "vault"] as const;

function isCore(id: string): id is CorePage {
  return (CORE_PAGES as readonly string[]).includes(id);
}

export function viewPageId(packId: string, viewId: string): PageId {
  return `view:${packId}:${viewId}`;
}

export function parseViewPage(
  id: string,
): { packId: string; viewId: string } | null {
  if (!id.startsWith("view:")) return null;
  const [, packId, viewId] = id.split(":");
  return packId && viewId ? { packId, viewId } : null;
}

/** 작업대 바깥(커맨드 팔레트 등)에서 특정 작업 상세를 열어 달라는 요청. WorkbenchPage 가 소비하고 지운다. */
export type OpenWorkRequest = {
  workId: string;
  artifact?: string;
  snippet?: string;
};

interface AppState {
  workflowToEdit: WorkflowDefinition | null;
  page: PageId;
  setPage: (p: string) => void;
  /** 커맨드 팔레트가 작업 상세 열기를 요청하는 통로. */
  openWorkRequest: OpenWorkRequest | null;
  openWork: (request: OpenWorkRequest) => void;
  clearOpenWork: () => void;
  openRunRequest: { id: string; projectId: string } | null;
  openRun: (id: string, projectId: string) => void;
  clearOpenRun: () => void;

  nav: NavEntry[];
  packs: PackRegistryView | null;
  agents: AgentPresence[];
  /** 설정값을 정상화한 기본 에이전트 id */
  defaultAgent: string;
  requirements: RequirementStatus[];
  schedules: ScheduleView[];
  /** 협업 세션 목록 — collab-changed 이벤트마다 다시 읽는다. */
  collabSessions: CollabSession[];

  config: ConfigView | null;
  diag: Diagnostics | null;
  improvements: IssueNote[];
  todos: TodoSections | null;
  jobs: Job[];
  progress: Record<string, ProgressEntry[]>;
  missed: MissedRoutine[];
  vaultTree: VaultNode[];
  inboxCount: number;
  audit: VaultAudit | null;
  attention: VaultAttention | null;
  unpromoted: UnpromotedItem[];
  wizardOpen: boolean;

  init: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => void;
  refreshConfig: () => Promise<void>;
  refreshPacks: () => Promise<void>;
  refreshSchedules: () => Promise<void>;
  refreshCollabSessions: () => Promise<void>;
  refreshRequirements: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshImprovements: () => Promise<void>;
  refreshTodos: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshMissed: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshAudit: () => Promise<void>;
  refreshAttention: () => Promise<void>;
  pushProgress: (jobId: string, entry: ProgressEntry) => void;
}

let initialized = false;

export const useApp = create<AppState>((set, get) => ({
  workflowToEdit: null,
  page: "overview",

  /**
   * 팩 화면 id 를 그대로 받고, 예전 이름(`improve`·`todos`…)은 그 화면을 가진 뷰로 옮긴다.
   * 팩이 꺼져 화면이 사라졌으면 홈으로 — 존재하지 않는 페이지에 갇히지 않게.
   */
  setPage: (p) => {
    if (["board", "issues", "improve"].includes(p)) return set({ page: "work" });
    if (isCore(p)) return set({ page: p });
    if (parseViewPage(p)) {
      const { packId, viewId } = parseViewPage(p)!;
      const exists = get().nav.some(
        (n) => n.packId === packId && n.viewId === viewId,
      );
      return set({ page: exists ? (p as PageId) : "overview" });
    }
    const alias = p === "improve" ? "issues" : p;
    const hit = get().nav.find(
      (n) => n.component === alias || n.viewId === alias,
    );
    set({ page: hit ? viewPageId(hit.packId, hit.viewId) : "overview" });
  },
  openWorkRequest: null,
  openWork: (request) => set({ openWorkRequest: request }),
  clearOpenWork: () => set({ openWorkRequest: null }),
  openRunRequest: null,
  openRun: (id, projectId) => {
    useProjectScope.getState().selectProject(projectId);
    set({ openRunRequest: { id, projectId }, page: "harness" });
  },
  clearOpenRun: () => set({ openRunRequest: null }),

  nav: [],
  packs: null,
  agents: [],
  defaultAgent: "claude",
  requirements: [],
  schedules: [],
  collabSessions: [],

  wizardOpen: false,
  openWizard: () => set({ wizardOpen: true }),
  closeWizard: () => set({ wizardOpen: false }),
  config: null,
  diag: null,
  improvements: [],
  todos: null,
  jobs: [],
  progress: {},
  missed: [],
  attention: null,
  vaultTree: [],
  inboxCount: 0,
  audit: null,
  unpromoted: [],

  init: async () => {
    if (initialized) return;
    initialized = true;
    if (!("__TAURI_INTERNALS__" in window)) {
      if (new URLSearchParams(window.location.search).get("preview") === "1") {
        // 프리뷰 핸들러가 없는 커맨드는 던진다. 브라우저 체험은 위젯이 비는 것보다
        // 화면 전체가 죽는 쪽이 훨씬 나쁘므로 개별 실패를 삼킨다.
        await Promise.all(
          [
            get().refreshConfig(),
            get().refreshDiagnostics(),
            get().refreshImprovements(),
            get().refreshPacks(),
            get().refreshTree(),
            get().refreshJobs(),
            get().refreshTodos(),
          ].map((task) => task.catch(() => {})),
        );
        void get().refreshAgents();
        void get().refreshRequirements();
      }
      return;
    }
    const unlisteners: UnlistenFn[] = [];
    unlisteners.push(
      await listen<{ jobId: string; entry: ProgressEntry }>(
        EVENTS.jobProgress,
        (e) => get().pushProgress(e.payload.jobId, e.payload.entry),
      ),
    );
    unlisteners.push(
      await listen<{ job: Job }>(
        EVENTS.jobFinished,
        () => void get().refreshJobs(),
      ),
    );
    unlisteners.push(
      await listen<{ areas: string[] }>(EVENTS.vaultChanged, () => {
        void get().refreshImprovements();
        void get().refreshTodos();
        void get().refreshTree();
        // 어텐션 프로브는 볼트 전체를 읽는다. 워처 이벤트가 몰려도 스캔은 한 번만.
        clearTimeout(attentionTimer);
        attentionTimer = window.setTimeout(
          () => void get().refreshAttention(),
          1500,
        );
      }),
    );
    unlisteners.push(
      await listen<{ missed: MissedRoutine }>(
        EVENTS.scheduleMissed,
        () => void get().refreshMissed(),
      ),
    );
    unlisteners.push(
      await listen<{ reason?: string }>(
        EVENTS.collabChanged,
        () => void get().refreshCollabSessions(),
      ),
    );
    await Promise.all([
      get().refreshConfig(),
      get().refreshPacks(),
      get().refreshSchedules(),
      get().refreshCollabSessions(),
      get().refreshJobs(),
      get().refreshMissed(),
      get().refreshImprovements(),
      get().refreshTodos(),
      get().refreshTree(),
      get().refreshAudit(),
      get().refreshAttention(),
      get().refreshDiagnostics(),
    ]);
    void get().refreshAgents();
    void get().refreshRequirements();
    const cfg = get().config;
    if (cfg && (!cfg.exists || cfg.vaultPath.length === 0)) {
      set({ wizardOpen: true });
    }
  },

  refreshConfig: async () => set({ config: await api.getConfig() }),
  refreshPacks: async () => {
    const [packs, nav] = await Promise.all([
      api.listPacks().catch(() => null),
      api.listNav().catch(() => [] as NavEntry[]),
    ]);
    set({ packs, nav });
    // 보고 있던 화면이 팩과 함께 사라졌으면 홈으로
    const page = get().page;
    const parsed = parseViewPage(page);
    if (
      parsed &&
      !nav.some((n) => n.packId === parsed.packId && n.viewId === parsed.viewId)
    ) {
      set({ page: "overview" });
    }
  },
  refreshAgents: async () => {
    const v = await api.listAgents().catch(() => null);
    if (v) set({ agents: v.agents, defaultAgent: v.defaultAgent });
  },
  refreshRequirements: async () =>
    set({ requirements: await api.checkRequirements().catch(() => []) }),
  refreshSchedules: async () =>
    set({ schedules: await api.listSchedules().catch(() => []) }),
  refreshCollabSessions: async () =>
    set({ collabSessions: await api.collabListSessions().catch(() => []) }),
  refreshImprovements: async () => {
    const improvements = await api.listIssues().catch(() => [] as IssueNote[]);
    set({
      improvements,
      inboxCount: await api.inboxCount().catch(() => 0),
    });
  },
  refreshTodos: async () => set({ todos: await api.listTodos() }),
  refreshJobs: async () => set({ jobs: await api.listJobs() }),
  refreshMissed: async () => set({ missed: await api.listMissed() }),
  refreshDiagnostics: async () => set({ diag: await api.diagnostics() }),
  refreshTree: async () => set({ vaultTree: await api.listVaultTree() }),
  refreshAudit: async () => {
    const [audit, unpromoted] = await Promise.all([
      api.auditVault(),
      api.listUnpromoted(),
    ]);
    set({ audit, unpromoted });
  },
  refreshAttention: async () =>
    set({ attention: await api.vaultAttention().catch(() => null) }),

  pushProgress: (jobId, entry) =>
    set((s) => {
      const list = s.progress[jobId] ?? [];
      // keep memory bounded for very chatty jobs
      const next = list.length > 4000 ? list.slice(-2000) : list;
      return { progress: { ...s.progress, [jobId]: [...next, entry] } };
    }),
}));

export { LEGACY_PAGE_ALIASES };
