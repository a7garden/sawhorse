// TasksPage — manages automation tasks (TaskDef): pending-review requests, scheduled definitions,
// and definitions run on demand. A different concept from the dev board's work items (WorkItem).
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  ClipboardCopy,
  Pencil,
  Plus,
  Play,
  Repeat,
  Search,
  Trash2,
} from "lucide-react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api, EVENTS } from "@/lib/api";
import { useApp } from "@/lib/store";
import {
  CollectionEmpty,
  CollectionFilters,
  CollectionIntro,
  CollectionSearch,
} from "@/components/CollectionTools";
import { RunButton } from "@/components/RunButton";
import AutomationTimeline from "@/features/automation/AutomationTimeline";
import type {
  PackAction,
  PackInfo,
  ScheduleKind,
  TaskDef,
  TaskRow,
  TaskSchedule,
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
    weekly: (s.days ?? [])
      .map((day) => i18n.t(`settings:tasks.days.${day}`))
      .join("·"),
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
  const [category, setCategory] = useState("all");
  const [query, setQuery] = useState("");
  const { t: tc } = useTranslation("collections");
  const [choosing, setChoosing] = useState(false);
  const [view, setView] = useState<TasksView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<TaskDef | null>(null);
  const [open, setOpen] = useState(false);
  const [scheduleEditing, setScheduleEditing] = useState(false);
  const [actionTarget, setActionTarget] = useState<{
    pack: PackInfo;
    action: PackAction;
  } | null>(null);
  const packs = useApp((s) => s.packs);
  const config = useApp((s) => s.config);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshConfig = useApp((s) => s.refreshConfig);
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
    // Re-fetch on the tasks-changed event. A listen that arrives late is unbound and discarded (unmount race).
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
      await Promise.all([refresh(), refreshSchedules(), refreshConfig()]);
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
    const separator = row.def.id.indexOf(".");
    const packId = row.def.id.slice(0, separator);
    const actionId = row.def.id.slice(separator + 1);
    const pack = packs?.packs.find((candidate) => candidate.id === packId);
    const action = pack?.actions.find((candidate) => candidate.id === actionId);
    return pack && action ? { pack, action } : null;
  };

  const candidates =
    mode === "library"
      ? all.filter(
          (row) =>
            category === "all" ||
            (category === "builtin" ? row.def.builtin : !row.def.builtin),
        )
      : scheduled;
  const visible = candidates.filter((row) =>
    [
      row.def.title,
      row.def.prompt,
      row.def.project,
      packActionFor(row)?.pack.name,
    ]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const filtered =
    query.trim().length > 0 ||
    (mode === "library" ? category !== "all" : filter !== "all");
  function resetFilters() {
    setQuery("");
    setCategory("all");
    setFilter("all");
  }

  function openSchedule(row: TaskRow, schedule?: TaskSchedule) {
    setEditing({
      ...row.def,
      schedule: schedule ??
        row.def.schedule ?? { kind: "daily", time: "09:00" },
      enabled: schedule || !row.def.schedule ? true : row.def.enabled,
    });
    setScheduleEditing(true);
    setOpen(true);
  }

  async function placeSchedule(row: TaskRow, schedule: TaskSchedule) {
    const action = packActionFor(row)?.action;
    const params = row.def.action?.params ?? {};
    if (
      action?.params.some(
        (field) =>
          field.required &&
          (params[field.key] == null ||
            String(params[field.key]).trim() === ""),
      )
    ) {
      openSchedule(row, schedule);
      return;
    }
    await guard(() =>
      api.saveTask({
        ...row.def,
        schedule,
        enabled: row.def.schedule ? row.def.enabled : true,
        action: row.def.builtin ? { id: row.def.id, params } : row.def.action,
      }),
    );
  }

  async function runRow(row: TaskRow) {
    const target = packActionFor(row);
    if (
      target &&
      target.action.params.length > 0 &&
      (!row.def.action ||
        target.action.params.some(
          (field) =>
            field.required &&
            !String(row.def.action?.params[field.key] ?? "").trim(),
        ))
    ) {
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
      <PageHeader
        title={
          mode === "library"
            ? t("tasks.title.library")
            : t("tasks.title.schedules")
        }
      >
        <Button
          size="sm"
          onClick={() => {
            if (mode === "schedules") setChoosing(true);
            else {
              setEditing(null);
              setScheduleEditing(false);
              setOpen(true);
            }
          }}
        >
          <Plus />{" "}
          {mode === "library" ? t("tasks.add") : t("tasks.addReservation")}
        </Button>
      </PageHeader>

      <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-6">
        <CollectionIntro
          description={tc(
            mode === "library"
              ? "tasks.libraryDescription"
              : "tasks.schedulesDescription",
          )}
        >
          {view && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {mode === "library"
                ? tc("tasks.count", { count: all.length })
                : tc("tasks.enabled", {
                    count: all.filter(
                      (row) => row.def.schedule && row.def.enabled,
                    ).length,
                  })}
            </span>
          )}
        </CollectionIntro>
        {err && (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive"
          >
            {err}
          </div>
        )}

        {view && view.pending.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                {t("tasks.pendingTitle")}
              </CardTitle>
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
          <AutomationTimeline
            rows={all}
            busy={busy}
            onPlace={placeSchedule}
            onEdit={openSchedule}
          />
        )}

        <section
          className="overflow-hidden rounded-xl border bg-background"
          aria-label={
            mode === "library"
              ? t("tasks.listTitle.library")
              : t("tasks.listTitle.schedules")
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
            <CollectionFilters
              value={mode === "library" ? category : filter}
              onChange={mode === "library" ? setCategory : setFilter}
              label={tc("tasks.filters")}
              options={
                mode === "library"
                  ? [
                      {
                        value: "all",
                        label: tc("tasks.all"),
                        count: all.length,
                      },
                      {
                        value: "custom",
                        label: tc("tasks.custom"),
                        count: all.filter((row) => !row.def.builtin).length,
                      },
                      {
                        value: "builtin",
                        label: tc("tasks.builtin"),
                        count: all.filter((row) => row.def.builtin).length,
                      },
                    ]
                  : [
                      { value: "all", label: t("tasks.filter.all") },
                      { value: "once", label: t("tasks.filter.once") },
                      { value: "repeat", label: t("tasks.filter.repeat") },
                    ]
              }
            />
            <CollectionSearch
              value={query}
              onChange={setQuery}
              label={tc("tasks.search")}
            />
          </div>
          {!view ? (
            <Empty>{err ?? tc("loading")}</Empty>
          ) : (
            <>
              <div className="divide-y">
                {visible.map((row) => (
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
                    onSchedule={() => openSchedule(row)}
                    onEdit={
                      row.def.builtin
                        ? undefined
                        : (d) => {
                            setEditing(d);
                            setScheduleEditing(false);
                            setOpen(true);
                          }
                    }
                  />
                ))}
              </div>
              {visible.length === 0 && (
                <CollectionEmpty
                  icon={
                    filtered
                      ? Search
                      : mode === "library"
                        ? Repeat
                        : CalendarClock
                  }
                  title={
                    filtered
                      ? tc("noResults")
                      : mode === "library"
                        ? t("tasks.empty.library")
                        : t("tasks.empty.schedules")
                  }
                  description={
                    filtered ? tc("noResultsHint") : tc("tasks.emptyHint")
                  }
                >
                  {filtered ? (
                    <Button variant="outline" size="sm" onClick={resetFilters}>
                      {tc("reset")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        mode === "schedules"
                          ? setChoosing(true)
                          : (setEditing(null),
                            setScheduleEditing(false),
                            setOpen(true))
                      }
                    >
                      <Plus />
                      {mode === "library"
                        ? tc("tasks.createFirst")
                        : tc("tasks.chooseForSchedule")}
                    </Button>
                  )}
                </CollectionEmpty>
              )}
            </>
          )}
        </section>
      </div>

      <Dialog
        open={choosing}
        onClose={() => setChoosing(false)}
        title={t("tasks.chooseTitle")}
      >
        <p className="mb-3 text-xs text-muted-foreground">
          {t("tasks.chooseHint")}
        </p>
        {all.map((row) => (
          <button
            key={row.def.id}
            className="mb-2 block w-full rounded-lg border p-3 text-left text-sm"
            onClick={() => {
              setChoosing(false);
              openSchedule(row);
            }}
          >
            {row.def.title}
            <small className="block text-muted-foreground">
              {scheduleLabel(row.def)}
            </small>
          </button>
        ))}
        {!all.length && <Empty>{t("tasks.chooseEmpty")}</Empty>}
      </Dialog>
      <TaskDialog
        error={err}
        scheduleOnly={scheduleEditing}
        action={
          editing
            ? packActionFor({ def: editing } as TaskRow)?.action
            : undefined
        }
        projects={config?.projects.map((project) => project.name) ?? []}
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
  onSchedule,
  packName,
  hasParameters,
}: {
  row: TaskRow;
  busy: boolean;
  guard: (fn: () => Promise<unknown>) => Promise<boolean>;
  onEdit?: (def: TaskDef) => void;
  onRun: () => void;
  onSchedule?: () => void;
  packName?: string;
  hasParameters: boolean;
}) {
  const def = row.def;
  const { t } = useTranslation("settings");
  return (
    <article
      aria-label={def.title}
      className="flex flex-wrap items-center gap-4 px-4 py-4 transition-colors hover:bg-muted/30"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
        {def.schedule ? (
          <CalendarClock className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </div>
      <div className="min-w-40 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[13px] font-semibold">
            {def.title}
          </span>
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
        </div>
        {def.prompt && (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {def.prompt}
          </p>
        )}
        {(def.schedule || packName || row.lastRun) && (
          <p className="mt-2 text-xs text-muted-foreground">
            {[
              def.schedule ? scheduleLabel(def) : null,
              packName,
              row.lastRun ? t("tasks.lastRun", { time: row.lastRun }) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {
          <label
            className="flex w-28 shrink-0 items-center justify-between gap-2 text-xs"
            htmlFor={`task-enabled-${def.id}`}
          >
            <span className="sr-only">
              {t("collections:tasks.enabledLabel", { title: def.title })}
            </span>
            <span
              aria-hidden="true"
              className={
                def.schedule && def.enabled
                  ? "text-primary"
                  : "text-muted-foreground"
              }
            >
              {t(
                def.schedule && def.enabled
                  ? "tasks.state.on"
                  : "tasks.state.off",
              )}
            </span>
            <Switch
              id={`task-enabled-${def.id}`}
              checked={Boolean(def.schedule && def.enabled)}
              disabled={busy}
              onCheckedChange={(v) =>
                def.schedule
                  ? void guard(() => api.setTaskEnabled(def.id, v))
                  : onSchedule?.()
              }
            />
          </label>
        }
        <div className="flex w-24 shrink-0 justify-center">
          {onSchedule && (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={onSchedule}
            >
              <CalendarClock />
              {t(def.schedule ? "tasks.editSchedule" : "tasks.addSchedule")}
            </Button>
          )}
        </div>
        <RunButton
          size="xs"
          variant="outline"
          label={t("actions.runNow")}
          ariaLabel={t("actions.runNow")}
          title={t("actions.runNow")}
          jobKey={row.jobKey}
          disabled={busy}
          onRun={onRun}
        />
        <div className="flex w-18 shrink-0 items-center gap-2">
          {onEdit && (
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("actions.edit")}
              title={t("actions.edit")}
              disabled={busy}
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
      </div>
    </article>
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
          <ActionFields
            action={target.action}
            projects={projects}
            values={values}
            setValues={setValues}
          />
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

function ActionFields({
  action,
  projects,
  values,
  setValues,
}: {
  action: PackAction;
  projects: string[];
  values: Record<string, string>;
  setValues: (values: Record<string, string>) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-3">
      {" "}
      {action.params.map((param) => (
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
                param.type === "list"
                  ? t("tasks.dialog.listPlaceholder")
                  : undefined
              }
              onChange={(event) =>
                setValues({ ...values, [param.key]: event.target.value })
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}

function actionValues(values: Record<string, string>, action?: PackAction) {
  return Object.fromEntries(
    (action?.params ?? [])
      .filter((param) => values[param.key]?.trim())
      .map((param) => [
        param.key,
        param.type === "list"
          ? values[param.key]
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
          : values[param.key].trim(),
      ]),
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
  action,
  projects,
}: {
  action?: PackAction;
  projects: string[];
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
  const [days, setDays] = useState<number[]>([0]);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const d = editing;
    setTitle(d?.title ?? "");
    setPrompt(d?.prompt ?? "");
    setKind(d?.schedule?.kind ?? "none");
    setTime(d?.schedule?.time ?? "09:00");
    setDate(d?.schedule?.date ?? "");
    setDays(d?.schedule?.days?.length ? d.schedule.days : [0]);
    setValues(
      Object.fromEntries(
        Object.entries(d?.action?.params ?? {}).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(", ") : String(value),
        ]),
      ),
    );
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
          : { kind, time, date: null, days: kind === "weekly" ? days : [] };
    // Even though saveTask returns a normalized TaskDef, the page ignores it and syncs by re-fetching.
    if (
      await guard(() =>
        api.saveTask({
          ...base,
          title: title.trim(),
          prompt: prompt.trim(),
          schedule,
          action: base.builtin
            ? { id: base.id, params: actionValues(values, action) }
            : base.action,
          enabled: !schedule || !base.schedule ? true : base.enabled,
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
                kind === "daily"
                  ? t("tasks.ask.daily")
                  : kind === "weekly"
                    ? days.map((day) => t(`tasks.days.${day}`)).join("·")
                    : t("tasks.ask.weekdays"),
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
              { value: "weekly", label: t("tasks.dialog.freq.weekly") },
              { value: "once", label: t("tasks.dialog.freq.once") },
            ]}
          />
          {kind !== "none" && (
            <Input
              type="time"
              aria-label={t("tasks.dialog.timeLabel")}
              className="w-28"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          )}
          {kind === "once" && (
            <Input
              type="date"
              aria-label={t("tasks.dialog.dateLabel")}
              className="w-40"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            kind === "none"
              ? "tasks.groups.manualHint"
              : "tasks.groups.scheduledHint",
          )}
        </p>
        {kind === "weekly" && (
          <div
            role="group"
            aria-label={t("tasks.dialog.days")}
            className="flex flex-wrap gap-2"
          >
            {Array.from({ length: 7 }, (_, day) => (
              <Button
                key={day}
                size="sm"
                variant={days.includes(day) ? "default" : "outline"}
                aria-pressed={days.includes(day)}
                onClick={() =>
                  setDays(
                    days.includes(day)
                      ? days.filter((d) => d !== day)
                      : [...days, day].sort(),
                  )
                }
              >
                {t(`tasks.days.${day}`)}
              </Button>
            ))}
          </div>
        )}
        {kind !== "none" && (
          <div className="flex gap-2">
            {["09:00", "12:00", "18:00"].map((preset) => (
              <Button
                key={preset}
                size="xs"
                variant="outline"
                onClick={() => setTime(preset)}
              >
                {preset}
              </Button>
            ))}
          </div>
        )}
        {action && (
          <ActionFields
            action={action}
            projects={projects}
            values={values}
            setValues={setValues}
          />
        )}
        <div className="flex justify-end gap-2">
          {!scheduleOnly && (
            <Button
              className="mr-auto"
              variant="ghost"
              size="sm"
              onClick={askAgent}
            >
              <ClipboardCopy /> {t("tasks.dialog.askAgent")}
            </Button>
          )}
          <Button
            size="sm"
            disabled={
              busy ||
              !title.trim() ||
              (!editing?.builtin && !prompt.trim()) ||
              (kind === "weekly" && days.length === 0) ||
              (kind !== "none" &&
                (action?.params.some(
                  (param) => param.required && !values[param.key]?.trim(),
                ) ??
                  false)) ||
              (kind !== "none" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) ||
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
