// Shared building blocks for the six pages. Page-local concerns stay in each page file.
import { useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { preprocessObsidianMd } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import type {
  AgentStatus,
  Job,
  JobRunner,
  JobStatus,
  ProgressEntry,
} from "@/lib/types";

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

export const WARN_TEXT = "text-warning-foreground";
export type BadgeVariant =
  "default" | "secondary" | "outline" | "destructive" | "success" | "warning";

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
  task: "자동 실행",
  excel: "엑셀",
  promote: "승격 검토",
  initVault: "init-vault",
  setup: "setup",
  action: "확장 액션",
};

export const JOB_RUNNER_KO: Record<JobRunner, string> = {
  headless: "백그라운드",
  herdr: "herdr",
};

// A running herdr job says more than "실행중": the pane may be waiting on a human.
export const AGENT_STATUS_KO: Record<AgentStatus, string> = {
  idle: "입력 대기",
  working: "작업 중",
  blocked: "승인 대기",
  done: "정리 중",
  unknown: "상태 불명",
};

export function agentBadgeVariant(s: AgentStatus): BadgeVariant {
  switch (s) {
    case "blocked":
      return "warning";
    case "working":
      return "default";
    default:
      return "outline";
  }
}

/// 실행중 herdr 잡은 에이전트 상태를 우선 보여준다 (승인 대기가 가장 중요한 정보).
export function jobStatusLabel(j: Job): string {
  if (j.status === "running" && j.agentStatus)
    return AGENT_STATUS_KO[j.agentStatus];
  return JOB_STATUS_KO[j.status];
}

export function jobStatusVariant(j: Job): BadgeVariant {
  if (j.status === "running" && j.agentStatus)
    return agentBadgeVariant(j.agentStatus);
  return jobBadgeVariant(j.status);
}

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

// Issue workflow vocabulary (templates/이슈.md): status/priority frontmatter values.
export const NOTE_STATUSES = [
  "제안",
  "승인대기",
  "승인",
  "진행중",
  "부분완료",
  "완료",
  "보류",
  "취소",
  // Existing improvement notes are shown without migration.
  "구현중",
  "부분구현",
  "구현완료",
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
    case "진행중":
    case "부분완료":
    case "구현중":
    case "부분구현":
      return "default";
    case "완료":
    case "구현완료":
      return "success";
    case "보류":
      return "secondary";
    case "취소":
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
    p === "최우선"
      ? "destructive"
      : p === "중요"
        ? "warning"
        : p === "보통"
          ? "secondary"
          : "outline";
  return <Badge variant={variant}>{p || "-"}</Badge>;
}

// ---------- progress entries ----------

export function entryText(e: ProgressEntry): string {
  if (e.kind === "result")
    return e.summary ?? e.text ?? (e.isError ? "비정상 종료" : "완료");
  return e.text ?? e.summary ?? (e.tool ? `도구: ${e.tool}` : e.kind);
}

// ---------- layout primitives ----------

export function PageHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="sticky top-0 z-20 flex min-h-[58px] flex-wrap items-center gap-2 border-b bg-background/90 px-4 py-3 backdrop-blur-xl lg:px-5">
      <div className="mr-auto">
        <h1 className="text-[15px] font-bold leading-tight tracking-tight">
          {title}
        </h1>
      </div>
      {children}
    </div>
  );
}

export function Empty({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "py-8 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
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

// Images live on disk (vault attachments); the webview cannot read files, so each
// one is fetched through the backend and inlined as a data URL. `notePath` anchors
// relative and Obsidian shortest-path references to the note being displayed.
function MarkdownImage({
  notePath,
  src,
  alt,
  title,
}: {
  notePath?: string;
  src?: string;
  alt?: string;
  title?: string;
}) {
  const [resolved, setResolved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = (src ?? "").trim();
    setError(null);
    if (!raw || /^(https?:|data:|blob:)/i.test(raw)) {
      setResolved(raw || null);
      return;
    }
    if (!notePath) {
      setResolved(null);
      setError("문서 경로를 알 수 없어 이미지를 찾지 못했습니다");
      return;
    }
    let alive = true;
    setResolved(null);
    api
      .readNoteAsset(notePath, raw)
      .then((url) => {
        if (alive) setResolved(url);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [notePath, src]);

  if (error) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-[12px] text-muted-foreground">
        [이미지] {alt || src} — {error}
      </span>
    );
  }
  if (!resolved) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-[12px] text-muted-foreground">
        [이미지] {alt || src} 불러오는 중…
      </span>
    );
  }
  return (
    <img
      src={resolved}
      alt={alt ?? ""}
      title={title}
      loading="lazy"
      className="my-2 block max-w-full rounded-md border bg-background"
    />
  );
}

export function MarkdownView({
  src,
  notePath,
  className,
}: {
  src: string;
  /** Path of the note the markdown came from — required to resolve embedded images. */
  notePath?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-[13px] leading-relaxed [&>*:first-child]:mt-0",
        MD_CLASSES,
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src: imgSrc, alt, title }) => (
            <MarkdownImage
              notePath={notePath}
              src={typeof imgSrc === "string" ? imgSrc : undefined}
              alt={typeof alt === "string" ? alt : undefined}
              title={typeof title === "string" ? title : undefined}
            />
          ),
        }}
      >
        {preprocessObsidianMd(src)}
      </ReactMarkdown>
    </div>
  );
}
