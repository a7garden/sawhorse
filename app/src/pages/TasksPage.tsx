import ScheduleCard from "./settings/ScheduleCard";
// TasksPage — 자동화의 자동화 작업(TaskDef)를 관리한다: 승인대기 요청, 예약된 정의,
// 필요할 때 직접 실행하는 정의. 개발 보드의 개발 항목(WorkItem)과는 다른 개념이다.
import { useCallback, useEffect, useState } from "react";
import { ClipboardCopy, Pencil, Plus, Trash2 } from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api, EVENTS } from "@/lib/api";
import { useApp } from "@/lib/store";
import { RunButton } from "@/components/RunButton";
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

const OP_KEY: Record<string, string> = {
  create: "tasks.op.create",
  update: "tasks.op.update",
  pause: "tasks.op.pause",
  resume: "tasks.op.resume",
  delete: "tasks.op.delete",
};

function scheduleLabel(def: TaskDef): string {
  const s = def.schedule;
  if (!s) return i18n.t("settings:tasks.schedule.manual");
  const kind: Record<ScheduleKind, string> = {
    daily: i18n.t("settings:tasks.schedule.daily"),
    weekdays: i18n.t("settings:tasks.schedule.weekdays"),
    once: s.date ?? "",
  };
  return `${kind[s.kind]} ${s.time}`;
}

