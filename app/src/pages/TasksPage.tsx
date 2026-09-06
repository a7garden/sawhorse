import ScheduleCard from "./settings/ScheduleCard";
// TasksPage — 승인대기 요청, 예약 작업(builtin + 사용자), 수동 작업을 관리한다.
import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api, EVENTS } from "@/lib/api";
import { useApp } from "@/lib/store";
import type {
  PackAction,
  PackInfo,
  ScheduleKind,
  TaskDef,
  TaskRow,
  TasksView,
} from "@/lib/types";
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
  const kind: Record<ScheduleKind, string> = {
    daily: "매일",
    weekdays: "평일",
    once: s.date ?? "",
  };
  return `${kind[s.kind]} ${s.time}`;
}

export default function TasksPage({
  mode = "library",
}: {
  mode?: "library" | "schedules";
}) {
  const [filter, setFilter] = useState("all");
  const [choosing, setChoosing] = useState(false);
  const [view, setView] = useState<TasksView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskDef | null>(null);
  const [open, setOpen] = useState(false);
  const [actionTarget, setActionTarget] = useState<{
    pack: PackInfo;
    action: PackAction;
  } | null>(null);
  const packs = useApp((s) => s.packs);
  const config = useApp((s) => s.config);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);

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
    if (!("__TAURI_INTERNALS__" in window)) return;
    void listen(EVENTS.tasksChanged, () => void refresh())
      .then((u) => {
        if (disposed) u();
        else un = u;
      })
      .catch((error) => setErr(String(error)));
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
      return true;
    } catch (e) {
      setErr(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const all = view ? [...view.builtin, ...view.tasks] : [];
  const scheduled = all.filter(
    (r) =>
      r.def.schedule &&
      (filter === "all" ||
        (filter === "once"
          ? r.def.schedule.kind === "once"
          : r.def.schedule.kind !== "once")),
  );
  const packActionFor = (row: TaskRow) => {
    const [packId, actionId] = row.def.id.split(".", 2);
    const pack = packs?.packs.find((candidate) => candidate.id === packId);
    const action = pack?.actions.find((candidate) => candidate.id === actionId);
    return pack && action ? { pack, action } : null;
  };

  async function runRow(row: TaskRow) {
    const target = packActionFor(row);
    if (target && target.action.params.length > 0) {
      setActionTarget(target);
      return;
    }
    if (await guard(() => api.runTaskNow(row.def.id))) {
      await refreshJobs();
      setPage("jobs");
    }
  }

  return (
    <div>
      <PageHeader title={mode === "library" ? "실행할 작업" : "예약과 반복"}>
        <Button
          size="sm"
          onClick={() => {
            if (mode === "schedules") setChoosing(true);
            else {
              setEditing(null);
              setOpen(true);
            }
          }}
        >
          <Plus /> {mode === "library" ? "작업 추가" : "기존 작업 예약"}
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
                    <span className="text-[13px] font-semibold">
                      {p.targetTitle}
                    </span>
                    <Badge variant="outline">{p.agent || "agent"}</Badge>
                    {p.duplicateOf && (
                      <Badge variant="warning">
                        중복 의심 · {p.duplicateOf}
                      </Badge>
                    )}
                  </div>
                  {p.note && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      비고: {p.note}
                    </p>
                  )}
                  {p.summary.length > 0 && (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {p.summary.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void guard(() => api.approveTaskRequest(p.id))
                      }
                    >
                      승인
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void guard(() => api.rejectTaskRequest(p.id))
                      }
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
              <CardTitle className={`text-[13px] ${WARN_TEXT}`}>
                반려됨
              </CardTitle>
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

        {mode === "schedules" && (
          <div className="flex gap-2">
            {[
              ["all", "전체"],
              ["once", "한 번 예약"],
              ["repeat", "반복 실행"],
            ].map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant={filter === id ? "secondary" : "ghost"}
                onClick={() => setFilter(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>
              {mode === "library" ? "등록된 작업" : "실행 일정"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(mode === "library" ? all : scheduled).map((row) => (
              <TaskLine
                key={row.def.id}
                row={row}
                busy={busy}
                guard={guard}
                packName={packActionFor(row)?.pack.name}
                hasParameters={
                  (packActionFor(row)?.action.params.length ?? 0) > 0
                }
                onRun={() => void runRow(row)}
                onEdit={
                  row.def.builtin
                    ? undefined
                    : (d) => {
                        setEditing(d);
                        setOpen(true);
                      }
                }
              />
            ))}
            {(mode === "library" ? all : scheduled).length === 0 && (
              <Empty>
                {mode === "library"
                  ? "실행할 내용을 작업으로 추가하세요."
                  : "예약된 작업이 없습니다. 기존 작업을 선택해 실행 시간을 지정하세요."}
              </Empty>
            )}
          </CardContent>
        </Card>
        {mode === "schedules" && (
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              내장 작업의 실행 시간 설정
            </summary>
            <ScheduleCard onChange={() => void refresh()} />
          </details>
        )}
      </div>

      <Dialog
        open={choosing}
        onClose={() => setChoosing(false)}
        title="예약할 작업 선택"
      >
        <p className="mb-3 text-xs text-muted-foreground">
          작업 내용은 그대로 두고 실행 시간만 설정합니다.
        </p>
        {view?.tasks.map((row) => (
          <button
            key={row.def.id}
            className="mb-2 block w-full rounded-lg border p-3 text-left text-sm"
            onClick={() => {
              setEditing(row.def);
              setChoosing(false);
              setOpen(true);
            }}
          >
            {row.def.title}
            <small className="block text-muted-foreground">
              {scheduleLabel(row.def)}
            </small>
          </button>
        ))}
        {!view?.tasks.length && (
          <Empty>먼저 ‘실행할 작업’에서 작업을 추가하세요.</Empty>
        )}
      </Dialog>
      <TaskDialog
        error={err}
        scheduleOnly={mode === "schedules"}
        open={open}
        setOpen={setOpen}
        editing={editing}
        busy={busy}
        guard={guard}
      />
      <PackActionTaskDialog
        target={actionTarget}
        projects={config?.projects.map((project) => project.name) ?? []}
        busy={busy}
        error={err}
        onClose={() => setActionTarget(null)}
        onRun={async (params) => {
          if (!actionTarget) return;
          if (
            await guard(() =>
              api.runPackAction(
                actionTarget.pack.id,
                actionTarget.action.id,
                params,
                null,
              ),
            )
          ) {
            setActionTarget(null);
            await refreshJobs();
            setPage("jobs");
          }
        }}
      />
    </div>
  );
}

function TaskLine({
  row,
  busy,
  guard,
  onEdit,
  onRun,
  packName,
  hasParameters,
}: {
  row: TaskRow;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<boolean>;
  onEdit?: (def: TaskDef) => void;
  onRun: () => void;
  packName?: string;
  hasParameters: boolean;
}) {
  const t = row.def;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/15 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{t.title}</span>
          {t.builtin && (
            <Badge variant="outline">
              {t.source.kind === "pack" || packName ? "확장 작업" : "기본 작업"}
            </Badge>
          )}
          {hasParameters && <Badge variant="secondary">입력 후 실행</Badge>}
          {!t.enabled && <Badge variant="warning">꺼짐</Badge>}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {scheduleLabel(t)}
          {packName ? ` · ${packName}` : ""}
          {row.lastRun ? ` · 마지막 실행 ${row.lastRun}` : ""}
        </p>
      </div>
      {(!t.builtin || t.schedule) && (
        <Switch
          checked={t.enabled}
          disabled={busy}
          onCheckedChange={(v) =>
            void guard(() => api.setTaskEnabled(t.id, v))
          }
        />
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label="지금 실행"
        title="지금 실행"
        disabled={busy}
        onClick={onRun}
      >
        <Play />
      </Button>
      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="편집"
          title="편집"
          onClick={() => onEdit(t)}
        >
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

function PackActionTaskDialog({
  target,
  projects,
  busy,
  error,
  onClose,
  onRun,
}: {
  target: { pack: PackInfo; action: PackAction } | null;
  projects: string[];
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onRun: (params: Record<string, unknown>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => setValues({}), [target]);
  const missingRequired =
    target?.action.params.some(
      (param) => param.required && !values[param.key]?.trim(),
    ) ?? false;
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={target ? `${target.action.label} · 실행` : "작업 실행"}
    >
      {target && (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const params = Object.fromEntries(
              target.action.params
                .filter((param) => values[param.key]?.trim())
                .map((param) => [
                  param.key,
                  param.type === "list"
                    ? values[param.key]
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean)
                    : values[param.key].trim(),
                ]),
            );
            void onRun(params);
          }}
        >
          <div>
            <p className="text-sm font-medium">{target.pack.name}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {target.action.description}
            </p>
          </div>
          {target.action.params.map((param) => (
            <label key={param.key} className="block space-y-1 text-sm">
              {param.label}
              {param.required ? " *" : ""}
              {param.type === "select" ? (
                <Select
                  className="w-full"
                  value={values[param.key] ?? ""}
                  onChange={(event) =>
                    setValues({ ...values, [param.key]: event.target.value })
                  }
                >
                  <option value="">선택하세요</option>
                  {param.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label || option.value}
                    </option>
                  ))}
                </Select>
              ) : param.type === "project" ? (
                <Select
                  className="w-full"
                  value={values[param.key] ?? ""}
                  onChange={(event) =>
                    setValues({ ...values, [param.key]: event.target.value })
                  }
                >
                  <option value="">기본 프로젝트</option>
                  {projects.map((project) => (
                    <option key={project} value={project}>
                      {project}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  value={values[param.key] ?? ""}
                  placeholder={
                    param.type === "list" ? "쉼표로 구분" : undefined
                  }
                  onChange={(event) =>
                    setValues({ ...values, [param.key]: event.target.value })
                  }
                />
              )}
            </label>
          ))}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              취소
            </Button>
            <Button type="submit" disabled={busy || missingRequired}>
              실행
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function TaskDialog({
  open,
  setOpen,
  editing,
  busy,
  guard,
  scheduleOnly,
  error,
}: {
  error: string | null;
  scheduleOnly: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  editing: TaskDef | null;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<boolean>;
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
      kind === "none"
        ? null
        : kind === "once"
          ? { kind, time, date }
          : { kind, time, date: null };
    // saveTask가 정규화된 TaskDef를 반환해도 페이지는 무시하고 재조회로 동기화한다.
    if (
      await guard(() =>
        api.saveTask({
          ...base,
          title: title.trim(),
          prompt: prompt.trim(),
          schedule,
        }),
      )
    )
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
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={
        scheduleOnly
          ? `${editing?.title ?? "작업"} · 실행 시간`
          : editing
            ? "작업 편집"
            : "작업 추가"
      }
    >
      <div className="space-y-3">
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {!scheduleOnly && (
          <>
            <Input
              aria-label="작업 제목"
              placeholder="제목"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              className="min-h-40"
              aria-label="작업 내용"
              placeholder="어떤 일을 실행할까요? 필요한 자료와 원하는 결과를 적어 주세요."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </>
        )}
        <p className="text-xs font-medium">언제 실행할까요?</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="실행 주기"
            value={kind}
            onChange={(e) => setKind(e.target.value as ScheduleKind | "none")}
          >
            <option value="none">필요할 때 직접 실행</option>
            <option value="daily">매일</option>
            <option value="weekdays">평일</option>
            <option value="once">한 번 예약</option>
          </Select>
          {kind !== "none" && (
            <Input
              type="time"
              className="w-28"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
          {kind === "once" && (
            <Input
              type="date"
              className="w-40"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" size="sm" onClick={askAgent}>
            <ClipboardCopy /> 에이전트에게 시키기
          </Button>
          <Button
            size="sm"
            disabled={
              busy ||
              !title.trim() ||
              !prompt.trim() ||
              (kind !== "none" && !time) ||
              (kind === "once" &&
                (!date || new Date(`${date}T${time}`).getTime() <= Date.now()))
            }
            onClick={() => void submit()}
          >
            저장
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
