import { ArrowRight, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { creationWorkflow } from "./workflow-creation";
import { isClosedStatus, type Project, type WorkItem, type WorkflowDefinition } from "./types";

export function ProjectWorkOverview({ projects, work, workflows, onProject, onWork, onNewProject }: {
  projects: Project[]; work: WorkItem[]; workflows: WorkflowDefinition[];
  onProject: (id: string) => void; onWork: (id: string) => void; onNewProject: () => void;
}) {
  const { t } = useTranslation("workbench");
  const unassigned = work.filter((item) => !projects.some((project) => project.id === item.projectId));
  return <>
    <header className="wb-work-header">
      <div><h1>{t("scope.workOverview")}</h1><p>{t("scope.workOverviewHint")}</p></div>
      <Button variant="outline" onClick={onNewProject}>{t("projects.add")}</Button>
    </header>
    <div className="wb-project-work-grid">
      {projects.map((project) => {
        const items = work.filter((item) => item.projectId === project.id);
        const workflow = creationWorkflow(workflows, project);
        const counts = [
          ["open", items.filter((item) => !isClosedStatus(item.status)).length],
          ["running", items.filter((item) => item.status === "running").length],
          ["review", items.filter((item) => item.status === "review").length],
          ["blocked", items.filter((item) => item.status === "blocked").length],
        ] as const;
        return <article className="wb-project-work-card" key={project.id} aria-label={project.name}>
          <div className="wb-project-work-heading"><Folder size={19} /><h2>{project.name}</h2></div>
          <p>{project.description || t("scope.projectWorkHint")}</p>
          <div className="wb-project-work-flow"><span>{t("scope.projectWorkflow")}</span>
            <strong>{workflow?.label ?? project.workflowId} <small>v{project.workflowVersion}</small></strong>
          </div>
          <dl className="wb-project-work-counts">{counts.map(([key, count]) => <div key={key}><dt>{t(`scope.counts.${key}`)}</dt><dd>{count}</dd></div>)}</dl>
          <Button variant="outline" onClick={() => onProject(project.id)}>{t("scope.enterWorkbench")}<ArrowRight size={14} /></Button>
        </article>;
      })}
    </div>
    {!projects.length && <div className="wb-empty"><Folder size={28} /><strong>{t("projects.emptyTitle")}</strong><p>{t("creation.projectRequired")}</p><Button onClick={onNewProject}>{t("projects.add")}</Button></div>}
    {unassigned.length > 0 && <section className="wb-unassigned-work" aria-label={t("scope.unassignedWork")}>
      <h2>{t("scope.unassignedWork")} <small>{unassigned.length}</small></h2><p>{t("scope.unassignedHint")}</p>
      {unassigned.map((item) => <button key={item.id} className="wb-project-summary" onClick={() => onWork(item.id)}><strong>{item.title}</strong><ArrowRight size={14} /></button>)}
    </section>}
  </>;
}
