import { test, expect, type Page } from "@playwright/test";
const nav = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();
const scope = (page: Page) =>
  page.getByRole("combobox", { name: "프로젝트 전환", exact: true });
async function selectProject(page: Page, name: string) {
  await scope(page).click();
  await page.getByRole("option", { name, exact: true }).click();
}
// The workbench is project-scoped: 작업대·실행 nav entries exist only after a
// project is picked, and work details open from the flow-board cards.
async function openWorkDetail(page: Page, title: string) {
  await selectProject(page, "Sawhorse");
  await nav(page, "작업대");
  await page
    .locator(".wb-task-board")
    .getByRole("button", { name: title, exact: true })
    .click();
  await expect(page.locator(".wb-detail-dialog")).toBeVisible();
}
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

  await selectProject(page, "Sawhorse");
  await nav(page, "작업대");
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
  // The board contract below needs the SDD process, so the new project pins it at creation.
  await page
    .getByRole("combobox", { name: "프로젝트 워크플로우", exact: true })
    .click();
  await page.getByRole("option", { name: /SDD · 명세 기반 개발/ }).click();
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.locator(".wb-project-card").filter({ hasText: "검증 프로젝트" }),
  ).toBeVisible();
  await selectProject(page, "검증 프로젝트");
  await nav(page, "작업대");
  // 검증 프로젝트 has no intake artifact yet, so the header button is the generic 새 항목
  // and the chooser dialog (project + workflow preselected) leads to the composer.
  await page.getByRole("button", { name: "새 항목", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "계속", exact: true }).click();
  await page.getByLabel("작업 이름", { exact: true }).fill("브라우저 흐름 검증");
  await page
    .getByRole("textbox", { name: "의도" })
    .fill("브라우저 흐름이 끊기지 않고 이어지는지 확인합니다.");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-detail h2")).toHaveText("브라우저 흐름 검증");
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  // A fresh project opens on the 전체 작업 list; the flow board lives in its workflow view.
  await page.getByRole("combobox", { name: "작업대 보기", exact: true }).click();
  await page.getByRole("option", { name: /SDD · 명세 기반 개발 · v1\.1\.1/ }).click();
  const card = page
    .locator(".wb-board-card")
    .filter({ hasText: "브라우저 흐름 검증" });
  await expect(card).not.toHaveAttribute("draggable", "true");
  await card.getByRole("button").click();
  await page.getByLabel("검토 결정", { exact: true }).fill("요청의 범위와 성공 기준을 확인했습니다.");
  await page.getByRole("button", { name: "검토 후 다음: 설계", exact: true }).click();
  await page.locator(".wb-detail-dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(page.locator('.wb-task-lane[data-stage="design"]').getByText("브라우저 흐름 검증", { exact: true })).toBeVisible();
  await page.reload();
  await nav(page, "작업대");
  // The reload resets the workbench to the 전체 작업 list; reopen the SDD flow board.
  await page.getByRole("combobox", { name: "작업대 보기", exact: true }).click();
  await page.getByRole("option", { name: /SDD · 명세 기반 개발 · v1\.1\.1/ }).click();

});

test("editing metadata from a task detail is reachable", async ({ page }) => {
  await openWorkDetail(page, "의도에서 시작하는 개발 흐름");
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
  await openWorkDetail(page, "의도에서 시작하는 개발 흐름");
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
    .locator(".wb-task-board")
    .getByRole("button", { name: "의도에서 시작하는 개발 흐름", exact: true })
    .click();
  await expect(editor).toContainText("검증된 의도");
});

