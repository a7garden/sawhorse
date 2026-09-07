import type { HerdrCleanup, HerdrMode, PermissionMode } from "@/lib/types";

export const PERMISSION_OPTIONS: { value: PermissionMode; key: string }[] = [
  { value: "default", key: "exec.perm.default" },
  { value: "acceptEdits", key: "exec.perm.acceptEdits" },
  { value: "bypassPermissions", key: "exec.perm.bypass" },
];

export const HERDR_MODE_OPTIONS: { value: HerdrMode; key: string }[] = [
  { value: "auto", key: "exec.herdrMode.auto" },
  { value: "herdr", key: "exec.herdrMode.herdr" },
  { value: "headless", key: "exec.herdrMode.headless" },
];

export const HERDR_CLEANUP_OPTIONS: { value: HerdrCleanup; key: string }[] = [
  { value: "closeOnSuccess", key: "exec.cleanup.closeOnSuccess" },
  { value: "keep", key: "exec.cleanup.keep" },
  { value: "closeAlways", key: "exec.cleanup.closeAlways" },
];

/// Number inputs hand back strings, including "" while the field is being retyped.
export function clampInt(
  raw: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
