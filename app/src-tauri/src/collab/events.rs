// Audit events and tauri event emission. Design line 825: audit event and transactional outbox.
// Internal state transitions are recorded in the same transaction via store.transition_with_audit,
// and this module owns frontend notification (`collab-changed`) and audit event creation.

use super::model::AuditEvent;
use super::{new_id, now_ts};
use serde_json::json;

/// Audit event kinds. Uses the canonical event names from design lines 676-679 verbatim.
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

/// Frontend emit callback. The tauri AppHandle is injected by the service layer.
pub type Emit = Box<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// Emit `collab-changed`. The UI refreshes the session and review screens from this one event.
pub fn notify_changed(emit: &Emit, reason: &str) {
    emit("collab-changed", json!({ "reason": reason }));
}
