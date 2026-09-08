import { expect, test, type Page } from "@playwright/test";
import { isTaskRecord, taskStage, workArea } from "../src/features/workbench/task-board";
import type { WorkItem } from "../src/features/workbench/types";

const KEY = "sawhorse.workflow.preview.v2";
const nav = (page: Page) => page.locator("aside nav").getByRole("button", { name: "작업", exact: true });
const area = (page: Page, name: RegExp) => page.getByRole("group", { name: "작업 공간" }).getByRole("button", { name });
const stages = ["구체화", "설계", "승인 대기", "구현 대기", "구현", "완료·미확인", "완료"];
async function open(page: Page, fixture = false) { await page.goto(fixture ? "/?preview=1&lifecycle=1&mockups=1" : "/?preview=1"); await nav(page).click(); }

test("normal entry has one complete lifecycle board and excludes inbox notes from task counts", async ({ page }) => {
  await open(page);
  await expect(page.locator(".wb-task-lane-head h2")).toHaveText(stages);
  await expect(page.locator(".wb-process-group")).toHaveCount(0);
  await expect(page.locator(".wb-work-heading > span")).toHaveText("5");
  await expect(page.locator(".wb-board-card")).toHaveCount(5);
  await expect(page.locator('[data-stage="done"]')).toContainText("첫 작업대 배포 기록");
  await area(page, /^의도 인박스/).click();
  await expect(page.locator(".wb-inbox-notes article")).toHaveCount(2);
  await expect(page.locator(".wb-work-results")).toContainText("작업 수에 포함되지 않음");
  await expect(page.getByRole("button", { name: "마일스톤과 개발 일정 연결", exact: true })).toBeVisible();
});

test("an empty project still shows every lifecycle stage and keeps its inbox separate", async ({ page }) => {
  await open(page);
  await page.getByRole("combobox", { name: "프로젝트 필터" }).click();
  await page.getByRole("option", { name: "Knowledge", exact: true }).click();
  await expect(page.locator(".wb-task-lane-head h2")).toHaveText(stages);
  await expect(page.locator(".wb-board-card")).toHaveCount(0);
  await expect(page.locator(".wb-work-heading > span")).toHaveText("0");
  await expect(area(page, /^의도 인박스/)).toContainText("1");
});

test("a saved note becomes a task only when clarification is requested", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "프로젝트", exact: true }).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("인박스에 남긴 생각");
  await page.getByRole("button", { name: "메모만 저장", exact: true }).click();
  await expect(page.locator(".wb-lifecycle")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator(".wb-work-heading > span")).toHaveText("5");
  await expect(page.locator(".wb-task-board")).not.toContainText("인박스에 남긴 생각");
  await area(page, /^의도 인박스/).click();
  await page.getByRole("button", { name: "인박스에 남긴 생각", exact: true }).click();
  await page.locator(".wb-lifecycle").getByRole("button", { name: "구체화 시작", exact: true }).click();
  await expect(page.locator(".wb-lifecycle").getByRole("heading", { name: "구체화", exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await area(page, /^작업 흐름/).click();
  await expect(page.locator('[data-stage="clarify"]')).toContainText("인박스에 남긴 생각");
  await expect(page.locator(".wb-work-heading > span")).toHaveText("6");
});

test("attention filters select designs and unconfirmed results while archive keeps cancellation separate", async ({ page }) => {
  await open(page, true);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const item = state.snapshot.work.find((w: WorkItem) => w.id === "lifecycle-inbox");
    item.stage = "cancelled"; item.status = "cancelled"; item.state = "closed";
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.reload(); await nav(page).click();
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work, KEY);
  await page.locator(".wb-task-overview").getByRole("button", { name: /검토할 설계/ }).click();
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator('[data-stage="approval"]')).toContainText("승인 대기");
  await page.locator(".wb-task-overview").getByRole("button", { name: /확인할 결과/ }).click();
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator('[data-stage="unconfirmed"]')).toContainText("완료·미확인");
  await area(page, /^보관함/).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".wb-issue-table")).toContainText("lifecycle-inbox");
  await area(page, /^작업 흐름/).click();
  await expect(page.locator('[data-stage="done"]')).toContainText("완료");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work, KEY)).toEqual(before);
});

test("legacy projection never invents approval or overwrites workflow data", () => {
  const work = { workflowId: "intent-flow", workflowVersion: "1.0.0", stage: "design", status: "running", artifacts: [], activeNodes: [], dependsOn: [] } as unknown as WorkItem;
  const before = JSON.stringify(work);
  expect(taskStage(work, [])).toBe("design");
  expect(taskStage({ ...work, status: "review" }, [])).toBe("approval");
  expect(taskStage({ ...work, stage: "build", status: "ready" }, [])).toBe("queued");
  expect(taskStage({ ...work, stage: "build", status: "running" }, [])).toBe("build");
  expect(taskStage({ ...work, workflowId: "custom", stage: "legal-review" }, [])).toBe("other");
  expect(workArea({ ...work, workflowId: "sdd-main", stage: "intent", status: "backlog" })).toBe("inbox");
  expect(workArea({ ...work, status: "cancelled" })).toBe("archive");
  expect(isTaskRecord({ ...work, workflowVersion: "2.0.0", stage: "cancelled", status: "cancelled", decisions: [{stage:"inbox", note:"cancel", at:""}] })).toBe(false);
  expect(isTaskRecord({ ...work, workflowVersion: "2.0.0", stage: "cancelled", status: "cancelled", decisions: [{stage:"clarify", note:"cancel", at:""}] })).toBe(true);
  expect(JSON.stringify(work)).toBe(before);
});

test("English navigation and both themes retain the lifecycle layout", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.evaluate(() => localStorage.setItem("sawhorse.language", "en"));
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "Work", exact: true }).click();
  await expect(page.locator(".wb-task-lane-head h2")).toHaveText(["Clarification", "Design", "Awaiting approval", "Implementation queue", "Implementation", "Awaiting confirmation", "Done"]);
  await expect(page.getByRole("group", { name: "Work spaces" })).toContainText("Intent inbox");
  const theme = page.locator("aside").getByRole("button", { name: /theme/i });
  for (let i = 0; i < 2; i++) {
    await theme.click();
    await expect(page.locator(".wb-task-board")).toBeVisible();
    const bounds = await page.locator(".wb-work-page").evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  }
});
