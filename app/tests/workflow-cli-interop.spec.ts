import { expect, test } from "@playwright/test";

// The browser preview models the same revision contract as the desktop CLI.
// Simulate a second writer through its persisted workspace, without a Tauri host.
test("external workflow drafts appear without overwriting unsaved Studio edits", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: "워크플로", exact: true }).click();
  await page.getByRole("button", { name: /기능 개발 요청 정리/ }).click();
  await page.getByRole("button", { name: "초안 만들어 줘", exact: true }).click();
  const name = page.getByLabel("워크플로 이름", { exact: true });
  await expect(name).toBeVisible();
  await name.fill("앱에서 작성한 초안");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("초안을 저장했습니다");
  await name.fill("아직 저장하지 않은 앱 수정");
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const state = JSON.parse(localStorage.getItem(key)!);
    const selected = state.drafts.find((draft: { definition: { label: string } }) => draft.definition.label === "앱에서 작성한 초안");
    selected.definition.label = "터미널에서 수정한 초안";
    selected.revision = "external-revision";
    const created = structuredClone(selected);
    created.draftId = "cli-created";
    created.definition.id = "cli-created";
    created.definition.label = "터미널에서 만든 새 흐름";
    state.drafts.push(created);
    localStorage.setItem(key, JSON.stringify(state));
    window.dispatchEvent(new Event("focus"));
  });
  await expect(page.locator(".studio-library-item").filter({ hasText: "터미널에서 만든 새 흐름" })).toBeVisible();
  await expect(name).toHaveValue("아직 저장하지 않은 앱 수정");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("revision-conflict");
  await expect(name).toHaveValue("아직 저장하지 않은 앱 수정");
  await page.locator(".studio-library-item").filter({ hasText: "터미널에서 수정한 초안" }).click();
  await expect(name).toHaveValue("터미널에서 수정한 초안");
  await name.fill("두 수정을 반영한 초안");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("초안을 저장했습니다");
});
