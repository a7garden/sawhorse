# si-workbench 설계 문서

SI 업무용 Claude Code 플러그인. Obsidian vault를 개인 지식베이스(위키)로 쓰고,
업무일지·업무 보고·제안서/코드베이스 분석 문서화를 자동화한다.

## 대상 환경

- Windows 10/11 업무용 PC, Claude Code CLI (v2.1.x 이상 권장)
- PowerShell 5.1+ (Windows 기본) — 훅 스크립트 실행
- 권장: Node.js 18+ (Playwright MCP 스크린샷), pandoc (docx 파싱)
- macOS/Linux에서도 동작하도록 스킬은 경로 변수를 쓰되, 1차 타깃은 Windows

## 저장소 구조 (repo = 마켓플레이스 + 플러그인)

```
si-workbench/
  .claude-plugin/plugin.json        # name, version, userConfig(vault_path)
  .claude-plugin/marketplace.json   # 단일 플러그인, source: "./"
  skills/                           # 12개 스킬 (아래)
  hooks/hooks.json                  # SessionEnd, PreToolUse
  hooks/scripts/journal-append.ps1
  hooks/scripts/block-push.ps1
  templates/                        # vault용 노트 템플릿 6종
  .mcp.json                         # Playwright MCP
  README.md, LICENSE(MIT), docs/design.md
```

## Vault 구조

```
<VAULT>/                            # ${user_config.vault_path}
  대시보드.md                       # 시작 화면. .base 뷰를 임베드 (Homepage 플러그인이 여기를 연다)
  템플릿/                           # Obsidian core Templates 플러그인 폴더
  일지/YYYY-MM-DD.md               # 오늘 할 일 / 업무기록(자동 영역 + 수기) / 비고 / 내일 할 일
  일지/일지.base                    # 최근 일지 뷰
  사업/사업.base                    # 진행중 / 전체 뷰
  사업/개선.base                    # 승인대기 / 구현대기 / 제안 / 검증대기 / 화면별 / 전체 뷰
  사업/<사업명>/
    <사업명>.md                     # 사업 허브(MOC)
    분석/                           # codebase-docs 산출물 (기능 1개 = 문서 1개)
    산출물/
    회의/
    개선/                           # improve 산출물
      개선.md                       # 상태별 문제 대시보드(MOC) + 구현 배치 이력
      <화면단위>/                   # 요청 단위 URL 1개 = 폴더 1개 (예: fdrList.do)
        문제목록 - <화면단위>.md      # 사용자가 자유 작성하는 인박스 겸 인덱스
        <ID> <제목>.md              # 문제 노트 (문제·설계·결과 한 노트)
  개념/<개념명>.md                  # 위키 노트 (한 줄짜리 용어도 노트 1개)
  개념/개념.base                    # 전체 / 분류별 / 확인필요 / 근거없음 뷰
  첨부/스크린샷/<사업명>/
  첨부/다이어그램/<사업명>/         # SVG 등 직접 그린 분석 다이어그램
  첨부/목업/<사업명>/               # improve 의 UI 목업 HTML (승인 전 화면 확인용)
```

- 사업/연구 구분은 폴더가 아니라 `type` 프로퍼티. 둘 다 `사업/` 아래에 둔다.
- 분류는 폴더가 아니라 프로퍼티. `개념/`은 평면 폴더이고 `domain`(기술 / 업무도메인 / 행정용어 / 제도·법령 / 조직·기관 / 시스템·제품)이 나눈다.
- `.base`는 뷰일 뿐이다. 전부 지워도 지식은 노트에 남아야 한다(wiki 규범 제6조). 정의 본문을 `.base`에 적지 않는다.
- 첨부는 `.obsidian/app.json`의 `attachmentFolderPath: 첨부/스크린샷`으로 유입 지점을 고정한다. 이 설정이 없으면 붙여넣기 이미지가 볼트 루트에 쌓이고, vault-tidy [NORMALIZE]가 매 실행 회수한다.

## 프로퍼티 스키마 (영어 키 + 한국어 값)

