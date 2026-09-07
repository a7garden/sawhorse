# 작업·마일스톤 저장 계약

## 소유권

| 대상 | 정본 | 변경 주체 |
|---|---|---|
| 프로젝트 | `projects/<id>/project.md` | 앱의 프로젝트 명령 |
| 작업 | `work/<id>/work.md` | 앱의 작업·workflow 명령 |
| 산출물 | 고정 workflow가 선언한 작업 폴더 내 파일 | 허용된 역할의 에이전트와 사용자 |
| 마일스톤 | `calendar/<id>.md`, `kind: milestone` | 앱의 일정 명령 |
| 실행 | `runs/<id>.md`와 호스트 장부 | 실행 하네스 |
| SI 지식 문서 | `프로젝트/<이름>/분석·회의·산출물/`, `일지/`, `개념/` | 해당 문서 스킬과 사용자 |

## 작업

`id`는 안정적인 로컬 키다. `issueType`, `executionType`, `labels`, `assignees`, `priority`, `dueDate`, `dependsOn`, `milestone`은 요청의 분류와 관계를 표현한다. `github*`는 외부 연결 정보이며 내부 생명주기를 대체하지 않는다.

`workflowId`, `workflowVersion`, `workflowDigest`는 작업에 고정된 정의를 가리킨다. 산출물의 종류와 파일명은 이 정의에서 읽는다. 처리 유형이나 파일명이 바뀌었다고 workflow를 추정하거나 교체하지 않는다. `sdd-main`, `issue-main`, `tdd-cycle`, `intent-flow`, 설치된 확장의 workflow는 각자 선언한 산출물을 사용한다.

| status | 의미 |
|---|---|
| backlog | 접수 |
| ready | 수락되어 예정됨 |
| running | 진행 |
| review | 최종 결과 검토 |
| blocked | 보류; 공정 위치 유지 |
| done | 결과 인수 완료 |
| rejected | 요청 반려 |
| cancelled | 수락한 작업 취소 |

단계별 검토 결정과 작업 전체의 수락·보류·종료 결정은 호스트가 기록한다. `state`, `closed`, `approve`, `approved`는 호환을 위해 파생되는 값이다. 직접 편집하거나 별도 승인 체크리스트로 관리하지 않는다.

## 마일스톤

작업의 `milestone`은 캘린더 일정 ID다. 소속은 그 필드 한 곳에만 저장한다. 진행률은 앱이 구성 작업에서 계산한다. 구성 작업이 남아 있는 일정의 삭제나 일반 일정 전환은 앱의 무결성 검사를 따른다.

## 기존 볼트

`프로젝트|사업/<이름>/이슈/*.md`와 `개선/*.md`는 이관 입력이다. 앱은 원본 본문을 산출물로 나누고 기존 내용을 `issue-main` 작업으로 연결한다. 원본은 삭제·이동하지 않고 `migrated_to`를 기록한다. 이미 이관한 원본을 다시 등록하지 않는다.

`config.json`의 `improve.projects`와 기존 `approve` 필드는 읽기 호환을 위해 남는다. 새 프로젝트 설정은 `projects/<id>/project.md`, 새 승인은 workflow 결정이 정본이다.
