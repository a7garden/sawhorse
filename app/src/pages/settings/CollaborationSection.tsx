// CollaborationSection — 설정 > 협업 탭. 승인 정책 선택, 등록 프로젝트의 통합
// 대상 표시, 검증 프로필 편집, legacy 프로젝트 등록을 맡는다. 정책은 다른 draft
// 값과 달리 즉시 커밋한다 — 활성 세션은 시작 때 찍은 snapshot을 따르므로 안전.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type {
  CollabProjectsView,
  CollabVerifyCheck,
  ConfigView,
  LocalIntegrationApproval,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Empty } from "../common";

const APPROVAL_OPTIONS: { value: LocalIntegrationApproval; label: string }[] = [
  { value: "required", label: "필수 — 후보마다 사람이 승인" },
  { value: "autoAfterPreflight", label: "사전검사 통과 시 자동 허가" },
];

interface CheckDraft {
  kind: "command" | "http";
  cwd: string;
  argv: string; // 쉼표 구분 입력
  url: string;
}

function emptyCheck(kind: "command" | "http"): CheckDraft {
  return { kind, cwd: "", argv: "", url: "" };
}

function draftToCheck(d: CheckDraft): CollabVerifyCheck | null {
  if (d.kind === "http") {
    return d.url.trim() ? { kind: "http", url: d.url.trim() } : null;
  }
  const argv = d.argv.split(",").map((s) => s.trim()).filter(Boolean);
  if (argv.length === 0) return null;
  return { kind: "command", cwd: d.cwd.trim(), argv };
}

function checkToDraft(c: CollabVerifyCheck): CheckDraft {
  if (c.kind === "http") return { kind: "http", cwd: "", argv: "", url: c.url };
  return { kind: "command", cwd: c.cwd, argv: c.argv.join(", "), url: "" };
}

