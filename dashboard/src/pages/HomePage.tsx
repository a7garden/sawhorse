import { useEffect, useState } from "react";
import { ArrowRight, Play, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { Job, ProgressEntry, RoutineName } from "@/lib/types";
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

const ROUTINES: { key: RoutineName; label: string }[] = [
  { key: "morning", label: "아침" },
  { key: "lunch", label: "점심" },
  { key: "evening", label: "저녁" },
];

// Job.label is backend-owned text; match routine jobs by name keywords.
const ROUTINE_LABEL_RE: Record<RoutineName, RegExp> = {
  morning: /morning|아침/i,
  lunch: /lunch|점심/i,
  evening: /evening|저녁/i,
};

export default function HomePage() {
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const improvements = useApp((s) => s.improvements);
  const jobs = useApp((s) => s.jobs);
  const progress = useApp((s) => s.progress);
  const missed = useApp((s) => s.missed);
  const setPage = useApp((s) => s.setPage);
  const openWizard = useApp((s) => s.openWizard);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const refreshMissed = useApp((s) => s.refreshMissed);
  const [busy, setBusy] = useState(false);

  useTicker(jobs.some((j) => j.status === "running"));

  useEffect(() => {
    // job-finished events refresh the list, but queued→running has no event; poll lightly.
    const t = setInterval(() => void refreshJobs(), 10000);
    return () => clearInterval(t);
  }, [refreshJobs]);

  const activeJobs = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const today = fmtDate(Date.now());

  const problems: string[] = [];
  if (config && !config.exists)
    problems.push("설정 파일(~/.claude/si-workbench/config.json)이 없습니다. 볼트 경로만 지정해도 시작할 수 있습니다.");
  if (diag && !diag.vaultPathOk) problems.push("볼트 경로가 유효하지 않습니다. 설정에서 경로를 확인하세요.");
  if (diag && !diag.claudeOk) problems.push("claude CLI를 실행할 수 없습니다. 설정에서 실행 파일 위치를 확인하세요.");
  if (diag) {
    const bad = diag.projects.filter((p) => !p.pathOk).map((p) => p.name);
    if (bad.length > 0) problems.push(`프로젝트 경로 확인 실패: ${bad.join(", ")}`);
  }

  async function runRoutine(r: RoutineName) {
    setBusy(true);
    try {
      await api.runRoutineNow(r);
      await refreshJobs();
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
      <PageHeader title="홈" desc="루틴과 개선 사이클, 실행 상태를 한눈에 봅니다." />
      <div className="space-y-4 p-4">

        {problems.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div className={`flex items-center gap-2 text-[13px] font-semibold ${WARN_TEXT}`}>
              <TriangleAlert className="size-4" /> 진단 문제 {problems.length}건
            </div>
            <ul className="mt-1 list-disc pl-9 text-xs text-muted-foreground">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <div className="mt-2 flex items-center gap-2">
              <Button size="xs" variant="outline" onClick={() => setPage("settings")}>
                설정으로 이동
              </Button>
              {(!config?.exists || config?.vaultPath.length === 0) && (
                <Button size="xs" variant="outline" onClick={openWizard}>
                  설정 마법사
                </Button>
              )}
            </div>
          </div>
        )}

        {missed.length > 0 && (
          <section className="space-y-2">
            {missed.map((m) => {
              const label = ROUTINES.find((r) => r.key === m.routine)?.label ?? m.routine;
              return (
                <div
                  key={m.key}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2"
                >
                  <TriangleAlert className={`size-4 shrink-0 ${WARN_TEXT}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">{label} 루틴을 놓쳤습니다</div>
                    <div className="text-xs text-muted-foreground">
                      {m.date} {m.scheduledAt} 예정 — 자동 실행되지 않았습니다. 확인 후 실행하세요.
                    </div>
                  </div>
                  <Button size="sm" disabled={busy} onClick={() => void dismissMissed(m.key, true)}>
                    <Play /> 실행
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismissMissed(m.key, false)}>
                    건너뛰기
                  </Button>
                </div>
              );
            })}
          </section>
        )}

        <section className="grid gap-3 sm:grid-cols-3">
          {ROUTINES.map((r) => {
            const sched = config?.dashboard.schedules[r.key];
            const rjobs = jobs.filter((j) => j.kind === "routine" && ROUTINE_LABEL_RE[r.key].test(j.label));
            const running = rjobs.find((j) => j.status === "running");
            const queued = rjobs.find((j) => j.status === "queued");
            const doneToday = rjobs.some(
              (j) => j.status === "success" && j.finishedAtMs != null && fmtDate(j.finishedAtMs) === today,
            );
            const isMissed = missed.some((m) => m.routine === r.key && m.date === today);

            let state: { label: string; variant: BadgeVariant } = { label: "예정", variant: "outline" };
            if (running) state = { label: "실행중", variant: "default" };
            else if (queued) state = { label: "대기", variant: "secondary" };
            else if (isMissed) state = { label: "놓침", variant: "warning" as const };
            else if (doneToday) state = { label: "완료", variant: "success" as const };
            else if (sched && !sched.enabled) state = { label: "꺼짐", variant: "outline" as const };

            return (
              <Card key={r.key}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle className="text-[13px]">{r.label} 루틴</CardTitle>
                  <Badge variant={state.variant}>{state.label}</Badge>
                </CardHeader>
                <CardContent>
                  <div className="text-xs text-muted-foreground">
                    {sched?.enabled ? `매일 ${sched.time}` : "비활성"}
                    {running ? ` · 시작 ${fmtClock(running.startedAtMs)}` : ""}
                    {queued ? ` · 등록 ${fmtClock(queued.createdAtMs)}` : ""}
                  </div>
                  <Button
                    className="mt-2 w-full"
                    size="sm"
                    variant={isMissed ? "default" : "outline"}
                    disabled={busy || !!running || !!queued}
                    onClick={() => void runRoutine(r.key)}
                  >
                    <Play /> 지금 실행
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">개선 사이클</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              {(
                [
                  ["제안", improvements.filter((n) => n.status === "제안").length],
                  ["승인대기", improvements.filter((n) => n.status === "승인대기").length],
                  ["구현대기", improvements.filter((n) => n.status === "승인").length],
                ] as const
              ).map(([label, n]) => (
                <button
                  key={label}
                  onClick={() => setPage("improve")}
                  className="rounded-lg border p-2 text-left transition-colors hover:bg-accent"
                >
                  <div className="text-lg font-bold tabular-nums">{n}</div>
                  <div className="text-[11px] text-muted-foreground">{label}</div>
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">실행 중 잡</CardTitle>
              <Button size="xs" variant="ghost" onClick={() => setPage("jobs")}>
                작업 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeJobs.length === 0 ? (
                <Empty>대기 중인 작업이 없습니다.</Empty>
              ) : (
                activeJobs.map((j) => <ActiveJobRow key={j.id} job={j} entries={progress[j.id] ?? []} />)
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

function ActiveJobRow({ job, entries }: { job: Job; entries: ProgressEntry[] }) {
  const last = entries[entries.length - 1];
  const elapsed = Date.now() - (job.startedAtMs ?? job.createdAtMs);
  return (
    <div className="rounded-lg border px-2.5 py-2">
      <div className="flex items-center gap-2">
        <Badge variant={jobBadgeVariant(job.status)}>{JOB_STATUS_KO[job.status]}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{job.label}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{fmtDur(elapsed)} 경과</span>
      </div>
      <div className="mt-1 truncate text-[11px] text-muted-foreground">
        {last ? entryText(last) : "진행 이벤트를 기다리는 중…"}
      </div>
    </div>
  );
}
