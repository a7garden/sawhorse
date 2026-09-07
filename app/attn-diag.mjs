import { chromium } from "playwright";

const fixtures = {
  get_config: { exists: true, vaultPath: "/tmp/vault", coreProjects: [] },
  list_jobs: [], list_missed: [], list_schedules: [], list_todos: {},
  list_inbox_count: 0, list_issues: [], list_unpromoted: [],
  audit_vault: { issues: [], journal: { todayExists: true, missing: [] }, scannedAtMs: 0 },
  diagnostics: {}, check_requirements: [], list_agents: { agents: {}, defaultAgent: "" },
  collab_list_sessions: [], list_vault_tree: [], list_nav: [],
  vault_attention: {
    pendingSchemaMoves: 3, schemaConflicts: 2, schemaId: "team-vault",
    schemaRevision: 5, pendingLegacyIssues: 7,
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text().slice(0, 300)}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${String(e).slice(0, 500)}`));
await page.addInitScript((fx) => {
  let cbId = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      const c = String(cmd);
      if (c.startsWith("plugin:event|")) return Promise.resolve(cbId++);
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(fx, c) ? structuredClone(fx[c]) : null,
      );
    },
    transformCallback: () => cbId++,
    metadata: { currentWebview: { label: "main" }, currentWindow: { label: "main" } },
  };
}, fixtures);

await page.goto("http://localhost:5199/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
const probe = await page.evaluate(() => ({
  hasInternals: "__TAURI_INTERNALS__" in window,
  url: location.href,
  text: document.body.innerText.slice(0, 600),
}));
console.log("PROBE:", JSON.stringify(probe, null, 2));
console.log("LOGS:", JSON.stringify(logs.slice(0, 25), null, 2));
await page.screenshot({ path: "/tmp/attn-fail.png" });
await browser.close();
