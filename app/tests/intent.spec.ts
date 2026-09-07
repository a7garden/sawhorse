import { expect, test, type Page } from "@playwright/test";
const KEY = "sawhorse.workflow.preview.v2";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=", "base64");
async function open(page: Page) {
  await page.goto("/?preview=1");
  await page.locator("aside nav").getByRole("button", {name:"작업",exact:true}).click();
  await page.getByRole("button", {name:"새 의도",exact:true}).click();
}
async function project(page: Page) {
  await page.getByRole("dialog").getByRole("combobox",{name:"프로젝트",exact:true}).click();
  await page.getByRole("option",{name:"Sawhorse",exact:true}).click();
}
async function design(page: Page) {
  await open(page); await project(page);
  await page.getByRole("dialog").getByRole("textbox").fill("# 설계 검토\n\n메모를 보존해 주세요.");
  await page.getByRole("button",{name:"메모만 저장",exact:true}).click();
  await expect(page.locator(".wb-intent-flow")).toBeVisible();
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const work = state.snapshot.work.find((w: {workflowId:string}) => w.workflowId === "intent-flow");
    for (const role of ["spec","plan"]) state.documents[`${work.id}/${role}`] = {workId:work.id,artifact:role,path:`work/${work.id}/${role}.md`,revision:role,
      markdown:role === "spec" ? "# 설계\n\n원본을 보존합니다." : "# 작업 단위\n\nUNIT-1 입력과 저장 검증"};
    localStorage.setItem(key,JSON.stringify(state));
  },KEY);
  await page.getByRole("button",{name:"문서 새로고침",exact:true}).click();
  await expect(page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true})).toBeEnabled();
}
test("note and image survive saving, editing and reopening", async ({page}) => {
  await open(page);
  await expect(page.getByLabel("작업 이름",{exact:true})).toHaveCount(0);
  const editor = page.getByRole("dialog").getByRole("textbox");
  await editor.fill("# 거친 메모\n\n**이미지**를 보고 설계해 주세요.");
  await page.getByRole("button",{name:"미리보기",exact:true}).click();
  await expect(page.locator(".wb-intent-preview strong")).toHaveText("이미지");
  await page.getByRole("button",{name:"편집",exact:true}).click();
  await expect(editor).toContainText("거친 메모");
  await page.locator('input[type="file"]').setInputFiles({name:"capture.png",mimeType:"image/png",buffer:png});
  await page.getByRole("button",{name:"메모만 저장",exact:true}).click();
  await expect(page.locator(".wb-intent-review-document img")).toHaveJSProperty("naturalWidth",1);
  await expect(page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true})).toBeDisabled();
  await page.locator(".wb-intent-flow").getByRole("button",{name:"편집",exact:true}).click();
  await expect(page.locator(".wb-intent-review-document .cm-atomic-image img")).toHaveJSProperty("naturalWidth",1);
  await page.locator(".wb-intent-review-document [contenteditable=true]").press("ControlOrMeta+End");
  await page.keyboard.insertText("\n\n추가 메모.");
  await page.locator(".wb-intent-flow").getByRole("button",{name:"저장",exact:true}).click();
  await expect(page.locator(".wb-intent-review-document")).toContainText("추가 메모.");
  await page.getByRole("dialog").getByRole("button",{name:"닫기",exact:true}).click();
  await page.reload();
  await page.locator("aside nav").getByRole("button",{name:"작업",exact:true}).click();
  await page.getByRole("button",{name:/거친 메모/}).first().click();
  await expect(page.locator(".wb-intent-review-document")).toContainText("추가 메모.");
  await expect(page.locator(".wb-intent-review-document img")).toHaveJSProperty("naturalWidth",1);
});
test("image-only intent supports removal and saving",async ({page}) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles({name:"only.png",mimeType:"image/png",buffer:png});
  const editor = page.getByRole("dialog").getByRole("textbox");
  await expect(page.locator(".wb-atomic-editor .cm-atomic-image img")).toHaveJSProperty("naturalWidth",1);
  await editor.press("ControlOrMeta+z");
  await expect(page.getByRole("button",{name:"메모만 저장",exact:true})).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles({name:"only.png",mimeType:"image/png",buffer:png});
  await page.getByRole("button",{name:"메모만 저장",exact:true}).click();
  await expect(page.locator(".wb-detail h2")).toHaveText("이미지로 남긴 의도");
  await expect(page.locator(".wb-intent-review-document img")).toHaveJSProperty("naturalWidth",1);
});
test("failed design launch preserves the note and does not duplicate it",async ({page}) => {
  await open(page); await project(page);
  await page.getByRole("dialog").getByRole("textbox").fill("실행 실패 복구");
  await page.getByRole("button",{name:"설계 요청",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("의도는 저장됐지만");
  await page.getByRole("button",{name:"설계 실행 다시 시도",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("의도는 저장됐지만");
  await expect(page.getByRole("alert")).toContainText("Herdr 연결이 필요합니다");
  await page.getByRole("button",{name:"저장된 의도 열기",exact:true}).click();
  expect(await page.evaluate((key)=>JSON.parse(localStorage.getItem(key)!).snapshot.work.filter((w:{title:string})=>w.title==="실행 실패 복구").length,KEY)).toBe(1);
});
test("approval records design before launching implementation and remains retryable",async ({page}) => {
  await design(page);
  await page.getByRole("tab",{name:"작업 단위",exact:true}).click();
  await expect(page.getByRole("tabpanel")).toContainText("UNIT-1");
  await page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("설계 승인은 기록됐지만");
  await expect(page.getByRole("button",{name:"구현 계속하기",exact:true})).toBeEnabled();
  await expect(page.getByRole("button",{name:"결과 확인·완료",exact:true})).toBeDisabled();
});
test("approval rejects a design changed since review",async ({page}) => {
  await design(page);
  await page.evaluate((key)=>{
    const state=JSON.parse(localStorage.getItem(key)!);
    const work=state.snapshot.work.find((w:{workflowId:string})=>w.workflowId==="intent-flow");
    state.documents[`${work.id}/spec`].revision="changed";
    localStorage.setItem(key,JSON.stringify(state));
  },KEY);
  await page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("design changed");
  await expect(page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true})).toBeVisible();
});


test("images are embedded at the caret, with undo/redo and portable saved order", async ({page}) => {
  await open(page);
  const editor = page.getByRole("dialog").getByRole("textbox");
  await editor.fill("before\n\nafter");
  await editor.press("ControlOrMeta+Home");
  for (let i=0; i<6; i++) await editor.press("ArrowRight");
  await page.locator('input[type="file"]').setInputFiles({name:"middle.png",mimeType:"image/png",buffer:png});
  await expect(page.locator(".wb-intent-images")).toHaveCount(0);
  await expect(page.locator(".wb-atomic-editor .cm-atomic-image img")).toHaveJSProperty("naturalWidth",1);
  await editor.press("ControlOrMeta+z");
  await expect(page.locator(".wb-atomic-editor .cm-atomic-image")).toHaveCount(0);
  await expect(editor).toContainText("before");
  await expect(editor).toContainText("after");
  await editor.press("ControlOrMeta+Shift+z");
  await expect(page.locator(".wb-atomic-editor .cm-atomic-image img")).toHaveJSProperty("naturalWidth",1);
  await page.getByRole("button",{name:"미리보기",exact:true}).click();
  await expect(page.locator(".wb-intent-preview img")).toHaveJSProperty("naturalWidth",1);
  await page.getByRole("button",{name:"메모만 저장",exact:true}).click();
  await expect(page.locator(".wb-intent-review-document img")).toHaveJSProperty("naturalWidth",1);
  const saved = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const work = state.snapshot.work.find((item:{workflowId:string}) => item.workflowId === "intent-flow");
    return state.documents[`${work.id}/intent`].markdown as string;
  },KEY);
  expect(saved.indexOf("before")).toBeLessThan(saved.indexOf("![middle.png]"));
  expect(saved.indexOf("![middle.png]")).toBeLessThan(saved.indexOf("after"));
  expect(saved).not.toContain("blob:");
});

