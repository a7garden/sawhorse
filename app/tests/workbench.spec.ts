import { test, expect, type Page } from "@playwright/test";
const nav = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();
test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.locator(".wb-header")).toBeVisible();
});

test("project and task creation persist and work can move across the board", async ({
  page,
}) => {
  await nav(page, "프로젝트");
  await page
    .getByRole("button", { name: "프로젝트 추가", exact: true })
    .click();
  await page.getByLabel("프로젝트 이름", { exact: true }).fill("검증 프로젝트");
  await page
    .getByLabel("저장소 경로", { exact: true })
    .fill("/tmp/sawhorse-demo");
  await page.getByLabel("검증 명령", { exact: true }).fill("npm test");
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.locator(".wb-project-card").filter({ hasText: "검증 프로젝트" }),
  ).toBeVisible();
  await nav(page, "작업");
  await page.getByRole("button", { name: "새 작업", exact: true }).click();
  await page
    .getByLabel("작업 이름", { exact: true })
    .fill("브라우저 흐름 검증");
  await page
    .getByLabel("프로젝트", { exact: true })
    .selectOption({ label: "검증 프로젝트" });
  await page.getByLabel("기한", { exact: true }).fill("2026-09-15");
  await page.getByRole("button", { name: "작업 만들기", exact: true }).click();
  await expect(page.locator(".wb-detail h2")).toHaveText("브라우저 흐름 검증");
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  const card = page
    .locator(".wb-board-card")
    .filter({ hasText: "브라우저 흐름 검증" });
  const target = page.locator(".wb-board-column").filter({
    has: page.locator(".wb-column-head").filter({ hasText: "준비" }),
  });
  await card.dragTo(target);
  await expect(
    target.locator(".wb-board-card").filter({ hasText: "브라우저 흐름 검증" }),
  ).toBeVisible();
  await page.reload();
  await nav(page, "작업");
  await expect(
    page
      .locator(".wb-board-column")
      .filter({
        has: page.locator(".wb-column-head").filter({ hasText: "준비" }),
      })
      .getByText("브라우저 흐름 검증", { exact: true }),
  ).toBeVisible();
});

test("editing metadata from a task detail is reachable", async ({ page }) => {
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  await page
    .locator(".wb-detail-head")
    .getByRole("button", { name: "편집", exact: true })
    .click();
  await page.getByLabel("작업 이름", { exact: true }).fill("수정된 개발 흐름");
  await page.getByRole("button", { name: "변경 저장", exact: true }).click();
  await expect(page.locator(".wb-detail h2")).toHaveText("수정된 개발 흐름");
});

test("calendar events render on the local day and refresh after save and delete", async ({
  page,
}) => {
  await nav(page, "캘린더");
  await page.getByRole("button", { name: "일정 추가", exact: true }).click();
  await page.getByLabel("일정 이름", { exact: true }).fill("통합 검토 일정");
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  await page.getByLabel("날짜", { exact: true }).fill(today);
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page
      .locator(".wb-day.is-today")
      .getByRole("button", { name: "통합 검토 일정", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "통합 검토 일정", exact: true })
    .click();
  await page.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "통합 검토 일정", exact: true }),
  ).toHaveCount(0);
});

test("markdown edits save and remain after reopening", async ({ page }) => {
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible();
  await editor.fill("# 검증된 의도\n\n사용자가 원하는 결과를 보존합니다.");
  await page
    .locator(".wb-editor-toolbar")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.getByText("저장되지 않은 변경", { exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  await expect(editor).toContainText("검증된 의도");
});

test("launch failures remain visible instead of claiming a run succeeded", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  await page.getByRole("button", { name: "실행 시작", exact: true }).click();
  await expect(
    page.getByText(
      "실제 에이전트 실행은 Sawhorse 데스크톱 앱과 Herdr 연결이 필요합니다.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("production browser without opt-in shows connection requirement", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByText(/Sawhorse 데스크톱 앱에서 작업공간을 열어/),
  ).toBeVisible();
  await expect(page.locator(".wb-metric")).toHaveCount(0);
});

test("an external document revision preserves the conflicting local draft", async ({
  page,
  context,
}) => {
  const open = async (p: Page) => {
    await p
      .getByRole("button", {
        name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
      })
      .click();
    await expect(p.locator(".cm-content")).toBeVisible();
  };
  await open(page);
  await page
    .locator(".cm-content")
    .fill("# 내 초안\n\n보존해야 하는 작업 중인 의도입니다.");
  const other = await context.newPage();
  await other.goto("/?preview=1");
  await open(other);
  await other
    .locator(".cm-content")
    .fill("# 외부 수정\n\n다른 편집자가 먼저 저장한 의도입니다.");
  await other
    .locator(".wb-editor-toolbar")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    other.getByText("저장되지 않은 변경", { exact: true }),
  ).toHaveCount(0);
  await page
    .locator(".wb-editor-toolbar")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toContainText("내 초안");
  await expect(page.getByText(/다른 곳에서 문서가 변경/).first()).toBeVisible();
});

test("discard confirmation protects unsaved edits when closing the document", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  await page.locator(".cm-content").fill("# 아직 저장하지 않은 의도");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(page.locator(".cm-content")).toContainText(
    "아직 저장하지 않은 의도",
  );
});

