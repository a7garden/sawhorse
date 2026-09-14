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

// Batches attention refreshes so vault-changed does not trigger a full vault scan each time.
let attentionTimer: number | undefined;
// Batches the cheap list re-reads (improvements/todos/tree) the same way as the attention probe.
let refreshTimer: number | undefined;

/**
 * Core pages are always held by the host; the screens between them are contributed by packs.
 * A pack screen's id is `view:<packId>:<viewId>`.
 */
export const CORE_PAGES = [
  "work",
  "github",
  "issues",
  "docs",
  "documents",
  "todos",
  "vault",
  "task-library",
  "home",
  "overview",
  "board",
  "calendar",
  "harness",
  "knowledge",
  "projects",
  "project-library",
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

/** Screen names that pre-pack code used → the native view owning that screen. */
const LEGACY_PAGE_ALIASES = ["improve", "issues"] as const;

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

/** Request to open a specific work item from outside the workbench (command palette etc.). WorkbenchPage consumes and clears it. */
export type OpenWorkRequest = {
  workId: string;
  artifact?: string;
  snippet?: string;
};

interface AppState {
  workflowToEdit: WorkflowDefinition | null;
  page: PageId;
  setPage: (p: string) => void;
  /** Channel through which the command palette requests opening a work item. */
  openWorkRequest: OpenWorkRequest | null;
  openWork: (request: OpenWorkRequest) => void;
  clearOpenWork: () => void;
  openRunRequest: { id: string; projectId: string } | null;
  openRun: (id: string, projectId: string) => void;
  clearOpenRun: () => void;

  nav: NavEntry[];
  packs: PackRegistryView | null;
  agents: AgentPresence[];
  /** Default agent id with the setting value normalized */
  defaultAgent: string;
  requirements: RequirementStatus[];
  schedules: ScheduleView[];
  /** Collaboration session list — re-read on every collab-changed event. */
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
   * Accepts pack screen ids as-is; legacy names (`improve`·`todos`…) map to the view owning that screen.
   * If the pack is disabled and the screen is gone, go home — so the user is never stuck on a nonexistent page.
   */
  setPage: (p) => {
    if (["board", "issues", "improve"].includes(p)) return set({ page: "work" });
    if (p === "todos") {
      const hit = get().nav.find((n) => n.component === "todos");
      return set({ page: hit ? viewPageId(hit.packId, hit.viewId) : "overview" });
    }
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
  defaultAgent: "",
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
        // Commands without a preview handler throw. In the browser demo, the whole screen
        // dying is far worse than an empty widget, so individual failures are swallowed.
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
        // Watcher bursts fire many events at once; collapse them into one batched re-read.
        clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void get().refreshImprovements();
          void get().refreshTodos();
          void get().refreshTree();
        }, 500);
        // The attention probe reads the whole vault. Even if watcher events pile up, scan only once.
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
      get().refreshAgents(),
      get().refreshRequirements(),
    ]);
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
    // If the screen being viewed vanished along with its pack, go home
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
  refreshTodos: async () => {
    const v = await api.listTodos().catch(() => null);
    if (v) set({ todos: v });
  },
  refreshJobs: async () => {
    const v = await api.listJobs().catch(() => null);
    if (v) set({ jobs: v });
  },
  refreshMissed: async () => {
    const v = await api.listMissed().catch(() => null);
    if (v) set({ missed: v });
  },
  refreshDiagnostics: async () => {
    const v = await api.diagnostics().catch(() => null);
    if (v) set({ diag: v });
  },
  refreshTree: async () => {
    const v = await api.listVaultTree().catch(() => null);
    if (v) set({ vaultTree: v });
  },
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
