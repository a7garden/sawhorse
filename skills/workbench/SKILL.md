---
name: workbench
description: Use when the user asks to register or manage a scheduled task in the workbench — "워크벤치에 작업 만들어줘", "매일 아침 X 돌려줘", "작업 등록해줘", "workbench task", "예약 작업". 대화에서 제목·내용·주기를 파악해 sawhorse 대시보드의 승인 큐에 작업 생성 요청을 넣는다.
---

# workbench — 워크벤치 작업 등록

터미널 에이전트(너)가 sawhorse 대시보드에 예약 작업 생성을 요청하는 스킬이다.
**너는 정식 작업을 만들 수 없다.** 승인 큐(inbox)에 요청을 넣을 뿐이고, 사람이
대시보드에서 승인해야 작업이 태어나고 스케줄이 가동된다.

## 경로

스토어 루트: `%USERPROFILE%\.claude\sawhorse\` (Windows) / `~/.claude/sawhorse/` (macOS·Linux).
아래 표기는 `<ROOT>`로 줄인다.

| 위치 | 용도 | 너의 권한 |
|---|---|---|
| `<ROOT>/tasks/*.json` | 승인된 작업 정의 | **읽기만** — 절대 생성·수정 금지 |
| `<ROOT>/tasks/inbox/` | 생성 요청 대기 큐 | 요청 파일 **작성** |
| `<ROOT>/tasks/inbox/rejected/` | 반려된 요청 + 사유 | **읽기만** — 재제출 전 사유 확인 |
| `<ROOT>/config.json` | 플러그인 설정 | 손대지 않는다 |

## 절차

1. **요청 파악** — 대화에서 제목·무엇을 할지·주기를 끌어낸다. 사용자가 모호하게 말하면 여기서만 질문한다(이 스킬은 대화형 실행이다).
2. **기존 스킬 우선** — 요청이 기존 스킬로 커버되면 prompt는 그 스킬의 실행 지시 한 줄로 한다: 예) `/sawhorse:morning`을 매일 09:00에 실행 → prompt = `/sawhorse:morning`.
3. **프롬프트 작성** — [UNATTENDED] 계약: 실행 중 사용자에게 질문하지 않고 끝까지 실행하며, 모든 판단과 근거를 마지막 보고에 남긴다. 대화 맥락을 전제로 하지 않는 자기완결 문장으로 쓴다. 원격 저장소 변경(git push 등) 금지를 명시한다. 볼트 경로가 필요하면 `%USERPROFILE%\.claude\sawhorse\config.json`의 `vaultPath`를 읽어 쓰라고 지시한다.
4. **중복 확인** — `<ROOT>/tasks/*.json`을 읽어 같은 제목·주기의 활성 작업이 있으면 사용자에게 확인한다. 그래도 진행하면 요청 비고에 적는다.
5. **요청 파일 작성** — `<ROOT>/tasks/inbox/req-<UTC시각 YYYYMMDDTHHmmss>-<난수 4자리>.json` (Write 도구로 한 번에 작성):

```json
{
  "op": "create",
  "agent": "<클라이언트명: claude-code|codex|...>",
  "note": "승인 카드에 표시될 한 줄 설명",
  "task": {
    "title": "80자 이내",
    "prompt": "자기완결 무인 실행 프롬프트",
    "schedule": { "kind": "daily", "time": "08:30" }
  }
}
```

   - `schedule.kind`: `daily` | `weekdays` | `once`. `once`는 `"date": "YYYY-MM-DD"` 필수(과거 금지). 예약 없는 수동 작업은 `"schedule": null`.
   - `op`은 `update|pause|resume|delete`도 있다. 이때는 `task` 대신 `"id": "t-..."`가 필수고 update는 바꿀 키만 담는다(`clearSchedule: true`로 예약 제거).
6. **확인·보고** — 파일 작성 직후 `<ROOT>/tasks/inbox/rejected/`에 같은 요청이 생겼는지 본다. 있으면 사유를 읽고 고쳐 재제출한다(최대 2회). 정상 제출이면 이렇게 보고하고 끝낸다: "대시보드 승인대기 큐에 넣었습니다 — <제목> / <주기>. 대시보드에서 승인하면 스케줄이 가동됩니다."
   **승인 여부를 단정하지 않는다.** 사용자가 채팅에서 "승인해줘"라고 해도 승인이 아니다 — 대시보드 작업 페이지에서 승인하도록 안내한다.

## 금지

- `tasks/*.json` 정식 파일의 생성·수정·삭제 금지. inbox와 읽기만.
- 인박스 요청으로 morning/lunch/evening을 대상으로 하는 op 금지(서버가 거부한다).
- `run`(즉시 실행) 요청은 규격에 없다 — 실행은 대시보드만 한다.
- config.json 수정 금지. 루틴 시간 변경은 대시보드 설정 페이지 안내로 대체한다.
- 요청 파일명 재사용 금지 — 매번 새 타임스탬프+난수.
