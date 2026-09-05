// SessionsPage — 멀티에이전트 협업 세션. 목표 하나에 에이전트 레인 여럿과 변경 후보를
// 묶고, 대표 체크아웃(통합 체크아웃) 상태를 함께 보여 준다. 후보 승인·거부는 검토
// 화면(ReviewPage)의 몫이다.
import { useCallback, useEffect, useMemo, useState } from "react";
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

const SESSION_STATUS_KO: Record<CollabSessionStatus, string> = {
  active: "진행",
  paused: "일시정지",
  readyToFinalize: "종결 준비",
  finalized: "종결",
};

const SESSION_STATUS_VARIANT: Record<CollabSessionStatus, "default" | "secondary" | "warning" | "outline"> = {
  active: "default",
  paused: "warning",
  readyToFinalize: "secondary",
  finalized: "outline",
};

const RUN_STATUS_KO: Record<string, string> = {
  pending: "대기",
  running: "실행",
  done: "완료",
  failed: "실패",
  cancelled: "취소",
  manual: "수동",
  unknown: "상태 불명",
};

const CHANGE_STATUS_KO: Record<string, string> = {
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

function changeStatusKo(s: string): string {
  return CHANGE_STATUS_KO[s] ?? s;
}

function runStatusKo(s: string): string {
  return RUN_STATUS_KO[s] ?? s;
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function short(sha: string): string {
  return sha ? sha.slice(0, 8) : "-";
}

/** Codex 수동 레인 안내. 설계 문구를 그대로 보여 준다. */
const CODEX_NOTE = "수동 제출 전용 — 앱이 시작·취소·재연결을 보장하지 않는다";

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
    const ready = rest.filter((c) => c.dependsOn.every((d) => done[d] || !byDigest[d]));
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
    void api.collabProjectsView().then(setProjects).catch(() => setProjects(null));
  }, [createOpen]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      setDetail(await api.collabSessionDetail(id));
      setAudit(await api.collabSessionAudit(id));
    } catch (e) {
      setMsg({ ok: false, text: `상세 조회 실패: ${String(e)}` });
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
      setMsg({ ok: false, text: "프로젝트를 선택하세요." });
      return;
    }
    if (goal.trim().length === 0) {
      setMsg({ ok: false, text: "세션 목표를 입력하세요." });
      return;
    }
    const clean = lanes.filter((l) => l.taskPrompt.trim().length > 0);
    if (clean.length === 0) {
      setMsg({ ok: false, text: "레인의 작업 지시를 하나 이상 입력하세요." });
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
    }, "세션을 만들었습니다.");
  }

  return (
    <div>
      <PageHeader title="세션" desc="에이전트 레인을 병렬로 돌리고 변경 후보를 모읍니다.">
        <Button size="sm" disabled={(projects?.registered.length ?? 0) === 0} onClick={() => setCreateOpen(true)}>
          <Plus /> 세션 만들기
        </Button>
      </PageHeader>

      <div className="space-y-4 p-4">
        {msg && (
          <div className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</div>
        )}

        {projects && projects.registered.length === 0 && (
          <Empty>협업 프로젝트가 없습니다. 설정 &gt; 협업에서 저장소를 먼저 등록하세요.</Empty>
        )}

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">세션 목록</CardTitle>
            <Badge variant="secondary">{sessions.length}</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {sessions.length === 0 && <Empty className="py-4">아직 세션이 없습니다.</Empty>}
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
                  <Badge variant={SESSION_STATUS_VARIANT[s.status]}>{SESSION_STATUS_KO[s.status]}</Badge>
                  <span className="min-w-0 truncate text-[13px] font-semibold">{s.goal || "(목표 없음)"}</span>
                  <Badge variant="outline">{s.mode === "direct" ? "직접" : "격리"}</Badge>
                  <span className="text-xs text-muted-foreground">{s.integrationBranch}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{fmtWhen(s.createdAt)}</span>
                </div>
                {s.pausedReason && (
                  <p className="mt-1 text-xs text-warning-foreground">정지 사유: {s.pausedReason}</p>
                )}
              </button>
            ))}
          </CardContent>
        </Card>

        {detail && (
          <>
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">대표 체크아웃</CardTitle>
                <Badge variant={detail.integrationClean ? "success" : "warning"}>
                  {detail.integrationClean ? "개발 서버 깨끗함" : "개발 서버에 변경 있음"}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid gap-0.5 text-xs text-muted-foreground">
                  <div>경로: {detail.integrationPath || "-"}</div>
                  <div>
                    브랜치: {detail.integrationBranch || "-"} · HEAD: {short(detail.integrationHead)}
                  </div>
                  <div>
                    시작 HEAD: {short(detail.targetStartSha)} · 정책 v{detail.policyVersion} · 검증
                    프로필: {detail.verificationProfile || "기본"}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail.status === "active" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setPauseOpen(true)}>
                      일시정지
                    </Button>
                  )}
                  {detail.status === "paused" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void guard(() => api.collabResume(detail.id), "세션을 재개했습니다.")}
                    >
                      재개
                    </Button>
                  )}
                  {detail.status === "readyToFinalize" && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void guard(() => api.collabFinalize(detail.id), "세션을 종결했습니다.")}
                    >
                      세션 종결
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">에이전트 레인</CardTitle>
                <Badge variant="secondary">{detail.agentRuns.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.agentRuns.length === 0 && <Empty className="py-4">레인이 없습니다.</Empty>}
                {detail.agentRuns.map((r) => (
                  <div key={r.id} className="space-y-1 rounded-lg border p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={r.status === "failed" ? "destructive" : r.status === "running" ? "default" : "outline"}>
                        {runStatusKo(r.status)}
                      </Badge>
                      <span className="text-[13px] font-semibold">{r.taskId || "자유 작업"}</span>
                      <Badge variant="outline">{r.driver}</Badge>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{r.branch}</span>
                    </div>
                    <div className="min-w-0 truncate text-xs text-muted-foreground">{r.worktreePath}</div>
                    {r.driver === "codex" && (
                      <p className="text-xs text-warning-foreground">{CODEX_NOTE}</p>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">변경 후보 (의존 순)</CardTitle>
                <Badge variant="secondary">{detail.changeSets.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-2">
                {orderedCandidates.length === 0 && (
                  <Empty className="py-4">아직 후보가 없습니다. 레인이 제출하면 여기에 표시됩니다.</Empty>
                )}
                {orderedCandidates.map((c, i) => {
                  const deps = c.dependsOn.map((d) => {
                    const dep = detail.changeSets.find((x) => x.digest === d);
                    return dep ? dep.taskId || short(dep.digest) : short(d);
                  });
                  return (
                    <div key={c.id} className="space-y-1 rounded-lg border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] tabular-nums text-muted-foreground">{i + 1}.</span>
                        <Badge variant={c.status === "verification_failed" || c.status === "conflicted" ? "destructive" : "outline"}>
                          {changeStatusKo(c.status)}
                        </Badge>
                        <span className="text-[13px] font-semibold">{c.taskId || "자유 작업"}</span>
                        <span className="min-w-0 truncate text-xs">{c.summary || "(요약 없음)"}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <span>
                          {short(c.baseSha)} → {short(c.sourceSha)}
                        </span>
                        <span>파일 {c.manifest.length}개</span>
                        <span>digest {c.digest.slice(0, 12)}</span>
                        {deps.length > 0 && <span>의존: {deps.join(", ")}</span>}
                      </div>
                      {c.overlapPaths.length > 0 && (
                        <p className="text-xs text-warning-foreground">
                          겹침 경로: {c.overlapPaths.join(", ")}
                        </p>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">감사 기록</CardTitle>
                <Badge variant="secondary">{audit.length}</Badge>
              </CardHeader>
              <CardContent className="space-y-1">
                {audit.length === 0 && <Empty className="py-4">기록이 없습니다.</Empty>}
                {audit.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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

      <Dialog open={pauseOpen} onClose={() => setPauseOpen(false)} title="세션 일시정지">
        <div className="space-y-3">
          <Label>정지 사유</Label>
          <Input
            className="w-full"
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="예: 통합 체크아웃 점검"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPauseOpen(false)}>
              취소
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setPauseOpen(false);
                void guard(
                  () => api.collabPause(detail!.id, pauseReason.trim() || "사용자 일시정지"),
                  "세션을 일시정지했습니다.",
                );
              }}
            >
              일시정지
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title="새 협업 세션" wide>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>프로젝트</Label>
            <Select className="w-full" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">선택…</option>
              {(projects?.registered ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.path} ({p.integration.branch || "기본 브랜치"})
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>세션 목표</Label>
            <Input
              className="w-full"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="예: 홈 화면에 읽을거리 위젯 추가"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label>통합 브랜치 (비우면 등록값)</Label>
              <Input className="w-full" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>모드</Label>
              <Select value={mode} onChange={(e) => setMode(e.target.value as CollabSession["mode"])}>
                <option value="direct">직접 (기존 브랜치)</option>
                <option value="isolated">격리 (세션 전용)</option>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>레인</Label>
              <Button size="xs" variant="outline" onClick={() => setLanes((ls) => [...ls, emptyLane()])}>
                <Plus /> 레인 추가
              </Button>
            </div>
            {lanes.map((l, i) => (
              <div key={i} className="space-y-1 rounded-lg border p-2.5">
                <div className="flex gap-2">
                  <Input
                    className="flex-1"
                    value={l.taskId}
                    onChange={(e) =>
                      setLanes((ls) => ls.map((x, j) => (j === i ? { ...x, taskId: e.target.value } : x)))
                    }
                    placeholder="작업 ID (비우면 자유 작업)"
                    aria-label={`레인 ${i + 1} 작업 ID`}
                  />
                  <Select
                    value={l.driver}
                    onChange={(e) =>
                      setLanes((ls) =>
                        ls.map((x, j) => (j === i ? { ...x, driver: e.target.value as CollabDriver } : x)),
                      )
                    }
                    aria-label={`레인 ${i + 1} 드라이버`}
                  >
                    <option value="claude">Claude (관리형)</option>
                    <option value="codex">Codex (수동 제출)</option>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={lanes.length === 1}
                    aria-label={`레인 ${i + 1} 삭제`}
                    onClick={() => setLanes((ls) => ls.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                <Textarea
                  className="w-full"
                  rows={2}
                  value={l.taskPrompt}
                  onChange={(e) =>
                    setLanes((ls) => ls.map((x, j) => (j === i ? { ...x, taskPrompt: e.target.value } : x)))
                  }
                  placeholder="이 레인이 할 작업 지시"
                  aria-label={`레인 ${i + 1} 작업 지시`}
                />
                {l.driver === "codex" && (
                  <p className="text-xs text-warning-foreground">{CODEX_NOTE}</p>
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              취소
            </Button>
            <Button disabled={busy} onClick={create}>
              세션 생성
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
