# 확장 탭 카탈로그 재구성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 확장 탭(`app/src/pages/PacksPage.tsx`)을 `전체 · 기능 · 워크플로우` 카테고리 탭으로 재구성하고, 발행된 워크플로우를 카탈로그에 표시한다.

**Architecture:** 프론트엔드 전용 변경. 분류는 매니페스트 기여에서 유도하되 v1 팩 목록은 전부 "기능", `workflow_catalog` 발행 워크플로우는 전부 "워크플로우"로 귀결되므로 별도 분류 함수 없이 두 데이터 소스의 조합으로 실현한다. 백엔드·store·매니페스트 스키마 무변경.

**Tech Stack:** React 18, TypeScript, Tailwind v4, lucide-react, Tauri invoke (`workflowApi.catalog()` — preview 모드에서는 `previewInvoke`가 자동 라우팅).

**Spec:** `docs/superpowers/specs/2026-09-06-extension-catalog-design.md`

## Global Constraints

- UI 카피는 한국어. 이모지 금지. 아이콘은 lucide-react만.
- 수정 파일은 `app/src/pages/PacksPage.tsx` 하나뿐. `store.ts`, `App.tsx`, 백엔드, 매니페스트 스키마 금지.
- 커밋 메시지: 컨벤셔널, 영어 (`feat:`).
- 유닛 테스트 러너가 없으므로 검증은 `npx tsc --noEmit` + 기존 playwright 빌드 게이트 + `?preview=1` 브라우저 확인으로 대신한다. 새 테스트 인프라를 만들지 않는다.
- 기존 기능(팩 상세·설정 편집·스킬 설치·액션 실행·패키지 설치 카드)을 하나도 잃지 않는다.

## File Structure

- Modify: `app/src/pages/PacksPage.tsx` (669줄) — 유일한 변경 파일.
  - lucide 아이콘 임포트 확장 (4-12줄)
  - `workflowApi`/`WorkflowDefinition` 임포트 추가 (13행 근처)
  - 모듈 수준 `TABS` 상수 + `WorkflowCard` 컴포넌트 추가 (35행 `SKILL_STATE_KO` 앞)
  - `PacksPage` 내부: `category`/`selWfId`/`workflows` 상태 추가 (69-80줄 블록)
  - 카탈로그 로딩 effect 추가 (85-90줄 effect 옆)
  - 카테고리 탭 행 삽입 (279줄 `{msg && ...}`와 281줄 broken 배너 사이가 아니라, PageHeader 뒤 279줄 앞)
  - PageHeader desc 교체 (269줄)
  - 좌 리스트 팩 행에 배지 3행 추가 (336-338줄)
  - 좌 리스트에 워크플로우 섹션 추가 (344줄 `agents` 섹션 앞)
  - 메인 영역 3분기 (317-558줄 `flex min-h-0 flex-1` 블록을 조건 분기)

## Task 1: 카테고리 탭 + 워크플로우 카드 그리드

**Files:**
- Modify: `app/src/pages/PacksPage.tsx`

**Interfaces:**
- Consumes: `workflowApi.catalog(): Promise<WorkflowDefinition[]>` (`@/features/workbench/api` — preview 모드 자동 처리). `WorkflowDefinition` (`@/features/workbench/types`): `{ id, label, description, version, nodes, edges, ... }`. `setPage(page: PageId)` (이미 67줄에서 꺼내 쓰는 store 액션).
- Produces: 모듈 상수 `CATALOG_TABS`, 컴포넌트 `WorkflowCard({ wf, onOpenStudio })`, 상태 `category: CatalogCategory`, `selWfId: string | null`, `workflows: WorkflowDefinition[]` — Task 2가 이 이름들을 그대로 쓴다.

- [ ] **Step 1: 임포트와 모듈 수준 코드 추가**

lucide 임포트(4-12줄)에 `Workflow`, `PencilRuler`를 추가한다:

```tsx
import {
  CircleAlert,
  Download,
  FolderOpen,
  HardDriveDownload,
  PencilRuler,
  Play,
  RefreshCw,
  Trash2,
  Workflow,
} from "lucide-react";
```

33줄 `import { Empty, MarkdownView, PageHeader } from "./common";` 뒤에 추가한다:

```tsx
import { workflowApi } from "@/features/workbench/api";
import type { WorkflowDefinition } from "@/features/workbench/types";
```

`SKILL_STATE_KO`(35줄) 앞에 추가한다:

