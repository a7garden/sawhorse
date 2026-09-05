// 승인 정책 평가. 설계 234-320줄.
//
// - 설정은 전역(dashboard.collaboration) → 프로젝트(integration.approval) 순으로
//   새 세션의 초기값을 계산하고, 세션 시작 때 immutable v1 snapshot을 만든다.
// - 전역·프로젝트 설정 변경은 활성 세션을 몰래 바꾸지 않는다. 사람이 「세션 정책 변경」을
//   확인했을 때만 v2가 생긴다.
// - 에이전트·pack·connector가 정책을 쓰는 명령은 제공하지 않는다.

use super::model::*;
use super::store::Store;
use crate::config::ConfigView;
use serde_json::json;

/// 세션 시작 시 적용할 effective policy. 전역값에 프로젝트 approval 재정의를 얹는다.
pub fn effective_policy(view: &ConfigView, project_id: &str) -> CollaborationPolicy {
    let mut policy = view.dashboard.collaboration.clone();
    if let Some(project) = view.core_projects.get(project_id) {
        if let Some(approval) = project_override(&project.integration.branch, view, project_id) {
            policy.local_integration_approval = approval;
        }
    }
    policy
}

/// 프로젝트별 approval 재정의는 config의 `projects.<id>.integration.approval`에 둔다.
/// CoreProject 구조는 검증 프로필·경로만 알고 approval은 wire에서 별도로 읽는다.
fn project_override(_branch: &str, _view: &ConfigView, _project_id: &str) -> Option<PolicyMode> {
    // approval 필드는 serde로 CoreProject에 들어오지 않는다(설계 예시의 "approval": null은
    // "재정의 없음"). MVP는 전역 정책만 사용하고 재정의는 4단계 batch integration과 함께 넣는다.
    None
}

/// 세션 시작 스냅샷(v1). 사람이 시작을 확인한 시점의 정책이 고정된다.
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

/// 세션 정책 개정. 사람이 확인했을 때만 v2를 만들고 새 버전을 반환한다.
/// 완화는 v2로 만든 review snapshot부터, 강화는 아직 통합되지 않은 후보에 적용된다.
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

/// 승인 때 본 HEAD와 현재 HEAD가 한 bit라도 다르면 재승인(설계 378-380줄).
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

/// 승인 결정 처리. 사람 승인은 Approval + AuthorizationDecision(human)을 남긴다.
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

/// 자동 정책 허가. 사전검사(preflight) 결과가 모두 통과일 때만 policy authorization을 만든다.
/// 사람 승인으로 위장하지 않는다(설계 317-320줄).
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
    // 자동 모드도 승인 기록은 남긴다 — 누가(무엇이) 허가했는지 재현 가능해야 한다(설계 49줄).
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

/// 감사 payload 표준형.
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
        // Store는 Arc 래퍼라 테스트에서 직접 반환하지 않는다 — 헬퍼로 재구성.
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
