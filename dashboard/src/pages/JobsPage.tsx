import { useState } from "react";
import { CircleCheck, CircleX, Play, RefreshCw, Square, Terminal, TriangleAlert, Wrench } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Job, ProgressEntry } from "@/lib/types";
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
  JOB_STATUS_KO,
  MarkdownView,
  PageHeader,
  WARN_TEXT,
  entryText,
  fmtClock,
  fmtDur,
  jobBadgeVariant,
  useTicker,
} from "./common";

function EntryIcon({ kind, isError }: { kind: ProgressEntry["kind"]; isError?: boolean }) {
  if (isError) return <CircleX className="mt-0.5 size-3.5 shrink-0 text-destructive" />;
  if (kind === "init") return <Play className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
  if (kind === "tool") return <Wrench className={`mt-0.5 size-3.5 shrink-0 ${WARN_TEXT}`} />;
  if (kind === "result") return <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />;
  return <Terminal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

export default function JobsPage() {
  const jobs = useApp((s) => s.jobs);
  const progress = useApp((s) => s.progress);
  const refreshJobs = useApp((s) => s.refreshJobs);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [logView, setLogView] = useState<{ label: string; lines: string[] } | null>(null);
  const [reportView, setReportView] = useState<{ label: string; md: string | null } | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const active = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const history = jobs
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .sort((a, b) => (b.finishedAtMs ?? b.createdAtMs) - (a.finishedAtMs ?? a.createdAtMs));

  useTicker(active.some((j) => j.status === "running"));

  // follow the user's pick while it stays active, otherwise the oldest active job
  const currentId =
    selectedId != null && active.some((j) => j.id === selectedId) ? selectedId : active[0]?.id ?? null;
  const current = active.find((j) => j.id === currentId) ?? null;
  const entries = current ? progress[current.id] ?? [] : [];
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

  async function openLog(j: Job) {
    try {
      setLogView({ label: j.label, lines: await api.jobLog(j.id) });
    } catch (e) {
      setLogView({ label: j.label, lines: [`로그를 읽지 못했습니다: ${String(e)}`] });
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
      <PageHeader title="작업" desc="큐와 실행 상태를 감시하고 로그·리포트를 확인합니다.">
        <Button size="sm" variant="outline" onClick={() => void refreshJobs()}>
          <RefreshCw /> 새로고침
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        <section className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">큐 / 실행중</CardTitle>
              <Badge variant="secondary">{active.length}</Badge>
            </CardHeader>
            <CardContent className="space-y-2">
              {active.length === 0 ? (
                <Empty>대기 중인 작업이 없습니다.</Empty>
              ) : (
                active.map((j) => (
                  <div
                    key={j.id}
                    className={`rounded-lg border px-2.5 py-2 ${
                      j.id === currentId ? "border-primary/40" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge variant={jobBadgeVariant(j.status)}>{JOB_STATUS_KO[j.status]}</Badge>
                      <button
                        className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
                        onClick={() => setSelectedId(j.id)}
                        title="타임라인에서 보기"
                      >
                        {j.label}
                      </button>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {fmtDur(Date.now() - (j.startedAtMs ?? j.createdAtMs))}
                      </span>
                      {j.status === "running" && (
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={cancelling}
                          onClick={() => void cancel(j.id)}
                        >
                          <Square /> 취소
                        </Button>
                      )}
                    </div>
                    {j.project && (
                      <div className="mt-1 text-[11px] text-muted-foreground">{j.project}</div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">라이브 타임라인</CardTitle>
              {current && <Badge variant="outline">{JOB_KIND_KO[current.kind]}</Badge>}
            </CardHeader>
            <CardContent>
              {!current ? (
                <Empty>실행 중인 작업이 없습니다.</Empty>
              ) : timeline.length === 0 ? (
                <Empty>진행 이벤트를 기다리는 중…</Empty>
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
                      <span className={`min-w-0 flex-1 break-words ${e.isError ? "text-destructive" : ""}`}>
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
            <CardTitle className="text-[13px]">히스토리</CardTitle>
            <Badge variant="secondary">{history.length}</Badge>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <Empty>완료된 작업이 없습니다.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">종류</TableHead>
                    <TableHead>라벨</TableHead>
                    <TableHead className="w-28">프로젝트</TableHead>
                    <TableHead className="w-24">상태</TableHead>
                    <TableHead className="w-24">종료 시각</TableHead>
                    <TableHead className="w-24">소요</TableHead>
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
                        <div className="max-w-[280px] truncate text-xs" title={j.label}>
                          {j.label}
                          {j.error && (
                            <span className={`ml-1 inline-flex align-[-2px] ${WARN_TEXT}`} title={j.error}>
                              <TriangleAlert className="size-3" />
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="truncate text-xs text-muted-foreground">
                        {j.project ?? "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={jobBadgeVariant(j.status)}>{JOB_STATUS_KO[j.status]}</Badge>
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {fmtClock(j.finishedAtMs)}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-muted-foreground">
                        {j.finishedAtMs
                          ? fmtDur(j.finishedAtMs - (j.startedAtMs ?? j.createdAtMs))
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          <Button size="xs" variant="ghost" onClick={() => void openLog(j)}>
                            로그
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => void openReport(j)}>
                            리포트
                          </Button>
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
        title={`로그 — ${logView?.label ?? ""}`}
      >
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-2.5 text-[11px] leading-relaxed selectable">
          {logView?.lines.join("\n")}
        </pre>
      </Dialog>

      <Dialog
        open={reportView != null}
        onClose={() => setReportView(null)}
        wide
        title={`리포트 — ${reportView?.label ?? ""}`}
      >
        {reportView?.md ? (
          <MarkdownView src={reportView.md} className="selectable" />
        ) : (
          <Empty>저장된 리포트가 없습니다. 마지막 assistant 응답이 있을 때만 저장됩니다.</Empty>
        )}
      </Dialog>
    </div>
  );
}
