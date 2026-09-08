---
name: daily-report
description: Use when the user asks for a daily work report to send — "업무 보고 써줘", "퇴근 보고", "일일 보고", "오늘 업무 보고해줘" 같은 요청을 할 때, 퇴근 전 보고를 정리할 때 사용.
---

# daily-report — 업무 보고 작성

오늘의 세션 저널을 분석해 보고 형식 요약을 fenced 코드블록 하나로 출력한다. 일지 노트는 수정하지 않는다(노트 작성은 `/sawhorse:daily-log`). 호출: `/sawhorse:daily-report [$ARGUMENTS]`. `$ARGUMENTS`에는 세션에 남지 않은 구두 업무(회의 등)를 적는다.

## 공통 원칙

- 코드베이스는 읽기 전용으로만 다룬다. 어떤 저장소의 파일도 수정/삭제하지 않는다.
- 원격 저장소 변경 주의: `git push`, `svn commit`/`svn ci`, `git svn dcommit`, `hg push`는 불필요하면 실행하지 않는다. 로컬 `git commit`은 자유이며, 훅(block-push.mjs)이 원격 변경은 실행 전 사용자 확인을 요구한다.
- 위키 규범은 sawhorse:wiki를 준수한다. 이 스킬은 vault에 아무것도 쓰지 않으며, 출력물은 메신저·메일 등 위키 밖으로 복사하는 용도이므로 `[[위키링크]]` 표기를 쓰지 않고 일반 문구로 쓴다.

## 분석 절차 (daily-log와 공통)

1. **저널 로드** — `%USERPROFILE%\.claude\sawhorse\journal\<오늘>.jsonl`을 읽는다. `<오늘>`은 로컬 날짜 `YYYY-MM-DD`. 라인 스키마: `{"ts","session_id","cwd","transcript_path","reason"}`.
2. **session_id dedup** — 같은 session_id가 여러 줄이면 마지막 것만 유효로 삼는다.
3. **transcript 샘플링** — 유효 라인의 `transcript_path`마다 다음 규칙을 그대로 적용한다:

[SAMPLING] transcript JSONL 샘플링 규칙: (1) 전체 통독 금지. (2) 먼저 라인 수 파악. (3) `"type":"summary"` 라인과 user 발화(`message.role == "user"`이고 content가 문자열이거나 content[].type=="text")를 추출. (4) 마지막 assistant 텍스트 1-2개만 추가. (5) tool_result 본문은 읽지 않는다. 파일이 크면 앞부분 user 발화와 뒷부분 마무리를 우선.

4. **프로젝트별 재구성** — `cwd`를 기준으로 작업을 프로젝트별로 묶고, `ts` 순서(시간순)로 작업 항목을 재구성한다.
5. **$ARGUMENTS 반영** — `$ARGUMENTS`(구두 업무: 회의 등)가 있으면 분석 결과에 추가 업무로 반영한다.
6. **세션이 없는 날** — 저널 파일이 없거나 유효한 세션이 없으면 빈 결과를 보고하고, `$ARGUMENTS`만으로 보고 작성을 진행한다. `$ARGUMENTS`도 없으면 보고할 내용이 없음을 사용자에게 안내하고 종료한다.

## 출력 형식

[REPORT-FORMAT] 출력은 fenced 코드블록 하나뿐. 블록 밖에 날짜/인사/제목/설명 금지(복사→붙여넣기 그대로). 형식: `[분류]` 줄 + `- 항목` 줄들, 카테고리 사이 빈 줄 1줄. 분류는 그날 작업 내용을 보고 판단(예: [코드 분석], [문서 작성], [환경 구축]). 출력 전 자체 점검: (1) 코드블록 1개인가 (2) 첫 줄이 [분류]인가 (3) 모든 항목이 `- `로 시작하는가 (4) 카테고리 사이 빈 줄이 있는가.

예시(형식 참고용 — 이대로 출력하지 않는다):

```
[코드 분석]
- 인증 모듈 오류 원인 규명 및 수정

[문서 작성]
- A프로젝트 기능분석 문서 2건 작성
```

- 분류 이름은 그날 작업에 맞게 새로 판단한다(예: [회의], [테스트], [환경 구축]).
- 항목은 한 줄 사실 기술로 쓴다. 장식·이모지 금지.
- `$ARGUMENTS`(구두 업무: 회의 등)가 있으면 알맞은 분류의 항목으로 추가한다.
