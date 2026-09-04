# 홈 페이지 확장 + 볼트 관리 탭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 홈에 오늘의 업무·활동 요약·볼트 현황 카드를 추가하고, 볼트 빠른 검사(Rust 결정론) + 미승격 목록 + claude 인박스 승격 검토 잡을 제공하는 "볼트" 탭을 신설한다.

**Architecture:** 도메인 로직은 전부 Rust(vault.rs 스캐너, jobs.rs 잡 종류), 웹뷰는 뷰만. FE↔Rust 계약은 `src/lib/types.ts` + `api.ts`가 유일 — commands.rs와 1:1. 검사는 결정론 규칙(Rust), 의미 판단 정리만 claude 잡(스펙 접근 B).

**Tech Stack:** Tauri 2 (Rust, serde_yaml/serde_json/chrono), React 18 + TS + Tailwind v4 + shadcn 셀프 벤더, zustand.

**Spec:** `docs/superpowers/specs/2026-09-04-home-vault-design.md`

## Global Constraints

- 플러그인 파일(skills/, hooks/, scripts/, README.md) 변경 금지. 새 코드는 `dashboard/` 아래만.
- 볼트 쓰기는 기존 범위(승인 3키, 할 일 토글/추가) 유지 — 이 계획은 볼트 쓰기 추가 없음.
- UI 문구 한국어, 코드/커밋 영어, conventional commits (`feat:`, `test:`, `refactor:`...).
- `parking_lot::Mutex` 잠금은 즉시 unwrap 규칙. Guard를 if-let scrutinee에 걸쳐 await 금지 — `let taken = lock().take();` 패턴.
- FE: ts-no-tiny-functions 규칙(한 줄 위임 함수 금지 — store 셀렉터·invoke 래퍼는 예외).
- `tauri::spawn` 금지 — `tauri::async_runtime::spawn` (Builder setup은 tokio 밖).
- pages는 frozen lib/(`src/lib/`, `src/components/ui/`) 수정 최소화 — 이번 계획에서 lib 수정은 Task 4(계약 파일)만.
- 기존 28건 cargo 테스트는 항상 green 유지.

---

### Task 1: 볼트 감사 스캐너 (Rust)

**Files:**
- Modify: `dashboard/src-tauri/src/vault.rs` (개선 노트 섹션 뒤, `// ---------- journal todos ----------` 앞에 추가; `mod tests`에 테스트)
- Modify: `dashboard/src-tauri/src/commands.rs` (command 추가)
- Modify: `dashboard/src-tauri/src/lib.rs` (handler 등록)

**Interfaces:**
- Consumes: `vault::scan_improvements(vault, None, projects) -> Vec<ImprovementNote>`, `vault::journal_path(vault) -> PathBuf` (기존).
- Produces: `vault::audit_vault(vault: &Path, projects: &[String]) -> VaultAudit`, 타입 `VaultAudit { issues: Vec<AuditIssue>, journal: JournalAudit, scanned_at_ms: u64 }`, `AuditIssue { severity: String, path: String, message: String }`, `JournalAudit { today_exists: bool, missing: Vec<String> }`, command `audit_vault()`.

- [ ] **Step 1: 실패하는 테스트 작성** — `vault.rs`의 `mod tests`에 추가:

