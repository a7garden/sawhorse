import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  CalendarDays,
  Bot,
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
  Workflow,
  FlaskConical,
  FolderSearch,
  FileStack,
  Library,
} from "lucide-react";
import { useApp, parseViewPage, viewPageId, type PageId } from "@/lib/store";
import { icon as packIcon, type IconComponent } from "@/lib/icons";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { Language } from "@/i18n";
import WorkbenchPage from "@/features/workbench/WorkbenchPage";
import { useProjectScope } from "@/features/workbench/project-scope";
import { ensureWorkspaceSnapshot, useWorkspaceSnapshot } from "@/features/workbench/snapshot-store";
import { isWorkbenchPreview } from "@/features/workbench/api";
import { AttentionStrip } from "@/components/AttentionStrip";
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
import JournalPage from "@/features/journal/JournalPage";
import PackViewPage from "@/pages/PackViewPage";
import TerminalPage from "@/pages/TerminalPage";
import SchemaStudioPage from "@/features/schema-studio/SchemaStudioPage";
import WorkflowStudioPage from "@/features/workflow-studio/WorkflowStudioPage";
import OnboardingPage from "@/pages/OnboardingPage";
import PdcDocumentsPage from "@/features/documents/PdcDocumentsPage";

import GitHubExtensionPage from "@/pages/GitHubExtensionPage";
import { DetailNavigation } from "@/components/DetailNavigation";
import { Toaster } from "@/components/ui/toast";
import SetupWizard from "@/pages/SetupWizard";
import { Select } from "@/components/ui/select";

