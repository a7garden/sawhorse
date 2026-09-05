# sawhorse 멀티에이전트 협업·확장 설계

날짜: 2026-09-05. 상태: 검토 대기.

관련 문서: [워크벤치 플랫폼 설계](2026-09-05-workbench-platform-design.md),
[워크벤치 작업 시스템](2026-09-05-workbench-tasks-design.md),
[이슈·마일스톤 모델](../../issues-milestones-design.md).

## 결정 요약

1. 에이전트는 각자 브랜치와 worktree에서 작업하고, 변경을 **불변 커밋 후보**로 제출한다.
2. 실제 병합은 개발 서버가 보고 있는 **대표 로컬 체크아웃 한 곳**에서만 직렬로 수행한다.
3. 기본 정책은 모든 후보를 사람이 대시보드에서 확인하고 승인한 뒤 병합하는 것이다.
   앱 설정에서 `required`를 `autoAfterPreflight`로 바꿀 수 있지만, 에이전트·확장 API에는 정책
   변경을 노출하지 않고 세션의 effective policy는 사람이 시작하고 명시적으로 개정한다.
4. 병합 뒤 대표 체크아웃에서 자동 검사와 수동 화면 검증을 한다. 실패하면 새 수정 후보를
   만들거나 병합 커밋을 `revert`한다. 자동 `reset --hard`는 하지 않는다.
5. 로컬 병합, 원격 push, PR 병합, 외부 이슈 수정은 서로 다른 권한과 승인 대상으로 둔다.
6. 기존 `pack`은 호스트 native 코드가 없는 업무 확장으로 유지한다. GitHub·RSS처럼 네트워크나
   비밀값이 필요한 기능은 별도의 **connector** 계층으로 추가하되, 앱에서는 둘 다 「확장」으로 보인다.
7. 코드의 정본은 Git, 업무 이슈의 정본은 로컬 Markdown, 운영 장부는 로컬 SQLite다.
   GitHub와 기사 사이트는 선택적인 외부 투영·수집 채널일 뿐 제품의 필수 기반이 아니다.

## 문제와 목표

멀티에이전트 작업은 병렬 worktree를 만들기 쉽지만, 실제 앱을 보는 개발 서버는 보통 사용자가
늘 쓰는 한 경로에서 돈다. worktree마다 서버를 다시 띄우면 포트·환경변수·로컬 데이터·로그인
상태가 갈라져 검증 비용이 너무 크다.

따라서 sawhorse는 다음 흐름을 제품의 기본값으로 삼는다.

```text
에이전트 A worktree ─┐
에이전트 B worktree ─┼─ 후보 제출 ─▶ 검토·승인 큐 ─▶ 단일 병합 큐
에이전트 C worktree ─┘                                  │
                                                         ▼
                              대표 로컬 체크아웃(개발 서버 경로)
                                           │
                                  자동 검사 + 화면 확인
                                           │
                              확정 / 수정 후보 / 변경 되돌리기
                                           │
                                  선택적 GitHub 게시·동기화
```

목표는 다음과 같다.

- 네트워크가 없어도 세션 생성, 작업, 검토, 로컬 병합, 검증, 되돌리기가 모두 된다.
- 어떤 에이전트의 어떤 커밋을 누가 승인해 어느 로컬 HEAD에 적용했는지 재현할 수 있다.
- 개발 서버 경로는 하나만 유지하고, 이 경로의 변경은 통합 워커 하나만 직렬 처리한다.
- 제3자 connector SDK 단계 이후에는 GitHub 외 이슈 서비스와 기사 사이트를 코어 변경 없이
  추가할 수 있다. MVP의 GitHub·RSS adapter는 먼저 host-owned 구현으로 제공한다.
- 외부 확장이 Git 저장소나 sawhorse 장부를 직접 변조하지 못하도록 모든 변경 의도를 코어가
  검증·승인·기록한다.

이번 설계의 비목표는 원격 CI 대체, 자동 PR 병합, 클라우드 협업 서버, 악의적인 네이티브
실행 파일의 완전한 샌드박싱이다.

## 기존 구조와의 연결

현재 sawhorse에는 이 설계를 받칠 세 가지 패턴이 이미 있다.

- `tasks.rs`: 에이전트는 파일 인박스에 요청하고, 대시보드만 정식 상태를 쓰는 **단일 작성자** 패턴
- `jobs.rs`·`herdr.rs`: 에이전트 실행과 사람이 이어받을 수 있는 장기 세션
- `packs.rs`: 호스트 native 코드 없이 설정·액션·뷰를 선언하는 업무 확장

새 협업 시스템도 같은 원칙을 따른다. 에이전트는 후보를 제출할 뿐 승인 장부와 대표
체크아웃을 직접 수정하지 않는다. `Job`은 한 번의 실행 기록이고 `ChangeSet`은 검토와 병합을
거치는 영속 변경 단위이므로 둘을 같은 모델로 합치지 않고 `agent_run.job_id`로 연결한다.

기존 SI 이슈 스킬의 단일 `workBranch` 규칙은 일반 실행에서 그대로 유지한다. 멀티에이전트
세션을 명시적으로 열었을 때만 호스트가 agent worktree와 integration branch를 관리하며, 이때
기존 `workBranch`는 통합 브랜치의 호환 입력값으로 읽는다. 즉 스킬이 임의로 branch를 바꾸는
것이 아니라 사람이 시작한 세션 안에서 호스트가 병합 권한을 새로 맡는 것이다.

멀티에이전트 모드에서는 여러 lane이 같은 외부 볼트 이슈 노트를 직접 고치지 않는다. 각 lane은
노트 변경 intent를 후보와 함께 제출하고, 검증 완료 뒤 코어가 optimistic hash와 file WAL을 거쳐
한 번만 적용한다. 기존 이슈 필드는 다음처럼 해석한다.

| 기존/신규 필드 | 멀티에이전트 세션에서의 의미 |
|---|---|
| `approve` | 이슈 설계·실행 권한. 기존 사람 승인이고 병합 승인과 별개 |
| `base` | 세션의 `target_start_sha` |
| `branch` | 대표 체크아웃의 통합 대상 branch |
| `commits` | 기존 의미 유지: agent 후보를 구성한 구현 commit |
| `integration_commits`(신규) | 통합 체크아웃에 생긴 merge commit과 후보 연결 |
| `integration_reverts`(신규) | 실패 후보를 제거한 revert commit |
| `session_id`, `candidate_ids`(신규) | 세션·후보 감사 연결 |
| `verified` | 기존 문자열 `확인|부분확인|미확인` 유지. 대표 체크아웃 검증 뒤 갱신 |

따라서 기존 issues skill에는 `session mode`가 필요하다. 이 모드에서는 agent branch가
`workBranch`와 같은지 검사하지 않고 session descriptor를 검사하며, 공유 노트를 직접 쓰는 대신
intent를 제출한다. 세션 밖의 단일 branch·경로 한정 commit·노트 갱신 동작은 바꾸지 않는다.
기존 `commits` 소비자와 `git show` 의존성 판정도 그대로 유지하고, collaboration rollback만
`integration_commits`를 사용해 `revert -m 1`한다. integration branch는 rebase하지 않으며,
isolated branch의 promotion은 승인된 merge 또는 PR 게시로 처리한다.

