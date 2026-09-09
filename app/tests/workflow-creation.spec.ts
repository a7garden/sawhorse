import { expect, test, type Page } from "@playwright/test";
import { creationWorkflow, workflowIntake } from "../src/features/workbench/workflow-creation";
import type { WorkflowDefinition } from "../src/features/workbench/types";
const KEY = "sawhorse.workflow.preview.v2";
const nav = (page: Page, name: string) => page.locator("aside nav").getByRole("button", { name, exact: true }).click();
async function selectProject(page: Page, name: string) {
  await page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
}
async function chooseView(page: Page, label: string) {
  await page.getByRole("combobox", { name: "작업대 보기", exact: true }).click();
  await page.getByRole("option").filter({ hasText: label }).click();
}
async function openProject(page: Page, workflow = "TDD · 테스트 기반 개발 · v1.0.1") {
  await page.goto("/?preview=1");
  await selectProject(page, "Sawhorse");
  await nav(page, "작업");
  await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  await page.getByRole("combobox", { name: "프로젝트 워크플로우", exact: true }).click();
  await page.getByRole("option", { name: workflow, exact: true }).click();
  const extras = await page.locator(".wb-project-workflows label").filter({ has: page.locator("input:checked:not(:disabled)") }).locator("span").allTextContents();
  for (const name of extras) await page.getByRole("checkbox", { name, exact: true }).uncheck();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await chooseView(page, workflow);
}

test("all projects is an overview, with a persistent project switch in the sidebar", async ({ page }) => {
  await page.goto("/?preview=1");
  await nav(page, "작업");
  await expect(page.getByRole("heading", { name: "전체 프로젝트 현황", exact: true })).toBeVisible();
  await expect(page.locator(".wb-project-work-card")).toHaveCount(3);
  await expect(page.locator(".wb-task-board")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "새 항목", exact: true })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("combobox")).toHaveCount(1);
  await page.getByRole("article", { name: "Herdr", exact: true }).getByRole("button", { name: "작업대 열기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true })).toContainText("Herdr");
  await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
  await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
  await selectProject(page, "Sawhorse");
  await expect(page.getByRole("heading", { name: "Sawhorse 작업대", exact: true })).toBeVisible();
  await nav(page, "캘린더");
  await page.reload();
  await expect(page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true })).toContainText("Sawhorse");
  await nav(page, "워크플로");
  await selectProject(page, "Herdr");
  await nav(page, "작업");
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  await selectProject(page, "전체 프로젝트");
  await expect(page.getByRole("heading", { name: "전체 프로젝트 현황", exact: true })).toBeVisible();
});

