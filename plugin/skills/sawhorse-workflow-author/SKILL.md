---
name: sawhorse-workflow-author
description: Create, edit, validate, simulate, and register Sawhorse workflow definitions using the sawhorse CLI. Use for adding or changing a workflow's stages, artifacts, transitions, or subworkflows; existing task execution uses its own workflow instructions.
---

# Sawhorse workflow author

Turn the user's process into a workflow that the Sawhorse app can open and use. Use the installed `sawhorse` console executable on macOS or Windows; the desktop app need not be running.

## Discover the actual contract

Run `sawhorse --version` and `sawhorse workflow --help`. Read `sawhorse workflow schema --json` and `sawhorse workflow list --json` when authoring. The CLI's schema and exported definitions are the contract for the installed version; do not invent node kinds, fields, roles, or events.

Pass `--vault "<workspace path>"` when the user selected a workspace. Otherwise `sawhorse workspace show --json` reports the resolved workspace. The CLI checks `--vault` / `SAWHORSE_VAULT`, the current folder's ancestors, then Sawhorse's configured vault. Do not change global configuration to target a different workspace. Use `--output` for generated JSON files so PowerShell redirection cannot change their encoding.

## Design and verify

Start from an appropriate definition using `workflow show ID@VERSION --json` or `workflow init NEW-ID --from ID@VERSION --output FILE`. Read the `data` field of JSON command results; output files contain the raw definition.

Translate the request into stages, artifact roles and templates, explicit transition events, and any review or rework paths. Keep the intended process and terminology. Use exact `workflowRef.id` and `workflowRef.version` for a subworkflow, and an explicit bounded loop for rework. A successfully completed child returns via the parent subworkflow node's `succeeded` event; inspect an exported composed workflow for the surrounding transitions. Artifact paths use `/`, with `{workId}` and `{projectId}` placeholders; operating-system paths passed as command arguments can be native Windows or macOS paths.

Run `workflow validate FILE --json` and fix reported `code` / `path` issues. Unpublished child definitions can be supplied with repeated `--dependency FILE` options. Validation failures have a nonzero exit status and a structured error result.

Create a JSON array of simulation events, for example `[{"event":"approved","facts":{}}]`, using the events and conditions actually present in the definition. Run `workflow simulate FILE --events EVENTS.json --require-complete --json`. Test the normal completion path and any meaningful rejection, loop-limit, or child-workflow paths added by this change. A `waiting` result means more events are needed; simulation does not execute real agents, commands, or human approvals.

## Register and hand off

Use `workflow draft save FILE --id DRAFT-ID --json` to make the draft visible in Studio. For an existing draft, first read `workflow draft show DRAFT-ID --json`, edit its definition, and save with `--expected-revision REVISION`. If a revision conflict occurs, reload and reconcile the edits; do not silently overwrite the newer definition or retry with a newly fetched revision without reviewing it.

Publish with `workflow publish FILE --json`; for unpublished subworkflows pass all definitions in the same call (`workflow publish PARENT.json CHILD.json --json`). `--dry-run` checks the exact batch without writing. Published ID/version pairs are immutable; changes require a new SemVer version. Repeating publication of identical content is safe.

If the user's request includes applying the workflow to a project, use `project list --json`, then `project show PROJECT-ID --json` and `workflow activate ID@VERSION --project PROJECT-ID --expected-revision REVISION --json`. Activation selects the default for new tasks; existing tasks keep their pinned version. Existing user authorization is sufficient: do not add a mandatory approval question between validation and the requested local registration or application.

Report the workspace, workflow ID/version, draft ID or publication result, simulation coverage, and project selection when changed. The user can continue editing the same draft in Sawhorse's Workflow Studio.

## Result handling

`--json` produces one UTF-8 JSON object on stdout: `{ "schemaVersion": 1, "ok": true, "data": ... }` or `{ "schemaVersion": 1, "ok": false, "error": { "code": ..., "message": ..., "details": ... } }`. Exit codes: 0 success, 1 I/O or operation failure, 2 usage/invalid input, 3 validation or simulation failure, 4 conflict or workspace busy. A busy lock can be retried after the other writer finishes; reconcile a content conflict before retrying.
