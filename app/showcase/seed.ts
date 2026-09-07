import type { Document, Project, WorkItem, WorkspaceSnapshot, WorkflowDefinition } from "../src/features/workbench/types";

// Fictional product-development work for documentation. Dates stay relative to
// today so that the real dashboard's deadline calculations remain meaningful.
const date = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const timestamp = `${date()}T08:00:00+09:00`;
const stages = ["intent", "design", "build", "test", "deploy"];
const roles = ["intent", "spec", "plan", "verification", "release"];
const labels = ["Intent", "Design", "Build", "Verify", "Deploy"];
const workflow: WorkflowDefinition = {
  definitionVersion: 1, id: "sdd-main", version: "1.1.0",
  label: "Product development", description: "From a clear intent to a verified release.", entry: "intent",
  artifacts: roles.map((role) => ({ role, label: role, path: `work/{workId}/${role}.md`, template: `# ${role}\n` })),
  nodes: stages.map((id, index) => ({
    id, label: labels[index], kind: index === 0 ? "artifact" : "agent",
    artifactRole: index === 0 ? "intent" : null, actionRef: index === 0 ? null : `sdd-${id}`,
    workflowRef: null, decision: null, inputs: index ? [roles[index - 1]] : [], outputs: [roles[index]],
    allowedRoles: ["research", "planner", "implementer", "verifier", "reviewer"],
    instructions: "Record the outcome and supporting evidence before moving forward.",
    requiresCompletedDependencies: index >= 2,
  })),
  edges: stages.slice(0, -1).flatMap((from, index) => [
    { from, to: stages[index + 1], on: "approved", condition: null, loopRef: null },
    { from: stages[index + 1], to: from, on: "revise", condition: null, loopRef: "revision" },
  ]),
  loops: [{ id: "revision", maxIterations: 20, onLimit: "pause" }],
};
const project = (id: string, name: string, description: string): Project => ({
  id, name, description, repoPath: `/projects/${id}`, extraPaths: [], githubRepos: [], dependsOn: [],
  verifyCommands: ["npm run build", "npm test"], defaultAgent: "codex", defaultModel: "",
  workflowId: workflow.id, workflowVersion: workflow.version, workflowDigest: "showcase-sdd-v1",
});
const item = (id: string, title: string, stage: string, status: WorkItem["status"], projectId: string, due: number): WorkItem => ({
  id, title, stage, status, projectId,
  description: "Keep the intent, implementation plan, and verification evidence connected in one local workspace.",
  priority: due <= 1 ? "high" : "normal", owner: "Alex", startDate: date(-3), dueDate: date(due),
  dependsOn: [], tags: ["product"], createdAt: timestamp, updatedAt: timestamp,
  decisions: stage === "intent" ? [] : [{ stage: "intent", at: timestamp, note: "Scope and acceptance criteria reviewed. Ready to proceed." }],
  artifacts: roles, workflowId: workflow.id, workflowVersion: workflow.version, workflowDigest: "showcase-sdd-v1",
  workflowInstanceId: null, activeNodes: [], issueType: "기능", executionType: "코드",
  labels: [], assignees: [], milestone: "launch", approvalRequired: true, approve: stage !== "intent",
  approved: stage !== "intent" ? date(-1) : "", state: status === "done" ? "closed" : "open",
  closed: status === "done" ? date() : "", githubRepo: "", githubNumber: "", githubUrl: "", githubState: "", githubUpdated: "",
});

