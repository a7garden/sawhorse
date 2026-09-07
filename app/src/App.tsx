import { Fragment, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  CalendarDays,
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
  CircleDot,
  FileText,
  Github,
} from "lucide-react";
import { useApp, parseViewPage, viewPageId, type PageId } from "@/lib/store";
import { icon as packIcon, type IconComponent } from "@/lib/icons";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import appIcon from "../src-tauri/icons/icon.svg";
import WorkbenchPage from "@/features/workbench/WorkbenchPage";
import { isWorkbenchPreview } from "@/features/workbench/api";
import { AppToolbar } from "@/components/AppToolbar";
import { useCoreExtensions } from "@/lib/core-extensions";
import ImprovePage from "@/pages/ImprovePage";
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
import SetupWizard from "@/pages/SetupWizard";

/** 사이드바 섹션 — 호스트가 섹션 목록·순서를 소유하고, 팩 뷰는 group 태그로 섹션을 고른다. */
const SECTIONS = [
  { id: "work", label: "작업공간" },
  { id: "vault", label: "볼트" },
  { id: "reading", label: "확장 기능" },
];
const TOP_NAV: {
  id: PageId;
  label: string;
  icon: IconComponent;
  group: string;
}[] = [
  { id: "overview", label: "작업대", icon: LayoutDashboard, group: "work" },
  { id: "board", label: "작업", icon: KanbanSquare, group: "work" },
  { id: "calendar", label: "캘린더", icon: CalendarDays, group: "work" },
  { id: "projects", label: "프로젝트", icon: FolderGit2, group: "work" },
  { id: "issues", label: "이슈", icon: CircleDot, group: "work" },
  { id: "terminal", label: "실행", icon: Terminal, group: "work" },
  { id: "docs", label: "모든 문서", icon: FileText, group: "vault" },
  { id: "reading", label: "읽을거리", icon: Newspaper, group: "reading" },
  { id: "github", label: "GitHub", icon: Github, group: "reading" },
  { id: "packs", label: "확장 관리", icon: Puzzle, group: "reading" },
];
const PAGE_GROUPS = [
  {
    root: "board",
    tabs: [
      { id: "board", label: "작업 보드" },
      { id: "todos", label: "오늘 할 일" },
      { id: "task-library", label: "실행할 작업" },
      { id: "tasks", label: "예약과 반복" },
    ],
  },
  {
    root: "terminal",
    tabs: [
      { id: "terminal", label: "에이전트 터미널" },
      { id: "harness", label: "작업 실행" },
      { id: "sessions", label: "협업 세션" },
      { id: "jobs", label: "실행 기록" },
      { id: "review", label: "검토" },
    ],
  },
];

const BOTTOM_NAV: { id: PageId; label: string; icon: IconComponent }[] = [
  { id: "settings", label: "설정", icon: Settings },
];

/** 선언형 뷰로 옮기지 않은 화면들. 팩이 `type: native` 로 이 이름을 가리킨다. */
const NATIVE: Record<string, () => JSX.Element> = {
  issues: ImprovePage,
  todos: TodosPage,
  docs: DocsPage,
  vault: VaultPage,
};

const THEME_LABEL: Record<Theme, string> = {
  light: "라이트",
  dark: "다크",
  system: "시스템",
};

export default function App() {
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const init = useApp((s) => s.init);
  const nav = useApp((s) => s.nav);
  const coreExtensions = useCoreExtensions();
  const groups = PAGE_GROUPS;
  const group = groups.find((g) => g.tabs.some((t) => t.id === page));
  const brokenCount = useApp((s) => s.packs?.broken.length ?? 0);
  const [version, setVersion] = useState("");
  const theme = useTheme((s) => s.theme);
  const resolved = useTheme((s) => s.resolved);
  const cycleTheme = useTheme((s) => s.cycle);

  useEffect(() => {
    void init();
    // 사이드바 버전은 tauri.conf.json 이 정본이다 — 손으로 적으면 반드시 어긋난다
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, [init]);

  const body = (() => {
    switch (page) {
      case "overview":
      case "board":
      case "calendar":
      case "harness":
      case "knowledge":
      case "projects":
        return <WorkbenchPage key={page} view={page} />;
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
      case "issues":
        return <ImprovePage />;
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
    const active =
      page === id ||
      group?.root === id ||
      (
        {
          workflows: "packs",
          schemas: "settings",
          onboarding: "projects",
        } as Record<string, string>
      )[page] === id;
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
        className={cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
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
          {SECTIONS.map(({ id, label }, index) => {
            const core = TOP_NAV.filter(
              (n) =>
                n.group === id &&
                (n.id !== "reading" || coreExtensions.feeds) &&
                (n.id !== "github" || coreExtensions.githubInstalled),
            );
            const packViews = nav.filter(
              (n) =>
                n.group === id &&
                !["issues", "todos", "docs"].includes(n.component),
            );
            if (id === "vault") {
              const order = (label: string) =>
                ({ 일지: 10, 개념: 20, 점검: 30 } as Record<string, number>)[
                  label
                ] ?? 50;
              packViews.sort((a, b) => order(a.label) - order(b.label));
            }
            if (core.length === 0 && packViews.length === 0) return null;
            return (
              <Fragment key={id}>
                <div
                  className={
                    index === 0
                      ? "mb-2 px-2 text-[10px] font-semibold tracking-wider text-muted-foreground"
                      : "mb-1 mt-4 px-2 text-[10px] font-semibold tracking-wider text-muted-foreground"
                  }
                >
                  {label}
                </div>
                {core.map((n) => (
                  <NavButton
                    key={n.id}
                    id={n.id}
                    label={n.label}
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
              </Fragment>
            );
          })}

          {nav.some(
            (n) =>
              !["issues", "todos", "docs"].includes(n.component) &&
              !SECTIONS.some((s) => s.id === n.group),
          ) && (
            <Fragment>
              <div className="mb-1 mt-4 px-2 text-[10px] font-semibold tracking-wider text-muted-foreground">
                기타
              </div>
              {nav
                .filter(
                  (n) =>
                    !["issues", "todos", "docs"].includes(n.component) &&
                    !SECTIONS.some((s) => s.id === n.group),
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
          {BOTTOM_NAV.map((n) => (
            <NavButton
              key={n.id}
              id={n.id}
              label={n.label}
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
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--workspace)]">
        <AppToolbar />
        <DetailNavigation />
        {group && (
          <div
            className="flex shrink-0 flex-wrap gap-1 border-b bg-background px-5 py-2"
            aria-label="화면 선택"
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
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {isWorkbenchPreview && (
            <div className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900">
              브라우저 체험 · 예제 데이터는 이 브라우저에만 저장됩니다. 실제
              에이전트와 파일은 데스크톱 앱에서 연결됩니다.
            </div>
          )}
          {body}
        </div>
      </main>
      <SetupWizard />
    </div>
  );
}
