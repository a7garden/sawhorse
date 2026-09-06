// builtin:github 이슈 connector — 1단계는 importOnly(설계 690-696줄).
//
// 1. 전용 poller가 ETag/cursor로 GitHub 변경을 읽는다(작업 스케줄러와 별개).
// 2. remote payload를 바로 노트에 쓰지 않고 inbound change로 staging한다.
// 3. 연결되지 않은 remote issue는 「가져오기」 후보로, 연결된 이슈 변경은 field diff로 보인다.
// 4. 사람이 수락하면 코어가 Markdown을 갱신하고 sync base hash를 기록한다.
//
// provider가 issue와 PR을 같은 목록 표현으로 섞어 주면 entity type을 확인해 PR을
// 이슈로 가져오지 않는다(설계 713-714줄). ExternalLink에는 provider, account,
// immutable repository/issue ID를 저장해 rename·번호 변화에도 연결을 유지한다(683-687줄).

use super::broker::ExtensionContext;
use crate::collab::model::AuditEvent;
use crate::collab::store::Store;
use crate::collab::{new_id, now_ts};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct GitHubSourceConfig {
    /// GitHub account login(승인 대상 계정).
    pub account: String,
    /// owner/repo 표기. 진단 표시용이며 identity는 repository_id다.
    pub repository: String,
    /// immutable repository node id(GraphQL) 또는 숫자 id.
    pub repository_id: String,
    /// 읽어올 issue 상태. 기본 open.
    pub state: String,
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

/// REST 이슈 목록 응답의 최소 필드.
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

/// importOnly poll. 변경을 inbound_change로 staging하고 커서를 전진시킨다.
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
        // PR은 이슈로 가져오지 않는다(설계 713-714줄).
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
                // 연결된 이슈: field diff 후보로 staging한다.
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
                // 연결되지 않은 이슈: 가져오기 후보.
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

// ---------- 수락 적용 ----------

/// 「가져오기」 후보 수락: 새 이슈 노트를 만든다. 사람의 수락이 승인이며,
/// 코어가 file WAL 절차로 원자적으로 쓴다(설계 696줄·566-571줄).
pub fn accept_import(
    store: &Store,
    inbound_id: &str,
    project_id: &str,
    notes_dir: &std::path::Path,
    id_prefix: &str,
) -> Result<String, String> {
    let inbounds = store.list_inbound_changes("staged", 1000)?;
    let inbound = inbounds
        .iter()
        .find(|i| i["id"] == serde_json::json!(inbound_id))
        .ok_or("staged inbound change가 없다")?;
    let payload: serde_json::Value =
        serde_json::from_str(inbound["payload"].as_str().unwrap_or("{}"))
            .map_err(|e| format!("payload 해석 실패: {e}"))?;
    let title = payload["title"].as_str().unwrap_or("무제").to_string();
    let next_number = next_note_number(notes_dir, id_prefix)?;
    let note_id = format!("{id_prefix}-{next_number:03}");
    crate::sdlc::validate_id(id_prefix)?;
    let safe_title: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':') {
                '-'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let file_name = format!("{note_id} {safe_title}.md");
    let target = notes_dir.join(&file_name);
    if target.exists() {
        return Err(format!("노트 파일이 이미 있다: {}", target.display()));
    }
    let repository_id = payload["repositoryId"].as_str().unwrap_or("").to_string();
    let frontmatter = format!(
        "---\ntype: 이슈\npriority: 보통\norigin: GitHub\nid: {note_id}\nurl: \"\"\nissue_type: 작업\nexecution_type: 코드\nlabels: []\nassignees: []\nmilestone: \"\"\nstatus: 제안\nstate: open\napproval_required: true\napprove: false\napproved: \"\"\nbase: \"\"\nbranch: \"\"\ncommits: []\nverified: 미확인\ndepends_on: []\ndependents: []\nrelated: []\nraised: \"\"\ndue: \"\"\nclosed: \"\"\ngithub_repo: \"\"\ngithub_number: \"{}\"\ngithub_url: \"{}\"\ngithub_state: \"{}\"\ngithub_updated: \"{}\"\n---\n\n## 배경 및 요청\n\nGitHub에서 가져온 이슈다. #{}\n\n## 근거 및 분석\n\n{}\n\n## 설계\n\n### 실행 대상\n\n| 대상 | 실행 내용 |\n|---|---|\n\n### 검증 방법\n\n### 위험 및 되돌리기\n\n### 검토 의견\n\n### 개정 이력\n\n## 결과\n\n### 적용 내역\n\n| 항목 | 값 |\n|---|---|\n",
        payload["number"].as_i64().unwrap_or(0),
        payload["url"].as_str().unwrap_or(""),
        payload["state"].as_str().unwrap_or(""),
        payload["updatedAt"].as_str().unwrap_or(""),
        payload["number"].as_i64().unwrap_or(0),
        payload["body"].as_str().unwrap_or(""),
    );
    apply_via_wal(store, &target, "", &frontmatter)?;

    // ExternalLink 기록 — rename·번호 변화에도 유지되는 immutable identity.
    store.upsert_external_link(
        &new_id("el"),
        project_id,
        &target.to_string_lossy().to_string(),
        "github",
        payload["account"].as_str().unwrap_or(""),
        &repository_id,
        inbound["externalId"].as_str().unwrap_or(""),
    )?;
    store.set_inbound_state(inbound_id, "applied")?;
    Ok(target.to_string_lossy().to_string())
}

/// 연결된 이슈의 field 갱신 수락(제목·상태). 원문 body는 덮어쓰지 않는다(설계 702-703줄).
pub fn accept_field_update(store: &Store, inbound_id: &str) -> Result<String, String> {
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
    apply_via_wal(store, &target, &expected, &updated)?;
    let link =
        store.find_external_link("github", "", inbound["externalId"].as_str().unwrap_or(""))?;
    if let Some((link_id, _, _)) = link {
        for field in ["state", "title"] {
            let value = payload.get(field).and_then(|v| v.as_str()).unwrap_or("");
            let _ = store.set_field_sync_base(&link_id, field, &sha256_hex(value), value);
        }
    }
    store.set_inbound_state(inbound_id, "applied")?;
    Ok(note_path)
}

/// frontmatter의 단일 필드만 교체한다. 본문은 절대 건드리지 않는다(vault.rs 3키 갱신 패턴과 동일).
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

/// 설계 563-571줄의 file WAL 절차 그대로.
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
    // 2. 현재 파일 hash가 expected와 같은지 재확인.
    let current = std::fs::read_to_string(target).unwrap_or_default();
    let current_hash = sha256_hex(&current);
    if !expected_hash.is_empty() && current_hash != expected_hash {
        store.file_wal_finish(&wal_id, false, &current_hash)?;
        return Err("로컬 파일이 예상 해시와 다르다 (외부 충돌)".into());
    }
    // 3. 임시 파일 + 같은 filesystem atomic rename.
    let tmp = target.with_extension(format!("tmp-{}", &wal_id[..8.min(wal_id.len())]));
    std::fs::write(&tmp, content).map_err(|e| {
        let _ = store.file_wal_finish(&wal_id, false, &current_hash);
        format!("임시 파일 쓰기 실패: {e}")
    })?;
    std::fs::rename(&tmp, target).map_err(|e| {
        let _ = store.file_wal_finish(&wal_id, false, &current_hash);
        format!("원자적 rename 실패: {e}")
    })?;
    // 4. 실제 파일 hash 확인 후 applied.
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
}
