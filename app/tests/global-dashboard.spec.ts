import { expect, test, type Page } from "@playwright/test";

const nav = (page: Page, name: string) => page.locator("aside nav").getByRole("button", { name, exact: true });
const scope = (page: Page) => page.getByRole("combobox", { name: "프로젝트 전환", exact: true });
async function selectProject(page: Page, name: string) {
  await scope(page).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function seedRuns(page: Page) {
  await page.goto("/?preview=1&lifecycle=1");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const state = JSON.parse(localStorage.getItem(key)!);
    state.runs = ["sawhorse", "herdr"].map((projectId, index) => {
      const item = state.snapshot.work.find((entry: { projectId: string }) => entry.projectId === projectId);
      return { id: `dashboard-run-${index}`, projectId, workId: item.id, role: "implementer", agent: "codex",
        status: "running", stage: item.stage, workflowId: item.workflowId, workflowVersion: item.workflowVersion,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
        agentName: "codex", session: "", prompt: "", resumable: false };
    });
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem("sawhorse.preview-jobs", JSON.stringify([{ id: "dashboard-job", label: "전체 자료 정리", project: "sawhorse", status: "running", createdAtMs: Date.now(), startedAtMs: Date.now(), source: "task", log: "" }]));
  });
  await page.reload();
}

test("the sidebar scopes project views while the dashboard retains all activity", async ({ page }) => {
  await seedRuns(page);
  const feed = page.locator('[data-widget="jobs"]');
  await expect(feed).toContainText("Sawhorse");
  await expect(feed).toContainText("Herdr");
  await expect(feed).toContainText("전체 자료 정리");
  await expect(page.locator(".wb-today-bar")).toHaveCount(3);
  await expect(page.locator('[data-widget="metric:jobs-live"] strong')).toHaveText("3");
  expect((await scope(page).boundingBox())!.y).toBeGreaterThan((await nav(page, "대시보드").boundingBox())!.y);
  await expect(page.locator(".app-toolbar").getByRole("combobox")).toHaveCount(0);
  await selectProject(page, "Herdr");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await expect(feed).toContainText("Sawhorse");
  await expect(feed).toContainText("Herdr");
  await nav(page, "작업대").click();
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await selectProject(page, "Sawhorse");
  await expect(page.getByRole("heading", { name: "Sawhorse 작업대", exact: true })).toBeVisible();
  await nav(page, "대시보드").click();
  await expect(scope(page)).toContainText("Sawhorse");
  await expect(feed).toContainText("Herdr");
  await page.reload();
  await expect(scope(page)).toContainText("Sawhorse");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
});

test("project and run links activate their own project", async ({ page }) => {
  await seedRuns(page);
  await page.locator('[data-widget="projects"]').getByRole("button", { name: /^Herdr/ }).click();
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await nav(page, "대시보드").click();
  await page.locator('[data-widget="jobs"] .wb-action-main').filter({ hasText: "Sawhorse" }).filter({ hasNotText: "전체 자료 정리" }).click();
  await expect(scope(page)).toContainText("Sawhorse");
  await expect(nav(page, "실행")).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("현재 위치")).toContainText("Sawhorse");
});

test("widget edits are shared and persistent, with no lifecycle catalog controls", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  await page.getByRole("button", { name: "오늘 활동 위젯 숨기기", exact: true }).click();
  await selectProject(page, "Herdr");
  await expect(page.locator('[data-widget="today"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-widget="today"]')).toHaveCount(0);
  await page.getByRole("button", { name: "위젯 추가", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("switch", { name: /단계별 맥락|작업 현황|승인 필요/ })).toHaveCount(0);
  await page.getByRole("textbox", { name: "위젯 검색", exact: true }).fill("오늘 활동");
  await page.getByRole("dialog").getByRole("switch").check();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-widget="today"]')).toHaveCount(1);
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  while (await page.getByRole("button", { name: /위젯 숨기기/ }).count()) await page.getByRole("button", { name: /위젯 숨기기/ }).first().click();
  await page.reload();
  await expect(page.getByText("표시할 위젯이 없습니다.", { exact: true })).toBeVisible();
});

test("legacy lifecycle widgets retire without resizing custom general widgets", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sawhorse.dashboard-layout", JSON.stringify({ version: 4, enabled: ["issues", "stages", "metric:done"], layouts: {
    lg: [{ i: "issues", x: 0, y: 0, w: 7, h: 10 }, { i: "metric:done", x: 7, y: 0, w: 5, h: 5 }],
    md: [{ i: "metric:done", x: 0, y: 0, w: 4, h: 5 }], sm: [{ i: "metric:done", x: 0, y: 0, w: 4, h: 5 }],
  } })));
  await page.goto("/?preview=1");
  await expect(page.locator(".widget-grid-item")).toHaveCount(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sawhorse.dashboard-layout")!));
  expect(saved.enabled).toEqual(["metric:done"]);
  expect(saved.layouts.lg.find((item: { i: string }) => item.i === "metric:done")).toMatchObject({ w: 5, h: 5 });
});

test("no projects and a deleted selection leave the shared dashboard available", async ({ page }) => {
  await page.goto("/?preview=1&lifecycle=1");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const state = JSON.parse(localStorage.getItem(key)!);
    state.snapshot.projects = []; state.snapshot.work = []; state.snapshot.events = [];
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem("sawhorse.project-scope", "deleted-project");
  });
  await page.reload();
  await expect(scope(page)).toContainText("프로젝트 선택");
  await expect(page.locator('[data-widget="today"]')).toBeVisible();
  await expect(nav(page, "실행")).toHaveCount(0);
  await nav(page, "프로젝트 현황").click();
  await expect(page.getByRole("button", { name: "프로젝트 추가", exact: true }).last()).toBeVisible();
});

test("desktop and compact themes preserve widget fit and the collapsed switch", async ({ page }) => {
  await page.goto("/?preview=1");
  const today = page.locator('[data-widget="today"]');
  const jobs = page.locator('[data-widget="jobs"]');
  await expect(today).toBeVisible();
  expect(Math.abs((await today.boundingBox())!.y - (await jobs.boundingBox())!.y)).toBeLessThan(2);
  expect((await today.boundingBox())!.width).toBeGreaterThan((await jobs.boundingBox())!.width);
  await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
  await scope(page).click();
  expect((await page.getByRole("listbox", { name: "프로젝트 전환", exact: true }).boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await page.getByRole("option", { name: "Herdr", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "사이드바 펼치기", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 540, height: 820 });
  for (let i = 0; i < 3; i++) {
    await expect(page.getByRole("button", { name: "위젯 추가", exact: true })).toBeInViewport();
    await expect.poll(() => page.locator(".app-content").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: "테마 전환", exact: true }).click();
  }
  await nav(page, "작업대").click();
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
});
