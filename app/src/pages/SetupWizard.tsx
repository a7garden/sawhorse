import { PathInput } from "@/components/ui/path-input";
// 첫 실행 마법사 — 대시보드 우선 온보딩.
//
// 예전에는 플러그인을 먼저 깔고 스킬로 볼트를 만든 다음 앱을 열었다. 이제 순서가 뒤집혔다:
// 앱이 이 PC를 훑고, 작업공간을 만들고, 확장을 고르고, **에이전트에 스킬을 설치해 준다.**
//
// 앞의 두 단계(기본 환경·에이전트)는 아무것도 바꾸지 않는 읽기 전용 점검이다. 기본
// 환경은 Obsidian·herdr만 다루며 기능별 도구는 선택한 workflow가 별도로 선언한다.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, FolderOpen, Sparkles, SquareTerminal } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { icon as packIcon } from "@/lib/icons";
import type { AgentPresence, PackInfo, VaultCandidate } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import StepAgents from "./setup/StepAgents";
import StepPrograms, { programSummary } from "./setup/StepPrograms";

const STEPS = [
  "intro",
  "programs",
  "agents",
  "vault",
  "packs",
  "skills",
  "done",
] as const;
/// 단계를 숫자로 넘기면 하나를 끼워 넣을 때 이동 코드가 조용히 어긋난다.
const S = {
  intro: 0,
  programs: 1,
  agents: 2,
  vault: 3,
  packs: 4,
  skills: 5,
  done: 6,
} as const;
const LAST = S.done;

/** 상대경로를 받으면 앱이 어디를 기준으로 만들지 사용자와 앱의 생각이 갈린다. */
function isAbsolutePath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
}

