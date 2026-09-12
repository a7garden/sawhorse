import { workTypeKey } from "./WorkTypeField";
import type { MouseEvent } from "react";
import { ArrowRight, Check, Inbox, Loader2, MessageSquare, GitBranch, Play, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isLifecycleV2 } from "./lifecycle-v2";
import { taskStage, taskStages, usesLifecycleBoard, workflowBoardLanes, workflowBoardStage, type TaskStage } from "./task-board";
import type { WorkItem, Project, WorkflowDefinition } from "./types";
import "./task-board.css";

export type QuickAction = "approve" | "revise" | "confirm" | "queue";
/**
 * Decisions made straight from the list without opening the detail. Approving only moves to
 * awaiting-implementation and does not start the run, so approval can be given now and queue later.
 */
export function QuickDecision({ item, stage, busy, disabled, onDecide }: {
  item: WorkItem; stage: TaskStage; busy: boolean; disabled: boolean;
  onDecide: (item: WorkItem, action: QuickAction) => void;
}) {
  const { t } = useTranslation("workbench");
  // Offers instant decisions only on v2 work whose approval flow is fixed to these three stages.
  if (!isLifecycleV2(item) || !["approval", "unconfirmed", "queued"].includes(stage)) return null;
  const spin = busy ? <Loader2 className="wb-spin" size={12} /> : null;
  return <div className="wb-quick-decision" onClick={(event) => event.stopPropagation()}>
    {stage === "approval" && <>
      <button type="button" className="wb-quick-primary" disabled={disabled}
        title={t("taskBoard.decide.approveHint")} aria-label={t("taskBoard.decide.approveAria", { title: item.title })}
        onClick={() => onDecide(item, "approve")}>{spin ?? <Check size={12} />}{t("taskBoard.decide.approve")}</button>
      <button type="button" disabled={disabled}
        title={t("taskBoard.decide.reviseHint")} aria-label={t("taskBoard.decide.reviseAria", { title: item.title })}
        onClick={() => onDecide(item, "revise")}><Undo2 size={12} />{t("taskBoard.decide.revise")}</button>
    </>}
    {stage === "unconfirmed" && <button type="button" className="wb-quick-primary" disabled={disabled}
      aria-label={t("taskBoard.decide.confirmAria", { title: item.title })}
      onClick={() => onDecide(item, "confirm")}>{spin ?? <Check size={12} />}{t("taskBoard.decide.confirm")}</button>}
    {stage === "queued" && <button type="button" disabled={disabled}
      title={t("taskBoard.decide.queueHint")} aria-label={t("taskBoard.decide.queueAria", { title: item.title })}
      onClick={() => onDecide(item, "queue")}>{spin ?? <Play size={12} />}{t("taskBoard.decide.queue")}</button>}
  </div>;
}

