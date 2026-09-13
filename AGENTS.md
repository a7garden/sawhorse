# AGENTS.md — Sawhorse

## Priority 1 — Portable Document Contract migration

- Unless the user explicitly overrides priority, the staged document-plane migration in `docs/architecture/pdc-migration.md` is this repository's highest-priority document interoperability initiative. Advance its earliest incomplete safety gate before beginning a competing document format, editor, renderer, link, asset, or migration design.
- Load and follow the installed `portable-document-contract` skill before changing durable user-authored document storage, discovery, parsing, editing, rendering, linking, assets, indexing, or migration. The external PDC repository is authoritative; Sawhorse must not silently define a conflicting contract.
- Apply PDC only to the authored document plane. Ordinary canonical documents use `pdc-djot/1`; authored HTML structure, layout, and inline CSS use the parallel canonical `pdc-html/1`. Prefer PDC HTML when migrating compatible `shdoc/1` content rather than downgrading it to Djot.
- Keep operational records in their owning stores: `.sawhorse/`, runtime databases, runs, approvals, queues, journals, ChangeSets, generated evidence, prompts, and caches are not PDC documents. Approval and workflow status are ledger facts, never inferred from document fields.
- Never normalize or convert canonical bytes as a side effect. Write through the expected-revision and atomic replacement path; on conflict stop and re-read. Unknown fields, extension data, source comments, attributes, whitespace, and stable IDs survive or the document becomes read-only.
- Existing Markdown and `shdoc/1` readers remain during migration. Bulk replacement requires a previewable, rollback-capable ChangeSet, a per-document loss/conflict report, retained source, and explicit user authorization.
