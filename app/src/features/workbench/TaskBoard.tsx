import type { MouseEvent } from "react";
import { ArrowRight, Check, Inbox, Loader2, MessageSquare, GitBranch, Play, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isLifecycleV2 } from "./lifecycle-v2";
import { taskStage, taskStages, type TaskStage } from "./task-board";
import type { WorkItem, Project, WorkflowDefinition } from "./types";
import "./task-board.css";

export type QuickAction = "approve" | "revise" | "confirm" | "queue";
/**
 * 상세를 열지 않고 목록에서 바로 내리는 결정. 승인은 구현 대기로만 옮기고 실행은 시작하지 않으므로,
 * 승인만 해 두고 구현은 나중에 큐에 넣을 수 있다.
 */
export function QuickDecision({ item, stage, busy, disabled, onDecide }: {
  item: WorkItem; stage: TaskStage; busy: boolean; disabled: boolean;
  onDecide: (item: WorkItem, action: QuickAction) => void;
}) {
  const { t } = useTranslation("workbench");
  // 승인 흐름이 이 세 단계로 고정된 v2 작업에서만 즉시 결정을 제공한다.
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

type Props = { work: WorkItem[]; projects: Project[]; workflows: WorkflowDefinition[]; onSelectWork: (id: string) => void; selectedIds?: Set<string>; onToggle?: (id: string, checked: boolean) => void; selectionDisabled?: boolean; onWorkMenu?: (event: MouseEvent, item: WorkItem) => void; onDecide?: (item: WorkItem, action: QuickAction) => void; decidingId?: string | null; decisionsDisabled?: boolean };
export function TaskBoard({ work, projects, workflows, onSelectWork, selectedIds, onToggle, selectionDisabled, onWorkMenu, onDecide, decidingId, decisionsDisabled }: Props) {
  const { t } = useTranslation("workbench");
  const extra = (["discarding", "other"] as const).filter((stage) => work.some((w) => taskStage(w, workflows) === stage));
  return <section className="wb-task-board" aria-label={t("taskBoard.flow")}>
    <div className="wb-task-lanes">
      {[...taskStages, ...extra].map((stage, index) => {
        const members = work.filter((w) => taskStage(w, workflows) === stage);
        return <section className="wb-task-lane" key={stage} data-stage={stage} aria-label={t(`taskBoard.stages.${stage}`)}>
          <header className="wb-task-lane-head"><div><span className="wb-task-step">{stage === "done" ? <Check size={12} /> : index + 1}</span><h2>{t(`taskBoard.stages.${stage}`)}</h2><span className="wb-task-lane-count">{members.length}</span></div><p>{t(`taskBoard.hints.${stage}`)}</p></header>
          <div className="wb-task-card-stack">
            {members.map((item) => {
              const workflow = workflows.find((w) => w.id === item.workflowId && w.version === item.workflowVersion);
              const original = workflow?.nodes.find((n) => n.id === item.stage)?.label ?? item.stage;
              return <article className="wb-task-card wb-board-card" key={item.id} data-selected={selectedIds?.has(item.id) || undefined} onContextMenu={onWorkMenu ? (event) => onWorkMenu(event, item) : undefined}>
                {onToggle && <label className="wb-task-card-select"><input type="checkbox" checked={selectedIds?.has(item.id) ?? false} disabled={selectionDisabled} onChange={(e) => onToggle(item.id, e.target.checked)} aria-label={t("issues.selectRowAria", { id: item.id, title: item.title })} />{t("goal.select")}</label>}
                <button onClick={() => onSelectWork(item.id)} aria-label={item.title}>
                  <div className="wb-card-top"><span className="wb-work-card-id">{item.id}</span><span className={`wb-priority is-${item.priority}`}>{t(`priority.${item.priority}`)}</span></div>
                  <strong>{item.title}</strong>{item.description && <p>{item.description}</p>}
                  <div className="wb-task-card-flags">
                    {item.status === "blocked" && <span className="is-blocked"><MessageSquare size={12} />{t("taskBoard.needsAttention")}</span>}
                    {item.dependsOn.length > 0 && <span><GitBranch size={12} />{t("taskBoard.dependencies", { count: item.dependsOn.length })}</span>}
                    {!isLifecycleV2(item) && <span title={workflow?.label}>{original}</span>}
                  </div>
                  <footer><span>{projects.find((p) => p.id === item.projectId)?.name ?? t("board.uncategorized")}</span><span className="wb-task-card-next">{t(`taskBoard.next.${stage}`)}<ArrowRight size={12} /></span></footer>
                </button>
                {onDecide && <QuickDecision item={item} stage={stage} busy={decidingId === item.id} disabled={!!decisionsDisabled || !!decidingId} onDecide={onDecide} />}
              </article>;
            })}
            {!members.length && <p className="wb-task-lane-empty">{t("taskBoard.emptyLane")}</p>}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

export function IntentInbox({ work, projects, onSelectWork, onNewWork, onWorkMenu }: Omit<Props, "workflows"> & { onNewWork: () => void }) {
  const { t } = useTranslation("workbench");
  return <section className="wb-intent-inbox" aria-label={t("taskBoard.inbox")}>
    <header><div className="wb-inbox-symbol"><Inbox size={22} /></div><div><h2>{t("taskBoard.inboxTitle")}</h2><p>{t("taskBoard.inboxHint")}</p></div></header>
    {work.length ? <div className="wb-inbox-notes">{work.map((item) => <article key={item.id} onContextMenu={onWorkMenu ? (event) => onWorkMenu(event, item) : undefined}>
      <button onClick={() => onSelectWork(item.id)} aria-label={item.title}><small>{projects.find((p) => p.id === item.projectId)?.name ?? t("board.uncategorized")}</small><h3>{item.title}</h3>{item.description && <p>{item.description}</p>}<footer><span>{t("taskBoard.notYetTask")}</span><span>{t("taskBoard.readIntent")}<ArrowRight size={14} /></span></footer></button>
    </article>)}</div> : <div className="wb-inbox-empty"><p>{t("taskBoard.emptyInbox")}</p><button onClick={onNewWork}>{t("board.newWork")}<ArrowRight size={14} /></button></div>}
  </section>;
}