type Props = { workflow?: WorkflowDefinition; work: WorkItem[]; projects: Project[]; workflows: WorkflowDefinition[]; onSelectWork: (id: string) => void; selectedIds?: Set<string>; onToggle?: (id: string, checked: boolean) => void; selectionDisabled?: boolean; onWorkMenu?: (event: MouseEvent, item: WorkItem) => void; onDecide?: (item: WorkItem, action: QuickAction) => void; decidingId?: string | null; decisionsDisabled?: boolean };
export function TaskBoard({ workflow: selectedWorkflow, work, projects, workflows, onSelectWork, selectedIds, onToggle, selectionDisabled, onWorkMenu, onDecide, decidingId, decisionsDisabled }: Props) {
  const { t } = useTranslation("workbench");
  const extra = (["discarding", "other"] as const).filter((stage) => work.some((w) => taskStage(w, workflows) === stage));
  const lifecycle = usesLifecycleBoard(selectedWorkflow);
  const lanes = lifecycle
    ? [...taskStages, ...extra].map((stage) => ({ id: stage, label: t(`taskBoard.stages.${stage}`), hint: t(`taskBoard.hints.${stage}`), done: stage === "done" }))
    : workflowBoardLanes(selectedWorkflow!, work).map((node) => ({ id: node.id, label: node.id === "done" ? t("status.done") : node.label, hint: t(`taskBoard.nodeKind.${node.kind}`), done: node.kind === "end" }));
  return <section className="wb-task-board" aria-label={t("taskBoard.flow")}>
    <div className="wb-task-lanes">
      {lanes.map((lane, index) => {
        const stage = lane.id;
        const members = work.filter((w) => (lifecycle ? taskStage(w, workflows) : workflowBoardStage(w, selectedWorkflow!)) === stage);
        return <section className="wb-task-lane" key={stage} data-stage={stage} aria-label={lane.label}>
          <header className="wb-task-lane-head"><div><span className="wb-task-step">{lane.done ? <Check size={12} /> : index + 1}</span><h2>{lane.label}</h2><span className="wb-task-lane-count">{members.length}</span></div><p>{lane.hint}</p></header>
          <div className="wb-task-card-stack">
            {members.map((item) => {
              const workflow = workflows.find((w) => w.id === item.workflowId && w.version === item.workflowVersion);
              const original = workflow?.nodes.find((n) => n.id === item.stage)?.label ?? item.stage;
              return <article className="wb-task-card wb-board-card" key={item.id} data-selected={selectedIds?.has(item.id) || undefined} onContextMenu={onWorkMenu ? (event) => onWorkMenu(event, item) : undefined}>
                {onToggle && <label className="wb-task-card-select"><input type="checkbox" checked={selectedIds?.has(item.id) ?? false} disabled={selectionDisabled} onChange={(e) => onToggle(item.id, e.target.checked)} aria-label={t("issues.selectRowAria", { id: item.id, title: item.title })} />{t("goal.select")}</label>}
                <button onClick={() => onSelectWork(item.id)} aria-label={item.title}>
                  <div className="wb-card-top"><span className="wb-work-card-id">{item.id}</span><span className={`wb-priority is-${item.priority}`}>{t(`priority.${item.priority}`)}</span></div>
                  <span className="wb-work-type-badge">{t(`issueType.${workTypeKey(item.issueType)}`)}</span><strong>{item.title}</strong>{item.description && <p>{item.description}</p>}
                  <div className="wb-task-card-flags">
                    {item.status === "blocked" && <span className="is-blocked"><MessageSquare size={12} />{t("taskBoard.needsAttention")}</span>}
                    {item.dependsOn.length > 0 && <span><GitBranch size={12} />{t("taskBoard.dependencies", { count: item.dependsOn.length })}</span>}
                    {!isLifecycleV2(item) && <span title={workflow?.label}>{original}</span>}
                  </div>
                  <footer><span>{projects.find((p) => p.id === item.projectId)?.name ?? t("board.uncategorized")}</span><span className="wb-task-card-next">{t(`taskBoard.next.${lifecycle ? stage : item.status === "done" ? "done" : "other"}`)}<ArrowRight size={12} /></span></footer>
                </button>
                {onDecide && <QuickDecision item={item} stage={taskStage(item, workflows)} busy={decidingId === item.id} disabled={!!decisionsDisabled || !!decidingId} onDecide={onDecide} />}
              </article>;
            })}
            {!members.length && <p className="wb-task-lane-empty">{t("taskBoard.emptyLane")}</p>}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

export function IntentInbox({ work, projects, onSelectWork, onNewWork, createLabel, onWorkMenu }: Omit<Props, "workflows"> & { onNewWork: () => void; createLabel: string }) {
  const { t } = useTranslation("workbench");
  return <section className="wb-intent-inbox" aria-label={t("taskBoard.inbox")}>
    <header><div className="wb-inbox-symbol"><Inbox size={22} /></div><div><h2>{t("taskBoard.inboxTitle")}</h2><p>{t("taskBoard.inboxHint")}</p></div></header>
    {work.length ? <div className="wb-inbox-notes">{work.map((item) => <article key={item.id} onContextMenu={onWorkMenu ? (event) => onWorkMenu(event, item) : undefined}>
      <button onClick={() => onSelectWork(item.id)} aria-label={item.title}><small>{projects.find((p) => p.id === item.projectId)?.name ?? t("board.uncategorized")}</small><h3>{item.title}</h3>{item.description && <p>{item.description}</p>}<footer><span>{t("taskBoard.notYetTask")}</span><span>{t("taskBoard.readIntent")}<ArrowRight size={14} /></span></footer></button>
    </article>)}</div> : <div className="wb-inbox-empty"><p>{t("taskBoard.emptyInbox")}</p><button onClick={onNewWork}>{createLabel}<ArrowRight size={14} /></button></div>}
  </section>;
}
