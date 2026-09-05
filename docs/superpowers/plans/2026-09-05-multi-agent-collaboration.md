# 멀티에이전트 협업 1단계(로컬 통합 레인) 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트가 전용 worktree에서 만든 변경을 불변 후보(digest)로 인박스 제출하고, 사람이 대시보드에서 승인한 뒤 단일 통합 워커가 대표 체크아웃에 직렬 `--no-ff` 병합·검증·revert까지 수행하는 로컬 협업 레인을 만든다.

**Architecture:** 신규 Rust 모듈 `collab/`(store=SQLite 장부, git=읽기 검사, inbox=후보 수용, policy=승인 정책, integration=병합·revert·복구, checks=검증 실행, drivers=Claude lane, events=감사) + config의 top-level `projects` 마이그레이션 + 프론트 Sessions/Review 페이지와 설정 섹션 + issues 스킬 session mode. 에이전트는 파일 인박스(`collab/inbox/changesets/`)만 쓰고, 장부(SQLite)와 대표 체크아웃은 대시보드 프로세스만 쓴다(tasks.rs 단일 작성자 패턴 재사용).

**Tech Stack:** Tauri 2 command, rusqlite(bundled)+WAL, sha2 canonical digest, tempfile 기반 Git fixture 테스트, React 18 + zustand + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-09-05-multi-agent-collaboration-design.md` (줄 번호 인용은 이 문서 기준)

## Global Constraints

- UI 문구·에러 메시지 한국어. 코드·커밋 영어.
- Rust·TS wire 타입 camelCase 1:1. 신규 필드는 전부 `#[serde(default)]`.
- **단일 작성자**: 에이전트는 `collab/inbox/changesets/*.json`만 쓴다. DB·대표 체크아웃·이슈 노트는 대시보드만 쓴다.
- **승인 identity는 digest**: branch 이름·patch-id 아니다. `digest_payload(base, source, trees, manifest, deps, plan)` = sha256.
- 후보 ref `refs/sawhorse/candidates/<id>`는 create-only. 절대 다른 SHA로 갱신 금지.
- 병합은 통합 워커 하나만, `git merge --no-ff --no-commit --no-verify <sha>` 후 `write-tree == planned_tree_sha` 대조, 커밋은 `--no-verify --no-gpg-sign` + trailer 4종.
- Git 변경 전에 항상 장부(WAL 행)를 먼저 쓴다. `reset --hard` 자동 실행 금지 — 기본 복구는 `revert -m 1`.
- HEAD drift·dirty checkout·conflict는 사용자 변경을 건드리지 않고 큐를 멈춘다.
- 네트워크 클라이언트(reqwest)는 1단계 범위 밖. connector는 2단계.
- 커밋: conventional(feat:/fix:/test:), 영어, 경로 한정 add. 남의 WIP를 섞지 않는다.
- 전제: worktree `feat/multi-agent-collab`. 베이스 커밋 `ed2c473`(custom-agents WIP carry)까지 완료됨.

## 진행 상태 메모 (2026-09-05 밤)

- store.rs(1166줄), git.rs(633줄) 착성, config.rs core_projects 진행 중 — 병렬 세션이 구현 중이므로 **기존 파일은 재작성하지 말고 읽고 이어받을 것**. 이어받을 때는 아래 계약과 실제 시그니처가 다르면 실제 코드가 정본.
- `collab/model.rs`(805줄)는 타입 계약 확정본: Session/AgentRun/ChangeSet/ManifestEntry/IntegrationAttempt/CheckRun/Approval/AuthorizationDecision/PolicySnapshot/AuditEvent/ProposeRequest/NoteIntent/ChangeSetView/SessionView + `digest_payload` + `ChangeSetStatus` 전체 상태전이. **이 타입을 바꾸려면 스펙 근거가 있어야 한다.**

---

### Task 1: `collab/store.rs` — SQLite 장부

**Files:**
- Create/Verify: `dashboard/src-tauri/src/collab/store.rs`
- Test: 같은 파일 `#[cfg(test)]`