| 노트 | frontmatter |
|---|---|
| 사업 허브 | `type: 사업\|연구`, `status: 예비\|진행중\|완수\|보류`, `client`, `period`, `parent`, `related[]`, `codebase`, `vcs: git\|svn`, `tags[]` |
| 개념 | `type: 개념`, `aliases[]`, `related[]`, `sources[]`, `tags[]` |
| 일지 | `type: 일지`, `tags[]` |
| 기능분석 | `type: 기능분석`, `sources[]`, `related[]`, `status: 초안\|검토완료`, `tags[]` |
| 회의 | `type: 회의`, `date`, `participants[]`, `project`, `related[]`, `tags[]` |
| 개선 | `type: 개선`, `id`, `screen_id`, `screen`, `url`, `category: 버그\|UI 개선\|성능\|리팩터링`, `status: 제안\|승인대기\|승인\|구현중\|부분구현\|구현완료\|보류\|반려`, `approve: bool`, `approved`, `base`, `branch`, `commits[]`, `verified: 확인\|부분확인\|미확인`, `depends_on[]`, `dependents[]`, `related[]` |

규칙: 스킬이 임의 필드를 만들지 않는다. 모르는 값은 비워둔다. 값은 한국어.

## 개선 사이클 (improve)

사용자가 발견한 화면 단위 문제를 **문제 기술서 → 설계 → 승인 → 커밋 적용 → 결과 보고** 로 처리한다.
승인은 **볼트에서만** 일어나고, 적용은 되돌릴 수 있는 커밋 1개로 남는다.
설계는 여러 건을 한 번에 쓸 수 있고, 승인된 건들도 한 번에 구현할 수 있다.

```
        (스킬: 코드 조사 → ## 설계)        (사람: 볼트에서 approve 체크)
제안 ─────────────────────────▶ 승인대기 ─────────────────────────▶ 승인
 ▲                                 ▲ │                                │
 │        (스킬: 설계 개정 시        │ │ (사람: status 를 보류/반려)      │ (스킬: 구현)
 │         approve 자동 해제) ───────┘ ▼                                ▼
 │                                 보류 / 반려                       구현중
 │                                                                    │ (스킬: 경로 한정 커밋 1개)
 └──(사람: 되돌리기 <ID>)◀──── 구현완료 ◀────────────────────────────┘
                                  │
                                  └─(사람: 화면 확인) → verified: 확인
```

- **승인 게이트는 볼트 전용.** 노트의 `approve` 체크박스를 사람이 켜야 코드를 고칠 권한이 열린다.
  스킬은 이 값을 `true` 로 쓰지 않고(`false` 로 되돌리는 것만 허용), 구현 직전 **디스크에서 노트를 재확인**한다.
  채팅의 "승인해줘" 는 승인이 아니다 — 노트를 `obsidian://open` 으로 열어주고 정지하며, 재차 요구받아도 대신 켜지 않는다.
  `### 변경 대상` 이 빈 채로 체크만 켜진 건은 승인 무효. 승인 후 설계를 고치면 `approve: false` + `승인대기` 로 내리고 `### 개정 이력` 에 사유를 남긴다.
- 검증(`verified`)은 게이트가 아니라 사후 기록이라 채팅으로 갱신해도 된다. 승인만 볼트 전용인 이유는 승인이 **코드를 고칠 권한을 여는 행위**이기 때문이다.
- 반려·수정 요청은 노트의 `### 검토 의견` 에 적는다. 스킬은 스캔 때 `승인대기` 노트 본문까지 읽어 대응 없는 의견을 재설계 대상으로 올린다.
- **일괄 설계**(`설계`): `제안` 전부를 순차 처리하고 건별 저장(중단 내성). 끝에 교차 검토 1회 — 변경 대상이 겹치는 문제쌍·모순 설계·중복 문제를 보고한다.
- **일괄 구현**(`구현`): `approve: true` 인 건을 의존성 위상정렬 + 파일 겹침 인접 배치 순으로 돌린다.
  문제마다 구현 → verify → **즉시 커밋** — 여러 건을 커밋 없이 쌓으면 한 작업 트리에 변경이 섞여 되돌리기 단위가 소멸하기 때문이다(단건 모드는 화면 검증 후 커밋).
  실패는 그 건만 `restore` 하고 같은 파일 후속 건만 건너뛴 뒤 계속하며, 끝에 성공/실패/건너뜀 표를 낸다.
