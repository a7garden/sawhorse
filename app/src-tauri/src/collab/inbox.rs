// Candidate file inbox. Design lines 200-232 and 819-820.
//
// An agent writes exactly one JSON file into `~/.sawhorse/collab/inbox/changesets/`
// (single-writer rule, same as the file inbox pattern in tasks.rs). This module validates the file,
// re-verifies the Git objects, normalizes the candidate into the ledger (SQLite), and moves the file to processed/rejected.
// Only the ledger holds the canonical candidate record — the inbox file is just a request.

use super::git;
use super::model::*;
use super::store::Store;
use super::{inbox_dir, inbox_done_dir, inbox_rejected_dir, new_id, now_ts};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Result of processing one inbox entry.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxReport {
    pub file: String,
    pub accepted: bool,
    pub candidate_id: String,
    pub reason: String,
}

/// Check results submitted by the agent. Kept for reference only; never used for the acceptance decision.
fn note_checks(checks: &[ProposedCheck]) -> String {
    checks
        .iter()
        .map(|c| format!("{}: {}", c.name, c.status))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Process every pending file in the inbox. Called by both the worker and the command.
/// Files may still be mid-write, so a 2-second mtime stability guard applies (same as tasks.rs).
pub fn process_inbox(store: &Store) -> Result<Vec<InboxReport>, String> {
    let dir = inbox_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return Ok(vec![]);
    }
    let mut reports = Vec::new();
    let mut entries: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    entries.sort();
    for path in entries {
        // 2-second mtime guard: files changed recently are re-examined on the next tick.
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(modified) = meta.modified() {
                if modified.elapsed().map(|e| e.as_secs() < 2).unwrap_or(true) {
                    continue;
                }
            }
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        match handle_file(store, &path) {
            Ok(candidate_id) => {
                let done = inbox_done_dir().join(&name);
                std::fs::create_dir_all(inbox_done_dir()).ok();
                if move_file(&path, &done).is_err() {
                    return Err(format!("인박스 파일 이동 실패: {name}"));
                }
                reports.push(InboxReport {
                    file: name,
                    accepted: true,
                    candidate_id,
                    reason: String::new(),
                });
            }
            Err(reason) => {
                let rejected = inbox_rejected_dir().join(&name);
                std::fs::create_dir_all(inbox_rejected_dir()).ok();
                // Leave the rejection reason as a sidecar file so the agent can learn the cause.
                let _ = std::fs::write(
                    inbox_rejected_dir().join(format!("{name}.reason.txt")),
                    &reason,
                );
                let _ = move_file(&path, &rejected);
                reports.push(InboxReport {
                    file: name,
                    accepted: false,
                    candidate_id: String::new(),
                    reason,
                });
            }
        }
    }
    Ok(reports)
}

fn handle_file(store: &Store, path: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("파일 읽기 실패: {e}"))?;
    let req: ProposeRequest =
        serde_json::from_str(&raw).map_err(|e| format!("JSON 해석 실패: {e}"))?;
    validate_request(store, &req)
}

