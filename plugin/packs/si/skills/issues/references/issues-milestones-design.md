# 이슈·마일스톤 모델

## 결정

**이슈와 개발 항목은 하나의 레코드다.** 두 이름은 같은 것을 다른 축에서 부른 것뿐이다 — 이슈는 요청·승인의 축, 개발 항목은 단계·진행의 축이다. 저장소는 `<vault>/work/<id>/` 하나이고, 화면만 둘이다.

이전에는 이슈가 `사업/<이름>/이슈/*.md`에, 개발 항목이 `work/<id>/`에 따로 있었다. 상태 어휘도(제안·승인대기·승인 대 backlog·ready·review), 산출물도(한 파일의 절 대 여섯 파일), 승인 게이트도(`approve` 대 단계 전이) 각각이었다. 같은 수명주기를 두 번 구현한 것이라 마일스톤 하나만 캘린더에서 공유되고 나머지는 계속 어긋났다.

여러 이슈가 만드는 납기·릴리스·검수 목표는 **마일스톤**으로 기록하며, 마일스톤은 `calendar/<id>.md`의 `kind: milestone` 일정이다.

## 저장 구조

```
<vault>/
  projects/<project-id>/project.md
  work/<work-id>/
    work.md
    intent.md  spec.md  verification.md          # 모든 처리 유형
    plan.md  release.md  learning.md             # 코드형 SDD workflow 에서만
  calendar/<event-id>.md
  프로젝트/<프로젝트명>/                          # 사람이 읽는 문서 영역
    분석/ 회의/ 산출물/
    이슈/ 개선/                                   # 레거시. 읽기 전용 입력
```

프로젝트 폴더의 이름은 `프로젝트/`다. 예전 이름 `사업/`은 계속 읽지만 새로 만들지 않는다.

## 개발 항목 스키마 (이슈 축)

| 필드 | 용도 | GitHub 대응 |
|---|---|---|
| `id` | 폴더 이름이자 안정적인 식별자 | 외부 번호와 독립된 로컬 키 |
| `title` | 제목 | title |
| `issueType` | 버그 / 기능 / 작업 / 질문 | Issue type 또는 label |
| `executionType` | 코드 / 문서 / 조사 / 협의 / 결정 | 작업 유형 또는 label |
| `status` | backlog → review → ready → running → done (+ blocked, cancelled) | 프로젝트 보드 상태 |
| `state` | `open` / `closed`. `status`에서 파생 | issue state |
| `closed` | 닫힌 날짜. `status`에서 파생 | closed_at |
| `labels[]`, `assignees[]` | 분류·담당 | labels, assignees |
| `milestone` | `calendar/`의 마일스톤 일정 ID | milestone |
| `approvalRequired`, `approve`, `approved` | 사람 승인 게이트 | — |
| `priority`, `dueDate`, `startDate`, `dependsOn[]` | 일정과 선행 관계 | — |
| `githubRepo`, `githubNumber`, `githubUrl`, `githubState`, `githubUpdated` | 외부 이슈 연결 | repository, number, html_url, state, updated_at |
| `stage`, `workflowId`, `workflowVersion`, `workflowDigest` | 고정된 흐름과 현재 단계 | — |

`status`는 승인·실행 단계를 표현하므로 GitHub의 두 상태(open/closed)로 축소하지 않는다. `state`와 `closed`는 앱이 저장할 때마다 `status`에서 다시 파생하므로 사람이나 에이전트가 손으로 맞추지 않는다. `approve`는 사람만 켜며, `spec.md`의 실행 대상이 비어 있으면 승인해도 실행하지 않는다.

## workflow 선택

| `executionType` | workflow | 산출물 |
|---|---|---|
| `코드` | 프로젝트가 고정한 정의 (기본 `sdd-main`) | intent, spec, plan, verification, release, learning |
| 그 외 | `issue-main` | intent(요청), spec(설계), verification(결과) |

`issue-main`은 요청 → 설계(사람 승인) → 수행의 3노드 흐름이다. 산출물 role은 SDD와 같은 이름을 쓰므로 하네스 프롬프트와 스킬이 그대로 붙는다. 이미 만든 항목의 workflow는 처리 유형이 바뀌어도 갈아끼우지 않는다.

## 마일스톤

마일스톤은 `calendar/<id>.md`에 `kind: milestone`, `title`, `date`(목표일), `notes`로 저장한다. 소속은 개발 항목의 `milestone` 필드가 정본이며, 마일스톤 문서에 구성원 목록을 복제하지 않는다. 진행률은 구성 항목의 `state: closed` 비율이다. 이슈 화면과 캘린더가 같은 일정 편집기를 쓰며, 항목이 남아 있는 마일스톤은 삭제나 일반 일정으로의 변경이 거절된다.

## 이관과 호환

- 앱의 이슈 화면이 `프로젝트|사업/<이름>/이슈/*.md`와 레거시 `개선/*.md`를 훑어 이관 계획을 보여 준다.
- 이관은 상태·유형·중요도·레이블·담당·마일스톤·GitHub 필드를 옮기고, 노트의 `## 배경 및 요청`·`## 근거 및 분석` → `intent.md`, `## 설계` → `spec.md`, `## 결과` → `verification.md`로 나눈다. 노트가 가진 절이 셋뿐이므로 처리 유형과 무관하게 `issue-main`에 얹는다.
- 폴더 이름은 코어 프로젝트로 승격된다. 같은 이름의 프로젝트가 없으면 만들고, 있으면 그것을 쓴다.
- **원본은 지우거나 옮기지 않는다.** `migrated_to: <work-id>`만 적어 두 곳에 같은 이슈가 살아 있는 상태를 막는다. 이미 표시가 있으면 다시 이관하지 않는다.
- 이관하지 않아도 앱은 동작한다. 레거시 노트는 계속 읽히고 마일스톤 무결성 검사에도 포함된다.

## GitHub 동기화의 경계

이 모델은 GitHub에 네트워크 쓰기를 하지 않는다. 동기화를 추가할 때에도 로컬 `id`를 정본으로 유지하고, 생성·수정·종료·마일스톤 배정은 각각 미리보기와 명시적 사용자 승인을 거친다. 원격 `push` 금지와 로컬 승인 게이트는 그대로 적용된다.

후속 connector, 필드별 충돌 처리, 원격 쓰기 승인 설계는
[멀티에이전트 협업·확장 설계](superpowers/specs/2026-09-05-multi-agent-collaboration-design.md)를 따른다.
