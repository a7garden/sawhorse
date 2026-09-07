import { useState } from "react";
import {
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
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Job, ProgressEntry } from "@/lib/types";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
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
  const jobs = useApp((s) => s.jobs);
  const progress = useApp((s) => s.progress);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const { t } = useTranslation("sessions");

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
    try {
      await api.cancelJob(id);
      await refreshJobs();
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
        <Button size="sm" variant="outline" onClick={() => void refreshJobs()}>
          <RefreshCw /> {t("actions.refresh")}
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        <section className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("jobs.activeTitle")}</CardTitle>
              <Badge variant="secondary">{active.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {focusError && (
                <div className="rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive">
                  {t("jobs.focusFailed", { error: focusError })}
                </div>
              )}
              {active.length === 0 ? (
                <Empty>{t("jobs.emptyActive")}</Empty>
              ) : (
                active.map((j) => (
                  <div
                    key={j.id}
                    className={`rounded-lg border px-2.5 py-2 ${
                      j.id === currentId ? "border-primary/40" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={jobStatusVariant(j)}>
                        {jobStatusLabel(j)}
                      </Badge>
                      <button
                        className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
                        onClick={() => setSelectedId(j.id)}
                        title={t("jobs.seeTimeline")}
                      >
                        {j.label}
                      </button>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {fmtDur(Date.now() - (j.startedAtMs ?? j.createdAtMs))}
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
              <CardTitle className="text-[13px]">{t("jobs.timelineTitle")}</CardTitle>
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
              {!current ? (
                <Empty>{t("jobs.emptyCurrent")}</Empty>
              ) : timeline.length === 0 ? (
                <Empty>{t("jobs.waitingEvents")}</Empty>
              ) : (
                <div className="max-h-[360px] space-y-0.5 overflow-y-auto">
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

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">{t("jobs.historyTitle")}</CardTitle>
            <Badge variant="secondary">{history.length}</Badge>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <Empty>{t("jobs.emptyHistory")}</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">{t("jobs.kind")}</TableHead>
                    <TableHead>{t("jobs.label")}</TableHead>
                    <TableHead className="w-28">{t("jobs.project")}</TableHead>
                    <TableHead className="w-24">{t("jobs.runner")}</TableHead>
                    <TableHead className="w-24">{t("jobs.status")}</TableHead>
                    <TableHead className="w-24">{t("jobs.finishedAt")}</TableHead>
                    <TableHead className="w-24">{t("jobs.duration")}</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell>
                        <Badge variant="outline">{JOB_KIND_KO[j.kind]}</Badge>
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[280px] truncate text-xs"
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
                      </TableCell>
                      <TableCell className="truncate text-xs text-muted-foreground">
                        {j.project ?? "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {JOB_RUNNER_KO[j.runner] ?? JOB_RUNNER_KO.headless}
                      </TableCell>
                      <TableCell>
                        <Badge variant={jobBadgeVariant(j.status)}>
                          {JOB_STATUS_KO[j.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {fmtClock(j.finishedAtMs)}
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
          </CardContent>
        </Card>
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