export default function SetupWizard() {
  const { t } = useTranslation("packs");
  const open = useApp((s) => s.wizardOpen);
  const close = useApp((s) => s.closeWizard);
  const setPage = useApp((s) => s.setPage);
  const config = useApp((s) => s.config);
  const packs = useApp((s) => s.packs);
  const agents = useApp((s) => s.agents);
  const requirements = useApp((s) => s.requirements);
  const storedDefaultAgent = useApp((s) => s.defaultAgent);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshPacks = useApp((s) => s.refreshPacks);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const refreshRequirements = useApp((s) => s.refreshRequirements);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);
  const refreshTree = useApp((s) => s.refreshTree);
  const refreshJobs = useApp((s) => s.refreshJobs);

  const [step, setStep] = useState(0);
  const [vaultPath, setVaultPath] = useState("");
  const [suggested, setSuggested] = useState("");
  const [candidates, setCandidates] = useState<VaultCandidate[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [plan, setPlan] = useState<string[]>([]);
  const [created, setCreated] = useState<string[] | null>(null);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  // 사용자가 이번 마법사에서 고른 값. 고르기 전에는 null 이고, 그동안은 저장된 값을
  // 그대로 보여 준다 — 감지 결과가 늦게 와도 화면이 예전 값에 붙들리지 않게.
  const [picked, setPicked] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      await Promise.all([refreshAgents(), refreshRequirements()]);
    } finally {
      setScanning(false);
    }
  }, [refreshAgents, refreshRequirements]);

  useEffect(() => {
    if (!open) return;
    setStep(S.intro);
    setErr(null);
    setCreated(null);
    setInstalled({});
    setVaultPath(config?.vaultPath ?? "");
    setPicked(null);
    api
      .listObsidianVaults()
      .then(setCandidates)
      .catch(() => setCandidates([]));
    api
      .suggestVaultPath()
      .then(setSuggested)
      .catch(() => setSuggested(""));
    void scan();
    // 작업공간 경로는 열 때의 설정값을 한 번만 집어넣는다 — 편집 중에 되돌리지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scan]);

  useEffect(() => {
    if (!packs) return;
    setChosen(Object.fromEntries(packs.packs.map((p) => [p.id, p.enabled])));
  }, [packs]);

  // 마법사는 언제든 닫을 수 있어야 한다 — 갇힌 느낌을 주면 대충 눌러 넘긴다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const list: PackInfo[] = packs?.packs ?? [];
  const enabledIds = list.filter((p) => chosen[p.id]).map((p) => p.id);
  const installTargets = agents.filter((a) => a.installable);
  const defaultAgent = picked ?? storedDefaultAgent;
  const pickedAgent = agents.find((a) => a.id === defaultAgent);

  async function pickAgent(id: string) {
    setPicked(id);
    setErr(null);
    try {
      await api.setDefaultAgent(id);
      await refreshConfig();
    } catch (e) {
      setErr(String(e));
    }
  }

  async function saveVault() {
    const path = vaultPath.trim();
    if (path.length === 0) {
      setErr(t("wizard.errPathRequired"));
      return;
    }
    if (!isAbsolutePath(path)) {
      setErr(t("wizard.errAbsolutePath"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.saveConfig({ vaultPath: path });
      await refreshConfig();
      setPlan(await api.workspacePlan().catch(() => []));
      setStep(S.packs);
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
      if (report.failed.length > 0)
        setErr(
          t("wizard.partialFailure", { list: report.failed.join("; ") }),
        );
      await refreshTree();
      setStep(S.skills);
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
        [agent.id]:
          failed > 0
            ? t("wizard.installReport.fail", { n: ok, failed })
            : t("wizard.installReport.ok", { n: ok }),
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
            <Sparkles className="size-4" /> {t("wizard.title")}
          </div>
          <div className="mt-2 flex items-center gap-1">
            {STEPS.map((label, i) => (
              <div key={label} className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={i >= step || busy}
                  onClick={() => setStep(i)}
                  title={t(`steps.${label}`)}
                  className={cn(
                    "inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold transition-colors",
                    i <= step
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                    i < step && !busy && "cursor-pointer hover:bg-primary/80",
                  )}
                >
                  {i + 1}
                </button>
                {i === step && (
                  <span className="text-[11px] font-semibold">
                    {t(`steps.${label}`)}
                  </span>
                )}
                {i < LAST && <span className="mx-0.5 h-px w-2.5 bg-border" />}
              </div>
            ))}
          </div>
        </div>

        <div className="overflow-y-auto p-5">
          {step === S.intro && (
            <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
              <p>
                <b className="text-foreground">{t("wizard.intro.lead")}</b>{" "}
                {t("wizard.intro.rest")}
              </p>
              <div className="space-y-1.5">
                {(
                  [
                    "programs",
                    "agents",
                    "vault",
                    "packs",
                    "skills",
                  ] as const
                ).map((key) => (
                  <div key={key} className="rounded-lg border px-3 py-2">
                    <div className="text-[13px] font-semibold text-foreground">
                      {t(`steps.${key}`)}
                    </div>
                    <div className="text-[11px]">
                      {t(`wizard.intro.${key}`)}
                    </div>
                  </div>
                ))}
              </div>
              <p>
                {t("wizard.intro.outro")}
              </p>
            </div>
          )}

          {step === S.programs && (
            <StepPrograms
              rows={requirements}
              busy={scanning}
              onRefresh={() => void scan()}
            />
          )}

          {step === S.agents && (
            <StepAgents
              agents={agents}
              defaultAgent={defaultAgent}
              busy={scanning}
              onRefresh={() => void scan()}
              onPick={(id) => void pickAgent(id)}
            />
          )}

          {step === S.vault && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("wizard.vault.hint")}
              </p>
              <div>
                <Label>{t("wizard.vault.label")}</Label>
                <PathInput
                  autoFocus
                  placeholder={suggested || t("wizard.vault.placeholder")}
                  value={vaultPath}
                  onValueChange={(value) => setVaultPath(value)}
                  className="mt-1"
                />
              </div>
              {candidates != null && candidates.length > 0 && (
                <div className="space-y-1">
                  <Label>{t("wizard.vault.existing")}</Label>
                  {candidates.map((c) => (
                    <button
                      key={c.path}
                      type="button"
                      onClick={() => setVaultPath(c.path)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        vaultPath === c.path
                          ? "border-primary"
                          : "border-input",
                      )}
                    >
                      <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{c.path}</span>
                      {c.open && (
                        <Badge variant="success">
                          {t("wizard.vault.open")}
                        </Badge>
                      )}
                    </button>
                  ))}
                </div>
              )}
              {candidates != null && candidates.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("wizard.vault.noRecords")}
                </p>
              )}
              {suggested && vaultPath.trim() !== suggested && (
                <button
                  type="button"
                  onClick={() => setVaultPath(suggested)}
                  className="flex w-full items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                >
                  <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">
                    {t("wizard.vault.createNew", { path: suggested })}
                  </span>
                </button>
              )}
            </div>
          )}

          {step === S.packs && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("wizard.packs.hint")}
              </p>
              {list.length === 0 && (
                <p className="text-xs text-destructive">
                  {t("wizard.packs.noneFound")}
                </p>
              )}
              {list.map((p) => {
                const Icon = packIcon(p.icon);
                return (
                  <div
                    key={p.id}
                    className="flex items-start gap-3 rounded-lg border p-3"
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold">{p.name}</div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {p.description}
                      </p>
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
                      onCheckedChange={(on) =>
                        setChosen({ ...chosen, [p.id]: on })
                      }
                    />
                  </div>
                );
              })}
              {plan.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t("wizard.packs.plan", {
                    n: plan.length,
                    items: plan.slice(0, 6).join(", "),
                  })}
                  {plan.length > 6 && " …"}
                </p>
              )}
            </div>
          )}

          {step === S.skills && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("wizard.skills.hint", { n: enabledIds.length })}
              </p>
              {installTargets.length === 0 && (
                <p className="text-xs text-warning-foreground">
                  {t("wizard.skills.noTargets")}
                </p>
              )}
              {installTargets.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      a.detected ? "bg-success" : "bg-muted-foreground/40",
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[13px] font-semibold">
                        {a.name}
                      </span>
                      {a.id === defaultAgent && (
                        <Badge variant="success">{t("defaultBadge")}</Badge>
                      )}
                      {a.version && (
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {a.version}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {a.detected
                        ? a.note
                        : t("wizard.skills.notDetected")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={a.id === defaultAgent ? "default" : "outline"}
                    disabled={busy || enabledIds.length === 0}
                    onClick={() => void installAll(a)}
                  >
                    {installed[a.id] ? <Check className="size-3" /> : null}
                    {installed[a.id] ?? t("actions.install")}
                  </Button>
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                {t("wizard.skills.skipHint")}
              </p>
            </div>
          )}

          {step === LAST && (
            <div className="space-y-3">
              <div className="space-y-1 rounded-lg border p-3 text-[11px] text-muted-foreground">
                <div className="text-[13px] font-semibold text-foreground">
                  {t("wizard.done.summaryTitle")}
                </div>
                <p className="truncate" title={vaultPath}>
                  {t("wizard.done.workspace", {
                    path: vaultPath || t("unset"),
                  })}
                </p>
                <p>
                  {t("wizard.done.agent", {
                    agent: pickedAgent?.name ?? defaultAgent,
                  })}
                </p>
                <p>{t("wizard.done.extensions", { n: enabledIds.length })}</p>
                <p>
                  {t("wizard.done.programs", {
                    summary: programSummary(requirements),
                  })}
                </p>
                <p>
                  {created && created.length > 0
                    ? t("wizard.done.created", { n: created.length })
                    : t("wizard.done.alreadyReady")}
                </p>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("wizard.done.outro")}
              </p>
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => void runSkill("initVault")}
                  className="flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent"
                >
                  <SquareTerminal className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold">
                      {t("wizard.done.initVaultTitle")}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("wizard.done.initVaultDesc")}
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
                    <span className="block text-[13px] font-semibold">
                      {t("wizard.done.setupTitle")}
                    </span>
                    <span className="block text-[11px] text-muted-foreground">
                      {t("wizard.done.setupDesc")}
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
            {t("wizard.later")}
          </Button>
          <div className="flex items-center gap-2">
            {step > S.intro && step < LAST && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setStep(step - 1)}
              >
                {t("wizard.back")}
              </Button>
            )}
            {step < S.vault && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setStep(step + 1)}
              >
                {step === S.intro ? t("wizard.start") : t("wizard.next")}
              </Button>
            )}
            {step === S.vault && (
              <Button
                size="sm"
                disabled={busy || vaultPath.trim().length === 0}
                onClick={() => void saveVault()}
              >
                {busy ? t("wizard.saving") : t("wizard.next")}
              </Button>
            )}
            {step === S.packs && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void applyPacks()}
              >
                {busy ? t("wizard.applying") : t("wizard.applyAndNext")}
              </Button>
            )}
            {step === S.skills && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  void refreshDiagnostics();
                  setStep(LAST);
                }}
              >
                {t("wizard.next")}
              </Button>
            )}
            {step === LAST && (
              <Button size="sm" variant="success" onClick={close}>
                {t("wizard.openDashboard")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
