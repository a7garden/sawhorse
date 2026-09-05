# sawhorse

**로컬 에이전트 워크벤치.** 데스크톱 앱이 작업공간을 만들고, 확장을 관리하고,
터미널 에이전트(Claude Code·Codex)를 감독한다. 하는 일 — 업무일지, 보고, 위키, 문서화,
이슈 워크플로 — 은 전부 **확장(pack)** 이 정하고, 확장은 매니페스트 한 장이면 만들 수 있다.

```
┌ 앱(호스트) ──────────────────────────────────────────────┐
│  작업공간 · 잡 큐 · 예약 · 노트 질의 · 에이전트 브리지        │
│  ├ 확장: SI 업무   → 일지·사업·개념·이슈·마일스톤·보고 엑셀   │
│  ├ 확장: 기본 작업 → 기록·노트·주간 회고                     │
│  └ 확장: 당신이 만든 것                                     │
└──────────────────┬──────────────────────────────────────┘
      herdr 세션 / 백그라운드  →  Claude Code · Codex
```

## 시작하기 — 앱을 먼저 설치한다

```bash
cd dashboard
npm install
npm run tauri dev     # 개발 실행
npm run tauri build   # 배포 번들
```

앱을 처음 열면 마법사가 다섯 단계를 안내한다.

| 단계 | 하는 일 |
|---|---|
| 1 시작 | 무엇을 설치할지 안내 |
| 2 작업공간 | 노트가 쌓일 폴더 지정 (Obsidian 볼트 기록을 자동으로 찾아 준다. 없는 폴더면 만든다) |
| 3 확장 | 쓸 확장 선택 → **앱이 폴더·템플릿·인덱스를 직접 만든다** (에이전트 불필요) |
| 4 에이전트 | Claude Code·Codex·herdr 감지 → **앱이 확장의 스킬을 설치한다** |
| 5 완료 | 선택적으로 `init-vault`(Obsidian 설정 맞추기)·`setup`(환경 진단) 실행 |

4단계가 예전의 "플러그인 설치"다. 이제 앱 안에서 일어난다.

### Claude Code 플러그인으로 쓰고 싶다면

같은 내용물이 Claude Code 플러그인으로도 배포된다. 앱 없이 스킬만 쓰려면:

```
/plugin marketplace add a7garden/sawhorse
/plugin install sawhorse@sawhorse
```

둘 다 설치해도 되지만, 같은 슬래시 커맨드가 두 벌 뜬다 — 확장 화면이 이 상태를 감지해
알려준다.

## 화면

| 화면 | 하는 일 | 출처 |
|---|---|---|
| 홈 | 예약 카드(놓침 알림 포함), 오늘 할 일, 실행 중 잡, 진단 | 호스트 |
| 작업 | 잡 큐·실시간 타임라인·리포트·로그·취소 | 호스트 |
| 터미널 | herdr 워크스페이스/탭/에이전트, **승인 대기 세션**, 새 탭, 액션 실행 | 호스트 |
| 확장 | 팩 켜기/끄기, 에이전트 설치, 팩 설정, 스킬 문서 | 호스트 |
| 설정 | 작업공간·사업·실행 옵션·herdr·진단 | 호스트 |
| 이슈 · 할 일 · 마일스톤 · 개념 · 문서 · 볼트 | 노트 워크플로 | **SI 업무 확장** |
| 기록 · 노트 | 개인 작업 기록 | **기본 작업 확장** |

확장을 끄면 그 확장의 화면·예약·액션이 함께 사라진다(노트는 남는다).

## 확장(pack)

확장 하나가 "한 가지 일하는 방식" 전체다. 폴더 하나 + `pack.json` 한 장.

```
<pack>/
  pack.json               # 매니페스트
  skills/<name>/SKILL.md  # 에이전트에 설치될 스킬
  templates/*.md          # 작업공간에 깔릴 템플릿
  assets/**               # .base 등 부속 자산
```

매니페스트가 선언할 수 있는 것은 넷이다.

