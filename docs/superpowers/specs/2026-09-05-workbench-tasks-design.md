# 워크벤치 작업 시스템 설계 — 에이전트가 만드는 예약 실행

날짜: 2026-09-05. 상태: 검토 대기.

## 목적

터미널 에이전트(Claude Code, Codex 등)가 워크벤치에 예약 작업을 만들 수 있게 한다.
사용자가 "워크벤치에 매일 아침 X 해주는 작업 만들어줘"라고 말하면 에이전트가
작업 정의를 작성해 대시보드 승인 큐에 넣는다. Claude 데스크톱·Codex 데스크톱의
"도움 받아 작업 작성"을 에이전트 자체 생성으로 대체한다. GUI 생성과 수동
프롬프트 작성도 함께 지원한다.

## 결정된 사항 (사용자 확인)

1. 생성 채널: **파일 인박스**. 에이전트는 요청 JSON을 인박스에 쓰고, 대시보드가
   검증해 가져온다. siwb CLI·localhost HTTP는 기각.
2. 승인 정책: **에이전트 생성 요청은 전부 승인대기** → 대시보드 원클릭 승인 후
   스케줄 가동. GUI·수동 생성은 작성자가 사람이므로 게이트 없이 즉시 저장.
3. 루틴 처리: **morning/lunch/evening을 작업 모델로 통합**. 스케줄 로직 2벌 방지.

## 핵심 원칙

1. **단일 작성자** — `tasks/` 정식 파일은 대시보드 프로세스만 쓴다. 에이전트는
   인박스 쓰기 + 스토어 읽기만. 공유 체크아웃 동시 쓰기 사고(stale-hash)의
   구조적 차단.
2. **승인 게이트는 대시보드 전용** — improve 승인 철학과 동일. 에이전트가 만든
   예약은 사람이 권한을 열어야 무인 실행된다. 채팅의 "승인해줘"는 승인이 아니다.
3. **실행 유발은 대시보드만** — 인박스 op에 `run`은 없다. 에이전트는 정의만
   바꾸고, 예약·수동 실행 모두 사람 손이 닿는 지점(승인, 카드 버튼)을 지난다.

## 저장소 레이아웃

```
~/.claude/sawhorse/
  config.json                # 기존 정본. 루틴 스케줄(schedules.*)도 여기 그대로
  tasks/                     # 신규. 대시보드 소유. 플러그인은 미지 파일로 무시
    t-20260905-a1b2.json     # 작업 정의 1개 = 파일 1개 (동시 작성 충돌 없는 단위)
    archive/                 # 삭제 승인된 작업 이동 (수동 정리, 스캐빈저 없음)
    inbox/
      req-<ISO시각>-<난수>.json        # 에이전트 요청 (승인 시 소비)
      rejected/req-*.rejected.json    # 반려 요청 + { error } — 에이전트가 읽고 자기수정
```

작업 파일 스키마 (camelCase, 기존 와이어 규약):

```json
{
  "id": "t-20260905-a1b2",
  "title": "주간 이슈 정리",
  "prompt": "자기완결 무인 실행 프롬프트 본문",
  "schedule": { "kind": "daily", "time": "08:30" },
  "enabled": true,
  "builtin": false,
  "skill": null,
  "project": null,
  "source": { "kind": "agent", "agent": "claude-code", "request": "req-..." },
  "createdAt": "2026-09-05T01:33:00Z",
  "updatedAt": "2026-09-05T01:33:00Z"
}
```

- `schedule`: `{ kind: "daily"|"weekdays"|"once", time: "HH:MM", date }`.
  `once`만 `date`(YYYY-MM-DD) 필수. `null`이면 수동 작업 — "지금 실행"만.
- `skill`: builtin 전용(`sawhorse:morning` 등). 프롬프트 대신 스킬 호출.
- `project`: improve 사업 키(옵션). 잡 cwd 결정에 사용.
- `source`: 에이전트 요청으로 태어났음을 추적. GUI 생성은 `{kind:"gui"}`.

**builtin(morning/lunch/evening)은 파일이 아니라 코드 시드.** 목록 뷰에서 작업과
합쳐 보이지만 스케줄 정본은 config.json `schedules.*`(setup 스킬이 관리하던
소유권 유지). `armed` 플래그는 없다 — 인박스 항목 자체가 승인대기 상태이고,
승인 시점에 파일이 태어난다. 스토어에는 승인된 정의만 존재.

