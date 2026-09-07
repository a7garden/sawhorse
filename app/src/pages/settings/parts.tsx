import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** 카테고리 패널의 제목과 설명. */
export function SectionHeader({
  id,
  title,
  desc,
}: {
  id?: string;
  title: ReactNode;
  desc?: ReactNode;
}) {
  return (
    <div className="settings-section-heading">
      <h2 id={id} className="text-2xl font-semibold tracking-tight">{title}</h2>
      {desc != null && (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {desc}
        </p>
      )}
    </div>
  );
}

/** 제목·설명·액션과 입력 행을 묶는 설정 카드. */
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
    <section className={cn("settings-group", className)}>
      {(title != null || actions != null) && (
        <div className="settings-group-heading">
          <div className="min-w-0">
            {title != null && (
              <h3 className="text-sm font-semibold leading-6">{title}</h3>
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
      <div className="settings-group-body">{children}</div>
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
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {hint}
        </span>
      )}
    </span>
  );
  if (stacked) {
    return (
      <div className="setting-row setting-row-stacked">
        {head}
        <div className="mt-2">{control}</div>
      </div>
    );
  }
  return (
    <div className="setting-row">
      {head}
      <div className="setting-control">{control}</div>
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
