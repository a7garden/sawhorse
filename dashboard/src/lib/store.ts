import { create } from "zustand";
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
  ScheduleView,
  TodoSections,
  UnpromotedItem,
  VaultAudit,
  VaultNode,
} from "./types";

/**
 * 코어 페이지는 호스트가 항상 들고 있고, 그 사이의 화면은 팩이 기여한다.
 * 팩 화면의 id 는 `view:<packId>:<viewId>`.
 */
export const CORE_PAGES = ["home", "jobs", "terminal", "packs", "settings"] as const;
export type CorePage = (typeof CORE_PAGES)[number];
export type PageId = CorePage | `view:${string}:${string}`;

/** 팩 이전 코드가 부르던 화면 이름 → 그 화면을 가진 네이티브 뷰. */
const LEGACY_PAGE_ALIASES = ["improve", "issues", "todos", "docs", "vault"] as const;

function isCore(id: string): id is CorePage {
  return (CORE_PAGES as readonly string[]).includes(id);
}

export function viewPageId(packId: string, viewId: string): PageId {
  return `view:${packId}:${viewId}`;
}

export function parseViewPage(id: string): { packId: string; viewId: string } | null {
  if (!id.startsWith("view:")) return null;
  const [, packId, viewId] = id.split(":");
  return packId && viewId ? { packId, viewId } : null;
}

interface AppState {
  page: PageId;
  setPage: (p: string) => void;

  nav: NavEntry[];
  packs: PackRegistryView | null;
  agents: AgentPresence[];
  schedules: ScheduleView[];

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
  unpromoted: UnpromotedItem[];
  wizardOpen: boolean;

  init: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => void;
  refreshConfig: () => Promise<void>;
  refreshPacks: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshSchedules: () => Promise<void>;
  refreshImprovements: () => Promise<void>;
  refreshTodos: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  refreshMissed: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  refreshTree: () => Promise<void>;
  refreshAudit: () => Promise<void>;
  pushProgress: (jobId: string, entry: ProgressEntry) => void;
}

let initialized = false;

export const useApp = create<AppState>((set, get) => ({
  page: "home",

  /**
   * 팩 화면 id 를 그대로 받고, 예전 이름(`improve`·`todos`…)은 그 화면을 가진 뷰로 옮긴다.
   * 팩이 꺼져 화면이 사라졌으면 홈으로 — 존재하지 않는 페이지에 갇히지 않게.
   */
  setPage: (p) => {
    if (isCore(p)) return set({ page: p });
    if (parseViewPage(p)) {
      const { packId, viewId } = parseViewPage(p)!;
      const exists = get().nav.some((n) => n.packId === packId && n.viewId === viewId);
      return set({ page: exists ? (p as PageId) : "home" });
    }
    const alias = p === "improve" ? "issues" : p;
    const hit = get().nav.find((n) => n.component === alias || n.viewId === alias);
    set({ page: hit ? viewPageId(hit.packId, hit.viewId) : "home" });
  },

  nav: [],
  packs: null,
  agents: [],
  schedules: [],

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
  vaultTree: [],
  inboxCount: 0,
  audit: null,
  unpromoted: [],

  init: async () => {
    if (initialized) return;
    initialized = true;
    const unlisteners: UnlistenFn[] = [];
    unlisteners.push(
      await listen<{ jobId: string; entry: ProgressEntry }>(EVENTS.jobProgress, (e) =>
        get().pushProgress(e.payload.jobId, e.payload.entry),
      ),
    );
    unlisteners.push(
      await listen<{ job: Job }>(EVENTS.jobFinished, () => void get().refreshJobs()),
    );
    unlisteners.push(
      await listen<{ areas: string[] }>(EVENTS.vaultChanged, () => {
        void get().refreshImprovements();
        void get().refreshTodos();
        void get().refreshTree();
      }),
    );
    unlisteners.push(
      await listen<{ missed: MissedRoutine }>(EVENTS.scheduleMissed, () =>
        void get().refreshMissed(),
      ),
    );
    await Promise.all([
      get().refreshConfig(),
      get().refreshPacks(),
      get().refreshSchedules(),
      get().refreshJobs(),
      get().refreshMissed(),
      get().refreshImprovements(),
      get().refreshTodos(),
      get().refreshTree(),
      get().refreshAudit(),
      get().refreshDiagnostics(),
    ]);
    void get().refreshAgents();
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
    if (parsed && !nav.some((n) => n.packId === parsed.packId && n.viewId === parsed.viewId)) {
      set({ page: "home" });
    }
  },
  refreshAgents: async () => set({ agents: await api.listAgents().catch(() => []) }),
  refreshSchedules: async () => set({ schedules: await api.listSchedules().catch(() => []) }),
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
    const [audit, unpromoted] = await Promise.all([api.auditVault(), api.listUnpromoted()]);
    set({ audit, unpromoted });
  },

  pushProgress: (jobId, entry) =>
    set((s) => {
      const list = s.progress[jobId] ?? [];
      // keep memory bounded for very chatty jobs
      const next = list.length > 4000 ? list.slice(-2000) : list;
      return { progress: { ...s.progress, [jobId]: [...next, entry] } };
    }),
}));

export { LEGACY_PAGE_ALIASES };
