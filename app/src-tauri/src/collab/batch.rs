// Approved batch integration. Design lines 355-357 and 881.
//
// - approvedBatch mode: ties the approval to the whole batch digest. To be reproducible it must be
//   the ordered full-batch digest, not a single candidate's digest.
// - Removal is in reverse order: revert candidates starting from the last merged one.
// - Inside a batch it is perChange — one failure halts everything after it (invariant 5).

use crate::collab::model::{ChangeSet, ChangeSetStatus, Session};
use crate::collab::policy;
use crate::collab::store::Store;
use crate::collab::{new_id, now_ts};
use sha2::{Digest, Sha256};

/// Ordered batch digest. Binds candidate ids, digests, and the expected HEAD in order.
pub fn batch_digest(candidate_ids: &[String], digests: &[String], expected_head: &str) -> String {
    let mut h = Sha256::new();
    for (id, d) in candidate_ids.iter().zip(digests.iter()) {
        h.update((id.len() as u64).to_le_bytes());
        h.update(id.as_bytes());
        h.update((d.len() as u64).to_le_bytes());
        h.update(d.as_bytes());
    }
    h.update((expected_head.len() as u64).to_le_bytes());
    h.update(expected_head.as_bytes());
    hex::encode(h.finalize())[..32].to_string()
}

/// Batch approvability check: same session, review_pending or changes_requested, dependency order preserved.
pub fn validate_batch(
    store: &Store,
    session: &Session,
    candidates: &[ChangeSet],
) -> Result<(), String> {
    if candidates.is_empty() {
        return Err("빈 배치다".into());
    }
    for c in candidates {
        if c.session_id != session.id {
            return Err(format!("{} 후보가 다른 세션이다", c.id));
        }
        if !matches!(
            c.status,
            ChangeSetStatus::ReviewPending | ChangeSetStatus::ChangesRequested
        ) {
            return Err(format!(
                "{} 후보가 검토 대기 상태가 아니다: {}",
                c.id,
                c.status.as_str()
            ));
        }
    }
    // Dependencies: a depends_on candidate digest must appear earlier in the same batch or already be verified.
    let digest_index: std::collections::HashMap<&str, usize> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (c.digest.as_str(), i))
        .collect();
    let verified: std::collections::HashSet<String> = store
        .list_change_sets(&session.id)?
        .into_iter()
        .filter(|c| c.status == ChangeSetStatus::Verified)
        .map(|c| c.digest)
        .collect();
    for (i, c) in candidates.iter().enumerate() {
        for dep in store.change_set_depends_on(&c.id)? {
            let in_batch_ahead = digest_index
                .get(dep.as_str())
                .map(|j| *j < i)
                .unwrap_or(false);
            if !in_batch_ahead && !verified.contains(&dep) {
                return Err(format!(
                    "{} 후보의 의존성 {dep}은 같은 배치에서 앞서거나 이미 verified여야 한다",
                    c.id
                ));
            }
        }
    }
    Ok(())
}

/// Approve a batch. Records a human approval per candidate and moves them all to queued.
/// The full batch digest is recorded in the audit event (design lines 356-357).
pub fn approve_batch(
    store: &Store,
    session: &Session,
    candidates: &[ChangeSet],
    expected_head: &str,
    decided_by: &str,
) -> Result<String, String> {
    validate_batch(store, session, candidates)?;
    let ids: Vec<String> = candidates.iter().map(|c| c.id.clone()).collect();
    let digests: Vec<String> = candidates.iter().map(|c| c.digest.clone()).collect();
    let digest = batch_digest(&ids, &digests, expected_head);
    for c in candidates {
        policy::record_human_approval(store, c, expected_head, session.policy_version, decided_by)?;
        store.update_change_set_status(&c.id, ChangeSetStatus::Queued)?;
    }
    store.insert_audit_event(&crate::collab::model::AuditEvent {
        id: new_id("e"),
        kind: "approval.batch".into(),
        project_id: session.project_id.clone(),
        session_id: session.id.clone(),
        payload_json: serde_json::json!({
            "batchDigest": digest,
            "candidates": ids,
            "expectedHead": expected_head,
            "decidedBy": decided_by,
            "createdAt": now_ts(),
        })
        .to_string(),
        created_at: now_ts(),
    })?;
    Ok(digest)
}