## 용어

| 용어 | 뜻 |
|---|---|
| 프로젝트 | 하나의 Git 저장소와 대표 로컬 체크아웃 설정 |
| 통합 체크아웃 | 개발 서버가 보고 있고 승인된 후보가 실제로 병합되는 대표 로컬 경로 |
| 세션 | 하나의 목표를 위해 여러 에이전트 실행과 후보를 묶는 단위 |
| 에이전트 레인 | 에이전트 한 명의 branch + worktree + task |
| 변경 후보(`ChangeSet`) | 검토할 `base_sha..source_sha`와 그 불변 digest |
| 통합 시도 | 후보 하나를 특정 통합 HEAD에 병합하고 검사한 기록 |
| 검증 프로필 | 통합 체크아웃에서 실행할 명령·health probe·수동 체크리스트 |
| pack | 기존의 선언형 업무 확장. 호스트 native 코드는 없지만 prompt·skill은 active content |
| connector | GitHub·RSS 등 외부 시스템을 정규화하는 권한 기반 어댑터 |

기존 제품에서 `workspace`는 볼트 의미로도 쓰이므로, Git 경로는 UI와 코드에서 반드시
`integration checkout` 또는 `integrationPath`라고 부른다.

## 세션과 에이전트 레인

세션을 만들 때 다음을 고정한다.

- 프로젝트와 통합 체크아웃 절대경로
- 통합 브랜치와 시작 HEAD
- 승인 정책의 스냅샷
- 검증 프로필
- 에이전트별 task, branch, worktree, 의존 후보

권장 브랜치 규칙은 다음과 같다.

```text
sawhorse/agent/<session-id>/<task-id>
sawhorse/repair/<session-id>/<candidate-id>
sawhorse/integration/<session-id>       # 선택적 격리 모드
```

기본 모드는 대표 체크아웃에 이미 checkout된 기존 `workBranch`를 통합 대상으로 고정하는
**direct 모드**다. 세션 중 branch를 전환하지 않으므로 개발 서버·IDE가 보는 경로와 상태가
그대로 유지된다. 세션 시작 시 사람이 path, branch, HEAD를 확인한다.

선택적 isolated 모드는 같은 대표 경로에서 세션 전용 integration branch를 한 번 checkout하고
그 branch 자체를 세션 산출물로 남긴다. 다른 target branch로 promotion하려면 그것도 새로운
병합 후보로 만들어 별도 사람 승인과 검증을 거친다. direct 모드의 `finalized`는 새 Git 변경을
만들지 않고 모든 후보가 `verified`, `reverted`, `resolved_with_repair`, `redundant`, `superseded`,
`rejected` 중 하나인지를 확인한 뒤 checkout lease를 푸는 상태다.

에이전트는 가능한 lint·typecheck·단위 테스트를 자기 worktree에서 수행하고 결과를 후보에
첨부한다. 하지만 수용 검증의 정본은 대표 체크아웃에서의 결과다. 세션 중 다음 조건이 생기면
통합 레인을 자동으로 일시정지한다.

- 통합 체크아웃에 예상하지 않은 수정·untracked 파일이 생김
- 현재 branch 또는 HEAD가 사용자의 수동 작업으로 달라짐
- 병합 충돌이나 검증 실패
- 앱 재시작 뒤 완료되지 않은 Git 트랜잭션 발견
- Git LFS·submodule·대소문자 충돌 등 안전한 자동 적용을 보장할 수 없음

현재 `jobs.rs`의 관리형 runner는 Claude에 고정돼 있고 Codex는 감지·스킬 설치만 지원한다.
세션 모델은 `AgentDriver(start, status, cancel, reattach, collect_result)` 경계를 먼저 만들되,
1단계 관리형 병렬 실행은 Claude headless/herdr lane으로 한정한다. Codex가 수동으로 후보 인박스를
제출하는 것은 가능하지만, Codex driver가 구현되기 전에는 앱이 시작·취소·재연결을 보장한다고
표시하지 않는다.

### 강제 가능한 범위

현재 에이전트는 같은 OS 사용자 권한으로 실행되고 `bypassPermissions`를 쓸 수도 있으므로,
native OS sandbox 없이 악의적인 agent가 대표 경로나 `config.json`을 직접 고치는 것까지 막을
수는 없다. MVP의 승인 게이트는 협력적인 agent의 실수와 경합을 막는 **호스트 워크플로
불변식**이다.

- agent에게는 대표 경로 merge API를 제공하지 않고 항상 전용 worktree에서 시작한다.
- 대표 checkout 변화, policy 파일 변화, 예상 HEAD 이탈을 감시해 즉시 세션을 멈춘다.
- 세션의 effective policy는 시작 때 사람이 확인한 뒤 app-owned SQLite에 versioned snapshot으로
  고정하고, 사람의 세션 정책 개정만 새 버전을 만든다.
- hook과 명령 필터는 방어층으로 쓰되 보안 경계라고 주장하지 않는다.
- 적대적 agent까지 강제 격리해야 하는 환경은 별도 clone 또는 OS/WASI sandbox driver를 요구한다.

## 변경 후보 계약

후보 제출 시 worktree는 clean이어야 하고 모든 변경이 커밋되어 있어야 한다. 승인 대상은
브랜치 이름이나 Git `patch-id`가 아니라 코어가 계산한 canonical candidate digest다.
`patch-id`는 whitespace·binary·rename·파일 mode를 정확히 식별하는 콘텐츠 해시가 아니므로
승인 identity로 사용하지 않는다.

```text
candidate_id
session_id
task_id
repository_id
base_sha
source_sha
base_tree_sha
source_tree_sha
exact change manifest(path, old/new blob oid, mode, rename relation)
dependency candidate digests or verified merge SHAs
verification_plan_hash
```

대시보드가 후보를 가져오면 `source_sha`를
`refs/sawhorse/candidates/<candidate-id>`로 붙잡아 branch가 삭제되거나 이동해도 검토한 Git
객체가 사라지지 않게 한다. 이 ref는 create-only이며 절대 다른 SHA로 갱신하지 않는다. amend,
추가 커밋, 충돌 해결은 같은 후보의 수정이 아니라 새 `candidate_id`이고, 이전 후보는
`superseded`가 된다.

에이전트는 기존 task 인박스와 같은 방식으로 다음 요청 파일만 쓴다.

```json
{
  "op": "propose",
  "sessionId": "s-20260905-a1b2",
  "taskId": "ui-shell",
  "agent": "claude-code",
  "worktree": "/local/path/to/worktree",
  "baseSha": "0123456...",
  "sourceSha": "abcdef0...",
  "summary": "세션 목록과 검토 카드를 추가",
  "checks": [
    { "name": "typecheck", "status": "passed", "logRef": "..." }
  ]
}
```

