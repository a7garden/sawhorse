// Shared building blocks for the six pages. Page-local concerns stay in each page file.
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { preprocessObsidianMd } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type { Job, JobStatus, ProgressEntry } from "@/lib/types";

// ---------- text / time formatting ----------

export function fmtClock(ms?: number): string {
  if (!ms) return "-";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDur(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}시간 ${m % 60}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}

// ---------- labels / badges ----------

export const WARN_TEXT = "text-[oklch(0.55_0.14_70)]";
export type BadgeVariant = "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

export const JOB_STATUS_KO: Record<JobStatus, string> = {
  queued: "대기",
  running: "실행중",
  success: "완료",
  failed: "실패",
  cancelled: "취소",
  interrupted: "중단",
};

export const JOB_KIND_KO: Record<Job["kind"], string> = {
  design: "설계",
  implement: "구현",
  routine: "루틴",
  excel: "엑셀",
  initVault: "init-vault",
  setup: "setup",
};

export function jobBadgeVariant(s: JobStatus): BadgeVariant {
  switch (s) {
    case "queued":
      return "secondary";
    case "running":
      return "default";
    case "success":
      return "success";
    case "failed":
      return "destructive";
    default:
      return "outline"; // cancelled / interrupted
  }
}

// Improvement note vocabulary (templates/개선.md): status/priority frontmatter values.
export const NOTE_STATUSES = [
  "제안",
  "승인대기",
  "승인",
  "구현중",
  "부분구현",
  "구현완료",
  "보류",
  "반려",
] as const;

export function statusBadgeVariant(status: string): BadgeVariant {
  switch (status) {
    case "제안":
      return "outline";
    case "승인대기":
      return "warning";
    case "승인":
      return "success";
    case "구현중":
    case "부분구현":
      return "default";
    case "구현완료":
      return "success";
    case "보류":
      return "secondary";
    case "반려":
      return "destructive";
    default:
      return "secondary";
  }
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusBadgeVariant(status)}>{status || "-"}</Badge>;
}

export function PriorityBadge({ p }: { p: string }) {
  const variant =
    p === "최우선" ? "destructive" : p === "중요" ? "warning" : p === "보통" ? "secondary" : "outline";
  return <Badge variant={variant}>{p || "-"}</Badge>;
}

// ---------- progress entries ----------

export function entryText(e: ProgressEntry): string {
  if (e.kind === "result") return e.summary ?? e.text ?? (e.isError ? "비정상 종료" : "완료");
  return e.text ?? e.summary ?? (e.tool ? `도구: ${e.tool}` : e.kind);
}

// ---------- layout primitives ----------

export function PageHeader({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
      <div className="mr-auto">
        <h1 className="text-sm font-bold leading-tight">{title}</h1>
        {desc && <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("py-8 text-center text-xs text-muted-foreground", className)}>{children}</div>
  );
}

// Re-renders once per `ms` while `active` — drives elapsed-time displays.
export function useTicker(active: boolean, ms = 1000): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}

// ---------- markdown ----------

const MD_CLASSES = [
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-bold",
  "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-sm [&_h2]:font-bold",
  "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-[13px] [&_h3]:font-semibold",
  "[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-xs [&_h4]:font-semibold",
  "[&_p]:my-1.5",
  "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-0.5",
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[12px]",
  "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-2.5 [&_pre]:text-[12px]",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs",
  "[&_th]:border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium",
  "[&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
  "[&_hr]:my-3 [&_hr]:border-border",
  "[&_a]:text-primary [&_a]:underline",
].join(" ");

export function MarkdownView({ src, className }: { src: string; className?: string }) {
  return (
    <div className={cn("text-[13px] leading-relaxed [&>*:first-child]:mt-0", MD_CLASSES, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{preprocessObsidianMd(src)}</ReactMarkdown>
    </div>
  );
}
