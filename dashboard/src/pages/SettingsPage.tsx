import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView, PermissionMode, ProjectCfg, RoutineName } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Empty, PageHeader } from "./common";

const ROUTINES: { key: RoutineName; label: string }[] = [
  { key: "morning", label: "아침" },
  { key: "lunch", label: "점심" },
  { key: "evening", label: "저녁" },
];

const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "기본" },
  { value: "acceptEdits", label: "편집 자동 승인" },
  { value: "bypassPermissions", label: "권한 우회 (무인 실행)" },
];

function validate(d: ConfigView): string | null {
  if (d.vaultPath.trim().length === 0) return "볼트 경로를 입력하세요.";
  const names = new Set<string>();
  for (const p of d.projects) {
    if (p.name.trim().length === 0) return "프로젝트 이름이 비어 있습니다.";
    if (names.has(p.name)) return `프로젝트 이름이 중복됩니다: ${p.name}`;
    names.add(p.name);
    if (p.path.trim().length === 0) return `${p.name} 프로젝트의 경로가 비어 있습니다.`;
  }
  if (d.defaultProject.length > 0 && !names.has(d.defaultProject))
    return "기본 프로젝트가 프로젝트 목록에 없습니다.";
  for (const r of ROUTINES) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.dashboard.schedules[r.key].time.trim()))
      return `${r.label} 루틴 시각은 HH:MM 형식이어야 합니다.`;
  }
  if (d.dashboard.claudeBin.trim().length === 0) return "claude 실행 파일을 입력하세요.";
  return null;
}

