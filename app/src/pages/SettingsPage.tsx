// 설정 화면의 껍데기. draft 상태와 저장·검증만 여기 있고, 내용은 settings/ 아래
// 섹션 넷이 나눠 그린다. 탭을 옮겨도 draft 는 유지되고 저장은 항상 설정 전체 기준이다.
//
// 예약 카드(ExecutionSection 안)만 예외로 draft 를 타지 않는다 — 예약은 자기 API 로
// 즉시 커밋된다. 자세한 이유는 settings/ScheduleCard.tsx.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import CollaborationSection from "./settings/CollaborationSection";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import ExecutionSection from "./settings/ExecutionSection";
import GeneralSection from "./settings/GeneralSection";
import ProjectsSection from "./settings/ProjectsSection";
import { Empty, PageHeader } from "./common";

type SectionId =
  "general" | "projects" | "collaboration" | "execution" | "diagnostics";

const SECTION_IDS: SectionId[] = [
  "general",
  "projects",
  "collaboration",
  "execution",
  "diagnostics",
];

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
        <Button
          size="sm"
          variant="outline"
          onClick={() => useApp.getState().setPage("schemas")}
        >
          {t("page.schemas")}
        </Button>
      </PageHeader>

      {msg && (
        <div
          className={`px-4 pt-2 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}
        >
          {msg.text}
        </div>
      )}

      {!draft ? (
        <Empty>{t("page.loading")}</Empty>
      ) : (
        <>
          <div className="sticky top-[58px] z-10 border-b bg-background/90 px-4 py-2 backdrop-blur-xl lg:px-5">
            <Tabs tabs={tabs} value={section} onChange={setSection} />
          </div>

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
        </>
      )}
    </div>
  );
}
