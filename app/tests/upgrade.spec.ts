import { test, expect, type Page } from "@playwright/test";

async function nativeUpgrade(page: Page, status: "completed" | "failed") {
  await page.addInitScript(({ status }) => {
    const global = window as unknown as { isTauri: boolean; __TAURI_INTERNALS__: unknown; upgradeCommands: string[] };
    global.isTauri = true;
    global.upgradeCommands = [];
    global.__TAURI_INTERNALS__ = {
      invoke: async (command: string) => {
        global.upgradeCommands.push(command);
        if (command === "upgrade_retry") throw new Error("원본 문서의 날짜를 확인하세요");
        if (command !== "upgrade_status") throw new Error(`업그레이드 중 앱 명령 실행: ${command}`);
        return {
          id: "fixture", status, changed: true, migrated: 3,
          error: status === "failed" ? "마일스톤 날짜가 유효하지 않습니다" : null,
          steps: ["볼트 데이터 변환·검증 및 원본 백업"],
          notices: ["이전 엑셀 자동화를 일시 중지했습니다"],
          backups: ["/fixture/backup/vault"],
        };
      },
    };
  }, { status });
  await page.goto("/?preview=1");
}

test("upgrade failure gates app commands and keeps retry errors visible", async ({ page }) => {
  await nativeUpgrade(page, "failed");
  await expect(page.getByText("마일스톤 날짜가 유효하지 않습니다")).toBeVisible();
  await expect(page.locator("aside nav")).toHaveCount(0);
  await expect(page.getByText("복구 가능한 문제를 자동으로 정리", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "자동 복구하고 계속" }).click();
  await expect(page.getByText("원본 문서의 날짜를 확인하세요", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { upgradeCommands: string[] }).upgradeCommands))
    .toEqual(expect.arrayContaining(["upgrade_status", "upgrade_retry"]));
  expect(await page.evaluate(() => (window as unknown as { upgradeCommands: string[] }).upgradeCommands.every(c => c.startsWith("upgrade_"))))
    .toBe(true);
});

test("upgrade result exposes backups and notices before opening the workspace", async ({ page }) => {
  await nativeUpgrade(page, "completed");
  await expect(page.getByRole("heading", { name: "작업공간 업그레이드 완료" })).toBeVisible();
  await expect(page.getByText("이전 엑셀 자동화를 일시 중지했습니다")).toBeVisible();
  await page.locator("summary").click();
  await expect(page.getByText("/fixture/backup/vault")).toBeVisible();
  await page.evaluate(() => { (window as unknown as { isTauri: boolean }).isTauri = false; });
  await page.getByRole("button", { name: "작업공간 열기" }).click();
  await expect(page.locator("aside nav")).toBeVisible();
  await expect(page.getByRole("heading", { name: "작업공간 업그레이드 완료" })).toHaveCount(0);
});
