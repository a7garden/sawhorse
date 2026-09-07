// 설정 화면의 껍데기. 왼쪽 섹션 레일(좁은 화면에서는 탭)로 다섯 섹션을 고르고,
// 오른쪽 내용은 settings/ 아래 섹션 컴포넌트가 그린다. 탭을 옮겨도 draft 는
// 유지되고 저장은 항상 설정 전체 기준이다.
//
// 예약 카드(자동화 페이지)와 협업 승인 정책만 예외로 draft 를 타지 않는다 —
// 두 값은 자기 API 로 즉시 커밋된다. 이유는 settings/ScheduleCard.tsx 와
// settings/CollaborationSection.tsx.
import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
  Activity,
  FolderGit2,
  Play,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Notice } from "./settings/parts";
import CollaborationSection from "./settings/CollaborationSection";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import ExecutionSection from "./settings/ExecutionSection";
import GeneralSection from "./settings/GeneralSection";
import ProjectsSection from "./settings/ProjectsSection";
import { PageHeader } from "./common";

type SectionId =
  "general" | "projects" | "collaboration" | "execution" | "diagnostics";

const SECTION_IDS: SectionId[] = [
  "general",
  "projects",
  "collaboration",
  "execution",
  "diagnostics",
];

const SECTION_ICONS: Record<SectionId, ComponentType<{ className?: string }>> = {
  general: SlidersHorizontal,
  projects: FolderGit2,
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

  const [section, setSection] = useState<SectionId>("general");
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
      !diag.claudeOk ||
      diag.projects.some((p) => !p.pathOk || !p.gitOk));

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
          {/* 섹션 레일. 어디에 무엇이 있는지 한눈에 보이게 아이콘과 한 줄 설명을
              곁들이고, 진단에 문항이 있으면 점을 찍어 눈길을 끈다. */}
          <nav
            aria-label={t("page.title")}
            className="sticky top-[58px] hidden max-h-[calc(100dvh-58px)] w-56 shrink-0 flex-col gap-0.5 self-start overflow-y-auto border-r p-3 md:flex"
          >
            {SECTION_IDS.map((id) => {
              const Icon = SECTION_ICONS[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id ? "page" : undefined}
                  onClick={() => setSection(id)}
                  className={cn(
                    "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                    section === id
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
            {/* 좁은 화면에서는 레일 대신 탭 한 줄. */}
            <div className="border-b px-4 py-2 md:hidden">
              <Tabs tabs={tabs} value={section} onChange={setSection} />
            </div>
            <div className="mx-auto w-full max-w-3xl p-4 lg:p-5">
              {section === "general" && (
                <GeneralSection
                  draft={draft}
                  patchDraft={patchDraft}
                  onLaunchAtLogin={toggleLogin}
                />
              )}
              {section === "projects" && (
                <ProjectsSection draft={draft} patchDraft={patchDraft} />
              )}
              {section === "collaboration" && (
                <CollaborationSection draft={draft} patchDraft={patchDraft} />
              )}
              {section === "execution" && (
                <ExecutionSection draft={draft} patchDraft={patchDraft} />
              )}
              {section === "diagnostics" && (
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
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
