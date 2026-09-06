---
name: weekly-review
description: Use when the user wants to look back on a week of logs — "주간 회고 써줘", "이번 주 정리해줘", "지난주 뭐 했지", "weekly review" — or when a scheduled workbench action asks for a review. Reads the week's 기록 notes in the sawhorse workspace and writes one review note with what happened, what is unfinished, and next week's list.
---

# 주간 회고 (weekly-review)

한 주의 기록 노트를 모아 회고 한 장을 쓴다. **기록 노트는 읽기만 한다** — 회고는 새 노트
하나이고, 원본을 요약으로 대체하지 않는다.

이 스킬은 사용자에게 중간에 질문하지 않고 끝까지 실행한 뒤 보고한다([UNATTENDED]).

## 입력

`$ARGUMENTS` 에 기준 날짜(`YYYY-MM-DD`)가 오면 그 날이 속한 주, 없으면 오늘이 속한 주.

## 설정 읽기

`~/.claude/sawhorse/config.json`

- `vaultPath` — 작업공간 루트. 비어 있으면 아무것도 쓰지 않고 안내 후 멈춘다.
- `packs.settings.starter.reviewDay` — 한 주의 끝으로 볼 요일(기본 `금`). 주의 시작은
  그 다음 날이다.
- `packs.settings.starter.archiveAfterDays` — 0 보다 크면 그보다 오래된 기록을 `보관/`
  이동 **후보로 제안만** 한다. 옮기지는 않는다.
- `packs.settings.starter.ownerName` — 있으면 회고 머리말에 쓴다.

## 절차

1. 기준 주의 시작·끝 날짜를 계산한다.
2. `<작업공간>/기록/*.md` 중 그 범위의 노트를 읽는다. 한 장도 없으면 회고를 만들지 않고
   "이번 주 기록이 없습니다"라고 보고하고 끝낸다 — 빈 회고는 볼트를 더럽힌다.
3. 각 노트에서 다음을 모은다.
   - `## 한 일` 항목 전부
   - `## 할 일` 중 **체크되지 않은** 항목
   - `## 메모` 중 다음 주에 영향이 있는 것
4. `<작업공간>/기록/회고-<주 시작날짜>.md` 를 쓴다. 이미 있으면 **덮어쓰지 않고** 본문
   끝에 `## 재작성 <시각>` 절을 붙여 새 내용을 넣는다.

   ```markdown
   ---
   type: 회고
   date: <주 시작날짜>
   range: <시작> ~ <끝>
   tags: []
   ---

   # <시작> ~ <끝> 주간 회고

   ## 한 일

   - 비슷한 항목은 묶어서 한 줄로. 날짜가 중요하면 뒤에 (MM-DD)

   ## 남은 일

   - [ ] 체크되지 않은 항목 원문 그대로

   ## 다음 주

   - 남은 일과 메모를 보고 제안하는 항목. 제안임을 알 수 있게 쓴다
   ```

5. `archiveAfterDays` 가 0 보다 크면 기준보다 오래된 기록 파일 목록을 보고에 **제안으로만**
   낸다("`보관/` 으로 옮길 후보: …"). 파일을 옮기지 않는다.
6. 마지막 보고: 읽은 기록 수, 한 일 N건, 남은 일 M건, 회고 노트 경로.

## 금지사항

| 금지 | 이유 |
|---|---|
| 기록 노트 수정·삭제 | 회고는 파생물이다. 원본이 정본이어야 다시 볼 수 있다 |
| 기존 회고 노트 덮어쓰기 | 다시 돌려도 이전 회고가 남아야 한다 — 절을 덧붙인다 |
| 남은 일 문장 다듬기 | 원문 그대로 옮겨야 다음 주에 같은 일로 알아본다 |
| 기록 파일 자동 이동·삭제 | 보관은 사람이 정한다. 스킬은 후보만 제안한다 |
| 기록이 없을 때 회고 생성 | 빈 노트가 쌓이면 목록이 거짓말을 한다 |