export default function CollaborationSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const [projects, setProjects] = useState<CollabProjectsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 검증 프로필 폼
  const [profileProject, setProfileProject] = useState("");
  const [profileName, setProfileName] = useState("");
  const [checks, setChecks] = useState<CheckDraft[]>([]);
  const [manual, setManual] = useState<string[]>([]);

  const reload = useCallback(() => {
    void api
      .collabProjectsView()
      .then(setProjects)
      .catch(() => setProjects(null));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function setApproval(v: LocalIntegrationApproval) {
    patchDraft((d) => {
      d.dashboard.collaboration.localIntegrationApproval = v;
    });
    try {
      await api.saveConfig({
        dashboard: { collaboration: { localIntegrationApproval: v } },
      });
      setMsg({ ok: true, text: "승인 정책을 저장했습니다." });
    } catch (e) {
      setMsg({ ok: false, text: `승인 정책 저장 실패: ${String(e)}` });
    }
  }

  async function saveProfile() {
    if (!profileProject) {
      setMsg({ ok: false, text: "프로젝트를 선택하세요." });
      return;
    }
    if (profileName.trim().length === 0) {
      setMsg({ ok: false, text: "프로필 이름을 입력하세요." });
      return;
    }
    const built = checks.map(draftToCheck).filter((c): c is CollabVerifyCheck => c != null);
    const manualList = manual.map((m) => m.trim()).filter(Boolean);
    setBusy(true);
    setMsg(null);
    try {
      await api.collabSaveVerifyProfile(profileProject, profileName.trim(), {
        checks: built,
        manual: manualList,
      });
      setMsg({ ok: true, text: `검증 프로필 "${profileName.trim()}"을 저장했습니다.` });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: `검증 프로필 저장 실패: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function register(name: string, path: string, branch: string, verifyProfile: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api.collabRegisterProject(name, path, branch, verifyProfile);
      setMsg({ ok: true, text: `"${name}" 프로젝트를 등록했습니다.` });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: `프로젝트 등록 실패: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const registeredPaths = new Set((projects?.registered ?? []).map((r) => r.path));

  return (
    <div className="space-y-4 p-4">
      {msg && (
        <div className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</div>
      )}

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">승인 정책</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select
            value={draft.dashboard.collaboration.localIntegrationApproval}
            onChange={(e) => void setApproval(e.target.value as LocalIntegrationApproval)}
            aria-label="로컬 통합 승인 정책"
          >
            {APPROVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            새 세션의 초기값으로만 쓰입니다. 이미 시작한 세션은 시작 때의 정책 스냅샷을 따릅니다.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">등록 프로젝트</CardTitle>
          {(projects?.registered.length ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground">{projects?.registered.length}개</span>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {projects && projects.registered.length === 0 && (
            <Empty className="py-3">등록된 협업 프로젝트가 없습니다.</Empty>
          )}
          {(projects?.registered ?? []).map((p) => (
            <div key={p.id} className="space-y-0.5 rounded-lg border p-2.5 text-xs">
              <div className="font-medium">{p.name}</div>
              <div className="text-muted-foreground">경로: {p.path}</div>
              <div className="text-muted-foreground">
                통합: {p.integration.path || p.path} · {p.integration.branch || "기본 브랜치"} · 프로필:{" "}
                {p.integration.verifyProfile || "기본"}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">검증 프로필</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>프로젝트</Label>
              <Select
                className="w-full"
                value={profileProject}
                onChange={(e) => setProfileProject(e.target.value)}
              >
                <option value="">선택…</option>
                {(projects?.registered ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label>프로필 이름</Label>
              <Input
                className="w-full"
                value={profileName}
                onChange={(e) => {
                  const name = e.target.value;
                  setProfileName(name);
                  const existing = profileProject
                    ? draft.coreProjects[profileProject]?.verifyProfiles[name]
                    : undefined;
                  if (existing) {
                    setChecks(existing.checks.map(checkToDraft));
                    setManual([...existing.manual]);
                  }
                }}
                placeholder="예: 기본"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>자동 검사</Label>
              <div className="flex gap-1">
                <Button size="xs" variant="outline" onClick={() => setChecks((cs) => [...cs, emptyCheck("command")])}>
                  <Plus /> 명령
                </Button>
                <Button size="xs" variant="outline" onClick={() => setChecks((cs) => [...cs, emptyCheck("http")])}>
                  <Plus /> HTTP
                </Button>
              </div>
            </div>
            {checks.length === 0 && <Empty className="py-2">자동 검사가 없습니다.</Empty>}
            {checks.map((c, i) => (
              <div key={i} className="space-y-1 rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Select
                    value={c.kind}
                    onChange={(e) =>
                      setChecks((cs) =>
                        cs.map((x, j) => (j === i ? { ...x, kind: e.target.value as "command" | "http" } : x)),
                      )
                    }
                    aria-label={`검사 ${i + 1} 종류`}
                  >
                    <option value="command">명령</option>
                    <option value="http">HTTP</option>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`검사 ${i + 1} 삭제`}
                    onClick={() => setChecks((cs) => cs.filter((_, j) => j !== i))}
                  >
                    <Trash2 />
                  </Button>
                </div>
                {c.kind === "command" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      className="h-7"
                      value={c.cwd}
                      onChange={(e) => setChecks((cs) => cs.map((x, j) => (j === i ? { ...x, cwd: e.target.value } : x)))}
                      placeholder="작업 디렉터리 (비면 저장소 루트)"
                      aria-label={`검사 ${i + 1} 작업 디렉터리`}
                    />
                    <Input
                      className="h-7"
                      value={c.argv}
                      onChange={(e) => setChecks((cs) => cs.map((x, j) => (j === i ? { ...x, argv: e.target.value } : x)))}
                      placeholder="명령 (쉼표 구분, 예: npm, run, build)"
                      aria-label={`검사 ${i + 1} 명령`}
                    />
                  </div>
                ) : (
                  <Input
                    className="h-7"
                    value={c.url}
                    onChange={(e) => setChecks((cs) => cs.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                    placeholder="http://localhost:5173"
                    aria-label={`검사 ${i + 1} URL`}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>수동 확인 항목</Label>
              <Button size="xs" variant="outline" onClick={() => setManual((ms) => [...ms, ""])}>
                <Plus /> 항목 추가
              </Button>
            </div>
            {manual.length === 0 && <Empty className="py-2">수동 확인이 없으면 자동 검사 통과 뒤 곧바로 검증 완료가 됩니다.</Empty>}
            {manual.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Textarea
                  className="min-h-[36px] flex-1"
                  rows={1}
                  value={m}
                  onChange={(e) => setManual((ms) => ms.map((x, j) => (j === i ? e.target.value : x)))}
                  placeholder="예: 개발 서버에서 홈 화면이 그려지는지 확인"
                  aria-label={`수동 확인 ${i + 1}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`수동 확인 ${i + 1} 삭제`}
                  onClick={() => setManual((ms) => ms.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button size="sm" disabled={busy} onClick={() => void saveProfile()}>
              프로필 저장
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">프로젝트 등록 (기존 목록)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {projects && projects.legacy.length === 0 && (
            <Empty className="py-3">기존 프로젝트 목록이 없습니다. 설정 &gt; 프로젝트에서 추가하세요.</Empty>
          )}
          {(projects?.legacy ?? []).map((p) => (
            <div key={p.name} className="flex items-center gap-2 rounded-lg border p-2.5 text-xs">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="text-muted-foreground">
                  {p.path} · {p.workBranch || "기본 브랜치"} · 검증: {p.verify || "없음"}
                </div>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || registeredPaths.has(p.path)}
                onClick={() => void register(p.name, p.path, p.workBranch, p.verify)}
              >
                등록
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
