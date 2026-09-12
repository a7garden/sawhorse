import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Title and description of a category panel. */
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

/** Settings card bundling title·description·actions and input rows. */
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

/** One settings row. Default is label left·control right; wide controls (path inputs, long
 *  choices) stack label above·control below via stacked. The parent divides rows with divide-y. */
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

/** Save·validation result banner. Success on a pale green panel, failure on a pale red panel with an icon. */
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
