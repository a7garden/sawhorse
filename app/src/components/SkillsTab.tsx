// 확장 관리 → 스킬 탭.
// ① skills.sh 마켓플레이스 검색·설치, ② 확장 팩 스킬의 에이전트별 설치/업데이트/제거,
// ③ 에이전트 폴더에 실제로 설치된 스킬 열람 — 세 시야를 한 화면에 모은다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type {
  AgentPresence,
  AgentSkillEntry,
  AgentSkillGroup,
  InstallReport,
  MarketSkill,
  PackAgentStatus,
  PackInfo,
  SkillState,
  SkillStatus,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView } from "@/pages/common";

export function skillVariant(s: SkillState) {
  return s === "installed"
    ? "success"
    : s === "modified"
      ? "warning"
      : "outline";
}

export function summarize(list: SkillStatus[]): string {
  const n = (s: SkillState) => list.filter((x) => x.state === s).length;
  return i18n.t("packs:skill.summary", {
    installed: n("installed"),
    modified: n("modified"),
    missing: n("missing"),
  });
}

export function reportText(r: InstallReport): string {
  const parts: string[] = [];
  if (r.installed.length > 0)
    parts.push(i18n.t("packs:report.processed", { n: r.installed.length }));
  if (r.skipped.length > 0)
    parts.push(i18n.t("packs:report.skipped", { n: r.skipped.length }));
  if (r.failed.length > 0)
    parts.push(i18n.t("packs:report.failed", { list: r.failed.join(", ") }));
  return parts.join(" · ") || i18n.t("packs:report.none");
}

