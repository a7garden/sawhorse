# Dashboard Light/Dark Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add light/dark/system theme switching to the si-workbench dashboard (Tauri v2 + React 18 + Tailwind v4).

**Architecture:** shadcn-standard CSS variable dual-scheme — `@theme inline` maps utilities to vars, `:root`/`.dark` define palettes. A zustand mini-store (`lib/theme.ts`) owns state, persists to localStorage, applies `.dark` on `<html>`, and syncs the native Tauri window theme. An inline boot script prevents first-frame flash.

**Tech Stack:** Tailwind CSS v4 (`@theme inline`), zustand 5, lucide-react, Tauri v2 window API.

## Global Constraints

- Theme modes exactly `"light" | "dark" | "system"`; default and any invalid fallback = `"system"`.
- localStorage key: `si-workbench.theme` (verbatim).
- No new npm dependencies.
- All colors via design tokens; zero hardcoded `oklch(...)`/hex in components after this plan.
- Frontend has no test runner — verification is `npm run build` + boot smoke + visual screenshots.
- Dark palette is shadcn "neutral" dark (the light palette already is shadcn neutral light).
- Commit messages in English, conventional commits.

---

### Task 1: Dual-scheme token layer + token-ize hardcoded colors

**Files:**
- Modify: `dashboard/src/index.css`
- Modify: `dashboard/src/pages/common.tsx:37`
- Modify: `dashboard/src/components/ui/badge.tsx:12`
- Modify: `dashboard/src/components/ui/checkbox.tsx:12`
- Modify: `dashboard/src/App.tsx:84`

**Interfaces:**
- Produces: CSS custom properties `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--success`, `--warning`, `--warning-foreground`, `--border`, `--input`, `--ring`, `--sidebar`, `--sidebar-foreground`, `--scrollbar-thumb` defined on `:root` (light) and `.dark`. Tailwind utilities `bg-background`, `text-warning-foreground`, `accent-primary`, etc. resolve through `@theme inline`.
- Produces: `.dark` class on `<html>` is the only switch.

- [ ] **Step 1: Rewrite `dashboard/src/index.css`**

Replace the entire file with:

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.823);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.141 0.005 285.823);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.141 0.005 285.823);
  --primary: oklch(0.21 0.006 285.885);
  --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.967 0.001 286.375);
  --secondary-foreground: oklch(0.21 0.006 285.885);
  --muted: oklch(0.967 0.001 286.375);
  --muted-foreground: oklch(0.552 0.016 285.938);
  --accent: oklch(0.967 0.001 286.375);
  --accent-foreground: oklch(0.21 0.006 285.885);
  --destructive: oklch(0.577 0.245 27.325);
  --destructive-foreground: oklch(0.985 0 0);
  --success: oklch(0.627 0.17 149.2);
  --warning: oklch(0.769 0.16 70.08);
  --warning-foreground: oklch(0.55 0.14 70);
  --border: oklch(0.92 0.004 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.067);
  --sidebar: oklch(0.985 0 0);
  --sidebar-foreground: oklch(0.141 0.005 285.823);
  --scrollbar-thumb: oklch(0.87 0.006 286.3);
}

.dark {
  --background: oklch(0.141 0.005 285.823);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.885);
  --card-foreground: oklch(0.985 0 0);
  --popover: oklch(0.21 0.006 285.885);
  --popover-foreground: oklch(0.985 0 0);
  --primary: oklch(0.92 0.004 286.32);
  --primary-foreground: oklch(0.21 0.006 285.885);
  --secondary: oklch(0.274 0.006 286.033);
  --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.274 0.006 286.033);
  --muted-foreground: oklch(0.705 0.015 286.067);
  --accent: oklch(0.274 0.006 286.033);
  --accent-foreground: oklch(0.985 0 0);
  --destructive: oklch(0.704 0.191 22.216);
  --destructive-foreground: oklch(0.985 0 0);
  --success: oklch(0.723 0.17 149.2);
  --warning: oklch(0.83 0.13 75);
  --warning-foreground: oklch(0.87 0.12 80);
  --border: oklch(1 0 0 / 12%);
  --input: oklch(1 0 0 / 16%);
  --ring: oklch(0.552 0.016 285.938);
  --sidebar: oklch(0.21 0.006 285.885);
  --sidebar-foreground: oklch(0.985 0 0);
  --scrollbar-thumb: oklch(0.32 0.007 286.1);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --radius: 0.5rem;
}

@layer base {
  * {
    @apply border-border;
  }
  html {
    color-scheme: light;
  }
  html.dark {
    color-scheme: dark;
  }
  body {
    @apply bg-background text-foreground antialiased;
    font-family:
      "Pretendard", -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    font-size: 13px;
    user-select: none;
  }
  pre,
  code,
  .selectable {
    user-select: text;
  }
}

/* thin scrollbars for the ops look */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 4px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

- [ ] **Step 2: Token-ize hardcoded colors**

`dashboard/src/pages/common.tsx` line 37:

```tsx
export const WARN_TEXT = "text-warning-foreground";
```

`dashboard/src/components/ui/badge.tsx` warning variant:

```tsx
warning: "border-transparent bg-warning/15 text-warning-foreground",
```

`dashboard/src/components/ui/checkbox.tsx` className:

