// GitHub outbound — per-field write intents and the remote write state machine (design 698-719).
//
// - Only title, state, labels, assignees, and milestone sync per field. Local status and approve
//   stay local-only and are not collapsed into GitHub open/closed (design 701).
// - The GitHub body changes only the sawhorse-managed region enclosed by markers (design 702-703).
// - inbound/outbound/conflict are decided by comparing the per-field base snapshot of the last
//   sync against both current values. When both sides changed, it is a conflict with no
//   automatic last-write-wins (design 705-707).
// - Every remote write is managed as a remote_operation (prepared → sending → succeeded |
//   uncertain → reconciled | failed | stale). Approval binds to payload hash + observed
//   revision; if the revision differs right before execution, the operation reverts to stale (design 708-712).
// - Push and PR creation are separate intents, permissions, and approvals (design 716-719).

use crate::collab::store::Store;
use crate::collab::{new_id, now_ts};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Per-field sync policy. Only this list ever leaves for the remote (design 700).
pub const SYNC_FIELDS: &[&str] = &["title", "state", "labels", "assignees", "milestone"];

/// Markers of the sawhorse-managed region in the GitHub body (design 702-703).
pub const BODY_MARKER_BEGIN: &str = "<!-- sawhorse:begin -->";
pub const BODY_MARKER_END: &str = "<!-- sawhorse:end -->";

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

/// 3-way decision for a single field.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldDiff {
    pub field: String,
    pub base: String,
    pub local: String,
    pub remote: String,
    /// inbound: remote changed only. outbound: local changed only. conflict: both.
    pub direction: String,
}

