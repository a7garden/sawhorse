// 설정 화면의 껍데기. draft 상태와 저장·검증만 여기 있고, 내용은 settings/ 아래
// 섹션 넷이 나눠 그린다. 탭을 옮겨도 draft 는 유지되고 저장은 항상 설정 전체 기준이다.
//
// 예약 카드(ExecutionSection 안)만 예외로 draft 를 타지 않는다 — 예약은 자기 API 로
// 즉시 커밋된다. 자세한 이유는 settings/ScheduleCard.tsx.
import { useEffect, useMemo, useState } from "react";
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

type SectionId = "general" | "projects" | "collaboration" | "execution" | "diagnostics";

const SECTIONS: { value: SectionId; label: string }[] = [
  { value: "general", label: "일반" },
  { value: "projects", label: "프로젝트" },
  { value: "collaboration", label: "협업" },
  { value: "execution", label: "실행" },
  { value: "diagnostics", label: "진단" },
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
  if (d.dashboard.claudeBin.trim().length === 0) return "claude 실행 파일을 입력하세요.";
  return null;
}

export default function SettingsPage() {
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
        claudeBin: draft.dashboard.claudeBin,
        permissionMode: draft.dashboard.permissionMode,
        launchAtLogin: draft.dashboard.launchAtLogin,
        herdr: draft.dashboard.herdr,
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
      <PageHeader title="설정" desc="볼트·프로젝트·예약과 실행 옵션을 관리합니다.">
        <Button size="sm" variant="ghost" onClick={openWizard}>
          마법사
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
        <>
          <div className="sticky top-[58px] z-10 border-b bg-background/90 px-4 py-2 backdrop-blur-xl lg:px-5">
            <Tabs tabs={SECTIONS} value={section} onChange={setSection} />
          </div>

          {section === "general" && (
            <GeneralSection draft={draft} patchDraft={patchDraft} onLaunchAtLogin={toggleLogin} />
          )}
          {section === "projects" && <ProjectsSection draft={draft} patchDraft={patchDraft} />}
          {section === "collaboration" && <CollaborationSection draft={draft} patchDraft={patchDraft} />}
          {section === "execution" && <ExecutionSection draft={draft} patchDraft={patchDraft} />}
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
