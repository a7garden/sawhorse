import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto('/?preview=1');
  await page.locator('aside nav').getByRole('button', { name: '일지', exact: true }).click();
  await expect(page.getByRole('heading', { name: '일지', exact: true })).toBeVisible();
});

test('journal calendar, archive search and empty months keep the reader in sync', async ({ page }) => {
  const calendar = page.locator('.journal-calendar');
  const days = calendar.getByRole('button', { name: /일지 읽기/ });
  await expect(days.first()).toBeVisible();
  await days.first().click();
  const date = (await days.first().getAttribute('aria-label'))!.split(' ')[0];
  await expect(page.locator('.journal-file')).toContainText(date);
  await expect(page.locator('.journal-prose')).toContainText('오늘 한 일');
  await page.getByRole('textbox', { name: '날짜, 제목, 태그 검색' }).fill('회고');
  await expect(page.locator('.journal-entry')).toHaveCount(3);
  await page.getByRole('textbox', { name: '날짜, 제목, 태그 검색' }).fill('존재하지 않는 일지');
  await expect(page.getByText('검색한 기록이 없습니다.')).toBeVisible();
  await expect(page.locator('.journal-paper')).toHaveCount(0);
  await page.getByRole('button', { name: '다음 달', exact: true }).click();
  await expect(page.getByText('이달에는 아직 기록이 없습니다.')).toBeVisible();
  await page.getByRole('button', { name: '최근 기록으로 이동', exact: true }).click();
  await expect(page.locator('.journal-prose')).toContainText('오늘 한 일');
});

test('journal reader switches back to the list in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 850 });
  await expect(page.locator('.journal-reader')).toBeHidden();
  await page.locator('.journal-entry').first().click();
  await expect(page.locator('.journal-reader')).toBeVisible();
  await expect(page.locator('.journal-index')).toBeHidden();
  await page.getByRole('button', { name: '기록 탐색', exact: true }).click();
  await expect(page.locator('.journal-index')).toBeVisible();
  await expect(page.locator('.journal-reader')).toBeHidden();
});

test('checklist completion persists and journal widget opens the reading page', async ({ page }) => {
  await page.locator('aside nav').getByRole('button', { name: '작업대', exact: true }).click();
  // 할 일과 일지 위젯은 카탈로그에서 켠다. 켜진 위젯과 체크 상태는 모두 남는다.
  const openCatalog = async () => {
    await page.getByRole('button', { name: '위젯 추가', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  };
  await openCatalog();
  await page.getByRole('textbox', { name: '위젯 검색' }).fill('할 일');
  await page.getByRole('dialog').getByRole('switch', { name: /^할 일/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  const checklist = page.locator('.journal-checklist');
  await expect(checklist).toBeVisible();
  await checklist.getByRole('checkbox', { name: '작업대 위젯 훑어보기' }).click();
  await expect(checklist.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  await page.reload();
  await expect(checklist.getByRole('checkbox', { name: '작업대 위젯 훑어보기' })).toBeChecked();
  await openCatalog();
  await page.getByRole('textbox', { name: '위젯 검색' }).fill('일지');
  await page.getByRole('dialog').getByRole('switch', { name: /^일지/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('.widget-grid-item .journal-widget')).toBeVisible();
  await page.locator('.widget-grid-item .journal-widget-latest').click();
  await expect(page.getByRole('heading', { name: '일지', exact: true })).toBeVisible();
});
