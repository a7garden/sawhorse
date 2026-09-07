import { expect, test } from "@playwright/test";

test("intent-first creation, refinement, persistence and immutable publishing", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await page
    .locator("aside nav")
    .getByRole("button", { name: "워크플로", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "초안 만들어 줘", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("워크플로 캔버스")).toHaveCount(0);
  await page.getByRole("button", { name: /기능 개발 요청 정리/ }).click();
  await expect(page.getByLabel("에이전트에게 맡기고 싶은 일")).toContainText(
    "기능 요청",
  );
  await page
    .getByRole("button", { name: "초안 만들어 줘", exact: true })
    .click();
  await expect(
    page.getByText("내가 확인할 순간", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("체험용 예시 초안");
  await page
    .getByLabel("워크플로 이름", { exact: true })
    .fill("검증용 워크플로");
  await page.getByRole("button", { name: "초안 저장", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("초안을 저장했습니다");
  await page
    .getByRole("button", { name: "검토하고 발행", exact: true })
    .click();
  await expect(
    page.locator(".studio-library-item").filter({ hasText: "검증용 워크플로" }),
  ).toHaveCount(2);
  await page
    .getByLabel("이 흐름에서 바꾸고 싶은 점")
    .fill("검토 기준에 접근성을 포함해 줘.");
  await page
    .getByRole("button", { name: "변경 요청하기", exact: true })
    .click();
  await expect(page.locator(".studio-description")).toContainText("접근성");
  await page
    .getByRole("button", { name: "검토하고 발행", exact: true })
    .click();
  await page.getByText("이전 버전", { exact: true }).click();
  await expect(page.getByRole("button", { name: /v1.0.0/ })).toBeVisible();
  await page.reload();
  await page
    .locator("aside nav")
    .getByRole("button", { name: "워크플로", exact: true })
    .click();
  await expect(
    page.locator(".studio-library-item").filter({ hasText: "검증용 워크플로" }),
  ).toHaveCount(2);
  await page
    .locator(".studio-library-item")
    .filter({ hasText: "검증용 워크플로" })
    .first()
    .click();
  await expect(page.locator(".studio-description")).toContainText("접근성");
  await page.getByRole("button", { name: "세부 편집", exact: true }).click();
  await expect(page.getByLabel("워크플로 캔버스")).toBeVisible();
  await page
    .getByRole("button", { name: "흐름 요약으로", exact: true })
    .click();
  await expect(page.getByLabel("워크플로 이름", { exact: true })).toHaveValue(
    "검증용 워크플로",
  );
});

test("generated workflow drafts survive leaving before manual save", async ({page}) => {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button",{name:"워크플로",exact:true}).click();
  await page.getByRole("button",{name:/기능 개발 요청 정리/}).click();
  await page.getByRole("button",{name:"초안 만들어 줘",exact:true}).click();
  await expect(page.getByRole("status")).toContainText("체험용 예시 초안");
  const name = await page.getByLabel("워크플로 이름",{exact:true}).inputValue();
  await page.locator("aside nav").getByRole("button",{name:"프로젝트",exact:true}).click();
  await page.reload();
  await page.locator("aside nav").getByRole("button",{name:"워크플로",exact:true}).click();
  await page.locator(".studio-library-item").filter({hasText:name}).click();
  await expect(page.getByText("내가 확인할 순간",{exact:true})).toBeVisible();
});
