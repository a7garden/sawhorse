// ReviewPage — 변경 후보 검토. 승인대기 카드(Diff·수정 요청·승인·거부)와 통합 카드
// (단계·검사 기록·수동 확인·수정 작업·되돌리기), 그리고 큐 정체 배너를 담당한다.
import { useCallback, useEffect, useMemo, useState } from "react";
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

const STATUS_KO: Record<string, string> = {
  working: "작업 중",
  review_pending: "승인대기",
  changes_requested: "수정 요청",
  approved: "승인",
  authorized_by_policy: "정책 허가",
  queued: "대기열",
  integrating: "통합 중",
  conflicted: "충돌",
  integrated: "통합됨",
  automated_verifying: "자동 검사",
  manual_verification_pending: "수동 확인 대기",
  verification_failed: "검증 실패",
  fix_forward: "수정 진행",
  reverting: "되돌리는 중",
  reverted: "되돌려짐",
  verified: "검증 완료",
  superseded: "대체됨",
  stale_context: "오래된 기준",
  baseline_failed: "기준 검사 실패",
  redundant: "중복",
  resolved_with_repair: "수정으로 해소",
  recovery_required: "복구 필요",
  revert_conflicted: "되돌리기 충돌",
  rejected: "거부됨",
};

function statusKo(s: string): string {
  return STATUS_KO[s] ?? s;
}

function statusVariant(s: string): "default" | "secondary" | "warning" | "destructive" | "success" | "outline" {
  if (s === "review_pending" || s === "manual_verification_pending") return "warning";
  if (["verification_failed", "conflicted", "recovery_required", "revert_conflicted", "rejected"].includes(s))
    return "destructive";
  if (["verified", "integrated", "reverted", "resolved_with_repair"].includes(s)) return "success";
  if (["superseded", "redundant", "stale_context"].includes(s)) return "outline";
  return "secondary";
}

/** manifest 항목 하나의 변경 상태. old/new blob 유무와 rename으로 판정한다. */
function entryAction(e: CollabManifestEntry): "A" | "M" | "D" | "R" {
  if (e.renameFrom) return "R";
  if (!e.oldBlob) return "A";
  if (!e.newBlob) return "D";
  return "M";
}

const ACTION_KO: Record<string, string> = { A: "추가", M: "수정", D: "삭제", R: "이름 변경" };

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "-";
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Codex 수동 레인 안내. 설계 문구를 그대로 보여 준다. */
const CODEX_NOTE = "수동 제출 전용 — 앱이 시작·취소·재연결을 보장하지 않는다";

/// 큐가 멈춘 판정. 이 상태 후보가 하나라도 있으면 배너를 띄운다.
const STALLED_STATUSES = ["verification_failed", "conflicted", "recovery_required"];

interface Candidate {
  cs: CollabChangeSetView;
  session: CollabSession;
  run: CollabAgentRun | null;
}

/// 확인·수정·거부 사유를 묻는 대화상자 모드.
type PromptMode = "request_changes" | "reject" | "manual_fail" | "repair" | null;

const PROMPT_TITLE: Record<Exclude<PromptMode, null>, string> = {
  request_changes: "수정 요청",
  reject: "후보 거부",
  manual_fail: "수동 확인 실패",
  repair: "수정 작업 만들기",
};