test("deleting an embedded image does not append it again when saving", async ({page}) => {
  await open(page);
  const editor = page.getByRole("dialog").getByRole("textbox");
  await editor.fill("keep this note");
  await page.locator('input[type="file"]').setInputFiles({name:"removed.png",mimeType:"image/png",buffer:png});
  await expect(page.locator(".wb-atomic-editor .cm-atomic-image img")).toBeVisible();
  await editor.press("ControlOrMeta+z");
  await page.getByRole("button",{name:"메모만 저장",exact:true}).click();
  await expect(page.locator(".wb-intent-review-document")).toHaveText("keep this note");
  await expect(page.locator(".wb-intent-review-document img")).toHaveCount(0);
});

test("a rejected launch keeps the captured intent in intake", async ({page}) => {
  await open(page); await project(page);
  await page.getByRole("dialog").getByRole("textbox").fill("실행 접수 실패 상태");
  await page.getByRole("button",{name:"설계 요청",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("의도는 저장됐지만");
  await page.getByRole("button",{name:"저장된 의도 열기",exact:true}).click();
  await expect(page.locator(".wb-detail-title")).toContainText("접수");
  await expect(page.getByText("설계를 요청하면 AI가 설계와 작업 단위를 작성합니다.", {exact:false})).toBeVisible();
  const item = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!).snapshot.work.find((w:{title:string}) => w.title === "실행 접수 실패 상태"), KEY);
  expect(item.status).toBe("backlog");
  expect(item.decisions).toEqual([]);
});

