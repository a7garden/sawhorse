import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/pages/common";
import { sddApi, workflowApi } from "./api";
import { launchIntent } from "./intent";
import { isClosedStatus, type HarnessRun, type Project, type WorkItem } from "./types";

export function IntentFlowPanel({ work, project, onReload, onDirtyChange }: {
  work: WorkItem; project?: Project; onReload: () => Promise<void>; onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation("workbench");
  const [review, setReview] = useState<Awaited<ReturnType<typeof sddApi.intentReview>> | null>(null);
  const [tab, setTab] = useState(work.stage === "build" ? "verification" : "intent");
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [loadedRuns, setLoadedRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const actionLock = useRef(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editRevision, setEditRevision] = useState("");
  useEffect(() => { onDirtyChange(editing); return () => onDirtyChange(false); }, [editing, onDirtyChange]);
  const building = work.stage === "build";
  const closed = isClosedStatus(work.status);
  const active = runs.some((run) => ["starting", "running", "blocked"].includes(run.status));
  const currentRun = runs.filter((run) => run.stage === work.stage).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const refresh = useCallback(async () => {
    const next = await sddApi.intentReview(work.id);
    setReview(next);
    return next;
  }, [work.id]);
  useEffect(() => {
    let alive = true;
    sddApi.intentReview(work.id).then((next) => { if (alive) setReview(next); }).catch((error) => { if (alive) setError(String(error)); });
    return () => { alive = false; };
  }, [work.id, work.stage]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let previous = "";
    const poll = async () => {
      try {
        const next = (await sddApi.runs()).filter((run) => run.workId === work.id && !run.parentRunId);
        if (!alive) return;
        setRuns(next); setLoadedRuns(true);
        const signature = next.map((run) => `${run.id}:${run.status}`).join("|");
        if (previous && previous !== signature) await refresh();
        previous = signature;
      } catch (error) { if (alive) { setLoadedRuns(false); setError(String(error)); } }
      if (alive) timer = setTimeout(() => void poll(), 4000);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [work.id, refresh]);
  const doc = review?.documents.find((document) => document.artifact === tab);
  const substantial = (role: string) => !!review?.documents.find((document) => document.artifact === role)?.markdown
    .replace(/<!--[\s\S]*?-->/g, "").split("\n").some((line) => line.trim() && !line.trim().startsWith("#"));
  async function act(action: "run" | "approve" | "complete" | "revise") {
    if (actionLock.current || !review || active || !loadedRuns) return;
    actionLock.current = true; setBusy(true); setError("");
    let transitioned = false;
    try {
      if (action === "complete") {
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
            note: feedback.trim() || t("intent.approvalNote"), eventId: crypto.randomUUID(), inputDigest: review.inputDigest });
          transitioned = true;
          setTab("verification");
        }
        await launchIntent(current, project, action === "approve" ? "" : feedback.trim());
        setFeedback("");
        setRuns((await sddApi.runs()).filter((run) => run.workId === work.id && !run.parentRunId));
      }
    } catch (error) { setError(`${transitioned ? t("intent.approvedLaunchFailed") + " " : ""}${String(error)}`); }
    finally { try { await onReload(); } finally { actionLock.current = false; setBusy(false); } }
  }
  return <section className="wb-intent-flow">
    <div className="wb-intent-flow-head"><div><h3>{t(closed ? "intent.finished" : building ? "intent.build" : "intent.design")}</h3>
      <p>{t(building ? "intent.buildHint" : "intent.reviewHint")}</p></div>
      <Button size="sm" variant="outline" disabled={busy || editing} onClick={() => { void refresh().catch((error) => setError(String(error))); }}><RefreshCw />{t("intent.refresh")}</Button>
    </div>
    {currentRun && <div className="wb-intent-run" role="status">{active && <Loader2 className="wb-spin" size={14} />}
      {t(`intent.runStatus.${currentRun.status}`)}{currentRun.error && <span>{currentRun.error}</span>}</div>}
    <div className="wb-artifact-nav" role="tablist">{["intent", "spec", "plan", "verification"].map((role) =>
      <button disabled={editing} key={role} role="tab" aria-selected={tab === role} className={tab === role ? "active" : ""} onClick={() => setTab(role)}>{t(`intent.docs.${role}`)}</button>)}</div>
    {tab === "intent" && !closed && !active && !building && doc && <div className="wb-intent-footer">
      {!editing ? <Button size="sm" variant="outline" onClick={() => { setDraft(doc.markdown); setEditRevision(doc.revision); setEditing(true); }}>{t("intent.edit")}</Button> : <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>{t("common.cancel")}</Button>
        <Button size="sm" disabled={busy} onClick={() => {
          setBusy(true); setError("");
          void sddApi.writeDocument(work.id, "intent", draft, editRevision)
            .then(async () => { setEditing(false); await refresh(); })
            .catch((error) => setError(String(error))).finally(() => setBusy(false));
        }}>{t("common.save")}</Button>
      </>}
    </div>}
    <div className="wb-intent-review-document" role="tabpanel">
      {editing ? <AtomicCodeMirrorEditor documentId={`${work.id}:intent:${editRevision}`} markdownSource={draft} readOnly={busy} onMarkdownChange={setDraft} /> : doc ? <MarkdownView src={doc.markdown || t("intent.waitingDocument")} notePath={doc.path} /> : <Loader2 className="wb-spin" />}
    </div>
    {!closed && <>
      <textarea className="wb-intent-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} aria-label={t("intent.feedback")} placeholder={t("intent.feedbackHint")} disabled={busy || editing || active} />
      <div className="wb-intent-footer">
        <span className="wb-intent-help">{!project ? t("intent.projectHint") : t("intent.agent", { agent: project.defaultAgent, model: project.defaultModel || t("intent.defaultModel") })}</span>
        <Button variant="outline" disabled={busy || editing || active || !loadedRuns || !review || !project || ["blocked", "review"].includes(work.status)} onClick={() => void act("run")}><Play />{t(building ? "intent.retryBuild" : currentRun ? "intent.reviseDesign" : "intent.requestDesign")}</Button>
        {!building && <Button disabled={busy || editing || active || !loadedRuns || !project || work.status === "blocked" || !!feedback.trim() || !substantial("spec") || !substantial("plan")} onClick={() => void act("approve")}>
          {busy ? <Loader2 className="wb-spin" /> : <Check />}{t("intent.approveBuild")}</Button>}
        {building && <Button variant="outline" disabled={busy || editing || active || !loadedRuns || !project || work.status === "blocked"} onClick={() => void act("revise")}>{t("intent.backToDesign")}</Button>}
        {building && <Button disabled={busy || editing || active || !loadedRuns || !["running", "review"].includes(work.status) || !substantial("verification")} onClick={() => void act("complete")}><Check />{t("intent.acceptResult")}</Button>}
      </div>
    </>}
    {error && <div className="wb-inline-error" role="alert">{error}</div>}
  </section>;
}
