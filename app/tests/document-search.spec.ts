import { test, expect } from "@playwright/test";

const search = async (page: import("@playwright/test").Page, term: string) => {
  await page.getByRole("textbox", { name: "문서 검색어" }).fill(term);
  await page.getByRole("textbox", { name: "문서 검색어" }).press("Enter");
  await expect(page.getByRole("region", { name: "검색 결과", exact: true })).toHaveAttribute("aria-busy", "false");
};
test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await page.locator("aside nav").getByRole("button", { name: "작업 문서 검색", exact: true }).click();
  await expect(page.getByRole("heading", { name: "작업 문서 검색", exact: true })).toBeVisible();
});

test("document results filter by artifact and open the matching document", async ({ page }) => {
  await expect(page.getByRole("region", { name: "최근 수정한 작업" })).toBeVisible();
  await search(page, "Herdr");
  const results = page.locator(".doc-search-hit");
  await expect(results.first()).toBeVisible();
  const total = await results.count();
  await expect(results.first().locator("mark").first()).toHaveText("Herdr");
  const filters = page.getByRole("group", { name: "문서 종류" });
  const kind = filters.getByRole("button").nth(1);
  await kind.click();
  await expect(kind).toHaveAttribute("aria-pressed", "true");
  expect(await results.count()).toBeLessThan(total);
  const labels = await results.locator(".doc-search-kind").allTextContents();
  expect(new Set(labels).size).toBe(1);
  await results.first().click();
  await expect(page.locator(".cm-content")).toContainText("Herdr");
});

test("project changes reset results and limit searches to that project", async ({ page }) => {
  await search(page, "Herdr");
  await expect(page.locator(".doc-search-hit").first()).toBeVisible();
  await page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true }).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "문서 검색어" })).toHaveValue("");
  await expect(page.locator(".doc-search-scope")).toHaveText("Sawhorse");
  await search(page, "Herdr");
  await expect(page.getByText("일치하는 문서가 없습니다", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "새로 검색", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "문서 검색어" })).toBeFocused();
  await search(page, "의도");
  await expect(page.locator(".doc-search-hit").first()).toBeVisible();
  for (const meta of await page.locator(".doc-search-hit-meta").allTextContents()) expect(meta).toContain("Sawhorse");
  await page.getByRole("button", { name: "검색어 지우기" }).click();
  await expect(page.getByRole("region", { name: "검색 결과", exact: true })).toHaveCount(0);
});
