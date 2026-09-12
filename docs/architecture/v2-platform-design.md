# Sawhorse v2 설계 — 앱 독립 문서 공간과 HTML 원본 문서

작성일: 2026-09-12. 상태: **R1 수직 흐름·R1A 코어 구현 완료**(2026-09-12, [기준선과 단위별 상태](v2-baseline.md) — HTML 정본 저장·읽기·원문 편집·ContextSnapshot·디자인 바인딩·어댑터 재배치 포함). 외부에서 작성한 vNext 통합 설계 0.4와 그 개정(문서 계층 분리안)을 이 저장소의 실제 코드 기준으로 정착한 문서다. 여기의 타입·API·경로는 목표 계약이며 현재 제품의 제공 기능을 의미하지 않는다.

이 문서에서 **v2**는 제품 차원의 다음 방향을 뜻한다. 이미 구현된 SDD lifecycle v2(`intent-flow` 2.x, [sdd-lifecycle-v2.md](sdd-lifecycle-v2.md))나 확장 package manifest v2와 다르며 그 둘을 대체하지 않는다.

## 1. v2의 정의와 범위

**Sawhorse의 상위 개념은 특정 노트 앱이 아니라 앱 독립적인 문서 공간이다.** Obsidian과 Oximemo는 선택 가능한 편집·탐색 앱이고, Oxibrain은 선택 가능한 검색·기억 계층이며, Sawhorse는 그 위에서 작업 방식을 정의하고 실행·승인을 장부로 남기는 플랫폼이다.

세 축으로 요약한다.

- **작업 방식은 나의 환경에.** 문서는 사용자가 선택한 외부 공간(볼트)에 있고, 기여 대상 저장소에 개인 관리 파일을 추가하지 않는다.
- **사람용 문서의 새 정본은 HTML.** 같은 내용을 사람은 시각적으로 검토하고 에이전트는 의미 구조로 읽는다. 기존 Markdown은 금지하지 않고 `LegacyMarkdownCodec`으로 보존한다.
- **판정은 실행 장부에.** 문서 내용, 에이전트 완료, 검증 통과, 사람의 승인을 구분해 기록한다. 외부 앱에서 체크박스를 완성해도 Sawhorse 작업이 승인되지 않는다.

이번 설계에 **포함한다**: 앱 독립 문서 공간(DocumentSpace·DocumentStore), 여러 문서 공간 등록과 기본 여는 앱 선택, HTML 원본 계약과 DESIGN.md 표현 계층, 원문/section 편집과 revision 충돌 검사, 필수 입력의 revision 고정(ContextSnapshot), Obsidian 어댑터 재배치, Oximemo 읽기·연결, 선택적 Oxibrain 검색, 게시본 파생과 경험 기록.

이번 설계에 **포함하지 않는다**: 여러 앱의 실시간 공동 편집, CRDT 협업 서버, 중앙 인증·감사 서버, 양방향 자동 동기화, 임의 HTML 프로그램 실행, 새로운 검색 엔진·그래프 DB. R5에서 메타데이터 왕복·동시 저장 충돌 검증을 통과한 경우에만 제한적 공동 편집을 연다.

## 2. 핵심 결정

| 결정 | 채택 | 기각 |
|---|---|---|
| D01 · 저장소 독립 | 논리 프로젝트와 코드 저장소·외부 문서 공간을 분리한다. | 개인 지침 파일을 코드 저장소에 강제한다. |
| D02 · 단일 본문 원본 | 새 사람용 문서는 의미 구조를 가진 HTML(`shdoc/1`)이 정본이다. | HTML과 편집기 JSON을 각각 수정 가능한 원본으로 둔다. |
| D03 · 계층별 정본 | 문서 공간·문서 저장소·앱 어댑터·지식 계층·실행 장부의 소유권을 분리한다(§4 표). | 모든 데이터를 한 앱이나 Markdown 한 곳으로 이관한다. |
| D04 · 기존 엔진 재사용 | workflow 정의·확장 package·스키마·ChangeSet·기존 하네스를 확장한다. | 새 workflow 언어와 두 번째 승인 엔진을 만든다. |
| D05 · 명시적 권위 | 범위·발행 권한·자료 접근 경계를 따로 해석한다. | 가장 가까운 파일이 모든 규칙을 이긴다. |
| D06 · 두 컨텍스트 경로 | 필수 입력은 정확한 revision에서 직접 읽고, 참고 자료만 검색한다. | 필수 정책을 관련성 검색에 맡긴다. |
| D07 · 디자인 재사용 | 외부 DESIGN.md + 검토된 공통 테마 + 목적별 layout을 사용한다. | 문서마다 HTML/CSS 전체를 다시 생성한다. |
| D08 · 불변 실행 입력 | 전달한 실제 내용과 출처를 스냅샷으로 기록한다. | 나중에 재검색한 결과를 과거 입력이라고 표시한다. |
| D09 · 권한은 실효성 기준 | 어댑터가 실제로 강제할 수 있는 범위만 보장한다. | 금지 프롬프트·worktree를 보안 격리라고 부른다. |
| D10 · 승인 분리 | 설계 인수·검증·표현 검토·게시 승인을 각각 기록한다. | 문서의 `approved` 속성이나 에이전트 `done`을 완료 판정으로 쓴다. |
| D11 · 명시적 게시 | 특정 revision에서 공개 가능한 게시본을 파생한다. | 개인 문서와 원격 문서를 자동 양방향 동기화한다. |
| D12 · 점진적 출시 | 작동하는 작은 수직 흐름부터 만들고 회귀·실패 테스트를 붙인다. | 기존 작업·기록을 일괄 변환한다. |
| D13 · 앱 어댑터는 부착물 | 문서 앱 탐지·열기는 어댑터 뒤로 숨긴다. 앱이 없어도 코어가 동작한다. | 특정 노트 앱 탐지를 코어에 박는다(현재 `detect_obsidian_vaults`의 위치). |

