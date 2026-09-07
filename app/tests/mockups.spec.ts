import { expect, test, type Page } from "@playwright/test";
import { appendFeedback, readFeedback } from "../src/features/mockups/feedback";
import { mockupDemo } from "../src/features/mockups/preview";

const KEY = "sawhorse.workflow.preview.v2";
const tour = "/?preview=1&mockups=1";
const review = (page: Page) => page.locator(".mockup-review");
const screenButton = (page: Page, label: string) =>
  review(page)
    .getByRole("group", { name: "목업 화면 선택" })
    .getByRole("button", { name: new RegExp(label) });
async function open(page: Page) {
  await page.goto(tour);
  await page
    .locator(".app-navigation")
    .getByRole("button", { name: "작업", exact: true })
    .click();
  await page
    .getByRole("button", { name: "작업 검토 경험 개선", exact: true })
    .click();
  await page
    .locator(".wb-artifact-nav")
    .getByRole("button", { name: "목업", exact: true })
    .click();
  await expect(
    review(page).getByRole("heading", { name: "작업 검토 경험 개선" }),
  ).toBeVisible();
}

test("feedback serialization preserves Markdown and ignores commented examples", () => {
  const original =
    "---\r\nprojectId: demo\r\n---\r\n# 검토 의견\r\n\r\n## 목업 수정 요청\r\n<!--\r\n- [ ] [tasks] 주석 예시\r\n-->\r\n```md\r\n- [ ] [tasks] 코드 예시\r\n```\r\n- [x] [tasks] 이미 처리한 요청\r\n\r\n## 새 개선 제안\r\n\r\n## 처리 이력\r\n기존 처리 기록\r\n";
  const result = appendFeedback(
    original,
    "revision",
    "tasks",
    " 버튼을\n명확하게 표시 ",
  );
  expect(result).toContain("---\r\nprojectId: demo\r\n---");
  expect(result).toContain("## 처리 이력\r\n기존 처리 기록\r\n");
  expect(readFeedback(result)).toEqual([
    {
      kind: "revision",
      screenId: "tasks",
      text: "이미 처리한 요청",
      processed: true,
    },
    {
      kind: "revision",
      screenId: "tasks",
      text: "버튼을 명확하게 표시",
      processed: false,
    },
  ]);
  expect(() =>
    appendFeedback(result, "revision", "tasks", "버튼을 명확하게 표시"),
  ).toThrow("duplicate-feedback");
  expect(
    readFeedback(
      appendFeedback(result, "proposal", "tasks", "버튼을 명확하게 표시"),
    ),
  ).toHaveLength(3);
  expect(() =>
    appendFeedback(original, "revision", "../escape", "요청"),
  ).toThrow("invalid-feedback");
});

