import type { WorkflowDefinition } from "./types";

/**
 * Published workflows are immutable; an old revision of an id remains only for opening items
 * already created, by digest. New projects can choose the latest revision per id;
 * new work inherits its project's exact revision until the project is updated.
 */

/** SemVer precedence, including prereleases; build metadata has no precedence. */
export function compareWorkflowVersions(a: string, b: string): number {
  const [aCore, ...aSuffix] = a.split("+")[0].split("-");
  const [bCore, ...bSuffix] = b.split("+")[0].split("-");
  const left = aCore.split(".").map((piece) => Number(piece) || 0);
  const right = bCore.split(".").map((piece) => Number(piece) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  if (!aSuffix.length || !bSuffix.length)
    return Number(!aSuffix.length) - Number(!bSuffix.length);
  const aPre = aSuffix.join("-").split(".");
  const bPre = bSuffix.join("-").split(".");
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    if (aPre[i] === undefined) return -1;
    if (bPre[i] === undefined) return 1;
    if (aPre[i] === bPre[i]) continue;
    const aNumeric = /^\d+$/.test(aPre[i]);
    const bNumeric = /^\d+$/.test(bPre[i]);
    if (aNumeric && bNumeric) {
      if (aPre[i].length !== bPre[i].length)
        return aPre[i].length - bPre[i].length;
    } else if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aPre[i] < bPre[i] ? -1 : 1;
  }
  return 0;
}

/** One entry per workflow, while retaining exact revisions for history/resume. */
export function groupWorkflowVersions(
  catalog: WorkflowDefinition[],
): WorkflowDefinition[][] {
  const groups = new Map<string, WorkflowDefinition[]>();
  for (const definition of catalog) {
    const versions = groups.get(definition.id) ?? [];
    versions.push(definition);
    groups.set(definition.id, versions);
  }
  return [...groups.values()].map((versions) =>
    versions.sort((a, b) => compareWorkflowVersions(b.version, a.version)),
  );
}

/** Retired purpose-specific bundles remain resolvable for existing runs only. */
export function isSelectableWorkflow(id: string): boolean {
  return !["bugfix-main", "refactor-main"].includes(id);
}

/** Keep an existing project's pin selectable without offering all historical revisions. */
export function workflowChoices(
  catalog: WorkflowDefinition[],
  current?: { id: string; version: string },
): WorkflowDefinition[] {
  const latest = latestWorkflowVersions(catalog);
  return catalog.filter(
    (item) =>
      isSelectableWorkflow(item.id) && (latest.get(item.id) === item.version ||
      (item.id === current?.id && item.version === current.version)),
  );
}

/** Latest version per workflow id. Computed from the catalog (built-ins + published files). */
export function latestWorkflowVersions(
  catalog: WorkflowDefinition[],
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const definition of catalog) {
    const current = latest.get(definition.id);
    if (!current || compareWorkflowVersions(definition.version, current) > 0)
      latest.set(definition.id, definition.version);
  }
  return latest;
}
