import { test, expect } from "@playwright/test";

test("dashboard retains interrupted tasks and opens their execution details", async ({ page }) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: "프로젝트", exact: true }).click();
  await page.locator(".wb-project-card").filter({ hasText: "Sawhorse" }).getByRole("button", { name: "프로젝트 설정", exact: true }).click();
  await page.locator("form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    const key = "sawhorse.workflow.preview.v2";
    const state = JSON.parse(localStorage.getItem(key)!);
    const base = {
      workId: "work-intent", projectId: "sawhorse", role: "planner", agent: "claude", model: "sonnet",
      parentRunId: null, runner: "headless", stage: "design", workflowId: "sdd-main", workflowVersion: "1.1.0",
      workflowDigest: "preview", workflowInstanceId: null, nodeRunId: null, agentName: "test-background",
      paneId: null, workspaceId: null, session: "default", prompt: "Inspect the task", instructions: "Inspect the task",
      agentSession: null, tabClosedAt: null, finalReport: null, resumable: false,
    };
    state.runs = [
      { ...base, id: "failed-background", status: "failed", error: "완료 보고 없이 조기 종료했습니다", createdAt: "2026-09-09T02:00:00Z", updatedAt: "2026-09-09T02:00:00Z" },
      { ...base, id: "older-failure", status: "failed", error: "오래된 오류", createdAt: "2026-09-09T01:00:00Z", updatedAt: "2026-09-09T01:00:00Z" },
      { ...base, id: "running-background", role: "research", status: "running", error: null, createdAt: "2026-09-09T03:00:00Z", updatedAt: "2026-09-09T03:00:00Z" },
    ];
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem("sawhorse.project-scope", "sawhorse");
  });
  await page.reload();
  const attention = page.getByRole("region", { name: "확인 필요한 작업" });
  await expect(attention).toContainText("완료 보고 없이 조기 종료했습니다");
  await expect(attention).not.toContainText("오래된 오류");
  await attention.locator(".wb-run-attention-open").click();
  await expect(page.locator(".wb-run-detail")).toContainText("백그라운드");
  await expect(page.locator(".wb-run-detail .wb-inline-error")).toContainText("조기 종료");
  await expect(page.getByRole("button", { name: "다시 실행", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "herdr로 보기", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "확인 필요한 작업 · 1", exact: true }).click();
  await expect(page.locator(".wb-run-list > button")).toHaveCount(1);
  await page.getByRole("button", { name: "확인 필요한 작업 · 1", exact: true }).click();
  await page.locator(".wb-run-list > button").filter({ hasText: "실행 중" }).click();
  await expect(page.getByRole("button", { name: "herdr로 보기", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "다시 실행", exact: true })).toHaveCount(0);
  // 다시 실행하지 않고도 목록에서 내릴 수 있고, 되돌리는 길이 같은 자리에 남는다.
  await page.locator(".wb-run-list > button").filter({ hasText: "조기 종료" }).click();
  const detail = page.locator(".wb-run-detail");
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.getByRole("button", { name: "확인 필요한 작업 · 0", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "다시 표시", exact: true }).click();
  await expect(page.getByRole("button", { name: "확인 필요한 작업 · 1", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/background-execution.png", fullPage: true });
});
