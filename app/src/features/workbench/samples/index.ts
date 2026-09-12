import data from "./data.json";
import definitions from "./workflows.json";
import type { CalendarEvent, Document, Project, WorkItem, WorkflowDefinition, WorkspaceSnapshot } from "../types";
import type { GoalState } from "../goals";
import type { LifecycleState } from "../lifecycle-v2";

export interface SampleReport {
  createdProjects: string[];
  skippedProjects: string[];
  workItems: number;
  documents: number;
  events: number;
}

interface SampleData {
  projects: Project[];
  work: WorkItem[];
  events: CalendarEvent[];
  documents: Record<string, Document>;
  goals: Record<string, GoalState>;
  lifecycle: Record<string, LifecycleState>;
}

export function sampleData(today = new Date()): SampleData {
  const source = JSON.stringify(data).replace(/\{\{day:(-?\d+)\}\}/g, (_, offset: string) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Number(offset));
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  });
  const samples = JSON.parse(source) as SampleData;
  // Classification codes use the current application's localized vocabulary;
  // all authored content in the shared bundle remains portable English.
  for (const work of samples.work) {
    work.issueType = ({ task: "작업", bug: "버그", feature: "기능", question: "질문" } as Record<string, string>)[work.issueType] ?? work.issueType;
    work.executionType = ({ code: "코드", research: "조사", document: "문서", discussion: "협의", decision: "결정" } as Record<string, string>)[work.executionType] ?? work.executionType;
  }
  return samples;
}

/** Same additive contract as the desktop importer; edited projects are skipped. */
export function installPreviewSamples(store: {
  snapshot: WorkspaceSnapshot;
  documents: Record<string, Document>;
  goals?: Record<string, GoalState>;
  lifecycle?: Record<string, LifecycleState>;
}): SampleReport {
  const samples = sampleData();
  const report: SampleReport = { createdProjects: [], skippedProjects: [], workItems: 0, documents: 0, events: 0 };
  for (const project of samples.projects) {
    if (store.snapshot.projects.some((item) => item.id === project.id)) {
      report.skippedProjects.push(project.id);
      continue;
    }
    const items = samples.work.filter((item) => item.projectId === project.id);
    for (const item of items) {
      if (store.snapshot.work.some((existing) => existing.id === item.id)) continue;
      store.snapshot.work.push(item);
      report.workItems++;
      for (const [key, document] of Object.entries(samples.documents).filter(([, document]) => document.workId === item.id)) {
        if (!store.documents[key]) { store.documents[key] = document; report.documents++; }
      }
      if (samples.goals[item.id]) (store.goals ??= {})[item.id] ??= samples.goals[item.id];
      if (samples.lifecycle[item.id]) (store.lifecycle ??= {})[item.id] ??= samples.lifecycle[item.id];
    }
    for (const event of samples.events.filter((event) => event.projectId === project.id)) {
      if (!store.snapshot.events.some((existing) => existing.id === event.id)) {
        store.snapshot.events.push(event); report.events++;
      }
    }
    const definition = definitions.find((definition) => definition.id === project.workflowId && definition.version === project.workflowVersion)!;
    if (!store.snapshot.workflows.some((existing) => existing.id === definition.id && existing.version === definition.version))
      store.snapshot.workflows.push(definition as WorkflowDefinition);
    store.snapshot.projects.push(project);
    report.createdProjects.push(project.id);
  }
  return report;
}
