// Approval policy evaluation. Design lines 234-320.
//
// - Settings compute a new session's initial values in global (dashboard.collaboration) then
//   project (integration.approval) order, and an immutable v1 snapshot is made at session start.
// - Global or project setting changes never silently alter active sessions. A v2 exists only
//   after a human confirms the "세션 정책 변경" (change session policy) action.
// - No command lets agents, packs, or connectors write policy.

use super::model::*;
use super::store::Store;
use crate::config::ConfigView;
use serde_json::json;

/// Effective policy applied at session start. Project approval overrides layer on top of global values.
pub fn effective_policy(view: &ConfigView, project_id: &str) -> CollaborationPolicy {
    let mut policy = view.dashboard.collaboration.clone();
    if let Some(project) = view.core_projects.get(project_id) {
        if let Some(approval) = project_override(&project.integration.branch, view, project_id) {
            policy.local_integration_approval = approval;
        }
    }
    policy
}

/// Per-project approval overrides live in config at `projects.<id>.integration.approval`.
/// The CoreProject struct knows only verification profile and paths; approval is read separately from the wire.
fn project_override(_branch: &str, _view: &ConfigView, _project_id: &str) -> Option<PolicyMode> {
    // The approval field does not reach CoreProject through serde ("approval": null in the design example
    // means "no override"). MVP uses the global policy only; overrides land together with phase-4 batch integration.
    None
}

/// Session start snapshot (v1). Pins the policy as of the moment a human confirmed the start.
pub fn snapshot_for_new_session(
    store: &Store,
    project_id: &str,
    view: &ConfigView,
) -> Result<(i64, CollaborationPolicy), String> {
    let policy = effective_policy(view, project_id);
    let snapshot = PolicySnapshot {
        version: 1,
        project_id: project_id.into(),
        policy_json: serde_json::to_string(&policy)
            .map_err(|e| format!("정책 직렬화 실패: {e}"))?,
        created_at: super::now_ts(),
        created_by: "human".into(),
    };
    let version = store.insert_policy_snapshot(&snapshot)?;
    Ok((version, policy))
}

/// Amend the session policy. Creates v2 only when a human confirms, and returns the new version.
/// Loosening applies starting from the v2-created review snapshot; tightening applies to candidates not yet integrated.
pub fn amend_policy(
    store: &Store,
    project_id: &str,
    view: &ConfigView,
    by: &str,
) -> Result<(i64, CollaborationPolicy), String> {
    let policy = effective_policy(view, project_id);
    let snapshot = PolicySnapshot {
        version: 0,
        project_id: project_id.into(),
        policy_json: serde_json::to_string(&policy)
            .map_err(|e| format!("정책 직렬화 실패: {e}"))?,
        created_at: super::now_ts(),
        created_by: by.into(),
    };
    let version = store.insert_policy_snapshot(&snapshot)?;
    Ok((version, policy))
}

pub fn load_policy(
    store: &Store,
    project_id: &str,
    version: i64,
) -> Result<CollaborationPolicy, String> {
    let snapshot = store
        .get_policy_snapshot(project_id, version)?
        .ok_or_else(|| format!("정책 스냅샷 없음: {project_id} v{version}"))?;
    serde_json::from_str(&snapshot.policy_json).map_err(|e| format!("정책 스냅샷 해석 실패: {e}"))
}

/// If the HEAD seen at approval time differs from the current HEAD by even one bit, re-approval is required (design lines 378-380).
pub fn approval_is_stale(
    approval: &Approval,
    current_head: &str,
    candidate: &ChangeSet,
) -> Result<bool, String> {
    if approval.decision != "approved" {
        return Ok(true);
    }
    if approval.digest != candidate.digest {
        return Ok(true);
    }
    Ok(approval.expected_head != current_head)
}