- 배치 식별자는 별도 필드 없이 `base`(배치 시작 HEAD)를 전 건에 동일하게 기록해 표현한다. 같은 `base` = 한 배치 → `되돌리기 배치 <기준커밋>` 으로 역순 revert.
- `.obsidian/types.json` 에 `"approve": "checkbox"` 를 등록해야 속성 패널·Base 표에서 체크박스로 렌더된다(init-vault 가 처리).
- **스킬은 하나(`improve`)이고 파일만 나눈다.** 설계/구현을 별도 스킬로 쪼개면 승인 게이트가 두 문서에 복제돼 한쪽만 고쳐질 위험이 있고, 다음 단계는 이미 노트 `status` 가 정하므로 사용자가 스킬 이름으로 단계를 고를 이유도 없다.
  대신 `SKILL.md`(안전 규칙·설정·구조·상태 머신·승인 게이트·스캔·전파·금지사항)를 항상 읽고, 경로가 정해진 뒤 `references/승격.md` `references/설계.md` `references/구현.md` 중 해당 파일만 읽는다.
- 문제 ID 는 사업 단위 단조 증가(`FDR-001`). 화면이 달라도 번호를 이어 써 커밋 메시지에서 전역 유일하게 한다.
- 커밋 규격: `fix(FDR-001): <요약>` + 본문에 문제 노트 경로와 채택 설계안. 타입은 `category` 에 대응.
- 커밋은 항상 **경로 한정**(`git commit -m ... -- <파일>`). 사용자의 무관한 미커밋 변경이 섞이면 되돌리기 단위가 깨진다.
- 브랜치는 **개선 전용 단일 `workBranch` 하나**. 문제마다 브랜치를 파지 않는다 — 같은 작업 트리를 IDE·톰캣·다른 세션이 함께 보므로 브랜치 전환 자체가 부작용이고, 동시에 두 문제를 볼 수도 없다. 되돌리기 단위는 브랜치가 아니라 경로 한정 커밋이다. 브랜치 생성·전환·병합·rebase 는 **사용자만** 실행한다(스킬은 현재 브랜치 확인만).
- 의존성은 양방향 기록: 이번 노트 `depends_on` ↔ 상대 노트 `dependents`. 되돌리기는 `dependents` 역순.
- **의존성 판정의 정본은 노트의 `commits`** — 커밋 메시지 `--grep` 이 아니다. 규격을 안 지킨 커밋이 섞이거나 `rebase` 로 메시지가 낡으면 grep 이 조용히 빈 결과를 내 "의존성 없음" 으로 오판한다. 노트의 SHA 로 `git show --name-only` 해서 파일 교집합을 본다. SHA 가 `git cat-file -e` 로 확인되지 않으면 히스토리가 재작성된 것이므로 노트 갱신이 먼저다.
- 화면이 바뀌는 문제는 승인 전에 자기완결 HTML 목업(`첨부/목업/<사업명>/<ID>-<안>.html`)을 만들어 브라우저로 보여주고, Playwright 캡처를 `## 설계` 의 `### 목업` 절에 임베드한다. 목업은 현재 화면·기존 시안을 기준으로 하고 없는 요소를 지어내지 않는다. MCP 부재 시 캡처만 건너뛴다.
- 설정: `config.json` 의 `improve.projects.<사업명>` (`path`, `workBranch`, `portableBase`, `idPrefix`, `verify`). `workBranch` 는 남의 변경이 섞이지 않은 지점에서 분기해 두고, 승인 후 이식은 `git rebase --onto <portableBase> <분기점>` 으로 한다 — SHA 가 바뀌므로 문제 노트 `commits` 갱신 필요. PC마다 다르므로 setup 이 대화로 수집한다.
- 원격 금지는 다른 스킬과 동일하고, 여기에 **SVN 상태 변경 명령 전면 금지**(읽기 전용 조회만)가 추가된다.

## 위키 규범 (모든 스킬이 준수 — `si-workbench:wiki` 스킬이 규범 본문)