```rust
fn audit_write_note(vault: &Path, name: &str, yaml: &str) {
    let p = vault.join("사업").join("FDR").join("개선").join(name);
    std::fs::write(p, format!("---\n{yaml}---\n\n본문.\n")).unwrap();
}

#[test]
fn audit_clean_vault_has_no_issues() {
    let vault = fixture_vault("audit-ok");
    // 오늘 일지 작성 — 없으면 error 이슈 1건
    std::fs::write(
        journal_path(&vault),
        "---\ntype: 일지\n---\n\n## 오늘 할 일\n\n- [ ] A\n",
    )
    .unwrap();
    let audit = audit_vault(&vault, &["FDR".to_string()]);
    assert!(audit.issues.is_empty(), "unexpected: {:?}", audit.issues);
    assert!(audit.journal.today_exists);
}

#[test]
fn audit_flags_bad_status_and_approval_mismatch() {
    let vault = fixture_vault("audit-bad");
    audit_write_note(&vault, "FDR-003 상태 오타.md", "id: FDR-003\nstatus: 완료\napprove: false\n");
    audit_write_note(&vault, "FDR-004 승인 불일치.md", "id: FDR-004\nstatus: 승인대기\napprove: true\napproved: 9월1일\n");
    let audit = audit_vault(&vault, &["FDR".to_string()]);
    let msgs: Vec<&str> = audit.issues.iter().map(|i| i.message.as_str()).collect();
    assert!(msgs.iter().any(|m| m.contains("FDR-003") && m.contains("허용 집합 밖")));
    assert!(msgs.iter().any(|m| m.contains("FDR-004") && m.contains("3키 불일치")));
    assert!(msgs.iter().any(|m| m.contains("FDR-004") && m.contains("YYYY-MM-DD")));
}

#[test]
fn audit_flags_dangling_dependency() {
    let vault = fixture_vault("audit-dep");
    audit_write_note(&vault, "FDR-005 유령 의존.md", "id: FDR-005\nstatus: 제안\napprove: false\ndepends_on: [FDR-999]\n");
    let audit = audit_vault(&vault, &["FDR".to_string()]);
    assert!(audit.issues.iter().any(|i| i.message.contains("FDR-999")));
}
```

- [ ] **Step 2: 테스트 실패 확인** — `cargo test -p si-workbench-dashboard audit_` → 컴파일 에러(함수 없음).

- [ ] **Step 3: 구현** — `vault.rs`에 추가 (`// ---------- vault audit ----------` 섹션):

```rust
// ---------- vault audit ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditIssue {
    pub severity: String, // "error" | "warn" | "info"
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JournalAudit {
    pub today_exists: bool,
    pub missing: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultAudit {
    pub issues: Vec<AuditIssue>,
    pub journal: JournalAudit,
    pub scanned_at_ms: u64,
}

/// skills/improve/SKILL.md frontmatter 어휘 (2026-09 기준)
const STATUS_SET: [&str; 8] =
    ["제안", "승인대기", "승인", "구현중", "부분구현", "구현완료", "보류", "반려"];

pub fn audit_vault(vault: &Path, projects: &[String]) -> VaultAudit {
    let mut issues = Vec::new();

    // 개선 노트 규칙 (1: status 어휘, 2: 승인 3키, 3: dangling 의존성)
    let notes = scan_improvements(vault, None, projects);
    let ids: std::collections::HashSet<&str> = notes.iter().map(|n| n.id.as_str()).collect();
    for n in &notes {
        if !STATUS_SET.contains(&n.status.as_str()) {
            issues.push(AuditIssue {
                severity: "error".into(),
                path: n.path.clone(),
                message: format!("{}: status '{}' — 허용 집합 밖", n.id, n.status),
            });
        }
        if n.approve {
            if n.status != "승인" {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!("{}: approve=true인데 status='{}' — 승인 3키 불일치", n.id, n.status),
                });
            }
            if chrono::NaiveDate::parse_from_str(&n.approved, "%Y-%m-%d").is_err() {
                issues.push(AuditIssue {
                    severity: "warn".into(),
                    path: n.path.clone(),
                    message: format!("{}: approved '{}' — YYYY-MM-DD 아님", n.id, n.approved),
                });
            }
        }
        for d in n.depends_on.iter().chain(n.dependents.iter()) {
            if !ids.contains(d.as_str()) {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!("{}: 의존성 '{d}' 노트 없음 (dangling)", n.id),
                });
            }
        }
    }

    // 일지 (4)
    let today = chrono::Local::now().date_naive();
    let today_exists = journal_path(vault).is_file();
    if !today_exists {
        issues.push(AuditIssue {
            severity: "error".into(),
            path: String::new(),
            message: "오늘 일지가 없습니다".into(),
        });
    }
    let mut missing = Vec::new();
    for i in 1..=7 {
        let d = today - chrono::Duration::days(i);
        if !vault.join("일지").join(format!("{d}.md")).is_file() {
            missing.push(d.to_string());
        }
    }
    if !missing.is_empty() {
        issues.push(AuditIssue {
            severity: "info".into(),
            path: String::new(),
            message: format!("최근 7일 중 일지 없는 날: {}", missing.join(", ")),
        });
    }

    // 구조 (5)
    for project in projects {
        let dir = vault.join("사업").join(project).join("개선");
        if !dir.is_dir() {
            issues.push(AuditIssue {
                severity: "info".into(),
                path: dir.to_string_lossy().to_string(),
                message: format!("'{project}' 개선 폴더 없음 (init-vault 기준 구조)"),
            });
        }
    }

    VaultAudit {
        issues,
        journal: JournalAudit { today_exists, missing },
        scanned_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }
}
```

