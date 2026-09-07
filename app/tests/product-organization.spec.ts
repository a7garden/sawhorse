import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/?preview=1");
  await expect(
    page.getByRole("heading", { name: "작업대", exact: true }),
  ).toBeVisible();
});
const nav = (page: import("@playwright/test").Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();

test("dashboard widgets resize, move, hide and persist an intentionally empty board", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "새 작업", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  const widget = page.locator(".widget-grid-item").filter({
    has: page.getByRole("heading", { name: "다음 작업", exact: true }),
  });
  // 보드에 전체폭 위젯이 늘면 이 위젯은 첫 화면 아래로 밀린다. 마우스 좌표는
  // 뷰포트 기준이므로 손잡이를 화면 안으로 가져온 뒤에 재야 한다.
  await widget.scrollIntoViewIfNeeded();
  const before = (await widget.boundingBox())!;
  const handle = (await widget
    .locator(".react-resizable-handle")
    .boundingBox())!;
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    handle.x + handle.width / 2,
    handle.y + handle.height / 2 + 84,
    { steps: 12 },
  );
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await widget.boundingBox())!.height))
    .toBeGreaterThan(Math.round(before.height));
  const resized = Math.round((await widget.boundingBox())!.height);
  const gripHandle = page.getByRole("button", {
    name: "다음 작업 위젯 이동",
  });
  await gripHandle.scrollIntoViewIfNeeded();
  const grip = (await gripHandle.boundingBox())!;
  await page.mouse.move(grip.x + 20, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(grip.x + 180, grip.y + 100, { steps: 12 });
  await page.mouse.up();
  await page.reload();
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
  await widget.scrollIntoViewIfNeeded();
  await expect
    .poll(async () => Math.round((await widget.boundingBox())!.height))
    .toBe(resized);
  while (await page.getByRole("button", { name: /위젯 숨기기/ }).count())
    await page
      .getByRole("button", { name: /위젯 숨기기/ })
      .first()
      .click();
  await page.reload();
  await expect(page.getByText("표시할 위젯이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "위젯 추가", exact: true }).click();
  // 지표는 카드 한 장이 위젯 하나다. 하나만 켜서 보드가 그 한 칸으로 돌아오는지 본다.
  await page.getByLabel("위젯 검색").fill("결과 검토");
  await page.getByLabel("결과 검토", { exact: false }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(page.locator(".widget-grid-item")).toHaveCount(1);
  await page.screenshot({ path: "test-results/dashboard.png", fullPage: true });
});

test("tasks are defined once and scheduled by reference without duplicating content", async ({
  page,
}) => {
  await nav(page, "자동화");
  await page.getByRole("button", { name: "자동화 작업", exact: true }).click();
  await expect(page.getByText("마일스톤 계획", { exact: true })).toBeVisible();
  await expect(
    page.getByText("인박스 승격 검토", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "정의 추가", exact: true }).click();
  await page.getByLabel("자동화 작업 제목").fill("매일 자료 정리");
  await page
    .getByLabel("실행 내용")
    .fill("새 문서를 읽고 오늘의 요약을 작성하세요.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  await page
    .getByRole("button", { name: "기존 정의 예약", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /매일 자료 정리/ })
    .click();
  await expect(page.getByLabel("실행 내용")).toHaveCount(0);
  await page.getByLabel("실행 주기").selectOption("daily");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(page.getByText("매일 09:00", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "한 번 예약", exact: true }).click();
  await expect(page.getByText("매일 자료 정리", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "반복 실행", exact: true }).click();
  await expect(page.getByText("매일 자료 정리", { exact: true })).toBeVisible();
  await page.reload();
  await nav(page, "자동화");
  await page.getByRole("button", { name: "자동화 작업", exact: true }).click();
  await expect(page.getByText("매일 자료 정리", { exact: true })).toHaveCount(
    1,
  );
});

test("the SDLC board and the automation library are separate entry points", async ({
  page,
}) => {
  // 개발 = intent.md 로 시작하는 작업, 자동화 = 저장해 둔 자동화 작업.
  // 같은 그룹에 섞이면 다시 같은 말로 읽히므로 진입점 자체가 갈라져 있어야 한다.
  await nav(page, "작업");
  await page.getByRole("button", { name: "공정 보드", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "작업", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "새 작업", exact: true }),
  ).toBeVisible();
  for (const gone of ["자동화 작업", "예약과 반복", "할 일"])
    await expect(
      page.locator("main").getByRole("button", { name: gone, exact: true }),
    ).toHaveCount(0);

  await nav(page, "자동화");
  await expect(
    page.getByRole("heading", { name: "자동화 작업", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "정의 추가", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "새 작업", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "예약과 반복", exact: true }),
  ).toBeVisible();
});

test("all document views stay grouped under one vault sidebar category", async ({
  page,
}) => {
  await expect(
    page.locator("aside nav").getByText("볼트", { exact: true }),
  ).toHaveCount(1);
  for (const child of ["모든 문서", "할 일", "일지", "개념", "점검"]) {
    await expect(
      page
        .locator("aside nav")
        .getByRole("button", { name: child, exact: true }),
    ).toHaveCount(1);
  }

  await nav(page, "모든 문서");
  await expect(page.getByText("볼트 문서", { exact: true })).toBeVisible();
  await nav(page, "일지");
  await expect(
    page.getByRole("heading", { name: "일지", exact: true }),
  ).toBeVisible();
  await nav(page, "개념");
  await expect(
    page.getByRole("heading", { name: "개념", exact: true }),
  ).toBeVisible();
  await nav(page, "점검");
  await expect(
    page.getByRole("heading", { name: "볼트", exact: true }),
  ).toBeVisible();
});

test("installed GitHub gets an extension page and RSS stays inside reading", async ({
  page,
}) => {
  await expect(
    page
      .locator("aside nav")
      .getByRole("button", { name: "GitHub", exact: true }),
  ).toHaveCount(0);
  await nav(page, "확장 관리");
  await page
    .getByRole("button", { name: "확장 설치·사용", exact: true })
    .click();
  await nav(page, "GitHub");
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "이슈 동기화 관리", exact: true })
    .click();
  await page.getByRole("button", { name: "연결 추가", exact: true }).click();
  await expect(page.getByRole("option", { name: /GitHub/ })).toHaveCount(1);
  await expect(page.getByRole("option", { name: /읽을거리/ })).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await nav(page, "읽을거리");
  await page
    .getByRole("button", { name: "RSS 소스 관리", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "읽을거리 소스", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "연결 추가", exact: true }).click();
  await expect(page.getByRole("option", { name: /GitHub/ })).toHaveCount(0);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await nav(page, "확장 관리");
  await page
    .getByTestId("core-extension-feeds")
    .getByRole("button", { name: "사용 중지" })
    .click();
  await expect(
    page
      .locator("aside nav")
      .getByRole("button", { name: "읽을거리", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page
      .locator("aside nav")
      .getByRole("button", { name: "읽을거리", exact: true }),
  ).toHaveCount(0);
});

test("workflow edges are editable without JSON and schema is nested under settings", async ({
  page,
}) => {
  await nav(page, "워크플로");
  await page.getByRole("button", { name: "새 워크플로", exact: true }).click();
  await expect(page.getByLabel("워크플로 캔버스")).toBeVisible();
  await page.getByLabel("연결 1 다음 단계").selectOption("start");
  await expect(page.getByLabel("연결 1 다음 단계")).toHaveValue("start");
  await page.getByRole("button", { name: "단계 추가", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "단계 새 단계 3" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "연결 추가", exact: true }).click();
  await expect(page.getByLabel("연결 2 시작 단계")).toHaveValue("step-3");
  await page.screenshot({
    path: "test-results/workflow-canvas.png",
    fullPage: true,
  });
  await nav(page, "설정");
  await page
    .getByRole("button", { name: "볼트 문서 구조", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "볼트 문서 구조" }),
  ).toBeVisible();
  await page
    .getByLabel("입력 형식", { exact: true })
    .first()
    .selectOption("boolean");
  await page.getByRole("button", { name: "고급 JSON" }).click();
  await expect(page.getByLabel("VaultSchema JSON")).toContainText(
    '"type": "boolean"',
  );
});

test("global search and notifications remain available from every primary page", async ({
  page,
}) => {
  await nav(page, "프로젝트");
  await page.getByRole("button", { name: /전체 검색/ }).click();
  await page.getByPlaceholder("문서와 작업을 검색하세요").fill("Herdr");
  await expect(
    page.getByRole("option").filter({ hasText: "Herdr 실행과 기록 연결" }).first(),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "알림센터", exact: true }).click();
  await expect(page.getByText("새 알림이 없습니다.")).toBeVisible();
});

