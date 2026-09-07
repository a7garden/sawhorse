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
    has: page.getByRole("heading", { name: "다음에 할 일", exact: true }),
  });
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
  const grip = (await page
    .getByRole("button", { name: "다음에 할 일 위젯 이동" })
    .boundingBox())!;
  await page.mouse.move(grip.x + 20, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(grip.x + 180, grip.y + 100, { steps: 12 });
  await page.mouse.up();
  await page.reload();
  await page.getByRole("button", { name: "배치 편집", exact: true }).click();
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
  await page.getByLabel("핵심 지표", { exact: false }).check();
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
  await nav(page, "작업");
  await page.getByRole("button", { name: "실행할 작업", exact: true }).click();
  await expect(page.getByText("마일스톤 계획", { exact: true })).toBeVisible();
  await expect(
    page.getByText("인박스 승격 검토", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "작업 추가", exact: true }).click();
  await page.getByLabel("작업 제목").fill("매일 자료 정리");
  await page
    .getByLabel("작업 내용")
    .fill("새 문서를 읽고 오늘의 요약을 작성하세요.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  await page
    .getByRole("button", { name: "기존 작업 예약", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /매일 자료 정리/ })
    .click();
  await expect(page.getByLabel("작업 내용")).toHaveCount(0);
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
  await nav(page, "작업");
  await page.getByRole("button", { name: "실행할 작업", exact: true }).click();
  await expect(page.getByText("매일 자료 정리", { exact: true })).toHaveCount(
    1,
  );
});

test("all document views stay grouped under one vault sidebar category", async ({
  page,
}) => {
  await expect(page.locator("aside nav").getByText("볼트", { exact: true })).toHaveCount(1);
  for (const child of ["모든 문서", "일지", "개념", "점검"]) {
    await expect(
      page
        .locator("aside nav")
        .getByRole("button", { name: child, exact: true }),
    ).toHaveCount(1);
  }

  await nav(page, "모든 문서");
  await expect(page.getByText("볼트 문서", { exact: true })).toBeVisible();
  await nav(page, "일지");
  await expect(page.getByRole("heading", { name: "일지", exact: true })).toBeVisible();
  await nav(page, "개념");
  await expect(page.getByRole("heading", { name: "개념", exact: true })).toBeVisible();
  await nav(page, "점검");
  await expect(page.getByRole("heading", { name: "볼트", exact: true })).toBeVisible();
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
  await nav(page, "확장 관리");
  await page.getByRole("button", { name: "워크플로", exact: false }).click();
  await page
    .getByRole("button", { name: "새 워크플로", exact: true })
    .click();
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
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(
    page
      .locator(".wb-search-hit")
      .filter({ hasText: "Herdr 실행과 기록 연결" })
      .first(),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
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
  await expect(page.getByRole("status")).toContainText(
    "workspace 이슈 연결을 추가했습니다",
  );
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

test("milestones group real issues and share membership with calendar editing", async ({
  page,
}) => {
  await page.evaluate(() =>
    localStorage.setItem(
      "sawhorse.preview-issues",
      JSON.stringify(
        [1, 2].map((id) => ({
          id: `ISS-${id}`,
          title: id === 1 ? "로그인 개선" : "검색 개선",
          path: `/preview/ISS-${id}.md`,
          project: "Sawhorse",
          milestone: "",
          status: id === 1 ? "완료" : "제안",
          state: id === 1 ? "closed" : "open",
          mtimeMs: id,
          approve: false,
          legacy: false,
          dependsOn: [],
          dependents: [],
          commits: [],
          labels: [],
          assignees: [],
          priority: "보통",
          executionType: "코드",
        })),
      ),
    ),
  );
  await page.reload();
  await nav(page, "이슈");
  await page
    .getByRole("button", { name: "마일스톤 추가", exact: true })
    .click();
  await page.getByLabel("마일스톤 이름").fill("9월 개선");
  await page.getByLabel("ISS-1 로그인 개선", { exact: true }).check();
  await page.getByLabel("ISS-2 검색 개선", { exact: true }).check();
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
  await expect(
    page.getByLabel("ISS-1 로그인 개선", { exact: true }),
  ).toBeChecked();
  await page.getByLabel("ISS-1 로그인 개선", { exact: true }).uncheck();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();
  await nav(page, "이슈");
  await expect(
    page.getByRole("progressbar", { name: "9월 개선 진행률" }),
  ).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: /9월 개선.*0\/1 완료/ }).click();
  await expect(page.locator("table").getByText("검색 개선")).toBeVisible();
  await expect(page.locator("table").getByText("로그인 개선")).toHaveCount(0);
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

test("opening a workflow from its extension card edits the selected definition", async ({
  page,
}) => {
  await nav(page, "확장 관리");
  await page.getByRole("button", { name: "워크플로", exact: false }).click();
  await page
    .getByRole("button", { name: "스튜디오에서 열기", exact: true })
    .nth(1)
    .click();
  await expect(
    page.getByLabel("워크플로 이름", { exact: true }),
  ).toHaveValue("TDD 사이클");
  await expect(page.getByLabel("워크플로 캔버스")).toBeVisible();
});
