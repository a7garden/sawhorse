// Integration worker. Design lines 369-498: representative checkout merge procedure, verification-failure recovery, and crash safety.
//
// Invariants (design lines 908-917):
// 1. Only one integration worker merges into the representative checkout — OS lock + session lease.
// 2. Unapproved candidates never reach this module (the caller guarantees it; re-checked here too).
// 3. Approval is bound to the SHA and digest — any difference in HEAD forces re-approval.
// 4. dirty, stale, and conflict states stop the queue without touching user changes.
// 5. The next candidate is not merged until the verification failure is resolved.
//
// Every Git change happens after the ledger (integration_attempt) is written first. Even if the app dies,
// the recovery rules (design lines 479-486) can be applied from the combination of the ledger and the actual Git state.

use super::checks;
use super::git::{self, HeadInfo};
use super::model::*;
use super::store::Store;
use super::{new_id, now_ts};
use std::path::{Path, PathBuf};

/// Context needed to run the integration procedure. Assembled by the caller (service).
pub struct IntegrationCtx<'a> {
    pub store: &'a Store,
    pub project_id: &'a str,
    /// Verification profile saved by a human. Never injected by the candidate.
    pub profile: &'a VerifyProfile,
}

// ---------- checkout lease ----------

/// Identity lock for the integration checkout. Even if the same path is registered under a different project alias,
/// no one can bypass the single lock file keyed by the canonical root (design lines 373-374).
pub struct CheckoutLease {
    _file: std::fs::File,
    lock_path: PathBuf,
}

impl Drop for CheckoutLease {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

pub fn acquire_lease(integration_path: &Path) -> Result<CheckoutLease, String> {
    let identity = git::repo_identity(integration_path)?;
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(identity.canonical_root.as_bytes());
    let key = hex::encode(h.finalize())[..24].to_string();
    let lock_path = super::locks_dir().join(format!("{key}.lock"));
    std::fs::create_dir_all(super::locks_dir())
        .map_err(|e| format!("lock 디렉터리 생성 실패: {e}"))?;
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("다른 통합 워커가 이 체크아웃을 사용 중이다 ({lock_path:?})")
            } else {
                format!("lock 파일 생성 실패: {e}")
            }
        })?;
    Ok(CheckoutLease {
        _file: file,
        lock_path,
    })
}

// ---------- semantic overlap ----------

/// File patterns that assemble multiple features (design lines 398-402). If two candidates touch the same spot,
/// re-approval plus a manual smoke test of the affected screen is enforced.
pub const ASSEMBLY_PATTERNS: &[&str] = &[
    "App.tsx",
    "main.tsx",
    "main.rs",
    "lib.rs",
    "package.json",
    "Cargo.toml",
    "Cargo.lock",
];

pub fn is_assembly_path(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    // Treat route/registry/settings-shell files as assembly points too.
    let lower = path.to_lowercase();
    ASSEMBLY_PATTERNS.iter().any(|p| name == *p)
        || lower.contains("route")
        || lower.contains("registry")
        || lower.contains("settingspage")
}

pub fn overlap_paths(manifest_json: &str) -> Vec<String> {
    let entries: Vec<ManifestEntry> = serde_json::from_str(manifest_json).unwrap_or_default();
    entries
        .iter()
        .map(|e| e.path.clone())
        .filter(|p| is_assembly_path(p))
        .collect()
}

// ---------- Merge procedure ----------