```tsx
type CatalogCategory = "all" | "feature" | "workflow";

const CATALOG_TABS: { id: CatalogCategory; label: string }[] = [
  { id: "all", label: "전체" },
  { id: "feature", label: "기능" },
  { id: "workflow", label: "워크플로우" },
];

function WorkflowCard({ wf, onOpenStudio }: { wf: WorkflowDefinition; onOpenStudio: () => void }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Workflow className="size-4 shrink-0 text-muted-foreground" /> {wf.label}
          <Badge variant="outline" className="ml-auto">v{wf.version}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {wf.description && <p className="line-clamp-2 text-xs text-muted-foreground">{wf.description}</p>}
        <p className="text-[11px] text-muted-foreground">
          단계 {wf.nodes.length} · 전이 {wf.edges.length} · 앱에서 발행
        </p>
        <Button size="xs" variant="outline" onClick={onOpenStudio}>
          <PencilRuler className="size-3" /> 스튜디오에서 열기
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: 상태와 카탈로그 로딩 추가**

80줄 `const [extensionProject, setExtensionProject] = useState("default");` 뒤에 추가한다:

```tsx
  const [category, setCategory] = useState<CatalogCategory>("all");
  const [selWfId, setSelWfId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
```

90줄의 `refreshAgents` effect 뒤에 추가한다:

```tsx
  useEffect(() => {
    let alive = true;
    workflowApi
      .catalog()
      .then((rows) => { if (alive) setWorkflows(rows); })
      .catch(() => { if (alive) setWorkflows([]); });
    return () => { alive = false; };
  }, []);
```

- [ ] **Step 3: 탭 행 삽입 + desc 교체**

PageHeader desc(269줄)를 교체한다:

```tsx
        desc="이 앱이 할 수 있는 일과 일하는 방식을 여기서 얻습니다. 기능은 화면·액션·스킬을, 워크플로우는 작업의 흐름을 앱에 넣습니다."
```

`{msg && ...}` 행(279줄) 앞에 탭 행을 끼워 넣는다:

```tsx
      <div className="flex gap-1 border-b px-4 py-2">
        {CATALOG_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setCategory(t.id)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent",
              category === t.id && "bg-secondary",
            )}
          >
            {t.label}
            {t.id === "workflow" && workflows.length > 0 ? ` ${workflows.length}` : ""}
          </button>
        ))}
      </div>
