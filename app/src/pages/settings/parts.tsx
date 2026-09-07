// 설정 화면의 공통 조각. 섹션 카드 머리(제목+설명), 라벨 왼쪽·컨트롤 오른쪽 설정 행,
// 저장 결과 배너. 다섯 섹션이 같은 어휘로 그리도록 여기서만 모양을 정의한다.
import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** 설정 카드. 제목과 한 줄 설명을 머리에 두고, actions 에 카드 단위 버튼을 받는다. */
export function SectionCard({
  title,
  desc,
  actions,
  children,
  className,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0 pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-[13px]">{title}</CardTitle>
          {desc && <CardDescription>{desc}</CardDescription>}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 설정 행 한 줄. 기본은 라벨 왼쪽·컨트롤 오른쪽이고, 넓은 컨트롤(경로 입력 등)은
 *  stacked 로 라벨 위·컨트롤 아래로 쌓는다. 부모는 divide-y 로 줄을 나눈다. */
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
    <div className={cn("min-w-0 space-y-0.5", stacked && "space-y-1")}>
      <label
        htmlFor={htmlFor}
        className="block text-[13px] font-medium leading-tight"
      >
        {label}
      </label>
      {hint && (
        <p className="text-xs leading-snug text-muted-foreground">{hint}</p>
      )}
    </div>
  );
  if (stacked) {
    return (
      <div className="space-y-1.5 py-3 first:pt-0 last:pb-0">
        {head}
        {control}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
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
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        ok
          ? "border-success/25 bg-success/10 text-success"
          : "border-destructive/25 bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{text}</span>
    </div>
  );
}