경로는 표시와 진단에만 쓰며 병합 입력으로 신뢰하지 않는다. 코어는 저장소 identity와 Git
object를 다시 확인한다. `summary`, `checks`, SHA 외의 changed path·dependency·tree 정보도
에이전트 입력을 신뢰하지 않고 재계산한다. 정식 후보 파일·DB·승인 기록은 대시보드만 쓴다.

후보 수용 전 코어는 다음을 확인한다.

- canonical repo root, worktree git-dir, git-common-dir가 등록된 repository identity와 일치
- base/source가 축약되지 않은 commit object이고 base가 source의 ancestor
- base가 현재 integration HEAD의 ancestor
- source range의 merge commit은 기본 거부하고, 허용 정책일 때만 별도 강조
- exact blob/mode manifest, binary·submodule·rename, diff 크기, 허용·금지 경로
- dependency가 단순 ID가 아니라 승인된 candidate digest 또는 verified merge SHA와 일치

같은 Git common object database의 worktree만 MVP 입력으로 받는다. 추후 격리 clone을 지원할 때는
검증된 Git bundle을 임시 namespace로 import한 뒤 동일한 검사를 적용한다.

## 승인 정책

단순 boolean 대신 다음 두 모드를 둔다.

| 값 | 동작 |
|---|---|
| `required` | 기본값. 후보마다 대시보드에서 사람 승인이 있어야 병합 큐에 들어감 |
| `autoAfterPreflight` | clean merge, 허용 경로, 정상 baseline 등 사전검사를 통과하면 정책이 자동 허가 |

검토 snapshot은 read-only merge simulation, 위험 경로 분석, baseline check를 먼저 수행한 뒤 만든다.
사람은 이 snapshot을 승인하고 자동 정책도 같은 결과를 평가한다. 실제 병합 직전에는 checkout
lock 아래에서 전부 다시 계산한다. `required` 모드에서는 현재 HEAD에 맞는 후보 하나만 승인할
수 있고, 앞 후보가 통합된 뒤 다음 후보의 snapshot을 다시 만든다.

설정은 전역 → 프로젝트 순으로 새 세션의 초기값을 계산하고, 세션 시작 때 immutable v1
snapshot을 만든다. 전역·프로젝트 설정 변경은 활성 세션을 몰래 바꾸지 않는다. 활성 세션에서
사람이 「세션 정책 변경」을 확인했을 때만 v2가 생긴다. 완화는 v2로 새로 만든 review snapshot부터,
강화는 아직 통합되지 않은 후보에 적용하고 기존 policy authorization을 무효화한다. 모든
authorization은 사용한 policy version을 기록한다. 에이전트·pack·connector가 이를 쓰는 명령은
제공하지 않는다.

```jsonc
{
  "dashboard": {
    "collaboration": {
      "localIntegrationApproval": "required",
      "verificationMode": "perChange",
      "failurePolicy": "pause",
      "integrationStrategy": "mergeCommit",
      "remoteWriteApproval": "required"
    }
  },
  "projects": {
    "p-73f0a5c8-2f88-4b39-a2f1-123456789abc": {
      "path": "/Volumes/MERCURY/PROJECTS/sawhorse",
      "integration": {
        "path": "/Volumes/MERCURY/PROJECTS/sawhorse",
        "branch": "main",
        "approval": null,
        "verifyProfile": "desktop"
      },
      "verifyProfiles": {
        "desktop": {
          "checks": [
            { "kind": "command", "cwd": "dashboard", "argv": ["npm", "run", "build"] },
            { "kind": "command", "cwd": "dashboard/src-tauri", "argv": ["cargo", "test"] },
            { "kind": "http", "url": "http://127.0.0.1:1420/" }
          ],
          "manual": ["홈이 열린다", "변경 화면의 핵심 동작을 확인한다"]
        }
      }
    }
  }
}
```

위 명령은 구조 예시다. 실제 명령은 에이전트가 후보마다 주입하지 않고 사람이 저장한 프로젝트
검증 프로필에서만 가져온다. 기존 `improve.projects.*.path`와 `verify`는 읽기 별칭으로 가져오고,
새 코어 프로젝트 설정으로 옮기는 마이그레이션을 제공한다.

새 `projects`는 top-level host-owned 정본이고 key는 표시 이름이 아니라 등록 시 생성한 안정적인
UUID 기반 `projectId`다. 이행은 다음 순서를 지킨다.

1. dual-read에서 새 projectId가 있으면 우선하고, 없으면 `improve.projects.<name>`을 legacy
   candidate로 보여 준다.
2. 사용자가 등록을 확인하면 UUID를 만들고 path, branch, verify를 새 블록으로 복사한다. 기존
   `improve.projects`는 rollback을 위해 그대로 둔다.
3. 기존 `TaskDef.project`, `Job.project`, pack의 project 이름은 unique legacy name으로 해석하고,
   새 기록은 `projectId`와 별도 display name을 쓴다. wire field 추가는 전부 serde default를 둔다.
4. `config.rs::save_patch_at`이 legacy project 객체를 다섯 필드로 재구성하며 새 값을 지우지 않도록
   top-level `projects`의 merge·preserve 로직과 설정 UI를 함께 바꾼다.
5. cutover 뒤에도 구형 job/task 조회는 유지하고, 이름이 중복되면 자동 선택하지 않는다.

기존 `verify`는 임의 shell 문자열이므로 argv 배열로 자동 분해하지 않는다. `legacyShell` check로
표시만 가져오고, 사용자가 내용을 확인해 활성화하거나 새 argv check로 변환한다.

자동 모드에서도 다음은 자동 수행하지 않는다.

- 충돌 해결
- 검증 실패 뒤 revert 또는 history rewrite
- remote push, PR merge, 외부 이슈 쓰기
- 서브모듈 포인터나 대형 바이너리 등 정책상 고위험 변경

채팅 메시지의 “승인”은 승인 신호가 아니다. 대시보드 동작만 human authorization을 만들며,
기록은 사용자, 시각, 후보 digest, 예상 통합 HEAD, 정책 버전을 담는다. 자동 모드는 이를 사람
승인으로 위장하지 않고 `AuthorizationDecision { kind: policy }`로 구분한다. merge trailer는
사람 승인과 정책 허가를 함께 포괄하는 authorization decision ID를 참조한다.

## 병합·검증 상태 머신

```text
working
  └─ propose
      ▼
review_pending ── 수정 요청 ─▶ changes_requested ─▶ working
      │
      ├─ 사람 승인 ─────────▶ approved ─────────────┐
      └─ 자동 정책 허가 ────▶ authorized_by_policy ─┤
                                                     ▼
                                                   queued
                                                     │
                                                     ▼
                                                integrating
                                             ┌───────┴────────┐
                                             ▼                ▼
                                         conflicted       integrated
                                             │                │
                                        새 후보·재승인          ▼
                                                    automated_verifying
                                                       │          │
                                                    성공          실패
                                                       ▼          ▼
                                      manual_verification_pending  verification_failed
                                             │               │        │
                                          확인 완료         수정       제거
                                             ▼               ▼        ▼
                                         verified       fix_forward  reverting ─▶ reverted
                                             ▲               │
                                             └──── repair verified ──▶ 원 후보 resolved_with_repair
```

