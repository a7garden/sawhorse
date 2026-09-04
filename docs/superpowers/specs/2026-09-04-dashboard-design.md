# si-workbench 운영 대시보드 설계 (Tauri 데스크톱 앱)

날짜: 2026-09-04. 상태: 승인됨(사용자 위임 — "알아서 끝내둬").

## 목적

si-workbench 플러그인의 운반반(ops) 데스크톱 앱. 볼트를 열지 않고도
설정 편집 → 개선 사이클 실행/감독 → 루틴 예약 → 할 일·문서 열람을 한다.
플러그인 코드·볼트 규약은 변경하지 않는다.

## 결정된 사항 (사용자 확인)

1. 설정 정본: 기존 `~/.claude/si-workbench/config.json`(JSON) 유지. 앱은 폼 UI로 편집,
   앱 전용 키는 같은 파일의 `dashboard` 블록에 둔다(플러그인은 모르는 키 무시).
2. 위치: `si-workbench/dashboard/` 하위 폴더(같은 저장소).
3. 승인: 대시보드에서도 승인 허용. 볼트 체크와 동일한 쓰기(approve/approved/status).
4. 스케줄 놓침: 자동 보상 실행 금지. 앱 내 알림 카드 → 사용자가 확인해야 실행.

## 스택

- Tauri 2 (Rust 백엔드) + React 18 + TypeScript + Vite
- Tailwind CSS v4 + shadcn 스타일 컴포넌트(셀프 벤더, Radix 불요)
- zustand(상태), lucide-react(아이콘), react-markdown + remark-gfm(뷰어)
- Rust: tokio, serde_json(preserve_order), serde_yaml, notify, uuid, chrono, dirs
- 플러그인: autostart, single-instance, opener

## 아키텍처

웹뷰는 뷰만. 모든 도메인 로직(파일 I/O, 프로세스, 스케줄)은 Rust가 소유하고
Tauri command(요청) + event(푸시)로 통신한다. 앱이 상주 프로세스(트레이)이므로
별도 데몬은 두지 않는다.

```
src-tauri/src/
  main.rs        진입점, 트레이, 플러그인 등록
  config.rs      config.json 로드/저장(모르는 키 보존), 검증
  vault.rs       개선 노트 frontmatter 스캔/승인 쓰기, 일지 할 일 파싱/토글, 볼트 트리/읽기
  jobs.rs        잡 큐(FIFO 직렬), claude 스폰, stream-json 파싱, 로그/리포트 저장
  scheduler.rs   루틴 시각 감시, 실행 등록, 놓침 판정
  watcher.rs     볼트 파일시스템 감시 → vault-changed 이벤트
  state.rs       앱 데이터 디렉터리(state.json, logs/, reports/, jobs.jsonl)
  commands.rs    Tauri command 얇은 래퍼
```

## 설정 스키마 (config.json 확장)

```json
{
  "vaultPath": "...",                       // 기존 (플러그인이 읽음)
  "improve": { "defaultProject": "...",     // 기존
    "projects": { "<사업명>": { "path", "workBranch", "portableBase", "idPrefix", "verify" } } },
  "dashboard": {                            // 앱만 읽음
    "schedules": { "morning": { "enabled": true, "time": "09:00" },
                   "lunch":   { "enabled": true, "time": "12:30" },
                   "evening": { "enabled": true, "time": "18:00" } },
    "excelOutputDir": "...",
    "claudeBin": "claude",
    "permissionMode": "bypassPermissions",  // default | acceptEdits | bypassPermissions
    "launchAtLogin": false
  }
}
```

저장 규칙: 알려진 키만 갱신하고 Value 나머지는 보존(preserve_order로 키 순서 유지).
임시 파일 쓰기 + rename 원자적 교체. 저장 전 검증: 경로 실존, 시각 형식 HH:MM,
permissionMode 열거값.

위험 명시: `bypassPermissions` 기본은 무인 실행(루틴·구현)에 필요하다. 안전망은
플러그인 자체 규칙(승인 게이트, 범위 게이트, SVN/원격 금지, 경로 한정 커밋)과
PreToolUse 훅(block-push — 비대화형 세션에서 ask는 거부로 귀결되어 push 차단)이다.

## 잡(job) 모델

종류: `design`(improve 설계), `implement`(improve 구현), `routine`(morning/lunch/evening),
`excel`(improve-excel). 요청: { kind, project?, ids?, routine? }.

- 프롬프트: `/si-workbench:improve 설계 [IDs]`, `/si-workbench:improve 구현 [IDs]`,
  `/si-workbench:<routine>`, `/si-workbench:improve-excel --out "<excelOutputDir>/개선수정사항-체크리스트.xlsx" --prev "<직전 OUT>"`.
  `--prev` 경로는 state.json에 마지막 OUT을 기록해 이어받는다.
- 실행: `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode <mode>`,
  cwd = 프로젝트 path(설계·구현) 또는 vaultPath(루틴·엑셀). Windows는 `cmd /c claude …`.
- 큐: 전역 FIFO, 동시 실행 1개. 히스토리는 app-data/jobs.jsonl에 추가 기록(재시작 후에도 열람).
- 진행: stdout 줄 단위 JSON 파싱 → `job-progress` 이벤트.
  `{type:"assistant"}`의 text/tool_use를 타임라인 항목으로, `{type:"result"}`를 종결로.
  모르는 형식은 무시하되 원문 줄은 항상 logs/<id>.jsonl에 적는다.
