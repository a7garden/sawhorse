import { useEffect } from "react";
import {
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
} from "lucide-react";
import { useApp, type PageId } from "@/lib/store";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import HomePage from "@/pages/HomePage";
import ImprovePage from "@/pages/ImprovePage";
import JobsPage from "@/pages/JobsPage";
import TodosPage from "@/pages/TodosPage";
import DocsPage from "@/pages/DocsPage";
import SettingsPage from "@/pages/SettingsPage";
import VaultPage from "@/pages/VaultPage";
import PluginPage from "@/pages/PluginPage";

import SetupWizard from "@/pages/SetupWizard";

const NAV: { id: PageId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "home", label: "홈", icon: LayoutDashboard },
  { id: "improve", label: "이슈", icon: ListChecks },
  { id: "jobs", label: "작업", icon: SquareTerminal },
  { id: "todos", label: "할 일", icon: SquareCheckBig },
  { id: "docs", label: "문서", icon: FileText },
  { id: "vault", label: "볼트", icon: FolderSearch },
  { id: "plugin", label: "플러그인", icon: Puzzle },
  { id: "settings", label: "설정", icon: Settings },
];

const THEME_LABEL: Record<Theme, string> = { light: "라이트", dark: "다크", system: "시스템" };

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const missedCount = useApp((s) => s.missed.length);
  const theme = useTheme((s) => s.theme);
  const resolved = useTheme((s) => s.resolved);
  const cycleTheme = useTheme((s) => s.cycle);

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
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="flex w-40 shrink-0 flex-col border-r bg-sidebar px-2 py-3">
        <div className="mb-3 px-2">
          <div className="text-[13px] font-bold leading-tight">si-workbench</div>
          <div className="text-[10px] text-muted-foreground">운영 대시보드</div>
        </div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setPage(n.id)}
              className={cn(
                "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors",
                page === n.id
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <n.icon className="size-3.5" />
              {n.label}
              {n.id === "home" && missedCount > 0 && (
                <span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning-foreground">
                  {missedCount}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="mt-auto flex items-center justify-between px-2">
          <div className="text-[10px] text-muted-foreground">v0.1.0</div>
          <button
            onClick={cycleTheme}
            title={`테마: ${THEME_LABEL[theme]} (클릭하여 전환)`}
            aria-label="테마 전환"
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{body}</main>
      <SetupWizard />
    </div>
  );
}
