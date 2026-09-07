import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
  Activity,
  AppWindow,
  ArrowUpRight,
  Check,
  Circle,
  Settings2,
  Play,
  Users,
  Vault,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Notice, SectionHeader } from "./settings/parts";
import AppSection from "./settings/AppSection";
import CollaborationSection from "./settings/CollaborationSection";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import ExecutionSection from "./settings/ExecutionSection";
import VaultSection from "./settings/VaultSection";
import "./settings/settings.css";

type SectionId =
  | "app"
  | "vault"
  | "execution"
  | "collaboration"
  | "diagnostics";

const SECTION_IDS: SectionId[] = [
  "app",
  "vault",
  "execution",
  "collaboration",
  "diagnostics",
];

const SECTION_ICONS: Record<SectionId, ComponentType<{ className?: string }>> = {
  app: AppWindow,
  vault: Vault,
  collaboration: Users,
  execution: Play,
  diagnostics: Activity,
};

function validate(d: ConfigView): string | null {
  if (d.vaultPath.trim().length === 0) return i18n.t("settings:validate.vaultPathRequired");
  const names = new Set<string>();
  for (const p of d.projects) {
    if (p.name.trim().length === 0)
      return i18n.t("settings:validate.projectNameEmpty");
    if (names.has(p.name))
      return i18n.t("settings:validate.projectNameDuplicate", { name: p.name });
    names.add(p.name);
    if (p.path.trim().length === 0)
      return i18n.t("settings:validate.projectPathEmpty", { name: p.name });
  }
  if (d.defaultProject.length > 0 && !names.has(d.defaultProject))
    return i18n.t("settings:validate.defaultProjectMissing");
  if (d.dashboard.claudeBin.trim().length === 0)
    return i18n.t("settings:validate.claudeBinRequired");
  return null;
}

