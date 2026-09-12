import { test, expect, type Page } from "@playwright/test";

const openMarket = async (page: Page) => {
  await page.goto("/?preview=1");
  await page
    .locator("aside nav")
    .getByRole("button", { name: "확장 관리", exact: true })
    .click();
  await page.getByRole("button", { name: "마켓플레이스", exact: true }).click();
};

test("default skills source searches without connecting a catalog and preserves explicit target choices", async ({
  page,
}) => {
  await openMarket(page);
  const market = page.getByRole("region", {
    name: "스킬 마켓플레이스 · skills.sh",
  });
  await expect(market.getByText("기본 제공", { exact: true })).toBeVisible();
  await expect(page.getByLabel("마켓플레이스 URL")).not.toBeVisible();
  await market.getByRole("button", { name: "react", exact: true }).click();
  const row = market
    .getByRole("article")
    .filter({ hasText: "React best practices" });
  await expect(row).toBeVisible();
  const selectedTargets = market.locator(
    '.market-targets button[aria-pressed="true"]',
  );
  while (await selectedTargets.count()) await selectedTargets.first().click();
  await expect(
    row.getByRole("button", { name: "설치", exact: true }),
  ).toBeDisabled();
  await expect(
    market.getByText("설치할 에이전트를 하나 이상 선택하세요."),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "워크플로 확장 작업 단계, 산출물과 승인 흐름",
    })
    .click();
  await expect(market).not.toBeVisible();
  await page
    .getByRole("button", {
      name: "스킬 확장 에이전트가 활용하는 지식과 작업 지침",
    })
    .click();
  await expect(row).toBeVisible();
  await expect(
    row.getByRole("button", { name: "설치", exact: true }),
  ).toBeDisabled();
  await market.getByRole("button", { name: "codex", exact: true }).click();
  await row.getByRole("button", { name: "설치", exact: true }).click();
  // Preview must never install into the user's actual agent folders or claim success.
  await expect(market.getByRole("alert")).toContainText("데스크톱 앱");
  await expect(
    row.getByRole("button", { name: "설치", exact: true }),
  ).toBeEnabled();
  await expect(
    row.getByRole("button", { name: "설치됨", exact: true }),
  ).toHaveCount(0);
  await market.getByLabel("스킬 검색 (2자 이상)").fill("no-such-extension-xyz");
  await market.getByRole("button", { name: "검색", exact: true }).click();
  await expect(market.getByText("검색 결과가 없습니다.")).toBeVisible();
});

test("extension types lead to their own management surfaces", async ({
  page,
}) => {
  await openMarket(page);
  await page
    .getByRole("button", { name: "기능 확장 화면, 액션과 외부 서비스 연결" })
    .click();
  await expect(
    page.getByRole("region", { name: "스킬 마켓플레이스 · skills.sh" }),
  ).not.toBeVisible();
  await page
    .getByRole("region", { name: "기능 확장", exact: true })
    .getByRole("button", { name: "관리", exact: true })
    .first()
    .click();
  await expect(page.getByTestId("core-extension-github")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "기능", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "스킬", exact: true }).click();
  await expect(
    page.getByText("에이전트에 설치된 스킬", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "스킬 마켓플레이스 · skills.sh" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "워크플로", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("확장이 제공하는 워크플로", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "워크플로 스튜디오", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "새 워크플로", exact: true }).first(),
  ).toBeVisible();
});

test("marketplace stays readable in light and dark themes at desktop and narrow widths", async ({
  page,
}) => {
  await openMarket(page);
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const dark of [false, true]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark,
      );
      await expect(
        page.getByRole("heading", {
          name: "필요한 만큼, 작업 공간을 넓히세요",
        }),
      ).toBeVisible();
      const content = page.locator(".extension-marketplace");
      expect(
        await content.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/marketplace-${width}-${dark ? "dark" : "light"}.png`,
        fullPage: true,
      });
    }
  }
});
