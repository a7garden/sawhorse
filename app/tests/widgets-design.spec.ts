import { expect, test } from "@playwright/test";

test("a small widget scrolls by keyboard while its title and actions remain available", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sawhorse.dashboard-layout", JSON.stringify({
      version: 4,
      enabled: ["next"],
      layouts: {
        lg: [{ i: "next", x: 0, y: 0, w: 3, h: 5 }],
        md: [{ i: "next", x: 0, y: 0, w: 3, h: 5 }],
        sm: [{ i: "next", x: 0, y: 0, w: 2, h: 5 }],
      },
    }));
  });
  await page.goto("/?preview=1");
  const widget = page.locator('[data-widget="next"]');
  const title = widget.getByRole("heading", { name: "다음 작업", exact: true });
  const content = widget.getByRole("group", { name: "다음 작업", exact: true });
  await expect(title).toBeInViewport();
  const initialTitle = (await title.boundingBox())!;
  await content.focus();
  await page.keyboard.press("End");
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(Math.abs((await title.boundingBox())!.y - initialTitle.y)).toBeLessThan(1);
  const geometry = await content.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1);
  await expect(widget.getByRole("button", { name: "작업 검토", exact: true }).last()).toBeVisible();
  await widget.getByRole("button", { name: "작업 편집", exact: true }).last().click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("checklist widgets can be added, completed and restored with their progress", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.getByRole("button", { name: "위젯 추가", exact: true }).click();
  await page.getByRole("textbox", { name: "위젯 검색", exact: true }).fill("할 일");
  const catalog = page.getByRole("dialog");
  await catalog.getByRole("switch", { name: /^할 일 볼트/ }).check();
  await catalog.getByRole("button", { name: "닫기", exact: true }).click();
  const checklist = page.locator('[data-widget="checklist"]');
  // 완료 항목이 목록 맨 아래로 재배치되므로 check() 의 같은-요소 검증 대신 한 번 누른다.
  await checklist.getByRole("checkbox", { name: "작업대 위젯 훑어보기", exact: true }).click();
  await expect(checklist.getByRole("checkbox", { name: "작업대 위젯 훑어보기", exact: true })).toBeChecked();
  await expect(checklist.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await page.reload();
  await expect(checklist.getByRole("checkbox", { name: "작업대 위젯 훑어보기", exact: true })).toBeChecked();
  await expect(checklist.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await checklist.getByRole("button", { name: "체크리스트 열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "할 일", exact: true })).toBeVisible();
});