test("workflow boards create in the selected enabled flow and historical boards cannot create", async ({ page }) => {
  await openProject(page);
  await expect(page.locator(".wb-task-lane-head h2")).toHaveText(["테스트 의도", "Red", "Green", "리팩터링", "재검증", "완료"]);
  await chooseView(page, "기본 SDD · v1.1.0");
  await expect(page.getByRole("button", { name: "새 항목", exact: true })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("현재 새 작업에 사용하지 않는 흐름");
  await chooseView(page, "TDD · 테스트 기반 개발 · v1.0.1");
  await page.getByRole("button", { name: "새 테스트 의도", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("TDD · 테스트 기반 개발 · 테스트 의도 단계에서 시작");
  await expect(dialog).toContainText("프로젝트: Sawhorse");
  await expect(dialog.getByRole("combobox", { name: "작업 워크플로우", exact: true })).toHaveCount(0);
  await dialog.getByLabel("작업 이름", { exact: true }).fill("회귀 테스트 추가");
  await dialog.getByRole("textbox", { name: "테스트 의도", exact: true }).fill("장바구니의 할인 계산 오류를 재현하는 테스트를 작성한다.");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
  const work = state.snapshot.work.find((item: { title: string }) => item.title === "회귀 테스트 추가");
  expect(work).toMatchObject({ workflowId: "tdd-cycle", workflowVersion: "1.0.1", stage: "test-intent", status: "backlog", projectId: "sawhorse" });
  expect(state.documents[`${work.id}/test-intent`].markdown).toContain("장바구니의 할인 계산 오류");
  expect(state.documents[`${work.id}/intent`]).toBeUndefined();
  expect((state.runs ?? []).filter((run: { workId: string }) => run.workId === work.id)).toHaveLength(0);
});

test("a project pinned to a historical version creates that exact version", async ({ page }) => {
  await openProject(page);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    Object.assign(state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse"), { workflowId: "intent-flow", workflowVersion: "1.0.0" });
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.reload();
  await nav(page, "작업");
  await expect(page.getByRole("region", { name: "기본 워크플로우", exact: true })).toContainText("v1.0.0");
  await chooseView(page, "메모에서 구현까지 · v1.0.0");
  await page.getByRole("button", { name: "새 원본 의도", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".wb-intent-composer")).toHaveCount(0);
  await dialog.getByLabel("작업 이름", { exact: true }).fill("이전 버전 유지");
  await dialog.getByRole("textbox", { name: "원본 의도", exact: true }).fill("프로젝트에서 승인한 버전으로 시작합니다.");
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  const item = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.find((w: { title: string }) => w.title === "이전 버전 유지"), KEY);
  expect(item).toMatchObject({ workflowId: "intent-flow", workflowVersion: "1.0.0", stage: "design" });
});

test("project changes during composition reject creation and preserve the draft", async ({ page }) => {
  await openProject(page);
  await page.getByRole("button", { name: "새 테스트 의도", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("작업 이름", { exact: true }).fill("설정 변경 중인 초안");
  await dialog.getByRole("textbox", { name: "테스트 의도", exact: true }).fill("작성한 내용을 잃지 않습니다.");
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    Object.assign(state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse"), { workflowId: "intent-flow", workflowVersion: "2.0.0" });
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await dialog.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("선택한 워크플로우가 프로젝트에서 제거");
  await expect(dialog.getByRole("textbox", { name: "테스트 의도", exact: true })).toHaveValue("작성한 내용을 잃지 않습니다.");
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.some((w: { title: string }) => w.title === "설정 변경 중인 초안"), KEY)).toBe(false);
});

test("lifecycle creation has no switch to another workflow and saves in the selected project", async ({ page }) => {
  await openProject(page, "Intent · 의도 기반 개발 · v2.0.1");
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".wb-intent-composer")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "골 모드", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("combobox", { name: "작업 워크플로우", exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox").fill("# 프로젝트에 속한 메모\n\n설계 전에 기록합니다.");
  await dialog.getByRole("button", { name: "메모만 저장", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  const item = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.find((w: { title: string }) => w.title === "프로젝트에 속한 메모"), KEY);
  expect(item).toMatchObject({ projectId: "sawhorse", workflowId: "intent-flow", workflowVersion: "2.0.1", stage: "inbox" });
});

test("missing project workflow versions block creation without falling back", async ({ page }) => {
  await openProject(page);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse").workflowVersion = "9.9.9";
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.reload();
  await nav(page, "작업");
  await expect(page.getByRole("alert").filter({ hasText: "워크플로우 버전을 찾을 수 없습니다" })).toBeVisible();
  await expect(page.getByRole("button", { name: "새 항목", exact: true })).toBeDisabled();
});

test("project workflow resolution retains the exact pin and custom input meaning", () => {
  const workflow = { id: "order", version: "1.0.0", entry: "receive", nodes: [{ id: "receive", artifactRole: null, inputs: ["intent"] }], artifacts: [{ role: "intent", label: "주문서" }] } as WorkflowDefinition;
  expect(workflowIntake(workflow).artifact?.label).toBe("주문서");
  expect(workflowIntake(workflow).composer).toBe("generic");
  expect(workflowIntake({ ...workflow, artifacts: [] }).artifact).toBeUndefined();
  const catalog = [workflow, { ...workflow, version: "1.10.0" }];
  expect(creationWorkflow(catalog, { workflowId: "order", workflowVersion: "1.0.0" })?.version).toBe("1.0.0");
  expect(creationWorkflow(catalog, { workflowId: "order", workflowVersion: "9.0.0" })).toBeUndefined();
  expect(creationWorkflow(catalog)).toBeUndefined();
});

test("the project switch, search and sidebar toggle remain usable at the minimum desktop size", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 620 });
  await page.goto("/?preview=1");
  await selectProject(page, "Sawhorse");
  await nav(page, "작업");
  const bar = page.locator(".app-toolbar");
  await expect(page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true })).toBeInViewport();
  await expect(bar.getByRole("button", { name: "전체 검색", exact: true })).toBeInViewport();
  await bar.getByRole("button", { name: "전체 검색", exact: true }).click();
  await expect(page.getByPlaceholder("문서와 작업을 검색하세요")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "사이드바 접기", exact: true }).click();
  await page.getByRole("button", { name: "사이드바 펼치기", exact: true }).click();
  await selectProject(page, "Herdr");
  await expect(page.getByRole("heading", { name: "Herdr 작업대", exact: true })).toBeVisible();
  const geometry = await bar.evaluate((element) => ({ width: element.getBoundingClientRect().width, scroll: element.scrollWidth }));
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
});

