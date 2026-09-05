// 감사 이벤트와 tauri 이벤트 방출. 설계 825줄: audit event·transactional outbox.
// 내부 상태 전이는 store.transition_with_audit으로 같은 트랜잭션에 기록되고,
// 이 모듈은 프론트엔드 알림(`collab-changed`)과 감사 이벤트 생성을 담당한다.

use super::model::AuditEvent;
use super::{new_id, now_ts};
use serde_json::json;

/// 감사 이벤트 종류. 설계 676-679줄의 대표 이벤트 이름을 그대로 쓴다.
pub const SESSION_CREATED: &str = "session.created";
pub const AGENT_RUN_COMPLETED: &str = "agent.run.completed";
pub const CHANGESET_PROPOSED: &str = "changeset.proposed";
pub const APPROVAL_REQUESTED: &str = "approval.requested";
pub const APPROVAL_RESOLVED: &str = "approval.resolved";
pub const INTEGRATION_STARTED: &str = "integration.started";
pub const INTEGRATION_VERIFIED: &str = "integration.verified";
pub const INTEGRATION_FAILED: &str = "integration.failed";
pub const INTEGRATION_REVERTED: &str = "integration.reverted";
pub const SYNC_FAILED: &str = "sync.failed";

pub fn make_event(
    kind: &str,
    project_id: &str,
    session_id: &str,
    payload: serde_json::Value,
) -> AuditEvent {
    AuditEvent {
        id: new_id("e"),
        kind: kind.into(),
        project_id: project_id.into(),
        session_id: session_id.into(),
        payload_json: payload.to_string(),
        created_at: now_ts(),
    }
}

/// 프론트엔드 방출 콜백. tauri AppHandle은 서비스 계층에서 주입받는다.
pub type Emit = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// `collab-changed` 방출. UI는 이 이벤트 하나로 세션·검토 화면을 갱신한다.
pub fn notify_changed(emit: &Emit, reason: &str) {
    emit("collab-changed", json!({ "reason": reason }));
}
