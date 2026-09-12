import { test, expect, type Page } from "@playwright/test";

const nav = (page: Page, name: string) => page.locator("aside nav").getByRole("button", { name, exact: true }).click();
const picker = (page: Page) => page.getByRole("combobox", { name: "프로젝트 전환", exact: true });
const widget = (page: Page, name: string) => page.locator(".widget-grid-item").filter({ has: page.getByRole("heading", { name, exact: true }) });
async function selectProject(page: Page, name: string) {
  await picker(page).click();
  await page.getByRole("option", { name, exact: true }).click();
}
// Sidebar, workbench-view and filter selects are custom comboboxes: open the list, then pick the option.
async function choose(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
});

test("project scope follows navigation, new work, documents and reload without narrowing global search", async ({ page }) => {
  await selectProject(page, "Herdr");
  await expect(picker(page)).toContainText("Herdr");
  // The dashboard keeps every project's activity; global search must stay unscoped.
  await page.getByRole("button", { name: /전체 검색/ }).click();
  await page.getByPlaceholder("문서와 작업을 검색하세요").fill("마크다운 라이브 편집기");
  await expect(
    page.getByRole("option").filter({ hasText: "마크다운 라이브 편집기" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker(page)).toContainText("Herdr");
  await nav(page, "작업대");
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await expect(page.locator(".wb-board-card")).toHaveCount(2);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // The scoped workbench starts the flow for its own project, so no project picker is offered again.
  await expect(dialog.getByRole("combobox", { name: "프로젝트", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await nav(page, "캘린더");
  await expect(picker(page)).toContainText("Herdr");
  await nav(page, "대시보드");
  await page.reload();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await expect(picker(page)).toContainText("Herdr");
});

test("the shared widget layout keeps edits across project switches and reloads", async ({ page }) => {
  const globalCount = await page.locator(".widget-grid-item").count();
  await selectProject(page, "Sawhorse");
  await expect(page.locator(".widget-grid-item")).toHaveCount(globalCount);
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  await page.getByRole("button", { name: "기한 임박 위젯 숨기기", exact: true }).click();
  await expect(widget(page, "기한 임박")).toHaveCount(0);
  await page.getByRole("button", { name: "배치 완료", exact: true }).click();
  await selectProject(page, "Herdr");
  await expect(widget(page, "기한 임박")).toHaveCount(0);
  await page.reload();
  await expect(widget(page, "기한 임박")).toHaveCount(0);
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  await page.getByRole("button", { name: "모든 화면 기본 배치 복원", exact: true }).click();
  await expect(page.locator(".widget-grid-item")).toHaveCount(globalCount);
  await expect(widget(page, "기한 임박")).toBeVisible();
});

async function persistPreview(page: Page) {
  await nav(page, "프로젝트");
  await page.locator(".wb-project-card").filter({ hasText: "Sawhorse" }).getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  await page.locator("form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sawhorse.workflow.preview.v2"))).not.toBeNull();
}

test("workflow versions and nested processes keep separate counts, columns and stage filters", async ({ page }) => {
  await persistPreview(page);
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const store = JSON.parse(localStorage.getItem(key)!);
    const s = store.snapshot;
    const old = structuredClone(s.workflows.find((w: { id: string }) => w.id === "sdd-main"));
    old.version = "0.9.0";
    old.nodes.find((node: { id: string }) => node.id === "design").label = "구버전 설계";
    s.workflows.push(old);
    const base = s.work.find((item: { id: string }) => item.id === "work-intent");
    s.work = [
      { ...base, id: "sdd-current", title: "현재 설계", stage: "design", status: "running", activeNodes: [] },
      { ...base, id: "sdd-old", title: "이전 설계", stage: "design", status: "running", workflowVersion: "0.9.0", activeNodes: [] },
      { ...base, id: "nested-tdd", title: "구현 안의 테스트", stage: "build", status: "running", activeNodes: [{ workflowId: "tdd-cycle", workflowVersion: "1.0.0", nodeId: "red", nodeRunId: "red-run", depth: 1 }] },
      { ...base, id: "closed-sdd", title: "완료한 설계", stage: "design", status: "done", state: "closed", activeNodes: [] },
    ];
    // A new default must not relabel work that has pinned a prior process.
    s.projects[0].workflowId = "tdd-cycle";
    s.projects[0].workflowVersion = "1.0.0";
    localStorage.setItem(key, JSON.stringify(store));
    localStorage.setItem("sawhorse.project-scope", "sawhorse");
  });
  await page.reload();
  await expect(picker(page)).toContainText("Sawhorse");
  await nav(page, "작업대");
  await expect(page.getByRole("heading", { name: "Sawhorse 작업대", exact: true })).toBeVisible();
  // Each pinned process version keeps its own count in the workbench view picker.
  const views = page.getByRole("combobox", { name: "작업대 보기", exact: true });
  await views.click();
  for (const option of ["전체 작업 (4)", "기본 SDD · v1.1.0 (3) · 기존 작업만", "기본 SDD · v0.9.0 (1) · 기존 작업만", "TDD 사이클 · v1.0.0 (0)"]) {
    await expect(page.getByRole("option", { name: option, exact: true })).toBeVisible();
  }
  await page.getByRole("option", { name: "기본 SDD · v1.1.0 (3) · 기존 작업만", exact: true }).click();
  await expect(page.locator('[data-workflow="sdd-main@1.1.0"]')).toHaveCount(1);
  // Counts group by the owning workflow and version; the closed item stays in the done lane.
  await expect(page.locator(".wb-board-card")).toHaveCount(3);
  await page.getByRole("button", { name: "필터", exact: true }).click();
  await choose(page, "단계 필터", "설계");
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toContainText("현재 설계");
  await views.click();
  await page.getByRole("option", { name: "기본 SDD · v0.9.0 (1) · 기존 작업만", exact: true }).click();
  await expect(page.locator('[data-workflow="sdd-main@0.9.0"]')).toContainText("구버전 설계");
  await expect(page.locator(".wb-board-card")).toContainText("이전 설계");
  await choose(page, "단계 필터", "구버전 설계");
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toContainText("이전 설계");
  await views.click();
  await page.getByRole("option", { name: "TDD 사이클 · v1.0.0 (0)", exact: true }).click();
  await expect(page.locator('[data-workflow="tdd-cycle@1.0.0"]')).toContainText("Red");
  // The nested run lists under its owning workflow's view; the TDD view shows its lanes empty.
  await expect(page.locator(".wb-board-card")).toHaveCount(0);
  await views.click();
  await page.getByRole("option", { name: "전체 작업 (4)", exact: true }).click();
  await expect(page.getByText("4개 작업", { exact: true })).toBeVisible();
  await expect(page.locator(".wb-issue-table")).toContainText("이전 설계");
  await expect(page.locator(".wb-issue-table")).toContainText("구현 안의 테스트");
});

test("an empty project displays its configured process and stale project selection falls back to all", async ({ page }) => {
  await persistPreview(page);
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const store = JSON.parse(localStorage.getItem(key)!);
    store.snapshot.work = [];
    localStorage.setItem(key, JSON.stringify(store));
    localStorage.setItem("sawhorse.project-scope", "sawhorse");
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
  await expect(picker(page)).toContainText("Sawhorse");
  await nav(page, "작업대");
  await expect(page.getByRole("heading", { name: "Sawhorse 작업대", exact: true })).toBeVisible();
  await expect(page.locator('.wb-process-group[data-workflow="sdd-main@1.1.0"]')).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toHaveCount(0);
  await expect(page.getByText("0개 작업", { exact: true })).toBeVisible();
  await expect(page.getByLabel("기본 워크플로우")).toContainText("기본 SDD · v1.1.0");
  await page.evaluate(() => localStorage.setItem("sawhorse.project-scope", "deleted-project"));
  await page.reload();
  await expect(picker(page)).toContainText("프로젝트 선택");
  await expect(page.getByRole("heading", { name: "대시보드", exact: true })).toBeVisible();
});

test("sidebar groups runs by source and preserves project scope between tabs", async ({ page }) => {
  const sidebar = page.locator("aside nav");
  const projectViews = sidebar.getByRole("region", { name: "프로젝트", exact: true });
  const workspace = sidebar.getByRole("region", { name: "공통 도구", exact: true });
  const location = page.getByLabel("현재 위치", { exact: true });
  await selectProject(page, "Sawhorse");
  for (const name of ["작업대", "실행", "작업 문서 검색"]) {
    await expect(projectViews.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const name of ["개발 실행", "실행 기록"]) {
    await expect(projectViews.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  for (const name of ["자동화", "프로젝트", "프로젝트 라이브러리", "워크플로", "에이전트"]) {
    await expect(workspace.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  await selectProject(page, "Herdr");
  await nav(page, "실행");
  await expect(location).toContainText("Herdr");
  await expect(projectViews.getByRole("button", { name: "실행", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("작업의 설계·구현·검증을 수행한 에이전트 실행입니다.", { exact: false })).toBeVisible();
  // Work runs have their own page; source tabs live on the shared automation and agent pages instead.
  await expect(page.getByLabel("화면 선택", { exact: true })).toHaveCount(0);
  await nav(page, "자동화");
  const runTabs = page.getByLabel("화면 선택", { exact: true });
  await runTabs.getByRole("button", { name: "자동화·도구 실행", exact: true }).click();
  await expect(runTabs.getByRole("button", { name: "자동화·도구 실행", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("자동화 작업·예약과 개별 도구에서 시작한 실행입니다.", { exact: false })).toBeVisible();
  await expect(projectViews.getByRole("button", { name: "실행", exact: true })).not.toHaveAttribute("aria-current", "page");
  await expect(picker(page)).toContainText("Herdr");
  await selectProject(page, "Sawhorse");
  await expect(picker(page)).toContainText("Sawhorse");
  await nav(page, "실행");
  await expect(location).toContainText("Sawhorse");
  await expect(page.getByText("작업의 설계·구현·검증을 수행한 에이전트 실행입니다.", { exact: false })).toBeVisible();
  await nav(page, "에이전트");
  await expect(workspace.getByRole("button", { name: "에이전트", exact: true })).toHaveAttribute("aria-current", "page");
  const agentTabs = page.getByLabel("화면 선택", { exact: true });
  await expect(agentTabs.getByRole("button", { name: "작업 실행", exact: true })).toHaveCount(0);
  await expect(agentTabs.getByRole("button", { name: "협업 세션", exact: true })).toBeVisible();
  await expect(picker(page)).toContainText("Sawhorse");
});
