// Pack manifests declare icons by kebab-case name. Pulling in all of lucide dynamically would
// drag the whole bundle in, so only the used ones are registered explicitly and unknown names
// fall back to a default icon. Packs needing a new icon add one line here — better than a silently blank slot.
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