test("installed GitHub stays manageable when disabled and repositories provide connection actions", async ({
  page,
}) => {
  await nav(page, "확장 관리");
  const extension = page.getByTestId("core-extension-github");
  await extension.getByRole("button", { name: "확장 설치·사용" }).click();
  await extension.getByRole("button", { name: "사용 중지" }).click();
  await expect(extension.getByText("설치됨", { exact: true })).toBeVisible();
  await extension.getByRole("button", { name: "관리", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "사용 시작", exact: true }).click();
  await expect(page.getByLabel("GitHub 토큰")).toHaveCount(0);
  await page.getByRole("button", { name: "GitHub로 로그인" }).click();
  await expect(page.getByText("ABCD-EFGH", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "예제 계정", exact: true }),
  ).toBeVisible();
  await page.getByLabel("저장소 검색").fill("workspace");
  await expect(
    page.getByRole("heading", { name: "preview-user/docs" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "이슈 연결", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "이슈 연결을 추가했습니다" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "프로젝트로 가져오기", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "폴더 선택" })
    .click();
  await expect(page.getByRole("alert")).toContainText("데스크톱 앱에서");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.getByRole("button", { name: "이슈 동기화 관리" }).click();
  await expect(
    page.getByText("preview-user/workspace", { exact: true }).first(),
  ).toBeVisible();
});

