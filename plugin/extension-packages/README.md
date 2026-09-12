# Sawhorse extension packages

Each subfolder carries an `extension.json` with `manifestVersion: 2` and a payload pinned by
digest. The app's extensions screen installs packages from local folders, portable JSON files,
exact Git commits, or HTTPS, resolves dependencies and the engine API range, then records
per-project permissions and exact digests in `.sawhorse/extensions.lock.json`.

```bash
node plugin/extension-packages/validate.mjs
```

CI runs the same command to check each bundled package's full file list, SHA-256 hashes, and
contribution paths. A `*.sawhorse-package.json` exported from the app preserves the payload as
base64, so text and binaries reinstall the same way. Installation never executes skills or actions.

File order within a workflow contribution is free. The host inspects every definition being
activated together and publishes referenced sub-workflows first. Sub-flows must be referenced by
exact ID and version; missing versions, circular references, and content conflicts for the same
version return errors before activation.

Workflows also declare per-feature runtime dependencies. In `requirements`, an `extension` entry
points at the project lock's semver and a `program` entry at portable executable candidates.
`required` is enforced before a run, while `recommended` and `optional` serve as environment
guidance. For example, a flow with XLSX artifacts declares `xlsx-export`, and a flow reading DOCX
source documents declares the matching reader extension or `pandoc`. Never push these requirements
into the app-wide install list or unrelated packs.

```json
"requirements": [
  {
    "kind": "extension", "id": "xlsx-export", "label": "XLSX Export",
    "level": "required", "reason": "최종 보고서를 XLSX로 제출",
    "commands": [], "versionArgs": [], "minimumMajor": 0,
    "version": "^1.1", "installUrl": "", "installHint": ""
  },
  {
    "kind": "program", "id": "pandoc", "label": "Pandoc",
    "level": "recommended", "reason": "DOCX 제안서의 텍스트 추출",
    "commands": ["pandoc"], "versionArgs": ["--version"], "minimumMajor": 3,
    "version": "",
    "installUrl": "https://pandoc.org/installing.html", "installHint": ""
  }
]
```

Required dependencies search the installed versions for a combination that works together. When the
newest version conflicts with another required range the search falls back to older candidates;
optional dependencies are never auto-activated. Never publish different digests for the same ID and
version — when content changes, use a new version. If the combination to activate would break
existing project extension dependencies or a pinned digest is missing, the app keeps the existing
lock and profile and guides you to the required packages and versions.

Today `xlsx-export` is an optional extension kept separate from the default core and other feature
extensions. Projects that have not activated it show no XLSX actions or screens; activation
requires explicitly approving `adapter:xlsx-export` and vault permissions.

`ui-mockup` is an optional extension that surveys the current UI for exactly the items checked in
the issue list and produces A/B mockups per screen context. Even a full selection never merges
different screens into one mockup. Results are registered as a `mockup-review` work item plus HTML
and preview artifacts, reviewed in the workbench and the 「목업 산출물」 (mockup artifacts) screen.
Even a rough backlog is elaborated into per-screen problems, proposals, and acceptance criteria;
review comments circulate into a new backlog linked to the original screen and mockup revisions
that are never overwritten. The workbench presents approval and change requests as different
transitions. A declarative view offering a selection action must declare `selection: "multiple"`,
and the host passes the checked row IDs and the select-all flag as action parameters.