런타임 장부(`last_run`, `missed`)는 기존대로 앱 데이터 `state.json`. builtin id를
`morning/lunch/evening` 그대로 써서 기존 state.json이 무마격 이행된다.
`MissedEntry.routine`은 `task_id`+`title`로 일반화(serde alias로 구형 호환).

## 인박스 프로토콜

```json
{ "op": "create|update|pause|resume|delete",
  "agent": "claude-code",
  "note": "승인 카드에 표시될 한 줄 설명",
  "task": { },
  "id": "t-..." }
```

처리 파이프라인 (watcher.rs 디바운스 패턴 재사용):

1. watcher가 `tasks/inbox/` 감시 → `tasks-changed` emit.
2. 틱(부팅 직후 + 기존 20s 주기)이 요청 처리: **mtime 2초 안정화 + 파싱 실패
   1회 재시도**(에이전트 쓰기 도중 감시 레이스 방지) → 검증.
3. 검증: op 화이트리스트, 제목 1~80자, 프롬프트 1~20,000자, schedule 형식
   (HH:MM, once의 date 필수·과거 날짜 거부), create 외 op의 id 존재,
   **builtin(morning/lunch/evening) 대상 op 거부**(스케줄 변경은 설정 페이지),
   정규화 제목+스케줄이 동일한 활성 작업 존재 시 카드에 중복 경고(차단 아님).
4. 유효 → 승인대기 카드(TasksPage). 반려 → `rejected/`로 이동 + 사유 기록.
5. 승인 → 대시보드가 정식 파일 생성/수정(원자적 쓰기) 후 요청 소비.
   거부 → `rejected/`로 이동(사유 "사용자 거부").
6. **모든 op가 승인을 경유** — op별 예외 없음. update가 프롬프트/스케줄을
   건드리면 재승인이 자연히 일어난다. pause/resume는 승인 시 enabled 토글,
   delete는 `archive/` 이동.

반려 파일은 에이전트의 자기수정 루프를 만든다: 스킬이 "제출 후 rejected에 내
요청이 있으면 사유를 읽고 고쳐 재제출" 절차를 수행.

## 스케줄러 통합

- `ScheduledEntry` 어댑터 = `{ id, title, time, enabled, kind: builtin|task }`.
  builtin은 config.json에서, task는 파일에서. `decide()`는 순수 함수로 그대로
  재사용 — grace 2분, 미싱 자동 보상 금지, 카드 확인 후 실행 규칙 유지.
- `decide()`에 weekdays(주말 스킵)·once 분기 추가. once 실행 성공 시
  `enabled=false` 자동 전환. 부팅 시 이미 지난 once도 미싱 카드로(실행/삭제 선택).
- `ROUTINES` const → 내장 엔트리 3개로 일반화. `tick_once`는 엔트리 목록을
  순회. `run_routine_now` → `run_task_now(id)`.
- `build_job`에 `kind:"task"` arm 추가: `prompt = task.prompt` 그대로,
  `cwd = project 경로 → 볼트 폴백`(design/implement arm과 동일 규칙),
  label = 작업 제목. `JobRequest`에 `task_id` 필드 추가. builtin은 기존
  `routine` arm(스킬 호출) 유지.

## 워크벤치 스킬

플러그인 스킬 `skills/workbench/SKILL.md` 신설(12→13번째, 설계 문서 스킬 표
갱신). 배포 경로 2개, 본문은 단일 정본:

- **Claude Code**: 플러그인에 탑재 → `/sawhorse:workbench` + description
  트리거("워크벤치에 작업 만들어줘", "매일 X 돌려줘", "작업 등록"). 설치 불필요.
- **기타 에이전트**: 대시보드 설정 페이지 "워크벤치 스킬 설치" →
  `~/.claude/skills/workbench/`(Claude 개인 스킬), `~/.codex/prompts/workbench.md`
  (Codex 슬래시 프롬프트) 감지·복사. 본문은 `plugin::resolve_root()`로 플러그인
  레포에서 읽고, 없으면 앱 번들 리소스 폴백. Codex본은 프론트매터를 트리거 안내로
  바꾼 파생본.

스킬 계약:

1. 경로 결정: `~/.claude/sawhorse/` 존재 확인(기존 루틴 스킬의 결정 규칙과
   동일 계층: `${user_config.vault_path}` 아님 — 스토어 루트는 고정 경로).
2. 대화에서 제목·내용·주기 파악 → **자기완결 [UNATTENDED] 프롬프트를 직접
   작성**. 대화 맥락 의존 금지. 기존 스킬로 커버되면 prompt는
   `/sawhorse:<skill>` 실행 지시.
