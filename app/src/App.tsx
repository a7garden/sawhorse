import { Fragment, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  CalendarDays,
  Bot,
  History,
  Search,
  KanbanSquare,
  FolderGit2,
  LayoutDashboard,
  Newspaper,
  Terminal,
  Settings,
  Monitor,
  Moon,
  Sun,
  Puzzle,
  FileText,
  Github,
  Repeat,
  SquareCheckBig,
  Workflow,
} from "lucide-react";
import { useApp, parseViewPage, viewPageId, type PageId } from "@/lib/store";
import { icon as packIcon, type IconComponent } from "@/lib/icons";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import appIcon from "../src-tauri/icons/icon.svg";
import WorkbenchPage from "@/features/workbench/WorkbenchPage";
import { useProjectScope } from "@/features/workbench/project-scope";
import { ensureWorkspaceSnapshot, useWorkspaceSnapshot } from "@/features/workbench/snapshot-store";
import { isWorkbenchPreview } from "@/features/workbench/api";
import { AppToolbar } from "@/components/AppToolbar";
import { useCoreExtensions } from "@/lib/core-extensions";
import JobsPage from "@/pages/JobsPage";
import TasksPage from "@/pages/TasksPage";
import TodosPage from "@/pages/TodosPage";
import DocsPage from "@/pages/DocsPage";
import SettingsPage from "@/pages/SettingsPage";
import SessionsPage from "@/pages/SessionsPage";
import ReviewPage from "@/pages/ReviewPage";
import SourcesPage from "@/pages/SourcesPage";
import ReadingPage from "@/pages/ReadingPage";
import VaultPage from "@/pages/VaultPage";
import PacksPage from "@/pages/PacksPage";
import PackViewPage from "@/pages/PackViewPage";
import TerminalPage from "@/pages/TerminalPage";
import SchemaStudioPage from "@/features/schema-studio/SchemaStudioPage";
import WorkflowStudioPage from "@/features/workflow-studio/WorkflowStudioPage";
import OnboardingPage from "@/pages/OnboardingPage";

import GitHubExtensionPage from "@/pages/GitHubExtensionPage";
import { DetailNavigation } from "@/components/DetailNavigation";
import { Toaster } from "@/components/ui/toast";
import { Select } from "@/components/ui/select";
import SetupWizard from "@/pages/SetupWizard";

/** 사이드바 섹션 — 호스트가 섹션 목록·순서를 소유하고, 팩 뷰는 group 태그로 섹션을 고른다. */
const SECTIONS: { id: string; labelKey: string }[] = [
  { id: "project-scope", labelKey: "nav.section.project" },
  { id: "work", labelKey: "nav.section.work" },
  { id: "vault", labelKey: "nav.section.vault" },
  { id: "reading", labelKey: "nav.section.reading" },
];
const TOP_NAV: {
  id: PageId;
  labelKey: string;
  icon: IconComponent;
  group: string;
}[] = [
  { id: "overview", labelKey: "nav.overview", icon: LayoutDashboard, group: "project-scope" },
  // 작업은 하나의 생명주기를 목록과 공정 보드로 본다. 자동화 정의는 별도다.
  { id: "work", labelKey: "nav.work", icon: KanbanSquare, group: "project-scope" },
  { id: "task-library", labelKey: "nav.taskLibrary", icon: Repeat, group: "work" },
  { id: "calendar", labelKey: "nav.calendar", icon: CalendarDays, group: "project-scope" },
  { id: "harness", labelKey: "nav.tab.harness", icon: Bot, group: "project-scope" },
  { id: "jobs", labelKey: "nav.tab.jobs", icon: History, group: "project-scope" },
  { id: "knowledge", labelKey: "nav.workDocuments", icon: Search, group: "project-scope" },
  { id: "projects", labelKey: "nav.projects", icon: FolderGit2, group: "work" },
  // 워크플로우는 확장의 부속이 아니라 제품의 주인 객체다. 작업 섹션의 1급 진입점.
  { id: "workflows", labelKey: "nav.workflows", icon: Workflow, group: "work" },
  // `실행` 은 잡·하네스 런 한 가지만 가리킨다. 진입점 이름까지 실행이면 여섯 개가
  // 같은 낱말을 쓴다.
  { id: "terminal", labelKey: "nav.terminal", icon: Terminal, group: "work" },
  { id: "docs", labelKey: "nav.docs", icon: FileText, group: "vault" },
  { id: "todos", labelKey: "nav.todos", icon: SquareCheckBig, group: "vault" },
  { id: "reading", labelKey: "nav.reading", icon: Newspaper, group: "reading" },
  { id: "github", labelKey: "nav.github", icon: Github, group: "reading" },
  { id: "packs", labelKey: "nav.packs", icon: Puzzle, group: "reading" },
];
const PAGE_GROUPS = [
  {
    root: "task-library",
    tabs: [
      { id: "task-library", labelKey: "nav.tab.taskLibrary" },
      { id: "tasks", labelKey: "nav.tab.tasks" },
    ],
  },
  {
    root: "terminal",
    tabs: [
      { id: "terminal", labelKey: "nav.tab.terminal" },
      { id: "sessions", labelKey: "nav.tab.sessions" },
      { id: "review", labelKey: "nav.tab.review" },
    ],
  },
];