/// If schema, session, and Git validation pass, create the candidate in the ledger and return its ID.
/// The core does not trust agent input; it re-verifies the repository identity and Git objects (design lines 218-229).
pub fn validate_request(store: &Store, req: &ProposeRequest) -> Result<String, String> {
    if req.op != "propose" {
        return Err(format!("지원하지 않는 op: {}", req.op));
    }
    if req.session_id.is_empty() || req.source_sha.is_empty() || req.base_sha.is_empty() {
        return Err("sessionId·baseSha·sourceSha는 필수다".into());
    }
    let session = store
        .get_session(&req.session_id)?
        .ok_or_else(|| format!("세션이 없다: {}", req.session_id))?;
    if session.status != SessionStatus::Active {
        return Err(format!(
            "세션이 활성 상태가 아니다: {}",
            session.status.as_str()
        ));
    }
    let repo = PathBuf::from(&session.integration_path);

    // Repository identity: whether the submitted worktree belongs to the session's repository.
    let worktree = PathBuf::from(&req.worktree);
    if !worktree.is_dir() {
        return Err(format!("worktree 경로가 없다: {}", req.worktree));
    }
    let identity = git::repo_identity(&worktree)?;
    let session_identity = git::repo_identity(&repo)?;
    if identity.git_common_dir != session_identity.git_common_dir {
        return Err("제출 worktree가 세션의 Git 저장소와 다르다 (같은 common object database만 입력으로 받는다)".into());
    }

    // Unabbreviated commit objects, plus base must be an ancestor of source.
    let base = git::resolve_commit(&repo, &req.base_sha)?;
    let source = git::resolve_commit(&repo, &req.source_sha)?;
    if !git::is_ancestor(&repo, &base, &source)? {
        return Err("baseSha가 sourceSha의 조상이 아니다".into());
    }

    // Whether base is an ancestor of the current integration HEAD (marks a stale candidate).
    let head = git::head_info(&repo)?;
    let base_is_current_ancestor = if head.head.is_empty() {
        false
    } else {
        git::is_ancestor(&repo, &base, &head.head)?
    };

    // Ranges containing merge commits are rejected by default (design line 227).
    if git::contains_merge_commit(&repo, &base, &source)? {
        return Err("base..source에 merge commit이 포함되어 있다 — 기본 정책은 거부다".into());
    }

    // Recompute the exact manifest — path and blob info sent by the agent is ignored (design lines 219-220).
    let (entries, manifest_json) = git::compute_manifest(&repo, &base, &source)?;
    if entries.is_empty() {
        return Err("변경이 비어 있다 (base == source)".into());
    }

    // Pre-check for risky content (design line 229).
    let risks = git::assess_manifest_risks(&repo, &entries)?;
    let blob_risks = git::assess_blob_risks(&repo, &entries)?;
    let mut blocked = Vec::new();
    blocked.extend(risks.submodules.iter().map(|p| format!("submodule: {p}")));
    blocked.extend(
        risks
            .case_renames
            .iter()
            .map(|p| format!("case-only rename: {p}")),
    );
    blocked.extend(
        blob_risks
            .lfs_pointers
            .iter()
            .map(|p| format!("LFS pointer: {p}")),
    );
    blocked.extend(
        blob_risks
            .oversized
            .iter()
            .map(|p| format!("8MB 초과: {p}")),
    );
    if !blocked.is_empty() {
        return Err(format!(
            "안전 자동 적용을 보장할 수 없다: {}",
            blocked.join(", ")
        ));
    }
    let collisions = git::untracked_collisions(&repo, &entries)?;
    if !collisions.is_empty() {
        return Err(format!("untracked 파일과 충돌: {}", collisions.join(", ")));
    }

    // Dependency validation: not bare IDs but an approved candidate digest or verified merge SHA (design lines 229-230).
    validate_dependencies(store, &req.depends_on)?;

    // Grab the protected ref first so Git objects cannot vanish during review (design lines 194-198).
    let candidate_id = new_id("c");
    git::create_protected_ref(&repo, &candidate_id, &source)?;

    let base_tree = tree_of(&repo, &base)?;
    let source_tree = tree_of(&repo, &source)?;
    let dependency_json = serde_json::to_string(&req.depends_on).unwrap_or_else(|_| "[]".into());
    let verification_plan_hash = verification_plan_hash(&session);
    // note 인텐트도 승인 digest에 묶는다 — 인텐트 내용이 다르면 digest가 달라져 재승인이 필요하다.
    let note_intents_json = serde_json::to_string(&req.note_intents).unwrap_or_else(|_| "[]".into());
    let digest = {
        let base_digest = digest_payload(
            &base,
            &source,
            &base_tree,
            &source_tree,
            &manifest_json,
            &dependency_json,
            &verification_plan_hash,
        );
        // digest_payload과 같은 규칙(길이 접두사)으로 base digest 뒤에 인텐트를 이어 붙인다.
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update((base_digest.len() as u64).to_le_bytes());
        h.update(base_digest.as_bytes());
        h.update((note_intents_json.len() as u64).to_le_bytes());
        h.update(note_intents_json.as_bytes());
        hex::encode(h.finalize())
    };

    let change_set = ChangeSet {
        id: candidate_id.clone(),
        session_id: session.id.clone(),
        task_id: req.task_id.clone(),
        repository_id: session_identity.repository_id(),
        base_sha: base,
        source_sha: source,
        base_tree_sha: base_tree,
        source_tree_sha: source_tree,
        manifest_json: manifest_json.clone(),
        dependency_json,
        verification_plan_hash,
        digest,
        // Stale candidates still need review, so keep them review_pending and flag stale in the view.
        status: ChangeSetStatus::ReviewPending,
        summary: req.summary.clone(),
        superseded_by: String::new(),
        remediated_by: String::new(),
        created_at: now_ts(),
        updated_at: now_ts(),
    };
    store.insert_change_set(&change_set, &req.depends_on)?;

    // Issue note change intents are applied exactly once by the core via the file WAL after approval (design lines 76-78).
    for intent in &req.note_intents {
        store_note_intent(store, &change_set.id, intent)?;
    }

    // Submitted check results are stored only as a summary — never used for the acceptance decision.
    let checks_note = note_checks(&req.checks);
    if !checks_note.is_empty() {
        store.insert_audit_event(&AuditEvent {
            id: new_id("e"),
            kind: "changeset.proposed.checks".into(),
            project_id: session.project_id.clone(),
            session_id: session.id.clone(),
            payload_json: serde_json::json!({
                "candidateId": change_set.id,
                "agent": req.agent,
                "checks": checks_note,
                "baseIsStale": !base_is_current_ancestor,
            })
            .to_string(),
            created_at: now_ts(),
        })?;
    }
    Ok(candidate_id)
}

