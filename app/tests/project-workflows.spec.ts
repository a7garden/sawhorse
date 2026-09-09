import { expect, test, type Page } from "@playwright/test";
import { projectWorkflowRefs, creationWorkflow } from "../src/features/workbench/workflow-creation";
import type { WorkflowDefinition } from "../src/features/workbench/types";

const KEY = "sawhorse.workflow.preview.v2";
const tdd = "TDD · 테스트 기반 개발 · v1.0.1";
const composed = "SDD + TDD · 명세·테스트 기반 개발 · v1.1.1";
const intent = "Intent · 의도 기반 개발 · v2.0.1";
const goal = "Goal · 목표 달성 · v1.0.1";
async function selectView(page: Page, name: string) {
  await page.getByRole("combobox", { name: "작업대 보기", exact: true }).click();
  await page.getByRole("option").filter({ hasText: name }).click();
}
async function setup(page: Page, enabled = [tdd, composed, intent, goal]) {
  await page.goto("/?preview=1");
  await page.getByRole("combobox", { name: "사이드바 프로젝트 선택", exact: true }).click();
  await page.getByRole("option", { name: "Sawhorse", exact: true }).click();
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  for (const name of enabled) await page.getByRole("checkbox", { name, exact: true }).check();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
async function continueWorkflow(page: Page, name: string) {
  const picker = page.getByRole("combobox", { name: "작업 워크플로우", exact: true });
  await expect(picker).toContainText(name);
  await page.getByRole("button", { name: "계속", exact: true }).click();
}

test("a project combines an all-work list with exact workflow boards and creates in the selected flow", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("combobox", { name: "작업대 보기", exact: true })).toContainText("전체 작업");
  await expect(page.locator(".wb-task-board")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "작업 워크플로우", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "기본 워크플로우", exact: true })).toContainText("기본 SDD");
  await selectView(page, tdd);
  await expect(page.locator(".wb-task-lane-head h2")).toHaveText(["테스트 의도", "Red", "Green", "리팩터링", "재검증", "완료"]);
  await page.getByRole("button", { name: "새 테스트 의도", exact: true }).click();
  await continueWorkflow(page, tdd);
  await page.getByRole("combobox", { name: "작업 유형", exact: true }).click();
  await page.getByRole("option", { name: "버그 수정", exact: true }).click();
  await page.getByLabel("작업 이름", { exact: true }).fill("검색 결과 중복 수정");
  await page.getByRole("textbox", { name: "테스트 의도", exact: true }).fill("검색을 반복하면 같은 결과가 두 번 나옵니다.");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "작업대 보기", exact: true })).toContainText(tdd);
  await expect(page.locator(".wb-task-board")).toContainText("검색 결과 중복 수정");
  await selectView(page, "전체 작업");
  await expect(page.getByRole("row").filter({ hasText: "검색 결과 중복 수정" })).toContainText("TDD · 테스트 기반 개발");
  await page.getByRole("button", { name: "필터", exact: true }).click();
  await page.getByRole("combobox", { name: "작업 유형 필터", exact: true }).click();
  await page.getByRole("option", { name: "버그 수정", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr")).toContainText("검색 결과 중복 수정");
  await page.getByRole("combobox", { name: "작업 유형 필터", exact: true }).click();
  await page.getByRole("option", { name: "모든 작업 유형", exact: true }).click();
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
  const work = state.snapshot.work.find((item: { title: string }) => item.title === "검색 결과 중복 수정");
  expect(work).toMatchObject({ projectId: "sawhorse", workflowId: "tdd-cycle", workflowVersion: "1.0.1", issueType: "버그" });
  expect(state.snapshot.projects.find((project: { id: string }) => project.id === "sawhorse").workflowId).toBe("sdd-main");
  await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  await page.getByRole("checkbox", { name: tdd, exact: true }).uncheck();
  await expect(page.getByRole("checkbox", { name: tdd, exact: true })).not.toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const enabled = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.projects.find((project: { id: string }) => project.id === "sawhorse").additionalWorkflows, KEY);
  expect(enabled).not.toContainEqual({ id: "tdd-cycle", version: "1.0.1" });
  await selectView(page, tdd);
  await expect(page.getByRole("combobox", { name: "작업대 보기", exact: true })).toContainText("기존 작업만");
  await expect(page.getByRole("button", { name: "새 항목", exact: true })).toBeDisabled();
  await expect(page.locator(".wb-task-board")).toContainText("검색 결과 중복 수정");

});

