// Wizard "Agents" step — scans this PC's terminal agents and picks a default among them.
//
// Local agents supported by Herdr are treated under the same run-lifecycle contract. Skill
// installation is per-agent in format, so it may be offered separately for Claude/Codex only.
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
          selectable={a.runsJobs}
          selected={a.id === defaultAgent}
          onSelect={a.runsJobs ? () => onPick(a.id) : undefined}
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
