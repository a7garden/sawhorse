# 문서·자동화 팩 만들기

팩은 지식 문서와 자동화 루틴을 묶는다. 작업의 단계·승인·산출물은 앱의 공통 워크플로우가 관리한다. 설치 권한·의존성을 가진 새 기능은 [확장 패키지 v2](../extension-packages/README.md)를 사용한다.
**코드는 필요 없다** — 선언하면 앱이 렌더·검증·실행을 맡는다.

## 5분 만에 만들기

```bash
cp -R packs/starter ~/.claude/sawhorse/packs/my-pack
# pack.json 의 "id" 를 "my-pack" 으로 바꾼다 (소문자·숫자·하이픈)
```

앱의 **확장 관리**에서 새로고침하면 목록에 나타난다. `views`가 있는 팩만 업무 화면을 추가한다.

같은 `id` 의 사용자 팩은 내장 팩을 **덮어쓴다**. 내장 SI 확장을 내 방식대로 고치고
싶으면 `packs/si/` 를 `~/.claude/sawhorse/packs/si/` 로 복사해 고치면 된다.

## 폴더

```
<pack>/
  pack.json               # 매니페스트 (필수)
  skills/<name>/SKILL.md  # 에이전트에 설치될 스킬
  templates/*.md          # 작업공간에 깔릴 템플릿
  assets/**               # .base 등 부속 자산
```

## 매니페스트

| 키 | 뜻 |
|---|---|
| `id` | 소문자·숫자·하이픈. 설정 네임스페이스 키가 된다 |
| `name` `version` `description` `author` `icon` | 확장 화면에 보이는 것. `icon` 은 lucide 이름(kebab-case) |
| `skills` | 에이전트에 설치할 스킬 디렉터리 이름 |
| `workspace` | `folders[]` 와 `files[{src,dest}]`. **기존 파일은 덮지 않는다** |
| `settings` | 확장 화면이 폼을 자동 생성. 값은 `config.json` 의 `packs.settings.<id>` |
| `actions` | 실행 단위. 잡 큐에 들어가고 예약 대상이 된다 |
| `views` | 사이드바 카테고리 아래에 추가할 화면 |

### actions

```jsonc
{ "id": "review", "label": "주간 회고", "description": "…",
  "prompt": "/weekly-review {{week}}",       // {{key}} 가 파라미터 자리
  "cwd": "workspace",                        // workspace | project | path:/절대/경로
  "featured": true,
  "params": [{ "key": "week", "type": "text", "label": "기준 날짜", "required": false }],
  "schedule": { "kind": "weekdays", "time": "17:30" } }   // daily | weekdays
```

- 파라미터 타입: `text` `list`(공백으로 이어 붙음) `select`(`options[]`) `project`.
- 치환값에서 개행·백틱은 지워진다(슬래시 커맨드가 한 줄로 전달되는 경로가 있다).
  **템플릿 자체의 줄바꿈은 보존된다** — 여러 줄짜리 무인 실행 지시를 써도 된다.
- 채워지지 않은 `{{key}}` 는 흔적 없이 사라진다.
- `schedule` 이 있으면 앱의 예약 목록에 뜬다. 사용자가 시각을 바꾸면
  `dashboard.schedules["<id>.<actionId>"]` 에 저장되고 매니페스트 값을 덮는다.

### views

```jsonc
{ "id": "logs", "label": "일지", "icon": "calendar-days", "group": "vault", "type": "notes",
  "query": {
    "folders": ["일지", "문서"],        // 글로브는 `*` 한 단계만
    "exclude": ["*목록.md", "*.base"],
    "where": [{ "field": "type", "op": "eq", "value": "문서" }],
    "sort": { "source": "title", "desc": true },   // source: "" | "title" | "mtime"
    "limit": 120
  },
  "columns": [
    { "source": "title", "label": "제목" },        // 노트에서 오는 값
    { "field": "status", "label": "상태", "type": "badge", "width": 90 },
    { "field": "tags", "label": "태그", "type": "list" }
  ],
  "groupBy": "status",                        // 프론트매터 필드 → 상단 그룹 탭
  "actions": ["review"],                      // 이 화면에서 실행할 액션 id
  "empty": "아직 없습니다. …" }
```

