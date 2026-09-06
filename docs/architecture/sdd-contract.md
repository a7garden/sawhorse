# Sawhorse SDD workbench — implementation contract

The host owns the SDLC schema. React/Tauri desktop stays the distribution; packs extend policies/skills but cannot redefine core work fields. Markdown is canonical and Obsidian optional. No user vault is automatically rewritten during development.

## Storage and stages

`<vault>/.sawhorse/schema.json` version 1; `<vault>/projects/<id>/project.md`; `<vault>/work/<id>/work.md` (YAML frontmatter plus description), sibling artifacts `intent.md`, `spec.md`, `plan.md`, `verification.md`, `release.md`, `learning.md`; `<vault>/calendar/<id>.md`; `<vault>/runs/<id>.md` plus transcript markdown.

Stages: plan, design, build, test, deploy, maintain. Board status independently: backlog, ready, running, review, blocked, done. Priorities: urgent, high, normal, low. Artifacts are versioned documents, editor returns revision for optimistic concurrency. All writes validate IDs, dates, refs, no dependency cycles, no escapes or symlink escapes. Unknown/future schema versions rejected. Initialization idempotent, existing content preserved. Missing schema is explicit initialization UI. Legacy folders untouched; canonical core schema mandatory for new work.

## TypeScript contracts

`app/src/features/workbench/types.ts` is owned by parent and authoritative JSON contract. Keys camelCase, optional values use null in Rust. Backend domain in `sdlc.rs` (store agent), harness in `sdlc_harness.rs` (harness agent); each exports #[tauri::command] functions. Parent registers modules/commands in lib.rs. Frontend API in api.ts owned by parent.

Commands (argument names exact):
- sdd_snapshot() => WorkspaceSnapshot (must return initialized false when no schema, errors diagnostics for corrupt individual work docs, no silent data loss)
- sdd_initialize() => WorkspaceSnapshot
- sdd_save_project(input: Project) => Project (id empty => generate)
- sdd_save_work(input: WorkItem) => WorkItem (id empty => generate, preserve stage on update; stage changes only transition)
- sdd_transition(id: string, stage: Stage, note?: string) => WorkItem (adjacent forward/back; require prior artifact substantive content, review decision explicit, unfinished dependency blocks build and later; append decision ledger)
- sdd_read_document(workId: string, artifact: ArtifactKind) => Document
- sdd_write_document(workId: string, artifact: ArtifactKind, markdown: string, revision: string) => Document (CAS; templates not evidence)
- sdd_save_event(input: CalendarEvent) => CalendarEvent
- sdd_delete_event(id: string) => void
- sdd_search(query: string) => SearchHit[] (local exact ranked search across canonical markdown, source path+snippet)
- sdd_launch(input: LaunchInput) => HarnessRun
- sdd_runs() => HarnessRun[]
- sdd_refresh_run(id: string) => HarnessRun
- sdd_stop_run(id: string) => HarnessRun
- sdd_run_output(id: string) => string
- sdd_continue_run(id: string, instructions: string) => HarnessRun (explicit user follow-up to settled owned agent)
- sdd_run_key(id: string, key: string) => HarnessRun (explicit user key to blocked owned agent; allowlist only)

Backend sdlc.rs exports to harness:
`pub fn vault_root() -> Result<PathBuf,String>` configured config::load_view().vault_path;
`pub fn snapshot(root: &Path) -> Result<WorkspaceSnapshot,String>`;
`pub fn read_document(root: &Path, work_id: &str, artifact: &str) -> Result<Document,String>`;
`pub fn validate_id(id: &str) -> Result<(),String>`;
Model structs public fields snake_case serde camelCase; stage/status strings validated by domain.

## Harness behavior

Herdr CLI using crate::herdr::Herdr and config HerdrCfg; launch chosen claude/codex kind with optional model, role (research, planner, implementer, verifier, reviewer), workId/projectId, optional parentRunId. Explicit stage prompt with artifact paths, repo paths, dependency context and validation commands. Herdr creates a workspace/tab per owned context, records exact pane/name/session; start readiness then prompt. All shell args passed as args not interpolation. No auto-approval of agent dialogs. Persist run BEFORE launching and each lifecycle change, preserve failures and output evidence; idle/done means review, never verification passed. Can stop only owned recorded agents; restart recovers via exact identity. Dependency and stage gates validated server side before launch. Do not automatically deploy/merge. Parent-child runs visible; a running agent may create an inbox request for child research, but implement only if it can be durable/validated. No fake runtime in desktop UI.

## UI ownership

Frontend agent owns new pages and components ONLY under app/src/features/workbench/, except types.ts/api.ts parent owned. Export default `WorkbenchPage({view})` where view = overview|board|calendar|harness|knowledge|projects. Korean copy. Complete work CRUD, project dependencies, kanban filters and drag/drop status, month/agenda calendar event CRUD, work detail with 6 stage stepper and artifacts markdown editor/preview, gates and run launcher, harness queue/output/child action, global knowledge search with document jumps. Empty/error/loading states honest. Do not edit App.tsx/store.ts or package files (parent integrates). Use existing React/lucide/UI primitives and CSS module or workbench.css. Browser preview may use opt-in fixture adapter owned by parent, never silent desktop fallback.

## Verification

Meaningful Rust tempdir tests for CAS/path safety/frontmatter roundtrip/cycle/gates/date/schema recovery and harness prompt/lifecycle parsing. Frontend build, manual/browser full flow. Each agent reports exact commands and limitations. Do not commit or modify unrelated files. Do not use subagents recursively.
