// 첫 실행 마법사 — 대시보드 우선 온보딩.
//
// 예전에는 플러그인을 먼저 깔고 스킬로 볼트를 만든 다음 앱을 열었다. 이제 순서가 뒤집혔다:
// 앱이 작업공간을 만들고, 확장을 고르고, **에이전트에 스킬을 설치해 준다.**
import { useEffect, useState } from "react";
import { Check, FolderOpen, Sparkles, SquareTerminal } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { icon as packIcon } from "@/lib/icons";
import type { AgentPresence, PackInfo, VaultCandidate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const STEPS = ["시작", "작업공간", "확장", "에이전트", "완료"];

export default function SetupWizard() {
  const open = useApp((s) => s.wizardOpen);
  const close = useApp((s) => s.closeWizard);
  const setPage = useApp((s) => s.setPage);
  const packs = useApp((s) => s.packs);
  const agents = useApp((s) => s.agents);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshPacks = useApp((s) => s.refreshPacks);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);
  const refreshTree = useApp((s) => s.refreshTree);
  const refreshJobs = useApp((s) => s.refreshJobs);

  const [step, setStep] = useState(0);
  const [vaultPath, setVaultPath] = useState("");
  const [candidates, setCandidates] = useState<VaultCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [plan, setPlan] = useState<string[]>([]);
  const [created, setCreated] = useState<string[] | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setErr(null);
    setCreated(null);
    setInstalled({});
    api.listObsidianVaults().then(setCandidates).catch(() => setCandidates([]));
    void refreshAgents();
  }, [open, refreshAgents]);

  useEffect(() => {
    if (!packs) return;
    setChosen(Object.fromEntries(packs.packs.map((p) => [p.id, p.enabled])));
  }, [packs]);

  if (!open) return null;

  const list: PackInfo[] = packs?.packs ?? [];
  const enabledIds = list.filter((p) => chosen[p.id]).map((p) => p.id);

  async function saveVault() {
    const path = vaultPath.trim();
    if (path.length === 0) {
      setErr("작업공간 경로를 입력하세요.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.saveConfig({ vaultPath: path });
      await refreshConfig();
      setPlan(await api.workspacePlan().catch(() => []));
      setStep(2);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyPacks() {
    setBusy(true);
    setErr(null);
    try {
      for (const p of list) {
        const want = !!chosen[p.id];
        if (want !== p.enabled) await api.setPackEnabled(p.id, want);
      }
      await Promise.all([refreshPacks(), refreshConfig(), refreshSchedules()]);
      const report = await api.provisionWorkspace();
      setCreated(report.created);
      if (report.failed.length > 0) setErr(`일부 항목 실패: ${report.failed.join("; ")}`);
      await refreshTree();
      setStep(3);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function installAll(agent: AgentPresence) {
    setBusy(true);
    setErr(null);
    try {
      let ok = 0;
      let failed = 0;
      for (const id of enabledIds) {
        const r = await api.installPackSkills(id, agent.id, false);
        ok += r.installed.length;
        failed += r.failed.length;
      }
      setInstalled({
        ...installed,
        [agent.id]: failed > 0 ? `${ok}건 설치, ${failed}건 실패` : `${ok}건 설치`,
      });
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
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
            <Sparkles className="size-4" /> sawhorse 워크벤치 시작
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
                    i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <span className={cn("text-[11px]", i === step ? "font-semibold" : "text-muted-foreground")}>
                  {label}
                </span>
                {i < STEPS.length - 1 && <span className="mx-0.5 h-px w-3 bg-border" />}
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto p-5">
          {step === 0 && (
            <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                <b className="text-foreground">이 앱이 주인입니다.</b> 에이전트(Claude Code·Codex)와
                herdr 터미널은 이 앱이 감지해서 필요한 것을 설치해 줍니다. 따로 플러그인을 먼저
                깔 필요가 없습니다.
              </p>
              <div className="space-y-1.5">
                {[
                  ["작업공간", "노트가 쌓일 폴더 하나. Obsidian 볼트를 그대로 써도 됩니다."],
                  ["확장", "일하는 방식 한 벌. 켜면 화면·예약·스킬이 함께 따라옵니다."],
                  ["에이전트", "확장의 스킬을 에이전트에 설치합니다. 이 단계가 예전의 플러그인 설치입니다."],
                ].map(([t, d]) => (
                  <div key={t} className="rounded-lg border px-3 py-2">
                    <div className="text-[13px] font-semibold text-foreground">{t}</div>
                    <div className="text-[11px]">{d}</div>
                  </div>
                ))}
              </div>
              <p>세 가지를 차례로 정하면 끝입니다. 나중에 확장 탭에서 언제든 바꿀 수 있습니다.</p>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                노트가 쌓일 폴더의 절대 경로입니다. 없는 폴더를 적으면 앱이 만듭니다.
                Obsidian 을 쓰고 있으면 그 볼트를 그대로 지정하세요.
              </p>
              <div>
                <Label>작업공간 절대 경로</Label>
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
                  <Label>Obsidian 에서 쓰던 볼트</Label>
                  {candidates.map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      onClick={() => setVaultPath(c.path)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        vaultPath === c.path ? "border-primary" : "border-input",
                      )}
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
                  Obsidian 볼트 기록을 찾지 못했습니다. 직접 입력하면 됩니다.
                </p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                켠 확장이 곧 이 앱의 기능입니다. 끄면 그 확장의 화면·예약·액션이 사라집니다
                (노트는 그대로 남습니다).
              </p>
              {list.length === 0 && (
                <p className="text-xs text-destructive">설치된 확장을 찾지 못했습니다.</p>
              )}
              {list.map((p) => {
                const Icon = packIcon(p.icon);
                return (
                  <div key={p.id} className="flex items-start gap-3 rounded-lg border p-3">
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold">{p.name}</div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">{p.description}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {p.views.map((v) => (
                          <Badge key={v.id} variant="outline">
                            {v.label}
                          </Badge>
                        ))}
                      </div>
                    </div>
                    <Switch
                      checked={!!chosen[p.id]}
                      onCheckedChange={(on) => setChosen({ ...chosen, [p.id]: on })}
                    />
                  </div>
                );
              })}
              {plan.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  작업공간에 새로 만들 것 {plan.length}개: {plan.slice(0, 6).join(", ")}
                  {plan.length > 6 && " …"}
                </p>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                켠 확장({enabledIds.length}개)의 스킬을 에이전트에 설치합니다. 이미 있는 파일을
                손으로 고쳤다면 덮지 않고 남겨 둡니다.
              </p>
              {agents.map((a) => (
                <div key={a.id} className="flex items-center gap-3 rounded-lg border p-3">
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      a.detected ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold">
                      {a.name}
                      {a.version && (
                        <span className="ml-2 text-[11px] font-normal text-muted-foreground">{a.version}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {a.detected ? a.note : "감지되지 않았습니다 — 설치 후 다시 열면 잡힙니다."}
                    </p>
                  </div>
                  {a.installable ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void installAll(a)}>
                      {installed[a.id] ? <Check className="size-3" /> : null}
                      {installed[a.id] ?? "설치"}
                    </Button>
                  ) : (
                    <Badge variant="outline">실행 기반</Badge>
                  )}
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                지금 건너뛰어도 됩니다 — 확장 탭에서 언제든 설치할 수 있습니다.
              </p>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                준비가 끝났습니다.
                {created && created.length > 0
                  ? ` 작업공간에 ${created.length}개 항목을 만들었습니다.`
                  : " 작업공간은 이미 갖춰져 있었습니다."}
              </p>
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void runSkill("initVault")}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">Obsidian 설정 맞추기 (init-vault)</span>
                    <span className="block text-[11px] text-muted-foreground">
                      템플릿 폴더·첨부 경로·프로퍼티 타입·시작 화면을 에이전트가 점검합니다.
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
                      Node·pandoc·훅·MCP 설정을 점검하고 결과를 보고합니다.
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
            {step > 0 && step < 4 && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setStep(step - 1)}>
                이전
              </Button>
            )}
            {step === 0 && (
              <Button size="sm" onClick={() => setStep(1)}>
                시작하기
              </Button>
            )}
            {step === 1 && (
              <Button size="sm" disabled={busy || vaultPath.trim().length === 0} onClick={() => void saveVault()}>
                {busy ? "저장 중…" : "다음"}
              </Button>
            )}
            {step === 2 && (
              <Button size="sm" disabled={busy} onClick={() => void applyPacks()}>
                {busy ? "적용 중…" : "적용하고 다음"}
              </Button>
            )}
            {step === 3 && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  void refreshDiagnostics();
                  setStep(4);
                }}
              >
                다음
              </Button>
            )}
            {step === 4 && (
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