기본값은 `perChange`다. 후보 하나를 병합하고 검증할 때까지 다음 후보를 적용하지 않아야 실패
원인이 명확하다. 나중에 `approvedBatch`를 추가할 수 있지만, 그 경우에도 배치 전체 digest를
승인에 묶고 제거는 역순으로 해야 한다.

manual checklist가 비어 있으면 자동 검사 성공 뒤 곧바로 `verified`가 된다. checklist가 있으면
`manual_verification_pending`에서 큐를 막고, 사람이 「확인 완료」를 누르는 순간에도 HEAD가
해당 merge SHA이며 index와 tracked worktree가 clean인지 다시 확인한다. 화면에서 문제를 발견해
「실패」를 누르면 `verification_failed`로 이동한다.

정상 흐름 외 상태는 `superseded`, `stale_context`, `baseline_failed`, `redundant`,
`resolved_with_repair`, `recovery_required`, `revert_conflicted`로 명시한다. repair 후보가 verified면
원래 실패 후보에 `remediated_by=<repair candidate>`를 기록하고 `resolved_with_repair`로 닫는다.
`redundant`와 해소된 terminal 상태를 제외하면 자동으로 다음 후보를 진행하지 않는다.

## 대표 체크아웃 병합 절차

통합 워커 하나가 다음 순서로 실행한다.

1. canonical repo root + worktree git-dir + git-common-dir로 만든 checkout identity의 OS lock과
   세션 lease를 얻는다. 같은 경로를 다른 project alias로 등록해도 lock을 우회할 수 없다.
2. 저장소 identity, 대표 경로, 현재 branch, 예상 HEAD, clean status를 확인한다. detached HEAD와
   `MERGE_HEAD`·`REBASE_HEAD`·`CHERRY_PICK_HEAD`·`REVERT_HEAD`가 있으면 중단한다.
3. 후보의 protected ref, source SHA, digest, 승인 상태를 다시 확인한다.
4. `required`에서는 승인 때의 integration HEAD와 현재 HEAD가 한 bit라도 다르면 새 simulation과
   diff를 만든 뒤 무조건 재승인한다. HEAD drift 허용은 ordered batch 전체 digest를 승인하는
   후속 기능으로만 둔다.
5. 현재 통합 HEAD를 기준으로 임시 index에서 merge simulation을 수행하고 `planned_tree_sha`와
   경로 겹침을 기록한다.
6. 병합 전 baseline command·health 결과와 `pre_head`를 저장한다. baseline 실패는
   `baseline_failed`로 멈추며, 계속하려면 실패 증거에 묶인 별도 사람 override가 필요하다.
7. 승인된 branch 이름이 아니라 SHA를 비대화형으로
   `git merge --no-ff --no-commit --no-verify <source_sha>`한다. MVP 통합 commit은 signing과
   repository hook을 끄고, 검사는 저장된 verify profile에서 명시적으로 실행한다.
8. 충돌이면 그 시점에만 `git merge --abort`하고 HEAD/index/worktree가 `pre_head`의 clean 상태로
   돌아왔는지 확인한다. 확인이 안 되면 `recovery_required`다.
9. 실제 `git write-tree`가 `planned_tree_sha`와 같은지 확인한 뒤 후보 하나당 merge commit 하나를
   `git commit --no-verify --no-gpg-sign`으로 만들고 `merge_sha`와 tree SHA를 기록한다. commit
   뒤에도 `HEAD^{tree}`를 다시 대조한다.
10. 같은 대표 경로에서 검증 명령과 health probe를 수행하고, 각 check 뒤 branch, HEAD, index,
    tracked worktree가 그대로인지 확인한다. check가 파일을 바꾸면 자동 commit하지 않고 멈춘다.
11. 자동 검사와 필요한 수동 확인이 모두 성공하면 `verified`, 실패하면
    `verification_failed`로 두고 다음 후보를 막는다.

파일 충돌이 없어도 `App.tsx`, route/registry, 설정 shell, dependency manifest처럼 여러 기능을
조립하는 파일은 **semantic overlap** 위험 경로로 취급한다. 두 후보가 같은 조립 지점을 바꾸면
재승인과 해당 화면의 수동 smoke를 강제한다. 실제로 한쪽 설정 화면이 다른 병렬 병합에
덮여 컴포넌트가 고아가 된 뒤에도 `tsc`가 통과한 사례처럼, build 성공만으로 통합 완전성을
판정해서는 안 된다.

병합 커밋에는 복구 가능한 trailer를 붙인다.

```text
Sawhorse-Session: s-20260905-a1b2
Sawhorse-Candidate: c-20260905-c3d4
Sawhorse-Source: abcdef012345
Sawhorse-Authorization: a-20260905-e5f6
```

`--no-ff` merge commit을 기본으로 쓰면 에이전트의 세부 커밋을 보존하면서도 후보 하나를 한
커밋으로 되돌릴 수 있다. 이미 같은 patch가 들어온 후보는 빈 merge commit을 만들지 않고
`redundant`로 끝낸다.

## 검증 실패와 복구

검증 실패 시 병합된 상태를 그대로 보여 주고 자동으로 다음 후보를 진행하지 않는다.

### 수정 계속

실패 로그와 `merge_sha`를 포함한 repair task를 만든다. repair branch는 **현재 통합 HEAD**에서
시작하고 수정 커밋을 새 후보로 제출한다. 내용이 바뀌었으므로 다시 승인한다.

### 변경 되돌리기

사람이 「변경 제거」를 누른 행위 자체를 승인으로 기록하고 다음을 실행한다.

```text
revert WAL 기록
git revert --no-commit -m 1 <merge_sha>
tree·conflict 확인
git commit --no-verify --no-gpg-sign (Sawhorse-Reverts trailer 포함)
smoke·health 확인
```

`revert_sha`를 통합 시도에 기록한다. 충돌이면 `revert_conflicted`로 멈추고 사용자가 선택하게
하며, 앱 재시작 시 `REVERT_HEAD`와 별도 WAL로 복구한다. 이미 revert한 merge의 원래 branch를
그대로 재병합하면 Git이 조상을 이미 병합된 것으로 보기 때문에, 재시도는 현재 HEAD에서 새
repair branch와 새 후보로 만든다.

기본 복구는 revert다. `reset --hard`로 로컬 기록에서 완전히 빼는 고급 기능은 MVP에서
제공하지 않는다. 나중에 제공하더라도 다음 조건을 모두 만족하고 사람이 별도 확인한 경우로
한정한다.

- 해당 merge가 현재 HEAD의 마지막 커밋
- 이후 후보와 사용자 변경이 없음
- 어떤 remote에도 도달하지 않음
- `refs/sawhorse/checkpoints/<attempt-id>` 백업 ref를 먼저 생성함

후속 후보가 실패 후보에 의존한다면 역의존 순서로 revert하거나 fix-forward만 허용한다.