- 마지막 assistant 텍스트 = 리포트 → reports/<id>.md 저장, UI 뷰어로 열람.
- 취소: 프로세스 트리 kill(unix: process group, windows: taskkill /T) → Cancelled.
- 앱 종료로 잡이 죽으면 재시작 시 Interrupted 표시(improve는 건별 저장이라 중단 내성 있음).

## 볼트 접근 규칙

- 개선 노트: `사업/<사업명>/개선/*.md` (개선.md, *문제목록.md, *.base 제외).
  frontmatter만 파싱(본문은 요청 시 통째로 읽음). 승인 쓰기는
  `approve:false→true`, `approved:""→오늘`, `status:승인대기→승인` 3키만 갱신,
  본문 바이트 보존, 원자적 교체. 사전 조건 위반(status≠승인대기)이면 오류.
- 할 일: `일지/YYYY-MM-DD.md`의 `## 오늘 할 일` / `## 내일 할 일` 섹션.
  `- [ ]`/`- [x]` 줄만 항목으로. 토글은 해당 줄의 체크 문자만 치환, 추가는 섹션 끝에
  append. 파일이 없으면 최소 스켈레톤으로 생성. 나머지 줄은 절대 변경 없음([PRESERVE] 준수).
- 문서 뷰어: 볼트 트리(디렉터리 + .md) + 본문 렌더. 읽기 전용. `[[위키링크]]`·
  `![[임베드]]`는 칩/링크로 폴백 렌더. `.base`는 텍스트 미리보기.
- 감시: notify로 볼트 재귀 감시(디바운스 1초) → `vault-changed` → 목록 재조회.

## 스케줄러

20초 틱. 활성 루틴의 시각을 지나고 오늘 실행 기록이 없으면:
- 앱이 켜진 상태에서 시각을 통과 → 즉시 큐 등록(정상 예약 실행).
- 앱 시작 시점에 이미 시각이 지났으면(지연 >2분) → 자동 실행 금지,
  `schedule-missed` 이벤트 + 홈 알림 카드. 카드의 "실행"을 눌러야 큐에 등록되고
  last_run이 오늘로 기록. "건너뛰기"로 카드만 제거.
- last_run은 app-data/state.json에 루틴별 날짜로 기록.

## 화면 (사이드바 6페이지, 한국어, 미니멀)

1. 홈 — 루틴 3카드(예정/실행중/완료/놓침+실행버튼), 개선 요약(제안·승인대기·구현대기),
   실행 중 잡 카드(라이브 진행), 진단 배너(config/vault/claude 문제).
2. 개선 — 프로젝트 선택, 상태 필터, 문제 테이블(ID·제목·화면·중요도·상태·승인·의존),
   행 상세(설계서 마크다운 + 변경 대상 + 승인 버튼), `설계 실행`/`구현 실행`/`엑셀` 버튼,
   선택 건 큐 등록. 인박스(문제목록 신규) 건수 표시.
3. 작업 — 큐/실행중 카드 + 라이브 타임라인, 히스토리 테이블, 리포트 뷰어, 취소.
4. 할 일 — 오늘/내일 체크리스트 토글 + 추가.
5. 문서 — 트리 + 마크다운 뷰어.
6. 설정 — 위 스키마 전체 폼 + 진단 결과 표 + 자동 시작 스위치.

## Tauri command / event 계약

commands: `get_config`, `save_config(patch)`, `diagnostics()`,
`list_improvements(project?)`, `read_note(path)`, `approve_note(path)`,
`list_inbox_count(project)`, `list_todos()`, `toggle_todo(section, index, checked)`,
`add_todo(section, text)`, `list_vault_tree()`, `read_vault_note(rel)`,
`enqueue_job(req)`, `cancel_job(id)`, `list_jobs()`, `job_log(id)`, `job_report(id)`,
`run_routine_now(name)`, `list_missed()`, `dismiss_missed(key, run: bool)`,
`set_launch_at_login(enabled)`.
events: `job-progress {job_id, entry}`, `job-finished {job}`, `vault-changed {areas}`,
`schedule-missed {missed}`.

## 오류 처리

config 부재 → 홈에 설정 유도 배너(볼트 경로만 입력해도 시작 가능).
claude CLI 부재 → 진단 카드(버전 확인 실패 표시). vault 무효 → 배너 + 설정 이동.
프로세스 스폰 실패/비정상 종료 → 잡 Failed(로그 보존). frontmatter 쓰기 실패 시
원본 훼손 없음(임시파일+rename).

## 테스트

Rust 단위: config 병합(모르는 키·키 순서 보존), frontmatter 승인 쓰기(바이트 보존·
사전조건·멱등), 할 일 파싱/토글/추가, 스케줄러 판정(정상/놓침/이미실행),
stream-json 라인 파서(샘플 고정 라인). 통합: fake-claude 스크립트로 잡 러너
end-to-end(이벤트 순서·취소·실패). 프론트엔드: tsc+vite 빌드 통과.
수동: tauri dev로 홈·개선·설정 시나리오 확인.

## 비목표 (v1)

볼트 인박스 자동 재구성(추후 플러그인 스킬 확장 + 트리거 버튼), 동시 다중 잡,
마크다운 편집기, git push/원격 작업, FDR 외 분류 체계 변경 UI(idPrefix 편집만).
