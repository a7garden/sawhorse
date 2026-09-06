# Overview Density + Slot Toggles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 작업대(overview)에 슬롯 6종(지표·다음 할 일·단계·기한 임박·임박 일정·최근 완료)과 슬롯 토글을 얹고 죽은 위젯 셸을 삭제한다.

**Architecture:** 프론트엔드 전용. `WorkspaceSnapshot`에서 파생한 6슬롯을 고정 서사로 배치하고, zustand 미니 스토어가 슬롯 on/off를 localStorage에 저장한다. 백엔드 변경 없음.

**Tech Stack:** React 18 + TypeScript + zustand + 자체 CSS(wb-* 변수). 유닛 러너 없음.

**Spec:** `docs/superpowers/specs/2026-09-06-overview-density-design.md`

## Global Constraints

- 검증 관례(저장소 프론트엔드): `npx tsc --noEmit` + `npm run build` 통과 + `?preview=1` 브라우저 육안. 새 테스트 파일을 만들지 않는다.
- 기존 뷰와 공유하는 wb-* 클래스(metrics, two-column, panel, work-row)를 재정의하지 않는다 — overview 전용 새 클래스만 추가.
- 팩/백엔드 파일(`src-tauri/**`, `plugin/**`)은 건드리지 않는다.
- 커밋 메시지: conventional commits, 영어.

---

### Task 1: Remove dead widget dashboard shell

**Files:**
- Delete: `app/src/features/dashboard/` (DashboardBoard.tsx, layout-store.ts, registry.ts)
- Modify: `app/src/index.css` (`.dashboard-grid` 블록 141–264행)
- Modify: `app/package.json` (react-grid-layout 의존성 제거)

- [ ] **Step 1: Verify zero imports remain**

Run: `grep -r "features/dashboard\|react-grid-layout" app/src --include="*.tsx" --include="*.ts" -l`
Expected: `app/src/features/dashboard/` 내부 3파일만.

- [ ] **Step 2: Delete files and dependency**

```bash
rm -rf app/src/features/dashboard
```

`app/package.json`에서 `"react-grid-layout": "^2.2.4",` 한 줄 삭제 후 `npm install --no-audit --no-fund`로 lockfile 동기화.

- [ ] **Step 3: Delete index.css block**

`app/src/index.css`의 `/* Editable dashboard grid */`(141행)부터 `.dashboard-grid .widget-remove-button:hover { … }` 닫는 중괄호(264행)까지 삭제. 정확한 끝 행은 편집 직전 파일에서 확인.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A app && git commit -m "chore(workbench): remove dead widget dashboard shell"
```

### Task 2: Overview slot store + dense slot cards

**Files:**
- Create: `app/src/features/workbench/overview-store.ts`
- Modify: `app/src/features/workbench/WorkbenchPage.tsx` (OverviewView 재구성, 신규 컴포넌트 추가)
- Modify: `app/src/features/workbench/workbench.css` (overview 전용 클래스 추가)

**Interfaces:**
- Consumes: `WorkspaceSnapshot`(work, projects, workflows, events), `useApp.setPage`(store.ts), 기존 헬퍼 `isoToday`·`formatDate`·`cx`
- Produces: `useOverviewSlots` (zustand store: `enabled: OverviewSlotId[]`, `toggle(id)`, `reset()`), `OVERVIEW_SLOTS`, type `OverviewSlotId = "metrics" | "next" | "stages" | "due" | "events" | "done"`

- [ ] **Step 1: Write overview-store.ts**

```ts
import { create } from "zustand";

export const OVERVIEW_SLOTS = [
  { id: "metrics", label: "핵심 지표", description: "진행 중·준비됨·기한 주의·완료 숫자 카드" },
  { id: "next", label: "다음에 할 일", description: "기한과 우선순위순 작업 목록" },
  { id: "stages", label: "단계별 맥락", description: "워크플로 단계별 작업 분포" },
  { id: "due", label: "기한 임박", description: "지난 것 포함 일주일 안에 마감되는 작업" },
  { id: "events", label: "임박 일정", description: "다가오는 마일스톤·회의" },
  { id: "done", label: "최근 완료", description: "방금 끝낸 작업들" },
] as const;

export type OverviewSlotId = (typeof OVERVIEW_SLOTS)[number]["id"];

const SLOT_IDS = OVERVIEW_SLOTS.map((slot) => slot.id);
const ALL_SLOTS: OverviewSlotId[] = [...SLOT_IDS];
const STORAGE_KEY = "sawhorse.overview-slots";
const STORAGE_VERSION = 1;

interface OverviewState {
  enabled: OverviewSlotId[];
  toggle: (id: OverviewSlotId) => void;
  reset: () => void;
}

function isSlotId(value: unknown): value is OverviewSlotId {
  return typeof value === "string" && (SLOT_IDS as readonly string[]).includes(value);
}