- [ ] **Step 4: 테스트 통과** — `cargo test -p si-workbench-dashboard audit_` → 3 passed.

- [ ] **Step 5: command 노출** — `commands.rs` (`list_inbox_count` 뒤):

```rust
#[tauri::command]
pub fn audit_vault() -> vault::VaultAudit {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vault::VaultAudit {
            issues: vec![],
            journal: vault::JournalAudit { today_exists: false, missing: vec![] },
            scanned_at_ms: 0,
        };
    }
    let projects: Vec<String> = view.projects.iter().map(|p| p.name.clone()).collect();
    vault::audit_vault(Path::new(&view.vault_path), &projects)
}
```

`lib.rs` invoke_handler 목록에 `commands::audit_vault,` 추가.

- [ ] **Step 6: 전체 테스트 + 커밋**

```bash
cd dashboard/src-tauri && cargo test && cd ../..
git add dashboard/src-tauri
git commit -m "feat(dashboard): deterministic vault audit scanner"
```

---

### Task 2: 미승격 항목 목록 (Rust)

**Files:**
- Modify: `dashboard/src-tauri/src/vault.rs` (`inbox_count` 섹션), `mod tests`
- Modify: `dashboard/src-tauri/src/commands.rs`, `dashboard/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `inbox_count`의 문제목록 탐색 로직(리팩터 대상).
- Produces: `vault::list_unpromoted(vault: &Path, projects: &[(String, String)]) -> Vec<UnpromotedItem>`, `UnpromotedItem { project: String, id_prefix: String, text: String, list_path: String }`, command `list_unpromoted()`. `inbox_count`는 `section_items(...).len()`로 동작 유지.

- [ ] **Step 1: 실패하는 테스트** — `mod tests`에:

```rust
#[test]
fn list_unpromoted_reads_new_section() {
    let vault = fixture_vault("unpromoted");
    let items = list_unpromoted(&vault, &[("FDR".to_string(), "FDR".to_string())]);
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].text, "목업 버튼 위치가 어색함 (fdrView.do)");
    assert_eq!(items[0].project, "FDR");
    assert!(items[0].list_path.ends_with("FDR 문제목록.md"));
}
```

- [ ] **Step 2: 실패 확인** — `cargo test -p si-workbench-dashboard list_unpromoted` → 컴파일 에러.

- [ ] **Step 3: 구현 + 리팩터** — `count_section_items`를 `section_items`로 교체 (클린 커트오버 — `count_section_items` 삭제):

```rust
fn section_items(text: &str, header: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim_end();
        if t.starts_with("## ") {
            if in_section {
                break;
            }
            in_section = t == header;
            continue;
        }
        if in_section && t.starts_with("- ") {
            items.push(t[2..].trim().to_string());
        }
    }
    items
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnpromotedItem {
    pub project: String,
    pub id_prefix: String,
    pub text: String,
    pub list_path: String,
}