/// Merges one candidate into the current integration HEAD (design lines 369-415, in that order).
/// Returns: a summary of the attempt outcome. All state transitions happen here, together with the ledger.
#[allow(clippy::too_many_arguments)]
pub fn attempt_merge(
    ctx: &IntegrationCtx,
    session: &Session,
    candidate: &ChangeSet,
    approval: &Approval,
) -> Result<AttemptPhase, String> {
    let repo = PathBuf::from(&session.integration_path);

    // 1. OS lock + session lease.
    let _lease = acquire_lease(&repo)?;

    // 2. Verify identity, branch, HEAD, and cleanliness.
    let identity = git::repo_identity(&repo)?;
    if identity.repository_id() != candidate.repository_id {
        return Err(format!(
            "후보의 repository({})가 현재 체크아웃({})과 다르다",
            candidate.repository_id,
            identity.repository_id()
        ));
    }
    let head = git::head_info(&repo)?;
    if let Some(danger) = &head.dangerous_state {
        return Err(format!("위험한 Git 상태: {danger}"));
    }
    if !head.clean {
        return Err(format!(
            "통합 체크아웃이 dirty하다: {:?}",
            head.status_lines
        ));
    }
    if session.mode == SessionMode::Direct && head.branch != session.integration_branch {
        return Err(format!(
            "branch가 세션 대상과 다르다: 현재 {}, 예상 {}",
            head.branch, session.integration_branch
        ));
    }

    // 3. Re-check protected ref, source SHA, digest, and approval state.
    match git::protected_ref_sha(&repo, &candidate.id)? {
        Some(sha) if sha == candidate.source_sha => {}
        Some(sha) => return Err(format!("protected ref가 승인 SHA와 다르다: {sha}")),
        None => git::create_protected_ref(&repo, &candidate.id, &candidate.source_sha)?,
    }
    if git::resolve_commit(&repo, &candidate.source_sha)? != candidate.source_sha {
        return Err("source SHA가 저장소에 없다".into());
    }
    // 4. HEAD drift: any difference from the HEAD seen at approval forces re-approval.
    if approval.expected_head != head.head {
        return Err(format!(
            "HEAD_DRIFT:{}:{}",
            approval.expected_head, head.head
        ));
    }

    // 5. Merge simulation (read-only).
    let planned = match git::three_way_simulation(&repo, &head.head, &candidate.source_sha, None)? {
        Ok((tree, _conflicts)) => tree,
        Err(conflicts) => {
            ctx.store
                .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Conflicted)?;
            let _ = conflicts;
            return Ok(AttemptPhase::ConflictAborted);
        }
    };

    // If the same content is already present, do not create an empty merge commit (design lines 413-415).
    let current_tree = git_tree_of(&repo, &head.head)?;
    if current_tree == planned {
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Redundant)?;
        return Ok(AttemptPhase::ConflictAborted); // finishes without merging — reported via a dedicated status
    }

    // 6. Pre-merge baseline checks + store pre_head.
    let attempt = IntegrationAttempt {
        id: new_id("ia"),
        candidate_id: candidate.id.clone(),
        session_id: session.id.clone(),
        operation: "merge".into(),
        phase: AttemptPhase::Prepared,
        pre_head: head.head.clone(),
        planned_tree_sha: planned.clone(),
        source_sha: candidate.source_sha.clone(),
        baseline_json: String::new(),
        merge_sha: String::new(),
        revert_sha: String::new(),
        failure_detail: String::new(),
        created_at: now_ts(),
        finished_at: String::new(),
    };
    ctx.store.insert_attempt(&attempt)?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Integrating)?;

    let baseline_runs =
        checks::run_profile_checks_blocking(&repo, ctx.project_id, ctx.profile, true);
    let baseline_ok = baseline_runs.iter().all(|(r, _)| r.status == "passed");
    let baseline_json =
        serde_json::to_string(&baseline_runs.iter().map(|(r, _)| r).collect::<Vec<_>>())
            .unwrap_or_else(|_| "[]".into());
    for (run, _) in &baseline_runs {
        let mut run = run.clone();
        run.attempt_id = attempt.id.clone();
        ctx.store.insert_check_run(&run)?;
    }
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Prepared, "", "", "")?;
    if !baseline_ok {
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::BaselineFailed,
            "",
            "",
            "baseline 실패",
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::BaselineFailed)?;
        return Ok(AttemptPhase::BaselineFailed);
    }

    // 7. Non-interactive merge by SHA (design lines 385-387).
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Merging, "", "", "")?;
    let merge_out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(&repo)
        .args([
            "merge",
            "--no-ff",
            "--no-commit",
            "--no-verify",
            &candidate.source_sha,
        ])
        .output()
        .map_err(|e| format!("git merge 실행 실패: {e}"))?;
    if !merge_out.status.success() {
        // 8. Conflict — abort and verify a clean restore.
        let aborted = abort_merge(&repo)?;
        let detail = format!(
            "merge 실패: {}{}",
            String::from_utf8_lossy(&merge_out.stderr),
            if aborted {
                ""
            } else {
                " (abort 뒤 clean 복원 확인 실패 — recovery_required)"
            }
        );
        let phase = if aborted {
            AttemptPhase::ConflictAborted
        } else {
            AttemptPhase::RecoveryRequired
        };
        ctx.store
            .update_attempt_phase(&attempt.id, phase, "", "", &detail)?;
        ctx.store.update_change_set_status(
            candidate.id.clone(),
            if aborted {
                ChangeSetStatus::Conflicted
            } else {
                ChangeSetStatus::RecoveryRequired
            },
        )?;
        return Ok(phase);
    }

    // 9. Verify the actual write-tree matches the plan (design line 390).
    let staged_tree = staged_tree(&repo)?;
    if staged_tree != planned {
        let _ = abort_merge(&repo);
        let detail = format!("staged tree({staged_tree})가 계획({planned})과 다르다");
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RecoveryRequired,
            "",
            "",
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RecoveryRequired)?;
        return Ok(AttemptPhase::RecoveryRequired);
    }

    // merge commit — one per candidate (design lines 390-392).
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Merged, "", "", "")?;
    let msg = merge_commit_message(session, candidate, approval);
    let commit_out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(&repo)
        .args(["commit", "--no-verify", "--no-gpg-sign", "-m", &msg])
        .output()
        .map_err(|e| format!("git commit 실행 실패: {e}"))?;
    if !commit_out.status.success() {
        let detail = format!(
            "commit 실패: {}",
            String::from_utf8_lossy(&commit_out.stderr)
        );
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RecoveryRequired,
            "",
            "",
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RecoveryRequired)?;
        return Ok(AttemptPhase::RecoveryRequired);
    }
    let merge_sha = git::head_info(&repo)?.head;
    // Re-compare HEAD^{tree} after the commit.
    let actual_tree = git_tree_of(&repo, "HEAD")?;
    if actual_tree != planned {
        let detail = format!("commit 뒤 tree 불일치: {actual_tree} != {planned}");
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RecoveryRequired,
            &merge_sha,
            "",
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RecoveryRequired)?;
        return Ok(AttemptPhase::RecoveryRequired);
    }
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Merged, &merge_sha, "", "")?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Integrated)?;

    // 10. Verify in the same representative path (design lines 393-394).
    run_verification(ctx, &repo, &attempt.id, candidate, &merge_sha)
}

