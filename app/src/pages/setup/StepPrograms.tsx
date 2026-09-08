// 마법사 「기본 환경」 단계 — 모든 워크플로에 공통인 선택 연동만 확인한다.
//
// Node.js, pandoc, Git 같은 기능별 도구는 여기에 넣지 않는다. 워크플로 정의가 소유하고
// 실행 직전에 검사해야, 시작 마법사가 특정 회사의 산출물 방식에 종속되지 않는다.
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import type { RequirementStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import DetectRow, { InstallButton, NeedBadge } from "./DetectRow";

export function programSummary(rows: RequirementStatus[]): string {
  if (rows.length === 0) return i18n.t("packs:programs.summary.checking");
  const missing = rows.filter((r) => !r.detected);
  const outdated = rows.filter((r) => r.detected && r.outdated);
  if (missing.length === 0 && outdated.length === 0)
    return i18n.t("packs:programs.summary.allReady", { n: rows.length });
  const parts: string[] = [];
  if (missing.length > 0)
    parts.push(
      i18n.t("packs:programs.summary.missing", { n: missing.length }),
    );
  if (outdated.length > 0)
    parts.push(
      i18n.t("packs:programs.summary.outdated", { n: outdated.length }),
    );
  return parts.join(" · ");
}

export default function StepPrograms({
  rows,
  busy,
  onRefresh,
}: {
  rows: RequirementStatus[];
  busy: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation("packs");
  const blocking = rows.filter((r) => r.need === "required" && !r.detected);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("programs.introA")}{" "}
          <b className="text-foreground">{t("programs.installLabel")}</b>
          {t("programs.introB")}{" "}
          <b className="text-foreground">{t("programs.recheckLabel")}</b>
          {t("programs.introC")}
        </p>
        <Button size="xs" variant="outline" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={busy ? "animate-spin" : undefined} />{" "}
          {t("programs.recheck")}
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {programSummary(rows)}
      </p>

      {rows.map((r) => (
        <DetectRow
          key={r.id}
          name={r.name}
          ok={r.detected}
          warn={r.outdated}
          badge={
            <>
              <NeedBadge need={r.need} missing={!r.detected} />
              {r.outdated && (
                <Badge variant="warning">
                  {t("programs.minVersion", { version: r.minMajor })}
                </Badge>
              )}
            </>
          }
          version={r.version}
          detail={r.why}
          path={r.detected ? r.path : undefined}
          hint={!r.detected ? r.installHint || undefined : undefined}
          action={
            r.detected && !r.outdated ? undefined : (
              <InstallButton
                url={r.installUrl}
                label={r.outdated ? t("programs.get") : t("actions.install")}
              />
            )
          }
        />
      ))}

      {blocking.length > 0 && (
        <p className="text-[11px] text-warning-foreground">
          {t("programs.blocking", {
            list: blocking.map((r) => r.name).join(", "),
          })}
        </p>
      )}
    </div>
  );
}