| 블록 | 뜻 | 호스트가 하는 일 |
|---|---|---|
| `workspace` | 쓰는 폴더·템플릿·자산 | 작업공간에 직접 만든다 (기존 파일은 덮지 않는다) |
| `settings` | 필요한 설정 항목 | 확장 화면에 폼을 **자동 생성** |
| `actions` | 할 수 있는 일 | 잡으로 실행 + 예약 대상 |
| `views` | 보여줄 화면 | 사이드바 페이지를 **코드 없이** 추가 |

```jsonc
{
  "id": "my-pack",
  "name": "내 작업 방식",
  "version": "1.0.0",
  "skills": ["capture"],
  "workspace": { "folders": ["기록"], "files": [{ "src": "templates/기록.md", "dest": "템플릿/기록.md" }] },
  "settings": [{ "key": "ownerName", "type": "text", "label": "이름" }],
  "actions": [
    { "id": "today", "label": "오늘 기록", "prompt": "/capture --today",
      "cwd": "workspace", "schedule": { "kind": "weekdays", "time": "09:00" } }
  ],
  "views": [
    { "id": "logs", "label": "기록", "icon": "calendar-days", "type": "notes",
      "query": { "folders": ["기록"], "sort": { "source": "title", "desc": true } },
      "columns": [{ "source": "title", "label": "날짜" }, { "field": "tags", "label": "태그", "type": "list" }] }
  ]
}
```

- `settings[].type` — `text` `path` `number` `bool` `select` `table`
- `actions[].params[].type` — `text` `list` `select` `project`, `cwd` — `workspace` `project` `path:<절대경로>`
- `views[].type` — `notes`(프론트매터 표) 또는 `native`(앱이 이미 가진 화면)
- `query` — `folders`(글로브 `*` 1단계) · `exclude` · `where`(`eq` `ne` `in` `contains` `exists` `truthy` `notEmpty`) · `sort` · `limit`

표현력의 상한은 의도한 것이다. 확장이 못 하는 일은 스킬(에이전트 본문)이 한다.

**만들려면**: `packs/starter/` 를 `~/.claude/sawhorse/packs/<내-팩>/` 으로 복사하고
`id` 를 바꾼 뒤 확장 화면에서 새로고침. 같은 `id` 의 사용자 팩은 내장 팩을 덮어쓴다
(내장 확장을 내 방식대로 고치는 경로다).

동봉 확장:

| 확장 | 내용 |
|---|---|
| `si` — SI 업무 | 일과 루틴 3종, 업무일지·보고, 위키, 사업 문서화, 이슈·마일스톤, 보고용 엑셀 |
| `starter` — 기본 작업 | 기록 한 장·빠른 캡처·주간 회고. 업종 어휘 없음. 팩 저작 예제 |

## 실행 기반 — herdr

잡은 두 실행기 중 하나에서 돈다.

- **herdr** (기본, 가능할 때): 잡마다 워크스페이스에 탭을 만들고 그 안에서 대화형
  `claude` 를 돌린다. 사람이 **보고 이어받을 수 있고**, 승인 프롬프트에 답할 수 있으며,
  앱을 재시작해도 세션이 살아 있다. 터미널 화면이 이 세계를 보여준다.
- **백그라운드**: `claude -p … --output-format stream-json`. herdr 가 없으면 자동 폴백.

터미널 화면은 승인 대기(`blocked`) 세션을 맨 위에 모아 보여준다 — 무인 실행이 사람을
기다리다 조용히 멈추는 것이 가장 비싼 실패이기 때문이다.

## 설정 정본

`~/.claude/sawhorse/config.json` — 앱과 플러그인이 같은 파일을 쓴다.
앱은 아는 키만 병합하고 나머지(키 순서 포함)를 보존한다.

```jsonc
{
  "vaultPath": "…",                                   // 작업공간 루트
  "improve": { "defaultProject": "…", "projects": { … } },  // SI 확장이 쓴다
  "dashboard": { "schedules": { "si.morning": { "enabled": true, "time": "09:00" } },
                 "claudeBin": "claude", "permissionMode": "bypassPermissions", "herdr": { … } },
  "packs": { "enabled": ["si", "starter"], "settings": { "starter": { "ownerName": "…" } } }
}
```

