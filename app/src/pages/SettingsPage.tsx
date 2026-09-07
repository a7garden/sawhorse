// 설정 화면의 껍데기. 탭을 나누지 않고 다섯 섹션을 한 페이지에 쌓는다 — 저장은
// 항상 설정 전체 기준인데 탭을 옮겨 다니면 저장하지 않은 변경이 안 보이는 곳에
// 남으므로, 모든 변경이 한 화면에 보이는 쪽이 저장 모델과 어울린다. 왼쪽 레일이
// 섹션으로 스크롤해 보내고, 반대로 스크롤 위치도 따라와 현재 섹션을 밝힌다.
//
// 예약 카드(자동화 페이지)와 협업 승인 정책만 예외로 draft 를 타지 않는다 —
// 두 값은 자기 API 로 즉시 커밋된다. 이유는 settings/ScheduleCard.tsx 와
// settings/CollaborationSection.tsx.
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
  Activity,
  AppWindow,
  Play,
  Users,
  Vault,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Notice, SectionHeader } from "./settings/parts";
import AppSection from "./settings/AppSection";
import CollaborationSection from "./settings/CollaborationSection";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import ExecutionSection from "./settings/ExecutionSection";
import VaultSection from "./settings/VaultSection";
import { PageHeader } from "./common";

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
  const tabs = SECTION_IDS.map((value) => ({
    value,
    label: t(`sections.${value}`),
  }));
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

  // 스크롤 스파이. 스크롤은 창이 아니라 앱 레이아웃의 내부 컨테이너에서 일어나므로
  // 그 컨테이너의 scroll 이벤트를 듣고, 헤더(58px) 바로 아래 선을 지난 마지막
  // 섹션을 현재로 삼는다. 컨테이너 끝에 닿으면 마지막 섹션을 강제한다 — 마지막
  // 섹션은 경계선까지 올라오지 않을 수 있기 때문.
  const sectionEls = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});
  const [active, setActive] = useState<SectionId>("app");

  useEffect(() => {
    if (!draft) return;
    const first = sectionEls.current[SECTION_IDS[0]];
    if (!first) return;
    let node: HTMLElement | null = first.parentElement;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      node = node.parentElement;
    }
    const scroller = node;
    if (!scroller) return;
    const last = SECTION_IDS[SECTION_IDS.length - 1];
    const update = () => {
      const line = scroller.getBoundingClientRect().top + 70;
      let current = SECTION_IDS[0];
      for (const id of SECTION_IDS) {
        const el = sectionEls.current[id];
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      const atEnd =
        scroller.scrollTop + scroller.clientHeight >=
        scroller.scrollHeight - 4;
      setActive(atEnd ? last : current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [draft != null]);

  function scrollToSection(id: SectionId) {
    const el = sectionEls.current[id];
    if (!el) return;
    // 스크롤IntoView 대신 컨테이너 좌표로 직접 굴린다 — 창까지 건드리지 않고,
    // 헤더 높이만큼 여백을 둔 위치가 어디서나 같게 잡힌다.
    let node: HTMLElement | null = el.parentElement;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      node = node.parentElement;
    }
    if (!node) return;
    const top =
      node.scrollTop +
      el.getBoundingClientRect().top -
      node.getBoundingClientRect().top -
      70;
    node.scrollTo({ top, behavior: "smooth" });
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
    <div>
      <PageHeader title={t("page.title")}>
        <Button size="sm" variant="ghost" onClick={openWizard}>
          {t("page.wizard")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(config ? structuredClone(config) : null);
            setMsg(null);
          }}
        >
          {t("page.revert")}
        </Button>
        <Button
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? t("actions.saving") : t("actions.save")}
        </Button>
      </PageHeader>

      {msg && (
        <div className="px-4 pt-3 lg:px-5">
          <Notice ok={msg.ok} text={msg.text} />
        </div>
      )}

      {!draft ? (
        <div className="max-w-3xl space-y-4 p-4 lg:p-5" aria-busy="true">
          <span className="sr-only">{t("page.loading")}</span>
          <div className="h-28 animate-pulse rounded-xl border bg-muted/40" />
          <div className="h-40 animate-pulse rounded-xl border bg-muted/40" />
        </div>
      ) : (
        <div className="flex items-start">
          {/* 섹션 레일. 앵커 내비 — 누르면 해당 섹션으로 스크롤하고, 스크롤 위치를
              따라 현재 섹션을 밝힌다. 진단에 문항이 있으면 점을 찍어 눈길을 끈다. */}
          <nav
            aria-label={t("page.title")}
            className="sticky top-[58px] hidden max-h-[calc(100dvh-58px)] w-52 shrink-0 flex-col gap-0.5 self-start overflow-y-auto border-r p-3 md:flex"
          >
            {SECTION_IDS.map((id) => {
              const Icon = SECTION_ICONS[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={active === id ? "location" : undefined}
                  onClick={() => scrollToSection(id)}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    active === id
                      ? "bg-secondary text-secondary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <Icon className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium leading-tight">
                      {t(`sections.${id}`)}
                      {id === "diagnostics" && diagProblem && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-warning"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                      {t(`sectionsDesc.${id}`)}
                    </span>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="min-w-0 flex-1">
            {/* 좁은 화면에서는 레일 대신 칩 한 줄. 누르면 마찬가지로 스크롤한다. */}
            <div className="sticky top-[58px] z-10 border-b bg-background/90 px-4 py-2 backdrop-blur-xl md:hidden">
              <Tabs tabs={tabs} value={active} onChange={scrollToSection} />
            </div>
            <div className="mx-auto w-full max-w-3xl p-4 lg:p-5">
              {SECTION_IDS.map((id) => (
                <section
                  key={id}
                  id={id}
                  ref={(el) => {
                    sectionEls.current[id] = el;
                  }}
                  className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0"
                >
                  <SectionHeader
                    title={t(`sections.${id}`)}
                    desc={t(`sectionsDesc.${id}`)}
                  />
                  {id === "app" && (
                    <AppSection draft={draft} onLaunchAtLogin={toggleLogin} />
                  )}
                  {id === "vault" && (
                    <VaultSection draft={draft} patchDraft={patchDraft} />
                  )}
                  {id === "execution" && (
                    <ExecutionSection draft={draft} patchDraft={patchDraft} />
                  )}
                  {id === "collaboration" && (
                    <CollaborationSection draft={draft} patchDraft={patchDraft} />
                  )}
                  {id === "diagnostics" && (
                    <DiagnosticsSection
                      diag={diag}
                      requirements={requirements}
                      agents={agents}
                      defaultAgent={defaultAgent}
                      vaultPath={draft.vaultPath}
                      onRefresh={() => {
                        void refreshDiagnostics();
                        void refreshRequirements();
                        void refreshAgents();
                      }}
                      onSetDefaultAgent={(v) => void setDefaultAgent(v)}
                    />
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
