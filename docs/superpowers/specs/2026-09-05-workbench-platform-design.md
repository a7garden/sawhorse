# sawhorse 워크벤치 플랫폼 설계 — 대시보드가 호스트가 된다

날짜: 2026-09-05. 상태: 승인됨(사용자 위임 — "설계하고 구현까지 알아서 해").

## 배경 — 무엇이 어긋나 있었나

지금 저장소는 두 개의 물건이 한 곳에 있고, 그 둘의 주종 관계가 실제 사용 흐름과 반대다.

1. **플러그인이 주(主)**다. 설치 순서가 `/plugin marketplace add` → `/plugin install` →
   `/sawhorse:setup` → `/sawhorse:init-vault` 이고, 대시보드 앱은 그 결과물(볼트·config.json)을
   나중에 읽는 열람·조작 계층이다. 앱을 먼저 깔면 할 수 있는 일이 없다.
2. **둘이 따로 논다.** 대시보드는 `config.json` 을 읽지만 그 파일의 스키마 주인은 `setup` 스킬이고,
   볼트 폴더 구조를 알지만 그 구조를 만드는 것은 `init-vault` 스킬이다. 앱이 아는 것과
   앱이 만들 수 있는 것이 어긋나 있어, 앱은 항상 "플러그인이 이미 깔려 있고 이미 돌았다"를
   전제해야 한다.
3. **SI 업체 한 곳에 맞춰져 있다.** `사업/<사업명>/이슈/`, `일지/`, `개념/`, `개선.base`,
   `발주처 보고용 엑셀`, `improve.projects.<사업명>.workBranch`, SVN 금지 규칙 — 도메인 어휘가
   Rust 코드와 React 페이지에 하드코딩되어 있다. 다른 일을 하는 사람은 이 앱을 쓸 수 없고,
   쓰려면 소스를 고쳐야 한다.
4. **herdr 연계가 잡 실행기에만 있다.** herdr 는 이 앱의 실행 기반인데 UI 에서는 「작업」탭의
   부수 효과로만 보인다. 사용자가 herdr 워크스페이스·탭·에이전트를 앱에서 보고 다루지 못한다.

## 목표

**sawhorse 를 "로컬 에이전트 워크벤치 호스트"로 만든다.** 데스크톱 앱이 제품이고 런타임이며,
도메인 지식은 전부 **팩(pack, 확장)** 으로 밀어낸다. Claude Code 플러그인은 같은 내용물을
배포하는 여러 채널 중 하나로 내려온다.

| | 이전 | 이후 |
|---|---|---|
| 제품 | Claude Code 플러그인 | 워크벤치 데스크톱 앱 |
| 첫 설치 | `/plugin install` → `/sawhorse:setup` | 앱 설치 → 첫 실행 마법사 |
| 작업공간 생성 | `init-vault` 스킬(에이전트 필요) | 앱이 직접 만든다(에이전트 불필요) |
| 에이전트 | 앱의 전제 조건 | 앱이 감지하고 **설치해 주는 대상** |
| 도메인 로직 | Rust/React 하드코딩 | 팩 매니페스트(선언) |
| herdr | 잡 실행기 내부 구현 | 1급 화면 + 기본 실행기 |

### 비목표 (이번 판)

- 팩 원격 레지스트리·마켓플레이스 서버. 팩은 로컬 폴더에서 발견한다(설치는 폴더 복사).
- 팩 샌드박싱·권한 모델. 팩은 프롬프트와 노트 질의를 선언할 뿐 코드를 실행하지 않는다
  (스킬 본문은 에이전트가 실행하며, 그 신뢰 경계는 기존과 동일하다).
- 기존 SI 화면(이슈·할 일·문서·볼트)의 선언형 뷰 완전 이관. 이번엔 **레지스트리에 편입**해
  팩이 끄고 켤 수 있게만 하고, 내부 구현은 그대로 둔다.
- 볼트 노트 편집기. 뷰어는 읽기 전용을 유지한다.

## 핵심 개념: 팩(pack) = 확장

**팩 하나가 "한 가지 일하는 방식" 전체다.** 폴더 하나 + 매니페스트 하나.

```
<pack>/
  pack.json                 # 매니페스트 (아래 스키마)
  skills/<name>/SKILL.md    # 에이전트에 설치될 스킬 (사용자 팩)
  templates/*.md            # 작업공간에 깔릴 노트 템플릿
  assets/**                 # .base 등 부속 자산
```

팩이 선언할 수 있는 것은 네 가지다.

