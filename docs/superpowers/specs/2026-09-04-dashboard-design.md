# sawhorse 운영 대시보드 설계 (Tauri 데스크톱 앱)

날짜: 2026-09-04. 상태: 승인됨(사용자 위임 — "알아서 끝내둬").

## 목적

sawhorse 플러그인의 운반반(ops) 데스크톱 앱. 볼트를 열지 않고도
설정 편집 → 개선 사이클 실행/감독 → 루틴 예약 → 할 일·문서 열람을 한다.
플러그인 코드·볼트 규약은 변경하지 않는다.

## 결정된 사항 (사용자 확인)

1. 설정 정본: 기존 `~/.claude/sawhorse/config.json`(JSON) 유지. 앱은 폼 UI로 편집,
   앱 전용 키는 같은 파일의 `dashboard` 블록에 둔다(플러그인은 모르는 키 무시).
2. 위치: `sawhorse/dashboard/` 하위 폴더(같은 저장소).
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
    "launchAtLogin": false,
    "herdr": {                              // 잡을 herdr 세션으로 돌릴 때
      "mode": "auto",                       // auto | herdr | headless
      "bin": "herdr",
      "session": "",                        // 이름 있는 herdr 세션, ""=기본
      "workspaceLabel": "sawhorse",
      "cleanup": "closeOnSuccess",          // closeOnSuccess | keep | closeAlways
      "maxParallel": 1,
      "startTimeoutSec": 60,
      "jobTimeoutMin": 120,                 // 0 = 무제한
      "notify": true
    }
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

- 프롬프트: `/sawhorse:improve 설계 [IDs]`, `/sawhorse:improve 구현 [IDs]`,
  `/sawhorse:<routine>`, `/sawhorse:improve-excel --out "<excelOutputDir>/개선수정사항-체크리스트.xlsx" --prev "<직전 OUT>"`.
  `--prev` 경로는 state.json에 마지막 OUT을 기록해 이어받는다.
- cwd = 프로젝트 path(설계·구현) 또는 vaultPath(루틴·엑셀).
- 큐: 전역 FIFO 입장. 히스토리는 app-data/jobs.jsonl에 추가 기록(재시작 후에도 열람).
  같은 id의 마지막 줄만 살려 읽는다(전이 로그이므로 줄이 여러 개 쌓인다).
- 마지막 assistant 텍스트 = 리포트 → reports/<id>.md 저장, UI 뷰어로 열람.
- 원문 줄은 항상 logs/<id>.jsonl에 적는다(실행기 무관).

### 실행기 1: 백그라운드(headless)

- `claude -p "<prompt>" --output-format stream-json --verbose --permission-mode <mode>`.
  Windows는 `cmd /c claude …`.
- 동시 실행 1개(다른 잡과 슬롯을 나눠 쓰지 않는다).
- 진행: stdout 줄 단위 JSON 파싱 → `job-progress`. `{type:"assistant"}`의 text/tool_use를
  타임라인 항목으로, `{type:"result"}`를 종결로. 모르는 형식은 무시.
- 취소: 자식 프로세스 kill → Cancelled.
- 앱 종료로 잡이 죽으면 재시작 시 Interrupted 표시(improve는 건별 저장이라 중단 내성 있음).

### 실행기 2: herdr (기본, 사용 가능할 때)

목적: 잡을 **보이고 이어받을 수 있는** 세션으로 만든다. 승인 프롬프트에 사람이 답할 수 있고,
대시보드를 재시작해도 세션이 죽지 않는다.

- 레이아웃: `workspaceLabel` 워크스페이스 1개 + **잡마다 탭 1개**
  (`tab create --workspace … --cwd <job.cwd> --label <job.label> --no-focus`).
  워크스페이스 id는 state.json에 기억하고, 없으면 같은 라벨의 기존 워크스페이스를 먼저 찾아
  붙는다(재설치 때 같은 라벨이 쌓이지 않게).
- 기동: `agent start sw-<8hex> --kind claude --pane <root_pane> --timeout <startTimeoutSec>
  -- --session-id <uuid> --permission-mode <mode> "<prompt>"`.
  프롬프트를 `agent prompt`로 타이핑하지 않는 이유: 잡 프롬프트 대부분이 슬래시 커맨드라
  입력창 자동완성이 제출 Enter를 가로챌 수 있다. `--` 뒤 인자는 argv로 전달되어 셸 인용도
  필요 없다. `agent start` 실패는 치명적이지 않다 — 페인에 에이전트가 실제로 있으면 진행한다.