test("launch failures remain visible instead of claiming a run succeeded", async ({
  page,
}) => {
  await openWorkDetail(page, "의도에서 시작하는 개발 흐름");
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
    await selectProject(p, "Sawhorse");
    await nav(p, "작업대");
    await p
      .locator(".wb-task-board")
      .getByRole("button", { name: "의도에서 시작하는 개발 흐름", exact: true })
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
  await openWorkDetail(page, "의도에서 시작하는 개발 흐름");
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
  await openWorkDetail(page, "의도에서 시작하는 개발 흐름");
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
  // The in-board 프로젝트 필터 is gone: project narrowing now happens in the sidebar scope.
  await selectProject(page, "Herdr");
  await nav(page, "작업대");
  await page.getByRole("button", { name: "필터", exact: true }).click();
  await page.getByRole("combobox", { name: "단계 필터", exact: true }).click();
  await page.getByRole("option", { name: "구현", exact: true }).click();
  await expect(page.locator(".wb-board-card")).toHaveCount(1);
  await expect(page.locator(".wb-board-card")).toContainText(
    "Herdr 실행과 기록 연결",
  );
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
  await selectProject(page, "Sawhorse");
  await nav(page, "프로젝트");
  await page
    .locator(".wb-project-card")
    .filter({ hasText: "Sawhorse" })
    .getByRole("button", { name: "프로젝트 편집" })
    .click();
  await page
    .getByRole("combobox", { name: "프로젝트 워크플로우", exact: true })
    .click();
  await page.getByRole("option", { name: /TDD · 테스트 기반 개발/ }).click();
  await page
    .locator("form")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.locator(".wb-project-card").filter({ hasText: "Sawhorse" }),
  ).toContainText("TDD · 테스트 기반 개발");

  await nav(page, "작업대");
  await page.getByRole("button", { name: "새 항목", exact: true }).click();
  await page.getByRole("button", { name: "계속", exact: true }).click();
  await page.getByLabel("작업 이름", { exact: true }).fill("TDD로 만든 새 항목");
  await page
    .getByLabel("테스트 의도", { exact: true })
    .fill("Red 단계부터 검증합니다.");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(page.locator(".wb-stepper .is-current")).toContainText(
    "테스트 의도",
  );
  await expect(page.locator(".wb-artifact-nav")).toContainText("Red 근거");
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "작업대 보기", exact: true })
    .click();
  await page.getByRole("option", { name: /기본 SDD · v1\.1\.0/ }).click();
  await expect(
    page
      .locator('.wb-task-lane[data-stage="design"]')
      .getByText("의도에서 시작하는 개발 흐름", { exact: true }),
  ).toBeVisible();
  await nav(page, "대시보드");
  await expect(
    page.getByRole("button", { name: /의도에서 시작하는 개발 흐름 Sawhorse/ }),
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
  // The library rail and the gallery both offer 새 워크플로; the gallery one opens the brief,
  // and the canvas editor lives behind 직접 구성하고 싶다면.
  await page.getByRole("button", { name: "새 워크플로", exact: true }).last().click();
  await page.getByRole("button", { name: "직접 구성하고 싶다면", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "워크플로", exact: true }),
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
  // The old 입력 경로 input became the source drop zone.
  await expect(page.getByLabel("자료 던지기 영역")).toBeVisible();
});

test("final acceptance closes the work in both views and freezes further execution", async ({
  page,
}) => {
  await selectProject(page, "Sawhorse");
  await nav(page, "작업대");
  await page.getByRole("button", { name: "새 의도", exact: true }).click();
  await page.getByLabel("작업 이름", { exact: true }).fill("결과 인수 검증");
  await page
    .getByRole("textbox", { name: "의도" })
    .fill("배포 결과를 인수하고 작업을 완료합니다.");
  await page.getByRole("button", { name: "만들기", exact: true }).click();
  const detail = page.locator(".wb-detail-dialog");
  await expect(detail.getByRole("button", { name: "결과 인수·완료", exact: true })).toHaveCount(0);
  for (const stage of ["설계", "구현", "검증", "배포"]) {
    await page.getByLabel("검토 결정", { exact: true }).fill(`${stage} 진입 근거를 확인했습니다.`);
    await detail.getByRole("button", { name: `검토 후 다음: ${stage}`, exact: true }).click();
    await expect(detail.locator(".wb-stepper .is-current")).toContainText(stage);
    await expect(detail.locator(".wb-detail-title")).toContainText("진행");
  }
  await page.getByLabel("검토 결정", { exact: true }).fill("배포 결과와 완료 기준을 대조했습니다.");
  await detail.getByRole("button", { name: "결과 검토 요청", exact: true }).click();
  await expect(detail.locator(".wb-detail-title")).toContainText("결과 검토");
  await expect(detail.getByRole("button", { name: "실행 시작", exact: true })).toHaveCount(0);
  await page.getByLabel("검토 결정", { exact: true }).fill("결과를 인수합니다.");
  await detail.getByRole("button", { name: "결과 인수·완료", exact: true }).click();
  await expect(detail.locator(".wb-detail-title")).toContainText("완료");
  await expect(detail.getByLabel("검토 결정", { exact: true })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "실행 시작", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "닫기", exact: true }).click();
  // The open/closed state filter is gone; the list keeps closed work visible.
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(
    page
      .locator(".wb-issue-table tbody tr")
      .filter({ hasText: "결과 인수 검증" }),
  ).toContainText("완료");
  await page.reload();
  await nav(page, "작업대");
  await expect(
    page
      .locator(".wb-issue-table tbody tr")
      .filter({ hasText: "결과 인수 검증" }),
  ).toContainText("완료");
});
