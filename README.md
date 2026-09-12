# Sawhorse

![Sawhorse — a deterministic, portable workflow platform](docs/images/sawhorse-overview.png)

**A local workflow platform that deterministically ports the way a team works.**

Sawhorse's core does not enforce a specific development methodology or artifact format. A workflow
defines stages, artifacts, human approvals, automated runs, and the required extensions and external
programs in one version. Carrying the same definition with pinned extension versions reproduces the
same sequence and gates in a different environment.

- Artifact-centric teams can define a waterfall flow that produces requirements, design, and mockups
  in sequence, decomposes them with Task Master, and runs them automatically.
- Agile teams can define a short flow that elaborates intent in `intent.md` and implements it after
  design approval.
- Only flows that need XLSX reporting or DOCX input declare those extensions and runtime tools such
  as Node.js or Pandoc.

The kanban board, calendar, Markdown editor, and execution harness all look at the same work items
and projects of the selected workflow. Data stays in local Markdown and can be edited and managed
with the app alone, without Obsidian. The only app-wide recommended integrations are Obsidian and
Herdr; everything else is an optional extension scoped to a workflow.

## Getting started

```bash
cd app
bun install
bun run tauri dev
```

When updating an existing installation, the first launch backs up and verifies the previous vault
and Sawhorse plugin, then upgrades them automatically. See
[Automatic upgrades and recovery](docs/architecture/automatic-upgrades.md).

On first launch, the setup wizard picks the workspace path where records are stored. In the
workbench, press **작업공간 초기화** (initialize workspace), then register folders under
**프로젝트** (projects). Names come from the folder; after saving, an agent analyzes and fills in
the description and verification command. The default model list is fetched from agent CLIs.
In **워크플로** (workflows), create or import your team's flow and apply it to a project. With the
bundled `intent-flow`, leave notes and images in **새 의도** (new intent) and request elaboration.
Review the direction, hand it over to design, and after design approval run the items waiting for
implementation in batch.

```bash
# UI-only preview: http://127.0.0.1:1420/?preview=1
bun run dev

# Verification
bun run build
bun run test:e2e
(cd src-tauri && cargo test --lib)

# Desktop distribution bundle
bun run tauri build
```

The browser preview stores its sample data in the browser. Real file access and agent execution
work only in the Tauri desktop app. The first UI test run requires `bunx playwright install chromium`.

## Default screens

Actual app screens with the English UI populated by a sample project and work. Reopen the same
setup with [running the capture demo and regenerating the images](docs/images/README.md).

![English process board with sample work progressing through Intent, Design, Build, Verify, and Deploy](docs/images/process-board.png)

<details>
<summary>Work detail — Markdown specification and agent execution context</summary>

![A Markdown specification beside the agent role, model, and execution context in Sawhorse](docs/images/work-detail.png)

</details>

| Screen | Function |
|---|---|
| Workbench | In-progress work, due dates, next work item, per-stage distribution |
| Work | List/process-board switching for the same work items, work item creation and editing, milestone/project/dependency links |
| Calendar | Month and list views, work due dates, milestone/review/deploy/meeting schedules |
| Work detail | Stage and decision history of the selected workflow, direct Markdown editing with the Atomic Editor |
| Work copilot | Q&A at the right of work detail over that item's documents and decision log (read-only queries through the configured agent) |
| Agent harness | Role and model selection, Herdr runs, parent and child runs, status and output logging |
| Projects | Folder selection (first folder is default), folder-derived names, analysis-filled description and verification command, CLI model list, default agent and model |
| Workflows | Editing stages, artifacts, and subflows; simulation; draft and immutable version publishing and export |
| Schemas | Editing document types, fields, paths, and templates; vault scan; preview/apply/rollback/activation of link and field changes |
| Project import | Snapshot of multiple code/document folders, per-file resume, evidence document drafts, conflict review and apply |
| Extensions | v2 package installation, dependency resolution, permission approval, project lock, portable export |
| Records and knowledge | Workspace Markdown search and artifact relocation |