## 3. 현재 코드에서 확인한 기반과 간극

2026-09-12 현재 트리 기준. 이미 있는 것을 재구현하지 않고, 간극만 이 설계가 메운다.

| 영역 | 현재 확인한 구현 | v2에 필요한 변경 |
|---|---|---|
| 저장 루트 | [`sdlc.rs:418`](../../app/src-tauri/src/sdlc.rs) `vault_root()`가 [`config.rs:18`](../../app/src-tauri/src/config.rs) `~/.claude/sawhorse/config.json`의 `vaultPath` 하나로 모든 문서 공간을 고정 | `DocumentSpace` 다중 등록, 공간별 루트·권한 |
| 문서 형식 | 전부 YAML frontmatter + Markdown 본문 단일 포맷(`sdlc.rs:603` `markdown()`). HTML은 목업([`preview-html.ts`](../../app/src/features/mockups/preview-html.ts) `sandboxedMockupHtml`, CSP 샌드박싱 선례)에서만 1급 | format-neutral `DocumentService` + `shdoc/1` HTML codec |
| revision 충돌 검사 | 문서 전체 SHA-256(`sdlc.rs:695`) 기반 낙관 검사. `write_document_at`(`sdlc.rs:1922`)·`save_project_at`(`sdlc.rs:1540`)·프론트 4개 편집기(Atomic Editor)가 동일 계약, 충돌 UI(최신본 비교/초안 복사/재로드) 존재 | HTML 원문에도 동일 계약 적용. 블록 단위 `expected_block_digest`는 R3 |
| 파일 변경 적용 | [`changes/mod.rs`](../../app/src-tauri/src/changes/mod.rs) ChangeSet: preview→apply→rollback, `.sawhorse/changes/<uuid>.json` 저널 + 백업, 중단 복구·충돌 판정 | HTML candidate 적용도 같은 경로. 저널이 볼트 내부에 있어 공간 분리 시 위치·`root_identity` 재정의 |
| 승인 basis 고정 | `work/<id>/approved-design.json` 스냅샷(`sdlc.rs:2449`), `intent_design_revisions`(`sdlc.rs:3751`)로 승인 시점 revision 고정, `check_approval`이 변경 시 차단 | 소유권 표의 `approval_basis_digest`로 일반화 |
| 실행 입력 고정 | `work_input_digest`(정의 digest + 전체 artifact revision, `sdlc.rs:2092`) 재계산 → 장부 `mark_stale_at`(`sdlc.rs:1949`)으로 입력 변경 시 이전 run 무효화 | `ContextSnapshot`(전달 payload 원문 보존 + 출처·자원 lock)으로 확장 |
| 컨텍스트 조립 | `LaunchContext` + `build_prompt`([`sdlc_harness.rs:516-673`](../../app/src-tauri/src/sdlc_harness.rs)): artifact 절대경로 목록·검증 명령·금지 규칙·스킬 경로를 단일 프롬프트에 주입 | 필수/참고 입력 분리, payload bytes 보존, 관측 범위(included/accessible/observed_read/unknown) 기록 |
| 실행 장부 | `.sawhorse/runtime.sqlite` `workflow_instances`(state_json)·`workflow_events`([`ledger.rs:29-58`](../../app/src-tauri/src/workflow/ledger.rs)), append-only 이벤트, `attach_execution_at`으로 node_run↔`runs/<runId>.md` 상호 연결 | 그대로 운영 상태 정본. 문서 계층 분리와 무관하게 유지 |
| 증거 CAS | ingestion이 `.sawhorse/evidence/ingestion/<key>/<sha256><ext>`로 원문을 내용 주소 보관, 해시 불일치 시 실패([`ingestion.rs:417`](../../app/src-tauri/src/ingestion.rs)) | 실행 입력·candidate 증거로 일반화(objects 저장소) |
| Obsidian 결합 | `detect_obsidian_vaults`([`vault.rs:1263`](../../app/src-tauri/src/vault.rs)) + 임베드 해석 3함수(`vault.rs:1093-1183`) + `SKIP_DIRS`(vault.rs:980) + 진단([`detect.rs:328`](../../app/src-tauri/src/detect.rs)) + 업그레이드 보존([`upgrade.rs:55`](../../app/src-tauri/src/upgrade.rs)) + 위자드 후보 UI | 전부 `ObsidianDocumentAppAdapter` 뒤로 이동. 코어는 앱 비의존 |
| DESIGN.md | [`project_resources.rs`](../../app/src-tauri/src/project_resources.rs): 리소스 JSON(`.sawhorse/resources/<id>.json`)과 `projects/<id>/DESIGN.md` **이중 저장**, repo 폴백·추출(`sdd_design_source`)·LLM 생성·내보내기 존재 | `DesignBinding`/`PresentationLock`으로 소유권 단일화(§6) |
| 검색 | `sdd_search`([`sdlc.rs:2587`](../../app/src-tauri/src/sdlc.rs)) — 전체 볼트 .md 소문자 substring 정확 매치, 색인 없음 | `KnowledgeProvider`(LocalSearch)로 격리. HTML 수집·마크업 제거 추가. Oxibrain은 선택 provider |
| 스키마 | [`schemas/mod.rs`](../../app/src-tauri/src/schemas/mod.rs): 불변 revision 게시(`.sawhorse/schemas/<id>/<rev>.json`) + `workspace.json` 활성 포인터, 전체 스캔 통과 조건 | storage.path를 공간 루트 기준으로 재정의 |
| 볼트 관례 | `프로젝트/`·레거시 `사업/` 폴더, 이슈/개선 한국어 파일명(`vault.rs:104-126, 323-476`), BOM 관용 파서 | 문서 공간이 특정 앱·언어 관례에 종속되지 않게 어댑터로 이동 |

