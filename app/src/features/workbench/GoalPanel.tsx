import { WorkTypeField } from "./WorkTypeField";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { sddApi } from "./api";
import type { GoalState } from "./goals";
import type { HarnessRun, Project, WorkItem } from "./types";
import "./goals.css";

export function GoalComposer({ initial, projects, onClose, onSaved }: {
  initial: WorkItem; projects: Project[]; onClose: () => void; onSaved: (work: WorkItem) => void;
}) {
  const { t } = useTranslation("workbench");
  const [objective, setObjective] = useState(initial.description);
  const [issueType, setIssueType] = useState(initial.issueType || "작업");
  const projectId = initial.projectId;
  const [parallel, setParallel] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const id = useRef(`work-${crypto.randomUUID()}`);
  const submitting = useRef(false);
  const submit = async (start: boolean) => {
    if (submitting.current || !objective.trim() || !projectId) return;
    submitting.current = true; setBusy(true); setError("");
    try { onSaved(await sddApi.createGoal({ id: id.current, projectId, objective, maxParallel: parallel, start, workflowVersion: initial.workflowVersion, issueType })); }
    catch (e) { setError(String(e)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <Dialog open wide title={t("goal.title")} onClose={() => { if (!busy) onClose(); }}>
    <div className="wb-goal">
      <p>{t("form.project")}: {projects.find((project) => project.id === projectId)?.name} · v{initial.workflowVersion}</p>
      <h2>{t("goal.heading")}</h2><p>{t("goal.hint")}</p>
      <WorkTypeField value={issueType} onChange={setIssueType} disabled={busy} empty={!objective.trim()} onTemplate={setObjective} />
      <textarea aria-label={t("goal.objective")} placeholder={t("goal.placeholder")} value={objective} disabled={busy} onChange={(e) => setObjective(e.target.value)} rows={9} />
      <div className="wb-goal-actions">
        <label>{t("goal.parallel")}<input aria-label={t("goal.parallel")} type="number" min={1} max={16} value={parallel} disabled={busy} onChange={(e) => setParallel(Number(e.target.value))} /></label>
      </div>
      <p>{t("goal.retryHint")}</p>
      <div className="wb-goal-actions">
        <Button variant="outline" disabled={busy || !objective.trim() || !projectId || parallel < 1 || parallel > 16} onClick={() => void submit(false)}>{t("goal.save")}</Button>
        <Button disabled={busy || !objective.trim() || !projectId || parallel < 1 || parallel > 16} onClick={() => void submit(true)}>{t(busy ? "goal.saving" : "goal.start")}</Button>
      </div>
      {error && <p className="wb-inline-error" role="alert">{error}</p>}
    </div>
  </Dialog>;
}

export function GoalPanel({ work, onReload }: { work: WorkItem; onReload: () => Promise<void> }) {
  const { t } = useTranslation("workbench");
  const [states, setStates] = useState<GoalState[]>([]);
  const [runs, setRuns] = useState<HarnessRun[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [states, runs] = await Promise.all([sddApi.goalState(work.id), sddApi.runs()]);
        if (!disposed) { setStates(states); setRuns(runs); }
      } catch (e) { if (!disposed) setError(String(e)); }
      finally { if (!disposed) timer = setTimeout(() => void poll(), 3000); }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [work.id]);
  const control = async (id: string, action: "pause" | "resume" | "cancel") => {
    setBusy(true); setError("");
    try { await sddApi.goalControl(id, action); setStates(await sddApi.goalState(work.id)); await onReload(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const state = states[0];
  return <section className="wb-goal" aria-label={t("goal.title")}>
    <p>{t("goal.retryHint")}</p>
    {state && <>
      <div className="wb-goal-actions"><strong>{t(`goal.status.${state.status}`)}</strong><span>{t(`goal.phase.${state.phase}`)}</span><span>{t("goal.iterations", { count: state.iteration })}</span>
        {!['completed', 'cancelled'].includes(state.status) && <>
          <Button size="sm" disabled={busy} onClick={() => void control(work.id, state.status === "paused" ? "resume" : "pause")}>{t(state.status === "paused" ? "goal.resume" : "goal.pause")}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void control(work.id, "cancel")}>{t("goal.cancel")}</Button>
        </>}
      </div>
      <p>{t("goal.progress", { done: states.slice(1).filter((s) => s.status === "completed").length, total: state.tasks.length, parallel: state.maxParallel })}</p>
      {states.map((s) => {
        const run = runs.find((r) => r.id === s.runId);
        return <article className="wb-goal-task" key={s.workId}>
          <strong>{state.tasks.find((task) => task.id === s.workId)?.title ?? work.title}</strong>
          <span>{t(`goal.status.${s.status}`)} · {t(`goal.phase.${s.phase}`)}</span>
          {run && <small>{t("goal.claim", { agent: run.agent, id: run.id.slice(0, 8) })}</small>}
          {s.nextRetryAt && <p>{t("goal.nextRetry", { time: new Date(s.nextRetryAt).toLocaleString() })}</p>}
          {s.lastError && <p className="wb-goal-error">{s.lastError}</p>}
          {s.evidence && <details><summary>{t("goal.evidence")}</summary><pre>{s.evidence}</pre></details>}
          {s.status === "paused" && s.workId !== work.id && <Button size="xs" disabled={busy} onClick={() => void control(s.workId, "resume")}>{t("goal.resume")}</Button>}
        </article>;
      })}
    </>}
    {error && <p className="wb-inline-error" role="alert">{error}</p>}
  </section>;
}