- 예약 키는 `<확장id>.<액션id>`. 예전 키(`morning`·`lunch`·`evening`)도 계속 읽는다.
- `packs.enabled` 가 **비어 있으면 전부 활성**이다 — 업그레이드했을 때 화면이 사라지지 않는다.

## SI 업무 확장

발주처 사업을 하는 사람을 위한 확장. 명령은 `/sawhorse:*` 슬래시 커맨드로도, 앱의
액션 버튼으로도 실행된다.

### 일과 루틴 (무인 실행 — 걸어두고 비워도 됩니다)

| 명령 | 하는 일 |
|---|---|
| `/sawhorse:morning` | 오늘 일지 준비 + 어제 `내일 할 일` 이월 + 어제 요약 + 볼트 빠른 정리 |
| `/sawhorse:lunch` | 오전 결산: 오늘 할 일 vs 오전 세션 대조 + 볼트 진단 (읽기 전용) |
| `/sawhorse:evening` | 체크 정리 → 일지 `업무기록` → 보고서 → `내일 할 일` → 볼트 정리 |

### 도구

| 명령 | 하는 일 |
|---|---|
| `/sawhorse:setup` | 설정·환경 진단 (Node/pandoc, 훅, MCP) |
| `/sawhorse:init-vault` | Obsidian 설정 맞추기 (템플릿 폴더·첨부 경로·프로퍼티 타입·시작 화면) |
| `/sawhorse:daily-log` | 오늘 세션 분석 → 일지 `## 업무기록` 갱신 |
| `/sawhorse:daily-report` | 업무 보고 형식 코드블록 생성 (복붙용) |
| `/sawhorse:project-doc` | 제안서 + 코드베이스로 사업 문서 등록 |
| `/sawhorse:codebase-docs` | 코드베이스 기능별 문서화 (mermaid + 스크린샷) |
| `/sawhorse:wiki` | 개념 노트 생성/정리 (모든 스킬이 따르는 규범) |
| `/sawhorse:vault-tidy` | 볼트 정규화 + 재구성·파편 병합 (로컬 git) |
| `/sawhorse:issues` | 이슈·마일스톤: 등록·설계·승인·실행·검증 |
| `/sawhorse:improve` | 호환 명령: 기존 개선 노트를 읽는 이전 진입점 |
| `/sawhorse:improve-excel` | 이슈 노트 → 발주처 보고용 체크리스트 엑셀 |

폴더·템플릿 생성은 이제 앱이 한다. `init-vault` 는 Obsidian 쪽 설정만 맡는다
(설치 여부·기존 설정 병합 판단이 필요한 부분).

### 작업공간 구조

```
<작업공간>/
  대시보드.md      # Obsidian 시작 화면
  템플릿/          # 사업·개념·일지·기능분석·회의·이슈·마일스톤
  일지/            # YYYY-MM-DD.md (+ 일지.base)
  사업/<사업명>/   # 허브 + 분석/ + 산출물/ + 회의/ + 이슈/ + 마일스톤/
  개념/            # 위키 노트 (+ 개념.base)
  첨부/스크린샷/ 첨부/다이어그램/
  기록/ 노트/ 보관/  # 기본 작업 확장
```

`.base` 는 Obsidian Bases 뷰 정의다. **지식은 항상 노트에 있다** — 전부 지워도 잃는 것은
보기 방식뿐이다. 거꾸로, 노트 프로퍼티에서 나오는 목록을 문서에 마크다운 표로 베껴 두지
않는다(상태가 두 곳에 있으면 반드시 어긋난다).

### 이슈·마일스톤 워크플로

새 이슈는 `사업/<사업명>/이슈/<ID접두어> 이슈목록.md` 에 적거나 `템플릿/이슈.md` 로 만든다.
자세한 필드와 GitHub 대응은 [이슈·마일스톤 설계](docs/issues-milestones-design.md) 참고.

모든 이슈는 노트 하나에 **배경 → 근거 → 설계 → 사람 승인 → 실행 → 검증 → 결과**를 남긴다.
`/sawhorse:issues 설계 <ID>` 로 설계하고, **볼트나 대시보드에서 사람이 승인 체크**한 뒤
`/sawhorse:issues 실행 <ID>` 로 실행한다. 승인은 코드를 고칠 권한을 여는 행위라
채팅의 "승인해줘"로는 열리지 않는다.

