// TasksPage — 승인대기 요청, 예약 작업(builtin + 사용자), 수동 작업을 관리한다.
import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, EVENTS } from "@/lib/api";
import type { ScheduleKind, TaskDef, TaskRow, TasksView } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Empty, PageHeader, WARN_TEXT } from "./common";

const OP_KO: Record<string, string> = {
  create: "생성",
  update: "수정",
  pause: "일시정지",
  resume: "재개",
  delete: "삭제",
};

function scheduleLabel(t: TaskDef): string {
  const s = t.schedule;
  if (!s) return "수동";
  const kind: Record<ScheduleKind, string> = { daily: "매일", weekdays: "평일", once: s.date ?? "" };
  return `${kind[s.kind]} ${s.time}`;
}

export default function TasksPage() {
  const [view, setView] = useState<TasksView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskDef | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setView(await api.listTasks());
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // tasks-changed 이벤트로 재조회. 늦게 도착한 listen은 해제 후 폐기한다(언마운트 경합).
    let un: UnlistenFn | undefined;
    let disposed = false;
    void listen(EVENTS.tasksChanged, () => void refresh()).then((u) => {
      if (disposed) u();
      else un = u;
    });
    return () => {
      disposed = true;
      un?.();
    };
  }, [refresh]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const scheduled = view ? [...view.builtin, ...view.tasks.filter((r) => r.def.schedule)] : [];
  const manual = view ? view.tasks.filter((r) => !r.def.schedule) : [];

  return (
    <div>
      <PageHeader title="작업" desc="예약·수동 작업을 등록하고 에이전트 요청을 승인합니다.">
        <Button
          size="sm"
          onClick={() => {
            setEditing(null);
            setOpen(true);
          }}
        >
          <Plus /> 작업 추가
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        {err && (
          <div className="rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive">
            {err}
          </div>
        )}

        {view && view.pending.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">승인대기</CardTitle>
              <Badge variant="secondary">{view.pending.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {view.pending.map((p) => (
                <div key={p.id} className="rounded-xl border bg-muted/15 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{OP_KO[p.op] ?? p.op}</Badge>
                    <span className="text-[13px] font-semibold">{p.targetTitle}</span>
                    <Badge variant="outline">{p.agent || "agent"}</Badge>
                    {p.duplicateOf && <Badge variant="warning">중복 의심 · {p.duplicateOf}</Badge>}
                  </div>
                  {p.note && <p className="mt-1 text-xs text-muted-foreground">비고: {p.note}</p>}
                  {p.summary.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {p.summary.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => void guard(() => api.approveTaskRequest(p.id))}>
                      승인
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void guard(() => api.rejectTaskRequest(p.id))}
                    >
                      거부
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {view && view.rejected.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className={`text-[13px] ${WARN_TEXT}`}>반려됨</CardTitle>
              <Badge variant="warning">{view.rejected.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-1">
              {view.rejected.map((r) => (
                <div key={r.id} className="text-xs text-muted-foreground">
                  <span className="font-mono">{r.id}</span> — {r.error}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">예약 작업</CardTitle>
            <Badge variant="secondary">{scheduled.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {scheduled.length === 0 && <Empty>등록된 예약 작업이 없습니다.</Empty>}
            {scheduled.map((row) => (
              <TaskLine
                key={row.def.id}
                row={row}
                busy={busy}
                guard={guard}
                onEdit={row.def.builtin ? undefined : (d) => {
                  setEditing(d);
                  setOpen(true);
                }}
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">수동 작업</CardTitle>
            <Badge variant="secondary">{manual.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {manual.length === 0 && <Empty>수동 작업이 없습니다.</Empty>}
            {manual.map((row) => (
              <TaskLine
                key={row.def.id}
                row={row}
                busy={busy}
                guard={guard}
                onEdit={(d) => {
                  setEditing(d);
                  setOpen(true);
                }}
              />
            ))}
          </CardContent>
        </Card>
      </div>

      <TaskDialog open={open} setOpen={setOpen} editing={editing} busy={busy} guard={guard} />
    </div>
  );
}

function TaskLine({
  row,
  busy,
  guard,
  onEdit,
}: {
  row: TaskRow;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
  onEdit?: (def: TaskDef) => void;
}) {
  const t = row.def;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/15 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{t.title}</span>
          {t.builtin && <Badge variant="outline">내장</Badge>}
          {!t.enabled && <Badge variant="warning">꺼짐</Badge>}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {scheduleLabel(t)}
          {row.lastRun ? ` · 마지막 실행 ${row.lastRun}` : ""}
        </p>
      </div>
      <Switch checked={t.enabled} disabled={busy} onCheckedChange={(v) => void guard(() => api.setTaskEnabled(t.id, v))} />
      <Button
        size="icon"
        variant="ghost"
        aria-label="지금 실행"
        title="지금 실행"
        disabled={busy}
        onClick={() => void guard(() => api.runTaskNow(t.id))}
      >
        <Play />
      </Button>
      {onEdit && (
        <Button size="icon" variant="ghost" aria-label="편집" title="편집" onClick={() => onEdit(t)}>
          <Pencil />
        </Button>
      )}
      {!t.builtin && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="삭제"
          title="삭제"
          disabled={busy}
          onClick={() => void guard(() => api.deleteTask(t.id))}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );
}

function TaskDialog({
  open,
  setOpen,
  editing,
  busy,
  guard,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  editing: TaskDef | null;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<ScheduleKind | "none">("none");
  const [time, setTime] = useState("09:00");
  const [date, setDate] = useState("");

  useEffect(() => {
    if (!open) return;
    const d = editing;
    setTitle(d?.title ?? "");
    setPrompt(d?.prompt ?? "");
    setKind(d?.schedule?.kind ?? "none");
    setTime(d?.schedule?.time ?? "09:00");
    setDate(d?.schedule?.date ?? "");
  }, [open, editing]);

  const submit = async () => {
    const base: TaskDef = editing ?? {
      id: "",
      title: "",
      prompt: "",
      schedule: null,
      enabled: true,
      builtin: false,
      skill: null,
      project: null,
      source: { kind: "gui" },
      createdAt: "",
      updatedAt: "",
    };
    const schedule =
      kind === "none" ? null : kind === "once" ? { kind, time, date } : { kind, time, date: null };
    // saveTask가 정규화된 TaskDef를 반환해도 페이지는 무시하고 재조회로 동기화한다.
    await guard(() => api.saveTask({ ...base, title, prompt, schedule }));
    setOpen(false);
  };

  const askAgent = () => {
    const scheduleText =
      kind === "none"
        ? "예약 없이 수동 작업으로"
        : kind === "once"
          ? `${date} ${time}에 1회 실행`
          : `${kind === "daily" ? "매일" : "평일마다"} ${time}에 실행`;
    const text = `워크벤치에 작업 만들어줘.\n제목: ${title || "(제목)"}\n내용: ${prompt || "(내용)"}\n주기: ${scheduleText}\n워크벤치 스킬 규격대로 승인 큐에 넣어줘.`;
    void navigator.clipboard.writeText(text);
  };

  return (
    <Dialog open={open} onClose={() => setOpen(false)} title={editing ? "작업 편집" : "작업 추가"}>
      <div className="space-y-3">
        <Input placeholder="제목" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Textarea
          className="min-h-40"
          placeholder="무인 실행 프롬프트 (자기완결로 — 사용자 질문 없이 끝까지 실행되게)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind | "none")}>
            <option value="none">수동</option>
            <option value="daily">매일</option>
            <option value="weekdays">평일</option>
            <option value="once">1회</option>
          </Select>
          {kind !== "none" && (
            <Input type="time" className="w-28" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
          {kind === "once" && (
            <Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} />
          )}
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={askAgent}>
            <ClipboardCopy /> 에이전트에게 시키기
          </Button>
          <Button size="sm" disabled={busy || !title || !prompt} onClick={() => void submit()}>
            저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