test("interactive previews switch screens and render at real device widths", async ({
  page,
}) => {
  await open(page);
  const frame = page.frameLocator('iframe[title="작업 목록 대화형 목업"]');
  await expect(
    frame.getByRole("heading", { name: "다음 검토를 시작하세요." }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "검토 대기", exact: true }).click();
  await expect(
    frame.getByText("마크다운 라이브 편집기", { exact: true }),
  ).toBeHidden();
  await review(page)
    .getByRole("button", { name: "모바일", exact: true })
    .click();
  await expect(review(page).locator("iframe")).toHaveCSS("width", "390px");
  await expect(
    review(page).getByRole("button", { name: "모바일", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    frame.getByText("마크다운 라이브 편집기", { exact: true }),
  ).toBeHidden();
  await screenButton(page, "문서 편집").click();
  const editor = page.frameLocator('iframe[title="문서 편집 대화형 목업"]');
  await editor.getByRole("button", { name: "저장", exact: true }).click();
  await expect(editor.getByRole("status")).toHaveText(
    "모든 변경 사항을 저장했습니다.",
  );
  await review(page)
    .getByRole("button", { name: "미리보기 다시 시작", exact: true })
    .click();
  await expect(editor.getByRole("status")).toHaveText("저장되지 않은 변경");
});

test("feedback drafts survive screen changes and guard closing or jumping to a revision", async ({
  page,
}) => {
  await open(page);
  await review(page).getByRole("textbox").fill("첫 화면의 미완성 의견");
  await screenButton(page, "문서 편집").click();
  await review(page).getByRole("textbox").fill("두 번째 화면의 의견");
  await screenButton(page, "작업 목록").click();
  await expect(review(page).getByRole("textbox")).toHaveValue(
    "첫 화면의 미완성 의견",
  );
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(review(page)).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await review(page)
    .getByRole("button", { name: "이전 개정", exact: true })
    .click();
  await expect(review(page)).toContainText("Rev 2");
  await expect(review(page).getByRole("textbox")).toHaveValue(
    "첫 화면의 미완성 의견",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await review(page)
    .getByRole("button", { name: "이전 개정", exact: true })
    .click();
  await expect(review(page)).toContainText("Rev 1");
});

test("saving feedback merges concurrent edits, prevents duplicates, and survives reopening", async ({
  page,
}) => {
  await open(page);
  // A different editor saves after this review has opened.
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const doc = state.documents["mockup-demo/feedback"];
    doc.markdown += "\n다른 편집자의 처리 기록\n";
    doc.revision = "external-revision";
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await review(page).getByRole("textbox").fill("검토 버튼을\n더 명확하게 표시");
  await review(page)
    .getByRole("button", { name: "의견 저장", exact: true })
    .click();
  await expect(review(page).getByRole("status")).toHaveText(
    "화면에 연결된 검토 의견을 저장했습니다.",
  );
  const saved = await page.evaluate(
    (key) =>
      JSON.parse(localStorage.getItem(key)!).documents["mockup-demo/feedback"]
        .markdown,
    KEY,
  );
  expect(saved).toContain("다른 편집자의 처리 기록");
  expect(saved).toContain("- [ ] [tasks] 검토 버튼을 더 명확하게 표시");
  await review(page).getByRole("textbox").fill("검토 버튼을 더 명확하게 표시");
  await review(page)
    .getByRole("button", { name: "의견 저장", exact: true })
    .click();
  await expect(review(page).getByRole("alert")).toHaveText(
    "같은 화면에 동일한 미처리 의견이 있습니다.",
  );
  await expect(review(page).getByRole("textbox")).toHaveValue(
    "검토 버튼을 더 명확하게 표시",
  );
  await review(page)
    .getByRole("button", { name: "새 개선 제안", exact: true })
    .click();
  await review(page).getByRole("textbox").fill("검토 기한을 함께 표시");
  await review(page)
    .getByRole("button", { name: "의견 저장", exact: true })
    .click();
  await expect(review(page).locator(".mockup-comments li")).toHaveCount(2);
  await review(page)
    .getByRole("button", { name: "수정 요청", exact: true })
    .click();
  await review(page).getByRole("textbox").fill("");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await open(page);
  await expect(review(page).locator(".mockup-comments")).toContainText(
    "검토 기한을 함께 표시",
  );
  await expect(review(page).locator(".mockup-comments li")).toHaveCount(2);
});

test("missing HTML keeps context and document editing available", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(
    ({ key, manifest }) => {
      const state = JSON.parse(localStorage.getItem(key)!);
      state.mockups = { "mockup-demo": { manifest, html: {} } };
      localStorage.setItem(key, JSON.stringify(state));
    },
    { key: KEY, manifest: mockupDemo },
  );
  await review(page)
    .getByRole("button", { name: "미리보기 다시 시작", exact: true })
    .click();
  await expect(review(page).getByRole("alert")).toContainText(
    "이 화면의 HTML을 열 수 없습니다",
  );
  await expect(
    review(page).getByText("검토 대기 작업을 한 번에 필터링합니다.", {
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".wb-editor-toolbar")
    .getByRole("button", { name: "문서 편집", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toBeVisible();
});

test("HTML can run inline interactions without accessing the parent or the network", async ({
  page,
}) => {
  await open(page);
  let requests = 0;
  await page.route("https://mockup-test.invalid/**", (route) => {
    requests += 1;
    return route.abort();
  });
  await page.evaluate(
    ({ key, manifest }) => {
      const state = JSON.parse(localStorage.getItem(key)!);
      state.mockups = {
        "mockup-demo": {
          manifest,
          html: {
            tasks: `<html><head><base href="https://mockup-test.invalid/"><meta http-equiv="refresh" content="0;url=https://mockup-test.invalid/refresh"></head><body><p id="result"></p><script>try{parent.document.body.dataset.escaped='yes'}catch(e){document.getElementById('result').textContent='Parent blocked'}fetch('https://mockup-test.invalid/data').catch(()=>{});</script><img src="https://mockup-test.invalid/image"></body></html>`,
          },
        },
      };
      localStorage.setItem(key, JSON.stringify(state));
    },
    { key: KEY, manifest: mockupDemo },
  );
  await review(page)
    .getByRole("button", { name: "미리보기 다시 시작", exact: true })
    .click();
  await expect(
    page
      .frameLocator('iframe[title="작업 목록 대화형 목업"]')
      .getByText("Parent blocked", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  await expect(review(page).locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
});

test("compact review stays within the dialog and English labels are available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 850 });
  await open(page);
  await review(page)
    .getByRole("button", { name: "모바일", exact: true })
    .click();
  const bounds = await review(page).evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  await expect(
    review(page).getByRole("button", { name: "의견 저장", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => localStorage.setItem("sawhorse.language", "en"));
  await page.reload();
  await page
    .locator(".app-navigation")
    .getByRole("button", { name: "Work", exact: true })
    .click();
  await page
    .getByRole("button", { name: "작업 검토 경험 개선", exact: true })
    .click();
  await page
    .locator(".wb-artifact-nav")
    .getByRole("button", { name: "목업", exact: true })
    .click();
  await expect(
    review(page).getByRole("button", { name: "Save feedback", exact: true }),
  ).toBeVisible();
});