pub fn list_unpromoted(vault: &Path, projects: &[(String, String)]) -> Vec<UnpromotedItem> {
    let mut out = Vec::new();
    for (name, id_prefix) in projects {
        let dir = vault.join("사업").join(name).join("개선");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let matches = if id_prefix.is_empty() {
                fname.ends_with("문제목록.md")
            } else {
                fname == &format!("{id_prefix} 문제목록.md")
            };
            if !matches {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for item in section_items(&text, "## 신규 (미승격)") {
                out.push(UnpromotedItem {
                    project: name.clone(),
                    id_prefix: id_prefix.clone(),
                    text: item,
                    list_path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    out
}
```

`inbox_count` 마지막 줄은 `total += section_items(&text, "## 신규 (미승격)").len() as u64;`로 교체.

- [ ] **Step 4: 통과 확인** — `cargo test -p si-workbench-dashboard` (inbox_count 기존 테스트 포함 전부 green).

- [ ] **Step 5: command 노출** — `commands.rs`:

```rust
#[tauri::command]
pub fn list_unpromoted() -> Vec<vault::UnpromotedItem> {
    let view = config::load_view();
    if view.vault_path.is_empty() {
        return vec![];
    }
    let pairs: Vec<(String, String)> =
        view.projects.iter().map(|p| (p.name.clone(), p.id_prefix.clone())).collect();
    vault::list_unpromoted(Path::new(&view.vault_path), &pairs)
}
```

`lib.rs`에 `commands::list_unpromoted,` 등록.

- [ ] **Step 6: 커밋**

```bash
cd dashboard/src-tauri && cargo test && cd ../..
git add dashboard/src-tauri
git commit -m "feat(dashboard): list unpromoted inbox items"
```

---

### Task 3: promote 잡 종류 (Rust)

**Files:**
- Modify: `dashboard/src-tauri/src/jobs.rs` (`build_job` match에 arm 추가, `mod tests`에 테스트)

**Interfaces:**
- Consumes: `build_job(req, opts, view, state)`의 `"initVault"` arm 패턴 (jobs.rs:310-320).
- Produces: `JobRequest.kind == "promote"` → label `"인박스 승격 검토"`, cwd=볼트, 일반 프롬프트(스킬 아님 — 플러그인 파일 불변 제약).

- [ ] **Step 1: 실패하는 테스트** — `jobs.rs` `mod tests`에:

```rust
#[tokio::test]
async fn build_promote_job_targets_vault() {
    let rig = rig("promote");
    let view = rig.view.clone();
    let mut opts = opts("/bin/claude-fake", &rig.dir);
    opts.vault_path = rig.dir.join("vault").to_string_lossy().to_string();
    let job = build_job(
        JobRequest { kind: "promote".into(), project: None, ids: None, routine: None },
        &opts, &view, &rig.state,
    )
    .unwrap();
    assert_eq!(job.label, "인박스 승격 검토");
    assert!(job.prompt.contains("신규 (미승격)"));
    assert_eq!(job.cwd, opts.vault_path);

    let mut empty_vault = opts("/bin/claude-fake", &rig.dir);
    empty_vault.vault_path = String::new();
    let err = build_job(
        JobRequest { kind: "promote".into(), project: None, ids: None, routine: None },
        &empty_vault, &view, &rig.state,
    )
    .unwrap_err();
    assert!(err.contains("볼트 경로"));
}
```

주의: rig/opts 헬퍼의 실제 시그니처는 `jobs.rs` `mod tests`의 기존 테스트(rig("nobin"), opts(bin, &dir))와 동일하게 맞춘다. `opts.vault_path` 필드명이 다르면 기존 테스트의 fixture 작성 방식을 따른다.

- [ ] **Step 2: 실패 확인** — `cargo test -p si-workbench-dashboard build_promote` → `알 수 없는 작업 종류: promote` 에러로 FAIL.

- [ ] **Step 3: 구현** — `build_job` match의 `"setup"` arm 뒤(`jobs.rs:331`), `other =>` 앞:

```rust
        "promote" => {
            if opts.vault_path.is_empty() {
                return Err("볼트 경로가 설정되지 않았습니다".into());
            }
            let prompt = "볼트의 모든 사업 문제목록(사업/<사업명>/개선/<idPrefix> 문제목록.md)의 '## 신규 (미승격)' 항목을 검토하라.\n\
                1. 항목별로 승격 여부를 판단한다. 단순 메모·중복·실행 불가는 승격하지 않고 해당 항목 뒤에 한 줄 사유를 덧붙여 유지한다.\n\
                2. 승격 건은 개선 노트 템플릿으로 생성한다: status: 제안, approve: false, priority: 보통, id는 해당 사업 개선 폴더의 기존 id 최댓값+1, 파일명은 '<ID> <제목>.md', 개선/ 바로 아래 평면 배치.\n\
                3. 문제목록 문서는 base 뷰 임베드 + '## 신규 (미승격)' + '## 승격 이력' 구조로 재작성하고, 승격 건은 '## 승격 이력'에 '<ID> (<날짜>)'로 남긴다.\n\
                4. 마지막 출력에 승격 N건 / 유지 M건과 승격된 ID 목록을 보고한다.";
            Ok(Job {
                label: "인박스 승격 검토".into(),
                prompt: prompt.into(),
                cwd: opts.vault_path.clone(),
                ..base
            })
        }
```

- [ ] **Step 4: 통과** — `cargo test -p si-workbench-dashboard` 전체 green (기존 28건 + 신규).

- [ ] **Step 5: 커밋**

```bash
cd dashboard/src-tauri && cargo test && cd ../..
git add dashboard/src-tauri
git commit -m "feat(dashboard): promote job kind for inbox review"
```

---

### Task 4: FE 계약 확장 (types/api/store)

**Files:**
- Modify: `dashboard/src/lib/types.ts` (JobKind union 끝, VaultCandidate 근처)
- Modify: `dashboard/src/lib/api.ts`
- Modify: `dashboard/src/lib/store.ts`

**Interfaces:**
- Consumes: Task 1-3의 Rust payload (camelCase serialize 확인 완료 — `#[serde(rename_all = "camelCase")]`).
- Produces: `VaultAudit`/`AuditIssue`/`JournalAudit`/`UnpromotedItem` 타입, `api.auditVault()`, `api.listUnpromoted()`, store `audit`, `unpromoted`, `refreshAudit()`, `PageId`에 `"vault"`.

- [ ] **Step 1: types.ts** — `JobKind` union에 `"promote"` 추가:

```ts
export type JobKind =
  | "design"
  | "implement"
  | "routine"
  | "excel"
  | "initVault"
  | "setup"
  | "promote";
```

`VaultCandidate` 정의 아래:

```ts
export interface AuditIssue {
  severity: "error" | "warn" | "info";
  path: string;
  message: string;
}

export interface JournalAudit {
  todayExists: boolean;
  missing: string[];
}

export interface VaultAudit {
  issues: AuditIssue[];
  journal: JournalAudit;
  scannedAtMs: number;
}

export interface UnpromotedItem {
  project: string;
  idPrefix: string;
  text: string;
  listPath: string;
}
```

- [ ] **Step 2: api.ts** — import에 `AuditIssue` 불필요(다른 모듈이 참조), `JournalAudit`, `UnpromotedItem`, `VaultAudit` 추가. `inboxCount` 아래:

```ts
  auditVault: (): Promise<VaultAudit> => invoke("audit_vault"),
  listUnpromoted: (): Promise<UnpromotedItem[]> => invoke("list_unpromoted"),
```

- [ ] **Step 3: store.ts** — `PageId`에 `"vault"` 추가:

```ts
export type PageId = "home" | "improve" | "jobs" | "todos" | "docs" | "vault" | "settings";
```

interface와 구현에 추가:

```ts
// interface
  audit: VaultAudit | null;
  unpromoted: UnpromotedItem[];
  refreshAudit: () => Promise<void>;
```

```ts
// 구현 (inboxCount 초기값 근처)
  audit: null,
  unpromoted: [],
```

```ts
// refresh* 구현 근처
  refreshAudit: async () => {
    const [audit, unpromoted] = await Promise.all([api.auditVault(), api.listUnpromoted()]);
    set({ audit, unpromoted });
  },
```

`init()`의 기존 refresh 묶음에 `refreshAudit()` 추가 (볼트가 없으면 audit은 빈 객체를 반환하므로 안전).

- [ ] **Step 4: 컴파일 확인** — `cd dashboard && npx tsc --noEmit` → 0 error (페이지 미사용 타입은 미참조라 통과).

- [ ] **Step 5: 커밋**

```bash
git add dashboard/src
git commit -m "feat(dashboard): FE contract for vault audit and unpromoted items"
```

---

### Task 5: 홈 카드 3종 (FE)

**Files:**
- Modify: `dashboard/src/pages/HomePage.tsx` (기존 `lg:grid-cols-2` 섹션(개선/실행잡)을 아래 구조로 교체·확장)

**Interfaces:**
- Consumes: store `todos`, `improvements`, `jobs`, `inboxCount`, `audit`; common.tsx `fmtDate`, `fmtClock`, `Empty`, `jobBadgeVariant`; `api.toggleTodo`.
- Produces: 홈 3카드. 레이아웃: `[업무 span2 | 활동요약]` / `[볼트현황 | 개선카운트 | 실행잡]`.

- [ ] **Step 1: store 셀렉터 추가** — `HomePage()` 내 기존 셀렉터 뒤:

```tsx
  const todos = useApp((s) => s.todos);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const audit = useApp((s) => s.audit);
  const unpromoted = useApp((s) => s.unpromoted);
```

마운트 effect(refreshJobs 있는 곳)에 `void refreshAudit();` 추가.

- [ ] **Step 2: 오늘의 업무 카드** — 토글 핸들러는 `runRoutine` 위에:

```tsx
  async function toggleToday(index: number, checked: boolean) {
    if (!todos) return;
    try {
      await api.toggleTodo("today", index, checked);
      await refreshTodos();
    } catch (e) {
      console.error(e);
    }
  }
```

JSX — 기존 `section.grid.gap-3.lg:grid-cols-2`(개선/실행잡, HomePage.tsx:194-234)를 다음 구조로 교체:

```tsx
        <section className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                오늘의 업무
                {todos && todos.today.length > 0 && (
                  <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                    {todos.today.filter((t) => t.checked).length}/{todos.today.length}
                  </span>
                )}
              </CardTitle>
              <Button size="xs" variant="ghost" onClick={() => setPage("todos")}>
                전체 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent>
              {!todos || !todos.fileExists || todos.today.length === 0 ? (
                <Empty>일지에 오늘 할 일이 없습니다.</Empty>
              ) : (
                <div className="space-y-1">
                  {todos.today.map((t) => (
                    <label key={t.index} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-accent">
                      <input
                        type="checkbox"
                        checked={t.checked}
                        onChange={(e) => void toggleToday(t.index, e.target.checked)}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                      <span className={t.checked ? "text-muted-foreground line-through" : ""}>{t.text}</span>
                    </label>
                  ))}
                  {todos.tomorrow.length > 0 && (
                    <details className="pt-1">
                      <summary className="cursor-pointer text-[11px] text-muted-foreground">
                        내일 {todos.tomorrow.length}건
                      </summary>
                      <ul className="mt-1 space-y-0.5 pl-5 text-xs text-muted-foreground list-disc">
                        {todos.tomorrow.map((t) => (
                          <li key={t.index}>{t.text}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">활동 요약</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">오늘 완료 잡</span>
                <span className="font-semibold tabular-nums">
                  {jobs.filter((j) => j.status === "success" && j.finishedAtMs != null && fmtDate(j.finishedAtMs) === today).length}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">오늘 실패 잡</span>
                <span className="font-semibold tabular-nums">
                  {jobs.filter((j) => j.status === "failed" && j.finishedAtMs != null && fmtDate(j.finishedAtMs) === today).length}
                </span>
              </div>
              {(() => {
                const failed = jobs
                  .filter((j) => j.status === "failed")
                  .sort((a, b) => (b.finishedAtMs ?? 0) - (a.finishedAtMs ?? 0))[0];
                return failed ? (
                  <button
                    onClick={() => setPage("jobs")}
                    className="w-full rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-left"
                  >
                    <span className="block truncate font-medium">{failed.label}</span>
                    <span className="text-[11px] text-muted-foreground">
                      마지막 실패 {failed.finishedAtMs ? fmtClock(failed.finishedAtMs) : ""} · 작업 탭에서 로그 보기
                    </span>
                  </button>
                ) : null;
              })()}
              <Button size="xs" variant="outline" className="w-full" onClick={() => setPage("docs")}>
                마지막 리포트 <ArrowRight />
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-3 lg:grid-cols-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">볼트 현황</CardTitle>
              <Button size="xs" variant="ghost" onClick={() => setPage("vault")}>
                볼트 관리 <ArrowRight />
              </Button>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <button onClick={() => setPage("vault")} className="flex w-full items-center justify-between rounded-md border p-2 text-left transition-colors hover:bg-accent">
                <span className="text-muted-foreground">미승격 항목</span>
                <span className="text-lg font-bold tabular-nums">{inboxCount}</span>
              </button>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">오늘 일지</span>
                {audit == null ? (
                  <Badge variant="outline">검사 전</Badge>
                ) : audit.journal.todayExists ? (
                  <Badge variant="success">있음</Badge>
                ) : (
                  <Badge variant="warning">없음</Badge>
                )}
              </div>
              <div>
                <div className="mb-1 text-muted-foreground">최근 변경 개선 노트</div>
                {improvements.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">개선 노트가 없습니다.</p>
                ) : (
                  <ul className="space-y-0.5">
                    {improvements.slice(0, 3).map((n) => (
                      <li key={n.path} className="truncate">
                        <button onClick={() => setPage("improve")} className="text-left hover:underline" title={n.title}>
                          <span className="font-mono text-[11px] text-muted-foreground">{n.id}</span> {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 기존 개선 사이클 카드(HomePage.tsx:195-217)를 이 grid로 이동 — 내용 변경 없음 */}
          {/* 기존 실행 중 잡 카드(HomePage.tsx:219-233)를 이 grid로 이동 — 내용 변경 없음 */}
        </section>
```

주의: `inboxCount`, `unpromoted` 셀렉터 중 이 카드에서 실제 쓰는 것만 남긴다(`unpromoted`는 홈에서 미사용 — 셀렉터에서 제외). 기존 개선/실행잡 카드 JSX는 그대로 잘라내어 두 번째 grid로 옮긴다(CUT+PUT).

- [ ] **Step 3: 타입 체크 + 빌드**

```bash
cd dashboard && npm run build
```

Expected: tsc 0 error, vite 성공.

- [ ] **Step 4: 렌더 스모크** — `npm run dev` + headless Chromium(이 세션의 방식: `python3 -m http.server`로 dist 서빙 후 브라우저 탭에서 rootChildren > 0 확인) 또는 tauri dev 실물 확인.

- [ ] **Step 5: 커밋**

```bash
git add dashboard/src
git commit -m "feat(dashboard): today tasks, activity digest, vault summary cards on home"
```

---

### Task 6: 볼트 탭 (FE)

**Files:**
- Create: `dashboard/src/pages/VaultPage.tsx`
- Modify: `dashboard/src/App.tsx` (import, NAV, switch), `dashboard/src/pages/common.tsx`는 수정 없음

**Interfaces:**
- Consumes: store `audit`, `unpromoted`, `refreshAudit`; `api.readNote(path)` (절대 경로 — 감사 이슈 행용); `api.enqueueJob({ kind: "promote" })`; `MarkdownView` from `@/lib/markdown`; common.tsx `PageHeader`, `Empty`, `entryText` 미사용.
- Produces: 페이지 id `"vault"`, 사이드바 라벨 "볼트".

- [ ] **Step 1: VaultPage.tsx 작성**:

```tsx
import { useState } from "react";
import { ListChecks, RefreshCw, SquareTerminal } from "lucide-react";
import { api } from "@/lib/api";
import { MarkdownView } from "@/lib/markdown";
import { useApp } from "@/lib/store";
import type { AuditIssue } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, PageHeader } from "./common";

const SEV: Record<AuditIssue["severity"], { label: string; variant: "destructive" | "warning" | "secondary" }> = {
  error: { label: "위험", variant: "destructive" },
  warn: { label: "주의", variant: "warning" },
  info: { label: "정보", variant: "secondary" },
};

export default function VaultPage() {
  const audit = useApp((s) => s.audit);
  const unpromoted = useApp((s) => s.unpromoted);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<{ title: string; md: string } | null>(null);

  async function scan() {
    setScanning(true);
    try {
      await refreshAudit();
    } finally {
      setScanning(false);
    }
  }

  async function openPath(path: string) {
    try {
      const v = await api.readNote(path);
      const title = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
      setView({ title, md: v.markdown });
    } catch {
      setView(null);
    }
  }

  async function promote() {
    await api.enqueueJob({ kind: "promote" });
  }

  return (
    <div>
      <PageHeader title="볼트" desc="볼트 구조를 검사하고 인박스(미승격) 항목을 정리합니다.">
        <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
          <RefreshCw /> 다시 검사
        </Button>
        <Button size="sm" onClick={() => void promote()}>
          <SquareTerminal /> 인박스 승격 검토
        </Button>
      </PageHeader>

      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">빠른 검사</CardTitle>
              {audit && <span className="text-[11px] text-muted-foreground">{audit.issues.length}건</span>}
            </CardHeader>
            <CardContent>
              {audit == null ? (
                <Empty>아직 검사하지 않았습니다. 다시 검사를 누르세요.</Empty>
              ) : audit.issues.length === 0 ? (
                <Empty>문제를 찾지 못했습니다.</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {audit.issues.map((iss, i) => (
                    <li key={i} className="rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant={SEV[iss.severity].variant}>{SEV[iss.severity].label}</Badge>
                        <span className="min-w-0 flex-1">{iss.message}</span>
                      </div>
                      {iss.path.length > 0 && (
                        <button onClick={() => void openPath(iss.path)} className="mt-0.5 block w-full truncate text-left text-[11px] text-muted-foreground hover:underline" title={iss.path}>
                          {iss.path}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                <ListChecks className="mr-1 inline size-3.5" /> 미승격 항목 {unpromoted.length}건
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unpromoted.length === 0 ? (
                <Empty>미승격 항목이 없습니다.</Empty>
              ) : (
                <ul className="space-y-1">
                  {unpromoted.map((it, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className="shrink-0">{it.project}</Badge>
                      <span className="min-w-0 flex-1">{it.text}</span>
                      <button onClick={() => void openPath(it.listPath)} className="shrink-0 text-[11px] text-muted-foreground hover:underline">
                        목록 열기
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">{view ? view.title : "노트 미리보기"}</CardTitle>
          </CardHeader>
          <CardContent>
            {view ? (
              <MarkdownView src={view.md} className="selectable" />
            ) : (
              <Empty>검사 결과나 목록에서 노트를 열어보세요.</Empty>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

주의: `MarkdownView`의 실제 export 경로·props는 `dashboard/src/lib/markdown.ts`와 DocsPage.tsx:163 사용부를 먼저 확인하고 맞춘다. `Badge variant="warning"`은 common.tsx `BadgeVariant`에 존재하는 값으로 확인 후 사용(ui/badge에 없으면 common의 `WARN_TEXT` 클래스로 대체).

- [ ] **Step 2: App.tsx 연결** — import 추가:

```tsx
import VaultPage from "@/pages/VaultPage";
```

lucide import에 `FolderSearch` 추가. NAV 배열(docs와 settings 사이):

```tsx
  { id: "vault", label: "볼트", icon: FolderSearch },
```

switch에 추가:

```tsx
      case "vault":
        return <VaultPage />;
```

- [ ] **Step 3: 빌드 + 스모크**

```bash
cd dashboard && npm run build
```

- [ ] **Step 4: 커밋**

```bash
git add dashboard/src
git commit -m "feat(dashboard): vault management tab with audit and inbox review"
```

---

### Task 7: 전체 검증

- [ ] **Step 1: 백엔드 전체 테스트**

```bash
cd dashboard/src-tauri && cargo test
```

Expected: 기존 28건 + 신규(audit 3, unpromoted 1, promote 1) 전부 green, warning 0.

- [ ] **Step 2: FE 빌드 + 바이너리 재빌드**

```bash
cd dashboard && npm run build && cd src-tauri && cargo build
```

- [ ] **Step 3: 실물 확인 (tauri dev)** — `npx tauri dev`로 앱 실행 후:
  1. 홈: 오늘의 업무 토글 → Obsidian에서 일지 체크 반영 확인
  2. 볼트 탭: 다시 검사 → 이슈 목록(설정 없으면 빈) 렌더, 미승격 목록
  3. 인박스 승격 검토 → 작업 탭으로 전환되고 스트리밍 시작 확인(실제 잡 실행은 볼트 경로 설정 후)

- [ ] **Step 4: 최종 커밋 (있다면) + 스펙 D1/D2 확정 반영 여부 확인**

```bash
git log --oneline -6
```

## Self-Review 결과

- 스펙 커버리지: 홈 3카드(Task 5), 볼트 탭 검사/인박스/승격(Task 6), backend audit/unpromoted/promote(Task 1-3), 계약(Task 4) — 전 항목 매핑 완료. "일지 열기는 v1 문서 탭 이동만"은 Task 5 활동 요약의 리포트 버튼 + 업무 카드의 전체 버튼으로 충족.
- 플레이스홀더: 없음. 모든 코드 블록은 실제 구현 코드.
- 타입 일관성: `VaultAudit.journal.todayExists`(camelCase, serde rename) ↔ Task 5 `audit.journal.todayExists` 일치. `UnpromotedItem.text` ↔ Task 6 렌더 일치. `severity` 리터럴 3종 ↔ SEV 레코드 키 일치.
- 리스크 표기: jobs.rs 테스트 헬퍼 시그니처와 `MarkdownView`/`Badge warning`는 구현 시 기존 코드 확인 후 정렬(각 Task에 주석 명시).
