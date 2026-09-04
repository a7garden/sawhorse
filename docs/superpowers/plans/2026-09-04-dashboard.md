# si-workbench 운영 대시보드 구현 계획

> **For agentic workers:** 이 계획은 단일 세션에서 인라인 실행한다(superpowers:executing-plans 방식).
> 스펙: `docs/superpowers/specs/2026-09-04-dashboard-design.md`

**Goal:** Tauri 2 + React 데스크톱 운영 대시보드(설정 폼 편집, 개선 사이클 실행·승인, 루틴 예약, 할 일·문서 열람).

**Architecture:** 웹뷰는 뷰만, 도메인 로직은 전부 Rust(Tauri command + event). 잡은 전역 FIFO 직렬 실행, claude CLI를 stream-json으로 구동해 진행을 스트리밍한다. 별도 데몬 없이 앱 자체가 상주(트레이).

**Tech Stack:** Tauri 2, tokio, serde_json(preserve_order), serde_yaml, notify, React 18, TS, Vite, Tailwind v4, shadcn 스타일 셀프 벤더 컴포넌트, zustand, react-markdown.

## Global Constraints

- 플러그인 기존 파일(skills/, hooks/, scripts/, README.md) 변경 금지. 새 코드는 `dashboard/` 아래에만.
- 설정 정본은 `~/.claude/si-workbench/config.json`. 앱 키는 `dashboard` 블록. 모르는 키 보존 필수.
- 볼트 쓰기는 승인 3키 갱신과 할 일 체크 토글/추가뿐. 그 외 볼트 변경 없음.
- 원격 저장소 작업(push) 코드 없음. svn 상태 변경 없음.
- UI 문구 한국어. 코드/커밋 영어.
- 커밋: conventional (`feat(dashboard): ...`).

---

### Task 1: 프론트엔드 스캐폴드 + 계약 레이어

**Files (Create):** `dashboard/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`,
`src/main.tsx`, `src/index.css`, `src/App.tsx`, `src/lib/types.ts`, `src/lib/api.ts`,
`src/lib/store.ts`, `src/lib/markdown.ts`, `src/components/ui/*`(button card badge checkbox input
label switch select table tabs dialog separator textarea scroll)

**Interfaces (Produces — Rust/페이지가 공유하는 유일한 계약):**

```ts
// lib/types.ts
interface Schedules { morning: RoutineSched; lunch: RoutineSched; evening: RoutineSched }
interface RoutineSched { enabled: boolean; time: string }            // "HH:MM"
interface DashboardCfg { schedules: Schedules; excelOutputDir: string; claudeBin: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions"; launchAtLogin: boolean }
interface ProjectCfg { name: string; path: string; workBranch: string; portableBase: string;
  idPrefix: string; verify: string }
interface ConfigView { exists: boolean; vaultPath: string; defaultProject: string;
  projects: ProjectCfg[]; dashboard: DashboardCfg }
interface ImprovementNote { project: string; path: string; id: string; title: string;
  url: string; category: string; priority: string; status: string; approve: boolean;
  approved: string; verified: string; dependsOn: string[]; dependents: string[];
  commits: string[]; mtimeMs: number }
interface TodoItem { index: number; text: string; checked: boolean }
interface TodoSections { date: string; today: TodoItem[]; tomorrow: TodoItem[]; fileExists: boolean }
interface VaultNode { name: string; rel: string; dir: boolean; size: number; mtimeMs: number }
interface Job { id: string; kind: "design"|"implement"|"routine"|"excel"; label: string;
  status: "queued"|"running"|"success"|"failed"|"cancelled"|"interrupted";
  project?: string; createdAtMs: number; startedAtMs?: number; finishedAtMs?: number;
  exitCode?: number; error?: string }
interface ProgressEntry { tsMs: number; kind: "init"|"text"|"tool"|"result";
  text?: string; tool?: string; summary?: string; isError?: boolean }
interface Diagnostics { configExists: boolean; vaultPathOk: boolean; claudeOk: boolean;
  claudeVersion?: string; projects: { name: string; pathOk: boolean; gitOk: boolean;
  branchOk: boolean | null }[] }
interface MissedRoutine { key: string; routine: "morning"|"lunch"|"evening"; date: string; scheduledAt: string }
```