The existing routine, job, collaboration session, review, source, RSS, terminal, and extension screens are retained as well.

## Default SDD flow: from intent to result confirmation

```text
Intent → Elaboration·interview → Design·interview → Awaiting approval → Ready to implement → Implementation → Done·unconfirmed → Done
source     brief.md         spec/plan        review decision    batch intake     verification·commit       user confirmation
```

Work detail shows the current stage, the next action, and the linked runs and per-stage document
history. The original intent and pre-edit documents, plus documents captured at design review, run
input, and result acceptance, are preserved separately under `work/<id>/history/`. If the intent,
design, or plan changes after approval, re-review is required before implementation runs and result
acceptance can proceed. History accumulates from when this feature was enabled; previously
overwritten past content is not restored. For the new flow's interviews, A2A, commit integration,
and dependency-based discarding, see [the SDD v2 lifecycle](docs/architecture/sdd-lifecycle-v2.md).
Existing v1 work items keep the [legacy intent flow](docs/architecture/intent-flow.md).

The projects screen registers, extracts, applies, and exports DESIGN.md and artifact templates.
The mockups view in the work screen manages the latest version alongside previous ones. Sawhorse's
own design guidelines are collected in [DESIGN.md](DESIGN.md).

## Bundled waterfall example: SDD flow

```text
Intent         Design     Implementation  Verification      Deployment·result acceptance
intent.md  →  spec.md  →  plan.md  →  verification.md  →  release.md
Follow-up intents discovered in operation are linked as new work items.
```

Work items progress through a single workflow; the status
(`접수 / 예정 / 진행 / 결과 검토 / 보류 / 완료 / 반려 / 취소` — intake / scheduled / in progress /
result review / on hold / done / rejected / canceled) summarizes that progress and the
acceptance/closing decisions. Status and approval checks are not edited separately.
Moving a stage forward checks the previous artifact's evidence and dependent work items and records
the review decision. Saving a document compares against the revision that was read, so content
changed by another edit is never silently overwritten.

Agent `idle` and `done` signals are recorded as **검토 대기** (awaiting review). Evidence of passing
tests or an actual deployment must be left in the verification and deployment artifacts. The app is
not a general-purpose CI service that auto-deploys arbitrary services or auto-merges remote
repositories; it connects the run, verification, and deployment procedures that fit the project.

## The workspace and workflows the app owns

```text
<vault>/
  .sawhorse/schema.json
  .sawhorse/workspace.json
  .sawhorse/schemas/<schema-id>/<revision>.json
  .sawhorse/workflows/<workflow-id>/<version>.json
  .sawhorse/extensions.lock.json
  .sawhorse/runtime.sqlite
  .sawhorse/evidence/
  .sawhorse/changes/<change-set-id>.json
  projects/<id>/project.md
  work/<id>/
    work.md
    intent.md
    spec.md
    plan.md
    verification.md
    release.md
    learning.md
  calendar/<id>.md
  runs/<id>.md
```

YAML frontmatter carries relationships and status; the body is a human-readable record. A project
selects the workflow to use, and a work item pins the exact version and content digest at creation
time. Re-running initialization never overwrites existing files or published workflow definitions,
and legacy `프로젝트/` (projects), `일지/` (journal), and `개념/` (concepts) folders are kept.
Existing documents are not converted into new work items automatically.

## Herdr and agents

To author workflows themselves from a terminal agent, use the **Sawhorse CLI + authoring skill**.
`sawhorse workflow` provides listing, schemas, validation, simulation, drafts, immutable
publishing, and project application, and `sawhorse skill install --agent codex` or `--agent claude`
distributes the authoring procedure. Standalone executables are provided for Windows and macOS and
work without launching the app. See [installation and command reference](docs/cli.md).

