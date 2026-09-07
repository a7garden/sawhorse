---
name: init-vault
description: Prepare the SI pack's document folders, templates, and optional Obsidian integration in an existing Sawhorse vault. Use when these document assets are missing or the user asks to initialize SI notes.
---

# SI 문서 준비

앱의 작업공간 초기화는 작업·프로젝트·워크플로우 저장소를 만든다. 이 스킬은 SI 지식 문서를 위한 폴더와 자산만 준비한다.

1. `~/.claude/sawhorse/config.json`의 `vaultPath`를 읽는다. 명시된 실행 문맥의 볼트 경로가 있으면 그것을 사용한다. 경로가 없을 때만 사용자에게 요청한다. Windows에서도 사용자 홈의 `.claude/sawhorse/`가 설정 위치다.
2. `${CLAUDE_PLUGIN_ROOT}/packs/si/pack.json`의 `workspace.folders`와 `workspace.files`를 읽고 그대로 배치한다. `src`는 SI 팩 루트 기준, `dest`는 볼트 기준 상대경로다. 경로가 각 루트 밖으로 나가면 중단한다. 기존 파일은 건너뛴다. 폴더·템플릿 목록을 이 스킬에 따로 복제하지 않는다.
3. `.obsidian/`가 있거나 사용자가 Obsidian 설정을 요청한 경우만 해당 설정을 준비한다. `templates.json`이 없으면 `{"folder":"템플릿"}`을 만들고, `app.json`의 첨부 폴더가 비어 있거나 루트일 때만 `첨부/스크린샷`으로 지정한다. 다른 설정과 사용자 지정 경로는 보존한다. Obsidian 플러그인 설치·활성화는 이 작업에 포함하지 않는다.
4. 생성·생략한 파일과 설정 변경을 보고한다. 코어 작업공간이 없으면 앱의 작업공간 초기화를 안내한다.

`work/`, `projects/`, `calendar/`, `runs/`, `.sawhorse/`는 이 스킬이 초기화하거나 보정하지 않는다. 과거 이슈·개선 템플릿과 승인 체크박스를 새로 배치하지 않는다. 기존 사용자 볼트의 레거시 문서는 그대로 둔다.
