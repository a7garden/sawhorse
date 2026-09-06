// 터미널 화면 — herdr 를 1급 시민으로 올린 자리.
// 잡 실행기 안에만 있던 herdr 를 사람이 직접 보고 다룰 수 있게 한다: 어느 워크스페이스에
// 무엇이 돌고 있는지, 무엇이 사람 응답을 기다리는지(blocked), 어디서 새 탭을 여는지.
//
// 시각화는 일반 대시보드 대신 작은 운영 콘솔에 가깝다:
// - 상단에 상태별 카운터 (working / blocked / idle / done / 전체)
// - 워크스페이스 카드 안에 탭 레일과 에이전트 칩
// - 에이전트 종류(claude / codex / shell)는 색으로 구분, 활동 중엔 점이 호흡한다
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Eye,
  Play,
  Plus,
  RefreshCw,
  SquareX,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { HerdrAgentRow, HerdrSnapshot, HerdrTab, HerdrWorkspace, PackInfo } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BadgeVariant } from "./common";
import { AGENT_STATUS_KO, Empty, PageHeader } from "./common";

type Tone = "working" | "blocked" | "idle" | "done" | "focused";

function toneOf(s: string | undefined | null): Tone {
  switch (s) {
    case "working":
      return "working";
    case "blocked":
      return "blocked";
    case "idle":
      return "idle";
    case "done":
      return "done";
    default:
      return "idle";
  }
}

function statusBadge(s: string): { label: string; variant: BadgeVariant; tone: Tone } {
  const tone = toneOf(s);
  const known = (AGENT_STATUS_KO as Record<string, string>)[s];
  if (s === "blocked") return { label: known ?? s, variant: "warning", tone };
  if (s === "working") return { label: known ?? s, variant: "default", tone };
  if (s === "idle" || s === "done") return { label: known ?? s, variant: "outline", tone };
  return { label: known ?? (s || "없음"), variant: "secondary", tone };
}

function agentKind(a: string): { label: string; tone: string } {
  const k = (a || "").toLowerCase();
  if (k === "claude") return { label: "claude", tone: "claude" };
  if (k === "codex") return { label: "codex", tone: "codex" };
  return { label: k || "shell", tone: "shell" };
}

/** 작은 호흡 점. working/blocked 만 호흡한다. */
function StatusDot({ tone, pulse }: { tone: string; pulse?: boolean }) {
  const t: Tone = toneOf(tone);
  if (pulse && (t === "working" || t === "blocked")) {
    return (
      <span className="term-dot-pulse" data-tone={t} aria-hidden>
        <span className="term-dot" data-tone={t} />
      </span>
    );
  }
  return <span className="term-dot" data-tone={t} aria-hidden />;
}

/** 상태별 카운터 한 알. 카운트가 0 이면 흐리게 표시해 시각 노이즈를 줄인다. */
function StatusCounter({ tone, num, label }: { tone: Tone; num: number; label: string }) {
  return (
    <span className={cn("term-counter", num === 0 && "opacity-55")} data-tone={tone}>
      <span className="term-counter-dot" style={{ background: `var(--${tone === "focused" ? "brand" : tone === "idle" ? "muted-foreground" : tone})` }} />
      <span className="term-counter-num">{num}</span>
      <span className="term-counter-label">{label}</span>
    </span>
  );
}

