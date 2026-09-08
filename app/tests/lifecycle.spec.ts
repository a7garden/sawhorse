import { expect, test, type Page } from "@playwright/test";
const KEY = "sawhorse.workflow.preview.v2";
async function open(page: Page) { await page.goto("/?preview=1&lifecycle=1&mockups=1"); await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click(); }
const panel = (page: Page) => page.locator(".wb-lifecycle");
test("the board separates intent, clarification, approval, queue and unconfirmed results", async ({ page }) => {
  await open(page);
  const board = page.locator(".wb-task-board");
  await expect(board.locator(".wb-task-lane-head h2")).toHaveText(["구체화", "설계", "승인 대기", "구현 대기", "구현", "완료·미확인", "완료"]);
  await expect(page.getByRole("button", { name: "구현 대기 1개 일괄 실행", exact: true })).toBeVisible();
  await page.getByRole("group", { name: "작업 공간" }).getByRole("button", { name: /^의도 인박스/ }).click();
  await page.getByRole("button", { name: "의도", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "구체화 시작", exact: true })).toBeEnabled();
  await expect(panel(page).getByRole("button", { name: "설계 승인", exact: true })).toHaveCount(0);
});
test("an interview blocks design until the answer is durably saved", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "구체화", exact: true }).click();
  const question = panel(page).getByRole("complementary", { name: "결정이 필요해요" });
  await expect(question).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "방향 확인 · 설계 시작", exact: true })).toBeDisabled();
  await question.getByRole("button", { name: "이 기기에만", exact: true }).click();
  await question.getByRole("button", { name: "답변하고 계속", exact: true }).click();
  await expect(question).toHaveCount(0);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).lifecycle["lifecycle-clarify"].interviews[0].answer, KEY)).toBe("이 기기에만");
  await expect(panel(page).getByRole("button", { name: "방향 확인 · 설계 시작", exact: true })).toBeEnabled();
});
test("design approval queues work and never starts an agent implicitly", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "승인 대기", exact: true }).click();
  await panel(page).getByRole("button", { name: "설계 승인", exact: true }).click();
  await expect(panel(page).getByRole("heading", { name: "구현 대기", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "구현 시작", exact: true })).toBeEnabled();
  await expect(panel(page).getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).runs?.length ?? 0, KEY)).toBe(0);
});
test("one confirmation completes an implemented result", async ({ page }) => {
  await open(page); await page.getByRole("button", { name: "완료·미확인", exact: true }).click();
  await expect(panel(page).locator(".wb-commit")).toHaveText("a".repeat(40));
  await panel(page).getByRole("button", { name: "확인 · 완료", exact: true }).click();
  await expect(panel(page).getByRole("heading", { name: "완료", exact: true })).toBeVisible();
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.find((w: { id: string }) => w.id === "lifecycle-unconfirmed").status, KEY)).toBe("done");
});
test("discard shows downstream dependency impact before permitting a revert", async ({ page }) => {
  await open(page);
  await page.evaluate((key) => { const state = JSON.parse(localStorage.getItem(key)!); state.snapshot.work.find((w: { id: string }) => w.id === "lifecycle-design").dependsOn = ["lifecycle-unconfirmed"]; localStorage.setItem(key, JSON.stringify(state)); }, KEY);
  await page.getByRole("button", { name: "완료·미확인", exact: true }).click();
  await panel(page).getByRole("button", { name: "폐기", exact: true }).click();
  await expect(panel(page).getByText(/이 작업에 의존하는 항목이 있습니다/)).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "영향 확인 · 폐기 실행", exact: true })).toBeDisabled();
});
test("registered designs and artifact templates persist and attach to a project", async ({ page }) => {
  await open(page); await page.locator("aside nav").getByRole("button", { name: "프로젝트", exact: true }).click();
  const library = page.getByRole("region", { name: "디자인과 템플릿" });
  await library.getByLabel("이름", { exact: true }).fill("제품 디자인");
  await library.getByLabel("DESIGN.md", { exact: true }).fill("# DESIGN.md\n\n## Color Palette\nPrimary: #0064FF\n\n## Voice\n짧고 명확한 문장");
  await library.getByRole("button", { name: "저장", exact: true }).click();
  await library.getByRole("button", { name: "프로젝트에 적용", exact: true }).click();
  await expect(library.getByRole("status")).toContainText("프로젝트에 적용했습니다");
  await library.getByRole("button", { name: "산출물 템플릿", exact: true }).click();
  await library.getByLabel("이름", { exact: true }).fill("설계 양식");
  await library.getByLabel("템플릿 내용", { exact: true }).fill("# {{제목}}\n\n## 검증 기준\n<!-- 실제 명령과 기대 결과 -->");
  await library.getByRole("button", { name: "저장", exact: true }).click();
  await library.getByRole("button", { name: "프로젝트에 적용", exact: true }).click();
  await expect(library.getByRole("status")).toContainText("프로젝트에 적용했습니다");
  await page.reload(); await page.locator("aside nav").getByRole("button", { name: "프로젝트", exact: true }).click();
  await expect(library.locator(".wb-resource-list button")).toHaveCount(2);
  await expect(library).toContainText("제품 디자인");
  expect(await page.evaluate((key) => Object.values(JSON.parse(localStorage.getItem(key)!).resourceAssignments).some((a: any) => a.designId && a.templates.spec), KEY)).toBe(true);
});
test("mockup management groups latest revisions and exposes previous revisions", async ({ page }) => {
  await open(page); await page.getByRole("group", { name: "작업 공간" }).getByRole("button", { name: /^목업/ }).click();
  const library = page.getByRole("region", { name: "목업" });
  await expect(library.locator("article")).toHaveCount(1);
  await expect(library).toContainText("Rev 2");
  await library.getByRole("button", { name: "최신 개정만", exact: true }).click();
  await expect(library.locator("article")).toHaveCount(2);
  await library.getByRole("button", { name: "이전 개정 열기", exact: true }).click();
  await expect(page.locator(".wb-detail h2")).toContainText("첫 개정");
});
