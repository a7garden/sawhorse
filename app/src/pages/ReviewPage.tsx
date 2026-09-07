// ReviewPage — 변경 후보 검토. 승인대기 카드(Diff·수정 요청·승인·거부)와 통합 카드
// (단계·검사 기록·수동 확인·수정 작업·되돌리기), 그리고 큐 정체 배너를 담당한다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type {
  CollabAgentRun,
  CollabAuditEvent,
  CollabChangeSetView,
  CollabManifestEntry,
  CollabSession,
  CollabSessionView,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Empty, PageHeader } from "./common";

const STATUS_KEY: Record<string, string> = {
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

function statusLabel(t: TFunction, s: string): string {
  const key = STATUS_KEY[s];
  return key ? t(key) : s;
}

function statusVariant(
  s: string,
): "default" | "secondary" | "warning" | "destructive" | "success" | "outline" {
  if (s === "review_pending" || s === "manual_verification_pending")
    return "warning";
  if (
    [
      "verification_failed",
      "conflicted",
      "recovery_required",
      "revert_conflicted",
      "rejected",
    ].includes(s)
  )
    return "destructive";
  if (
    ["verified", "integrated", "reverted", "resolved_with_repair"].includes(s)
  )
    return "success";
  if (["superseded", "redundant", "stale_context"].includes(s))
    return "outline";
  return "secondary";
}

/** manifest 항목 하나의 변경 상태. old/new blob 유무와 rename으로 판정한다. */
function entryAction(e: CollabManifestEntry): "A" | "M" | "D" | "R" {
  if (e.renameFrom) return "R";
  if (!e.oldBlob) return "A";
  if (!e.newBlob) return "D";
  return "M";
}

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "-";
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/// 큐가 멈춘 판정. 이 상태 후보가 하나라도 있으면 배너를 띄운다.
const STALLED_STATUSES = [
  "verification_failed",
  "conflicted",
  "recovery_required",
];

interface Candidate {
  cs: CollabChangeSetView;
  session: CollabSession;
  run: CollabAgentRun | null;
}

/// 확인·수정·거부 사유를 묻는 대화상자 모드.
type PromptMode =
  "request_changes" | "reject" | "manual_fail" | "repair" | null;

export default function ReviewPage() {
  const sessions = useApp((s) => s.collabSessions);
  const { t } = useTranslation("sessions");
  const [details, setDetails] = useState<Record<string, CollabSessionView>>({});
  const [audits, setAudits] = useState<Record<string, CollabAuditEvent[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [diffFor, setDiffFor] = useState<CollabChangeSetView | null>(null);
  const [promptMode, setPromptMode] = useState<PromptMode>(null);
  const [promptFor, setPromptFor] = useState<CollabChangeSetView | null>(null);
  const [promptText, setPromptText] = useState("");
  const [revertFor, setRevertFor] = useState<CollabChangeSetView | null>(null);

  const reload = useCallback(async () => {
    const targets = sessions.filter((s) => s.status !== "finalized");
    const next: Record<string, CollabSessionView> = {};
    const nextAudits: Record<string, CollabAuditEvent[]> = {};
    await Promise.all(
      targets.map(async (s) => {
        try {
          next[s.id] = await api.collabSessionDetail(s.id);
        } catch {
          // 세션 하나가 실패해도 나머지는 그린다
        }
        try {
          nextAudits[s.id] = await api.collabSessionAudit(s.id);
        } catch {
          nextAudits[s.id] = [];
        }
      }),
    );
    setDetails(next);
    setAudits(nextAudits);
  }, [sessions]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const candidates = useMemo<Candidate[]>(() => {
    const out: Candidate[] = [];
    for (const view of Object.values(details)) {
      for (const cs of view.changeSets) {
        const run =
          view.agentRuns.find((r) => r.taskId && r.taskId === cs.taskId) ??
          null;
        out.push({ cs, session: view, run });
      }
    }
    return out;
  }, [details]);

  const pending = candidates.filter((c) => c.cs.status === "review_pending");
  const integrating = candidates.filter(
    (c) => c.cs.status !== "working" && c.cs.status !== "review_pending",
  );
  const stalled = candidates.filter((c) =>
    STALLED_STATUSES.includes(c.cs.status),
  );

  async function act<T>(
    id: string,
    fn: () => Promise<T>,
    okText: (r: T) => string,
  ) {
    setBusy(id);
    setMsg(null);
    try {
      const result = await fn();
      await reload();
      setMsg({ ok: true, text: okText(result) });
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
      await reload().catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  function submitPrompt() {
    const cs = promptFor;
    if (!cs || !promptMode) return;
    const text = promptText.trim();
    if (promptMode === "repair") {
      if (text.length === 0) {
        setMsg({ ok: false, text: t("review.toast.repairPromptRequired") });
        return;
      }
      setPromptMode(null);
      void act(
        cs.id,
        () => api.collabRepair(cs.id, text),
        (r) =>
          t("review.toast.repairLaneCreated", {
            branch: r.branch || t("review.checking"),
          }),
      );
      return;
    }
    if (text.length === 0) {
      setMsg({ ok: false, text: t("review.toast.reasonRequired") });
      return;
    }
    setPromptMode(null);
    if (promptMode === "request_changes") {
      void act(
        cs.id,
        () => api.collabRequestChanges(cs.id, text),
        () => t("review.toast.changesRequested"),
      );
    } else if (promptMode === "reject") {
      void act(
        cs.id,
        () => api.collabReject(cs.id, "dashboard", text),
        () => t("review.toast.rejected"),
      );
    } else {
      void act(
        cs.id,
        () => api.collabManualFail(cs.id, text),
        () => t("review.toast.manualFailRecorded"),
      );
    }
  }

  return (
    <div>
      <PageHeader title={t("review.title")}>
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null}
          onClick={() =>
            void act(
              "queue",
              () => api.collabRunQueue(),
              (r) =>
                r
                  ? t("review.toast.queueAdvanced", {
                      status: statusLabel(t, r),
                    })
                  : t("review.toast.queueEmpty"),
            )
          }
        >
          {t("review.runQueue")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null}
          onClick={() => {
            void act(
              "inbox",
              () => api.collabInboxTick(),
              (list) => {
                const ok = list.filter((x) => x.accepted).length;
                return list.length === 0
                  ? t("review.toast.inboxEmpty")
                  : t("review.toast.inboxAccepted", {
                      total: list.length,
                      accepted: ok,
                    });
              },
            );
          }}
        >
          {t("review.checkInbox")}
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

        {stalled.length > 0 && (
          <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            {t("review.banner.stalled", { n: stalled.length })}
          </div>
        )}

        {sessions.length === 0 && (
          <Empty>{t("review.empty.noSessions")}</Empty>
        )}

        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold">{t("review.pendingTitle")}</h2>
          {pending.length === 0 && (
            <Empty className="py-3">{t("review.empty.pending")}</Empty>
          )}
          {pending.map(({ cs, session, run }) => (
            <Card key={cs.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {cs.taskId || t("lanes.freeRun")}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {session.goal}
                  </span>
                </CardTitle>
                <Badge variant={statusVariant(cs.status)}>
                  {statusLabel(t, cs.status)}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    {t("review.agentLabel", { driver: run ? run.driver : "-" })}
                    {run?.branch ? ` · ${run.branch}` : ""}
                  </span>
                  <span>
                    {short(cs.baseSha)} → {short(cs.sourceSha)}
                  </span>
                  <span>{t("changes.fileCount", { n: cs.manifest.length })}</span>
                  {cs.expectedHead && (
                    <span>{t("review.expectedHead", { head: short(cs.expectedHead) })}</span>
                  )}
                </div>
                {cs.summary && <p className="text-xs">{cs.summary}</p>}
                {cs.overlapPaths.length > 0 && (
                  <p className="text-xs text-warning-foreground">
                    {t("changes.overlap", { paths: cs.overlapPaths.join(", ") })}
                  </p>
                )}
                {run?.driver === "codex" && (
                  <p className="text-xs text-warning-foreground">
                    {t("codexNote")}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDiffFor(cs)}
                  >
                    {t("review.viewDiff")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy != null}
                    onClick={() => {
                      setPromptFor(cs);
                      setPromptMode("request_changes");
                      setPromptText("");
                    }}
                  >
                    {t("review.requestChanges")}
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy != null}
                    onClick={() =>
                      void act(
                        cs.id,
                        async () => {
                          await api.collabApprove(cs.id, "dashboard");
                          await api.collabRunQueue().catch(() => null);
                        },
                        () => t("review.toast.approvedQueued"),
                      )
                    }
                  >
                    {t("review.approveAndQueue")}
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={busy != null}
                    onClick={() => {
                      setPromptFor(cs);
                      setPromptMode("reject");
                      setPromptText("");
                    }}
                  >
                    {t("review.reject")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold">{t("review.integratingTitle")}</h2>
          {integrating.length === 0 && (
            <Empty className="py-3">{t("review.empty.integrating")}</Empty>
          )}
          {integrating.map(({ cs, session, run }) => {
            const logs = audits[session.id] ?? [];
            const manual = cs.status === "manual_verification_pending";
            const actionable = ![
              "integrated",
              "verified",
              "reverted",
              "superseded",
              "rejected",
              "redundant",
              "resolved_with_repair",
            ].includes(cs.status);
            return (
              <Card key={cs.id}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle className="text-[13px]">
                    {cs.taskId || t("lanes.freeRun")}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {session.goal}
                    </span>
                  </CardTitle>
                  <Badge variant={statusVariant(cs.status)}>
                    {statusLabel(t, cs.status)}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {short(cs.baseSha)} → {short(cs.sourceSha)}
                    </span>
                    <span>{t("changes.fileCount", { n: cs.manifest.length })}</span>
                    {cs.expectedHead && (
                      <span>{t("review.expectedHead", { head: short(cs.expectedHead) })}</span>
                    )}
                    {cs.remediatedBy && (
                      <span>{t("review.remediatedBy", { sha: short(cs.remediatedBy) })}</span>
                    )}
                  </div>

                  {logs.length > 0 && (
                    <div className="space-y-0.5 rounded-md border bg-muted/15 p-2">
                      {logs.slice(-6).map((e) => (
                        <div
                          key={e.id}
                          className="flex items-center gap-2 text-[11px] text-muted-foreground"
                        >
                          <span className="tabular-nums">
                            {fmtWhen(e.createdAt)}
                          </span>
                          <Badge variant="outline">{e.kind}</Badge>
                          <span className="min-w-0 truncate">
                            {e.payloadJson}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {manual && (
                    <div className="space-y-1.5">
                      <p className="text-xs">
                        {t("review.manualNeeded", {
                          profile:
                            session.verificationProfile ||
                            t("integration.defaultProfile"),
                        })}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="xs"
                          variant="success"
                          disabled={busy != null}
                          onClick={() =>
                            void act(
                              cs.id,
                              () => api.collabManualOk(cs.id),
                              () => t("review.toast.manualOk"),
                            )
                          }
                        >
                          {t("review.manualOk")}
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive"
                          disabled={busy != null}
                          onClick={() => {
                            setPromptFor(cs);
                            setPromptMode("manual_fail");
                            setPromptText("");
                          }}
                        >
                          {t("review.manualFail")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {run?.driver === "codex" && (
                    <p className="text-xs text-warning-foreground">
                      {t("codexNote")}
                    </p>
                  )}

                  {actionable && !manual && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy != null}
                        onClick={() => {
                          setPromptFor(cs);
                          setPromptMode("repair");
                          setPromptText("");
                        }}
                      >
                        {t("review.createRepair")}
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={busy != null}
                        onClick={() => setRevertFor(cs)}
                      >
                        {t("review.revert")}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </section>
      </div>

      <Dialog
        open={diffFor != null}
        onClose={() => setDiffFor(null)}
        title={t("review.diffTitle", {
          taskId: diffFor?.taskId || t("lanes.freeRun"),
        })}
        wide
      >
        <div className="space-y-1">
          {(diffFor?.manifest ?? []).length === 0 && (
            <Empty>{t("review.empty.noEntries")}</Empty>
          )}
          {(diffFor?.manifest ?? []).map((e) => (
            <div
              key={`${e.path}-${e.newBlob}-${e.oldBlob}`}
              className="flex items-center gap-2 text-xs"
            >
              <Badge variant={e.path ? "outline" : "outline"}>
                {t(`review.diffAction.${entryAction(e)}`)}
              </Badge>
              <span className="min-w-0 truncate">{e.path}</span>
              {e.renameFrom && (
                <span className="text-muted-foreground">← {e.renameFrom}</span>
              )}
              {e.binary && (
                <span className="text-muted-foreground">
                  {t("review.binaryLabel")}
                </span>
              )}
            </div>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={promptMode != null}
        onClose={() => setPromptMode(null)}
        title={promptMode ? t(`review.prompt.title.${promptMode}`) : ""}
      >
        <div className="space-y-3">
          <Label>
            {promptMode === "repair"
              ? t("review.prompt.repairLabel")
              : t("review.prompt.reasonLabel")}
          </Label>
          {promptMode === "repair" ? (
            <Textarea
              className="w-full"
              rows={3}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t("review.prompt.repairPlaceholder")}
              autoFocus
            />
          ) : (
            <Input
              className="w-full"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder={t("review.prompt.reasonPlaceholder")}
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPromptMode(null)}>
              {t("actions.cancel")}
            </Button>
            <Button disabled={busy != null} onClick={submitPrompt}>
              {t("review.confirm")}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revertFor != null}
        onClose={() => setRevertFor(null)}
        title={t("review.revert")}
      >
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("review.revertDescription")}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevertFor(null)}>
              {t("actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy != null}
              onClick={() => {
                const cs = revertFor;
                setRevertFor(null);
                if (cs)
                  void act(
                    cs.id,
                    () => api.collabRevert(cs.id),
                    (r) => t("review.toast.revertStarted", { result: r }),
                  );
              }}
            >
              {t("review.remove")}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