3. 중복 확인: `tasks/*.json` **읽기만**.
4. `tasks/inbox/req-<ISO시각>-<난수>.json` 작성(Write 도구, 파일명 유일).
5. 확인: rejected에 내 요청이 있으면 사유 읽고 재제출. 없으면 "승인대기 큐에
   넣었다"고 보고. **승인 여부를 단정하지 않는다.**
6. 금지: `tasks/*.json` 직접 생성·수정, config.json 수정, 즉시 실행 요청.

프롬프트 품질 보증은 승인 카드에서 사람이 한다 — 이것이 "도움 받기"의 대체점.

## 프론트엔드

- `src/pages/TasksPage.tsx` 신규(registry 등록, 사이드바 "작업"):
  1. **승인대기** — 요청 카드: op·note·변경 요약·중복 경고, 승인/거부 버튼.
  2. **예약 작업** — builtin+사용자 통합 표: 제목·스케줄·마지막/다음 실행·활성
     스위치·지금 실행·편집. builtin 행의 시간 편집은 기존 설정 페이지 경로 유지.
  3. **수동 작업** — schedule=null 목록.
- 생성/편집 다이얼로그: 제목, 프롬프트(마크다운 textarea), 스케줄(없음/매일/
  평일/1회+시간·날짜), 사업(옵션), 활성. GUI·수동은 즉시 저장(인박스 우회).
- **"에이전트에게 시키기"** 버튼: 폼 내용을 스킬 규격 요청 문장으로 변환해
  클립보드 복사 — GUI→에이전트 브리지.
- HomePage 루틴 카드·미싱 카드: 데이터 소스만 통합 모델로 교체(보이는 것 유지).
- JobsPage: `kind:"task"` 라벨 = 작업 제목.
- `store.ts` PageId에 `"tasks"` 추가, `types.ts`/`api.ts`에 작업 타입·호출 추가.

## 백엔드 명령·이벤트

`list_tasks`(builtin+task+pending), `save_task`, `delete_task`(인박스 delete
승인과 동일하게 `archive/` 이동), `set_task_enabled`, `run_task_now`,
`list_pending_requests`, `approve_request`, `reject_request`,
`install_skill(target)`, `skill_status` + 이벤트
`tasks-changed`. 신규 모듈 `src-tauri/src/tasks.rs`(스토어·스키마·인박스 검증),
스케줄러 일반화는 scheduler.rs 내에서.

## 오류 처리

- 잘못된 요청 → `rejected/` + 사유. 승인대기 목록에 "반려됨" 항목으로도 표시해
  사용자가 에이전트에게 고쳐달라고 전달할 수 있게.
- 대시보드 꺼짐 → 부팅 패스에서 인박스 스캔(미싱 카드와 동일 부팅 흐름).
- 파싱 레이스 → mtime 안정화 + 1회 재시도, 그래도 실패면 반려.
- tasks/ 디렉터리 없음 → 첫 접근 시 생성(기존 journal/backup 생성 관행 준수).

## 보안/정책

- 단일 작성자, 승인 게이트, run 없음 — 상기 원칙 3개가 곧 정책.
- 프롬프트 크기·제목 길이·스케줄 형식 검증은 인박스 진입점에서 1회.
- [UNATTENDED] 문구 존재는 스킬이 요구하지만 기계 강제하지 않음 — 승인 카드에서
  사람이 프롬프트를 읽는 것이 보증.

## 테스트

- Rust 단위: 인박스 검증 표(정상/각 위반/중복/mtime 레이스), 승인→파일 생성·
  수정·삭제(archive 이동) 플로우, decide() weekdays/once 분기, 기존 루틴
  시간표 회귀, 구형 state.json(MissedEntry.routine) 로드 호환, once 비활성화.
- 빌드: cargo test, tsc + vite build. 기존 54 테스트 유지.
- 스모크: 실제 인박스 파일 투입 → 승인 카드 → 승인 → 예약 목록 반영 →
  지금 실행으로 잡 생성까지 실제 앱에서 확인.

## 비목표 (v1)

- 인박스 `run` op(에이전트의 즉시 실행 요청), siwb CLI 바이너리,
  cron/interval 스케줄, 작업별 runner·permissionMode 오버라이드(전역 설정
  따름), 작업 실행 이력 전용 화면(JobsPage 재사용), rejected 자동 스캐빈저,
  에이전트별 스킬 변형 고도화(Codex본은 파생복사 수준).
