---
name: init-vault
description: Use when the user wants to prepare the Obsidian vault for si-workbench — "vault 초기화해줘", "처음 세팅해줘", "vault 새로 만들어줘", "si-workbench 초기 설정해줘", "템플릿 세팅해줘" — or when another si-workbench skill cannot proceed because the vault folders or 템플릿 templates are missing.
---

# vault 초기화

si-workbench가 쓸 Obsidian vault의 폴더 구조를 만들고, 노트 템플릿·Bases 인덱스·대시보드를 배치하고, Obsidian 쪽 설정(첨부 폴더·홈페이지)을 보정한다.
재실행 멱등: 기존 파일과 설정은 절대 덮어쓰지 않으므로 여러 번 실행해도 안전하며, 항상 같은 상태로 수렴한다.

## 공통 정책

- 코드베이스는 읽기 전용으로만 다룬다. 어떤 파일도 수정/삭제하지 않는다.
- 원격 변경 금지: `git push`, `svn commit/ci`, `git svn dcommit`, `hg push`는 실행하지 않는다.
- 이 스킬은 노트를 작성하지 않는다. 이후 모든 노트 작성은 si-workbench:wiki 규범을 준수한다.
- 클라우드 동기화·원격 저장소 설정은 하지 않는다. vault의 로컬 git 버저닝은 vault-tidy가 담당한다.

## 절차

1. vault 경로 확인
   - `${user_config.vault_path}` 값을 읽는다.
   - 값이 비어있거나 실존하지 않으면 `%USERPROFILE%\.claude\si-workbench\config.json`의 `vaultPath`를 확인한다. 있으면 그 경로를 쓴다.
   - 둘 다 없으면 임의로 추정하지 말고 사용자에게 vault 절대경로를 문의한다. 답을 받으면 그 경로로 진행하고, 사용자 동의를 얻어 config.json에 저장한다(다음 실행부터 자동 적용). 이하 절차의 `${user_config.vault_path}`는 여기서 확정한 경로로 읽는다.
2. 폴더 생성 (이미 있으면 건너뛰고 목록에 기록)
   - `${user_config.vault_path}/템플릿/`
   - `${user_config.vault_path}/일지/`
   - `${user_config.vault_path}/사업/`
   - `${user_config.vault_path}/개념/`
   - `${user_config.vault_path}/첨부/스크린샷/`
   - `${user_config.vault_path}/첨부/다이어그램/`
   - 사업별 스크린샷·다이어그램 폴더(`첨부/.../<사업명>/`)는 project-doc, codebase-docs가 필요 시 만든다.
3. 템플릿 복사: `${CLAUDE_PLUGIN_ROOT}/templates/*.md` → `${user_config.vault_path}/템플릿/`
   - 대상 폴더에 같은 이름의 파일이 있으면 덮어쓰지 않고 skip 목록에 기록한다.
   - 복사한 파일과 스킵한 파일을 각각 목록으로 남긴다.
4. Obsidian 템플릿 설정: `${user_config.vault_path}/.obsidian/templates.json`
   - 파일이 없으면 `.obsidian/` 폴더와 함께 아래 내용으로 작성한다.
     ```json
     {"folder":"템플릿"}
     ```
   - 파일이 있으면 `folder` 값을 확인한다. `"템플릿"`이면 그대로 통과하고, 다른 값이면 기존 파일을 덮어쓰지 말고 "현재 템플릿 폴더 설정은 X입니다"라고 안내만 한다.
5. 인덱스 자산 배치 (Bases 뷰 + 대시보드)
   - `${CLAUDE_PLUGIN_ROOT}/assets/bases/개념.base` → `${user_config.vault_path}/개념/개념.base`
   - `${CLAUDE_PLUGIN_ROOT}/assets/bases/사업.base` → `${user_config.vault_path}/사업/사업.base`
   - `${CLAUDE_PLUGIN_ROOT}/assets/bases/개선.base` → `${user_config.vault_path}/사업/개선.base`
   - `${CLAUDE_PLUGIN_ROOT}/assets/bases/일지.base` → `${user_config.vault_path}/일지/일지.base`
   - `${CLAUDE_PLUGIN_ROOT}/assets/대시보드.md` → `${user_config.vault_path}/대시보드.md`
   - 같은 이름의 파일이 이미 있으면 덮어쓰지 않고 skip 목록에 기록한다.
   - Bases는 Obsidian 1.9+ 코어 플러그인이다. `.obsidian/core-plugins.json`의 `"bases"`가 `false`면 활성화를 안내한다(설정 파일을 직접 고치지 않는다).
