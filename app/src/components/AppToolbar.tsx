import { api } from "@/lib/api";
import { sddApi } from "@/features/workbench/api";
import type { HarnessRun } from "@/features/workbench/types";
import type { PendingTaskRequest } from "@/lib/types";
import { useEffect, useState } from "react";
import { Bell, Search } from "lucide-react";
import { useApp } from "@/lib/store";
import { useCoreExtensions } from "@/lib/core-extensions";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import WorkbenchPage from "@/features/workbench/WorkbenchPage";

export function AppToolbar() {
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
  const items = [
    ...pending.map((p) => ({
      id: `pending:${p.id}`,
      title: p.targetTitle,
      text: "작업 변경 요청을 검토해 주세요.",
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
            ? "사용자의 입력을 기다리고 있습니다."
            : r.status === "review"
              ? "실행 결과를 검토해 주세요."
              : "실행에 실패했습니다."),
        page: "harness",
      })),
    ...jobs
      .filter((j) => j.finishedAtMs || j.status === "failed")
      .map((j) => ({
        id: `job:${j.id}:${j.status}`,
        title: j.label,
        text:
          j.error ||
          (j.status === "failed" ? "실행 실패" : "실행이 종료되었습니다."),
        page: "jobs",
      })),
    ...missed.map((m) => ({
      id: `missed:${m.key}`,
      title: m.label ?? m.routine,
      text: `${m.date} ${m.scheduledAt} 예약 실행을 놓쳤습니다.`,
      page: "tasks",
    })),
    ...(packs?.broken ?? []).map((p) => ({
      id: `pack:${p.dir}:${p.error}`,
      title: "확장을 불러오지 못했습니다",
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
      <div className="flex h-12 shrink-0 items-center justify-between gap-4 border-b bg-background px-5">
        <button
          className="flex items-center gap-2 text-xs text-muted-foreground"
          onClick={() => setSearch(true)}
        >
          <Search size={15} /> 전체 검색{" "}
          <kbd className="ml-6 rounded border px-1.5 py-0.5">⌘ / Ctrl K</kbd>
        </button>
        <button
          className="relative rounded-md p-2 hover:bg-accent"
          aria-label={`알림센터${unread ? ` · 읽지 않은 알림 ${unread}개` : ""}`}
          onClick={() => setNotifications(true)}
        >
          <Bell size={17} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">
              {unread}
            </span>
          )}
        </button>
      </div>
      <Dialog
        open={search}
        onClose={() => {
          if (
            window.dispatchEvent(
              new Event("sawhorse:navigate", { cancelable: true }),
            )
          )
            setSearch(false);
        }}
        title="전체 검색"
        className="max-w-5xl"
      >
        <WorkbenchPage view="knowledge" />
      </Dialog>
      <Dialog
        open={notifications}
        onClose={() => setNotifications(false)}
        title="알림센터"
        className="absolute right-5 top-16 max-w-md"
      >
        <div className="mb-3 flex justify-end">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => mark(items.map((i) => i.id))}
          >
            모두 읽음
          </Button>
        </div>
        {!items.length && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            새 알림이 없습니다.
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
              setPage(item.page);
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
