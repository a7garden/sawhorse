# Sawhorse: 의도에서 운영까지 이어지는 작업대

2026-09-06. 기존 팩 중심 대시보드 위에 SDD를 호스트의 기본 도메인으로 추가한다.

## 제품 흐름

사용자는 프로젝트와 저장소 의존성을 등록하고 작업을 만든다. 각 작업은 `intent.md`에서 시작해 명세, 실행 계획, 검증, 배포, 운영 학습으로 이어진다. 백로그·캘린더·문서·하네스가 같은 작업 ID를 사용한다. 에이전트 실행이 끝나도 작업이 자동 승인되지는 않는다. 산출물과 실제 검증 근거를 검토한 뒤 단계 전환을 기록한다.

| 단계 | 주요 산출물 | 앱이 연결하는 일 |
|---|---|---|
| Plan / 의도 | intent.md | 문제·원하는 결과·영향·제약·열린 질문 |
| Design / 설계 | spec.md | 요구사항·수용 기준·설계·우려 사항 |
| Build / 구현 | plan.md | 변경 범위·의존 저장소·작업 순서·실행 |
| Test / 검증 | verification.md | 실제 명령·결과·증거·미해결 실패 |
| Deploy / 배포 | release.md | 릴리스 내용·배포 및 되돌리기 기록 |
| Maintain / 학습 | learning.md | 관측 결과·회귀 방지·후속 의도 |

업무 상태(backlog, ready, running, review, blocked, done)는 개발 단계와 별도다. 칸반 열을 이동하는 것과 설계를 승인하여 구현 단계로 가는 것은 서로 다른 동작이다.

## 저장 규약

```text
<vault>/
  .sawhorse/schema.json
  projects/<project-id>/project.md
  work/<work-id>/
    work.md
    intent.md
    spec.md
    plan.md
    verification.md
    release.md
    learning.md
  calendar/<event-id>.md
  runs/<run-id>.md
```

YAML frontmatter는 관계와 상태, 본문은 사람이 읽는 기록이다. ID는 표시 제목과 분리한다. 저장소 경로와 프로젝트 관계는 프로젝트 문서가 소유한다. 단계와 판단 이력은 앱이 변경한다. 문서 본문은 앱과 에이전트가 편집할 수 있으며 앱 저장은 SHA-256 revision 비교로 외부 수정 충돌을 감지한다. 앱 재시작 후에도 원본 Markdown에서 다시 읽는다.

새 규약은 버전이 있는 필수 코어다. 초기화는 멱등이며 기존 SI/기록 폴더를 삭제하거나 이름을 바꾸지 않는다. 과거 확장은 계속 쓸 수 있지만 코어 필드를 재정의하지 않는다. 향후 스키마 변경은 명시적 버전 마이그레이션으로 처리한다. 현재 버전보다 새로운 스키마를 발견하면 쓰기를 거부한다.

## Herdr 실행 하네스

Tauri는 Herdr CLI를 통해 에이전트를 시작하고 관측한다. 프로세스를 UI 수명에 묶지 않는다. 각 실행은 작업, 프로젝트, 단계, 역할, 모델, 부모 실행, Herdr 세션과 pane/agent identity를 기록한다. 앱은 실행 시작 전에 기록을 만들고, 시작 실패·승인 대기·검토 대기·중지 상태를 보존한다. 프롬프트에는 정확한 산출물 위치, 프로젝트 관계, 검증 명령을 넣는다.

독립된 연구·계획·구현·검증·검토 역할로 실행한다. 부모 실행에서 하위 실행을 요청할 수 있고, 요청 수용 여부와 결과는 기록으로 남는다. Herdr의 idle/done은 에이전트가 입력을 기다린다는 신호다. 테스트 통과나 배포 완료의 증거로 취급하지 않는다. 앱이 소유한 실행의 정확한 identity를 확인한 후에만 중지 등 제어 명령을 보낸다.

현재 하네스는 실행 관리와 기록 수집을 제공한다. 임의의 운영 환경에 대한 자동 배포, 모니터링 수집, 외부 CI 정책은 프로젝트별 실행 절차가 필요하다. `release.md`를 만드는 것만으로 실제 서비스가 배포되었다고 표시하지 않는다.

## 배포와 확장

Tauri 데스크톱을 유지한다. 로컬 파일·여러 저장소·지속 터미널이 핵심이므로 웹 서비스로 바꾸는 것보다 사용자의 기존 작업환경과 자연스럽게 연결된다. 기본 SDD는 플러그인 설치 없이 앱에서 제공한다. `plugin/skills/sdd`는 앱이 시작한 에이전트가 산출물 규약을 따르도록 돕는다. SI·루틴·커넥터는 추가 기능으로 남는다. Obsidian은 같은 Markdown을 보는 선택적 클라이언트다.

Atomic Editor는 기존 React/CodeMirror 기반 라이브 Markdown 편집에 사용한다. 문서의 정본은 원문 Markdown이며 편집기 내부 모델이 별도 정본이 되지 않는다.

지식 검색은 우선 로컬 Markdown의 정확 검색과 원문 위치를 제공한다. zvec-grep는 프로젝트를 넘는 의미 검색 후보로 검토했다. 자체 인덱스 및 임베딩 관리가 필요하므로 현재 코어 저장소와 강결합하지 않는다. 이후 선택적 검색 공급자로 연결할 수 있다. 원문과 파일 경로는 계속 Sawhorse가 소유한다.

## 출처와 해석

- [Anthropic: Capture as intent.md](https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent): 의도를 사람이 읽고 버전 관리할 수 있는 Markdown으로 구체화하고 검토한다.
- [Anthropic: Requirements and design](https://academy.claude.com/courses/ai-native-sdlc-playbook/requirements-and-design): 승인된 intent에서 spec을 만들고 구현 진입을 검토한다.
- [Anthropic: Feedback loop](https://academy.claude.com/courses/ai-native-sdlc-playbook/give-claude-a-feedback-loop): 작업 중 반복 검증과 독립 검증 역할을 구분한다.
- [Anthropic: Closing the loop](https://academy.claude.com/courses/ai-native-sdlc-playbook/closing-the-loop-on-metrics): 운영 근거가 새 의도로 돌아오는 흐름.
- [Herdr](https://herdr.dev): 지속 터미널 및 에이전트 제어 기반. 구현 시 설치된 CLI 도움말을 계약으로 확인했다.
- [Atomic Editor](https://github.com/kenforthewin/atomic-editor): Markdown 원문을 유지하는 CodeMirror 6 라이브 편집기.
- [zvec-grep](https://github.com/zvec-ai/zvec-grep): 로컬 정확·키워드·벡터 검색을 통합하는 선택적 검색 후보.

이 앱의 폴더 구조, 상태 모델, 실행 장부와 UI는 위 자료를 바탕으로 Sawhorse에 맞게 설계한 것이다. Anthropic의 공식 제품 구현이나 고정 표준을 그대로 복제한 것은 아니다. 제공된 YouTube 영상은 직접 내용을 가져오지 못해 공식 Academy 문서를 근거로 삼았다.