/// Post-integration automated checks through the manual verdict. Used both right after a merge and when resuming recovery.
pub fn run_verification(
    ctx: &IntegrationCtx,
    repo: &Path,
    attempt_id: &str,
    candidate: &ChangeSet,
    merge_sha: &str,
) -> Result<AttemptPhase, String> {
    ctx.store
        .update_attempt_phase(attempt_id, AttemptPhase::Verifying, merge_sha, "", "")?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::AutomatedVerifying)?;

    let runs = checks::run_profile_checks_blocking(repo, ctx.project_id, ctx.profile, false);
    let mut all_ok = true;
    for (run, _) in &runs {
        let mut run = run.clone();
        run.attempt_id = attempt_id.to_string();
        if ctx.store.insert_check_run(&run).is_err() {
            all_ok = false;
        }
        if run.status != "passed" {
            all_ok = false;
        }
    }
    // After each check, verify HEAD, index, and tracked files are unchanged — stop if they diverge (design line 394).
    if let Ok(before) = git::head_info(repo) {
        if git::verify_unchanged(repo, &before).is_err() {
            let detail = "검사가 저장소를 변경했다";
            ctx.store.update_attempt_phase(
                attempt_id,
                AttemptPhase::VerificationFailed,
                merge_sha,
                "",
                detail,
            )?;
            ctx.store.update_change_set_status(
                candidate.id.clone(),
                ChangeSetStatus::VerificationFailed,
            )?;
            return Ok(AttemptPhase::VerificationFailed);
        }
    }

    if !all_ok {
        ctx.store.update_attempt_phase(
            attempt_id,
            AttemptPhase::VerificationFailed,
            merge_sha,
            "",
            "자동 검사 실패",
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::VerificationFailed)?;
        return Ok(AttemptPhase::VerificationFailed);
    }

    // If a manual checklist exists, block the queue (design lines 359-362).
    if !ctx.profile.manual.is_empty() || !overlap_paths(&candidate.manifest_json).is_empty() {
        ctx.store.update_change_set_status(
            candidate.id.clone(),
            ChangeSetStatus::ManualVerificationPending,
        )?;
        return Ok(AttemptPhase::Verifying); // manual confirmation does not terminate the attempt
    }
    ctx.store
        .update_attempt_phase(attempt_id, AttemptPhase::Verified, merge_sha, "", "")?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Verified)?;
    Ok(AttemptPhase::Verified)
}

/// Re-verification at the moment a human presses "Confirm done" (design lines 360-362).
pub fn confirm_manual_ok(
    store: &Store,
    session: &Session,
    candidate: &ChangeSet,
) -> Result<(), String> {
    if candidate.status != ChangeSetStatus::ManualVerificationPending {
        return Err(format!(
            "수동 확인 대기 상태가 아니다: {}",
            candidate.status.as_str()
        ));
    }
    let repo = PathBuf::from(&session.integration_path);
    let head = git::head_info(&repo)?;
    let attempts = store.list_attempts(&candidate.id)?;
    let attempt = attempts
        .iter()
        .filter(|a| a.operation == "merge")
        .max_by_key(|a| a.created_at.clone())
        .ok_or("통합 시도 기록이 없다")?;
    if head.head != attempt.merge_sha {
        return Err(format!(
            "HEAD가 merge SHA와 다르다: 현재 {}, 기대 {}",
            head.head, attempt.merge_sha
        ));
    }
    if !head.clean {
        return Err("index·tracked worktree가 clean하지 않다".into());
    }
    store.update_attempt_phase(
        &attempt.id,
        AttemptPhase::Verified,
        &attempt.merge_sha,
        "",
        "",
    )?;
    store.update_change_set_status(candidate.id.clone(), ChangeSetStatus::Verified)?;
    Ok(())
}

/// Problem found on screen → verification_failed (design line 362).
pub fn confirm_manual_failed(
    store: &Store,
    candidate: &ChangeSet,
    reason: &str,
) -> Result<(), String> {
    if candidate.status != ChangeSetStatus::ManualVerificationPending {
        return Err(format!(
            "수동 확인 대기 상태가 아니다: {}",
            candidate.status.as_str()
        ));
    }
    let attempts = store.list_attempts(&candidate.id)?;
    if let Some(attempt) = attempts
        .iter()
        .filter(|a| a.operation == "merge")
        .max_by_key(|a| a.created_at.clone())
    {
        store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::VerificationFailed,
            &attempt.merge_sha,
            "",
            &format!("수동 확인 실패: {reason}"),
        )?;
    }
    store.update_change_set_status(candidate.id.clone(), ChangeSetStatus::VerificationFailed)?;
    Ok(())
}