## 충돌·크래시 안전성

통합 체크아웃의 사용자 변경을 자동 stash, restore, discard하지 않는다. dirty 상태나 예상하지
않은 HEAD를 발견하면 `paused`로 두고 사용자가 정리하도록 한다.

merge와 revert 모두 실제 Git 변경 전에 write-ahead 레코드를 먼저 내구성 있게 기록한다.

```json
{
  "attemptId": "ia-20260905-a1b2",
  "candidateId": "c-20260905-c3d4",
  "operation": "merge",
  "phase": "prepared",
  "preHead": "0123456...",
  "preStateDigest": "sha256:...",
  "sourceSha": "abcdef0...",
  "plannedTreeSha": "9876543...",
  "resultCommitSha": null
}
```

revert WAL은 `operation=revert`, `sourceSha=<제거할 merge SHA>`, revert simulation의
`plannedTreeSha`를 쓴다. phase와 result commit은 각 Git 단계 뒤에 fsync 가능한 transaction으로
전진시키며, 메모리 상태보다 장부를 먼저 쓴다.

앱 재시작 시 복구 규칙은 다음과 같다.

| 발견 상태 | 처리 |
|---|---|
| HEAD가 `preHead`, index/worktree clean, 다른 Git operation 없음 | 적용 전 중단으로 보고 다시 queued |
| `MERGE_HEAD` 또는 `REVERT_HEAD` 존재 | 자동 abort하지 않고 `recovery_required`; 사람 확인 |
| HEAD가 예상 merge/revert commit이고 parent·tree·trailer가 모두 일치 | 상태를 복원하고 검사 재개 |
| HEAD·index가 어느 기록과도 다름 | 자동 수정하지 않고 `recovery_required` |

merge 복원은 1번 parent=`preHead`, 2번 parent=`sourceSha`, tree=`plannedTreeSha`까지 확인한다.
해당 commit 뒤에 다른 commit이 하나라도 있으면 자동 복원하지 않는다. 앱이 죽은 뒤 사용자가
conflict를 편집했을 수 있으므로 `MERGE_HEAD`와 장부가 맞는다는 이유만으로 자동 abort하지 않는다.

통합 직전 untracked 충돌, LFS 포인터, submodule, case-only rename, 파일 모드 변경도 사전검사한다.
worktree와 protected candidate ref는 검증 완료 또는 revert까지 정리하지 않는다.

코어는 자신이 생성해 registry에 정확한 path/git-dir/branch를 기록한 worktree만 정리한다. 사용자
worktree를 대상으로 포괄적인 `git worktree prune`을 실행하지 않는다. 기본 보존 기간은 finalized
뒤 7일이며, dirty worktree·미통합 commit·복구 중인 후보는 자동 삭제하지 않는다. 후보 거부·세션
취소 때도 같은 검사를 하고, protected ref를 지우기 전에 audit/artifact 보존 여부를 확인한다.

## 로컬 저장 모델

정본을 역할별로 나눈다.

| 데이터 | 정본 |
|---|---|
| 코드·병합 이력 | 로컬 Git repository와 `refs/sawhorse/*` |
| 이슈의 배경·설계·결과 | 기존 볼트의 Markdown 이슈 노트 |
| 사용자 설정 | 기존 `~/.claude/sawhorse/config.json` |
| 세션·후보·승인·검증·동기화 장부 | 앱 전역 로컬 SQLite(WAL), 모든 행에 scope/project ID |
| 에이전트 제출 | 파일 인박스. 가져온 뒤 DB에 정규화 |
| 큰 로그·diff·응답 payload | content hash로 이름 붙인 로컬 artifact 파일 |
| 토큰·비밀값 | OS Keychain. DB에는 `secret_ref`만 저장 |

예시 레이아웃:

```text
~/.claude/sawhorse/
  config.json
  workbench.sqlite
  collab/inbox/changesets/
  projects/<project-id>/
    artifacts/<sha256>
    logs/
```

SQLite는 여러 에이전트가 직접 쓰는 공유 DB가 아니다. Tauri 코어의 단일 writer가 transaction과
outbox를 함께 보장하기 위해 사용한다. 에이전트는 계속 파일 인박스만 쓴다. 로컬 운영 데이터는
저장소에 commit하지 않는다.

DB를 프로젝트별로 나누지 않는 이유는 extension 설치·account grant·기사 source처럼 전역인
데이터와 여러 프로젝트를 잇는 outbox가 있기 때문이다. project-scoped 행에는 안정적인
`projectId` foreign key를 둔다. 중앙 `collab/inbox` 하나만 감시하므로 현재 부팅 시 watcher 한
번 등록하는 구조도 유지할 수 있다.

projectId는 path나 이름 hash가 아니라 등록 때 생성한 UUID다. 별도로 canonical repo root,
worktree git-dir, git-common-dir를 저장해 중복 등록과 checkout 이동을 진단한다. 같은 repository의
여러 checkout은 서로 다른 checkout identity가 될 수 있지만 한 integration checkout lease를
동시에 두 세션에 줄 수 없다.

현재 백엔드에는 DB와 HTTP client가 없으므로 이는 의도적인 새 기반 의존성이다. 1단계에서
SQLite migration과 백업·복원부터 검증하고, Git 명령은 기존 CLI 호출 방식처럼 argv 기반으로
감싼다. 2단계에서 host-owned connector를 넣을 때 HTTP client를 추가한다.

핵심 테이블은 다음 정도로 제한한다.

- `project`, `session`, `agent_run`
- `change_set`, `change_dependency`, `integration_attempt`, `check_run`
- `approval`, `authorization_decision`, `policy_snapshot`, `audit_event`
- `extension_install`, `permission_grant`
- `external_link`, `field_sync_base`, `sync_cursor`, `inbound_change`
- `event_outbox`, `remote_operation`, `file_apply_wal`, `dead_letter`
- `article`, `article_source`, `article_state`

내부 이벤트와 `event_outbox`는 같은 transaction에 기록한다. connector 전달은 at-least-once이고
consumer는 `event_id`로 로컬 중복 처리를 막는다. 이것이 외부 API 부작용까지 exactly-once로
만든다는 뜻은 아니다.

외부 쓰기는 별도 `remote_operation` 상태 머신(`prepared → sending → succeeded | uncertain →
reconciled | failed`)으로 관리한다. 요청 성공 뒤 응답만 유실되면 무작정 같은 create를 다시
보내지 않고, provider별 operation marker나 사후 조회로 이미 생성됐는지 reconcile한다. update는
실행 직전 remote revision을 다시 읽고 승인 때 본 값과 다르면 `stale`로 되돌린다.

SQLite와 Markdown도 하나의 transaction으로 묶이지 않는다. inbound 변경 수락은 다음 application
WAL을 거친다.

1. DB에 `expected_local_hash`, `target_hash`, target path, payload hash, `phase=prepared`를 기록한다.
2. 현재 파일 hash가 expected 값과 같은지 다시 확인한다.
3. 임시 파일을 쓰고 같은 filesystem에서 atomic rename한다.
4. 실제 파일 hash를 확인한 뒤 `field_sync_base`, `applied_revision`, `inbound_change.state`를
   갱신하고 `applied`로 끝낸다.