추가로 확인한 결합점: `.sawhorse/` 내부물 13종(schema.json, workflows/, schemas/, workspace.json, runtime.sqlite, changes/, evidence/, ingestion/, resources/, profiles/, extensions.lock.json, locks/, goal-cooldowns.json)과 이를 예약 경로로 검사하는 가드 6곳(changes/mod.rs:160, ingestion.rs:179, workflow/mod.rs:420, validation.rs:71, cli/mod.rs:318, upgrade.rs:58). frontmatter 파서가 vault.rs(Obsidian 관용: BOM·`...` 종결자)와 sdlc.rs(엄격) 2종 공존한다.

## 4. 대상 아키텍처 — 4계층 문서 모델

하나의 Rust 애플리케이션 안에서 책임을 나눈다. GUI·CLI·에이전트가 같은 Command API를 통과하며, 각 계층의 소유권이 서로 다르다.

```text
Sawhorse Core
├─ Work Runtime (기존 유지)
│  └─ workflow 정의·instance·node run·승인·게시 상태 = 운영 상태의 정본
│
├─ Document Service (신규)
│  ├─ DocumentSpace    개인·회사·프로젝트 등 논리적·보안적 문서 영역
│  ├─ DocumentStore    원문·native ID·revision·첨부 자료의 읽기와 보존
│  └─ ArtifactBinding  Sawhorse 작업(역할) ↔ 외부 문서(revision) 연결
│
├─ Document App Adapters (신규 레지스트리)
│  ├─ Built-in   파일 탐색기/기본 앱
│  ├─ Obsidian   기존 detect_obsidian_vaults() 구현을 이동
│  └─ Oximemo    읽기·연결 수준 (R2)
│
└─ Knowledge Providers (기존 sdd_search 격리 + 확장)
   ├─ Local Search
   └─ Oxibrain (선택)
```

### 계층별 소유권

| 계층 | 책임 | 정본 여부 |
|---|---|---|
| DocumentSpace | 문서의 논리적 영역과 개인정보 경계 | 공간 설정의 정본 |
| DocumentStore | 원문, native ID, revision, 첨부 자료 | 문서 내용의 정본 |
| DocumentAppAdapter | 앱 탐지, 열기, 위치 표시, 선택적 편집 | 정본 아님 |
| KnowledgeProvider | 검색, 연관 문서 발견, 과거 경험 회상 | 정본 아님 |
| Sawhorse 장부 | 실행, 승인, 검증 증거, 게시 상태 | 운영 상태의 정본 |

따라서 Oximemo에서 체크박스를 완료하거나 문서 metadata를 바꿔도 Sawhorse 작업이 승인되지 않고, Sawhorse가 문서를 연결했다고 원문을 자기 형식으로 변환하지도 않는다. 반대로 검색 인덱스·문서 IR·렌더 캐시는 재생성 가능한 파생 데이터라 삭제·재색인이 본문이나 승인을 삭제하지 않는다.

