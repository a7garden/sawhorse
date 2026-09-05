import { useEffect, useState } from "react";
import { FolderOpen, Plus, Sparkles, SquareTerminal, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ProjectCfg, VaultCandidate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

const STEPS = ["볼트", "사업(선택)", "시작"];

function emptyProject(): ProjectCfg {
  return { name: "", path: "", workBranch: "", portableBase: "", idPrefix: "", verify: "" };
}

export default function SetupWizard() {
  const open = useApp((s) => s.wizardOpen);
  const close = useApp((s) => s.closeWizard);
  const setPage = useApp((s) => s.setPage);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);
  const refreshImprovements = useApp((s) => s.refreshImprovements);
  const refreshTree = useApp((s) => s.refreshTree);
  const refreshJobs = useApp((s) => s.refreshJobs);

  const [step, setStep] = useState(0);
  const [vaultPath, setVaultPath] = useState("");
  const [candidates, setCandidates] = useState<VaultCandidate[] | null>(null);
  const [projects, setProjects] = useState<ProjectCfg[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setErr(null);
    api
      .listObsidianVaults()
      .then(setCandidates)
      .catch(() => setCandidates([]));
  }, [open]);

  if (!open) return null;

  function patchProject(i: number, key: keyof ProjectCfg, value: string) {
    setProjects((ps) => ps.map((p, j) => (j === i ? { ...p, [key]: value } : p)));
  }

  async function save() {
    if (vaultPath.trim().length === 0) {
      setErr("볼트 경로를 입력하세요.");
      return;
    }
    const named = projects.filter((p) => p.name.trim().length > 0);
    if (named.some((p) => p.path.trim().length === 0 || p.workBranch.trim().length === 0)) {
      setErr("등록한 사업의 경로와 작업 브랜치는 필수입니다.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api.saveConfig({
        vaultPath: vaultPath.trim(),
        projects: named,
        defaultProject: named.length === 1 ? named[0].name.trim() : "",
      });
      await Promise.all([
        refreshConfig(),
        refreshDiagnostics(),
        refreshImprovements(),
        refreshTree(),
      ]);
      setStep(2);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function runSkill(kind: "initVault" | "setup") {
    try {
      await api.enqueueJob({ kind });
      await refreshJobs();
      setPage("jobs");
      close();
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border bg-card shadow-lg">
        <div className="border-b px-5 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles className="size-4" /> sawhorse 시작 마법사
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
                    i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                  }`}
                >
                  {i + 1}
                </span>
                <span className={`text-[11px] ${i === step ? "font-semibold" : "text-muted-foreground"}`}>
                  {label}
                </span>
                {i < STEPS.length - 1 && <span className="mx-0.5 h-px w-4 bg-border" />}
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto p-5">
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Obsidian 볼트 경로를 지정합니다. 업무일지·이슈·마일스톤·위키가 이 볼트에 저장됩니다.
                Obsidian에서 쓰던 볼트가 있으면 그 경로를 그대로 쓰면 됩니다.
              </p>
              <div>
                <Label>볼트 절대 경로</Label>
                <Input
                  autoFocus
                  placeholder="예: /Users/won/Documents/WorkVault"
                  value={vaultPath}
                  onChange={(e) => setVaultPath(e.target.value)}
                  className="mt-1"
                />
              </div>
              {candidates != null && candidates.length > 0 && (
                <div className="space-y-1">
                  <Label>Obsidian에서 쓰던 볼트</Label>
                  {candidates.map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      onClick={() => setVaultPath(c.path)}
                      className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
                        vaultPath === c.path ? "border-primary" : "border-input"
                      }`}
                    >
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{c.path}</span>
                      {c.open && <Badge variant="success">열림</Badge>}
                    </button>
                  ))}
                </div>
              )}
              {candidates != null && candidates.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Obsidian 볼트 기록을 찾지 못했습니다. 직접 입력해도 됩니다.
                </p>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                코드형 이슈를 실행할 사업이 있으면 등록하세요. 문서·조사·협의 이슈는 이 설정 없이도
                볼트에서 관리할 수 있습니다. 작업 브랜치는 남의 변경이 섞이지 않은 지점에서 미리 만들어 둔
                코드 이슈 전용 브랜치입니다.
              </p>
              {projects.map((p, i) => (
                <div key={i} className="space-y-1.5 rounded-lg border p-3">
                  <div className="flex items-center justify-between">
                    <Label>사업 {i + 1}</Label>
                    <Button size="icon" variant="ghost" aria-label="삭제" onClick={() => setProjects((ps) => ps.filter((_, j) => j !== i))}>
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Input placeholder="사업명 (예: FDR)" value={p.name} onChange={(e) => patchProject(i, "name", e.target.value)} />
                    <Input placeholder="ID 접두어 (예: FDR)" value={p.idPrefix} onChange={(e) => patchProject(i, "idPrefix", e.target.value)} />
                    <Input placeholder="코드베이스 절대 경로" value={p.path} onChange={(e) => patchProject(i, "path", e.target.value)} />
                    <Input placeholder="작업 브랜치 (예: improve/fdr)" value={p.workBranch} onChange={(e) => patchProject(i, "workBranch", e.target.value)} />
                  </div>
                </div>
              ))}
              <Button size="sm" variant="outline" onClick={() => setProjects((ps) => [...ps, emptyProject()])}>
                <Plus /> 사업 추가
              </Button>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                설정을 저장했습니다. 이어서 플러그인 스킬을 백그라운드로 돌릴 수 있습니다 —
                진행은 작업 탭에서 실시간으로 보입니다.
              </p>
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void runSkill("initVault")}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">볼트 초기화 (init-vault)</span>
                    <span className="block text-[11px] text-muted-foreground">
                      일지·사업·개념 구조와 템플릿·대시보드 노트를 만듭니다. 기존 파일은 건드리지 않습니다.
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => void runSkill("setup")}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">환경 진단 (setup)</span>
                    <span className="block text-[11px] text-muted-foreground">
                      vault·Node·pandoc·훅·MCP 설정을 점검하고 결과를 보고합니다.
                    </span>
                  </span>
                </button>
              </div>
            </div>
          )}

          {err && <p className="mt-3 text-xs text-destructive">{err}</p>}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <Button size="sm" variant="ghost" onClick={close}>
            나중에
          </Button>
          <div className="flex items-center gap-2">
            {step > 0 && step < 2 && (
              <Button size="sm" variant="outline" onClick={() => setStep(step - 1)}>
                이전
              </Button>
            )}
            {step === 0 && (
              <Button size="sm" disabled={vaultPath.trim().length === 0} onClick={() => setStep(1)}>
                다음
              </Button>
            )}
            {step === 1 && (
              <Button size="sm" disabled={saving} onClick={() => void save()}>
                {saving ? "저장 중…" : "저장하고 마침"}
              </Button>
            )}
            {step === 2 && (
              <Button size="sm" variant="success" onClick={close}>
                대시보드 시작
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
