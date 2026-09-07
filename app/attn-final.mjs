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

const rows = await page.$$eval('[role="alert"] > div', (els) =>
  els.map((e) => e.innerText.replace(/\s*\n\s*/g, " | ")),
);
console.log("ROWS:", JSON.stringify(rows, null, 2));

// CTA: 충돌 행(첫 행)의 스키마 스튜디오 버튼 → 페이지 이동 확인
const firstCta = page.locator('[role="alert"] > div').first().getByRole("button").first();
await firstCta.click();
await page.waitForTimeout(1200);
const nav = await page.locator('[aria-current="page"]').allInnerTexts();
console.log("AFTER_CTA_NAV:", JSON.stringify(nav));

// 해제: 마지막 행의 X(aria-label 있는 버튼) → 행 수 감소 확인
const beforeRows = await page.locator('[role="alert"] > div').count();
const closeBtn = page.locator('[role="alert"] button[aria-label]').last();
await closeBtn.click();
await page.waitForTimeout(400);
const afterRows = await page.locator('[role="alert"] > div').count();
console.log("DISMISS:", JSON.stringify({ beforeRows, afterRows }));

await page.screenshot({ path: "/tmp/attn-final.png" });
await browser.close();
