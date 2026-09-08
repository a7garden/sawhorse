import { expect, test } from "@playwright/test";

const previewKey = "sawhorse.workflow.preview.v2";

test("board and list share selection and queue selected tasks in goal mode with partial results", async ({ page }) => {
  await page.goto("/?preview=1&lifecycle=1");
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  const original = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.find((w: { id: string }) => w.id === "work-editor"), previewKey);
  await page.getByRole("checkbox", { name: /^work-editor / }).check();
  await page.getByRole("checkbox", { name: /^work-session / }).check();
  await page.getByRole("checkbox", { name: /^work-release / }).check();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".wb-bulk-bar")).toContainText("3건 선택");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: /^work-editor / })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^work-session / })).toBeChecked();
  await page.getByRole("button", { name: "골 모드로 일괄 실행", exact: true }).click();
  await expect(page.locator(".wb-goal-batch-results")).toContainText("2개 실행 접수 · 0개 이미 대기 중 · 1개 건너뜀");
  await expect(page.locator(".wb-goal-batch-results")).toContainText("첫 작업대 배포 기록");
  await expect(page.getByRole("checkbox", { name: /^work-editor / })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^work-release / })).toBeChecked();
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), previewKey);
  expect(state.goalSources["work-editor"]).toEqual(original);
  expect(state.snapshot.work.find((w: { id: string }) => w.id === "work-editor").workflowId).toBe("goal-main");
  expect(state.goals["work-session"].status).toBe("ready");
  expect(state.goals["work-release"]).toBeUndefined();
  await page.getByRole("button", { name: "선택 해제", exact: true }).click();
  await page.getByRole("checkbox", { name: /^work-editor / }).check();
  await page.getByRole("button", { name: "골 모드로 일괄 실행", exact: true }).click();
  await expect(page.locator(".wb-goal-batch-results")).toContainText("0개 실행 접수 · 1개 이미 대기 중");
});

test("filtering removes hidden selections from goal bulk execution", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("checkbox", { name: "전체 선택", exact: true }).check();
  await page.getByPlaceholder("작업 이름, ID, 담당자, 태그 검색…").fill("work-editor");
  await expect(page.locator(".wb-bulk-bar")).toContainText("1건 선택");
  await page.screenshot({ path: "test-results/goal-bulk-selection.png", fullPage: true });
  await page.getByRole("button", { name: "골 모드로 일괄 실행", exact: true }).click();
  await expect(page.locator(".wb-goal-batch-results")).toContainText("1개 실행 접수");
  expect(await page.evaluate((key) => Object.keys(JSON.parse(localStorage.getItem(key)!).goals), previewKey)).toEqual(["work-editor"]);
});

test("goal creation preserves autonomous settings and exposes controls without approval steps", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByRole("button", { name: "골 모드", exact: true }).click();
  await expect(page.getByRole("heading", { name: "도달할 목표를 정해 주세요" })).toBeVisible();
  await page.getByLabel("목표와 완료 기준").fill("플레이 가능한 게임\n10개 웨이브와 점수, 재시작을 구현하고 검증한다.");
  await page.getByLabel("최대 병렬 작업").fill("4");
  await page.getByRole("combobox", { name: "프로젝트", exact: true }).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await page.getByRole("button", { name: "목표 저장", exact: true }).click();
  const panel = page.getByRole("region", { name: "골 모드", exact: true });
  await expect(panel).toContainText("최대 4개 병렬");
  await expect(panel).toContainText("1시간마다 자동 재시도");
  await expect(panel.getByRole("button", { name: "재개", exact: true })).toBeVisible();
  await expect(page.locator(".wb-stepper")).toHaveCount(0);
  await expect(page.locator(".wb-review-note")).toHaveCount(0);
  await page.screenshot({ path: "test-results/goal-mode.png", fullPage: true });
  await panel.getByRole("button", { name: "목표 취소", exact: true }).click();
  await expect(panel).toContainText("취소됨");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sawhorse.workflow.preview.v2")!));
  const goal = Object.values(saved.goals)[0] as { status: string; maxParallel: number; objective: string };
  expect(goal.status).toBe("cancelled");
  expect(goal.maxParallel).toBe(4);
  expect(goal.objective).toContain("10개 웨이브");
});