**Interfaces (Produces):**
- `pub struct CollabStore { conn: Mutex<rusqlite::Connection> }` — `CollabStore::open(path) -> Result<Self, String>`, 테스트용 `open_in_memory()`.
- 부팅 시 `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` + `user_version` 순차 마이그레이션.
- 테이블(1단계 부분집합, 설계 544-552): `project`, `session`, `agent_run`, `change_set`, `integration_attempt`, `check_run`, `approval`, `authorization_decision`, `policy_snapshot`, `audit_event`, `file_apply_wal`.
- 각 행 CRUD: `insert_session/get_session/update_session_status/list_sessions`, `insert_change_set/get_change_set/update_change_set_status/list_by_status(session_id)`, `insert_attempt/update_attempt_phase/...`, `insert_approval/latest_approval_for(candidate)`, `record_audit(...)`, `insert_file_wal/mark_file_wal_phase/pending_file_wals`.
- 모든 상태 전이는 한 트랜잭션에서 audit_event와 함께 기록한다(내부 이벤트·outbox 같은 트랜잭션 원칙, 설계 553-556).

**Accept:**
- [ ] 마이그레이션 재실행 멱등(같은 user_version 재오픈 성공)
- [ ] change_set.status 전이가 `ChangeSetStatus` 문자열과 왕복 일치
- [ ] 트랜잭션 롤백 시 audit_event도 같이 롤백됨

### Task 2: `collab/git.rs` — 읽기 전용 Git 검사

**Files:** `dashboard/src-tauri/src/collab/git.rs` (착성됨 — 계약 대조 후 보완)

**Interfaces (Produces):**
- `pub struct RepoIdentity { canonical_root, git_dir, common_dir }` + `identity(path) -> Result<RepoIdentity, String>` — canonical repo root + worktree git-dir + git-common-dir.
- `pub fn full_sha(path, rev) -> Result<String>` / `tree_of(path, sha)` / `is_ancestor(path, a, b)`.
- `pub struct CheckoutState { head, branch, clean, detached, merge_head, rebase_head, cherry_pick_head, revert_head }` + `checkout_state(path)`.
- `pub fn range_manifest(path, base, source) -> Result<Vec<ManifestEntry>>` — `git diff --raw -M -z base..source` 재계산(에이전트 입력 비신뢰).
- `pub fn merge_simulate(path, base_head, source) -> Result<String /*planned_tree*/>` — 임시 index(`GIT_INDEX_FILE`) + `git merge-tree` 또는 read-tree 3-way; **worktree를 건드리지 않는다**.
- `pub fn create_protected_ref(path, candidate_id, sha)` — create-only, 이미 존재하고 SHA 다르면 오류.
- `range_has_merge_commit(path, base, source) -> bool`.

**Accept:**
- [ ] fixture repo(temperature lib git2 없음 — `git` CLI argv 호출)에서 manifest/planned_tree 검증
- [ ] merge_simulate가 dirty worktree에서도 HEAD/index를 바꾸지 않음(전후 `status --porcelain` 동일)

### Task 3: `config.rs` — top-level `projects`(projectId) 마이그레이션

**Files:** `dashboard/src-tauri/src/config.rs` (진행 중), `collab/model.rs`의 `CoreProject`/`IntegrationTarget` 사용

**Interfaces:**
- `ConfigView.core_projects: BTreeMap<String, CoreProject>` (key = UUID projectId, 설계 294-300).
- `save_patch_at`에 `coreProjects` 패치 키: 항목별 insert/update. **legacy `improve.projects`는 절대 삭제·덮지 않는다** — rollback 보존(설계 300).
- dual-read: projectId 있으면 우선, 없으면 `improve.projects.<name>`을 legacy candidate로 노출(프론트 등록 확인 UI).
- `improve.projects.*.verify`는 `legacyShell`로 표시만(설계 307-308). argv 자동 분해 금지.
- 등록: `register_project(path, branch) -> CoreProject` — canonical path로 UUID 발급, 중복 등록 진단 필드(canonical root, git-common-dir) 저장.

**Accept:**
- [ ] 기존 config.json에 `projects`(신규) 추가 후 `unknownProjectKey`·legacy 블록 보존 (기존 테스트 회귀 없음)
- [ ] legacy만 있던 사용자가 등록 확인 전에는 신규 블록이 비어 있음(dual-read)

### Task 4: `collab/inbox.rs` — 후보 수용·검증

