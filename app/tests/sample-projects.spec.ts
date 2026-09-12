import { expect, test, type Page } from "@playwright/test";
import samples from "../src/features/workbench/samples/data.json" with { type: "json" };

const storageKey = "sawhorse.workflow.preview.v2";
const nav = (page: Page, name: string) => page.locator("aside nav").getByRole("button", { name, exact: true });

for (const language of ["ko", "en"] as const) {
  test(`populated samples retain English content in ${language} and can be reopened`, async ({ page }) => {
    await page.addInitScript((language) => localStorage.setItem("sawhorse.language", language), language);
    await page.goto("/?preview=1");
    await nav(page, language === "ko" ? "프로젝트" : "Projects").click();
    const add = page.getByRole("button", { name: language === "ko" ? "샘플 프로젝트 추가" : "Add sample projects", exact: true });
    await add.click();
    await expect(page.getByRole("heading", { name: samples.projects[0].name, exact: true })).toBeVisible();
    const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), storageKey);
    const work = saved.snapshot.work.filter((item: { id: string }) => item.id.startsWith("sample-"));
    expect(work).toHaveLength(31);
    expect(saved.snapshot.events.filter((item: { id: string }) => item.id.startsWith("sample-"))).toHaveLength(18);
    expect(Object.keys(saved.documents).filter((id) => id.startsWith("sample-"))).toHaveLength(166);
    expect(JSON.stringify(samples)).not.toMatch(/[가-힣]/);
    expect(JSON.stringify(saved)).not.toContain("{{day:");
    expect(Object.values(saved.goals).every((goal: any) => ["paused", "completed"].includes(goal.status))).toBe(true);
    for (const project of samples.projects) {
      expect(saved.snapshot.projects.find((item: { id: string }) => item.id === project.id)).toMatchObject({ workflowId: project.workflowId, workflowVersion: project.workflowVersion });
      await page.getByRole("combobox", { name: language === "ko" ? "프로젝트 전환" : "Switch project", exact: true }).click();
      await page.getByRole("option", { name: project.name, exact: true }).click();
      await nav(page, language === "ko" ? "작업대" : "Workbench").click();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(project.name);
      const item = samples.work.find((item) => item.projectId === project.id && item.status !== "backlog")!;
      await expect(page.getByText(item.title, { exact: true }).first()).toBeVisible();
    }
    // An edited record survives a repeated import and a reload.
    await page.evaluate((key) => {
      const state = JSON.parse(localStorage.getItem(key)!);
      state.snapshot.projects.find((project: { id: string }) => project.id === "sample-atlas").description = "My edited project";
      localStorage.setItem(key, JSON.stringify(state));
    }, storageKey);
    await page.reload();
    await nav(page, language === "ko" ? "프로젝트" : "Projects").click();
    await add.click();
    await expect(page.getByText("My edited project", { exact: true })).toBeVisible();
    expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.projects.filter((project: { id: string }) => project.id.startsWith("sample-")).length, storageKey)).toBe(6);
  });
}

test("the starter dashboard uses distinct activity and planning rows on every breakpoint", async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.locator(".widget-grid-item")).toHaveCount(10);
  const data = await page.evaluate(() => JSON.parse(localStorage.getItem("sawhorse.dashboard-layout")!));
  for (const [breakpoint, cols] of Object.entries({ lg: 12, md: 8, sm: 4 })) {
    const layout = data.layouts[breakpoint];
    expect(layout).toHaveLength(10);
    for (const item of layout) {
      expect(item.x + item.w).toBeLessThanOrEqual(cols);
      expect(item.y).toBeGreaterThanOrEqual(0);
      for (const peer of layout.filter((peer: { i: string }) => peer.i !== item.i)) {
        expect(item.x >= peer.x + peer.w || peer.x >= item.x + item.w || item.y >= peer.y + peer.h || peer.y >= item.y + item.h).toBe(true);
      }
    }
  }
  const desktop = data.layouts.lg;
  const item = (id: string) => desktop.find((entry: { i: string }) => entry.i === id);
  expect(item("today").y).toBe(item("jobs").y);
  expect(item("projects").y).toBe(item("events").y);
  expect(item("projects").w).toBe(6);
  expect(item("due").y).toBe(item("schedules").y);
  expect(item("projects").y).toBeGreaterThan(item("today").y);
});
