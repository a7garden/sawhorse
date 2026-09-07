import { expect, test, type Page } from "@playwright/test";

const nav = (page: Page, name: string) => page.locator(".app-navigation").getByRole("button", { name, exact: true });
const scope = (page: Page) => page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true });

test("the default desk prioritizes work, and new intents inherit the project", async ({ page }) => {
  await page.goto("/?preview=1");
  const next = page.locator('[data-widget="next"]');
  const projects = page.locator('[data-widget="projects"]');
  await expect(next.getByRole("heading", { name: "다음 작업" })).toBeInViewport();
  const nextBounds = (await next.boundingBox())!;
  const projectBounds = (await projects.boundingBox())!;
  expect(Math.abs(nextBounds.y - projectBounds.y)).toBeLessThan(2);
  expect(nextBounds.width).toBeGreaterThan(projectBounds.width);
  await expect(page.locator(".wb-overview-page").getByRole("combobox")).toHaveCount(0);
  await projects.getByRole("button", { name: /^Herdr/ }).click();
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "프로젝트", exact: true })).toContainText("Herdr");
});

test("collapsed navigation persists and the project menu remains readable", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCSS("width", "58px");
  await scope(page).click();
  const menu = page.getByRole("listbox", { name: "사이드바 프로젝트 선택", exact: true });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  await page.getByRole("option", { name: "Herdr", exact: true }).click();
  await nav(page, "작업").click();
  await expect(page.getByRole("combobox", { name: "프로젝트 필터", exact: true })).toContainText("Herdr");
  await expect(nav(page, "작업")).toHaveAttribute("aria-current", "page");
  await page.reload();
  await expect(page.getByRole("button", { name: "사이드바 펼치기", exact: true })).toBeVisible();
  await expect(scope(page)).toHaveAttribute("aria-label", "사이드바 프로젝트 선택");
  await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
  await expect(page.locator(".app-sidebar")).toHaveCSS("width", "216px");
});

test("compact navigation retains search and page controls in both themes", async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 820 });
  await page.goto("/?preview=1");
  await expect(page.getByRole("button", { name: "새 의도", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "전체 검색", exact: true }).click();
  await expect(page.getByPlaceholder("문서와 작업을 검색하세요")).toBeVisible();
  await page.keyboard.press("Escape");
  await nav(page, "작업").click();
  await expect(page.getByRole("textbox", { name: "작업 검색", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "목록", exact: true }).click();
  for (let i = 0; i < 3; i++) {
    const bounds = await page.locator(".app-content").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    await page.getByRole("button", { name: "테마 전환", exact: true }).click();
  }
});

test("existing customized dashboards keep their widgets and dimensions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sawhorse.dashboard-layout", JSON.stringify({
      version: 4,
      enabled: ["issues", "metric:done"],
      layouts: {
        lg: [{ i: "issues", x: 0, y: 0, w: 7, h: 10 }, { i: "metric:done", x: 7, y: 0, w: 5, h: 5 }],
        md: [{ i: "issues", x: 0, y: 0, w: 8, h: 10 }, { i: "metric:done", x: 0, y: 10, w: 4, h: 5 }],
        sm: [{ i: "issues", x: 0, y: 0, w: 4, h: 10 }, { i: "metric:done", x: 0, y: 10, w: 4, h: 5 }],
      },
    }));
  });
  await page.goto("/?preview=1");
  await expect(page.locator(".widget-grid-item")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "작업 현황", exact: true })).toBeVisible();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sawhorse.dashboard-layout")!));
  expect(saved.enabled).toEqual(["issues", "metric:done"]);
  expect(saved.layouts.lg.find((item: { i: string }) => item.i === "issues")).toMatchObject({ w: 7, h: 10 });
});
