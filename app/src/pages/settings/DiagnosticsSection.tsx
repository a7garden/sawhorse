import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  AgentPresence,
  Diagnostics,
  RequirementStatus,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "../common";
import DetectRow, { InstallButton, NeedBadge } from "../setup/DetectRow";

export default function DiagnosticsSection({
  diag,
  vaultPath,
  requirements,
  agents,
  defaultAgent,
  onRefresh,
}: {
  diag: Diagnostics | null;
  vaultPath: string;
  requirements: RequirementStatus[];
  agents: AgentPresence[];
  defaultAgent: string;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">{t("diag.title")}</CardTitle>
          <Button size="xs" variant="outline" onClick={onRefresh}>
            <RefreshCw /> {t("actions.rescan")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-1.5">
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
                <Badge
                  variant={
                    diag.herdr.mode === "headless"
                      ? "secondary"
                      : diag.herdr.serverOk
                        ? "success"
                        : "warning"
                  }
                >
                  {diag.herdr.mode === "headless"
                    ? t("diag.herdrDisabled")
                    : diag.herdr.serverOk
                      ? t("diag.serverConnected")
                      : diag.herdr.binOk
                        ? t("diag.noServer")
                        : t("diag.notInstalled")}
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
                  {diag.herdr.reason && (
                    <span className="text-[11px] text-muted-foreground">
                      {t("diag.runnerFallback", { reason: diag.herdr.reason })}
                    </span>
                  )}
              </div>
              {diag.projects.map((p) => (
                <div
                  key={p.name}
                  className="flex items-center gap-2 rounded border px-2 py-1"
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
        </CardContent>
      </Card>

      {/* 마법사의 「프로그램」 단계와 같은 목록. 첫 설치 뒤에 도구를 깔았을 때 마법사를
          다시 열지 않고 여기서 확인·설치할 수 있어야 한다. */}
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">{t("diag.requirementsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">{t("diag.agentsTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
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
          <p className="text-[11px] text-muted-foreground">
            {t("diag.defaultAgentHint")}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
