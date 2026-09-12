import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { EVENTS } from "@/lib/api";
import type { WorkspaceSnapshot } from "./types";
import { sddApi } from "./api";

/**
 * A workspace read model that outlives the tab's local UI state.
 *
 * WorkbenchPage may mount fresh per screen, but snapshots reading the same vault are shared.
 * A file watcher announces changes, and on re-entry only a stale cache is refreshed in the
 * background. In-flight requests are coalesced, which also blocks dev-mode StrictMode's double effects.
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

/** Force-starts a request, but if one is already in flight, awaits the same result. */
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
      // If the content is identical, keep the previous object. Supplying a new object makes the whole
      // subscribed screen re-render every time the vault watcher fires, jolting the document view and lists.
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

/** Shows the cache immediately, re-reading only when it is missing or stale. */
export function ensureWorkspaceSnapshot(): Promise<WorkspaceSnapshot | null> {
  const current = useWorkspaceSnapshot.getState();
  if (
    current.snapshot &&
    Date.now() - current.loadedAt < REVALIDATE_AFTER_MS
  )
    return Promise.resolve(current.snapshot);
  return refreshWorkspaceSnapshot();
}

/** When a command like initialize already produced a complete snapshot, adopt it without a separate re-fetch. */
export function acceptWorkspaceSnapshot(snapshot: WorkspaceSnapshot) {
  useWorkspaceSnapshot.setState({
    snapshot,
    loading: false,
    error: null,
    loadedAt: Date.now(),
  });
}

/**
 * Subscribes to vault changes only while the Workbench is visible. Returning to the screen renders
 * the cache first, and ensureWorkspaceSnapshot starts revalidation as needed.
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
