import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { EVENTS } from "@/lib/api";
import type { WorkspaceSnapshot } from "./types";
import { sddApi } from "./api";

/**
 * 탭의 로컬 UI 상태보다 오래 사는 작업공간 read model.
 *
 * WorkbenchPage는 화면마다 새로 마운트될 수 있지만, 동일한 볼트를 읽는 스냅샷은
 * 공유한다. 파일 watcher가 변경을 알리고, 재진입 시에는 오래된 캐시만 백그라운드로
 * 갱신한다. 진행 중 요청은 하나로 합쳐 개발 모드 StrictMode의 이중 effect도 막는다.
 */
interface WorkspaceSnapshotState {
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  error: string | null;
  loadedAt: number;
}

const REVALIDATE_AFTER_MS = 30_000;
let inFlight: Promise<WorkspaceSnapshot | null> | null = null;

export const useWorkspaceSnapshot = create<WorkspaceSnapshotState>(() => ({
  snapshot: null,
  loading: true,
  error: null,
  loadedAt: 0,
}));

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** 요청을 강제로 시작하되, 이미 진행 중인 요청이 있으면 같은 결과를 기다린다. */
export function refreshWorkspaceSnapshot(): Promise<WorkspaceSnapshot | null> {
  if (inFlight) return inFlight;
  const current = useWorkspaceSnapshot.getState();
  useWorkspaceSnapshot.setState({
    loading: current.snapshot === null,
    error: null,
  });
  inFlight = sddApi
    .snapshot()
    .then((snapshot) => {
      // 내용이 같으면 이전 객체를 그대로 둔다. 새 객체를 넣으면 볼트 watcher 가 울릴 때마다
      // 구독 화면 전체가 다시 그려져 문서 뷰와 목록이 튄다.
      const previous = useWorkspaceSnapshot.getState().snapshot;
      const next =
        previous && JSON.stringify(previous) === JSON.stringify(snapshot)
          ? previous
          : snapshot;
      useWorkspaceSnapshot.setState({
        snapshot: next,
        loading: false,
        error: null,
        loadedAt: Date.now(),
      });
      return next;
    })
    .catch((error) => {
      useWorkspaceSnapshot.setState({
        loading: false,
        error: errorText(error),
      });
      return null;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** 캐시를 즉시 보여 주고, 없거나 오래됐을 때만 다시 읽는다. */
export function ensureWorkspaceSnapshot(): Promise<WorkspaceSnapshot | null> {
  const current = useWorkspaceSnapshot.getState();
  if (
    current.snapshot &&
    Date.now() - current.loadedAt < REVALIDATE_AFTER_MS
  )
    return Promise.resolve(current.snapshot);
  return refreshWorkspaceSnapshot();
}

/** 초기화 명령처럼 이미 완성된 스냅샷을 받은 경우 별도 재조회 없이 채택한다. */
export function acceptWorkspaceSnapshot(snapshot: WorkspaceSnapshot) {
  useWorkspaceSnapshot.setState({
    snapshot,
    loading: false,
    error: null,
    loadedAt: Date.now(),
  });
}

/**
 * Workbench가 보이는 동안만 볼트 변경을 구독한다. 화면을 떠났다가 돌아오면 캐시를
 * 먼저 그리고 ensureWorkspaceSnapshot이 필요한 재검증을 시작한다.
 */
export function watchWorkspaceSnapshot(): () => void {
  if (!("__TAURI_INTERNALS__" in window)) return () => undefined;
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  void listen(EVENTS.vaultChanged, () => void refreshWorkspaceSnapshot())
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => undefined);
  return () => {
    disposed = true;
    unlisten?.();
  };
}
