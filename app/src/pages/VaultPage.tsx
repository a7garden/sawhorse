import { useState } from "react";
import { ListChecks, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { jobRequestKey } from "@/lib/jobs";
import { RunButton } from "@/components/RunButton";
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

// 미승격 목록의 절대 경로에서 볼트 경로 prefix를 떼어 볼트 기준 상대 경로로 바꾼다.
// 구분자는 슬래시로 정규화하고, 볼트 경로와 맞지 않으면 null을 돌려준다.
function vaultRel(listPath: string, vaultPath: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const v = norm(vaultPath);
  const f = norm(listPath);
  if (v.length === 0 || !f.startsWith(`${v}/`)) return null;
  return f.slice(v.length + 1);
}

export default function VaultPage() {
  const audit = useApp((s) => s.audit);
  const unpromoted = useApp((s) => s.unpromoted);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);
  const vaultPath = useApp((s) => s.config?.vaultPath ?? "");
  const [scanning, setScanning] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{
    title: string;
    md: string;
    path: string;
  } | null>(null);

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
      setView({ title, md: v.markdown, path });
    } catch {
      setView(null);
    }
  }

  // 미승격 목록은 frontmatter가 없어 read_note가 거부하므로 볼트 노트 읽기로 연다.
  async function openList(rel: string) {
    try {
      const v = await api.readVaultNote(rel);
      setView({ title: v.title, md: v.markdown, path: rel });
    } catch {
      setView(null);
    }
  }

  async function promote() {
    setPromoting(true);
    setError(null);
    try {
      await api.enqueueJob({ kind: "promote" });
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  return (
    <div>
      <PageHeader title="볼트">
        <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
          <RefreshCw /> 다시 검사
        </Button>
        <RunButton
          size="sm"
          variant="default"
          icon={<SquareTerminal />}
          jobKey={jobRequestKey({ kind: "promote" })}
          label="인박스 승격 검토"
          disabled={promoting}
          onRun={promote}
          onError={setError}
        />
      </PageHeader>

      {error && (
        <p className="mx-4 mb-1 flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" /> 승격 검토 등록 실패: {error}
        </p>
      )}

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
                  {unpromoted.map((it, i) => {
                    const rel = vaultRel(it.listPath, vaultPath);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <Badge variant="outline" className="shrink-0">{it.project}</Badge>
                        <span className="min-w-0 flex-1">{it.text}</span>
                        {rel ? (
                          <button onClick={() => void openList(rel)} className="shrink-0 text-[11px] text-muted-foreground hover:underline">
                            목록 열기
                          </button>
                        ) : (
                          <span className="shrink-0 text-[11px] text-muted-foreground" title="설정의 볼트 경로와 목록 경로가 일치하지 않습니다">
                            볼트 불일치
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">{view ? view.title : "문서 미리보기"}</CardTitle>
          </CardHeader>
          <CardContent>
            {view ? (
              <MarkdownView
                src={view.md}
                notePath={view.path}
                className="selectable"
              />
            ) : (
              <Empty>검사 결과나 목록에서 문서를 열어보세요.</Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
