import { create } from "zustand";
import type { Job } from "@/lib/types";
import type { Project, WorkItem, WorkflowDefinition } from "./types";

const STORAGE_KEY = "sawhorse.project-scope";
function readScope(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
}
export const useProjectScope = create<{
  projectId: string;
  selectProject: (id: string) => void;
}>((set) => ({
  projectId: readScope(),
  selectProject: (projectId) => {
    set({ projectId });
    try { localStorage.setItem(STORAGE_KEY, projectId); } catch { /* Optional UI preference. */ }
  },
}));

export function jobsForProject(jobs: Job[], project?: Project) {
  return project ? jobs.filter((job) => job.project === project.id || job.project === project.name) : jobs;
}

export function processKey(item: WorkItem) {
  const active = item.activeNodes?.[0];
  return `${active?.workflowId ?? item.workflowId}@${active?.workflowVersion ?? item.workflowVersion}`;
}
export function processStageKey(item: WorkItem) {
  return `${processKey(item)}:${item.activeNodes?.[0]?.nodeId ?? item.stage}`;
}

/** Only comparable process definitions share columns, including nested workflows and old versions. */
export function groupProcesses(work: WorkItem[], workflows: WorkflowDefinition[], project?: Project) {
  const groups = new Map<string, { key: string; workflow?: WorkflowDefinition; items: WorkItem[] }>();
  const ensure = (key: string) => {
    if (!groups.has(key)) groups.set(key, {
      key,
      workflow: workflows.find((definition) => `${definition.id}@${definition.version}` === key),
      items: [],
    });
    return groups.get(key)!;
  };
  if (project) ensure(`${project.workflowId}@${project.workflowVersion}`);
  for (const item of work) ensure(processKey(item)).items.push(item);
  return [...groups.values()];
}
