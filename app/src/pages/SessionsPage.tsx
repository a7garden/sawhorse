// SessionsPage — 멀티에이전트 협업 세션. 목표 하나에 에이전트 레인 여럿과 변경 후보를
// 묶고, 대표 체크아웃(통합 체크아웃) 상태를 함께 보여 준다. 후보 승인·거부는 검토
// 화면(ReviewPage)의 몫이다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import type {
  CollabAuditEvent,
  CollabChangeSetView,
  CollabDriver,
  CollabProjectsView,
  CollabSession,
  CollabSessionStatus,
  CollabSessionView,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Empty, PageHeader } from "./common";

const SESSION_STATUS_VARIANT: Record<
  CollabSessionStatus,
  "default" | "secondary" | "warning" | "outline"
> = {
  active: "default",
  paused: "warning",
  readyToFinalize: "secondary",
  finalized: "outline",
};

const RUN_STATUS_KEY: Record<string, string> = {
  pending: "runStatus.pending",
  running: "runStatus.running",
  done: "runStatus.done",
  failed: "runStatus.failed",
  cancelled: "runStatus.cancelled",
  manual: "runStatus.manual",
  unknown: "runStatus.unknown",
};

const CHANGE_STATUS_KEY: Record<string, string> = {
  working: "changeStatus.working",
  review_pending: "changeStatus.review_pending",
  changes_requested: "changeStatus.changes_requested",
  approved: "changeStatus.approved",
  authorized_by_policy: "changeStatus.authorized_by_policy",
  queued: "changeStatus.queued",
  integrating: "changeStatus.integrating",
  conflicted: "changeStatus.conflicted",
  integrated: "changeStatus.integrated",
  automated_verifying: "changeStatus.automated_verifying",
  manual_verification_pending: "changeStatus.manual_verification_pending",
  verification_failed: "changeStatus.verification_failed",
  fix_forward: "changeStatus.fix_forward",
  reverting: "changeStatus.reverting",
  reverted: "changeStatus.reverted",
  verified: "changeStatus.verified",
  superseded: "changeStatus.superseded",
  stale_context: "changeStatus.stale_context",
  baseline_failed: "changeStatus.baseline_failed",
  redundant: "changeStatus.redundant",
  resolved_with_repair: "changeStatus.resolved_with_repair",
  recovery_required: "changeStatus.recovery_required",
  revert_conflicted: "changeStatus.revert_conflicted",
  rejected: "changeStatus.rejected",
};

function changeStatusLabel(t: TFunction, s: string): string {
  const key = CHANGE_STATUS_KEY[s];
  return key ? t(key) : s;
}

function runStatusLabel(t: TFunction, s: string): string {
  const key = RUN_STATUS_KEY[s];
  return key ? t(key) : s;
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "-";
}

interface LaneDraft {
  taskId: string;
  taskPrompt: string;
  driver: CollabDriver;
}

function emptyLane(): LaneDraft {
  return { taskId: "", taskPrompt: "", driver: "claude" };
}