/// Batch removal order: starting from the last merged candidate (reverse).
pub fn revert_order(candidate_ids: &[String]) -> Vec<String> {
    candidate_ids.iter().rev().cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> std::sync::Arc<Store> {
        let dir = std::env::temp_dir().join(format!("sawhorse-batch-{}", uuid::Uuid::new_v4()));
        Store::open_at(dir.join("wb.sqlite")).unwrap()
    }

    fn session(id: &str) -> Session {
        Session {
            id: id.into(),
            project_id: "p-1".into(),
            goal: "배치".into(),
            status: crate::collab::model::SessionStatus::Active,
            mode: crate::collab::model::SessionMode::Direct,
            integration_path: "/tmp/x".into(),
            integration_branch: "main".into(),
            target_start_sha: "aaa".into(),
            policy_version: 1,
            verification_profile: "test".into(),
            created_at: now_ts(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        }
    }

    fn candidate(
        store: &std::sync::Arc<Store>,
        session_id: &str,
        digest: &str,
        deps: &[String],
    ) -> ChangeSet {
        let c = ChangeSet {
            id: new_id("c"),
            session_id: session_id.into(),
            digest: digest.into(),
            status: ChangeSetStatus::ReviewPending,
            created_at: now_ts(),
            updated_at: now_ts(),
            ..Default::default()
        };
        store.insert_change_set(&c, deps).unwrap();
        c
    }

    #[test]
    fn batch_digest_is_order_sensitive() {
        let a = batch_digest(
            &["c1".into(), "c2".into()],
            &["d1".into(), "d2".into()],
            "head",
        );
        let b = batch_digest(
            &["c2".into(), "c1".into()],
            &["d2".into(), "d1".into()],
            "head",
        );
        let c = batch_digest(
            &["c1".into(), "c2".into()],
            &["d1".into(), "d2".into()],
            "head2",
        );
        assert_ne!(a, b, "순서가 바뀌면 digest가 다르다");
        assert_ne!(a, c, "HEAD가 다르면 digest가 다르다");
    }

    #[test]
    fn batch_approval_queues_all_with_batch_audit() {
        let store = temp_store();
        store
            .upsert_project("p-1", "/x", "/x", "/x/.git", "/x/.git")
            .unwrap();
        let s = session("s-1");
        store.insert_session(&s).unwrap();
        let c1 = candidate(&store, "s-1", "d1", &[]);
        let c2 = candidate(&store, "s-1", "d2", &["d1".into()]);
        let digest =
            approve_batch(&store, &s, &[c1.clone(), c2.clone()], "head1", "human").unwrap();
        assert!(!digest.is_empty());
        assert_eq!(
            store.get_change_set(&c1.id).unwrap().unwrap().status,
            ChangeSetStatus::Queued
        );
        assert_eq!(
            store.get_change_set(&c2.id).unwrap().unwrap().status,
            ChangeSetStatus::Queued
        );
        let events = store.list_audit_events("s-1", 50).unwrap();
        assert!(events
            .iter()
            .any(|e| e.kind == "approval.batch" && e.payload_json.contains(&digest)));
    }

    #[test]
    fn batch_rejects_dependency_order_violation() {
        let store = temp_store();
        store
            .upsert_project("p-1", "/x", "/x", "/x/.git", "/x/.git")
            .unwrap();
        let s = session("s-2");
        store.insert_session(&s).unwrap();
        let c1 = candidate(&store, "s-2", "d1", &[]);
        let c2 = candidate(&store, "s-2", "d2", &["d1".into()]);
        // Rejected when c2 comes before c1.
        assert!(approve_batch(&store, &s, &[c2.clone(), c1.clone()], "head", "human").is_err());
    }

    #[test]
    fn revert_order_is_reversed() {
        let order = revert_order(&["a".into(), "b".into(), "c".into()]);
        assert_eq!(
            order,
            vec!["c".to_string(), "b".to_string(), "a".to_string()]
        );
    }
}
