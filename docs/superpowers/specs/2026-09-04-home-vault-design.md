# 홈 페이지 확장 + 볼트 관리 탭 설계

- 날짜: 2026-09-04
- 상태: 사용자 리뷰 대기
- 선행: `2026-09-04-dashboard-design.md` (운영 대시보드 v1)

## 배경

홈 페이지가 정보 대비 공간 대비 여유가 크다. 스토어에 이미 로드된 데이터 중 홈에서 미사용:
`todos`(일지 오늘/내일), `improvements` 상세(카운트만 표시), `inboxCount`, 진단 양수 항목.
사용자 요구: 홈을 "오늘의 업무 + 활동 요약 + 볼트 현황"으로 채우고, 볼트 검사/정리를 할 수 있는
전용 탭을 추가한다.

## 목표 / 비목표

목표
1. 홈에 3개 카드 추가: 오늘의 업무, 활동 요약, 볼트 현황(요약)
2. "볼트" 탭 신설: 결정론 빠른 검사, 인박스(미승격) 목록, claude 인박스 승격 검토 잡 트리거
3. 백엔드: `audit_vault` command, 미승격 항목 목록 command, `promote` JobKind 추가

비목표
- 플러그인 파일(skills/, hooks/, scripts/) 변경 — 새 스킬 추가도 금지. 승격 검토는 일반 프롬프트 잡
- 링크 그래프/중복 노트 탐지 같은 무거운 의미론 검사
- 검사 결과 자동 수정 — 수정은 사용자가 노트 뷰어/claude 잡으로 명시적으로

## 설계 결정 (사용자 미확인분은 권장안 기본, 리뷰에서 확정)

- D1. 홈 "볼트 현황"은 볼트 탭과 겹치므로 3줄 요소(미승격 총계/오늘 일지/최근 변경)로 최소화
- D2. 승격 검토 잡의 개선 노트 생성(볼트 쓰기) 승인 — 플러그인 루틴 잡이 일지·개선 노트를 쓰는 것과
  같은 선. 대시보드 자체 쓰기 원칙(승인 3키 + 할 일 토글)은 유지된다

## 접근 (채택: B 이원화)

볼트 검사는 Rust 결정론(즉시·무료·재현 가능)으로, 의미 판단이 필요한 정리(인박스 승격)만 claude 잡.
전부 claude(A)는 잦은 검사에 30초+ 대기와 토큰, 전부 Rust(C)는 "정리"를 못 한다.

## 홈 페이지

기존 섹션(진단 배너, 놓친 스케줄, 루틴 3카드) 아래 `lg:grid-cols-3` 그리드:

```
[오늘의 업무 (span 2)] [활동 요약]
[볼트 현황] [개선 사이클(기존 이동)] [실행 중 잡(기존 이동)]
```

### 오늘의 업무 (span 2)
- 일지 today 섹션을 체크박스 리스트로. 토글 시 `toggle_todo` 즉시 호출(기존 TodosPage와 동일 API)
- 완료 항목은 취소선. 상단에 "오늘 N/M" 진행 표시
- "내일 N건" 접기 버튼 → 펼치면 tomorrow 섹션(읽기 전용)
- 일지 파일이 없거나 항목이 비면 Empty + "일지 열기"(문서 탭, 오늘 일지 경로 전달은 2차 — v1은 문서 탭 이동만)
- 근거: `TodoSections { date, today, tomorrow, fileExists }` 이미 스토어에 있음

### 활동 요약 (span 1)
- 오늘 잡 성공/실패 수(완료 시각 기준, `fmtDate` 재사용)
- 최근 실패 1건: 라벨·시각, 클릭 → 작업 탭
- "마지막 리포트" 행: 문서 탭 이동 버튼

### 볼트 현황 (span 1)
- 미승격 총계(숫자, 클릭 → 볼트 탭)
- 오늘 일지: 있음/없음 배지
- 최근 변경 개선 노트 3건(mtimeMs 내림, 클릭 → 개선 탭)
- 카드 헤더 "볼트 관리 →" 링크