### 4.1 기존 구조의 재배치

```text
기존:  Sawhorse Core ── detect_obsidian_vaults()          (vault.rs:1263)
변경:  Sawhorse Core
         └─ DocumentAppRegistry
              ├─ ObsidianDocumentAppAdapter ── 기존 detect_obsidian_vaults() 구현 이동
              ├─ OximemoDocumentAppAdapter  ── R2 (파일 수준 읽기 전용)
              └─ BuiltinFileAppAdapter      ── OS 기본 앱/탐색기
```

이동 대상(현 위치): 탐지 `vault.rs:1263` + `commands.rs:164 list_obsidian_vaults` + 위자드 `SetupWizard.tsx:104`, 임베드 해석 `vault.rs:1093-1183`(percent_decode·find_by_name·resolve_note_asset), `SKIP_DIRS`의 `.obsidian`·`.smart-env`(스캐너 2곳과 공유), 진단 `detect.rs:328-348` + `core-preview.ts:262-272` 미러, 업그레이드 보존 `upgrade.rs:55-59, 307-311`, BOM 관용 파서 `vault.rs:22-25`. 기능은 제거하지 않고 어댑터 뒤로 옮겨 기존 동작을 유지하며, 이후 다른 문서 앱도 코어 수정 없이 추가한다.

`DocumentSpace` 도입은 `vault_root()`의 다중화에서 시작한다. 기존 볼트 루트를 default DocumentStore로 감싸고 기존 경로를 유지한다(§9 이관).

### 4.2 Oximemo — 첫 단계는 읽기·연결

Oximemo는 일반 파일을 정본으로 삼고 인덱스는 재생성 가능한 캐시로 다루므로 이 연결 방식과 잘 맞는다. Sawhorse는 다음만 수행한다.

1. Oximemo 문서 공간을 탐지하거나 사용자가 경로를 등록한다.
2. 메모의 native ID, 현재 revision/hash, 원본 위치를 읽는다.
3. `ArtifactBinding`으로 작업·프로젝트·참고자료 역할과 연결한다.
4. 실행 시 사용한 정확한 문서 revision을 `ContextSnapshot`에 고정한다.
5. 사용자가 요청하면 Oximemo에서 해당 메모를 연다.
6. 검색이 필요하면 Oxibrain을 별도의 KnowledgeProvider로 호출한다.

**주의**: Oximemo CLI는 현재 명령 분기 전에 볼트를 연 뒤 `vault.migrate()`를 실행한다. 실제 사용자 볼트에 CLI 명령을 호출하면 0-write 계약을 보장할 수 없으므로, 실제 볼트 탐지·인덱싱에 CLI를 사용하지 않는다. 파일 수준의 읽기 전용 어댑터, 부작용 없는 코어 경계, 또는 임시 복사본만 사용한다. 동일한 원문·인덱스 계약의 검증이 통과한 뒤에만 다른 수준을 연다.

완전한 공동 편집(양방향)은 별도 호환성 단계(R5)로 연기한다.

## 5. shdoc/1 — HTML 문서의 원본 계약

HTML은 출력 포맷이 아니라 새 사람용 문서의 기본 원본이다. `shdoc/1`은 Sawhorse가 사용하는 작은 HTML 규약의 제안 이름이며, 새 확장자나 전용 태그 언어를 만들지 않는다. 표준 요소로 읽히는 본문에 안정 블록 ID와 제한된 `data-sh-*` 의미만 추가한다.

```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="sawhorse:format" content="shdoc/1">
  <meta name="sawhorse:document-id" content="doc-work-001-spec">
  <meta name="sawhorse:document-profile" content="spec-basic/1">
  <title>외부 저장소 기여 명세</title>
</head>
<body><main><article id="document">
  <h1>외부 저장소 기여 명세</h1>
  <section id="b-repo-clean" data-sh-kind="requirement">
    <h2>개인 작업 문서는 외부 볼트에 저장한다</h2>
    <p>기여 대상에는 개인 workflow 관리 파일을 추가하지 않는다.</p>
  </section>
</article></main></body></html>
```

| 규칙 | 계약 |
|---|---|
| 정체성 | UTF-8, 언어, 제목, 형식 버전, 문서 ID, 하나의 canonical `article`. 블록 ID는 제목·위치 변경에도 유지. |
| 본문 | 표준 요소(제목·문단·목록·표·코드·인용·figure·링크·details) 사용. 표 헤더·caption·alt·코드 공백 보존. |
| 의미 | `goal / requirement / decision / risk / acceptance-criterion` 등은 문서 profile이 요구하는 범위에서만. 일반 메모의 모든 문단을 구조화하지 않는다. |
| 표현 | profile이 허용한 class와 검토된 공통 테마만. 본문 내 임의 style·숨김 속성·작성자 CSS 기본 금지. |
| 실행 | 작성자 script·이벤트·iframe·object/embed·자동 form 제출·외부 CSS/폰트 로드 기본 금지. SVG는 자료 허용 목록 통과. |
| 미지원 구조 | 원문을 보존하고 제한된 읽기만 제공. unknown node를 버리거나 의미를 추측해 자동 편집·승인하지 않는다. |

