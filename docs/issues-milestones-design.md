# 이슈·마일스톤 모델

## 결정

`개선`은 업무의 한 종류일 뿐, 시스템의 최상위 작업 단위가 아니다. 앞으로 모든 변경·결함·조사·요청은 **이슈**로 기록하고, 여러 이슈가 만드는 납기·릴리스·검수 목표는 **마일스톤**으로 기록한다.

기존의 설계 승인과 Markdown 결과 기록은 모든 이슈에 적용한다. 코드 변경만의 패턴이 아니다. 이슈는 GitHub Issue와 같은 일반적인 추적 단위이면서도, 로컬 SI 업무에 필요한 사람 승인 게이트를 가진다.

## 저장 구조

```
사업/<사업명>/
  이슈/
    이슈.md                     # 이슈 MOC
    <idPrefix> 이슈.base         # 사업 범위 이슈 뷰
    <idPrefix> 이슈목록.md       # 자유 입력 인박스
    <ID> <제목>.md               # 이슈 1건
  마일스톤/
    마일스톤.md                  # 마일스톤 MOC
    <ID> <제목>.md               # 마일스톤 1건
```

전역 뷰는 `사업/이슈.base`, `사업/마일스톤.base`다. 이슈는 `milestone`에 마일스톤 ID를 적어 연결한다. 폴더를 마일스톤별로 나누지 않아야 이슈를 여러 축(상태·우선순위·레이블·담당자)으로 볼 수 있다.

## 이슈 스키마

| 필드 | 용도 | GitHub 대응 |
|---|---|---|
| `id` | 사업 단위의 안정적인 식별자 | 외부 번호와 독립된 로컬 키 |
| `title`(파일명) | 이슈 제목 | title |
| `execution_type` | 코드 / 문서 / 조사 / 협의 / 결정 | 작업 유형 또는 label |
| `status` | 제안 → 승인대기 → 승인 → 진행중 → 완료의 공통 워크플로 | 프로젝트 보드 상태에 해당 |
| `state` | `open` / `closed` | issue state |
| `issue_type` | 버그 / 기능 / 작업 / 질문 | Issue type 또는 label |
| `labels[]`, `assignees[]` | 분류·담당 | labels, assignees |
| `milestone` | 로컬 마일스톤 ID | milestone |
| `github_repo`, `github_number`, `github_url` | 외부 이슈 연결 정보 | repository, number, html_url |
| `github_state`, `github_updated` | 마지막 동기화 관측값 | state, updated_at |

`status`는 승인·실행 단계를 표현하므로 GitHub의 두 상태(open/closed)로 축소하지 않는다. 새 이슈의 표준 상태는 `제안|승인대기|승인|진행중|부분완료|완료|보류|취소`이며, `완료|취소`만 `state: closed`다. `approve`는 사람만 true로 바꾸며, `### 실행 대상`이 비어 있으면 어떤 유형도 실행하지 않는다. `execution_type: 코드`는 경로 한정 커밋과 되돌리기 기록이 추가로 필수다.

이 방식은 문서·조사·협의·결정 이슈에도 같은 감사 추적을 남긴다. 차이는 실행 대상과 검증 증거뿐이다. 실제 동기화 기능은 아직 만들지 않으며, 연결 필드를 먼저 표준화해 GitHub CLI/API 연동을 추가할 때 변환 계층을 만들 필요가 없게 한다.

## 마일스톤 스키마

마일스톤은 `id`, `title`(파일명), `status: 계획|진행중|완료|보류`, `state`, `due`, `description`, `github_repo`, `github_number`, `github_url`, `github_state`, `github_updated`를 사용한다. `id`는 예를 들어 `FDR-M1`이며 이슈의 `milestone` 값이 된다. 이슈의 milestone 참조는 같은 사업의 실제 마일스톤 ID여야 한다.

## 전환 및 호환

- 새 이슈는 `이슈/`와 `type: 이슈`로만 만든다.
- 기존 `개선/`, `type: 개선` 노트는 대시보드가 계속 읽고, 기존 명령과 엑셀도 계속 처리한다.
- 기존 노트 이동·`type` 변경·링크 재작성은 자동으로 하지 않는다. 이슈 스킬이 발견하면 사용자 승인 뒤에만 이관한다.
- 레거시 `category`는 이관 시 `issue_type`으로 옮기고 `labels`에도 유지할 수 있다. 기존 `status`·`approve`·커밋·의존성은 그대로 보존한다.
- 현재 `/si-workbench:improve` 명령은 호환 별칭으로 남긴다. 화면과 문서에서는 `이슈`를 기본 명칭으로 사용한다.

## GitHub 동기화의 경계

이 변경은 GitHub에 네트워크 쓰기를 하지 않는다. 동기화 기능을 추가할 때에도 로컬 이슈 ID를 정본으로 유지하고, 생성·수정·종료·마일스톤 배정은 각각 미리보기와 명시적 사용자 승인을 거친다. 원격 `push` 금지와 로컬 승인 게이트는 그대로 적용된다.
