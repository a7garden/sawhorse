import { useState } from "react";
import { ListChecks, RefreshCw, SquareTerminal } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { AuditIssue } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, MarkdownView, PageHeader } from "./common";

const SEV: Record<AuditIssue["severity"], { label: string; variant: "destructive" | "warning" | "secondary" }> = {
  error: { label: "위험", variant: "destructive" },
  warn: { label: "주의", variant: "warning" },
  info: { label: "정보", variant: "secondary" },
};

export default function VaultPage() {
  const audit = useApp((s) => s.audit);
  const unpromoted = useApp((s) => s.unpromoted);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<{ title: string; md: string } | null>(null);

  async function scan() {
    setScanning(true);
    try {
      await refreshAudit();
    } finally {
      setScanning(false);
    }
  }

  async function openPath(path: string) {
    try {
      const v = await api.readNote(path);
      const title = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
      setView({ title, md: v.markdown });
    } catch {
      setView(null);
    }
  }

  async function promote() {
    await api.enqueueJob({ kind: "promote" });
  }

  return (
    <div>
      <PageHeader title="볼트" desc="볼트 구조를 검사하고 인박스(미승격) 항목을 정리합니다.">
        <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
          <RefreshCw /> 다시 검사
        </Button>
        <Button size="sm" onClick={() => void promote()}>
          <SquareTerminal /> 인박스 승격 검토
        </Button>
      </PageHeader>

      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">빠른 검사</CardTitle>
              {audit && <span className="text-[11px] text-muted-foreground">{audit.issues.length}건</span>}
            </CardHeader>
            <CardContent>
              {audit == null ? (
                <Empty>아직 검사하지 않았습니다. 다시 검사를 누르세요.</Empty>
              ) : audit.issues.length === 0 ? (
                <Empty>문제를 찾지 못했습니다.</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {audit.issues.map((iss, i) => (
                    <li key={i} className="rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant={SEV[iss.severity].variant}>{SEV[iss.severity].label}</Badge>
                        <span className="min-w-0 flex-1">{iss.message}</span>
                      </div>
                      {iss.path.length > 0 && (
                        <button onClick={() => void openPath(iss.path)} className="mt-0.5 block w-full truncate text-left text-[11px] text-muted-foreground hover:underline" title={iss.path}>
                          {iss.path}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                <ListChecks className="mr-1 inline size-3.5" /> 미승격 항목 {unpromoted.length}건
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unpromoted.length === 0 ? (
                <Empty>미승격 항목이 없습니다.</Empty>
              ) : (
                <ul className="space-y-1">
                  {unpromoted.map((it, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className="shrink-0">{it.project}</Badge>
                      <span className="min-w-0 flex-1">{it.text}</span>
                      <button onClick={() => void openPath(it.listPath)} className="shrink-0 text-[11px] text-muted-foreground hover:underline">
                        목록 열기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">{view ? view.title : "노트 미리보기"}</CardTitle>
          </CardHeader>
          <CardContent>
            {view ? (
              <MarkdownView src={view.md} className="selectable" />
            ) : (
              <Empty>검사 결과나 목록에서 노트를 열어보세요.</Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
