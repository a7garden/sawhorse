---
name: issues
description: Organize Sawhorse work requests and milestones, or prepare their design and result artifacts. Use for explicit issue registration, triage, planning, execution, or legacy-note migration requests within Sawhorse.
---

# 작업과 마일스톤

SI 업무 요청을 Sawhorse의 공통 작업으로 연결한다. 코드·문서·조사·협의·결정 모두 `work/<id>/`의 같은 모델을 사용한다. 이 스킬은 별도의 상태나 승인 흐름을 만들지 않는다.

먼저 [작업 계약](references/issues-milestones-design.md)을 읽는다. 하네스가 제공한 작업 ID, 프로젝트, 고정 workflow, 현재 노드, 산출물 경로와 허용 범위가 실행 기준이다. 하네스 밖에서는 `~/.claude/sawhorse/config.json`의 `vaultPath`를 읽고 해당 작업과 프로젝트를 확인한다. Windows에서는 사용자 홈의 `.claude/sawhorse/`를 사용한다.

## 요청별 처리

- 등록·분류: 요청, 기대 결과, 근거, 처리 유형, 중요도, 의존 작업을 정리한다. 기존 작업과 중복을 확인한 뒤 앱의 작업 생성 경로를 사용한다. 생성 API가 없는 세션에서는 등록할 내용과 프로젝트를 전달한다. 임의 ID로 `work.md`를 만들어 호스트 검증을 우회하지 않는다.
- 설계: 선택한 workflow가 선언한 설계 산출물에 방안, 선택 이유, 실행 대상, 완료 기준과 검증 방법을 쓴다. 업무 성격에 필요한 내용만 추가한다. 설계 저장과 단계 승인은 서로 다른 동작이다.
- 실행·검증: 호스트가 허용한 현재 단계와 사용자 범위에서 수행한다. SDD 작업은 `${CLAUDE_PLUGIN_ROOT}/skills/sdd/SKILL.md`, TDD 노드는 `${CLAUDE_PLUGIN_ROOT}/skills/tdd/SKILL.md`의 증거 계약을 적용한다. 실행 결과와 실패·미확인 사항을 선언된 결과 산출물에 남긴다.
- 마일스톤: 목표·완료 기준·목표일을 정리하고 앱의 `calendar/` 마일스톤과 작업의 `milestone` 필드로 연결한다. 구성원 목록과 진행률을 별도 문서에 복제하지 않는다.
- 현황: 작업·공정·마일스톤의 저장된 상태를 읽고 보고한다. 에이전트 종료를 완료나 승인으로 해석하지 않는다.
- 이관: 과거 `프로젝트/` 또는 `사업/` 아래 `이슈/`, `개선/` 문서는 앱의 레거시 이관 입력이다. 앱의 미리보기·이관 경로를 사용하며 원본을 직접 이동하거나 새 레거시 문서를 만들지 않는다.

## 상태와 변경 범위

상태·공정 이동·검토 결정은 호스트의 `workflow_command`가 관리한다. `approve`, `approved`, `approvalRequired`는 과거 독자를 위한 호환 필드이며 새 승인 수단이 아니다. 사람이 Markdown 체크박스를 바꾸도록 안내하거나 에이전트가 이 필드를 수정하지 않는다. 중간 설계 검토를 작업 전체의 결과 검토(`review`)로 바꾸지 않는다.

산출물은 현재 내용을 다시 읽고 기존 근거와 사용자 내용을 보존해 편집한다. workflow ID·버전·digest, 결정 이력, 상태, 실행 ID를 직접 바꿔 게이트를 통과시키지 않는다. 필요한 호스트 동작이 세션에 없으면 작성한 산출물과 다음 앱 동작을 보고한다.

코드 실행은 저장소 규약과 실제 작업 디렉터리를 확인하고, 사용자 변경을 보존하며 검증 결과를 기록한다. 커밋이 요청되면 관련 경로만 포함한다. 협업 세션에서는 제공된 worktree·후보 제출 계약을 따르고 공유 기록을 직접 갱신하지 않는다. 원격 게시·병합·연락은 현재 사용자 요청과 호스트 권한 범위를 따른다.

보고서 내보내기는 활성화한 `xlsx-export` 확장을 사용한다. 보고서는 상태의 정본이 아니다.
