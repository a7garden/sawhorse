import { create } from "zustand";

export const OVERVIEW_SLOTS = [
  {
    id: "metrics",
    label: "핵심 지표",
    description: "진행 중·준비됨·기한 주의·완료 숫자 카드",
  },
  {
    id: "next",
    label: "다음에 할 일",
    description: "기한과 우선순위순 작업 목록",
  },
  {
    id: "stages",
    label: "단계별 맥락",
    description: "워크플로 단계별 작업 분포",
  },
  {
    id: "due",
    label: "기한 임박",
    description: "지난 것 포함 일주일 안에 마감되는 작업",
  },
  {
    id: "events",
    label: "임박 일정",
    description: "다가오는 마일스톤·회의",
  },
  {
    id: "done",
    label: "최근 완료",
    description: "방금 끝낸 작업들",
  },
] as const;

export type OverviewSlotId = (typeof OVERVIEW_SLOTS)[number]["id"];

const SLOT_BY_ID = Object.fromEntries(
  OVERVIEW_SLOTS.map((slot) => [slot.id, slot]),
) as Record<OverviewSlotId, (typeof OVERVIEW_SLOTS)[number]>;

function isSlotId(value: unknown): value is OverviewSlotId {
  return typeof value === "string" && value in SLOT_BY_ID;
}

const STORAGE_KEY = "sawhorse.overview-slots";
const STORAGE_VERSION = 1;
const ALL_SLOTS: OverviewSlotId[] = OVERVIEW_SLOTS.map((slot) => slot.id);

interface OverviewState {
  enabled: OverviewSlotId[];
  toggle: (id: OverviewSlotId) => void;
  reset: () => void;
}

function loadEnabled(): OverviewSlotId[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ALL_SLOTS;
    const parsed = JSON.parse(raw) as { version?: unknown; enabled?: unknown };
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.enabled)) {
      return ALL_SLOTS;
    }
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
