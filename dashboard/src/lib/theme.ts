import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "si-workbench.theme";

function loadStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // storage unavailable — fall through
  }
  return "system";
}

export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  const prefersDark =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function syncNativeWindow(theme: Theme) {
  // Native titlebar/traffic lights follow the app theme. No-op outside Tauri.
  try {
    getCurrentWindow()
      .setTheme(theme === "system" ? null : theme)
      .catch(() => {});
  } catch {
    // running in plain browser (vite dev)
  }
}

function apply(theme: Theme) {
  const resolved = resolveTheme(theme);
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.colorScheme = resolved;
  syncNativeWindow(theme);
  return resolved;
}

interface ThemeState {
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (theme: Theme) => void;
  cycle: () => void;
  init: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: loadStored(),
  resolved: "light",
  setTheme: (theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // persistence is best-effort
    }
    set({ theme, resolved: apply(theme) });
  },
  cycle: () => {
    const order: Theme[] = ["light", "dark", "system"];
    const next = order[(order.indexOf(get().theme) + 1) % order.length];
    get().setTheme(next);
  },
  init: () => {
    const theme = get().theme;
    set({ resolved: apply(theme) });
    if (typeof matchMedia === "function") {
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (get().theme === "system") set({ resolved: apply("system") });
      });
    }
  },
}));
