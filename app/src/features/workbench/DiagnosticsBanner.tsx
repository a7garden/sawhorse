import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown, ChevronUp, Loader2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sddApi } from "./api";

const DOC_PREVIEW_LIMIT = 8;

/**
 * 스냅샷 진단을 원문 나열 대신 종류별로 묶은 알림으로 보여주고, 알려진 형식
 * 문제는 앱 안에서 바로 자동 수정할 수 있게 한다.
 */
export function DiagnosticsBanner({
  diagnostics,
  reload,
  setNotice,
}: {
  diagnostics: string[];
  reload: () => Promise<void>;
  setNotice: (notice: { tone: "error" | "success"; text: string }) => void;
}) {
  const { t } = useTranslation("workbench");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 진단은 항상 "경로.md: 메시지" 꼴이다. 같은 메시지끼리 묶어야 문서 수십
  // 개가 같은 원인일 때 한 줄로 읽힌다.
  const groups = useMemo(() => {
    const byMessage = new Map<string, string[]>();
    for (const entry of diagnostics) {
      const match = entry.match(/^(\S+\.md): (.+)$/s);
      const docs = byMessage.get(match ? match[2] : entry) ?? [];
      if (match) docs.push(match[1]);
      byMessage.set(match ? match[2] : entry, docs);
    }
    return [...byMessage.entries()]
      .map(([message, docs]) => ({ message, docs }))
      .sort((a, b) => b.docs.length - a.docs.length);
  }, [diagnostics]);
  const docCount = useMemo(
    () =>
      new Set(diagnostics.map((entry) => entry.match(/^(\S+\.md): /)?.[1] ?? entry)).size,
    [diagnostics],
  );
  const repair = async () => {
    setBusy(true);
    try {
      const report = await sddApi.repairDocuments();
      await reload();
      const repaired = new Set(report.repairs.map((repair) => repair.path)).size;
      if (repaired === 0)
        setNotice({ tone: "error", text: t("diagnostics.nothingToRepair") });
      else if (report.remaining.length > 0)
        setNotice({
          tone: "success",
          text: t("diagnostics.repairedRemaining", {
            count: repaired,
            remaining: report.remaining.length,
          }),
        });
      else setNotice({ tone: "success", text: t("diagnostics.repaired", { count: repaired }) });
    } catch (error) {
      setNotice({ tone: "error", text: t("diagnostics.repairFailed", { error: String(error) }) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="wb-diagnostics" role="alert">
      <div className="wb-diagnostics-head">
        <AlertCircle size={15} />
        <span className="wb-diagnostics-title">
          {t("diagnostics.title", { count: diagnostics.length, docs: docCount })}
        </span>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void repair()}>
          {busy ? <Loader2 className="wb-spin" /> : <Wrench />}
          {t("diagnostics.repair")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
          {open ? <ChevronUp /> : <ChevronDown />}
          {open ? t("diagnostics.hide") : t("diagnostics.details")}
        </Button>
      </div>
      {open && (
        <ul className="wb-diagnostics-groups">
          {groups.map((group) => (
            <li key={group.message}>
              <span className="wb-diagnostics-message">{group.message}</span>
              {group.docs.length > 0 && (
                <span className="wb-diagnostics-docs">
                  {" — "}
                  {t("common.nCount", { count: group.docs.length })} ·{" "}
                  {group.docs.slice(0, DOC_PREVIEW_LIMIT).join(", ")}
                  {group.docs.length > DOC_PREVIEW_LIMIT
                    ? ` ${t("diagnostics.docsMore", { count: group.docs.length - DOC_PREVIEW_LIMIT })}`
                    : ""}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
