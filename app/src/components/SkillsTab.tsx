// Installed skill management. Discovery and npx installation live in SkillsMarketplace.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import type {
  AgentPresence,
  AgentSkillEntry,
  AgentSkillGroup,
  InstallReport,
  PackAgentStatus,
  PackInfo,
  SkillState,
  SkillStatus,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
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

/** Renders one pack's per-agent skill status plus a single status-appropriate button (install/update). */
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
  const browseTargets = useMemo(
    () => agents.filter((a) => ["claude", "codex"].includes(a.id)),
    [agents],
  );

  // ---------- extension-pack skill status ----------
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

  // ---------- skills installed in agents ----------
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

  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);

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
      {/* ② extension-pack skills */}
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

      {/* ③ skills installed in agents */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-[13px]">
            <span>{t("skillsTab.browse.title")}</span>
            <span className="ml-auto flex items-center gap-2">
              <Select
                aria-label={t("skillsTab.browse.title")}
                value={browseAgent}
                onChange={setBrowseAgent}
                options={(browseTargets.length > 0
                  ? browseTargets
                  : [{ id: "claude", name: "Claude Code" } as AgentPresence]
                ).map((a) => ({ value: a.id, label: a.name }))}
              />
              <Button
                size="xs"
                variant="ghost"
                aria-label={t("actions.refresh")}
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

      {/* doc browsing */}
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
