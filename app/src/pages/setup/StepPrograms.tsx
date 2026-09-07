// 마법사 「프로그램」 단계 — 제품이 실제로 부르는 외부 프로그램이 이 PC에 있는지.
//
// 각 줄이 "왜 필요한가"를 달고 있어야 사용자가 설치 여부를 스스로 정한다. 없는 것을
// 못 넘어가게 막지는 않는다 — 필수 항목이 빠져도 나머지 설정은 지금 끝내는 편이 낫고,
// 설정 → 진단에서 같은 목록을 언제든 다시 본다.
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
