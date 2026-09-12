import { expect, test, type Page } from "@playwright/test";

const KEY = "sawhorse.workflow.preview.v2";
const workNav = (page: Page) => page.locator("aside nav").getByRole("button", { name: "작업대", exact: true });
const cards = (page: Page) => page.locator(".wb-board-card");
const results = (page: Page) => page.locator(".wb-work-results").getByRole("status");
const filterToggle = (page: Page) => page.locator(".wb-work-toolbar").getByRole("button", { name: /^필터/ });
const scope = (page: Page) => page.getByRole("combobox", { name: "프로젝트 전환", exact: true });
async function selectProject(page: Page, name: string) {
  await scope(page).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function selectView(page: Page, name: string) {
  await page.getByRole("combobox", { name: "작업대 보기", exact: true }).click();
  await page.getByRole("option").filter({ hasText: name }).click();
}
async function choose(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  // The workbench is project-gated: scope to Sawhorse, then open 작업대.
  await selectProject(page, "Sawhorse");
  await workNav(page).click();
});

test("search carries across views, prunes hidden selections, and opens work with the keyboard", async ({ page }) => {
  await expect(cards(page)).toHaveCount(4);
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
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(4);
  await page.locator(".wb-work-title-link").filter({ hasText: "마크다운 라이브 편집기" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
});

test("advanced filters remain active when collapsed and reset together", async ({ page }) => {
  await filterToggle(page).click();
  await choose(page, "단계 필터", "검증");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.locator('[data-stage="test"]')).toContainText("마크다운 라이브 편집기");
  await filterToggle(page).click();
  await expect(page.getByRole("combobox", { name: "단계 필터", exact: true })).toHaveCount(0);
  await expect(filterToggle(page)).toContainText("1");
  await expect(results(page)).toHaveText("1개 작업");
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(cards(page)).toHaveCount(4);
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
  await expect(cards(page)).toHaveCount(4);
  await page.getByRole("button", { name: "마일스톤 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("done remains in the flow, list preference persists, and project scope applies", async ({ page }) => {
  await expect(page.locator('[data-stage="done"]')).toContainText("첫 작업대 배포 기록");
  await expect(page.getByRole("group", {name:"열림 상태"})).toHaveCount(0);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(4);
  await page.reload();
  await workNav(page).click();
  await expect(page.getByRole("button", { name: "목록", exact: true })).toHaveAttribute("aria-pressed", "true");
  await selectProject(page, "Herdr");
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  // The creation form is preset to the scoped project.
  await expect(page.getByRole("dialog")).toContainText("프로젝트: Herdr");
});

test("saving an intent adds an inbox note without increasing the work count", async ({ page }) => {
  // The lifecycle fixture only lands on the very first load, so reseed before entering.
  await page.evaluate((key) => localStorage.removeItem(key), KEY);
  await page.goto("/?preview=1&lifecycle=1");
  // The preview chunk loads lazily with the first command; wait for it to persist the fixture.
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), KEY), { timeout: 15000 }).not.toBeNull();
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    state.snapshot.projects.find((project: { id: string }) => project.id === "sawhorse").additionalWorkflows =
      [{ id: "intent-flow", version: "2.0.0" }];
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.reload();
  await selectProject(page, "Sawhorse");
  await workNav(page).click();
  await selectView(page, "SDD · 의도에서 완료까지");
  const inbox = page.getByRole("group", { name: "작업 공간" }).getByRole("button", { name: /^의도 인박스/ });
  await expect(inbox).toContainText("1");
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByRole("combobox", { name: "작업 워크플로우", exact: true }).click();
  await page.getByRole("option", { name: "SDD · 의도에서 완료까지 · v2.0.0", exact: true }).click();
  await page.getByRole("button", { name: "계속", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("# 의도 모아보기");
  await page.getByRole("button", { name: "메모만 저장", exact: true }).click();
  await expect(page.locator(".wb-lifecycle")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(cards(page)).toHaveCount(7);
  await expect(page.locator(".wb-work-heading > span")).toHaveText("7");
  await expect(inbox).toContainText("2");
  await inbox.click();
  await expect(results(page)).toHaveText("의도 2개 · 작업 수에 포함되지 않음");
  await expect(page.getByRole("button", { name: "의도 모아보기", exact: true })).toBeVisible();
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

test("sort choice orders the list and survives a reload", async ({ page }) => {
  await choose(page, "정렬 기준", "이슈 번호순");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const ids = page.locator(".wb-issue-table tbody tr .wb-issue-id");
  await expect(ids.first()).toHaveText("work-calendar");
  await expect(ids.last()).toHaveText("work-release");
  await page.getByRole("button", { name: "정렬 방향: 오름차순", exact: true }).click();
  await expect(ids.first()).toHaveText("work-release");
  await expect(ids.last()).toHaveText("work-calendar");
  await page.reload();
  await workNav(page).click();
  await expect(page.getByRole("combobox", { name: "정렬 기준", exact: true })).toContainText("이슈 번호순");
  await expect(ids.first()).toHaveText("work-release");
  // Switching axes resets the direction to that axis's default — title order is ascending again.
  await choose(page, "정렬 기준", "제목순");
  await expect(ids.first()).toHaveText("work-calendar");
  await expect(ids.last()).toHaveText("work-release");
});

test("the copilot rail answers about the open work item and remembers being closed", async ({ page }) => {
  await page.locator(".wb-board-card").filter({ hasText: "마크다운 라이브 편집기" }).click();
  const dialog = page.locator(".wb-detail-dialog");
  await expect(dialog).toBeVisible();
  const copilot = dialog.locator(".wb-copilot");
  await expect(copilot).toBeVisible();
  // Clicking an example question from the empty state sends it as-is and an answer follows.
  await copilot.getByRole("button", { name: "이 작업을 한 문단으로 요약해 줘", exact: true }).click();
  await expect(copilot.locator(".wb-copilot-question")).toHaveText("이 작업을 한 문단으로 요약해 줘");
  await expect(copilot.locator(".wb-copilot-answer")).toContainText("마크다운 라이브 편집기");
  // A hand-typed question continues the same conversation.
  await copilot.getByRole("textbox", { name: "질문", exact: true }).fill("다음 단계는?");
  await copilot.getByRole("button", { name: "묻기", exact: true }).click();
  await expect(copilot.locator(".wb-copilot-question")).toHaveCount(2);
  await expect(copilot.locator(".wb-copilot-answer")).toHaveCount(2);
  // Once collapsed, it stays collapsed the next time the detail opens.
  await dialog.getByRole("button", { name: "코파일럿", exact: true }).click();
  await expect(copilot).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".wb-board-card").filter({ hasText: "마일스톤과 개발 일정 연결" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".wb-copilot")).toHaveCount(0);
  await dialog.getByRole("button", { name: "코파일럿", exact: true }).click();
  await expect(dialog.locator(".wb-copilot")).toBeVisible();
});
