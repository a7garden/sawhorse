import { cn } from "@/lib/utils";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: { value: T; label: React.ReactNode; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          onClick={() => onChange(t.value)}
          className={cn(
            "inline-flex h-6.5 items-center gap-1 rounded-md px-2.5 text-xs font-medium transition-colors",
            value === t.value
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
          {t.count != null && (
            <span className="text-[10px] tabular-nums opacity-70">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
