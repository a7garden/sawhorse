import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { sddApi } from "@/features/workbench/api";
import type { HarnessRun } from "@/features/workbench/types";
import type { PendingTaskRequest } from "@/lib/types";
import { useEffect, useState } from "react";
import { Bell, Search, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useApp } from "@/lib/store";
import { useCoreExtensions } from "@/lib/core-extensions";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { CommandPalette } from "./CommandPalette";

const isMac = /mac/i.test(navigator.platform);

export function AppToolbar({ contextLabel, pageLabel, sidebarCollapsed, onToggleSidebar }: {
  contextLabel?: string; pageLabel?: string; sidebarCollapsed: boolean; onToggleSidebar: () => void;
}) {
  const { t } = useTranslation("common");
  useEffect(() => {
    const title = [contextLabel, pageLabel, "Sawhorse"].filter(Boolean).join(" · ");
    document.title = title;
    if (isTauri()) void getCurrentWindow().setTitle(title).catch(() => undefined);
  }, [contextLabel, pageLabel]);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [pending, setPending] = useState<PendingTaskRequest[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const [runs, tasks] = await Promise.all([
        sddApi.runs().catch(() => []),
        api.listTasks().catch(() => null),
      ]);
      if (alive) {
        setRuns(runs);
        setPending(tasks?.pending ?? []);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const [search, setSearch] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [read, setRead] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("sawhorse.notifications-read") ?? "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((x) => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  });
  const jobs = useApp((s) => s.jobs);
  const missed = useApp((s) => s.missed);
  const packs = useApp((s) => s.packs);
  const setPage = useApp((s) => s.setPage);
  useEffect(() => {
    void useCoreExtensions
      .getState()
      .refresh()
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (
          !search ||
          window.dispatchEvent(
            new Event("sawhorse:navigate", { cancelable: true }),
          )
        )
          setSearch(!search);
      }
      if (e.key === "Escape") {
        if (
          window.dispatchEvent(
            new Event("sawhorse:navigate", { cancelable: true }),
          )
        )
          setSearch(false);
        setNotifications(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [search]);
  const items: Array<{ id: string; title: string; text: string; page: string; run?: HarnessRun }> = [
    ...pending.map((p) => ({
      id: `pending:${p.id}`,
      title: p.targetTitle,
      text: t("toolbar.pendingChange"),
      page: "task-library",
    })),
    ...runs
      .filter((r) => ["blocked", "failed", "review"].includes(r.status))
      .map((r) => ({
        id: `run:${r.id}:${r.status}`,
        title: `${r.agent} · ${r.role}`,
        text:
          r.error ??
          (r.status === "blocked"
            ? t("toolbar.waitingInput")
            : r.status === "review"
              ? t("toolbar.reviewRun")
              : t("toolbar.runFailed")),
        page: "harness",
        run: r,
      })),
    ...jobs
      .filter((j) => j.finishedAtMs || j.status === "failed")
      .map((j) => ({
        id: `job:${j.id}:${j.status}`,
        title: j.label,
        text:
          j.error ||
          (j.status === "failed" ? t("toolbar.jobFailed") : t("toolbar.jobFinished")),
        page: "jobs",
      })),
    ...missed.map((m) => ({
      id: `missed:${m.key}`,
      title: m.label ?? m.routine,
      text: t("toolbar.missedRun", { date: m.date, time: m.scheduledAt }),
      page: "tasks",
    })),
    ...(packs?.broken ?? []).map((p) => ({
      id: `pack:${p.dir}:${p.error}`,
      title: t("toolbar.brokenPack"),
      text: p.error,
      page: "packs",
    })),
  ];
  const unread = items.filter((i) => !read.includes(i.id)).length;
  function mark(ids: string[]) {
    const next = [...new Set([...read, ...ids])].slice(-1000);
    setRead(next);
    try {
      localStorage.setItem("sawhorse.notifications-read", JSON.stringify(next));
    } catch {
      /* session only */
    }
  }
  return (
    <>
      <header className={`app-toolbar app-titlebar${isTauri() && isMac ? " has-native-controls" : ""}`} data-tauri-drag-region aria-label={t("toolbar.titlebar")}>
        <button className="app-sidebar-toggle" onClick={onToggleSidebar} aria-label={t(sidebarCollapsed ? "nav.expandSidebar" : "nav.collapseSidebar")} aria-expanded={!sidebarCollapsed} title={t(sidebarCollapsed ? "nav.expandSidebar" : "nav.collapseSidebar")}>
          {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        <span className="app-toolbar-brand" data-tauri-drag-region>Sawhorse</span>
        <div className="app-location" aria-label={t("toolbar.location")} data-tauri-drag-region>
          {contextLabel && <span data-tauri-drag-region>{contextLabel}</span>}
          <ChevronRight size={12} aria-hidden />
          {pageLabel && <strong data-tauri-drag-region>{pageLabel}</strong>}
        </div>
        <button
          className="app-search-trigger"
          aria-label={t("toolbar.search")}
          onClick={() => setSearch(true)}
        >
          <Search size={14} className="shrink-0" />
          <span className="flex-1 truncate text-left">{t("toolbar.search")}</span>
          <kbd className="shrink-0 rounded border bg-background px-1.5 py-0.5 text-[10px] font-normal">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
        <button
          className="app-notification-trigger relative rounded-md p-2 hover:bg-accent"
          aria-label={
            unread
              ? t("toolbar.notificationsUnread", { count: unread })
              : t("toolbar.notifications")
          }
          onClick={() => setNotifications(true)}
        >
          <Bell size={17} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
              {unread}
            </span>
          )}
        </button>
      </header>
      <CommandPalette open={search} onClose={() => setSearch(false)} />
      <Dialog
        open={notifications}
        onClose={() => setNotifications(false)}
        title={t("toolbar.notifications")}
        className="absolute right-5 top-16 max-w-md"
      >
        <div className="mb-3 flex justify-end">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => mark(items.map((i) => i.id))}
          >
            {t("toolbar.markAllRead")}
          </Button>
        </div>
        {!items.length && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("toolbar.noNotifications")}
          </p>
        )}
        {items.map((item) => (
          <button
            key={item.id}
            className={`mb-2 w-full rounded-lg border p-3 text-left ${read.includes(item.id) ? "opacity-60" : "bg-primary/5"}`}
            onClick={() => {
              if (
                !window.dispatchEvent(
                  new Event("sawhorse:navigate", { cancelable: true }),
                )
              )
                return;
              mark([item.id]);
              if (item.run) useApp.getState().openRun(item.run.id, item.run.projectId);
              else setPage(item.page);
              setNotifications(false);
            }}
          >
            <strong className="block text-sm">{item.title}</strong>
            <span className="text-xs text-muted-foreground">{item.text}</span>
          </button>
        ))}
      </Dialog>
    </>
  );
}
