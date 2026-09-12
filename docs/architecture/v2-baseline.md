# Sawhorse v2 기준선 (R0)

작성일: 2026-09-12. [v2 설계](v2-platform-design.md)의 R0 산출물. 구현 착수 시점의 저장소 상태와 검증 결과, 설계-코드 차이를 기록한다.

## 기준선

| 항목 | 값 |
|---|---|
| 기준 commit | `7c25d8d4ec9ca9eae66bbfd1b5df16e67bd1ddff` |
| 작업 트리 | 사용자 미커밋 변경 205 파일 위에서 착수(설계 문서·스텁 모듈·의존성 추가 포함) |
| 회귀 검증 | `cd app/src-tauri && cargo test --lib` — **통과 438 / 실패 0 / 무시 1**, 종료 코드 0 |
| 무시 1건 | `upgrade::tests::supplied_vault_copy_can_complete_upgrade` — `SAWHORSE_UPGRADE_FIXTURE` 환경변수가 가리키는 폐기 가능한 볼트 복사본이 필요한 옵트인 테스트 |

R0의 계약 고정 대상(설계 §10)별 현재 상태:

| 계약 | 고정 방법 | 상태 |
|---|---|---|
| Markdown 저장 | `sdlc.rs` 인라인 테스트(저장·읽기·frontmatter 파싱, 동시 저장 경쟁 `sdlc.rs:5079-5107`) | 기존 회귀로 고정됨 |
| SQLite 장부 | `workflow/ledger.rs`·`collab/store.rs` 테스트(instance·event·멱등) | 기존 회귀로 고정됨 |
| ChangeSet | `changes/mod.rs` 테스트(preview·apply·rollback·중단 복구·충돌) | 기존 회귀로 고정됨 |
| 승인 | `sdlc.rs` approved-design 스냅샷·`work_lifecycle.rs` `check_approval` 테스트 | 기존 회귀로 고정됨 |
| revision 동시성 | SHA-256 expected_revision 낙관 검사 + 뮤텍스 경쟁 테스트 | 기존 회귀로 고정됨 |

## 착수 시점에 추가한 변경 (동작 중립)

- `Cargo.toml`: `html5ever` 추가(shdoc/1 파싱용). `markup5ever_rcdom`은 버전 비호환으로 최종 제거했다(아래 차이 기록 3). 참조 시점에는 회귀 무영향이었다.
- `lib.rs` + 빈 모듈 스텁: `documents/`(codec·model·validation), `document_apps/`(obsidian·registry·builtin), `document_spaces.rs`. 선언만으로 동작 변화 없음.

## R1/R1A 착수 단위와 상태

| 단위 | 소유 | 내용 | 상태 |
|---|---|---|---|
| ① 기준선·호환 facade | 루트 | 이 문서 + 스텁·의존성 | 완료 |
| ② 자원 식별자 | helper `v2-spaces` | `document_spaces.rs` — DocumentSpace·SpacesConfig(`.sawhorse/spaces.json`)·기본 공간 래핑·resolve_root, 테스트 9건 | 완료 |
| 어댑터 레지스트리 | helper `v2-appreg` | `document_apps/` — DocumentAppRegistry·Obsidian 탐지 이동(`detect_vaults_from` 파라미터화)·Builtin 폴백, 테스트 11건 | 완료 |
| ③ 문서 parser·profile·fixture | helper `v2-shdoc` | `documents/` — shdoc/1 파싱·검증·canonical 직렬화·source_digest, 테스트 17건 | 완료 |
| cutover | 루트 | `vault.rs` 탐지 제거·`commands.rs` registry 경유·`vault_root()` 공간 래핑 | 완료 |
| ④ 디자인 binding·읽기 화면 | helper `v2-design`·`v2-ui` | `documents/design.rs`(DesignBinding·PresentationLock·work 폴더 바인딩 기록, 테스트 4건) + `features/documents/` ShdocView(CSP 샌드박스 읽기·원문 편집)·ArtifactEditor HTML 분기·preview `?shdoc=1` 시드·i18n | 완료 |
| ⑤ candidate 저장·보수적 stale | helper `v2-svc`·루트 | `documents/service.rs`(read_html_at·substantial_html·is_html_artifact_path, 테스트 7건). 저장은 기존 `write_document_at` 계약(내용 불문)을 그대로 사용 — HTML 저장 시 `mark_stale`·`intent_history` 자동 연결. 블록 단위 patch는 R3 | 완료(R1 수준) |
| ⑥ method/context snapshot | helper `v2-ctx`·루트 | `documents/context.rs`(capture_at·record_at → `runs/<runId>.context.json`, 테스트 7건) + 하네스 launch 시 노드 inputs 캡처 연결 | 완료(R1 수준) |
| ⑦ 하네스·UI 연결 | 루트 | `sdd_read_html_document` 명령(sdlc.rs+lib.rs), substantial 형식 분기 5곳, write 시 DesignBinding 캡처, launch 시 스냅샷 캡처 | 완료 |
| ⑧ end-to-end 회귀 | 루트 | `html_artifact_vertical_flow_from_write_to_snapshot` 수직 테스트(템플릿→저장→충돌→읽기 뷰→실질성→바인딩→스냅샷) + bun build + Playwright | 완료 |

Cutover 세부:

