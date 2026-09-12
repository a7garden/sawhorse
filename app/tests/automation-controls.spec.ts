import { test, expect, type Page } from "@playwright/test";

const nav = (page: Page, name: string) =>
  page.locator("aside nav").getByRole("button", { name, exact: true }).click();

async function seed(page: Page) {
  await page.addInitScript(() => {
    if (localStorage.getItem("automation-controls-seeded")) return;
    localStorage.setItem("automation-controls-seeded", "true");
    const def = {
      id: "custom-daily",
      title: "자료 정리",
      prompt: "자료를 정리합니다.",
      schedule: { kind: "daily", time: "10:00", date: null },
      enabled: true,
      builtin: false,
      skill: null,
      project: null,
      source: { kind: "gui" },
      createdAt: "2026-09-09T00:00:00Z",
      updatedAt: "2026-09-09T00:00:00Z",
    };
    localStorage.setItem(
      "sawhorse.preview-tasks",
      JSON.stringify([
        { def, lastRun: null, jobKey: "task:custom-daily" },
        {
          def: {
            ...def,
            id: "custom-manual",
            title: "직접 자료 검토",
            schedule: null,
            enabled: false,
          },
          lastRun: null,
          jobKey: "task:custom-manual",
        },
      ]),
    );
    localStorage.setItem(
      "sawhorse.preview-schedules",
      JSON.stringify([
        {
          key: "routine.morning",
          packId: "routine",
          actionId: "morning",
          label: "아침 정리",
          kind: "weekdays",
          time: "08:00",
          enabled: true,
          jobKey: "action:routine:morning",
        },
      ]),
    );
  });
  await page.goto("/?preview=1");
  await nav(page, "자동화");
}

const save = (page: Page) =>
  page
    .getByRole("dialog")
    .getByRole("button", { name: "저장", exact: true })
    .click();