**Interfaces:**
- `pub fn process_inbox(store: &CollabStore, emit: &EmitFn) -> usize` — 디렉터리 스캔(tasks::process_inbox 패턴, mtime 2초 안정화).
- 검사(설계 222-229 전부): repo identity 일치 / 축약 없는 SHA + ancestor / base ⊂ 현재 integration HEAD / range 내 merge commit 기본 거부 / manifest·digest 재계산 일치 / 의존 = 승인 digest 또는 verified merge SHA / 경로 정책(고위험: submodule·LFS 포인터·mode 변경) / semantic overlap(같은 세션 후보와 `App.tsx`·route·registry·manifest 조립 지점 겹침 → 위험 플래그).
- 수용 → `change_set` 행(`review_pending`) + protected ref + 파일 `processed/` 이동. 거절 → `rejected/` 보존 + 사유.
- `NoteIntent` 수용 → 현재 파일 sha256이 `expected_local_hash`와 같은지 확인 → `file_apply_wal` prepared 행. 실제 적용은 verified 뒤.
- 같은 patch가 이미 통합된 후보 → `redundant` 종결(빈 merge commit 금지).

**Accept:** fixture repo + 인박스 파일로 수용/거절/중복/의존거절 단위 테스트.

### Task 5: `collab/policy.rs` — 승인 정책

**Interfaces:**
- `eval(policy, candidate_snapshot) -> AuthorizationKind` — `required`면 사람 승인만, `autoAfterPreflight`는 clean merge sim + 허용 경로 + baseline 통과 시 `AuthorizationKind::Policy`.
- 승인 때 integration HEAD를 `Approval.expected_head`로 고정. 병합 직전 HEAD가 한 bit라도 다르면 **무조건 재승인**(설계 378-380).
- 설정: `dashboard.collaboration` 전역 + project override → 세션 시작 때 `policy_snapshot` v1 고정. 개정은 v2, 완화는 새 snapshot부터, 강화는 미통합 후보 전부에 적용하고 기존 authorization 무효화.
- 채팅 메시지의 "승인"은 신호가 아니다 — 대시보드 동작만 human authorization(설계 317-320).

**Accept:** precedence(전역→프로젝트→스냅샷), drift 재승인, 강화 시 무효화 단위 테스트.

### Task 6: `collab/integration.rs` — 직렬 병합·revert·복구 (핵심)

**Interfaces:**
- `pub struct IntegrationWorker { ... }` — `spawn(store: Arc<CollabStore>, emit: EmitFn)` 부팅 시 1회. 같은 checkout identity에 OS flock(`collab/locks/<hash>.lock`) + 세션 lease.
- 병합 절차(설계 369-397 순서 그대로): identity lock → checkout_state 검사(detached·MERGE_HEAD류 있으면 중단) → 후보 ref/digest/승인/HEAD 재확인 → merge_simulate로 planned_tree → baseline 실행·`pre_head` 기록 → WAL(`phase=prepared`) → `git merge --no-ff --no-commit --no-verify <sha>` → 충돌 시에만 `merge --abort` + clean 복원 확인(안 되면 `recovery_required`) → `write-tree == planned` 대조 → trailer 커밋 → check 실행(각 check 뒤 상태 불변 확인) → `verified` | `verification_failed`.
- trailer: `Sawhorse-Session/-Candidate/-Source/-Authorization`.
- revert(설계 428-441): 사람 승인 기록 → WAL → `git revert --no-commit -m 1 <merge_sha>` → tree/conflict 확인 → trailer 커밋(`Sawhorse-Reverts`) → smoke. 충돌 시 `revert_conflicted` 정지.
- **재시작 복구**(설계 479-486 표 그대로): 부팅 시 미종결 attempt 스캔 → preHead+clean+무git op = 재큐 / MERGE_HEAD·REVERT_HEAD = `recovery_required`(자동 abort 금지) / HEAD가 예상 커밋(parent·tree·trailer 일치, 이후 커밋 없음) = 검사 재개 / 그 외 = `recovery_required`.
- 검증 실패·baseline 실패는 큐 정지. 다음 후보 진행 금지(불변식 5).

**Accept:** Git fixture 테스트 — clean merge, planned tree 불일치 차단, conflict abort 복원, dirty 차단, stale HEAD 재승인, redundant, revert, revert-conflict, merge 중 크래시(단계별 kill) 복구.

### Task 7: `collab/checks.rs` — 검증 프로필 실행