```

- [ ] **Step 4: 워크플로우 탭의 메인 영역 분기**

317줄 `<div className="flex min-h-0 flex-1">`을 조건 분기로 감싼다. 이 블록의 닫는 `</div>`(558줄)까지가 기존 두 창이다. 구조:

```tsx
      {category === "workflow" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {workflows.length === 0 && (
            <Empty className="pt-16">
              발행된 워크플로우가 없습니다. 워크플로 스튜디오에서 만들거나 확장 패키지로 가져올 수 있습니다.
            </Empty>
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflows.map((wf) => (
              <WorkflowCard
                key={`${wf.id}@${wf.version}`}
                wf={wf}
                onOpenStudio={() => setPage("workflows")}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 기존 두 창 내용 그대로 (318-557줄) */}
        </div>
      )}
```

- [ ] **Step 5: 검증**

```bash
cd /Volumes/MERCURY/PROJECTS/sawhorse/app && npx tsc --noEmit
```
Expected: exit 0.

브라우저 확인 (HMR 자동 반영): `http://127.0.0.1:1420/?preview=1` 에서 (1) 탭 3개 렌더, (2) 워크플로우 탭에서 preview 워크플로우 카드 그리드, (3) "스튜디어에서 열기" 클릭 시 워크플로 페이지 이동. 데스크톱 앱 창에서도 동일 확인.

- [ ] **Step 6: Commit**

```bash
git add app/src/pages/PacksPage.tsx
git commit -m "feat: add category tabs and workflow grid to extension page"
```

## Task 2: 전체 탭 합집합 — 좌 리스트 워크플로우 섹션 + 우측 상세

**Files:**
- Modify: `app/src/pages/PacksPage.tsx`

**Interfaces:**
- Consumes: Task 1의 `category`, `selWfId`, `setSelWfId`, `workflows`, `WorkflowCard`.
- Produces: 없음 (Task 3이 좌 리스트 행 마크업을 고칠 때 이 Task의 결과 행 구조를 전제).

- [ ] **Step 1: 팩 클릭 시 워크플로우 선택 해제**

325줄 팩 행 `onClick={() => setSelId(p.id)}`를 다음으로 교체:

```tsx
                onClick={() => { setSelId(p.id); setSelWfId(null); }}
```

- [ ] **Step 2: 좌 리스트에 워크플로우 섹션 추가**

`agents` 섹션(344줄 `{agents.length > 0 && (`) 앞에 추가. `category === "all"`일 때만 렌더 — 기능 탭은 순수 팩 목록을 유지:

```tsx
          {category === "all" && workflows.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <div className="px-2 pb-1 text-[10px] font-semibold text-muted-foreground">워크플로우</div>
              {workflows.map((wf) => (
                <button
                  key={wf.id}
                  onClick={() => setSelWfId(wf.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                    selWfId === wf.id && "bg-secondary",
                  )}
                >
                  <Workflow className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{wf.label}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      v{wf.version} · 단계 {wf.nodes.length}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
```

- [ ] **Step 3: 우측 상세 분기**

359-360줄의 `{!sel && <Empty ... />}` / `{sel && (...)}` 앞단에 워크플로우 선택 분기를 추가한다. `const selWf = workflows.find((w) => w.id === selWfId) ?? null;`을 `list` 정의(82줄) 근처에 두고:

```tsx
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {selWf && (
            <div className="mx-auto max-w-xl">
              <WorkflowCard wf={selWf} onOpenStudio={() => setPage("workflows")} />
            </div>
          )}
          {!selWf && !sel && <Empty>왼쪽에서 확장을 선택하세요.</Empty>}
          {!selWf && sel && (
            /* 기존 팩 상세 JSX 그대로 (361-554줄) */
          )}
        </div>
```

- [ ] **Step 4: 검증**

```bash
cd /Volumes/MERCURY/PROJECTS/sawhorse/app && npx tsc --noEmit
```
Expected: exit 0.

`?preview=1`: 전체 탭 좌 리스트 하단에 워크플로우 섹션, 클릭 시 우측에 상세 카드, 팩 클릭 시 팩 상세로 복귀.

- [ ] **Step 5: Commit**

```bash
git add app/src/pages/PacksPage.tsx
git commit -m "feat: show published workflows in all-tab union list"
```

## Task 3: 주입 배지 + 최종 검증

**Files:**
- Modify: `app/src/pages/PacksPage.tsx`

**Interfaces:**
- Consumes: Task 1-2 결과물. `PackInfo.views/actions/skills` (`@/lib/types`).

- [ ] **Step 1: 좌 리스트 팩 행에 배지 추가**

336-338줄의 버전 행 아래에 배지 행을 추가한다:

```tsx
                  <span className="block truncate text-[10px] text-muted-foreground">
                    v{p.version} · {p.source === "builtin" ? "내장" : "사용자"}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    화면 {p.views.length} · 액션 {p.actions.length} · 스킬 {p.skills.length}
                  </span>
```

- [ ] **Step 2: 타입 체크 + e2e 빌드 게이트**

```bash
cd /Volumes/MERCURY/PROJECTS/sawhorse/app && npx tsc --noEmit && npm run build
```
Expected: exit 0 (`tsc --noEmit` + `vite build`).

```bash
cd /Volumes/MERCURY/PROJECTS/sawhorse/app && npx playwright test
```
Expected: workbench.spec 전부 통과 (확장 탭 단언 없음 — 회귀 없음을 확인).

- [ ] **Step 3: 스크린샷 증거**

`?preview=1`에서 탭별(전체/기능/워크플로우) 스크린샷 캡처해 사용자에게 보고. 데스크톱 앱(HMR)에서 사용자 직접 확인 요청.

- [ ] **Step 4: Commit**

```bash
git add app/src/pages/PacksPage.tsx
git commit -m "feat: show injection badges on extension list rows"
```

## Self-Review 기록

- Spec 커버리지: 카테고리 탭(Task 1 Step 3) / 워크플로우 카드 그리드(Task 1 Step 4) / 전체 합집합(Task 2) / 기능 2단 유지(Task 1 Step 4 else 분기) / 배지·헤더(Task 3, Task 1 Step 3) / 설치 카드 현위치 유지(건드리지 않음) — 전부 커버. 스펙의 "v2 기여 기반 분류"는 v2 workflow-only 패키지가 pseudo-pack을 만들지 않는 백엔드 동작(`activate_contributions` 조기 반환)과 현재 카탈로그 소스 조합으로 자동 실현됨을 확인했다.
- 플레이스홀더: "기존 두 창 내용 그대로" 주석은 이동 없는 보존 영역 표시이며 코드 생략이 아니다 — 해당 줄 번호를 명시했다.
- 타입 일관성: `CatalogCategory`/`CATALOG_TABS`/`selWfId`/`workflows` 이름이 Task 1→2→3에서 동일하다.

## 실행 시 주의

- **worktree 격리를 쓰지 않는다.** 사용자가 메인 체크아웃에서 `tauri dev`로 라이브 검증 중이므로 변경은 메인 체크아웃에 직접 반영돼야 HMR로 보인다. 프론트 단일 파일 변경이라 격리 이익도 없다.
- `tauri dev`가 `src-tauri`를 감시 중이지만 이 변경은 프론트 전용이라 재빌드가 없다.
