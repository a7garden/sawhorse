import * as React from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "success" | "error" | "info";

export type Toast = {
  id: number;
  tone: ToastTone;
  text: string;
};

/** 토스트는 페이지 밖에서도(비-컴포넌트 모듈) 띄울 수 있어야 하므로 store 를 모듈 전역에 둔다. */
let items: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  listeners.forEach((fn) => fn());
}

/** 오류는 읽는 데 시간이 더 걸린다 — 성공·안내보다 길게 띄운다. */
const LIFETIME: Record<ToastTone, number> = {
  success: 4000,
  info: 5000,
  error: 8000,
};

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  if (!items.some((item) => item.id === id)) return;
  items = items.filter((item) => item.id !== id);
  emit();
}

export function toast(input: { tone?: ToastTone; text: string }) {
  const tone = input.tone ?? "info";
  const text = input.text.trim();
  if (!text) return -1;
  const id = ++seq;
  // 같은 문구가 연속으로 쌓이면 화면만 가린다 — 직전 것을 걷어내고 새로 띄운다.
  items
    .filter((item) => item.text === text)
    .forEach((item) => dismissToast(item.id));
  items = [...items, { id, tone, text }].slice(-4);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), LIFETIME[tone]),
  );
  emit();
  return id;
}

function useToasts() {
  return React.useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => items,
    () => items,
  );
}

const ICON: Record<ToastTone, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
};

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-success/40 text-foreground [&>svg]:text-success",
  error: "border-destructive/40 text-destructive [&>svg]:text-destructive",
  info: "text-foreground [&>svg]:text-muted-foreground",
};

/** 앱 최상단에 한 번만 올려 둔다. */
export function Toaster() {
  const toasts = useToasts();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-14 z-[100] flex flex-col items-center gap-2 px-4"
      aria-live="polite"
    >
      {toasts.map((item) => {
        const Icon = ICON[item.tone];
        return (
          <div
            key={item.id}
            role={item.tone === "error" ? "alert" : "status"}
            className={cn(
              "toast-item pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border bg-card px-3.5 py-2.5 text-[13px] shadow-lg",
              TONE_CLASS[item.tone],
            )}
          >
            <Icon className="mt-px size-4 shrink-0" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
              {item.text}
            </span>
            <button
              onClick={() => dismissToast(item.id)}
              aria-label="알림 닫기"
              className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