export default function TerminalPage() {
  const config = useApp((s) => s.config);
  const packs = useApp((s) => s.packs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);

  const [snap, setSnap] = useState<HerdrSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  const [preview, setPreview] = useState<{ paneId: string; title: string; body: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await api.herdrSnapshot());
    } catch (e) {
      setMsg(String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const enabledPacks: PackInfo[] = (packs?.packs ?? []).filter((p) => p.enabled);
  const runnable = enabledPacks.flatMap((p) =>
    p.actions.filter((a) => !a.params.some((x) => x.required)).map((a) => ({ pack: p, action: a })),
  );

  const cwdChoices = [
    { value: "", label: `작업공간 (${config?.vaultPath || "미설정"})` },
    ...(config?.projects ?? [])
      .filter((p) => p.path.length > 0)
      .map((p) => ({ value: p.path, label: `${p.name} (${p.path})` })),
  ];

  async function act(fn: () => Promise<unknown>, note?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (note) setMsg(note);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runInTerminal() {
    const hit = runnable.find((r) => `${r.pack.id}:${r.action.id}` === action);
    if (!hit) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.runPackAction(hit.pack.id, hit.action.id, {});
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  const blocked = snap?.agents.filter((a) => a.agentStatus === "blocked") ?? [];

  /** 앱을 떠나지 않고 그 페인이 지금 무엇을 묻고 있는지 본다. */
  async function peek(paneId: string, title: string) {
    setPreview({ paneId, title, body: "출력을 읽는 중…" });
    try {
      setPreview({ paneId, title, body: await api.herdrReadPane(paneId, 60) });
    } catch (e) {
      setPreview({ paneId, title, body: `출력을 읽지 못했습니다: ${String(e)}` });
    }
  }

  // 상태별 카운트 — 상단 요약 띠에 들어간다.
  const counts = useMemo(() => {
    const c = { working: 0, blocked: 0, idle: 0, done: 0, total: 0 };
    if (!snap) return c;
    for (const a of snap.agents) {
      c.total += 1;
      const t = toneOf(a.agentStatus);
      if (t === "working") c.working += 1;
      else if (t === "blocked") c.blocked += 1;
      else if (t === "idle") c.idle += 1;
      else if (t === "done") c.done += 1;
    }
    return c;
  }, [snap]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="터미널"
        desc="herdr 세션에서 무엇이 돌고 무엇이 사람을 기다리는지 봅니다. 잡도 여기서 열립니다."
      >
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !snap?.available}
          onClick={() => void act(() => api.herdrOpenTab(target || undefined), "새 탭을 열었습니다.")}
        >
          <Plus /> 새 탭
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="size-3" /> 새로고침
        </Button>
      </PageHeader>

      {msg && <div className="border-b bg-muted px-4 py-1.5 text-xs">{msg}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {snap == null && <Empty>herdr 상태를 확인하는 중…</Empty>}

        {snap && !snap.available && (
          <Card className="mx-auto max-w-xl">
            <CardHeader className="pb-1">
              <CardTitle className="text-[13px]">herdr 서버에 닿지 못했습니다</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                herdr 는 잡을 <b>사람이 볼 수 있고 이어받을 수 있는</b> 터미널 세션에서 돌리는
                실행 기반입니다. 없으면 잡은 백그라운드로 조용히 돌아갑니다 — 동작은 하지만
                승인 프롬프트에 답할 수 없습니다.
              </p>
              {snap.error && <p className="break-all font-mono text-[11px]">{snap.error}</p>}
              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="outline" onClick={() => void api.openExternal("https://herdr.dev")}>
                  <ExternalLink className="size-3" /> herdr.dev
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPage("settings")}>
                  실행 설정 열기
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {snap?.available && (
          <div className="space-y-3">
            {/* 상태 요약 띠 — 어떤 에이전트가 지금 어떤 상태인지 한눈에. */}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                세션 {snap.session || "—"}
              </span>
              <span className="text-muted-foreground/40">·</span>
              <StatusCounter tone="working" num={counts.working} label="작업 중" />
              <StatusCounter tone="blocked" num={counts.blocked} label="승인 대기" />
              <StatusCounter tone="idle" num={counts.idle} label="입력 대기" />
              <StatusCounter tone="done" num={counts.done} label="정리 중" />
              <StatusCounter tone="focused" num={counts.total} label="전체 에이전트" />
            </div>

            {blocked.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-foreground">
                  <TriangleAlert className="size-4" /> 사람 응답을 기다리는 세션 {blocked.length}건
                </div>
                <div className="mt-1.5 space-y-1">
                  {blocked.map((a) => (
                    <div key={a.paneId} className="flex items-center gap-2 text-xs">
                      <StatusDot tone="blocked" pulse />
                      <span className="min-w-0 flex-1 truncate" title={a.cwd}>
                        {a.terminalTitle || a.name || a.paneId}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void peek(a.paneId, a.terminalTitle || a.paneId)}
                      >
                        <Eye className="size-3" /> 내용
                      </Button>
                      <Button size="xs" disabled={busy} onClick={() => void act(() => api.herdrFocusPane(a.paneId))}>
                        열기
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-[13px]">터미널에서 실행</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Select className="min-w-0 flex-1" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {cwdChoices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                <Select className="min-w-0 flex-1" value={action} onChange={(e) => setAction(e.target.value)}>
                  <option value="">(액션 선택)</option>
                  {runnable.map(({ pack, action: a }) => (
                    <option key={`${pack.id}:${a.id}`} value={`${pack.id}:${a.id}`}>
                      {a.label} · {pack.name}
                    </option>
                  ))}
                </Select>
                <Button size="sm" disabled={busy || action === ""} onClick={() => void runInTerminal()}>
                  <Play /> 실행
                </Button>
                <p className="w-full text-[11px] text-muted-foreground">
                  액션은 실행 설정의 herdr 모드를 따릅니다 — herdr 가 떠 있으면 탭에서 돌고,
                  아니면 백그라운드로 떨어집니다. 경로 선택은 「새 탭」에도 함께 적용됩니다.
                </p>
              </CardContent>
            </Card>

            {preview && (
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle className="flex min-w-0 items-center gap-2 text-[13px]" title={preview.title}>
                    <StatusDot tone={snap?.agents.find((a) => a.paneId === preview.paneId)?.agentStatus ?? ""} />
                    <span className="truncate">{preview.title}</span>
                  </CardTitle>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="xs" variant="outline" disabled={busy} onClick={() => void peek(preview.paneId, preview.title)}>
                      <RefreshCw className="size-3" /> 다시 읽기
                    </Button>
                    <Button size="xs" disabled={busy} onClick={() => void act(() => api.herdrFocusPane(preview.paneId))}>
                      열기
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>
                      닫기
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="term-pre max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 text-[11px] leading-snug">
                    {preview.body}
                  </pre>
                </CardContent>
              </Card>
            )}

            {snap.workspaces.length === 0 && <Empty>워크스페이스가 없습니다. 「새 탭」으로 하나 만드세요.</Empty>}

            {snap.workspaces.map((ws) => (
              <WorkspacePanel
                key={ws.workspaceId}
                ws={ws}
                tabs={snap.tabs.filter((t) => t.workspaceId === ws.workspaceId)}
                agents={snap.agents}
                busy={busy}
                previewPaneId={preview?.paneId ?? null}
                onPeek={peek}
                onFocusWorkspace={(id) => void act(() => api.herdrFocusWorkspace(id))}
                onFocusPane={(id) => void act(() => api.herdrFocusPane(id))}
                onCloseTab={(id) => void act(() => api.herdrCloseTab(id), "탭을 닫았습니다.")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface WorkspacePanelProps {
  ws: HerdrWorkspace;
  tabs: HerdrTab[];
  agents: HerdrAgentRow[];
  busy: boolean;
  previewPaneId: string | null;
  onPeek: (paneId: string, title: string) => void;
  onFocusWorkspace: (id: string) => void;
  onFocusPane: (id: string) => void;
  onCloseTab: (id: string) => void;
}

/** 워크스페이스 한 개 = 카드 한 개. 헤더에 상태/메타, 본문에 탭 레일. */
function WorkspacePanel({
  ws,
  tabs,
  agents,
  busy,
  previewPaneId,
  onPeek,
  onFocusWorkspace,
  onFocusPane,
  onCloseTab,
}: WorkspacePanelProps) {
  const st = statusBadge(ws.agentStatus);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
        <CardTitle className="flex items-center gap-2 text-[13px]">
          <StatusDot tone={st.tone} pulse={st.tone === "working" || st.tone === "blocked"} />
          <span>{ws.label || `워크스페이스 ${ws.number}`}</span>
          <Badge variant={st.variant}>{st.label}</Badge>
          {ws.focused && (
            <Badge variant="secondary" className="gap-1">
              <span className="term-dot" data-tone="focused" aria-hidden /> 포커스
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            탭 {ws.tabCount} · 페인 {ws.paneCount}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onFocusWorkspace(ws.workspaceId)}
          >
            열기
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {tabs.length === 0 && <Empty>탭이 없습니다.</Empty>}
        {tabs.map((t) => (
          <TabRail
            key={t.tabId}
            tab={t}
            agents={agents.filter((a) => a.tabId === t.tabId)}
            busy={busy}
            previewPaneId={previewPaneId}
            onPeek={onPeek}
            onFocusPane={onFocusPane}
            onCloseTab={onCloseTab}
          />
        ))}
      </CardContent>
    </Card>
  );
}

interface TabRailProps {
  tab: HerdrTab;
  agents: HerdrAgentRow[];
  busy: boolean;
  previewPaneId: string | null;
  onPeek: (paneId: string, title: string) => void;
  onFocusPane: (id: string) => void;
  onCloseTab: (id: string) => void;
}

/** 탭 한 줄 = 좌측 레일 + 메타(라벨/상태/닫기) + 그 아래 에이전트 칩들. */
function TabRail({
  tab,
  agents,
  busy,
  previewPaneId,
  onPeek,
  onFocusPane,
  onCloseTab,
}: TabRailProps) {
  const ts = statusBadge(tab.agentStatus);
  return (
    <div className="rounded-md border bg-background/40 px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="term-rail" data-tone={ts.tone} aria-hidden />
        <StatusDot tone={ts.tone} pulse={ts.tone === "working" || ts.tone === "blocked"} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {tab.label || `탭 ${tab.number}`}
        </span>
        {tab.focused && (
          <Badge variant="secondary" className="gap-1">
            <span className="term-dot" data-tone="focused" aria-hidden /> 포커스
          </Badge>
        )}
        <Badge variant={ts.variant}>{ts.label}</Badge>
        <Button
          size="icon"
          variant="ghost"
          aria-label="탭 닫기"
          disabled={busy}
          title="탭 닫기"
          onClick={() => onCloseTab(tab.tabId)}
        >
          <SquareX />
        </Button>
      </div>
      {agents.length === 0 ? (
        <div className="mt-1 flex items-center gap-2 pl-5 text-[11px] text-muted-foreground">
          <span className="term-rail" data-tone="idle" aria-hidden />
          이 탭에 실행 중인 에이전트가 없습니다
        </div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {agents.map((a) => (
            <AgentChip
              key={a.paneId}
              agent={a}
              busy={busy}
              isPreview={previewPaneId === a.paneId}
              onPeek={onPeek}
              onFocusPane={onFocusPane}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface AgentChipProps {
  agent: HerdrAgentRow;
  busy: boolean;
  isPreview: boolean;
  onPeek: (paneId: string, title: string) => void;
  onFocusPane: (id: string) => void;
}

/** 에이전트 한 명 — 좌측 레일 · 호흡 점 · 종류 칩 · 제목/경로 · 호버 액션. */
function AgentChip({ agent, busy, isPreview, onPeek, onFocusPane }: AgentChipProps) {
  const st = statusBadge(agent.agentStatus);
  const kind = agentKind(agent.agent);
  const title = agent.terminalTitle || agent.name || agent.paneId;
  return (
    <div
      className={cn(
        "term-row group relative flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px]",
        agent.agentStatus === "blocked" && "bg-warning/10",
        isPreview && "bg-secondary",
        "hover:bg-accent/40",
      )}
    >
      <span className="term-rail" data-tone={st.tone} aria-hidden />
      <StatusDot
        tone={st.tone}
        pulse={st.tone === "working" || st.tone === "blocked"}
      />
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-[1px] font-mono text-[10px] font-medium",
          `term-kind-${kind.tone}`,
        )}
        title={`에이전트 종류: ${kind.label}`}
      >
        {kind.label}
      </span>
      <button
        onClick={() => onPeek(agent.paneId, title)}
        className="min-w-0 flex-1 truncate text-left hover:underline"
        title={`${agent.cwd}\n클릭하면 최근 출력을 봅니다`}
      >
        <span className="block truncate font-medium text-foreground">{title}</span>
        {agent.cwd && agent.cwd !== title && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
            {agent.cwd}
          </span>
        )}
      </button>
      <Badge variant={st.variant}>{st.label}</Badge>
      {agent.focused && (
        <Badge variant="secondary" className="gap-1">
          <span className="term-dot" data-tone="focused" aria-hidden /> 활성
        </Badge>
      )}
      <span className="term-row-actions flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          title="이 페인을 herdr 에서 앞으로"
          onClick={() => onFocusPane(agent.paneId)}
        >
          열기
        </Button>
      </span>
    </div>
  );
}
