import { expect, test, type Page } from "@playwright/test";
import {
  compareWorkflowVersions,
  groupWorkflowVersions,
  latestWorkflowVersions,
  workflowChoices,
} from "../src/features/workbench/workflow-version";
import type { WorkflowDefinition } from "../src/features/workbench/types";

async function openGallery(page: Page) {
  await page.goto("/?preview=1");
  await page
    .locator("aside nav")
    .getByRole("button", { name: "워크플로", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "우리 팀에 맞는 일의 흐름" }),
  ).toBeVisible();
}

test("SemVer ordering retains prereleases and groups immutable history", () => {
  const order = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
  ];
  for (let i = 1; i < order.length; i++)
    expect(compareWorkflowVersions(order[i - 1], order[i])).toBeLessThan(0);
  expect(compareWorkflowVersions("1.0.0+one", "1.0.0+two")).toBe(0);
  const catalog = order.map(
    (version) => ({ id: "team", version }) as WorkflowDefinition,
  );
  expect(groupWorkflowVersions(catalog)[0].map((item) => item.version)).toEqual(
    [...order].reverse(),
  );
  expect(latestWorkflowVersions(catalog).get("team")).toBe("1.10.0");
  expect(catalog.map((item) => item.version)).toEqual(order);
  expect(workflowChoices(catalog).map((item) => item.version)).toEqual([
    "1.10.0",
  ]);
  expect(
    workflowChoices(catalog, { id: "team", version: "1.0.0" }).map(
      (item) => item.version,
    ),
  ).toEqual(["1.0.0", "1.10.0"]);
});

test("gallery groups versions, compares workflows and filters by purpose", async ({
  page,
}) => {
  await openGallery(page);
  const cards = page.locator(".gallery-card");
  await expect(cards).toHaveCount(6);
  await expect(cards.locator("h3")).toHaveText([
    "Goal · 목표 달성", "SDD · 명세 기반 개발", "TDD · 테스트 기반 개발",
    "SDD + TDD · 명세·테스트 기반 개발", "Issue · 요청 해결", "Intent · 의도 기반 개발",
  ]);
  await expect(
    cards.filter({ hasText: "Intent · 의도 기반 개발" }),
  ).toHaveCount(1);
  await expect(cards.filter({ hasText: "메모에서 구현까지" })).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: "SDD · 명세 기반 개발 비교", exact: true })
    .check();
  await page
    .getByRole("checkbox", { name: "TDD · 테스트 기반 개발 비교", exact: true })
    .check();
  await expect(
    page.getByRole("region", { name: "흐름 비교", exact: true }),
  ).toContainText("최대 50회");
  await page.getByRole("button", { name: "사람 참여", exact: true }).click();
  await expect(cards.filter({ hasText: "TDD · 테스트 기반 개발" })).toHaveCount(0);
  await page.getByRole("button", { name: "전체", exact: true }).click();
  await page.getByLabel("이름이나 용도로 검색").fill("없는-워크플로");
  await expect(cards).toHaveCount(0);
  await expect(
    page.getByText("조건에 맞는 흐름이 없습니다.", { exact: false }),
  ).toBeVisible();
});

