// builtin:github issue connector — phase 1 is importOnly (design 690-696).
//
// 1. A dedicated poller reads GitHub changes with ETag/cursor (separate from the task scheduler).
// 2. Remote payloads are staged as inbound changes rather than written straight into notes.
// 3. Unlinked remote issues appear as 「가져오기」 (Import) candidates; linked-issue changes appear as field diffs.
// 4. On human acceptance the core updates the Markdown and records the sync base hash.
//
// When the provider mixes issues and PRs into one list representation, check the entity type
// and do not import PRs as issues (design 713-714). ExternalLink stores provider, account,
// and immutable repository/issue IDs so links survive renames and number changes (683-687).

use super::broker::ExtensionContext;
use crate::collab::model::AuditEvent;
use crate::collab::store::Store;
use crate::collab::{new_id, now_ts};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubSourceConfig {
    /// GitHub account login (the account being authorized).
    pub account: String,
    /// owner/repo notation. For diagnostic display only; identity is repository_id.
    pub repository: String,
    /// Immutable repository node id (GraphQL) or numeric id.
    pub repository_id: String,
    /// Issue state to read. Default open.
    pub state: String,
    /// Project this sync is bound to (sdlc id). Used to pre-select import targets.
    pub project_id: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PollReport {
    pub fetched: usize,
    pub staged_new: usize,
    pub staged_updates: usize,
    pub skipped_pull_requests: usize,
    pub cursor: String,
}

/// Minimal fields of the REST issue list response.
#[derive(Deserialize, Clone, Debug)]
struct GhIssue {
    id: i64,
    number: i64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    html_url: String,
}

/// importOnly poll. Stages changes as inbound_change and advances the cursor.
pub async fn poll_issues(
    store: &Store,
    ctx: &ExtensionContext,
    config: &GitHubSourceConfig,
) -> Result<PollReport, String> {
    let _ = ctx.require_capability("secret_use");
    let state = if config.state.is_empty() {
        "open".to_string()
    } else {
        config.state.clone()
    };
    let (since, etag) = stored_cursor(store, &ctx.instance_id);
    let mut url = format!(
        "https://api.github.com/repos/{}/issues?state={}&per_page=50&sort=updated&direction=desc",
        config.repository, state
    );
    if !since.is_empty() {
        url.push_str(&format!("&since={since}"));
    }
    let resp = ctx
        .guarded_get_authorized(&url, "github.oauth", "application/vnd.github+json")
        .await?;
    if resp.status == 304 {
        return Ok(PollReport {
            cursor: since,
            ..Default::default()
        });
    }
    if resp.status != 200 {
        return Err(format!("GitHub API 상태 {}", resp.status));
    }
    let issues: Vec<GhIssue> =
        serde_json::from_slice(&resp.body).map_err(|e| format!("응답 해석 실패: {e}"))?;
    let new_etag = resp.header("etag").unwrap_or("").to_string();
    let mut report = PollReport {
        fetched: issues.len(),
        ..Default::default()
    };

    for issue in &issues {
        // PRs are not imported as issues (design 713-714).
        if issue.pull_request.is_some() {
            report.skipped_pull_requests += 1;
            continue;
        }
        let link =
            store.find_external_link("github", &config.repository_id, &issue.id.to_string())?;
        let payload = serde_json::json!({
            "account": config.account,
            "repositoryId": config.repository_id,
            "repository": config.repository,
            "number": issue.number,
            "title": issue.title,
            "body": issue.body.clone().unwrap_or_default(),
            "state": issue.state,
            "url": issue.html_url,
            "updatedAt": issue.updated_at,
        });
        match link {
            Some((link_id, _project_id, note_path)) => {
                // Linked issue: staged as a field-diff candidate.
                store.insert_inbound_change(
                    &new_id("ic"),
                    &link_id,
                    &ctx.instance_id,
                    &issue.id.to_string(),
                    &payload.to_string(),
                    &note_path,
                )?;
                report.staged_updates += 1;
            }
            None => {
                // Unlinked issue: an import candidate.
                store.insert_inbound_change(
                    &new_id("ic"),
                    "",
                    &ctx.instance_id,
                    &issue.id.to_string(),
                    &payload.to_string(),
                    "",
                )?;
                report.staged_new += 1;
            }
        }
    }
    let newest = issues
        .iter()
        .map(|i| i.updated_at.as_str())
        .max()
        .unwrap_or("")
        .to_string();
    store.update_sync_cursor(
        &format!("github:{}", ctx.instance_id),
        &newest,
        &new_etag,
        "",
    )?;
    report.cursor = newest;
    store.insert_audit_event(&AuditEvent {
        id: new_id("e"),
        kind: "github.polled".into(),
        project_id: String::new(),
        session_id: String::new(),
        payload_json: serde_json::json!({
            "instanceId": ctx.instance_id,
            "fetched": report.fetched,
            "stagedNew": report.staged_new,
            "stagedUpdates": report.staged_updates,
            "skippedPullRequests": report.skipped_pull_requests,
        })
        .to_string(),
        created_at: now_ts(),
    })?;
    Ok(report)
}

fn stored_cursor(store: &Store, instance_id: &str) -> (String, String) {
    store
        .get_sync_cursor(&format!("github:{instance_id}"))
        .ok()
        .flatten()
        .map(|(cursor, etag, _)| (cursor, etag))
        .unwrap_or_default()
}

// ---------- Acceptance application ----------

/// Accepting an 「가져오기」 (Import) candidate: creates a new work item in the chosen project
/// and links it via ExternalLink. The human's acceptance is the approval; the work.md write
/// goes through the core's file WAL procedure (design 696, 566-571).
pub fn accept_import(store: &Store, inbound_id: &str, project_id: &str) -> Result<String, String> {
    accept_import_at(store, &crate::sdlc::vault_root()?, inbound_id, project_id)
}

/// Body taking an injected vault root. Split out so tests can run against a temp vault.
pub fn accept_import_at(
    store: &Store,
    root: &std::path::Path,
    inbound_id: &str,
    project_id: &str,
) -> Result<String, String> {
    let inbounds = store.list_inbound_changes("staged", 1000)?;
    let inbound = inbounds
        .iter()
        .find(|i| i["id"] == serde_json::json!(inbound_id))
        .ok_or("staged inbound change가 없다")?;
    let payload: serde_json::Value =
        serde_json::from_str(inbound["payload"].as_str().unwrap_or("{}"))
            .map_err(|e| format!("payload 해석 실패: {e}"))?;
    let external_id = inbound["externalId"].as_str().unwrap_or("").to_string();
    let repository_id = payload["repositoryId"].as_str().unwrap_or("").to_string();
    // One external issue maps to at most one work item.
    if store
        .find_external_link("github", &repository_id, &external_id)?
        .is_some()
    {
        return Err("이미 가져온 이슈입니다. 연결된 이슈 갱신 후보를 확인하세요.".into());
    }
    let work = crate::sdlc::import_issue_work_at(
        root,
        project_id,
        crate::sdlc::ExternalIssue {
            title: payload["title"].as_str().unwrap_or("").to_string(),
            body: payload["body"].as_str().unwrap_or("").to_string(),
            repository: payload["repository"].as_str().unwrap_or("").to_string(),
            number: payload["number"].as_i64().unwrap_or(0),
            url: payload["url"].as_str().unwrap_or("").to_string(),
            state: payload["state"].as_str().unwrap_or("").to_string(),
            updated_at: payload["updatedAt"].as_str().unwrap_or("").to_string(),
        },
    )?;
    let note_path = crate::sdlc::work_path(&root, &work.id)
        .to_string_lossy()
        .to_string();

    // ExternalLink record — immutable identity that survives renames and number changes.
    store.upsert_external_link(
        &new_id("el"),
        project_id,
        &note_path,
        "github",
        payload["account"].as_str().unwrap_or(""),
        &repository_id,
        &external_id,
    )?;
    store.set_inbound_state(inbound_id, "applied")?;
    Ok(note_path)
}

/// Accepts field updates of a linked issue (title, state). Does not overwrite the original body (design 702-703).
pub fn accept_field_update(store: &Store, inbound_id: &str) -> Result<String, String> {
    accept_field_update_at(store, &crate::sdlc::vault_root()?, inbound_id)
}

/// Body taking an injected vault root. Split out so tests can run against a temp vault.
pub fn accept_field_update_at(
    store: &Store,
    root: &std::path::Path,
    inbound_id: &str,
) -> Result<String, String> {
    let inbounds = store.list_inbound_changes("staged", 1000)?;
    let inbound = inbounds
        .iter()
        .find(|i| i["id"] == serde_json::json!(inbound_id))
        .ok_or("staged inbound change가 없다")?;
    let payload: serde_json::Value =
        serde_json::from_str(inbound["payload"].as_str().unwrap_or("{}"))
            .map_err(|e| format!("payload 해석 실패: {e}"))?;
    let note_path = inbound["targetPath"].as_str().unwrap_or("").to_string();
    if note_path.is_empty() {
        return Err("연결 노트 경로가 없다".into());
    }
    let target = std::path::PathBuf::from(&note_path);
    let current = std::fs::read_to_string(&target).unwrap_or_default();
    let expected = sha256_hex(&current);
    let mut updated = current.clone();
    if is_work_target(root, &target) {
        // work.md targets are updated through the type model. Only the title and GitHub mirror
        // fields change; local status remains human-owned (design 690-716).
        let work_id = target
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        updated = crate::sdlc::apply_external_field_update(
            &root,
            &work_id,
            payload["title"].as_str().unwrap_or(""),
            payload["state"].as_str().unwrap_or(""),
            payload["updatedAt"].as_str().unwrap_or(""),
        )?;
    } else {
        for field in ["title", "state", "github_state", "github_updated"] {
            let value = match payload.get(field).and_then(|v| v.as_str()) {
                Some(v) => v.to_string(),
                None => continue,
            };
            let fm_field = match field {
                "title" => "title",
                "state" => "state",
                "github_state" => "github_state",
                _ => "github_updated",
            };
            updated = update_frontmatter_field(&updated, fm_field, &value)?;
        }
    }
    apply_via_wal(store, &target, &expected, &updated)?;
    let link = store.find_external_link(
        "github",
        payload["repositoryId"].as_str().unwrap_or(""),
        inbound["externalId"].as_str().unwrap_or(""),
    )?;
    if let Some((link_id, _, _)) = link {
        for field in ["state", "title"] {
            let value = payload.get(field).and_then(|v| v.as_str()).unwrap_or("");
            let _ = store.set_field_sync_base(&link_id, field, &sha256_hex(value), value);
        }
    }
    store.set_inbound_state(inbound_id, "applied")?;
    Ok(note_path)
}

/// True when the update target is a work/ item. Legacy vault notes keep the existing
/// frontmatter patch path unchanged.
fn is_work_target(root: &std::path::Path, target: &std::path::Path) -> bool {
    target.starts_with(root.join("work"))
}

/// Replaces a single frontmatter field. Never touches the body (same as vault.rs's 3-key update pattern).
pub fn update_frontmatter_field(
    markdown: &str,
    field: &str,
    value: &str,
) -> Result<String, String> {
    if !markdown.starts_with("---\n") {
        return Err("frontmatter가 없는 노트다".into());
    }
    let close = markdown[4..]
        .find("\n---")
        .map(|i| i + 4)
        .ok_or("frontmatter가 닫히지 않았다")?;
    let fm = &markdown[..close];
    let rest = &markdown[close..];
    let key = format!("{field}:");
    let mut replaced = false;
    let mut lines: Vec<String> = Vec::new();
    for line in fm.lines() {
        if line.starts_with(&key) && !replaced {
            lines.push(format!(
                "{field}: \"{}\"",
                value
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\n', "\\n")
                    .replace('\r', "\\r")
            ));
            replaced = true;
        } else {
            lines.push(line.to_string());
        }
    }
    if !replaced {
        lines.push(format!(
            "{field}: \"{}\"",
            value
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', "\\r")
        ));
    }
    let mut out = lines.join("\n");
    out.push_str(rest);
    Ok(out)
}

/// The file WAL procedure from design lines 563-571, verbatim.
fn apply_via_wal(
    store: &Store,
    target: &std::path::Path,
    expected_hash: &str,
    content: &str,
) -> Result<(), String> {
    // 1. WAL prepared.
    let payload_hash = sha256_hex(content);
    let wal_id = store.file_wal_prepare(
        &target.to_string_lossy().to_string(),
        &expected_hash,
        &payload_hash,
    )?;
    // 2. Re-verify the current file hash matches expected.
    let current = std::fs::read_to_string(target).unwrap_or_default();
    let current_hash = sha256_hex(&current);
    if !expected_hash.is_empty() && current_hash != expected_hash {
        store.file_wal_finish(&wal_id, false, &current_hash)?;
        return Err("로컬 파일이 예상 해시와 다르다 (외부 충돌)".into());
    }
    // 3. Temp file + atomic rename on the same filesystem.
    let tmp = target.with_extension(format!("tmp-{}", &wal_id[..8.min(wal_id.len())]));
    std::fs::write(&tmp, content).map_err(|e| {
        let _ = store.file_wal_finish(&wal_id, false, &current_hash);
        format!("임시 파일 쓰기 실패: {e}")
    })?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = store.file_wal_finish(&wal_id, false, &current_hash);
        format!("원자적 rename 실패: {e}")
    })?;
    // 4. Verify the actual file hash, then mark applied.
    let actual = std::fs::read_to_string(target).unwrap_or_default();
    let actual_hash = sha256_hex(&actual);
    store.file_wal_finish(&wal_id, actual_hash == payload_hash, &actual_hash)?;
    if actual_hash != payload_hash {
        return Err("적용 후 해시가 일치하지 않는다".into());
    }
    Ok(())
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