/** 한 팩의 에이전트별 스킬 상태 + 상태에 맞는 버튼 하나(설치/업데이트)를 렌더한다. */
export function AgentInstallRows({
  agents,
  groups,
  busy,
  onInstall,
  onUninstall,
  onOpenSkill,
}: {
  agents: AgentPresence[];
  groups: AgentSkillGroup[] | null;
  busy: boolean;
  onInstall: (agent: string, force: boolean) => void;
  onUninstall: (agent: string) => void;
  onOpenSkill?: (skill: string) => void;
}) {
  const { t } = useTranslation("packs");
  const targets = agents.filter((a) => a.installable);
  return (
    <>
      {targets.map((a) => {
        const rows = groups?.find((g) => g.agent === a.id)?.skills ?? [];
        const n = (s: SkillState) => rows.filter((x) => x.state === s).length;
        const installed = n("installed");
        const modified = n("modified");
        const allInstalled = rows.length > 0 && installed === rows.length;
        return (
          <div key={a.id} className="rounded-lg border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{a.name}</span>
              {!a.detected && (
                <Badge variant="outline">{t("packAgents.undetected")}</Badge>
              )}
              <span className="text-[11px] text-muted-foreground">
                {summarize(rows)}
              </span>
              <span className="ml-auto flex gap-1.5">
                {modified > 0 ? (
                  <Button
                    size="xs"
                    disabled={busy}
                    title={t("skillsTab.packs.updateHint")}
                    onClick={() => onInstall(a.id, true)}
                  >
                    <RefreshCw className="size-3" />{" "}
                    {t("skillsTab.packs.update")}
                  </Button>
                ) : allInstalled ? (
                  <Badge variant="success">{t("skill.state.installed")}</Badge>
                ) : (
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => onInstall(a.id, false)}
                  >
                    <Download className="size-3" /> {t("actions.install")}
                  </Button>
                )}
                {installed + modified > 0 && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => onUninstall(a.id)}
                  >
                    <Trash2 className="size-3" /> {t("actions.uninstall")}
                  </Button>
                )}
              </span>
            </div>
            {rows.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {rows.map((r) => (
                  <button
                    key={r.skill}
                    onClick={() => onOpenSkill?.(r.skill)}
                    title={r.target}
                    className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors hover:bg-accent"
                  >
                    {r.skill}
                    <Badge variant={skillVariant(r.state)}>
                      {t(`skill.state.${r.state}`)}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function SkillsTab({
  packs,
  agents,
  busy,
  setBusy,
  setMsg,
}: {
  packs: PackInfo[];
  agents: AgentPresence[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setMsg: (m: string | null) => void;
}) {
  const { t } = useTranslation("packs");
  const skillPacks = useMemo(
    () => packs.filter((p) => p.skills.length > 0),
    [packs],
  );
  const installTargets = useMemo(
    () => agents.filter((a) => a.installable),
    [agents],
  );

  // ---------- 확장 팩 스킬 상태 ----------
  const [statuses, setStatuses] = useState<Record<string, PackAgentStatus>>({});
  const loadStatuses = useCallback(async () => {
    const entries = await Promise.all(
      skillPacks.map(async (p) => {
        try {
          return [p.id, await api.packAgentStatus(p.id)] as const;
        } catch {
          return null;
        }
      }),
    );
    setStatuses(
      Object.fromEntries(
        entries.filter((e): e is [string, PackAgentStatus] => e !== null),
      ),
    );
  }, [skillPacks]);
  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  // ---------- 에이전트에 설치된 스킬 열람 ----------
  const [browseAgent, setBrowseAgent] = useState("claude");
  const [entries, setEntries] = useState<AgentSkillEntry[]>([]);
  const loadEntries = useCallback(async () => {
    try {
      setEntries(await api.listAgentSkills(browseAgent));
    } catch {
      setEntries([]);
    }
  }, [browseAgent]);
  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  // ---------- 마켓플레이스 ----------
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MarketSkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [marketTargets, setMarketTargets] = useState<Set<string>>(new Set());
  const [log, setLog] = useState<string | null>(null);
  // 에이전트 목록이 늦게 도착하면 감지된 대상을 기본 선택으로 채운다.
  useEffect(() => {
    setMarketTargets((prev) =>
      prev.size > 0
        ? prev
        : new Set(
            installTargets.filter((a) => a.detected).map((a) => a.id),
          ),
    );
  }, [installTargets]);

  // ---------- 문서 열람 ----------
  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);

  async function search() {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setMsg(null);
    try {
      setResults(await api.skillsMarketSearch(q));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setSearching(false);
    }
  }

  async function marketInstall(row: MarketSkill) {
    if (marketTargets.size === 0) {
      setMsg(t("skillsTab.market.noTargets"));
      return;
    }
    setBusy(true);
    setMsg(null);
    setLog(null);
    try {
      const out = await api.skillsMarketInstall(
        row.source,
        row.skillId || null,
        [...marketTargets],
      );
      setLog(out);
      setMsg(t("skillsTab.market.installed", { name: row.name }));
      await loadEntries();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function marketUpdate() {
    setBusy(true);
    setMsg(null);
    setLog(null);
    try {
      const out = await api.skillsMarketUpdate();
      setLog(out);
      setMsg(t("skillsTab.market.updated"));
      await loadEntries();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function packInstall(pack: PackInfo, agent: string, force: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.installPackSkills(pack.id, agent, force);
      const st = await api.packAgentStatus(pack.id);
      setStatuses((prev) => ({ ...prev, [pack.id]: st }));
      await loadEntries();
      setMsg(t("msg.agentReport", { agent, report: reportText(r) }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function packUninstall(pack: PackInfo, agent: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.uninstallPackSkills(pack.id, agent);
      const st = await api.packAgentStatus(pack.id);
      setStatuses((prev) => ({ ...prev, [pack.id]: st }));
      await loadEntries();
      setMsg(t("msg.agentReport", { agent, report: reportText(r) }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openPackSkill(pack: PackInfo, name: string) {
    try {
      setDoc({ title: name, body: await api.readPackSkill(pack.id, name) });
    } catch (e) {
      setDoc({ title: name, body: `> ${String(e)}` });
    }
  }

  async function openAgentSkill(entry: AgentSkillEntry) {
    try {
      setDoc({ title: entry.name, body: await api.readAgentSkill(entry.path) });
    } catch (e) {
      setDoc({ title: entry.name, body: `> ${String(e)}` });
    }
  }

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      {/* ① 마켓플레이스 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-[13px]">
            {t("skillsTab.market.title")}
            <Button
              size="xs"
              variant="outline"
              className="ml-auto"
              disabled={busy}
              onClick={() => void marketUpdate()}
            >
              <RefreshCw className="size-3" /> {t("skillsTab.market.updateAll")}
            </Button>
          </CardTitle>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("skillsTab.market.subtitle")}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("skillsTab.market.placeholder")}
            />
            <Button
              type="submit"
              size="sm"
              disabled={searching || query.trim().length < 2}
            >
              <Search className="size-3" /> {t("skillsTab.market.search")}
            </Button>
          </form>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>{t("skillsTab.market.targets")}</span>
            {installTargets.map((a) => {
              const on = marketTargets.has(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() =>
                    setMarketTargets((prev) => {
                      const next = new Set(prev);
                      if (next.has(a.id)) next.delete(a.id);
                      else next.add(a.id);
                      return next;
                    })
                  }
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 transition-colors",
                    on
                      ? "border-success bg-success/10 text-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  {a.name}
                  {!a.detected && ` (${t("packAgents.undetected")})`}
                </button>
              );
            })}
          </div>
          {results !== null && results.length === 0 && (
            <Empty>{t("skillsTab.market.noResults")}</Empty>
          )}
          {results !== null && results.length > 0 && (
            <div className="space-y-1">
              {results.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {row.name}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {row.source}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("skillsTab.market.installs", { n: row.installs })}
                  </span>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => void marketInstall(row)}
                  >
                    <Download className="size-3" /> {t("actions.install")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {log && (
            <div className="rounded-md border bg-muted/40">
              <div className="flex items-center px-2 pt-1.5 text-[10px] font-semibold text-muted-foreground">
                {t("skillsTab.market.logTitle")}
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setLog(null)}
                >
                  <X className="size-3" />
                </Button>
              </div>
              <pre className="max-h-48 overflow-auto px-2 pb-2 text-[10px] leading-relaxed">
                {log}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ② 확장 팩 스킬 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-[13px]">
            {t("skillsTab.packs.title")}
          </CardTitle>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("skillsTab.packs.subtitle")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {skillPacks.length === 0 && <Empty>{t("skill.empty")}</Empty>}
          {skillPacks.map((pack) => (
            <div key={pack.id} className="space-y-2">
              <div className="text-xs font-semibold">
                {t("skill.tabCardTitle", {
                  name: pack.name,
                  n: pack.skills.length,
                })}
              </div>
              <AgentInstallRows
                agents={agents}
                groups={statuses[pack.id]?.agents ?? null}
                busy={busy}
                onInstall={(agent, force) =>
                  void packInstall(pack, agent, force)
                }
                onUninstall={(agent) => void packUninstall(pack, agent)}
                onOpenSkill={(skill) => void openPackSkill(pack, skill)}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ③ 에이전트에 설치된 스킬 열람 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-[13px]">
            {t("skillsTab.browse.title")}
            <span className="ml-auto flex items-center gap-2">
              <Select
                value={browseAgent}
                onChange={setBrowseAgent}
                options={(installTargets.length > 0
                  ? installTargets
                  : [{ id: "claude", name: "Claude Code" } as AgentPresence]
                ).map((a) => ({ value: a.id, label: a.name }))}
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void loadEntries()}
              >
                <RefreshCw className="size-3" />
              </Button>
            </span>
          </CardTitle>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {t("skillsTab.browse.subtitle")}
          </p>
        </CardHeader>
        <CardContent className="space-y-1">
          {entries.length === 0 && <Empty>{t("skillsTab.browse.empty")}</Empty>}
          {entries.map((entry) => (
            <button
              key={entry.path}
              onClick={() => void openAgentSkill(entry)}
              title={entry.path}
              className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.name}</span>
                {entry.description && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {entry.description}
                  </span>
                )}
              </span>
              {entry.group && (
                <Badge variant="outline">{entry.group}</Badge>
              )}
              {entry.managed && (
                <Badge variant="secondary">
                  {t("skillsTab.browse.managed")}
                </Badge>
              )}
            </button>
          ))}
        </CardContent>
      </Card>

      {/* 문서 열람 */}
      {doc && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-[13px]">
              {doc.title}
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                onClick={() => setDoc(null)}
              >
                <X className="size-3" /> {t("actions.close")}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MarkdownView src={doc.body} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