/// Verify each dependency is a candidate digest or a verified merge SHA.
pub fn validate_dependencies(store: &Store, depends_on: &[String]) -> Result<(), String> {
    for dep in depends_on {
        let as_digest = store
            .pending_change_sets()?
            .iter()
            .any(|c| &c.digest == dep)
            || store_unverified_ok(store, dep)?;
        if !as_digest {
            return Err(format!(
                "의존성 '{dep}'는 승인된 candidate digest나 verified merge SHA가 아니다"
            ));
        }
    }
    Ok(())
}

fn store_unverified_ok(_store: &Store, _dep: &str) -> Result<bool, String> {
    // A dependency in merge SHA form is verified against the merge_sha of verified/reverted attempts in integration_attempt.
    // digest matching in pending_change_sets is the first filter; here the merge SHA's existence is looked up in the ledger.
    Ok(false) // phase 1 supports digest matching only: the store API has no global list_attempts query
}

fn store_note_intent(store: &Store, candidate_id: &str, intent: &NoteIntent) -> Result<(), String> {
    // The intent is stored as a staged inbound_change. Once the candidate is verified, apply_note_intents
    // applies it exactly once via the file WAL procedure (design lines 76-78 and 566-571).
    store.insert_audit_event(&AuditEvent {
        id: new_id("e"),
        kind: "changeset.note_intent".into(),
        project_id: String::new(),
        session_id: String::new(),
        payload_json: serde_json::json!({
            "candidateId": candidate_id,
            "notePath": intent.note_path,
            "field": intent.field,
            "expectedLocalHash": intent.expected_local_hash,
        })
        .to_string(),
        created_at: now_ts(),
    })?;
    store.insert_inbound_change(
        &new_id("ni"),
        candidate_id,
        "note_intent",
        &intent.field,
        &serde_json::json!({
            "value": intent.value,
            "expectedLocalHash": intent.expected_local_hash,
        })
        .to_string(),
        &intent.note_path,
    )?;
    Ok(())
}

