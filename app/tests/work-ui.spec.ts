import { expect, test, type Page } from "@playwright/test";

const workNav = (page: Page) => page.locator("aside nav").getByRole("button", { name: "작업", exact: true });
const cards = (page: Page) => page.locator(".wb-board-card");
const results = (page: Page) => page.locator(".wb-work-results").getByRole("status");
const filterToggle = (page: Page) => page.locator(".wb-work-toolbar").getByRole("button", { name: /^필터/ });
async function choose(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "작업대", exact: true })).toBeVisible();
  await workNav(page).click();
});

test("search carries across views, prunes hidden selections, and opens work with the keyboard", async ({ page }) => {
  await expect(cards(page)).toHaveCount(6);
  const search = page.getByRole("textbox", { name: "작업 검색", exact: true });
  await search.fill("WORK-INTENT");
  await expect(cards(page)).toHaveCount(1);
  await expect(results(page)).toHaveText("1개 작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(1);
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await expect(page.locator(".wb-bulk-bar")).toContainText("1건 선택");
  await search.fill("work-editor");
  await expect(page.locator(".wb-bulk-bar")).toHaveCount(0);
  await expect(page.locator(".wb-issue-table tbody tr")).toContainText("마크다운 라이브 편집기");
  await search.fill("no-matching-work");
  await expect(page.getByText("조건에 맞는 작업이 없습니다", { exact: true })).toBeVisible();
  await page.locator(".wb-empty").getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(6);
  await page.locator(".wb-work-title-link").filter({ hasText: "마크다운 라이브 편집기" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
});

test("advanced filters remain active when collapsed and reset together", async ({ page }) => {
  await filterToggle(page).click();
  await choose(page, "단계 필터", "기본 SDD 1.1.0 · 구현");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("Herdr 실행과 기록 연결");
  await filterToggle(page).click();
  await expect(page.getByRole("combobox", { name: "단계 필터", exact: true })).toHaveCount(0);
  await expect(filterToggle(page)).toContainText("1");
  await expect(results(page)).toHaveText("1개 작업");
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(cards(page)).toHaveCount(6);
  await filterToggle(page).click();
  await choose(page, "처리 유형 필터", "문서");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page)).toContainText("의도에서 시작하는 개발 흐름");
});

test("milestones expand above the board and stay in sync with the filter", async ({ page }) => {
  await expect(page.locator(".wb-milestone-rail")).toHaveCount(0);
  await page.getByRole("button", { name: "마일스톤", exact: true }).click();
  await page.locator(".wb-milestone-row").filter({ hasText: "작업대 마일스톤" }).click();
  await expect(results(page)).toContainText("0개 작업");
  await filterToggle(page).click();
  await expect(page.getByRole("combobox", { name: "마일스톤 필터", exact: true })).toContainText("작업대 마일스톤");
  await choose(page, "마일스톤 필터", "소속 없음");
  await expect(page.locator(".wb-milestone-row").filter({ hasText: "소속 없음" })).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(6);
  await page.getByRole("button", { name: "마일스톤 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("state tabs and saved display preference work with project scope", async ({ page }) => {
  const states = page.getByRole("group", { name: "열림 상태", exact: true });
  await states.getByRole("button", { name: /^닫힌 작업/ }).click();
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('[data-stage="__closed"]')).toContainText("완료");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(1);
  await page.reload();
  await workNav(page).click();
  await expect(page.getByRole("button", { name: "목록", exact: true })).toHaveAttribute("aria-pressed", "true");
  await choose(page, "프로젝트 필터", "Herdr");
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "프로젝트", exact: true })).toContainText("Herdr");
});

test("narrow windows keep page controls within the canvas and scroll work locally", async ({ page }) => {
  for (const width of [820, 540]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("textbox", { name: "작업 검색", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "새 의도", exact: true })).toBeInViewport();
    const bounds = await page.locator(".wb-work-page").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  }
  await filterToggle(page).click();
  await expect(page.getByRole("combobox", { name: "마일스톤 필터", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const bounds = await page.locator(".wb-work-page").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
});