| 블록 | 뜻 | 호스트가 하는 일 |
|---|---|---|
| `workspace` | 이 팩이 쓰는 폴더·템플릿·자산 | 작업공간 프로비저닝(앱이 직접 파일 생성) |
| `settings` | 이 팩이 필요로 하는 설정 항목 | 설정 화면에 폼을 **자동 생성** |
| `actions` | 이 팩이 할 수 있는 일 | 잡 큐에 넣을 수 있는 실행 단위 + 예약 대상 |
| `views` | 이 팩이 보여줄 화면 | 사이드바 페이지를 **코드 없이** 추가 |

`skills` 는 위 넷을 에이전트 쪽에서 수행하는 본문이고, 호스트는 그 파일을 **설치**만 한다.

### pack.json 스키마

```jsonc
{
  "id": "si",                        // [a-z0-9-] 소문자 슬러그. 설정 네임스페이스 키
  "name": "SI 업무",
  "version": "1.0.0",
  "description": "…",
  "author": "won",
  "icon": "briefcase",               // lucide 아이콘 이름
  "skills": ["morning", "issues"],   // 에이전트에 설치할 스킬 디렉터리 이름

  "workspace": {
    "folders": ["일지", "사업", "개념"],
    "files": [                       // 없을 때만 복사. 기존 파일은 절대 덮지 않는다
      { "src": "templates/일지.md", "dest": "템플릿/일지.md" },
      { "src": "assets/bases/이슈.base", "dest": "사업/이슈.base" }
    ]
  },

  "settings": [                      // 값은 config.json 의 packs.<id>.settings 에 저장
    { "key": "excelOutputDir", "type": "path", "label": "엑셀 출력 폴더" },
    { "key": "projects", "type": "table", "label": "사업",
      "columns": [{ "key": "name", "label": "사업명" }, { "key": "path", "label": "경로", "type": "path" }] }
  ],

  "actions": [
    { "id": "morning", "label": "아침 브리핑", "prompt": "/sawhorse:morning",
      "cwd": "workspace", "schedule": { "kind": "daily", "time": "09:00" } },
    { "id": "design", "label": "이슈 설계", "prompt": "/sawhorse:issues 설계 {{ids}}",
      "cwd": "project", "params": [{ "key": "ids", "type": "list", "label": "이슈 ID" }] }
  ],

  "views": [
    { "id": "issues", "label": "이슈", "icon": "list-checks", "kind": "notes",
      "query": { "folders": ["사업/*/이슈"], "exclude": ["*목록.md"],
                 "where": [{ "field": "type", "op": "eq", "value": "이슈" }] },
      "columns": [{ "field": "id", "label": "ID", "width": 90 },
                  { "field": "title", "label": "제목", "source": "title" }],
      "groupBy": "status",
      "actions": ["design"] }
  ]
}
```

**타입은 다섯 개뿐이다.** `settings[].type` = `text | path | number | bool | select | table`,
`actions[].params[].type` = `text | list | select | project`,
`views[].kind` = `notes`(프론트매터 표) — 이 이상은 팩이 React 를 들고 오게 만들지 않기 위해
일부러 늘리지 않는다. 표현력이 모자란 팩은 스킬로 처리하고 결과를 노트에 남기면 된다.

### 왜 "선언"인가

팩이 코드를 들고 오면 (a) 앱 버전마다 깨지고 (b) 신뢰 경계가 생기고 (c) 배포가 무거워진다.
선언만 받으면 팩은 텍스트 파일 몇 개이고, 호스트가 렌더·검증·실행을 전담한다.
**표현력의 상한은 의도한 것이다** — 팩이 못 하는 일은 스킬(에이전트 본문)이 한다.

### 팩 해석 순서

1. **내장 팩** — 저장소/앱 번들의 `packs/*/pack.json`. `skills` 는 플러그인 루트의 `skills/` 에서 찾는다
   (Claude Code 플러그인 규약상 `skills/` 는 루트에 있어야 하므로 물리 이동 없이 이름으로 참조).
2. **사용자 팩** — `~/.claude/sawhorse/packs/<id>/pack.json`. `skills` 는 팩 폴더 안의 `skills/` 에서 찾는다.
3. 같은 `id` 면 사용자 팩이 이긴다(내장 팩 덮어쓰기 = 사용자 커스터마이즈 경로).

활성화 상태는 `config.json` 의 `packs.enabled: ["si", …]`. **비어 있으면 전부 활성**으로 해석한다
(기존 사용자가 업그레이드했을 때 화면이 사라지지 않게 하는 마이그레이션 규칙).

