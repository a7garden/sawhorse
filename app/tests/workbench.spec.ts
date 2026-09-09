import { test, expect, type Page } from "@playwright/test";
const nav = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();

/**
 * ?lifecycle=1 프리뷰 시더는 저장소가 비어 있을 때만 의도 흐름 v2 단계 표본을 심는다.
 * beforeEach 가 먼저 기본 시더로 채우므로, v2 단계 표본이 필요한 테스트는 저장소를
 * 비운 뒤 시더 URL 로 다시 연다.
 */
const loadLifecyclePreview = async (page: Page) => {
  await page.evaluate(() => localStorage.clear());
  await page.goto("/?preview=1&lifecycle=1");
  await expect(page.locator(".wb-header")).toBeVisible();
};
test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(page.locator(".wb-header")).toBeVisible();
});

test("workbench tabs reuse the shared snapshot without returning to a loading screen", async ({
  page,
}) => {
  await page.evaluate(() => {
    const observedWindow = window as Window & {
      __sawhorseLoadingObserved?: boolean;
    };
    observedWindow.__sawhorseLoadingObserved = false;
    new MutationObserver(() => {
      if (document.querySelector(".wb-loading"))
        observedWindow.__sawhorseLoadingObserved = true;
    }).observe(document.body, { childList: true, subtree: true });
  });

  await nav(page, "작업");
  await expect(page.locator(".wb-task-board")).toBeVisible();
  await nav(page, "캘린더");
  await expect(page.locator(".wb-calendar")).toBeVisible();

  expect(
    await page.evaluate(
      () =>
        (window as Window & { __sawhorseLoadingObserved?: boolean })
          .__sawhorseLoadingObserved,
    ),
  ).toBe(false);
});

test("project and work creation persist and decisions advance the process board", async ({
  page,
}) => {
  await loadLifecyclePreview(page);
  await nav(page, "프로젝트");
  await page
    .getByRole("button", { name: "프로젝트 추가", exact: true })
    .click();
  await page.getByLabel("프로젝트 이름", { exact: true }).fill("검증 프로젝트");
  await page
    .getByLabel("폴더 경로", { exact: true })
    .fill("/tmp/sawhorse-demo");
  await page
    .getByLabel("폴더 경로", { exact: true })
    .press("Enter");
  await expect(
    page.locator(".wb-folder-row").filter({ hasText: "/tmp/sawhorse-demo" }),
  ).toBeVisible();
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.locator(".wb-project-card").filter({ hasText: "검증 프로젝트" }),
  ).toBeVisible();
  await nav(page, "작업");
  await page
    .locator(".wb-work-header")
    .getByRole("button", { name: "새 의도", exact: true })
    .click();
  const composer = page.locator(".wb-intent-dialog");
  await composer
    .locator(".cm-content")
    .fill("브라우저 흐름 검증\n\n요청의 범위와 성공 기준을 확인했습니다.");
  await composer
    .getByRole("combobox", { name: "프로젝트", exact: true })
    .click();
  await page.getByRole("option", { name: "검증 프로젝트" }).click();
  await composer
    .getByRole("button", { name: "구체화 시작", exact: true })
    .click();
  // 브라우저 체험에서는 실행이 막히지만 의도 저장 자체는 성공한다.
  await expect(
    composer.getByText(/의도는 저장됐지만 설계 실행을 시작하지 못했습니다/),
  ).toBeVisible();
  await composer
    .getByRole("button", { name: "저장된 의도 열기", exact: true })
    .click();
  await expect(page.locator(".wb-detail h2")).toHaveText("브라우저 흐름 검증");
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(
    page
      .locator('.wb-task-lane[data-stage="clarify"]')
      .locator(".wb-board-card")
      .filter({ hasText: "브라우저 흐름 검증" }),
  ).toBeVisible();
  // 승인 대기 표본에 내린 즉시 결정이 보드를 진행시킨다: 승인 → 구현 대기
  const approvalCard = page
    .locator('.wb-task-lane[data-stage="approval"]')
    .locator(".wb-board-card");
  await expect(approvalCard.filter({ hasText: "승인 대기" })).toBeVisible();
  await approvalCard
    .getByRole("button", { name: "승인 대기 설계 승인", exact: true })
    .click();
  const queuedCard = page
    .locator('.wb-task-lane[data-stage="queued"]')
    .locator(".wb-board-card")
    .filter({ hasText: "승인 대기" });
  await expect(queuedCard).toBeVisible();
  await page.reload();
  await nav(page, "작업");
  await expect(
    page
      .locator('.wb-task-lane[data-stage="clarify"]')
      .locator(".wb-board-card")
      .filter({ hasText: "브라우저 흐름 검증" }),
  ).toBeVisible();
  await expect(queuedCard).toBeVisible();

});