`svn` 은 조회 명령만 쓴다 — `commit`·`update`·`revert` 는 어떤 경우에도 실행하지 않는다.

### 보고 형식 예시

```
[코드 분석]
- 인증 모듈 오류 원인 규명 및 수정
- 배치 누락 건 재처리 로직 점검

[문서 작성]
- A사업 기능분석 문서 2건 작성
```

## 훅

- **SessionEnd** — 세션 종료마다 `~/.claude/sawhorse/journal/YYYY-MM-DD.jsonl` 에 한 줄.
  일지/보고 스킬이 이 저널을 읽는다.
- **PreToolUse** — `git push`, `svn commit/ci/import`, `git svn dcommit`, `hg push` 를
  감지하면 실행 전 확인 프롬프트를 띄운다. 로컬 `git commit` 은 확인 없이 실행된다.

## 요구사항

| 항목 | 필수 | 비고 |
|---|---|---|
| macOS / Windows 10+ / Linux | 필수 | 앱은 Tauri 2. 훅 스크립트는 PowerShell용(Windows) |
| Rust 도구체인 + Node 18+ | 앱 빌드에 필요 | 배포 번들을 쓰면 불필요 |
| Claude Code CLI | 권장 | 액션 실행에 필요. 없어도 앱은 뜬다 |
| herdr | 선택 | 잡을 사람이 볼 수 있는 터미널에서 돌리려면 |
| Obsidian | 선택 | SI 확장의 `.base` 뷰·시작 화면을 쓰려면 |
| pandoc | 선택 | docx 제안서 파싱. 없으면 Word 자동화로 폴백 |

## 자주 묻는 질문

**확장을 끄면 노트가 지워지나요?** 아니요. 사라지는 것은 화면·예약·액션뿐입니다.
작업공간의 파일은 그대로 남고, 다시 켜면 그대로 보입니다.

**앱이 내 스킬을 덮어쓰나요?** 아니요. 내용이 다르면 `수정됨` 으로 표시만 하고 남깁니다.
덮어쓰려면 확장 화면에서 「강제 설치」를 눌러야 합니다. 제거도 우리가 넣은 그대로인
파일만 지웁니다.

**일지를 하루에 여러 번 돌리면?** `## 업무기록` 안의 자동 영역(`sawhorse:auto:start`~`end`
마커 사이)만 다시 쓰입니다(멱등). `## 오늘 할 일`·`## 비고`·`## 내일 할 일` 은 자동 갱신
대상이 아닙니다.

**업무기록에 직접 손으로 적어도 되나요?** 됩니다. 자동 영역 밖의 글은 지워지지 않고,
성격에 따라 재가공됩니다(한 일 → 업무기록, "~할 것" → 내일 할 일, 개념 → 개념 노트 +
링크, 나머지 → 비고). 애매하면 원문 그대로 둡니다. 노트 수정 전 원본은
`~/.claude/sawhorse/backup/` 에 복사됩니다.

**morning 이 어제 할 일을 마음대로 옮기나요?** `오늘 할 일` 이 템플릿 초기 상태일 때만
이월합니다. 미리 적어 둔 날은 건드리지 않고 브리핑에만 표시합니다.

**push 마다 확인창이 떠요.** 회사 정책 반영입니다 — 원격 저장소 변경은 항상 1회 확인됩니다.
개인 저장소에 자주 push 한다면 `/hooks` 에서 이 훅만 끄세요.

**Playwright MCP 로드 에러가 나요.** Node.js 가 없을 때 나는 메시지로, 나머지 기능에는
영향이 없습니다. 스크린샷이 필요하면 Node.js 18+ 를 설치하세요.

## 문서

- [워크벤치 플랫폼 설계](docs/superpowers/specs/2026-09-05-workbench-platform-design.md) — 팩 아키텍처
- [대시보드 설계](docs/superpowers/specs/2026-09-04-dashboard-design.md) — 잡 실행기·herdr
- [이슈·마일스톤 설계](docs/issues-milestones-design.md)
- [전체 설계 문서](docs/design.md)

## 라이선스

MIT