1. 문서에 개념 첫 등장 시 `[[개념명]]` 위키링크. 노트가 없으면 템플릿으로 생성 후 링크 (죽은 링크 금지).
2. 개념 노트: 2-3문장 정의 + `sources` 출처 + `related`. 다른 노트와 본문 중복 금지 — 링크로 연결.
3. 기능분석 문서: 실제 파일 경로는 frontmatter `sources`에만 적는다. 본문은 추상 서술 + 다이어그램(mermaid 우선, 복잡한 그림은 SVG) — 텍스트보다 다이어그램이 명확하면 반드시 다이어그램. 경로 변경에 본문이 썩지 않는 구조.
4. 사업 허브 = MOC: 분석 문서·주요 개념·산출물 링크 목록을 최신으로 유지.
5. 프로퍼티는 템플릿 스키마만 사용.

## 일지 파이프라인

```
세션 종료 → SessionEnd 훅(자동)
  → %USERPROFILE%\.claude\si-workbench\journal\YYYY-MM-DD.jsonl
    한 줄: {"ts","session_id","cwd","transcript_path","reason"}

/si-workbench:daily-log  → 오늘 저널 → transcript 샘플링 → 상세 업무기록
  → 일지/오늘.md 의 `## 업무기록` 자동 영역만 교체 (재실행 멱등, 노트 없으면 생성)
  → 자동 영역 밖 수기 기록은 [PRESERVE] 계약으로 재가공 (삭제 금지)
/si-workbench:daily-report → 동일 분석 → 보고 형식 코드블록 1개 출력
/si-workbench:evening → 오늘 할 일 체크 확정(증거 기반) → daily-log 절차 → daily-report → 내일 할 일 이월
```

- transcript 샘플링: user 발화 + summary 항목 중심. JSONL 통독 금지.
- 같은 session_id가 여러 줄이면 마지막 것만 유효.
- `$ARGUMENTS`로 구두 업무(회의 등) 추가 입력 가능.
- vault 경로 결정: `${user_config.vault_path}` → `%USERPROFILE%\.claude\si-workbench\config.json`의 `vaultPath` → 사용자 문의. `/si-workbench:setup`이 이 설정을 관리한다.

[PRESERVE] 사용자 문장 보존 계약 — 일지 노트를 쓰는 모든 스킬(daily-log, evening)이 지킨다.

- `## 업무기록`은 `<!-- si-workbench:auto:start -->`~`<!-- si-workbench:auto:end -->` 사이(자동 영역)와 그 밖(수기 기록)으로 나뉜다. 교체 가능한 것은 자동 영역뿐이다.
- 마커가 없는 노트(구버전·수기 작성)는 섹션 전체를 수기 기록으로 간주하고 마커를 새로 만든다. 마이그레이션 시점에 손으로 쓴 글이 사라지지 않는다.
- 수기 기록은 삭제하지 않고 재가공한다: 한 일 → 자동 영역 통합, 할 일 → `## 내일 할 일`, 개념·구조 설명 → 개념 노트 + `[[링크]]`, 사업/개선 상세 → 해당 노트 + 링크, 그 외 메모 → `## 비고`, 애매하면 원문 그대로 보존.
- `## 비고`·`## 내일 할 일`은 덧붙이기만 한다(기존 줄 삭제·수정 금지).
- 노트 수정 전 원본을 `%USERPROFILE%\.claude\si-workbench\backup\일지-<날짜>-<시각>.md`로 복사한다. 백업에 실패하면 노트를 수정하지 않는다.
- 재가공 결과는 `원문 → 옮긴 위치` 표로 보고한다.


## 보고 형식 (daily-report 표준 출력)

- 단일 fenced 코드블록. 날짜·인사·마크다운 장식 금지. 복사→붙여넣기 그대로.
- `[분류]`는 그날 내용을 보고 AI가 추론. 항목은 `- ` 한 줄. 카테고리 사이 빈 줄.

```
[분류1]
- 업무내용1
- 업무내용2

[분류2]
- 업무내용1
```

## 훅

| 훅 | 스크립트 | 동작 |
|---|---|---|
| `SessionEnd` (전체) | journal-append.ps1 | 저널 JSONL 1줄 추가. 실패해도 조용히 exit 0 |
| `PreToolUse` (`Bash\|PowerShell`) | block-push.ps1 | `git push`/`send-pack`, `svn commit/ci/import`, `git svn dcommit`, `hg push` → ask(실행 전 확인 프롬프트 강제) |

