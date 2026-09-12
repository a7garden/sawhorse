# Sawhorse Desktop

React + TypeScript + Tauri 2. The core provides deterministic workflow execution, not a specific
methodology. SDD and the intent flow are bundled examples served over the same public contracts,
and the existing packs and collaboration features are retained.

For the roles and data compatibility of workbench widgets, work items, schedules, extensions, and
global search, see [the work-centric app structure](../docs/architecture/product-organization.md).

```bash
bun install
bun run tauri dev
bun run build
bunx playwright install chromium
bun run test:e2e
(cd src-tauri && cargo test --lib)
bun run tauri build
```

To run the frontend alone, start `bun run dev` and open the browser preview with `?preview=1`.
Preview data is stored only in the browser's localStorage. Desktop errors are not hidden behind
sample data.

For the English demo used for README screenshots, run `bun run dev --port 1430` and open
`http://127.0.0.1:1430/showcase/?preview=1`. See the
[sample data and image regeneration guide](../docs/images/README.md).

| Location | Role |
|---|---|
| src/features/workbench | Workbench, artifact editing, dynamic workflow UI, runtime ledger, SDD-compatible IPC |
| src/features/workflow-studio | Node/artifact/subflow/required extension·program editing, validation, simulation, publishing |
| src/features/schema-studio | Document type/field/path/template editing and migration preview/apply |
| src/pages/OnboardingPage.tsx | Snapshot-based project import, resume, evidence drafts, conflict review |
| src-tauri/src/sdlc.rs | Markdown schemas, CRUD, review decisions, dependencies, document conflicts, search |
| src-tauri/src/sdlc_harness.rs | Herdr runs, recovery, output logging, control, subrun requests |
| src-tauri/src/workflow | Definition and validation, nested execution engine, SQLite instance/node/event ledger |
| src-tauri/src/schemas | Schema draft/publish/activate and field, path, and link migrations |
| src-tauri/src/changes | Hash/CAS-based preview, journal, apply, rollback, and recovery |
| src-tauri/src/extensions/package.rs | Package v2 install, resolve, lock, permissions, portable export |
| src-tauri/src/ingestion.rs | Input snapshots, evidence, checkpoints, document drafts, merge base |
| src-tauri/src/herdr.rs | Herdr CLI adapter |
| src-tauri/src/collab | Legacy collaboration sessions, reviews, and integration |
| src-tauri/src/packs.rs | Optional workflow packs |
| ../plugin/skills/sdd | Artifact conventions for harness agents |
| tests | Browser-level user flow verification |

The source of truth for core schemas is the vault's `.sawhorse/schema.json` plus the published
schema/workflow JSON and Markdown. Run and import state lives in `.sawhorse/runtime.sqlite`, and
package selection in `.sawhorse/extensions.lock.json`. User preferences live in the app-owned
`~/.sawhorse/config.json` (relocated once from the older `~/.claude/sawhorse` location). Tests use temporary folders and an explicit browser preview and
never modify a real user vault.

## GitHub OAuth setup

The GitHub extension links accounts through the OAuth Device Flow. Default builds embed the public
Client ID of the registered SawHorse OAuth App, so sign-in works without extra configuration. No
Client Secret is used. The app registration enables `Enable Device Flow` and token expiration, and
expired tokens are refreshed with a refresh token. The registered redirect URI `http://127.0.0.1`
is not used by the Device Flow.

To use a separate OAuth App, enable `Enable Device Flow` on that app and provide the Client ID as
follows.

```bash
SAWHORSE_GITHUB_CLIENT_ID=YOUR_CLIENT_ID bun run tauri dev
SAWHORSE_GITHUB_CLIENT_ID=YOUR_CLIENT_ID bun run tauri build
```

Environment variables apply in the order run-time value, build-time value, then the default Client
ID. The `read:user repo` scopes are requested for browsing and importing private repositories,
while actual extension behavior is limited to read requests allowed by the host broker and Git
clones. A PAT saved by an older version stays readable until disconnect, but the new sign-in screen
offers no PAT input.

GitHub credentials are stored in the OS secure store, and a value read once is reused from app
process memory. Re-entering the screen, moving between repository pages, and concurrent requests
do not reopen the keychain repeatedly. Sign-in and token refresh replace the in-memory value only
after a successful save; disconnect clears the in-memory value and then deletes it from the secure
store. Access denial or deletion failure is surfaced as an error, never hidden by disconnecting.

macOS development runs keep the same code-signing identity through
`src-tauri/scripts/dev-codesign.sh`. If rebuilding the app demands keychain approval every time,
check the `dev-codesign` errors in the development terminal. On
`unable to build chain to self-signed root`, check whether the issuer certificate is installed and
how the developer certificate's trust is configured. For the Apple code-signing certificate, do not
set `항상 신뢰` (Always Trust); use the system default. See
[Apple's troubleshooting notes](https://developer.apple.com/forums/thread/712043). Switching from
the old ad-hoc signature to a real signature for the first time may require approving keychain
access once more.

[Full design](../docs/architecture/sdd-workbench.md) · [API contract](../docs/architecture/sdd-contract.md)