export default function SettingsPage() {
  const { t } = useTranslation("settings");
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);
  const requirements = useApp((s) => s.requirements);
  const agents = useApp((s) => s.agents);
  const defaultAgent = useApp((s) => s.defaultAgent);
  const refreshRequirements = useApp((s) => s.refreshRequirements);
  const refreshAgents = useApp((s) => s.refreshAgents);
  const openWizard = useApp((s) => s.openWizard);

  const [draft, setDraft] = useState<ConfigView | null>(
    config ? structuredClone(config) : null,
  );
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(config ? structuredClone(config) : null);
  }, [config]);

  const dirty = useMemo(
    () =>
      config != null &&
      draft != null &&
      JSON.stringify(draft) !== JSON.stringify(config),
    [config, draft],
  );

  // 성공 배너는 스스로 사라진다. 실패는 사용자가 다음 동작을 결정할 때까지 남는다.
  useEffect(() => {
    if (!msg?.ok) return;
    const id = window.setTimeout(() => setMsg(null), 3000);
    return () => window.clearTimeout(id);
  }, [msg]);

  // 진단에 문제가 있으면 레일의 진단 항목에 점을 찍어 어디를 봐야 하는지 가리킨다.
  const diagProblem =
    diag != null &&
    (!diag.configExists ||
      !diag.vaultPathOk ||
      diag.projects.some((p) => !p.pathOk || !p.gitOk));

  const contentRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<SectionId>("app");
  const changedSections = useMemo(() => {
    if (!config || !draft) return new Set<SectionId>();
    const changed = new Set<SectionId>();
    if (config.dashboard.launchAtLogin !== draft.dashboard.launchAtLogin) changed.add("app");
    if (config.vaultPath !== draft.vaultPath || config.defaultProject !== draft.defaultProject ||
        JSON.stringify(config.projects) !== JSON.stringify(draft.projects)) changed.add("vault");
    if (config.dashboard.claudeBin !== draft.dashboard.claudeBin ||
        config.dashboard.permissionMode !== draft.dashboard.permissionMode ||
        JSON.stringify(config.dashboard.herdr) !== JSON.stringify(draft.dashboard.herdr)) changed.add("execution");
    return changed;
  }, [config, draft]);

  function selectSection(id: SectionId) {
    setActive(id);
    // The app scrolls inside main; reset only that container when changing category.
    let node = contentRef.current?.parentElement;
    while (node) {
      if (["auto", "scroll"].includes(getComputedStyle(node).overflowY)) {
        node.scrollTo({ top: 0 });
        break;
      }
      node = node.parentElement;
    }
  }

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
      selectSection(draft.vaultPath.trim() && problem === i18n.t("settings:validate.claudeBinRequired") ? "execution" : "vault");
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
        claudeBin: draft.dashboard.claudeBin,
        permissionMode: draft.dashboard.permissionMode,
        launchAtLogin: draft.dashboard.launchAtLogin,
        herdr: draft.dashboard.herdr,
      };
      await api.saveConfig(patch);
      await refreshConfig();
      await refreshDiagnostics();
      setMsg({ ok: true, text: t("page.saved") });
    } catch (e) {
      setMsg({ ok: false, text: t("page.saveFailed", { error: String(e) }) });
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
      setMsg({ ok: false, text: t("page.autoStartFailed", { error: String(e) }) });
    }
  }

  async function setDefaultAgent(id: string) {
    try {
      await api.setDefaultAgent(id);
      await refreshAgents();
    } catch (e) {
      setMsg({
        ok: false,
        text: t("diag.defaultAgentFailed", { error: String(e) }),
      });
    }
  }

  return (
    <div className="settings-page" ref={contentRef}>
      <header className="settings-topbar">
        <div className="settings-title">
          <Settings2 aria-hidden className="size-4 text-muted-foreground" />
          <h1>{t("page.title")}</h1>
          <span className="settings-scope">{t("page.scope")}</span>
        </div>
        <div className="settings-save-actions">
          <span className={cn("settings-save-state", dirty && "is-dirty")} role="status">
            {dirty ? <Circle aria-hidden className="size-2 fill-current" /> : <Check aria-hidden className="size-3.5" />}
            {dirty ? t("page.unsaved") : t("page.upToDate")}
          </span>
          <Button variant="ghost" disabled={!dirty || saving} onClick={() => {
            setDraft(config ? structuredClone(config) : null);
            setMsg(null);
          }}>{t("page.revert")}</Button>
          <Button disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      </header>
      {!draft ? (
        <div className="max-w-3xl space-y-4 p-6" aria-busy="true">
          <span className="sr-only">{t("page.loading")}</span>
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
        </div>
      ) : (
        <div className="settings-layout">
          <div className="settings-rail">
            <nav aria-label={t("page.title")} className="settings-nav">
              <p className="settings-nav-caption">{t("page.preferences")}</p>
              {SECTION_IDS.map((id) => {
                const Icon = SECTION_ICONS[id];
                return (
                  <button key={id} type="button" aria-label={t(`sections.${id}`)}
                    aria-current={active === id ? "page" : undefined}
                    aria-controls={`settings-${id}`} onClick={() => selectSection(id)}
                    className={cn("settings-nav-item", active === id && "is-active")}>
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="settings-nav-label">{t(`sections.${id}`)}</span>
                      <span className="settings-nav-description" aria-hidden>{t(`navDesc.${id}`)}</span>
                    </span>
                    {changedSections.has(id) && <span className="settings-change-dot" title={t("page.unsaved")} />}
                    {id === "diagnostics" && diagProblem && <span className="size-1.5 rounded-full bg-warning" title={t("status.problem")} />}
                  </button>
                );
              })}
              <div className="settings-setup">
                <p>{t("page.setupTitle")}</p>
                <span>{t("page.setupHint")}</span>
                <button type="button" onClick={openWizard}>
                  {t("page.wizard")} <ArrowUpRight aria-hidden className="size-3.5" />
                </button>
              </div>
            </nav>
          </div>
          <div className="settings-content">
            {msg && <div className="mb-5"><Notice ok={msg.ok} text={msg.text} /></div>}
            {/* Keep panels mounted so unsaved project and verification forms survive navigation. */}
            {SECTION_IDS.map((id) => (
              <section key={id} id={`settings-${id}`} hidden={active !== id}
                aria-labelledby={`settings-${id}-title`}>
                <SectionHeader id={`settings-${id}-title`} title={t(`sections.${id}`)} desc={t(`sectionsDesc.${id}`)} />
                {id === "app" && <AppSection draft={draft} onLaunchAtLogin={toggleLogin} />}
                {id === "vault" && <VaultSection draft={draft} patchDraft={patchDraft} />}
                {id === "execution" && <ExecutionSection draft={draft} patchDraft={patchDraft} />}
                {id === "collaboration" && <CollaborationSection draft={draft} patchDraft={patchDraft} />}
                {id === "diagnostics" && <DiagnosticsSection
                  diag={diag} requirements={requirements} agents={agents} defaultAgent={defaultAgent}
                  vaultPath={draft.vaultPath} onRefresh={() => {
                    void refreshDiagnostics(); void refreshRequirements(); void refreshAgents();
                  }} onSetDefaultAgent={(v) => void setDefaultAgent(v)} />}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