`DocumentRef = store_id + document_id`, `BlockRef = DocumentRef + block_id`로 연결한다. 일반 `href`는 브라우저 탐색용 locator이고 안정 참조는 `data-sh-ref`다. 자산은 작은 파일 외에 base64로 반복 삽입하지 않고 내용 digest로 보관하며, 문서 revision에 의존 자료 전체를 `resource_lock`으로 기록한다(원본 자산이 변하면 HTML bytes가 같아도 입력이 변경된 것).

표시는 기존 목업 파이프라인의 선례를 따른다: 허용된 구조로 파싱해 앱 컴포넌트로 표시하거나 권한이 분리된 뷰를 사용하고([`preview-html.ts`](../../app/src/features/mockups/preview-html.ts)의 CSP 재조립 패턴), 임의 문서를 권한 있는 앱 DOM에 그대로 삽입하지 않는다.

## 6. DESIGN.md와 표현 계층

HTML은 내용의 정본, DESIGN.md는 시각 지침의 정본, CSS·컴포넌트는 지침의 구현이다. 현재 [`project_resources.rs`](../../app/src-tauri/src/project_resources.rs)는 리소스 JSON과 `projects/<id>/DESIGN.md` 이중 저장에 repo 폴백까지 3경로가 섞여 있다. v2는 소유권을 단일화한다.

```text
DesignBinding
  purpose: document-view          # app-shell / document-view / target-ui 구분
  source: store:personal/designs/<design-id>/DESIGN.md
  revision: sha256:…

DESIGN.md @ fixed revision
  ├─ 구조화 토큰 → 타입·참조 검사 → tokens.css
  └─ 설명·예시   → 생성/검토 지침

HTML + 고정 document.css + 문서 종류 layout → 읽기·편집·검토 화면 / 게시본

PresentationLock
  design_source_digest + importer_revision + tokens_digest
  + theme_digest + layout_revision + renderer_revision
```

- **app-shell**: Sawhorse 앱 자체 디자인([루트 DESIGN.md](../../DESIGN.md)). 문서가 승인 컨트롤·권한 상태를 꾸미지 못한다.
- **document-view**: 문서용 DESIGN.md. 개인 보고서가 구현 대상 프로젝트 브랜드를 자동 상속하지 않는다.
- **target-ui**: 구현할 제품의 디자인. 대상 저장소에서 발견했다는 이유로 Sawhorse 문서 디자인이 바뀌지 않는다.

기존 기능은 재사용한다: 등록(`sdd_save_resource`)·추출(`sdd_design_source`의 css/scss/tailwind 수집)·생성(`sdd_generate_resource`)·내보내기(`sdd_export_resource`)·프로젝트 적용(`sdd_assign_resource`)의 경로를 유지하되, 적용 결과를 `DesignBinding` + `PresentationLock`으로 기록하고 이중 저장을 정리한다. 구조화 토큰이 없는 DESIGN.md는 참고 지침으로 보존하고 테마는 검토·발행한 구현을 사용한다.

`method_lock`은 작업 절차를, `presentation_lock`은 표현 의존성을 고정한다. 새 기본 디자인이 과거 작업·게시본을 자동 변경하지 않는다.

## 7. 편집과 revision

기본 사용자 경험은 문단·표·요구사항·결정 블록을 편집하는 것이다. 저장 원본은 HTML이며, Markdown식 입력 단축키는 허용한다. 첫 출시는 안전한 읽기와 원문/section 편집이고, 구조형 편집기는 왕복 보존 테스트를 통과한 뒤 확장한다.

현재 revision 계약(문서 전체 SHA-256 + expected_revision 낙관 검사, 저장 충돌 UI의 최신본 비교·초안 복사·재로드)은 HTML에도 그대로 적용한다. R3에서 블록 단위로 확장한다.

```json
{
  "document_id": "doc-work-001-spec",
  "expected_source_digest": "sha256:BASE",
  "operations": [{
    "op": "replace_block",
    "block_id": "b-repo-clean",
    "expected_block_digest": "sha256:BLOCK",
    "html": "<section id=\"b-repo-clean\" data-sh-kind=\"requirement\">…</section>"
  }]
}
```

기본 연산은 replace / insert / move / delete. 에이전트는 candidate를 제출하고 canonical 파일을 직접 덮어쓰지 않는다. 제출→검사(구문·의미·참조·자산)→검토(구조 diff·원문 diff)→적용(기존 ChangeSet·저널·새 revision) 순서는 기존 changes 모듈의 preview/apply/rollback을 그대로 탄다.