```ts
// lib/api.ts — invoke 래퍼 + listen 상수 (이름은 백엔드 commands.rs와 1:1)
getConfig(): Promise<ConfigView>;            saveConfig(patch: Partial<DashboardCfg> & { vaultPath?: string; defaultProject?: string; projects?: ProjectCfg[] }): Promise<void>
diagnostics(): Promise<Diagnostics>
listImprovements(project?: string): Promise<ImprovementNote[]>
readNote(path: string): Promise<{ markdown: string; frontmatter: Record<string, unknown> }>
approveNote(path: string): Promise<void>
listTodos(): Promise<TodoSections>;          toggleTodo(section: "today"|"tomorrow", index: number, checked: boolean): Promise<void>
addTodo(section: "today"|"tomorrow", text: string): Promise<void>
listVaultTree(): Promise<VaultNode[]>;       readVaultNote(rel: string): Promise<{ title: string; markdown: string }>
enqueueJob(req: { kind: Job["kind"]; project?: string; ids?: string[]; routine?: "morning"|"lunch"|"evening" }): Promise<Job>
cancelJob(id: string): Promise<void>;        listJobs(): Promise<Job[]>
jobLog(id: string): Promise<string[]>;       jobReport(id: string): Promise<string | null>
runRoutineNow(routine): Promise<Job>;        listMissed(): Promise<MissedRoutine[]>
dismissMissed(key: string, run: boolean): Promise<MissedRoutine[]>
setLaunchAtLogin(on: boolean): Promise<void>
// events: "job-progress" {jobId, entry}, "job-finished" {job}, "vault-changed" {areas: string[]}, "schedule-missed" {missed: MissedRoutine}
```

- [ ] `npm install` 성공 (`@tauri-apps/api@^2 react react-dom zustand lucide-react react-markdown remark-gfm`, dev: `vite @vitejs/plugin-react typescript tailwindcss @tailwindcss/vite @types/react @types/react-dom @tauri-apps/cli`)
- [ ] `npm run build`(tsc + vite) 통과 — 컴포넌트·App 셸까지

### Task 2: Rust 크레이트 스캐폴드

**Files:** `dashboard/src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`, `capabilities/default.json`,
`src/main.rs`, `src/lib.rs`, `src/state.rs`

- tauri 2 (features: `tray-icon`), tauri-plugin-autostart, tauri-plugin-single-instance, tauri-plugin-opener,
  tokio(full), serde+serde_json(preserve_order)+serde_yaml, notify(debounce-crossbeam? plain + 수동 디바운스), uuid(v4, getrandom), chrono, dirs, thiserror
- state.rs: `AppState` = Mutex<PathBuf>(app_data_dir) + Mutex<Vec<Job>> + Mutex<HashMap<routine, String>>(last_run/missed).
  앱데이터 레이아웃: `logs/<id>.jsonl`, `reports/<id>.md`, `state.json`, `jobs.jsonl`.
- [ ] `cargo check` 통과(빈 명령 등록 상태)

### Task 3: config.rs

- `load() -> ConfigView`: JSON Value 읽고 타입 뷰 추출(케멀 케이스 키: vaultPath, improve.projects).
- `save(patch)`: Value에 알려진 키만 반영해 저장. `serde_json::Value` + preserve_order로
  키 순서 보존. tmp+rename 원자적.
- `diagnostics()`: vault 실존, `claude --version`(2초 타임아웃), 프로젝트별 path/git/.git,
  브랜치 존재(`git branch --list <workBranch>` — read-only).
- 테스트: 저장 시 모르는 키 보존 + 키 순서 보존 + 기본값 채움(dashboard 블록 자동 생성).

### Task 4: vault.rs

- `scan_improvements(vault, project?) -> Vec<ImprovementNote>`: `사업/*/개선/*.md`,
  제외 { 개선.md, *문제목록.md, *.base }. frontmatter YAML → 구조체. 파일명에서
  `<ID> ` 접두를 떼고 제목 복원.