**Interfaces:**
- `run_checks(profile: &VerifyProfile, checkout: &str, attempt_id, store) -> CheckSummary` — `VerifyCheck::Command{cwd, argv}`(checkout 하위 상대 cwd, argv 직접 spawn — shell 문자열 금지), `VerifyCheck::Http{url}`(1단계는 `reqwest` 없이 `std` TCP health 또는 127.0.0.1 GET 최소 구현… **reqwest 제거 상태이므로 1단계는 http check를 "연결+2xx" 수준의 최소 TCP probe로 구현**).
- 각 check 뒤 branch/HEAD/index/tracked clean 불변 확인 — check가 파일을 바꾸면 자동 커밋 없이 정지.
- 로그 본문은 `collab/projects/<projectId>/artifacts/<sha256>` 파일, DB는 `log_ref`만.
- manual checklist 비었으면 곧바로 verified, 있으면 `manual_verification_pending`. 확인 완료 시 HEAD==merge_sha && clean 재확인(설계 359-362).

### Task 8: `collab/drivers.rs` — AgentDriver + Claude lane

**Interfaces:**
- `pub trait AgentDriver { fn kind(&self) -> &str; fn start(&self, run: &AgentRun) -> Result<Job, String>; fn status(&self, job_id) -> Option<Job>; fn cancel(&self, job_id) -> Result<(), String>; fn reattach(&self, job_id) -> Result<(), String>; fn collect_result(&self, job_id) -> Option<CollectedResult>; }`
- `ClaudeDriver`: `JobManager::enqueue_with` 위 thin wrapper. `jobs.rs::build_job`에 kind `"collabLane"` arm 추가 — prompt = 레인 task 지시문(세션 목표+task+후보 제출 안내+인박스 경로), `cwd = worktree_path`. 레인당 branch `sawhorse/agent/<sid>/<tid>` + worktree `~/.claude/sawhorse/collab/worktrees/<sid>/<tid>`.
- Codex 등: `start` → 오류 "관리형 실행 미지원 — 인박스 수동 제출만 가능"(UI 문구와 일치, 설계 855-856).
- Job ↔ run 연결은 `AgentRun.job_id`만(기존 `Job.sessionId`는 Claude 세션 ID로 의미 보존, 설계 837-840).

### Task 9: `collab/events.rs` + command·watcher 배선

**Interfaces:**
- 감사 kind: `session.created/changeset.proposed/approval.resolved/integration.started/.verified/.failed/.reverted`(설계 676-679 부분집합).
- 프론트 이벤트: `"collab-changed"`(kebab-case 규칙) — 모든 상태 전이·인박스 처리 후 emit. payload `{}`(목록 재조회 트리거).
- lib.rs: `mod collab;`(완료), `CollabStore::open(workbench_root()/workbench.sqlite)` manage, IntegrationWorker::spawn, 부팅 복구 호출, `watcher::start_path(&collab::inbox_dir(), emit, "collab-changed", json!({}))` WatchKeeper 누적 패턴.

### Task 10: `commands.rs` — Tauri command 표면

패턴: `State<'_, Arc<CollabStore>>`, 에러 String, 한국어.
- 프로젝트: `collab_register_project(path, branch, verifyProfile)` / `collab_list_projects` / `collab_confirm_legacy_project(name)` / `collab_save_verify_profile(projectId, name, profile)`
- 세션: `collab_create_session(projectId, goal, lanes: Vec<{taskId?, title, prompt}>, mode)` — checkout 검사 + 정책 v1 스냅샷 + AgentRun 생성 + worktree/branch 생성 + lane 시작 / `collab_list_sessions` / `collab_get_session` → `SessionView` / `collab_pause_session` / `collab_resume_session` / `collab_finalize_session`(direct: 모든 후보 terminal 확인 뒤 lease 해제)
- 검토: `collab_list_pending_changes` → `Vec<ChangeSetView>` / `collab_approve_change(id)` / `collab_request_changes(id, reason)` / `collab_reject_change(id, reason)`
- 통합: `collab_confirm_manual(candidateId)` / `collab_fail_manual(candidateId, note)` / `collab_create_repair(candidateId)`(현재 HEAD에서 repair branch+task) / `collab_revert_change(candidateId)`(사람 승인 기록 후 revert)
- 진단: `collab_get_attempt(attemptId)`(check runs + log_ref) / `collab_retry_recovery(attemptId)`
- 모든 변경 command 끝에 `emit("collab-changed", {})`.