/** 의존을 먼저 나열하는 단순 위상 정렬. 순환은 남는 항목을 그대로 이어 붙인다. */
function topoSort(candidates: CollabChangeSetView[]): CollabChangeSetView[] {
  const byDigest: Record<string, CollabChangeSetView> = {};
  for (const c of candidates) byDigest[c.digest] = c;
  const done: Record<string, true> = {};
  const out: CollabChangeSetView[] = [];
  let rest = [...candidates];
  while (rest.length > 0) {
    const ready = rest.filter((c) =>
      c.dependsOn.every((d) => done[d] || !byDigest[d]),
    );
    const pick = ready.length > 0 ? ready : rest.slice(0, 1); // 순환 등 걸리는 묶음은 순서 유지
    for (const c of pick) {
      done[c.digest] = true;
      out.push(c);
    }
    rest = rest.filter((c) => !pick.includes(c));
  }
  return out;
}
export default function SessionsPage() {
  const sessions = useApp((s) => s.collabSessions);
  const refreshSessions = useApp((s) => s.refreshCollabSessions);
  const { t } = useTranslation("sessions");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CollabSessionView | null>(null);
  const [audit, setAudit] = useState<CollabAuditEvent[]>([]);
  const [projects, setProjects] = useState<CollabProjectsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState("");

  // 새 세션 폼
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [mode, setMode] = useState<CollabSession["mode"]>("direct");
  const [branch, setBranch] = useState("");
  const [lanes, setLanes] = useState<LaneDraft[]>([emptyLane()]);

  useEffect(() => {
    void api
      .collabProjectsView()
      .then(setProjects)
      .catch(() => setProjects(null));
  }, [createOpen]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.collabSessionDetail(id));
      setAudit(await api.collabSessionAudit(id));
    } catch (e) {
      setMsg({
        ok: false,
        text: t("toast.detailLoadFailed", { error: String(e) }),
      });
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, sessions, loadDetail]);

  const orderedCandidates = useMemo(
    () => (detail ? topoSort(detail.changeSets) : []),
    [detail],
  );

  async function guard(fn: () => Promise<unknown>, okText?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      await refreshSessions();
      if (selectedId) await loadDetail(selectedId);
      if (okText) setMsg({ ok: true, text: okText });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  function create() {
    if (!projectId) {
      setMsg({ ok: false, text: t("validation.selectProject") });
      return;
    }
    if (goal.trim().length === 0) {
      setMsg({ ok: false, text: t("validation.enterGoal") });
      return;
    }
    const clean = lanes.filter((l) => l.taskPrompt.trim().length > 0);
    if (clean.length === 0) {
      setMsg({ ok: false, text: t("validation.enterLanePrompt") });
      return;
    }
    void guard(async () => {
      const s = await api.collabCreateSession({
        projectId,
        goal: goal.trim(),
        mode,
        branch: branch.trim(),
        lanes: clean.map((l) => ({
          taskId: l.taskId.trim(),
          taskPrompt: l.taskPrompt.trim(),
          driver: l.driver,
        })),
      });
      setCreateOpen(false);
      setGoal("");
      setBranch("");
      setLanes([emptyLane()]);
      setSelectedId(s.id);
    }, t("toast.created"));
  }

  return (
    <div>
      <PageHeader title={t("title")}>
        <Button
          size="sm"
          disabled={(projects?.registered.length ?? 0) === 0}
          onClick={() => setCreateOpen(true)}
        >
          <Plus /> {t("actions.create")}
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        {msg && (
          <div
            className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}
          >
            {msg.text}
          </div>
        )}

        {projects && projects.registered.length === 0 && (
          <Empty>
            {t("empty.noProjects")}
          </Empty>
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">{t("list.title")}</CardTitle>
            <Badge variant="secondary">{sessions.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions.length === 0 && (
              <Empty className="py-4">{t("empty.noSessions")}</Empty>
            )}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={cn(
                  "w-full rounded-lg border p-2.5 text-left transition-colors",
                  detail?.id === s.id
                    ? "border-primary/60 bg-primary/5"
                    : "border-border bg-muted/15 hover:bg-accent",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SESSION_STATUS_VARIANT[s.status]}>
                    {t(`sessionStatus.${s.status}`)}
                  </Badge>
                  <span className="min-w-0 truncate text-[13px] font-semibold">
                    {s.goal || t("list.noGoal")}
                  </span>
                  <Badge variant="outline">
                    {s.mode === "direct" ? t("mode.direct") : t("mode.isolated")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {s.integrationBranch}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {fmtWhen(s.createdAt)}
                  </span>
                </div>
                {s.pausedReason && (
                  <p className="mt-1 text-xs text-warning-foreground">
                    {t("list.pausedReason", { reason: s.pausedReason })}
                  </p>
                )}
              </button>
            ))}
          </CardContent>
        </Card>

        {detail && (
          <>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">{t("integration.title")}</CardTitle>
                <Badge
                  variant={detail.integrationClean ? "success" : "warning"}
                >
                  {detail.integrationClean
                    ? t("integration.clean")
                    : t("integration.dirty")}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <div>{t("integration.path", { path: detail.integrationPath || "-" })}</div>
                  <div>
                    {t("integration.branchHead", {
                      branch: detail.integrationBranch || "-",
                      head: short(detail.integrationHead),
                    })}
                  </div>
                  <div>
                    {t("integration.meta", {
                      head: short(detail.targetStartSha),
                      policy: detail.policyVersion,
                      profile:
                        detail.verificationProfile ||
                        t("integration.defaultProfile"),
                    })}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.status === "active" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setPauseOpen(true)}
                    >
                      {t("actions.pause")}
                    </Button>
                  )}
                  {detail.status === "paused" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void guard(
                          () => api.collabResume(detail.id),
                          t("toast.resumed"),
                        )
                      }
                    >
                      {t("actions.resume")}
                    </Button>
                  )}
                  {detail.status === "readyToFinalize" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void guard(
                          () => api.collabFinalize(detail.id),
                          t("toast.finalized"),
                        )
                      }
                    >
                      {t("actions.finalize")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">{t("lanes.title")}</CardTitle>
                <Badge variant="secondary">{detail.agentRuns.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.agentRuns.length === 0 && (
                  <Empty className="py-4">{t("empty.noLanes")}</Empty>
                )}
                {detail.agentRuns.map((r) => (
                  <div key={r.id} className="space-y-1 rounded-lg border p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant={
                          r.status === "failed"
                            ? "destructive"
                            : r.status === "running"
                              ? "default"
                              : "outline"
                        }
                      >
                        {runStatusLabel(t, r.status)}
                      </Badge>
                      <span className="text-[13px] font-semibold">
                        {r.taskId || t("lanes.freeRun")}
                      </span>
                      <Badge variant="outline">{r.driver}</Badge>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {r.branch}
                      </span>
                    </div>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">
                      {r.worktreePath}
                    </div>
                    {r.driver === "codex" && (
                      <p className="text-xs text-warning-foreground">
                        {t("codexNote")}
                      </p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {t("changes.title")}
                </CardTitle>
                <Badge variant="secondary">{detail.changeSets.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {orderedCandidates.length === 0 && (
                  <Empty className="py-4">
                    {t("empty.noChanges")}
                  </Empty>
                )}
                {orderedCandidates.map((c, i) => {
                  const deps = c.dependsOn.map((d) => {
                    const dep = detail.changeSets.find((x) => x.digest === d);
                    return dep ? dep.taskId || short(dep.digest) : short(d);
                  });
                  return (
                    <div
                      key={c.id}
                      className="space-y-1 rounded-lg border p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] tabular-nums text-muted-foreground">
                          {i + 1}.
                        </span>
                        <Badge
                          variant={
                            c.status === "verification_failed" ||
                            c.status === "conflicted"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {changeStatusLabel(t, c.status)}
                        </Badge>
                        <span className="text-[13px] font-semibold">
                          {c.taskId || t("lanes.freeRun")}
                        </span>
                        <span className="min-w-0 truncate text-xs">
                          {c.summary || t("changes.noSummary")}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>
                          {short(c.baseSha)} → {short(c.sourceSha)}
                        </span>
                        <span>{t("changes.fileCount", { n: c.manifest.length })}</span>
                        <span>digest {c.digest.slice(0, 12)}</span>
                        {deps.length > 0 && (
                          <span>{t("changes.deps", { deps: deps.join(", ") })}</span>
                        )}
                      </div>
                      {c.overlapPaths.length > 0 && (
                        <p className="text-xs text-warning-foreground">
                          {t("changes.overlap", { paths: c.overlapPaths.join(", ") })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">{t("audit.title")}</CardTitle>
                <Badge variant="secondary">{audit.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-1">
                {audit.length === 0 && (
                  <Empty className="py-4">{t("empty.noAudit")}</Empty>
                )}
                {audit.map((e) => (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="tabular-nums">{fmtWhen(e.createdAt)}</span>
                    <Badge variant="outline">{e.kind}</Badge>
                    <span className="min-w-0 truncate">{e.payloadJson}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <Dialog
        open={pauseOpen}
        onClose={() => setPauseOpen(false)}
        title={t("pause.title")}
      >
        <div className="space-y-3">
          <Label>{t("pause.reasonLabel")}</Label>
          <Input
            className="w-full"
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder={t("pause.reasonPlaceholder")}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPauseOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setPauseOpen(false);
                void guard(
                  () =>
                    api.collabPause(
                      detail!.id,
                      pauseReason.trim() || t("pause.defaultReason"),
                    ),
                  t("toast.paused"),
                );
              }}
            >
              {t("actions.pause")}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={t("create.title")}
        wide
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("create.project")}</Label>
            <Select
              className="w-full"
              value={projectId}
              onChange={(v) => setProjectId(v)}
              options={[
                { value: "", label: t("create.selectProject") },
                ...(projects?.registered ?? []).map((p) => ({
                  value: p.id,
                  label: `${p.path} (${
                    p.integration.branch || t("create.defaultBranch")
                  })`,
                })),
              ]}
            />
          </div>
          <div className="space-y-1">
            <Label>{t("create.goal")}</Label>
            <Input
              className="w-full"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t("create.goalPlaceholder")}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label>{t("create.integrationBranch")}</Label>
              <Input
                className="w-full"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("create.mode")}</Label>
              <Select
                value={mode}
                onChange={(v) => setMode(v as CollabSession["mode"])}
                options={[
                  { value: "direct", label: t("create.modeDirect") },
                  { value: "isolated", label: t("create.modeIsolated") },
                ]}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("create.lanes")}</Label>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setLanes((ls) => [...ls, emptyLane()])}
              >
                <Plus /> {t("create.addLane")}
              </Button>
            </div>
            {lanes.map((l, i) => (
              <div key={i} className="space-y-1 rounded-lg border p-2.5">
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={l.taskId}
                    onChange={(e) =>
                      setLanes((ls) =>
                        ls.map((x, j) =>
                          j === i ? { ...x, taskId: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder={t("create.laneTaskIdPlaceholder")}
                    aria-label={t("create.laneTaskIdAria", { n: i + 1 })}
                  />
                  <Select
                    value={l.driver}
                    onChange={(v) =>
                      setLanes((ls) =>
                        ls.map((x, j) =>
                          j === i
                            ? { ...x, driver: v as CollabDriver }
                            : x,
                        ),
                      )
                    }
                    aria-label={t("create.laneDriverAria", { n: i + 1 })}
                    options={[
                      { value: "claude", label: t("create.driverClaude") },
                      { value: "codex", label: t("create.driverCodex") },
                    ]}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={lanes.length === 1}
                    aria-label={t("create.laneRemoveAria", { n: i + 1 })}
                    onClick={() =>
                      setLanes((ls) => ls.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Textarea
                  className="w-full"
                  rows={2}
                  value={l.taskPrompt}
                  onChange={(e) =>
                    setLanes((ls) =>
                      ls.map((x, j) =>
                        j === i ? { ...x, taskPrompt: e.target.value } : x,
                      ),
                    )
                  }
                  placeholder={t("create.lanePromptPlaceholder")}
                  aria-label={t("create.lanePromptAria", { n: i + 1 })}
                />
                {l.driver === "codex" && (
                  <p className="text-xs text-warning-foreground">
                    {t("codexNote")}
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t("actions.cancel")}
            </Button>
            <Button disabled={busy} onClick={create}>
              {t("create.submit")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