test("applying a workflow changes the project default while retaining work pins", async ({
  page,
}) => {
  await openGallery(page);
  const pins = () =>
    page.evaluate(() =>
      JSON.parse(
        localStorage.getItem("sawhorse.workflow.preview.v2") || "null",
      )?.snapshot.work.map(
        (item: {
          id: string;
          workflowId: string;
          workflowVersion: string;
          workflowDigest: string;
        }) => [
          item.id,
          item.workflowId,
          item.workflowVersion,
          item.workflowDigest,
        ],
      ),
    );
  // The preview seed is saved on the first mutation; capture rendered catalog first.
  await page
    .locator(".gallery-card")
    .filter({ hasText: "TDD · 테스트 기반 개발" })
    .getByRole("button", { name: "살펴보고 선택" })
    .click();
  await page
    .getByLabel("적용할 프로젝트 선택")
    .selectOption({ label: "Sawhorse" });
  await page
    .getByRole("button", { name: "프로젝트에 적용", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("TDD · 테스트 기반 개발 v1.0.1");
  const original = await pins();
  await page.getByRole("button", { name: "상세 닫기" }).click();
  await page
    .locator(".gallery-card")
    .filter({ hasText: "Intent · 의도 기반 개발" })
    .getByRole("button", { name: "살펴보고 선택" })
    .click();
  await page
    .getByLabel("적용할 프로젝트 선택")
    .selectOption({ label: "Sawhorse" });
  await page
    .getByRole("button", { name: "프로젝트에 적용", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("v2.0.1");
  expect(await pins()).toEqual(original);
  const detail = page.getByRole("region", {
    name: "Intent · 의도 기반 개발 상세",
  });
  await detail.getByText("이전 버전", { exact: false }).first().click();
  await expect(detail.getByText(/v1.0.0/)).toBeVisible();
});

test("shared JSON imports as a persistent draft, and duplicates have independent IDs", async ({
  page,
}) => {
  await openGallery(page);
  await page.getByRole("button", { name: "가져오기", exact: true }).click();
  await page.getByLabel("워크플로우 JSON", { exact: true }).fill("{broken");
  await page
    .getByRole("button", { name: "초안으로 가져오기", exact: true })
    .click();
  await expect(page.getByRole("status")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "우리 팀에 맞는 일의 흐름" }),
  ).toBeVisible();
  const definition: WorkflowDefinition = {
    definitionVersion: 1,
    id: "shared-team",
    label: "함께 만든 흐름",
    description: "우리 팀의 공유 절차",
    version: "1.0.0",
    entry: "done",
    artifacts: [],
    loops: [],
    edges: [],
    nodes: [
      {
        id: "done",
        label: "완료",
        kind: "end",
        actionRef: null,
        artifactRole: null,
        workflowRef: null,
        decision: null,
        inputs: [],
        outputs: [],
        allowedRoles: [],
        instructions: "",
        requiresCompletedDependencies: false,
      },
    ],
  };
  await page
    .getByLabel("워크플로우 JSON", { exact: true })
    .fill(JSON.stringify(definition));
  await page
    .getByRole("button", { name: "초안으로 가져오기", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("초안으로 저장했습니다");
  await page.reload();
  await page
    .locator("aside nav")
    .getByRole("button", { name: "워크플로", exact: true })
    .click();
  await page
    .locator(".studio-library-item")
    .filter({ hasText: "함께 만든 흐름" })
    .click();
  await page
    .getByRole("button", { name: "검토하고 발행", exact: true })
    .click();
  await page
    .getByRole("button", { name: "흐름 둘러보기", exact: true })
    .click();
  await page
    .locator(".gallery-card")
    .filter({ hasText: "함께 만든 흐름" })
    .getByRole("button", { name: "살펴보고 선택" })
    .click();
  await page
    .getByRole("button", { name: "복제해서 만들기", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("독립된 ID");
  await expect(page.getByLabel("워크플로 이름", { exact: true })).toHaveValue(
    "함께 만든 흐름 · 우리 팀",
  );
  await page
    .getByRole("button", { name: "검토하고 발행", exact: true })
    .click();
  await page
    .getByRole("button", { name: "흐름 둘러보기", exact: true })
    .click();
  await expect(
    page.locator(".gallery-card").filter({ hasText: "함께 만든 흐름" }),
  ).toHaveCount(2);
});

test("new project choices hide old workflow versions", async ({ page }) => {
  await openGallery(page);
  await page
    .locator("aside nav")
    .getByRole("button", { name: "프로젝트", exact: true })
    .click();
  await page
    .getByRole("button", { name: "프로젝트 추가", exact: true })
    .first()
    .click();
  await page
    .getByRole("combobox", { name: "프로젝트 워크플로우", exact: true })
    .click();
  await expect(
    page.getByRole("option", {
      name: "Intent · 의도 기반 개발 · v2.0.1",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /메모에서 구현까지/ }),
  ).toHaveCount(0);
});

test("gallery controls fit a narrow desktop window", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 });
  await openGallery(page);
  const bounds = await page
    .locator(".studio-main")
    .evaluate((element) => ({
      width: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
  await expect(page.getByLabel("이름이나 용도로 검색")).toBeInViewport();
});
