# 설정창 상단 탭 분할 설계 (2026-09-05)

## 배경

설정 페이지(`dashboard/src/pages/SettingsPage.tsx`)는 6장의 카드(볼트, 프로젝트, 루틴 예약, 실행 옵션, herdr 세션, 진단)를 `lg:grid-cols-2` 2열 그리드에 나열한다. 문제:

- 오른쪽 열(루틴+실행옵션+herdr+진단)이 왼쪽 열(볼트+프로젝트)보다 훨씬 길어 비대하고, 왼쪽에는 빈 공간이 크다.
- herdr 카드가 입력 7개 + 스위치 + 안내문으로 밀도가 가장 높다.
- 저장 위치(볼트/프로젝트)·실행 정책(루틴/실행/herdr)·상태(진단)가 계층 없이 섞여 있다.

## 목표 / 비목표

**목표**: 4개 섹션 탭(일반/프로젝트/실행/진단)으로 분할해 한 번에 한 섹션만 보여주고, 탭 안에서 위계를 정리한다.

**비목표**:

- 설정 스키마(`ConfigView`/`ConfigPatch`)·저장 API·`validate` 로직 변경 없음.
- 활성 탭의 URL·전역 스토어 동기화 없음 (컴포넌트 state).
- 섹션 컴포넌트의 다른 페이지 재사용은 고려하지 않음.

## 구조

```
SettingsPage (draft 상태 소유)
├─ PageHeader: 마법사·되돌리기·저장 (기존 그대로, 전체 draft 기준)
├─ 저장 피드백 msg (헤더 아래, 탭 전환과 무관하게 유지)
├─ Tabs: 일반 | 프로젝트 | 실행 | 진단 — 헤더 바로 아래 스티키 (top-[58px], 헤더 border에 맞춤)
└─ 활성 탭 패널 1개만 렌더
```

### 탭 구성 (기존 카드 → 이동)

| 탭 | 내용 |
| --- | --- |
| 일반 | 볼트 경로, 기본 프로젝트, 엑셀 출력 폴더, 로그인 시 자동 시작 |
| 프로젝트 | 프로젝트 목록 (추가/삭제/필드 편집) |
| 실행 | 루틴 예약 / claude 실행 파일·권한 모드 / herdr 세션. 탭 안 `lg:grid-cols-2`: 좌(루틴+claude+권한), 우(herdr). 기존 Card 스타일은 섹션 내 그룹 단위로 유지 |
| 진단 | 진단 배지 + 다시 검사 |

### 상태·동작 (기존 유지)
- `draft`/`patchDraft`/`dirty`/`save`는 SettingsPage 레벨 그대로. 탭을 옮겨도 편집 내용이 유지되고, 저장·검증(`validate`)은 설정 전체 기준.
- 활성 탭은 SettingsPage `useState`, 기본 `"일반"`.
- `toggleLogin`의 즉시 `api.setLaunchAtLogin` 호출을 포함해 기존 동작 그대로 유지.
- `draft == null` (로딩 중)이면 탭 없이 `Empty`만 렌더 (기존과 동일).

## 파일 구성

- 신설 `dashboard/src/pages/settings/`:
  - `GeneralSection.tsx` — props: `{ draft, patchDraft, onLaunchAtLogin }`
  - `ProjectsSection.tsx` — props: `{ draft, patchDraft }`
  - `ExecutionSection.tsx` — props: `{ draft, patchDraft }`
  - `DiagnosticsSection.tsx` — props: `{ diag, vaultPath, onRefresh }` (draft 전체 대신 문자열 하나만)
- 수정 `SettingsPage.tsx`: 상수(`ROUTINES`, `PERMISSION_OPTIONS`, `HERDR_MODE_OPTIONS`, `HERDR_CLEANUP_OPTIONS`)와 herdr 숫자 입력 전용인 `clampInt`는 `settings/constants.ts`로 이동. `validate`는 전역 저장 검증이므로 SettingsPage에 유지.
- 탭은 기존 `components/ui/tabs.tsx` 프리미티브 재사용 (현재 미사용 상태).

## 검증

- `cd dashboard && npm run build` — `tsc --noEmit` + `vite build`.
- UI 스모크: 실행 중 앱 인스턴스가 있으면 생략(Tauri single-instance가 새 인스턴스를 무알림 종료시킴). 없으면 `npm run tauri dev` 또는 vite dev + invoke 목킹으로 ① 탭 전환 ② 탭 이동 후 편집 내용 유지 ③ dirty 시 저장 버튼 활성화 확인.
- Rust(`cargo test`)는 설정 로직 변경이 없어 영향 없음.

## 위험

- 공유 체크아웃: 워킹트리에 형제 세션의 미커밋 변경이 다수(App.tsx, common.tsx, card.tsx, index.css 등). 본 작업 커밋은 settings 관련 파일만 스테이징하고, `common.tsx`(PageHeader)와 `tabs.tsx`는 재사용만 하고 수정하지 않는다.