export default function TasksPage({
  mode = "library",
}: {
  mode?: "library" | "schedules";
}) {
  const { t } = useTranslation("settings");
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
      <PageHeader title={mode === "library" ? t("tasks.title.library") : t("tasks.title.schedules")}>
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
          <Plus />{" "}
          {mode === "library" ? t("tasks.add") : t("tasks.addReservation")}
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
              <CardTitle className="text-[13px]">{t("tasks.pendingTitle")}</CardTitle>
              <Badge variant="secondary">{view.pending.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {view.pending.map((p) => (
                <div key={p.id} className="rounded-xl border bg-muted/15 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {OP_KEY[p.op] ? t(OP_KEY[p.op]) : p.op}
                    </Badge>
                    <span className="text-[13px] font-semibold">
                      {p.targetTitle}
                    </span>
                    <Badge variant="outline">{p.agent || "agent"}</Badge>
                    {p.duplicateOf && (
                      <Badge variant="warning">
                        {t("tasks.duplicateSuspected", { id: p.duplicateOf })}
                      </Badge>
                    )}
                  </div>
                  {p.note && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("tasks.note", { note: p.note })}
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
                      {t("tasks.approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void guard(() => api.rejectTaskRequest(p.id))
                      }
                    >
                      {t("tasks.reject")}
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
                {t("tasks.rejectedTitle")}
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
              ["all", t("tasks.filter.all")],
              ["once", t("tasks.filter.once")],
              ["repeat", t("tasks.filter.repeat")],
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
              {mode === "library"
                ? t("tasks.listTitle.library")
                : t("tasks.listTitle.schedules")}
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
                  ? t("tasks.empty.library")
                  : t("tasks.empty.schedules")}
              </Empty>
            )}
          </CardContent>
        </Card>
        {mode === "schedules" && (
          <details className="rounded-lg border p-3">
            <summary className="cursor-pointer text-sm">
              {t("tasks.builtinScheduleTitle")}
            </summary>
            <ScheduleCard onChange={() => void refresh()} />
          </details>
        )}
      </div>

      <Dialog
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t("tasks.chooseTitle")}
      >
        <p className="mb-3 text-xs text-muted-foreground">
          {t("tasks.chooseHint")}
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
          <Empty>{t("tasks.chooseEmpty")}</Empty>
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
  const def = row.def;
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/15 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-semibold">{def.title}</span>
          {def.builtin && (
            <Badge variant="outline">
              {def.source.kind === "pack" || packName
                ? t("tasks.badge.pack")
                : t("tasks.badge.builtin")}
            </Badge>
          )}
          {hasParameters && (
            <Badge variant="secondary">{t("tasks.badge.needsInput")}</Badge>
          )}
          {!def.enabled && <Badge variant="warning">{t("tasks.badge.off")}</Badge>}
        </div>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {scheduleLabel(def)}
          {packName ? ` · ${packName}` : ""}
          {row.lastRun ? ` · ${t("tasks.lastRun", { time: row.lastRun })}` : ""}
        </p>
      </div>
      {(!def.builtin || def.schedule) && (
        <Switch
          checked={def.enabled}
          disabled={busy}
          onCheckedChange={(v) => void guard(() => api.setTaskEnabled(def.id, v))}
        />
      )}
      <RunButton
        size="xs"
        variant="ghost"
        label=""
        ariaLabel={t("actions.runNow")}
        title={t("actions.runNow")}
        jobKey={row.jobKey}
        disabled={busy}
        onRun={onRun}
      />
      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("actions.edit")}
          title={t("actions.edit")}
          onClick={() => onEdit(def)}
        >
          <Pencil />
        </Button>
      )}
      {!def.builtin && (
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("actions.delete")}
          title={t("actions.delete")}
          disabled={busy}
          onClick={() => void guard(() => api.deleteTask(def.id))}
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
  const { t } = useTranslation("settings");
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
      title={
        target
          ? t("tasks.dialog.runTitle", { label: target.action.label })
          : t("tasks.dialog.runFallback")
      }
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
                  onChange={(v) => setValues({ ...values, [param.key]: v })}
                  options={[
                    { value: "", label: t("tasks.dialog.select") },
                    ...param.options.map((option) => ({
                      value: option.value,
                      label: option.label || option.value,
                    })),
                  ]}
                />
              ) : param.type === "project" ? (
                <Select
                  className="w-full"
                  value={values[param.key] ?? ""}
                  onChange={(v) => setValues({ ...values, [param.key]: v })}
                  options={[
                    { value: "", label: t("fields.defaultProject") },
                    ...projects.map((project) => ({
                      value: project,
                      label: project,
                    })),
                  ]}
                />
              ) : (
                <Input
                  value={values[param.key] ?? ""}
                  placeholder={
                    param.type === "list" ? t("tasks.dialog.listPlaceholder") : undefined
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
              {t("actions.cancel")}
            </Button>
            <Button type="submit" disabled={busy || missingRequired}>
              {t("actions.run")}
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
  const { t } = useTranslation("settings");
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
        ? t("tasks.ask.none")
        : kind === "once"
          ? t("tasks.ask.once", { date, time })
          : t("tasks.ask.exec", {
              cycle:
                kind === "daily" ? t("tasks.ask.daily") : t("tasks.ask.weekdays"),
              time,
            });
    const text = t("tasks.ask.body", {
      title: title || t("tasks.ask.noTitle"),
      prompt: prompt || t("tasks.ask.noContent"),
      schedule: scheduleText,
    });
    void navigator.clipboard.writeText(text);
  };

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={
        scheduleOnly
          ? t("tasks.dialog.scheduleTitle", {
              title: editing?.title ?? t("tasks.title.library"),
            })
          : editing
            ? t("tasks.dialog.editTitle")
            : t("tasks.dialog.addTitle")
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
              aria-label={t("tasks.dialog.titleLabel")}
              placeholder={t("tasks.dialog.titlePlaceholder")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              className="min-h-40"
              aria-label={t("tasks.dialog.promptLabel")}
              placeholder={t("tasks.dialog.promptPlaceholder")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </>
        )}
        <p className="text-xs font-medium">{t("tasks.dialog.when")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label={t("tasks.dialog.freqLabel")}
            value={kind}
            onChange={(v) => setKind(v as ScheduleKind | "none")}
            options={[
              { value: "none", label: t("tasks.dialog.freq.none") },
              { value: "daily", label: t("tasks.dialog.freq.daily") },
              { value: "weekdays", label: t("tasks.dialog.freq.weekdays") },
              { value: "once", label: t("tasks.dialog.freq.once") },
            ]}
          />
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
            <ClipboardCopy /> {t("tasks.dialog.askAgent")}
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
            {t("actions.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
