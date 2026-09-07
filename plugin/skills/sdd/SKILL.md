---
name: sdd
description: Work on a Sawhorse SDD task using its intent, spec, plan, verification, release, and learning artifacts. Use for tasks launched by the Sawhorse harness or when asked to update an existing Sawhorse development artifact; ordinary scheduled routines use the workbench skill.
---

# Sawhorse SDD

Sawhorse owns the workspace schema and task transitions. The harness prompt supplies the task ID, repository, artifact paths, stage, role, and verification commands. Read those concrete files first; do not reconstruct requirements from a terminal title or assume another agent's context.

When invoked outside the harness, read `~/.claude/sawhorse/config.json` for `vaultPath`, then `.sawhorse/schema.json` in that vault. Version 1 uses:

- `projects/<id>/project.md`: repository, project dependencies, verification commands, default agent/model.
- `work/<id>/work.md`: task metadata, dependency IDs, dates, stage, status, decision history, and the issue axis — `issueType`, `executionType`, `labels`, `assignees`, `milestone`, `state`, `closed`, `github*`.
- Sibling artifacts named by the pinned workflow. The SDD chain is `intent.md`, `spec.md`, `plan.md`, `verification.md`, `release.md`, `learning.md`; the lighter `issue-main` workflow writes only `intent.md`, `spec.md`, `verification.md`.
- `calendar/<id>.md`: events, including milestones. A work item's `milestone` names one of them. `runs/<id>.md`: host-managed execution records.

There is no separate issue store. An issue **is** a work item seen from the request side, so never create or update `<프로젝트>/<이름>/이슈/*.md` as the record of work; those notes are a legacy input the app migrates on the user's request. `state` and `closed` are derived from `status` by the host — do not hand-edit them. `approve`, `approved`, and `approvalRequired` are legacy compatibility fields, not a separate approval control. The host records workflow decisions; do not edit these fields or ask users to toggle them.

Read the selected task and its dependencies. Work only in the scope authorized by the task and current user instruction. Edit the requested artifact files; retain headings and existing evidence, and re-read before writing if another agent may have changed the file. Do not rewrite host-managed IDs, decisions, stage/status, schema, or run identity to make a gate pass. Report an invalid schema or blocked dependency to the task owner.

## Deliverables by role

- Research: cite source paths and concrete findings; carry uncertainty and unresolved questions into `intent.md` or `spec.md` as requested.
- Planner: turn the accepted intent into `spec.md`, then a bounded `plan.md` with affected repositories, dependencies, acceptance criteria, and reproducible checks. Flag contradictory requirements.
- Implementer: follow the accepted spec and plan. Run the project's checks and record actual results in `verification.md`, including failures and environmental limitations.
- Verifier: compare the change against intent/spec/plan with a fresh review. Record commands, results, evidence paths and remaining risks in `verification.md`. An agent returning to its prompt is not evidence that tests passed.
- Reviewer: review the artifacts and change. Record deployment prerequisites/rollback in `release.md`, or observed outcomes/regression lessons in `learning.md`. Do not describe a planned release as shipped.

Operational findings should become a new intent through Sawhorse's task UI, with a link to the originating work and evidence. Completion of one artifact does not authorize deployment or remote publication; preserve the authorization in the current task.

## Child research

When the harness prompt explicitly supplies a child-request inbox and its JSON format, submit only supported roles and scope using a new request ID and the current run as parent. Read the resulting child run and its evidence before using its conclusions. The host validates requests, concurrency, ancestry, and role boundaries. If no inbox is supplied, use the app's child-run action; do not invent a schema or directly spawn untracked agents.

Finish with the changed artifact paths, checks actually run, results, and any remaining blocker. The app records review decisions and advances stages.