### Task 11: 프론트엔드

**Files:**
- `dashboard/src/lib/types.ts`: Session/AgentRun/ChangeSet/ChangeSetView/SessionView/AttemptView/CheckRunView/CoreProject/VerifyProfile 인터페이스(camelCase, 명칭 백엔드와 1:1)
- `dashboard/src/lib/api.ts`: 위 command 래퍼 + `EVENTS.collabChanged = "collab-changed"`
- `dashboard/src/lib/store.ts`: `CORE_PAGES`에 `sessions` 추가
- `dashboard/src/App.tsx`: TOP_NAV `세션` + 본문 case → `SessionsPage`, `ReviewPage`는 세션 상세에서 진입(탭 1개 유지, 하단 nav 포화 방지)
- `dashboard/src/pages/SessionsPage.tsx`(신규): 세션 목록/생성 다이얼로그(프로젝트·목표·레인 task 편집)/상세(레인 상태, 후보 목록, 통합 상태, paused 사유)
- `dashboard/src/pages/ReviewPage.tsx`(신규): 승인대기 카드(agent/task, base→source, 파일 수, 겹침 경로 경고, checks) + `승인 후 큐에 넣기/수정 요청/거부`; 통합 카드(단계 스테퍼, 검사 로그, 수동 체크리스트) + `확인 완료/수정 작업 만들기/변경 제거`. TasksPage 패턴(PageHeader/Card/guard/Dialog) 모방.
- `dashboard/src/pages/settings/CollaborationSection.tsx`(신규): 승인 정책, 통합 path·branch, 검증 프로필(argv 편집기, legacyShell 표시), Codex "인박스 수동 제출만 지원" 문구. SettingsPage SectionId·SECTIONS·switch 3곳 갱신.
- `dashboard/src/pages/settings/ProjectsSection.tsx`: legacy 후보 등록 확인 UI(dual-read).

### Task 12: issues 스킬 session mode + 노트 intent 적용

**Files:** `skills/issues/SKILL.md`, `vault.rs`(또는 collab 측 헬퍼), `collab/` 적용 경로
- `apply_note_intent(path, field, value, expected_hash)`: 현재 파일 sha256 비교(optimistic) → frontmatter 필드 갱신 → `file_apply_wal` prepared→applied. 설계 76-78, 563-571.
- 통합 verified 뒤 코어가 이슈 노트에 `integration_commits`(merge SHA), `verified` 갱신. `base`=target_start_sha, `branch`=통합 branch 해석은 스킬 문서에 명시.
- SKILL.md에 session mode 절 추가: session descriptor 있으면 workBranch 검사 생략, 공유 노트 직접 쓰기 금지(intent 제출), `commits`는 구현 커밋 그대로, 단일 branch 동작은 세션 밖에서만.
- 노트 intent 적용은 후보 verified 이후 일괄(충돌 시 해당 후보 `manual_verification_pending` 전에 정지·보고).

### Task 13: 전체 검증

- [ ] `cargo test --lib` 전부 green (collab fixture 포함)
- [ ] `cargo clippy --all-targets -- -D warnings` green
- [ ] `npx tsc --noEmit` green
- [ ] 수동 스모크(사용자): `npm run tauri dev` → 세션 생성 → 레인 2개 → 후보 2건 순차 승인·병합·검증 → 두 번째 실패 시 첫 후보 보존한 채 두 번째만 revert (설계 완료 기준 854-856)
- [ ] Codex 레인 UI 문구 확인
- [ ] 완료 후 batch-commit-autonomously로 잔여 정리

## Self-Review 메모

- 스펙 커버리지: 1단계 완료 기준의 전부(관리형 Claude lane 2, 순차 승인·병합·검증, 실패 revert 격리, Codex 표시) → Task 6/8/11/13. 노트 intent → Task 12. 정책 스냅샷 → Task 5. 복구 → Task 6.
- 의도적 축소(스펙 근거 있음): http check 최소 구현(reqwest 2단계), approvedBatch(4단계), isolated 모드는 세션 생성 UI에 옵션만 제공하고 병합 절차는 direct와 동일 경로.
