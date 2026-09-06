import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export function Dialog({
  open,
  onClose,
  title,
  children,
  className,
  wide,
}: {
  open: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={cn(
          "relative z-10 max-h-[85vh] w-full overflow-hidden rounded-xl border bg-card shadow-lg flex flex-col",
          wide ? "max-w-3xl" : "max-w-md",
          className,
        )}
      >
        {title != null && (
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <div className="text-sm font-semibold">{title}</div>
            {onClose && (
              <Button variant="ghost" size="icon" onClick={onClose} aria-label="닫기">
                <X />
              </Button>
            )}
          </div>
        )}
        <div className="overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
