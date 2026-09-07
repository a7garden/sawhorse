import { chromium } from "playwright";

const fixtures = {
  get_config: { exists: true, vaultPath: "/tmp/vault", coreProjects: [] },
  list_jobs: [], list_missed: [], list_schedules: [], list_todos: {},
  list_inbox_count: 0, list_issues: [], list_unpromoted: [],
  audit_vault: { issues: [], journal: { todayExists: true, missing: [] }, scannedAtMs: 0 },
  diagnostics: {}, check_requirements: [], list_agents: { agents: {}, defaultAgent: "" },
  collab_list_sessions: [], list_vault_tree: [], list_nav: [],
  vault_attention: {
    pendingSchemaMoves: 3,
    schemaConflicts: 2,
    schemaId: "team-vault",
    schemaRevision: 5,
    pendingLegacyIssues: 7,
  },
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript(() => {
  // 아래 JSON 은 실행 시 주입된다
  window.__ATTN_FIXTURES__ = window.__ATTN_FIXTURES__;
});
await page.addInitScript((fx) => {
  let cbId = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: (cmd) => {
      const c = String(cmd);
      if (c.startsWith("plugin:event|")) return Promise.resolve(cbId++);
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(fx, c)
          ? structuredClone(fx[c])
          : null,
      );
    },
    transformCallback: () => cbId++,
    metadata: {
      currentWebview: { label: "main" },
      currentWindow: { label: "main" },
    },
  };
}, fixtures);

await page.goto("http://localhost:5199/", { waitUntil: "domcontentloaded" });
try {
  await page.waitForSelector('[role="alert"] > div', { timeout: 20000 });
} catch (e) {
  console.log("STRIP_NOT_FOUND bodyLen=", (await page.content()).length);
  await page.screenshot({ path: "/tmp/attn-fail.png" });
  await browser.close();
  process.exit(1);
}
const rows = await page.$$eval('[role="alert"] > div', (els) =>
  els.map((e) => e.innerText.replace(/\s*\n\s*/g, " | ")),
);
console.log("ROWS:", JSON.stringify(rows, null, 2));

// CTA 클릭 → 스키마 스튜디오로 이동하는지
const conflictRow = page.locator('[role="alert"] > div').first();
await conflictRow.getByRole("button", { name: /스튜디오|studio/i }).click();
await page.waitForTimeout(1200);
const current = await page
  .locator('[aria-current="page"]')
  .allInnerTexts();
console.log("ACTIVE_NAV:", JSON.stringify(current));

// 닫기(X) → 해당 행만 사라지는지
const closeButtons = page.locator('[role="alert"] button[aria-label]');
const before = await closeButtons.count();
await closeButtons.last().click();
await page.waitForTimeout(300);
const after = await page.locator('[role="alert"] > div').count();
console.log("DISMISS:", { rowsBefore: rows.length, dismissTargets: before, rowsAfter: after });

await page.screenshot({ path: "/tmp/attn-strip.png", fullPage: false });
await browser.close();