function loadEnabled(): OverviewSlotId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_SLOTS;
    const parsed = JSON.parse(raw) as { version?: unknown; enabled?: unknown };
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.enabled)) return ALL_SLOTS;
    const enabled = parsed.enabled.filter(isSlotId);
    return enabled.length ? [...new Set(enabled)] : ALL_SLOTS;
  } catch {
    return ALL_SLOTS;
  }
}

function persist(enabled: OverviewSlotId[]) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, enabled }),
    );
  } catch {
    // 저장 불가 환경(프라이빗 모드 등) — 세션 안에서만 유지된다.
  }
}

export const useOverviewSlots = create<OverviewState>()((set) => ({
  enabled: loadEnabled(),
  toggle: (id) =>
    set((state) => {
      const enabled = state.enabled.includes(id)
        ? state.enabled.filter((slot) => slot !== id)
        : [...state.enabled, id];
      persist(enabled);
      return { enabled };
    }),
  reset: () => {
    persist(ALL_SLOTS);
    set({ enabled: ALL_SLOTS });
  },
}));
```

- [ ] **Step 2: Extend imports in WorkbenchPage.tsx**

lucide 아이콘 추가: `CalendarClock`, `CircleCheck`, `SlidersHorizontal`. store 임포트 추가: `import { useApp } from "@/lib/store";`. 새 모듈 임포트: `import { OVERVIEW_SLOTS, useOverviewSlots, type OverviewSlotId } from "./overview-store";`

- [ ] **Step 3: Replace OverviewView and add row components**

`OverviewView`(595–762행)를 아래로 교체하고, `Metric` 위에 `SlotCard`·`DueRow`·`EventRow`·`DoneRow`·`daysUntil`·`dateChip`을 추가한다. 파생 데이터:

```ts
const today = isoToday();
const open = work.filter((item) => item.status !== "done");
const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const nextUp = [...open]
  .sort((a, b) => {
    const ad = a.dueDate ?? "9999-12-31";
    const bd = b.dueDate ?? "9999-12-31";
    if (ad !== bd) return ad.localeCompare(bd);
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    return b.updatedAt.localeCompare(a.updatedAt);
  })
  .slice(0, 6);
const dueSoon = open
  .filter((item) => item.dueDate && item.dueDate <= plusDays(today, 7))
  .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));
const upcomingEvents = events
  .filter((event) => (event.endDate ?? event.date) >= today)
  .sort((a, b) => a.date.localeCompare(b.date))
  .slice(0, 5);
const recentlyDone = [...work]
  .filter((item) => item.status === "done")
  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  .slice(0, 6);
```

레이아웃(스토어에서 enabled 읽어 조건 렌더):

```tsx
const enabled = useOverviewSlots((state) => state.enabled);
const show = (id: OverviewSlotId) => enabled.includes(id);
const setPage = useApp((state) => state.setPage);
```

- metrics: 기존 `wb-metric-grid` + `Metric` 4장 그대로
- (next | stages): `wb-two-column` — next는 `SlotCard`에 `WorkRow` 대신 밀도 행 재사용(기존 `WorkRow` 유지), stages 타일에 `onClick={() => setPage("board")}`
- (due | events): `wb-slot-two-col`
- done: `wb-slot-done-grid`

헤더는 정보형으로: `title="오늘의 작업"`, subtitle `진행 ${active.length} · 기한 임박 ${dueSoon.length} · 완료 ${doneCount}`.

- [ ] **Step 4: Add CSS**

`workbench.css` 끝에 `.wb-slot-two-col`(900px 미만 1열)·`.wb-slot-done-grid`(720px 미만 1열)·`.wb-dense-row`·`.wb-dense-title`·`.wb-dense-meta`·`.wb-date-chip`(+`.is-overdue`)·`.wb-event-kind` 추가. 변수는 `--wb-*` 만 사용.

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add app/src/features/workbench && git commit -m "feat(workbench): rebuild overview with dense slots"
```

### Task 3: Slot visibility editor

**Files:**
- Modify: `app/src/features/workbench/WorkbenchPage.tsx`

**Interfaces:**
- Consumes: Task 2의 `useOverviewSlots`·`OVERVIEW_SLOTS`, `Dialog({ open, onClose, title })`, `Switch({ checked, onCheckedChange })`, `Button`

- [ ] **Step 1: Add SlotSettingsDialog + header button**

OverviewView에 `slotsOpen` state, PageHeader children에 구성 버튼:

```tsx
<Button variant="outline" size="sm" onClick={() => setSlotsOpen(true)}>
  <SlidersHorizontal size={14} /> 구성
</Button>
```

다이얼로그: `OVERVIEW_SLOTS.map` → Switch 행(라벨+설명), 하단 "기본값 복원" 버튼(reset).

- [ ] **Step 2: Typecheck and commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add app/src/features/workbench && git commit -m "feat(workbench): add slot visibility editor"
```

### Task 4: Verify

- [ ] `npm run build` 통과
- [ ] 브라우저 `?preview=1` overview: 슬롯 6종 렌더, 토글 on/off 반영, 백로그 이동 확인, 스크린샷 캡처
