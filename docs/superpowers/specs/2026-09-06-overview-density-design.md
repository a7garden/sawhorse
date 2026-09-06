# 작업대(overview) 정보 밀도 회복 + 슬롯 토글 + 톤 정비 설계

날짜: 2026-09-06. 상태: 승인됨(사용자 위임 — "모두 진행해").

## 배경

작업대(overview)가 "평범한 대시보드"처럼 비어 보인다는 피드백. 원인은 두 가지:

1. 위젯 기반 대시보드(커밋 `6184877`, 이후 `7224100` 재구성에서 본체 유실)가
   보여주던 정보 밀도(지표·할 일·실행·루틴·이슈·운영 6카드)가 현재 overview에는
   숫자 4장 + 리스트 1개 + 단계 카운트로 축소됐다.
2. 화면이 못 큰다 — 고정 마크업이라 섹션 추가·숨기기가 없다.

위젯 그리드(react-grid-layout) 복원은 기각했다: 본체 컴포넌트가 커밋된 적 없고,
구 위젯 6종의 내용은 전용 페이지와 중복이며, 자유 드래그는 1인 사용자에게
한 번 쓰고 끝나는 비용(의존성 + 레이아웃 검증 ~500줄)이다. 대신 위젯 시절의
**콘텐츠 패턴**(MetricCard·WidgetCard·스테이지 타일 — `6184877`의 HomePage에서 회수)을
새 SDD 도메인으로 이식하고, 배치는 고정 서사로 유지하되 **슬롯 단위 on/off**를 얹는다.

## 결정 사항

1. 접근 3건을 모두 수행: B(정보 밀도) → A(슬롯 토글) → C(톤 정비).
2. 데이터는 전부 `WorkspaceSnapshot`(`sddApi.snapshot()`)에서 파생 — **백엔드 변경 0**.
3. 위젯 시체 삭제: `app/src/features/dashboard/`(셸 3파일), `app/src/index.css`의
   `.dashboard-grid` 블록(141–264), `react-grid-layout` 의존성.
4. 검증은 저장소 프론트엔드 관례(tsc + vite build + 브라우저 프리뷰 육안)를 따른다.
   `app/`에는 유닛 러너가 없고 e2e는 WIP 스캐폴드뿐이라 새 테스트를 만들지 않는다.

## 슬롯 구성 (6개, overview 고정 서사)

| 슬롯 id | 내용 | 데이터 파생 |
|---|---|---|
| `metrics` | 진행 중·준비됨·기한 주의·완료 숫자 카드 4장 | `work` 상태 카운트 (기존 유지) |
| `next` | 다음에 할 일 — 기한·우선순위 정렬 상위 6건 | `work` 미완료, (기한 임박 > 우선순위 > updatedAt) |
| `stages` | 단계별 맥락 — 타일 클릭 시 백로그(board)로 이동 | `workflows` 노드 × `work` 카운트 (기존 유지 + 클릭 추가) |
| `due` | 기한 임박 — 오늘 포함 이후 7일 내 마감 미완료, 날짜 오름차순, D-day 칩 | `work.dueDate` |
| `events` | 임박 일정 — 오늘 이후 일정 5건, 종류 뱃지(milestone·review·release·meeting) | `events` |
| `done` | 최근 완료 — updatedAt 내림차순 6건, 2열 그리드 | `work.status === "done"` |

레이아웃: metrics → (next \| stages) → (due \| events) → done(전체 폭).
빈 데이터 슬롯은 빈 상태 문구를 보여준다(위젯 시절 Empty 패턴 계승).

## 슬롯 토글 (A)

- 신규 `app/src/features/workbench/overview-store.ts`: zustand 미니 스토어.
  `enabled: OverviewSlotId[]`, `toggle(id)`, `reset()`.
- 저장: localStorage `sawhorse.overview-slots`, `{ version: 1, enabled: [...] }`.
  로드 규칙: 모르는 id 버림, 유효 항목 0이면 전체 활성(플랫폼 설계의
  "비어 있으면 전부 활성" 마이그레이션 규칙과 동일한 사고).
- UX: overview 헤더에 편집 버튼(SlidersHorizontal) → Dialog에 6슬롯 Switch 목록 +
  "기본값 복원". 구 위젯 catalog UX(스위치 목록)에서 드래그·좌표만 뺀 형태.

## 톤 정비 (C)

- overview 헤더 카피를 정보형으로: 슬로건("작업의 흐름을 선명하게") 제거,
  title "오늘의 작업", subtitle "진행 N · 기한 임박 N · 완료 N".
- 밀도: 새 카드 행들은 구 위젯의 촘촘한 행 규격(11–13px, py-1.5)으로.
  기존 뷰(board 등)와 공유하는 wb-* 클래스는 건드리지 않고 overview 전용 클래스만 추가.

## 파일 구조

- 생성: `app/src/features/workbench/overview-store.ts`
- 수정: `app/src/features/workbench/WorkbenchPage.tsx` (OverviewView 재구성,
  SlotCard·DueRow·EventRow·DoneRow 추가)
- 수정: `app/src/features/workbench/workbench.css` (overview 전용 밀도 클래스)
- 삭제: `app/src/features/dashboard/{DashboardBoard,layout-store,registry}.ts`,
  `app/src/index.css` 141–264행 블록, `app/package.json`의 react-grid-layout

## 오류 처리

- localStorage 파싱 실패/스키마 불일치 → 기본값(전체 활성).
- snapshot 미초기화·오류 → 기존 InitializeView/ErrorState 경로 그대로.

## 비목표

- react-grid-layout 부활, 자유 드래그/리사이즈.
- board·calendar 등 다른 뷰의 카피·밀도 변경.
- 팩이 overview에 카드를 기여하는 스키마(플랫폼 설계의 다음 단계로 남긴다).
