import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, EVENTS } from "./api";
import type {
  ConfigView,
  Diagnostics,
  IssueNote,
  Job,
  MissedEntry,
  ProgressEntry,
  TodoSections,
  UnpromotedItem,
  VaultAudit,
  VaultNode,
} from "./types";

export type PageId = "home" | "improve" | "jobs" | "tasks" | "todos" | "docs" | "vault" | "plugin" | "settings";

interface AppState {
  page: PageId;
  setPage: (p: PageId) => void;

  config: ConfigView | null;
  diag: Diagnostics | null;
  improvements: IssueNote[];
  todos: TodoSections | null;
  jobs: Job[];
  progress: Record<string, ProgressEntry[]>;
  missed: MissedEntry[];
  vaultTree: VaultNode[];
  inboxCount: number;
  audit: VaultAudit | null;
  unpromoted: UnpromotedItem[];
  wizardOpen: boolean;

  init: () => Promise<void>;
  openWizard: () => void;
  closeWizard: () => void;
  refreshConfig: () => Promise<void>;
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
  setPage: (page) => set({ page }),

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
      await listen<{ missed: MissedEntry }>(EVENTS.scheduleMissed, () =>
        void get().refreshMissed(),
      ),
    );
    await Promise.all([
      get().refreshConfig(),
      get().refreshJobs(),
      get().refreshMissed(),
      get().refreshImprovements(),
      get().refreshTodos(),
      get().refreshTree(),
      get().refreshAudit(),
      get().refreshDiagnostics(),
    ]);
    const cfg = get().config;
    if (cfg && (!cfg.exists || cfg.vaultPath.length === 0)) {
      set({ wizardOpen: true });
    }
  },

  refreshConfig: async () => set({ config: await api.getConfig() }),
  refreshImprovements: async () => {
    const improvements = await api.listIssues();
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
