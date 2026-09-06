// 장부(SQLite) 계층. 설계 500-556줄: 여러 에이전트가 직접 쓰는 공유 DB가 아니라
// Tauri 코어의 단일 writer가 transaction·outbox를 보증하기 위한 것이다.
//
// - 경로: `~/.claude/sawhorse/workbench.sqlite` (전역 단일 DB, project-scoped 행은 project_id 보유)
// - WAL + synchronous=FULL: 앱 크래시 뒤 장부가 Git 상태보다 뒤처지지 않게(장부 먼저 쓰기).
// - 모든 접근은 `parking_lot::Mutex<Connection>`으로 직렬화한다. 백그라운드 워커와
//   tauri 커맨드가 같은 인스턴스를 공유한다.

use super::model::*;
use super::{new_id, now_ts, workbench_root};
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::PathBuf;
use std::sync::Arc;

pub struct Store {
    conn: Mutex<Connection>,
}

pub type StoreHandle = Arc<Store>;

/// 스키마 버전. 구조 변경 시 이 숫자를 올리고 migrate의 match에 분기를 추가한다.
pub const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS project (
    id TEXT PRIMARY KEY,            -- UUID 기반 projectId (path·이름 hash 아님)
    path TEXT NOT NULL,
    canonical_root TEXT NOT NULL DEFAULT '',
    worktree_git_dir TEXT NOT NULL DEFAULT '',
    git_common_dir TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id),
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'direct',
    integration_path TEXT NOT NULL,
    integration_branch TEXT NOT NULL,
    target_start_sha TEXT NOT NULL,
    policy_version INTEGER NOT NULL DEFAULT 1,
    verification_profile TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finalized_at TEXT NOT NULL DEFAULT '',
    paused_reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS agent_run (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session(id),
    job_id TEXT NOT NULL DEFAULT '',
    task_id TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    worktree_path TEXT NOT NULL DEFAULT '',
    driver TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS change_set (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES session(id),
    task_id TEXT NOT NULL DEFAULT '',
    repository_id TEXT NOT NULL DEFAULT '',
    base_sha TEXT NOT NULL,
    source_sha TEXT NOT NULL,
    base_tree_sha TEXT NOT NULL DEFAULT '',
    source_tree_sha TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL DEFAULT '[]',
    dependency_json TEXT NOT NULL DEFAULT '[]',
    verification_plan_hash TEXT NOT NULL DEFAULT '',
    digest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'working',
    summary TEXT NOT NULL DEFAULT '',
    superseded_by TEXT NOT NULL DEFAULT '',
    remediated_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changeset_session ON change_set(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_changeset_status ON change_set(status);
CREATE TABLE IF NOT EXISTS change_dependency (
    candidate_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,       -- candidate digest 또는 verified merge SHA
    PRIMARY KEY (candidate_id, depends_on)
);
CREATE TABLE IF NOT EXISTS integration_attempt (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    operation TEXT NOT NULL DEFAULT 'merge',
    phase TEXT NOT NULL DEFAULT 'prepared',
    pre_head TEXT NOT NULL DEFAULT '',
    planned_tree_sha TEXT NOT NULL DEFAULT '',
    source_sha TEXT NOT NULL DEFAULT '',
    baseline_json TEXT NOT NULL DEFAULT '',
    merge_sha TEXT NOT NULL DEFAULT '',
    revert_sha TEXT NOT NULL DEFAULT '',
    failure_detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_attempt_candidate ON integration_attempt(candidate_id, created_at);
CREATE TABLE IF NOT EXISTS check_run (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    log_ref TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_check_attempt ON check_run(attempt_id);
CREATE TABLE IF NOT EXISTS approval (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    digest TEXT NOT NULL,
    expected_head TEXT NOT NULL DEFAULT '',
    policy_version INTEGER NOT NULL DEFAULT 1,
    decision TEXT NOT NULL,
    decided_by TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_candidate ON approval(candidate_id, created_at);
CREATE TABLE IF NOT EXISTS authorization_decision (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    policy_version INTEGER NOT NULL DEFAULT 1,
    decision_ref TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_snapshot (
    version INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (project_id, version)
);
CREATE TABLE IF NOT EXISTS audit_event (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_event(session_id, created_at);
-- 아래는 2단계 이후 사용. 스키마를 미리 고정해 마이그레이션 경계를 줄인다.
CREATE TABLE IF NOT EXISTS extension_install (
    id TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    dir TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS permission_grant (
    id TEXT PRIMARY KEY,
    instance_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    scope_json TEXT NOT NULL DEFAULT '{}',
    granted INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(instance_id, capability)
);
CREATE TABLE IF NOT EXISTS external_link (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL DEFAULT '',
    note_path TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    account_id TEXT NOT NULL DEFAULT '',
    repository_id TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(provider, account_id, repository_id, external_id)
);
CREATE TABLE IF NOT EXISTS field_sync_base (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL,
    field TEXT NOT NULL,
    base_hash TEXT NOT NULL DEFAULT '',
    base_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(link_id, field)
);
CREATE TABLE IF NOT EXISTS sync_cursor (
    key TEXT PRIMARY KEY,           -- "<instance-id>:<source>"
    cursor TEXT NOT NULL DEFAULT '',
    etag TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbound_change (
    id TEXT PRIMARY KEY,
    link_id TEXT NOT NULL DEFAULT '',
    source_instance TEXT NOT NULL DEFAULT '',
    external_id TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'staged',
    expected_local_hash TEXT NOT NULL DEFAULT '',
    target_path TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_inbound_state ON inbound_change(state);
CREATE TABLE IF NOT EXISTS event_outbox (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    sent_at TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS remote_operation (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,             -- issue_update | issue_create | push | pr_create ...
    capability TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'prepared', -- prepared|sending|succeeded|uncertain|reconciled|failed|stale
    observed_revision TEXT NOT NULL DEFAULT '',
    result_json TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS file_apply_wal (
    id TEXT PRIMARY KEY,
    target_path TEXT NOT NULL,
    expected_local_hash TEXT NOT NULL DEFAULT '',
    target_hash TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL DEFAULT '',
    phase TEXT NOT NULL DEFAULT 'prepared', -- prepared|applied|failed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dead_letter (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_source (
    id TEXT PRIMARY KEY,            -- source instance id
    extension_id TEXT NOT NULL DEFAULT '',
    component_id TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article (
    id TEXT PRIMARY KEY,
    source_instance_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    canonical_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    same_as_json TEXT NOT NULL DEFAULT '[]',
    UNIQUE(source_instance_id, external_id)
);
CREATE TABLE IF NOT EXISTS article_state (
    article_id TEXT NOT NULL REFERENCES article(id),
    read INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (article_id)
);
"#;

impl Store {
    /// 열거나 만든다. 부모 디렉터리가 없으면 만든다.
    pub fn open() -> Result<StoreHandle, String> {
        Self::open_at(Self::default_path())
    }

    pub fn default_path() -> PathBuf {
        workbench_root().join("workbench.sqlite")
    }

    pub fn open_at(path: PathBuf) -> Result<StoreHandle, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("장부 디렉터리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(&path).map_err(|e| format!("장부 열기 실패: {e}"))?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| format!("WAL 설정 실패: {e}"))?;
        // 크래시 복구 규칙이 장부를 진실원으로 삼으므로 FULL로 둔다.
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(|e| format!("synchronous 설정 실패: {e}"))?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| format!("foreign_keys 설정 실패: {e}"))?;
        let store = Store {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(Arc::new(store))
    }

    fn migrate(&self) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("트랜잭션 시작 실패: {e}"))?;
        let current: i64 = tx
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| format!("user_version 조회 실패: {e}"))?;
        if current < 1 {
            tx.execute_batch(SCHEMA_V1)
                .map_err(|e| format!("스키마 v1 적용 실패: {e}"))?;
        }
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| format!("user_version 갱신 실패: {e}"))?;
        tx.commit()
            .map_err(|e| format!("마이그레이션 커밋 실패: {e}"))
    }

    // ---------- session ----------

    pub fn insert_session(&self, s: &Session) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO session (id, project_id, goal, status, mode, integration_path, \
             integration_branch, target_start_sha, policy_version, verification_profile, \
             created_at, finalized_at, paused_reason) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                s.id, s.project_id, s.goal, s.status.as_str(), session_mode_str(s.mode),
                s.integration_path, s.integration_branch, s.target_start_sha,
                s.policy_version, s.verification_profile, s.created_at, s.finalized_at,
                s.paused_reason
            ],
        )
        .map_err(|e| format!("세션 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn update_session_status(
        &self,
        id: &str,
        status: SessionStatus,
        paused_reason: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        let finalized_at = if status == SessionStatus::Finalized {
            now_ts()
        } else {
            String::new()
        };
        conn.execute(
            "UPDATE session SET status=?2, paused_reason=?3, finalized_at=CASE WHEN ?2='finalized' THEN ?4 ELSE finalized_at END WHERE id=?1",
            params![id, status.as_str(), paused_reason, finalized_at],
        )
        .map_err(|e| format!("세션 상태 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn get_session(&self, id: &str) -> Result<Option<Session>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM session WHERE id=?1",
            params![id],
            row_to_session,
        )
        .optional()
        .map_err(|e| format!("세션 조회 실패: {e}"))
    }

    pub fn list_sessions(&self) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM session ORDER BY created_at DESC")
            .map_err(|e| format!("세션 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map([], row_to_session)
            .map_err(|e| format!("세션 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// finalized가 아닌 세션. 통합 워커 lease 확인에 쓴다.
    pub fn active_sessions_for_path(&self, integration_path: &str) -> Result<Vec<Session>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT * FROM session WHERE integration_path=?1 AND status != 'finalized' ORDER BY created_at",
            )
            .map_err(|e| format!("활성 세션 조회 실패: {e}"))?;
        let rows = stmt
            .query_map(params![integration_path], row_to_session)
            .map_err(|e| format!("활성 세션 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- agent_run ----------

    pub fn insert_agent_run(&self, r: &AgentRun) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO agent_run (id, session_id, job_id, task_id, branch, worktree_path, driver, status, created_at, finished_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![r.id, r.session_id, r.job_id, r.task_id, r.branch, r.worktree_path, r.driver, r.status, r.created_at, r.finished_at],
        )
        .map_err(|e| format!("에이전트 실행 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn update_agent_run(&self, id: &str, job_id: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE agent_run SET job_id=?2, status=?3, finished_at=CASE WHEN ?3 IN ('done','failed','cancelled') THEN ?4 ELSE finished_at END WHERE id=?1",
            params![id, job_id, status, now_ts()],
        )
        .map_err(|e| format!("에이전트 실행 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn list_agent_runs(&self, session_id: &str) -> Result<Vec<AgentRun>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM agent_run WHERE session_id=?1 ORDER BY created_at")
            .map_err(|e| format!("실행 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![session_id], row_to_agent_run)
            .map_err(|e| format!("실행 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- change_set ----------

    pub fn insert_change_set(&self, c: &ChangeSet, depends_on: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("트랜잭션 시작 실패: {e}"))?;
        tx.execute(
            "INSERT INTO change_set (id, session_id, task_id, repository_id, base_sha, source_sha, \
             base_tree_sha, source_tree_sha, manifest_json, dependency_json, verification_plan_hash, \
             digest, status, summary, superseded_by, remediated_by, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'','',?15,?15)",
            params![
                c.id, c.session_id, c.task_id, c.repository_id, c.base_sha, c.source_sha,
                c.base_tree_sha, c.source_tree_sha, c.manifest_json, c.dependency_json,
                c.verification_plan_hash, c.digest, c.status.as_str(), c.summary, c.created_at
            ],
        )
        .map_err(|e| format!("후보 기록 실패: {e}"))?;
        for dep in depends_on {
            tx.execute(
                "INSERT OR IGNORE INTO change_dependency (candidate_id, depends_on) VALUES (?1, ?2)",
                params![c.id, dep],
            )
            .map_err(|e| format!("의존성 기록 실패: {e}"))?;
        }
        tx.commit().map_err(|e| format!("후보 커밋 실패: {e}"))
    }

    pub fn update_change_set_status(
        &self,
        id: impl AsRef<str>,
        status: ChangeSetStatus,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE change_set SET status=?2, updated_at=?3 WHERE id=?1",
            params![id.as_ref(), status.as_str(), now_ts()],
        )
        .map_err(|e| format!("후보 상태 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn set_change_set_fields(
        &self,
        id: &str,
        status: ChangeSetStatus,
        superseded_by: &str,
        remediated_by: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE change_set SET status=?2, superseded_by=CASE WHEN ?3='' THEN superseded_by ELSE ?3 END, \
             remediated_by=CASE WHEN ?4='' THEN remediated_by ELSE ?4 END, updated_at=?5 WHERE id=?1",
            params![id, status.as_str(), superseded_by, remediated_by, now_ts()],
        )
        .map_err(|e| format!("후보 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn get_change_set(&self, id: &str) -> Result<Option<ChangeSet>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM change_set WHERE id=?1",
            params![id],
            row_to_change_set,
        )
        .optional()
        .map_err(|e| format!("후보 조회 실패: {e}"))
    }

    pub fn list_change_sets(&self, session_id: &str) -> Result<Vec<ChangeSet>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM change_set WHERE session_id=?1 ORDER BY created_at")
            .map_err(|e| format!("후보 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![session_id], row_to_change_set)
            .map_err(|e| format!("후보 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 검토 대기 이상, 종결되지 않은 후보를 전역 순서로. 큐 워커의 입력.
    pub fn pending_change_sets(&self) -> Result<Vec<ChangeSet>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT * FROM change_set WHERE status IN ('review_pending','approved',\
                 'authorized_by_policy','queued','changes_requested','fix_forward') ORDER BY created_at",
            )
            .map_err(|e| format!("대기 후보 조회 실패: {e}"))?;
        let rows = stmt
            .query_map([], row_to_change_set)
            .map_err(|e| format!("대기 후보 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn change_set_depends_on(&self, candidate_id: &str) -> Result<Vec<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT depends_on FROM change_dependency WHERE candidate_id=?1")
            .map_err(|e| format!("의존성 조회 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![candidate_id], |r| r.get::<_, String>(0))
            .map_err(|e| format!("의존성 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- integration_attempt ----------

    /// WAL 선기록. 실제 Git 변경 전에 반드시 이 메서드로 prepared를 남긴다.
    pub fn insert_attempt(&self, a: &IntegrationAttempt) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO integration_attempt (id, candidate_id, session_id, operation, phase, pre_head, \
             planned_tree_sha, source_sha, baseline_json, merge_sha, revert_sha, failure_detail, created_at, finished_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                a.id, a.candidate_id, a.session_id, a.operation, a.phase.as_str(), a.pre_head,
                a.planned_tree_sha, a.source_sha, a.baseline_json, a.merge_sha, a.revert_sha,
                a.failure_detail, a.created_at, a.finished_at
            ],
        )
        .map_err(|e| format!("통합 시도 기록 실패: {e}"))?;
        Ok(())
    }

    /// Git 단계 하나가 끝날 때마다 장부를 먼저 전진시킨다(설계 476-477줄).
    pub fn update_attempt_phase(
        &self,
        id: &str,
        phase: AttemptPhase,
        merge_sha: &str,
        revert_sha: &str,
        failure_detail: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        let finished = matches!(
            phase,
            AttemptPhase::Verified
                | AttemptPhase::VerificationFailed
                | AttemptPhase::ConflictAborted
                | AttemptPhase::BaselineFailed
                | AttemptPhase::Reverted
                | AttemptPhase::RevertConflicted
                | AttemptPhase::RecoveryRequired
        );
        conn.execute(
            "UPDATE integration_attempt SET phase=?2, \
             merge_sha=CASE WHEN ?3='' THEN merge_sha ELSE ?3 END, \
             revert_sha=CASE WHEN ?4='' THEN revert_sha ELSE ?4 END, \
             failure_detail=?5, \
             finished_at=CASE WHEN ?6=1 THEN ?7 ELSE finished_at END \
             WHERE id=?1",
            params![
                id,
                phase.as_str(),
                merge_sha,
                revert_sha,
                failure_detail,
                finished as i64,
                now_ts()
            ],
        )
        .map_err(|e| format!("통합 시도 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn get_attempt(&self, id: &str) -> Result<Option<IntegrationAttempt>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM integration_attempt WHERE id=?1",
            params![id],
            row_to_attempt,
        )
        .optional()
        .map_err(|e| format!("통합 시도 조회 실패: {e}"))
    }

    pub fn list_attempts(&self, candidate_id: &str) -> Result<Vec<IntegrationAttempt>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM integration_attempt WHERE candidate_id=?1 ORDER BY created_at")
            .map_err(|e| format!("통합 시도 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![candidate_id], row_to_attempt)
            .map_err(|e| format!("통합 시도 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 종료되지 않은 시도. 재시작 복구 스캔의 입력.
    pub fn unfinished_attempts(&self) -> Result<Vec<IntegrationAttempt>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT * FROM integration_attempt WHERE phase NOT IN ('verified','verification_failed',\
                 'conflict_aborted','baseline_failed','reverted','revert_conflicted','recovery_required') \
                 ORDER BY created_at",
            )
            .map_err(|e| format!("미종료 시도 조회 실패: {e}"))?;
        let rows = stmt
            .query_map([], row_to_attempt)
            .map_err(|e| format!("미종료 시도 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- check_run ----------

    pub fn insert_check_run(&self, c: &CheckRun) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO check_run (id, attempt_id, kind, name, status, log_ref, started_at, finished_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![c.id, c.attempt_id, c.kind, c.name, c.status, c.log_ref, c.started_at, c.finished_at],
        )
        .map_err(|e| format!("검사 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn update_check_run(&self, id: &str, status: &str, log_ref: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        let finished = if matches!(status, "passed" | "failed" | "skipped") {
            now_ts()
        } else {
            String::new()
        };
        conn.execute(
            "UPDATE check_run SET status=?2, log_ref=CASE WHEN ?3='' THEN log_ref ELSE ?3 END, \
             finished_at=CASE WHEN ?4='' THEN finished_at ELSE ?4 END WHERE id=?1",
            params![id, status, log_ref, finished],
        )
        .map_err(|e| format!("검사 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn list_check_runs(&self, attempt_id: &str) -> Result<Vec<CheckRun>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM check_run WHERE attempt_id=?1 ORDER BY started_at, id")
            .map_err(|e| format!("검사 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![attempt_id], row_to_check_run)
            .map_err(|e| format!("검사 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- approval / authorization ----------

    pub fn insert_approval(&self, a: &Approval) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO approval (id, candidate_id, digest, expected_head, policy_version, decision, decided_by, reason, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![a.id, a.candidate_id, a.digest, a.expected_head, a.policy_version, a.decision, a.decided_by, a.reason, a.created_at],
        )
        .map_err(|e| format!("승인 기록 실패: {e}"))?;
        Ok(())
    }

    /// 후보의 유효 승인. digest·예상 HEAD가 모두 일치해야 유효하다(불변식 3).
    pub fn latest_approval(&self, candidate_id: &str) -> Result<Option<Approval>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT * FROM approval WHERE candidate_id=?1 ORDER BY created_at DESC, id DESC LIMIT 1",
            params![candidate_id],
            row_to_approval,
        )
        .optional()
        .map_err(|e| format!("승인 조회 실패: {e}"))
    }

    pub fn list_approvals(&self, candidate_id: &str) -> Result<Vec<Approval>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM approval WHERE candidate_id=?1 ORDER BY created_at DESC")
            .map_err(|e| format!("승인 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![candidate_id], row_to_approval)
            .map_err(|e| format!("승인 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn insert_authorization(&self, a: &AuthorizationDecision) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO authorization_decision (id, candidate_id, kind, policy_version, decision_ref, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6)",
            params![a.id, a.candidate_id, a.kind_as_str(), a.policy_version, a.decision_ref, a.created_at],
        )
        .map_err(|e| format!("허가 기록 실패: {e}"))?;
        Ok(())
    }

    // ---------- policy_snapshot ----------

    pub fn insert_policy_snapshot(&self, p: &PolicySnapshot) -> Result<i64, String> {
        let conn = self.conn.lock();
        let next: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(version),0)+1 FROM policy_snapshot WHERE project_id=?1",
                params![p.project_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("정책 버전 조회 실패: {e}"))?;
        conn.execute(
            "INSERT INTO policy_snapshot (version, project_id, policy_json, created_at, created_by) VALUES (?1,?2,?3,?4,?5)",
            params![next, p.project_id, p.policy_json, p.created_at, p.created_by],
        )
        .map_err(|e| format!("정책 스냅샷 기록 실패: {e}"))?;
        Ok(next)
    }

    pub fn get_policy_snapshot(
        &self,
        project_id: &str,
        version: i64,
    ) -> Result<Option<PolicySnapshot>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT version, project_id, policy_json, created_at, created_by FROM policy_snapshot WHERE project_id=?1 AND version=?2",
            params![project_id, version],
            |r| {
                Ok(PolicySnapshot {
                    version: r.get(0)?,
                    project_id: r.get(1)?,
                    policy_json: r.get(2)?,
                    created_at: r.get(3)?,
                    created_by: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("정책 스냅샷 조회 실패: {e}"))
    }

    // ---------- project ----------

    pub fn upsert_project(
        &self,
        id: &str,
        path: &str,
        canonical_root: &str,
        git_dir: &str,
        common_dir: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO project (id, path, canonical_root, worktree_git_dir, git_common_dir, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6) \
             ON CONFLICT(id) DO UPDATE SET path=?2, canonical_root=?3, worktree_git_dir=?4, git_common_dir=?5",
            params![id, path, canonical_root, git_dir, common_dir, now_ts()],
        )
        .map_err(|e| format!("프로젝트 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn get_project(
        &self,
        id: &str,
    ) -> Result<Option<(String, String, String, String, String)>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, path, canonical_root, worktree_git_dir, git_common_dir FROM project WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("프로젝트 조회 실패: {e}"))
    }

    // ---------- 확장: instance · grant · article · sync ----------

    pub fn upsert_instance(
        &self,
        i: &crate::extensions::manifest::ConnectorInstance,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO extension_install (id, bundle_id, version, source, dir, enabled, created_at, updated_at) \
             VALUES (?1,?2,'','','',1,?3,?3) \
             ON CONFLICT(id) DO UPDATE SET updated_at=?3",
            params![i.instance_id, i.extension_id, now_ts()],
        )
        .map_err(|e| format!("instance 기록 실패: {e}"))?;
        let grant_json = serde_json::to_string(&i.grant).unwrap_or_default();
        let config_json = serde_json::to_string(&i.config).unwrap_or_default();
        conn.execute(
            "INSERT INTO permission_grant (id, instance_id, capability, scope_json, granted, created_at) \
             VALUES (?1,?2,'grant',?3,1,?4) \
             ON CONFLICT(instance_id, capability) DO UPDATE SET scope_json=?3",
            params![new_id("g"), i.instance_id, grant_json, now_ts()],
        )
        .map_err(|e| format!("grant 기록 실패: {e}"))?;
        conn.execute(
            "INSERT INTO sync_cursor (key, cursor, etag, updated_at) VALUES (?1,?2,'',?3) \
             ON CONFLICT(key) DO UPDATE SET cursor=?2, updated_at=?3",
            params![format!("instance:{}", i.instance_id), config_json, now_ts()],
        )
        .map_err(|e| format!("instance 커서 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn instance_config(&self, instance_id: &str) -> Result<Option<serde_json::Value>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT sc.cursor FROM sync_cursor sc WHERE sc.key=?1",
            params![format!("instance:{instance_id}")],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("instance 조회 실패: {e}"))?
        .map(|json| {
            serde_json::from_str(&json).map_err(|e| format!("instance config 해석 실패: {e}"))
        })
        .transpose()
    }

    pub fn list_instances(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id FROM extension_install ORDER BY created_at")
            .map_err(|e| format!("instance 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| format!("instance 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_article(
        &self,
        id: &str,
        source_instance_id: &str,
        external_id: &str,
        canonical_url: &str,
        title: &str,
        summary: &str,
        authors_json: &str,
        tags_json: &str,
        published_at: &str,
    ) -> Result<bool, String> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "INSERT INTO article (id, source_instance_id, external_id, canonical_url, title, summary, \
                 authors_json, tags_json, published_at, discovered_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) \
                 ON CONFLICT(source_instance_id, external_id) DO NOTHING",
                params![id, source_instance_id, external_id, canonical_url, title, summary, authors_json, tags_json, published_at, now_ts()],
            )
            .map_err(|e| format!("article 기록 실패: {e}"))?;
        Ok(changed > 0)
    }

    pub fn list_articles(
        &self,
        source_instance_id: &str,
        limit: i64,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.canonical_url, a.title, a.summary, a.tags_json, a.published_at, a.discovered_at, \
                 COALESCE(s.read,0), COALESCE(s.archived,0) \
                 FROM article a LEFT JOIN article_state s ON s.article_id = a.id \
                 WHERE a.source_instance_id=?1 ORDER BY a.discovered_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("article 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![source_instance_id, limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "url": r.get::<_, String>(1)?,
                    "title": r.get::<_, String>(2)?,
                    "summary": r.get::<_, String>(3)?,
                    "tags": r.get::<_, String>(4)?,
                    "publishedAt": r.get::<_, String>(5)?,
                    "discoveredAt": r.get::<_, String>(6)?,
                    "read": r.get::<_, i64>(7)?,
                    "archived": r.get::<_, i64>(8)?,
                }))
            })
            .map_err(|e| format!("article 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn set_article_state(
        &self,
        article_id: &str,
        read: Option<bool>,
        archived: Option<bool>,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO article_state (article_id, read, archived, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(article_id) DO UPDATE SET \
             read=CASE WHEN ?2<0 THEN read ELSE ?2 END, \
             archived=CASE WHEN ?3<0 THEN archived ELSE ?3 END, updated_at=?4",
            params![
                article_id,
                read.map(|b| b as i64).unwrap_or(-1),
                archived.map(|b| b as i64).unwrap_or(-1),
                now_ts()
            ],
        )
        .map_err(|e| format!("article 상태 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn update_sync_cursor(
        &self,
        key: &str,
        cursor: &str,
        etag: &str,
        _last_modified: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO sync_cursor (key, cursor, etag, updated_at) VALUES (?1,?2,?3,?4) \
             ON CONFLICT(key) DO UPDATE SET cursor=?2, etag=?3, updated_at=?4",
            params![key, cursor, etag, now_ts()],
        )
        .map_err(|e| format!("커서 기록 실패: {e}"))?;
        Ok(())
    }

    /// (cursor, etag, last_modified)
    pub fn get_sync_cursor(&self, key: &str) -> Result<Option<(String, String, String)>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT cursor, etag, '' FROM sync_cursor WHERE key=?1",
            params![key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("커서 조회 실패: {e}"))
    }

    pub fn insert_dead_letter(&self, source: &str, kind: &str, error: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO dead_letter (id, source, kind, error, created_at) VALUES (?1,?2,?3,?4,?5)",
            params![new_id("dl"), source, kind, error, now_ts()],
        )
        .map_err(|e| format!("dead letter 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn list_dead_letters(&self, limit: i64) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, source, kind, error, created_at FROM dead_letter ORDER BY created_at DESC LIMIT ?1")
            .map_err(|e| format!("dead letter 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "source": r.get::<_, String>(1)?,
                    "kind": r.get::<_, String>(2)?,
                    "error": r.get::<_, String>(3)?,
                    "createdAt": r.get::<_, String>(4)?,
                }))
            })
            .map_err(|e| format!("dead letter 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- 확장: external link · inbound change · file WAL ----------

    #[allow(clippy::too_many_arguments)]
    pub fn upsert_external_link(
        &self,
        id: &str,
        project_id: &str,
        note_path: &str,
        provider: &str,
        account_id: &str,
        repository_id: &str,
        external_id: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO external_link (id, project_id, note_path, provider, account_id, repository_id, external_id, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
             ON CONFLICT(provider, account_id, repository_id, external_id) DO UPDATE SET note_path=?3",
            params![id, project_id, note_path, provider, account_id, repository_id, external_id, now_ts()],
        )
        .map_err(|e| format!("external link 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn find_external_link(
        &self,
        provider: &str,
        repository_id: &str,
        external_id: &str,
    ) -> Result<Option<(String, String, String)>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, project_id, note_path FROM external_link WHERE provider=?1 AND repository_id=?2 AND external_id=?3",
            params![provider, repository_id, external_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("external link 조회 실패: {e}"))
    }

    pub fn insert_inbound_change(
        &self,
        id: &str,
        link_id: &str,
        source_instance: &str,
        external_id: &str,
        payload_json: &str,
        target_path: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO inbound_change (id, link_id, source_instance, external_id, payload_json, state, target_path, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,'staged',?6,?7,?7) \
             ON CONFLICT(id) DO NOTHING",
            params![id, link_id, source_instance, external_id, payload_json, target_path, now_ts()],
        )
        .map_err(|e| format!("inbound change 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn list_inbound_changes(
        &self,
        state: &str,
        limit: i64,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, link_id, source_instance, external_id, payload_json, target_path, created_at \
                 FROM inbound_change WHERE state=?1 ORDER BY created_at DESC LIMIT ?2",
            )
            .map_err(|e| format!("inbound 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![state, limit], |r| {
                Ok(serde_json::json!({
                    "id": r.get::<_, String>(0)?,
                    "linkId": r.get::<_, String>(1)?,
                    "sourceInstance": r.get::<_, String>(2)?,
                    "externalId": r.get::<_, String>(3)?,
                    "payload": r.get::<_, String>(4)?,
                    "targetPath": r.get::<_, String>(5)?,
                    "createdAt": r.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| format!("inbound 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn set_inbound_state(&self, id: &str, state: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE inbound_change SET state=?2, updated_at=?3 WHERE id=?1",
            params![id, state, now_ts()],
        )
        .map_err(|e| format!("inbound 상태 갱신 실패: {e}"))?;
        Ok(())
    }

    /// 파일 적용 WAL(설계 563-571줄). prepared → applied로만 전진한다.
    pub fn file_wal_prepare(
        &self,
        target_path: &str,
        expected_hash: &str,
        payload_hash: &str,
    ) -> Result<String, String> {
        let conn = self.conn.lock();
        let id = new_id("fw");
        conn.execute(
            "INSERT INTO file_apply_wal (id, target_path, expected_local_hash, target_hash, payload_hash, phase, created_at) \
             VALUES (?1,?2,?3,'',?4,'prepared',?5)",
            params![id, target_path, expected_hash, payload_hash, now_ts()],
        )
        .map_err(|e| format!("file WAL 기록 실패: {e}"))?;
        Ok(id)
    }

    pub fn file_wal_finish(
        &self,
        id: &str,
        applied: bool,
        target_hash: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE file_apply_wal SET phase=?2, target_hash=?3, updated_at=?4 WHERE id=?1",
            params![
                id,
                if applied { "applied" } else { "failed" },
                target_hash,
                now_ts()
            ],
        )
        .map_err(|e| format!("file WAL 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn set_field_sync_base(
        &self,
        link_id: &str,
        field: &str,
        base_hash: &str,
        base_value: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO field_sync_base (id, link_id, field, base_hash, base_value, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6) \
             ON CONFLICT(link_id, field) DO UPDATE SET base_hash=?4, base_value=?5, updated_at=?6",
            params![
                new_id("fb"),
                link_id,
                field,
                base_hash,
                base_value,
                now_ts()
            ],
        )
        .map_err(|e| format!("field sync base 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn get_field_sync_base(
        &self,
        link_id: &str,
        field: &str,
    ) -> Result<Option<(String, String)>, String> {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT base_hash, base_value FROM field_sync_base WHERE link_id=?1 AND field=?2",
            params![link_id, field],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("field sync base 조회 실패: {e}"))
    }

    // ---------- 확장: remote operation(원격 쓰기 상태머신) ----------

    #[allow(clippy::too_many_arguments)]
    pub fn insert_remote_operation(
        &self,
        id: &str,
        kind: &str,
        capability: &str,
        payload_hash: &str,
        payload_json: &str,
        observed_revision: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO remote_operation (id, kind, capability, payload_hash, payload_json, status, observed_revision, created_at) \
             VALUES (?1,?2,?3,?4,?5,'prepared',?6,?7)",
            params![id, kind, capability, payload_hash, payload_json, observed_revision, now_ts()],
        )
        .map_err(|e| format!("remote operation 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn get_remote_operation(
        &self,
        id: &str,
    ) -> Result<
        Option<(
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        )>,
        String,
    > {
        let conn = self.conn.lock();
        conn.query_row(
            "SELECT id, kind, capability, payload_hash, payload_json, status, observed_revision, result_json FROM remote_operation WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?)),
        )
        .optional()
        .map_err(|e| format!("remote operation 조회 실패: {e}"))
    }

    pub fn update_remote_operation(
        &self,
        id: &str,
        status: &str,
        result_json: &str,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE remote_operation SET status=?2, result_json=CASE WHEN ?3='' THEN result_json ELSE ?3 END, updated_at=?4 WHERE id=?1",
            params![id, status, result_json, now_ts()],
        )
        .map_err(|e| format!("remote operation 갱신 실패: {e}"))?;
        Ok(())
    }

    pub fn list_remote_operations(
        &self,
        statuses: &[&str],
        limit: i64,
    ) -> Result<Vec<serde_json::Value>, String> {
        let conn = self.conn.lock();
        let placeholders = statuses.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, kind, capability, payload_hash, status, observed_revision, result_json, created_at, updated_at \
             FROM remote_operation WHERE status IN ({placeholders}) ORDER BY created_at DESC LIMIT ?"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("remote operation 준비 실패: {e}"))?;
        let mut bind: Vec<Box<dyn rusqlite::ToSql>> = statuses
            .iter()
            .map(|s| Box::new(s.to_string()) as Box<dyn rusqlite::ToSql>)
            .collect();
        bind.push(Box::new(limit));
        let rows = stmt
            .query_map(
                rusqlite::params_from_iter(bind.iter().map(|b| b.as_ref())),
                |r| {
                    Ok(serde_json::json!({
                        "id": r.get::<_, String>(0)?,
                        "kind": r.get::<_, String>(1)?,
                        "capability": r.get::<_, String>(2)?,
                        "payloadHash": r.get::<_, String>(3)?,
                        "status": r.get::<_, String>(4)?,
                        "observedRevision": r.get::<_, String>(5)?,
                        "resultJson": r.get::<_, String>(6)?,
                        "createdAt": r.get::<_, String>(7)?,
                        "updatedAt": r.get::<_, String>(8)?,
                    }))
                },
            )
            .map_err(|e| format!("remote operation 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    // ---------- audit ----------

    /// 감사 이벤트 기록. 같은 커넥션 안에서 실행되므로 outbox와 함께 원자적이다.
    pub fn insert_audit_event(&self, e: &AuditEvent) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO audit_event (id, kind, project_id, session_id, payload_json, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![e.id, e.kind, e.project_id, e.session_id, e.payload_json, e.created_at],
        )
        .map_err(|e| format!("감사 기록 실패: {e}"))?;
        Ok(())
    }

    pub fn list_audit_events(
        &self,
        session_id: &str,
        limit: i64,
    ) -> Result<Vec<AuditEvent>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT * FROM audit_event WHERE session_id=?1 ORDER BY created_at DESC, id DESC LIMIT ?2")
            .map_err(|e| format!("감사 목록 준비 실패: {e}"))?;
        let rows = stmt
            .query_map(params![session_id, limit], row_to_audit)
            .map_err(|e| format!("감사 목록 조회 실패: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 상태 전이 + 감사 기록을 한 트랜잭션으로 묶는 헬퍼. 큐 워커가 전이마다 쓴다.
    pub fn transition_with_audit(
        &self,
        candidate_id: &str,
        from: ChangeSetStatus,
        to: ChangeSetStatus,
        audit_kind: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|e| format!("트랜잭션 시작 실패: {e}"))?;
        let changed = tx
            .execute(
                "UPDATE change_set SET status=?2, updated_at=?3 WHERE id=?1 AND status=?4",
                params![candidate_id, to.as_str(), now_ts(), from.as_str()],
            )
            .map_err(|e| format!("상태 전이 실패: {e}"))?;
        if changed == 0 {
            // 이미 다른 상태로 갔다 — 경합 패배. 오류 대신 무시(멱등).
            return Ok(());
        }
        let event = AuditEvent {
            id: new_id("e"),
            kind: audit_kind.into(),
            project_id: String::new(),
            session_id: String::new(),
            payload_json: payload.to_string(),
            created_at: now_ts(),
        };
        tx.execute(
            "INSERT INTO audit_event (id, kind, project_id, session_id, payload_json, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
            params![event.id, event.kind, event.project_id, event.session_id, event.payload_json, event.created_at],
        )
        .map_err(|e| format!("감사 기록 실패: {e}"))?;
        tx.commit().map_err(|e| format!("전이 커밋 실패: {e}"))
    }
}

// ---------- row mappers ----------

fn session_mode_str(m: SessionMode) -> &'static str {
    match m {
        SessionMode::Direct => "direct",
        SessionMode::Isolated => "isolated",
    }
}

fn row_to_session(r: &Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        goal: r.get("goal")?,
        status: string_to_session_status(&r.get::<_, String>("status")?),
        mode: match r.get::<_, String>("mode")?.as_str() {
            "isolated" => SessionMode::Isolated,
            _ => SessionMode::Direct,
        },
        integration_path: r.get("integration_path")?,
        integration_branch: r.get("integration_branch")?,
        target_start_sha: r.get("target_start_sha")?,
        policy_version: r.get("policy_version")?,
        verification_profile: r.get("verification_profile")?,
        created_at: r.get("created_at")?,
        finalized_at: r.get("finalized_at")?,
        paused_reason: r.get("paused_reason")?,
    })
}

fn string_to_session_status(s: &str) -> SessionStatus {
    match s {
        "paused" => SessionStatus::Paused,
        "readyToFinalize" => SessionStatus::ReadyToFinalize,
        "finalized" => SessionStatus::Finalized,
        _ => SessionStatus::Active,
    }
}

fn row_to_agent_run(r: &Row) -> rusqlite::Result<AgentRun> {
    Ok(AgentRun {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        job_id: r.get("job_id")?,
        task_id: r.get("task_id")?,
        branch: r.get("branch")?,
        worktree_path: r.get("worktree_path")?,
        driver: r.get("driver")?,
        status: r.get("status")?,
        created_at: r.get("created_at")?,
        finished_at: r.get("finished_at")?,
    })
}

fn row_to_change_set(r: &Row) -> rusqlite::Result<ChangeSet> {
    Ok(ChangeSet {
        id: r.get("id")?,
        session_id: r.get("session_id")?,
        task_id: r.get("task_id")?,
        repository_id: r.get("repository_id")?,
        base_sha: r.get("base_sha")?,
        source_sha: r.get("source_sha")?,
        base_tree_sha: r.get("base_tree_sha")?,
        source_tree_sha: r.get("source_tree_sha")?,
        manifest_json: r.get("manifest_json")?,
        dependency_json: r.get("dependency_json")?,
        verification_plan_hash: r.get("verification_plan_hash")?,
        digest: r.get("digest")?,
        status: ChangeSetStatus::parse(&r.get::<_, String>("status")?)
            .unwrap_or(ChangeSetStatus::Working),
        summary: r.get("summary")?,
        superseded_by: r.get("superseded_by")?,
        remediated_by: r.get("remediated_by")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

fn row_to_attempt(r: &Row) -> rusqlite::Result<IntegrationAttempt> {
    Ok(IntegrationAttempt {
        id: r.get("id")?,
        candidate_id: r.get("candidate_id")?,
        session_id: r.get("session_id")?,
        operation: r.get("operation")?,
        phase: string_to_phase(&r.get::<_, String>("phase")?),
        pre_head: r.get("pre_head")?,
        planned_tree_sha: r.get("planned_tree_sha")?,
        source_sha: r.get("source_sha")?,
        baseline_json: r.get("baseline_json")?,
        merge_sha: r.get("merge_sha")?,
        revert_sha: r.get("revert_sha")?,
        failure_detail: r.get("failure_detail")?,
        created_at: r.get("created_at")?,
        finished_at: r.get("finished_at")?,
    })
}

fn string_to_phase(s: &str) -> AttemptPhase {
    Some(match s {
        "merging" => AttemptPhase::Merging,
        "merged" => AttemptPhase::Merged,
        "verifying" => AttemptPhase::Verifying,
        "verified" => AttemptPhase::Verified,
        "verification_failed" => AttemptPhase::VerificationFailed,
        "conflict_aborted" => AttemptPhase::ConflictAborted,
        "baseline_failed" => AttemptPhase::BaselineFailed,
        "reverting" => AttemptPhase::Reverting,
        "reverted" => AttemptPhase::Reverted,
        "revert_conflicted" => AttemptPhase::RevertConflicted,
        "recovery_required" => AttemptPhase::RecoveryRequired,
        _ => AttemptPhase::Prepared,
    })
    .unwrap_or(AttemptPhase::Prepared)
}

fn row_to_check_run(r: &Row) -> rusqlite::Result<CheckRun> {
    Ok(CheckRun {
        id: r.get("id")?,
        attempt_id: r.get("attempt_id")?,
        kind: r.get("kind")?,
        name: r.get("name")?,
        status: r.get("status")?,
        log_ref: r.get("log_ref")?,
        started_at: r.get("started_at")?,
        finished_at: r.get("finished_at")?,
    })
}

fn row_to_approval(r: &Row) -> rusqlite::Result<Approval> {
    Ok(Approval {
        id: r.get("id")?,
        candidate_id: r.get("candidate_id")?,
        digest: r.get("digest")?,
        expected_head: r.get("expected_head")?,
        policy_version: r.get("policy_version")?,
        decision: r.get("decision")?,
        decided_by: r.get("decided_by")?,
        reason: r.get("reason")?,
        created_at: r.get("created_at")?,
    })
}

fn row_to_audit(r: &Row) -> rusqlite::Result<AuditEvent> {
    Ok(AuditEvent {
        id: r.get("id")?,
        kind: r.get("kind")?,
        project_id: r.get("project_id")?,
        session_id: r.get("session_id")?,
        payload_json: r.get("payload_json")?,
        created_at: r.get("created_at")?,
    })
}

impl AuthorizationDecision {
    pub fn kind_as_str(&self) -> &'static str {
        match self.kind {
            AuthorizationKind::Human => "human",
            AuthorizationKind::Policy => "policy",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> StoreHandle {
        let dir =
            std::env::temp_dir().join(format!("sawhorse-store-test-{}", uuid::Uuid::new_v4()));
        Store::open_at(dir.join("workbench.sqlite")).unwrap()
    }

    fn sample_session(id: &str) -> Session {
        Session {
            id: id.into(),
            project_id: "p-1".into(),
            goal: "테스트".into(),
            status: SessionStatus::Active,
            mode: SessionMode::Direct,
            integration_path: "/tmp/repo".into(),
            integration_branch: "main".into(),
            target_start_sha: "aaa".into(),
            policy_version: 1,
            verification_profile: "desktop".into(),
            created_at: now_ts(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        }
    }

    #[test]
    fn session_roundtrip_and_status_update() {
        let store = temp_store();
        store
            .upsert_project(
                "p-1",
                "/tmp/repo",
                "/tmp/repo",
                "/tmp/repo/.git",
                "/tmp/repo/.git",
            )
            .unwrap();
        store.insert_session(&sample_session("s-1")).unwrap();
        let s = store.get_session("s-1").unwrap().unwrap();
        assert_eq!(s.status, SessionStatus::Active);
        assert_eq!(s.integration_path, "/tmp/repo");
        store
            .update_session_status("s-1", SessionStatus::Paused, "dirty checkout")
            .unwrap();
        let s = store.get_session("s-1").unwrap().unwrap();
        assert_eq!(s.status, SessionStatus::Paused);
        assert_eq!(s.paused_reason, "dirty checkout");
        store
            .update_session_status("s-1", SessionStatus::Finalized, "")
            .unwrap();
        let s = store.get_session("s-1").unwrap().unwrap();
        assert_eq!(s.status, SessionStatus::Finalized);
        assert!(!s.finalized_at.is_empty());
    }

    #[test]
    fn active_session_query_excludes_finalized() {
        let store = temp_store();
        store
            .upsert_project(
                "p-1",
                "/tmp/repo",
                "/tmp/repo",
                "/tmp/repo/.git",
                "/tmp/repo/.git",
            )
            .unwrap();
        store.insert_session(&sample_session("s-1")).unwrap();
        store.insert_session(&sample_session("s-2")).unwrap();
        store
            .update_session_status("s-2", SessionStatus::Finalized, "")
            .unwrap();
        let active = store.active_sessions_for_path("/tmp/repo").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, "s-1");
    }

    #[test]
    fn attempt_phase_transitions_persist() {
        let store = temp_store();
        store
            .upsert_project(
                "p-1",
                "/tmp/repo",
                "/tmp/repo",
                "/tmp/repo/.git",
                "/tmp/repo/.git",
            )
            .unwrap();
        store.insert_session(&sample_session("s-1")).unwrap();
        let attempt = IntegrationAttempt {
            id: "ia-1".into(),
            candidate_id: "c-1".into(),
            session_id: "s-1".into(),
            pre_head: "aaa".into(),
            planned_tree_sha: "ttt".into(),
            source_sha: "sss".into(),
            created_at: now_ts(),
            ..Default::default()
        };
        store.insert_attempt(&attempt).unwrap();
        store
            .update_attempt_phase("ia-1", AttemptPhase::Merging, "", "", "")
            .unwrap();
        store
            .update_attempt_phase("ia-1", AttemptPhase::Merged, "mmm", "", "")
            .unwrap();
        let a = store.get_attempt("ia-1").unwrap().unwrap();
        assert_eq!(a.phase, AttemptPhase::Merged);
        assert_eq!(a.merge_sha, "mmm");
        assert!(a.finished_at.is_empty(), "merged는 아직 종결 아님");
        store
            .update_attempt_phase("ia-1", AttemptPhase::Verified, "", "", "")
            .unwrap();
        let a = store.get_attempt("ia-1").unwrap().unwrap();
        assert!(!a.finished_at.is_empty(), "verified는 종결");
        let unfinished = store.unfinished_attempts().unwrap();
        assert!(unfinished.is_empty());
    }

    #[test]
    fn unfinished_attempt_is_visible_for_recovery() {
        let store = temp_store();
        store
            .upsert_project(
                "p-1",
                "/tmp/repo",
                "/tmp/repo",
                "/tmp/repo/.git",
                "/tmp/repo/.git",
            )
            .unwrap();
        store.insert_session(&sample_session("s-1")).unwrap();
        store
            .insert_attempt(&IntegrationAttempt {
                id: "ia-1".into(),
                candidate_id: "c-1".into(),
                session_id: "s-1".into(),
                phase: AttemptPhase::Merging,
                pre_head: "aaa".into(),
                created_at: now_ts(),
                ..Default::default()
            })
            .unwrap();
        let unfinished = store.unfinished_attempts().unwrap();
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].phase, AttemptPhase::Merging);
    }

    #[test]
    fn policy_snapshot_versions_increment_per_project() {
        let store = temp_store();
        let snap = |json: &str| PolicySnapshot {
            version: 0,
            project_id: "p-1".into(),
            policy_json: json.into(),
            created_at: now_ts(),
            created_by: "human".into(),
        };
        let v1 = store.insert_policy_snapshot(&snap("{}")).unwrap();
        let v2 = store.insert_policy_snapshot(&snap("{\"a\":1}")).unwrap();
        assert_eq!(v1, 1);
        assert_eq!(v2, 2);
        let loaded = store.get_policy_snapshot("p-1", 2).unwrap().unwrap();
        assert_eq!(loaded.policy_json, "{\"a\":1}");
        assert!(store.get_policy_snapshot("p-2", 1).unwrap().is_none());
    }

    #[test]
    fn transition_with_audit_is_conditional() {
        let store = temp_store();
        store
            .upsert_project(
                "p-1",
                "/tmp/repo",
                "/tmp/repo",
                "/tmp/repo/.git",
                "/tmp/repo/.git",
            )
            .unwrap();
        store.insert_session(&sample_session("s-1")).unwrap();
        let cs = ChangeSet {
            id: "c-1".into(),
            session_id: "s-1".into(),
            status: ChangeSetStatus::ReviewPending,
            digest: "d".into(),
            created_at: now_ts(),
            updated_at: now_ts(),
            ..Default::default()
        };
        store.insert_change_set(&cs, &[]).unwrap();
        store
            .transition_with_audit(
                "c-1",
                ChangeSetStatus::ReviewPending,
                ChangeSetStatus::Approved,
                "approval.resolved",
                serde_json::json!({"ok": true}),
            )
            .unwrap();
        assert_eq!(
            store.get_change_set("c-1").unwrap().unwrap().status,
            ChangeSetStatus::Approved
        );
        // 경합 패배: 이미 Approved인 후보를 ReviewPending에서 Approved로 또 바꾸려 함 — 무시.
        store
            .transition_with_audit(
                "c-1",
                ChangeSetStatus::ReviewPending,
                ChangeSetStatus::Approved,
                "approval.resolved",
                serde_json::json!({}),
            )
            .unwrap();
        assert_eq!(
            store.get_change_set("c-1").unwrap().unwrap().status,
            ChangeSetStatus::Approved
        );
    }
}