```tsx
"size-3.5 shrink-0 cursor-pointer rounded border border-input accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
```

`dashboard/src/App.tsx` home badge text:

```tsx
<span className="ml-auto rounded-full bg-warning/20 px-1.5 text-[10px] font-semibold text-warning-foreground">
```

- [ ] **Step 3: Verify build**

Run: `cd dashboard && npm run build`
Expected: tsc clean, vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/index.css dashboard/src/pages/common.tsx dashboard/src/components/ui/badge.tsx dashboard/src/components/ui/checkbox.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): dual-scheme design tokens with dark palette"
```

---

### Task 2: Theme store, boot script, native window sync

**Files:**
- Create: `dashboard/src/lib/theme.ts`
- Modify: `dashboard/index.html`
- Modify: `dashboard/src/main.tsx`

**Interfaces:**
- Consumes: `.dark` class contract from Task 1.
- Produces: `useTheme` zustand store — state `{ theme: Theme, resolved: "light" | "dark" }`, actions `setTheme(theme: Theme): void`, `cycle(): void`, `init(): void`; type `export type Theme = "light" | "dark" | "system"`; helper `resolveTheme(theme: Theme): "light" | "dark"`.

- [ ] **Step 1: Create `dashboard/src/lib/theme.ts`**

```ts
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

export function systemPrefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveTheme(theme: Theme): "light" | "dark" {
  return theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
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
```

- [ ] **Step 2: Add FOUC-prevention boot script to `dashboard/index.html`**

Inside `<head>`, before the closing `</head>`:

```html
<script>
  (function () {
    try {
      var t = localStorage.getItem("si-workbench.theme");
      var dark =
        t === "dark" ||
        (t !== "light" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      if (dark) document.documentElement.classList.add("dark");
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    } catch (e) {}
  })();
</script>
```

- [ ] **Step 3: Initialize theme in `dashboard/src/main.tsx`**

Add import and one-line init before `createRoot`:

```tsx
import { useTheme } from "@/lib/theme";

useTheme.getState().init();
```

- [ ] **Step 4: Verify build**

Run: `cd dashboard && npm run build`
Expected: tsc clean, vite build succeeds.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/lib/theme.ts dashboard/index.html dashboard/src/main.tsx
git commit -m "feat(dashboard): theme store with localStorage persistence and flash-free boot"
```

---

### Task 3: Sidebar theme toggle + native theme permission

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src-tauri/capabilities/default.json`

**Interfaces:**
- Consumes: `useTheme` from Task 2 (`theme`, `resolved`, `cycle`).

- [ ] **Step 1: Add `core:window:allow-set-theme` to `dashboard/src-tauri/capabilities/default.json`**

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default capabilities for the main window",
  "windows": ["main"],
  "permissions": ["core:default", "core:event:default", "core:window:allow-set-theme"]
}
```

- [ ] **Step 2: Add toggle button to sidebar footer in `dashboard/src/App.tsx`**

Add imports:

```tsx
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";
```

Add module-level label map:

```tsx
const THEME_LABEL: Record<Theme, string> = { light: "라이트", dark: "다크", system: "시스템" };
```

Inside `App()`, subscribe:

```tsx
const theme = useTheme((s) => s.theme);
const resolved = useTheme((s) => s.resolved);
const cycleTheme = useTheme((s) => s.cycle);
```

Replace the sidebar footer line `<div className="mt-auto px-2 text-[10px] text-muted-foreground">v0.1.0</div>` with:

```tsx
<div className="mt-auto flex items-center justify-between px-2">
  <div className="text-[10px] text-muted-foreground">v0.1.0</div>
  <button
    onClick={cycleTheme}
    title={`테마: ${THEME_LABEL[theme]} (클릭하여 전환)`}
    aria-label="테마 전환"
    className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
  >
    {theme === "system" ? (
      <Monitor className="size-3.5" />
    ) : resolved === "dark" ? (
      <Moon className="size-3.5" />
    ) : (
      <Sun className="size-3.5" />
    )}
  </button>
</div>
```

Icon semantics: Monitor = following OS; Sun/Moon = manual mode, showing the resolved appearance. Clicking cycles light → dark → system.

- [ ] **Step 3: Verify build**

Run: `cd dashboard && npm run build`
Expected: tsc clean, vite build succeeds.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src-tauri/capabilities/default.json
git commit -m "feat(dashboard): sidebar light/dark/system theme toggle"
```

---

### Task 4: End-to-end verification (no commit)

**Files:** none (verification only)

- [ ] **Step 1: Boot smoke of the real Tauri debug binary** (must survive startup; catches runtime issues `cargo check`/vite cannot)

Run: `cd dashboard && npm run tauri build -- --debug --no-bundle`, then launch the binary for ~5s and confirm the process stays alive with the expected window.

- [ ] **Step 2: Visual verification in the real app**

For each mode — light, dark, system (with OS in dark, then in light) — screenshot and check: sidebar, cards, tables, badges (esp. warning badge text contrast), checkbox accent, scrollbars, dialogs. Toggle cycle works; OS theme flip while in `system` updates in real time; app restart preserves the stored mode.

- [ ] **Step 3: Report**

Summarize evidence: build output, boot smoke result, screenshots, any deviations from spec.