test("review checkpoints survive later edits and cannot be used to approve", async ({page}) => {
  await design(page);
  await page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("설계 승인은 기록됐지만");
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const work = state.snapshot.work.find((w:{workflowId:string}) => w.workflowId === "intent-flow");
    state.documents[`${work.id}/spec`].markdown = "# New scope\n\nChanged after review";
    state.documents[`${work.id}/spec`].revision = "new-scope";
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.getByRole("button",{name:"문서 새로고침",exact:true}).click();
  await page.getByRole("tab",{name:"설계",exact:true}).click();
  await expect(page.getByRole("tabpanel")).toContainText("Changed after review");
  await page.getByText(/단계별 문서 기록 ·/).click();
  await page.getByRole("button",{name:/설계 검토 시점/}).click();
  await expect(page.getByRole("tabpanel")).toContainText("원본을 보존합니다");
  await expect(page.getByRole("button",{name:"구현 계속하기",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"현재 문서로 돌아가기",exact:true}).click();
  await expect(page.getByRole("tabpanel")).toContainText("Changed after review");
});

test("unsent feedback blocks approval and completion until resolved", async ({page}) => {
  await design(page);
  await page.getByLabel("에이전트에게 남길 메모",{exact:true}).fill("접근성 검증을 추가하세요");
  await expect(page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true})).toBeDisabled();
  await expect(page.getByText(/아직 전달하지 않은 메모가 있습니다/)).toBeVisible();
  await page.getByLabel("에이전트에게 남길 메모",{exact:true}).fill("");
  await page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true}).click();
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const work = state.snapshot.work.find((w:{workflowId:string}) => w.workflowId === "intent-flow");
    state.documents[`${work.id}/verification`] = {workId:work.id,artifact:"verification",path:`work/${work.id}/verification.md`,revision:"verified",markdown:"# Result\n\nUNIT-1: tests passed"};
    localStorage.setItem(key, JSON.stringify(state));
  }, KEY);
  await page.getByRole("button",{name:"문서 새로고침",exact:true}).click();
  await expect(page.getByRole("button",{name:"결과 확인·완료",exact:true})).toBeEnabled();
  await page.getByLabel("에이전트에게 남길 메모",{exact:true}).fill("모바일 결과도 필요합니다");
  await expect(page.getByRole("button",{name:"결과 확인·완료",exact:true})).toBeDisabled();
  await page.getByLabel("에이전트에게 남길 메모",{exact:true}).fill("");
  await page.getByRole("button",{name:"결과 확인·완료",exact:true}).click();
  await expect(page.locator(".wb-detail-title")).toContainText("완료");
  await page.getByText(/단계별 문서 기록 ·/).click();
  await page.getByRole("button",{name:/결과 검토 시점/}).click();
  await expect(page.getByRole("tabpanel")).toContainText("UNIT-1: tests passed");
});

test("a blocked run opens the exact execution from the intent detail", async ({page}) => {
  await design(page);
  await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key)!);
    const work = state.snapshot.work.find((w:{workflowId:string}) => w.workflowId === "intent-flow");
    const base = {workId:work.id,projectId:work.projectId,role:"planner",agent:"codex",model:"",parentRunId:null,stage:"design",workflowId:"intent-flow",workflowVersion:"1.0.0",workflowDigest:"",workflowInstanceId:null,nodeRunId:null,status:"blocked",agentName:"review-agent",paneId:null,workspaceId:null,session:"default",prompt:"Human response needed",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),error:null,agentSession:null,tabClosedAt:null,finalReport:null,resumable:false};
    state.runs = [{...base,id:"another-run",workId:"work-intent"},{...base,id:"target-run"}];
    localStorage.setItem(key,JSON.stringify(state));
  },KEY);
  await page.getByRole("dialog").getByRole("button",{name:"닫기",exact:true}).click();
  await page.getByRole("button",{name:/설계 검토/}).first().click();
  await expect(page.getByRole("button",{name:"이 실행 열기",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"설계 승인하고 구현 시작",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"이 실행 열기",exact:true}).click();
  await expect(page.locator(".wb-run-detail h2")).toHaveText("설계 검토");
  await expect(page.locator(".wb-run-detail")).toContainText("Human response needed");
});
