import { vaultImageSources } from "./embedded-images";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Play, RefreshCw, SquareTerminal, StopCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/pages/common";
import { useApp } from "@/lib/store";
import { sddApi, workflowApi } from "./api";
import { launchIntent } from "./intent";
import { isClosedStatus, type Document, type HarnessRun, type Project, type WorkItem } from "./types";

const occupied = (run: HarnessRun) => ["starting", "running", "blocked", "unknown"].includes(run.status);
const meaningful = (markdown = "") => markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
  .replace(/<!--[\s\S]*?-->/g, "").split("\n").some((line) => line.trim() && !/^\s*(#|[-*] \[ \])/.test(line));

export function IntentFlowPanel({ work, project, onReload, onDirtyChange }: {
  work: WorkItem; project?: Project; onReload: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const { t, i18n } = useTranslation("workbench");
  const [review, setReview] = useState<Awaited<ReturnType<typeof sddApi.intentReview>> | null>(null);
  const [tab, setTab] = useState(work.stage === "build" ? "verification" : "intent");
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loadedRuns, setLoadedRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const actionLock = useRef(false);
  const initialTab = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editRevision, setEditRevision] = useState("");
  const [checkpointId, setCheckpointId] = useState("");
  const [archived, setArchived] = useState<Document[] | null>(null);
  useEffect(() => {
    onDirtyChange(editing || !!feedback.trim());
    return () => onDirtyChange(false);
  }, [editing, feedback, onDirtyChange]);
  const building = work.stage === "build";
  const closed = isClosedStatus(work.status);
  const activeRun = runs.find(occupied);
  const active = !!activeRun;
  const currentRun = activeRun ?? runs.filter((run) => run.stage === work.stage).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  // 폴링이 같은 문서를 다시 넣으면 마크다운 뷰가 새로 그려져 화면이 튄다.
  // 직전 응답을 문자열로 기억해 두고 달라졌을 때만 바꾸며, 입력 중이면 그때까지 미룬다.
  const seen = useRef({ review: "", runs: "" });
  const holdingInput = editing || !!feedback.trim();
  const holding = useRef(holdingInput); holding.current = holdingInput;
  const deferredReview = useRef<Awaited<ReturnType<typeof sddApi.intentReview>> | null>(null);
  const applyReview = useCallback((next: Awaited<ReturnType<typeof sddApi.intentReview>>, force = false) => {
    const key = JSON.stringify(next);
    if (key === seen.current.review) return;
    if (!force && holding.current) { deferredReview.current = next; return; }
    deferredReview.current = null; seen.current.review = key; setReview(next);
  }, []);
  useEffect(() => {
    if (holdingInput || !deferredReview.current) return;
    const next = deferredReview.current; deferredReview.current = null;
    seen.current.review = JSON.stringify(next); setReview(next);
  }, [holdingInput]);
  const refresh = useCallback(async (force = false) => {
    const next = await sddApi.intentReview(work.id);
    applyReview(next, force);
    if (!initialTab.current) {
      initialTab.current = true;
      if (work.stage === "design" && next.documents.some((doc) => doc.artifact === "spec" && meaningful(doc.markdown))) setTab("spec");
    }
    return next;
  }, [work.id, work.stage, applyReview]);
  useEffect(() => { void refresh().catch((error) => setError(String(error))); }, [refresh]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    const poll = async () => {
      try {
        const saved = (await sddApi.runs()).filter((run) => run.workId === work.id && !run.parentRunId);
        const next = await Promise.all(saved.map((run) => occupied(run) ? sddApi.refreshRun(run.id) : run));
        if (!alive) return;
        const runKey = JSON.stringify(next);
        if (runKey !== seen.current.runs) { seen.current.runs = runKey; setRuns(next); }
        setLoadedRuns(true);
        const signature = next.map((run) => `${run.id}:${run.status}:${run.updatedAt}`).join("|");
        if (previous && previous !== signature) { await refresh(); await onReload(); }
        previous = signature;
      } catch (error) { if (alive) { setLoadedRuns(false); setError(String(error)); } }
      if (alive) timer = setTimeout(() => void poll(), 8000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [work.id, refresh, onReload]);
  useEffect(() => {
    let alive = true;
    setArchived(null);
    if (checkpointId) void sddApi.intentCheckpoint(work.id, checkpointId)
      .then((documents) => { if (alive) setArchived(documents); })
      .catch((error) => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [work.id, checkpointId]);
  const documents = checkpointId ? archived : review?.documents;
  const doc = documents?.find((document) => document.artifact === tab);
  const imageExtensions = useMemo(() => doc ? [vaultImageSources(doc.path)] : [], [doc?.path]);
  const substantial = (role: string) => meaningful(review?.documents.find((document) => document.artifact === role)?.markdown);
  const designReady = substantial("spec") && substantial("plan");
  const resultReady = substantial("verification");
  const checkpoint = review?.history.find((entry) => entry.id === checkpointId);
  const locked = busy || editing || active || !loadedRuns || !review || !!checkpointId;
  const nextStep = checkpointId ? "historyHint" : work.status === "blocked" ? "pausedHint"
    : active ? `runStatus.${currentRun!.status}` : !project ? "projectHint"
    : currentRun && ["failed", "stopped", "unknown"].includes(currentRun.status) ? `runStatus.${currentRun.status}`
    : feedback.trim() ? "feedbackPending" : building ? resultReady ? "resultReady" : "resultMissing"
    : designReady ? "designReady" : "designMissing";
  async function act(action: "run" | "approve" | "complete" | "revise" | "resume" | "stop") {
    if (actionLock.current || !review || !loadedRuns || (active && action !== "stop")) return;
    actionLock.current = true; setBusy(true); setError("");
    let transitioned = false;
    try {
      if (action === "stop") {
        if (activeRun) await sddApi.stopRun(activeRun.id);
      } else if (action === "resume") {
        await workflowApi.command({ workId: work.id, event: "work:resume", expectedNodeId: work.stage,
          note: feedback.trim() || t("intent.resumeNote"), eventId: crypto.randomUUID(), facts: { expectedStatus: work.status } });
        setFeedback("");
      } else if (action === "complete") {
        let current = work;
        if (current.status === "running") current = await workflowApi.command({ workId: work.id, event: "work:submit", expectedNodeId: work.stage,
          note: t("intent.acceptResult"), eventId: crypto.randomUUID(), inputDigest: review.inputDigest });
        await workflowApi.command({ workId: work.id, event: "work:complete", expectedNodeId: work.stage,
          note: t("intent.acceptResult"), eventId: crypto.randomUUID(), inputDigest: review.inputDigest, facts: { expectedStatus: current.status } });
      } else {
        if (!project) throw new Error(t("intent.projectHint"));
        let current = work;
        if (action === "revise") {
          current = await workflowApi.command({ workId: work.id, event: "revise", targetNodeId: "design", expectedNodeId: "build",
            note: feedback.trim() || t("intent.backToDesign"), eventId: crypto.randomUUID() });
          setTab("spec");
        }
        if (action === "approve") {
          current = await workflowApi.command({ workId: work.id, event: "approved", targetNodeId: "build", expectedNodeId: "design",
            note: t("intent.approvalNote"), eventId: crypto.randomUUID(), inputDigest: review.inputDigest });
          transitioned = true;
          setTab("verification");
        }
        await launchIntent(current, project, action === "approve" ? "" : feedback.trim());
        setFeedback("");
      }
    } catch (error) { setError(`${transitioned ? t("intent.approvedLaunchFailed") + " " : ""}${String(error)}`); }
    finally {
      try {
        const saved = (await sddApi.runs()).filter((run) => run.workId === work.id && !run.parentRunId);
        const runKey = JSON.stringify(saved);
        if (runKey !== seen.current.runs) { seen.current.runs = runKey; setRuns(saved); }
        await refresh(true); await onReload();
      }
      catch (error) { setError(String(error)); }
      finally { actionLock.current = false; setBusy(false); }
    }
  }
  const openRun = (run: HarnessRun) => {
    if ((editing || feedback.trim()) && !window.confirm(t("detail.confirmClose"))) return;
    useApp.getState().openRun(run.id, run.projectId);
  };
  return <section className="wb-intent-flow">
    <ol className="wb-intent-progress" aria-label={t("intent.progress")}>
      {["humanIntent", "aiDesign", "humanApproval", "aiBuild", "humanResult"].map((step, index) => {
        const current = closed ? 4 : building ? resultReady && !active ? 4 : 3 : designReady && !active ? 2 : 1;
        return <li key={step} aria-current={index === current ? "step" : undefined} className={index < current ? "is-complete" : ""}>
          <span>{index < current ? <Check size={12} /> : index + 1}</span>{t(`intent.${step}`)}
        </li>;
      })}
    </ol>
    <div className="wb-intent-flow-head"><div><h3>{t(closed ? "intent.finished" : building ? "intent.build" : "intent.design")}</h3>
      <p>{t(closed ? "intent.completedHint" : `intent.${nextStep}`)}</p></div>
      <Button size="sm" variant="outline" disabled={busy || editing} onClick={() => { void refresh(true).then(() => setError("")).catch((error) => setError(String(error))); }}><RefreshCw />{t("intent.refresh")}</Button>
    </div>
    {currentRun && <div className="wb-intent-run" role="status">
      <span>{active && currentRun.status !== "blocked" && <Loader2 className="wb-spin" size={14} />}{t(`intent.runStatus.${currentRun.status}`)}{currentRun.error && <small>{currentRun.error}</small>}</span>
      <Button size="sm" variant="outline" onClick={() => openRun(currentRun)}><SquareTerminal />{t("intent.openRun")}</Button>
      {active && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("stop")}><StopCircle />{t("intent.stopRun")}</Button>}
    </div>}
    {error && <div className="wb-inline-error" role="alert">{error}</div>}
    {!closed && <div className="wb-intent-action-box">
      <label className="wb-intent-feedback-label">{t("intent.feedback")}
        <textarea className="wb-intent-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} aria-label={t("intent.feedback")} placeholder={t("intent.feedbackHint")} disabled={busy || editing || active || !!checkpointId} />
      </label>
      <div className="wb-intent-footer">
        <span className="wb-intent-help">{project && t("intent.agent", { agent: project.defaultAgent, model: project.defaultModel || t("intent.defaultModel") })}</span>
        {["blocked", "review"].includes(work.status) && !building && <Button variant="outline" disabled={locked} onClick={() => void act("resume")}>{t("intent.resume")}</Button>}
        <Button variant="outline" disabled={locked || !project || ["blocked", "review"].includes(work.status)} onClick={() => void act("run")}><Play />{t(building ? "intent.retryBuild" : currentRun ? "intent.reviseDesign" : "intent.requestDesign")}</Button>
        {!building && <Button disabled={locked || !project || work.status === "blocked" || !!feedback.trim() || !designReady} onClick={() => void act("approve")}>
          {busy ? <Loader2 className="wb-spin" /> : <Check />}{t("intent.approveBuild")}</Button>}
        {building && <Button variant="outline" disabled={locked || !project || work.status === "blocked"} onClick={() => void act("revise")}>{t("intent.backToDesign")}</Button>}
        {building && <Button disabled={locked || !!feedback.trim() || !["running", "review"].includes(work.status) || !resultReady} onClick={() => void act("complete")}><Check />{t("intent.acceptResult")}</Button>}
      </div>
      {work.status === "blocked" && building && <Button size="sm" variant="outline" disabled={locked} onClick={() => void act("resume")}>{t("intent.resume")}</Button>}
    </div>}
    <div className="wb-artifact-nav" role="tablist">{["intent", "spec", "plan", "verification"].map((role) =>
      <button disabled={editing} key={role} role="tab" aria-selected={tab === role} className={tab === role ? "active" : ""} onClick={() => setTab(role)}>{t(`intent.docs.${role}`)}</button>)}</div>
    {checkpointId && <div className="wb-intent-history-notice"><span>{t("intent.historyHint")} {checkpoint && new Date(checkpoint.at).toLocaleString(i18n.language)}</span>
      <Button size="sm" variant="outline" onClick={() => setCheckpointId("")}>{t("intent.currentDocuments")}</Button></div>}
    {tab === "intent" && !checkpointId && !closed && !active && !building && doc && <div className="wb-intent-footer">
      {!editing ? <Button size="sm" variant="outline" onClick={() => { setDraft(doc.markdown); setEditRevision(doc.revision); setEditing(true); }}>{t("intent.edit")}</Button> : <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
        <Button size="sm" disabled={busy} onClick={() => {
          setBusy(true); setError("");
          void sddApi.writeDocument(work.id, "intent", draft, editRevision)
            .then(async () => { setEditing(false); await refresh(true); })
            .catch((error) => setError(String(error))).finally(() => setBusy(false));
        }}>{t("common.save")}</Button>
      </>}
    </div>}
    <div className="wb-intent-review-document" role="tabpanel">
      {editing ? <AtomicCodeMirrorEditor documentId={`${work.id}:intent:${editRevision}`} markdownSource={draft} extensions={imageExtensions} readOnly={busy} onMarkdownChange={setDraft} /> : doc ? <MarkdownView src={meaningful(doc.markdown) ? doc.markdown : t("intent.waitingDocument")} notePath={doc.path} /> : <Loader2 className="wb-spin" />}
    </div>
    {currentRun?.finalReport && <details className="wb-intent-history"><summary>{t("intent.agentReport")}</summary><MarkdownView src={currentRun.finalReport} /></details>}
    <details className="wb-intent-history"><summary>{t("intent.history")} · {review?.history.length ?? 0}</summary>
      <p>{t("intent.historyDescription")}</p>
      {review?.history.map((entry) => <button key={entry.id} disabled={editing || busy} onClick={() => setCheckpointId(entry.id)} aria-pressed={checkpointId === entry.id}>
        <span>{t(`intent.historyEvents.${entry.event}`, { defaultValue: entry.event })}</span><time>{new Date(entry.at).toLocaleString(i18n.language)}</time>
        {entry.note && <small>{entry.note}</small>}
      </button>)}
    </details>
    {!!runs.length && <details className="wb-intent-history"><summary>{t("intent.runHistory")} · {runs.length}</summary>
      {runs.map((run) => <button key={run.id} onClick={() => openRun(run)}><span>{t(`intent.runStatus.${run.status}`)}</span><time>{new Date(run.createdAt).toLocaleString(i18n.language)}</time></button>)}
    </details>}
  </section>;
}
