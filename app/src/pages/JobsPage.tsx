import {
  jobsForProject,
  useProjectScope,
} from "@/features/workbench/project-scope";
import { useWorkspaceSnapshot } from "@/features/workbench/snapshot-store";
import { useState } from "react";
import {
  Activity,
  History,
  Search,
  CircleCheck,
  CircleX,
  ExternalLink,
  Play,
  RefreshCw,
  Square,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  CollectionEmpty,
  CollectionFilters,
  CollectionIntro,
  CollectionSearch,
} from "@/components/CollectionTools";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Job, ProgressEntry } from "@/lib/types";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  JOB_KIND_KO,
  JOB_RUNNER_KO,
  JOB_STATUS_KO,
  MarkdownView,
  PageHeader,
  WARN_TEXT,
  entryText,
  fmtClock,
  fmtDur,
  jobBadgeVariant,
  jobStatusLabel,
  jobStatusVariant,
  useTicker,
} from "./common";

function EntryIcon({
  kind,
  isError,
}: {
  kind: ProgressEntry["kind"];
  isError?: boolean;
}) {
  if (isError)
    return <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
  if (kind === "init")
    return <Play className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === "tool")
    return <Wrench className={`mt-0.5 size-3.5 shrink-0 ${WARN_TEXT}`} />;
  if (kind === "result")
    return <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />;
  return (
    <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
  );
}

