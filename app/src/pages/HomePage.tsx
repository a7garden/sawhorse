import { useEffect, useState } from "react";
import { ArrowRight, TriangleAlert } from "lucide-react";
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
    const t = setInterval(() => {
      void refreshJobs();
      void refreshSchedules();
    }, 10000);
    return () => clearInterval(t);
  }, [refreshJobs, refreshAudit, refreshSchedules]);

  const activeJobs = jobs
    .filter((j) => j.status === "queued" || j.status === "running")
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  const today = fmtDate(Date.now());

  const problems: string[] = [];
  if (config && !config.exists)
    problems.push(
      "설정 파일(~/.claude/sawhorse/config.json)이 없습니다. 작업공간 경로만 지정해도 시작할 수 있습니다.",
    );
  if (diag && !diag.vaultPathOk)
    problems.push("볼트 경로가 유효하지 않습니다. 설정에서 경로를 확인하세요.");
  if (diag && !diag.claudeOk)
    problems.push(
      "claude CLI를 실행할 수 없습니다. 설정에서 실행 파일 위치를 확인하세요.",
    );
  if (diag) {
    const bad = diag.projects.filter((p) => !p.pathOk).map((p) => p.name);
    if (bad.length > 0)
      problems.push(`프로젝트 경로 확인 실패: ${bad.join(", ")}`);
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
      <PageHeader title="홈" />
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
              <TriangleAlert className="size-4" /> 진단 문제 {problems.length}건
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
                      {label} 예약을 놓쳤습니다
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {m.date} {m.scheduledAt} 예정 — 자동 실행되지 않았습니다.
                      확인 후 실행하세요.
                    </div>
                  </div>
                  <RunButton
                    size="sm"
                    variant="default"
                    jobKey={
                      schedules.find((s) => s.key === m.routine)?.jobKey ?? ""
                    }
                    label="실행"
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
                    건너뛰기
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
                label: "예정",
                variant: "outline",
              };
              if (running) state = { label: "실행중", variant: "default" };
              else if (queued) state = { label: "대기", variant: "secondary" };
              else if (isMissed)
                state = { label: "놓침", variant: "warning" as const };
              else if (doneToday)
                state = { label: "완료", variant: "success" as const };
              else if (!s.enabled)
                state = { label: "꺼짐", variant: "outline" as const };

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
                        ? `${s.kind === "weekdays" ? "평일" : "매일"} ${s.time}`
                        : "비활성"}
                      {running
                        ? ` · 시작 ${fmtClock(running.startedAtMs)}`
                        : ""}
                      {queued ? ` · 등록 ${fmtClock(queued.createdAtMs)}` : ""}
                    </div>
                    <RunButton
                      className="mt-2 w-full"
                      size="sm"
                      variant={isMissed ? "default" : "outline"}
                      jobKey={s.jobKey}
                      label="지금 실행"
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
                오늘의 업무
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
                전체 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent>
              {!todos || !todos.fileExists || todos.today.length === 0 ? (
                <Empty>일지에 오늘 할 일이 없습니다.</Empty>
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
                        내일 {todos.tomorrow.length}건
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
              <CardTitle className="text-[13px]">활동 요약</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">오늘 완료 잡</span>
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
                <span className="text-muted-foreground">오늘 실패 잡</span>
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
                      마지막 실패{" "}
                      {failed.finishedAtMs ? fmtClock(failed.finishedAtMs) : ""}{" "}
                      · 작업 탭에서 로그 보기
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
                마지막 리포트 <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">볼트 현황</CardTitle>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setPage("vault")}
              >
                볼트 점검 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <button
                onClick={() => setPage("vault")}
                className="flex w-full items-center justify-between rounded-md border p-2 text-left transition-colors hover:bg-accent"
              >
                <span className="text-muted-foreground">미승격 항목</span>
                <span className="text-lg font-bold tabular-nums">
                  {inboxCount}
                </span>
              </button>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">오늘 일지</span>
                {audit == null ? (
                  <Badge variant="outline">검사 전</Badge>
                ) : audit.journal.todayExists ? (
                  <Badge variant="success">있음</Badge>
                ) : (
                  <Badge variant="warning">없음</Badge>
                )}
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">최근 변경 이슈</div>
                {improvements.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    이슈가 없습니다.
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
              <CardTitle className="text-[13px]">이슈 워크플로</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-3 gap-2">
              {(
                [
                  [
                    "제안",
                    improvements.filter((n) => n.status === "제안").length,
                  ],
                  [
                    "승인대기",
                    improvements.filter((n) => n.status === "승인대기").length,
                  ],
                  [
                    "실행대기",
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
              <CardTitle className="text-[13px]">실행 중 잡</CardTitle>
              <Button size="xs" variant="ghost" onClick={() => setPage("jobs")}>
                작업 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2">
              {activeJobs.length === 0 ? (
                <Empty>대기 중인 작업이 없습니다.</Empty>
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
          {fmtDur(elapsed)} 경과
        </span>
      </div>
      <div className="mt-1 truncate text-[11px] text-muted-foreground">
        {last ? entryText(last) : "진행 이벤트를 기다리는 중…"}
      </div>
    </div>
  );
}
