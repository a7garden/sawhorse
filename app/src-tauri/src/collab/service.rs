// Collaboration service. Design line 815: session service and command boundary.
//
// Gathers state transitions, queue progression, driver assembly, and event emission in one place. Tauri
// commands call only this service's methods. The approval queue is perChange serial processing (design lines 355-357) —
// the next candidate is not touched until the current one is finalized as verified/reverted, etc.

use super::drivers::{AgentDriver, ClaudeManagedDriver, CodexManualDriver};
use super::events;
use super::inbox;
use super::integration::{self, IntegrationCtx};
use super::model::*;
use super::policy;
use super::store::{Store, StoreHandle};
use super::{inbox_dir, new_id, now_ts};
use crate::collab::git;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct CollabService {
    pub store: StoreHandle,
    pub claude: Arc<ClaudeManagedDriver>,
    pub codex: Arc<CodexManualDriver>,
    /// Logical serialization of the integration worker. Besides the OS lock, it ties the queue into one within the process.
    queue_lock: parking_lot::Mutex<()>,
}

/// Session creation input. Values confirmed by a human on the dashboard.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub project_id: String,
    pub goal: String,
    pub mode: String,
    /// Integration target branch in direct mode. Empty means the registered integration.branch.
    pub branch: String,
    /// Lane list. Each lane is one agent's branch + worktree + task.
    pub lanes: Vec<LaneInput>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneInput {
    pub task_id: String,
    pub task_prompt: String,
    /// claude | codex. codex is for manual submission only.
    pub driver: String,
}

impl CollabService {
    pub fn new(store: StoreHandle, jobs: Arc<crate::jobs::JobManager>) -> Arc<Self> {
        Arc::new(CollabService {
            store,
            claude: Arc::new(ClaudeManagedDriver::new(jobs)),
            codex: Arc::new(CodexManualDriver),
            queue_lock: parking_lot::Mutex::new(()),
        })
    }

    fn driver(&self, name: &str) -> Result<&dyn AgentDriver, String> {
        match name {
            "claude" => Ok(self.claude.as_ref()),
            "codex" => Ok(self.codex.as_ref()),
            other => Err(format!("알 수 없는 드라이버: {other}")),
        }
    }

    // ---------- Sessions ----------

