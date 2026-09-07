// Optional browser demo (?preview=1&mockups=1); never used by desktop IPC.
import type { Mockup } from "./types";

export const mockupDemo: Mockup = {
  id: "mockup-demo",
  title: "작업 검토 경험 개선",
  projectId: "sawhorse",
  revision: 2,
  parentMockupId: "mockup-v1",
  issues: [
    { id: "work-intent", title: "검토할 작업을 쉽게 찾기", screenId: "tasks" },
    {
      id: "work-editor",
      title: "문서 저장 상태를 명확하게 표시",
      screenId: "editor",
    },
  ],
  screens: [
    {
      id: "tasks",
      label: "작업 목록",
      context: "프로젝트 작업의 검토 우선순위",
      baseline: ["상태가 섞인 목록에서 검토 대상을 찾아야 합니다."],
      evidence: ["브라우저 체험을 위한 예시 화면입니다."],
      proposal: [
        "검토 대기 작업을 한 번에 필터링합니다.",
        "작업마다 다음 행동을 표시합니다.",
      ],
      acceptance: ["검토 대기 필터를 누르면 해당 작업만 보입니다."],
    },
    {
      id: "editor",
      label: "문서 편집",
      context: "산출물 편집과 저장",
      baseline: ["저장 여부를 확인하려면 도구 모음을 다시 살펴봐야 합니다."],
      evidence: ["브라우저 체험을 위한 예시 화면입니다."],
      proposal: ["저장 결과를 편집 영역 가까이에 표시합니다."],
      acceptance: ["저장을 누르면 저장 완료 상태를 확인할 수 있습니다."],
    },
  ],
};

export function demoHtml(screenId: string) {
  if (!["tasks", "editor"].includes(screenId))
    throw new Error("목업에 등록되지 않은 화면입니다");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  *{box-sizing:border-box}body{margin:0;background:#f5f6f3;color:#28352e;font:16px -apple-system,BlinkMacSystemFont,sans-serif}header{padding:22px 32px;border-bottom:1px solid #dde3dc;display:flex;justify-content:space-between;gap:20px;background:white}header strong{font-size:19px}header small{color:#768277}main{max-width:1050px;margin:54px auto;padding:0 28px}h1{font-size:36px;margin:10px 0}p{color:#6f7b72;line-height:1.6}nav{display:flex;gap:6px;margin:24px 0}button{cursor:pointer;padding:10px 16px;border:1px solid #d7ded5;border-radius:7px;background:white;color:#365e4e;font:inherit}button.active,button.primary{background:#365e4e;color:white;border-color:#365e4e}article{padding:22px;border:1px solid #dde3dc;border-radius:10px;background:white;margin-top:10px;display:flex;justify-content:space-between;gap:18px;align-items:center}article strong{display:block;margin-bottom:6px}article small{color:#768277}textarea{display:block;width:100%;min-height:240px;padding:20px;font:inherit;border:1px solid #d7ded5;border-radius:10px;resize:vertical}footer{margin-top:18px;display:flex;align-items:center;gap:16px}#saved{color:#365e4e}@media(max-width:600px){header{padding:16px}header small{display:none}main{margin-top:28px;padding:0 16px}h1{font-size:27px}article{align-items:flex-start;flex-direction:column}nav{flex-wrap:wrap}button{font-size:14px}}
  </style></head><body><header><strong>sawhorse / ${screenId === "tasks" ? "작업" : "문서"}</strong><small>브라우저 체험용 예시 · Rev 2</small></header><main><small>PROJECT / SAWHORSE</small>
  ${screenId === "tasks" ? `<h1>다음 검토를 시작하세요.</h1><p>의견이 필요한 작업과 다음 행동을 함께 확인합니다.</p><nav><button id="all" class="active">전체 작업</button><button id="review">검토 대기</button></nav><article><div><strong>의도에서 시작하는 개발 흐름</strong><small>설계 검토 대기 · 수정 12분 전</small></div><button class="primary" id="open">설계 검토</button></article><article id="other"><div><strong>마크다운 라이브 편집기</strong><small>구현 진행 중 · 수정 1시간 전</small></div><button>진행 상황</button></article><p id="status" role="status"></p><script>const all=document.getElementById('all'),review=document.getElementById('review'),other=document.getElementById('other');review.onclick=()=>{other.hidden=true;other.style.display='none';review.className='active';all.className=''};all.onclick=()=>{other.hidden=false;other.style.display='flex';all.className='active';review.className=''};document.getElementById('open').onclick=()=>document.getElementById('status').textContent='검토할 설계를 선택했습니다.';</script>` : `<h1>검토 의견을 문서에 남기세요.</h1><p>변경한 내용과 저장 결과를 같은 자리에서 확인합니다.</p><textarea aria-label="예시 문서"># 검토 메모\n\n저장 버튼을 눌러 상태 변화를 확인해 보세요.</textarea><footer><button id="save" class="primary">저장</button><span id="saved" role="status">저장되지 않은 변경</span></footer><script>document.getElementById('save').onclick=()=>document.getElementById('saved').textContent='모든 변경 사항을 저장했습니다.';document.querySelector('textarea').oninput=()=>document.getElementById('saved').textContent='저장되지 않은 변경';</script>`}
  </main></body></html>`;
}