export default function ReviewPage() {
  const sessions = useApp((s) => s.collabSessions);
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
        const run = view.agentRuns.find((r) => r.taskId && r.taskId === cs.taskId) ?? null;
        out.push({ cs, session: view, run });
      }
    }
    return out;
  }, [details]);

  const pending = candidates.filter((c) => c.cs.status === "review_pending");
  const integrating = candidates.filter(
    (c) => c.cs.status !== "working" && c.cs.status !== "review_pending",
  );
  const stalled = candidates.filter((c) => STALLED_STATUSES.includes(c.cs.status));

  async function act<T>(id: string, fn: () => Promise<T>, okText: (r: T) => string) {
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
        setMsg({ ok: false, text: "수정 지시를 입력하세요." });
        return;
      }
      setPromptMode(null);
      void act(
        cs.id,
        () => api.collabRepair(cs.id, text),
        (r) => `수정 레인을 만들었습니다: ${r.branch || "확인 중"}`,
      );
      return;
    }
    if (text.length === 0) {
      setMsg({ ok: false, text: "사유를 입력하세요." });
      return;
    }
    setPromptMode(null);
    if (promptMode === "request_changes") {
      void act(cs.id, () => api.collabRequestChanges(cs.id, text), () => "수정을 요청했습니다.");
    } else if (promptMode === "reject") {
      void act(
        cs.id,
        () => api.collabReject(cs.id, "dashboard", text),
        () => "후보를 거부했습니다.",
      );
    } else {
      void act(
        cs.id,
        () => api.collabManualFail(cs.id, text),
        () => "수동 확인을 실패로 기록했습니다.",
      );
    }
  }

  return (
    <div>
      <PageHeader title="변경 검토">
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null}
          onClick={() =>
            void act(
              "queue",
              () => api.collabRunQueue(),
              (r) => (r ? `큐 진행: ${statusKo(r)}` : "진행할 대기 후보가 없습니다."),
            )
          }
        >
          큐 진행
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null}
          onClick={() => {
            void act("inbox", () => api.collabInboxTick(), (list) => {
              const ok = list.filter((x) => x.accepted).length;
              return list.length === 0
                ? "인박스에 새 제출이 없습니다."
                : `인박스 ${list.length}건 중 ${ok}건 수용`;
            });
          }}
        >
          인박스 확인
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        {msg && (
          <div className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</div>
        )}

        {stalled.length > 0 && (
          <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            큐가 멈췄습니다 — 검증 실패·충돌·복구 필요 후보 {stalled.length}건을 아래에서 처리하세요.
          </div>
        )}

        {sessions.length === 0 && <Empty>세션이 없습니다. 세션 화면에서 먼저 만드세요.</Empty>}

        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold">승인대기</h2>
          {pending.length === 0 && <Empty className="py-3">승인대기 후보가 없습니다.</Empty>}
          {pending.map(({ cs, session, run }) => (
            <Card key={cs.id}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {cs.taskId || "자유 작업"}
                  <span className="ml-2 font-normal text-muted-foreground">{session.goal}</span>
                </CardTitle>
                <Badge variant={statusVariant(cs.status)}>{statusKo(cs.status)}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    {run ? `에이전트: ${run.driver}` : "에이전트: -"}
                    {run?.branch ? ` · ${run.branch}` : ""}
                  </span>
                  <span>
                    {short(cs.baseSha)} → {short(cs.sourceSha)}
                  </span>
                  <span>파일 {cs.manifest.length}개</span>
                  {cs.expectedHead && <span>예상 HEAD: {short(cs.expectedHead)}</span>}
                </div>
                {cs.summary && <p className="text-xs">{cs.summary}</p>}
                {cs.overlapPaths.length > 0 && (
                  <p className="text-xs text-warning-foreground">
                    겹침 경로: {cs.overlapPaths.join(", ")}
                  </p>
                )}
                {run?.driver === "codex" && (
                  <p className="text-xs text-warning-foreground">{CODEX_NOTE}</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button size="xs" variant="outline" onClick={() => setDiffFor(cs)}>
                    Diff 보기
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
                    수정 요청
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
                        () => "승인하고 큐에 넣었습니다.",
                      )
                    }
                  >
                    승인 후 큐에 넣기
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
                    거부
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </section>

        <section className="space-y-2">
          <h2 className="text-[13px] font-semibold">통합</h2>
          {integrating.length === 0 && <Empty className="py-3">통합 진행·완료 후보가 없습니다.</Empty>}
          {integrating.map(({ cs, session, run }) => {
            const logs = audits[session.id] ?? [];
            const manual = cs.status === "manual_verification_pending";
            const actionable = !["integrated", "verified", "reverted", "superseded", "rejected", "redundant", "resolved_with_repair"].includes(
              cs.status,
            );
            return (
              <Card key={cs.id}>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle className="text-[13px]">
                    {cs.taskId || "자유 작업"}
                    <span className="ml-2 font-normal text-muted-foreground">{session.goal}</span>
                  </CardTitle>
                  <Badge variant={statusVariant(cs.status)}>{statusKo(cs.status)}</Badge>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>
                      {short(cs.baseSha)} → {short(cs.sourceSha)}
                    </span>
                    <span>파일 {cs.manifest.length}개</span>
                    {cs.expectedHead && <span>예상 HEAD: {short(cs.expectedHead)}</span>}
                    {cs.remediatedBy && <span>수정: {short(cs.remediatedBy)}</span>}
                  </div>

                  {logs.length > 0 && (
                    <div className="space-y-0.5 rounded-md border bg-muted/15 p-2">
                      {logs.slice(-6).map((e) => (
                        <div key={e.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                          <span className="tabular-nums">{fmtWhen(e.createdAt)}</span>
                          <Badge variant="outline">{e.kind}</Badge>
                          <span className="min-w-0 truncate">{e.payloadJson}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {manual && (
                    <div className="space-y-1.5">
                      <p className="text-xs">
                        수동 확인이 필요합니다. 검증 프로필: {session.verificationProfile || "기본"}
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
                              () => "수동 확인을 완료했습니다.",
                            )
                          }
                        >
                          확인 완료
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
                          실패
                        </Button>
                      </div>
                    </div>
                  )}

                  {run?.driver === "codex" && (
                    <p className="text-xs text-warning-foreground">{CODEX_NOTE}</p>
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
                        수정 작업 만들기
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={busy != null}
                        onClick={() => setRevertFor(cs)}
                      >
                        변경 제거
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </section>
      </div>

      <Dialog open={diffFor != null} onClose={() => setDiffFor(null)} title={`Diff — ${diffFor?.taskId || "자유 작업"}`} wide>
        <div className="space-y-1">
          {(diffFor?.manifest ?? []).length === 0 && <Empty>항목이 없습니다.</Empty>}
          {(diffFor?.manifest ?? []).map((e) => (
            <div key={`${e.path}-${e.newBlob}-${e.oldBlob}`} className="flex items-center gap-2 text-xs">
              <Badge variant={e.path ? "outline" : "outline"}>{ACTION_KO[entryAction(e)]}</Badge>
              <span className="min-w-0 truncate">{e.path}</span>
              {e.renameFrom && <span className="text-muted-foreground">← {e.renameFrom}</span>}
              {e.binary && <span className="text-muted-foreground">(바이너리)</span>}
            </div>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={promptMode != null}
        onClose={() => setPromptMode(null)}
        title={promptMode ? PROMPT_TITLE[promptMode] : ""}
      >
        <div className="space-y-3">
          <Label>{promptMode === "repair" ? "수정 지시" : "사유"}</Label>
          {promptMode === "repair" ? (
            <Textarea
              className="w-full"
              rows={3}
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="예: 빌드 실패 원인을 찾아 고쳐 제출하세요"
              autoFocus
            />
          ) : (
            <Input
              className="w-full"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="사유를 입력하세요"
              autoFocus
            />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPromptMode(null)}>
              취소
            </Button>
            <Button disabled={busy != null} onClick={submitPrompt}>
              확인
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={revertFor != null} onClose={() => setRevertFor(null)} title="변경 제거">
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            이 후보의 통합 변경을 되돌립니다. 되돌리기는 병합 커밋을 되돌리는 revert 커밋으로 기록됩니다.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRevertFor(null)}>
              취소
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
                    (r) => `되돌리기 시작: ${r}`,
                  );
              }}
            >
              제거
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
