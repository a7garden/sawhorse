import { PathInput } from "@/components/ui/path-input";
import { useCoreExtensions } from "@/lib/core-extensions";
import { ExtensionMarketplace } from "@/components/ExtensionMarketplace";
// 확장(pack) 화면. 앱이 에이전트를 설치 대상으로 다루는 곳 —
// 여기서 "플러그인 설치"가 대시보드 안에서 일어난다.
import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  Download,
  FolderOpen,
  HardDriveDownload,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { actionJobKey } from "@/lib/jobs";
import { RunButton } from "@/components/RunButton";
import { useApp } from "@/lib/store";
import { icon as packIcon } from "@/lib/icons";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import type {
  InstallReport,
  PackAgentStatus,
  PackInfo,
  InstalledExtensionPackage,
  ExtensionLock,
  SettingField,
  SkillState,
  SkillStatus,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView, PageHeader } from "./common";

type CatalogCategory = "installed" | "marketplace" | "skill";

const CATALOG_TABS: CatalogCategory[] = [
  "installed",
  "marketplace",
  "skill",
];

function skillVariant(s: SkillState) {
  return s === "installed"
    ? "success"
    : s === "modified"
      ? "warning"
      : "outline";
}

function summarize(list: SkillStatus[]): string {
  const n = (s: SkillState) => list.filter((x) => x.state === s).length;
  return i18n.t("packs:skill.summary", {
    installed: n("installed"),
    modified: n("modified"),
    missing: n("missing"),
  });
}

function reportText(r: InstallReport): string {
  const parts: string[] = [];
  if (r.installed.length > 0)
    parts.push(i18n.t("packs:report.processed", { n: r.installed.length }));
  if (r.skipped.length > 0)
    parts.push(i18n.t("packs:report.skipped", { n: r.skipped.length }));
  if (r.failed.length > 0)
    parts.push(
      i18n.t("packs:report.failed", { list: r.failed.join(", ") }),
    );
  return parts.join(" · ") || i18n.t("packs:report.none");
}

