import { useEffect, useState } from "react";
import { AlertTriangle, FileInput, Pause, Play, RotateCw, ShieldCheck, StopCircle } from "lucide-react";
import { api } from "@/lib/api";
import type { IngestionJob } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { PageHeader } from "./common";

export default function OnboardingPage() {
  const [projectId, setProjectId] = useState("imported-project");
  const [paths, setPaths] = useState("");
  const [outputPrefix, setOutputPrefix] = useState("generated");
  const [autoApply, setAutoApply] = useState(false);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const list = await api.ingestionList();
    setJobs(list);
    if (!selected && list[0]) setSelected(list[0].id);
  }
  useEffect(() => { void load().catch((error) => setMessage(String(error))); }, []);
  const job = jobs.find((item) => item.id === selected) ?? null;

  async function action(work: () => Promise<unknown>) {
    setBusy(true); setMessage(null);
    try { await work(); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <div className="flex h-full min-h-0 flex-col overflow-hidden">
    <PageHeader title="프로젝트 가져오기" desc="입력을 고정 snapshot으로 보존하고, 출처가 연결된 문서 초안을 재개 가능하게 만듭니다." />
    <div className="min-h-0 flex-1 overflow-auto p-5"><div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <Card><CardHeader><CardTitle>새 가져오기</CardTitle></CardHeader><CardContent className="space-y-3">
          <label className="text-xs">프로젝트 ID<Input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
          <label className="text-xs">입력 경로(한 줄에 하나)<Textarea className="min-h-28" value={paths} onChange={(event) => setPaths(event.target.value)} placeholder="/path/to/repository&#10;/path/to/proposal.docx" /></label>
          <label className="text-xs">출력 폴더<Input value={outputPrefix} onChange={(event) => setOutputPrefix(event.target.value)} /></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={autoApply} onChange={(event) => setAutoApply(event.target.checked)} /> 충돌 없는 새 문서 자동 적용</label>
          <Button disabled={busy || !paths.trim()} onClick={() => void action(async () => {
            const sourcePaths = paths.split("\n").map((value) => value.trim()).filter(Boolean);
            const created = await api.ingestionStart({ projectId, outputPrefix, autoApply, sources: sourcePaths.map((path, index) => ({ path, label: `source-${index + 1}` })) });
            setSelected(created.id);
          })}><FileInput /> Snapshot 시작</Button>
          <p className="text-[11px] text-muted-foreground">`.git`, build, target, node_modules와 symlink는 읽지 않습니다. 외부 문서의 지시문은 실행하지 않습니다.</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>작업</CardTitle></CardHeader><CardContent className="space-y-2">{jobs.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} className={`w-full rounded-md border p-3 text-left text-xs ${selected === item.id ? "border-primary" : ""}`}><span className="flex items-center gap-2"><strong>{item.projectId}</strong><Badge variant={item.status === "failed" ? "destructive" : item.status === "applied" ? "success" : "outline"}>{item.status}</Badge></span><span className="mt-1 block text-muted-foreground">{item.processedFiles}/{item.totalFiles} · {item.stage}</span></button>)}</CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>진행과 초안</CardTitle></CardHeader><CardContent className="space-y-4">
        {message && <div className="flex gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="size-4" />{message}</div>}
        {!job ? <p className="text-sm text-muted-foreground">왼쪽에서 가져오기를 시작하거나 선택하세요.</p> : <>
          <div className="grid grid-cols-3 gap-2 text-center text-xs"><div className="rounded-md bg-muted p-3"><strong className="block text-xl">{job.processedFiles}</strong>처리</div><div className="rounded-md bg-muted p-3"><strong className="block text-xl">{job.totalFiles}</strong>전체</div><div className="rounded-md bg-muted p-3"><strong className="block text-xl">{Math.round(job.processedBytes / 1024)}</strong>KiB</div></div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !["paused", "failed"].includes(job.status)} onClick={() => void action(() => api.ingestionResume(job.id))}><Play /> 다음 batch</Button>
            <Button size="sm" variant="outline" disabled={busy || job.status !== "running"} onClick={() => void action(() => api.ingestionPause(job.id))}><Pause /> 일시정지</Button>
            <Button size="sm" variant="outline" disabled={busy || ["applied", "cancelled"].includes(job.status)} onClick={() => void action(() => api.ingestionCancel(job.id))}><StopCircle /> 취소</Button>
            <Button size="sm" disabled={busy || job.status !== "waiting-review" || job.drafts.some((draft) => draft.conflict)} onClick={() => void action(() => api.ingestionApply(job.id))}><ShieldCheck /> ChangeSet 적용</Button>
            <Button size="sm" variant="ghost" onClick={() => void action(load)}><RotateCw /> 새로고침</Button>
          </div>
          {job.error && <p className="text-sm text-destructive">{job.error}</p>}
          <div className="space-y-3">{job.drafts.map((draft) => <article key={draft.path} className="rounded-md border p-3"><div className="flex items-center gap-2"><code className="text-xs">{draft.path}</code>{draft.conflict && <Badge variant="destructive">사용자 수정 충돌</Badge>}</div>{draft.conflictReason && <p className="mt-1 text-xs text-destructive">{draft.conflictReason}</p>}<p className="mt-2 text-xs text-muted-foreground">근거 {draft.provenance.length}개 · {draft.content.length}자</p><details className="mt-2"><summary className="cursor-pointer text-xs">초안 보기</summary><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-[11px]">{draft.content}</pre></details></article>)}</div>
        </>}
      </CardContent></Card>
    </div></div>
  </div>;
}