test("editing metadata from a task detail is reachable", async ({ page }) => {
  await page
    .getByRole("button", {
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
    })
    .click();
  await page
    .locator(".wb-detail-head")
    .getByRole("button", { name: "편집", exact: true })
    .click();
  await page
    .getByLabel("작업 이름", { exact: true })
    .fill("수정된 개발 흐름");
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

test("undated milestones can be saved and scheduled later", async ({ page }) => {
  await nav(page, "캘린더");
  await page.getByRole("button", { name: "일정 추가", exact: true }).click();
  await page.getByLabel("일정 이름", { exact: true }).fill("일정 미정 마일스톤");
  await page.getByRole("combobox", { name: "일정 종류" }).click();
  await page.getByRole("option", { name: "마일스톤", exact: true }).click();
  await page.getByLabel("날짜", { exact: true }).fill("");
  await expect(page.getByLabel("날짜", { exact: true })).not.toHaveAttribute("required", "");
  await expect(page.getByLabel("종료일", { exact: true })).toBeDisabled();
  await page.locator("form").getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const milestone = page.locator(".wb-agenda-row").filter({ hasText: "일정 미정 마일스톤" });
  await expect(milestone).toContainText("날짜 없음");
  await page.reload();
  await nav(page, "캘린더");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await milestone.click();
  await expect(page.getByLabel("날짜", { exact: true })).toHaveValue("");
  await page.getByLabel("날짜", { exact: true }).fill("2026-10-01");
  await page.locator("form").getByRole("button", { name: "저장", exact: true }).click();
  await expect(milestone).not.toContainText("날짜 없음");
});

test("markdown edits save and remain after reopening", async ({ page }) => {
  await page
    .getByRole("button", {
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
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
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
    })
    .click();
  await expect(editor).toContainText("검증된 의도");
});

test("launch failures remain visible instead of claiming a run succeeded", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
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
        name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
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
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
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
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
    })
    .click();
  await expect(page.getByRole("button", { name: "수정 요청" })).toBeVisible();
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
  await page.getByLabel("프로젝트 필터").click();
  await page.getByRole("option", { name: "Herdr", exact: true }).click();
  await page.getByRole("button", { name: "필터", exact: true }).click();
  await page.getByLabel("단계 필터").click();
  await page.getByRole("option", { name: "구현", exact: true }).click();
  await expect(page.locator(".wb-board-card")).toHaveCount(2);
  await expect(
    page.locator(".wb-board-card").filter({ hasText: "Herdr 실행과 기록 연결" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /전체 검색/ }).click();
  await page
    .getByPlaceholder("문서와 작업을 검색하세요")
    .fill("원하는 결과");
  await page
    .getByRole("option")
    .filter({ hasText: "의도에서 시작하는 개발 흐름" })
    .first()
    .click();
  await expect(page.locator(".cm-content")).toContainText("원하는 결과");
});