const BOTTOM_NAV: { id: PageId; labelKey: string; icon: IconComponent }[] = [
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

/** 선언형 뷰로 옮기지 않은 화면들. 팩이 `type: native` 로 이 이름을 가리킨다. */
const NATIVE: Record<string, () => JSX.Element> = {
  issues: () => <WorkbenchPage view="work" />,
  todos: TodosPage,
  docs: DocsPage,
  vault: VaultPage,
};

const THEME_KEY: Record<Theme, string> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const nav = useApp((s) => s.nav);
  const { t } = useTranslation("common");
  const snapshot = useWorkspaceSnapshot((state) => state.snapshot);
  const selectedProjectId = useProjectScope((state) => state.projectId);
  const selectProject = useProjectScope((state) => state.selectProject);
  const selectedProject = snapshot?.projects.find((project) => project.id === selectedProjectId);
  const coreExtensions = useCoreExtensions();
  const groups = PAGE_GROUPS;
  const group = groups.find((g) => g.tabs.some((tab) => tab.id === page));
  const brokenCount = useApp((s) => s.packs?.broken.length ?? 0);
  const [version, setVersion] = useState("");
  const theme = useTheme((s) => s.theme);
  const resolved = useTheme((s) => s.resolved);
  const cycleTheme = useTheme((s) => s.cycle);

  useEffect(() => {
    void init();
    void ensureWorkspaceSnapshot();
    // 사이드바 버전은 tauri.conf.json 이 정본이다 — 손으로 적으면 반드시 어긋난다
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [init]);

  useEffect(() => {
    if (snapshot && selectedProjectId && !selectedProject) selectProject("");
  }, [snapshot, selectedProjectId, selectedProject, selectProject]);

  const body = (() => {
    switch (page) {
      case "work":
      case "overview":
      case "board":
      case "calendar":
      case "harness":
      case "knowledge":
      case "projects":
      // 과거 진입점도 같은 작업 화면으로 연결한다.
      case "issues":
        return <WorkbenchPage key={["board", "issues"].includes(page) ? "work" : page} view={page} />;
      case "github":
        return <GitHubExtensionPage />;
      case "docs":
        return <DocsPage />;
      case "todos":
        return <TodosPage />;
      case "schemas":
        return <SchemaStudioPage />;
      case "workflows":
        return <WorkflowStudioPage />;
      case "onboarding":
        return <OnboardingPage />;
      case "home":
      case "task-library":
        return <TasksPage mode="library" />;
      case "jobs":
        return <JobsPage />;
      case "terminal":
        return <TerminalPage />;
      case "sessions":
        return <SessionsPage />;
      case "review":
        return <ReviewPage />;
      case "sources":
        return <SourcesPage scope="rss" />;
      case "reading":
        return <ReadingPage />;
      case "packs":
        return <PacksPage />;
      case "tasks":
        return <TasksPage mode="schedules" />;
      case "settings":
        return <SettingsPage />;
    }
    const parsed = parseViewPage(page);
    if (!parsed) return <WorkbenchPage view="overview" />;
    const entry = nav.find(
      (n) => n.packId === parsed.packId && n.viewId === parsed.viewId,
    );
    if (!entry) return <WorkbenchPage view="overview" />;
    if (entry.type === "native") {
      const Native = NATIVE[entry.component];
      return Native ? <Native /> : <WorkbenchPage view="overview" />;
    }
    return <PackViewPage packId={entry.packId} viewId={entry.viewId} />;
  })();

  function NavButton({
    id,
    label,
    Icon,
    badge,
  }: {
    id: PageId;
    label: string;
    Icon: IconComponent;
    badge?: number;
  }) {
    const active = page === id || group?.root === id;
    return (
      <button
        onClick={() => {
          if (
            window.dispatchEvent(
              new Event("sawhorse:navigate", { cancelable: true }),
            )
          )
            setPage(id);
        }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
          active
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}
      >
        <Icon className="size-3.5" />
        <span className="min-w-0 truncate">{label}</span>
        {badge != null && badge > 0 && (
          <span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning-foreground">
            {badge}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <aside className="app-sidebar flex w-[208px] shrink-0 flex-col border-r bg-sidebar px-3 py-5">
        <div className="mb-6 flex items-center gap-2.5 px-2">
          <img src={appIcon} alt="" className="size-8 shrink-0" />
          <div className="text-[16px] font-bold tracking-tight leading-tight">
            sawhorse
          </div>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {SECTIONS.map(({ id, labelKey }, index) => {
            const core = TOP_NAV.filter(
              (n) =>
                n.group === id &&
                (n.id !== "reading" || coreExtensions.feeds) &&
                (n.id !== "github" || coreExtensions.githubInstalled),
            );
            const packViews = nav.filter(
              (n) =>
                id !== "project-scope" && n.group === id &&
                !["issues", "todos", "docs"].includes(n.component),
            );
            if (id === "vault") {
              const order = (label: string) =>
                (({ 일지: 10, 개념: 20, 점검: 30 }) as Record<string, number>)[
                  label
                ] ?? 50;
              packViews.sort((a, b) => order(a.label) - order(b.label));
            }
            if (core.length === 0 && packViews.length === 0) return null;
            return (
              <section
                key={id}
                aria-label={t(labelKey)}
                data-nav-scope={id === "project-scope" ? "project" : "workspace"}
                className={cn("flex shrink-0 flex-col gap-0.5", index > 0 && "mt-5", index === 1 && "border-t border-border/60 pt-4")}
              >
                <div className="mb-1 flex items-center justify-between gap-2 px-2 pt-1 text-[10px] font-semibold tracking-wider text-muted-foreground">
                  <span>{t(labelKey)}</span>
                  {id !== "project-scope" && <span className="text-[9px] font-normal tracking-normal text-muted-foreground/60">{t("nav.scope.shared")}</span>}
                </div>
                {id === "project-scope" && (
                  <div className="mb-2">
                    <label htmlFor="sidebar-project" className="sr-only">{t("nav.scope.select")}</label>
                    <Select
                      id="sidebar-project"
                      size="sm"
                      variant="sidebar"
                      leadingIcon={<FolderGit2 className="size-4" />}
                      className="w-full min-w-0"
                      disabled={!snapshot}
                      aria-label={t("nav.scope.select")}
                      value={selectedProject?.id ?? ""}
                      options={[
                        { value: "", label: t("workbench:scope.all") },
                        ...(snapshot?.projects.map((project) => ({ value: project.id, label: project.name })) ?? []),
                      ]}
                      onChange={(next) => {
                        if (window.dispatchEvent(new Event("sawhorse:navigate", { cancelable: true }))) selectProject(next);
                      }}
                    />
                    <p className="mt-1.5 px-2 text-[10px] leading-relaxed text-muted-foreground/70">{t("nav.scope.appliesBelow")}</p>
                  </div>
                )}
                {core.map((n) => (
                  <NavButton
                    key={n.id}
                    id={n.id}
                    label={t(n.labelKey)}
                    Icon={n.icon}
                  />
                ))}
                {packViews.map((n) => (
                  <NavButton
                    key={`${n.packId}:${n.viewId}`}
                    id={viewPageId(n.packId, n.viewId)}
                    label={n.label}
                    Icon={packIcon(n.icon)}
                  />
                ))}
              </section>
            );
          })}

          {nav.some(
            (n) =>
              !["issues", "todos", "docs"].includes(n.component) &&
              !SECTIONS.some((s) => s.id !== "project-scope" && s.id === n.group),
          ) && (
            <Fragment>
              <div className="mb-1 mt-4 flex items-center justify-between px-2 text-[10px] font-semibold tracking-wider text-muted-foreground">
                {t("nav.other")}<span>{t("nav.scope.shared")}</span>
              </div>
              {nav
                .filter(
                  (n) =>
                    !["issues", "todos", "docs"].includes(n.component) &&
                    !SECTIONS.some((s) => s.id !== "project-scope" && s.id === n.group),
                )
                .map((n) => (
                  <NavButton
                    key={`${n.packId}:${n.viewId}`}
                    id={viewPageId(n.packId, n.viewId)}
                    label={n.label}
                    Icon={packIcon(n.icon)}
                  />
                ))}
            </Fragment>
          )}

          <div className="my-1.5 h-px bg-border" />
          <div className="px-2 text-[10px] text-muted-foreground">{t("nav.scope.sharedSettings")}</div>
          {BOTTOM_NAV.map((n) => (
            <NavButton
              key={n.id}
              id={n.id}
              label={t(n.labelKey)}
              Icon={n.icon}
              badge={n.id === "packs" ? brokenCount : undefined}
            />
          ))}
        </nav>
        <div className="mt-2 flex items-center justify-between px-2">
          <div className="text-[10px] text-muted-foreground">
            {version ? `v${version}` : ""}
          </div>
          <button
            onClick={cycleTheme}
            title={t("nav.themeTitle", { theme: t(THEME_KEY[theme]) })}
            aria-label={t("nav.themeToggle")}
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
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--workspace)]">
        <AppToolbar />
        <DetailNavigation />
        {group && (
          <div
            className="flex shrink-0 flex-wrap gap-1 border-b bg-background px-5 py-2"
            aria-label={t("nav.viewPicker")}
          >
            {group.tabs.map((tab) => (
              <button
                key={tab.id}
                aria-current={page === tab.id ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-2 text-xs",
                  page === tab.id
                    ? "bg-secondary font-semibold"
                    : "text-muted-foreground hover:bg-accent",
                )}
                onClick={() => {
                  if (
                    window.dispatchEvent(
                      new Event("sawhorse:navigate", { cancelable: true }),
                    )
                  )
                    setPage(tab.id);
                }}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isWorkbenchPreview && (
            <div className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900">
              {t("nav.previewNotice")}
            </div>
          )}
          {body}
        </div>
      </main>
      <SetupWizard />
      <Toaster />
    </div>
  );
}
