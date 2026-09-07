# Sawhorse CLI

터미널 에이전트가 워크플로우를 작성·검증·시뮬레이션·등록하고, 앱의 Workflow Studio에서
같은 초안을 이어서 편집할 수 있다. `sawhorse`는 데스크톱과 같은 Rust 서비스를 호출하는
콘솔 실행 파일이다. 실행할 때 앱·Herdr·에이전트·MCP 서버를 시작하지 않는다.

## 설치

릴리스의 운영체제·CPU에 맞는 `sawhorse-cli-<version>-<target>` 파일을 내려받아 압축을 푼다.
macOS는 Apple Silicon(`aarch64-apple-darwin`)과 Intel(`x86_64-apple-darwin`),
Windows는 x64(`x86_64-pc-windows-msvc`)를 제공한다. `.sha256` 파일로 다운로드를 확인할 수 있다.
CLI 사용에는 Node.js, Python, Rust가 필요하지 않다.

macOS / Linux — 압축을 푼 폴더에서:

```sh
sh ./install.sh
export PATH="$HOME/.local/bin:$PATH"
sawhorse --version
```

설치 위치를 바꾸려면 `sh ./install.sh /원하는/bin`을 사용한다. `PATH` 설정을 유지하려면
사용하는 셸의 설정 파일에도 해당 디렉터리를 추가한다. 설치기는 셸 설정을 자동으로 바꾸지 않는다.

Windows PowerShell — 압축을 푼 폴더에서:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

기본 설치 위치는 `%LOCALAPPDATA%\Sawhorse\bin`이며 **사용자 PATH**에 추가한다.
설치 후 새 터미널에서 `sawhorse --version`을 실행한다. 설치 폴더를 지정하려면
`-BinDirectory 'D:\도구\Sawhorse'`, PATH 수정을 생략하려면 `-NoPathUpdate`를 사용한다.
압축만 풀고 `& '.\sawhorse.exe' --version`으로 직접 실행할 수도 있다.

소스에서 빌드·설치할 때는 데스크톱의 Rust/Tauri 빌드 의존성이 필요하다:

```sh
npm --prefix app ci
npm --prefix app run build
cargo install --path app/src-tauri --bin sawhorse --locked
```

`cargo run`과 Tauri 개발 실행의 기본 대상은 기존 데스크톱이다. CLI 개발 실행은
`cargo run --manifest-path app/src-tauri/Cargo.toml --bin sawhorse -- --help`로 지정한다.

## 작성 스킬 보급

```sh
sawhorse skill install --agent codex
sawhorse skill install --agent claude
```

CLI에 내장된 `sawhorse-workflow-author/SKILL.md`를 설치한다. Codex는 `CODEX_HOME/skills`
(기본 `~/.codex/skills`), Claude는 `CLAUDE_CONFIG_DIR/skills`(기본 `~/.claude/skills`)를 사용한다.
프로젝트나 다른 에이전트의 스킬 폴더는 `--dir '스킬 폴더'`로 지정한다. 같은 내용은 재설치하지
않으며 기존 내용이 다르면 보존하고 충돌을 반환한다. 검토 후 `--force`로 교체할 수 있다.
`sawhorse skill show`로 설치할 내용을 먼저 읽을 수 있다.

같은 스킬은 기존 Sawhorse 플러그인에도 포함된다. 플러그인으로 이미 제공받는 에이전트에는
별도 사본을 설치할 필요가 없다. 설치 후 에이전트의 스킬 목록을 새로 고치거나 새 세션을 시작한다.

## 작업공간 선택

선택 순서는 `--vault PATH` → `SAWHORSE_VAULT` → 현재 폴더부터 부모 방향으로 찾은
`.sawhorse/schema.json` 또는 `workspace.json` → 앱의 `~/.claude/sawhorse/config.json`의
`vaultPath`이다. 상대경로는 명령을 실행한 폴더 기준이다. 공백·한글 경로는 따옴표로 감싼다.

```sh
sawhorse workspace show --json
sawhorse workspace init --vault './팀 작업공간' --json
sawhorse workflow list --vault './팀 작업공간' --json
```

`workspace init`은 명시한 디렉터리를 생성·초기화하고 기존 파일을 보존한다. 글로벌 설정은
수정하지 않는다. 정의 파일 편집과 조회·검증·시뮬레이션은 워크플로우를 발행하지 않는다.
스키마와 스킬 조회는 작업공간이 없어도 가능하다. 등록할 작업공간이 없으면 발행·초안 저장·적용은 실패한다.

## 워크플로우 작성

다음 예시는 초기화된 작업공간 안에서 실행한다. `list`로 설치된 정확한 버전을 확인하고,
`schema`로 현재 지원 필드·열거값을 읽는다. `init`은 `--from ID@VERSION`을 생략하면 현재
기본 SDD 정의에서 시작한다.

```sh
sawhorse workflow list --json
sawhorse workflow schema --json
sawhorse workflow init customer-fix --output './고객 수정.json'
sawhorse workflow validate './고객 수정.json' --json
sawhorse workflow draft save './고객 수정.json' --id customer-fix --json
sawhorse workflow publish './고객 수정.json' --dry-run --json
sawhorse workflow publish './고객 수정.json' --json
sawhorse project list --json
sawhorse workflow activate customer-fix@1.0.0 --project my-project --json
```