5. 재시작 때 expected/target/actual hash 조합으로 미적용·적용 완료·외부 충돌을 구분한다.

remote payload를 가져오는 순간에는 `inbound_change` upsert와 **poll cursor/ETag** 갱신을 한 DB
transaction에 묶어, cursor만 앞서가 변경을 잃는 경우를 막는다. poll cursor는 staging 진행도이고
사람의 수락 진행도인 applied revision과 분리한다.

## 확장 모델: pack과 connector를 분리한다

기존 `pack.json`은 유지한다. pack은 템플릿·설정 폼·프롬프트 액션·노트 뷰·스킬만 선언하고
**호스트 native 코드**를 싣지 않는다. 다만 prompt와 설치된 `SKILL.md`는 에이전트의 기존 도구
권한으로 부작용을 낼 수 있는 비신뢰 active content다. connector 권한을 상속하거나 자동으로
event subscription을 얻지 않으며, GitHub API 호출이나 HTML 스크레이퍼를 pack 본문에 넣지 않는다.

사용자에게는 모두 「확장」으로 보이되 내부적으로 두 종류다.

| 종류 | 할 수 있는 일 | 신뢰 수준 |
|---|---|---|
| workflow pack | 작업공간·설정·액션·노트 뷰·스킬 선언 | 호스트 native 코드 없음, 기존 agent 권한 |
| connector | 외부 API·feed를 정규화하고 intent 제출 | 명시적 capability 필요 |

확장은 **bundle → component → configured instance**의 3층이다.

- bundle: 설치·업데이트하는 배포 단위
- component: bundle 안의 pack 또는 connector 구현과 contribution
- instance: 사용자가 연결한 GitHub account/repository 또는 RSS feed 묶음

권한 grant, secret ref, sync cursor, outbox scope는 bundle 전체가 아니라 instance에 귀속한다.
한 bundle이 pack과 connector component를 함께 포함할 수 있다. 예를 들어 GitHub bundle은 이슈
connector와 동기화 상태 view를 함께 기여한다.

```text
<extension>/
  extension.json            bundle과 component 목록
  pack/pack.json            선택: workflow pack component
  resources/                아이콘·schema 등 비실행 자산
```

내장 connector는 앱 리소스에서, 사용자 connector는
`~/.claude/sawhorse/extensions/<id>/extension.json`에서 발견한다. 기존
`~/.claude/sawhorse/packs/` 탐색과 사용자 pack 우선순위는 바꾸지 않는다.
bundle/component ID는 전역·bundle 범위에서 각각 유일해야 하고 `schemaVersion`, `minCoreVersion`,
version migration을 검증한다. 사용자 bundle이 같은 ID의 내장 connector를 조용히 덮어쓰지는
못하며, 개발자 모드에서 명시적으로 override해야 한다. 업데이트는 새 디렉터리에 검증 후
atomic swap하고, 권한 증가가 있으면 기존 instance를 paused로 둔다.

bundle 안의 pack component는 설치기가 검증한 디렉터리를 기존 pack registry에 virtual root로
등록한다. pack 우선순위는 기존 사용자 pack > 설치 bundle의 pack > 내장 pack이고, 서로 다른
설치 bundle 사이의 같은 pack ID는 자동 우선순위를 정하지 않고 충돌 상태로 둔다.

```jsonc
{
  "schemaVersion": 1,
  "id": "github",
  "name": "GitHub",
  "version": "0.1.0",
  "components": [{
    "id": "issues",
    "type": "connector",
    "adapter": "builtin:github",
    "requests": {
      "repository": ["read"],
      "issues": ["read"],
      "network": ["api.github.com"],
      "secrets": ["github.oauth"]
    },
    "subscriptions": ["issue.changed", "integration.verified"],
    "commands": ["github.syncIssues", "github.publishIssue"],
    "contributes": {
      "sources": [{ "id": "issues", "type": "issue" }],
      "views": [{ "id": "github-sync", "renderer": "sync-status" }]
    }
  }]
}
```

### 실행 신뢰 단계

MVP는 `builtin:github`, `builtin:rss`처럼 **호스트가 구현한 어댑터**와 선언형 설정만 허용한다.
이 방식이면 기존 pack 원칙을 깨지 않고 GitHub·RSS를 먼저 제공할 수 있다.

GitHub `importOnly` instance는 위 예시처럼 read 권한만 요청한다. 사용자가 양방향 sync나 게시를
켤 때 처음으로 write 권한 승격을 요청한다. instance grant에는 표시 이름만이 아니라 provider
account/installation ID와 허용 repository ID 목록을 담아 같은 API domain의 다른 저장소 접근을
막는다.

추후 제3자 connector는 WASI처럼 실제 capability를 강제할 수 있는 런타임에 올린다. 별도 native
process와 JSON-RPC/stdio는 충돌 격리에는 도움이 되지만, OS sandbox 없이 파일·네트워크 접근을
막아 주지는 않는다. 그러므로 샌드박스 없는 native connector는 「신뢰한 코드」로 명확히
표시하고 기본 설치 경로로 삼지 않는다.

### 권한 규칙

- 기본 거부. 설치할 때 요청 권한과 적용 프로젝트를 보여 준다.
- 확장 업데이트가 권한을 늘리면 재승인 전까지 해당 기능을 멈춘다.
- 네트워크는 domain allowlist, 파일은 workspace/repository read 같은 좁은 capability로 중개한다.
- built-in handler도 raw DB·Git·HTTP client·token을 받지 않고 좁은 `ExtensionContext`만 받는다.
  credential broker가 승인된 account/repository 요청에만 Authorization을 붙이며 token 자체는
  connector에 반환하지 않는다.
- connector는 `.git`, 볼트 Markdown, SQLite를 직접 쓰지 않는다. Core Command API에 intent를
  제출하고 코어가 정책·승인·원자적 쓰기를 담당한다.
- `remote_branch_push`, `pull_request_create`, `issue_write`, `secret_use`를 서로 다른 capability로
  둔다. `local_integrate`는 확장 capability가 아니라 Core 통합 워커만 부를 수 있는 내부 명령이다.
- 임의 React/HTML 코드를 앱 안에 주입하지 않는다. source·command·setting·core renderer만
  선언적으로 기여하며, `renderer` ID는 호스트에 사전 등록된 allowlist 값만 허용한다.

대표 이벤트는 `session.created`, `agent.run.completed`, `changeset.proposed`,
`approval.requested`, `approval.resolved`, `integration.started`, `integration.verified`,
`integration.failed`, `integration.reverted`, `issue.changed`, `article.discovered`,
`article.read`, `sync.failed`다.

## GitHub 이슈 동기화

