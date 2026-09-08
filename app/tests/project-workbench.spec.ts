import { test, expect, type Page } from "@playwright/test";

const nav = (page: Page, name: string) => page.locator("aside nav").getByRole("button", { name, exact: true }).click();
const scope = (page: Page) => page.getByLabel("프로젝트 범위", { exact: true });
const widget = (page: Page, name: string) => page.locator(".widget-grid-item").filter({ has: page.getByRole("heading", { name, exact: true }) });

test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.getByRole("heading", { name: "작업대", exact: true })).toBeVisible();
});

test("project scope follows navigation, new work, documents and reload without narrowing global search", async ({ page }) => {
  await scope(page).selectOption("herdr");
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await expect(widget(page, "다음 작업")).toContainText("Herdr 실행과 기록 연결");
  await expect(widget(page, "다음 작업")).not.toContainText("마크다운 라이브 편집기");
  await expect(widget(page, "작업 문서")).not.toContainText("마크다운 라이브 편집기");
  await page.getByRole("button", { name: /전체 검색/ }).click();
  await page.getByPlaceholder("문서와 작업을 검색하세요").fill("마크다운 라이브 편집기");
  await expect(
    page.getByRole("option").filter({ hasText: "마크다운 라이브 편집기" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(scope(page)).toHaveValue("herdr");
  await nav(page, "작업");
  await expect(page.getByLabel("프로젝트 필터")).toHaveValue("herdr");
  await expect(page.locator(".wb-board-card")).toHaveCount(2);
  await page.getByRole("button", { name: "새 작업", exact: true }).click();
  await expect(page.getByLabel("프로젝트", { exact: true })).toHaveValue("herdr");
  await page.keyboard.press("Escape");
  await nav(page, "캘린더");
  await expect(scope(page)).toHaveValue("herdr");
  await expect(page.locator(".wb-calendar")).not.toContainText("SDD 명세 검토");
  await nav(page, "작업대");
  await page.reload();
  await expect(scope(page)).toHaveValue("herdr");
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
});

test("project layouts retain independent hidden widgets and leave the global layout intact", async ({ page }) => {
  const globalCount = await page.locator(".widget-grid-item").count();
  await scope(page).selectOption("sawhorse");
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  await page.getByRole("button", { name: "작업 문서 위젯 숨기기", exact: true }).click();
  await expect(widget(page, "작업 문서")).toHaveCount(0);
  await scope(page).selectOption("herdr");
  await expect(widget(page, "작업 문서")).toBeVisible();
  await scope(page).selectOption("sawhorse");
  await expect(widget(page, "작업 문서")).toHaveCount(0);
  await page.reload();
  await expect(widget(page, "작업 문서")).toHaveCount(0);
  await scope(page).selectOption("");
  await expect(page.locator(".widget-grid-item")).toHaveCount(globalCount);
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
  await expect(page.locator(".wb-workflow-summary")).toHaveCount(3);
  await expect(page.locator('[data-workflow="sdd-main@1.1.0"]')).toContainText("설계1");
  await expect(page.locator('[data-workflow="sdd-main@0.9.0"]')).toContainText("구버전 설계1");
  await expect(page.locator('[data-workflow="tdd-cycle@1.0.0"]')).toContainText("Red1");
  await nav(page, "작업");
  await expect(page.locator(".wb-process-group")).toHaveCount(3);
  await page.getByLabel("단계 필터").selectOption("sdd-main@0.9.0:design");
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toContainText("이전 설계");
  await page.getByLabel("단계 필터").selectOption("tdd-cycle@1.0.0:red");
  await expect(page.locator(".wb-board-card")).toContainText("구현 안의 테스트");
  await page.getByLabel("프로젝트 필터").selectOption("all");
  await expect(page.locator(".wb-process-group")).toHaveCount(3);
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
  await expect(page.locator(".wb-workflow-summary")).toHaveCount(1);
  await expect(page.locator(".wb-stage-tile strong")).toHaveText(["0", "0", "0", "0", "0"]);
  await page.evaluate(() => localStorage.setItem("sawhorse.project-scope", "deleted-project"));
  await page.reload();
  await expect(scope(page)).toHaveValue("");
  await expect(page.getByRole("heading", { name: "작업대", exact: true })).toBeVisible();
});

test("sidebar groups runs by source and preserves project scope between tabs", async ({ page }) => {
  const sidebar = page.locator("aside nav");
  const projectViews = sidebar.getByRole("region", { name: "프로젝트별 화면", exact: true });
  const workspace = sidebar.getByRole("region", { name: "전체 작업공간", exact: true });
  const picker = page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true });
  const location = page.getByLabel("현재 위치", { exact: true });
  for (const name of ["작업대", "작업", "캘린더", "실행", "작업 문서 검색"]) {
    await expect(projectViews.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const name of ["개발 실행", "실행 기록"]) {
    await expect(projectViews.getByRole("button", { name, exact: true })).toHaveCount(0);
  }
  for (const name of ["자동화", "프로젝트", "워크플로", "에이전트"]) {
    await expect(workspace.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  await picker.click();
  await page.getByRole("option", { name: "Herdr", exact: true }).click();
  await nav(page, "실행");
  await expect(location).toContainText("Herdr");
  await expect(projectViews.getByRole("button", { name: "실행", exact: true })).toHaveAttribute("aria-current", "page");
  const runTabs = page.getByLabel("화면 선택", { exact: true });
  await expect(runTabs.getByRole("button", { name: "작업 실행", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("작업의 설계·구현·검증을 수행한 에이전트 실행입니다.", { exact: false })).toBeVisible();
  await runTabs.getByRole("button", { name: "자동화·도구 실행", exact: true }).click();
  await expect(runTabs.getByRole("button", { name: "자동화·도구 실행", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("자동화 작업·예약과 개별 도구에서 시작한 실행입니다.", { exact: false })).toBeVisible();
  await expect(projectViews.getByRole("button", { name: "실행", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(location).toContainText("Herdr");
  await expect(scope(page)).toContainText("Herdr");
  await scope(page).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await expect(picker).toContainText("Sawhorse");
  await runTabs.getByRole("button", { name: "작업 실행", exact: true }).click();
  await expect(location).toContainText("Sawhorse");
  await nav(page, "에이전트");
  await expect(workspace.getByRole("button", { name: "에이전트", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(runTabs.getByRole("button", { name: "작업 실행", exact: true })).toHaveCount(0);
  await expect(runTabs.getByRole("button", { name: "협업 세션", exact: true })).toBeVisible();
});
