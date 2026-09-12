// Surfaces tasks the user must carry out themselves, such as migrations and
// data moves, as first-class items above every screen. Where UpgradeGate blocks
// the whole app for an "unusable state", this strip handles "work is possible,
// but these are problems you must not skip unaware". Actual fixes happen in the
// dedicated screens (schema studio, workbench issues), so the strip's role ends
// at making the user aware and pointing the way. Dismissing hides it only for
// this session — as long as the state persists it asks again on the next run.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowRightLeft, Inbox, X } from "lucide-react";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";

interface AttentionRow {
  id: string;
  Icon: typeof AlertTriangle;
  tone: "warning" | "danger";
  text: string;
  cta: string;
  page: "issues" | "schemas";
}

const TONE_CLASS = {
  warning: "border-amber-300 bg-amber-50 text-amber-900",
  danger: "border-red-300 bg-red-50 text-red-900",
} as const;

export function AttentionStrip() {
  const { t } = useTranslation("common");
  const attention = useApp((s) => s.attention);
  const setPage = useApp((s) => s.setPage);
  const [dismissed, setDismissed] = useState<string[]>([]);

  if (!attention) return null;
  const rows: AttentionRow[] = [];
  // Conflicts block the migration itself, so they rank above move-pending.
  if (attention.schemaConflicts > 0) {
    rows.push({
      id: "schema-conflicts",
      Icon: AlertTriangle,
      tone: "danger",
      text: t("attention.schemaConflicts", {
        count: attention.schemaConflicts,
        id: attention.schemaId,
        revision: attention.schemaRevision,
      }),
      cta: t("attention.schemaConflictsCta"),
      page: "schemas",
    });
  }
  if (attention.pendingSchemaMoves > 0) {
    rows.push({
      id: "schema-moves",
      Icon: ArrowRightLeft,
      tone: "warning",
      text: t("attention.schemaMoves", {
        count: attention.pendingSchemaMoves,
        id: attention.schemaId,
        revision: attention.schemaRevision,
      }),
      cta: t("attention.schemaMovesCta"),
      page: "schemas",
    });
  }
  if (attention.pendingLegacyIssues > 0) {
    rows.push({
      id: "legacy-issues",
      Icon: Inbox,
      tone: "warning",
      text: t("attention.legacyIssues", {
        count: attention.pendingLegacyIssues,
      }),
      cta: t("attention.legacyIssuesCta"),
      page: "issues",
    });
  }
  const visible = rows.filter((row) => !dismissed.includes(row.id));
  if (visible.length === 0) return null;
  return (
    <div role="alert" className="shrink-0 border-b bg-background">
      {visible.map((row) => (
        <div
          key={row.id}
          className={`flex items-center gap-2.5 px-5 py-2 text-xs ${TONE_CLASS[row.tone]}`}
        >
          <row.Icon className="size-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">{row.text}</p>
          <Button size="xs" variant="outline" onClick={() => setPage(row.page)}>
            {row.cta}
          </Button>
          <button
            aria-label={t("attention.dismiss")}
            className="rounded p-1 opacity-70 hover:opacity-100"
            onClick={() => setDismissed((prev) => [...prev, row.id])}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
