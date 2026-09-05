// 확장(pack) 화면. 앱이 에이전트를 설치 대상으로 다루는 곳 —
// 여기서 "플러그인 설치"가 대시보드 안에서 일어난다.
import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  Download,
  FolderOpen,
  HardDriveDownload,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { icon as packIcon } from "@/lib/icons";
import type {
  InstallReport,
  PackAgentStatus,
  PackInfo,
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

const SKILL_STATE_KO: Record<SkillState, string> = {
  installed: "설치됨",
  modified: "수정됨",
  missing: "미설치",
  noSource: "본문 없음",
};

function skillVariant(s: SkillState) {
  return s === "installed" ? "success" : s === "modified" ? "warning" : "outline";
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
  const [skillDoc, setSkillDoc] = useState<{ name: string; body: string } | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);

  const list = packs?.packs ?? [];
  const sel = list.find((p) => p.id === selId) ?? list[0] ?? null;

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

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
      setMsg(on ? `${pack.name} 을 켰습니다.` : `${pack.name} 을 껐습니다 — 이 팩의 화면과 예약이 사라집니다.`);
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
          (r.failed.length > 0 ? `, 실패 ${r.failed.length}건 (${r.failed.join("; ")})` : ""),
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
      await api.runPackAction(pack.id, actionId, {});
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

  if (!packs) return <Empty className="pt-16">확장 목록을 불러오는 중…</Empty>;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="확장"
        desc="이 앱이 할 줄 아는 일은 전부 확장이 정합니다. 켜고 끄면 화면과 예약이 함께 따라옵니다."
      >
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void provision()}>
          <HardDriveDownload /> 작업공간에 반영
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void refreshPacks()}>
          <RefreshCw className="size-3" /> 새로고침
        </Button>
      </PageHeader>

      {msg && <div className="border-b bg-muted px-4 py-1.5 text-xs">{msg}</div>}

      {packs.broken.length > 0 && (
        <div className="border-b border-warning/40 bg-warning/10 px-4 py-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-warning-foreground">
            <CircleAlert className="size-4" /> 읽지 못한 확장 {packs.broken.length}건
          </div>
          <ul className="mt-1 space-y-0.5 pl-6 text-xs text-muted-foreground">
            {packs.broken.map((b) => (
              <li key={b.dir}>
                <span className="font-mono">{b.dir}</span> — {b.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="w-56 shrink-0 overflow-y-auto border-r p-2">
          {list.length === 0 && <Empty>설치된 확장이 없습니다.</Empty>}
          {list.map((p) => {
            const Icon = packIcon(p.icon);
            return (
              <button
                key={p.id}
                onClick={() => setSelId(p.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                  sel?.id === p.id && "bg-secondary",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", !p.enabled && "opacity-40")} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-[13px] font-medium", !p.enabled && "text-muted-foreground")}>
                    {p.name}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    v{p.version} · {p.source === "builtin" ? "내장" : "사용자"}
                  </span>
                </span>
                {!p.enabled && <Badge variant="outline">꺼짐</Badge>}
              </button>
            );
          })}
          {agents.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <div className="px-2 pb-1 text-[10px] font-semibold text-muted-foreground">에이전트</div>
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-2 px-2 py-1 text-[11px]" title={a.note}>
                  <span className={cn("size-1.5 rounded-full", a.detected ? "bg-success" : "bg-muted-foreground/40")} />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="shrink-0 text-muted-foreground">{a.detected ? "감지됨" : "없음"}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {!sel && <Empty>왼쪽에서 확장을 선택하세요.</Empty>}
          {sel && (
            <div className="space-y-3">
              <Card>
                <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                  <div className="min-w-0">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      {sel.name}
                      <Badge variant="secondary">v{sel.version}</Badge>
                      <Badge variant="outline">{sel.source === "builtin" ? "내장" : "사용자"}</Badge>
                    </CardTitle>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{sel.description}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 pl-3">
                    <span className="text-[11px] text-muted-foreground">{sel.enabled ? "켜짐" : "꺼짐"}</span>
                    <Switch checked={sel.enabled} disabled={busy} onCheckedChange={(on) => void toggle(sel, on)} />
                  </div>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {sel.author && <span>{sel.author}</span>}
                  <span className="truncate font-mono" title={sel.dir}>
                    {sel.dir}
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void api.openPath(sel.dir)}>
                    <FolderOpen className="size-3" /> 폴더 열기
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-1">
                  <CardTitle className="text-[13px]">에이전트에 설치</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    이 확장의 스킬을 에이전트가 쓸 수 있게 넣습니다. 손으로 고친 파일은 덮지 않고
                    <b> 수정됨</b>으로 표시합니다 — 덮어쓰려면 「강제 설치」를 쓰세요.
                  </p>
                  {status?.pluginInstalls && status.pluginInstalls.length > 0 && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px]">
                      Claude Code 플러그인으로도 설치되어 있습니다
                      ({status.pluginInstalls.map((p) => `${p.key} v${p.version}`).join(", ")}).
                      개인 스킬까지 넣으면 같은 명령이 두 벌로 뜹니다.
                    </div>
                  )}
                  {(["claude", "codex"] as const).map((agent) => {
                    const rows = status ? status[agent] : [];
                    const present = agents.find((a) => a.id === agent)?.detected ?? false;
                    return (
                      <div key={agent} className="rounded-lg border p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium">
                            {agent === "claude" ? "Claude Code" : "Codex"}
                          </span>
                          {!present && <Badge variant="outline">감지 안 됨</Badge>}
                          <span className="text-[11px] text-muted-foreground">{summarize(rows)}</span>
                          <span className="ml-auto flex gap-1.5">
                            <Button size="xs" disabled={busy} onClick={() => void install(sel, agent, false)}>
                              <Download className="size-3" /> 설치
                            </Button>
                            <Button size="xs" variant="outline" disabled={busy} onClick={() => void install(sel, agent, true)}>
                              강제 설치
                            </Button>
                            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void uninstall(sel, agent)}>
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
                                <Badge variant={skillVariant(r.state)}>{SKILL_STATE_KO[r.state]}</Badge>
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
                    <CardTitle className="text-[13px]">화면 {sel.views.length}개</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {sel.views.length === 0 && <Empty>이 확장은 화면을 추가하지 않습니다.</Empty>}
                    {sel.views.map((v) => (
                      <div key={v.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate">{v.label}</span>
                        <Badge variant="outline">{v.type === "native" ? "내장 화면" : "선언형"}</Badge>
                      </div>
                    ))}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-[13px]">액션 {sel.actions.length}개</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {sel.actions.map((a) => (
                      <div key={a.id} className="flex items-center gap-2 text-xs">
                        <span className="min-w-0 flex-1 truncate" title={a.description}>
                          {a.label}
                        </span>
                        {a.schedule && (
                          <Badge variant="outline">
                            {a.schedule.kind === "weekdays" ? "평일" : "매일"} {a.schedule.time}
                          </Badge>
                        )}
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={busy || !sel.enabled || a.params.some((p) => p.required)}
                          title={
                            a.params.some((p) => p.required)
                              ? "필수 입력이 있는 액션은 해당 화면에서 실행하세요"
                              : a.prompt
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
                    <Button size="xs" disabled={busy} onClick={() => void saveSettings(sel)}>
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

              {sel.workspace.folders.length + sel.workspace.files.length > 0 && (
                <Card>
                  <CardHeader className="pb-1">
                    <CardTitle className="text-[13px]">작업공간에 만드는 것</CardTitle>
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
                    <CardTitle className="text-[13px]">{skillDoc.name} · SKILL.md</CardTitle>
                    <Button size="xs" variant="ghost" onClick={() => setSkillDoc(null)}>
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
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{field.description}</p>
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
    const rows: Record<string, string>[] = Array.isArray(value) ? (value as Record<string, string>[]) : [];
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
                    onChange(rows.map((r, j) => (i === j ? { ...r, [c.key]: e.target.value } : r)))
                  }
                />
              ))}
              <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button size="xs" variant="outline" onClick={() => onChange([...rows, {}])}>
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
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        />
      </div>
    );
  }
  const text = typeof value === "string" ? value : "";
  return (
    <div>
      {common}
      {text.length > 80 ? (
        <Textarea className="mt-1" value={text} onChange={(e) => onChange(e.target.value)} />
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