- `commands.rs list_obsidian_vaults` → `document_apps::registry::default_registry().detect_vaults_for("obsidian")`. 반환 타입만 `document_apps::obsidian::VaultCandidate`로 바뀌고 serde 모양(`path`·`open`)은 동일 — 프론트 변경 불요.
- `vault.rs`의 `VaultCandidate`·`parse_vault_registry`·`detect_obsidian_vaults`·관련 테스트 제거(구현은 어댑터로 이동, 중복 소멸).
- `sdlc.rs vault_root()` — `.sawhorse/spaces.json`이 있을 때만 `document_spaces::resolve_root`로 위임, 없으면 기존 설정 경로 그대로(동작 보존). 다중 공간은 spaces.json 생성 시점에 활성화된다.

## 최종 검증 (R1 수직 흐름 통합 후)

| 명령 | 결과 |
|---|---|
| `cd app/src-tauri && cargo test --lib` | **492 통과 / 0 실패 / 1 무시**(cutover 후 474 + 신규 19 − 제거한 harness `substantive` 테스트 1) |
| `cargo check`(bin 포함) | 통과, documents/ 발 경고 0건(R2/R3 선행 표면은 항목별 `#[allow(dead_code)]` 사유 표시) |
| `cd app && bun run build` | 통과(tsc --noEmit + vite build) |
| Playwright 전체 | **이 트리에서 사전 실패 상태** — 아래 판정 참조 |


**Playwright 판정**: `document-search`·`intent`·`lifecycle` 스펙 20개 중 19개가 사이드바 네비 라벨(`작업대`·`작업 문서 검색` 버튼) 대기 타임아웃으로 실패한다. 원인은 이 트리의 진행 중 작업(사용자 미커밋)에서 네비가 재편된 것(`ko/common.json`의 `nav.section.overview` 제거 등)과 구스펙의 불일치다 — `app/src` 어디에도 구스펙이 기다리는 라벨의 버튼이 없고, 문서 시스템 변경(이 문서의 단위)은 네비·라벨을 만지지 않았다. 스펙을 새 네비에 맞추는 정리는 네비 재편 작업의 소속이다. 문서 흐름 자체는 브라우저 검증으로 확인했다(아래).
## 설계-코드 차이 기록

구현 중 발견한 설계 가정과 실제 코드의 차이. 설계 문서는 이 기록으로 보정된다.

1. **설계 §3 "검색"**: `sdd_search`는 `canonical_markdown_paths`가 수집하는 .md만 본다 — HTML 정본 도입 시 이 수집기와 snippet 생성이 직접 영향. 설계가 예상한 범위와 일치(간극으로만 기록).
2. **`document_spaces` 동시성**: `save_at`의 tmp+rename은 단일 쓰기 원자성만 보장. 읽기-수정-쓰기 경합은 호출자(`vault_root()` 통합 지점)의 락이 필요 — R1A 통합 시 `sdlc.rs`의 `DOMAIN_MUTATION_LOCK` 패턴을 따른다.
3. **html5ever 0.40 / markup5ever_rcdom 0.39 비호환**(의존성 결정): rcdom 0.39는 markup5ever 0.39의 `TreeSink`를 구현하고 html5ever 0.40 파서는 0.40의 `TreeSink`를 요구해 직접 조합이 불가능(E0277 재현 확인). `documents/codec.rs`가 동일 계약의 최소 반복문 DOM을 내부에 두는 것으로 해결했고 `markup5ever_rcdom` 의존성은 제거했다. rcdom의 0.40 대응 릴리스가 나오면 내부 DOM을 교체할지 검토한다. 커스텀 DOM은 탐색·직렬화·Drop 전부 반복문 구현이라 4 MiB 한도 내 초심층 중첩에서도 스택 오버플로가 없다.
4. **template 요소**: shdoc 직렬화·블록 추출·검색에서 template 내부는 제외된다(설계 §5 "미지원 구조는 원문 보존·제한된 읽기"와 부합). 별도 지원이 필요하면 후속.
5. **DESIGN.md 바인딩 발동 조건**(v2-design 발견): `design_content`는 프로젝트에 design 리소스가 **할당**된 경우(`projects/<id>/resources.json`의 `designId`)만 적용된 DESIGN.md를 읽는다. 파일 존재만으로는 무스타일(None)이다. 또한 `design_digest`는 디자인이 없어도 빈 문자열의 sha256으로 성공하므로 존재 판별을 먼저 해야 한다. 설계 §6의 "적용된 디자인"이 실제 계약은 "할당된 리소스"임이 확인됐다.
6. **`substantial` 게이트의 메시지**: 게이트 오류 문구가 `{artifact}.md`로 고정돼 있어 HTML 산출물에서도 `.md`로 표시된다. 검사는 형식을 가리지만(`substantial_for`) 문구는 아니다 — 표시 정확화는 사용자에게 보이는 변경이므로 후속 정리로 남긴다.

## 확인 범위

Rust 회귀·프론트 빌드·브라우저 preview 검증까지 실행했다. 실제 Tauri 데스크톱 앱에서의 HTML 산출물 열림(`sdd_read_html_document` invoke)과 실제 에이전트 launch를 통한 `runs/<runId>.context.json` 생성은 수동 확인이 필요하다 — 자동화는 e2e 확장 단위에서.