/// Apply note intents after the candidate is verified. Rejects when the expected hash differs —
/// optimistic hash + file WAL (design lines 566-571). Returns the number of successful applications.
pub fn apply_note_intents(store: &Store, candidate_id: &str) -> Result<usize, String> {
    // 에이전트가 넣은 경로는 반드시 볼트 루트 안이어야 한다 — 임의 파일 읽기/rename 차단.
    let root = crate::sdlc::vault_root()?;
    let staged = store.list_inbound_changes("staged", 500)?;
    let mut applied = 0usize;
    for item in &staged {
        if item["linkId"] != serde_json::json!(candidate_id) {
            continue;
        }
        if item["sourceInstance"] != serde_json::json!("note_intent") {
            continue;
        }
        let payload: serde_json::Value =
            serde_json::from_str(item["payload"].as_str().unwrap_or("{}"))
                .map_err(|e| format!("intent payload 해석 실패: {e}"))?;
        let note_path = item["targetPath"].as_str().unwrap_or("").to_string();
        let field = item["externalId"].as_str().unwrap_or("").to_string();
        let value = payload["value"].as_str().unwrap_or("").to_string();
        let expected = payload["expectedLocalHash"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let target = std::path::PathBuf::from(&note_path);
        crate::workspace_io::check_path(&root, &target)?;
        let current = std::fs::read_to_string(&target).unwrap_or_default();
        let current_hash = {
            use sha2::{Digest, Sha256};
            let mut h = Sha256::new();
            h.update(current.as_bytes());
            hex::encode(h.finalize())
        };
        if !expected.is_empty() && expected != current_hash {
            store.set_inbound_state(item["id"].as_str().unwrap_or(""), "conflict")?;
            continue;
        }
        let updated =
            crate::extensions::github::update_frontmatter_field(&current, &field, &value)?;
        // The file WAL procedure cannot reuse extensions::github's internal function,
        // so perform the same procedure here: prepared -> write -> applied.
        let wal_id = store.file_wal_prepare(&note_path, &current_hash, "")?;
        let tmp = target.with_extension(format!("intent-{}", &wal_id[..8.min(wal_id.len())]));
        std::fs::write(&tmp, &updated).map_err(|e| format!("임시 파일 쓰기 실패: {e}"))?;
        std::fs::rename(&tmp, &target).map_err(|e| format!("원자적 rename 실패: {e}"))?;
        store.file_wal_finish(&wal_id, true, "")?;
        store.set_inbound_state(item["id"].as_str().unwrap_or(""), "applied")?;
        applied += 1;
    }
    Ok(applied)
}

/// Content hash of the session's verification profile. Changing the profile invalidates existing approvals.
pub fn verification_plan_hash(session: &Session) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(session.verification_profile.as_bytes());
    h.update(session.integration_branch.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

fn tree_of(repo: &Path, rev: &str) -> Result<String, String> {
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

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| format!("이동 실패: {e}"))
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

    struct TempRepo(PathBuf);
    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Main checkout + an agent worktree in the same repository + a propose request valid for the session.
    fn setup(tag: &str) -> (TempRepo, std::sync::Arc<Store>, ProposeRequest) {
        let main_dir =
            std::env::temp_dir().join(format!("sawhorse-inbox-{}-{tag}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&main_dir).unwrap();
        run(&main_dir, &["init", "-q", "-b", "main"]);
        run(&main_dir, &["config", "user.email", "t@example.com"]);
        run(&main_dir, &["config", "user.name", "t"]);
        std::fs::write(main_dir.join("base.txt"), "base").unwrap();
        run(&main_dir, &["add", "."]);
        run(&main_dir, &["commit", "-q", "-m", "init"]);
        let base = run(&main_dir, &["rev-parse", "HEAD"]).trim().to_string();

        let wt = main_dir
            .parent()
            .unwrap()
            .join(format!("{}-wt-{tag}", uuid::Uuid::new_v4()));
        run(
            &main_dir,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "sawhorse/agent/t1",
                wt.to_str().unwrap(),
            ],
        );
        std::fs::write(wt.join("feat.txt"), "v1").unwrap();
        run(&wt, &["add", "."]);
        run(&wt, &["commit", "-q", "-m", "agent work"]);
        let source = run(&wt, &["rev-parse", "HEAD"]).trim().to_string();

        let db = std::env::temp_dir().join(format!(
            "sawhorse-inbox-db-{}-{tag}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let store = Store::open_at(db).unwrap();
        let identity = git::repo_identity(&main_dir).unwrap();
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
            goal: "테스트".into(),
            status: SessionStatus::Active,
            mode: SessionMode::Direct,
            integration_path: main_dir.to_string_lossy().to_string(),
            integration_branch: "main".into(),
            target_start_sha: base.clone(),
            policy_version: 1,
            verification_profile: "test".into(),
            created_at: now_ts(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        };
        store.insert_session(&session).unwrap();

        let req = ProposeRequest {
            op: "propose".into(),
            session_id: session.id,
            task_id: "lane-1".into(),
            agent: "claude-code".into(),
            worktree: wt.to_string_lossy().to_string(),
            base_sha: base,
            source_sha: source,
            summary: "feat.txt 추가".into(),
            checks: vec![ProposedCheck {
                name: "typecheck".into(),
                status: "passed".into(),
                log_ref: String::new(),
            }],
            depends_on: vec![],
            note_intents: vec![],
        };
        (TempRepo(main_dir), store, req)
    }

    #[test]
    fn valid_proposal_creates_review_pending_candidate() {
        let (_t, store, req) = setup("valid");
        let candidate_id = validate_request(&store, &req).unwrap();
        let cs = store.get_change_set(&candidate_id).unwrap().unwrap();
        assert_eq!(cs.status, ChangeSetStatus::ReviewPending);
        assert!(!cs.digest.is_empty());
        assert!(
            cs.manifest_json.contains("feat.txt"),
            "manifest에 feat.txt가 있다"
        );
        let session = store.get_session(&req.session_id).unwrap().unwrap();
        let ref_sha = git::protected_ref_sha(Path::new(&session.integration_path), &candidate_id)
            .unwrap()
            .unwrap();
        assert_eq!(ref_sha, cs.source_sha);
    }

    #[test]
    fn rejects_abbreviated_or_missing_sha() {
        let (_t, store, mut req) = setup("badsha");
        req.base_sha = "0".repeat(40);
        assert!(
            validate_request(&store, &req).is_err(),
            "없는 SHA는 거부된다"
        );
        req.base_sha = req.source_sha[..8].to_string();
        assert!(validate_request(&store, &req).unwrap_err().contains("축약"));
    }

    #[test]
    fn rejects_base_not_ancestor_of_source() {
        let (_t, store, mut req) = setup("nonancestry");
        std::mem::swap(&mut req.base_sha, &mut req.source_sha);
        assert!(validate_request(&store, &req)
            .unwrap_err()
            .contains("조상이 아니다"));
    }

    #[test]
    fn rejects_finalized_session() {
        let (_t, store, req) = setup("finalized");
        store
            .update_session_status(&req.session_id, SessionStatus::Finalized, "")
            .unwrap();
        assert!(validate_request(&store, &req)
            .unwrap_err()
            .contains("활성 상태가 아니다"));
    }

    #[test]
    fn rejects_unknown_dependency() {
        let (_t, store, mut req) = setup("baddep");
        req.depends_on = vec!["nonexistent-digest".into()];
        assert!(validate_request(&store, &req)
            .unwrap_err()
            .contains("의존성"));
    }

    #[test]
    fn process_inbox_moves_accepted_and_rejected() {
        let (_t, store, req) = setup("process");
        std::fs::create_dir_all(inbox_dir()).unwrap();
        let good = inbox_dir().join("good.json");
        std::fs::write(&good, serde_json::to_string(&req).unwrap()).unwrap();
        let mut bad = req.clone();
        bad.op = "explode".into();
        let bad_path = inbox_dir().join("bad.json");
        std::fs::write(&bad_path, serde_json::to_string(&bad).unwrap()).unwrap();
        let old = filetime::FileTime::from_unix_time(0, 0);
        filetime::set_file_mtime(&good, old).unwrap();
        filetime::set_file_mtime(&bad_path, old).unwrap();

        let reports = process_inbox(&store).unwrap();
        assert_eq!(reports.len(), 2);
        assert!(reports.iter().any(|r| r.file == "good.json" && r.accepted));
        assert!(reports.iter().any(|r| r.file == "bad.json" && !r.accepted));
        assert!(!good.exists(), "수용 파일은 processed로 이동");
        assert!(!bad_path.exists(), "거부 파일은 rejected로 이동");
        assert!(
            inbox_rejected_dir().join("bad.json.reason.txt").exists(),
            "거부 사유 사이드카"
        );
    }

    #[test]
    fn note_intents_are_bound_into_the_approval_digest() {
        let (_t, store, mut req) = setup("digest-intent");
        let d1 = store
            .get_change_set(&validate_request(&store, &req).unwrap())
            .unwrap()
            .unwrap()
            .digest;
        req.note_intents = vec![NoteIntent {
            note_path: "프로젝트/x/이슈.md".into(),
            field: "status".into(),
            value: "done".into(),
            ..Default::default()
        }];
        let d2 = store
            .get_change_set(&validate_request(&store, &req).unwrap())
            .unwrap()
            .unwrap()
            .digest;
        assert_ne!(d1, d2, "인텐트가 있으면 digest가 달라야 한다");
        req.note_intents[0].value = "review".into();
        let d3 = store
            .get_change_set(&validate_request(&store, &req).unwrap())
            .unwrap()
            .unwrap()
            .digest;
        assert_ne!(d2, d3, "인텐트 내용이 다르면 digest가 달라야 한다");
    }

    #[test]
    fn note_intent_outside_vault_is_rejected() {
        let (_t, store, _req) = setup("intent-escape");
        let payload = serde_json::json!({
            "value": "x",
            "expectedLocalHash": "",
        })
        .to_string();
        let escape = std::env::temp_dir().join("sawhorse-escape-note.md");
        let _ = std::fs::remove_file(&escape);
        store
            .insert_inbound_change(
                &new_id("ni"),
                "c-escape",
                "note_intent",
                "status",
                &payload,
                &escape.to_string_lossy(),
            )
            .unwrap();
        assert!(
            apply_note_intents(&store, "c-escape").is_err(),
            "볼트 밖 경로 인텐트는 거부되어야 한다"
        );
        assert!(!escape.exists(), "볼트 밖 파일이 만들어지면 안 된다");
    }
}
