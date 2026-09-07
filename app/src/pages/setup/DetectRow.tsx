// 마법사의 「프로그램」과 「에이전트」 단계가 같은 줄 모양을 쓴다. 두 화면이 같은 질문
// ("이게 이 PC에 있나, 없으면 어디서 받나")에 답하므로 눈이 익숙해지는 편이 낫다.
import type { ReactNode } from "react";
import { Check, ExternalLink, X } from "lucide-react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Need } from "@/lib/types";

function StatusDot({ ok, warn }: { ok: boolean; warn?: boolean }) {
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full text-white",
        ok ? (warn ? "bg-warning" : "bg-success") : "bg-muted-foreground/40",
      )}
    >
      {ok ? <Check className="size-2.5" /> : <X className="size-2.5" />}
    </span>
  );
}

/** https 링크를 기본 브라우저로 연다. 링크를 모르는 항목은 버튼 자체를 내지 않는다 —
 *  엉뚱한 곳으로 보내느니 아무 데도 보내지 않는 편이 낫다. */
export function InstallButton({
  url,
  label,
}: {
  url: string;
  label?: string;
}) {
  const { t } = useTranslation("packs");
  if (!url) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      onClick={() => void api.openExternal(url).catch(() => {})}
    >
      {label ?? t("actions.install")} <ExternalLink className="size-3" />
    </Button>
  );
}


/** 없을 때만 시급함을 색으로 말한다. 갖춰져 있으면 분류 표시로만 남는다. */
export function NeedBadge({ need, missing }: { need: Need; missing: boolean }) {
  const { t } = useTranslation("packs");
  const variant = !missing
    ? "outline"
    : need === "required"
      ? "destructive"
      : need === "recommended"
        ? "warning"
        : "outline";
  return <Badge variant={variant}>{t(`programs.need.${need}`)}</Badge>;
}

export default function DetectRow({
  name,
  ok,
  warn,
  badge,
  version,
  detail,
  path,
  hint,
  action,
  selectable,
  selected,
  onSelect,
}: {
  name: string;
  ok: boolean;
  /** 있긴 한데 문제가 있다 (버전이 낮다 등) */
  warn?: boolean;
  badge?: ReactNode;
  version?: string;
  detail?: string;
  path?: string;
  hint?: string;
  action?: ReactNode;
  /** 켜면 줄의 본문이 라디오처럼 눌린다 (기본 에이전트 고르기) */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const main = (
    <>
      <StatusDot ok={ok} warn={warn} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold">{name}</span>
          {badge}
          {version && (
            <span className="truncate text-[11px] text-muted-foreground">
              {version}
            </span>
          )}
        </div>
        {detail && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {detail}
          </p>
        )}
        {path && (
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
            title={path}
          >
            {path}
          </p>
        )}
        {hint && (
          <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </>
  );

  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border p-2.5 transition-colors",
        selectable &&
          (selected ? "border-primary bg-accent/40" : "hover:bg-accent/30"),
      )}
    >
      {selectable ? (
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
        >
          {main}
        </button>
      ) : (
        main
      )}
      {action && (
        <div className="flex shrink-0 items-center gap-1.5 pl-1">{action}</div>
      )}
    </div>
  );
}
