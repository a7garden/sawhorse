// 설정 화면의 공통 조각. 섹션 머리(제목+설명 — 섹션 정체를 말하는 유일한 지점),
// 섹션 안의 평면 그룹(예전 카드에서 테두리를 벗긴 것), 라벨 왼쪽·컨트롤 오른쪽 설정 행,
// 저장 결과 배너. 다섯 섹션이 같은 어휘로 그리도록 여기서만 모양을 정의한다.
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** 섹션 머리(단일 스크롤 설정의 앵커 제목). 레일 내비가 가리키는 대상이며, 섹션
 *  안의 그룹과 행은 섹션 제목을 다시 반복하지 않는다. */
export function SectionHeader({
  title,
  desc,
}: {
  title: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <div>
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {desc != null && (
        <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
          {desc}
        </p>
      )}
    </div>
  );
}

/** 섹션 안의 묶음. 카드 테두리를 벗긴 평면 그룹 — 제목 행 + 내용. 제목 없는 묶음
 *  (섹션 바로 아래 첫 묶음)은 title 을 비운다. 부모가 space-y 로 묶음 사이를 벌린다. */
export function SettingsGroup({
  title,
  desc,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {(title != null || actions != null) && (
        <div className="mb-1.5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            {title != null && (
              <h3 className="text-[13px] font-medium leading-6">{title}</h3>
            )}
            {desc != null && (
              <p className="text-xs leading-snug text-muted-foreground">
                {desc}
              </p>
            )}
          </div>
          {actions != null && (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** 설정 행 한 줄. 기본은 라벨 왼쪽·컨트롤 오른쪽이고, 넓은 컨트롤(경로 입력, 긴
 *  선택지)은 stacked 로 라벨 위·컨트롤 아래로 쌓는다. 부모는 divide-y 로 줄을 나눈다. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  control,
  stacked = false,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  control: ReactNode;
  stacked?: boolean;
}) {
  const head = (
    <span className="min-w-0">
      <label htmlFor={htmlFor} className="block text-[13px] leading-snug">
        {label}
      </label>
      {hint != null && (
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {hint}
        </span>
      )}
    </span>
  );
  if (stacked) {
    return (
      <div className="py-3 first:pt-0 last:pb-0">
        {head}
        <div className="mt-2">{control}</div>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      {head}
      <div className="shrink-0">{control}</div>
    </div>
  );
}

/** 저장·검사 결과 배너. 성공은 옅은 초록 판, 실패는 옅은 빨간 판에 아이콘을 얹는다. */
export function Notice({ ok, text }: { ok: boolean; text: string }) {
  const Icon = ok ? CheckCircle2 : AlertCircle;
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-snug",
        ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
