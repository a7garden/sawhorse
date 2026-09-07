---
name: setup
description: Use when setting up or troubleshooting sawhorse — "sawhorse 설정", "setup", "초기 설정", "vault 경로 바꿔줘", "환경 진단", "플러그인 동작 확인" — or right after install, before init-vault.
---

# setup — 설정 및 환경 진단

설정 값을 확인·수집하고 실행 환경을 점검한다. 재실행 멱등: 이미 설정된 항목은 다시 묻지 않고 통과 표시한다.

## 안전 규칙

- 진단은 읽기 전용 확인(`--version`, 파일 존재 확인)만 한다. 도구 설치를 임의로 진행하지 않는다 — 방법만 안내한다.
- 원격 저장소 변경(`git push`, `svn commit`) 금지. 이 스킬이 네트워크로 무언가를 전송하는 일도 없다.
- 파일 쓰기는 2곳뿐이다: `%USERPROFILE%\.claude\sawhorse\config.json`, 그리고 사용자가 동의한 경우뿐.

## 1. vault 경로

1. `${user_config.vault_path}` 값을 이 본문에서 읽는다. 값이 있고 그 디렉토리가 실존하면 ✓ 통과.
2. 비어있거나 실존하지 않으면 `%USERPROFILE%\.claude\sawhorse\config.json`의 `vaultPath`를 확인한다. 값이 있고 실존하면 ✓. (이 파일은 userConfig 다음 우선순위다.)
3. 둘 다 없으면 사용자에게 Obsidian vault 절대경로를 묻고, 답을 받아 config.json을 작성/갱신한다:

   ```json
   {"vaultPath": "C:\\Users\\me\\Documents\\WorkVault"}
   ```

   - 기존 파일이 있으면 `vaultPath` 키만 갱신한다.
   - 영구 설정의 우선 방법은 `/plugin`에서 sawhorse의 `vault_path` 옵션을 편집하는 것임을 안내한다.

## 2. 코드 실행 대상 프로젝트 (선택)

`/sawhorse:issues`에서 **코드형 이슈를 실행**할 때만 필요하다. 문서·조사·협의·결정 이슈는 볼트만 있으면 관리할 수 있다. 현재 호환 설정 키는 `improve.projects.<프로젝트명>`이므로 그대로 사용한다. 블록이 없으면 **"코드 실행 이슈를 쓰실 거면 프로젝트 경로를 등록할 수 있습니다"** 라고 한 줄 안내만 하고, 사용자가 원할 때만 아래를 수집한다. 경로는 PC마다 다르므로 반드시 물어보고 추정해서 쓰지 않는다.

| 항목 | 뜻 | 기본값 |
|---|---|---|
| `path` | 코드베이스 절대경로 | (필수, 실존 확인) |
| `workBranch` | **코드 이슈 작업 전용 단일 브랜치.** 관련 커밋이 여기 쌓인다 | (필수, 반드시 물어본다 — 추정·자동 생성 금지) |
| `portableBase` | 나중에 이 브랜치를 다른 브랜치로 옮길 때의 기준 (예: `origin/dev`) | 생략 가능 |
| `idPrefix` | 문제 ID 접두어 (예: `FDR` → `FDR-001`) | 프로젝트명 이니셜로 제안 |
| `verify` | 컴파일 검증 명령 | 매니페스트로 추정해 제안 (`pom.xml` → `mvn -o -q compile`, `package.json` → `npm run build`) |

```json
{
  "vaultPath": "C:\\Users\\me\\Documents\\WorkVault",
  "improve": {
    "defaultProject": "<프로젝트명>",
    "projects": {
      "<프로젝트명>": {
        "path": "D:\\workspace\\myproj",
        "workBranch": "improve/fdr",
        "portableBase": "origin/dev",
        "idPrefix": "FDR",
        "verify": "mvn -o -q compile"
      }
    }
  }
}
```

- 프로젝트가 하나뿐이면 `defaultProject` 를 그 값으로 자동 설정한다.
- 등록된 프로젝트는 진단 표에 `path` 실존, git 저장소 여부, `.svn` 공존 여부를 함께 보고한다. `.svn` 이 있으면 "SVN 작업복사본입니다 — issues 스킬은 svn 상태 변경 명령을 실행하지 않습니다" 를 덧붙인다.
- **브랜치를 만들지 않는다.** `git branch --list <workBranch>` 로 존재 여부만 확인한다. 없으면 값은 그대로 기록하되 아래를 안내하고 사용자가 직접 만들게 한다:
  - `workBranch` 는 **남의 변경이 섞이지 않은 지점에서 분기**해 두어야 나중에 통째로 다른 브랜치에 옮길 수 있다.
  - 만드는 명령: `git branch <workBranch> <분기점>` (개선 작업은 문제마다 브랜치를 파지 않고 이 하나에만 쌓인다).
  - 같은 작업 트리를 IDE·톰캣·다른 세션이 함께 보므로 `switch`·`checkout` 은 사용자가 직접 판단해 실행한다.
- 이 스킬도 issues 스킬도 브랜치를 생성·전환·병합하지 않는다. 확인과 안내까지가 범위다.

## 3. 환경 진단

아래 표 형식으로 보고한다 (항목 | 상태 ✓/✗ | 조치):

| 항목 | 확인 방법 | ✗일 때 조치 안내 |
|---|---|---|
| vault 디렉토리 | 1단계에서 확인 | 경로 재질문 |
| Obsidian 템플릿 설정 | `<vault>/.obsidian/templates.json` 존재 | `/sawhorse:init-vault` 실행 제안 |
| 이슈 승인 체크박스 | `<vault>/.obsidian/types.json` 의 `types.approve` 가 `checkbox` | 없으면 승인 표시가 체크박스가 아니라 텍스트로 보인다. `/sawhorse:init-vault` 실행 제안 |
| pandoc | `pandoc --version` | docx 파싱은 Word 자동화로 폴백됨. 설치 권장: https://pandoc.org/installing |
| Node.js (v18+) | `node --version` | Playwright 스크린샷만 제한, 나머지 기능 정상 |
| Playwright MCP | 세션의 `/mcp` 화면에서 playwright 상태 확인 | 미연결이면 README '자주 묻는 질문'의 Windows npx 우회법 안내 |
| 저널 훅 | `%USERPROFILE%\.claude\sawhorse\journal\` 확인 | 신규 설치면 세션 1회 종료 후 생성됨. 지금 비어 있어도 정상 |

## 4. 마무리

- 진단 표와 수행한 설정 변경을 요약 보고한다.
- vault 구조(`템플릿/`, `일지/`, `프로젝트/`, `개념/`, `첨부/`)가 없으면 `/sawhorse:init-vault` 실행을 제안한다.