- 원칙: 회사 저장소 원격 변경은 완전 차단이 아니라 **항상 확인**. 사용자가 승인하면 실행됨. 로컬 `git commit`은 확인 없이 허용.
- ps1은 UTF-8 **with BOM**으로 저장 (Windows PowerShell 5.1 한글 파싱).
- 훅 스크립트 경로는 `${CLAUDE_PLUGIN_ROOT}` 변수 사용.

## 스킬 (12개, 네임스페이스 `/si-workbench:*`)

### 일과 루틴 (무인 실행)

볼트 위생은 `scripts/vault-hygiene.ps1` 한 스크립트가 담당하고 세 루틴이 모드를 나눠 호출한다(`quick`/`scan`/`fix`). 스킬이 노트를 하나씩 읽지 않고 스크립트 출력 목록만 받아 판단이 필요한 것만 처리한다 — 한 번에 전체를 훑는 비용을 하루에 분산하는 것이 목적이다. 전체 패스는 `vault-tidy`가 맡는다.

루틴 스킬은 [UNATTENDED] 계약을 따른다: 실행 중 사용자에게 질문하지 않고, 모든 판단과 근거를 마지막 보고에 남긴다. 사용자가 실행을 걸어둔 채 자리를 비우는 사용 패턴을 전제로 한다.

| 스킬 | 역할 |
|---|---|
| `morning` | 오늘 일지 노트 확보 + 어제 `내일 할 일` 이월(오늘 할 일이 초기 상태일 때만 자동, 아니면 표시만) + 어제 요약 브리핑 + 볼트 위생 `quick` |
| `lunch` | 완전 읽기 전용 오전 결산: 오늘 할 일 vs 오전 저널 대조 → 완료/진행중/미착수 + 오후 제안 + 볼트 위생 `scan`(진단만) |
| `evening` | 체크 확정(저널 증거 기반, 근거 없으면 유지) → daily-log 절차로 `## 업무기록` 자동 영역 교체([PRESERVE] 준수) → daily-report 형식 출력 → 미체크 항목 `## 내일 할 일` 병합 + 볼트 위생 `fix` |

### 도구

| 스킬 | 역할 |
|---|---|
| `setup` | 설정·환경 진단: vault 경로 수집(config.json), Node/pandoc/MCP/훅 점검. 재실행 안전 |
| `wiki` | 개념 노트 규범 본문. 다른 모든 스킬이 이 규범을 준수함을 명시 |
| `init-vault` | vault 스캐폴딩 + 템플릿·`.base`·대시보드 배치 + templates.json/app.json/homepage 설정. 재실행 안전(기존 파일 보존) |
| `daily-log` | 상세 업무기록 → 일지 노트 `## 업무기록` 자동 영역 교체 + 수기 기록 재가공([PRESERVE]) |
| `daily-report` | 보고 형식 요약 → 코드블록 출력 |
| `project-doc` | 사업 등록: 제안서(docx: pandoc, 없으면 Word COM) + 코드베이스 경로 → 사업 폴더/허브/요약 |
| `codebase-docs` | 코드베이스 → 기능별 기능분석 문서(mermaid 필수) + 필요시 Playwright 스크린샷 → 첨부/스크린샷 |
| `vault-tidy` | ①상시 정규화(매 실행·무승인): 루트 첨부 회수, `attachmentFolderPath` 교정, frontmatter 스키마 정합, 인덱스 자산 확인, 죽은 링크. ②재구성(승인 게이트): 이동·병합·보강·삭제. 로컬 git 증분 (remote 금지) |
| `improve` | 개선 사이클: 스캔 → 설계(단건·일괄, 정지) → **볼트에서 승인 체크** → 구현(단건·일괄) → 경로 한정 커밋 1개/건 + 커밋 ID·의존성·배치 결과 보고 |

공통: vault 경로는 `${user_config.vault_path}` 주입, 비었으면 `%USERPROFILE%\.claude\si-workbench\config.json`의 `vaultPath` 폴백(setup이 관리). docx 우선순위 pandoc → Word COM.

## 보안/정책
- 원격 전송/push 로직 없음. vault의 git은 로컬 버저닝 전용 — vault-tidy가 초기화·커밋을 관리하고 remote는 금지.
- 정부사업 특성상 세션 내용은 vault(로컬)에만 저장. 외부 동기화 가정 없음.
