// 마법사 「프로그램」 단계 — 제품이 실제로 부르는 외부 프로그램이 이 PC에 있는지.
//
// 각 줄이 "왜 필요한가"를 달고 있어야 사용자가 설치 여부를 스스로 정한다. 없는 것을
// 못 넘어가게 막지는 않는다 — 필수 항목이 빠져도 나머지 설정은 지금 끝내는 편이 낫고,
// 설정 → 진단에서 같은 목록을 언제든 다시 본다.
import { RefreshCw } from "lucide-react";
import type { RequirementStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import DetectRow, { InstallButton, NeedBadge } from "./DetectRow";

export function programSummary(rows: RequirementStatus[]): string {
  if (rows.length === 0) return "검사 중…";
  const missing = rows.filter((r) => !r.detected);
  const outdated = rows.filter((r) => r.detected && r.outdated);
  if (missing.length === 0 && outdated.length === 0)
    return `${rows.length}개 모두 준비됐습니다.`;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`없음 ${missing.length}개`);
  if (outdated.length > 0) parts.push(`버전 낮음 ${outdated.length}개`);
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
  const blocking = rows.filter((r) => r.need === "required" && !r.detected);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          이 PC에서 찾은 것만 표시합니다. 없는 항목의{" "}
          <b className="text-foreground">설치</b> 를 누르면 받는 곳이 브라우저로
          열립니다. 설치한 뒤 <b className="text-foreground">다시 검사</b>.
        </p>
        <Button size="xs" variant="outline" disabled={busy} onClick={onRefresh}>
          <RefreshCw className={busy ? "animate-spin" : undefined} /> 다시 검사
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
                <Badge variant="warning">{r.minMajor} 이상 필요</Badge>
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
                label={r.outdated ? "받기" : "설치"}
              />
            )
          }
        />
      ))}

      {blocking.length > 0 && (
        <p className="text-[11px] text-warning-foreground">
          필수 항목이 빠져 있습니다 ({blocking.map((r) => r.name).join(", ")}).
          지금은 그냥 넘어가도 되고, 설치한 뒤 설정 → 진단에서 다시 검사하면
          됩니다.
        </p>
      )}
    </div>
  );
}
