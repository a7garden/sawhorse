import { Fragment, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  CalendarClock,
  CalendarDays,
  KanbanSquare,
  BookOpen,
  FolderGit2,
  Workflow,

  ClipboardCheck,
  LayoutDashboard,
  Network,
  Newspaper,
  Rss,
  SquareTerminal,
  Terminal,
  Settings,
  Monitor,
  Moon,
  Sun,
  Puzzle,
  Braces,
  FolderInput,
} from "lucide-react";
import { useApp, parseViewPage, viewPageId, type PageId } from "@/lib/store";
import { icon as packIcon, type IconComponent } from "@/lib/icons";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import appIcon from "../src-tauri/icons/icon.svg";
import WorkbenchPage from "@/features/workbench/WorkbenchPage";
import { isWorkbenchPreview } from "@/features/workbench/api";
import HomePage from "@/pages/HomePage";
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

import SetupWizard from "@/pages/SetupWizard";

/** 사이드바 섹션 — 호스트가 섹션 목록·순서를 소유하고, 팩 뷰는 group 태그로 섹션을 고른다. */
const SECTIONS: { id: string; label: string }[] = [
  { id: "work", label: "작업" },
  { id: "execution", label: "실행" },
  { id: "vault", label: "볼트" },
  { id: "reading", label: "정보" },
  { id: "automation", label: "자동화" },
];

const TOP_NAV: { id: PageId; label: string; icon: IconComponent; group: string }[] = [
  // 작업 — 매일 하는 일
  { id: "overview", label: "작업대", icon: LayoutDashboard, group: "work" },
  { id: "board", label: "백로그", icon: KanbanSquare, group: "work" },
  { id: "calendar", label: "캘린더", icon: CalendarDays, group: "work" },
  { id: "projects", label: "프로젝트", icon: FolderGit2, group: "work" },
  // 실행 — 일을 돌리는 장치
  { id: "workflows", label: "워크플로", icon: Workflow, group: "execution" },
  { id: "harness", label: "에이전트 하네스", icon: Workflow, group: "execution" },
  { id: "review", label: "검토", icon: ClipboardCheck, group: "execution" },
  { id: "jobs", label: "실행 큐", icon: SquareTerminal, group: "execution" },
  { id: "sessions", label: "세션", icon: Network, group: "execution" },
  { id: "terminal", label: "터미널", icon: Terminal, group: "execution" },
  // 볼트 — 내용과 그 구조
  { id: "knowledge", label: "기록과 지식", icon: BookOpen, group: "vault" },
  { id: "schemas", label: "스키마", icon: Braces, group: "vault" },
  { id: "onboarding", label: "프로젝트 가져오기", icon: FolderInput, group: "vault" },
  // 정보 — 받아서 읽는 것
  { id: "sources", label: "소스", icon: Rss, group: "reading" },
  { id: "reading", label: "읽을거리", icon: Newspaper, group: "reading" },
  // 자동화 — 시간이 일을 시키는 것
  { id: "home", label: "루틴", icon: CalendarClock, group: "automation" },
  { id: "tasks", label: "예약", icon: CalendarClock, group: "automation" },
];

const BOTTOM_NAV: { id: PageId; label: string; icon: IconComponent }[] = [
  { id: "packs", label: "확장", icon: Puzzle },
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
  const missedCount = useApp((s) => s.missed.length);
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
      case "schemas":
        return <SchemaStudioPage />;
      case "workflows":
        return <WorkflowStudioPage />;
      case "onboarding":
        return <OnboardingPage />;
      case "home":
        return <HomePage />;
      case "jobs":
        return <JobsPage />;
      case "terminal":
        return <TerminalPage />;
      case "sessions":
        return <SessionsPage />;
      case "review":
        return <ReviewPage />;
      case "sources":
        return <SourcesPage />;
      case "reading":
        return <ReadingPage />;
      case "packs":
        return <PacksPage />;
      case "tasks":
        return <TasksPage />;
      case "settings":
        return <SettingsPage />;
    }
    const parsed = parseViewPage(page);
    if (!parsed) return <HomePage />;
    const entry = nav.find(
      (n) => n.packId === parsed.packId && n.viewId === parsed.viewId,
    );
    if (!entry) return <HomePage />;
    if (entry.type === "native") {
      const Native = NATIVE[entry.component];
      return Native ? <Native /> : <HomePage />;
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
          page === id
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
            const core = TOP_NAV.filter((n) => n.group === id);
            const packViews = nav.filter((n) => n.group === id);
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
                    badge={n.id === "home" ? missedCount : undefined}
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

          {nav.some((n) => !SECTIONS.some((s) => s.id === n.group)) && (
            <Fragment>
              <div className="mb-1 mt-4 px-2 text-[10px] font-semibold tracking-wider text-muted-foreground">
                기타
              </div>
              {nav
                .filter((n) => !SECTIONS.some((s) => s.id === n.group))
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
      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--workspace)]">
        {isWorkbenchPreview && (
          <div className="border-b border-amber-300 bg-amber-50 px-5 py-2 text-xs text-amber-900">
            브라우저 체험 · 예제 데이터는 이 브라우저에만 저장됩니다. 실제
            에이전트와 파일은 데스크톱 앱에서 연결됩니다.
          </div>
        )}
        {body}
      </main>
      <SetupWizard />
    </div>
  );
}
