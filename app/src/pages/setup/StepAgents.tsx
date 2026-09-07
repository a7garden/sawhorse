// 마법사 「에이전트」 단계 — 이 PC의 터미널 에이전트를 훑고 그중 기본을 고른다.
//
// 기본 에이전트가 정하는 것과 정하지 않는 것을 화면이 분명히 말해야 한다. 스킬 설치
// 대상과 안내의 기준은 이 값이 정하지만, **잡 실행기는 아직 Claude Code 하나뿐이다**
// (진행 스트림 파싱이 그 CLI 의 형식에 묶여 있다). 고른 값이 실행기를 바꾼다고 착각하면
// "왜 codex 로 안 돌지" 로 시간을 버린다.
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AgentPresence } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import DetectRow, { InstallButton } from "./DetectRow";

export default function StepAgents({
  agents,
  defaultAgent,
  busy,
  onRefresh,
  onPick,
}: {
  agents: AgentPresence[];
  defaultAgent: string;
  busy: boolean;
  onRefresh: () => void;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation("packs");
  const found = agents.filter((a) => a.detected);
  const missing = agents.filter((a) => !a.detected);
  const picked = agents.find((a) => a.id === defaultAgent);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("agentStep.introA")}{" "}
          <b className="text-foreground">{t("agentStep.introDefault")}</b>
          {t("agentStep.introB")}
        </p>
        <Button size="xs" variant="outline" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />{" "}
          {t("programs.recheck")}
        </Button>
      </div>

      {found.length === 0 && (
        <p className="text-xs text-warning-foreground">
          {t("agentStep.noneFound")}
        </p>
      )}

      {found.map((a) => (
        <DetectRow
          key={a.id}
          name={a.name}
          ok
          selectable
          selected={a.id === defaultAgent}
          onSelect={() => onPick(a.id)}
          badge={
            <>
              {a.id === defaultAgent && (
                <Badge variant="success">{t("defaultBadge")}</Badge>
              )}
              {a.installable && (
                <Badge variant="outline">
                  {t("agentStep.canInstallSkills")}
                </Badge>
              )}
              {a.runsJobs && (
                <Badge variant="outline">{t("agentStep.runsJobs")}</Badge>
              )}
              {a.custom && (
                <Badge variant="secondary">{t("agentStep.custom")}</Badge>
              )}
            </>
          }
          version={a.version}
          detail={a.note}
          path={a.path}
        />
      ))}

      {missing.length > 0 && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer px-2.5 py-2 text-[11px] text-muted-foreground">
            {t("agentStep.missingSummary", { n: missing.length })}
          </summary>
          <div className="space-y-1.5 border-t p-2.5">
            {missing.map((a) => (
              <DetectRow
                key={a.id}
                name={a.name}
                ok={false}
                badge={
                  a.custom ? (
                    <Badge variant="secondary">{t("agentStep.custom")}</Badge>
                  ) : undefined
                }
                detail={a.note}
                hint={a.installHint || undefined}
                action={<InstallButton url={a.installUrl} />}
              />
            ))}
          </div>
        </details>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {picked && !picked.runsJobs ? (
          <>
            <b className="text-foreground">{picked.name}</b>{" "}
            {t("agentStep.jobsFootnote")}
          </>
        ) : (
          <>
            {t("agentStep.customFootnoteA")}{" "}
            <code>dashboard.customAgents</code>{" "}
            {t("agentStep.customFootnoteB")}
          </>
        )}
      </p>
    </div>
  );
}