- `group: "vault"`인 화면은 사이드바의 `볼트` 카테고리 아래에서 `모든 문서`와 함께
  표시한다. 폴더 전체 탐색은 `모든 문서`, 유형별 목록은 선언형 `notes` 뷰를 쓴다.
- 술어 연산자: `eq` `ne` `in` `contains` `exists` `truthy` `notEmpty`.
  모르는 연산자는 거르지 않는다(오타로 화면이 비지 않게).
- 컬럼 타입: `text` `badge` `list` `check` `date`.
- `source` 는 프론트매터가 아니라 노트 자체에서 오는 값: `title`(첫 `# 헤딩`, 없으면 파일명)
  `mtime` `path`.
- `type: "native"` 는 앱이 이미 가진 업무 화면(`issues` `todos` `vault`)을 가리킨다.
  내장 SI 확장만 쓴다.

### settings

```jsonc
{ "key": "ownerName", "type": "text", "label": "이름",
  "description": "회고 문서에 적을 이름", "placeholder": "예: 김워크" }
```

타입: `text` `path` `number` `bool` `select`(`options[{value,label}]`)
`table`(`columns[{key,label}]`).

값은 `~/.claude/sawhorse/config.json` 의 `packs.settings.<packId>` 에 저장된다.
**스킬이 그 값을 읽는다** — SKILL.md 에 어느 키를 읽는지 적어 두는 것이 계약이다.

## 규칙 세 가지

1. **호스트는 필드의 뜻을 모른다.** 프론트매터를 그대로 싣고, 의미는 매니페스트가 정한다.
   그래서 어떤 스키마를 쓰든 상관없다.
2. **기존 파일은 덮지 않는다.** `workspace.files` 는 없을 때만 복사하고, 스킬 설치는
   내용이 다르면 `수정됨` 으로 표시만 한다.
3. **꺼진 팩은 없는 팩이다.** 화면·예약·액션이 함께 사라진다(노트는 남는다).

## 흔한 실수

| 증상 | 원인 |
|---|---|
| 목록에 안 뜬다 | `id` 가 소문자·숫자·하이픈이 아니거나 JSON 파싱 실패. 확장 화면 상단의 「읽지 못한 확장」에 사유가 나온다 |
| 화면이 비어 있다 | `folders` 글로브가 실제 폴더와 안 맞거나 `where` 가 너무 좁다. 헤더의 "N개 폴더" 로 확인 |
| 설치 버튼이 아무것도 안 한다 | `skills[]` 에 적은 이름의 `SKILL.md` 가 실제로 없다 (`본문 없음` 배지) |
| 작업공간에 아무것도 안 생긴다 | 이미 다 있거나, `files[].src` 가 팩 폴더 기준이 아니다 |
| 예약이 안 돈다 | 팩이 꺼져 있거나 작업공간 경로가 비어 있다. 놓친 예약은 홈 카드로만 뜬다(자동 실행 없음) |

## 번들 정합성

`pack.json`의 `skills`가 공개 스킬의 정본이다. 실제 스킬 폴더와 선언이 일치해야 하고, 액션은 선언된 스킬을 호출해야 한다. 폐지한 스킬은 선언과 폴더를 함께 제거한다.

다른 팩과 충돌할 수 있는 템플릿은 `템플릿/<pack-id>/`에 둔다. 기존 사용자 파일은 덮어쓰지 않는다. 코어 레코드나 과거 이슈·개선 템플릿을 팩 초기화로 다시 만들지 않는다.

저장소 루트에서 `node plugin/validate.mjs`로 선언·시드·스킬 참조를 검사한다.