export default function JobsPage() {
  const allJobs = useApp((s) => s.jobs);
  const projectId = useProjectScope((s) => s.projectId);
  const selectProject = useProjectScope((s) => s.selectProject);
  const snapshot = useWorkspaceSnapshot((s) => s.snapshot);
  const project = snapshot?.projects.find((p) => p.id === projectId);
  const jobs = jobsForProject(allJobs, project);
  const progress = useApp((s) => s.progress);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const { t, i18n } = useTranslation("sessions");
  const { t: tc } = useTranslation("collections");
  const setPage = useApp((s) => s.setPage);
  const [query, setQuery] = useState("");
  const [resultFilter, setResultFilter] = useState("all");
  const [actionError, setActionError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logView, setLogView] = useState<{
    label: string;
    lines: string[];
  } | null>(null);
  const [reportView, setReportView] = useState<{
    label: string;
    md: string | null;
  } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [focusError, setFocusError] = useState<string | null>(null);

  const active = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const history = jobs
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .sort(
      (a, b) =>
        (b.finishedAtMs ?? b.createdAtMs) - (a.finishedAtMs ?? a.createdAtMs),
    );

  const visibleHistory = history.filter(
    (job) =>
      (resultFilter === "all" || job.status === resultFilter) &&
      `${job.label} ${job.project ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const hasFilters = resultFilter !== "all" || query.trim().length > 0;
  function resetFilters() {
    setQuery("");
    setResultFilter("all");
  }
  function finishedLabel(ms?: number) {
    return ms
      ? new Date(ms).toLocaleString(i18n.language, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "-";
  }

  useTicker(active.some((j) => j.status === "running"));

  // follow the user's pick while it stays active, otherwise the oldest active job
  const currentId =
    selectedId != null && active.some((j) => j.id === selectedId)
      ? selectedId
      : (active[0]?.id ?? null);
  const current = active.find((j) => j.id === currentId) ?? null;
  const entries = current ? (progress[current.id] ?? []) : [];
  const timeline = entries.slice(-200).reverse();

  async function cancel(id: string) {
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelJob(id);
      await refreshJobs();
    } catch (error) {
      setActionError(tc("jobs.cancelFailed", { error: String(error) }));
    } finally {
      setCancelling(false);
    }
  }

  // herdr jobs run in a real pane — hand the user the session instead of a summary.
  async function focus(j: Job) {
    setFocusError(null);
    try {
      await api.focusJob(j.id);
    } catch (e) {
      setFocusError(String(e));
    }
  }

  async function openLog(j: Job) {
    try {
      setLogView({ label: j.label, lines: await api.jobLog(j.id) });
    } catch (e) {
      setLogView({
        label: j.label,
        lines: [t("jobs.logReadFailed", { error: String(e) })],
      });
    }
  }

  async function openReport(j: Job) {
    try {
      setReportView({ label: j.label, md: await api.jobReport(j.id) });
    } catch {
      setReportView({ label: j.label, md: null });
    }
  }

  return (
    <div>
      <PageHeader title={t("jobs.title")}>
        <Select
          aria-label={t("workbench:scope.label")}
          size="sm"
          value={project?.id ?? ""}
          onChange={(v) => selectProject(v)}
          options={[
            { value: "", label: t("workbench:scope.all") },
            ...(snapshot?.projects ?? []).map((entry) => ({
              value: entry.id,
              label: entry.name,
            })),
          ]}
        />
        <Button size="sm" variant="outline" onClick={() => void refreshJobs()}>
          <RefreshCw /> {t("actions.refresh")}
        </Button>
      </PageHeader>

      <div className="mx-auto max-w-6xl space-y-6 p-4 lg:p-6">
        <CollectionIntro description={tc("jobs.description")} />
        {(actionError || focusError) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {actionError || t("jobs.focusFailed", { error: focusError })}
          </p>
        )}
        {active.length === 0 ? (
          <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-background p-5">
            <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Activity className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-medium">{tc("jobs.idle")}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {tc("jobs.idleHint")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage("task-library")}
            >
              {tc("jobs.openLibrary")}
            </Button>
          </div>
        ) : (
          <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {t("jobs.activeTitle")}
                </CardTitle>
                <Badge variant="secondary">{active.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {active.length === 0 ? (
                  <Empty>{t("jobs.emptyActive")}</Empty>
                ) : (
                  active.map((j) => (
                    <div
                      key={j.id}
                      className={`rounded-lg border px-3 py-3 ${
                        j.id === currentId
                          ? "border-primary/40 bg-primary/5"
                          : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={jobStatusVariant(j)}>
                          {jobStatusLabel(j)}
                        </Badge>
                        <button
                          className="min-w-32 flex-1 break-words text-left text-sm font-medium hover:underline"
                          aria-pressed={j.id === currentId}
                          onClick={() => setSelectedId(j.id)}
                          title={t("jobs.seeTimeline")}
                        >
                          {j.label}
                        </button>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {fmtDur(
                            Date.now() - (j.startedAtMs ?? j.createdAtMs),
                          )}
                        </span>
                        {j.runner === "herdr" && (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => void focus(j)}
                          >
                            <ExternalLink /> herdr
                          </Button>
                        )}
                        {j.status === "running" && (
                          <Button
                            size="xs"
                            variant="destructive"
                            aria-label={tc("jobs.cancelRun", { label: j.label })}
                                disabled={cancelling}
                            onClick={() => void cancel(j.id)}
                          >
                            <Square /> {t("actions.cancel")}
                          </Button>
                        )}
                      </div>
                      {j.agentStatus === "blocked" && (
                        <div className={`mt-1 text-[11px] ${WARN_TEXT}`}>
                          {t("jobs.blockedNote")}
                        </div>
                      )}
                      {j.project && (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {j.project}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {t("jobs.timelineTitle")}
                </CardTitle>
                {current && (
                  <div className="flex gap-1">
                    <Badge variant="outline">{JOB_KIND_KO[current.kind]}</Badge>
                    <Badge variant="secondary">
                      {JOB_RUNNER_KO[current.runner]}
                    </Badge>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {current && (
                  <p className="mb-4 break-words text-sm font-medium">
                    {current.label}
                  </p>
                )}
                {!current ? (
                  <Empty>{t("jobs.emptyCurrent")}</Empty>
                ) : timeline.length === 0 ? (
                  <Empty>{t("jobs.waitingEvents")}</Empty>
                ) : (
                  <div className="max-h-[420px] space-y-0.5 overflow-y-auto">
                    {timeline.map((e, i) => (
                      <div
                        key={`${e.tsMs}-${i}`}
                        className="flex items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted/50"
                      >
                        <span className="shrink-0 pt-0.5 text-[11px] tabular-nums text-muted-foreground">
                          {fmtClock(e.tsMs)}
                        </span>
                        <EntryIcon kind={e.kind} isError={e.isError} />
                        <span
                          className={`min-w-0 flex-1 break-words ${e.isError ? "text-destructive" : ""}`}
                        >
                          {entryText(e)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        )}
        <section
          className="overflow-hidden rounded-xl border bg-background"
          aria-label={tc("jobs.history")}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <History className="size-4 text-muted-foreground" />
              {tc("jobs.history")}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {history.length}
              </span>
            </h2>
            <CollectionSearch
              value={query}
              onChange={setQuery}
              label={tc("jobs.search")}
            />
          </div>
          <div className="border-b px-3 py-2">
            <CollectionFilters
              value={resultFilter}
              onChange={setResultFilter}
              label={tc("jobs.filters")}
              options={[
                { value: "all", label: tc("jobs.all"), count: history.length },
                ...(
                  ["success", "failed", "cancelled", "interrupted"] as const
                ).map((status) => ({
                  value: status,
                  label: JOB_STATUS_KO[status],
                  count: history.filter((job) => job.status === status).length,
                })),
              ]}
            />
          </div>
          {visibleHistory.length === 0 ? (
            <CollectionEmpty
              icon={hasFilters ? Search : History}
              title={hasFilters ? tc("noResults") : t("jobs.emptyHistory")}
              description={
                hasFilters ? tc("noResultsHint") : tc("jobs.idleHint")
              }
            >
              {hasFilters && (
                <Button size="sm" variant="outline" onClick={resetFilters}>
                  {tc("reset")}
                </Button>
              )}
            </CollectionEmpty>
          ) : (
            <Table className="[&_td]:px-4 [&_td]:py-3 [&_th]:px-4 [&_th]:py-2">
              <TableHeader>
                <TableRow>
                  <TableHead>{t("jobs.label")}</TableHead>
                  <TableHead className="w-24">{t("jobs.status")}</TableHead>
                  <TableHead className="w-44">{t("jobs.finishedAt")}</TableHead>
                  <TableHead className="w-24">{t("jobs.duration")}</TableHead>
                  <TableHead className="w-32">
                    <span className="sr-only">{tc("jobs.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleHistory.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <div
                        className="min-w-40 max-w-md break-words text-sm font-medium"
                        title={j.label}
                      >
                        {j.label}
                        {j.error && (
                          <span
                            className={`ml-1 inline-flex align-[-2px] ${WARN_TEXT}`}
                            title={j.error}
                          >
                            <TriangleAlert className="size-3" />
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        <span>{JOB_KIND_KO[j.kind]}</span>
                        {j.project && <span>{j.project}</span>}
                        <span>
                          {JOB_RUNNER_KO[j.runner] ?? JOB_RUNNER_KO.headless}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={jobBadgeVariant(j.status)}>
                        {JOB_STATUS_KO[j.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {finishedLabel(j.finishedAtMs)}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums text-muted-foreground">
                      {j.finishedAtMs
                        ? fmtDur(
                            j.finishedAtMs - (j.startedAtMs ?? j.createdAtMs),
                          )
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void openLog(j)}
                        >
                          {t("jobs.log")}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => void openReport(j)}
                        >
                          {t("jobs.report")}
                        </Button>
                        {j.runner === "herdr" && j.herdrTabId && (
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => void focus(j)}
                          >
                            herdr
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>

      <Dialog
        open={logView != null}
        onClose={() => setLogView(null)}
        wide
        title={t("jobs.logTitle", { label: logView?.label ?? "" })}
      >
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2.5 text-[11px] leading-relaxed selectable">
          {logView?.lines.join("\n")}
        </pre>
      </Dialog>

      <Dialog
        open={reportView != null}
        onClose={() => setReportView(null)}
        wide
        title={t("jobs.reportTitle", { label: reportView?.label ?? "" })}
      >
        {reportView?.md ? (
          <MarkdownView src={reportView.md} className="selectable" />
        ) : (
          <Empty>{t("jobs.emptyReport")}</Empty>
        )}
      </Dialog>
    </div>
  );
}
