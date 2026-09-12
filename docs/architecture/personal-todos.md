# Personal todos

The 할 일 tab is a persistent personal task list. The default view shows all
unfinished tasks, grouped into overdue, today, upcoming and no date. Completion
is a separate view; reopening restores an item to its date group. Search and
priority filters combine with the selected view. Date sorting puts undated tasks
last, while priority sorting orders high, normal and low.

`list_managed_todos` reads the vault's `할 일.md` and every dated Markdown file
in `일지/`. For existing journals, it reads the `## 오늘 할 일` and
`## 내일 할 일` sections. Their initial due dates are the journal's date and the
following calendar day. It does not copy or delete journal entries during reads.
Separate entries in different journals remain separate tasks.

`save_managed_todo` appends new tasks to `할 일.md`. Existing tasks are edited in
their original file. A trailing `<!-- sawhorse-todo:{...} -->` comment stores
`dueDate` (ISO date or null), `priority` and `deleted`. Setting `deleted` hides a
row while keeping its original text; setting it back to false in the Markdown
restores it. Checkbox completion remains standard Markdown. Journal consumers
in the app hide this metadata and omit deleted rows.

Rows carry a revision made from their relative file path, line index and SHA-256
of the raw line. Saves rescan and reject stale references, then check file content
again before atomic replacement. In-process managed writes are serialized. An
external editor that does not use the same lock can still race the final check;
this is not a cross-process transaction. Untouched lines and existing newline
style are preserved.

The page refreshes after changes, on vault notifications, on window focus and
every minute, so calendar rollover changes views without moving or deleting
records. Browser preview uses a separate local storage collection. It is demo
persistence; desktop persistence is the vault Markdown.

Validation: `app/tests/todos.spec.ts` covers date views, filters, creation,
editing, completion/reopening, deletion, refresh persistence, save failures,
English and narrow/dark layouts. Rust `todos::tests` covers storage, historical
journals, year boundaries, stale revisions and preservation of unrelated text.
