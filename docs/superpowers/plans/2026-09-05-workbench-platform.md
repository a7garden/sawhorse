# 워크벤치 플랫폼 구현 계획 — 대시보드가 호스트가 된다

설계: [2026-09-05-workbench-platform-design.md](../specs/2026-09-05-workbench-platform-design.md)
상태: 1~7단계 구현 완료. 8단계(후속)는 남겨 둔다.

## 무엇이 바뀌었나 (한 줄)

도메인 지식이 Rust·React 에서 **팩 매니페스트**로 빠져나갔고, 앱이 에이전트를
**설치 대상으로** 다루기 시작했다.

## 1단계 — 호스트 코어 (Rust, 신규 4모듈)

| 파일 | 내용 |
|---|---|
| `packs.rs` | 매니페스트 스키마·검증, 발견(사용자 > 내장), 활성 해석, 프롬프트 렌더, cwd 해석, 예약 엔트리, 프론트 계약 |
| `notes.rs` | 선언형 질의 엔진: 폴더 글로브(1단계), 프론트매터 술어 7종, 정렬·상한, 볼트 탈출 차단 |
| `agents.rs` | Claude Code·Codex 감지/설치/제거, 바이트 비교 상태 판정, Codex 파생본 변환, 플러그인 중복 감지 |
| `workspace.rs` | 활성 팩의 폴더·시드 파일 반영(덮어쓰기 금지), 미리보기 `plan()` |

핵심 규칙 세 가지가 코드로 박혀 있다.

1. **호스트는 필드의 뜻을 모른다.** `notes.rs` 는 `status`·`사업` 을 모르고 프론트매터를
   그대로 싣는다. 알기 시작하면 다시 SI 전용 앱이 된다.
2. **기존 파일은 덮지 않는다.** 프로비저닝도, 스킬 설치도. 사용자가 고친 것은
   `수정됨` 으로 표시하고 남긴다(`--force` 는 사람이 누른다).
3. **꺼진 팩은 보이지 않는다.** `Registry::action`/`view` 가 활성 팩에서만 찾는다 —
   "끄면 사라진다"가 예약·실행까지 관통해야 참이 된다.

## 2단계 — 기존 모듈 일반화

- `config.rs`: `packs { enabled, settings }` 블록 + 전체 `schedules` 맵 노출.
  **빈 `enabled` = 전부 활성**(업그레이드 시 화면이 사라지지 않게), 예약 키는
  `<packId>.<actionId>` 이고 예전 키(`morning`)는 읽기 별칭.
- `jobs.rs`: `kind: "action"` 추가 — `{packId, actionId, params}` → 템플릿 렌더 + cwd 해석.
  기존 `design|implement|routine|excel|initVault|setup|promote` arm 은 그대로 둔다
  (`jobs.jsonl` 히스토리가 그 형식이다).
- `scheduler.rs`: 루틴 3개 하드코딩 → 팩 액션 엔트리 순회. `decide()` 순수 함수는
  **한 줄도 건드리지 않았다** — 형제 작업(에이전트가 만드는 예약)이 같은 함수에 엔트리를
  더할 예정이라 판정 규칙이 한 곳에 있어야 한다. `weekdays` 는 `due_today()` 로 앞에서 거른다.
  팩 레지스트리를 못 읽는 환경에서는 예전 루틴 3개로 떨어지는 안전망을 남겼다.
- `herdr.rs`: `snapshot()`(workspace/tab/agent 목록) + focus/close/open-shell-tab.
- `plugin.rs`: 리소스 디렉터리 루트 등록(`set_root_override`) — 번들 앱에서 팩을 찾기 위해.

## 3단계 — 팩 두 벌

- `packs/si/` — 지금 있던 전부. `templates/`·`assets/` 를 저장소 루트에서 **이 팩 안으로
  옮겼다**(`git mv`). 스킬은 플러그인 규약상 루트 `skills/` 에 남고 이름으로 참조한다.
  `init-vault`·`wiki` 스킬의 `${CLAUDE_PLUGIN_ROOT}` 경로를 함께 고쳤다.
  화면 4개는 `type: native`(기존 React 화면), 2개는 `type: notes`(선언형) — 두 방식이
  같은 레지스트리에 공존하는 것이 점진 이관의 조건이다.
- `packs/starter/` — SI 어휘 0. 자기 스킬 2개(`capture`, `weekly-review`), 템플릿 2개,
  선언형 화면 2개, 설정 스키마 4개. **네이티브 화면 없이 선다** — 이게 "SI 전용이 아니다"의
  기계적 증거다(테스트가 이 성질을 검사한다).

SI 팩은 `settings` 를 선언하지 않는다. 그 값들(`vaultPath`·`improve`·`dashboard`)은 팩
이전부터 있던 정본이라, packs.settings 로 옮기면 상태가 두 곳이 된다. 스키마 폼은
starter 가 실증한다.