export const snapshot: WorkspaceSnapshot = {
  schemaVersion: 1, initialized: true, vaultPath: "/demo/product-workspace", diagnostics: [],
  workflows: [workflow],
  projects: [
    project("atlas", "Atlas", "A thoughtful workspace for a small product team."),
    project("compass", "Compass", "Search and connect knowledge across projects."),
    project("relay", "Relay", "Reliable agent sessions with a complete execution history."),
  ],
  work: [
    item("command-menu", "Design a faster command menu", "design", "running", "atlas", 0),
    item("agent-resume", "Resume interrupted agent sessions", "build", "running", "relay", 1),
    item("markdown-editor", "Ship the live Markdown editor", "test", "running", "atlas", 2),
    item("search", "Search across project knowledge", "intent", "ready", "compass", 4),
    item("review-history", "Keep every review decision", "design", "running", "atlas", 3),
    item("run-timeline", "Connect runs to the work timeline", "build", "running", "relay", 4),
    item("calendar", "Plan milestones on the calendar", "intent", "backlog", "atlas", 6),
    item("local-links", "Resolve links between local notes", "test", "blocked", "compass", -1),
    item("onboarding", "Polish the first workspace setup", "deploy", "review", "atlas", 1),
    item("release-notes", "Publish the release checklist", "deploy", "done", "atlas", -2),
    item("workspace-import", "Import an existing project folder", "deploy", "done", "compass", -3),
    item("session-log", "Preserve the agent session log", "deploy", "done", "relay", -4),
  ],
  events: [
    { id: "design-review", title: "Command menu design review", date: date(), endDate: null, kind: "review", projectId: "atlas", workId: "command-menu", notes: "Review keyboard navigation, ranking, and empty states." },
    { id: "release-check", title: "Workspace release check", date: date(2), endDate: null, kind: "release", projectId: "atlas", workId: "onboarding", notes: "Check verification evidence and release notes." },
    { id: "launch", title: "Product workspace v1", date: date(6), endDate: null, kind: "milestone", projectId: "atlas", workId: null, notes: "Connect planning, agent execution, and local knowledge." },
  ],
};

export const documents: Record<string, Document> = {};
const descriptions: Record<string, string> = {
  "command-menu": "Find projects, work, and documents with a few keystrokes.",
  "agent-resume": "Restore the session and pick up from the last checkpoint.",
  "markdown-editor": "Edit local documents with a live, readable preview.",
  search: "Surface the right note with its project and source path.",
  "review-history": "Preserve the reasoning behind each approval and revision.",
  "run-timeline": "Follow agent activity from launch through verification.",
  calendar: "See deadlines, reviews, and release dates in one calendar.",
  "local-links": "Keep references intact when notes move between folders.",
  onboarding: "Guide a new project from folder selection to its first intent.",
  "release-notes": "Bundle acceptance evidence with a concise release summary.",
  "workspace-import": "Bring existing Markdown into a connected workspace.",
  "session-log": "Keep a durable record of each agent's work and results.",
};
for (const work of snapshot.work) {
  work.description = descriptions[work.id];
  for (const role of roles) {
    documents[`${work.id}/${role}`] = {
      workId: work.id, artifact: role, path: `work/${work.id}/${role}.md`, revision: "1",
      markdown: `# ${work.title}\n\n## Outcome\n${work.description}\n\n## Scope\n- Keep the interaction focused and keyboard accessible.\n- Preserve existing Markdown files and project links.\n- Attach review decisions and verification to this work item.\n\n## Acceptance criteria\n- [ ] The primary flow works without leaving the workspace.\n- [ ] Empty states explain the next available action.\n- [ ] Build and regression checks pass before acceptance.\n`,
    };
  }
}
documents["command-menu/spec"].markdown = `# A faster path to your work

## Why this matters
Finding a task should take a few keystrokes. Bring projects, work items, and local documents into one focused command menu.

## Interaction
1. Press **Cmd + K** anywhere in the workspace.
2. Type a project, task title, or phrase from a document.
3. Preview the match, then press **Enter** to open it.

## Design decisions
- Rank exact title matches before document excerpts.
- Keep the current project as an optional search scope.
- Show the document path so every result has context.
- Return focus to the previous view when dismissed.

## Acceptance criteria
- [x] Keyboard navigation and focus behavior specified.
- [x] Empty and loading states reviewed.
- [ ] Implementation and regression checks attached.
`;

export const todos = {
  date: date(), fileExists: true,
  today: [
    { index: 0, text: "Review the command menu design", checked: false },
    { index: 1, text: "Check the editor verification notes", checked: false },
    { index: 2, text: "Write the workspace release checklist", checked: true },
  ], tomorrow: [],
};
