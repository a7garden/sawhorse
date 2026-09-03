---
name: setup
description: Use when setting up or troubleshooting si-workbench — "si-workbench 설정", "setup", "초기 설정", "vault 경로 바꿔줘", "환경 진단", "플러그인 동작 확인" — or right after install, before init-vault.
---

# setup — 설정 및 환경 진단

설정 값을 확인·수집하고 실행 환경을 점검한다. 재실행 멱등: 이미 설정된 항목은 다시 묻지 않고 통과 표시한다.

## 안전 규칙

- 진단은 읽기 전용 확인(`--version`, 파일 존재 확인)만 한다. 도구 설치를 임의로 진행하지 않는다 — 방법만 안내한다.
- 원격 저장소 변경(`git push`, `svn commit`) 금지. 이 스킬이 네트워크로 무언가를 전송하는 일도 없다.
- 파일 쓰기는 2곳뿐이다: `%USERPROFILE%\.claude\si-workbench\config.json`, 그리고 사용자가 동의한 경우뿐.

## 1. vault 경로

1. `${user_config.vault_path}` 값을 이 본문에서 읽는다. 값이 있고 그 디렉토리가 실존하면 ✓ 통과.
2. 비어있거나 실존하지 않으면 `%USERPROFILE%\.claude\si-workbench\config.json`의 `vaultPath`를 확인한다. 값이 있고 실존하면 ✓. (이 파일은 userConfig 다음 우선순위다.)
3. 둘 다 없으면 사용자에게 Obsidian vault 절대경로를 묻고, 답을 받아 config.json을 작성/갱신한다:

   ```json
   {"vaultPath": "C:\\Users\\me\\Documents\\WorkVault"}
   ```

   - 기존 파일이 있으면 `vaultPath` 키만 갱신한다.
   - 영구 설정의 우선 방법은 `/plugin`에서 si-workbench의 `vault_path` 옵션을 편집하는 것임을 안내한다.

## 2. 개선 사이클 대상 프로젝트 (선택)

`/si-workbench:improve` 를 쓸 때만 필요하다. config.json 에 `improve` 블록이 없으면 **"개선 사이클을 쓰실 거면 지금 프로젝트 경로를 등록할 수 있습니다"** 라고 한 줄 안내만 하고, 사용자가 원할 때만 아래를 수집해 `improve.projects.<사업명>` 에 저장한다. 경로는 PC마다 다르므로 반드시 물어보고 추정해서 쓰지 않는다.

| 항목 | 뜻 | 기본값 |
|---|---|---|
| `path` | 코드베이스 절대경로 | (필수, 실존 확인) |
| `idPrefix` | 문제 ID 접두어 (예: `FDR` → `FDR-001`) | 사업명 이니셜로 제안 |
| `mode` | `inplace`(현재 디렉터리에 브랜치) / `worktree`(별도 체크아웃) | `inplace` |
| `baseBranch` | 복귀·병합 대상 브랜치 | 빈 값 = 실행 시점의 현재 브랜치 |
| `branchPrefix` | 문제 브랜치 접두어 | `fix/` |
| `worktreeRoot` | 워크트리 위치 (`worktree` 모드만) | (필수) **SVN 작업복사본 바깥** 경로여야 함 |
| `verify` | 컴파일 검증 명령 | 매니페스트로 추정해 제안 (`pom.xml` → `mvn -o -q compile`, `package.json` → `npm run build`) |

```json
{
  "vaultPath": "C:\\Users\\me\\Documents\\WorkVault",
  "improve": {
    "defaultProject": "<사업명>",
    "projects": {
      "<사업명>": {
        "path": "D:\\workspace\\myproj",
        "mode": "inplace",
        "baseBranch": "",
        "branchPrefix": "fix/",
        "worktreeRoot": "",
        "idPrefix": "FDR",
        "verify": "mvn -o -q compile"
      }
    }
  }
}
```

- 사업이 하나뿐이면 `defaultProject` 를 그 값으로 자동 설정한다.
- 등록된 프로젝트는 진단 표에 `path` 실존, git 저장소 여부, `.svn` 공존 여부를 함께 보고한다. `.svn` 이 있으면 "SVN 작업복사본입니다 — improve 스킬은 svn 상태 변경 명령을 실행하지 않습니다" 를 덧붙인다.
- `worktreeRoot` 가 프로젝트 경로 **안쪽**으로 지정되면 거부하고 다시 묻는다 (SVN 작업복사본 오염 방지).

## 3. 환경 진단

아래 표 형식으로 보고한다 (항목 | 상태 ✓/✗ | 조치):

| 항목 | 확인 방법 | ✗일 때 조치 안내 |
|---|---|---|
| vault 디렉토리 | 1단계에서 확인 | 경로 재질문 |
| Obsidian 템플릿 설정 | `<vault>/.obsidian/templates.json` 존재 | `/si-workbench:init-vault` 실행 제안 |
| pandoc | `pandoc --version` | docx 파싱은 Word 자동화로 폴백됨. 설치 권장: https://pandoc.org/installing |
| Node.js (v18+) | `node --version` | Playwright 스크린샷만 제한, 나머지 기능 정상 |
| Playwright MCP | 세션의 `/mcp` 화면에서 playwright 상태 확인 | 미연결이면 README '자주 묻는 질문'의 Windows npx 우회법 안내 |
| 저널 훅 | `%USERPROFILE%\.claude\si-workbench\journal\` 확인 | 신규 설치면 세션 1회 종료 후 생성됨. 지금 비어 있어도 정상 |

## 4. 마무리

- 진단 표와 수행한 설정 변경을 요약 보고한다.
- vault 구조(`템플릿/`, `일지/`, `사업/`, `개념/`, `첨부/`)가 없으면 `/si-workbench:init-vault` 실행을 제안한다.
