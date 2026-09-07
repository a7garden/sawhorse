import { PathInput } from "@/components/ui/path-input";
// SourcesPage — 소스 커넥터 화면. instance 연결(feed/GitHub), 동기화 실행,
// GitHub 가져오기·field update 승인, 원격 쓰기 승인 대기를 담당한다(설계 690-810줄).
import { useCallback, useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CircleAlert,
  Download,
  Github,
  Inbox,
  Play,
  Plus,
  RefreshCw,
  Rss,
  Trash2,
} from "lucide-react";
import { api, EVENTS } from "@/lib/api";
import { isFeedCfg, isGitHubCfg } from "@/lib/types";
import type {
  DeadLetter,
  ExtensionBundle,
  ExtensionPermissionRequests,
  FeedEntryCfg,
  GitHubIssuePayload,
  InboundChange,
  RemoteOperation,
  SourceInstanceCfg,
  SourceInstanceRow,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Empty, PageHeader } from "./common";

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

const REMOTE_STATUSES = ["prepared", "approved", "uncertain", "failed"];

const REMOTE_STATUS_KEY: Record<string, string> = {
  prepared: "sources.remoteStatus.prepared",
  approved: "sources.remoteStatus.approved",
  uncertain: "sources.remoteStatus.uncertain",
  failed: "sources.remoteStatus.failed",
};

function remoteStatusLabel(t: TFunction, s: string): string {
  const key = REMOTE_STATUS_KEY[s];
  return key ? t(key) : s;
}

function remoteStatusVariant(
  s: string,
): "warning" | "default" | "destructive" | "outline" {
  if (s === "prepared" || s === "uncertain") return "warning";
  if (s === "failed") return "destructive";
  if (s === "approved") return "default";
  return "outline";
}

const REMOTE_KIND_KEY: Record<string, string> = {
  push: "sources.remoteKind.push",
  pr_create: "sources.remoteKind.pr_create",
};

function remoteKindLabel(t: TFunction, s: string): string {
  const key = REMOTE_KIND_KEY[s];
  return key ? t(key) : s;
}

