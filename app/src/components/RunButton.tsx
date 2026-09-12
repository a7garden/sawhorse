// Run button that never asks for the same task twice.
//
// If a job this button creates is already queued or running, the only thing you
// can press is "stop". The check uses the host-assigned dedup key
// (Job.dedupKey), so whether it was pressed on another screen or triggered by a
// schedule, the same task shows as running here too.
import { useState, type ReactNode } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import { activeJob } from "@/lib/jobs";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

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
  /** Names the icon-only button (when label is an empty string). */
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
  const { t } = useTranslation("common");

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
      title={job ? t("toolbar.stopHint") : title}
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
      {job ? (running ? t("toolbar.runningStop") : t("toolbar.pendingCancel")) : label}
    </Button>
  );
}