/// Handle an approval decision. A human approval leaves an Approval plus AuthorizationDecision (human).
pub fn record_human_approval(
    store: &Store,
    candidate: &ChangeSet,
    expected_head: &str,
    policy_version: i64,
    decided_by: &str,
) -> Result<AuthorizationDecision, String> {
    let approval = Approval {
        id: super::new_id("ap"),
        candidate_id: candidate.id.clone(),
        digest: candidate.digest.clone(),
        expected_head: expected_head.into(),
        policy_version,
        decision: "approved".into(),
        decided_by: decided_by.into(),
        reason: String::new(),
        created_at: super::now_ts(),
    };
    store.insert_approval(&approval)?;
    let decision = AuthorizationDecision {
        id: super::new_id("a"),
        candidate_id: candidate.id.clone(),
        kind: AuthorizationKind::Human,
        policy_version,
        decision_ref: approval.id.clone(),
        created_at: super::now_ts(),
    };
    store.insert_authorization(&decision)?;
    Ok(decision)
}

/// Automatic policy authorization. Creates a policy authorization only when every preflight result passes.
/// It never masquerades as human approval (design lines 317-320).
pub fn record_policy_authorization(
    store: &Store,
    candidate: &ChangeSet,
    expected_head: &str,
    policy_version: i64,
    preflight_ok: bool,
) -> Result<Option<AuthorizationDecision>, String> {
    if !preflight_ok {
        return Ok(None);
    }
    // Auto mode still records an approval — who (or what) granted it must be reproducible (design line 49).
    let approval = Approval {
        id: super::new_id("ap"),
        candidate_id: candidate.id.clone(),
        digest: candidate.digest.clone(),
        expected_head: expected_head.into(),
        policy_version,
        decision: "policy".into(),
        decided_by: "policy:autoAfterPreflight".into(),
        reason: String::new(),
        created_at: super::now_ts(),
    };
    store.insert_approval(&approval)?;
    let decision = AuthorizationDecision {
        id: super::new_id("a"),
        candidate_id: candidate.id.clone(),
        kind: AuthorizationKind::Policy,
        policy_version,
        decision_ref: approval.id.clone(),
        created_at: super::now_ts(),
    };
    store.insert_authorization(&decision)?;
    Ok(Some(decision))
}

/// Standard audit payload shape.
pub fn audit_payload(candidate: &ChangeSet, extra: serde_json::Value) -> serde_json::Value {
    json!({
        "candidateId": candidate.id,
        "digest": candidate.digest,
        "base": candidate.base_sha,
        "source": candidate.source_sha,
        "extra": extra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> Store {
        let dir = std::env::temp_dir().join(format!("sawhorse-policy-{}", uuid::Uuid::new_v4()));
        Store::open_at(dir.join("wb.sqlite")).unwrap();
        // Store is an Arc wrapper and cannot be returned directly from tests — rebuild it via the helper.
        panic!("unused");
    }

    #[test]
    fn effective_policy_honors_global_auto_mode() {
        let raw = serde_json::json!({
            "dashboard": { "collaboration": { "localIntegrationApproval": "autoAfterPreflight" } }
        });
        let view = crate::config::view(&raw, true);
        let policy = effective_policy(&view, "p-1");
        assert_eq!(
            policy.local_integration_approval,
            PolicyMode::AutoAfterPreflight
        );
    }

    #[test]
    fn stale_approval_detection() {
        let candidate = ChangeSet {
            id: "c-1".into(),
            digest: "d1".into(),
            ..Default::default()
        };
        let approval = Approval {
            decision: "approved".into(),
            digest: "d1".into(),
            expected_head: "head1".into(),
            ..Default::default()
        };
        assert!(!approval_is_stale(&approval, "head1", &candidate).unwrap());
        assert!(
            approval_is_stale(&approval, "head2", &candidate).unwrap(),
            "HEAD drift는 무조건 재승인"
        );
        let rejected = Approval {
            decision: "rejected".into(),
            ..approval.clone()
        };
        assert!(approval_is_stale(&rejected, "head1", &candidate).unwrap());
        let other_digest = Approval {
            digest: "d2".into(),
            ..approval.clone()
        };
        assert!(approval_is_stale(&other_digest, "head1", &candidate).unwrap());
    }
}
