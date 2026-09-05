# si-workbench 대시보드

si-workbench 플러그인의 운영 대시보드(Tauri 2 데스크톱 앱). 볼트를 열지 않고
설정 편집 → 이슈의 설계·승인·실행 감독 → 루틴 예약 → 할 일·문서 열람을 한다.

## 역할

| 화면 | 하는 일 |
|---|---|
| 홈 | 루틴 상태 카드, 놓친 예약 알림(자동 보상 실행 없음 — 확인 후 실행), 이슈 요약, 진단 배너 |
| 이슈 | 이슈 테이블(frontmatter 정본), 설계서 읽기, 승인(approve/approved/status 3키 갱신), 설계·실행·엑셀 실행 |
| 작업 | 실행 큐(herdr 세션 또는 백그라운드), 실시간 타임라인, 승인 대기 표시, herdr 세션 열기, 리포트·로그 열람, 취소 |
| 할 일 | 일지 `오늘/내일 할 일` 체크 토글·추가 (나머지 줄 불변) |
| 문서 | 볼트 트리 + 마크다운 읽기 전용 뷰어 |
| 플러그인 | 플러그인 메타데이터(버전·설명·키워드), GitHub 링크, 스킬 목록과 SKILL.md 전문 열람 |
| 설정 | config.json 폼 편집(볼트·사업·스케줄·실행 옵션), 진단, 로그인 시 자동 시작 |

## 설정 정본

`~/.claude/sawhorse/config.json` — 플러그인(setup·issues 스킬, improve-xlsx.mjs)과
같은 파일을 쓴다. 앱 전용 키는 `dashboard` 블록에 들어가고 플러그인은 모르는 키를
무시한다. 앱은 알려진 키만 병합하고 나머지(키 순서 포함)를 보존한다.

## 실행 방법

```bash
cd dashboard
npm install
npm run tauri dev    # 개발 실행
npm run tauri build  # 배포 번들
```

요구사항: Rust 도구체인, Node 18+, 그리고 실행 대상 기기에 Claude Code CLI와
si-workbench 플러그인이 설치되어 있을 것. herdr 실행을 쓰려면 [herdr](https://herdr.dev)가
설치되고 서버가 떠 있어야 한다(없으면 백그라운드로 자동 폴백).

## 설계 결정 (요약)

- 백엔드가 모든 도메인 로직 소유(Rust), 웹뷰는 뷰만. command + event로 통신.
- 잡 실행기는 둘이고 타임라인 모양은 같다.
  - **herdr** (기본, 가능할 때): 잡마다 `si-workbench` 워크스페이스에 탭을 만들고 그 안에서
    대화형 `claude`를 돌린다. 세션 UUID를 대시보드가 만들어 `--session-id`로 넘기므로
    트랜스크립트(`~/.claude/projects/*/<uuid>.jsonl`)를 tail 해 진행을 읽는다. 프롬프트는
    입력창에 타이핑하지 않고 claude의 위치 인자로 넘긴다(슬래시 커맨드 자동완성이 Enter를
    가로채는 것을 피한다).
    트랜스크립트는 타임라인용이고 잡의 성패는 herdr 에이전트 상태로 판정한다 — Claude Code는
    환경에 `CLAUDE_CODE_CHILD_SESSION`이 있으면 기록을 남기지 않기 때문(탭 생성 시 지우지만,
    그래도 없으면 성공 처리하고 이유를 남긴다).
  - **백그라운드**: 기존 `claude -p … --output-format stream-json`.
  - 잡은 FIFO 입장. 백그라운드는 항상 1개 직렬, herdr는 `maxParallel`(기본 1)까지 동시 실행.
- herdr 세션은 앱보다 오래 산다 → 재시작 후에도 살아 있는 세션은 「중단」이 아니라 감시를 재개한다.
- 승인 대기(`blocked`)는 새 잡 상태가 아니라 `Job.agentStatus`로 표현한다. 잡은 여전히
  실행 중이고, 사람이 herdr에서 답하면 그대로 이어진다.
- 승인 게이트: 대시보드 체크도 "사람이 직접 누름"으로 취급하며, 볼트 체크와 동일한
  frontmatter 쓰기(approve/approved/status)를 한다. `### 실행 대상`이 없는 설계는 승인 거부
  (레거시 `### 변경 대상`은 읽기 호환).
- 스케줄 놓침은 자동 보상 실행하지 않고 앱 내 알림 카드로 확인 후 실행.
- 창을 닫아도 트레이로 상주(스케줄 유지). 종료는 트레이 메뉴에서.
- `permissionMode` 기본값 `bypassPermissions` — 무인 루틴/구현에 필요. 안전망은
  플러그인 자체 규칙(승인 게이트·범위 게이트·SVN/원격 금지·경로 한정 커밋)과
  block-push 훅(비대화형에서 ask는 거부로 귀결)이다. 설정에서 `acceptEdits` 등으로 완화 가능.
  herdr 실행에서는 `default`/`acceptEdits`가 실제로 쓸 만해진다 — 승인 프롬프트가 페인에
  뜨고 대시보드가 「승인 대기」로 알려주며, 사람이 답하면 잡이 이어서 진행된다.

## 구조

```
dashboard/
  src/          React (pages 6 + lib 계약 레이어 + ui 프리미티브)
  src-tauri/    Rust (config vault jobs herdr transcript scheduler watcher state commands)
```

`herdr.rs`는 herdr CLI 래퍼(소켓 프로토콜을 직접 말하지 않는다 — 윈도우 named pipe는
herdr에게 맡긴다), `transcript.rs`는 Claude Code 세션 기록 tail + 진행 매핑이다.
어시스턴트 블록 → 타임라인 변환은 `jobs::map_assistant_content` 하나를 두 실행기가 공유한다.

설계 문서: `docs/superpowers/specs/2026-09-04-dashboard-design.md`
