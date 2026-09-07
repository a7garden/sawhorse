import { chromium } from "playwright";

const fixtures = {
  get_config: { exists: true, vaultPath: "/tmp/vault", coreProjects: [] },
  upgrade_status: { id: "t", status: "completed", error: null, steps: [], backups: [], migrated: 0, changed: false, notices: [] },
  list_packs: { broken: [], packs: [] },
  sdd_snapshot: { projects: [] },
  check_requirements: [],
  list_agents: { agents: {}, defaultAgent: "" },
  audit_vault: { issues: [], journal: { todayExists: true, missing: [] }, scannedAtMs: 0 },
  vault_attention: {
    pendingSchemaMoves: 3, schemaConflicts: 2, schemaId: "team-vault",
    schemaRevision: 5, pendingLegacyIssues: 7,
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 200)));
await page.addInitScript((fx) => {
  window.isTauri = true;
  let cbId = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      const c = String(cmd);
      if (c.startsWith("plugin:event|")) return Promise.resolve(cbId++);
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(fx, c) ? structuredClone(fx[c]) : [],
      );
    },
    transformCallback: () => cbId++,
    metadata: { currentWebview: { label: "main" }, currentWindow: { label: "main" } },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}, fixtures);

await page.goto("http://localhost:5199/", { waitUntil: "domcontentloaded" });
await page.waitForSelector('[role="alert"] > div', { timeout: 20000 });

// 1) 스키마 충돌 CTA → 스키마 스튜디오 화면으로 바뀌는지
await page.locator('[role="alert"] > div').first().getByRole("button").first().click();
await page.waitForTimeout(1500);
const body1 = await page.evaluate(() => document.body.innerText);
console.log("SCHEMA_PAGE_MARKERS:", JSON.stringify({
  hasStudioHeading: body1.includes("스키마"),
  stripStillVisible: await page.locator('[role="alert"]').count(),
}, null, 2));

// 2) 레거시 이슈 CTA → 작업대 이슈 화면으로 바뀌는지
const legacyCta = page.locator('[role="alert"] > div').last().getByRole("button").first();
await legacyCta.click();
await page.waitForTimeout(1500);
const body2 = await page.evaluate(() => document.body.innerText);
console.log("WORK_PAGE_MARKERS:", JSON.stringify({
  hasWorkbench: body2.includes("작업대") || body2.includes("이슈"),
  snippet: body2.slice(0, 250),
}, null, 2));

await browser.close();
