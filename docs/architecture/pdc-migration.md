# Portable Document Contract Migration

Status: priority 1 document-plane migration — Stage 0 (boundary and fixtures) implemented; Stages 1–4 pending  
Contract: `pdc-document/1`, authoritative repository `github.com/a7garden/portable-document-contract` (public draft 4, 2026-09-13, conformance corpus revision 3, pinned at commit 6481ef0e2fb44cae969ecbf5e3d57fd253c77e4b)
Target capabilities: Full Reader; Djot and HTML Writer/Mutator for the authored document plane

This plan governs Sawhorse documents that users understand as portable authored artifacts. It does not convert operational records into documents. The external `portable-document-contract` repository is authoritative; contract changes land there before Sawhorse behavior defines them implicitly.

## Plane boundary

### In scope

- User-authored work artifacts such as intent, specification, plan, notes, and other workflow-declared document bodies.
- User-authored project, calendar, journal, and concept documents when their product role is a portable document rather than an operational record.
- `shdoc/1` documents whose authored HTML structure is user content.
- Registered document-space content intended to open in another participating application.

### Out of scope

- `.sawhorse/` configuration, locks, ChangeSets, evidence CAS, runtime databases, collaboration state, and upgrade journals.
- Run records, approval snapshots, queues, generated evidence, prompts, caches, and generated previews.
- Workflow/project/work metadata whose purpose is machine state rather than authored document content.

Approval and workflow status remain ledger facts. A checkbox or document field never grants approval or replaces an operational record.

## Current state

- The dominant store is Markdown plus YAML frontmatter, discovered through workflow and directory conventions.
- Structured work/project records deserialize into typed Rust structures and may discard unknown frontmatter on reserialization.
- Raw artifact documents are edited as source with an expected revision and already use locked, atomic writes.
- `shdoc/1` is first-class HTML with document metadata, stable block IDs, validation, source editing, and sandboxed rendering.
- Wiki links, relative assets, path- and app-ID references, and mixed legacy identifiers are not PDC canonical semantics.

## Target representation

- Ordinary portable artifacts use `.djot` plus `pdc-djot/1`.
- Authored rich documents use `.html` plus the PDC comment-wrapped envelope and `pdc-html/1`.
- `shdoc/1` migrates preferentially to PDC HTML, retaining its body and readable semantics instead of converting to Djot.
- Operational metadata stays in its owning record. Portable documents refer to operational objects through `x_sawhorse` only when the reference is useful outside Sawhorse.
- Complex extension data uses an opaque `x_sawhorse.*_json` literal string; other apps preserve it without interpreting it.

## Mapping rules

| Sawhorse source | PDC target | Rule |
|---|---|---|
| UUID-shaped legacy ID | `id` | Preserve UUID value in canonical spelling. |
| non-UUID work/project/artifact ID | UUIDv7 + `x_sawhorse.legacy_id` | Allocate once and persist the mapping before rewriting references. |
| created/updated fields | `created` / `updated` | Normalize to canonical UTC millisecond timestamps. |
| first H1 or HTML title | `title` | Store reviewed title or leave empty to retain profile fallback. |
| tags/aliases/favorite | standard fields | Promote only authored document metadata. |
| typed nested metadata | owning operational record or `x_sawhorse.*_json` | Do not flatten or lose arrays/maps. |
| `data-sh-ref` and frontmatter references | `pdc://document/<uuid>` | Rewrite only after a complete, unambiguous mapping exists. |
| relative attachments | managed SHA-256 assets | Copy atomically, then rewrite references; preserve original hints. |
| `data-sh-kind`, profile, block IDs | PDC classes/attributes and `x_sawhorse` | Keep readable fallback and stable UUID block targets. |

Unknown keys, body comments, HTML source, Djot attributes, and authored whitespace survive writes. Structured PDC records must not pass through typed legacy serializers that drop unknown data.

## Write and security rules

- Reuse the existing expected-revision, lock, and atomic replacement path for canonical documents.
- A no-op leaves all bytes and `updated` unchanged. A metadata-only patch preserves body bytes exactly.
- A revision conflict stops the write; never retry against newly read bytes without an explicit merge decision.
- Djot preview sanitizes generated HTML. PDC HTML preview preserves source but renders through the existing sandbox model extended to the shared render policy.
- Scripts, events, nested browsing contexts, forms, popups, navigation, and unapproved subresources never execute.
- PDC links and assets resolve in the host before content reaches the sandbox.

