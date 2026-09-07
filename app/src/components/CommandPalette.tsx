import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  FileText,
  FolderGit2,
  Loader2,
  Search,
  SquareCheckBig,
  SquareTerminal,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp, type OpenWorkRequest } from "@/lib/store";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { TaskDef } from "@/lib/types";
import { sddApi } from "@/features/workbench/api";
import { useWorkspaceSnapshot } from "@/features/workbench/snapshot-store";
import type { SearchHit } from "@/features/workbench/types";

type GroupKey = "work" | "projects" | "tasks" | "jobs" | "documents";

const GROUP_ORDER: GroupKey[] = [
  "work",
  "projects",
  "tasks",
  "jobs",
  "documents",
];

const GROUP_LABEL: Record<GroupKey, string> = {
  work: "workbench:search.categoryWork",
  projects: "workbench:search.categoryProject",
  tasks: "workbench:search.categoryTask",
  jobs: "workbench:search.categoryJob",
  documents: "workbench:search.document",
};

const GROUP_ICON: Record<GroupKey, typeof FileText> = {
  work: Briefcase,
  projects: FolderGit2,
  tasks: SquareCheckBig,
  jobs: SquareTerminal,
  documents: FileText,
};

type PaletteItem = {
  key: string;
  group: GroupKey;
  title: string;
  subtitle?: string;
  meta?: string;
  run: () => void;
};


/**
 * 전역 커맨드 팔레트. 입력 즉시 로컬 항목(작업·프로젝트·잡)을 걸러 보여 주고,
 * 문서·자동화 작업은 원격 검색을 디바운스해서 붙인다. 작업 항목은 작업대 상세로
 * 점프하고, 나머지는 팔레트 안에서 미리 보기로 열린다.
 */
