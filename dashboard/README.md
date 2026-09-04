# si-workbench 대시보드

si-workbench 플러그인의 운영 대시보드(Tauri 2 데스크톱 앱). 볼트를 열지 않고
설정 편집 → 개선 사이클 실행·감독 → 루틴 예약 → 할 일·문서 열람을 한다.

## 역할

| 화면 | 하는 일 |
|---|---|
| 홈 | 루틴 상태 카드, 놓친 예약 알림(자동 보상 실행 없음 — 확인 후 실행), 개선 요약, 진단 배너 |
| 개선 | 문제 테이블(frontmatter 정본), 설계서 읽기, 승인(approve/approved/status 3키 갱신), 설계·구현·엑셀 실행 |
| 작업 | claude 백그라운드 실행 큐, stream-json 실시간 타임라인, 리포트·로그 열람, 취소 |
| 할 일 | 일지 `오늘/내일 할 일` 체크 토글·추가 (나머지 줄 불변) |
| 문서 | 볼트 트리 + 마크다운 읽기 전용 뷰어 |
| 설정 | config.json 폼 편집(볼트·사업·스케줄·실행 옵션), 진단, 로그인 시 자동 시작 |

## 설정 정본

`~/.claude/si-workbench/config.json` — 플러그인(setup·improve 스킬, improve-xlsx.mjs)과
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
si-workbench 플러그인이 설치되어 있을 것(작업 실행은 `claude -p`를 호출한다).

## 설계 결정 (요약)

- 백엔드가 모든 도메인 로직 소유(Rust), 웹뷰는 뷰만. command + event로 통신.
- 잡은 전역 FIFO 직렬 1개. 진행은 `--output-format stream-json` 파싱 → 실시간 이벤트.
- 승인 게이트: 대시보드 체크도 "사람이 직접 누름"으로 취급하며, 볼트 체크와 동일한
  frontmatter 쓰기(approve/approved/status)를 한다. `### 변경 대상`이 없는 설계는 승인 거부.
- 스케줄 놓침은 자동 보상 실행하지 않고 앱 내 알림 카드로 확인 후 실행.
- 창을 닫아도 트레이로 상주(스케줄 유지). 종료는 트레이 메뉴에서.
- `permissionMode` 기본값 `bypassPermissions` — 무인 루틴/구현에 필요. 안전망은
  플러그인 자체 규칙(승인 게이트·범위 게이트·SVN/원격 금지·경로 한정 커밋)과
  block-push 훅(비대화형에서 ask는 거부로 귀결)이다. 설정에서 `acceptEdits` 등으로 완화 가능.

## 구조

```
dashboard/
  src/          React (pages 6 + lib 계약 레이어 + ui 프리미티브)
  src-tauri/    Rust (config vault jobs scheduler watcher state commands)
```

설계 문서: `docs/superpowers/specs/2026-09-04-dashboard-design.md`
