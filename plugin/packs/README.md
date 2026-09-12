# Authoring document and automation packs

A pack bundles **one feature** that users can toggle independently with that feature's
documentation and automation routines. Never put an entire industry, customer, or way of working
into a single pack. Work item stages, approvals, and artifacts are managed by the app's common
workflow. New features that carry install permissions or dependencies use
[extension packages v2](../extension-packages/README.md).
**No code required** — declare it and the app takes care of rendering, validation, and execution.

## Build one in five minutes

```bash
cp -R packs/journal ~/.sawhorse/packs/my-feature
# change the "id" in pack.json to "my-pack" (lowercase, digits, hyphens)
```

Refresh in the app's **확장 관리** (extension manager) and the pack appears in the list. Only packs
with `views` add work screens.

A user pack with the same `id` **overrides** the built-in pack. To reshape a built-in feature pack
your way, copy that feature folder to `~/.sawhorse/packs/<feature-id>/` and edit the copy.

## Folder layout

```
<pack>/
  pack.json               # manifest (required)
  skills/<name>/SKILL.md  # skill installed into agents
  templates/*.md          # templates laid into the workspace
  assets/**               # auxiliary assets such as .base
```

## Manifest

| Key | Meaning |
|---|---|
| `id` | Lowercase letters, digits, hyphens; becomes the settings namespace key |
| `name` `version` `description` `author` `icon` | What the extensions screen shows; `icon` is a lucide name (kebab-case) |
| `skills` | Skill directory names to install into agents |
| `workspace` | `folders[]` and `files[{src,dest}]`. **Existing files are never overwritten** |
| `settings` | The extensions screen generates the form; values live in `config.json` under `packs.settings.<id>` |
| `actions` | Runnable units; they enter the job queue and can be scheduled |
| `views` | Screens added under a sidebar category |

### actions

```jsonc
{ "id": "review", "label": "주간 회고", "description": "…",
  "prompt": "/weekly-review {{week}}",       // {{key}} marks a parameter slot
  "cwd": "workspace",                        // workspace | project | path:/absolute/path
  "featured": true,
  "params": [{ "key": "week", "type": "text", "label": "기준 날짜", "required": false }],
  "schedule": { "kind": "weekdays", "time": "17:30" } }   // daily | weekdays
```

- Parameter types: `text`, `list` (joined with spaces), `select` (`options[]`), `project`.
- Newlines and backticks are stripped from substituted values (some paths pass slash commands as a
  single line). **Line breaks in the template itself are preserved** — multi-line unattended run
  instructions are fine.
- Unfilled `{{key}}` placeholders vanish without a trace.
- A `schedule` shows up in the app's schedule list. When the user changes the time it is saved to
  `dashboard.schedules["<id>.<actionId>"]` and overrides the manifest value.

### views

```jsonc
{ "id": "logs", "label": "일지", "icon": "calendar-days", "group": "vault", "type": "notes",
  "query": {
    "folders": ["일지", "문서"],        // globs span a single `*` level
    "exclude": ["*목록.md", "*.base"],
    "where": [{ "field": "type", "op": "eq", "value": "문서" }],
    "sort": { "source": "title", "desc": true },   // source: "" | "title" | "mtime"
    "limit": 120
  },
  "columns": [
    { "source": "title", "label": "제목" },        // value coming from the note itself
    { "field": "status", "label": "상태", "type": "badge", "width": 90 },
    { "field": "tags", "label": "태그", "type": "list" }
  ],
  "groupBy": "status",                        // frontmatter field → top group tabs
  "actions": ["review"],                      // action ids runnable from this screen
  "empty": "아직 없습니다. …" }
```

- Screens with `group: "vault"` are shown under the sidebar's `볼트` (Vault) category alongside
  `모든 문서` (All documents). Whole-folder browsing belongs to `모든 문서`; per-type listings use
  the declarative `notes` view.
- Predicate operators: `eq` `ne` `in` `contains` `exists` `truthy` `notEmpty`.
  Unknown operators do not filter (so a typo never empties the screen).
- Column types: `text` `badge` `list` `check` `date`.
- `source` values come from the note itself, not frontmatter: `title` (first `#` heading, falling
  back to the filename), `mtime`, `path`.
- `type: "native"` points at work screens the app already ships (`issues`, `todos`). Use it only to
  expose a native screen as an opt-in feature. Core features that are always needed, such as the
  vault health check, never go into a pack.

### settings

```jsonc
{ "key": "ownerName", "type": "text", "label": "이름",
  "description": "회고 문서에 적을 이름", "placeholder": "예: 김워크" }
```

Types: `text`, `path`, `number`, `bool`, `select` (`options[{value,label}]`),
`table` (`columns[{key,label}]`).

Values are stored in `~/.sawhorse/config.json` under `packs.settings.<packId>`.
**Skills read those values** — writing in SKILL.md which keys to read is the contract.

## Three rules

1. **The host does not know what fields mean.** Frontmatter is carried as-is; the manifest decides
   the meaning. That is why any schema works.
2. **Existing files are never overwritten.** `workspace.files` copies only when missing, and a
   skill install whose content differs is only flagged `수정됨` (modified).
3. **A disabled pack is an absent pack.** Its screens, schedules, and actions disappear together
   (notes remain). So two features that must toggle independently never share a pack.

## Common mistakes

| Symptom | Cause |
|---|---|
| Missing from the list | `id` is not lowercase/digits/hyphens, or JSON parsing failed. The reason shows in the extensions screen's top 「읽지 못한 확장」 (unreadable extensions) section |
| Screen is empty | The `folders` globs do not match real folders, or `where` is too narrow. Check the "N개 폴더" (N folders) count in the header |
| Install button does nothing | No `SKILL.md` actually exists under the names in `skills[]` (`본문 없음` (no body) badge) |
| Nothing appears in the workspace | Everything is already there, or `files[].src` is not relative to the pack folder |
| Schedule does not fire | The pack is disabled or the workspace path is empty. Missed schedules surface only as a home card (no automatic execution) |

## Bundle consistency

`pack.json`'s `skills` is the source of truth for published skills. The actual skill folders must
match the declaration, and actions must call declared skills. Retire a skill by removing its
declaration and folder together.

Templates that could collide with other packs live under `템플릿/<pack-id>/` (templates). Existing
user files are never overwritten. Pack initialization never re-creates core records or the legacy
issue and improvement templates.

From the repository root, `node plugin/validate.mjs` checks declarations, seeds, and skill
references.
