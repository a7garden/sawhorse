import { useEffect } from "react";
import {
  CalendarClock,
  LayoutDashboard,
  ListChecks,
  SquareTerminal,
  SquareCheckBig,
  FolderSearch,
  FileText,
  Settings,
  Monitor,
  Moon,
  Sun,
  Puzzle,
  Activity,
  Circle,
} from "lucide-react";
import { useApp, type PageId } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import HomePage from "@/pages/HomePage";
import ImprovePage from "@/pages/ImprovePage";
import JobsPage from "@/pages/JobsPage";
import TasksPage from "@/pages/TasksPage";
import TodosPage from "@/pages/TodosPage";
import DocsPage from "@/pages/DocsPage";
import SettingsPage from "@/pages/SettingsPage";
import VaultPage from "@/pages/VaultPage";
import PluginPage from "@/pages/PluginPage";

import SetupWizard from "@/pages/SetupWizard";

const NAV: {
  id: PageId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { id: "home", label: "홈", icon: LayoutDashboard },
  { id: "improve", label: "이슈", icon: ListChecks },
  { id: "jobs", label: "잡", icon: SquareTerminal },
  { id: "tasks", label: "작업", icon: CalendarClock },
  { id: "todos", label: "할 일", icon: SquareCheckBig },
  { id: "docs", label: "문서", icon: FileText },
  { id: "vault", label: "볼트", icon: FolderSearch },
  { id: "plugin", label: "플러그인", icon: Puzzle },
  { id: "settings", label: "설정", icon: Settings },
];

const NAV_GROUPS: { label: string; items: PageId[] }[] = [
  { label: "워크스페이스", items: ["home", "improve", "jobs", "todos"] },
  { label: "자료", items: ["docs", "vault", "plugin"] },
  { label: "시스템", items: ["settings"] },
];

const THEME_LABEL: Record<Theme, string> = {
  light: "라이트",
  dark: "다크",
  system: "시스템",
};

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const missedCount = useApp((s) => s.missed.length);
  const jobs = useApp((s) => s.jobs);
  const diag = useApp((s) => s.diag);
  const theme = useTheme((s) => s.theme);
  const resolved = useTheme((s) => s.resolved);
  const cycleTheme = useTheme((s) => s.cycle);
  const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const systemHealthy =
    !!diag?.vaultPathOk && !!diag?.claudeOk && diag.projects.every((p) => p.pathOk);

  useEffect(() => {
    void init();
  }, [init]);

  const body = (() => {
    switch (page) {
      case "home":
        return <HomePage />;
      case "improve":
        return <ImprovePage />;
      case "jobs":
        return <JobsPage />;
      case "tasks":
        return <TasksPage />;
      case "todos":
        return <TodosPage />;
      case "docs":
        return <DocsPage />;
      case "vault":
        return <VaultPage />;
      case "settings":
        return <SettingsPage />;
      case "plugin":
        return <PluginPage />;
    }
  })();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <aside className="flex w-[196px] shrink-0 flex-col border-r bg-sidebar p-3">
        <div className="mb-5 flex items-center gap-2.5 px-1 py-1">
          <div className="grid size-8 shrink-0 place-items-center rounded-xl bg-[var(--brand)] text-white shadow-sm">
            <Activity className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-bold tracking-tight">sawhorse</div>
            <div className="text-[10px] text-muted-foreground">Operations Console</div>
          </div>
        </div>

        <nav className="flex flex-col gap-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="mb-1 px-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
                {group.label}
              </div>
              <div className="space-y-0.5">
                {group.items.map((id) => {
                  const n = NAV.find((item) => item.id === id)!;
                  const count = id === "home" ? missedCount : id === "jobs" ? activeCount : 0;
                  return (
                    <button
                      key={n.id}
                      onClick={() => setPage(n.id)}
                      className={cn(
                        "group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium transition-colors",
                        page === n.id
                          ? "bg-[var(--brand-soft)] text-[var(--brand)]"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      {page === n.id && (
                        <span className="absolute -left-3 h-4 w-0.5 rounded-r bg-[var(--brand)]" />
                      )}
                      <n.icon className="size-3.5" />
                      {n.label}
                      {count > 0 && (
                        <span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning-foreground">
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="mt-auto space-y-2">
          <div className="rounded-xl border bg-card/70 p-2.5">
            <div className="flex items-center gap-2 text-[11px] font-medium">
              <Circle
                className={cn(
                  "size-2 fill-current",
                  systemHealthy ? "text-success" : "text-warning",
                )}
              />
              {diag == null ? "상태 확인 중" : systemHealthy ? "시스템 정상" : "확인 필요"}
            </div>
            <div className="mt-1 text-[9px] text-muted-foreground">
              {activeCount > 0 ? `${activeCount}개 작업 실행 중` : "실행 대기열 없음"}
            </div>
          </div>
          <div className="flex items-center justify-between px-1">
            <div className="text-[9px] text-muted-foreground">v0.1.0</div>
            <button
              onClick={cycleTheme}
              title={`테마: ${THEME_LABEL[theme]} (클릭하여 전환)`}
              aria-label="테마 전환"
              className="rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              {theme === "system" ? (
                <Monitor className="size-3.5" />
              ) : resolved === "dark" ? (
                <Moon className="size-3.5" />
              ) : (
                <Sun className="size-3.5" />
              )}
            </button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--workspace)]">{body}</main>
      <SetupWizard />
    </div>
  );
}
