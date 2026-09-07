import { useEffect, useState } from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { RunButton } from "@/components/RunButton";
import type { Job, ProgressEntry, ScheduleView } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BadgeVariant } from "./common";
import {
  Empty,
  JOB_STATUS_KO,
  PageHeader,
  WARN_TEXT,
  entryText,
  fmtClock,
  fmtDate,
  fmtDur,
  jobBadgeVariant,
  useTicker,
} from "./common";

// 예약과 잡은 중복 판정 키로 잇는다 — 라벨이 아니라 "무엇을 하는 잡인가"가 기준이라,
// 예약이 돌린 잡이든 사람이 다른 화면에서 누른 잡이든 같은 칸에 보인다.
function jobsFor(jobs: Job[], s: ScheduleView): Job[] {
  return jobs.filter((j) => j.dedupKey === s.jobKey);
}

export default function HomePage() {
  const { t } = useTranslation("settings");
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const improvements = useApp((s) => s.improvements);
  const jobs = useApp((s) => s.jobs);
  const progress = useApp((s) => s.progress);
  const missed = useApp((s) => s.missed);
  const schedules = useApp((s) => s.schedules);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const setPage = useApp((s) => s.setPage);
  const openWizard = useApp((s) => s.openWizard);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const refreshMissed = useApp((s) => s.refreshMissed);
  const todos = useApp((s) => s.todos);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const audit = useApp((s) => s.audit);
  const inboxCount = useApp((s) => s.inboxCount);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useTicker(jobs.some((j) => j.status === "running"));

  useEffect(() => {
    void refreshAudit();
    void refreshSchedules();
    // job-finished events refresh the list, but queued→running has no event; poll lightly.
    const interval = setInterval(() => {
      void refreshJobs();
      void refreshSchedules();
    }, 10000);
    return () => clearInterval(interval);
  }, [refreshJobs, refreshAudit, refreshSchedules]);

  const activeJobs = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const today = fmtDate(Date.now());

  const problems: string[] = [];
  if (config && !config.exists)
    problems.push(t("home.problems.configMissing"));
  if (diag && !diag.vaultPathOk)
    problems.push(t("home.problems.vaultPath"));
  if (diag && !diag.claudeOk)
    problems.push(t("home.problems.claudeCli"));
  if (diag) {
    const bad = diag.projects.filter((p) => !p.pathOk).map((p) => p.name);
    if (bad.length > 0)
      problems.push(t("home.problems.projectPaths", { names: bad.join(", ") }));
  }

  async function toggleToday(index: number, checked: boolean) {
    if (!todos) return;
    try {
      await api.toggleTodo("today", index, checked);
      await refreshTodos();
    } catch (e) {
      console.error(e);
    }
  }

  async function runScheduled(key: string) {
    setBusy(true);
    try {
      await api.runScheduledNow(key);
      await Promise.all([refreshJobs(), refreshSchedules()]);
    } finally {
      setBusy(false);
    }
  }

  async function dismissMissed(key: string, run: boolean) {
    setBusy(true);
    try {
      await api.dismissMissed(key, run);
      await refreshMissed();
      if (run) await refreshJobs();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("home.title")} />
      <div className="space-y-4 p-4">
        {msg && (
          <div className="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive">
            {msg}
          </div>
        )}

        {problems.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div
              className={`flex items-center gap-2 text-[13px] font-semibold ${WARN_TEXT}`}
            >
              <TriangleAlert className="size-4" />{" "}
              {t("home.problems.count", { count: problems.length })}
            </div>
            <ul className="mt-1 list-disc pl-9 text-xs text-muted-foreground">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => setPage("settings")}
              >
                {t("home.goToSettings")}
              </Button>
              {(!config?.exists || config?.vaultPath.length === 0) && (
                <Button size="xs" variant="outline" onClick={openWizard}>
                  {t("home.setupWizard")}
                </Button>
              )}
            </div>
          </div>
        )}

        {missed.length > 0 && (
          <section className="space-y-2">
            {missed.map((m) => {
              const label =
                m.label ||
                schedules.find((s) => s.key === m.routine)?.label ||
                m.routine;
              return (
                <div
                  key={m.key}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
                >
                  <TriangleAlert className={`size-4 shrink-0 ${WARN_TEXT}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">
                      {t("home.missed.title", { label })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("home.missed.detail", {
                        date: m.date,
                        time: m.scheduledAt,
                      })}
                    </div>
                  </div>
                  <RunButton
                    size="sm"
                    variant="default"
                    jobKey={
                      schedules.find((s) => s.key === m.routine)?.jobKey ?? ""
                    }
                    label={t("actions.run")}
                    disabled={busy}
                    onRun={() => dismissMissed(m.key, true)}
                    onError={setMsg}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void dismissMissed(m.key, false)}
                  >
                    {t("home.skip")}
                  </Button>
                </div>
              );
            })}
          </section>
        )}

        {schedules.length > 0 && (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {schedules.map((s) => {
              const sjobs = jobsFor(jobs, s);
              const running = sjobs.find((j) => j.status === "running");
              const queued = sjobs.find((j) => j.status === "queued");
              const doneToday =
                s.lastRun === today ||
                sjobs.some(
                  (j) =>
                    j.status === "success" &&
                    j.finishedAtMs != null &&
                    fmtDate(j.finishedAtMs) === today,
                );
              const isMissed = missed.some(
                (m) => m.routine === s.key && m.date === today,
              );

              let state: { label: string; variant: BadgeVariant } = {
                label: t("home.state.scheduled"),
                variant: "outline",
              };
              if (running) state = { label: t("home.state.running"), variant: "default" };
              else if (queued) state = { label: t("home.state.queued"), variant: "secondary" };
              else if (isMissed)
                state = { label: t("home.state.missed"), variant: "warning" as const };
              else if (doneToday)
                state = { label: t("home.state.done"), variant: "success" as const };
              else if (!s.enabled)
                state = { label: t("home.state.off"), variant: "outline" as const };

              return (
                <Card key={s.key}>
                  <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                    <CardTitle
                      className="min-w-0 truncate text-[13px]"
                      title={s.label}
                    >
                      {s.label}
                    </CardTitle>
                    <Badge variant={state.variant}>{state.label}</Badge>
                  </CardHeader>
                  <CardContent>
                    <div className="text-xs text-muted-foreground">
                      {s.enabled
                        ? `${s.kind === "weekdays" ? t("home.schedule.weekdays") : t("home.schedule.daily")} ${s.time}`
                        : t("home.schedule.disabled")}
                      {running
                        ? ` · ${t("home.card.startedAt", { time: fmtClock(running.startedAtMs) })}`
                        : ""}
                      {queued
                        ? ` · ${t("home.card.queuedAt", { time: fmtClock(queued.createdAtMs) })}`
                        : ""}
                    </div>
                    <RunButton
                      className="mt-2 w-full"
                      size="sm"
                      variant={isMissed ? "default" : "outline"}
                      jobKey={s.jobKey}
                      label={t("actions.runNow")}
                      disabled={busy}
                      onRun={() => runScheduled(s.key)}
                      onError={setMsg}
                    />
                  </CardContent>
                </Card>
              );
            })}
          </section>
        )}

        <section className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                {t("home.todayTitle")}
                {todos && todos.today.length > 0 && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    {todos.today.filter((t) => t.checked).length}/
                    {todos.today.length}
                  </span>
                )}
              </CardTitle>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setPage("todos")}
              >
                {t("home.viewAll")} <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent>
              {!todos || !todos.fileExists || todos.today.length === 0 ? (
                <Empty>{t("home.emptyToday")}</Empty>
              ) : (
                <div className="space-y-1">
                  {todos.today.map((t) => (
                    <label
                      key={t.index}
                      className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-accent"
                    >
                      <input
                        type="checkbox"
                        checked={t.checked}
                        onChange={(e) =>
                          void toggleToday(t.index, e.target.checked)
                        }
                        className="size-3.5 accent-[var(--primary)]"
                      />
                      <span
                        className={
                          t.checked ? "text-muted-foreground line-through" : ""
                        }
                      >
                        {t.text}
                      </span>
                    </label>
                  ))}
                  {todos.tomorrow.length > 0 && (
                    <details className="pt-1">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        {t("home.tomorrow", { count: todos.tomorrow.length })}
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-5 text-xs text-muted-foreground list-disc">
                        {todos.tomorrow.map((t) => (
                          <li key={t.index}>{t.text}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("home.activityTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("home.doneToday")}</span>
                <span className="font-semibold tabular-nums">
                  {
                    jobs.filter(
                      (j) =>
                        j.status === "success" &&
                        j.finishedAtMs != null &&
                        fmtDate(j.finishedAtMs) === today,
                    ).length
                  }
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("home.failedToday")}</span>
                <span className="font-semibold tabular-nums">
                  {
                    jobs.filter(
                      (j) =>
                        j.status === "failed" &&
                        j.finishedAtMs != null &&
                        fmtDate(j.finishedAtMs) === today,
                    ).length
                  }
                </span>
              </div>
              {(() => {
                const failed = jobs
                  .filter((j) => j.status === "failed")
                  .sort(
                    (a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0),
                  )[0];
                return failed ? (
                  <button
                    onClick={() => setPage("jobs")}
                    className="w-full rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-left"
                  >
                    <span className="block truncate font-medium">
                      {failed.label}
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("home.lastFailed", {
                        time: failed.finishedAtMs ? fmtClock(failed.finishedAtMs) : "",
                      })}{" "}
                    </span>
                  </button>
                ) : null;
              })()}
              <Button
                size="xs"
                variant="outline"
                className="w-full"
                onClick={() => setPage("docs")}
              >
                {t("home.lastReport")} <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("home.vaultTitle")}</CardTitle>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setPage("vault")}
              >
                {t("home.vaultCheck")} <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <button
                onClick={() => setPage("vault")}
                className="flex w-full items-center justify-between rounded-md border p-2 text-left transition-colors hover:bg-accent"
              >
                <span className="text-muted-foreground">{t("home.unpromoted")}</span>
                <span className="text-lg font-bold tabular-nums">
                  {inboxCount}
                </span>
              </button>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t("home.journalToday")}</span>
                {audit == null ? (
                  <Badge variant="outline">{t("home.journal.unchecked")}</Badge>
                ) : audit.journal.todayExists ? (
                  <Badge variant="success">{t("home.journal.yes")}</Badge>
                ) : (
                  <Badge variant="warning">{t("home.journal.no")}</Badge>
                )}
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">{t("home.recentIssues")}</div>
                {improvements.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {t("home.noIssues")}
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {improvements.slice(0, 3).map((n) => (
                      <li key={n.path} className="truncate">
                        <button
                          onClick={() => setPage("improve")}
                          className="text-left hover:underline"
                          title={n.title}
                        >
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {n.id}
                          </span>{" "}
                          {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("home.issueFlow")}</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              {(
                [
                  [
                    t("home.flow.proposal"),
                    improvements.filter((n) => n.status === "제안").length,
                  ],
                  [
                    t("home.flow.awaiting"),
                    improvements.filter((n) => n.status === "승인대기").length,
                  ],
                  [
                    t("home.flow.ready"),
                    improvements.filter((n) => n.status === "승인").length,
                  ],
                ] as const
              ).map(([label, n]) => (
                <button
                  key={label}
                  onClick={() => setPage("improve")}
                  className="rounded-lg border p-2 text-left transition-colors hover:bg-accent"
                >
                  <div className="text-lg font-bold tabular-nums">{n}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {label}
                  </div>
                </button>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("home.runningJobs")}</CardTitle>
              <Button size="xs" variant="ghost" onClick={() => setPage("jobs")}>
                {t("home.jobs")} <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeJobs.length === 0 ? (
                <Empty>{t("home.emptyJobs")}</Empty>
              ) : (
                activeJobs.map((j) => (
                  <ActiveJobRow
                    key={j.id}
                    job={j}
                    entries={progress[j.id] ?? []}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

function ActiveJobRow({
  job,
  entries,
}: {
  job: Job;
  entries: ProgressEntry[];
}) {
  const last = entries[entries.length - 1];
  const { t } = useTranslation("settings");
  const elapsed = Date.now() - (job.startedAtMs ?? job.createdAtMs);
  return (
    <div className="rounded-lg border px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Badge variant={jobBadgeVariant(job.status)}>
          {JOB_STATUS_KO[job.status]}
        </Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {job.label}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {t("home.elapsed", { duration: fmtDur(elapsed) })}
        </span>
      </div>
      <div className="mt-1 truncate text-[11px] text-muted-foreground">
        {last ? entryText(last) : t("home.waitingEvents")}
      </div>
    </div>
  );
}
