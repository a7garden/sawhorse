// 같은 작업을 두 번 시키지 않는 실행 버튼.
//
// 이 버튼이 만드는 잡이 이미 대기·실행 중이면 누를 수 있는 것은 "중단"뿐이다. 판정은
// 호스트가 붙인 중복 키(Job.dedupKey)로 하므로, 다른 화면에서 눌렀든 예약이 돌렸든
// 같은 작업이면 여기서도 실행 중으로 보인다.
import { useState, type ReactNode } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import { activeJob } from "@/lib/jobs";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RunButton({
  jobKey,
  label,
  ariaLabel,
  onRun,
  onError,
  disabled,
  title,
  variant = "outline",
  size = "sm",
  className,
  icon,
}: {
  jobKey: string;
  label: string;
  /** 아이콘만 있는 버튼(label 이 빈 문자열)에 이름을 준다. */
  ariaLabel?: string;
  onRun: () => Promise<unknown> | unknown;
  onError?: (message: string) => void;
  disabled?: boolean;
  title?: string;
  variant?: "default" | "secondary" | "outline" | "ghost";
  size?: "default" | "sm" | "xs";
  className?: string;
  icon?: ReactNode;
}) {
  const jobs = useApp((s) => s.jobs);
  const job = activeJob(jobs, jobKey);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const [busy, setBusy] = useState(false);

  async function click() {
    setBusy(true);
    try {
      if (job) await api.cancelJob(job.id);
      else await onRun();
      await refreshJobs();
    } catch (cause) {
      onError?.(String(cause));
    } finally {
      setBusy(false);
    }
  }

  const running = job?.status === "running";
  return (
    <Button
      size={size}
      variant={job ? "secondary" : variant}
      disabled={busy || (!job && disabled)}
      aria-label={ariaLabel || label || undefined}
      title={job ? "실행 중입니다. 누르면 중단합니다." : title}
      className={cn(className)}
      onClick={(event) => {
        event.stopPropagation();
        void click();
      }}
    >
      {busy ? (
        <Loader2 className="animate-spin" />
      ) : job ? (
        <Square />
      ) : (
        (icon ?? <Play />)
      )}
      {job ? (running ? "실행 중 · 중단" : "대기 중 · 취소") : label}
    </Button>
  );
}
