import { ArrowRight, Check, Inbox, MessageSquare, GitBranch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isLifecycleV2 } from "./lifecycle-v2";
import { taskStage, taskStages } from "./task-board";
import type { WorkItem, Project, WorkflowDefinition } from "./types";
import "./task-board.css";

type Props = { work: WorkItem[]; projects: Project[]; workflows: WorkflowDefinition[]; onSelectWork: (id: string) => void; selectedIds?: Set<string>; onToggle?: (id: string, checked: boolean) => void; selectionDisabled?: boolean };
export function TaskBoard({ work, projects, workflows, onSelectWork, selectedIds, onToggle, selectionDisabled }: Props) {
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
              return <article className="wb-task-card wb-board-card" key={item.id} data-selected={selectedIds?.has(item.id) || undefined}>
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
              </article>;
            })}
            {!members.length && <p className="wb-task-lane-empty">{t("taskBoard.emptyLane")}</p>}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

export function IntentInbox({ work, projects, onSelectWork, onNewWork }: Omit<Props, "workflows"> & { onNewWork: () => void }) {
  const { t } = useTranslation("workbench");
  return <section className="wb-intent-inbox" aria-label={t("taskBoard.inbox")}>
    <header><div className="wb-inbox-symbol"><Inbox size={22} /></div><div><h2>{t("taskBoard.inboxTitle")}</h2><p>{t("taskBoard.inboxHint")}</p></div></header>
    {work.length ? <div className="wb-inbox-notes">{work.map((item) => <article key={item.id}>
      <button onClick={() => onSelectWork(item.id)} aria-label={item.title}><small>{projects.find((p) => p.id === item.projectId)?.name ?? t("board.uncategorized")}</small><h3>{item.title}</h3>{item.description && <p>{item.description}</p>}<footer><span>{t("taskBoard.notYetTask")}</span><span>{t("taskBoard.readIntent")}<ArrowRight size={14} /></span></footer></button>
    </article>)}</div> : <div className="wb-inbox-empty"><p>{t("taskBoard.emptyInbox")}</p><button onClick={onNewWork}>{t("board.newWork")}<ArrowRight size={14} /></button></div>}
  </section>;
}
