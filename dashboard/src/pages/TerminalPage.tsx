// 터미널 화면 — herdr 를 1급 시민으로 올린 자리.
// 잡 실행기 안에만 있던 herdr 를 사람이 직접 보고 다룰 수 있게 한다: 어느 워크스페이스에
// 무엇이 돌고 있는지, 무엇이 사람 응답을 기다리는지(blocked), 어디서 새 탭을 여는지.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Play, Plus, RefreshCw, SquareX, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { HerdrSnapshot, PackInfo } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BadgeVariant } from "./common";
import { AGENT_STATUS_KO, Empty, PageHeader } from "./common";

function statusBadge(s: string): { label: string; variant: BadgeVariant } {
  const known = (AGENT_STATUS_KO as Record<string, string>)[s];
  if (s === "blocked") return { label: known ?? s, variant: "warning" };
  if (s === "working") return { label: known ?? s, variant: "default" };
  if (s === "idle" || s === "done") return { label: known ?? s, variant: "outline" };
  return { label: known ?? (s || "없음"), variant: "secondary" };
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="터미널"
        desc="herdr 세션에서 무엇이 돌고 무엇이 사람을 기다리는지 봅니다. 잡도 여기서 열립니다."
      >
        <Button size="sm" variant="outline" disabled={busy || !snap?.available} onClick={() => void act(() => api.herdrOpenTab(target || undefined), "새 탭을 열었습니다.")}>
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
            {blocked.length > 0 && (
              <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-foreground">
                  <TriangleAlert className="size-4" /> 사람 응답을 기다리는 세션 {blocked.length}건
                </div>
                <div className="mt-1.5 space-y-1">
                  {blocked.map((a) => (
                    <div key={a.paneId} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate" title={a.cwd}>
                        {a.terminalTitle || a.name || a.paneId}
                      </span>
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

            {snap.workspaces.length === 0 && <Empty>워크스페이스가 없습니다. 「새 탭」으로 하나 만드세요.</Empty>}

            {snap.workspaces.map((ws) => {
              const tabs = snap.tabs.filter((t) => t.workspaceId === ws.workspaceId);
              const st = statusBadge(ws.agentStatus);
              return (
                <Card key={ws.workspaceId}>
                  <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                    <CardTitle className="flex items-center gap-2 text-[13px]">
                      {ws.label || `워크스페이스 ${ws.number}`}
                      <Badge variant={st.variant}>{st.label}</Badge>
                      {ws.focused && <Badge variant="secondary">포커스</Badge>}
                    </CardTitle>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        탭 {ws.tabCount} · 페인 {ws.paneCount}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void act(() => api.herdrFocusWorkspace(ws.workspaceId))}
                      >
                        열기
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {tabs.length === 0 && <Empty>탭이 없습니다.</Empty>}
                    {tabs.map((t) => {
                      const agents = snap.agents.filter((a) => a.tabId === t.tabId);
                      const ts = statusBadge(t.agentStatus);
                      return (
                        <div key={t.tabId} className="rounded-md border px-2.5 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {t.label || `탭 ${t.number}`}
                            </span>
                            <Badge variant={ts.variant}>{ts.label}</Badge>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="탭 닫기"
                              disabled={busy}
                              title="탭 닫기"
                              onClick={() => void act(() => api.herdrCloseTab(t.tabId), "탭을 닫았습니다.")}
                            >
                              <SquareX />
                            </Button>
                          </div>
                          {agents.map((a) => {
                            const as = statusBadge(a.agentStatus);
                            return (
                              <button
                                key={a.paneId}
                                onClick={() => void act(() => api.herdrFocusPane(a.paneId))}
                                className={cn(
                                  "mt-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[11px] transition-colors hover:bg-accent",
                                  a.agentStatus === "blocked" && "bg-warning/10",
                                )}
                              >
                                <span className="shrink-0 font-mono text-muted-foreground">{a.agent || "shell"}</span>
                                <span className="min-w-0 flex-1 truncate" title={a.cwd}>
                                  {a.terminalTitle || a.cwd || a.paneId}
                                </span>
                                <Badge variant={as.variant}>{as.label}</Badge>
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
