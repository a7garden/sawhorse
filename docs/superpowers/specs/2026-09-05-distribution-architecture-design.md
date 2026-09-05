# 배포 아키텍처 설계 — 앱과 플러그인을 하나의 제품으로

2026-09-05

## 문제

앱과 플러그인이 **서로를 반쯤 가정하고 있다.** 둘 중 하나만 깔면 깨지고,
둘 다 깔면 중복된다. 근거:

| 관찰 | 위치 |
|---|---|
| si 팩에 `skills/` 가 없다 → 플러그인 루트의 `skills/` 로 폴백 | `packs.rs` (`내장 팩은 플러그인 skills/ 를 본다`) |
| si 팩 액션은 전부 `/sawhorse:<name>` — **플러그인** 네임스페이스 | `packs/si/pack.json` |
| starter 팩 액션은 `/capture` — **개인 스킬** 네임스페이스 | `packs/starter/pack.json` |
| 앱 설치기는 둘 다 `~/.claude/skills/<name>/SKILL.md` 로 쓴다 = 개인 스킬 | `agents.rs: skill_target` |
| si 스킬 14개 중 **9개가 `${CLAUDE_PLUGIN_ROOT}`** 를 쓴다 | `skills/*/SKILL.md` |
| 앱은 `${CLAUDE_PLUGIN_ROOT}` 를 치환하지 않고 그대로 복사한다 | `agents.rs: render_for` |
| 앱의 내장 잡도 `/sawhorse:morning` 등을 하드코딩 | `jobs.rs` |

개인 스킬에는 `${CLAUDE_PLUGIN_ROOT}` 가 정의되지 않고, 슬래시 커맨드도
`/<name>` 이지 `/sawhorse:<name>` 이 아니다. 따라서:

> **앱만 설치하면 si 팩은 명령 이름도 안 맞고 스크립트 경로도 죽는다.**
> 지금 동작한다면 그건 마켓플레이스 플러그인이 같이 깔려 있어서고,
> 그 경우 앱이 깐 개인 스킬 14개는 순수한 중복이다.

`PacksPage.tsx` 의 "같은 명령이 두 벌로 뜹니다" 경고는 이 설계 결함의 증상이지
원인이 아니다.

## 왜 프롬프트 주입으로 대체할 수 없나

"플러그인을 없애고 앱이 프롬프트를 주입한다"는 성립하지 않는다.

1. **스킬은 점진적 공개다.** Claude 가 필요할 때 SKILL.md 를 읽는다.
   14개 본문을 매 프롬프트에 넣으면 설계 자체가 무너진다.
2. **훅은 주입 불가능하다.** SessionEnd 저널은 런타임 인터셉터고,
   `daily-log`·`daily-report` 가 그 저널을 읽는다.
3. **herdr 세션은 대화형이다.** 사람이 이어받아 직접 `/sawhorse:evening` 을
   친다. 등록된 커맨드여야 한다.

## 열쇠 — skills-dir 플러그인

`~/.claude/skills/<name>/` 에 `.claude-plugin/plugin.json` 이 있으면
**마켓플레이스도 설치 단계도 없이** `<name>@skills-dir` 로 자동 로드된다.
개인 스코프는 신뢰 게이트도 제약도 없다. 지원 범위:

- 스킬 (`/<name>:<skill>` 네임스페이스) · 훅 · `.mcp.json` · 에이전트
- **`${CLAUDE_PLUGIN_ROOT}` 가 그대로 정의된다**

즉 "플러그인이냐 우리가 주입하느냐"는 양자택일이 아니다.
**앱이 플러그인을 주입한다.**

## 설계 — 콘텐츠 계층 하나, 전달 경로 셋

```
sawhorse/
  .claude-plugin/marketplace.json    # source: "./plugin"
  plugin/                            # ← 콘텐츠 계층 = 배포 단위
    .claude-plugin/plugin.json       #   skills: ["./packs/si/skills", "./packs/starter/skills"]
    hooks/hooks.json                 #   node 기반 (크로스플랫폼)
    hooks/journal-append.mjs
    hooks/block-push.mjs
    scripts/vault-hygiene.mjs
    .mcp.json
    packs/
      si/      { pack.json, skills/, templates/, assets/ }
      starter/ { pack.json, skills/, templates/ }
  app/                               # dashboard/ 를 개명 — Tauri 호스트
  docs/
```