test("intent and goal composers work as additional flows in an SDD project", async ({ page }) => {
  await setup(page);
  await selectView(page, intent);
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await continueWorkflow(page, intent);
  await page.getByRole("combobox", { name: "작업 유형", exact: true }).click();
  await page.getByRole("option", { name: "버그 수정", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("# 여러 흐름에서 의도 기록\n\n검색 경험을 개선합니다.");
  await page.getByRole("button", { name: "메모만 저장", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await selectView(page, goal);
  await page.getByRole("button", { name: "새 목표", exact: true }).click();
  await continueWorkflow(page, goal);
  await page.getByRole("combobox", { name: "작업 유형", exact: true }).click();
  await page.getByRole("option", { name: "리팩토링", exact: true }).click();
  await page.getByRole("textbox", { name: "목표와 완료 기준", exact: true }).fill("검색 품질 검증을 완료한다");
  await page.getByRole("button", { name: "목표 저장", exact: true }).click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
  expect(state.snapshot.work.find((item: { title: string }) => item.title === "여러 흐름에서 의도 기록")).toMatchObject({ workflowId: "intent-flow", workflowVersion: "2.0.1", stage: "inbox", issueType: "버그" });
  expect(state.snapshot.work.find((item: { title: string }) => item.title === "검색 품질 검증을 완료한다")).toMatchObject({ workflowId: "goal-main", workflowVersion: "1.0.1", issueType: "리팩토링" });
});

test("all-work creation can choose an enabled flow and removal preserves an unsaved draft", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "새 항목", exact: true }).click();
  await page.getByRole("combobox", { name: "작업 워크플로우", exact: true }).click();
  await page.getByRole("option", { name: composed, exact: true }).click();
  await continueWorkflow(page, composed);
  await page.getByLabel("작업 이름", { exact: true }).fill("구조 개선 초안");
  await page.getByRole("textbox", { name: "의도", exact: true }).fill("공개 API를 보존하며 책임을 분리한다.");
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    state.snapshot.projects.find((project: { id: string }) => project.id === "sawhorse").additionalWorkflows = [];
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("프로젝트에서 제거");
  await expect(page.getByRole("textbox", { name: "의도", exact: true })).toHaveValue("공개 API를 보존하며 책임을 분리한다.");
});

test("enabled references retain exact versions and reject unregistered revisions", () => {
  const project = { workflowId: "sdd-main", workflowVersion: "1.1.0", additionalWorkflows: [{ id: "tdd-cycle", version: "1.0.0" }, { id: "tdd-cycle", version: "1.0.1" }] };
  expect(projectWorkflowRefs(project)).toHaveLength(3);
  const catalog = projectWorkflowRefs(project).map((reference) => reference as WorkflowDefinition);
  expect(creationWorkflow(catalog, project, { id: "tdd-cycle", version: "1.0.0" })?.version).toBe("1.0.0");
  expect(creationWorkflow(catalog, project, { id: "tdd-cycle", version: "2.0.0" })).toBeUndefined();
});

test("retired purpose workflows leave project choices while old work remains readable", async ({ page }) => {
  await setup(page, [tdd]);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const project = state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse");
    project.workflowId = "bugfix-main"; project.workflowVersion = "1.0.0";
    project.additionalWorkflows.push({ id: "refactor-main", version: "1.0.0" });
    const old = structuredClone(state.snapshot.work.find((w: { projectId: string }) => w.projectId === "sawhorse"));
    Object.assign(old, { id: "legacy-fix", title: "기존 버그 수정 기록", issueType: "버그", workflowId: "bugfix-main", workflowVersion: "1.0.0", workflowDigest: "legacy-digest", stage: "intent", status: "backlog", activeNodes: [], artifacts: ["intent", "spec", "plan", "verification"] });
    state.snapshot.work.push(old);
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "작업", exact: true }).click();
  await expect(page.getByRole("region", { name: "기본 워크플로우", exact: true })).toContainText("SDD · 명세 기반 개발");
  await selectView(page, "Bugfix · 버그 수정");
  await expect(page.getByRole("button", { name: "새 항목", exact: true })).toBeDisabled();
  await expect(page.locator(".wb-task-board")).toContainText("기존 버그 수정 기록");
  await page.getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  await expect(page.getByRole("checkbox").filter({ hasText: /Bugfix|Refactor/ })).toHaveCount(0);
  await expect(page.locator(".wb-project-workflows")).not.toContainText("Bugfix");
  await expect(page.locator(".wb-project-workflows")).not.toContainText("Refactor");
  await page.getByRole("combobox", { name: "프로젝트 워크플로우", exact: true }).click();
  await expect(page.getByRole("option").filter({ hasText: /Bugfix|Refactor/ })).toHaveCount(0);
  await page.getByRole("option", { name: "SDD · 명세 기반 개발 · v1.1.1", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const state = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
  expect(state.snapshot.projects.find((p: { id: string }) => p.id === "sawhorse")).toMatchObject({ workflowId: "sdd-main", workflowVersion: "1.1.1" });
  expect(state.snapshot.work.find((w: { id: string }) => w.id === "legacy-fix")).toMatchObject({ workflowId: "bugfix-main", workflowVersion: "1.0.0", workflowDigest: "legacy-digest" });
});
