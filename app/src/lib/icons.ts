// 팩 매니페스트가 아이콘을 kebab-case 이름으로 선언한다. lucide 전체를 동적으로 끌어오면
// 번들이 통째로 들어오므로, 쓰는 것만 명시적으로 등록하고 모르는 이름은 기본 아이콘으로 떨어진다.
// 새 아이콘이 필요한 팩은 여기 한 줄을 더한다 — 조용히 빈 칸이 되는 것보다 낫다.
import {
  BookMarked,
  Bot,
  Briefcase,
  Bug,
  CalendarDays,
  ChartLine,
  CircleCheckBig,
  FileText,
  Flag,
  FolderSearch,
  Inbox,
  LayoutDashboard,
  ListChecks,
  NotebookPen,
  Package,
  Puzzle,
  Settings,
  SquareCheckBig,
  SquareTerminal,
  StickyNote,
  Users,
  Wrench,
} from "lucide-react";

export type IconComponent = React.ComponentType<{ className?: string }>;

const ICONS: Record<string, IconComponent> = {
  "book-marked": BookMarked,
  bot: Bot,
  briefcase: Briefcase,
  bug: Bug,
  "calendar-days": CalendarDays,
  "chart-line": ChartLine,
  "circle-check-big": CircleCheckBig,
  "file-text": FileText,
  flag: Flag,
  "folder-search": FolderSearch,
  inbox: Inbox,
  "layout-dashboard": LayoutDashboard,
  "list-checks": ListChecks,
  "notebook-pen": NotebookPen,
  package: Package,
  puzzle: Puzzle,
  settings: Settings,
  "square-check-big": SquareCheckBig,
  "square-terminal": SquareTerminal,
  "sticky-note": StickyNote,
  users: Users,
  wrench: Wrench,
};

export function icon(name: string): IconComponent {
  return ICONS[name] ?? Package;
}