## 4단계 — 프론트엔드

- `store.ts`: `PageId` 가 `view:<pack>:<view>` 를 포함. 예전 이름(`improve`·`todos`…)은
  그 화면을 가진 뷰로 자동 이동하고, 팩이 꺼져 화면이 사라졌으면 홈으로 떨어진다.
- `App.tsx`: `switch` 문 나열 → 코어 3(홈·작업·터미널) + 팩 기여 + 코어 2(확장·설정).
- `PacksPage.tsx` (신규, 확장): 팩 목록·활성 토글·에이전트 설치 상태와 설치/강제/제거·
  스키마 기반 설정 폼·기여 목록·SKILL.md 뷰어·작업공간 반영. 기존 `PluginPage` 를 흡수(삭제).
- `TerminalPage.tsx` (신규, 터미널): herdr 워크스페이스/탭/에이전트 트리, 승인 대기 강조,
  포커스·닫기·새 탭, 액션을 터미널에서 실행. herdr 부재는 오류가 아니라 안내 카드.
- `PackViewPage.tsx` (신규): 선언형 뷰 렌더러 — 표·그룹 탭·검색·노트 미리보기·행 액션.
- `SetupWizard.tsx`: 3단계 → 5단계(시작·작업공간·확장·**에이전트**·완료). 3단계가
  예전의 "플러그인 설치"다.
- `HomePage.tsx`: 루틴 카드 3개 하드코딩 → `list_schedules` 기반 카드.

## 5단계 — 계약

신규 커맨드 20개: `list_packs` `list_nav` `set_pack_enabled` `save_pack_settings`
`query_pack_view` `run_pack_action` `read_pack_skill` `list_agents` `pack_agent_status`
`install_pack_skills` `uninstall_pack_skills` `workspace_plan` `provision_workspace`
`list_schedules` `run_scheduled_now` `set_schedule` `herdr_snapshot`
`herdr_focus_workspace` `herdr_focus_pane` `herdr_close_tab` `herdr_open_tab` `open_path`.

기존 커맨드는 전부 남는다. `run_routine_now` 는 `run_scheduled_now` 의 별칭이 되어
트레이 메뉴가 그대로 동작한다.

## 6단계 — 번들

`tauri.conf.json` 의 `bundle.resources` 에 `.claude-plugin`·`packs`·`skills` 를 실었다.
번들 앱은 리소스 디렉터리를 플러그인 루트로 등록하고, 개발 실행은 마커가 없어 그냥
저장소를 찾는다 — 두 경로가 같은 코드로 해결된다.

## 7단계 — 검증

- Rust 54 → **86 테스트**. 신규: 매니페스트 검증·발견 우선순위·활성 해석·프롬프트 렌더·
  cwd 4경로·질의 술어 7종·글로브·정렬/상한·볼트 탈출·스케줄 별칭·weekdays·팩 액션 잡 요청·
  에이전트 경로/파생본/플러그인 레지스트리·프로비저닝(생성·보존·탈출·부분실패·멱등)·
  config `packs` 병합.
- **동봉 팩 자물쇠 2개**: `shipped_packs_parse`(선언한 스킬·시드 원본이 실제로 존재하는지)와
  `shipped_packs_provision_a_usable_workspace`(빈 폴더 → 실제 작업공간, 선언형 뷰가 오류
  없이 빈 결과, 재실행 멱등). 깨진 매니페스트나 사라진 템플릿은 배포 전에 걸린다.
- 프론트: `tsc --noEmit` + `vite build` 통과.
- 수동 스모크는 **하지 않았다** — 사용자의 `tauri dev` 인스턴스가 이미 떠 있고
  single-instance 플러그인이 새 인스턴스를 조용히 죽인다. 위 두 자물쇠가 마법사 2·3단계가
  하는 일을 에이전트 없이 통과시키는 것으로 대신했다.

## 8단계 — 남긴 것 (후속)

| 항목 | 왜 이번에 안 했나 |
|---|---|
| SI 네이티브 화면 4개(이슈·할 일·문서·볼트)의 선언형 이관 | 승인 게이트·할 일 토글은 선언으로 표현 못 한다. 표현력을 늘리는 설계가 먼저다 |
| `scripts/vault-hygiene.ps1` 를 SI 팩으로 이동 | 스킬 4개의 `${CLAUDE_PLUGIN_ROOT}` 경로를 함께 고쳐야 하고, 이번 변경과 섞으면 되돌리기 단위가 커진다 |
| 팩 원격 설치(URL·git) | 로컬 폴더 복사로 충분하고, 원격은 신뢰 경계 설계가 먼저다 |
| 설정 화면의 팩 설정 통합 | 지금은 확장 탭에 있다. 설정 탭 재구성(형제 작업)과 충돌한다 |
| 뷰 `kind` 확장(칸반·타임라인) | 표 하나로 어디까지 되는지 먼저 써 보고 정한다 |
