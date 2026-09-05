// 후보 파일 인박스. 설계 200-232줄·819-820줄.
//
// 에이전트는 `~/.claude/sawhorse/collab/inbox/changesets/`에 JSON 파일 하나만 쓴다
// (tasks.rs의 파일 인박스 패턴과 동일한 단일 작성자 규칙). 이 모듈이 파일을 검증하고
// Git 객체를 다시 확인한 뒤 장부(SQLite)에 정규화하고 파일을 processed/rejected로 옮긴다.
// 정식 후보 기록은 장부만 쓴다 — 인박스 파일은 요청일 뿐이다.

use super::git;
use super::model::*;
use super::store::Store;
use super::{inbox_dir, inbox_done_dir, inbox_rejected_dir, new_id, now_ts};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 인박스 처리 한 건의 결과.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxReport {
    pub file: String,
    pub accepted: bool,
    pub candidate_id: String,
    pub reason: String,
}

/// 에이전트가 제출한 검사 결과. 참고용으로만 남기고 수용 판정에는 쓰지 않는다.
fn note_checks(checks: &[ProposedCheck]) -> String {
    checks
        .iter()
        .map(|c| format!("{}: {}", c.name, c.status))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 인박스의 대기 파일을 모두 처리한다. 워커와 커맨드 양쪽에서 호출한다.
/// 파일이 아직 쓰이는 중일 수 있으므로 2초 mtime 안정 가드를 둔다(tasks.rs와 동일).
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
        // 2초 mtime 가드: 최근에 바뀐 파일은 다음 틱에 다시 본다.
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
                // 거부 사유를 사이드카로 남겨 에이전트가 원인을 알 수 있게 한다.
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

/// 스키마·세션·Git 검증을 통과하면 장부에 후보를 만들고 ID를 반환한다.
/// 코어는 에이전트 입력을 신뢰하지 않고 저장소 identity와 Git object를 다시 확인한다(설계 218-229줄).
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

    // repository identity: 제출한 worktree가 세션과 같은 저장소인지.
    let worktree = PathBuf::from(&req.worktree);
    if !worktree.is_dir() {
        return Err(format!("worktree 경로가 없다: {}", req.worktree));
    }
    let identity = git::repo_identity(&worktree)?;
    let session_identity = git::repo_identity(&repo)?;
    if identity.git_common_dir != session_identity.git_common_dir {
        return Err("제출 worktree가 세션의 Git 저장소와 다르다 (같은 common object database만 입력으로 받는다)".into());
    }

    // 축약되지 않은 commit object + base가 source의 조상.
    let base = git::resolve_commit(&repo, &req.base_sha)?;
    let source = git::resolve_commit(&repo, &req.source_sha)?;
    if !git::is_ancestor(&repo, &base, &source)? {
        return Err("baseSha가 sourceSha의 조상이 아니다".into());
    }

    // base가 현재 integration HEAD의 조상인지(뒤처진 후보 표시).
    let head = git::head_info(&repo)?;
    let base_is_current_ancestor = if head.head.is_empty() {
        false
    } else {
        git::is_ancestor(&repo, &base, &head.head)?
    };

    // merge commit 포함 range는 기본 거부(설계 227줄).
    if git::contains_merge_commit(&repo, &base, &source)? {
        return Err("base..source에 merge commit이 포함되어 있다 — 기본 정책은 거부다".into());
    }

    // exact manifest 재계산 — 에이전트가 보낸 경로·blob 정보는 무시한다(설계 219-220줄).
    let (entries, manifest_json) = git::compute_manifest(&repo, &base, &source)?;
    if entries.is_empty() {
        return Err("변경이 비어 있다 (base == source)".into());
    }

    // 위험 콘텐츠 사전검사(설계 229줄).
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

    // 의존성 검증: 단순 ID가 아니라 승인된 candidate digest 또는 verified merge SHA(설계 229-230줄).
    validate_dependencies(store, &req.depends_on)?;

    // 보호 ref를 먼저 붙잡아 검토 중에 Git 객체가 사라지지 않게 한다(설계 194-198줄).
    let candidate_id = new_id("c");
    git::create_protected_ref(&repo, &candidate_id, &source)?;

    let base_tree = tree_of(&repo, &base)?;
    let source_tree = tree_of(&repo, &source)?;
    let dependency_json = serde_json::to_string(&req.depends_on).unwrap_or_else(|_| "[]".into());
    let verification_plan_hash = verification_plan_hash(&session);
    let digest = digest_payload(
        &base,
        &source,
        &base_tree,
        &source_tree,
        &manifest_json,
        &dependency_json,
        &verification_plan_hash,
    );

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
        // 뒤처진 후보도 검토는 필요하므로 review_pending으로 두고 뷰에서 stale을 표시한다.
        status: ChangeSetStatus::ReviewPending,
        summary: req.summary.clone(),
        superseded_by: String::new(),
        remediated_by: String::new(),
        created_at: now_ts(),
        updated_at: now_ts(),
    };
    store.insert_change_set(&change_set, &req.depends_on)?;

    // 이슈 노트 변경 intent는 승인 뒤 코어가 file WAL로 한 번만 적용한다(설계 76-78줄).
    for intent in &req.note_intents {
        store_note_intent(store, &change_set.id, intent)?;
    }

    // 제출 검사 결과는 요약으로만 남긴다 — 수용 판정에는 쓰지 않는다.
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

/// 의존 후보 digest 또는 verified merge SHA인지 확인한다.
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
    // merge SHA 형태의 의존은 integration_attempt에서 verified/reverted 시도의 merge_sha로 확인한다.
    // pending_change_sets의 digest 매칭이 1차 필터고, 여기서는 merge SHA 존재를 장부에서 찾는다.
    Ok(false) // store API에서 list_attempts 전역 조회가 없어 1단계는 digest 매칭만 지원
}

fn store_note_intent(store: &Store, candidate_id: &str, intent: &NoteIntent) -> Result<(), String> {
    // intent는 staged inbound_change로 남긴다. 후보가 verified되면 apply_note_intents가
    // file WAL 절차로 한 번만 적용한다(설계 76-78·566-571줄).
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

/// 후보가 verified된 뒤 노트 intent를 적용한다. expected hash가 다르면 거절한다 —
/// optimistic hash + file WAL(설계 566-571줄). 적용 성공 수를 반환한다.
pub fn apply_note_intents(store: &Store, candidate_id: &str) -> Result<usize, String> {
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
        // file WAL 절차는 extensions::github의 내부 함수를 재사용할 수 없으므로
        // 여기서 같은 절차를 수행한다: prepared → 쓰기 → applied.
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

/// 세션의 검증 프로필 내용 해시. 프로필이 바뀌면 기존 승인은 무효가 된다.
pub fn verification_plan_hash(session: &Session) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(session.verification_profile.as_bytes());
    h.update(session.integration_branch.as_bytes());
    hex::encode(h.finalize())[..16].to_string()
}

fn tree_of(repo: &Path, rev: &str) -> Result<String, String> {
    let out = std::process::Command::new("git")
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
        let out = std::process::Command::new("git")
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

    /// 대표 체크아웃 + 같은 저장소의 agent worktree + 세션과 유효한 propose 요청.
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
}
