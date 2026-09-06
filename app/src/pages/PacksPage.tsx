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
  PencilRuler,
  Play,
  RefreshCw,
  Trash2,
  Workflow,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { icon as packIcon } from "@/lib/icons";
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
import { workflowApi } from "@/features/workbench/api";
import type { WorkflowDefinition } from "@/features/workbench/types";

type CatalogCategory = "installed" | "marketplace" | "workflow" | "skill";

const CATALOG_TABS: { id: CatalogCategory; label: string }[] = [
  { id: "installed", label: "설치됨" },
  { id: "marketplace", label: "마켓플레이스" },
  { id: "skill", label: "스킬" },
  { id: "workflow", label: "워크플로" },
];

function WorkflowCard({
  wf,
  onOpenStudio,
}: {
  wf: WorkflowDefinition;
  onOpenStudio: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Workflow className="size-4 shrink-0 text-muted-foreground" />{" "}
          {wf.label}
          <Badge variant="outline" className="ml-auto">
            v{wf.version}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {wf.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {wf.description}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground">
          단계 {wf.nodes.length} · 전이 {wf.edges.length} · 앱에서 발행
        </p>
        <Button size="xs" variant="outline" onClick={onOpenStudio}>
          <PencilRuler className="size-3" /> 스튜디오에서 열기
        </Button>
      </CardContent>
    </Card>
  );
}

const SKILL_STATE_KO: Record<SkillState, string> = {
  installed: "설치됨",
  modified: "수정됨",
  missing: "미설치",
  noSource: "본문 없음",
};

function skillVariant(s: SkillState) {
  return s === "installed"
    ? "success"
    : s === "modified"
      ? "warning"
      : "outline";
}

function summarize(list: SkillStatus[]): string {
  const n = (s: SkillState) => list.filter((x) => x.state === s).length;
  return `설치 ${n("installed")} · 수정 ${n("modified")} · 미설치 ${n("missing")}`;
}

function reportText(r: InstallReport): string {
  const parts: string[] = [];
  if (r.installed.length > 0) parts.push(`처리 ${r.installed.length}건`);
  if (r.skipped.length > 0) parts.push(`건너뜀 ${r.skipped.length}건`);
  if (r.failed.length > 0) parts.push(`실패: ${r.failed.join(", ")}`);
  return parts.join(" · ") || "변경 없음";
}

export default function PacksPage() {
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
  const [selWfId, setSelWfId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);

  const list = packs?.packs ?? [];
  const selWf = workflows.find((w) => w.id === selWfId) ?? null;
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

  useEffect(() => {
    let alive = true;
    workflowApi
      .catalog()
      .then((rows) => {
        if (alive) setWorkflows(rows);
      })
      .catch(() => {
        if (alive) setWorkflows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

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
        `${installedPackage.manifest.name} ${installedPackage.manifest.version}을 검증해 설치했습니다.`,
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
        `${extension.manifest.name}을 ${extensionProject} 프로젝트에 정확한 digest로 고정했습니다.`,
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
      setMsg(
        `${extension.manifest.name}의 검증 가능한 portable package를 내보냈습니다.`,
      );
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
          ? `${pack.name} 을 켰습니다.`
          : `${pack.name} 을 껐습니다 — 이 팩의 화면과 예약이 사라집니다.`,
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
      setMsg(`${agent}: ${reportText(r)}`);
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
      setMsg(`${agent}: ${reportText(r)}`);
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
        `작업공간 반영 — 생성 ${r.created.length}건, 기존 유지 ${r.skipped.length}건` +
          (r.failed.length > 0
            ? `, 실패 ${r.failed.length}건 (${r.failed.join("; ")})`
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
      setMsg("설정을 저장했습니다.");
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
      <PageHeader title="확장 관리">
        {category === "workflow" && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              useApp.setState({ workflowToEdit: null });
              useApp.getState().setPage("workflows");
            }}
          >
            새 워크플로
          </Button>
        )}
        {category === "installed" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void provision()}
          >
            <HardDriveDownload /> 작업공간에 반영
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => void refreshPacks()}>
          <RefreshCw className="size-3" /> 새로고침
        </Button>
      </PageHeader>

      <div className="flex gap-1 border-b px-4 py-2">
        {CATALOG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setCategory(t.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
              category === t.id && "bg-secondary",
            )}
          >
            {t.label}
            {t.id === "workflow" && workflows.length > 0
              ? ` ${workflows.length}`
              : ""}
          </button>
        ))}
      </div>

      {msg && (
        <div className="border-b bg-muted px-4 py-1.5 text-xs">{msg}</div>
      )}

      {(packs?.broken ?? []).length > 0 && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-foreground">
            <CircleAlert className="size-4" /> 읽지 못한 확장{" "}
            {(packs?.broken ?? []).length}건
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
            <h2 className="text-sm font-semibold">연결된 기능</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              기능별 화면과 연결 상태를 관리합니다.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
          {(
            [
              {
                id: "feeds",
                name: "읽을거리",
                desc: "RSS 구독 · 읽기 목록 · 기사 보관",
                enabled: core.feeds,
              },
              {
                id: "github",
                name: "GitHub",
                desc: "저장소 탐색 · 프로젝트 가져오기 · 이슈 동기화",
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
                      ? "코어 확장"
                      : core.githubInstalled
                        ? "설치됨"
                        : "설치 가능"}
                  </span>
                  <span>· {extension.enabled ? "사용 중" : "사용 중지"}</span>
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
                    관리
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
                        `${extension.name} ${extension.enabled ? "사용 중지" : "사용 시작"}`,
                      );
                    } catch (error) {
                      setMsg(String(error));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {extension.enabled
                    ? "사용 중지"
                    : extension.id === "github" && !core.githubInstalled
                      ? "확장 설치·사용"
                      : "사용 시작"}
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
          외부 확장 설치
          {installed.length > 0 ? ` · ${installed.length}개 설치됨` : ""}
        </summary>
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">확장 패키지 설치</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 md:grid-cols-[150px_1fr_220px_auto]">
              <Select
                value={sourceKind}
                onChange={(event) =>
                  setSourceKind(event.target.value as typeof sourceKind)
                }
              >
                <option value="local-directory">로컬 폴더</option>
                <option value="local-file">패키지 파일</option>
                <option value="git">Git commit</option>
                <option value="https">HTTPS</option>
              </Select>
              {sourceKind.startsWith("local-") ? (
                <PathInput
                  directory={sourceKind === "local-directory"}
                  value={sourceLocation}
                  onValueChange={setSourceLocation}
                  placeholder="확장 패키지 경로"
                />
              ) : (
                <Input
                  value={sourceLocation}
                  onChange={(event) => setSourceLocation(event.target.value)}
                  placeholder="Git 또는 HTTPS 주소"
                />
              )}
              {sourceKind === "git" ? (
                <Input
                  value={sourceCommit}
                  onChange={(event) => setSourceCommit(event.target.value)}
                  placeholder="40자리 commit"
                />
              ) : (
                <span />
              )}
              <Button
                disabled={busy || !sourceLocation.trim()}
                onClick={() => void installExtensionPackage()}
              >
                <HardDriveDownload /> 검증·설치
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                적용 프로젝트
              </span>
              <Input
                className="h-8 w-44"
                value={extensionProject}
                onChange={(event) => setExtensionProject(event.target.value)}
              />
            </div>
            {installed.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                설치할 패키지 파일이나 주소를 선택하세요.
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
                        {locked && <Badge variant="success">고정됨</Badge>}
                        <Button
                          className="ml-auto"
                          size="xs"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void exportExtensionPackage(item)}
                        >
                          <Download className="size-3" /> 내보내기
                        </Button>
                        <Button
                          size="xs"
                          disabled={busy || locked}
                          title={`요청 권한: ${item.manifest.permissions.join(", ") || "없음"}`}
                          onClick={() => void activateExtensionPackage(item)}
                        >
                          권한 승인 및 적용
                        </Button>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                        sha256:{item.digest.slice(0, 16)}… · {item.source}
                      </p>
                      {item.manifest.permissions.length > 0 && (
                        <p className="mt-1">
                          권한: {item.manifest.permissions.join(", ")}
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

      {category === "workflow" && (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {workflows.length === 0 && (
            <Empty className="pt-16">
              발행된 워크플로우가 없습니다. 워크플로 스튜디오에서 만들거나 확장
              패키지로 가져올 수 있습니다.
            </Empty>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflows.map((wf) => (
              <WorkflowCard
                key={`${wf.id}@${wf.version}`}
                wf={wf}
                onOpenStudio={() => {
                  useApp.setState({ workflowToEdit: wf });
                  setPage("workflows");
                }}
              />
            ))}
          </div>
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
                    {pack.name} · 스킬 {pack.skills.length}개
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
                      {agent.id}에 설치
                    </Button>
                  ))}
                </CardContent>
              </Card>
            ))}
          {!list.some((p) => p.skills.length) && (
            <Empty>마켓플레이스나 확장 패키지에서 스킬을 설치하세요.</Empty>
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
            {list.length === 0 && <Empty>설치된 확장이 없습니다.</Empty>}
            {list.map((p) => {
              const Icon = packIcon(p.icon);
              return (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelId(p.id);
                    setSelWfId(null);
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
                      {p.source === "builtin" ? "내장" : "사용자"}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      화면 {p.views.length} · 액션 {p.actions.length} · 스킬{" "}
                      {p.skills.length}
                    </span>
                  </span>
                  {!p.enabled && <Badge variant="outline">꺼짐</Badge>}
                </button>
              );
            })}
            {agents.length > 0 && (
              <div className="mt-3 border-t pt-2">
                <div className="px-2 pb-1 text-[10px] font-semibold text-muted-foreground">
                  에이전트
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
                      {a.detected ? "감지됨" : "없음"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto p-4">
            {selWf && (
              <div className="mx-auto max-w-xl">
                <WorkflowCard
                  wf={selWf}
                  onOpenStudio={() => {
                    useApp.setState({ workflowToEdit: selWf });
                    setPage("workflows");
                  }}
                />
              </div>
            )}
            {!selWf && !sel && <Empty>왼쪽에서 확장을 선택하세요.</Empty>}
            {!selWf && sel && (
              <div className="space-y-3">
                <Card>
                  <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="flex items-center gap-2 text-sm">
                        {sel.name}
                        <Badge variant="secondary">v{sel.version}</Badge>
                        <Badge variant="outline">
                          {sel.source === "builtin" ? "내장" : "사용자"}
                        </Badge>
                      </CardTitle>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {sel.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 pl-3">
                      <span className="text-[11px] text-muted-foreground">
                        {sel.enabled ? "켜짐" : "꺼짐"}
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
                      <FolderOpen className="size-3" /> 폴더 열기
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-[13px]">
                      에이전트에 설치
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Claude Code 에는 번들 플러그인을 ~/.claude/skills/sawhorse
                      로 통째로 펼칩니다 (skills-dir 플러그인 — 설치 단계 없이
                      자동 적재). 손으로 고친 파일은 덮지 않고
                      <b> 수정됨</b>으로 표시합니다 — 덮어쓰려면 「강제 설치」를
                      쓰세요.
                    </p>
                    {status?.pluginInstalls &&
                      status.pluginInstalls.length > 0 && (
                        <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px]">
                          마켓플레이스 플러그인이 이미 설치되어 있습니다 (
                          {status.pluginInstalls
                            .map((p) => `${p.key} v${p.version}`)
                            .join(", ")}
                          ). 같은 내용이므로 앱은 사본을 만들지 않습니다 —
                          스킬은 그 플러그인이 제공합니다.
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
                              <Badge variant="outline">감지 안 됨</Badge>
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
                                <Download className="size-3" /> 설치
                              </Button>
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void install(sel, agent, true)}
                              >
                                강제 설치
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void uninstall(sel, agent)}
                              >
                                <Trash2 className="size-3" /> 제거
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
                                    {SKILL_STATE_KO[r.state]}
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
                        화면 {sel.views.length}개
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1">
                      {sel.views.length === 0 && (
                        <Empty>이 확장은 화면을 추가하지 않습니다.</Empty>
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
                            {v.type === "native" ? "내장 화면" : "선언형"}
                          </Badge>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-1">
                      <CardTitle className="text-[13px]">
                        액션 {sel.actions.length}개
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
                              {a.schedule.kind === "weekdays" ? "평일" : "매일"}{" "}
                              {a.schedule.time}
                            </Badge>
                          )}
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={
                              busy ||
                              !sel.enabled ||
                              a.params.some((p) => p.required)
                            }
                            title={
                              a.params.some((p) => p.required)
                                ? "필수 입력이 있는 액션은 해당 화면에서 실행하세요"
                                : a.prompt.replace(
                                    "{{ns}}",
                                    sel.source === "builtin"
                                      ? "sawhorse"
                                      : `sawhorse-${sel.id}`,
                                  )
                            }
                            onClick={() => void runAction(sel, a.id)}
                          >
                            <Play className="size-3" />
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>

                {sel.settings.length > 0 && draft && (
                  <Card>
                    <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                      <CardTitle className="text-[13px]">확장 설정</CardTitle>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => void saveSettings(sel)}
                      >
                        저장
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
                        작업공간에 만드는 것
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
                        닫기
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
          <option value="">(지정 안 함)</option>
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
                aria-label="삭제"
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
            줄 추가
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
