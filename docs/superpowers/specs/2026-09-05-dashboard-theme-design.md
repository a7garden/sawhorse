# 대시보드 라이트/다크 테마 설계

날짜: 2026-09-05
상태: 승인 (사용자 채팅 승인 + 수면 중 자동 진행 지시로 리뷰 게이트 생략)

## 결정 사항 (사용자 선택)

- 모드: 라이트 / 다크 / 시스템 3종. 기본값 `system`.
- 컨트롤: 사이드바 하단 아이콘 버튼 (설정 페이지 진입 없이 전환).
- 저장: localStorage (프론트 전용, 기기별 취향이므로 config.json 동기화 불필요).

## 접근

수동 구현 (shadcn 표준 패턴). `next-themes`는 SSR 플래시 방지가 핵심 가치인데
Tauri SPA에는 SSR이 없어 이점이 없고, 의존성 추가 대비 ~40줄이면 충분.

## 설계

### 1. 토큰 구조 — `dashboard/src/index.css`

- `@theme`의 색상을 `var(--x)` 참조로 변경.
- `:root`에 현 라이트 OKLCH 값 그대로, `.dark`에 shadcn neutral 다크 팔레트
  (기존 라이트가 shadcn neutral 라이트이므로 정합).
- `--color-warning-foreground` 신설: 라이트 `oklch(0.55 0.14 70)`, 다크는 밝은 호박색
  (예: `oklch(0.83 0.12 75)`).
- `html { color-scheme: light }` → `:root` light / `html.dark` dark.
- 스크롤바 thumb 색을 토큰(`--scrollbar-thumb`)으로 추출해 다크에서 밝게.
- 다크에서 `success`/`warning`/`destructive`는 명도 상향 보정.

### 2. 하드코딩 색 제거

`--color-warning-foreground` / `primary` 토큰으로 교체:

- `pages/common.tsx` `WARN_TEXT` → `text-warning-foreground`
- `components/ui/badge.tsx:12` warning 변체 → 동일
- `components/ui/checkbox.tsx:12` accent → `accent-primary`
- `App.tsx` 뱃지 텍스트 → `text-warning-foreground`

안 하면 다크에서 경고 텍스트 대비 붕괴.

### 3. 테마 상태 — `dashboard/src/lib/theme.ts` (신설)

- `type Theme = "light" | "dark" | "system"`. zustand 미니 스토어.
- localStorage 키 `sawhorse.theme`. 파싱 실패/모르는 값 → `system` 폴백.
- `resolve(theme)`: `system`이면 `matchMedia("(prefers-color-scheme: dark)")` 결과.
- `system` 상태에서 media query change 리스너로 OS 전환 실시간 반영.
- 적용: `<html>`에 `.dark` 클래스 토글 + `color-scheme` + Tauri
  `getCurrentWindow().setTheme()`로 네이티브 타이틀바 동기화 (`system`이면 `null`).
  실패 시 조용히 무시 (브라우저 dev 모드 대비).
- 초기화는 `main.tsx`에서 1회.

### 4. FOUC 방지 — `dashboard/index.html`

- `<head>` 인라인 스크립트가 React 부팅 전 localStorage를 읽어 `.dark` 부여.
  CSP null이라 인라인 허용. 첫 프레임부터 정확한 테마.

### 5. 사이드바 토글 — `dashboard/src/App.tsx`

- 하단 `v0.1.0` 옆 아이콘 버튼.
- 표시: 현재 적용 테마 기준 Sun/Moon, `system` 모드일 때 Monitor 아이콘.
- 클릭 시 `light → dark → system` 순환. `title`에 현재 모드 표시.

### 6. Tauri 권한

`setTheme` 호출을 위해 `src-tauri/capabilities`에 `core:window:allow-set-theme`
권한 확인/추가. 누락 시 앱에서 permission 에러 → 조용히 무시되지만 타이틀바 미동기화.

## 오류 처리

- localStorage 파싱 실패/미지원 → `system`.
- matchMedia 미지원(구형) → 다크 아님으로 간주.
- Tauri setTheme 실패 → 무시 (웹 콘텐츠 테마는 영향 없음).

## 검증

1. `npm run build` (tsc + vite).
2. Tauri 디버그 바이너리 부팅 스모크 (5초 생존).
3. 시각 검증: 라이트/다크/시스템 각 모드 스크린샷, OS 테마 전환 실시간 반영,
   재시작 후 설정 유지 확인.
4. 테스트 인프라 없음(프론트) — 시각 검증이 증거. 신규 테스트 러너 도입 안 함.

## 비목표

- 설정 페이지 테마 선택기 (사이드바 토글로 충분).
- config.json 연동, 다중 창 테마, 테마 전환 애니메이션.