export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation("common");
  const listId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);
  const setPage = useApp((s) => s.setPage);
  const openWork = useApp((s) => s.openWork);
  const jobs = useApp((s) => s.jobs);
  const snapshot = useWorkspaceSnapshot((s) => s.snapshot);

  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{ hits: SearchHit[]; tasks: TaskDef[] }>(
    { hits: [], tasks: [] },
  );
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{
    title: string;
    markdown: string;
  } | null>(null);
  const [active, setActive] = useState(0);

  // 열릴 때마다 깨끗한 상태로 시작한다.
  useEffect(() => {
    if (open) {
      setQuery("");
      setRemote({ hits: [], tasks: [] });
      setPreview(null);
      setActive(0);
    }
  }, [open]);

  const term = query.trim();

  // 원격 검색은 타이핑마다 다시 날리지 않게 짧게 모은다. 응답이 어긋나면 버린다.
  useEffect(() => {
    if (!open || !term) {
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const timer = window.setTimeout(async () => {
      try {
        const [hits, tasks] = await Promise.all([
          sddApi.search(term),
          api.listTasks().catch(() => null),
        ]);
        if (!alive) return;
        setRemote({
          hits,
          tasks: (tasks ? [...tasks.builtin, ...tasks.tasks] : []).map(
            (r) => r.def,
          ),
        });
      } catch (error) {
        if (!alive) return;
        setRemote({ hits: [], tasks: [] });
        toast({
          tone: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (alive) setSearching(false);
      }
    }, 140);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, term]);

  const q = term.toLowerCase();
  const matches = (text: string) => !!q && text.toLowerCase().includes(q);

  const jumpToWork = (request: OpenWorkRequest) => {
    onClose();
    setPage("work");
    openWork(request);
  };

  const items: PaletteItem[] = [];
  if (!q) {
    // 비어 있을 때는 최근 작업을 빠른 점프 목록으로 내준다.
    for (const item of [...(snapshot?.work ?? [])]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8)) {
      items.push({
        key: `work:${item.id}`,
        group: "work",
        title: item.title,
        subtitle: item.description,
        run: () => jumpToWork({ workId: item.id }),
      });
    }
  } else {
    for (const item of snapshot?.work ?? []) {
      if (!matches(`${item.title} ${item.description} ${item.tags.join(" ")}`))
        continue;
      items.push({
        key: `work:${item.id}`,
        group: "work",
        title: item.title,
        subtitle: item.description,
        run: () => jumpToWork({ workId: item.id }),
      });
    }
    for (const project of snapshot?.projects ?? []) {
      if (!matches(`${project.name} ${project.description}`)) continue;
      items.push({
        key: `project:${project.id}`,
        group: "projects",
        title: project.name,
        subtitle: project.description,
        meta: project.repoPath,
        run: () =>
          setPreview({
            title: project.name,
            markdown: `${project.description}\n\n${project.repoPath}`,
          }),
      });
    }
    for (const task of remote.tasks) {
      if (!matches(`${task.title} ${task.prompt}`)) continue;
      items.push({
        key: `task:${task.id}`,
        group: "tasks",
        title: task.title,
        subtitle: task.prompt.slice(0, 160),
        run: () => setPreview({ title: task.title, markdown: task.prompt }),
      });
    }
    for (const job of jobs) {
      if (!matches(`${job.label} ${job.error ?? ""}`)) continue;
      items.push({
        key: `job:${job.id}`,
        group: "jobs",
        title: job.label,
        subtitle: job.status,
        run: () =>
          setPreview({
            title: job.label,
            markdown: `${job.status}\n\n${job.error ?? ""}`,
          }),
      });
    }
    remote.hits.slice(0, 20).forEach((hit, index) => {
      items.push({
        key: `doc:${index}:${hit.path}`,
        group: "documents",
        title: hit.title,
        subtitle: hit.snippet,
        meta: hit.path,
        run: () => {
          if (hit.workId && hit.artifact) {
            jumpToWork({
              workId: hit.workId,
              artifact: hit.artifact,
              snippet: hit.snippet,
            });
            return;
          }
          void api
            .readVaultNote(hit.path)
            .then((note) =>
              setPreview({ title: hit.title, markdown: note.markdown }),
            )
            .catch((error: unknown) =>
              toast({
                tone: "error",
                text: error instanceof Error ? error.message : String(error),
              }),
            );
        },
      });
    });
  }

  let cursor = 0;
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: items
      .filter((item) => item.group === group)
      .map((item) => ({ item, index: cursor++ })),
  })).filter((group) => group.items.length > 0);
  const flat = groups.flatMap((group) => group.items);
  const current = flat[Math.min(active, flat.length - 1)] ?? null;

  // 질의·미리 보기가 바뀌면 선택을 처음으로 되돌린다.
  useEffect(() => {
    setActive(0);
  }, [q, preview]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, items.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // 미리 보기에서는 뒤로 가고, 창 핸들러로 새지 않게 막는다.
      event.stopPropagation();
      if (preview) setPreview(null);
      else onClose();
      return;
    }
    if (preview) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flat.length) setActive((index) => (index + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length)
        setActive((index) => (index - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      current?.item.run();
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <div
        className="palette-backdrop absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("toolbar.search")}
        className="palette-panel absolute inset-x-0 top-[12vh] mx-auto flex max-h-[68vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b px-4">
          {searching ? (
            <Loader2
              size={16}
              className="shrink-0 animate-spin text-muted-foreground"
            />
          ) : (
            <Search size={16} className="shrink-0 text-muted-foreground" />
          )}
          <input
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={
              preview || !current ? undefined : `${listId}-${current.index}`
            }
            aria-label={t("toolbar.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("workbench:search.placeholder")}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {preview ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">
              {preview.title}
            </div>
            <pre className="selectable whitespace-pre-wrap break-words text-xs leading-relaxed">
              {preview.markdown}
            </pre>
          </div>
        ) : flat.length > 0 ? (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t("toolbar.search")}
            className="min-h-0 flex-1 overflow-y-auto p-1.5"
          >
            {groups.map(({ group, items: groupItems }) => {
              const Icon = GROUP_ICON[group];
              return (
                <div key={group} className="px-1 pb-1 pt-2 first:pt-0.5">
                  <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {!q && group === "work"
                      ? t("palette.recent")
                      : t(GROUP_LABEL[group])}
                  </div>
                  {groupItems.map(({ item, index }) => (
                    <div
                      key={item.key}
                      id={`${listId}-${index}`}
                      role="option"
                      aria-selected={index === active}
                      data-active={index === active || undefined}
                      onPointerMove={() => setActive(index)}
                      onClick={() => item.run()}
                      className={cn(
                        "flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2",
                        index === active
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground",
                      )}
                    >
                      <Icon
                        size={15}
                        className="mt-0.5 shrink-0 text-muted-foreground"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium leading-5">
                          {item.title}
                        </div>
                        {item.subtitle && (
                          <div className="truncate text-[11px] leading-4 text-muted-foreground">
                            {item.subtitle}
                          </div>
                        )}
                      </div>
                      {item.meta && (
                        <span className="max-w-[36%] shrink-0 truncate pt-0.5 font-mono text-[10px] text-muted-foreground/70">
                          {item.meta}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex-1 px-4 py-10 text-center text-xs text-muted-foreground">
            {q ? t("palette.empty") : t("palette.hint")}
          </div>
        )}
        <div className="flex items-center gap-4 border-t px-4 py-2 text-[10px] text-muted-foreground">
          {!preview && (
            <>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1 font-sans">↑</kbd>
                <kbd className="rounded border bg-muted/50 px-1 font-sans">↓</kbd>
                {t("palette.navigate")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border bg-muted/50 px-1 font-sans">↵</kbd>
                {t("palette.open")}
              </span>
            </>
          )}
          <span className="flex items-center gap-1">
            <kbd className="rounded border bg-muted/50 px-1 font-sans">esc</kbd>
            {preview ? t("palette.back") : t("palette.close")}
          </span>
        </div>
      </div>
    </div>
  );
}
