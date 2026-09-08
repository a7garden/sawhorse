---
name: setup
description: Diagnose Sawhorse's vault path, enabled feature assets, agent tools, and journal hook. Use for setup or troubleshooting of these features.
---

# 환경 진단

이미 설정된 값은 다시 묻지 않고 실제 파일·디렉터리와 명령 실행 가능 여부를 확인한다.

- 설정: 사용자 홈의 `.claude/sawhorse/config.json`에서 `vaultPath`를 읽는다. 실행 문맥에 명시된 경로가 있으면 우선한다. 경로 변경 요청은 해당 키만 갱신하고 나머지 설정은 보존한다.
- 코어 작업공간: `<vault>/.sawhorse/schema.json`과 `projects/`를 확인한다. 없으면 앱의 작업공간 초기화를 안내한다.
- 프로젝트: 앱에 등록된 `projects/<id>/project.md`에서 폴더와 검증 명령을 읽는다. 새 프로젝트는 앱에서 등록한다. 과거 `improve.projects`는 호환 입력이며 새로 만들거나 전용 브랜치를 요구하지 않는다.
- 기능 확장 자산: `${CLAUDE_PLUGIN_ROOT}/packs/*/pack.json`의 활성 `workspace` 선언과 비교해 없는 파일을 보고한다. 필요한 경우 `/sawhorse:init-vault`로 준비한다.
- 도구: Node.js는 볼트 점검·훅, pandoc은 문서 변환, 선택한 에이전트 CLI와 Herdr는 앱의 개발 실행에 사용한다. 해당 기능을 쓰는 도구만 존재·버전을 확인하고 미설치와 실제 오류를 구분한다.
- 저널 훅: 사용자 홈의 `.claude/sawhorse/journal/`을 확인한다. 세션 기록이 없는 신규 설치는 실패가 아니다.
- Obsidian: 사용 중인 볼트에 `.obsidian/`가 있을 때만 템플릿·첨부 경로를 확인한다. 작업 승인은 앱의 워크플로우 결정으로 처리한다.

진단 결과에는 항목, 확인 근거, 필요한 조치만 남긴다. 도구 설치·원격 연결·프로젝트 변경은 사용자가 요청한 범위에 한해 별도로 수행한다.
