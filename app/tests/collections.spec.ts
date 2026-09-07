import { test, expect, type Page } from "@playwright/test";

const nav = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();

async function openPreview(page: Page) {
  await page.goto("/?preview=1");
  await expect(
    page.getByRole("heading", { name: "작업대", exact: true }),
  ).toBeVisible();
}

test("automation search combines with categories and resets without changing tasks", async ({
  page,
}) => {
  await openPreview(page);
  await nav(page, "자동화");
  await page.getByLabel("자동화 작업 검색").fill("납기");
  await expect(page.getByText("마일스톤 계획", { exact: true })).toBeVisible();
  await expect(page.getByText("인박스 승격 검토", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("button", { name: "내가 만든 작업", exact: true })
    .click();
  await expect(page.getByText("조건에 맞는 항목이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await expect(
    page.getByText("인박스 승격 검토", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("자동화 작업 검색")).toHaveValue("");
  await page.setViewportSize({ width: 900, height: 800 });
  expect(
    await page
      .locator("main")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "test-results/collections-automation.png" });
});

test("run history filters retain active runs and expose logs and reports", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "sawhorse.preview-jobs",
      JSON.stringify([
        {
          id: "active",
          kind: "task",
          label: "진행 중 자료 정리",
          project: "Sawhorse",
          status: "running",
          createdAtMs: Date.now() - 30000,
          startedAtMs: Date.now() - 20000,
          runner: "headless",
        },
        {
          id: "failed",
          kind: "task",
          label: "실패한 문서 정리",
          project: "Sawhorse",
          status: "failed",
          error: "연결 실패",
          createdAtMs: Date.now() - 60000,
          finishedAtMs: Date.now() - 10000,
          runner: "headless",
        },
        {
          id: "success",
          kind: "task",
          label: "완료한 일지 정리",
          project: "Knowledge",
          status: "success",
          createdAtMs: Date.now() - 86400000,
          finishedAtMs: Date.now() - 86000000,
          runner: "headless",
        },
      ]),
    );
  });
  await openPreview(page);
  await nav(page, "실행 기록");
  const history = page.getByRole("region", { name: "지난 실행" });
  await page
    .getByRole("group", { name: "실행 결과 필터" })
    .getByRole("button", { name: "실패", exact: true })
    .click();
  await expect(
    history.getByText("실패한 문서 정리", { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText("완료한 일지 정리", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "진행 중 자료 정리", exact: true }),
  ).toBeVisible();
  await page.getByLabel("실행 이름·프로젝트 검색").fill("Knowledge");
  await expect(history.getByText("조건에 맞는 항목이 없습니다.")).toBeVisible();
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await history
    .getByRole("row")
    .filter({ hasText: "실패한 문서 정리" })
    .getByRole("button", { name: "로그", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await page.setViewportSize({ width: 900, height: 800 });
  expect(
    await page
      .locator("main")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/collections-jobs.png",
    fullPage: true,
  });
  await history.getByRole("row").filter({ hasText: "완료한 일지 정리" }).getByRole("button", { name: "리포트", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("저장된 리포트가 없습니다.");
  await page.getByRole("dialog").getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "진행 중 자료 정리 취소", exact: true }).click();
  await expect(page.getByRole("heading", { name: "지금은 실행 중인 작업이 없습니다" })).toBeVisible();
  await expect(history.getByText("진행 중 자료 정리", { exact: true })).toBeVisible();

});

// Reading uses a native IPC fixture: no feeds are fetched and no user vault is touched.
async function readingFixture(page: Page) {
  await page.evaluate(() => {
    const fixtureWindow = window as unknown as {
      isTauri: boolean;
      __TAURI_INTERNALS__: unknown;
    };
    const articles = [
      {
        id: "one",
        title: "읽기 좋은 작업 기록",
        summary: "작업의 맥락과 결과를 함께 남기는 방법을 살펴봅니다.",
        url: "https://example.com/one",
        tags: '["디자인"]',
        publishedAt: "2026-09-08T01:00:00Z",
        discoveredAt: "2026-09-08T01:00:00Z",
        read: 0,
        archived: 0,
      },
      {
        id: "two",
        title: "작은 화면의 정보 설계",
        summary:
          "좁은 창에서도 주요 동작에 쉽게 접근할 수 있는 화면을 만듭니다.",
        url: "https://example.com/two",
        tags: "[]",
        publishedAt: "2026-09-07T01:00:00Z",
        discoveredAt: "2026-09-07T01:00:00Z",
        read: 1,
        archived: 0,
      },
    ];
    fixtureWindow.isTauri = true;
    fixtureWindow.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: Record<string, unknown>) => {
        if (command === "sources_list_instances")
          return {
            instances: [
              {
                instanceId: "디자인 피드",
                config: { feeds: [], refreshMinutes: 30, storeContent: false },
              },
            ],
            deadLetters: [],
          };
        if (command === "articles_list")
          return { articles: structuredClone(articles) };
        if (command === "article_set_state") {
          const article = articles.find((a) => a.id === args.articleId)!;
          if (args.read != null) article.read = args.read ? 1 : 0;
          if (args.archived != null)
            article.archived = args.archived ? 1 : 0;
          return;
        }
        if (command === "list_jobs") return [];
        throw new Error(`Unexpected fixture command: ${command}`);
      },
    };
  });
}

test("reading search, unread and archive controls update the same article list", async ({
  page,
}) => {
  await openPreview(page);
  await readingFixture(page);
  await nav(page, "읽을거리");
  await expect(page.getByRole("article")).toHaveCount(2);
  await page
    .getByRole("group", { name: "기사 상태 필터" })
    .getByRole("button", { name: "안읽음", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("article")
    .getByRole("button", { name: "읽음", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await page.getByLabel("기사 제목·내용 검색").fill("좁은 창");
  await expect(page.getByRole("article")).toHaveCount(1);
  await page
    .getByRole("article")
    .getByRole("button", { name: "보관", exact: true })
    .click();
  await page
    .getByRole("group", { name: "기사 상태 필터" })
    .getByRole("button", { name: "보관", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "작은 화면의 정보 설계" }),
  ).toBeVisible();
  await page
    .getByRole("article")
    .getByRole("button", { name: "보관 해제", exact: true })
    .click();
  await expect(page.getByRole("article")).toHaveCount(0);
  await page.getByRole("button", { name: "필터 초기화" }).click();
  await page.setViewportSize({ width: 900, height: 800 });
  expect(
    await page
      .locator("main")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({ path: "test-results/collections-reading.png" });
});