## 저장소 정본

```json
{
  "vaultPath": "…",                        // 기존 (플러그인도 읽음) = 작업공간 루트
  "improve": { "defaultProject": "…", "projects": { … } },   // 기존 (SI 팩이 계속 씀)
  "dashboard": { "schedules": { … }, "claudeBin": "…", "herdr": { … } },  // 기존
  "packs": {                               // 신규. 호스트 소유
    "enabled": ["si"],
    "settings": { "si": { "excelOutputDir": "…" } }
  }
}
```

- **알려진 키만 병합하고 나머지는 보존**하는 기존 규칙을 그대로 지킨다. 플러그인은 `packs` 를
  모르는 키로 무시하고, 앱은 `improve` 를 SI 팩 설정으로 읽는다.
- 예약은 `dashboard.schedules` 한 곳으로 모은다. 키는 **`<packId>.<actionId>`**
  (예: `si.morning`). 기존 `morning`/`lunch`/`evening` 키는 **읽기 별칭**으로 계속 지원한다
  (`si.morning` 이 없으면 `morning` 을 본다). 새로 저장할 때는 정규 키를 쓴다.

## 호스트 런타임 (Rust)

신규 모듈 넷:

```
src-tauri/src/
  packs.rs       매니페스트 스키마·발견·레지스트리·활성화·액션 해석·프롬프트 렌더
  notes.rs       선언형 노트 질의 엔진 (뷰의 데이터 소스)
  agents.rs      에이전트 감지 + 스킬 설치/제거/상태 (에이전트 브리지)
  workspace.rs   작업공간 프로비저닝 (폴더·템플릿·자산, 에이전트 불필요)
```

기존 모듈 변경:

| 모듈 | 변경 |
|---|---|
| `config.rs` | `packs` 블록(활성 목록·팩별 설정) 로드/저장, 스케줄 키 정규화·별칭 |
| `jobs.rs` | 잡 종류 `action` 추가 — `{ packId, actionId, params }` → 프롬프트 템플릿 렌더 + cwd 해석 |
| `scheduler.rs` | 하드코딩 루틴 3개 → **예약 가능한 팩 액션** 목록. `decide()` 순수 함수는 그대로 |
| `herdr.rs` | `workspace list` / `tab list` / `agent list` 래퍼 추가 (터미널 화면용) |
| `commands.rs` | 신규 커맨드 20여 개 |

### 노트 질의 엔진 (`notes.rs`)

뷰의 데이터 소스. 볼트를 걸어 프론트매터를 파싱하고 조건으로 거른다.

```rust
NoteQuery { folders: Vec<String>,   // 글로브. "사업/*/이슈"
            exclude: Vec<String>,   // 파일명 글로브
            where_: Vec<Predicate>, // field op value
            sort: Option<Sort>, limit: Option<usize> }
Predicate { field, op: Eq|Ne|In|Contains|Exists|Truthy, value }
```

반환은 `NoteRow { path, rel, title, mtimeMs, fields: Map<String, Json> }` — **필드는 프론트매터
그대로**이고 호스트는 의미를 모른다. 컬럼 라벨·순서는 뷰가 정한다.

`title` 은 `# 제목` 첫 헤딩 → 없으면 파일명. `source: "title"` 컬럼이 이것을 쓴다.

**설계상 중요한 제약**: 질의 엔진은 볼트 밖을 읽지 않는다(경로 정규화 후 루트 접두 검사).
글로브는 `*` 한 단계만 지원한다 — `**` 를 허용하면 큰 볼트에서 UI 가 멈춘다.

### 에이전트 브리지 (`agents.rs`)

앱이 에이전트를 **설치 대상으로 다룬다**. 이것이 주종 역전의 실체다.

| 에이전트 | 감지 | 설치 위치 | 형식 |
|---|---|---|---|
| Claude Code | `claude --version` | `~/.claude/skills/<name>/SKILL.md` | 원본 그대로 |
| Codex | `codex --version` | `~/.codex/prompts/<name>.md` | 프론트매터를 안내문으로 치환한 파생본 |
| herdr | `herdr --version` + 서버 도달 | — | 실행 기반(설치 대상 아님) |

상태는 셋: `설치됨`(내용 동일) · `갱신 필요`(내용 다름) · `미설치`. 판정은 파일 바이트 비교로
한다 — 해시 장부를 따로 두면 사용자가 손으로 고친 스킬을 앱이 조용히 덮어쓴다.