test("every task has the same automatic-run switch without separate task categories", async ({
  page,
}) => {
  await seed(page);
  await expect(
    page.getByRole("region", { name: "자동 실행", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "직접 실행", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("switch")).toHaveCount(5);
  for (const title of ["자료 정리", "아침 정리"]) {
    const row = page.getByRole("article", { name: title, exact: true });
    await row.getByRole("switch", { name: `${title} 예약 활성화` }).click();
    await expect(row.getByRole("switch")).not.toBeChecked();
    await expect(row.getByText("예약 꺼짐")).toBeVisible();
    await expect(
      row.getByRole("button", { name: "지금 실행", exact: true }),
    ).toBeEnabled();
  }
  await page.reload();
  await nav(page, "자동화");
  await expect(page.getByRole("switch", { checked: false })).toHaveCount(5);
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("switch", { checked: false })).toHaveCount(2);
});

test("built-in times edit in place and preserve a paused schedule", async ({
  page,
}) => {
  await seed(page);
  const row = page.getByRole("article", { name: "아침 정리", exact: true });
  await row.getByRole("switch").click();
  await row.getByRole("button", { name: "일정 편집" }).click();
  await expect(page.getByLabel("실행 내용")).toHaveCount(0);
  await page.getByLabel("실행 시간", { exact: true }).fill("07:30");
  await save(page);
  await expect(row).toContainText("평일 07:30");
  await expect(row.getByRole("switch")).not.toBeChecked();
  await page.reload();
  await nav(page, "자동화");
  await expect(row).toContainText("평일 07:30");
  await expect(row.getByRole("switch")).not.toBeChecked();
});

test("adding and removing a schedule preserves the same task and switch", async ({
  page,
}) => {
  await seed(page);
  const row = page.getByRole("article", {
    name: "직접 자료 검토",
    exact: true,
  });
  await row.getByRole("button", { name: "예약 추가" }).click();
  await page.getByRole("combobox", { name: "실행 주기" }).click();
  await page.getByRole("option", { name: "매일", exact: true }).click();
  await save(page);
  await expect(row.getByRole("switch")).toBeChecked();
  await expect(
    page.getByRole("article", { name: "직접 자료 검토" }),
  ).toHaveCount(1);
  await row.getByRole("button", { name: "일정 편집" }).click();
  await page.getByRole("combobox", { name: "실행 주기" }).click();
  await page
    .getByRole("option", { name: "필요할 때 직접 실행", exact: true })
    .click();
  await save(page);
  await expect(row.getByRole("switch")).not.toBeChecked();
  await expect(
    page.getByRole("article", { name: "직접 자료 검토" }),
  ).toHaveCount(1);
  await expect(row).toContainText("자료를 정리합니다.");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => localStorage.setItem("sawhorse.theme", value),
      theme,
    );
    await page.reload();
    await nav(page, "자동화");
    await page.setViewportSize({ width: 900, height: 800 });
    expect(
      await page
        .locator("main")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/automation-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
});

test("a failed schedule save keeps the previous state and allows retry", async ({
  page,
}) => {
  await seed(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === "sawhorse.preview-schedules") {
        Storage.prototype.setItem = original;
        throw new Error("예약 저장 실패");
      }
      original.call(this, key, value);
    };
  });
  const row = page.getByRole("article", { name: "아침 정리", exact: true });
  await row.getByRole("switch").click();
  await expect(page.getByRole("alert")).toContainText("예약 저장 실패");
  await expect(row.getByRole("switch")).toBeChecked();
  await row.getByRole("switch").click();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a built-in manual tool can be scheduled on selected weekdays and remains one task", async ({
  page,
}) => {
  await seed(page);
  const row = page.getByRole("article", {
    name: "인박스 승격 검토",
    exact: true,
  });
  await row.getByRole("switch").click();
  await page.getByRole("combobox", { name: "실행 주기" }).click();
  await page.getByRole("option", { name: "요일 선택", exact: true }).click();
  const weekdays = page.getByRole("group", { name: "반복 요일" });
  await weekdays.getByRole("button", { name: "수", exact: true }).click();
  await weekdays.getByRole("button", { name: "금", exact: true }).click();
  await page.getByLabel("실행 시간", { exact: true }).fill("14:15");
  await save(page);
  await expect(row).toContainText("월·수·금 14:15");
  await expect(row.getByRole("switch")).toBeChecked();
  await page.reload();
  await nav(page, "자동화");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("월·수·금 14:15");
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("sawhorse.preview-tasks")!).find(
        (r: { def: { id: string } }) => r.def.id === "core.promote",
      ).def,
  );
  expect(saved.action).toEqual({ id: "core.promote", params: {} });
  await row.getByRole("button", { name: "일정 편집" }).click();
  await page.getByRole("combobox", { name: "실행 주기" }).click();
  await page.getByRole("option", { name: "필요할 때 직접 실행" }).click();
  await save(page);
  await expect(row.getByRole("switch")).not.toBeChecked();
  await expect(
    row.getByRole("button", { name: "지금 실행", exact: true }),
  ).toBeEnabled();
});

