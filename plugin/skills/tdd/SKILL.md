---
name: tdd
description: Execute a Sawhorse TDD workflow node using revision-bound Red, Green, refactor, and regression evidence. Use for tasks launched with the tdd-cycle workflow; use sdd for the outer intent-to-release workflow.
---

# Sawhorse TDD

The harness prompt is the authority for the workflow version, current node, repository, allowed output artifacts, validation commands, and user scope. Read the named task and artifact paths before changing code. Do not infer a different workflow from filenames or modify host-managed workflow, stage, decision, schema, or run records.

Apply the sibling [delegate skill](../delegate/SKILL.md) when a bounded implementation or verification task benefits from delegation. Assess complexity yourself and let the host choose the child model. Preserve the Red → Green → refactor → reverify order: never parallelize dependent phases, and verify the revision after integrating a child's changes. Children report in their own run evidence file; the parent updates canonical TDD evidence. The harness's child-specific output and role limits take precedence over the general artifact instructions below.

Keep each cycle tied to one observable behavior and the exact code/test revision:

- Test intent: state the behavior, relevant acceptance criterion, and regression boundary.
- Red: add or change the smallest useful assertion, then run it. Record the command, target assertion, exit result, and enough output to show that the assertion failed for the intended missing behavior. A test discovery failure, build error, dependency failure, timeout, or environment error is not Red evidence.
- Green: make the minimum implementation change that satisfies the approved test. Run the target test and relevant nearby regression checks. Record commands, results, and the tested revision in `green-evidence`.
- Refactor: improve structure without broadening behavior. Explain any non-obvious choice in `refactor` and preserve user-authored content.
- Reverify: rerun the target test and relevant regression checks after refactoring. Record the actual results and revision in `regression`; never reuse evidence from an earlier revision.

Sawhorse parses these evidence lines outside HTML comments before allowing the corresponding transition. Keep the keys exact and put narrative/output around them as needed:

```text
# red-evidence
result: failed
failureKind: assertion
command: <actual command>
exitCode: <non-zero integer>
testRevision: <7-64 hexadecimal commit or content hash>

# green-evidence and regression
result: passed
command: <actual command>
exitCode: 0
codeRevision: <7-64 hexadecimal commit or content hash>
```

Do not write `failureKind: assertion` when the observed cause was compilation, discovery, setup, timeout, dependency, or environment failure. The structured fields are an indexable summary, not a substitute for preserving the relevant test output and explaining why it proves the intended behavior.

If Green fails, remain in the Green/Red loop and report the concrete failure. If a new behavior is needed after successful verification, request the workflow's bounded next-test loop. Do not turn unrelated existing failures into invented success, weaken assertions merely to get Green, or claim completion from an idle agent state.

Respect the node's declared output roles. Code may be changed only when the current node and user scope authorize implementation. Deployment, merging, remote publication, approval dialogs, and workflow transitions remain host or user actions unless separately authorized.

Finish with changed paths, exact checks and outcomes, revision identifiers when available, and any missing or stale evidence.