식별자의 역할:

| 식별자 | 계산 대상 | 목적 |
|---|---|---|
| `source_digest` | 원문 bytes | CAS 저장·복구·원본 출처 |
| `resource_lock` | 참조한 필수 자산·문서 revision 집합 | HTML 밖의 내용 변경 탐지 |
| `content_digest` | 정규화 트리 + 의미 의존성 | 구조 diff·내용 기준 승인 (R3부터 검증 범위만) |
| `presentation_lock` | 디자인 지침·토큰·테마·layout·renderer | 표현 출처 추적 |
| `approval_basis_digest` | 승인 종류가 요구하는 참조와 정책 binding | 그 승인에 영향 주는 변경만 stale 판정 |

정규화는 HTML 파싱 구조 기준으로 허용 속성 순서·직렬화 차이만 제거한다. 정규식 태그 제거나 LLM 동등성 판정을 증거로 쓰지 않는다. 검증 전에는 source + 필수 자원 변경에 보수적으로 stale을 적용한다.

## 8. 실행 입력과 문서의 연결

필수 자료는 직접 읽고 과거 지식은 선택적으로 찾는다.

```text
필수 경로:  method_lock + 승인 artifact + 프로젝트 지침 + 현재 권한 + 목적별 DESIGN.md
            → 정확한 revision 직접 조회 → profile·정책 검사
참고 경로:  허용된 출처·자료 영역 → LocalSearch / Oxibrain
            → 출처·revision·신뢰도 확인 → 관련 자료 선택
고정된 두 입력 + 실행 명세 → ContextSnapshot → AgentAdapter(기존 하네스)
실행 중 추가 조회 → ContextAppendix
```

`ContextSnapshot`은 현재 `LaunchContext` + `build_prompt`가 만드는 프롬프트 주입(artifact 절대경로, 검증 명령, 금지 규칙, 승인 리비전 고정)을 대체·일반화한다:

```text
ContextSnapshot
  work_id, node_run_id, schema_version
  method_lock_digest, effective_profile_digest, current_guardrails
  mandatory[]:  source_ref, revision, block_ids, resource_lock, authority_binding
  advisory[]:   source_ref, revision, excerpt, privacy_domain, freshness
  projector_revision, payload_object, payload_digest
  approval_basis_digest
  agent_adapter, agent/model/version, telemetry_coverage
  recorded_at
```

- 필수 입력이 누락·손상되면 실행하지 않는다(현재 `launch_gate`의 입력 실질성 검사·`ensure_intent_approval`와 같은 정신). 참고 검색 실패는 참고 패널의 `unavailable` 상태일 뿐 기본 흐름을 막지 않는다.
- 현재 `work_input_digest` → `mark_stale` 체계는 그대로 두되, 승인 종류별 `approval_basis_digest`로 세분화해 무관한 변경이 과거 승인을 일괄 폐기하지 않게 한다.
- 외부 CLI의 자동 지침 로드 등 확인 못한 관측은 `unknown`으로 남긴다. `included`를 "모델이 이해했다"로 표시하지 않는다.
- Oxibrain은 KnowledgeProvider 아래 선택 provider다. 미설치·timeout은 참고 기능만 끈다. provider가 허용 root 선필터를 보장하지 않으면 전체 space 회상을 금지하고 `UnsupportedScope`로 끈다. Oxibrain의 HTML 추출기는 검색용 텍스트를 만들 뿐 shdoc 파서로 사용하지 않는다.

## 9. 기존 데이터 이관

문서 형식 변경, 저장소 이동, 실행 장부 이관을 한 번에 하지 않는다.

| 대상 | 초기 처리 | 후속 이관 조건 |
|---|---|---|
| 기존 볼트 루트 | default DocumentStore로 감싸고 기존 경로 유지 | writer 정지·백업·mapping·복구 검증 후 이동 |
| 기존 Markdown artifact | `LegacyMarkdownCodec`으로 읽기·편집·실행 유지 | HTML 후보·참조 mapping·손실 보고를 검토한 뒤 binding 전환 |
| 기존 실행 기록·frontmatter | 원본과 과거 의미 보존 | 레코드별 정본 확인 후 `imported_from_legacy` 연결 |
| `detect_obsidian_vaults` 등 Obsidian 경로 | 어댑터 이동, 동작 유지 | — |
| DESIGN.md 이중 저장 | 현재 등록·적용 경로 재사용 | purpose·binding·revision 경계 추가 후 단일화 |
| 과거 실행의 입력 기록 없음 | `legacy_unrecorded`로 표시 | 오늘의 문서로 과거 snapshot을 꾸미지 않음 |

