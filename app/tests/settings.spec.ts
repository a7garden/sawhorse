import { test, expect, type Page } from "@playwright/test";

const category = (page: Page, name: string) => page.getByRole("navigation", { name: "설정", exact: true }).getByRole("button", { name, exact: true }).click();
const openSettings = (page: Page) => page.locator("aside nav").getByRole("button", { name: "설정", exact: true }).click();

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await openSettings(page);
  await expect(page.getByRole("heading", { name: "화면 스타일", exact: true })).toBeVisible();
});

test("drafts survive category changes and save or revert together", async ({ page }) => {
  const save = page.getByRole("button", { name: "저장", exact: true });
  await expect(save).toBeDisabled();
  await category(page, "볼트");
  const path = page.getByLabel("볼트 경로", { exact: true });
  const original = await path.inputValue();
  await path.fill("/preview/settings-redesign");
  await category(page, "협업");
  await page.getByPlaceholder("예: 기본", { exact: true }).fill("작업 중인 프로필");
  await category(page, "앱");
  await expect(save).toBeEnabled();
  await expect(page.getByText("저장하지 않은 변경", { exact: true })).toBeVisible();
  await category(page, "협업");
  await expect(page.getByPlaceholder("예: 기본", { exact: true })).toHaveValue("작업 중인 프로필");
  await category(page, "볼트");
  await expect(path).toHaveValue("/preview/settings-redesign");
  await page.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(path).toHaveValue(original);
  await path.fill("/preview/settings-redesign");
  await category(page, "앱");
  await save.click();
  await expect(page.getByText("설정을 저장했습니다.", { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.reload();
  await openSettings(page);
  await category(page, "볼트");
  await expect(path).toHaveValue("/preview/settings-redesign");
});

test("validation opens the category containing an invalid hidden field", async ({ page }) => {
  await category(page, "실행");
  await page.getByLabel("claude 실행 파일", { exact: true }).fill("");
  await category(page, "앱");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("heading", { name: "실행", exact: true })).toBeVisible();
  await expect(page.getByText("claude 실행 파일을 입력하세요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
});

test("theme and language apply immediately and compact navigation stays usable", async ({ page }) => {
  await page.getByRole("radio", { name: "다크", exact: true }).check();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("radio", { name: "라이트", exact: true }).check();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.getByRole("combobox", { name: "언어", exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await page.locator("aside nav").getByRole("button", { name: "Workbench", exact: true }).click();
  await expect(page.locator('[data-widget="next"] time').first()).toHaveText(/^[A-Z][a-z]{2} \d{1,2}$/);
  await page.locator("aside nav").getByRole("button", { name: "Settings", exact: true }).click();
  await page.setViewportSize({ width: 800, height: 900 });
  const nav = page.getByRole("navigation", { name: "Settings", exact: true });
  for (const name of ["Vault", "Execution", "Collaboration", "Diagnostics", "App"]) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true, level: 2 })).toBeVisible();
    const overflow = await page.locator(".settings-page").evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflow).toBe(false);
  }
  await page.reload();
  await expect(page.locator("aside nav").getByRole("button", { name: "Journal", exact: true })).toBeVisible();
  await page.locator("aside nav").getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
});