기존 이슈 노트의 `github_repo`, `github_number`, `github_url`, `github_state`,
`github_updated`를 그대로 연결 필드로 사용한다. 로컬 이슈 ID와 Markdown 본문이 정본이며 GitHub
번호와 URL은 표시용 외부 식별자다. 실제 `ExternalLink`에는 provider, account/installation ID,
immutable repository ID, immutable issue ID를 저장해 repository rename이나 number 표기 변화에도
연결을 유지한다. 현재 `vault.rs::ImprovementNote`가 `github_updated`와 immutable ID를 아직 읽지
않으므로 typed backend 모델과 마일스톤 scan도 connector 단계에서 함께 확장한다.

첫 버전의 기본 모드는 `importOnly`다.

1. 전용 connector poller가 ETag/cursor로 GitHub 변경을 읽는다. 이는 날짜 단위 작업 스케줄러와
   별개인 timestamp 기반 poll/retry loop다.
2. remote payload를 바로 노트에 쓰지 않고 inbound change로 staging한다.
3. 연결되지 않은 remote issue는 「가져오기」 후보로, 연결된 이슈 변경은 field diff로 보여 준다.
4. 사람이 수락하면 코어가 Markdown을 갱신하고 sync base hash를 기록한다.

그 다음 `bidirectional`을 추가한다.

- `title`, `state`, `labels`, `assignees`, `milestone`은 필드별 동기화 정책을 둔다.
- 로컬의 세밀한 `status`와 `approve`는 GitHub의 open/closed로 축소하지 않고 로컬 전용으로 둔다.
- GitHub body를 갱신할 때는 marker로 둘러싼 sawhorse 관리 영역만 바꿔 사용자의 원격 본문을
  덮어쓰지 않는다.
- 마지막 sync의 정규화된 **필드별 base snapshot/hash**와 양쪽 현재값을 비교해 한쪽만 바뀌면
  inbound/outbound intent를 만든다.
- 양쪽이 모두 바뀌었으면 자동 last-write-wins를 하지 않고 conflict를 만들어 필드별로 사람이
  선택한다.
- 오프라인 outbound intent는 `remote_operation`에 `prepared`로 남기고 재연결 시 remote revision을
  다시 확인한다. `event_outbox`가 외부 부작용을 직접 재실행하지 않는다.
- issue 생성·수정·종료, milestone 배정은 모두 `issue_write` 권한과 별도 원격 쓰기 승인을 거친다.
- outbound 승인은 정확한 payload hash와 관찰한 remote revision에 묶는다. 실행 직전 revision이
  달라지면 `stale`로 되돌리고 diff를 다시 보여 준다.
- provider가 issue와 pull request를 같은 목록 표현에 섞어 주더라도 issue connector는 entity
  type을 확인해 PR을 이슈로 가져오지 않는다.

로컬 통합이 완료돼도 자동 push하지 않는다. 필요하면 GitHub 확장이 검증된 integration commit을
PR 초안으로 만드는 게시를 제안한다. 이는 (1) 정확한 local commit/ref를 특정 remote branch에
push하는 intent와 (2) 관찰한 remote base에 PR을 만드는 intent 둘로 분리하며, 각자 별도 권한과
사람 승인을 거친다.

## 기사 사이트와 RSS/Atom

기사 소스는 공통 인터페이스 하나로 정규화한다.

```text
discover(source_config, cursor) -> Article[] + next_cursor
```

```text
Article {
  source_id,
  external_id,
  canonical_url,
  title,
  summary?,
  authors[],
  tags[],
  published_at?,
  discovered_at,
  content_ref?
}
```

`builtin:rss`가 RSS 2.0과 Atom을 처리한다. GeekNews나 pre-work 같은 사이트가 표준 feed를
제공하면 확장은 feed URL·갱신 간격·태그 규칙만 선언한다. feed로 부족한 사이트별 파서는 같은
Article 계약을 구현하는 별도 connector로 추가한다.

다음은 설치 manifest가 아니라 사용자가 만든 **configured source instance** 예시다.

```jsonc
{
  "instanceId": "feed-my-tech-reading",
  "extensionId": "core-feeds",
  "componentId": "rss",
  "config": {
    "feeds": [
      { "name": "기술 뉴스", "url": "https://example.com/feed.xml", "tags": ["tech"] }
    ],
    "refreshMinutes": 30,
    "storeContent": false
  },
  "grant": { "network": ["example.com"] }
}
```

- 물리 identity는 `(source_instance_id, external_id/GUID)`로 유지한다. GUID가 없거나 재사용되면
  entry URL·게시시각·content hash의 source-scoped fallback을 쓰고 collision을 기록한다.
- canonical URL이 같아도 번역·syndication·source별 태그를 잃지 않도록 row를 합치지 않는다.
  대신 `same_as` cluster로 묶어 UI에서만 중복 노출을 접을 수 있게 한다.
- connector 전용 timestamp scheduler가 ETag·Last-Modified·cursor를 저장하고 rate limit·지수
  backoff를 적용한다. 기존 `daily|weekdays|once` 작업 스케줄러와 놓친 루틴 정책을 재사용하지 않는다.
- 기본 저장은 제목, 링크, 짧은 요약, 태그, 읽음/보관 상태다. 원문 전문은 기본 저장하지 않는다.
- 기본 「원문 열기」는 system browser에 URL만 넘긴다. 앱이 원문을 host-fetch하는 opt-in 기능은
  entry origin별 추가 network grant와 아래 SSRF broker를 다시 거치며 사이트 약관·robots·저작권
  범위를 따른다.
- 기사를 세션·이슈에 첨부할 때 원문 복사 대신 URL, 메타데이터, 사용자가 쓴 메모를 남긴다.

사용자 URL을 host 권한으로 가져오는 기능이므로 다음 SSRF·parser 방어를 필수로 한다.

- URL scheme은 `http`·`https`만 허용하고 credential/userinfo가 든 URL은 거부
- DNS 해석 뒤 loopback, private, link-local, multicast, cloud metadata 대역을 차단하고 모든
  redirect에서 scheme·domain grant·해석 IP를 다시 검사
- source instance 활성화 때 실제 feed/redirect domain이 grant와 다르면 추가 승인을 요구
- connect/read timeout, redirect 수, wire bytes, decompressed bytes, entry 수, 본문 길이에 상한
- XML DTD와 external entity를 비활성화하고 entity expansion 한도를 둠
- WebView에 보여 주기 전 RSS의 HTML을 sanitize하고 script·event handler·위험 URL을 제거

## 화면 구성

호스트 코어에 다음 두 화면을 추가한다.

### 세션

- 세션 목표와 상태(`active`, `paused`, `readyToFinalize`, `finalized`)
- 에이전트 레인별 task, worktree, branch, 실행 상태
- 후보 의존 DAG와 경로 겹침 경고
- 대표 체크아웃 path, branch, HEAD, 개발 서버 상태

### 변경 검토

- 승인대기 카드: agent/task, base → source SHA, commit·파일 수, diff, 겹친 경로, 검사 결과
- `Diff 보기`, `수정 요청`, `승인 후 큐에 넣기`, `거부`
- 통합 카드: 현재 단계, 자동 검사 로그, health 상태, 수동 체크리스트
- `확인 완료`, `수정 작업 만들기`, `변경 제거`