// 이슈와 작업은 한 저장소다. 마일스톤 소속도 작업의 milestone 필드
// 한 곳에만 적히고, 이슈 화면과 캘린더가 같은 편집기를 쓴다.
test("milestones group work items and share membership with calendar editing", async ({
  page,
}) => {
  const closed = "work-release 첫 작업대 배포 기록";
  const open = "work-search 프로젝트를 넘나드는 지식 검색";
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await page
    .getByRole("button", { name: "마일스톤 추가", exact: true })
    .click();
  await page.getByLabel("일정 이름").fill("9월 개선");
  await page.getByLabel(closed, { exact: true }).check();
  await page.getByLabel(open, { exact: true }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await expect(
    page.getByRole("progressbar", { name: "9월 개선 진행률" }),
  ).toHaveAttribute("aria-valuenow", "50");
  await page.reload();
  await nav(page, "캘린더");
  await page.getByRole("button", { name: "9월 개선", exact: true }).click();
  await expect(page.getByLabel(closed, { exact: true })).toBeChecked();
  await page.getByLabel(closed, { exact: true }).uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(
    page.getByRole("progressbar", { name: "9월 개선 진행률" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: /9월 개선.*0\/1 완료/ }).click();
  await expect(
    page.locator("table").getByText("프로젝트를 넘나드는 지식 검색"),
  ).toBeVisible();
  await expect(
    page.locator("table").getByText("첫 작업대 배포 기록"),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/issue-milestones.png",
    fullPage: true,
  });
});

test("project imports preserve project context and functional pages have no slogan banners", async ({
  page,
}) => {
  await nav(page, "프로젝트");
  const project = page.locator(".wb-project-card").first();
  const name = await project.locator("h2").innerText();
  await expect(page.getByLabel("화면 선택")).toHaveCount(0);
  await project.getByRole("button", { name: "자료로 문서 만들기" }).click();
  await expect(
    page.getByRole("heading", { name: `${name} · 문서 만들기`, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("문서를 만들 프로젝트")).toBeDisabled();
  await nav(page, "캘린더");
  await expect(
    page.getByRole("heading", { name: "캘린더", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/시간 위의 약속|같은 리듬|SAWHORSE SDD/),
  ).toHaveCount(0);
  await nav(page, "확장 관리");
  await expect(page.getByLabel("화면 선택")).toHaveCount(0);
  await nav(page, "설정");
  await expect(page.getByLabel("화면 선택")).toHaveCount(0);
});

test("opening a published workflow from the library edits the selected definition", async ({
  page,
}) => {
  await nav(page, "워크플로");
  await page
    .getByRole("button", { name: "TDD 사이클", exact: false })
    .first()
    .click();
  await expect(page.getByLabel("워크플로 이름", { exact: true })).toHaveValue(
    "TDD 사이클",
  );
  await expect(page.getByLabel("워크플로 캔버스")).toBeVisible();
});

test("one work entry shares filters, detail and decisions between list and process board", async ({ page }) => {
  const sidebar = page.locator("aside nav");
  await expect(sidebar.getByRole("button", { name: "작업", exact: true })).toHaveCount(1);
  for (const removed of ["개발", "이슈"]) await expect(sidebar.getByRole("button", { name: removed, exact: true })).toHaveCount(0);
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await page.getByLabel("프로젝트 필터").selectOption("sawhorse");
  const row = page.locator(".wb-issue-table tbody tr").filter({ hasText: "의도에서 시작하는 개발 흐름" });
  await expect(row).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "승인", exact: true })).toHaveCount(0);
  await row.getByText("의도에서 시작하는 개발 흐름", { exact: true }).click();
  await page.getByLabel("검토 결정", { exact: true }).fill("설계의 수용 기준을 확인했습니다.");
  await page.getByRole("button", { name: "검토 후 다음: 구현", exact: true }).click();
  await expect(page.locator(".wb-detail-title")).toContainText("진행");
  await page.locator(".wb-detail-dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "공정 보드", exact: true }).click();
  await expect(page.getByLabel("프로젝트 필터")).toHaveValue("sawhorse");
  await expect(page.locator('.wb-board-column[data-stage="build"]').getByText("의도에서 시작하는 개발 흐름", { exact: true })).toBeVisible();
  await expect(page.getByText("Herdr 실행과 기록 연결", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(row.getByRole("button", { name: "구현", exact: true })).toBeVisible();
  await page.reload();
  await nav(page, "작업");
  await expect(page.locator(".wb-issue-table")).toBeVisible();
  await page.getByRole("button", { name: "새 작업", exact: true }).click();
  await expect(page.getByLabel("상태", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("유형", { exact: true })).toHaveValue("작업");
});

test("issue rows run their own stage, select in bulk and filter by tag", async ({
  page,
}) => {
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  const row = (title: string) =>
    page.locator(".wb-issue-table tbody tr").filter({ hasText: title });

  // 행마다 지금 밟을 단계가 그대로 버튼이 된다.
  await expect(
    row("의도에서 시작하는 개발 흐름").getByRole("button", {
      name: "설계",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    row("Herdr 실행과 기록 연결").getByRole("button", {
      name: "구현",
      exact: true,
    }),
  ).toBeVisible();

  // 끝난 항목에는 더 밟을 단계가 없다. 이 항목은 배포에서 완료되었다.
  await page.getByLabel("열림 상태").selectOption("all");
  await expect(
    row("첫 작업대 배포 기록").getByRole("button", {
      name: "배포",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("열림 상태").selectOption("open");

  // 실행은 확인창을 거친다. 체험 모드는 실행을 거절하므로 실패가 그대로 보인다.
  await row("의도에서 시작하는 개발 흐름")
    .getByRole("button", { name: "설계", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "설계 단계를 실행할까요?",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "실행", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("실패");

  const visible = await page.locator(".wb-issue-table tbody tr").count();
  await page.getByLabel("전체 선택").check();
  await expect(page.locator(".wb-bulk-bar")).toContainText(`${visible}건 선택`);
  await expect(page.getByRole("button", { name: "선택 실행", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "선택 승인", exact: true })).toHaveCount(0);

  // 문서에 적힌 태그로도 거를 수 있다.
  await page.getByRole("button", { name: "새 작업", exact: true }).click();
  await page
    .getByLabel("작업 이름", { exact: true })
    .fill("태그 필터 확인");
  await page.getByLabel("태그", { exact: true }).fill("챗봇");
  await page
    .getByRole("button", { name: "작업 만들기", exact: true })
    .click();
  await page
    .locator(".wb-detail-dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await nav(page, "작업");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await page.getByLabel("태그 필터", { exact: true }).selectOption("챗봇");
  await expect(page.locator(".wb-issue-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".wb-issue-table")).toContainText("태그 필터 확인");
});

test("the bundled metric strip becomes four cards a user can rearrange one by one", async ({
  page,
}) => {
  // v3 까지 쓰던 묶음 위젯. 이관은 같은 자리에서 낱개 카드 넉 장으로 펼쳐야 한다.
  await page.evaluate(() => {
    localStorage.setItem(
      "sawhorse.dashboard-layout",
      JSON.stringify({
        version: 3,
        enabled: ["metrics", "next"],
        layouts: {
          lg: [
            { i: "metrics", x: 0, y: 0, w: 12, h: 4 },
            { i: "next", x: 0, y: 4, w: 6, h: 8 },
          ],
          md: [
            { i: "metrics", x: 0, y: 0, w: 8, h: 5 },
            { i: "next", x: 0, y: 5, w: 8, h: 8 },
          ],
          sm: [
            { i: "metrics", x: 0, y: 0, w: 4, h: 8 },
            { i: "next", x: 0, y: 8, w: 4, h: 8 },
          ],
        },
      }),
    );
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "작업대", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".wb-metric.is-solo")).toHaveCount(4);
  await expect(page.locator(".widget-grid-item")).toHaveCount(5);
  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("sawhorse.dashboard-layout")!),
  );
  expect(stored.version).toBe(4);
  expect(stored.enabled).toEqual([
    "metric:running",
    "metric:ready",
    "metric:overdue",
    "metric:done",
    "next",
  ]);

  // 이제 카드 하나가 위젯 하나이므로 원하는 숫자만 따로 켤 수 있다.
  await page.getByRole("button", { name: "위젯 추가", exact: true }).click();
  await page.getByLabel("위젯 검색").fill("제안");
  await page.getByLabel("제안", { exact: false }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(page.locator(".wb-metric.is-solo")).toHaveCount(5);
  await page.reload();
  await expect(page.locator(".wb-metric.is-solo")).toHaveCount(5);
});