**설치는 언제나 사용자 행위다.** 앱은 첫 실행 마법사와 확장 화면에서 버튼으로만 설치하고,
백그라운드에서 몰래 쓰지 않는다. 제거는 우리가 설치한 파일만 지운다(내용이 다르면 남긴다).

### 작업공간 프로비저닝 (`workspace.rs`)

활성 팩들의 `workspace` 블록을 합쳐 폴더를 만들고 파일을 **없을 때만** 복사한다.
`init-vault` 스킬이 하던 일 중 **에이전트 판단이 필요 없는 부분**을 앱으로 가져온 것이다.
결과는 `{ created: [], skipped: [], failed: [] }` 로 보고한다.

`.obsidian/*` 설정(templates.json·app.json·types.json·homepage)은 그대로 `init-vault` 스킬에
남긴다 — Obsidian 설치 여부·기존 설정 병합 판단이 필요하고, 그건 에이전트가 잘하는 일이다.

### 잡: 팩 액션

```rust
JobRequest { kind: "action", pack_id, action_id, params: Map<String, Json>, … }
```

- 프롬프트: 액션의 `prompt` 템플릿에 `{{key}}` 치환. 리스트 파라미터는 공백 조인.
  **치환값은 개행·백틱을 제거**한다(프롬프트 인젝션이 아니라 셸/슬래시커맨드 오작동 방지).
- cwd: `workspace`(볼트) · `project`(파라미터 `project` → SI 팩 `improve.projects.<name>.path`,
  없으면 볼트 폴백) · `path:<절대경로>`.
- 라벨: `<액션 라벨> (<팩 이름>)`. 기존 `design|implement|routine|excel` 잡 종류는 그대로 두고
  내부적으로 같은 실행 경로를 탄다 — 히스토리(`jobs.jsonl`)가 과거 형식으로 남아 있기 때문이다.

### 스케줄러 일반화

```rust
ScheduledEntry { key: "si.morning", pack_id, action_id, label, time, enabled }
```

`decide()`(순수 함수, grace 2분, 자동 보상 실행 금지)는 손대지 않고 **엔트리 목록만
팩에서 만들어 넣는다**. `MissedEntry.routine` 은 그대로 두되 키에 `si.morning` 이 들어간다
(serde 호환 유지). 이 구조는 진행 중인 «워크벤치 작업 시스템»(에이전트가 만드는 예약)의
`ScheduledEntry` 어댑터와 같은 자리이며, 그 작업은 여기에 `kind: task` 엔트리를 더하면 된다.

## 프론트엔드

### 사이드바가 레지스트리에서 생성된다

```
홈 · 작업 · 터미널        ← 호스트 코어 (항상)
─────
[팩이 기여한 뷰들]        ← 활성 팩의 views (네이티브 + 선언형)
─────
확장 · 설정               ← 호스트 코어 (항상)
```

`App.tsx` 의 `switch` 문과 `PageId` 유니온을 없애고 `NavEntry[]` 를 순회한다.
기존 SI 화면(이슈·할 일·문서·볼트)은 SI 팩 매니페스트에 `"kind": "native", "component": "issues"`
로 등재해 레지스트리를 거치게 한다 — **팩을 끄면 화면도 사라진다**가 성립해야
"확장으로 조립된 앱"이라는 말이 참이 된다.

### 신규 화면 셋

1. **확장 (`PacksPage`)** — 설치된 팩 목록/활성 토글, 팩별 설정 폼(스키마에서 자동 생성),
   기여 목록(뷰·액션·스킬), 에이전트 설치 상태와 설치 버튼, 스킬 본문 뷰어.
   기존 「플러그인」 페이지를 흡수한다(플러그인 메타데이터는 내장 팩의 출처로 표시).
2. **터미널 (`TerminalPage`)** — herdr 서버 상태, 워크스페이스·탭·에이전트 트리,
   승인 대기(`blocked`) 강조, 포커스/열기/새 탭(작업공간 또는 사업 경로), 액션을 herdr 탭으로 실행.
3. **선언형 뷰 (`PackViewPage`)** — `kind: notes` 뷰 렌더러. 표 + 그룹 탭 + 검색 +
   행 선택 → 노트 미리보기 + 액션 버튼.

### 첫 실행 마법사 (대시보드 우선 온보딩)

```
1 환영     앱이 무엇인지, 무엇을 설치할 것인지
2 작업공간  볼트 선택/생성 (Obsidian 기록 감지, 없으면 새 폴더)
3 에이전트  claude/codex/herdr 감지 → 스킬 설치 (여기서 "플러그인"이 설치된다)
4 확장     팩 선택 (SI 업무 / 기본 작업 …) → 작업공간 프로비저닝
5 완료     선택적으로 init-vault·setup 잡 실행
```