「설정 > 협업」에는 승인 정책, 통합 방식, 대표 경로·브랜치, 검증 프로필을 둔다. 「확장」은
pack과 connector를 함께 보여 주되 connector 카드에는 권한, 연결 상태, 마지막 sync, 실패
outbox를 표시한다. 기사 확장이 하나라도 활성화되면 core renderer인 「읽을거리」 화면을
레지스트리에 기여한다.

## 백엔드 구조

```text
dashboard/src-tauri/src/
  collab/
    mod.rs                 세션 서비스와 command 경계
    model.rs               Session, AgentRun, ChangeSet, Approval
    store.rs               SQLite migration·transaction·query
    inbox.rs               에이전트 후보 요청 검증·가져오기
    drivers.rs             AgentDriver와 Claude/herdr 구현
    policy.rs              승인·권한 정책 평가
    git.rs                 read-only 검사와 protected ref
    integration.rs         잠금·merge·revert·재시작 복구
    checks.rs              command·health·manual 검증
    events.rs              audit event·transactional outbox
  extensions/
    manifest.rs            connector manifest·권한 검증
    host.rs                built-in/WASI adapter lifecycle
    broker.rs              scoped HTTP·credential·intent API
    github.rs              GitHub issue adapter
    feeds.rs               RSS/Atom adapter
```

프론트엔드는 `SessionsPage`, `ReviewPage`, `SourcesPage`, `settings/CollaborationSection`을 추가한다.
기존 `watcher`, atomic write, `tasks` inbox, `jobs` event 패턴을 재사용한다.

`Job`의 기존 `sessionId`는 Claude transcript/herdr 재연결용 세션 ID이므로 의미를 바꾸지 않는다.
협업 연결은 `collabSessionId`, `agentRunId`, `parentJobId`, `agentKind` 같은 별도 필드로 추가하고
모두 serde default/optional로 두어 기존 `jobs.jsonl` 행이 계속 로드되게 한다. 기존 running herdr
job의 재연결은 그대로 `JobManager`가 맡고, 새 `AgentRun`은 job ID가 있을 때만 이를 참조한다.

## 단계별 구현

### 1단계 — 로컬 통합 레인

- 안정적인 projectId를 가진 코어 프로젝트 설정, legacy migration, 대표 체크아웃 진단
- AgentDriver 경계와 Claude headless/herdr lane
- Session/AgentRun/ChangeSet/Approval/IntegrationAttempt 저장
- 후보 파일 인박스와 protected Git ref
- issues skill session mode와 `integration_commits`/노트 intent 적용
- required 승인 큐, 직렬 `--no-ff` merge, baseline·검증, revert
- 재시작 write-ahead 복구와 변경 검토 UI

완료 기준: 네트워크 없이 관리형 Claude lane 2개의 후보를 순서대로 승인·병합·검증할 수 있고,
두 번째 후보 실패 시 첫 번째를 보존한 채 두 번째 merge만 revert할 수 있다. Codex는 별도
driver가 들어오기 전까지 수동 인박스 제출만 지원한다고 UI에 정확히 표시한다.

### 2단계 — 확장 계약과 읽기 소스

- connector manifest, 권한 grant, event/outbox 계약
- 좁은 ExtensionContext·HTTP/credential broker와 RSS SSRF 방어
- host-owned `builtin:rss`, 읽을거리 화면
- GitHub 이슈 read-only import와 로컬 링크
- ETag/cursor, retry, dead-letter, 연결 진단 UI

완료 기준: 네트워크가 끊겨도 로컬 협업은 영향받지 않고, 복구 뒤 중복 기사나 중복 이슈 없이
sync가 이어진다.

### 3단계 — 양방향 협업

- GitHub outbound intent와 필드별 conflict UI
- issue/PR 초안 게시의 별도 승인
- 기사별 전용 adapter와 세션·이슈 첨부
- 알림·동기화 상태 배지

### 4단계 — 제3자 생태계

- WASI connector SDK와 실제 capability broker
- 서명·업데이트·권한 증가 재승인
- 추가 issue provider와 webhook 선택 지원
- 승인된 batch integration

## 테스트 전략

- 단위: canonical 후보 digest, immutable ref, ancestry·dependency 검사, target HEAD drift 시 재승인,
  정책 precedence, semantic overlap, issue field 3-way diff, RSS/Atom identity와 GUID collision
- Git fixture: clean merge, planned/actual tree 대조, conflict abort, dirty checkout 차단, stale HEAD,
  redundant patch, revert/revert-conflict, merge·revert crash 단계별 복구, LFS/submodule/untracked 충돌
- 통합: 에이전트 인박스 → 승인 카드 → 대표 경로 merge → verify → fix/revert 전체 흐름
- persistence: legacy project/job 이행, DB↔Markdown WAL의 각 crash point, cursor와 inbound change 원자성
- connector contract: 중복 event, uncertain remote create reconciliation, timeout, cursor 손상, 권한 거부,
  account/repository scope, 업데이트 권한 증가
- feed security: private/loopback·DNS/redirect 우회, oversized/decompression bomb, XXE, unsafe HTML
- UI: required/automatic 경고, 승인 digest 표시, 실패 뒤 큐 정지, sync conflict 수동 선택

## 채택하지 않는 방향

- **worktree별 개발 서버**: 실제 사용 환경과 다른 포트·데이터·로그인 상태를 만들고 요청의 전제를
  해결하지 못한다.
- **승인 전에 대표 경로에 임시 적용**: 대표 경로 변경 자체가 병합이므로 승인 게이트가 거짓이 된다.
- **에이전트가 대표 경로에 직접 cherry-pick**: 단일 작성자·감사·복구 불변식을 깨뜨린다.
- **실패 시 자동 reset**: 이후 병합과 사용자 변경을 잃을 수 있다. 기본은 revert다.
- **GitHub를 정본으로 사용**: 오프라인 동작과 로컬의 세밀한 승인·status 모델을 잃는다.
- **기존 pack에 임의 실행 코드를 추가**: 현재 pack의 단순한 신뢰 모델을 깨뜨린다.
- **샌드박스 없는 native connector를 안전한 제3자 확장으로 간주**: 별도 process는 장애 격리일 뿐
  권한 격리가 아니다.

## 최종 불변식

1. 대표 체크아웃의 병합은 통합 워커 하나만 수행한다.
2. 기본 정책에서 사람 승인이 없는 후보는 대표 경로에 닿지 않는다.
3. 승인은 branch 이름이 아니라 불변 Git SHA와 digest에 묶인다.
4. dirty checkout, stale HEAD, conflict는 사용자 변경을 건드리지 않고 큐를 멈춘다.
5. 검증 실패가 해결되기 전에는 다음 후보를 병합하지 않는다.
6. 로컬 병합과 원격 쓰기는 서로 다른 승인이다.
7. connector는 Git·볼트·DB를 직접 쓰지 않고 코어에 intent만 제출한다.
8. 네트워크와 확장이 없어도 핵심 멀티에이전트 흐름은 완전하게 작동한다.
