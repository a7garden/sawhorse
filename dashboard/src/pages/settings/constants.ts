import type { HerdrCleanup, HerdrMode, PermissionMode } from "@/lib/types";

export const PERMISSION_OPTIONS: { value: PermissionMode; label: string }[] = [
  { value: "default", label: "기본" },
  { value: "acceptEdits", label: "편집 자동 승인" },
  { value: "bypassPermissions", label: "권한 우회 (무인 실행)" },
];

export const HERDR_MODE_OPTIONS: { value: HerdrMode; label: string }[] = [
  { value: "auto", label: "자동 (herdr 가능하면 herdr, 아니면 백그라운드)" },
  { value: "herdr", label: "herdr 전용" },
  { value: "headless", label: "백그라운드 전용" },
];

export const HERDR_CLEANUP_OPTIONS: { value: HerdrCleanup; label: string }[] = [
  { value: "closeOnSuccess", label: "성공하면 닫기" },
  { value: "keep", label: "항상 남기기" },
  { value: "closeAlways", label: "항상 닫기" },
];

/// Number inputs hand back strings, including "" while the field is being retyped.
export function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