3단계가 이번 재구성의 핵심이다. **플러그인 설치가 앱 안에서 일어난다.**

## 팩 두 개를 함께 낸다

| 팩 | 목적 |
|---|---|
| `si` | 지금 있는 전부(일지·사업·개념·이슈/마일스톤·개선 엑셀·루틴 3종). **동작 동일** |
| `starter` | SI 어휘가 하나도 없는 최소 팩. 데일리 노트 + 할 일 캡처 + 주간 회고. 범용성의 증거이자 팩 저작 예제 |

`starter` 가 있어야 "이 앱이 SI 전용이 아니다"가 코드로 증명된다. 팩을 만들려는 사용자는
`starter/pack.json` 을 복사해 시작한다.

## 호환성 계약

1. 기존 `config.json` 은 그대로 동작한다. `packs` 가 없으면 **모든 팩이 활성**.
2. 기존 커맨드(`list_issues`, `run_routine_now`, `enqueue_job{kind:"routine"}` …)는 남는다.
3. 기존 잡 히스토리(`jobs.jsonl`)는 그대로 읽힌다 — 새 필드는 전부 `#[serde(default)]`.
4. Claude Code 플러그인 설치 경로(`/plugin install sawhorse@sawhorse`)는 계속 유효하다.
   앱이 설치하는 개인 스킬(`~/.claude/skills/`)과 플러그인 스킬은 **중복 등록될 수 있다** —
   확장 화면이 이 상태를 감지해 "플러그인으로 이미 제공됨" 으로 표시하고 설치를 권하지 않는다.
5. 기존 예약 키(`schedules.morning`)는 읽기 별칭으로 유지. 저장 시 정규 키로 승격.

## 오류 처리

- 팩 매니페스트 파싱 실패 → 그 팩만 `invalid` 로 표시하고 사유를 확장 화면에 낸다. 앱은 뜬다.
- 뷰 질의 실패(폴더 없음) → 빈 표 + "이 폴더가 아직 없습니다" 안내. 오류 아님.
- 스킬 설치 실패(권한·경로) → 팩별 상태에 사유 표시. 다른 팩 설치는 계속.
- 프로비저닝 실패 → `failed[]` 에 경로+사유. 부분 성공을 그대로 보고한다.
- herdr 서버 부재 → 터미널 화면이 설치·기동 안내 카드로 바뀐다(오류 아님).

## 테스트

Rust 단위:
- 매니페스트 파싱(정상/필수 누락/알 수 없는 타입/중복 id), 발견 우선순위(사용자 > 내장),
  활성 해석(빈 목록 = 전부).
- 프롬프트 렌더(치환·리스트 조인·미지정 파라미터·개행 제거), cwd 해석 4경로.
- 질의 엔진(글로브 매칭, 프론트매터 술어 6종, exclude, 정렬, 볼트 탈출 차단).
- 스케줄 키 정규화·별칭 폴백, 팩 액션 예약 엔트리 생성.
- 에이전트 설치 상태 판정(동일/상이/부재), 설치·제거 왕복, 파생본(Codex) 변환.
- 프로비저닝(신규 생성·기존 보존·부분 실패).
- config `packs` 블록 저장 시 알 수 없는 키 보존.

프론트: `tsc --noEmit` + `vite build`.
수동 스모크: 마법사 5단계, 확장 켜기/끄기 → 사이드바 반영, 터미널 화면의 실제 herdr 목록.

## 위험과 완화

| 위험 | 완화 |
|---|---|
| 형제 세션(`feat/workbench-tasks`)과 `scheduler.rs` 충돌 | `decide()` 순수 함수를 건드리지 않고 엔트리 소스만 교체. 같은 `ScheduledEntry` 이름·모양 사용 |
| 팩을 끄면 화면이 사라져 사용자가 당황 | 확장 화면에 "끄면 사라지는 화면" 을 명시. 기본은 전부 활성 |
| 선언형 뷰의 표현력 부족 | 네이티브 뷰(`kind: native`)를 같은 레지스트리에 공존시켜 점진 이관 |
| 앱이 스킬을 설치해 플러그인과 중복 | 중복 감지 후 설치 권유 억제(호환성 계약 4) |
| 큰 볼트에서 질의 지연 | 글로브 1단계 제한, 결과 상한, 프론트매터만 파싱(본문은 선택 시 읽음) |
