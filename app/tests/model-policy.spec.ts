import { test, expect } from "@playwright/test";

test("child model policy persists and explains a single-slot limit", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("navigation", { name: "설정", exact: true }).getByRole("button", { name: "실행", exact: true }).click();
  const policy = page.getByRole("combobox", { name: "하위 에이전트 모델 정책" });
  await expect(policy).toContainText("자동 · 스킬이 판단");
  await policy.click();
  await page.getByRole("option", { name: "부모 모델 상속", exact: true }).click();
  await page.locator("#herdr-parallel").fill("1");
  await expect(page.getByText("동시 실행 한도가 1이면 부모가 직접 처리합니다.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("navigation", { name: "설정", exact: true }).getByRole("button", { name: "실행", exact: true }).click();
  await expect(policy).toContainText("부모 모델 상속");
  await expect(page.locator("#herdr-parallel")).toHaveValue("1");
});

test("harness shows the chosen child model and the skill's reasoning", async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.locator(".wb-header")).toBeVisible();
  // Reading then saving a real preview artifact initializes the disposable store.
  await page.getByRole("button", { name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/ }).click();
  await page.locator(".cm-content").fill("# 의도\n\n하위 모델의 선택 근거를 확인합니다.");
  await page.locator(".wb-editor-toolbar").getByRole("button", { name: "저장", exact: true }).click();
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const state = JSON.parse(localStorage.getItem(key)!);
    state.runs = [{
      id: "child-example", workId: "work-intent", projectId: "sawhorse",
      role: "research", agent: "claude", model: "sonnet", parentRunId: "parent-example",
      modelSelection: { source: "auto", requestedModel: "", assessment: { complexity: "routine", reason: "함수 한 곳의 호출 경로와 회귀 검증만 확인합니다." }, reason: "함수 한 곳의 호출 경로와 회귀 검증만 확인합니다." },
      childModelPolicy: "auto", stage: "design", workflowId: "sdd-main", workflowVersion: "1.1.0", workflowDigest: "preview",
      workflowInstanceId: null, nodeRunId: null, status: "review", agentName: "child-example",
      paneId: null, workspaceId: null, session: "preview", prompt: "Preview child task",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
      agentSession: null, tabClosedAt: new Date().toISOString(), finalReport: "예시 실행 기록", resumable: false,
    }];
    localStorage.setItem(key, JSON.stringify(state));
  });
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "개발 실행", exact: true }).click();
  await expect(page.locator(".wb-run-detail header")).toContainText("sonnet");
  await expect(page.getByTestId("model-selection")).toContainText("스킬 판단으로 모델 선택");
  await expect(page.getByTestId("model-selection")).toContainText("함수 한 곳의 호출 경로와 회귀 검증만 확인합니다.");
  await expect(page.locator(".wb-run-list")).toContainText("자동 선택");
  await page.screenshot({ path: "test-results/model-policy-harness.png", fullPage: true });
});