[Herdr](https://herdr.dev)'s persistent terminals are the foundation for runs. The harness detects
and runs the local agents Herdr supports, with selectable roles for research, planning,
implementation, verification, and review. Agents installed and executable on this PC are the
defaults; a per-project default model can be set or changed per run. The corresponding CLI must be
installed with a valid login.

Before a run starts, a Markdown ledger records the actual Herdr session, workspace, tab, pane, and
agent names. Reopening the app keeps tracking the same run, and identity is checked so that
processes in other panes are never controlled by mistake. When an agent waits for approval it is
shown as blocked. Sub-investigation requests are also validated by the host and managed as
independent run records.

The internal SDD and TDD skills judge subtask difficulty and delegate small research,
implementation, and verification work to Sonnet and complex reasoning to Opus. The parent model is
retained, and an explicitly chosen model takes precedence. In 설정 → 실행 (Settings → Runs) you can
pick automatic selection or parent-model inheritance, and the run detail records the reason for the
choice. Codex and custom models inherit the parent model of the same agent. See the
[policy, role, and limit design](docs/architecture/model-aware-delegation.md).

The legacy routine job runner remains separate. Existing headless jobs are Claude Code only, while
the new SDD harness runs the selected CLI through Herdr.

## Extensions and distribution

`app/` is the Tauri 2 + React desktop app; `plugin/` holds the bundled skills, packs, and hooks.
The SDD workbench is a default app feature and needs no separate pack installation.
`plugin/skills/sdd` and `plugin/skills/tdd` help agents follow the artifact and evidence
conventions of the selected workflow.

- `journal`: daily records, quick notes, work reports, and weekly retrospectives.
- `concepts`: creating, classifying, and linking concept notes.
- `todos`: a todo screen that surfaces journal checklists.
- `project-docs`: project documentation of proposals and the codebase.
- User packs: add them at `~/.sawhorse/packs/<id>/pack.json`.

A pack's unit is an independent feature, not an industry or a way of working. A pack declares
folders, templates, settings, actions, and extra screens; turning it off leaves the original notes
in place. The vault health check is an always-needed app-native feature, so it is provided
regardless of pack installation. The app and plugins share `~/.sawhorse/config.json`.

Unified extension package v2 installs from local folders/files, exact Git commits, or HTTPS. After
verifying the full payload SHA-256 and engine/semver dependencies, it records the requested
permissions and exact package digest in each project's lock. The app can re-export a portable
package for distribution over an internal file server or Git. `xlsx-export` is an optional
extension that appears only in projects where it is installed and activated.

Distribution uses Tauri bundles (dmg, deb/AppImage, Windows NSIS) and keeps the existing GitHub
tag-release workflow. For plugin-only use, install with `/plugin marketplace add a7garden/sawhorse`
followed by `/plugin install sawhorse@sawhorse`.

## Development and design documents
- [v2 design: app-independent document spaces, HTML originals, layered document app adapters](docs/architecture/v2-platform-design.md)

- [Goal mode: autonomous iteration until the goal is met, hourly token-recovery retries, shared work claiming](docs/architecture/goal-mode.md)

- [SDD product, storage, and harness design](docs/architecture/sdd-workbench.md)
- [SDD API and implementation contract](docs/architecture/sdd-contract.md)
- [Implementation validation and operational scope](docs/architecture/sdd-validation.md)
- [Extensible workflow platform design and implementation status](docs/architecture/workflow-platform-design.md)
- [App development guide](app/README.md)
- [Boundaries of workflows, schemas, and extensions, and the cleanup record](docs/architecture/extension-boundaries.md)
- [Pack authoring guide](plugin/packs/README.md)
- [Legacy collaboration and extension design](docs/superpowers/specs/2026-09-05-multi-agent-collaboration-design.md)
- [Connector SDK](docs/connector-sdk.md)

Designed for Sawhorse with reference to Anthropic's
[AI-Native SDLC Playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook). Markdown
editing uses the [Atomic Editor](https://github.com/kenforthewin/atomic-editor).
[zvec-grep](https://github.com/zvec-ai/zvec-grep) is a candidate optional semantic search provider;
the app's current search is exact search over local Markdown.

MIT License.
