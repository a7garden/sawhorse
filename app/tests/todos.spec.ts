import { test, expect, type Page } from "@playwright/test";
import { matchesView, sortTodos } from "../src/features/todos/model";
import type { ManagedTodo } from "../src/lib/types";
const KEY = "sawhorse.preview-managed-todos";
const task = (id: string, text: string, dueDate: string | null, priority: ManagedTodo["priority"] = "normal", checked = false): ManagedTodo => ({ id, text, dueDate, priority, checked, source: "할 일.md" });
const fixture = [
  { ...task("past", "이전 일지에서 남은 업무", "2026-09-01", "high"), source: "일지/2026-09-01.md" },
  task("today", "오늘 검토할 자료", "2026-09-09"),
  task("tomorrow", "내일 회의 준비", "2026-09-10"),
  task("future", "다음 분기 계획", "2027-01-15", "high"),
  task("inbox", "언젠가 읽을 책", null, "low"),
  task("done", "완료한 업무", "2026-09-01", "normal", true),
];
async function open(page: Page, language = "ko") {
  await page.clock.setFixedTime(new Date("2026-09-09T03:00:00Z"));
  await page.addInitScript(({ key, items, language }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(items));
    localStorage.setItem("sawhorse.language", language);
  }, { key: KEY, items: fixture, language });
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", { name: language === "ko" ? "할 일" : "Todos", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(5);
}
const view = (page: Page, name: string) => page.getByRole("navigation", { name: "할 일 보기" }).getByRole("button", { name: new RegExp(`^${name}`) });

test("all dates and undated tasks remain available with combined filters", async ({ page }) => {
  await open(page);
  await view(page, "기한 지남").click();
  await expect(page.locator(".todos-row")).toHaveCount(1);
  await expect(page.locator(".todos-row")).toContainText("이전 일지");
  await view(page, "예정").click();
  await expect(page.locator(".todos-row")).toHaveCount(2);
  await page.getByLabel("할 일 검색", { exact: true }).fill("분기");
  await expect(page.locator(".todos-row")).toHaveCount(1);
  await page.getByRole("combobox", { name: "우선순위 필터", exact: true }).click();
  await page.getByRole("option", { name: "낮음", exact: true }).click();
  await expect(page.getByText("조건에 맞는 할 일이 없습니다")).toBeVisible();
  await page.getByRole("button", { name: "필터 초기화", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(2);
  await view(page, "날짜 없음").click();
  await expect(page.locator(".todos-row")).toContainText("언젠가 읽을 책");
});

test("capture without a date, schedule far ahead, complete, reopen and persist", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "할 일 추가", exact: true }).click();
  await page.getByLabel("할 일 제목").fill("장기 연구 계획");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(6);
  await view(page, "날짜 없음").click();
  await expect(page.locator(".todos-row")).toHaveCount(2);
  await page.getByRole("button", { name: "장기 연구 계획 수정", exact: true }).click();
  await page.getByLabel("마감일", { exact: true }).fill("2028-03-15");
  await page.getByRole("combobox", { name: "우선순위", exact: true }).click();
  await page.getByRole("option", { name: "높음", exact: true }).click();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(1);
  await view(page, "예정").click();
  await expect(page.locator(".todos-row").filter({ hasText: "장기 연구 계획" })).toContainText("2028");
  await page.getByRole("checkbox", { name: "장기 연구 계획 완료", exact: true }).click();
  await view(page, "완료").click();
  await page.getByRole("checkbox", { name: "장기 연구 계획 다시 열기", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(1);
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "할 일", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(6);
  await expect(page.locator(".todos-row").filter({ hasText: "장기 연구 계획" })).toContainText("높음");
});

test("deleting requires an explicit choice and survives reload", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "언젠가 읽을 책 삭제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(5);
  await page.getByRole("button", { name: "언젠가 읽을 책 삭제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(4);
  await page.reload();
  await page.locator("aside nav").getByRole("button", { name: "할 일", exact: true }).click();
  await expect(page.locator(".todos-row")).toHaveCount(4);
});

test("failed native writes keep the draft and expose a recoverable error", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { isTauri: boolean; __TAURI_INTERNALS__: unknown };
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = { invoke: async () => { throw new Error("테스트 저장 실패"); } };
  });
  await page.getByRole("button", { name: "할 일 추가", exact: true }).click();
  await page.getByLabel("할 일 제목").fill("잃어버리면 안 되는 초안");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("테스트 저장 실패");
  await expect(page.getByLabel("할 일 제목")).toHaveValue("잃어버리면 안 되는 초안");
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
});

test("English, dark theme and narrow windows retain usable controls", async ({ page }) => {
  await open(page, "en");
  await expect(page.getByRole("navigation", { name: "Task views" })).toContainText("Upcoming");
  await page.getByRole("combobox", { name: "Sort tasks", exact: true }).click();
  await page.getByRole("option", { name: "Priority first", exact: true }).click();
  await expect(page.locator(".todos-row").nth(1)).toContainText("다음 분기 계획");
  await page.screenshot({ path: "test-results/todos-desktop.png", fullPage: true });
  await page.locator("aside").getByRole("button", { name: /theme/i }).click();
  await page.setViewportSize({ width: 900, height: 800 });
  expect(await page.locator("main").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await expect(page.getByLabel("Task title", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/todos-narrow.png", fullPage: true });
});

test("date boundaries move unfinished work to overdue without mutating data", () => {
  const before = JSON.stringify(fixture);
  expect(fixture.filter((item) => matchesView(item, "overdue", "2026-09-10")).map((item) => item.id)).toEqual(["past", "today"]);
  expect(fixture.filter((item) => matchesView(item, "upcoming", "2026-09-10")).map((item) => item.id)).toEqual(["future"]);
  expect(sortTodos(fixture.filter((item) => !item.checked), "priority").map((item) => item.id)).toEqual(["past", "future", "today", "tomorrow", "inbox"]);
  expect(JSON.stringify(fixture)).toBe(before);
});
