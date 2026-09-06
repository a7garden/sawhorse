# sawhorse 워크벤치 (Tauri 2 데스크톱 앱)

제품 본체이자 호스트. 작업공간을 만들고, 확장을 관리하고, 에이전트에 스킬을 설치하고,
잡을 herdr 세션 또는 백그라운드에서 돌린다.

## 역할

| 화면 | 하는 일 | 출처 |
|---|---|---|
| 홈 | 예약 카드(놓친 예약 알림 — 자동 보상 실행 없음), 오늘 할 일, 실행 중 잡, 진단 배너 | 호스트 |
| 작업 | 실행 큐(herdr 세션 또는 백그라운드), 실시간 타임라인, 승인 대기 표시, 리포트·로그, 취소 | 호스트 |
| 터미널 | herdr 워크스페이스·탭·에이전트 트리, 승인 대기 세션, 새 탭, 액션 실행 | 호스트 |
| 확장 | 팩 켜기/끄기, 에이전트 설치 상태와 설치/제거, 팩 설정 폼, SKILL.md 뷰어, 작업공간 반영 | 호스트 |
| 설정 | config.json 폼 편집(작업공간·사업·예약·실행 옵션·herdr), 진단, 로그인 시 자동 시작 | 호스트 |
| 이슈·할 일·문서·볼트 | 노트 워크플로 (네이티브 화면) | SI 확장 |
| 마일스톤·개념 / 기록·노트 | 선언형 뷰 (`PackViewPage` 하나가 렌더) | SI / starter 확장 |

사이드바는 고정 목록이 아니라 **레지스트리에서 만들어진다**: 코어 3 → 팩 기여 → 코어 2.
팩을 끄면 그 화면이 사라진다.

## 설정 정본

`~/.claude/sawhorse/config.json` — 플러그인(setup·issues 스킬, improve-xlsx.mjs)과
같은 파일. 앱 전용 키는 `dashboard`·`packs` 블록에 들어가고 플러그인은 모르는 키를
무시한다. 앱은 알려진 키만 병합하고 나머지(키 순서 포함)를 보존한다.

## 실행 방법

```bash
npm install
npm run dev          # 프론트만 (Tauri 커맨드는 없음 — 타입/레이아웃 확인용)
npm run build        # tsc --noEmit + vite build
npm run tauri dev    # 앱 실행
npm run tauri build  # 배포 번들
```

```bash
cd src-tauri && cargo test    # 86 테스트
```

요구사항: Rust 도구체인, Node 18+. 액션을 실제로 돌리려면 Claude Code CLI 가 필요하고,
herdr 실행을 쓰려면 [herdr](https://herdr.dev) 서버가 떠 있어야 한다(없으면 백그라운드 폴백).

## 구조

```
src/          React
  App.tsx       레지스트리 기반 사이드바 + 라우팅
  pages/        HomePage JobsPage TerminalPage PacksPage PackViewPage SettingsPage
                ImprovePage TodosPage DocsPage VaultPage SetupWizard
  lib/          api(커맨드 계약) store(zustand) types icons theme markdown
src-tauri/    Rust
  packs        확장 레지스트리 — 매니페스트·활성·액션·뷰·예약 엔트리
  notes        선언형 노트 질의 엔진 (뷰의 데이터 소스)
  agents       에이전트 감지 + 스킬 설치/제거 (주종 역전의 실체)
  workspace    작업공간 프로비저닝 (에이전트 없이)
  config       config.json 로드/저장 (모르는 키 보존)
  vault        이슈 노트·할 일·트리·승인 쓰기 (SI 네이티브 화면용)
  jobs herdr transcript scheduler watcher state commands plugin
```

## 설계 결정 (요약)

- **호스트는 도메인을 모른다.** `notes.rs` 는 `status`·`사업` 같은 필드의 뜻을 모르고
  프론트매터를 그대로 싣는다. 라벨·순서·묶는 기준은 팩 매니페스트가 정한다.
- **팩은 선언만 한다.** 코드를 들고 오면 앱 버전마다 깨지고 신뢰 경계가 생긴다.
  표현력의 상한(`views[].type: notes` 하나)은 의도한 것이고, 못 하는 일은 스킬이 한다.
- **기존 파일은 덮지 않는다.** 프로비저닝도, 스킬 설치도. 내용이 다르면 `수정됨` 으로
  표시하고 남긴다 — 해시 장부를 두면 사용자가 고친 파일을 조용히 덮어쓴다.
- 백엔드가 모든 도메인 로직 소유(Rust), 웹뷰는 뷰만. command + event 로 통신.
- 잡 실행기는 둘이고 타임라인 모양은 같다.
  - **herdr** (기본, 가능할 때): 잡마다 워크스페이스에 탭을 만들고 대화형 `claude` 를
    돌린다. 세션 UUID 를 앱이 만들어 `--session-id` 로 넘기므로 트랜스크립트를 tail 해
    진행을 읽는다. 프롬프트는 입력창에 타이핑하지 않고 argv 로 넘긴다.
    성패는 herdr 에이전트 상태로 판정한다 — 트랜스크립트는 타임라인용이다.
  - **백그라운드**: `claude -p … --output-format stream-json`.
  - 잡은 FIFO 입장. 백그라운드는 1개 직렬, herdr 는 `maxParallel`(기본 1)까지.
- 승인 대기(`blocked`)는 새 잡 상태가 아니라 `Job.agentStatus` 다. 잡은 여전히 실행 중이고,
  사람이 herdr 에서 답하면 그대로 이어진다. 터미널 화면이 이걸 맨 위에 모아 보여준다.
- 승인 게이트: 대시보드 체크도 "사람이 직접 누름"으로 취급하며, 볼트 체크와 동일한
  frontmatter 쓰기(approve/approved/status)를 한다.
- 예약 놓침은 자동 보상 실행하지 않고 홈 알림 카드로 확인 후 실행. `decide()` 는 순수
  함수로 고정되어 있고, 예약 엔트리 목록만 팩에서 만들어 넣는다.
- 창을 닫아도 트레이로 상주(예약 유지). 종료는 트레이 메뉴에서.
- `permissionMode` 기본값 `bypassPermissions` — 무인 루틴에 필요. 안전망은 스킬 자체 규칙
  (승인 게이트·범위 게이트·SVN/원격 금지·경로 한정 커밋)과 block-push 훅이다.

설계 문서: [워크벤치 플랫폼](../docs/superpowers/specs/2026-09-05-workbench-platform-design.md) ·
[대시보드](../docs/superpowers/specs/2026-09-04-dashboard-design.md)
