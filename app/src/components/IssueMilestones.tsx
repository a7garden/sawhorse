import { useEffect, useState } from "react";
import type { IssueNote } from "@/lib/types";
import type { CalendarEvent } from "@/features/workbench/types";
import { sddApi } from "@/features/workbench/api";
import { api } from "@/lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog } from "./ui/dialog";

export function MilestoneIssuePicker({
  issues,
  selected,
  onChange,
}: {
  issues: IssueNote[];
  selected: string[];
  onChange: (paths: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span>포함할 이슈</span>
        <span>{selected.length}개 선택</span>
      </div>
      <Input
        aria-label="마일스톤 이슈 검색"
        placeholder="이슈 검색"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="max-h-52 overflow-y-auto rounded-lg border">
        {issues
          .filter((n) =>
            `${n.id} ${n.title} ${n.project}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((n) => (
            <label
              key={n.path}
              className="flex cursor-pointer items-start gap-3 border-b p-3 text-xs last:border-0 hover:bg-accent"
            >
              <input
                type="checkbox"
                aria-label={`${n.id} ${n.title}`}
                checked={selected.includes(n.path)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, n.path]
                      : selected.filter((p) => p !== n.path),
                  )
                }
              />
              <span>
                <span className="block">{n.title}</span>
                <span className="mt-1 block text-muted-foreground">
                  {n.project} · {n.id}
                  {n.milestone && !selected.includes(n.path)
                    ? " · 선택하면 기존 마일스톤에서 이동"
                    : ""}
                </span>
              </span>
            </label>
          ))}
        {!issues.length && (
          <p className="p-4 text-xs text-muted-foreground">
            등록된 이슈가 없습니다. 이슈를 가져온 뒤 추가할 수 있습니다.
          </p>
        )}
      </div>
    </div>
  );
}

export function IssueMilestones({
  issues,
  selected,
  onSelect,
  onChanged,
  onNames,
}: {
  issues: IssueNote[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => Promise<void>;
  onNames: (names: Record<string, string>) => void;
}) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [draft, setDraft] = useState<CalendarEvent | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() {
    const snapshot = await sddApi.snapshot();
    const milestones = snapshot.events.filter((e) => e.kind === "milestone");
    setEvents(milestones);
    onNames(Object.fromEntries(milestones.map((e) => [e.id, e.title])));
  }
  useEffect(() => {
    void load().catch((e) => setError(String(e)));
  }, []);
  const legacy = [
    ...new Set(issues.map((n) => n.milestone).filter(Boolean)),
  ].filter((id) => !events.some((e) => e.id === id));
  const milestones = [
    ...events,
    ...legacy.map((id) => ({ id, title: id, date: "" })),
  ];
  function open(event?: CalendarEvent) {
    setError("");
    setDraft(
      event ?? {
        id: "",
        title: "",
        date: new Date().toLocaleDateString("sv-SE"),
        endDate: null,
        kind: "milestone",
        projectId: null,
        workId: null,
        notes: "",
      },
    );
    setPaths(
      event
        ? issues.filter((n) => n.milestone === event.id).map((n) => n.path)
        : [],
    );
  }
  return (
    <aside className="w-full shrink-0 space-y-1 lg:w-60" aria-label="마일스톤">
      <div className="mb-2 flex items-center justify-between px-2">
        <h2 className="text-xs font-semibold text-muted-foreground">
          마일스톤
        </h2>
        <Button
          size="sm"
          variant="ghost"
          aria-label="마일스톤 추가"
          onClick={() => open()}
        >
          +
        </Button>
      </div>
      <button
        className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected === null ? "bg-secondary font-medium" : "hover:bg-accent"}`}
        onClick={() => onSelect(null)}
      >
        모든 이슈{" "}
        <span className="float-right text-xs text-muted-foreground">
          {issues.length}
        </span>
      </button>
      <button
        className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selected === "" ? "bg-secondary font-medium" : "hover:bg-accent"}`}
        onClick={() => onSelect("")}
      >
        마일스톤 없음{" "}
        <span className="float-right text-xs text-muted-foreground">
          {issues.filter((n) => !n.milestone).length}
        </span>
      </button>
      {milestones.map((m) => {
        const members = issues.filter((n) => n.milestone === m.id);
        const completed = members.filter((n) => n.state === "closed").length;
        const percent = members.length
          ? Math.round((completed * 100) / members.length)
          : 0;
        return (
          <div
            key={m.id}
            className={`rounded-lg border ${selected === m.id ? "border-primary bg-secondary/50" : "border-transparent hover:bg-accent/40"}`}
          >
            <button
              className="w-full space-y-2 p-3 text-left"
              onClick={() => onSelect(m.id)}
            >
              <span className="block truncate text-sm font-medium">
                {m.title}
              </span>
              <span className="flex justify-between text-[11px] text-muted-foreground">
                <span>
                  {completed}/{members.length} 완료
                </span>
                <span>{percent}%</span>
              </span>
              <span
                role="progressbar"
                aria-label={`${m.title} 진행률`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="block h-1 overflow-hidden rounded-full bg-muted"
              >
                <span
                  style={{ width: `${percent}%` }}
                  className="block h-full bg-primary"
                />
              </span>
              {m.date && (
                <span className="block text-[11px] text-muted-foreground">
                  기한 {m.date}
                </span>
              )}
            </button>
            {selected === m.id && events.some((e) => e.id === m.id) && (
              <Button
                size="sm"
                variant="ghost"
                className="mb-2 ml-2"
                onClick={() => open(events.find((e) => e.id === m.id))}
              >
                이슈 구성 편집
              </Button>
            )}
          </div>
        );
      })}
      {error && !draft && (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!draft}
        onClose={() => {
          if (!busy) setDraft(null);
        }}
        title={draft?.id ? "마일스톤 편집" : "마일스톤 추가"}
      >
        {draft && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              void (async () => {
                try {
                  const saved = await sddApi.saveEvent({
                    ...draft,
                    title: draft.title.trim(),
                  });
                  setDraft(saved); // Retry edits this milestone if assigning an issue fails.
                  await api.setIssueMilestone(paths, saved.id);
                  const removed = issues
                    .filter(
                      (n) =>
                        n.milestone === saved.id && !paths.includes(n.path),
                    )
                    .map((n) => n.path);
                  if (removed.length) await api.setIssueMilestone(removed, "");
                  await onChanged();
                  await load();
                  onSelect(saved.id);
                  setDraft(null);
                } catch (err) {
                  setError(String(err));
                  await onChanged();
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            <label className="block space-y-1 text-sm">
              이름
              <Input
                aria-label="마일스톤 이름"
                autoFocus
                required
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-sm">
              기한
              <Input
                aria-label="마일스톤 기한"
                type="date"
                required
                value={draft.date}
                onChange={(e) => setDraft({ ...draft, date: e.target.value })}
              />
            </label>
            <MilestoneIssuePicker
              issues={issues}
              selected={paths}
              onChange={setPaths}
            />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                취소
              </Button>
              <Button type="submit" disabled={busy || !draft.title.trim()}>
                저장
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </aside>
  );
}