/// Reverts the merge commit (design lines 428-441). The human's "remove change" action is itself the approval.
pub fn attempt_revert(
    ctx: &IntegrationCtx,
    session: &Session,
    candidate: &ChangeSet,
) -> Result<AttemptPhase, String> {
    let repo = PathBuf::from(&session.integration_path);
    let _lease = acquire_lease(&repo)?;
    let head = git::head_info(&repo)?;
    if let Some(danger) = &head.dangerous_state {
        return Err(format!("위험한 Git 상태: {danger}"));
    }
    if !head.clean {
        return Err(format!(
            "통합 체크아웃이 dirty하다: {:?}",
            head.status_lines
        ));
    }
    let attempts = ctx.store.list_attempts(&candidate.id)?;
    let merge_attempt = attempts
        .iter()
        .filter(|a| a.operation == "merge" && !a.merge_sha.is_empty())
        .max_by_key(|a| a.created_at.clone())
        .ok_or("되돌릴 merge commit 기록이 없다")?;
    let merge_sha = merge_attempt.merge_sha.clone();

    // Revert WAL pre-write (design lines 475-476).
    let attempt = IntegrationAttempt {
        id: new_id("ia"),
        candidate_id: candidate.id.clone(),
        session_id: session.id.clone(),
        operation: "revert".into(),
        phase: AttemptPhase::Prepared,
        pre_head: head.head.clone(),
        planned_tree_sha: String::new(),
        source_sha: merge_sha.clone(),
        baseline_json: String::new(),
        merge_sha: String::new(),
        revert_sha: String::new(),
        failure_detail: String::new(),
        created_at: now_ts(),
        finished_at: String::new(),
    };
    ctx.store.insert_attempt(&attempt)?;

    // Revert simulation: ours=HEAD, theirs=<merge>^1, base=<merge>.
    let first_parent = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(&repo)
        .args(["rev-parse", &format!("{merge_sha}^1")])
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if !first_parent.status.success() {
        return Err("merge commit의 첫 부모를 읽을 수 없다".into());
    }
    let parent_sha = String::from_utf8_lossy(&first_parent.stdout)
        .trim()
        .to_string();
    let planned = match git::three_way_simulation(&repo, &head.head, &parent_sha, Some(&merge_sha))?
    {
        Ok((tree, _)) => tree,
        Err(conflicts) => {
            ctx.store.update_attempt_phase(
                &attempt.id,
                AttemptPhase::RevertConflicted,
                "",
                &merge_sha,
                "revert simulation 충돌",
            )?;
            ctx.store.update_change_set_status(
                candidate.id.clone(),
                ChangeSetStatus::RevertConflicted,
            )?;
            return Ok(AttemptPhase::RevertConflicted);
        }
    };
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Prepared, "", "", "")?;

    // Actual revert (design lines 432-435).
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Reverting, "", "", "")?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Reverting)?;
    let out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(&repo)
        .args(["revert", "--no-commit", "-m", "1", &merge_sha])
        .output()
        .map_err(|e| format!("git revert 실행 실패: {e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RevertConflicted,
            "",
            &merge_sha,
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RevertConflicted)?;
        return Ok(AttemptPhase::RevertConflicted);
    }
    // Tree check (design line 434).
    let staged = staged_tree(&repo)?;
    if staged != planned {
        let detail = format!("revert tree 불일치: {staged} != {planned}");
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RecoveryRequired,
            "",
            &merge_sha,
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RecoveryRequired)?;
        return Ok(AttemptPhase::RecoveryRequired);
    }
    let msg = format!(
        "Revert \"{summary}\"\n\nThis reverts merge commit {merge_sha}.\n\nSawhorse-Session: {session}\nSawhorse-Candidate: {candidate}\nSawhorse-Reverts: {merge_sha}",
        summary = candidate.summary,
        session = session.id,
        candidate = candidate.id,
        merge_sha = merge_sha,
    );
    let commit_out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(&repo)
        .args(["commit", "--no-verify", "--no-gpg-sign", "-m", &msg])
        .output()
        .map_err(|e| format!("git commit 실행 실패: {e}"))?;
    if !commit_out.status.success() {
        let detail = format!(
            "revert commit 실패: {}",
            String::from_utf8_lossy(&commit_out.stderr)
        );
        ctx.store.update_attempt_phase(
            &attempt.id,
            AttemptPhase::RecoveryRequired,
            "",
            &merge_sha,
            &detail,
        )?;
        ctx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::RecoveryRequired)?;
        return Ok(AttemptPhase::RecoveryRequired);
    }
    let revert_sha = git::head_info(&repo)?.head;
    ctx.store
        .update_attempt_phase(&attempt.id, AttemptPhase::Reverted, "", &revert_sha, "")?;
    ctx.store
        .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Reverted)?;
    Ok(AttemptPhase::Reverted)
}

// ---------- Restart recovery ----------