새 HTML artifact는 새 workflow 버전에서만 기본으로 선택한다. old work를 자동 재발행하거나 과거 Markdown 승인으로 새 HTML 승인을 만들지 않는다. Markdown→HTML 변환은 dry-run 목록 → 원문 보존 → 후보·ID/링크·자산 매핑 → 검토 → ChangeSet → binding 활성화 순서고, Mermaid·수식·위키링크 등 미지원 표현은 손실을 표시한다.

## 10. 구현 순서

기존 단위들을 R0–R5 한 로드맵으로 통합한다. 첫 사용 가능한 제품은 R0+R1, 구조 완성은 R1A까지다.

| 단계 | 만들 것 | 완료 조건 |
|---|---|---|
| R0 · 기존 계약 고정 | 현재 Markdown 저장, SQLite 장부, ChangeSet, 승인, revision 동작을 회귀 테스트로 고정. baseline 문서로 설계-코드 차이 기록 | 기존 저장·실행이 유지된다. 일괄 이관·새 실행 엔진 없음 |
| R1 · HTML 수직 흐름 | Sawhorse가 직접 소유하는 새 사람용 문서에 HTML 정본 + DESIGN.md 표현 계층. shdoc/1 파서·profile·안전한 읽기, 고정 테마, 원문/section 편집, source digest 충돌 검사, 필수 snapshot, 기존 하네스 어댑터 연결 | 외부 repo에 개인 지침 파일 없이 작성→검토→실행→결과 확인. Oxibrain 없이 동작 |
| R1A · 앱 독립 문서 공간 | DocumentSpace, DocumentStore, DocumentAppBinding(Adapter 레지스트리), 기본 여는 앱 선택, 여러 공간 등록. `vault_root()` 다중화, Obsidian 어댑터 재배치 | Oximemo와 무관하게 구조가 먼저 완성. 기존 볼트가 default store로 감싸진다 |
| R2 · Oximemo 읽기·연결 | 공간 탐지·등록, native ID/revision/hash 보존, ArtifactBinding 작업 연결, 앱에서 열기, 선택적 Oxibrain 검색 | 실제 볼트에 0-write. CLI `vault.migrate()` 경로 미사용. 파일 수준 읽기 전용 어댑터 |
| R3 · 안전한 편집과 실행 | expected revision을 요구하는 변경안, 충돌 감지, staging, 승인 후 적용. 블록 patch/diff·참조·댓글, 검증된 normalization | 외부 편집 충돌·부분 적용·미관측 상태를 성공으로 숨기지 않음 |
| R4 · 게시와 학습 | 내부 문서에서 공개 가능 파생본(정적 HTML/Markdown 게시본), 게시 승인·receipt·reconcile, 승인된 학습 자료 outbox | 자료 공개·원격 변경·전송 결과 불명·중복을 처리. blind retry 없음 |
| R5 · 고급 상호운용 | 메타데이터 왕복 보존, 파일 이동 추적, 첨부 자료 호환성, 동시 저장 충돌 검증 통과 시 제한적 공동 편집 | CRDT·실시간 협업 서버는 별도 제품 결정으로 남김 |

작업 분할(R1/R1A 기준): ① 기준선·호환 facade ② 자원 식별자(DocumentSpace/Store) ③ 문서 parser·profile·fixture ④ 디자인 binding·읽기 화면 ⑤ candidate 저장·보수적 stale ⑥ method/context snapshot ⑦ 기존 하네스·UI 연결 ⑧ end-to-end 회귀.

이번 범위에서 하지 않을 것: 기존 work.md/project.md/실행 기록의 삭제·일괄 HTML 변환, 대상 프로젝트에 개인 파일 추가, Oxibrain 쓰기, 임의 JavaScript 문서 실행, 실시간 협업, 검증되지 않은 보안 격리의 지원 표시.

## 11. 수용 시나리오 (요약)

전체 시나리오는 R단계 정의 시 각 단위 테스트로 구체화한다. 여기는 불변식을 요약한다.