    /// Creates a session (design lines 117-135). Verify representative checkout → policy snapshot → record session and lanes → run.
    pub fn create_session(
        &self,
        view: &crate::config::ConfigView,
        input: &CreateSessionInput,
    ) -> Result<Session, String> {
        if input.goal.trim().is_empty() {
            return Err("세션 목표가 비어 있다".into());
        }
        let project = view
            .core_projects
            .get(&input.project_id)
            .ok_or_else(|| format!("등록되지 않은 프로젝트: {}", input.project_id))?;
        let integration_path = if project.integration.path.is_empty() {
            project.path.clone()
        } else {
            project.integration.path.clone()
        };
        let branch = if input.branch.is_empty() {
            project.integration.branch.clone()
        } else {
            input.branch.clone()
        };
        if branch.is_empty() {
            return Err("통합 branch가 지정되지 않았다".into());
        }
        let repo = PathBuf::from(&integration_path);
        if !repo.is_dir() {
            return Err(format!("통합 체크아웃 경로가 없다: {integration_path}"));
        }

        // A human confirms path, branch, and HEAD at session start (design lines 134-135).
        let identity = git::repo_identity(&repo)?;
        let head = git::head_info(&repo)?;
        if let Some(danger) = &head.dangerous_state {
            return Err(format!("대표 체크아웃 상태가 안전하지 않다: {danger}"));
        }
        if !head.clean {
            return Err(format!(
                "대표 체크아웃이 dirty하다: {:?}",
                head.status_lines
            ));
        }
        if head.branch != branch {
            return Err(format!(
                "대표 체크아웃이 {branch}가 아니라 {}에 있다. 세션 시작 전 사람이 확인해야 한다",
                head.branch
            ));
        }
        // The same integration checkout lease cannot go to two sessions at once (design lines 537-538).
        let active = self.store.active_sessions_for_path(&integration_path)?;
        if !active.is_empty() {
            return Err(format!(
                "이 통합 체크아웃에는 활성 세션이 이미 있다: {}",
                active[0].id
            ));
        }

        // policy snapshot v1 — the policy the human confirmed at start is fixed.
        let (policy_version, _policy) =
            policy::snapshot_for_new_session(&self.store, &input.project_id, view)?;

        let mode = if input.mode == "isolated" {
            SessionMode::Isolated
        } else {
            SessionMode::Direct
        };
        let profile_name = project.integration.verify_profile.clone();
        let session = Session {
            id: new_id("s"),
            project_id: input.project_id.clone(),
            goal: input.goal.clone(),
            status: SessionStatus::Active,
            mode,
            integration_path: integration_path.clone(),
            integration_branch: branch.clone(),
            target_start_sha: head.head.clone(),
            policy_version,
            verification_profile: profile_name,
            created_at: now_ts(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        };
        self.store.insert_session(&session)?;

        // Lanes: agent branch + dedicated worktree + driver start.
        for lane in &input.lanes {
            self.start_lane(&session, lane)?;
        }

        self.store.insert_audit_event(&events::make_event(
            events::SESSION_CREATED,
            &session.project_id,
            &session.id,
            serde_json::json!({
                "goal": session.goal,
                "mode": input.mode,
                "branch": branch,
                "head": head.head,
                "lanes": input.lanes.len(),
            }),
        ))?;
        Ok(session)
    }

    /// Creates and runs one lane. The core creates the worktree and records it exactly in the registry (design line 495).
    fn start_lane(&self, session: &Session, lane: &LaneInput) -> Result<AgentRun, String> {
        let branch = format!(
            "sawhorse/agent/{}/{}",
            session.id,
            if lane.task_id.is_empty() {
                "task".to_string()
            } else {
                lane.task_id.clone()
            }
        );
        self.spawn_lane(session, lane, &branch)
    }
    pub fn tick(
        &self,
        view: &crate::config::ConfigView,
    ) -> Result<Vec<inbox::InboxReport>, String> {
        let reports = inbox::process_inbox(&self.store)?;
        auto_authorize_candidates(&self.store, view)?;
        if reports.iter().any(|r| r.accepted) {
            self.run_queue(view)?;
        }
        Ok(reports)
    }

    /// Serial queue processing. Integrates only one candidate at a time (invariants 1 and 5).
    pub fn run_queue(
        &self,
        view: &crate::config::ConfigView,
    ) -> Result<Option<AttemptPhase>, String> {
        let _guard = self.queue_lock.lock();
        let pending = self.store.pending_change_sets()?;
        // Order: queued (approved) → approved; review_pending cannot enter the queue.
        let candidate = match pending
            .into_iter()
            .find(|c| matches!(c.status, ChangeSetStatus::Queued))
        {
            Some(c) => c,
            None => return Ok(None),
        };
        let session = self
            .store
            .get_session(&candidate.session_id)?
            .ok_or("세션이 없다")?;
        if session.status != SessionStatus::Active {
            return Ok(None);
        }
        let project = view
            .core_projects
            .get(&session.project_id)
            .ok_or("프로젝트 등록이 없다")?;
        let profile_name = if session.verification_profile.is_empty() {
            project.integration.verify_profile.clone()
        } else {
            session.verification_profile.clone()
        };
        let profile = project
            .verify_profiles
            .get(&profile_name)
            .cloned()
            .unwrap_or_default();

        // Approval validity: digest and expected HEAD must match (invariant 3).
        let approval = self
            .store
            .latest_approval(&candidate.id)?
            .ok_or("승인 기록이 없다")?;
        let repo = PathBuf::from(&session.integration_path);
        let head = git::head_info(&repo)?.head;
        if policy::approval_is_stale(&approval, &head, &candidate)? {
            return Ok(None);
        }

        let ctx = IntegrationCtx {
            store: &self.store,
            project_id: &session.project_id,
            profile: &profile,
        };
        self.store.transition_with_audit(
            &candidate.id,
            ChangeSetStatus::Queued,
            ChangeSetStatus::Queued,
            "integration.started",
            serde_json::json!({}),
        )?;
        let result = integration::attempt_merge(&ctx, &session, &candidate, &approval);
        match result {
            Ok(phase) => Ok(Some(phase)),
            Err(e) if e.starts_with("HEAD_DRIFT:") => {
                // Any difference from the HEAD at approval time forces re-approval (design lines 378-380).
                self.store
                    .update_change_set_status(&candidate.id, ChangeSetStatus::ReviewPending)?;
                self.store.insert_audit_event(&events::make_event(
                    "integration.head_drift",
                    &session.project_id,
                    &session.id,
                    serde_json::json!({ "candidateId": candidate.id, "detail": e }),
                ))?;
                Err("HEAD가 승인 때와 다르다 — 재승인이 필요하다".into())
            }
            Err(e) => Err(e),
        }
    }

    // ---------- Review ----------

    /// Accepts a candidate: approval record + queue entry (per policy). expected_head is the current integration HEAD.
    pub fn approve_candidate(&self, candidate_id: &str, decided_by: &str) -> Result<(), String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        if !matches!(
            candidate.status,
            ChangeSetStatus::ReviewPending | ChangeSetStatus::ChangesRequested
        ) {
            return Err(format!(
                "검토 대기 상태가 아니다: {}",
                candidate.status.as_str()
            ));
        }
        let session = self
            .store
            .get_session(&candidate.session_id)?
            .ok_or("세션이 없다")?;
        let repo = PathBuf::from(&session.integration_path);
        let head = git::head_info(&repo)?.head;
        policy::record_human_approval(
            &self.store,
            &candidate,
            &head,
            session.policy_version,
            decided_by,
        )?;
        self.store
            .update_change_set_status(candidate_id, ChangeSetStatus::Queued)?;
        self.store.insert_audit_event(&events::make_event(
            events::APPROVAL_RESOLVED,
            &session.project_id,
            &session.id,
            policy::audit_payload(
                &candidate,
                serde_json::json!({ "decision": "approved", "expectedHead": head }),
            ),
        ))?;
        Ok(())
    }

