// 협업 서비스. 설계 815줄: 세션 서비스와 command 경계.
//
// 상태 전이·큐 진행·드라이버 조립·이벤트 방출을 한 곳에 모은다. tauri 커맨드는
// 이 서비스의 메서드만 부른다. 승인 큐는 perChange 직렬 처리다(설계 355-357줄) —
// 후보 하나가 verified/reverted 등으로 종결되기 전까지 다음 후보를 건드리지 않는다.

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
    /// 통합 워커의 논리적 직렬화. OS lock과 별개로 프로세스 안에서 큐를 하나로 묶는다.
    queue_lock: parking_lot::Mutex<()>,
}

/// 세션 생성 입력. 사람이 대시보드에서 확인한 값들이다.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CreateSessionInput {
    pub project_id: String,
    pub goal: String,
    pub mode: String,
    /// direct 모드에서 통합 대상 branch. 비어 있으면 등록된 integration.branch.
    pub branch: String,
    /// 레인 목록. 각 레인은 에이전트 한 명의 branch + worktree + task.
    pub lanes: Vec<LaneInput>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct LaneInput {
    pub task_id: String,
    pub task_prompt: String,
    /// claude | codex. codex는 수동 제출 전용이다.
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

    // ---------- 세션 ----------

    /// 세션 생성(설계 117-135줄). 대표 체크아웃 확인 → 정책 스냅샷 → 세션·레인 기록 → 실행.
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

        // 세션 시작 때 사람이 path, branch, HEAD를 확인한다(설계 134-135줄).
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
        // 같은 통합 체크아웃 lease를 두 세션에 동시에 줄 수 없다(설계 537-538줄).
        let active = self.store.active_sessions_for_path(&integration_path)?;
        if !active.is_empty() {
            return Err(format!(
                "이 통합 체크아웃에는 활성 세션이 이미 있다: {}",
                active[0].id
            ));
        }

        // policy snapshot v1 — 시작 때 사람이 확인한 정책이 고정된다.
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

        // 레인: agent branch + 전용 worktree + 드라이버 시작.
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

    /// 레인 하나를 만들고 실행한다. worktree는 코어가 만들어 registry에 정확히 기록한다(설계 495줄).
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

    /// 직렬 큐 처리. 한 번에 후보 하나만 통합한다(불변식 1·5).
    pub fn run_queue(
        &self,
        view: &crate::config::ConfigView,
    ) -> Result<Option<AttemptPhase>, String> {
        let _guard = self.queue_lock.lock();
        let pending = self.store.pending_change_sets()?;
        // 순서: queued(승인됨) → approved → review_pending은 큐에 못 들어온다.
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

        // 승인 유효성: digest·예상 HEAD 일치(불변식 3).
        let approval = self
            .store
            .latest_approval(&candidate.id)?
            .ok_or("승인 기록이 없다")?;
        if policy::approval_is_stale(&approval, "", &candidate)? {
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
                // 승인 때 HEAD와 다르면 무조건 재승인(설계 378-380줄).
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

    // ---------- 검토 ----------

    /// 후보 수용: 승인 기록 + (정책에 따라) 큐 진입. expected_head는 현재 통합 HEAD.
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

    /// 수정 요청 → working으로 되돌려 에이전트가 이어서 작업하게 한다(설계 328줄).
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

    // ---------- 검증 확정 ----------

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
        // 검증 완료 뒤 이슈 노트 intent를 코어가 한 번만 적용한다(설계 76-78줄).
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

    // ---------- 복구 ----------

    /// 수정 계속: 현재 통합 HEAD에서 repair lane을 만든다(설계 423-424줄).
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
        // 현재 통합 HEAD에서 worktree+branch 생성(설계 423줄).
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

    /// 변경 제거 — 사람의 행위 자체가 승인이다(설계 428줄).
    pub fn revert_candidate(&self, candidate_id: &str) -> Result<AttemptPhase, String> {
        let candidate = self
            .store
            .get_change_set(candidate_id)?
            .ok_or("후보가 없다")?;
        let session = self
            .store
            .get_session(&candidate.session_id)?
            .ok_or("세션이 없다")?;
        let profile = VerifyProfile::default(); // revert 뒤 smoke는 기본 프로필로.
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

    // ---------- 종료 ----------

    /// direct 모드의 finalized: 모든 후보가 종결 상태인지 확인하고 lease를 푼다(설계 139-141줄).
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

    // ---------- 조회 ----------

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

/// autoAfterPreflight 정책의 자동 허가(설계 240-242줄). 사전검사 통과 후보만
/// policy authorization으로 큐에 넣는다. semantic overlap 후보는 자동 허가에서
/// 제외한다 — 재승인과 수동 smoke가 필요한 위험 경로다(설계 398-402줄).
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
        // preflight: 대표 체크아웃이 안전하고 후보 base가 현재 HEAD의 조상이어야 한다.
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
            _ => continue, // 뒤처진 후보는 재검토 대상
        }
        // 정상 baseline: 현재 HEAD에서 검증 프로필이 성공해야 한다.
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