export default function SettingsPage() {
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);

  const [draft, setDraft] = useState<ConfigView | null>(config ? structuredClone(config) : null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(config ? structuredClone(config) : null);
  }, [config]);

  const dirty = useMemo(
    () => config != null && draft != null && JSON.stringify(draft) !== JSON.stringify(config),
    [config, draft],
  );

  function patchDraft(fn: (d: ConfigView) => void) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    const problem = validate(draft);
    if (problem) {
      setMsg({ ok: false, text: problem });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const patch: ConfigPatch = {
        vaultPath: draft.vaultPath.trim(),
        defaultProject: draft.defaultProject,
        projects: draft.projects,
        schedules: draft.dashboard.schedules,
        excelOutputDir: draft.dashboard.excelOutputDir,
        claudeBin: draft.dashboard.claudeBin,
        permissionMode: draft.dashboard.permissionMode,
        launchAtLogin: draft.dashboard.launchAtLogin,
      };
      await api.saveConfig(patch);
      await refreshConfig();
      await refreshDiagnostics();
      setMsg({ ok: true, text: "설정을 저장했습니다." });
    } catch (e) {
      setMsg({ ok: false, text: `저장 실패: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function toggleLogin(on: boolean) {
    patchDraft((d) => {
      d.dashboard.launchAtLogin = on;
    });
    try {
      await api.setLaunchAtLogin(on);
    } catch (e) {
      setMsg({ ok: false, text: `자동 시작 설정 실패: ${String(e)}` });
    }
  }

  return (
    <div>
      <PageHeader title="설정" desc="볼트·프로젝트·루틴과 실행 옵션을 관리합니다.">
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(config ? structuredClone(config) : null);
            setMsg(null);
          }}
        >
          되돌리기
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "저장 중…" : "저장"}
        </Button>
      </PageHeader>

      {msg && (
        <div className={`px-4 pt-2 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.text}
        </div>
      )}

      {!draft ? (
        <Empty>설정을 불러오는 중…</Empty>
      ) : (
        <div className="grid gap-4 p-4 lg:grid-cols-2">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-[13px]">볼트</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="vault-path">볼트 경로</Label>
                  <Input
                    id="vault-path"
                    value={draft.vaultPath}
                    onChange={(e) => patchDraft((d) => (d.vaultPath = e.target.value))}
                    placeholder="/path/to/vault"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="default-project">기본 프로젝트</Label>
                  <Select
                    id="default-project"
                    className="w-full"
                    value={draft.defaultProject}
                    onChange={(e) => patchDraft((d) => (d.defaultProject = e.target.value))}
                  >
                    <option value="">(없음)</option>
                    {draft.projects.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">프로젝트</CardTitle>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    patchDraft((d) => {
                      const p: ProjectCfg = {
                        name: "",
                        path: "",
                        workBranch: "main",
                        portableBase: "",
                        idPrefix: "",
                        verify: "",
                      };
                      d.projects.push(p);
                    })
                  }
                >
                  <Plus /> 추가
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {draft.projects.length === 0 && <Empty className="py-4">등록된 프로젝트가 없습니다.</Empty>}
                {draft.projects.map((p, i) => (
                  <div key={i} className="space-y-2 rounded-lg border p-2.5">
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-7 flex-1"
                        value={p.name}
                        onChange={(e) => patchDraft((d) => (d.projects[i].name = e.target.value))}
                        placeholder="사업명"
                        aria-label="프로젝트 이름"
                      />
                      <Button
                        size="xs"
                        variant="ghost"
                        aria-label={`${p.name || "프로젝트"} 삭제`}
                        onClick={() => patchDraft((d) => d.projects.splice(i, 1))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <Input
                      className="h-7"
                      value={p.path}
                      onChange={(e) => patchDraft((d) => (d.projects[i].path = e.target.value))}
                      placeholder="프로젝트 경로"
                      aria-label="프로젝트 경로"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        className="h-7"
                        value={p.workBranch}
                        onChange={(e) => patchDraft((d) => (d.projects[i].workBranch = e.target.value))}
                        placeholder="작업 브랜치"
                        aria-label="작업 브랜치"
                      />
                      <Input
                        className="h-7"
                        value={p.idPrefix}
                        onChange={(e) => patchDraft((d) => (d.projects[i].idPrefix = e.target.value))}
                        placeholder="ID 접두 (예: FDR)"
                        aria-label="ID 접두"
                      />
                      <Input
                        className="h-7"
                        value={p.portableBase}
                        onChange={(e) => patchDraft((d) => (d.projects[i].portableBase = e.target.value))}
                        placeholder="portable 기준 경로"
                        aria-label="portable 기준 경로"
                      />
                      <Input
                        className="h-7"
                        value={p.verify}
                        onChange={(e) => patchDraft((d) => (d.projects[i].verify = e.target.value))}
                        placeholder="검증 명령"
                        aria-label="검증 명령"
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-[13px]">루틴 예약</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {ROUTINES.map((r) => {
                  const s = draft.dashboard.schedules[r.key];
                  return (
                    <div key={r.key} className="flex items-center gap-2">
                      <Switch
                        id={`sched-${r.key}`}
                        checked={s.enabled}
                        onCheckedChange={(on) =>
                          patchDraft((d) => {
                            d.dashboard.schedules[r.key].enabled = on;
                          })
                        }
                      />
                      <Label htmlFor={`sched-${r.key}`} className="w-10">
                        {r.label}
                      </Label>
                      <Input
                        className="w-24"
                        value={s.time}
                        onChange={(e) =>
                          patchDraft((d) => {
                            d.dashboard.schedules[r.key].time = e.target.value;
                          })
                        }
                        placeholder="HH:MM"
                        aria-label={`${r.label} 루틴 시각`}
                      />
                    </div>
                  );
                })}
                <p className="text-[11px] text-muted-foreground">
                  시각이 지나도 앱이 꺼져 있었다면 자동 실행하지 않고 홈에 알립니다.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-1">
                <CardTitle className="text-[13px]">실행 옵션</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="claude-bin">claude 실행 파일</Label>
                  <Input
                    id="claude-bin"
                    value={draft.dashboard.claudeBin}
                    onChange={(e) => patchDraft((d) => (d.dashboard.claudeBin = e.target.value))}
                    placeholder="claude"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="excel-dir">엑셀 출력 폴더</Label>
                  <Input
                    id="excel-dir"
                    value={draft.dashboard.excelOutputDir}
                    onChange={(e) => patchDraft((d) => (d.dashboard.excelOutputDir = e.target.value))}
                    placeholder="/path/to/output"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="perm-mode">권한 모드</Label>
                  <Select
                    id="perm-mode"
                    className="w-full"
                    value={draft.dashboard.permissionMode}
                    onChange={(e) =>
                      patchDraft((d) => (d.dashboard.permissionMode = e.target.value as PermissionMode))
                    }
                  >
                    {PERMISSION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                  <p className="text-[11px] text-muted-foreground">
                    무인 루틴·구현 실행에는 권한 우회가 필요합니다. 안전망은 플러그인 승인·범위 게이트와 훅입니다.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="launch-at-login"
                    checked={draft.dashboard.launchAtLogin}
                    onCheckedChange={(on) => void toggleLogin(on)}
                  />
                  <Label htmlFor="launch-at-login">로그인 시 자동 시작</Label>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">진단</CardTitle>
                <Button size="xs" variant="outline" onClick={() => void refreshDiagnostics()}>
                  <RefreshCw /> 다시 검사
                </Button>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {!diag ? (
                  <Empty className="py-4">검사 결과가 없습니다.</Empty>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <span className="w-24 text-xs font-medium">설정 파일</span>
                      <Badge variant={diag.configExists ? "success" : "destructive"}>
                        {diag.configExists ? "정상" : "없음"}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-24 text-xs font-medium">볼트 경로</span>
                      <Badge variant={diag.vaultPathOk ? "success" : "destructive"}>
                        {diag.vaultPathOk ? "정상" : "문제"}
                      </Badge>
                      <span className="truncate text-[11px] text-muted-foreground" title={draft.vaultPath}>
                        {draft.vaultPath}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-24 text-xs font-medium">claude CLI</span>
                      <Badge variant={diag.claudeOk ? "success" : "destructive"}>
                        {diag.claudeOk ? "정상" : "없음"}
                      </Badge>
                      {diag.claudeVersion && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {diag.claudeVersion}
                        </span>
                      )}
                    </div>
                    {diag.projects.map((p) => (
                      <div key={p.name} className="flex items-center gap-2 rounded border px-2 py-1">
                        <span className="w-24 truncate text-xs font-medium" title={p.name}>
                          {p.name}
                        </span>
                        <Badge variant={p.pathOk ? "success" : "destructive"}>경로</Badge>
                        <Badge variant={p.gitOk ? "success" : "destructive"}>git</Badge>
                        <Badge
                          variant={
                            p.branchOk == null ? "secondary" : p.branchOk ? "success" : "warning"
                          }
                        >
                          브랜치
                        </Badge>
                      </div>
                    ))}
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