- 진행: 세션 UUID를 대시보드가 만들어 넘기므로 트랜스크립트 경로가 정해진다
  (`<claude config dir>/projects/*/<uuid>.jsonl`, uuid로 탐색). 그 파일을 tail 하고
  `{type:"assistant"}`를 백그라운드와 **같은 매핑 함수**로 변환한다(thinking은 건너뜀).
  트랜스크립트에는 `result` 레코드가 없으므로 종결 항목은 마지막 assistant 텍스트로 합성한다.
- 완료 판정: 1초 주기 `agent get` 폴링. 세션이 실제로 뭔가 했다는 근거(트랜스크립트 항목
  **또는** `working`/`blocked` 상태 관측)를 보기 전에는 완료로 보지 않고(기동 유예
  `startTimeoutSec`), `idle`/`done`이 3틱 연속 유지되면 성공.
  **트랜스크립트는 타임라인용이지 생사 판정용이 아니다.** Claude Code는 환경에
  `CLAUDE_CODE_CHILD_SESSION`이 있으면 기록을 아예 남기지 않는데(예: herdr 서버를 Claude Code
  세션 안에서 띄운 경우) 잡 자체는 정상 실행된다. 그래서 탭 생성 시
  `--env CLAUDE_CODE_CHILD_SESSION=`로 지우고, 그래도 기록이 없으면 잡은 성공 처리하되
  타임라인이 빈 이유를 결과 항목과 로그에 남긴다.
- 승인 대기: `blocked`은 새 JobStatus가 아니라 `Job.agentStatus`. 잡은 계속 Running이고
  herdr 알림을 띄운 뒤 사람이 답할 때까지 기다린다. `jobTimeoutMin` 초과 시 실패.
- 취소: `agent send-keys esc` → `ctrl+c`.
- 정리: `cleanup` 정책(기본 성공 시 탭 닫기, 실패·취소는 남겨 증거 보존).
- 재시작 복구: herdr 세션은 앱보다 오래 산다. 실행 중이던 herdr 잡은 `agent get`으로 확인해
  살아 있으면 감시를 재개하고, 없으면 Interrupted. herdr의 claude 통합이 설치돼 있으면
  `agent_session`으로 세션 동일성까지 확인한다.
- 실행기 선택: `mode: auto`면 herdr 서버 도달 가능 여부로 정하고, 폴백 사유를 잡 로그에 남긴다.

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
`enqueue_job(req)`, `cancel_job(id)`, `focus_job(id)`, `list_jobs()`, `job_log(id)`,
`job_report(id)`, `herdr_probe()`, `run_routine_now(name)`, `list_missed()`,
`dismiss_missed(key, run: bool)`, `set_launch_at_login(enabled)`.
`focus_job`은 herdr로 실행한 잡의 페인을 앞으로 가져온다(에이전트 → 실패 시 탭 순).
`Job`은 `runner`(headless|herdr), `agentStatus`, `sessionId`, `herdrTabId/PaneId/Agent`를
함께 싣는다 — 모두 `#[serde(default)]`라 예전 히스토리도 그대로 읽힌다.
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
stream-json·트랜스크립트 라인 파서(샘플 고정 라인), Tailer 부분 줄 버퍼링,
herdr agent 이름 규칙. 통합: fake-claude 스크립트로 백그라운드 러너 end-to-end
(이벤트 순서·취소·실패), fake-herdr 스크립트로 herdr 러너 end-to-end
(트랜스크립트 스트리밍·리포트·탭 정리·승인 대기 전이·auto 폴백·기동 실패).
프론트엔드: tsc+vite 빌드 통과. 수동: tauri dev로 홈·개선·설정 시나리오와
herdr 실행(승인 대기 응답, 앱 재시작 후 감시 재개) 확인.

## 비목표 (v1)

볼트 인박스 자동 재구성(추후 플러그인 스킬 확장 + 트리거 버튼), 동시 다중 잡,
마크다운 편집기, git push/원격 작업, FDR 외 분류 체계 변경 UI(idPrefix 편집만).