fn next_note_number(notes_dir: &std::path::Path, id_prefix: &str) -> Result<i64, String> {
    let mut max = 0i64;
    if let Ok(entries) = std::fs::read_dir(notes_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let prefix = format!("{id_prefix}-");
            if let Some(rest) = name.strip_prefix(&prefix) {
                if let Some(num) = rest
                    .split([' ', '.'])
                    .next()
                    .and_then(|n| n.parse::<i64>().ok())
                {
                    max = max.max(num);
                }
            }
        }
    }
    Ok(max + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_field_update_touches_only_target_line() {
        let note = "---\ntype: 이슈\nstatus: 제안\nstate: open\n---\n\n본문\n";
        let updated = update_frontmatter_field(note, "state", "closed").unwrap();
        assert!(updated.starts_with("---\ntype: 이슈\nstatus: 제안\nstate: \"closed\"\n---\n"));
        assert!(updated.ends_with("\n\n본문\n"), "본문 보존");
        assert!(update_frontmatter_field("본문만", "state", "open").is_err());
    }

    #[test]
    fn frontmatter_update_cannot_inject_keys() {
        let note = "---\nmilestone: old\napprove: false\n---\nBody\n";
        let updated =
            update_frontmatter_field(note, "milestone", "release\\next\nstate: closed").unwrap();
        let split = crate::vault::split_frontmatter(&updated).unwrap();
        let mapping: serde_yaml::Value = serde_yaml::from_str(&split.yaml).unwrap();
        assert_eq!(
            mapping["milestone"].as_str(),
            Some("release\\next\nstate: closed")
        );
        assert!(mapping["state"].is_null());
        assert_eq!(split.after_close, "Body\n");
    }

    #[test]
    fn frontmatter_update_escapes_quotes() {
        let note = "---\ntitle: \"옛 제목\"\n---\n본문";
        let updated = update_frontmatter_field(note, "title", "새 \"제목\"").unwrap();
        assert!(updated.contains("title: \"새 \\\"제목\\\"\""));
    }
    fn fixture(name: &str) -> (std::path::PathBuf, crate::collab::store::StoreHandle) {
        let root = std::env::temp_dir().join(format!("swgh-{name}-{}", uuid::Uuid::new_v4()));
        crate::sdlc::initialize(&root).unwrap();
        crate::sdlc::save_project_at(
            &root,
            crate::sdlc::Project {
                id: "p1".into(),
                name: "프로젝트".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let store =
            crate::collab::store::Store::open_at(root.join(".collab").join("store.db")).unwrap();
        (root, store)
    }

    fn issue_payload() -> serde_json::Value {
        serde_json::json!({
            "account": "octocat",
            "repositoryId": "R_1",
            "repository": "octocat/hello",
            "number": 7,
            "title": "검색 오류",
            "body": "재현 절차:\n\n1. 검색 클릭",
            "state": "open",
            "url": "https://github.com/octocat/hello/issues/7",
            "updatedAt": "2026-09-07T01:02:03Z"
        })
    }

    #[test]
    fn import_lands_in_project_work_and_rejects_duplicate() {
        let (root, store) = fixture("import");
        store
            .insert_inbound_change(
                "ic1",
                "",
                "inst",
                "issue-1",
                &issue_payload().to_string(),
                "",
            )
            .unwrap();
        let note_path = accept_import_at(&store, &root, "ic1", "p1").unwrap();
        let note_path = note_path.replace('\\', "/");
        assert!(
            note_path.contains("/work/"),
            "work/ 아래여야 한다: {note_path}"
        );
        assert!(note_path.ends_with("/work.md"));

        let snapshot = crate::sdlc::snapshot(&root).unwrap();
        assert_eq!(snapshot.work.len(), 1);
        let work = &snapshot.work[0];
        assert_eq!(work.title, "검색 오류");
        assert_eq!(work.project_id, "p1");
        assert_eq!(work.github_repo, "octocat/hello");
        assert_eq!(work.github_number, "7");
        assert_eq!(work.github_state, "open");
        assert_eq!(work.status, "backlog");
        assert!(work.description.contains("재현 절차"));
        // Approval is a human decision, so imported items always start switched off.
        assert!(!work.approve);

        // A second acceptance of the same external issue is rejected.
        store
            .insert_inbound_change(
                "ic2",
                "",
                "inst",
                "issue-1",
                &issue_payload().to_string(),
                "",
            )
            .unwrap();
        let error = accept_import_at(&store, &root, "ic2", "p1").unwrap_err();
        assert!(error.contains("이미 가져온"), "{error}");
        assert_eq!(crate::sdlc::snapshot(&root).unwrap().work.len(), 1);
        drop(store);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn field_update_patches_mirrors_and_keeps_local_status() {
        let (root, store) = fixture("update");
        store
            .insert_inbound_change(
                "ic1",
                "",
                "inst",
                "issue-1",
                &issue_payload().to_string(),
                "",
            )
            .unwrap();
        let note_path = accept_import_at(&store, &root, "ic1", "p1").unwrap();

        let payload = serde_json::json!({
            "repositoryId": "R_1",
            "title": "검색 오류 (수정)",
            "state": "closed",
            "updatedAt": "2026-09-08T00:00:00Z"
        });
        store
            .insert_inbound_change(
                "ic2",
                "el1",
                "inst",
                "issue-1",
                &payload.to_string(),
                &note_path,
            )
            .unwrap();
        accept_field_update_at(&store, &root, "ic2").unwrap();

        let work = &crate::sdlc::snapshot(&root).unwrap().work[0];
        assert_eq!(work.title, "검색 오류 (수정)");
        assert_eq!(work.github_state, "closed");
        assert_eq!(work.github_updated, "2026-09-08T00:00:00Z");
        // Local status is not collapsed into GitHub open/closed (design 690-716).
        assert_eq!(work.status, "backlog");
        assert!(work.description.contains("재현 절차"), "본문 보존");
        drop(store);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn repository_slug_validation_matches_clone_rules() {
        assert!(crate::sdlc::validate_repository_slug("octocat/Hello-World").is_ok());
        for bad in [
            "../repo",
            "owner/..",
            "--help",
            "owner/repo/extra",
            "owner/repo\n",
        ] {
            assert!(crate::sdlc::validate_repository_slug(bad).is_err(), "{bad}");
        }
    }
}