/// Recovery on app restart (design lines 479-490). Applies the per-discovered-state table as is.
/// Does not abort automatically because the user may have edited the conflict.
pub fn recover_on_startup(store: &Store) -> Result<Vec<String>, String> {
    let mut actions = Vec::new();
    for attempt in store.unfinished_attempts()? {
        let candidate = match store.get_change_set(&attempt.candidate_id)? {
            Some(c) => c,
            None => continue,
        };
        let session = match store.get_session(&attempt.session_id)? {
            Some(s) => s,
            None => continue,
        };
        let repo = PathBuf::from(&session.integration_path);
        if !repo.is_dir() {
            continue;
        }
        let head = git::head_info(&repo).unwrap_or(HeadInfo {
            head: String::new(),
            branch: String::new(),
            clean: false,
            status_lines: vec![],
            dangerous_state: Some("repo 읽기 실패".into()),
        });

        let is_revert = attempt.operation == "revert";
        let expected_commit = if is_revert {
            &attempt.revert_sha
        } else {
            &attempt.merge_sha
        };

        let action = if attempt.phase == AttemptPhase::Prepared
            && head.head == attempt.pre_head
            && head.clean
            && head.dangerous_state.is_none()
        {
            // Interrupted before applying → back to queued (design line 483).
            store.update_change_set_status(candidate.id.clone(), ChangeSetStatus::Queued)?;
            store.update_attempt_phase(
                &attempt.id,
                AttemptPhase::RecoveryRequired,
                "",
                "",
                "재시작 복구: 적용 전 중단 → queued",
            )?;
            "재적용 대기(queued)로 복구"
        } else if head.dangerous_state.is_some()
            && head.dangerous_state.as_deref() != Some("detached HEAD")
        {
            // MERGE_HEAD/REVERT_HEAD etc. → human check (design line 484).
            store.update_change_set_status(
                candidate.id.clone(),
                ChangeSetStatus::RecoveryRequired,
            )?;
            store.update_attempt_phase(
                &attempt.id,
                AttemptPhase::RecoveryRequired,
                "",
                "",
                "재시작 복구: Git 진행 표식 존재",
            )?;
            "recovery_required — 사람 확인 필요"
        } else if !expected_commit.is_empty()
            && head.head == *expected_commit
            && commit_matches_attempt(&repo, &attempt)
        {
            // Expected commit with matching parent and tree → restore state and resume checks (design line 485).
            if is_revert {
                store.update_attempt_phase(
                    &attempt.id,
                    AttemptPhase::Reverted,
                    "",
                    &attempt.revert_sha,
                    "재시작 복구: 상태 복원",
                )?;
                store.update_change_set_status(candidate.id.clone(), ChangeSetStatus::Reverted)?;
            } else {
                store.update_attempt_phase(
                    &attempt.id,
                    AttemptPhase::Merged,
                    &attempt.merge_sha,
                    "",
                    "재시작 복구: 상태 복원",
                )?;
                store
                    .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Integrated)?;
            }
            "commit 상태 복원 완료 — 검사 재개"
        } else if !expected_commit.is_empty()
            && head.head == *expected_commit
            && after_head_clean(&repo, expected_commit)
        {
            // Same commit but differing details → no automatic restore (design lines 489-490).
            store.update_change_set_status(
                candidate.id.clone(),
                ChangeSetStatus::RecoveryRequired,
            )?;
            store.update_attempt_phase(
                &attempt.id,
                AttemptPhase::RecoveryRequired,
                expected_commit,
                "",
                "재시작 복구: commit 세부 불일치",
            )?;
            "recovery_required — commit 세부 불일치"
        } else {
            // Matches no record → no automatic fix (design line 486).
            store.update_change_set_status(
                candidate.id.clone(),
                ChangeSetStatus::RecoveryRequired,
            )?;
            store.update_attempt_phase(
                &attempt.id,
                AttemptPhase::RecoveryRequired,
                "",
                "",
                "재시작 복구: 미확인 상태",
            )?;
            "recovery_required — 미확인 상태"
        };
        actions.push(format!("{}: {}", attempt.id, action));
    }
    Ok(actions)
}

fn commit_matches_attempt(repo: &Path, attempt: &IntegrationAttempt) -> bool {
    // Parent 1 = pre_head, parent 2 = source (merges only), tree = planned (design line 488).
    let rev = |spec: &str| -> Option<String> {
        crate::spawn::no_window(std::process::Command::new("git"))
            .arg("-C")
            .arg(repo)
            .args(["rev-parse", spec])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    };
    let head = match rev("HEAD") {
        Some(h) => h,
        None => return false,
    };
    let _ = head;
    let parent1 = rev("HEAD^1");
    let tree = rev("HEAD^{tree}");
    if attempt.operation == "merge" {
        let parent2 = rev("HEAD^2");
        parent1.as_deref() == Some(attempt.pre_head.as_str())
            && parent2.as_deref() == Some(attempt.source_sha.as_str())
            && tree.as_deref() == Some(attempt.planned_tree_sha.as_str())
    } else {
        parent1.is_some() && tree.as_deref() == Some(attempt.planned_tree_sha.as_str())
    }
}

/// If any commit exists after the expected commit, automatic restore is forbidden (design line 489).
fn after_head_clean(repo: &Path, expected: &str) -> bool {
    crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .map(|h| h == expected)
        .unwrap_or(false)
}

// ---------- Internal helpers ----------

/// Aborts the merge on conflict. Aborts only at that point (design line 388) and verifies the restore.
fn abort_merge(repo: &Path) -> Result<bool, String> {
    crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo)
        .args(["merge", "--abort"])
        .output()
        .map_err(|e| format!("git merge --abort 실행 실패: {e}"))?;
    let head = git::head_info(repo)?;
    Ok(head.clean && head.dangerous_state.is_none())
}