## 볼트 관리 탭 (사이드바 신설, id "vault")

### 빠른 검사 (Rust 결정론)
- 버튼 + 탭 진입 시 캐시 없으면 1회 자동 실행
- `VaultAudit { issues: AuditIssue[], journal: { todayExists, missing: string[] }, scannedAtMs }`
- `AuditIssue { severity: "error"|"warn"|"info", path, message }` (path는 절대 경로, 없으면 "")
- 검사 항목 (vault.rs 기존 파서 재활용, 새 의존성 0):
  1. 개선 노트 status 오타/누락 — 허용집합: 제안/승인대기/승인/구현중/부분구현/구현완료/보류/반려
     (skills/improve/SKILL.md frontmatter 주석 기준)
  2. 승인 3키 불일치 — approve=true ↔ status=="승인" / approved 날짜 형식(YYYY-MM-DD)
  3. dependsOn/dependents의 id가 실제 노트 id 집합에 없음 (dangling)
  4. 일지: 오늘 없음(error), 최근 7일 결손(info) — 위치는 기존 todos 파서와 동일 일지 디렉터리
  5. 구조: 사업 `<name>/개선` 폴더·템플릿 노트 누락 (info) — init-vault가 만드는 기준 구조
- 이슈 행: 심각도 배지 + 메시지 + 경로. path가 개선 노트면 클릭 → 노트 뷰(문서 탭 뷰어 패턴 재사용)

### 인박스 (미승격)
- 사업별 `<idPrefix> 문제목록.md`의 `## 신규 (미승격)` 항목 나열 (신규 command, `inbox_count` 파서 확장)
- 항목 행: 사업 배지 + 텍스트. 목록 노트 열기 버튼 → 노트 뷰

### 정리 작업 (claude 잡)
- 버튼 1개: "인박스 승격 검토" — `enqueueJob({ kind: "promote" })` → 작업 탭 스트리밍
- build_job 규칙: vault_path 비면 "볼트 경로가 설정되지 않았습니다" 에러(기존 initVault와 동일), cwd=볼트
- 프롬프트(일반 지시문, 스킬 아님): 미승격 항목을 읽고 개별 판단 → 개선 노트로 승격(템플릿·frontmatter 준수,
  문제목록 섹션에서 제거) 또는 근거와 함께 유지. 무인 실행(permissionMode는 dashboard 설정값), 명시적 버튼이 게이트

## 백엔드 (Rust)

- `commands::audit_vault() -> VaultAudit` — vault.rs에 스캐너 추가. 설정 없으면 빈 결과+에러 아님
  (홈/볼트 탭이 빈 상태를 이미 처리하므로 issues=[] 반환)
- `commands::list_unpromoted() -> Vec<UnpromotedItem { project, idPrefix, text, listPath }>`
- `jobs::build_job`에 `"promote"` arm 추가, label "인박스 승격 검토"
- FE 계약: types.ts에 `VaultAudit`/`AuditIssue`/`UnpromotedItem`, api.ts에 `auditVault()`/`listUnpromoted()`,
  store에 `audit: VaultAudit | null`, `refreshAudit()` 추가

## 검증

- Rust: audit 스캐너 유닛테스트 — 정상 fixture(이슈 0) + 위반 fixture(status 오타, 3키 불일치, dangling dep,
  일지 결손) 각 1건 이상. 기존 28건 스위트에 추가
- FE: tsc + vite 빌드, headless Chromium 렌더 스모크(빈 설정 상태에서 홈/볼트 탭 크래시 없음)
- 실물: tauri dev에서 ① 홈 카드 렌더와 할 일 토글이 볼트에 반영 ② 볼트 탭 검사 실행 → 이슈 목록
  ③ 승격 잡 enqueue → 작업 탭 스트리밍 · 완료 후 재검사에서 미승격 수 감소