| ID | 단계 | 시나리오 | 기대 결과 |
|---|---|---|---|
| V01 | R0 | 기존 Markdown 작업 로드·저장·실행 | 자동 변환·새 승인 없이 기존 회귀 통과 |
| V02 | R1 | JS·네트워크 없는 HTML 읽기 | 본문·표·자료 설명·필수 결론 읽힘 |
| V03 | R1 | script·event·위험 URL·외부 CSS 포함 문서 | 거부/정제 진단, 권한 있는 DOM 미실행 |
| V04 | R1 | 외부 편집 후 오래된 후보 저장 | expected revision 실패, 양쪽 내용 보존 (기존 충돌 UI 동일) |
| V05 | R1 | 동일 HTML이 참조하는 이미지 bytes 변경 | resource lock과 관련 승인 basis 변경 |
| V06 | R1 | 고정 디자인 revision을 못 읽음 | 필수 준수 생성·게시 차단; 무스타일 읽기는 명시적 표시 |
| V07 | R1 | 승인 후 필수 spec 변경 | basis 재확인 실패로 실행 거부 (기존 approved-design.json/check_approval 확장) |
| V08 | R1 | 동일 고정 입력에서 payload 재생성 | 동일 projector에서 동일 bytes/digest |
| V09 | R1A | 기존 볼트를 default store로 감싸기 | 기존 경로·기능 변화 없음, Obsidian 탐지는 어댑터 경유 |
| V10 | R1A | 여러 문서 공간 등록·기본 앱 선택 | 공간별 격리, 앱 미설치 시 기본 앱 폴백 |
| V11 | R2 | Oximemo 공간 등록·메모 읽기 | native ID·revision·원본 위치 보존, 볼트 0-write |
| V12 | R2 | Oximemo 메모를 작업에 연결 | ArtifactBinding + ContextSnapshot에 정확한 revision 고정 |
| V13 | R2 | Oximemo에서 메모 변경 후 실행 | 원본 재검사, stale 결과를 필수 근거로 채택하지 않음 |
| V14 | R2 | Oxibrain 미설치·timeout·선필터 미지원 | 참고 기능만 unavailable/UnsupportedScope, 기본 흐름 유지 |
| V15 | R3 | 블록 삭제·이동·댓글 대상 수정 | 안정 참조 유지 또는 orphan 표시, 유사 문단 자동 연결 없음 |
| V16 | R3 | 구조형 편집기 읽기→저장 왕복 | ID·유형·표 헤더·코드 공백·링크·자산 보존 |
| V17 | R3 | 파일 적용 중 crash | 저널에서 완료·복구·conflict 판정 (기존 ChangeSet 복구 확장) |
| V18 | R4 | 공개 HTML의 숨은 속성·comments·첨부 | 실제 payload 검사, CSS 숨김으로 대체하지 않음 |
| V19 | R4 | 게시 후 원본 수정 | 게시본 stale 표시, 자동 업데이트 없음 |
| V20 | R5 | Oximemo↔Sawhorse 메타데이터 왕복 | 충돌 검증 통과 전엔 제한적 모드만 |

## 12. 남은 기술 결정

| 항목 | 선택 기준 | 확정 시점 |
|---|---|---|
| HTML parser·정제 경계 | 정상/악성 fixture, unknown 보존, 깊이·크기 제한, 안정 serialization | R0/R1 |
| 편집기 | ID·속성·표·자산 왕복, 기존 Atomic Editor 대체 비용 | 원문/section은 R1, 구조형은 R3 |
| 내용 동등성 규칙 | 정규화 속성 테스트, 의미 손실 없음, 자산 closure | R3 검증 범위만 |
| DESIGN.md importer | 지원 토큰·단위·참조 범위, 기존 리소스 경로 통합 | R1 최소, 일반화는 수요 후 |
| Oximemo 파일 계약 | native ID·revision 산출 방식, 임베드·첨부 해석, 임시 복사본 필요 여부 | R2 초입 contract test |
| Oxibrain 세부 계약 | client/binary, 인증, root 등록, 사전 범위 제한 | 읽기 R2 |
| `.sawhorse/` 위치와 공간 분리 | 저널·runtime.sqlite를 공간별로 둘지 워크스페이스에 둘지, 가드 문자열 6곳 정리 | R1A 설계 시 |
| 기존 장부 이관 | SQLite와 Markdown의 현재 정본, 과거 데이터 보존 | R0 기준선 후 개별 migration |

## 13. 근거와 확인 범위

이 문서는 다음을 통합했다: 외부 대화에서 합의된 vNext 통합 설계 0.4(31개 장·50개 수용 시나리오)와 그 개정 0.5(저장 공간·저장 방식·여는 앱·검색 계층의 4계층 분리, Oximemo 읽기·연결 범위, R0–R5 재편). 개정 대화는 기존 0.4 설계의 "문서 저장소를 앱과 독립시키겠다"는 방향과 "노트 앱 어댑터 일괄 제외"의 충돌을 걷어내고, 실시간 공동 편집·양방향 동기화만 후순위로 남겼다.

2026-09-12 현재 저장소의 실제 코드(vault/workspace/sdlc/changes/schemas/workflow/ledger/harness/work_lifecycle/ingestion/packs 및 프론트 문서 UX)를 조사해 §3의 기반·간극 표와 §4.1의 이동 대상을 파일:라인 근거로 작성했다. 다만 이 문서 작성 시점에 제품을 빌드·실행하거나 실사용 Oximemo 볼트를 연결한 것은 아니며, 그 검증은 R0·R1A·R2의 수용 테스트에 명시적으로 남긴다. 공개 main의 commit SHA는 고정하지 않았으므로 R0에서 정확한 기준 commit을 기록한다.