function parseIssue(payload: string): GitHubIssuePayload | null {
  try {
    return JSON.parse(payload) as GitHubIssuePayload;
  } catch {
    return null;
  }
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function parseTagText(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 연결 가능한 connector component 하나(bundle+component 평탄화). */
interface ConnChoice {
  key: string;
  extensionId: string;
  extensionName: string;
  componentId: string;
  adapter: string;
  requests: ExtensionPermissionRequests;
}

function connChoices(bundles: ExtensionBundle[]): ConnChoice[] {
  const out: ConnChoice[] = [];
  for (const b of bundles) {
    for (const c of b.manifest.components) {
      if (c.type !== "connector") continue;
      out.push({
        key: `${b.manifest.id}:${c.id}`,
        extensionId: b.manifest.id,
        extensionName: b.manifest.name,
        componentId: c.id,
        adapter: c.adapter,
        requests: c.requests,
      });
    }
  }
  return out;
}

/** instance의 설정 모양으로 어댑터를 되찾는다 — instance 행이 extension id를 주지 않는다. */
function adapterOf(config: SourceInstanceCfg): string {
  return isFeedCfg(config) ? "builtin:rss" : "builtin:github";
}

const ADAPTER_KEY: Record<string, string> = {
  "builtin:rss": "sources.adapter.rss",
  "builtin:github": "sources.adapter.github",
};

function adapterLabel(t: TFunction, s: string): string {
  const key = ADAPTER_KEY[s];
  return key ? t(key) : s;
}

interface SyncInfo {
  ok: boolean;
  at: string;
  text: string;
}

export default function SourcesPage({
  scope = "rss",
}: {
  scope?: "rss" | "github";
}) {
  const { t } = useTranslation("sessions");
  const [bundles, setBundles] = useState<ExtensionBundle[]>([]);
  const [instances, setInstances] = useState<SourceInstanceRow[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([]);
  const [inbound, setInbound] = useState<InboundChange[]>([]);
  const [remoteOps, setRemoteOps] = useState<RemoteOperation[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [syncInfo, setSyncInfo] = useState<Record<string, SyncInfo>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  /** 가져오기 수락 폼 대상 — null이면 닫힘. */
  const [importFor, setImportFor] = useState<InboundChange | null>(null);
  const [importProjectId, setImportProjectId] = useState("");
  const [importNotesDir, setImportNotesDir] = useState("");
  const [importIdPrefix, setImportIdPrefix] = useState("");
  /** 실행 repoDir 프롬프트 대상 — null이면 닫힘. */
  const [execFor, setExecFor] = useState<RemoteOperation | null>(null);
  const [execRepoDir, setExecRepoDir] = useState("");

  const reload = useCallback(async () => {
    const [ext, inst, ib, ops] = await Promise.all([
      api.extensionsList().catch(() => null),
      api.sourcesListInstances().catch(() => null),
      scope === "github"
        ? api.inboundList("staged").catch(() => null)
        : Promise.resolve(null),
      scope === "github"
        ? api.remoteOperationsList(REMOTE_STATUSES).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (ext)
      setBundles(
        ext.bundles.filter(
          (b) =>
            b.enabled !== false &&
            b.manifest.components.some((c) => c.adapter === `builtin:${scope}`),
        ),
      );
    setInstances(
      (inst?.instances ?? []).filter((i) =>
        scope === "rss" ? isFeedCfg(i.config) : isGitHubCfg(i.config),
      ),
    );
    setDeadLetters(inst?.deadLetters ?? []);
    setInbound(ib?.inbound ?? []);
    setRemoteOps(ops?.operations ?? []);
  }, [scope]);

  useEffect(() => {
    void reload();
    let unlisten: UnlistenFn | null = null;
    // 새 EVENTS 없이 협업 레인 변화 이벤트에 편승한다 + 15초 폴링.
    let disposed = false;
    if ("__TAURI_INTERNALS__" in window)
      void listen(EVENTS.collabChanged, () => void reload())
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => undefined);
    const timer = window.setInterval(() => void reload(), 15000);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [reload]);

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

  const sel =
    instances.find((i) => i.instanceId === selId) ?? instances[0] ?? null;
  const selInbound = inbound.filter(
    (i) => i.sourceInstance === sel?.instanceId,
  );
  const importCandidates = selInbound.filter((i) => i.linkId === "");
  const updateCandidates = selInbound.filter((i) => i.linkId !== "");
  const selDead = deadLetters.filter((d) => d.source === sel?.instanceId);
  const selRequests = sel
    ? connChoices(bundles).find((c) => c.adapter === adapterOf(sel.config))
        ?.requests
    : undefined;

  function noteSync(id: string, ok: boolean, text: string) {
    setSyncInfo((prev) => ({
      ...prev,
      [id]: { ok, at: new Date().toLocaleTimeString(), text },
    }));
  }

  function refreshFeed(instance: SourceInstanceRow) {
    void act(
      `refresh:${instance.instanceId}`,
      () => api.sourcesRefresh(instance.instanceId),
      (r) => {
        noteSync(
          instance.instanceId,
          true,
          t("sources.sync.discoveredNote", { n: r.discovered }),
        );
        return t("sources.toast.feedRefreshed", { n: r.discovered });
      },
    );
  }

  function tickGithub(instance: SourceInstanceRow) {
    void act(
      `tick:${instance.instanceId}`,
      () => api.githubImportTick(instance.instanceId),
      (r) => {
        noteSync(
          instance.instanceId,
          true,
          t("sources.sync.tickNote", {
            fetched: r.fetched,
            stagedNew: r.stagedNew,
            stagedUpdates: r.stagedUpdates,
            skipped: r.skippedPullRequests,
          }) + (r.cursor ? ` · cursor ${r.cursor}` : ""),
        );
        return t("sources.toast.issuesFetched", {
          fetched: r.fetched,
          stagedNew: r.stagedNew,
          stagedUpdates: r.stagedUpdates,
        });
      },
    );
  }

  function openImportForm(ib: InboundChange) {
    setImportFor(ib);
    setImportProjectId("");
    setImportNotesDir("");
    setImportIdPrefix("");
  }

  function submitImport() {
    const ib = importFor;
    if (!ib) return;
    if (!importProjectId.trim() || !importNotesDir.trim()) {
      setMsg({
        ok: false,
        text: t("sources.validation.projectAndNotesDirRequired"),
      });
      return;
    }
    setImportFor(null);
    void act(
      `import:${ib.id}`,
      () =>
        api.inboundAcceptImport({
          inboundId: ib.id,
          projectId: importProjectId.trim(),
          notesDir: importNotesDir.trim(),
          idPrefix: importIdPrefix.trim(),
        }),
      (r) => t("sources.toast.noteCreated", { path: r.notePath }),
    );
  }

  function submitExecute() {
    const op = execFor;
    if (!op) return;
    if (!execRepoDir.trim()) {
      setMsg({ ok: false, text: t("sources.validation.repoDirRequired") });
      return;
    }
    setExecFor(null);
    void act(
      `exec:${op.id}`,
      () => api.remoteOperationExecute(op.id, execRepoDir.trim()),
      (r) => t("sources.toast.executed", { output: truncate(r, 160) }),
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={scope === "rss" ? t("sources.title.rss") : t("sources.title.github")}
      >
        <Button
          size="sm"
          disabled={!bundles.length}
          onClick={() => setAddOpen(true)}
        >
          <Plus /> {t("actions.addConnection")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void reload()}>
          <RefreshCw className="size-3" /> {t("actions.refresh")}
        </Button>
      </PageHeader>

      {msg && (
        <div
          className={cn(
            "border-b px-4 py-1.5 text-xs",
            msg.ok ? "text-success" : "text-destructive",
          )}
        >
          {msg.text}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
          {instances.length === 0 && (
            <Empty>{t("sources.empty.noInstances")}</Empty>
          )}
          {instances.map((i) => {
            const feedCfg = isFeedCfg(i.config) ? i.config : null;
            const ghCfg = isGitHubCfg(i.config) ? i.config : null;
            const Icon = feedCfg ? Rss : Github;
            const info = syncInfo[i.instanceId];
            return (
              <button
                key={i.instanceId}
                onClick={() => setSelId(i.instanceId)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  sel?.instanceId === i.instanceId && "bg-secondary",
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">
                    {i.instanceId}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {feedCfg
                      ? t("sources.instance.feedCount", {
                          n: feedCfg.feeds.length,
                        })
                      : ghCfg?.repository || "GitHub"}
                  </span>
                </span>
                {info && !info.ok ? (
                  <CircleAlert className="size-3.5 shrink-0 text-destructive" />
                ) : (
                  <Badge variant="outline">
                    {feedCfg ? t("sources.adapter.rss") : t("sources.adapter.github")}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {!sel && (
            <Empty>{t("sources.empty.selectInstance")}</Empty>
          )}
          {sel && (
            <div className="space-y-3">
              <InstanceCard
                instance={sel}
                requests={selRequests}
                info={syncInfo[sel.instanceId]}
                deadLetters={selDead}
                busy={busy != null}
                onRefresh={() => refreshFeed(sel)}
                onTick={() => tickGithub(sel)}
              />

              {scope === "github" && (
                <>
                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="flex items-center gap-2 text-[13px]">
                        <Inbox className="size-3.5" />{" "}
                        {t("sources.importCandidates.title")}
                      </CardTitle>
                      <span className="text-[11px] text-muted-foreground">
                        {t("sources.candidatesCount", {
                          n: importCandidates.length,
                        })}
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {importCandidates.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {t("sources.importCandidates.empty")}
                        </p>
                      )}
                      {importCandidates.map((ib) => {
                        const p = parseIssue(ib.payload);
                        return (
                          <div
                            key={ib.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5"
                          >
                            <Badge variant="outline">#{p?.number ?? "?"}</Badge>
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              {p?.title || ib.externalId}
                            </span>
                            {p?.state && (
                              <Badge
                                variant={
                                  p.state === "open" ? "success" : "secondary"
                                }
                              >
                                {p.state}
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground">
                              {fmtWhen(ib.createdAt)}
                            </span>
                            <Button
                              size="xs"
                              disabled={busy != null}
                              onClick={() => openImportForm(ib)}
                            >
                              <Download className="size-3" />{" "}
                              {t("actions.accept")}
                            </Button>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                      <CardTitle className="text-[13px]">
                        {t("sources.updates.title")}
                      </CardTitle>
                      <span className="text-[11px] text-muted-foreground">
                        {t("sources.candidatesCount", {
                          n: updateCandidates.length,
                        })}
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {updateCandidates.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {t("sources.updates.empty")}
                        </p>
                      )}
                      {updateCandidates.map((ib) => {
                        const p = parseIssue(ib.payload);
                        return (
                          <div
                            key={ib.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5"
                          >
                            <Badge variant="outline">#{p?.number ?? "?"}</Badge>
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              {p?.title || ib.externalId}
                            </span>
                            {p?.state && (
                              <Badge
                                variant={
                                  p.state === "open" ? "success" : "secondary"
                                }
                              >
                                {p.state}
                              </Badge>
                            )}
                            <span
                              className="min-w-0 max-w-48 truncate font-mono text-[10px] text-muted-foreground"
                              title={ib.targetPath}
                            >
                              {ib.targetPath || "-"}
                            </span>
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy != null}
                              onClick={() =>
                                void act(
                                  `update:${ib.id}`,
                                  () => api.inboundAcceptUpdate(ib.id),
                                  (r) =>
                                    t("sources.toast.updateApplied", {
                                      path: r.notePath,
                                    }),
                                )
                              }
                            >
                              {t("actions.accept")}
                            </Button>
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>

                  <RemoteOpsCard
                    ops={remoteOps}
                    busy={busy != null}
                    onApprove={(op) =>
                      void act(
                        `approve:${op.id}`,
                        () => api.remoteOperationApprove(op.id, "human"),
                        () => t("sources.toast.remoteApproved"),
                      )
                    }
                    onExecute={(op) => {
                      setExecFor(op);
                      setExecRepoDir("");
                    }}
                    onReconcile={(op, created) =>
                      void act(
                        `reconcile:${op.id}`,
                        () =>
                          api.remoteOperationReconcile(
                            op.id,
                            created,
                            created
                              ? t("sources.remote.reconciledCreatedNote")
                              : t("sources.remote.reconciledMissingNote"),
                          ),
                        () =>
                          created
                            ? t("sources.toast.reconciledCreated")
                            : t("sources.toast.reconciledMissing"),
                      )
                    }
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {addOpen && (
        <AddConnectionDialog
          choices={connChoices(bundles).filter(
            (c) => c.adapter === `builtin:${scope}`,
          )}
          takenIds={instances.map((i) => i.instanceId)}
          onClose={() => setAddOpen(false)}
          onSaved={async (instanceId, okText) => {
            await reload();
            setSelId(instanceId);
            setAddOpen(false);
            setMsg({ ok: true, text: okText });
          }}
          onError={(text) => setMsg({ ok: false, text })}
        />
      )}

      <Dialog
        open={importFor != null}
        onClose={() => setImportFor(null)}
        title={t("sources.dialog.importTitle")}
      >
        {importFor && (
          <div className="space-y-3">
            {(() => {
              const p = parseIssue(importFor.payload);
              return p ? (
                <p className="text-xs text-muted-foreground">
                  {t("sources.import.intro", { n: p.number, title: p.title })}
                </p>
              ) : null;
            })()}
            <div className="space-y-1">
              <Label>{t("sources.import.projectIdLabel")}</Label>
              <Input
                value={importProjectId}
                onChange={(e) => setImportProjectId(e.target.value)}
                placeholder={t("sources.import.projectIdPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("sources.import.notesDirLabel")}</Label>
              <PathInput
                value={importNotesDir}
                onValueChange={(value) => setImportNotesDir(value)}
                placeholder={t("sources.import.notesDirPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("sources.import.idPrefixLabel")}</Label>
              <Input
                value={importIdPrefix}
                onChange={(e) => setImportIdPrefix(e.target.value)}
                placeholder={t("sources.import.idPrefixPlaceholder")}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setImportFor(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy != null}
                onClick={() => void submitImport()}
              >
                {t("actions.import")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={execFor != null}
        onClose={() => setExecFor(null)}
        title={t("sources.dialog.execTitle")}
      >
        {execFor && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t("sources.exec.summary", {
                kind: remoteKindLabel(t, execFor.kind),
                capability: execFor.capability,
              })}
            </p>
            <div className="space-y-1">
              <Label>{t("sources.exec.repoDirLabel")}</Label>
              <PathInput
                value={execRepoDir}
                onValueChange={(value) => setExecRepoDir(value)}
                placeholder="/Volumes/…/repo"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExecFor(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy != null}
                onClick={() => void submitExecute()}
              >
                {t("actions.execute")}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function InstanceCard({
  instance,
  requests,
  info,
  deadLetters,
  busy,
  onRefresh,
  onTick,
}: {
  instance: SourceInstanceRow;
  requests?: ExtensionPermissionRequests;
  info: SyncInfo | undefined;
  deadLetters: DeadLetter[];
  busy: boolean;
  onRefresh: () => void;
  onTick: () => void;
}) {
  const { t } = useTranslation("sessions");
  const feedCfg = isFeedCfg(instance.config) ? instance.config : null;
  const ghCfg = isGitHubCfg(instance.config) ? instance.config : null;
  const adapter = adapterOf(instance.config);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
        <div className="min-w-0">
          <CardTitle className="flex items-center gap-2 text-sm">
            {instance.instanceId}
            <Badge variant="outline">{adapterLabel(t, adapter)}</Badge>
            {info === undefined ? (
              <Badge variant="outline">{t("sources.instance.statusUnknown")}</Badge>
            ) : info.ok ? (
              <Badge variant="success">{t("sources.instance.connected")}</Badge>
            ) : (
              <Badge variant="destructive">{t("sources.instance.error")}</Badge>
            )}
          </CardTitle>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t("sources.instance.lastSync", {
              detail: info ? `${info.at} — ${info.text}` : t("sources.instance.noSync"),
            })}
          </p>
          {requests && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {t("sources.instance.permissions")}
              {requests.repository.length > 0 && (
                <Badge variant="outline">
                  repository {requests.repository.join(",")}
                </Badge>
              )}
              {requests.issues.length > 0 && (
                <Badge variant="outline">
                  issues {requests.issues.join(",")}
                </Badge>
              )}
              {requests.network.length > 0 && (
                <Badge variant="outline">
                  network {requests.network.join(",")}
                </Badge>
              )}
              {requests.secrets.length > 0 && (
                <Badge variant="outline">
                  secrets {requests.secrets.join(",")}
                </Badge>
              )}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pl-3">
          {feedCfg ? (
            <Button size="xs" disabled={busy} onClick={onRefresh}>
              <RefreshCw className="size-3" /> {t("actions.refresh")}
            </Button>
          ) : (
            <Button size="xs" disabled={busy} onClick={onTick}>
              <RefreshCw className="size-3" /> {t("actions.importIssues")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-[11px] text-muted-foreground">
        {feedCfg && (
          <ul className="space-y-0.5">
            {feedCfg.feeds.map((f) => (
              <li key={f.url} className="flex items-center gap-1.5">
                <Rss className="size-3 shrink-0" />
                <span className="truncate font-mono" title={f.url}>
                  {f.url}
                </span>
                {f.name && <span className="shrink-0">({f.name})</span>}
              </li>
            ))}
          </ul>
        )}
        {ghCfg && (
          <p>
            {ghCfg.account || t("sources.gh.accountUnset")} ·{" "}
            {ghCfg.repository || t("sources.gh.repoUnset")} · state{" "}
            {ghCfg.state || "open"}
            <span className="ml-1 font-mono" title={ghCfg.repositoryId}>
              {truncate(ghCfg.repositoryId, 24)}
            </span>
          </p>
        )}
        <div>
          {t("sources.instance.deadLetterCount", { n: deadLetters.length })}
          {deadLetters.length > 0 && (
            <ul className="mt-1 space-y-0.5 pl-3">
              {deadLetters.slice(0, 5).map((d) => (
                <li
                  key={d.id}
                  className="truncate"
                  title={`${d.kind}: ${d.error}`}
                >
                  <span className="font-mono">{d.kind}</span> —{" "}
                  {truncate(d.error, 120)}{" "}
                  <span className="opacity-70">({fmtWhen(d.createdAt)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RemoteOpsCard({
  ops,
  busy,
  onApprove,
  onExecute,
  onReconcile,
}: {
  ops: RemoteOperation[];
  busy: boolean;
  onApprove: (op: RemoteOperation) => void;
  onExecute: (op: RemoteOperation) => void;
  onReconcile: (op: RemoteOperation, created: boolean) => void;
}) {
  const { t } = useTranslation("sessions");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-[13px]">
          {t("sources.remoteOps.title")}
        </CardTitle>
        <span className="text-[11px] text-muted-foreground">
          {t("sources.remoteOps.pendingCount", { n: ops.length })}
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        {ops.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            {t("sources.remoteOps.empty")}
          </p>
        )}
        {ops.map((op) => (
          <div key={op.id} className="space-y-1.5 rounded-lg border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">
                {remoteKindLabel(t, op.kind)}
              </Badge>
              <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground">
                {op.capability}
              </span>
              <Badge variant={remoteStatusVariant(op.status)}>
                {remoteStatusLabel(t, op.status)}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {fmtWhen(op.updatedAt)}
              </span>
              <span className="ml-auto flex shrink-0 gap-1.5">
                {op.status === "prepared" && (
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => onApprove(op)}
                  >
                    {t("actions.approve")}
                  </Button>
                )}
                {op.status === "approved" && (
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => onExecute(op)}
                  >
                    <Play className="size-3" /> {t("actions.execute")}
                  </Button>
                )}
                {op.status === "uncertain" && (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onReconcile(op, true)}
                    >
                      {t("sources.remoteOps.created")}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onReconcile(op, false)}
                    >
                      {t("sources.remoteOps.notCreated")}
                    </Button>
                  </>
                )}
              </span>
            </div>
            {op.resultJson && (
              <p
                className="truncate font-mono text-[10px] text-muted-foreground"
                title={op.resultJson}
              >
                {truncate(op.resultJson, 160)}
              </p>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function AddConnectionDialog({
  choices,
  takenIds,
  onClose,
  onSaved,
  onError: reportError,
}: {
  choices: ConnChoice[];
  takenIds: string[];
  onClose: () => void;
  onSaved: (instanceId: string, okText: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const { t } = useTranslation("sessions");
  const [error, setError] = useState("");
  const onError = (message: string) => {
    setError(message);
    reportError(message);
  };
  const [choiceKey, setChoiceKey] = useState(choices[0]?.key ?? "");
  const [name, setName] = useState("");
  const [feeds, setFeeds] = useState<FeedEntryCfg[]>([
    { name: "", url: "", tags: [] },
  ]);
  const [tagsText, setTagsText] = useState<string[]>([""]);
  const [refreshMinutes, setRefreshMinutes] = useState("30");
  const [ghAccount, setGhAccount] = useState("");
  const [ghRepository, setGhRepository] = useState("");
  const [ghRepositoryId, setGhRepositoryId] = useState("");
  const [ghState, setGhState] = useState("open");
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const choice = choices.find((c) => c.key === choiceKey) ?? null;
  const isRss = choice?.adapter === "builtin:rss";
  const isGithub = choice?.adapter === "builtin:github";
  const suggestedHosts = [
    ...new Set(feeds.map((f) => hostOf(f.url.trim())).filter(Boolean)),
  ];
  const missingHosts = suggestedHosts.filter((h) => !granted[h]);

  // feed URL이 늘면 도메인 grant 후보를 자동으로 담는다(사용자가 끌 수도 있다).
  const hostKey = suggestedHosts.join("|");
  useEffect(() => {
    if (!isRss || suggestedHosts.length === 0) return;
    setGranted((prev) => ({
      ...prev,
      ...Object.fromEntries(suggestedHosts.map((h) => [h, true])),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostKey]);

  function setFeed(i: number, patch: Partial<FeedEntryCfg>) {
    setFeeds((rows) => rows.map((r, j) => (i === j ? { ...r, ...patch } : r)));
  }

  function toggleGrant(h: string) {
    setGranted((prev) => ({ ...prev, [h]: !prev[h] }));
  }

  async function save() {
    if (!choice) return onError(t("sources.add.errors.selectConnector"));
    const id = name.trim();
    if (!id) return onError(t("sources.add.errors.nameRequired"));
    if (takenIds.includes(id))
      return onError(t("sources.add.errors.nameTaken"));
    let config: SourceInstanceCfg;
    let network: string[];
    if (isRss) {
      const rows = feeds.filter((f) => f.url.trim().length > 0);
      if (rows.length === 0)
        return onError(t("sources.add.errors.feedUrlRequired"));
      config = {
        feeds: rows.map((f, i) => ({
          name: f.name.trim(),
          url: f.url.trim(),
          tags: parseTagText(tagsText[i] ?? ""),
        })),
        refreshMinutes:
          Number(refreshMinutes) > 0 ? Number(refreshMinutes) : 30,
        storeContent: false,
      };
      network = suggestedHosts.filter((h) => granted[h]);
      if (network.length === 0)
        return onError(t("sources.add.errors.networkGrantRequired"));
    } else {
      if (!ghRepositoryId.trim())
        return onError(t("sources.add.errors.repoIdRequired"));
      config = {
        account: ghAccount.trim(),
        repository: ghRepository.trim(),
        repositoryId: ghRepositoryId.trim(),
        state: ghState,
      };
      network = choice.requests.network;
    }
    setSaving(true);
    try {
      await api.sourcesUpsertInstance({
        instanceId: id,
        extensionId: choice.extensionId,
        componentId: choice.componentId,
        config,
        network,
      });
      await onSaved(id, t("sources.toast.connectionSaved", { id }));
    } catch (e) {
      onError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title={t("sources.dialog.addTitle")} wide>
      {error && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t("sources.add.serviceLabel")}</Label>
            <Select
              className="w-full"
              value={choiceKey}
              onChange={(e) => setChoiceKey(e.target.value)}
            >
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.extensionName}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t("sources.add.nameLabel")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("sources.add.namePlaceholder")}
            />
          </div>
        </div>

        {choice && (
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {t("sources.add.requestedPermissions")}
            {choice.requests.repository.length > 0 && (
              <Badge variant="outline">
                repository {choice.requests.repository.join(",")}
              </Badge>
            )}
            {choice.requests.issues.length > 0 && (
              <Badge variant="outline">
                issues {choice.requests.issues.join(",")}
              </Badge>
            )}
            {choice.requests.secrets.length > 0 && (
              <Badge variant="outline">
                secrets {choice.requests.secrets.join(",")}
              </Badge>
            )}
            {choice.requests.network.length > 0 && (
              <Badge variant="outline">
                network {choice.requests.network.join(",")}
              </Badge>
            )}
          </p>
        )}

        {isRss && (
          <div className="space-y-2">
            <Label>{t("sources.add.rssLabel")}</Label>
            {feeds.map((f, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  className="w-32 shrink-0"
                  placeholder={t("sources.add.feedNamePlaceholder")}
                  value={f.name}
                  onChange={(e) => setFeed(i, { name: e.target.value })}
                />
                <Input
                  className="min-w-0 flex-1"
                  placeholder="https://example.com/feed.xml"
                  value={f.url}
                  onChange={(e) => setFeed(i, { url: e.target.value })}
                />
                <Input
                  className="w-32 shrink-0"
                  placeholder={t("sources.add.tagsPlaceholder")}
                  value={tagsText[i] ?? ""}
                  onChange={(e) =>
                    setTagsText((t) =>
                      t.map((v, j) => (i === j ? e.target.value : v)),
                    )
                  }
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("sources.add.feedRemoveAria")}
                  disabled={feeds.length === 1}
                  onClick={() => {
                    setFeeds((rows) => rows.filter((_, j) => j !== i));
                    setTagsText((t) => t.filter((_, j) => j !== i));
                  }}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-3">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setFeeds((rows) => [
                    ...rows,
                    { name: "", url: "", tags: [] },
                  ]);
                  setTagsText((t) => [...t, ""]);
                }}
              >
                <Plus className="size-3" /> {t("sources.add.addFeed")}
              </Button>
              <div className="flex items-center gap-1.5">
                <Label>{t("sources.add.refreshMinutesLabel")}</Label>
                <Input
                  type="number"
                  className="h-7 w-20"
                  value={refreshMinutes}
                  onChange={(e) => setRefreshMinutes(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("sources.add.allowHostsLabel")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {suggestedHosts.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {t("sources.add.hostsHint")}
                  </span>
                )}
                {suggestedHosts.map((h) => (
                  <button key={h} type="button" onClick={() => toggleGrant(h)}>
                    <Badge variant={granted[h] ? "success" : "outline"}>
                      {granted[h] ? h : t("sources.add.hostDenied", { host: h })}
                    </Badge>
                  </button>
                ))}
              </div>
              {missingHosts.length > 0 && (
                <p className="text-[10px] text-warning-foreground">
                  {t("sources.add.deniedHostsWarning")}
                </p>
              )}
            </div>
          </div>
        )}

        {isGithub && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("sources.add.accountLabel")}</Label>
              <Input
                value={ghAccount}
                onChange={(e) => setGhAccount(e.target.value)}
                placeholder="octocat"
              />
            </div>
            <div className="space-y-1">
              <Label>{t("sources.add.repoLabel")}</Label>
              <Input
                value={ghRepository}
                onChange={(e) => setGhRepository(e.target.value)}
                placeholder="octocat/hello-world"
              />
            </div>
            <div className="space-y-1">
              <Label>{t("sources.add.repoIdLabel")}</Label>
              <Input
                value={ghRepositoryId}
                onChange={(e) => setGhRepositoryId(e.target.value)}
                placeholder="R_…"
              />
            </div>
            <div className="space-y-1">
              <Label>{t("sources.add.stateLabel")}</Label>
              <Select
                className="w-full"
                value={ghState}
                onChange={(e) => setGhState(e.target.value)}
              >
                <option value="open">open</option>
                <option value="closed">closed</option>
                <option value="all">all</option>
              </Select>
            </div>
          </div>
        )}

        {!isRss && !isGithub && choice && (
          <p className="text-[11px] text-warning-foreground">
            {t("sources.add.noConfigForm", { adapter: choice.adapter })}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {t("actions.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
