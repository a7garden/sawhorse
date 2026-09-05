# Settings Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the settings page (`dashboard/src/pages/SettingsPage.tsx`) into four tabs (일반/프로젝트/실행/진단), one section rendered at a time.

**Architecture:** `SettingsPage` keeps owning the draft state (`draft`/`patchDraft`/`dirty`/`save`/`toggleLogin`) and the sticky header. Four presentation components in a new `dashboard/src/pages/settings/` directory each render one tab panel and receive `draft` + `patchDraft` as props. Shared option constants and `clampInt` move to `settings/constants.ts` so sections never import from the page (no cycles).

**Tech Stack:** React 18 + TypeScript, zustand store (`@/lib/store`), existing UI primitives (`components/ui/{card,input,select,switch,button,tabs}.tsx`), Tailwind v4. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-05-settings-tabs-design.md`

## Global Constraints

- 동작 변경 금지: `ConfigView`/`ConfigPatch` 스키마, 저장 API 호출, `validate` 로직, `toggleLogin`의 즉시 `api.setLaunchAtLogin` 호출을 그대로 유지.
- UI 카피는 기존 한국어 문구를 그대로 이동 (새 문구 작성 금지, 오타 수정도 금지).
- `dashboard/src/pages/common.tsx`와 `dashboard/src/components/ui/*`는 수정 금지 (재사용만).
- 공유 체크아웃: 워킹트리에 형제 세션의 미커밋 변경이 있음. 커밋은 각 태스크가 지정한 경로만 `git add`로 스테이징할 것. `git add -A` / `git add .` 금지.
- 검증 주기: 이 프론트엔드에는 테스트 러너가 없다. 각 태스크의 테스트 = `cd dashboard && npm run build` (`tsc --noEmit` + `vite build`). 앱 스모크는 Task 6에서 1회만.
- All commands run from repo root unless noted.

---

### Task 1: Shared constants + GeneralSection

**Files:**
- Create: `dashboard/src/pages/settings/constants.ts`
- Create: `dashboard/src/pages/settings/GeneralSection.tsx`

**Interfaces:**
- Consumes: `ConfigView` from `@/lib/types`.
- Produces: `ROUTINES`, `PERMISSION_OPTIONS`, `HERDR_MODE_OPTIONS`, `HERDR_CLEANUP_OPTIONS`, `clampInt(raw: string, min: number, max: number, fallback: number): number` — Task 3 and Task 5 import these by these exact names.

- [ ] **Step 1: Create `dashboard/src/pages/settings/constants.ts`**

```ts
import type { HerdrCleanup, HerdrMode, PermissionMode, RoutineName } from "@/lib/types";

export const ROUTINES: { key: RoutineName; label: string }[] = [
  { key: "morning", label: "아침" },
  { key: "lunch", label: "점심" },
  { key: "evening", label: "저녁" },
];

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
```

- [ ] **Step 2: Create `dashboard/src/pages/settings/GeneralSection.tsx`**

일반 탭 = 기존 볼트 카드의 두 필드 + 실행 옵션 카드에서 옮긴 엑셀 폴더 + 자동 시작 스위치.

```tsx
import type { ConfigView } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export default function GeneralSection({
  draft,
  patchDraft,
  onLaunchAtLogin,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
  onLaunchAtLogin: (on: boolean) => void;
}) {
  return (
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">저장 위치</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="vault-path">볼트 경로</Label>
            <Input
              id="vault-path"
              value={draft.vaultPath}
              onChange={(e) => patchDraft((d) => (d.vaultPath = e.target.value))}
              placeholder="/path/to/vault"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="default-project">기본 프로젝트</Label>
            <Select
              id="default-project"
              className="w-full"
              value={draft.defaultProject}
              onChange={(e) => patchDraft((d) => (d.defaultProject = e.target.value))}
            >
              <option value="">(없음)</option>
              {draft.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="excel-dir">엑셀 출력 폴더</Label>
            <Input
              id="excel-dir"
              value={draft.dashboard.excelOutputDir}
              onChange={(e) => patchDraft((d) => (d.dashboard.excelOutputDir = e.target.value))}
              placeholder="/path/to/output"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">앱</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Switch
              id="launch-at-login"
              checked={draft.dashboard.launchAtLogin}
              onCheckedChange={(on) => onLaunchAtLogin(on)}
            />
            <Label htmlFor="launch-at-login">로그인 시 자동 시작</Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Build**

Run: `cd dashboard && npm run build`
Expected: passes (new files are unreferenced but type-checked).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/settings/constants.ts dashboard/src/pages/settings/GeneralSection.tsx
git commit -m "refactor(settings): extract shared constants and general section"
```

---

### Task 2: ProjectsSection

**Files:**
- Create: `dashboard/src/pages/settings/ProjectsSection.tsx`

**Interfaces:**
- Consumes: `ConfigView`, `ProjectCfg` from `@/lib/types`; `Empty` from `../common`.
- Produces: default export `ProjectsSection({ draft, patchDraft })` — Task 5 mounts it.

- [ ] **Step 1: Create `dashboard/src/pages/settings/ProjectsSection.tsx`**

기존 프로젝트 카드(추가 버튼, 프로젝트 행, 이름/경로/브랜치/ID접두/portable/검증 필드)를 그대로 이동. 탭 안에서는 카드 한 장이 전체 폭을 쓴다.

```tsx
import { Plus, Trash2 } from "lucide-react";
import type { ConfigView, ProjectCfg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Empty } from "../common";

export default function ProjectsSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">프로젝트</CardTitle>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              patchDraft((d) => {
                const p: ProjectCfg = {
                  name: "",
                  path: "",
                  workBranch: "main",
                  portableBase: "",
                  idPrefix: "",
                  verify: "",
                };
                d.projects.push(p);
              })
            }
          >
            <Plus /> 추가
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {draft.projects.length === 0 && <Empty className="py-4">등록된 프로젝트가 없습니다.</Empty>}
          {draft.projects.map((p, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  className="h-7 flex-1"
                  value={p.name}
                  onChange={(e) => patchDraft((d) => (d.projects[i].name = e.target.value))}
                  placeholder="사업명"
                  aria-label="프로젝트 이름"
                />
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`${p.name || "프로젝트"} 삭제`}
                  onClick={() => patchDraft((d) => d.projects.splice(i, 1))}
                >
                  <Trash2 />
                </Button>
              </div>
              <Input
                className="h-7"
                value={p.path}
                onChange={(e) => patchDraft((d) => (d.projects[i].path = e.target.value))}
                placeholder="프로젝트 경로"
                aria-label="프로젝트 경로"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  className="h-7"
                  value={p.workBranch}
                  onChange={(e) => patchDraft((d) => (d.projects[i].workBranch = e.target.value))}
                  placeholder="작업 브랜치"
                  aria-label="작업 브랜치"
                />
                <Input
                  className="h-7"
                  value={p.idPrefix}
                  onChange={(e) => patchDraft((d) => (d.projects[i].idPrefix = e.target.value))}
                  placeholder="ID 접두 (예: FDR)"
                  aria-label="ID 접두"
                />
                <Input
                  className="h-7"
                  value={p.portableBase}
                  onChange={(e) => patchDraft((d) => (d.projects[i].portableBase = e.target.value))}
                  placeholder="portable 기준 경로"
                  aria-label="portable 기준 경로"
                />
                <Input
                  className="h-7"
                  value={p.verify}
                  onChange={(e) => patchDraft((d) => (d.projects[i].verify = e.target.value))}
                  placeholder="검증 명령"
                  aria-label="검증 명령"
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd dashboard && npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/settings/ProjectsSection.tsx
git commit -m "refactor(settings): extract projects section"
```

---

### Task 3: ExecutionSection

**Files:**
- Create: `dashboard/src/pages/settings/ExecutionSection.tsx`

**Interfaces:**
- Consumes: `ConfigView`, `HerdrCleanup`, `HerdrMode`, `PermissionMode` from `@/lib/types`; `ROUTINES`, `PERMISSION_OPTIONS`, `HERDR_MODE_OPTIONS`, `HERDR_CLEANUP_OPTIONS`, `clampInt` from `./constants`.
- Produces: default export `ExecutionSection({ draft, patchDraft })` — Task 5 mounts it.

- [ ] **Step 1: Create `dashboard/src/pages/settings/ExecutionSection.tsx`**

좌열 = 루틴 예약 카드 + 실행 옵션 카드(claude 실행 파일·권한 모드만 — 엑셀 폴더와 자동 시작은 Task 1의 GeneralSection으로 이동함). 우열 = herdr 세션 카드 전체. JSX는 기존 SettingsPage에서 문구·필드 그대로 이동.

```tsx
import type { ConfigView, HerdrCleanup, HerdrMode, PermissionMode } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  HERDR_CLEANUP_OPTIONS,
  HERDR_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  ROUTINES,
  clampInt,
} from "./constants";

export default function ExecutionSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  return (
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">루틴 예약</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {ROUTINES.map((r) => {
              const s = draft.dashboard.schedules[r.key];
              return (
                <div key={r.key} className="flex items-center gap-2">
                  <Switch
                    id={`sched-${r.key}`}
                    checked={s.enabled}
                    onCheckedChange={(on) =>
                      patchDraft((d) => {
                        d.dashboard.schedules[r.key].enabled = on;
                      })
                    }
                  />
                  <Label htmlFor={`sched-${r.key}`} className="w-10">
                    {r.label}
                  </Label>
                  <Input
                    className="w-24"
                    value={s.time}
                    onChange={(e) =>
                      patchDraft((d) => {
                        d.dashboard.schedules[r.key].time = e.target.value;
                      })
                    }
                    placeholder="HH:MM"
                    aria-label={`${r.label} 루틴 시각`}
                  />
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground">
              시각이 지나도 앱이 꺼져 있었다면 자동 실행하지 않고 홈에 알립니다.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">실행 옵션</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="claude-bin">claude 실행 파일</Label>
              <Input
                id="claude-bin"
                value={draft.dashboard.claudeBin}
                onChange={(e) => patchDraft((d) => (d.dashboard.claudeBin = e.target.value))}
                placeholder="claude"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="perm-mode">권한 모드</Label>
              <Select
                id="perm-mode"
                className="w-full"
                value={draft.dashboard.permissionMode}
                onChange={(e) =>
                  patchDraft((d) => (d.dashboard.permissionMode = e.target.value as PermissionMode))
                }
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                무인 루틴·구현 실행에는 권한 우회가 필요합니다. 안전망은 플러그인 승인·범위 게이트와 훅입니다.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">herdr 세션</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="herdr-mode">실행 방식</Label>
            <Select
              id="herdr-mode"
              className="w-full"
              value={draft.dashboard.herdr.mode}
              onChange={(e) =>
                patchDraft((d) => (d.dashboard.herdr.mode = e.target.value as HerdrMode))
              }
            >
              {HERDR_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-muted-foreground">
              herdr로 실행하면 잡이 보이는 터미널 세션이 됩니다 — 도중에 이어받고, 승인
              프롬프트에 직접 답하고, 대시보드를 재시작해도 세션이 살아남습니다.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="herdr-bin">herdr 실행 파일</Label>
              <Input
                id="herdr-bin"
                value={draft.dashboard.herdr.bin}
                onChange={(e) => patchDraft((d) => (d.dashboard.herdr.bin = e.target.value))}
                placeholder="herdr"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-session">세션 이름</Label>
              <Input
                id="herdr-session"
                value={draft.dashboard.herdr.session}
                onChange={(e) =>
                  patchDraft((d) => (d.dashboard.herdr.session = e.target.value))
                }
                placeholder="(기본 세션)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-cleanup">끝난 뒤 탭</Label>
              <Select
                id="herdr-cleanup"
                className="w-full"
                value={draft.dashboard.herdr.cleanup}
                onChange={(e) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.cleanup = e.target.value as HerdrCleanup),
                  )
                }
              >
                {HERDR_CLEANUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-parallel">동시 실행</Label>
              <Input
                id="herdr-parallel"
                type="number"
                min={1}
                max={8}
                value={draft.dashboard.herdr.maxParallel}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.maxParallel = clampInt(e.target.value, 1, 8, 1)),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-start">기동 대기 (초)</Label>
              <Input
                id="herdr-start"
                type="number"
                min={10}
                max={600}
                value={draft.dashboard.herdr.startTimeoutSec}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.startTimeoutSec = clampInt(
                        e.target.value,
                        10,
                        600,
                        60,
                      )),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-timeout">최대 실행 (분, 0=무제한)</Label>
              <Input
                id="herdr-timeout"
                type="number"
                min={0}
                value={draft.dashboard.herdr.jobTimeoutMin}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.jobTimeoutMin = clampInt(
                        e.target.value,
                        0,
                        10080,
                        120,
                      )),
                  )
                }
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="herdr-notify"
              checked={draft.dashboard.herdr.notify}
              onCheckedChange={(on) => patchDraft((d) => (d.dashboard.herdr.notify = on))}
            />
            <Label htmlFor="herdr-notify">승인 대기·실패 시 herdr 알림</Label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            잡마다 「{draft.dashboard.herdr.workspaceLabel}」 워크스페이스에 탭 하나가
            생깁니다. 승인 대기가 실제로 쓸모 있으려면 권한 모드를 `default` 또는
            `acceptEdits`로 두세요.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd dashboard && npm run build`
Expected: passes.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/settings/ExecutionSection.tsx
git commit -m "refactor(settings): extract execution section"
```

---

### Task 4: DiagnosticsSection

**Files:**
- Create: `dashboard/src/pages/settings/DiagnosticsSection.tsx`

**Interfaces:**
- Consumes: `Diagnostics` from `@/lib/types`; `Empty` from `../common`; `Badge`, `Button`, `Card*` primitives.
- Produces: default export `DiagnosticsSection({ diag, vaultPath, onRefresh })` where `diag: Diagnostics | null`, `vaultPath: string`, `onRefresh: () => void` — Task 5 mounts it.

- [ ] **Step 1: Create `dashboard/src/pages/settings/DiagnosticsSection.tsx`**

기존 진단 카드 그대로. 두 참조만 바뀐다: `draft.vaultPath` → `vaultPath` prop, `refreshDiagnostics()` → `onRefresh()`.

```tsx
import { RefreshCw } from "lucide-react";
import type { Diagnostics } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "../common";

export default function DiagnosticsSection({
  diag,
  vaultPath,
  onRefresh,
}: {
  diag: Diagnostics | null;
  vaultPath: string;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">진단</CardTitle>
          <Button size="xs" variant="outline" onClick={onRefresh}>
            <RefreshCw /> 다시 검사
          </Button>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {!diag ? (
            <Empty className="py-4">검사 결과가 없습니다.</Empty>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">설정 파일</span>
                <Badge variant={diag.configExists ? "success" : "destructive"}>
                  {diag.configExists ? "정상" : "없음"}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">볼트 경로</span>
                <Badge variant={diag.vaultPathOk ? "success" : "destructive"}>
                  {diag.vaultPathOk ? "정상" : "문제"}
                </Badge>
                <span className="truncate text-[11px] text-muted-foreground" title={vaultPath}>
                  {vaultPath}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">claude CLI</span>
                <Badge variant={diag.claudeOk ? "success" : "destructive"}>
                  {diag.claudeOk ? "정상" : "없음"}
                </Badge>
                {diag.claudeVersion && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {diag.claudeVersion}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">herdr</span>
                <Badge
                  variant={
                    diag.herdr.mode === "headless"
                      ? "secondary"
                      : diag.herdr.serverOk
                        ? "success"
                        : "warning"
                  }
                >
                  {diag.herdr.mode === "headless"
                    ? "사용 안 함"
                    : diag.herdr.serverOk
                      ? "서버 연결됨"
                      : diag.herdr.binOk
                        ? "서버 없음"
                        : "미설치"}
                </Badge>
                <span className="truncate text-[11px] text-muted-foreground">
                  다음 잡: {diag.herdr.effectiveRunner === "herdr" ? "herdr 세션" : "백그라운드"}
                  {diag.herdr.version ? ` · ${diag.herdr.version}` : ""}
                </span>
              </div>
              {diag.projects.map((p) => (
                <div key={p.name} className="flex items-center gap-2 rounded border px-2 py-1">
                  <span className="w-24 truncate text-xs font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <Badge variant={p.pathOk ? "success" : "destructive"}>경로</Badge>
                  <Badge variant={p.gitOk ? "success" : "destructive"}>git</Badge>
                  <Badge
                    variant={
                      p.branchOk == null ? "secondary" : p.branchOk ? "success" : "warning"
                    }
                  >
                    브랜치
                  </Badge>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Build**

Run: `cd dashboard && npm run build`
Expected: passes. (If `HerdrDiag` fields `serverOk`/`effectiveRunner` are flagged, verify against `dashboard/src/lib/types.ts:204-219` — do not edit the section's JSX copy; the field names come from the original page.)

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/settings/DiagnosticsSection.tsx
git commit -m "refactor(settings): extract diagnostics section"
```

---

### Task 5: Rewire SettingsPage with tabs

**Files:**
- Modify: `dashboard/src/pages/SettingsPage.tsx` (replace whole file)

**Interfaces:**
- Consumes: the four section default exports and `ROUTINES` from `./settings/*` (Tasks 1-4); `Tabs` from `@/components/ui/tabs` (generic `Tabs<T extends string>({ tabs, value, onChange })`).
- Produces: nothing — this is the app-facing page.

- [ ] **Step 1: Replace `dashboard/src/pages/SettingsPage.tsx` with:**

```tsx
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ConfigPatch, ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { Empty, PageHeader } from "./common";
import DiagnosticsSection from "./settings/DiagnosticsSection";
import ExecutionSection from "./settings/ExecutionSection";
import GeneralSection from "./settings/GeneralSection";
import ProjectsSection from "./settings/ProjectsSection";
import { ROUTINES } from "./settings/constants";

type SettingsTab = "general" | "projects" | "execution" | "diagnostics";

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "general", label: "일반" },
  { value: "projects", label: "프로젝트" },
  { value: "execution", label: "실행" },
  { value: "diagnostics", label: "진단" },
];

function validate(d: ConfigView): string | null {
  if (d.vaultPath.trim().length === 0) return "볼트 경로를 입력하세요.";
  const names = new Set<string>();
  for (const p of d.projects) {
    if (p.name.trim().length === 0) return "프로젝트 이름이 비어 있습니다.";
    if (names.has(p.name)) return `프로젝트 이름이 중복됩니다: ${p.name}`;
    names.add(p.name);
    if (p.path.trim().length === 0) return `${p.name} 프로젝트의 경로가 비어 있습니다.`;
  }
  if (d.defaultProject.length > 0 && !names.has(d.defaultProject))
    return "기본 프로젝트가 프로젝트 목록에 없습니다.";
  for (const r of ROUTINES) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.dashboard.schedules[r.key].time.trim()))
      return `${r.label} 루틴 시각은 HH:MM 형식이어야 합니다.`;
  }
  if (d.dashboard.claudeBin.trim().length === 0) return "claude 실행 파일을 입력하세요.";
  return null;
}

export default function SettingsPage() {
  const config = useApp((s) => s.config);
  const diag = useApp((s) => s.diag);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const refreshDiagnostics = useApp((s) => s.refreshDiagnostics);
  const openWizard = useApp((s) => s.openWizard);

  const [tab, setTab] = useState<SettingsTab>("general");
  const [draft, setDraft] = useState<ConfigView | null>(config ? structuredClone(config) : null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setDraft(config ? structuredClone(config) : null);
  }, [config]);

  const dirty = useMemo(
    () => config != null && draft != null && JSON.stringify(draft) !== JSON.stringify(config),
    [config, draft],
  );

  function patchDraft(fn: (d: ConfigView) => void) {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  }

  async function save() {
    if (!draft) return;
    const problem = validate(draft);
    if (problem) {
      setMsg({ ok: false, text: problem });
      return;
    }
    setSaving(true);
    setMsg(null);
    try {
      const patch: ConfigPatch = {
        vaultPath: draft.vaultPath.trim(),
        defaultProject: draft.defaultProject,
        projects: draft.projects,
        schedules: draft.dashboard.schedules,
        excelOutputDir: draft.dashboard.excelOutputDir,
        claudeBin: draft.dashboard.claudeBin,
        permissionMode: draft.dashboard.permissionMode,
        launchAtLogin: draft.dashboard.launchAtLogin,
        herdr: draft.dashboard.herdr,
      };
      await api.saveConfig(patch);
      await refreshConfig();
      await refreshDiagnostics();
      setMsg({ ok: true, text: "설정을 저장했습니다." });
    } catch (e) {
      setMsg({ ok: false, text: `저장 실패: ${String(e)}` });
    } finally {
      setSaving(false);
    }
  }

  async function toggleLogin(on: boolean) {
    patchDraft((d) => {
      d.dashboard.launchAtLogin = on;
    });
    try {
      await api.setLaunchAtLogin(on);
    } catch (e) {
      setMsg({ ok: false, text: `자동 시작 설정 실패: ${String(e)}` });
    }
  }

  return (
    <div>
      <PageHeader title="설정" desc="볼트·프로젝트·루틴과 실행 옵션을 관리합니다.">
        <Button size="sm" variant="ghost" onClick={openWizard}>
          마법사
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(config ? structuredClone(config) : null);
            setMsg(null);
          }}
        >
          되돌리기
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? "저장 중…" : "저장"}
        </Button>
      </PageHeader>

      {msg && (
        <div className={`px-4 pt-2 text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.text}
        </div>
      )}

      {!draft ? (
        <Empty>설정을 불러오는 중…</Empty>
      ) : (
        <>
          <div className="sticky top-[58px] z-10 bg-[var(--workspace)] px-4 pt-3 pb-2">
            <Tabs tabs={TABS} value={tab} onChange={setTab} />
          </div>
          {tab === "general" && (
            <GeneralSection
              draft={draft}
              patchDraft={patchDraft}
              onLaunchAtLogin={(on) => void toggleLogin(on)}
            />
          )}
          {tab === "projects" && <ProjectsSection draft={draft} patchDraft={patchDraft} />}
          {tab === "execution" && <ExecutionSection draft={draft} patchDraft={patchDraft} />}
          {tab === "diagnostics" && (
            <DiagnosticsSection
              diag={diag}
              vaultPath={draft.vaultPath}
              onRefresh={() => void refreshDiagnostics()}
            />
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Check for leftover references**

Run: `grep -n "HERDR_MODE_OPTIONS\|PERMISSION_OPTIONS\|clampInt\|Grid\|Badge\|Switch\|Select" dashboard/src/pages/SettingsPage.tsx`
Expected: no matches at all — every listed symbol has moved out of the page.

- [ ] **Step 3: Build**

Run: `cd dashboard && npm run build`
Expected: passes with no unused-import errors.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/SettingsPage.tsx
git commit -m "feat(settings): split settings page into four tabs"
```

---

### Task 6: App smoke (conditional)

**Files:** none.

**Interfaces:** Consumes the running app; produces verification evidence only.

- [ ] **Step 1: Check for a running app instance**

Run: `pgrep -fl "sawhorse|si-workbench"`
- If any process matches: a user-owned instance is running. Tauri single-instance makes a second launch exit silently — SKIP steps 2-3 and record "smoke skipped: app already running" as the outcome. Do not kill the user's instance.
- If no match: continue.

- [ ] **Step 2: Launch the app in the background**

Use the process supervisor (`hub op:start`), not a blocking shell call:
- application: `npm`, args: `["run", "tauri", "dev"]`, cwd: `dashboard`, ready: log regex `Running|Local:`, timeout 120.
Wait for readiness, then confirm the window process exists (`pgrep -fl sawhorse`).

- [ ] **Step 3: Verify behaviors and stop**

Confirm in the settings page:
1. 탭 4개(일반/프로젝트/실행/진단) 전환 동작.
2. 일반 탭에서 볼트 경로 수정 → 프로젝트 탭으로 이동 → 다시 일반 탭: 수정 내용 유지 + 저장 버튼 활성화(dirty).
3. 실행 탭: 루틴/실행옵션(좌), herdr(우) 2열 배치.
4. 진단 탭: 배지 렌더링 + 다시 검사 버튼 동작.
5. 되돌리기 클릭 시 draft가 config로 복원되고 저장 버튼 비활성화.

Then stop the supervised process.

- [ ] **Step 4: Record outcome**

No commit. Report build result + smoke result (or skip reason) in the final summary.