test("forward stage transitions require and retain a review decision", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    })
    .click();
  await page.getByRole("button", { name: "검토 후 다음: 구현" }).click();
  await expect(page.getByRole("alert")).toContainText("검토 근거");
  await page
    .getByLabel("검토 결정", { exact: true })
    .fill("명세와 수용 기준을 확인했고 구현을 진행합니다.");
  await page.getByRole("button", { name: "검토 후 다음: 구현" }).click();
  await expect(page.locator(".wb-stepper .is-current")).toContainText("구현");
  await expect(page.locator(".wb-ledger")).toContainText("명세와 수용 기준");
});

test("project and stage filters combine and search opens an artifact", async ({
  page,
}) => {
  await nav(page, "작업");
  await page.getByLabel("프로젝트 필터").selectOption("herdr");
  await page.getByLabel("단계 필터").selectOption("build");
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toContainText(
    "Herdr 실행과 기록 연결",
  );
  await page.getByRole("button", { name: /전체 검색/ }).click();
  await page.getByPlaceholder("문서와 작업을 검색하세요").fill("원하는 결과");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await page.locator(".wb-search-hit").first().click();
  await expect(page.locator(".cm-content")).toContainText("원하는 결과");
});

test("a project switches to TDD without changing existing SDD work", async ({
  page,
}) => {
  await nav(page, "프로젝트");
  await page
    .locator(".wb-project-card")
    .filter({ hasText: "Sawhorse" })
    .getByRole("button", { name: "프로젝트 편집" })
    .click();
  await page.getByLabel("프로젝트 워크플로우").selectOption("tdd-cycle@1.0.0");
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.locator(".wb-project-card").filter({ hasText: "Sawhorse" }),
  ).toContainText("TDD 사이클");

  await nav(page, "작업");
  await page.getByRole("button", { name: "새 작업", exact: true }).click();
  await page.getByLabel("작업 이름").fill("TDD로 만든 새 작업");
  await page.getByLabel("프로젝트", { exact: true }).selectOption("sawhorse");
  await page.getByRole("button", { name: "작업 만들기" }).click();
  await expect(page.locator(".wb-stepper .is-current")).toContainText(
    "테스트 의도",
  );
  await expect(page.locator(".wb-artifact-nav")).toContainText("Red 근거");
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await nav(page, "작업대");
  await expect(
    page.getByRole("button", {
      name: "검토 의도에서 시작하는 개발 흐름 Sawhorse · 설계",
    }),
  ).toBeVisible();
});

test("schema studio exposes the guarded desktop migration workflow", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await nav(page, "설정");
  await page
    .getByRole("button", { name: "볼트 문서 구조", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "볼트 문서 구조" }),
  ).toBeVisible();
  await expect(page.getByLabel("스키마 ID")).toHaveValue("team-vault");
  await page.getByRole("button", { name: "고급 JSON" }).click();
  await expect(page.getByLabel("VaultSchema JSON")).toContainText(
    '"schemaFormatVersion": 1',
  );
  await page.getByRole("button", { name: "정의 검증" }).click();
  await expect(
    page.getByText(/데스크톱 앱에서 사용할 수 있습니다/),
  ).toBeVisible();
});

test("workflow studio and resumable project ingestion are reachable", async ({
  page,
}) => {
  await nav(page, "확장 관리");
  await page.getByRole("button", { name: "워크플로", exact: false }).click();
  await page
    .getByRole("button", { name: "새 워크플로", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "워크플로 스튜디오" }),
  ).toBeVisible();
  await expect(page.getByText("작성할 문서")).toBeVisible();
  await expect(page.getByRole("button", { name: "가상 실행" })).toBeVisible();

  await nav(page, "프로젝트");
  await page
    .getByRole("button", { name: "자료로 문서 만들기", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: /문서 만들기/ }),
  ).toBeVisible();
  await expect(page.getByLabel("입력 경로")).toBeVisible();
});