    pub fn reject_candidate(
        &self,
        candidate_id: &str,
        decided_by: &str,
        reason: &str,
    ) -> Result<(), String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        self.store.insert_approval(&Approval {
            id: new_id("ap"),
            candidate_id: candidate.id.clone(),
            digest: candidate.digest.clone(),
            decision: "rejected".into(),
            decided_by: decided_by.into(),
            reason: reason.into(),
            policy_version: 0,
            created_at: now_ts(),
            ..Default::default()
        })?;
        self.store
            .update_change_set_status(candidate_id, ChangeSetStatus::Rejected)?;
        Ok(())
    }

    /// Changes requested → back to working so the agent can continue (design line 328).
    pub fn request_changes(&self, candidate_id: &str, reason: &str) -> Result<(), String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        self.store
            .update_change_set_status(candidate_id, ChangeSetStatus::ChangesRequested)?;
        self.store.insert_audit_event(&events::make_event(
            events::APPROVAL_REQUESTED,
            "",
            &candidate.session_id,
            serde_json::json!({ "candidateId": candidate.id, "request": reason }),
        ))?;
        Ok(())
    }

    // ---------- Verification confirmation ----------

    pub fn confirm_manual_ok(&self, candidate_id: &str) -> Result<(), String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        let session = self
            .store
            .get_session(&candidate.session_id)?
            .ok_or("세션이 없다")?;
        integration::confirm_manual_ok(&self.store, &session, &candidate)?;
        // After verification succeeds, the core applies issue note intents once (design lines 76-78).
        inbox::apply_note_intents(&self.store, candidate_id)?;
        Ok(())
    }

    pub fn confirm_manual_failed(&self, candidate_id: &str, reason: &str) -> Result<(), String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        integration::confirm_manual_failed(&self.store, &candidate, reason)
    }

    // ---------- Recovery ----------

    /// Continue with repairs: create a repair lane from the current integration HEAD (design lines 423-424).
    pub fn create_repair_lane(
        &self,
        candidate_id: &str,
        instruction: &str,
    ) -> Result<AgentRun, String> {
        let failed = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        let session = self
            .store
            .get_session(&failed.session_id)?
            .ok_or("세션이 없다")?;
        let repo = PathBuf::from(&session.integration_path);
        let head = git::head_info(&repo)?;
        if !head.clean {
            return Err("repair lane은 clean한 통합 체크아웃에서만 만든다".into());
        }
        let lane = LaneInput {
            task_id: String::new(),
            task_prompt: format!(
                "후보 {cid}(요약: {summary})가 검증 실패했다. 실패 로그와 merge SHA는 검토 화면을 참고하라. 지시: {instruction}",
                cid = failed.id,
                summary = failed.summary,
                instruction = instruction,
            ),
            driver: "claude".into(),
        };
        let branch_name = format!("sawhorse/repair/{}/{}", session.id, failed.id);
        self.spawn_lane(&session, &lane, &branch_name)
    }

    fn spawn_lane(
        &self,
        session: &Session,
        lane: &LaneInput,
        branch: &str,
    ) -> Result<AgentRun, String> {
        let driver = self.driver(&lane.driver)?;
        let repo = PathBuf::from(&session.integration_path);
        let run_id = new_id("r");
        let worktree = super::locks_dir()
            .parent()
            .unwrap_or(Path::new("."))
            .join("worktrees")
            .join(&run_id);
        // Create worktree+branch from the current integration HEAD (design line 423).
        let out = crate::spawn::no_window(std::process::Command::new("git"))
            .arg("-C")
            .arg(&repo)
            .args([
                "worktree",
                "add",
                worktree.to_str().unwrap_or_default(),
                "-b",
                branch,
            ])
            .output()
            .map_err(|e| format!("git worktree 실행 실패: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "worktree 생성 실패: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let head = git::head_info(&repo)?.head;
        let run = AgentRun {
            id: run_id.clone(),
            session_id: session.id.clone(),
            job_id: String::new(),
            task_id: lane.task_id.clone(),
            branch: branch.to_string(),
            worktree_path: worktree.to_string_lossy().to_string(),
            driver: driver.id().to_string(),
            status: "pending".into(),
            created_at: now_ts(),
            finished_at: String::new(),
        };
        self.store.insert_agent_run(&run)?;
        let spec = crate::jobs::CollabLaneSpec {
            session_id: session.id.clone(),
            run_id: run.id.clone(),
            goal: session.goal.clone(),
            worktree: run.worktree_path.clone(),
            branch: branch.to_string(),
            base_sha: head,
            task_prompt: lane.task_prompt.clone(),
            inbox_path: inbox_dir().to_string_lossy().to_string() + "/",
        };
        match driver.start(&run, spec) {
            Ok(job_id) => {
                self.store.update_agent_run(&run.id, &job_id, "running")?;
            }
            Err(e) => {
                self.store.update_agent_run(&run.id, "", "failed")?;
                return Err(e);
            }
        }
        Ok(run)
    }

    /// Remove the change — the human's action is itself the approval (design line 428).
    pub fn revert_candidate(&self, candidate_id: &str) -> Result<AttemptPhase, String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        let session = self
            .store
            .get_session(&candidate.session_id)?
            .ok_or("세션이 없다")?;
        let profile = VerifyProfile::default(); // post-revert smoke uses the default profile.
        let ctx = IntegrationCtx {
            store: &self.store,
            project_id: &session.project_id,
            profile: &profile,
        };
        let phase = integration::attempt_revert(&ctx, &session, &candidate)?;
        self.store.insert_audit_event(&events::make_event(
            events::INTEGRATION_REVERTED,
            &session.project_id,
            &session.id,
            serde_json::json!({ "candidateId": candidate.id, "phase": phase.as_str() }),
        ))?;
        Ok(phase)
    }

    // ---------- Finalization ----------

    /// finalized in direct mode: confirm every candidate is terminal and release the lease (design lines 139-141).
    pub fn finalize_session(&self, session_id: &str) -> Result<Session, String> {
        let session = self.store.get_session(session_id)?.ok_or("세션이 없다")?;
        let candidates = self.store.list_change_sets(session_id)?;
        let open: Vec<&ChangeSet> = candidates
            .iter()
            .filter(|c| !c.status.is_terminal())
            .collect();
        if !open.is_empty() {
            return Err(format!(
                "종결되지 않은 후보가 있다: {}",
                open.iter()
                    .map(|c| c.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        self.store
            .update_session_status(session_id, SessionStatus::Finalized, "")?;
        let updated = self.store.get_session(session_id)?.unwrap();
        Ok(updated)
    }

    pub fn pause_session(&self, session_id: &str, reason: &str) -> Result<(), String> {
        self.store
            .update_session_status(session_id, SessionStatus::Paused, reason)?;
        Ok(())
    }

    pub fn resume_session(&self, session_id: &str) -> Result<(), String> {
        let session = self.store.get_session(session_id)?.ok_or("세션이 없다")?;
        if session.status != SessionStatus::Paused {
            return Err("일시정지 상태가 아니다".into());
        }
        self.store
            .update_session_status(session_id, SessionStatus::Active, "")?;
        Ok(())
    }

    // ---------- Queries ----------

    pub fn session_view(&self, session_id: &str) -> Result<SessionView, String> {
        let session = self.store.get_session(session_id)?.ok_or("세션이 없다")?;
        let runs = self.store.list_agent_runs(session_id)?;
        let candidates = self.store.list_change_sets(session_id)?;
        let repo = PathBuf::from(&session.integration_path);
        let (head, clean) = match git::head_info(&repo) {
            Ok(h) => (h.head, h.clean),
            Err(_) => (String::new(), false),
        };
        let mut views = Vec::new();
        for c in candidates {
            let deps = self.store.change_set_depends_on(&c.id)?;
            let approvals = self.store.list_approvals(&c.id)?;
            views.push(ChangeSetView {
                change_set: c.clone(),
                manifest: serde_json::from_str(&c.manifest_json).unwrap_or_default(),
                depends_on: deps,
                session_goal: session.goal.clone(),
                overlap_paths: integration::overlap_paths(&c.manifest_json),
                expected_head: head.clone(),
                approvals,
            });
        }
        Ok(SessionView {
            session,
            agent_runs: runs,
            change_sets: views,
            integration_head: head,
            integration_clean: clean,
        })
    }
}

/// Automatic authorization of the autoAfterPreflight policy (design lines 240-242). Only candidates that pass
/// preflight enter the queue as policy authorizations. Semantic overlap candidates are excluded from
/// automatic authorization — risky paths requiring re-approval and a manual smoke test (design lines 398-402).
pub fn auto_authorize_candidates(
    store: &Store,
    view: &crate::config::ConfigView,
) -> Result<usize, String> {
    let mut authorized = 0usize;
    for candidate in store.pending_change_sets()? {
        if candidate.status != ChangeSetStatus::ReviewPending {
            continue;
        }
        let session = match store.get_session(&candidate.session_id)? {
            Some(s) if s.status == SessionStatus::Active => s,
            _ => continue,
        };
        let policy = policy::load_policy(store, &session.project_id, session.policy_version)?;
        if policy.local_integration_approval != PolicyMode::AutoAfterPreflight {
            continue;
        }
        let repo = PathBuf::from(&session.integration_path);
        // preflight: the representative checkout must be safe and the candidate base must be an ancestor of the current HEAD.
        let head = match git::head_info(&repo) {
            Ok(h)
                if h.clean
                    && h.dangerous_state.is_none()
                    && h.branch == session.integration_branch =>
            {
                h
            }
            _ => continue,
        };
        match git::is_ancestor(&repo, &candidate.base_sha, &head.head) {
            Ok(true) => {}
            _ => continue, // a stale candidate goes back for re-review
        }
        // Healthy baseline: the verification profile must pass at the current HEAD.
        let project = match view.core_projects.get(&session.project_id) {
            Some(p) => p,
            None => continue,
        };
        let profile_name = if session.verification_profile.is_empty() {
            project.integration.verify_profile.clone()
        } else {
            session.verification_profile.clone()
        };
        let profile = project
            .verify_profiles
            .get(&profile_name)
            .cloned()
            .unwrap_or_default();
        let baseline_ok =
            super::checks::run_profile_checks_blocking(&repo, &session.project_id, &profile, true)
                .iter()
                .all(|(r, _)| r.status == "passed");
        if !baseline_ok {
            continue;
        }
        if !super::integration::overlap_paths(&candidate.manifest_json).is_empty() {
            continue;
        }
        if policy::record_policy_authorization(
            store,
            &candidate,
            &head.head,
            session.policy_version,
            true,
        )?
        .is_some()
        {
            store.update_change_set_status(&candidate.id, ChangeSetStatus::Queued)?;
            authorized += 1;
        }
    }
    Ok(authorized)
}
