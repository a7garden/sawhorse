# sawhorse Connector SDK 계약 (1차)

대상 설계: `docs/superpowers/specs/2026-09-05-multi-agent-collaboration-design.md`
(확장 모델·실행 신뢰 단계·권한 규칙 절). 이 문서는 제3자 connector가 sawhorse에
등록되기 위해 지켜야 할 계약의 현재 구현 상태를 정의한다.

## 1. 배포 단위(bundle)

```text
<extension-id>/
  extension.json            bundle manifest (아래 스키마)
  extension.json.sig        ed25519 서명 (hex 64바이트, 신뢰 키 요구)
```

- `schemaVersion`은 `1`. `id`는 전역 유일, `[a-z0-9-]{1,40}`.
- component `type`은 `connector` | `pack`. connector의 `adapter`는
  `builtin:<name>` 또는 `wasi:<module>` 접두사만 허용된다 — 샌드박스 없는
  native binary adapter는 신뢰한 코드로 명시 표시되며 기본 설치 경로가 아니다
  (설계 658-659줄).
- 사용자 bundle이 내장 bundle과 같은 id를 가지면 개발자 모드 override 없이는
  설치가 거부된다(612-614줄).

## 2. 권한 요청(`requests`)

| 키 | 값 | 의미 |
|---|---|---|
| `repository` | read/write | 저장소 메타·컨텐츠 읽기/쓰기 |
| `issues` | read/write | 이슈 읽기/쓰기 |
| `network` | 도메인 목록 | 허용 도메인 allowlist (예: `api.github.com`) |
| `secrets` | secret ref 이름 | credential broker가 Authorization에만 사용 |

- 기본 거부. 설치 때 요청 권한과 적용 프로젝트가 사용자에게 보인다(663줄).
- 업데이트가 권한을 늘리면 재승인 전까지 해당 instance는 paused다(664줄,
  `manifest::permission_increased`).
- network 요청은 DNS 해석 결과까지 검사한다: loopback·사설·link-local·
  multicast·cloud metadata 대역 차단, 모든 redirect에서 scheme·도메인·IP 재검사,
  본문 상한 8MB(780-786줄, `broker::ssrf_guard`).

## 3. 런타임(`ExtensionContext`)

connector 코드는 다음만 받는다(666-668줄). DB 핸들·Git 경로·HTTP client·토큰은
절대 노출되지 않는다.

- `granted_domains` — 승인된 도메인 allowlist
- `capabilities` — 승인된 capability 목록(기본 거부)
- `guarded_get` / `guarded_get_authorized` — SSRF 방어가 적용된 요청.
  토큰은 broker 내부에서만 붙고 connector로 반환되지 않는다.

### capability 카탈로그(671-672줄)

| capability | 의미 |
|---|---|
| `remote_branch_push` | 특정 local commit을 remote branch로 push하는 intent |
| `pull_request_create` | PR 생성 intent (push와 별도 승인) |
| `issue_write` | issue 생성·수정·종료 |
| `secret_use` | credential broker 사용 |

`local_integrate`는 확장 capability가 아니며 Core 통합 워커만 부른다.

## 4. intent 제출(불변식 7)

connector는 `.git`·볼트 Markdown·SQLite를 직접 쓰지 않는다. 모든 변경 의도는
Core Command API로 제출하고 코어가 정책·승인·원자적 쓰기를 담당한다:

- 이슈 원격 쓰기 → `remote_operation`(prepared → sending → succeeded | uncertain →
  reconciled | failed | stale). 승인은 payload hash + 관찰 revision에 묶이며
  실행 직전 revision이 다르면 stale로 되돌린다.
- 로컬 노트 갱신 → `file_apply_wal` 절차(prepared → hash 재확인 → 임시파일 +
  atomic rename → 해시 검증 → applied).

## 5. 이벤트 구독(`subscriptions`)

구독 가능 이벤트(676-679줄): `session.created`, `agent.run.completed`,
`changeset.proposed`, `approval.requested`, `approval.resolved`,
`integration.started`, `integration.verified`, `integration.failed`,
`integration.reverted`, `issue.changed`, `article.discovered`, `article.read`,
`sync.failed`. 전달은 at-least-once이며 consumer는 `event_id`로 중복을 막는다.

## 6. views 기여

`contributes.views[].renderer`는 호스트에 사전 등록된 allowlist 값만 허용된다
(현재: `sync-status`, `reading-list`). 임의 React/HTML 주입은 없다(673-674줄).

## 7. 확인된 비목표

- 원격 CI 대체, 자동 PR 병합, 클라우드 협업 서버
- 악의적 native 실행 파일의 완전 샌드박싱(별도 process는 장애 격리일 뿐
  권한 격리가 아니다 — WASI 런타임 이후에 capability가 실제 강제된다)