- `approve(path)`: 전제 `status==승인대기 && approve==false`. frontmatter 블록만 재직렬화
  (Mapping 삽입순서 유지), 본문 바이트 그대로, tmp+rename.
- `list_todos / toggle_todo / add_todo`: 섹션 헤더 `## 오늘 할 일` / `## 내일 할 일`,
  항목 `^\s*-\s\[( |x|X)\]\s?(.*)$`. 토글 = 해당 줄 `[ ]`↔`[x]`만. 없으면 생성(날짜 제목+섹션 골격).
- `vault_tree / read_note`: 재귀 트리(숨김·`.obsidian`·첨부 바이너리 제외, md/base만 노출).
- 테스트: 승인 쓰기 전후 본문 바이트 동일 + 3키만 변화, 전제 위반 에러, 할 일 토글 멱등·주변 줄 불변.

### Task 5: jobs.rs

- 스폰 명령: unix `claude -p <prompt> --output-format stream-json --verbose --permission-mode <mode>`,
  windows `cmd /c claude …`(설정 `claudeBin` 교체 가능). cwd: design/implement=project.path, 그 외=vaultPath.
- 파서: 줄 → ProgressEntry. `type=system/init`→init, `assistant.message.content[].{text|tool_use}`→text/tool
  (tool summary: tool 이름 + 입력의 명령/경로/프롬프트 요약 120자), `result`→result(is_error).
- 라이프사이클: queued→running→success/failed/cancelled. result.is_error=true 또는 exit≠0 → failed.
  앱 재시작 후 running으로 남은 잡 → interrupted로 표시.
- 큐: tokio mpsc + 워커 1개. 히스토리 append jobs.jsonl. 로그: stdout/stderr 원문 라인 전부.
- 테스트(fake-claude 셸 스크립트가 stream-json 샘플 출력): 이벤트 순서, 성공/실패 판정, 취소.

### Task 6: scheduler.rs + watcher.rs

- 판정(순수 함수로 추출해 단위 테스트): `decide(now, sched, last_run_date, app_started_at) ->
  Run | Missed | Idle`. 규칙: enabled && last_run≠오늘 && now≥오늘 시각.
  now−시각 ≤2분(앱이 켜진 채 통과) → Run, 그 외 → Missed. Missed는 state에 적재 + `schedule-missed` 이벤트.
  `dismiss_missed(key, run)`: run=true면 큐 등록 + last_run=오늘.
- watcher: notify RecursiveMode::Recursive, 1초 디바운스 → `vault-changed {areas}`(개선/일지/문서 추정).
- 테스트: decide 4분기(정상 실행/놓침/이미실행/비활성).

### Task 7: commands.rs + lib.rs 조립 + 트레이

- 위 계약의 command 전부 바인딩. 이벤트는 AppHandle.emit.
- 트레이: 표시/숨기기, 루틴 3개 즉시 실행, 종료. single-instance. autostart(set_launch_at_login).
- [ ] `cargo test` 전부 통과, `cargo build` 성공

### Task 8: 프론트 페이지 (위임 가능 — Task 1 계약 고정 후)

- 홈/개선/작업/할 일/문서/설정 6페이지 + 사이드바 셸. 이벤트 구독은 store에서 1회.
- 개선 상세: `readNote` 마크다운 렌더 + 승인 버튼(다이얼로그: 변경 대상 요약 표시는
  본문 `### 변경 대상` 절 발췌).
- [ ] `npm run build` 통과, 수동 시나리오: 설정 저장 → 개선 목록 → 승인 → 설계 큐 → 진행 표시

### Task 9: 아이콘·번들링·최종 검증

- 512px PNG 생성(python zlib 스크립트) → `tauri icon`.
- `npm run build`, `cargo test --release`, `cargo build`(debug) 전부 통과.
- `tauri dev` 부팅 스모크(창 생성 로그 확인 후 종료).

### Task 10: 문서·커밋

- `dashboard/README.md`(빌드·실행·스크린샷 역할 설명). 루트 README는 건드리지 않음.
- 마일스톤별 커밋: scaffold / backend / frontend / docs.
