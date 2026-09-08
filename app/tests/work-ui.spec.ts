import { expect, test, type Page } from "@playwright/test";

const workNav = (page: Page) => page.locator("aside nav").getByRole("button", { name: "작업", exact: true });
const cards = (page: Page) => page.locator(".wb-board-card");
const results = (page: Page) => page.locator(".wb-work-results").getByRole("status");
const filterToggle = (page: Page) => page.locator(".wb-work-toolbar").getByRole("button", { name: /^필터/ });
async function choose(page: Page, name: string, option: string) {
  await page.getByRole("combobox", { name, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "작업대", exact: true })).toBeVisible();
  await workNav(page).click();
});

test("search carries across views, prunes hidden selections, and opens work with the keyboard", async ({ page }) => {
  await expect(cards(page)).toHaveCount(5);
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
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(5);
  await page.locator(".wb-work-title-link").filter({ hasText: "마크다운 라이브 편집기" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
});

test("advanced filters remain active when collapsed and reset together", async ({ page }) => {
  await filterToggle(page).click();
  await choose(page, "단계 필터", "구현");
  await expect(cards(page)).toHaveCount(3);
  await expect(page.locator('[data-stage="build"]')).toContainText("Herdr 실행과 기록 연결");
  await filterToggle(page).click();
  await expect(page.getByRole("combobox", { name: "단계 필터", exact: true })).toHaveCount(0);
  await expect(filterToggle(page)).toContainText("1");
  await expect(results(page)).toHaveText("3개 작업");
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(cards(page)).toHaveCount(5);
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
  await expect(cards(page)).toHaveCount(5);
  await page.getByRole("button", { name: "마일스톤 추가", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("done remains in the flow, list preference persists, and project scope applies", async ({ page }) => {
  await expect(page.locator('[data-stage="done"]')).toContainText("첫 작업대 배포 기록");
  await expect(page.getByRole("group", {name:"열림 상태"})).toHaveCount(0);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(5);
  await page.reload();
  await workNav(page).click();
  await expect(page.getByRole("button", { name: "목록", exact: true })).toHaveAttribute("aria-pressed", "true");
  await choose(page, "프로젝트 필터", "Herdr");
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "프로젝트", exact: true })).toContainText("Herdr");
});

test("the intent tab gathers intent work without dropping the state axis", async ({ page }) => {
  const intentTab = page.locator(".wb-work-intent-tab");
  // 의도가 하나도 없으면 탭도 없다. 첫 의도를 남기면 그때 상태 탭 옆에 붙는다.
  await expect(intentTab).toHaveCount(0);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByRole("dialog").getByRole("combobox", { name: "프로젝트", exact: true }).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("# 의도 모아보기");
  await page.getByRole("button", { name: "메모만 저장", exact: true }).click();
  await expect(page.locator(".wb-intent-flow")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(cards(page)).toHaveCount(7);
  await expect(intentTab).toContainText("1");
  await intentTab.click();
  await expect(results(page)).toHaveText("1개 작업");
  await expect(cards(page)).toContainText("의도 모아보기");
  // 상태는 여전히 제 축이다. 닫힌 작업으로 옮기면 두 축이 함께 걸린다.
  const states = page.getByRole("group", { name: "열림 상태", exact: true });
  await states.getByRole("button", { name: /^닫힌 작업/ }).click();
  await expect(intentTab).toContainText("0");
  await expect(page.getByText("조건에 맞는 작업이 없습니다", { exact: true })).toBeVisible();
  await page.locator(".wb-empty").getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(intentTab).toHaveAttribute("aria-pressed", "false");
  await expect(cards(page)).toHaveCount(1);
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

test("sort choice orders the list and the board alike, and survives a reload", async ({ page }) => {
  const intake = page.locator('[data-stage="intent"] .wb-board-card');
  await choose(page, "정렬 기준", "이슈 번호순");
  await expect(intake.first()).toContainText("work-calendar");
  await page.getByRole("button", { name: "정렬 방향: 오름차순", exact: true }).click();
  await expect(intake.first()).toContainText("work-search");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const ids = page.locator(".wb-issue-table tbody tr .wb-issue-id");
  await expect(ids.first()).toHaveText("work-session");
  await expect(ids.last()).toHaveText("work-calendar");
  await page.reload();
  await workNav(page).click();
  await expect(page.getByRole("combobox", { name: "정렬 기준", exact: true })).toContainText("이슈 번호순");
  await expect(ids.first()).toHaveText("work-session");
  // 축을 바꾸면 방향은 그 축의 기본값으로 돌아간다 — 기한은 임박한 쪽이 먼저다.
  await choose(page, "정렬 기준", "기한순");
  await expect(ids.first()).toHaveText("work-session");
  await expect(ids.last()).toHaveText("work-search");
});

test("the copilot rail answers about the open work item and remembers being closed", async ({ page }) => {
  await page.locator(".wb-board-card").filter({ hasText: "마크다운 라이브 편집기" }).click();
  const dialog = page.locator(".wb-detail-dialog");
  await expect(dialog).toBeVisible();
  const copilot = dialog.locator(".wb-copilot");
  await expect(copilot).toBeVisible();
  // 빈 상태의 예시 질문을 누르면 그대로 질문이 되어 답이 붙는다.
  await copilot.getByRole("button", { name: "이 작업을 한 문단으로 요약해 줘", exact: true }).click();
  await expect(copilot.locator(".wb-copilot-question")).toHaveText("이 작업을 한 문단으로 요약해 줘");
  await expect(copilot.locator(".wb-copilot-answer")).toContainText("마크다운 라이브 편집기");
  // 직접 쓴 질문도 같은 대화에 이어 붙는다.
  await copilot.getByRole("textbox", { name: "질문", exact: true }).fill("다음 단계는?");
  await copilot.getByRole("button", { name: "묻기", exact: true }).click();
  await expect(copilot.locator(".wb-copilot-question")).toHaveCount(2);
  await expect(copilot.locator(".wb-copilot-answer")).toHaveCount(2);
  // 접어 두면 다음에 연 상세에서도 접혀 있다.
  await dialog.getByRole("button", { name: "코파일럿", exact: true }).click();
  await expect(copilot).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator(".wb-board-card").filter({ hasText: "프로젝트를 넘나드는 지식 검색" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".wb-copilot")).toHaveCount(0);
  await dialog.getByRole("button", { name: "코파일럿", exact: true }).click();
  await expect(dialog.locator(".wb-copilot")).toBeVisible();
});