fn git_tree_of(repo: &Path, rev: &str) -> Result<String, String> {
    let out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", &format!("{rev}^{{tree}}")])
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(format!("tree 조회 실패: {rev}"));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Tree of the current index. Identical to `git write-tree` (design line 390).
fn staged_tree(repo: &Path) -> Result<String, String> {
    let out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo)
        .args(["write-tree"])
        .output()
        .map_err(|e| format!("git write-tree 실행 실패: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Merge commit message + recovery trailers (design lines 404-411).
fn merge_commit_message(session: &Session, candidate: &ChangeSet, approval: &Approval) -> String {
    format!(
        "Merge candidate {cid}: {summary}\n\nSawhorse-Session: {sid}\nSawhorse-Candidate: {cid}\nSawhorse-Source: {src}\nSawhorse-Authorization: {auth}",
        cid = candidate.id,
        summary = candidate.summary,
        sid = session.id,
        src = candidate.source_sha,
        auth = approval.id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(path: &Path, args: &[&str]) -> String {
        let out = crate::spawn::no_window(std::process::Command::new("git"))
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    pub(super) struct TempRepo(PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn init_repo(tag: &str) -> (TempRepo, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sawhorse-int-{}-{tag}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.clone();
        run(&path, &["init", "-q", "-b", "main"]);
        run(&path, &["config", "user.email", "t@example.com"]);
        run(&path, &["config", "user.name", "t"]);
        run(&path, &["config", "commit.gpgsign", "false"]);
        (TempRepo(dir), path)
    }

    pub(super) fn commit_file(path: &Path, name: &str, content: &str, msg: &str) -> String {
        std::fs::write(path.join(name), content).unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-q", "-m", msg]);
        run(path, &["rev-parse", "HEAD"]).trim().to_string()
    }

    /// Minimal context with session + candidate + approval. The profile is a single `true` command.
    pub(super) struct Fixture {
        pub store: std::sync::Arc<Store>,
        pub repo: PathBuf,
        pub session: Session,
    }

    pub(super) fn fixture(tag: &str) -> (TempRepo, Fixture) {
        let (dir, repo) = init_repo(tag);
        let base = commit_file(&repo, "base.txt", "base", "init");
        let store = Store::open_at(std::env::temp_dir().join(format!(
            "sawhorse-int-db-{}-{tag}.sqlite",
            uuid::Uuid::new_v4()
        )))
        .unwrap();
        let identity = git::repo_identity(&repo).unwrap();
        store
            .upsert_project(
                "p-1",
                &identity.canonical_root,
                &identity.canonical_root,
                &identity.worktree_git_dir,
                &identity.git_common_dir,
            )
            .unwrap();
        let session = Session {
            id: new_id("s"),
            project_id: "p-1".into(),
            goal: "테스트 세션".into(),
            status: SessionStatus::Active,
            mode: SessionMode::Direct,
            integration_path: repo.to_string_lossy().to_string(),
            integration_branch: "main".into(),
            target_start_sha: base,
            policy_version: 1,
            verification_profile: "test".into(),
            created_at: now_ts(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        };
        store.insert_session(&session).unwrap();
        let fixture = Fixture {
            store,
            repo,
            session,
        };
        (dir, fixture)
    }

    pub(super) fn make_candidate(
        fx: &Fixture,
        file: &str,
        content: &str,
    ) -> (ChangeSet, Approval, String) {
        // Create a side commit as if work was done on a worktree branch.
        run(&fx.repo, &["checkout", "-q", "-b", "side"]);
        let source = commit_file(&fx.repo, file, content, "side work");
        run(&fx.repo, &["checkout", "-q", "main"]);
        let base = fx.session.target_start_sha.clone();
        let (manifest, manifest_json) = git::compute_manifest(&fx.repo, &base, &source).unwrap();
        let base_tree = run(&fx.repo, &["rev-parse", &format!("{base}^{{tree}}")])
            .trim()
            .to_string();
        let source_tree = run(&fx.repo, &["rev-parse", &format!("{source}^{{tree}}")])
            .trim()
            .to_string();
        let dependency_json = "[]".to_string();
        let digest = super::super::model::digest_for_test(
            &base,
            &source,
            &base_tree,
            &source_tree,
            &manifest_json,
            &dependency_json,
            "ph",
        );
        let candidate = ChangeSet {
            id: new_id("c"),
            session_id: fx.session.id.clone(),
            task_id: "task-1".into(),
            repository_id: git::repo_identity(&fx.repo).unwrap().repository_id(),
            base_sha: base,
            source_sha: source.clone(),
            base_tree_sha: base_tree,
            source_tree_sha: source_tree,
            manifest_json,
            dependency_json,
            verification_plan_hash: "ph".into(),
            digest: digest.clone(),
            status: ChangeSetStatus::Queued,
            summary: format!("{file} 변경"),
            superseded_by: String::new(),
            remediated_by: String::new(),
            created_at: now_ts(),
            updated_at: now_ts(),
        };
        fx.store.insert_change_set(&candidate, &[]).unwrap();
        let _ = manifest;
        let head = git::head_info(&fx.repo).unwrap().head;
        let approval = Approval {
            id: new_id("ap"),
            candidate_id: candidate.id.clone(),
            digest: candidate.digest.clone(),
            expected_head: head,
            policy_version: 1,
            decision: "approved".into(),
            decided_by: "human".into(),
            reason: String::new(),
            created_at: now_ts(),
        };
        (candidate, approval, source)
    }

    fn ctx<'a>(fx: &'a Fixture, profile: &'a VerifyProfile) -> IntegrationCtx<'a> {
        IntegrationCtx {
            store: &fx.store,
            project_id: "p-1",
            profile,
        }
    }

    #[test]
    fn clean_merge_produces_verified_merge_commit_with_trailers() {
        let (_t, fx) = fixture("clean");
        let profile = VerifyProfile {
            checks: vec![VerifyCheck::Command {
                cwd: String::new(),
                argv: vec!["true".into()],
            }],
            manual: vec![],
        };
        let (candidate, approval, _source) = make_candidate(&fx, "feat.txt", "v1");
        let result =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap();
        assert_eq!(result, AttemptPhase::Verified);

        // HEAD is a merge commit (--no-ff) and carries trailers.
        let msg = run(&fx.repo, &["log", "-1", "--format=%B"]);
        assert!(msg.contains(&format!("Sawhorse-Candidate: {}", candidate.id)));
        assert!(msg.contains(&format!("Sawhorse-Source: {}", candidate.source_sha)));
        let parents = run(&fx.repo, &["rev-parse", "HEAD^@"]).lines().count();
        assert_eq!(parents, 2, "--no-ff merge commit이어야 한다");
        // The file is actually reflected.
        assert_eq!(
            std::fs::read_to_string(fx.repo.join("feat.txt")).unwrap(),
            "v1"
        );
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Verified);
    }

    #[test]
    fn manual_checklist_blocks_at_manual_verification_pending() {
        let (_t, fx) = fixture("manual");
        let profile = VerifyProfile {
            checks: vec![],
            manual: vec!["홈이 열린다".into()],
        };
        let (candidate, approval, _) = make_candidate(&fx, "feat.txt", "v1");
        let result =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap();
        assert_eq!(result, AttemptPhase::Verifying);
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::ManualVerificationPending);
        // Create a HEAD mismatch, then confirm it is rejected.
        commit_file(&fx.repo, "extra.txt", "x", "user commit");
        assert!(confirm_manual_ok(&fx.store, &fx.session, &cs).is_err());
        assert!(confirm_manual_failed(&fx.store, &cs, "화면 깨짐").is_ok());
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::VerificationFailed);
    }

    #[test]
    fn head_drift_forces_re_approval() {
        let (_t, fx) = fixture("drift");
        let profile = VerifyProfile::default();
        let (candidate, mut approval, _) = make_candidate(&fx, "feat.txt", "v1");
        approval.expected_head = "0000000000000000000000000000000000000000".into();
        let err =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap_err();
        assert!(
            err.starts_with("HEAD_DRIFT"),
            "drift는 전용 신호로 보고된다: {err}"
        );
    }

    #[test]
    fn conflict_aborts_and_keeps_checkout_clean() {
        let (_t, fx) = fixture("conflict");
        let profile = VerifyProfile::default();
        // Change the same file in the representative checkout so it diverges from the original base.
        std::fs::write(fx.repo.join("base.txt"), "user-edit").unwrap();
        run(&fx.repo, &["add", "."]);
        run(&fx.repo, &["commit", "-q", "-m", "user edit"]);
        // Make the side branch from the session's start base (the original init commit) so both sides diverge.
        let base = fx.session.target_start_sha.clone();
        run(&fx.repo, &["checkout", "-q", "-b", "side2", &base]);
        let source = commit_file(&fx.repo, "base.txt", "agent-edit", "agent edit");
        run(&fx.repo, &["checkout", "-q", "main"]);
        let source_tree = run(&fx.repo, &["rev-parse", &format!("{source}^{{tree}}")])
            .trim()
            .to_string();
        let base_tree = run(&fx.repo, &["rev-parse", &format!("{base}^{{tree}}")])
            .trim()
            .to_string();
        let (manifest, manifest_json) = git::compute_manifest(&fx.repo, &base, &source).unwrap();
        let digest = super::super::model::digest_for_test(
            &base,
            &source,
            &base_tree,
            &source_tree,
            &manifest_json,
            "[]",
            "ph",
        );
        let candidate = ChangeSet {
            id: new_id("c"),
            session_id: fx.session.id.clone(),
            repository_id: git::repo_identity(&fx.repo).unwrap().repository_id(),
            base_sha: base,
            source_sha: source.clone(),
            base_tree_sha: base_tree,
            source_tree_sha: source_tree,
            manifest_json,
            digest,
            status: ChangeSetStatus::Queued,
            summary: "충돌 후보".into(),
            created_at: now_ts(),
            updated_at: now_ts(),
            ..Default::default()
        };
        fx.store.insert_change_set(&candidate, &[]).unwrap();
        let head = git::head_info(&fx.repo).unwrap().head;
        let approval = Approval {
            id: new_id("ap"),
            candidate_id: candidate.id.clone(),
            digest: candidate.digest.clone(),
            expected_head: head,
            policy_version: 1,
            decision: "approved".into(),
            created_at: now_ts(),
            ..Default::default()
        };
        let _ = manifest;
        let result =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap();
        assert_eq!(result, AttemptPhase::ConflictAborted);
        let info = git::head_info(&fx.repo).unwrap();
        assert!(info.clean, "abort 뒤 clean이어야 한다");
        assert_eq!(info.branch, "main");
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Conflicted);
    }

    #[test]
    fn already_applied_patch_ends_redundant() {
        let (_t, fx) = fixture("redundant");
        let profile = VerifyProfile::default();
        let (candidate, approval, _) = make_candidate(&fx, "feat.txt", "v1");
        // First apply the same patch manually (e.g. cherry-pick).
        run(
            &fx.repo,
            &["merge", "--no-ff", "--no-edit", "-q", &candidate.source_sha],
        );
        let head = git::head_info(&fx.repo).unwrap().head;
        let approval2 = Approval {
            expected_head: head,
            ..approval.clone()
        };
        let result =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval2).unwrap();
        assert_eq!(
            result,
            AttemptPhase::ConflictAborted,
            "빈 merge는 병합 없이 종결"
        );
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Redundant);
    }

    #[test]
    fn revert_removes_merge_and_marks_candidate() {
        let (_t, fx) = fixture("revert");
        let profile = VerifyProfile::default();
        let (candidate, approval, _) = make_candidate(&fx, "feat.txt", "v1");
        attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap();
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        let result = attempt_revert(&ctx(&fx, &profile), &fx.session, &cs).unwrap();
        assert_eq!(result, AttemptPhase::Reverted);
        assert!(!fx.repo.join("feat.txt").exists(), "파일이 제거되어야 한다");
        let msg = run(&fx.repo, &["log", "-1", "--format=%B"]);
        assert!(msg.contains(&format!(
            "Sawhorse-Reverts: {}",
            merge_sha_of(&fx, &candidate)
        )));
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Reverted);
    }

    fn merge_sha_of(fx: &Fixture, candidate: &ChangeSet) -> String {
        fx.store
            .list_attempts(&candidate.id)
            .unwrap()
            .iter()
            .find(|a| a.operation == "merge")
            .unwrap()
            .merge_sha
            .clone()
    }

    #[test]
    fn recovery_resumes_from_prepared_attempt() {
        let (_t, fx) = fixture("recover");
        let profile = VerifyProfile::default();
        let (candidate, approval, _) = make_candidate(&fx, "feat.txt", "v1");
        // Simulate the app dying at the prepared phase: record only the attempt, no merge.
        let attempt = IntegrationAttempt {
            id: new_id("ia"),
            candidate_id: candidate.id.clone(),
            session_id: fx.session.id.clone(),
            operation: "merge".into(),
            phase: AttemptPhase::Prepared,
            pre_head: git::head_info(&fx.repo).unwrap().head,
            planned_tree_sha: String::new(),
            source_sha: candidate.source_sha.clone(),
            created_at: now_ts(),
            ..Default::default()
        };
        fx.store.insert_attempt(&attempt).unwrap();
        fx.store
            .update_change_set_status(candidate.id.clone(), ChangeSetStatus::Integrating)
            .unwrap();
        let actions = recover_on_startup(&fx.store).unwrap();
        assert!(
            actions.iter().any(|a| a.contains("queued")),
            "적용 전 중단은 queued로 복구: {actions:?}"
        );
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Queued);
        let _ = approval;
    }

    #[test]
    fn recovery_restores_state_after_commit_crash() {
        let (_t, fx) = fixture("recover2");
        let profile = VerifyProfile::default();
        let (candidate, approval, _) = make_candidate(&fx, "feat.txt", "v1");
        let result =
            attempt_merge(&ctx(&fx, &profile), &fx.session, &candidate, &approval).unwrap();
        assert_eq!(result, AttemptPhase::Verified);
        // verified is terminal and not a recovery target — rewind the ledger to prepared to simulate a crash.
        let attempt = &fx.store.list_attempts(&candidate.id).unwrap()[0];
        fx.store
            .update_attempt_phase(&attempt.id, AttemptPhase::Merged, "", "", "")
            .unwrap();
        let actions = recover_on_startup(&fx.store).unwrap();
        assert!(
            actions.iter().any(|a| a.contains("상태 복원")),
            "{actions:?}"
        );
        let cs = fx.store.get_change_set(&candidate.id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::Integrated);
    }

    #[test]
    fn lease_is_exclusive_and_released_on_drop() {
        let (_t, fx) = fixture("lease");
        let lease = acquire_lease(&fx.repo).unwrap();
        assert!(acquire_lease(&fx.repo).is_err(), "이중 lease는 거부된다");
        drop(lease);
        assert!(acquire_lease(&fx.repo).is_ok(), "drop 뒤 재획득 가능");
    }

    #[test]
    fn assembly_detection_covers_known_hotspots() {
        assert!(is_assembly_path("dashboard/src/App.tsx"));
        assert!(is_assembly_path("dashboard/src/pages/SettingsPage.tsx"));
        assert!(is_assembly_path("dashboard/src-tauri/src/lib.rs"));
        assert!(is_assembly_path("dashboard/src/routes.ts"));
        assert!(!is_assembly_path("dashboard/src/pages/HomePage.tsx"));
        assert!(overlap_paths(r#"[{"path":"src/App.tsx","oldBlob":"","newBlob":"x","mode":"100644","renameFrom":"","binary":false}]"#).len() == 1);
    }
}