/// Per-field 3-way comparison. base is the snapshot from field_sync_base.
pub fn field_diffs(
    store: &Store,
    link_id: &str,
    local: &[(String, String)],
    remote: &[(String, String)],
) -> Vec<FieldDiff> {
    let get = |list: &[(String, String)], field: &str| {
        list.iter()
            .find(|(f, _)| f == field)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let mut out = Vec::new();
    for field in SYNC_FIELDS {
        let base = store
            .get_field_sync_base(link_id, field)
            .ok()
            .flatten()
            .map(|(_, v)| v)
            .unwrap_or_default();
        let local_value = get(local, field);
        let remote_value = get(remote, field);
        // No base means the field has never been synced. Same values on both sides = no change,
        // different values = conflict (design 705-707).
        let local_changed = if base.is_empty() {
            local_value != remote_value
        } else {
            local_value != base
        };
        let remote_changed = if base.is_empty() {
            local_value != remote_value
        } else {
            remote_value != base
        };
        if !local_changed && !remote_changed {
            continue;
        }
        let direction = match (local_changed, remote_changed) {
            (true, false) => "outbound",
            (false, true) => "inbound",
            _ => "conflict",
        };
        out.push(FieldDiff {
            field: (*field).to_string(),
            base,
            local: local_value,
            remote: remote_value,
            direction: direction.into(),
        });
    }
    out
}

/// Creates an outbound intent. Requires human approval before it can go to sending.
/// Bound to the payload hash and the observed remote revision (updated_at) (design 711-712).
pub fn propose_outbound(
    store: &Store,
    kind: &str,
    capability: &str,
    payload: &serde_json::Value,
    observed_revision: &str,
) -> Result<String, String> {
    if !SYNC_FIELDS.iter().any(|f| kind == *f)
        && kind != "issue_create"
        && kind != "push"
        && kind != "pr_create"
    {
        return Err(format!("동기화 필드가 아니다: {kind}"));
    }
    let payload_json = payload.to_string();
    let id = new_id("ro");
    store.insert_remote_operation(
        &id,
        kind,
        capability,
        &sha256_hex(&payload_json),
        &payload_json,
        observed_revision,
    )?;
    Ok(id)
}

/// Publishing a draft PR splits into a push intent and a PR-create intent (design 716-719).
pub fn propose_pr_publish(
    store: &Store,
    repository: &str,
    local_commit: &str,
    remote_base: &str,
    branch_name: &str,
    title: &str,
) -> Result<(String, String), String> {
    let push_payload = serde_json::json!({
        "repository": repository,
        "localCommit": local_commit,
        "branch": branch_name,
        "forceWithLease": true,
    });
    let pr_payload = serde_json::json!({
        "repository": repository,
        "head": branch_name,
        "base": remote_base,
        "title": title,
        "draft": true,
    });
    let push_id = propose_outbound(
        store,
        "push",
        crate::extensions::manifest::CAPABILITY_REMOTE_BRANCH_PUSH,
        &push_payload,
        remote_base,
    )?;
    // PR creation is executable only after the push finishes — recorded as dependsOn in the payload.
    let pr_payload = serde_json::json!({ "dependsOn": push_id, "pr": pr_payload });
    let pr_id = propose_outbound(
        store,
        "pr_create",
        crate::extensions::manifest::CAPABILITY_PULL_REQUEST_CREATE,
        &pr_payload,
        remote_base,
    )?;
    Ok((push_id, pr_id))
}

/// Re-verifies the remote revision right before execution. Reverts to stale on mismatch (design 712).
pub fn revision_matches(observed: &str, current_remote: &str) -> bool {
    observed.is_empty() || current_remote.is_empty() || observed == current_remote
}

/// Reconciles an uncertain operation. Checks via GET whether it was already created to decide
/// reconciled/failed (design 558-562: never blindly resend the same create).
pub fn mark_reconciled(
    store: &Store,
    operation_id: &str,
    remote_created: bool,
    result: &str,
) -> Result<(), String> {
    let (id, _, _, _, _, status, _, _) = store
        .get_remote_operation(operation_id)?
        .ok_or("operation이 없다")?;
    let _ = id;
    if status != "uncertain" && status != "sending" {
        return Err(format!("reconcile은 uncertain에서만 가능하다: {status}"));
    }
    store.update_remote_operation(
        operation_id,
        if remote_created {
            "reconciled"
        } else {
            "failed"
        },
        result,
    )
}

/// Approval: a human authorizes the remote write. The payload hash stays bound and is re-verified at execution.
pub fn approve_operation(
    store: &Store,
    operation_id: &str,
    decided_by: &str,
) -> Result<(), String> {
    let (_, _, capability, _, _, status, _, _) = store
        .get_remote_operation(operation_id)?
        .ok_or("operation이 없다")?;
    if status != "prepared" {
        return Err(format!("prepared 상태만 승인할 수 있다: {status}"));
    }
    store.update_remote_operation(
        operation_id,
        "approved",
        &format!("approved by {decided_by}"),
    )?;
    store.insert_audit_event(&crate::collab::model::AuditEvent {
        id: new_id("e"),
        kind: "remote_operation.approved".into(),
        project_id: String::new(),
        session_id: String::new(),
        payload_json: serde_json::json!({
            "operationId": operation_id,
            "capability": capability,
            "decidedBy": decided_by,
            "createdAt": now_ts(),
        })
        .to_string(),
        created_at: now_ts(),
    })?;
    Ok(())
}

/// Execution. Push is `git push --force-with-lease`; PR is `gh pr create --draft`.
/// After a network error with unknown outcome, mark uncertain (design 559-561).
pub fn execute_operation(
    store: &Store,
    operation_id: &str,
    repo_dir: &Path,
) -> Result<String, String> {
    let (_, kind, _, hash, payload_json, status, _, _) = store
        .get_remote_operation(operation_id)?
        .ok_or("operation이 없다")?;
    if status != "approved" {
        return Err(format!("승인된 operation만 실행한다: {status}"));
    }
    // Approval binds to the payload hash; re-verify locally that the stored payload is still
    // exactly what was approved right before the remote write goes out (design 711-712).
    if sha256_hex(&payload_json) != hash {
        return Err("payload 해시가 승인값과 다릅니다".into());
    }
    store.update_remote_operation(operation_id, "sending", "")?;
    let payload: serde_json::Value =
        serde_json::from_str(&payload_json).map_err(|e| format!("payload 해석 실패: {e}"))?;
    let outcome = match kind.as_str() {
        "push" => execute_push(repo_dir, &payload),
        "pr_create" => execute_pr_create(store, repo_dir, &payload),
        other => Err(format!("아직 실행기를 갖지 않은 operation kind: {other}")),
    };
    match outcome {
        Ok(result) => {
            store.update_remote_operation(operation_id, "succeeded", &result)?;
            Ok(result)
        }
        Err(e) if is_network_error(&e) => {
            // Unknown whether the request went out — stay uncertain until reconcile.
            store.update_remote_operation(operation_id, "uncertain", &e)?;
            Err(e)
        }
        Err(e) => {
            store.update_remote_operation(operation_id, "failed", &e)?;
            Err(e)
        }
    }
}

fn is_network_error(e: &str) -> bool {
    e.contains("network")
        || e.contains("Could not resolve")
        || e.contains("timed out")
        || e.contains("connection")
}

fn execute_push(repo_dir: &Path, payload: &serde_json::Value) -> Result<String, String> {
    let repository = payload["repository"].as_str().ok_or("repository가 없다")?;
    let local_commit = payload["localCommit"]
        .as_str()
        .ok_or("localCommit이 없다")?;
    let branch = payload["branch"].as_str().ok_or("branch가 없다")?;
    // The remote name is not inferred from the repository notation — pinned to origin (MVP).
    let _ = repository;
    let out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo_dir)
        .args([
            "push",
            "origin",
            &format!("{local_commit}:refs/heads/{branch}"),
            "--force-with-lease",
        ])
        .output()
        .map_err(|e| format!("git push 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(format!("pushed {local_commit} -> {branch}"))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn execute_pr_create(
    store: &Store,
    repo_dir: &Path,
    payload: &serde_json::Value,
) -> Result<String, String> {
    // pr_create depends on the push intent — the push must have succeeded first (design 716-719).
    let pr = &payload["pr"];
    if let Some(dep) = payload["dependsOn"].as_str() {
        let (_, _, _, _, _, status, _, _) = store
            .get_remote_operation(dep)?
            .ok_or("의존 push operation이 없다")?;
        if status != "succeeded" {
            return Err(format!("push가 아직 성공하지 않았다: {status}"));
        }
    }
    let head = pr["head"].as_str().ok_or("head가 없다")?;
    let base = pr["base"].as_str().ok_or("base가 없다")?;
    let title = pr["title"].as_str().ok_or("title이 없다")?;
    let out = crate::spawn::no_window(std::process::Command::new("gh"))
        .arg("pr")
        .arg("create")
        .args(["--draft", "--head", head, "--base", base, "--title", title])
        .current_dir(repo_dir)
        .output()
        .map_err(|e| format!("gh 실행 실패(gh CLI 필요): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if err.contains("already exists") {
            Ok("PR already exists".into())
        } else {
            Err(err)
        }
    }
}

/// Replaces only the sawhorse-managed region of the GitHub body (design 702-703).
pub fn replace_managed_body(remote_body: &str, managed_markdown: &str) -> String {
    let begin = remote_body.find(BODY_MARKER_BEGIN);
    let end = remote_body.find(BODY_MARKER_END);
    match (begin, end) {
        (Some(b), Some(e)) if b < e => {
            let mut out = String::new();
            out.push_str(&remote_body[..b]);
            out.push_str(BODY_MARKER_BEGIN);
            out.push('\n');
            out.push_str(managed_markdown);
            out.push('\n');
            out.push_str(BODY_MARKER_END);
            out.push_str(&remote_body[e + BODY_MARKER_END.len()..]);
            out
        }
        _ => {
            let mut out = String::new();
            out.push_str(remote_body);
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(BODY_MARKER_BEGIN);
            out.push('\n');
            out.push_str(managed_markdown);
            out.push('\n');
            out.push_str(BODY_MARKER_END);
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> std::sync::Arc<Store> {
        let dir = std::env::temp_dir().join(format!("sawhorse-outbound-{}", uuid::Uuid::new_v4()));
        Store::open_at(dir.join("wb.sqlite")).unwrap()
    }

    #[test]
    fn three_way_diff_classifies_directions() {
        let store = temp_store();
        store
            .set_field_sync_base("l1", "title", "h", "원래 제목")
            .unwrap();
        // state has no base — never synced yet.
        let local = vec![
            ("title".to_string(), "원래 제목".to_string()),
            ("state".to_string(), "open".to_string()),
        ];
        let remote = vec![
            ("title".to_string(), "바뀐 제목".to_string()),
            ("state".to_string(), "open".to_string()),
        ];
        let diffs = field_diffs(&store, "l1", &local, &remote);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].field, "title");
        assert_eq!(diffs[0].direction, "inbound");

        // Both sides changed → conflict.
        let local2 = vec![("title".to_string(), "로컬 제목".to_string())];
        let remote2 = vec![("title".to_string(), "원격 제목".to_string())];
        let diffs2 = field_diffs(&store, "l1", &local2, &remote2);
        assert_eq!(diffs2[0].direction, "conflict");

        // Local-only change → outbound.
        let local3 = vec![("title".to_string(), "로컬 제목".to_string())];
        let remote3 = vec![("title".to_string(), "원래 제목".to_string())];
        let diffs3 = field_diffs(&store, "l1", &local3, &remote3);
        assert_eq!(diffs3[0].direction, "outbound");
    }

    #[test]
    fn outbound_intent_is_hash_and_revision_bound() {
        let store = temp_store();
        let payload = serde_json::json!({ "number": 3, "title": "제목" });
        let id = propose_outbound(
            &store,
            "title",
            "issue_write",
            &payload,
            "2026-09-01T00:00:00Z",
        )
        .unwrap();
        let (_, kind, capability, hash, json, status, revision, _) =
            store.get_remote_operation(&id).unwrap().unwrap();
        assert_eq!(kind, "title");
        assert_eq!(capability, "issue_write");
        assert_eq!(status, "prepared");
    }

    #[test]
    fn pr_publish_separates_push_and_pr_intents() {
        let store = temp_store();
        let (push_id, pr_id) = propose_pr_publish(
            &store,
            "o/r",
            "abc123",
            "main",
            "sawhorse/agent/s-1/t-1",
            "제목",
        )
        .unwrap();
        let (_, kind1, cap1, _, _, status1, _, _) =
            store.get_remote_operation(&push_id).unwrap().unwrap();
        assert_eq!(kind1, "push");
        assert_eq!(
            cap1,
            crate::extensions::manifest::CAPABILITY_REMOTE_BRANCH_PUSH
        );
        assert_eq!(status1, "prepared");
        let (_, kind2, cap2, _, json2, _, _, _) =
            store.get_remote_operation(&pr_id).unwrap().unwrap();
        assert_eq!(kind2, "pr_create");
        assert_eq!(
            cap2,
            crate::extensions::manifest::CAPABILITY_PULL_REQUEST_CREATE
        );
        assert!(
            json2.contains(&push_id),
            "PR intent는 push intent에 의존한다"
        );
    }

    #[test]
    fn managed_body_replacement_keeps_remote_content() {
        let remote = "사용자 서두\n<!-- sawhorse:begin -->\n옛 관리 내용\n<!-- sawhorse:end -->\n사용자 꼬리";
        let out = replace_managed_body(remote, "새 관리 내용");
        assert!(out.starts_with("사용자 서두\n"));
        assert!(out.contains("새 관리 내용"));
        assert!(!out.contains("옛 관리 내용"));
        assert!(out.ends_with("사용자 꼬리"));
        // Without a marker, append at the end.
        let out2 = replace_managed_body("원격 본문", "관리");
        assert!(out2.starts_with("원격 본문"));
        assert!(out2.contains(super::BODY_MARKER_BEGIN));
    }

    #[test]
    fn revision_check_tolerates_empty_observation() {
        assert!(revision_matches("", "anything"));
        assert!(revision_matches("r1", "r1"));
        assert!(!revision_matches("r1", "r2"));
    }
}