**`plugin/` 이 곧 제품의 콘텐츠 전부다.** 앱은 이걸 통째로 리소스로
번들하고, 사용자 머신에 그대로 펼친다.

| 경로 | 방법 | 결과 |
|---|---|---|
| **앱** | 번들된 `plugin/` 을 `~/.claude/skills/sawhorse/` 로 materialize | `sawhorse@skills-dir` |
| **마켓플레이스** | `source: "./plugin"` → `plugin/` 만 클론 | `sawhorse@sawhorse` |
| **개발** | `claude --plugin-dir ./plugin` | 로컬 우선 |

셋 다 **같은 네임스페이스 `/sawhorse:*`, 같은 `${CLAUDE_PLUGIN_ROOT}` 의미,
같은 훅.** 앱의 하드코딩된 `/sawhorse:morning` 이 세 경로 모두에서 맞는다.

`init-vault` 스킬이 이미 `${CLAUDE_PLUGIN_ROOT}/packs/si/templates/*.md` 를
참조한다 — 스킬들은 **이미 이 레이아웃을 가정하고 쓰였다.**

### 중복 제거

앱은 이미 `installed_plugins.json` 을 읽어 마켓플레이스 설치를 감지한다
(`agents.rs: plugin_installs`). 감지되면 skills-dir 사본을 **쓰지 않는다.**
같은 네임스페이스라 사용자에게는 차이가 없다 — 훅이 두 번 도는 문제도 사라진다.

### 팩과 스킬의 소유권

폴백(`내장 팩은 플러그인 skills/ 를 본다`)을 **삭제한다.** 모든 팩이 자기
`skills/` 를 갖고, `plugin.json` 의 `skills` 배열이 이를 선언한다.
루트 `skills/` 는 없어진다. 불변식: **팩이 자기 스킬을 소유한다.**

## 결정 1 — 사용자 팩은 자기 네임스페이스를 갖는다

내장 팩(si·starter)은 `sawhorse` 플러그인 안에 있으므로 `/sawhorse:<skill>`.
사용자 팩(`~/.claude/sawhorse/packs/<id>/`)은 **별도 skills-dir 플러그인**
`~/.claude/skills/sawhorse-<id>/` 로 설치되어 `/sawhorse-<id>:<skill>` 이 된다.

한 폴더 = 한 팩 = 한 플러그인. 팩을 켜면 폴더를 쓰고, 끄면 지운다. 이름 충돌이
구조적으로 불가능하고, 명령 이름만 봐도 출처를 안다. 내장 콘텐츠를 앱 업데이트마다
다시 펼쳐도 사용자 팩이 휩쓸리지 않는다 — 공유 폴더에 병합했다면 전부 잃는 성질이다.

**대가와 그 해소.** 네임스페이스가 팩마다 달라지면 `pack.json` 의 액션 프롬프트가
팩 위치에 종속된다. README 가 안내하는 저작 경로 — `packs/starter/` 를 복사해 `id` 만
바꾸기 — 가 프롬프트 일괄 수정을 요구하게 된다. 그래서 `render_prompt` 에
**예약 변수 `{{ns}}`** 를 추가하고, 팩은 네임스페이스를 직접 쓰지 않는다.

```jsonc
{ "id": "design", "prompt": "/{{ns}}:issues 설계 {{ids}}" }
```

이것이 현재 si(`/sawhorse:morning`)와 starter(`/capture`)가 서로 다른 네임스페이스를
가정하던 불일치도 함께 없앤다 — 양쪽 다 `/{{ns}}:…` 로 통일된다. 팩은 복사해서
`id` 만 바꾸면 그대로 동작한다.

주의: `render_prompt` 는 채워지지 않은 `{{…}}` 를 **흔적 없이 지운다.** `ns` 가
주입되지 않으면 `/{{ns}}:issues` 가 `/:issues` 로 조용히 망가진다. 따라서 `ns` 는
파라미터가 아니라 렌더 진입점에서 **항상** 주입되어야 하고, 이를 테스트로 고정한다.