`init`의 출력 JSON을 에이전트나 에디터로 수정한다. 새 정의를 발행해도 기존 작업은 이전
ID/version/digest를 유지한다. 프로젝트 적용은 **앞으로 만드는 작업의 기본값**을 바꾼다.
프로젝트 생성은 앱에서 할 수 있다.

노드 ID와 파일명은 Windows에서도 유효해야 한다. `CON`, `NUL`, `COM1`, 끝의 점/공백 등은
거부한다. 산출물 경로는 `/` 구분자와 `{workId}` / `{projectId}`를 사용한다.
명령행으로 넘기는 실제 파일 경로에는 운영체제의 기본 구분자를 사용할 수 있다.
정의 JSON의 알 수 없는 필드는 오타가 조용히 사라지지 않도록 오류로 반환한다.

## 시뮬레이션과 조합

`--events`는 다음과 같은 JSON 배열 파일을 읽는다. 이벤트 이름과 facts는 편집한 정의의
전환과 조건에 맞춘다. 이 예시가 모든 워크플로우의 완료 이벤트를 뜻하지는 않는다.

```json
[{"event":"approved","facts":{}},{"event":"completed","facts":{}}]
```

```sh
sawhorse workflow simulate './고객 수정.json' --events events.json --require-complete --json
sawhorse workflow validate parent.json --dependency child.json --json
sawhorse workflow simulate parent.json --dependency child.json --events events.json --json
sawhorse workflow publish parent.json child.json --json
```

검증은 누락된 정확한 하위 버전, 순환 참조, 같은 ID/version의 내용 충돌을 검사한다.
여러 정의는 파일 순서에 관계없이 자식부터 발행한다. 실제 쓰기 도중 I/O 오류가 발생하면
일부 유효한 버전이 남을 수 있으며 같은 입력으로 재실행하면 이어서 발행할 수 있다.

시뮬레이션은 앱과 같은 실행 엔진을 사용하되 실제 에이전트·명령·승인은 실행하지 않는다.
`waiting`은 입력 이벤트가 더 필요하다는 뜻이고 `paused`는 반복 한도 등에 걸린 상태다.
`--require-complete`는 완료되지 않은 결과를 실패로 처리해 자동 검증에 사용할 수 있다.

## 충돌과 내보내기

초안 업데이트는 마지막으로 읽은 revision을 전달한다. 충돌하면 새 내용을 읽고 수정 사항을
조정한다. 발행된 버전은 변경할 수 없으며 같은 내용의 재발행은 멱등적이다.

```sh
sawhorse workflow draft show customer-fix --json
sawhorse workflow draft save './고객 수정.json' --id customer-fix --expected-revision REVISION --json
sawhorse workflow show customer-fix@1.0.0 --json
sawhorse workflow export customer-fix@1.0.0 --output exported.json
sawhorse workflow import exported.json --id imported-customer --json
sawhorse project show my-project --json
sawhorse workflow activate customer-fix@1.0.0 --project my-project --expected-revision PROJECT-REVISION --json
```

데스크톱과 CLI의 저장은 OS 파일 잠금을 공유하며 종료·비정상 종료 시 잠금이 해제된다.
초안 저장은 읽었던 revision도 검사한다. 발행은 기존 파일을 원자적으로 덮어쓰지 않도록
생성하고, 프로젝트 적용은 사용자 정의 frontmatter와 설명을 보존한다.

`--output`은 UTF-8 원본 정의를 기록하며 기존 파일이 있으면 `--force` 없이는 덮지 않는다.
셸의 `>` 대신 사용하면 Windows PowerShell 버전에 따른 출력 인코딩 차이를 피할 수 있다.
입력은 UTF-8(BOM 포함)과 BOM이 있는 UTF-16 LE/BE를 지원한다. 정의 또는 이벤트 파일에
`-`를 주면 stdin으로 읽는다. 한 명령에서 stdin은 한 번만 사용할 수 있다.

## 에이전트용 계약

`--json`은 stdout에 JSON 객체 하나를 출력한다. 진단 문자열을 앞뒤에 섞지 않는다.

```json
{"schemaVersion":1,"ok":true,"data":{}}
```

실패는 `ok: false`와 `error: {code, message, details?}`로 반환한다. 검증의 `details.issues`에는
필드 경로와 오류 코드가 있고, 시뮬레이션 실패의 `details`에는 상태와 trace가 있다.

| 종료 코드 | 의미 |
|---|---|
| 0 | 성공 |
| 1 | 파일 접근 또는 실행 오류 |
| 2 | 명령 사용법, JSON 또는 입력 오류 |
| 3 | 정의 검증·발행 사전 검증·시뮬레이션 실패 |
| 4 | revision/파일 충돌 또는 다른 Sawhorse 프로세스가 쓰는 중 |

`--json`의 `data`는 명령별 결과다. 이를 그대로 정의 파일로 쓰지 말고 `export` 또는
`init --output`을 사용한다. CLI 계약 버전은 앱 버전과 별도로 `schemaVersion: 1`로 표시한다.

## 검증과 배포

`cargo test --test cli`는 실제 콘솔 실행 파일로 한글·공백 경로, PowerShell 호환 입력,
검증/시뮬레이션, 초안 충돌, 불변 발행, 하위 정의 조합, 프로젝트 적용, 프로세스 잠금,
스킬 설치를 검사한다. CI는 macOS·Windows·Linux 러너에서 같은 테스트를 실행한다.
릴리스는 테스트 통과 후 각 플랫폼 CLI와 설치기·스킬·문서를 별도 압축 파일로 제공한다.
