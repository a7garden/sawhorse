---
name: delegate
description: Automatically assess and delegate bounded Sawhorse harness subtasks to an appropriate model through the host child-request inbox. Use during SDD or TDD work when splitting research, implementation, or verification reduces total work.
---

# Sawhorse model-aware delegation

Make the decomposition and model assessment yourself; do not ask the user to classify tasks or pick a child model. The parent retains the project's chosen model and owns integration and final verification. Optimize total context, retries, and coordination cost, not just the number of child agents. Do tiny edits and short lookups locally when handing them off would cost more than completing them.

Use the child inbox and limits supplied by the harness. Outside the harness, complete the work locally unless a tracked child-run interface is supplied. Never launch untracked Herdr panes or native subagents to bypass the host's limits. Existing user model choices and scope take precedence.

## Assess a bounded task

Read the relevant intent, constraints, and enough code to make an informed assessment. Choose the smallest useful task with a concrete result and check:

| complexity | Use when | Automatic Claude model |
|---|---|---|
| `routine` | Focused source lookup, log extraction, a mechanical change with an established pattern | Sonnet |
| `standard` | Bounded implementation or regression check with clear acceptance criteria and known interfaces | Sonnet |
| `complex` | Cross-module design, ambiguous requirements, concurrency/security reasoning, or a failed cheaper attempt that needs deeper reasoning | Opus |

Judge uncertainty, coupling, and verification difficulty, not prompt length or role alone. Keep architecture decisions with the parent when it already has the necessary context. Do not send a whole conversation or entire repository to every child; supply relevant paths, constraints, a bounded question/change, and acceptance checks.

When policy is `auto`, submit `model: ""` and `modelAssessment: {"complexity":"standard","reason":"Named helper and caller are understood; the existing regression test verifies the behavior."}`. Write a task-specific reason in the user's language. The host resolves supported Claude models. With `inherit`, it retains the parent's model. Codex and custom/provider models inherit within the same agent because no cheaper-model mapping is configured. Never invent a model ID or claim a cost reduction without measured usage. Set a nonempty `model` only to honor an explicit model choice from the user.

## Submit and integrate

Write one new UUID-named JSON request using the concrete IDs and inbox path in the harness prompt:

```json
{
  "requestId": "<new UUID>",
  "parentRunId": "<current run ID>",
  "workId": "<current work ID>",
  "projectId": "<current project ID>",
  "role": "research",
  "agent": "",
  "model": "",
  "modelAssessment": { "complexity": "routine", "reason": "Explain this task's bounded scope and observable check." },
  "instructions": "A self-contained bounded task: relevant paths, scope, expected evidence and actual verification commands."
}
```

`agent: ""` inherits the parent agent. Roles are `research`, `verifier`, or `implementer`; only an implementer parent can delegate implementation, and the current workflow node must allow it. Delegate concrete source/test file paths to an implementer and **pause your own code edits until it settles**. Only one child implementer may be active in a run tree. Research and verifier children do not edit source, tests, or canonical artifacts. Every child writes its findings/checks to its own `runs/<childRunId>.evidence.md`; the parent integrates those findings into workflow artifacts after reviewing them.

Read the same request file for `accepted`/`rejected`, `runId`, and `error`. Reuse its requestId only when recovering an uncertain submission; do not duplicate an accepted task. Read `runs/<runId>.md` and the child's evidence file to collect results. Stay active while awaiting children, using bounded waits with progress updates rather than ending the parent turn or busy polling. Never mark idle/review as proof of correctness. If the inbox is rejected for concurrency or depth/budget, perform the work locally instead of repeatedly submitting requests or waiting indefinitely. The concurrency limit includes the parent; a limit of 1 prevents delegation.

If a Sonnet result fails a concrete acceptance check because deeper reasoning is needed, document the failed check and prior run ID and submit **at most one** replacement for that subtask with `complexity: "complex"`, after the earlier child settles. Do not escalate authentication, quota, unavailable-model, approval, or environment failures by spawning more agents. After a failed escalation, the parent handles the remaining work or reports the concrete blocker. Keep escalation inside the host's tree budget and depth limits.

Finish with the reviewed result, checks actually run, and material limitations. Model aliases are launch requests; they do not prove the provider's resolved version or token savings.