## Codex — 유일한 예외

Codex 에는 플러그인·훅·`${CLAUDE_PLUGIN_ROOT}` 개념이 없다. 여기서만
앱이 진짜 변환을 한다 — `render_for` 가 `${CLAUDE_PLUGIN_ROOT}` 를
**materialize 된 절대경로로 치환**해야 한다 (현재 미구현).
Codex 프롬프트는 네임스페이스가 없으므로 `{{ns}}` 는 빈 문자열이 아니라
**슬래시 프롬프트 이름 그대로**(`/issues`)가 되도록 별도 렌더 규칙을 둔다.
훅에 의존하는 기능(저널 기반 일지)은 Codex 에서 제한됨을 명시한다.

## 버전

제품 버전 하나. `app/src-tauri/Cargo.toml` 과
`plugin/.claude-plugin/plugin.json` 의 `version` 이 같아야 하고,
`tauri.conf.json` 의 `version` 키는 **삭제**한다 (Cargo.toml 상속).
태그 `v<x.y.z>` 가 정본, CI 가 불일치를 막는다.

## 결정 2 — 재구성을 먼저 하고, 공개는 한 번만 한다

origin/main 은 66 커밋 뒤에 있고 아직 옛 `si-workbench` 플러그인을 서빙한다.
"일단 push 하고 나중에 재구성"이 아니라 **재구성을 끝낸 뒤 `v1.0.0` 으로 한 번에
공개한다.**

근거는 파급을 두 번 내지 않는 것이다. 지금 push 하면 마켓플레이스 이름이
`si-workbench` → `sawhorse` 로 바뀌어 기존 설치가 끊기고, 몇 주 뒤 `source` 를
`"./plugin"` 으로 옮기면 **또** 끊긴다. 한 번의 정확한 컷오버가 엄격히 낫다.

지금이 그렇게 할 수 있는 마지막 시점이다 — 레포는 생성 4일차, star 0 · fork 0,
릴리스도 태그도 없어 지켜야 할 계약이 아직 없다. 유일한 실사용자는 저자 본인이고,
그 사람은 로컬 트리를 쓴다.

받아들이는 비용: 새 README 가 GitHub 에 보이기까지 재구성 기간만큼 늦어진다.
그 사이 방문자는 옛 si-workbench 문서를 본다. 이는 이중 파손보다 싸다.

## 마이그레이션 순서

**1단계 — 재구성 (공개 전, 한 브랜치에서)**

1. `dashboard/` → `app/`, 루트 `skills/`·`packs/`·`hooks/`·`scripts/`·`.mcp.json` → `plugin/` 하위
2. 팩별 `skills/` 로 스킬 분배 + `plugin.json` 의 `skills` 배열 선언
3. `packs.rs` 의 skills_dir 폴백 제거
4. `render_prompt` 에 `{{ns}}` 주입 + 팩 프롬프트를 `/{{ns}}:…` 로 전환
5. 훅 `.ps1` → `.mjs` (Node 는 improve-excel 이 이미 요구)
6. `agents.rs`: 개인 스킬 설치 → skills-dir 플러그인 materialize 로 교체
7. `render_for`: Codex 용 `${CLAUDE_PLUGIN_ROOT}` 치환 + 네임스페이스 규칙
8. `marketplace.json` `source: "./plugin"`, 이름·버전 `sawhorse` / `1.0.0` 통일

**2단계 — 공개 (한 번)**

9. CI: `cargo test` · `npm run build` · 버전 정합성 · `claude plugin validate ./plugin`
10. 전체 push → 태그 `v1.0.0` → 릴리스 워크플로가 번들 생성

1단계 전체가 로컬에서 끝나고 CI 가 초록일 때까지 push 하지 않는다.

## 버리는 것

- 루트 = 플러그인 (앱 소스가 플러그인 설치에 딸려오던 구조)
- 개인 스킬 설치 경로와 그로 인한 중복 커맨드 경고
- `packs.rs` 의 skills_dir 폴백
- PowerShell 전용 훅
