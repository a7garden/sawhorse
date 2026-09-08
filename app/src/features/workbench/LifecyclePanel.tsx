import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { vaultImageSources } from "./embedded-images";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Play, Loader2, RefreshCw, SquareTerminal, StopCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/pages/common";
import { useApp } from "@/lib/store";
import { sddApi } from "./api";
import { launchIntent } from "./intent";
import { lifecycleStages, type LifecycleState } from "./lifecycle-v2";
import type { Document, HarnessRun, Project, WorkItem } from "./types";
import "./lifecycle.css";
const occupied = (run: HarnessRun) => ["starting", "running", "blocked", "unknown"].includes(run.status);
export function LifecyclePanel({ work, project, onReload, onDirtyChange }: { work: WorkItem; project?: Project; onReload: () => Promise<void>; onDirtyChange: (dirty: boolean) => void }) {
  const { t } = useTranslation("workbench");
  const [state, setState] = useState<LifecycleState | null>(null);
  const [review, setReview] = useState<Awaited<ReturnType<typeof sddApi.intentReview>> | null>(null);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [tab, setTab] = useState(work.stage === "inbox" ? "intent" : work.stage === "clarify" ? "brief" : ["unconfirmed", "build", "done"].includes(work.stage) ? "verification" : "spec");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ document: Document; text: string } | null>(null);
  const [archived, setArchived] = useState<Document[] | null>(null);
  const [impact, setImpact] = useState<WorkItem[] | null>(null);
  const lock = useRef(false);
  const latest = useRef({ onReload }); latest.current = { onReload };
  const refresh = useCallback(async () => {
    const [next, docs, saved] = await Promise.all([sddApi.lifecycle(work.id), sddApi.intentReview(work.id), sddApi.runs()]);
    setState(next); setReview(docs); setRuns(saved.filter((run) => run.workId === work.id && !run.parentRunId));
  }, [work.id]);
  useEffect(() => { onDirtyChange(!!editing || Object.values(answers).some(Boolean)); return () => onDirtyChange(false); }, [editing, answers, onDirtyChange]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>; let signature = "";
    const poll = async () => {
      try {
        const saved = (await sddApi.runs()).filter((run) => run.workId === work.id && !run.parentRunId);
        const refreshed = await Promise.all(saved.map((run) => occupied(run) ? sddApi.refreshRun(run.id) : run));
        const [next, docs] = await Promise.all([sddApi.lifecycle(work.id), sddApi.intentReview(work.id)]);
        if (!alive) return;
        setRuns(refreshed); setState(next); setReview(docs);
        const key = `${next.revision}:${refreshed.map((r) => `${r.id}:${r.status}`).join()}`;
        if (signature && signature !== key) await latest.current.onReload();
        signature = key;
      } catch (e) { if (alive) setError(String(e)); }
      if (alive) timer = setTimeout(() => void poll(), 4000);
    };
    void poll(); return () => { alive = false; clearTimeout(timer); };
  }, [work.id]);
  const active = runs.find(occupied);
  const lastRun = active ?? [...runs].sort((a,b) => b.createdAt.localeCompare(a.createdAt))[0];
  const pending = state?.interviews.filter((q) => !q.answer) ?? [];
  const locked = busy || !!active || !!editing || !!archived || !state || !review;
  const canRun = ["clarify", "design"].includes(work.stage) && !pending.length;
  const canCancel = ["inbox", "clarify", "design", "approval", "queued"].includes(work.stage);
  async function perform(task: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try { await task(); await refresh(); await onReload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); lock.current = false; }
  }
  async function decide(action: string) {
    if (!state || !review) return;
    const next = await sddApi.lifecycleAction({ workId: work.id, action, expectedStage: work.stage, revision: state.revision, inputDigest: review.inputDigest, note: t(`lifecycle.actions.${action}`) });
    if (["clarify", "design"].includes(action) && project) await launchIntent(next, project);
    if (action === "design") setTab("spec");
    if (action === "clarify") setTab("brief");
    setImpact(null);
  }
  const doc = (archived ?? review?.documents)?.find((d) => d.artifact === tab);
  const imageExtensions = useMemo(() => doc ? [vaultImageSources(doc.path)] : [], [doc?.path]);
  const currentIndex = lifecycleStages.indexOf(work.stage);
  return <section className="wb-lifecycle wb-intent-flow">
    <ol className="wb-lifecycle-progress" aria-label={t("lifecycle.progress")}>
      {lifecycleStages.map((stage, index) => <li key={stage} aria-current={stage === work.stage ? "step" : undefined} className={index < currentIndex ? "is-complete" : ""}><span>{index < currentIndex ? <Check size={12} /> : index + 1}</span>{t(`lifecycle.stages.${stage}`)}</li>)}
    </ol>
    <div className="wb-intent-flow-head"><div><h3>{t(`lifecycle.stages.${work.stage}`)}</h3><p>{t(`lifecycle.hints.${work.stage}`)}</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(refresh)}><RefreshCw />{t("intent.refresh")}</Button></div>
    {(error || state?.error) && <div className="wb-inline-error" role="alert">{error || state?.error}</div>}
    {lastRun && <div className="wb-intent-run" role="status"><span>{active && <Loader2 className="wb-spin" size={14} />}{t(`intent.runStatus.${lastRun.status}`)}{lastRun.error && <small>{lastRun.error}</small>}</span><Button size="sm" variant="outline" onClick={() => useApp.getState().openRun(lastRun.id, lastRun.projectId)}><SquareTerminal />{t("intent.openRun")}</Button>{active && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void perform(() => sddApi.stopRun(active.id))}><StopCircle />{t("intent.stopRun")}</Button>}</div>}
    {pending.length > 0 && <aside className="wb-interview" aria-label={t("lifecycle.interview")}><h3>{t("lifecycle.interview")}</h3><p>{t("lifecycle.interviewHint")}</p>
      {pending.map((question) => <form key={question.id} onSubmit={(e) => { e.preventDefault(); void perform(async () => {
        const next = await sddApi.answerInterview(work.id, question.id, answers[question.id] || "", state!.revision);
        setAnswers((prev) => ({ ...prev, [question.id]: "" }));
        if (!next.interviews.some((q) => !q.answer) && !active && project) {
          const current = (await sddApi.snapshot()).work.find((w) => w.id === work.id)!;
          await launchIntent(current, project, "인터뷰 답변을 읽고 현재 단계의 작업을 계속하세요.");
        }
      }); }}><label htmlFor={`answer-${question.id}`}>{question.question}</label><div className="wb-interview-options">{question.options.map((option) => <button type="button" key={option} aria-pressed={answers[question.id] === option} onClick={() => setAnswers((prev) => ({ ...prev, [question.id]: option }))}>{option}</button>)}</div>
      <textarea id={`answer-${question.id}`} value={answers[question.id] || ""} onChange={(e) => setAnswers((prev) => ({ ...prev, [question.id]: e.target.value }))} placeholder={t("lifecycle.answerPlaceholder")} disabled={busy} />
      <Button type="submit" size="sm" disabled={busy || !answers[question.id]?.trim()}>{t("lifecycle.answer")}</Button></form>)}
    </aside>}
    <div className="wb-lifecycle-actions">
      {work.stage === "inbox" && <Button disabled={locked || !project} onClick={() => void perform(() => decide("clarify"))}><Play />{t("lifecycle.actions.clarify")}</Button>}
      {canRun && <Button variant="outline" disabled={locked || !project} onClick={() => void perform(() => launchIntent(work, project!))}><Play />{t("lifecycle.continue")}</Button>}
      {work.stage === "clarify" && <Button disabled={locked || !state?.clarified || pending.length > 0 || !project} onClick={() => void perform(() => decide("design"))}>{t("lifecycle.actions.design")}</Button>}
      {work.stage === "approval" && <Button disabled={locked} onClick={() => void perform(() => decide("approve"))}><Check />{t("lifecycle.actions.approve")}</Button>}
      {["approval", "queued"].includes(work.stage) && <Button variant="outline" disabled={locked || state?.queued} onClick={() => void perform(() => decide("revise"))}>{t("lifecycle.actions.revise")}</Button>}
      {work.stage === "queued" && <Button disabled={locked || state?.queued} onClick={() => void perform(() => sddApi.queueImplementation([work.id]))}><Play />{t(state?.queued ? "lifecycle.enqueued" : "lifecycle.queue")}</Button>}
      {["build", "discarding"].includes(work.stage) && !active && <Button variant="outline" disabled={locked || state?.queued} onClick={() => void perform(() => decide("retry"))}>{t(state?.queued ? "lifecycle.enqueued" : "lifecycle.actions.retry")}</Button>}
      {work.stage === "unconfirmed" && <Button disabled={locked} onClick={() => void perform(() => decide("confirm"))}><Check />{t("lifecycle.actions.confirm")}</Button>}
      {canCancel && <Button variant="ghost" disabled={locked} onClick={() => void perform(() => decide("cancel"))}>{t("lifecycle.actions.cancel")}</Button>}
      {["unconfirmed", "done"].includes(work.stage) && <Button variant="ghost" disabled={locked} onClick={() => void perform(async () => setImpact(await sddApi.discardImpact(work.id)))}>{t("lifecycle.actions.discard")}</Button>}
    </div>
    {state?.clarified && !pending.length && work.stage === "clarify" && <p className="wb-lifecycle-notice">{t("lifecycle.clarified")}</p>}
    {impact && <aside className="wb-interview"><h3>{t("lifecycle.discardTitle")}</h3><p>{t(impact.length ? "lifecycle.discardBlocked" : "lifecycle.discardHint")}</p>{impact.map((item) => <p key={item.id}>{item.title} · {t(`lifecycle.stages.${item.stage}`, { defaultValue: item.stage })}</p>)}<Button disabled={locked || impact.length > 0} onClick={() => void perform(() => decide("discard"))}>{t("lifecycle.discardConfirm")}</Button><Button variant="ghost" onClick={() => setImpact(null)}>{t("common.cancel")}</Button></aside>}
    {(work.dependsOn.length > 0 || (state?.scope.length ?? 0) > 0) && <details className="wb-intent-history"><summary>{t("lifecycle.dependencies")}</summary><p>{work.dependsOn.join(", ") || t("lifecycle.noDependencies")}</p><pre>{state?.scope.join("\n")}</pre></details>}
    <nav className="wb-artifact-nav" role="tablist" aria-label={t("lifecycle.documents")}>{review?.documents.map((d) => <button key={d.artifact} role="tab" disabled={!!editing} aria-selected={tab === d.artifact} className={tab === d.artifact ? "active" : ""} onClick={() => setTab(d.artifact)}>{t(`lifecycle.docs.${d.artifact}`)}</button>)}</nav>
    {archived && <Button variant="ghost" onClick={() => setArchived(null)}>{t("intent.currentDocuments")}</Button>}
    {doc && <div className="wb-lifecycle-document wb-intent-review-document" role="tabpanel">
      {editing ? <><AtomicCodeMirrorEditor documentId={`${work.id}:${editing.document.artifact}:${editing.document.revision}`} markdownSource={editing.text} extensions={imageExtensions} readOnly={busy} onMarkdownChange={(text) => setEditing((current) => current ? { ...current, text } : null)} /><Button disabled={busy} onClick={() => void perform(async () => { await sddApi.writeDocument(work.id, editing.document.artifact, editing.text, editing.document.revision); setEditing(null); })}>{t("common.save")}</Button><Button variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button></> : <>
        {!active && !archived && canCancel && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing({ document: doc, text: doc.markdown })}>{t("intent.edit")}</Button>}
        <MarkdownView src={doc.markdown || t("intent.waitingDocument")} notePath={doc.path} />
      </>}
    </div>}
    {!!state?.commits.length && <details className="wb-intent-history" open><summary>{t("lifecycle.commits")}</summary>{state.commits.map((sha) => <code className="wb-commit" key={sha}>{sha}</code>)}{state.revertCommits.map((sha) => <code className="wb-commit" key={sha}>{t("lifecycle.revert")} {sha}</code>)}</details>}
    {!!state?.interviews.length && <details className="wb-intent-history"><summary>{t("lifecycle.interviewHistory")}</summary>{state.interviews.map((q) => <div key={`${q.runId}:${q.id}`}><strong>{q.question}</strong><p>{q.answer || t("lifecycle.waitingAnswer")}</p></div>)}</details>}
    {!!state?.messages.length && <details className="wb-intent-history"><summary>{t("lifecycle.messages")}</summary>{state.messages.map((m, i) => <p key={i}>{m.from} → {m.to}: {m.text}</p>)}</details>}
    {lastRun?.finalReport && <details className="wb-intent-history"><summary>{t("intent.agentReport")}</summary><MarkdownView src={lastRun.finalReport} /></details>}
    <details className="wb-intent-history"><summary>{t("intent.history")} · {review?.history.length ?? 0}</summary>{review?.history.map((h) => <button key={h.id} disabled={!!editing || busy} onClick={() => void perform(async () => setArchived(await sddApi.intentCheckpoint(work.id, h.id)))}><span>{h.note || h.event}</span><time>{new Date(h.at).toLocaleString()}</time></button>)}</details>
  </section>;
}
