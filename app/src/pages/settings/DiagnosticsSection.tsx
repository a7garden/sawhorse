import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentPresence,
  Diagnostics,
  RequirementStatus,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Empty } from "../common";
import { SettingsGroup, SettingRow } from "./parts";
import DetectRow, { InstallButton, NeedBadge } from "../setup/DetectRow";

export default function DiagnosticsSection({
  diag,
  vaultPath,
  requirements,
  agents,
  defaultAgent,
  onRefresh,
  onSetDefaultAgent,
}: {
  diag: Diagnostics | null;
  vaultPath: string;
  requirements: RequirementStatus[];
  agents: AgentPresence[];
  defaultAgent: string;
  onRefresh: () => void;
  onSetDefaultAgent: (id: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-6">
      <SettingsGroup
        title={t("diag.title")}
        desc={t("diag.desc")}
        actions={
          <Button size="sm" variant="outline" onClick={onRefresh}>
            <RefreshCw /> {t("actions.rescan")}
          </Button>
        }
      >
        <div className="space-y-1.5">
          {!diag ? (
            <Empty className="py-4">{t("diag.noResults")}</Empty>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">{t("diag.configFile")}</span>
                <Badge variant={diag.configExists ? "success" : "destructive"}>
                  {diag.configExists ? t("status.ok") : t("status.missing")}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">{t("fields.vaultPath")}</span>
                <Badge variant={diag.vaultPathOk ? "success" : "destructive"}>
                  {diag.vaultPathOk ? t("status.ok") : t("status.problem")}
                </Badge>
                <span
                  className="truncate text-[11px] text-muted-foreground"
                  title={vaultPath}
                >
                  {vaultPath}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">{t("diag.claudeCli")}</span>
                <Badge variant={diag.claudeOk ? "success" : "destructive"}>
                  {diag.claudeOk ? t("status.ok") : t("status.missing")}
                </Badge>
                {diag.claudeVersion && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {diag.claudeVersion}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">herdr</span>
                {/* 서버 상태는 모드와 무관하게 늘 답해야 한다 — 백그라운드로 돌더라도
                    「herdr로 보기」가 서버를 쓰므로 "사용 안 함"은 사실이 아니다. */}
                <Badge
                  variant={
                    diag.herdr.serverOk
                      ? "success"
                      : diag.herdr.mode === "herdr"
                        ? "warning"
                        : "secondary"
                  }
                >
                  {diag.herdr.serverOk
                    ? t("diag.serverConnected")
                    : diag.herdr.binOk
                      ? t("diag.noServer")
                      : t("diag.notInstalled")}
                </Badge>
                <Badge variant={diag.herdr.viewerOk ? "success" : "secondary"}>
                  {diag.herdr.viewerOk ? t("diag.viewerOk") : t("diag.viewerOff")}
                </Badge>
                <span className="truncate text-[11px] text-muted-foreground">
                  {t(
                    "diag.nextJob",
                    {
                      runner:
                        diag.herdr.effectiveRunner === "herdr"
                          ? t("diag.runnerHerdr")
                          : t("labels.jobRunner.headless"),
                    },
                  )}
                  {diag.herdr.version ? ` · ${diag.herdr.version}` : ""}
                </span>
                {/* herdr 모드를 골랐는데 herdr를 못 쓰는 건 고장이다. 기본 headless일 때의
                    같은 자리 문구는 그냥 왜 그런지 설명하는 한 줄이라 라벨을 붙이지 않는다. */}
                {diag.herdr.reason && (
                  <span className="text-[11px] text-muted-foreground">
                    {diag.herdr.mode === "herdr"
                      ? t("diag.herdrBlocked", { reason: diag.herdr.reason })
                      : diag.herdr.reason}
                  </span>
                )}
              </div>
              {diag.projects.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 py-1"
                >
                  <span
                    className="w-24 truncate text-xs font-medium"
                    title={p.name}
                  >
                    {p.name}
                  </span>
                  <Badge variant={p.pathOk ? "success" : "destructive"}>
                    {t("diag.badgePath")}
                  </Badge>
                  <Badge variant={p.gitOk ? "success" : "destructive"}>
                    git
                  </Badge>
                  <Badge
                    variant={
                      p.branchOk == null
                        ? "secondary"
                        : p.branchOk
                          ? "success"
                          : "warning"
                    }
                  >
                    {t("diag.badgeBranch")}
                  </Badge>
                </div>
              ))}
            </>
          )}
        </div>
      </SettingsGroup>

      {/* 마법사의 「기본 환경」 단계와 같은 공통 연동 목록. 첫 설치 뒤에 도구를 깔았을 때 마법사를
          다시 열지 않고 여기서 확인·설치할 수 있어야 한다. */}
      <SettingsGroup title={t("diag.requirementsTitle")}
      desc={t("diag.requirementsDesc")}>
        <div className="space-y-1.5">
          {requirements.length === 0 ? (
            <Empty className="py-4">{t("diag.noResults")}</Empty>
          ) : (
            requirements.map((r) => (
              <DetectRow
                key={r.id}
                name={r.name}
                ok={r.detected}
                warn={r.outdated}
                badge={<NeedBadge need={r.need} missing={!r.detected} />}
                version={r.version}
                detail={r.why}
                path={r.detected ? r.path : undefined}
                hint={!r.detected ? r.installHint || undefined : undefined}
                action={
                  r.detected && !r.outdated ? undefined : (
                    <InstallButton url={r.installUrl} />
                  )
                }
              />
            ))
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title={t("diag.agentsTitle")}
      desc={t("diag.agentsDesc")}>
        <div className="space-y-1.5">
          {/* 마법사 「에이전트」 단계와 같은 선택. 감지된 Herdr 호환 에이전트만
              실행 기본값으로 고를 수 있다. */}
          <SettingRow
            label={t("diag.defaultAgent")}
            htmlFor="default-agent"
            hint={t("diag.defaultAgentHint")}
            control={
              <Select
                id="default-agent"
                className="w-44"
                value={defaultAgent}
                onChange={onSetDefaultAgent}
                options={agents
                  .filter((a) => a.detected && a.runsJobs)
                  .map((a) => ({ value: a.id, label: a.name }))}
              />
            }
          />
          {agents.filter((a) => a.detected).length === 0 ? (
            <Empty className="py-4">{t("diag.noAgents")}</Empty>
          ) : (
            agents
              .filter((a) => a.detected)
              .map((a) => (
                <DetectRow
                  key={a.id}
                  name={a.name}
                  ok
                  badge={
                    <>
                      {a.id === defaultAgent && (
                        <Badge variant="success">{t("diag.badgeDefault")}</Badge>
                      )}
                      {a.installable && (
                        <Badge variant="outline">
                          {t("diag.badgeSkillInstallable")}
                        </Badge>
                      )}
                      {a.runsJobs && (
                        <Badge variant="outline">{t("diag.badgeRunsJobs")}</Badge>
                      )}
                    </>
                  }
                  version={a.version}
                  path={a.path}
                />
              ))
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}