test("timeline supports dragging, moving an occurrence, one-off dates and keyboard placement", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: "주간 타임라인",
    exact: true,
  });
  await page.getByLabel("표시할 주", { exact: true }).fill("2030-01-07");
  const chip = timeline
    .getByRole("group", { name: "배치할 작업" })
    .getByRole("button", { name: "인박스 승격 검토", exact: true });
  await chip.dragTo(
    timeline.getByRole("button", { name: "2030-01-08 10:30", exact: true }),
  );
  const event = timeline.getByRole("button", {
    name: "인박스 승격 검토 2030-01-08 10:30",
    exact: true,
  });
  await expect(event).toBeVisible();
  await event.dragTo(
    timeline.getByRole("button", { name: "2030-01-10 11:00", exact: true }),
  );
  await expect(event).toHaveCount(0);
  await expect(
    timeline.getByRole("button", {
      name: "인박스 승격 검토 2030-01-10 11:00",
      exact: true,
    }),
  ).toBeVisible();
  await timeline
    .getByRole("button", { name: "해당 날짜 한 번", exact: true })
    .click();
  const manualChip = timeline
    .getByRole("group", { name: "배치할 작업" })
    .getByRole("button", { name: "직접 자료 검토", exact: true });
  await manualChip.focus();
  await page.keyboard.press("Enter");
  const slot = timeline.getByRole("button", {
    name: "2030-01-11 12:00",
    exact: true,
  });
  await slot.focus();
  await page.keyboard.press("Enter");
  await expect(
    timeline.getByRole("button", {
      name: "직접 자료 검토 2030-01-11 12:00",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "직접 자료 검토", exact: true }),
  ).toContainText("2030-01-11 12:00");
  await page.reload();
  await nav(page, "자동화");
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  await page.getByLabel("표시할 주", { exact: true }).fill("2030-01-07");
  await expect(
    timeline.getByRole("button", {
      name: "직접 자료 검토 2030-01-11 12:00",
      exact: true,
    }),
  ).toBeVisible();
  await timeline.getByRole("button", { name: "다음 주", exact: true }).click();
  await expect(
    timeline.getByRole("button", { name: /직접 자료 검토 2030-/ }),
  ).toHaveCount(0);
  await expect(
    timeline.getByRole("button", {
      name: "인박스 승격 검토 2030-01-17 11:00",
      exact: true,
    }),
  ).toHaveCount(1);
  await timeline.getByRole("button", { name: "이전 주", exact: true }).click();
  await page.screenshot({
    path: "test-results/automation-timeline.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("empty weekday selections cannot save and past one-off drops leave schedules untouched", async ({
  page,
}) => {
  await seed(page);
  const row = page.getByRole("article", {
    name: "인박스 승격 검토",
    exact: true,
  });
  await row.getByRole("switch").click();
  await page.getByRole("combobox", { name: "실행 주기" }).click();
  await page.getByRole("option", { name: "요일 선택", exact: true }).click();
  await page
    .getByRole("group", { name: "반복 요일" })
    .getByRole("button", { name: "월", exact: true })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "닫기", exact: true })
    .click();
  await expect(row.getByRole("switch")).not.toBeChecked();
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: "주간 타임라인",
    exact: true,
  });
  await page.getByLabel("표시할 주", { exact: true }).fill("2020-01-06");
  await timeline
    .getByRole("button", { name: "해당 날짜 한 번", exact: true })
    .click();
  await timeline
    .getByRole("group", { name: "배치할 작업" })
    .getByRole("button", { name: "인박스 승격 검토", exact: true })
    .click();
  await timeline
    .getByRole("button", { name: "2020-01-07 10:00", exact: true })
    .click();
  await expect(timeline.getByRole("status")).toContainText("이미 지난 일시");
  await expect(
    page.getByRole("article", { name: "인박스 승격 검토", exact: true }),
  ).toHaveCount(0);
});

test("moving a paused recurring task preserves its pause and other selected weekdays", async ({
  page,
}) => {
  await seed(page);
  await page
    .getByRole("article", { name: "자료 정리", exact: true })
    .getByRole("switch")
    .click();
  await page.getByRole("button", { name: "예약과 반복", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: "주간 타임라인",
    exact: true,
  });
  await page.getByLabel("표시할 주", { exact: true }).fill("2030-01-07");
  await timeline
    .getByRole("button", { name: "자료 정리 2030-01-07 10:00", exact: true })
    .dragTo(
      timeline.getByRole("button", { name: "2030-01-08 11:30", exact: true }),
    );
  await expect(
    page
      .getByRole("article", { name: "자료 정리", exact: true })
      .getByRole("switch"),
  ).not.toBeChecked();
  const saved = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("sawhorse.preview-tasks")!).find(
        (r: { def: { id: string } }) => r.def.id === "custom-daily",
      ).def,
  );
  expect(saved.schedule.days).toEqual([1, 2, 3, 4, 5, 6]);
  expect(saved.schedule.time).toBe("11:30");
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => localStorage.setItem("sawhorse.theme", value),
      theme,
    );
    await page.reload();
    await nav(page, "자동화");
    await page
      .getByRole("button", { name: "예약과 반복", exact: true })
      .click();
    await page.getByLabel("표시할 주", { exact: true }).fill("2030-01-07");
    await page.setViewportSize({ width: 900, height: 900 });
    expect(
      await page
        .locator("main")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/automation-timeline-${theme}.png`,
      animations: "disabled",
    });
  }
});