for (const [name, purpose, method, intake] of [
  ["버그 수정", "버그", "SDD · 명세 기반 개발 · v1.1.1", "의도"],
  ["리팩토링", "리팩토링", "TDD · 테스트 기반 개발 · v1.0.1", "테스트 의도"],
]) {
  test(`${name} is a work purpose and follows the selected process`, async ({ page }) => {
    await openProject(page, method);
    await page.getByRole("button", { name: `새 ${intake}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "작업 유형", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
    await dialog.getByRole("button", { name: "작성 틀 넣기", exact: true }).click();
    const input = dialog.getByRole("textbox", { name: intake, exact: true });
    await expect(input).toHaveValue(purpose === "버그" ? /재현 절차와 환경/ : /보존할 동작과 공개 인터페이스/);
    await dialog.getByLabel("작업 이름", { exact: true }).fill(`${name} 적용`);
    await input.fill("문제와 변경 범위, 검증할 결과를 기록합니다.");
    await dialog.getByRole("combobox", { name: "작업 유형", exact: true }).click();
    await page.getByRole("option", { name: "일반 작업", exact: true }).click();
    await expect(input).toHaveValue("문제와 변경 범위, 검증할 결과를 기록합니다.");
    await expect(dialog.getByRole("button", { name: "작성 틀 넣기", exact: true })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "작업 유형", exact: true }).click();
    await page.getByRole("option", { name, exact: true }).click();
    await dialog.getByRole("button", { name: "만들기", exact: true }).click();
    await expect(page.locator(".wb-detail-dialog")).toBeVisible();
    const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
    const item = state.snapshot.work.find((work: { title: string }) => work.title === `${name} 적용`);
    expect(item).toMatchObject({ issueType: purpose, workflowId: purpose === "버그" ? "sdd-main" : "tdd-cycle", workflowVersion: purpose === "버그" ? "1.1.1" : "1.0.1", projectId: "sawhorse" });
    const project = state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse");
    expect(item.workflowId).toBe(project.workflowId);
    expect(state.documents[`${item.id}/${purpose === "버그" ? "intent" : "test-intent"}`].markdown).toContain("문제와 변경 범위");
  });
}

test("SDD intake work stays on its own workflow board instead of becoming an Intent inbox note", async ({ page }) => {
  await openProject(page, "SDD · 명세 기반 개발 · v1.1.1");
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByLabel("작업 이름", { exact: true }).fill("SDD 입력 단계 작업");
  await page.getByRole("textbox", { name: "의도", exact: true }).fill("선택한 흐름의 입력 단계부터 보드에 표시한다.");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('[data-stage="intent"]')).toContainText("SDD 입력 단계 작업");
  await expect(page.getByRole("group", { name: "작업 공간", exact: true })).toHaveCount(0);
});

test("named goal and intent revisions retain their specialized composers", () => {
  const base = { nodes: [], artifacts: [] } as unknown as WorkflowDefinition;
  for (const version of ["2.0.0", "2.0.1"])
    expect(workflowIntake({ ...base, id: "intent-flow", version }).composer).toBe("intent");
  for (const version of ["1.0.0", "1.0.1"])
    expect(workflowIntake({ ...base, id: "goal-main", version }).composer).toBe("goal");
  expect(workflowIntake({ ...base, id: "intent-flow", version: "3.0.0" }).composer).toBe("generic");
});
