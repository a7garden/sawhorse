// 마이그레이션·이관처럼 사용자가 직접 진행해야 하는 작업을 모든 화면 위 1급으로
// 띄운다. UpgradeGate 가 "앱을 못 쓰는 상태"를 전면 가림으로 처리한다면 이 스트립은
// "작업은 가능하지만 모르고 넘어가면 안 되는 문제"를 담당한다. 실제 해결은 각
// 전문 화면(스키마 스튜디오·작업대 이슈)에서 이뤄지므로 스트립의 역할은 인지시키고
// 안내하는 것까지다. 닫아도 이 세션 안에서만 사라진다 — 상태가 남는 한 다음
// 실행 때 다시 묻는다.
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
  // 충돌은 마이그레이션 자체를 막으므로 이동 대기보다 위에 온다.
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
