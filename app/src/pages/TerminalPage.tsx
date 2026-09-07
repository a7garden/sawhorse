// 터미널 화면 — herdr 를 1급 시민으로 올린 자리.
// 잡 실행기 안에만 있던 herdr 를 사람이 직접 보고 다룰 수 있게 한다: 어느 워크스페이스에
// 무엇이 돌고 있는지, 무엇이 사람 응답을 기다리는지(blocked), 어디서 새 탭을 여는지.
import { useCallback, useEffect, useState } from "react";
import {
  ExternalLink,
  Eye,
  Plus,
  RefreshCw,
  SquareX,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { actionJobKey } from "@/lib/jobs";
import { RunButton } from "@/components/RunButton";
import { Trans, useTranslation } from "react-i18next";
import type { HerdrSnapshot, PackInfo } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { BadgeVariant } from "./common";
import { AGENT_STATUS_KO, Empty, PageHeader } from "./common";

function statusBadge(
  s: string,
  noneLabel: string,
): { label: string; variant: BadgeVariant } {
  const known = (AGENT_STATUS_KO as Record<string, string>)[s];
  if (s === "blocked") return { label: known ?? s, variant: "warning" };
  if (s === "working") return { label: known ?? s, variant: "default" };
  if (s === "idle" || s === "done")
    return { label: known ?? s, variant: "outline" };
  return { label: known ?? (s || noneLabel), variant: "secondary" };
}

type Tone = "working" | "blocked" | "idle" | "done" | "focused";

function toneOf(status: string): Tone {
  if (
    status === "working" ||
    status === "blocked" ||
    status === "done" ||
    status === "focused"
  ) {
    return status;
  }
  return "idle";
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

export default function TerminalPage() {
  const config = useApp((s) => s.config);
  const packs = useApp((s) => s.packs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);
  const { t } = useTranslation("sessions");

  const [snap, setSnap] = useState<HerdrSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [action, setAction] = useState("");
  const [preview, setPreview] = useState<{
    paneId: string;
    title: string;
    body: string;
  } | null>(null);

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

  const enabledPacks: PackInfo[] = (packs?.packs ?? []).filter(
    (p) => p.enabled,
  );
  const runnable = enabledPacks.flatMap((p) =>
    p.actions
      .filter((a) => !a.params.some((x) => x.required))
      .map((a) => ({ pack: p, action: a })),
  );

  const cwdChoices = [
    {
      value: "",
      label: t("terminal.workspaceOption", {
        path: config?.vaultPath || t("unset"),
      }),
    },
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

  const selected =
    runnable.find((r) => `${r.pack.id}:${r.action.id}` === action) ?? null;
  const selectedActionKey = selected
    ? actionJobKey(selected.pack.id, selected.action.id)
    : "";

  async function runInTerminal() {
    const hit = selected;
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
    setPreview({ paneId, title, body: t("terminal.peeking") });
    try {
      setPreview({ paneId, title, body: await api.herdrReadPane(paneId, 60) });
    } catch (e) {
      setPreview({
        paneId,
        title,
        body: t("terminal.peekFailed", { error: String(e) }),
      });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("terminal.title")}>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !snap?.available}
          onClick={() =>
            void act(
              () => api.herdrOpenTab(target || undefined),
              t("terminal.toastTabOpened"),
            )
          }
        >
          <Plus /> {t("terminal.newTab")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="size-3" /> {t("actions.refresh")}
        </Button>
      </PageHeader>

      {msg && (
        <div className="border-b bg-muted px-4 py-1.5 text-xs">{msg}</div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {snap == null && <Empty>{t("terminal.checkingHerdr")}</Empty>}

        {snap && !snap.available && (
          <Card className="mx-auto max-w-xl">
            <CardHeader className="pb-1">
              <CardTitle className="text-[13px]">
                {t("terminal.unreachableTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                <Trans i18nKey="terminal.unreachableBody">
                  herdr 는 잡을 <b>사람이 볼 수 있고 이어받을 수 있는</b> 터미널
                  세션에서 돌리는 실행 기반입니다. 없으면 잡은 백그라운드로
                  조용히 돌아갑니다 — 동작은 하지만 승인 프롬프트에 답할 수
                  없습니다.
                </Trans>
              </p>
              {snap.error && (
                <p className="break-all font-mono text-[11px]">{snap.error}</p>
              )}
              <div className="flex gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void api.openExternal("https://herdr.dev")}
                >
                  <ExternalLink className="size-3" /> herdr.dev
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPage("settings")}
                >
                  {t("terminal.openSettings")}
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
                  <TriangleAlert className="size-4" />{" "}
                  {t("terminal.blockedTitle", { n: blocked.length })}
                </div>
                <div className="mt-1.5 space-y-1">
                  {blocked.map((a) => (
                    <div
                      key={a.paneId}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate" title={a.cwd}>
                        {a.terminalTitle || a.name || a.paneId}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void peek(a.paneId, a.terminalTitle || a.paneId)
                        }
                      >
                        <Eye className="size-3" /> {t("terminal.peek")}
                      </Button>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.herdrFocusPane(a.paneId))
                        }
                      >
                        {t("actions.open")}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-[13px]">
                  {t("terminal.runTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2">
                <Select
                  className="min-w-0 flex-1"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {cwdChoices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </Select>
                <Select
                  className="min-w-0 flex-1"
                  value={action}
                  onChange={(e) => setAction(e.target.value)}
                >
                  <option value="">{t("terminal.selectAction")}</option>
                  {runnable.map(({ pack, action: a }) => (
                    <option
                      key={`${pack.id}:${a.id}`}
                      value={`${pack.id}:${a.id}`}
                    >
                      {a.label} · {pack.name}
                    </option>
                  ))}
                </Select>
                <RunButton
                  size="sm"
                  variant="default"
                  label={t("actions.run")}
                  jobKey={selectedActionKey}
                  disabled={busy || action === ""}
                  onRun={runInTerminal}
                  onError={setMsg}
                />
                <p className="w-full text-[11px] text-muted-foreground">
                  {t("terminal.herdrNote")}
                </p>
              </CardContent>
            </Card>

            {preview && (
              <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                  <CardTitle
                    className="min-w-0 truncate text-[13px]"
                    title={preview.title}
                  >
                    {preview.title}
                  </CardTitle>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void peek(preview.paneId, preview.title)}
                    >
                      <RefreshCw className="size-3" /> {t("terminal.reread")}
                    </Button>
                    <Button
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        void act(() => api.herdrFocusPane(preview.paneId))
                      }
                    >
                      {t("actions.open")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setPreview(null)}
                    >
                      {t("actions.close")}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 text-[11px] leading-snug">
                    {preview.body}
                  </pre>
                </CardContent>
              </Card>
            )}

            {snap.workspaces.length === 0 && (
              <Empty>{t("terminal.emptyWorkspaces")}</Empty>
            )}

            {snap.workspaces.map((ws) => {
              const tabs = snap.tabs.filter(
                (t) => t.workspaceId === ws.workspaceId,
              );
              const st = statusBadge(ws.agentStatus, t("status.none"));
              return (
                <Card key={ws.workspaceId}>
                  <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                    <CardTitle className="flex items-center gap-2 text-[13px]">
                      {ws.label ||
                        t("terminal.workspaceNumbered", { n: ws.number })}
                      <Badge variant={st.variant}>{st.label}</Badge>
                      {ws.focused && (
                        <Badge variant="secondary">{t("terminal.focused")}</Badge>
                      )}
                    </CardTitle>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-muted-foreground">
                        {t("terminal.tabPaneCount", {
                          tabs: ws.tabCount,
                          panes: ws.paneCount,
                        })}
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(() =>
                            api.herdrFocusWorkspace(ws.workspaceId),
                          )
                        }
                      >
                        {t("actions.open")}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {tabs.length === 0 && (
                      <Empty>{t("terminal.emptyTabs")}</Empty>
                    )}
                    {tabs.map((tab) => {
                      const agents = snap.agents.filter(
                        (a) => a.tabId === tab.tabId,
                      );
                      const ts = statusBadge(tab.agentStatus, t("status.none"));
                      return (
                        <div
                          key={tab.tabId}
                          className="rounded-md border px-2.5 py-1.5"
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className="term-rail"
                              data-tone={toneOf(tab.agentStatus)}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {tab.label ||
                                t("terminal.tabNumbered", { n: tab.number })}
                            </span>
                            <Badge variant={ts.variant}>{ts.label}</Badge>
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label={t("terminal.closeTab")}
                              disabled={busy}
                              title={t("terminal.closeTab")}
                              onClick={() =>
                                void act(
                                  () => api.herdrCloseTab(tab.tabId),
                                  t("terminal.toastTabClosed"),
                                )
                              }
                            >
                              <SquareX />
                            </Button>
                          </div>
                          {agents.map((a) => {
                            const as = statusBadge(a.agentStatus, t("status.none"));
                            const tone = toneOf(a.agentStatus);
                            return (
                              <div
                                key={a.paneId}
                                className={cn(
                                  "term-row mt-1 flex items-center gap-2 rounded px-1.5 py-1 text-[11px]",
                                  a.agentStatus === "blocked" &&
                                    "bg-warning/10",
                                  preview?.paneId === a.paneId &&
                                    "bg-secondary",
                                )}
                              >
                                <span
                                  className="term-rail"
                                  data-tone={tone}
                                  aria-hidden
                                />
                                <StatusDot tone={a.agentStatus} pulse />
                                <span className="shrink-0 font-mono text-muted-foreground">
                                  {a.agent || "shell"}
                                </span>
                                <button
                                  onClick={() =>
                                    void peek(
                                      a.paneId,
                                      a.terminalTitle || a.paneId,
                                    )
                                  }
                                  className="min-w-0 flex-1 truncate text-left hover:underline"
                                  title={t("terminal.panePeekHint", {
                                    cwd: a.cwd,
                                  })}
                                >
                                  {a.terminalTitle || a.cwd || a.paneId}
                                </button>
                                <Badge variant={as.variant}>{as.label}</Badge>
                                <span className="term-row-actions">
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    disabled={busy}
                                    title={t("terminal.focusPaneTitle")}
                                    onClick={() =>
                                      void act(() =>
                                        api.herdrFocusPane(a.paneId),
                                      )
                                    }
                                  >
                                    {t("actions.open")}
                                  </Button>
                                </span>
                              </div>
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