## Migration stages

### Stage 0 — boundary and fixtures

- Pin corpus revision 3 and add it to native tests.
- Inventory all paths that are authored documents versus operational records.
- Freeze the `x_sawhorse` schema, UUID mapping store, and machine-readable migration report.

Exit: every path class has exactly one owner and scope classification.

Implemented in `app/src-tauri/src/pdc/`: contract pins (`contract.rs`, including the registered `x_sawhorse` namespace and the Sawhorse-frozen writer vocabulary of `legacy_id` + opaque `<name>_json` strings), the path classification inventory with a totality guarantee (`classify.rs` — every vault path resolves to exactly one owner/scope, unknown paths default to operational-record and are never migrated), the allocate-once legacy-ID → UUIDv7 mapping store at `.sawhorse/pdc/id-map.json` (`idmap.rs`), and the machine-readable migration report format (`report.rs`). Native tests: `cargo test --lib pdc::`. Exit: met.

### Stage 1 — Full Reader

- Discover `.djot` and PDC/legacy `.html` in registered document spaces.
- Parse both transports, expose invalid/unsupported diagnostics, resolve UUID links/assets, and preserve raw source.
- Keep existing Markdown and `shdoc/1` readers unchanged.

Exit: shared fixtures are visible and byte-identical after read-only access.
Implemented in `app/src-tauri/src/pdc/`: transport extraction (`transport.rs` — exact envelope line markers, CRLF tolerance for envelope parsing only, BOM rejection, 4 MiB ceiling, premature comment-close rejection, visible legacy HTML), the frozen constrained-envelope grammar hand-written to reject every forbidden feature (`envelope.rs` — including §5.3 opaque literal-block strings inside extension namespaces), and recursive discovery with corpus-vocabulary diagnostics plus unsafe-content and duplicate-target scans (`reader.rs`). The authoritative conformance corpus (revision 3, commit 6481ef0e) is vendored at `app/src-tauri/fixtures/pdc/conformance/` and native tests drive every file, reader-operation and set case, asserting byte-identical source preservation. Existing Markdown and `shdoc/1` readers are untouched. Exit: met.

### Stage 2 — canonical writers

- Add a Djot source editor/preview for ordinary artifacts.
- Extend the current HTML editor/validator/sandbox from `shdoc/1` to `pdc-html/1`.
- Write PDC only for newly created portable documents; keep operational records in their existing stores.

Exit: new documents pass profile-specific create, edit, move, rename, link, asset, and revision-conflict tests.

### Stage 3 — importer plans

- Markdown importer: map body syntax, links, IDs, assets, and authored metadata explicitly.
- `shdoc/1` importer: retain HTML body where safe, translate metadata and PDC semantics, and preserve old identifiers in `x_sawhorse`.
- Produce a deterministic dry-run with affected files, UUID/reference map, conflicts, unsafe constructs, and expected output digests.

Exit: dry-run on copied representative workspaces makes no source changes and reports every approximation.

### Stage 4 — authorized conversion

- Apply through a previewable, rollback-capable ChangeSet.
- Create new targets first and retain legacy source until explicit replacement approval.
- Rebuild derived search/task/link projections and compare counts and references.

Exit: Sawhorse, Oximemo, and Oxibrain agree on discovery, IDs, links, assets, standard metadata, and preservation for the same fixture vault.

## Non-goals

- No conversion of ledgers, approvals, queues, caches, runtime state, or generated evidence.
- No HTML-to-Djot downgrade.
- No automatic migration during application upgrade.
- No claim that PDC replaces workflow schemas or Sawhorse's operational model.
- No document normalization merely to match a serializer's preferred spelling.

## Verification

```bash
cd app
bun run build
bun run test:e2e
cd src-tauri && cargo test --lib
```

Migration verification additionally runs corpus revision 3, ChangeSet preview/apply/rollback tests, legacy-reader compatibility tests, and cross-app vault fixtures.
