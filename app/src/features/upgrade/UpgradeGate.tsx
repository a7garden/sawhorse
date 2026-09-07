import { useEffect, useState, type ReactNode } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";

type Report = { id: string; status: string; error: string | null; steps: string[]; backups: string[]; migrated: number; changed: boolean; notices: string[] };
export function UpgradeGate({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<Report>("upgrade_status").then(setReport).catch((e) => setError(String(e)));
  }, []);
  const completed = report?.status === "completed";
  const showResult = completed && report.changed && (report.backups.length > 0 || report.notices.length > 0);
  if (!isTauri() || (completed && (!showResult || dismissed))) return <>{children}</>;
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-5 p-8" aria-live="polite">
      <h1 className="text-xl font-semibold">{completed ? "작업공간 업그레이드 완료" : "작업공간 업그레이드"}</h1>
      <p>{error || report?.error || (completed ? `이전 작업 ${report.migrated}개를 확인·이관하고 Sawhorse 설치본을 갱신했습니다.` : "이전 데이터와 Sawhorse 플러그인을 확인하고 있습니다.")}</p>
      {!!report?.steps.length && <ul className="list-inside list-disc">{report.steps.map((step, i) => <li key={i}>{step}</li>)}</ul>}
      {!!report?.notices.length && <div className="rounded-md border p-4"><p className="mb-2 font-medium">확인이 필요한 항목</p>{report.notices.map((notice) => <p className="text-sm" key={notice}>{notice}</p>)}</div>}
      {!!report?.backups.length && <details className="rounded-md border p-4"><summary className="cursor-pointer">이전 데이터 백업 위치 ({report.backups.length})</summary><div className="mt-3 max-h-64 space-y-2 overflow-auto">{report.backups.map((path) => <p className="break-all text-sm" key={path}>{path}</p>)}</div></details>}
      {completed && <Button onClick={() => setDismissed(true)}>작업공간 열기</Button>}
      {(report?.status === "failed" || error) && <>
        <p className="text-sm text-muted-foreground">원인을 해결한 뒤 재시도하면 기록된 단계부터 복구합니다. 완료되면 앱을 다시 시작합니다.</p>
        <Button disabled={busy} onClick={async () => {
          setBusy(true); setError("");
          try { setReport(await invoke<Report>("upgrade_retry")); }
          catch (e) { setError(String(e)); }
          finally { setBusy(false); }
        }}>{busy ? "업그레이드 중…" : "다시 시도"}</Button>
      </>}
    </main>
  );
}