export default function PacksPage() {
  const { t } = useTranslation("packs");
  const [installOpen, setInstallOpen] = useState(false);
  const core = useCoreExtensions();
  const packs = useApp((s) => s.packs);
  const agents = useApp((s) => s.agents);
  const refreshPacks = useApp((s) => s.refreshPacks);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);

  const [selId, setSelId] = useState<string | null>(null);
  const [status, setStatus] = useState<PackAgentStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skillDoc, setSkillDoc] = useState<{
    name: string;
    body: string;
  } | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [installed, setInstalled] = useState<InstalledExtensionPackage[]>([]);
  const [extensionLock, setExtensionLock] = useState<ExtensionLock | null>(
    null,
  );
  const [sourceKind, setSourceKind] = useState<
    "local-directory" | "local-file" | "git" | "https"
  >("local-directory");
  const [sourceLocation, setSourceLocation] = useState("");
  const [sourceCommit, setSourceCommit] = useState("");
  const [extensionProject, setExtensionProject] = useState("default");
  const [category, setCategory] = useState<CatalogCategory>("installed");

  const list = packs?.packs ?? [];
  const sel = list.find((p) => p.id === selId) ?? list[0] ?? null;

  useEffect(() => {
    void refreshAgents();
    void Promise.all([api.listExtensionPackages(), api.extensionLock()])
      .then(([packages, lock]) => {
        setInstalled(packages);
        setExtensionLock(lock);
      })
      .catch(() => undefined);
  }, [refreshAgents]);

  async function refreshExtensionPackages() {
    const [packages, lock] = await Promise.all([
      api.listExtensionPackages(),
      api.extensionLock(),
    ]);
    setInstalled(packages);
    setExtensionLock(lock);
  }

  async function installExtensionPackage() {
    if (!sourceLocation.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const installedPackage = await api.installExtensionPackage({
        kind: sourceKind,
        location: sourceLocation.trim(),
        commit: sourceKind === "git" ? sourceCommit.trim() : null,
      });
      await refreshExtensionPackages();
      setMsg(
        t("msg.installVerified", {
          name: installedPackage.manifest.name,
          version: installedPackage.manifest.version,
        }),
      );
    } catch (error) {
      setMsg(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function activateExtensionPackage(
    extension: InstalledExtensionPackage,
  ) {
    setBusy(true);
    setMsg(null);
    try {
      const closure = await api.resolveExtensionPackage(
        extension.manifest.id,
        extension.manifest.version,
      );
      const grants = Object.fromEntries(
        closure.map((item) => [item.manifest.id, item.manifest.permissions]),
      );
      const lock = await api.activateExtensionPackage({
        projectId: extensionProject,
        packageId: extension.manifest.id,
        version: extension.manifest.version,
        grants,
      });
      setExtensionLock(lock);
      await refreshPacks();
      setMsg(
        t("msg.activated", {
          name: extension.manifest.name,
          project: extensionProject,
        }),
      );
    } catch (error) {
      setMsg(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function exportExtensionPackage(extension: InstalledExtensionPackage) {
    setBusy(true);
    setMsg(null);
    try {
      const portable = await api.exportExtensionPackage(
        extension.manifest.id,
        extension.manifest.version,
        extension.digest,
      );
      const blob = new Blob([JSON.stringify(portable, null, 2)], {
        type: "application/json",
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = `${extension.manifest.id}-${extension.manifest.version}.sawhorse-package.json`;
      anchor.click();
      URL.revokeObjectURL(href);
      setMsg(t("msg.exported", { name: extension.manifest.name }));
    } catch (error) {
      setMsg(String(error));
    } finally {
      setBusy(false);
    }
  }

  const loadStatus = useCallback(async (id: string) => {
    try {
      setStatus(await api.packAgentStatus(id));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    if (!sel) return;
    setSkillDoc(null);
    setDraft({ ...sel.settingsValues });
    void loadStatus(sel.id);
  }, [sel?.id, loadStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggle(pack: PackInfo, on: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      await api.setPackEnabled(pack.id, on);
      await Promise.all([refreshPacks(), refreshConfig(), refreshSchedules()]);
      setMsg(
        on
          ? t("msg.enabled", { name: pack.name })
          : t("msg.disabled", { name: pack.name }),
      );
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function install(pack: PackInfo, agent: string, force: boolean) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.installPackSkills(pack.id, agent, force);
      await loadStatus(pack.id);
      setMsg(t("msg.agentReport", { agent, report: reportText(r) }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(pack: PackInfo, agent: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.uninstallPackSkills(pack.id, agent);
      await loadStatus(pack.id);
      setMsg(t("msg.agentReport", { agent, report: reportText(r) }));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function provision() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.provisionWorkspace();
      setMsg(
        t("msg.provisioned", {
          created: r.created.length,
          skipped: r.skipped.length,
        }) +
          (r.failed.length > 0
            ? t("msg.provisionFailed", {
                n: r.failed.length,
                list: r.failed.join("; "),
              })
            : ""),
      );
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(pack: PackInfo) {
    if (!draft) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.savePackSettings(pack.id, draft);
      await Promise.all([refreshPacks(), refreshConfig()]);
      setMsg(t("msg.settingsSaved"));
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(pack: PackInfo, actionId: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api.runPackAction(
        pack.id,
        actionId,
        {},
        pack.id.startsWith("x-") ? extensionProject : null,
      );
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openSkill(pack: PackInfo, name: string) {
    try {
      setSkillDoc({ name, body: await api.readPackSkill(pack.id, name) });
    } catch (e) {
      setSkillDoc({ name, body: `> ${String(e)}` });
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("header.title")}>
        {category === "installed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void provision()}
          >
            <HardDriveDownload /> {t("actions.applyWorkspace")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refreshPacks()}>
          <RefreshCw className="size-3" /> {t("actions.refresh")}
        </Button>
      </PageHeader>

      <div className="flex gap-1 border-b px-4 py-2">
        {CATALOG_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => setCategory(tab)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
              category === tab && "bg-secondary",
            )}
          >
            {t(`catalog.tabs.${tab}`)}
          </button>
        ))}
      </div>

      {msg && (
        <div className="border-b bg-muted px-4 py-1.5 text-xs">{msg}</div>
      )}

      {(packs?.broken ?? []).length > 0 && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-foreground">
            <CircleAlert className="size-4" />{" "}
            {t("broken.count", { n: (packs?.broken ?? []).length })}
          </div>
          <ul className="mt-1 space-y-0.5 pl-6 text-xs text-muted-foreground">
            {(packs?.broken ?? []).map((b) => (
              <li key={b.dir}>
                <span className="font-mono">{b.dir}</span> — {b.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {category === "installed" && (
        <div className="border-b p-4">
          <div className="mb-3">
            <h2 className="text-sm font-semibold">{t("core.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("core.subtitle")}
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
          {(
            [
              {
                id: "feeds",
                name: t("core.feeds.name"),
                desc: t("core.feeds.desc"),
                enabled: core.feeds,
              },
              {
                id: "github",
                name: "GitHub",
                desc: t("core.github.desc"),
                enabled: core.github,
              },
            ] as const
          ).map((extension) => (
            <Card
              key={extension.id}
              data-testid={`core-extension-${extension.id}`}
            >
              <CardHeader>
                <CardTitle>{extension.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="mb-3 text-xs text-muted-foreground">
                  {extension.desc}
                </p>
                <div className="mb-3 flex gap-2 text-xs text-muted-foreground">
                  <span>
                    {extension.id === "feeds"
                      ? t("core.coreExtension")
                      : core.githubInstalled
                        ? t("core.installed")
                        : t("core.available")}
                  </span>
                  <span>
                    ·{" "}
                    {extension.enabled
                      ? t("status.inUse")
                      : t("status.disabled")}
                  </span>
                </div>
                {(extension.id === "feeds" || core.githubInstalled) && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mr-2"
                    onClick={() =>
                      useApp
                        .getState()
                        .setPage(
                          extension.id === "github" ? "github" : "sources",
                        )
                    }
                  >
                    {t("core.manage")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant={extension.enabled ? "outline" : "default"}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setMsg(null);
                    try {
                      await core.setEnabled(extension.id, !extension.enabled);
                      setMsg(
                        t("msg.extensionToggled", {
                          name: extension.name,
                          action: extension.enabled
                            ? t("toggle.disable")
                            : t("toggle.enable"),
                        }),
                      );
                    } catch (error) {
                      setMsg(String(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {extension.enabled
                    ? t("toggle.disable")
                    : extension.id === "github" && !core.githubInstalled
                      ? t("toggle.installAndUse")
                      : t("toggle.enable")}
                </Button>
              </CardContent>
            </Card>
          ))}
          </div>
        </div>
      )}
      {category === "marketplace" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ExtensionMarketplace
            onChoose={(source) => {
              setInstallOpen(true);
              setSourceKind(source.kind);
              setSourceLocation(source.location);
              setSourceCommit(source.commit ?? "");
            }}
          />
          <details
            open={installOpen}
            onToggle={(event) => setInstallOpen(event.currentTarget.open)}
            className="border-b p-4"
          >
        <summary className="cursor-pointer text-sm font-medium">
          {t("install.title")}
          {installed.length > 0
            ? t("install.countSuffix", { n: installed.length })
            : ""}
        </summary>
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("install.cardTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-[150px_1fr_220px_auto]">
              <Select
                value={sourceKind}
                onChange={(event) =>
                  setSourceKind(event.target.value as typeof sourceKind)
                }
              >
                <option value="local-directory">
                  {t("install.localDirectory")}
                </option>
                <option value="local-file">{t("install.localFile")}</option>
                <option value="git">Git commit</option>
                <option value="https">HTTPS</option>
              </Select>
              {sourceKind.startsWith("local-") ? (
                <PathInput
                  directory={sourceKind === "local-directory"}
                  value={sourceLocation}
                  onValueChange={setSourceLocation}
                  placeholder={t("install.pathPlaceholder")}
                />
              ) : (
                <Input
                  value={sourceLocation}
                  onChange={(event) => setSourceLocation(event.target.value)}
                  placeholder={t("install.urlPlaceholder")}
                />
              )}
              {sourceKind === "git" ? (
                <Input
                  value={sourceCommit}
                  onChange={(event) => setSourceCommit(event.target.value)}
                  placeholder={t("install.commitPlaceholder")}
                />
              ) : (
                <span />
              )}
              <Button
                disabled={busy || !sourceLocation.trim()}
                onClick={() => void installExtensionPackage()}
              >
                <HardDriveDownload /> {t("install.verifyInstall")}
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("install.project")}
              </span>
              <Input
                className="h-8 w-44"
                value={extensionProject}
                onChange={(event) => setExtensionProject(event.target.value)}
              />
            </div>
            {installed.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("install.emptyHint")}
              </p>
            ) : (
              <div className="grid gap-2 lg:grid-cols-2">
                {installed.map((item) => {
                  const locked = extensionLock?.projects[
                    extensionProject
                  ]?.some(
                    (entry) =>
                      entry.id === item.manifest.id &&
                      entry.digest === item.digest,
                  );
                  return (
                    <div
                      key={`${item.manifest.id}-${item.digest}`}
                      className="rounded-md border p-3 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <strong>{item.manifest.name}</strong>
                        <Badge variant="outline">{item.manifest.version}</Badge>
                        {locked && (
                          <Badge variant="success">{t("install.pinned")}</Badge>
                        )}
                        <Button
                          className="ml-auto"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void exportExtensionPackage(item)}
                        >
                          <Download className="size-3" /> {t("install.export")}
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy || locked}
                          title={t("install.permissionsTitle", {
                            permissions:
                              item.manifest.permissions.join(", ") ||
                              t("install.noPermissions"),
                          })}
                          onClick={() => void activateExtensionPackage(item)}
                        >
                          {t("install.approveApply")}
                        </Button>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        sha256:{item.digest.slice(0, 16)}… · {item.source}
                      </p>
                      {item.manifest.permissions.length > 0 && (
                        <p className="mt-1">
                          {t("install.permissions", {
                            permissions: item.manifest.permissions.join(", "),
                          })}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
          </details>
        </div>
      )}

      {category === "skill" && (
        <div className="grid gap-3 p-4 md:grid-cols-2">
          {list
            .filter((pack) => pack.skills.length > 0)
            .map((pack) => (
              <Card key={pack.id}>
                <CardHeader>
                  <CardTitle>
                    {t("skill.tabCardTitle", {
                      name: pack.name,
                      n: pack.skills.length,
                    })}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-1">
                    {pack.skills.map((skill) => (
                      <Button
                        key={skill}
                        size="xs"
                        variant="ghost"
                        onClick={() => void openSkill(pack, skill)}
                      >
                        {skill}
                      </Button>
                    ))}
                  </div>
                  {agents.map((agent) => (
                    <Button
                      key={agent.id}
                      className="mr-2"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void install(pack, agent.id, false)}
                    >
                      {t("skill.installTo", { agent: agent.id })}
                    </Button>
                  ))}
                </CardContent>
              </Card>
            ))}
          {!list.some((p) => p.skills.length) && (
            <Empty>{t("skill.empty")}</Empty>
          )}
          {skillDoc && (
            <Card className="md:col-span-2">
              <CardHeader>
                <CardTitle>{skillDoc.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <MarkdownView src={skillDoc.body} />
              </CardContent>
            </Card>
          )}
        </div>
      )}
      {category === "installed" && list.length > 0 && (
        <div className="flex min-h-0 flex-1">
          <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
            {list.length === 0 && <Empty>{t("list.empty")}</Empty>}
            {list.map((p) => {
              const Icon = packIcon(p.icon);
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelId(p.id);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                    sel?.id === p.id && "bg-secondary",
                  )}
                >
                  <Icon
                    className={cn(
                      "size-3.5 shrink-0",
                      !p.enabled && "opacity-40",
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[13px] font-medium",
                        !p.enabled && "text-muted-foreground",
                      )}
                    >
                      {p.name}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      v{p.version} ·{" "}
                      {p.source === "builtin"
                        ? t("source.builtin")
                        : t("source.user")}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {t("list.counts", {
                        views: p.views.length,
                        actions: p.actions.length,
                        skills: p.skills.length,
                      })}
                    </span>
                  </span>
                  {!p.enabled && (
                    <Badge variant="outline">{t("status.off")}</Badge>
                  )}
                </button>
              );
            })}
            {agents.length > 0 && (
              <div className="mt-3 border-t pt-2">
                <div className="px-2 pb-1 text-[10px] font-semibold text-muted-foreground">
                  {t("packAgents.label")}
                </div>
                {agents.map((a) => (
                  <div
                    key={a.id}
                    className="flex items-center gap-2 px-2 py-1 text-[11px]"
                    title={a.note}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        a.detected ? "bg-success" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {a.detected
                        ? t("packAgents.detected")
                        : t("packAgents.none")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {!sel && <Empty>{t("list.selectHint")}</Empty>}
            {sel && (
              <div className="space-y-3">
                <Card>
                  <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        {sel.name}
                        <Badge variant="secondary">v{sel.version}</Badge>
                        <Badge variant="outline">
                          {sel.source === "builtin"
                            ? t("source.builtin")
                            : t("source.user")}
                        </Badge>
                      </CardTitle>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {sel.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pl-3">
                      <span className="text-[11px] text-muted-foreground">
                        {sel.enabled ? t("status.on") : t("status.off")}
                      </span>
                      <Switch
                        checked={sel.enabled}
                        disabled={busy}
                        onCheckedChange={(on) => void toggle(sel, on)}
                      />
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    {sel.author && <span>{sel.author}</span>}
                    <span className="truncate font-mono" title={sel.dir}>
                      {sel.dir}
                    </span>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void api.openPath(sel.dir)}
                    >
                      <FolderOpen className="size-3" /> {t("actions.openFolder")}
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-[13px]">
                      {t("installToAgent.title")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      {t("installToAgent.explain1")}
                      <b> {t("installToAgent.modifiedTag")}</b>
                      {t("installToAgent.explain2")}
                    </p>
                    {status?.pluginInstalls &&
                      status.pluginInstalls.length > 0 && (
                        <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px]">
                          {t("installToAgent.marketplaceExists", {
                            plugins: status.pluginInstalls
                              .map((p) => `${p.key} v${p.version}`)
                              .join(", "),
                          })}
                        </div>
                      )}
                    {(["claude", "codex"] as const).map((agent) => {
                      const rows = status ? status[agent] : [];
                      const present =
                        agents.find((a) => a.id === agent)?.detected ?? false;
                      return (
                        <div key={agent} className="rounded-lg border p-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[13px] font-medium">
                              {agent === "claude" ? "Claude Code" : "Codex"}
                            </span>
                            {!present && (
                              <Badge variant="outline">
                                {t("packAgents.undetected")}
                              </Badge>
                            )}
                            <span className="text-[11px] text-muted-foreground">
                              {summarize(rows)}
                            </span>
                            <span className="ml-auto flex gap-1.5">
                              <Button
                                size="xs"
                                disabled={busy}
                                onClick={() => void install(sel, agent, false)}
                              >
                                <Download className="size-3" />{" "}
                                {t("actions.install")}
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void install(sel, agent, true)}
                              >
                                {t("actions.forceInstall")}
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void uninstall(sel, agent)}
                              >
                                <Trash2 className="size-3" />{" "}
                                {t("actions.uninstall")}
                              </Button>
                            </span>
                          </div>
                          {rows.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {rows.map((r) => (
                                <button
                                  key={r.skill}
                                  onClick={() => void openSkill(sel, r.skill)}
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
                  </CardContent>
                </Card>

                <div className="grid gap-3 lg:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-1">
                      <CardTitle className="text-[13px]">
                      {t("views.count", { n: sel.views.length })}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {sel.views.length === 0 && (
                        <Empty>{t("views.empty")}</Empty>
                      )}
                      {sel.views.map((v) => (
                        <div
                          key={v.id}
                          className="flex items-center gap-2 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {v.label}
                          </span>
                          <Badge variant="outline">
                            {v.type === "native"
                              ? t("views.native")
                              : t("views.declarative")}
                          </Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-1">
                      <CardTitle className="text-[13px]">
                        {t("actionsList.count", { n: sel.actions.length })}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {sel.actions.map((a) => (
                        <div
                          key={a.id}
                          className="flex items-center gap-2 text-xs"
                        >
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={a.description}
                          >
                            {a.label}
                          </span>
                          {a.schedule && (
                            <Badge variant="outline">
                              {a.schedule.kind === "weekdays"
                                ? t("schedule.weekdays")
                                : t("schedule.daily")}{" "}
                              {a.schedule.time}
                            </Badge>
                          )}
                          <RunButton
                            size="xs"
                            variant="ghost"
                            label=""
                            ariaLabel={t("actions.runAria", { label: a.label })}
                            jobKey={actionJobKey(
                              sel.id,
                              a.id,
                              {},
                              sel.id.startsWith("x-") ? extensionProject : null,
                            )}
                            disabled={
                              busy ||
                              !sel.enabled ||
                              a.params.some((p) => p.required)
                            }
                            title={
                              a.params.some((p) => p.required)
                                ? t("actions.requiredParamsTitle")
                                : a.prompt.replace(
                                    "{{ns}}",
                                    sel.source === "builtin"
                                      ? "sawhorse"
                                      : `sawhorse-${sel.id}`,
                                  )
                            }
                            onRun={() => runAction(sel, a.id)}
                            onError={setMsg}
                          />
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>

                {sel.settings.length > 0 && draft && (
                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                      <CardTitle className="text-[13px]">
                        {t("settings.title")}
                      </CardTitle>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => void saveSettings(sel)}
                      >
                        {t("actions.save")}
                      </Button>
                    </CardHeader>
                    <CardContent className="grid gap-3 sm:grid-cols-2">
                      {sel.settings.map((f) => (
                        <SettingInput
                          key={f.key}
                          field={f}
                          value={draft[f.key]}
                          onChange={(v) => setDraft({ ...draft, [f.key]: v })}
                        />
                      ))}
                    </CardContent>
                  </Card>
                )}

                {sel.workspace.folders.length + sel.workspace.files.length >
                  0 && (
                  <Card>
                    <CardHeader className="pb-1">
                      <CardTitle className="text-[13px]">
                        {t("workspace.creates")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-wrap gap-1 text-[11px]">
                      {sel.workspace.folders.map((f) => (
                        <Badge key={f} variant="secondary">
                          {f}/
                        </Badge>
                      ))}
                      {sel.workspace.files.map((f) => (
                        <Badge key={f.dest} variant="outline">
                          {f.dest}
                        </Badge>
                      ))}
                    </CardContent>
                  </Card>
                )}

                {skillDoc && (
                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                      <CardTitle className="text-[13px]">
                        {skillDoc.name} · SKILL.md
                      </CardTitle>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setSkillDoc(null)}
                      >
                        {t("actions.close")}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <MarkdownView src={skillDoc.body} />
                    </CardContent>
                  </Card>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { t } = useTranslation("packs");
  const common = (
    <>
      <Label>{field.label}</Label>
      {field.description && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {field.description}
        </p>
      )}
    </>
  );

  if (field.type === "bool") {
    return (
      <div className="flex items-start gap-2">
        <Switch checked={value === true} onCheckedChange={onChange} />
        <div className="min-w-0">{common}</div>
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div>
        {common}
        <Select
          className="mt-1 w-full"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t("unset")}</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label || o.value}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (field.type === "table") {
    const rows: Record<string, string>[] = Array.isArray(value)
      ? (value as Record<string, string>[])
      : [];
    return (
      <div className="sm:col-span-2">
        {common}
        <div className="mt-1 space-y-1">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1">
              {field.columns.map((c) => (
                <Input
                  key={c.key}
                  className="h-7 text-xs"
                  placeholder={c.label || c.key}
                  value={row[c.key] ?? ""}
                  onChange={(e) =>
                    onChange(
                      rows.map((r, j) =>
                        i === j ? { ...r, [c.key]: e.target.value } : r,
                      ),
                    )
                  }
                />
              ))}
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("settings.deleteRow")}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="outline"
            onClick={() => onChange([...rows, {}])}
          >
            {t("settings.addRow")}
          </Button>
        </div>
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <div>
        {common}
        <Input
          type="number"
          className="mt-1"
          value={typeof value === "number" ? String(value) : ""}
          placeholder={field.placeholder}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <div>
      {common}
      {text.length > 80 ? (
        <Textarea
          className="mt-1"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          className="mt-1"
          value={text}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