/** Sidebar sections — the host owns the section list and order; pack views pick a section via the group tag. */
const SECTIONS: { id: string; labelKey: string }[] = [
  { id: "overview", labelKey: "nav.section.overview" },
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
  { id: "overview", labelKey: "nav.overview", icon: LayoutDashboard, group: "overview" },
  // Work is one lifecycle viewed as a list and a process board. Automation definitions are separate.
  { id: "work", labelKey: "nav.work", icon: KanbanSquare, group: "project-scope" },
  { id: "task-library", labelKey: "nav.taskLibrary", icon: Repeat, group: "work" },
  { id: "calendar", labelKey: "nav.calendar", icon: CalendarDays, group: "overview" },
  { id: "harness", labelKey: "nav.runs", icon: Bot, group: "project-scope" },
  { id: "knowledge", labelKey: "nav.workDocuments", icon: Search, group: "project-scope" },
  { id: "projects", labelKey: "nav.projects", icon: FolderGit2, group: "work" },
  { id: "project-library", labelKey: "nav.projectLibrary", icon: Library, group: "work" },
  // Workflows are a first-class product object, not an extension attachment. Primary entry in the work section.
  { id: "workflows", labelKey: "nav.workflows", icon: Workflow, group: "work" },
  // `실행` (runs) refers only to job and harness runs. If entry points were also named "runs",
  // six of them would share the same word.
  { id: "terminal", labelKey: "nav.terminal", icon: Terminal, group: "work" },
  { id: "docs", labelKey: "nav.docs", icon: FileText, group: "vault" },
  { id: "documents", labelKey: "nav.documents", icon: FileStack, group: "vault" },
  { id: "vault", labelKey: "nav.vault", icon: FolderSearch, group: "vault" },
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
      { id: "jobs", labelKey: "nav.tab.jobs" },
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

/** Host built-in screens that extensions attach to via `type: native`. */
const NATIVE: Record<string, () => JSX.Element> = {
  issues: () => <WorkbenchPage view="work" />,
  todos: TodosPage,
  docs: DocsPage,
};

const THEME_KEY: Record<Theme, string> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

/**
 * `nav.documents` keeps the common nav key path but is owned by the documents lane;
 * common.json is shared with concurrent lanes, so the label ships as a defaultValue
 * fallback here instead of an edit to that file.
 */
const NAV_LABEL_FALLBACKS: Record<string, Record<Language, string>> = {
  "nav.documents": { ko: "정문서", en: "Documents" },
};

/**
 * Module scope on purpose: a component defined inside App would remount the whole
 * sidebar (losing focus) on every App render.
 */
function NavButton({
  id,
  label,
  Icon,
  badge,
  active,
}: {
  id: PageId;
  label: string;
  Icon: IconComponent;
  badge?: number;
  active: boolean;
}) {
  const setPage = useApp((s) => s.setPage);
  return (
    <button
      onClick={() => {
        if (
          window.dispatchEvent(
            new Event("sawhorse:navigate", { cancelable: true }),
          )
        ) {
          setPage(id);
        }
      }}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={label}
      className={cn(
        "app-nav-item flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
        active
          ? "bg-secondary text-secondary-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <Icon className="size-3.5" />
      <span className="app-nav-label min-w-0 truncate">{label}</span>
      {badge != null && badge > 0 && (
        <span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

export default function App() {
  const contentRef = useRef<HTMLDivElement>(null);
  const page = useApp((s) => s.page);
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, left: 0 }); }, [page]);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const nav = useApp((s) => s.nav);
  const { t, i18n } = useTranslation("common");
  /** Nav keys owned by feature lanes resolve their label through defaultValue (see NAV_LABEL_FALLBACKS). */
  const navLabel = (key: string) => {
    const fallback = NAV_LABEL_FALLBACKS[key];
    return fallback
      ? t(key, { defaultValue: fallback[i18n.language as Language] ?? fallback.ko })
      : t(key);
  };
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("sawhorse.sidebar-collapsed") === "true"; }
    catch { return false; }
  });
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    try { localStorage.setItem("sawhorse.sidebar-collapsed", String(!current)); } catch { /* Optional preference. */ }
    return !current;
  });
  const navPage = page === "board" || page === "issues" ? "work" : page;
  const pageLabelKey = group?.tabs.find((tab) => tab.id === page)?.labelKey
    ?? TOP_NAV.find((item) => item.id === navPage)?.labelKey
    ?? BOTTOM_NAV.find((item) => item.id === page)?.labelKey;
  const pageLabel = navPage === "work" && !selectedProject ? t("nav.projectsOverview") : pageLabelKey ? navLabel(pageLabelKey) : nav.find((item) => viewPageId(item.packId, item.viewId) === page)?.label;
  const projectScoped = TOP_NAV.some((item) => item.id === (group?.root ?? navPage) && item.group === "project-scope");
  const changeProject = (id: string) => {
    if (!window.dispatchEvent(new Event("sawhorse:navigate", { cancelable: true }))) return;
    selectProject(id);
    // The project switch changes only the section below it. Global screens keep their context.
    if (!id && projectScoped) setPage("work");
  };

  useEffect(() => {
    void init();
    void ensureWorkspaceSnapshot();
    // The sidebar version's source of truth is tauri.conf.json — hand-copying it always drifts
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
      case "project-library":
      // Legacy entry points also route to the same work screen.
      case "issues":
        return <WorkbenchPage key={["board", "issues"].includes(page) ? "work" : page} view={page} />;
      case "github":
        return <GitHubExtensionPage />;
      case "docs":
        return <DocsPage />;
      case "documents":
        return <PdcDocumentsPage />;
      case "todos":
        return <TodosPage />;
      case "vault":
        return <VaultPage />;
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
    if (entry.packId === "journal" && entry.viewId === "logs") return <JournalPage />;
    return <PackViewPage packId={entry.packId} viewId={entry.viewId} />;
  })();

  return (
    <div className={cn("app-shell flex h-screen w-screen flex-col overflow-hidden", sidebarCollapsed && "is-sidebar-collapsed")}>
      <AppToolbar contextLabel={projectScoped ? selectedProject?.name ?? t("workbench:scope.all") : t("nav.section.overview")} pageLabel={pageLabel}
        sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
      <div className="app-body flex min-h-0 flex-1 overflow-hidden">
      <aside className="app-sidebar">
        <nav className="app-navigation">
          {SECTIONS.map(({ id, labelKey }) => {
            const core = TOP_NAV.filter(
              (n) =>
                n.group === id && (id !== "project-scope" || !!selectedProject || n.id === "work") &&
                (n.id !== "reading" || coreExtensions.feeds) &&
                (n.id !== "github" || coreExtensions.githubInstalled),
            );
            const packViews = nav.filter(
              (n) =>
                id !== "project-scope" && n.group === id &&
                !["issues", "docs"].includes(n.component),
            );
            if (id === "vault") {
              const order = (label: string) =>
                (({ 일지: 10, 개념: 20, 점검: 30 }) as Record<string, number>)[
                  label
                ] ?? 50;
              packViews.sort((a, b) => order(a.label) - order(b.label));
            }
            if (core.length === 0 && packViews.length === 0 && id !== "project-scope") return null;
            return (
              <section
                key={id}
                aria-label={t(labelKey)}
                data-nav-scope={id === "project-scope" ? "project" : "workspace"}
                className={cn("app-nav-section", id === "work" && "app-workspace-section", id === "project-scope" && "app-project-section")}
              >
                <div className="app-section-caption">
                  <span>{t(labelKey)}</span>
                </div>
                {id === "project-scope" && <div className="app-project-picker" title={selectedProject?.name ?? t("nav.scope.choose")}>
                  <Select size="sm" variant="sidebar" leadingIcon={<FolderGit2 size={16} />} className="w-full min-w-0"
                    aria-label={t("nav.scope.select")} value={selectedProject?.id ?? ""} disabled={!snapshot}
                    options={[{ value: "", label: t("nav.scope.choose") }, ...(snapshot?.projects ?? []).map((project) => ({ value: project.id, label: project.name }))]}
                    onChange={changeProject} />
                  {selectedProject && <p className="app-project-workflow">{snapshot?.workflows.find((flow) => flow.id === selectedProject.workflowId && flow.version === selectedProject.workflowVersion)?.label ?? selectedProject.workflowId}</p>}
                </div>}
                {id === "project-scope" && !selectedProject && <>
                  <p className="app-project-hint">{t("nav.scope.chooseHint")}</p>
                </>}
                {core.map((n) => (
                  <NavButton
                    key={n.id}
                    id={n.id}
                    label={n.id === "work" && !selectedProject ? t("nav.projectsOverview") : navLabel(n.labelKey)}
                    Icon={n.icon}
                    active={navPage === n.id || group?.root === n.id}
                  />
                ))}
                {packViews.map((n) => {
                  const id = viewPageId(n.packId, n.viewId);
                  return (
                    <NavButton
                      key={`${n.packId}:${n.viewId}`}
                      id={id}
                      label={n.label}
                      Icon={packIcon(n.icon)}
                      active={navPage === id || group?.root === id}
                    />
                  );
                })}
              </section>
            );
          })}

          {nav.some(
            (n) =>
              !["issues", "docs"].includes(n.component) &&
              !SECTIONS.some((s) => s.id !== "project-scope" && s.id === n.group),
          ) && (
            <Fragment>
              <div className="app-section-caption">
                {t("nav.other")}<span>{t("nav.scope.shared")}</span>
              </div>
              {nav
                .filter(
                  (n) =>
                    !["issues", "docs"].includes(n.component) &&
                    !SECTIONS.some((s) => s.id !== "project-scope" && s.id === n.group),
                )
                .map((n) => {
                  const id = viewPageId(n.packId, n.viewId);
                  return (
                    <NavButton
                      key={`${n.packId}:${n.viewId}`}
                      id={id}
                      label={n.label}
                      Icon={packIcon(n.icon)}
                      active={navPage === id || group?.root === id}
                    />
                  );
                })}
            </Fragment>
          )}

          <div className="app-nav-settings">
          {BOTTOM_NAV.map((n) => (
            <NavButton
              key={n.id}
              id={n.id}
              label={t(n.labelKey)}
              Icon={n.icon}
              badge={n.id === "packs" ? brokenCount : undefined}
              active={navPage === n.id || group?.root === n.id}
            />
          ))}
          </div>
        </nav>
        <div className="app-sidebar-footer">
          <div className="app-version">
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
        <DetailNavigation />
        {group && (
          <div
            className="app-page-tabs flex shrink-0 flex-wrap gap-1 border-b bg-background px-5 py-2"
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
        <AttentionStrip />
        <div ref={contentRef} className="app-content min-h-0 flex-1 overflow-y-auto">
          {isWorkbenchPreview && (
            <div className="app-preview-notice">
              <FlaskConical size={13} aria-hidden />
              {t("nav.previewNotice")}
            </div>
          )}
          {body}
        </div>
      </main>
      </div>
      <SetupWizard />
      <Toaster />
    </div>
  );
}