6. Obsidian 설정 보정: `${user_config.vault_path}/.obsidian/app.json`
   - 파일이 없으면 `{"attachmentFolderPath":"첨부/스크린샷"}`으로 만든다.
   - 있으면 `attachmentFolderPath` 키만 본다. 없거나 값이 비어 있거나 `/` 또는 `.`(볼트 루트)이면 `첨부/스크린샷`으로 채운다. 다른 폴더가 지정돼 있으면 사용자의 선택이므로 그대로 두고 보고만 한다.
   - 이 키 외의 다른 설정은 읽기만 하고 건드리지 않는다. 이 설정이 없으면 붙여넣기 이미지가 볼트 루트에 쌓인다.
7. 프로퍼티 타입 등록: `${user_config.vault_path}/.obsidian/types.json`
   - 파일이 없으면 `{"types":{"approve":"checkbox"}}` 로 만든다. 있으면 `types` 객체에 `"approve": "checkbox"` 키만 추가한다(다른 키는 그대로 둔다. 이미 있으면 건드리지 않는다).
   - 이게 없으면 개선 노트의 승인 체크박스가 속성 패널과 `개선.base` 표에서 체크박스가 아니라 텍스트로 보인다. 승인은 클릭 한 번이어야 하므로 이 등록이 필요하다.
8. 홈페이지 설정 (Homepage 커뮤니티 플러그인이 설치돼 있을 때만)
   - `${user_config.vault_path}/.obsidian/plugins/homepage/`가 없으면 이 단계를 건너뛰고, 대시보드를 시작 화면으로 쓰려면 Homepage 플러그인을 설치하면 된다고 안내만 한다.
   - `data.json`이 이미 있으면 **덮어쓰지 않는다**. `homepages["Main Homepage"].value`가 무엇인지 보고만 한다.
   - `data.json`이 없으면 아래 내용으로 만든다(스키마는 플러그인 4.x 기준):
     ```json
     {"version":4,"homepages":{"Main Homepage":{"value":"대시보드","kind":"File","openOnStartup":true,"openMode":"Replace all open notes","manualOpenMode":"Keep open notes","view":"Default view","revertView":true,"openWhenEmpty":true,"refreshDataview":false,"autoCreate":false,"autoScroll":false,"pin":false,"commands":[],"alwaysApply":false,"hideReleaseNotes":false}},"separateMobile":false}
     ```
9. 결과 요약 보고
   - 생성한 폴더 목록, 복사한 템플릿·인덱스 자산 목록, 스킵한 파일 목록, templates.json / app.json / types.json / homepage 처리 결과를 보고한다.
   - 마무리 안내: Obsidian에서 설정 → 코어 플러그인에서 Templates(템플릿)와 Bases 활성화(이미 활성화면 생략), 템플릿 폴더 위치가 `템플릿`인지 확인, 대시보드가 열리는지 확인.

## 금지사항

| 금지 | 이유 |
|---|---|
| vault 경로가 비어있을 때 경로 임의 추정/생성 | 잘못된 위치에 vault가 생성됨 — 반드시 사용자에게 절대경로 문의 |
| 기존 템플릿 파일 덮어쓰기 | 사용자가 수정한 템플릿을 보존 — skip 후 목록 보고 |
| 기존 `.obsidian/templates.json` 덮어쓰기 | 기존 Obsidian 설정 존중 — `folder` 값 확인 후 안내만 |
| 기존 `.base`·`대시보드.md`·homepage `data.json` 덮어쓰기 | 사용자가 손본 뷰·시작화면을 보존 — skip 후 목록 보고 |
| `core-plugins.json` 직접 수정으로 플러그인 켜기 | Obsidian이 관리하는 설정 — 활성화는 사용자가 UI에서 |
| 템플릿 내용이나 frontmatter 필드 임의 수정 | 프로퍼티 스키마는 design.md 기준으로 고정 |
| vault에 `git init` 또는 원격 동기화 설정 | vault는 로컬 전용 (설계 정책) |