test("a project switches to TDD without changing existing SDD work", async ({
  page,
}) => {
  await nav(page, "프로젝트");
  const sawhorse = page
    .locator(".wb-project-card")
    .filter({ hasText: "Sawhorse" });
  await sawhorse.getByRole("button", { name: "프로젝트 편집" }).click();
  const projectDialog = page.getByRole("dialog", { name: "프로젝트 편집" });
  await projectDialog.getByRole("combobox", { name: "프로젝트 워크플로우" }).click();
  await page.getByRole("option", { name: "TDD 사이클 · v1.0.0" }).click();
  await projectDialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(sawhorse).toContainText("TDD 사이클");

  // 선택이 저장됐는지 다시 열어 확인한다.
  await sawhorse.getByRole("button", { name: "프로젝트 편집" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "프로젝트 편집" })
      .getByRole("combobox", { name: "프로젝트 워크플로우" }),
  ).toContainText("TDD 사이클");
  await page
    .getByRole("dialog", { name: "프로젝트 편집" })
    .getByRole("button", { name: "닫기", exact: true })
    .click();

  // 기존 항목은 시작 당시 워크플로우를 유지한다.
  await nav(page, "작업");
  await expect(
    page
      .locator('.wb-task-lane[data-stage="design"]')
      .locator(".wb-board-card")
      .filter({ hasText: "의도에서 시작하는 개발 흐름" }),
  ).toBeVisible();
  await nav(page, "작업대");
  await expect(
    page.getByRole("button", {
      name: /의도에서 시작하는 개발 흐름 Sawhorse · 설계/,
    }),
  ).toBeVisible();
});

test("schema studio exposes the guarded desktop migration workflow", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await nav(page, "설정");
  await page.getByRole("navigation", { name: "설정", exact: true }).getByRole("button", { name: "볼트", exact: true }).click();
  await page
    .getByRole("button", { name: "열기", exact: true })
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
  await nav(page, "워크플로");
  await page.getByRole("button", { name: "새 워크플로", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "워크플로", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "에이전트에게 맡기고 싶은 일" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "직접 구성하고 싶다면" }).click();
  await expect(page.getByRole("button", { name: "가상 실행" })).toBeVisible();

  await nav(page, "프로젝트");
  await page
    .getByRole("button", { name: "자료로 문서 만들기", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: /문서 만들기/ }),
  ).toBeVisible();
  await expect(page.getByLabel("자료 던지기 영역")).toBeVisible();
});


test("final acceptance closes the work in both views and freezes further execution", async ({ page }) => {
  await loadLifecyclePreview(page);
  await nav(page, "작업");
  const detail = page.locator(".wb-detail-dialog");
  const unconfirmed = page
    .locator('.wb-task-lane[data-stage="unconfirmed"]')
    .locator(".wb-board-card")
    .filter({ hasText: "완료·미확인" });
  await expect(unconfirmed).toHaveCount(1);
  await unconfirmed.getByRole("button", { name: "완료·미확인", exact: true }).click();
  await expect(detail.locator(".wb-intent-flow-head h3")).toHaveText("완료·미확인");
  await expect(detail.getByRole("button", { name: "실행 시작", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "확인 · 완료", exact: true }).click();
  await expect(detail.locator(".wb-intent-flow-head h3")).toHaveText("완료");
  await expect(detail.getByRole("button", { name: "확인 · 완료", exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "실행 시작", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  const accepted = page
    .locator('.wb-task-lane[data-stage="done"]')
    .locator(".wb-board-card")
    .filter({ hasText: "완료·미확인" });
  await expect(accepted).toBeVisible();
  await expect(accepted.getByRole("button", { name: "확인 완료" })).toHaveCount(0);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const row = page.locator(".wb-issue-table tbody tr").filter({ hasText: "완료·미확인" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("결과 검토", { exact: true })).toHaveCount(0);
  await expect(row.getByText("완료", { exact: true }).first()).toBeVisible();
  await page.reload();
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const persisted = page
    .locator(".wb-issue-table tbody tr")
    .filter({ hasText: "완료·미확인" });
  await expect(persisted).toHaveCount(1);
  await expect(persisted.getByText("완료", { exact: true }).first()).toBeVisible();
});
