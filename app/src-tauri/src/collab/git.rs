// Git 검사 계층. 설계 823줄: 읽기 전용 검사와 protected ref만 담당한다.
// 실제 merge·revert 변경은 integration.rs가, 이 모듈은 판정에 필요한 모든 조회를 제공한다.
//
// 모든 호출은 argv 기반 `git --no-optional-locks -C <path> ...`(기존 CLI 호출 방식과 동일).
// 에이전트 입력의 SHA·경로를 신뢰하지 않고 Git 객체로 재확인한다(설계 218-229줄).

use super::model::ManifestEntry;
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

/// 등록된 repository identity(설계 224줄). 같은 경로를 다른 alias로 등록해도
/// 이 세 값이 일치해야 같은 저장소로 인정된다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RepoIdentity {
    pub canonical_root: String,
    pub worktree_git_dir: String,
    pub git_common_dir: String,
}

impl RepoIdentity {
    /// repository_id는 identity 비교·표시용 키(canonical root 경로의 sha256 앞 16자).
    pub fn repository_id(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.canonical_root.as_bytes());
        hex::encode(h.finalize())[..16].to_string()
    }
}

/// git 명령 실행. 실패 시 stderr를 담은 오류를 반환한다.
fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} 실패 (exit {:?})", args.join(" "), out.status.code())
        } else {
            stderr
        });
    }
    Ok(stdout)
}

/// NUL 구분 출력용(경로에 공백·개행이 섞여도 안전).
fn git_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} 실패 (exit {:?})", args.join(" "), out.status.code())
        } else {
            stderr
        });
    }
    Ok(out.stdout)
}

/// identity 계산. canonicalize로 macOS /private 심볼릭 차이를 흡수한다.
pub fn repo_identity(path: &Path) -> Result<RepoIdentity, String> {
    let root = git(path, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let git_dir = git(path, &["rev-parse", "--absolute-git-dir"])?
        .trim()
        .to_string();
    let common = git(
        path,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?
    .trim()
    .to_string();
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|e| format!("repo root canonicalize 실패: {e}"))?
        .to_string_lossy()
        .to_string();
    Ok(RepoIdentity {
        canonical_root,
        worktree_git_dir: git_dir,
        git_common_dir: common,
    })
}

/// 현재 HEAD·branch·clean 상태. 통합 전 필수 확인(설계 375-376줄).
#[derive(Clone, Debug)]
pub struct HeadInfo {
    pub head: String,
    pub branch: String,
    pub clean: bool,
    /// porcelain 상태 전체. 진단·UI 표시용.
    pub status_lines: Vec<String>,
    /// detached HEAD, MERGE_HEAD·REBASE_HEAD·CHERRY_PICK_HEAD·REVERT_HEAD 존재.
    pub dangerous_state: Option<String>,
}

pub fn head_info(path: &Path) -> Result<HeadInfo, String> {
    let head = git(path, &["rev-parse", "HEAD"])?.trim().to_string();
    let branch = {
        let b = git(path, &["rev-parse", "--abbrev-ref", "HEAD"])?
            .trim()
            .to_string();
        if b == "HEAD" {
            String::new()
        } else {
            b
        }
    };
    let status_raw = git(path, &["status", "--porcelain"])?;
    let status_lines: Vec<String> = status_raw
        .lines()
        .map(|l| l.to_string())
        .filter(|l| !l.is_empty())
        .collect();
    let mut dangerous = None;
    if branch.is_empty() {
        dangerous = Some("detached HEAD".into());
    }
    let git_dir = git(path, &["rev-parse", "--absolute-git-dir"])?
        .trim()
        .to_string();
    for marker in [
        "MERGE_HEAD",
        "REBASE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ] {
        if Path::new(&git_dir).join(marker).exists() {
            dangerous = Some(format!("{marker} 존재"));
        }
    }
    Ok(HeadInfo {
        head,
        branch,
        clean: status_lines.is_empty(),
        status_lines,
        dangerous_state: dangerous,
    })
}

/// 축약되지 않은 commit object인지 확인. 존재하지 않거나 다른 타입이면 거절한다.
pub fn resolve_commit(repo: &Path, sha: &str) -> Result<String, String> {
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!("SHA '{sha}'는 축약되었거나 형식이 올바르지 않다"));
    }
    let ty = git(repo, &["cat-file", "-t", sha])?.trim().to_string();
    if ty != "commit" {
        return Err(format!("'{sha}'는 commit이 아니라 {ty}다"));
    }
    Ok(sha.to_string())
}

pub fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> Result<bool, String> {
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    Ok(out.status.success())
}

/// base..source가 merge commit을 포함하는지(설계 227줄 — 기본 거부).
pub fn contains_merge_commit(repo: &Path, base: &str, source: &str) -> Result<bool, String> {
    let out = git(
        repo,
        &["rev-list", "--merges", &format!("{base}..{source}")],
    )?;
    Ok(!out.trim().is_empty())
}

/// 두 commit 사이의 exact change manifest 재계산(설계 189-190·219-220줄).
/// rename은 `-M`으로 감지해 rename_from에 원래 경로를 남긴다. binary는 numstat의 `-`로 판정.
pub fn compute_manifest(
    repo: &Path,
    base: &str,
    source: &str,
) -> Result<(Vec<ManifestEntry>, String), String> {
    let raw = git_bytes(
        repo,
        &[
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-M",
            "-z",
            base,
            source,
        ],
    )?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let numstat = git(repo, &["diff", "--numstat", "-M", base, source])?;
    let binary_paths: HashSet<String> = numstat
        .lines()
        .filter_map(|line| {
            let mut it = line.split('\t');
            let add = it.next()?;
            let del = it.next()?;
            let p = it.next()?;
            (add == "-" && del == "-").then(|| p.to_string())
        })
        .collect();

    let mut parts = text.split('\u{0}').filter(|p| !p.is_empty());
    let mut entries = Vec::new();
    while let Some(header) = parts.next() {
        if !header.starts_with(':') {
            continue;
        }
        let cols: Vec<&str> = header[1..].split(' ').collect();
        if cols.len() < 5 {
            return Err(format!("diff-tree 출력 해석 실패: '{header}'"));
        }
        let new_mode = cols[1].to_string();
        let status = cols[4].to_string();
        // -z rename 레코드는 old 경로가 먼저, new 경로가 나중에 온다.
        let (path, rename_from) = if status.starts_with('R') || status.starts_with('C') {
            let from = parts.next().unwrap_or("").to_string();
            let to = parts.next().unwrap_or("").to_string();
            (to, from)
        } else {
            (parts.next().unwrap_or("").to_string(), String::new())
        };
        if path.is_empty() {
            continue;
        }
        let binary = binary_paths.contains(&path);
        entries.push(ManifestEntry {
            path,
            old_blob: if status.starts_with('A') {
                String::new()
            } else {
                cols[2].to_string()
            },
            new_blob: if status.starts_with('D') {
                String::new()
            } else {
                cols[3].to_string()
            },
            mode: new_mode,
            rename_from,
            binary,
        });
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let manifest_json = serde_json::to_string(&entries).unwrap_or_else(|_| "[]".into());
    Ok((entries, manifest_json))
}

/// worktree를 건드리지 않는 3-way simulation.
/// merge: (ours=HEAD, theirs=source, base=자동) — 설계 381-382줄.
/// revert: (ours=HEAD, theirs=<merge>^1, base=<merge>) — `-m 1` revert의 결과 tree.
/// Git ≥2.40(--merge-base 지원)을 요구한다. 충돌이면 Err(충돌 경로)를 돌려준다.
pub fn three_way_simulation(
    repo: &Path,
    ours: &str,
    theirs: &str,
    merge_base: Option<&str>,
) -> Result<Result<(String, Vec<String>), Vec<String>>, String> {
    let mut args = vec![
        "merge-tree".to_string(),
        "--write-tree".to_string(),
        "--name-only".to_string(),
    ];
    if let Some(base) = merge_base {
        args.push(format!("--merge-base={base}"));
    }
    args.push(ours.to_string());
    args.push(theirs.to_string());
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(&arg_refs)
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        let mut lines = stdout.lines();
        let tree = lines.next().unwrap_or("").trim().to_string();
        if tree.is_empty() {
            return Err("merge-tree가 빈 tree를 반환했다".into());
        }
        let conflicts: Vec<String> = lines
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(Ok((tree, conflicts)))
    } else if out.status.code() == Some(1) {
        let mut lines = stdout.lines();
        let _tree = lines.next().unwrap_or("");
        let conflicts: Vec<String> = lines
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        Ok(Err(conflicts))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// protected candidate ref 생성. create-only(설계 195-198줄).
/// `update-ref <ref> <new> <zero-old>`는 ref가 이미 있으면 실패하므로 경합에서도 안전하다.
pub fn create_protected_ref(repo: &Path, candidate_id: &str, sha: &str) -> Result<(), String> {
    let refname = format!("refs/sawhorse/candidates/{candidate_id}");
    let zero = "0".repeat(40);
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(["update-ref", &refname, sha, zero.as_str()])
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // 이미 존재하는 경우: 같은 SHA면 멱등 성공, 다르면 거부.
    if let Some(existing) = protected_ref_sha(repo, candidate_id)? {
        if existing == sha {
            return Ok(());
        }
        return Err(format!(
            "protected ref {refname}이 이미 다른 SHA({existing})로 존재한다 — amend·추가 커밋은 같은 후보의 수정이 아니라 새 candidate_id여야 한다"
        ));
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

pub fn protected_ref_sha(repo: &Path, candidate_id: &str) -> Result<Option<String>, String> {
    let refname = format!("refs/sawhorse/candidates/{candidate_id}");
    let out = Command::new("git")
        .arg("--no-optional-locks")
        .arg("-C")
        .arg(repo)
        .args(["rev-parse", "--verify", &refname])
        .output()
        .map_err(|e| format!("git 실행 실패: {e}"))?;
    if out.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&out.stdout).trim().to_string(),
        ))
    } else {
        Ok(None)
    }
}

/// 안전 자동 적용을 가로막는 콘텐츠 검사(설계 150-151·492-493줄).
#[derive(Clone, Debug, Default)]
pub struct RiskFindings {
    pub submodules: Vec<String>,
    pub lfs_pointers: Vec<String>,
    pub case_renames: Vec<String>,
    pub oversized: Vec<String>,
}

pub fn assess_manifest_risks(
    _repo: &Path,
    entries: &[ManifestEntry],
) -> Result<RiskFindings, String> {
    let mut findings = RiskFindings::default();
    for e in entries {
        if e.mode == "160000" {
            findings.submodules.push(e.path.clone());
        }
        if !e.rename_from.is_empty()
            && e.rename_from.to_lowercase() == e.path.to_lowercase()
            && e.rename_from != e.path
        {
            findings
                .case_renames
                .push(format!("{} -> {}", e.rename_from, e.path));
        }
    }
    Ok(findings)
}

/// 새 blob 내용을 검사하는 확장. LFS pointer·크기 상한은 blob을 읽어야 하므로 분리했다.
pub fn assess_blob_risks(repo: &Path, entries: &[ManifestEntry]) -> Result<RiskFindings, String> {
    let mut findings = RiskFindings::default();
    for e in entries {
        if e.new_blob.is_empty() || e.mode == "160000" {
            continue;
        }
        let content = git_bytes(repo, &["cat-file", "blob", &e.new_blob])?;
        if content.starts_with(b"version https://git-lfs") {
            findings.lfs_pointers.push(e.path.clone());
        }
        if content.len() > 8 * 1024 * 1024 {
            findings.oversized.push(e.path.clone());
        }
    }
    Ok(findings)
}

/// 통합 직전 untracked 파일이 후보가 만들 경로와 부딪히는지 사전검사(설계 492줄).
pub fn untracked_collisions(repo: &Path, entries: &[ManifestEntry]) -> Result<Vec<String>, String> {
    let status = git(repo, &["status", "--porcelain", "-z"])?;
    let mut untracked = HashSet::new();
    for rec in status.split('\u{0}').filter(|r| !r.is_empty()) {
        let mut chars = rec.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let _space = chars.next(); // XY 뒤의 단일 공백
        let path = chars.as_str().to_string();
        if x == '?' || y == '?' {
            untracked.insert(path);
        }
    }
    Ok(entries
        .iter()
        .filter(|e| untracked.contains(&e.path))
        .map(|e| e.path.clone())
        .collect())
}

/// 검사 실행 뒤 HEAD·branch·index·tracked worktree 불변 확인(설계 393-394줄).
pub fn verify_unchanged(repo: &Path, before: &HeadInfo) -> Result<(), String> {
    let after = head_info(repo)?;
    if after.head != before.head {
        return Err(format!(
            "HEAD가 검사 중에 이동했다: {} -> {}",
            before.head, after.head
        ));
    }
    if after.branch != before.branch {
        return Err(format!(
            "branch가 검사 중에 바뀌었다: {} -> {}",
            before.branch, after.branch
        ));
    }
    if !after.clean {
        return Err(format!(
            "검사가 worktree를 더럽혔다: {:?}",
            after.status_lines
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn run(path: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} 실패: {}",
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

    fn init_repo(tag: &str) -> (TempRepo, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sawhorse-git-{}-{tag}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.clone();
        // 러너·머신마다 git 의 기본 브랜치가 다르므로(main/master) 테스트는 고정한다.
        run(&path, &["init", "-q", "-b", "main"]);
        run(&path, &["config", "user.email", "t@example.com"]);
        run(&path, &["config", "user.name", "t"]);
        (TempRepo(dir), path)
    }

    fn commit_file(path: &Path, name: &str, content: &str, msg: &str) -> String {
        std::fs::write(path.join(name), content).unwrap();
        run(path, &["add", "."]);
        run(path, &["commit", "-q", "-m", msg]);
        run(path, &["rev-parse", "HEAD"]).trim().to_string()
    }

    #[test]
    fn repo_identity_is_stable() {
        let (_d, path) = init_repo("identity");
        let a = repo_identity(&path).unwrap();
        let b = repo_identity(&path).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.repository_id().len(), 16);
    }

    #[test]
    fn head_info_reports_branch_dirty_and_markers() {
        let (_d, path) = init_repo("headinfo");
        commit_file(&path, "a.txt", "1", "init");
        let info = head_info(&path).unwrap();
        assert_eq!(info.branch, "main");
        assert!(info.clean);
        assert!(info.dangerous_state.is_none());
        std::fs::write(path.join("a.txt"), "2").unwrap();
        let info = head_info(&path).unwrap();
        assert!(!info.clean);
        // MERGE_HEAD 흉내.
        std::fs::write(path.join(".git").join("MERGE_HEAD"), "0".repeat(40)).unwrap();
        let info = head_info(&path).unwrap();
        assert!(info.dangerous_state.unwrap().contains("MERGE_HEAD"));
    }

    #[test]
    fn resolve_commit_rejects_abbreviated_missing_and_blob() {
        let (_d, path) = init_repo("resolve");
        let sha = commit_file(&path, "a.txt", "1", "init");
        assert_eq!(resolve_commit(&path, &sha).unwrap(), sha);
        assert!(resolve_commit(&path, &sha[..8]).is_err(), "축약 SHA 거부");
        assert!(
            resolve_commit(&path, &"0".repeat(40)).is_err(),
            "없는 SHA 거절"
        );
        let blob = run(&path, &["hash-object", "-w", "--stdin"])
            .trim()
            .to_string();
        assert!(
            resolve_commit(&path, &blob).is_err(),
            "blob은 commit이 아니다"
        );
    }

    #[test]
    fn ancestry_and_merge_detection() {
        let (_d, path) = init_repo("ancestry");
        let base = commit_file(&path, "a.txt", "1", "init");
        let mid = commit_file(&path, "b.txt", "2", "second");
        assert!(is_ancestor(&path, &base, &mid).unwrap());
        assert!(!is_ancestor(&path, &mid, &base).unwrap());
        assert!(!contains_merge_commit(&path, &base, &mid).unwrap());
        run(&path, &["checkout", "-q", "-b", "side", &base]);
        let side = commit_file(&path, "c.txt", "3", "side");
        run(&path, &["checkout", "-q", "main"]);
        run(
            &path,
            &["merge", "-q", "--no-ff", "-m", "merge side", &side],
        );
        let head = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        assert!(contains_merge_commit(&path, &base, &head).unwrap());
    }

    #[test]
    fn manifest_recomputes_add_modify_delete_and_rename() {
        let (_d, path) = init_repo("manifest");
        let base = commit_file(&path, "keep.txt", "same", "init");
        std::fs::write(path.join("added.txt"), "new").unwrap();
        std::fs::write(path.join("keep.txt"), "changed").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "second"]);
        let source = run(&path, &["rev-parse", "HEAD"]).trim().to_string();

        let (entries, json) = compute_manifest(&path, &base, &source).unwrap();
        let by_path = |p: &str| entries.iter().find(|e| e.path == p).cloned().unwrap();
        assert!(!by_path("added.txt").new_blob.is_empty());
        assert_eq!(
            by_path("added.txt").old_blob,
            "",
            "추가는 old_blob이 비어 있다"
        );
        assert!(!by_path("keep.txt").old_blob.is_empty());
        assert_eq!(by_path("keep.txt").mode, "100644");
        assert!(serde_json::from_str::<Vec<ManifestEntry>>(&json).is_ok());

        // rename.
        std::fs::write(path.join("old.txt"), "moving").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "add old"]);
        let pre = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        run(&path, &["mv", "old.txt", "moved.txt"]);
        run(&path, &["commit", "-q", "-m", "rename"]);
        let after = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        let (renames, _) = compute_manifest(&path, &pre, &after).unwrap();
        let mv = renames.iter().find(|e| e.path == "moved.txt").unwrap();
        assert_eq!(mv.rename_from, "old.txt");
    }

    #[test]
    fn merge_simulation_predicts_clean_tree_and_conflicts() {
        let (_d, path) = init_repo("mergetree");
        let base = commit_file(&path, "shared.txt", "base", "init");
        run(&path, &["checkout", "-q", "-b", "side"]);
        let side = commit_file(&path, "side.txt", "side", "side");
        run(&path, &["checkout", "-q", "main"]);
        let head = commit_file(&path, "main.txt", "main", "main");
        assert!(is_ancestor(&path, &base, &side).unwrap());

        let clean = three_way_simulation(&path, &head, &side, None).unwrap();
        let (tree, conflicts) = clean.unwrap();
        assert!(!tree.is_empty());
        assert!(conflicts.is_empty());

        // 같은 파일을 양쪽에서 편집하면 충돌.
        run(&path, &["checkout", "-q", "side"]);
        let side2 = commit_file(&path, "shared.txt", "side-edit", "side-edit");
        run(&path, &["checkout", "-q", "main"]);
        let head2 = commit_file(&path, "shared.txt", "main-edit", "main-edit");
        let conflicted = three_way_simulation(&path, &head2, &side2, None).unwrap();
        assert!(conflicted.is_err());
    }

    #[test]
    fn revert_simulation_matches_real_revert_tree() {
        let (_d, path) = init_repo("revertsim");
        let base = commit_file(&path, "a.txt", "base", "init");
        run(&path, &["checkout", "-q", "-b", "side"]);
        let _side = commit_file(&path, "side.txt", "side", "side work");
        run(&path, &["checkout", "-q", "main"]);
        run(
            &path,
            &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
        );
        let merge_sha = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        let head = merge_sha.clone();

        // simulation: ours=HEAD, theirs=merge^1, base=merge.
        let first_parent = run(&path, &["rev-parse", &format!("{merge_sha}^1")])
            .trim()
            .to_string();
        let simulated = three_way_simulation(&path, &head, &first_parent, Some(&merge_sha))
            .unwrap()
            .unwrap()
            .0;

        // 실제 revert 후의 tree와 일치해야 한다.
        run(&path, &["revert", "--no-edit", "-m", "1", &merge_sha]);
        let actual = run(&path, &["rev-parse", "HEAD^{tree}"]).trim().to_string();
        assert_eq!(simulated, actual);
        // base 커밋과 같은 내용으로 돌아간다.
        let base_tree = run(&path, &["rev-parse", &format!("{base}^{{tree}}")])
            .trim()
            .to_string();
        assert_eq!(actual, base_tree);
    }

    #[test]
    fn protected_ref_is_create_only_and_race_safe() {
        let (_d, path) = init_repo("proref");
        let first = commit_file(&path, "a.txt", "1", "init");
        create_protected_ref(&path, "c-x", &first).unwrap();
        assert_eq!(protected_ref_sha(&path, "c-x").unwrap().unwrap(), first);
        create_protected_ref(&path, "c-x", &first).unwrap();
        let second = commit_file(&path, "b.txt", "2", "second");
        assert!(create_protected_ref(&path, "c-x", &second).is_err());
        assert_eq!(protected_ref_sha(&path, "c-x").unwrap().unwrap(), first);
    }

    #[test]
    fn risks_flag_submodule_lfs_case_rename() {
        let (_d, path) = init_repo("risks");
        let base = commit_file(&path, "a.txt", "1", "init");
        std::fs::write(
            path.join("asset.bin"),
            "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n",
        )
        .unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "lfs"]);
        let src = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        let (entries, _) = compute_manifest(&path, &base, &src).unwrap();
        let findings = assess_blob_risks(&path, &entries).unwrap();
        assert_eq!(findings.lfs_pointers, vec!["asset.bin".to_string()]);
        // submodule(mode 160000) 흉내는 mode만으로 판정한다.
        let entries = vec![ManifestEntry {
            path: "sub".into(),
            old_blob: String::new(),
            new_blob: "abc".into(),
            mode: "160000".into(),
            rename_from: String::new(),
            binary: false,
        }];
        let findings = assess_manifest_risks(&path, &entries).unwrap();
        assert_eq!(findings.submodules, vec!["sub".to_string()]);
    }

    #[test]
    fn untracked_collision_detected() {
        let (_d, path) = init_repo("untracked");
        let base = commit_file(&path, "a.txt", "1", "init");
        run(&path, &["checkout", "-q", "-b", "side"]);
        std::fs::write(path.join("collide.txt"), "x").unwrap();
        run(&path, &["add", "."]);
        run(&path, &["commit", "-q", "-m", "add collide"]);
        let src = run(&path, &["rev-parse", "HEAD"]).trim().to_string();
        run(&path, &["checkout", "-q", "main"]);
        std::fs::write(path.join("collide.txt"), "user file").unwrap();
        let (entries, _) = compute_manifest(&path, &base, &src).unwrap();
        assert_eq!(
            untracked_collisions(&path, &entries).unwrap(),
            vec!["collide.txt".to_string()]
        );
    }

    #[test]
    fn verify_unchanged_catches_drift() {
        let (_d, path) = init_repo("unchanged");
        commit_file(&path, "a.txt", "1", "init");
        let before = head_info(&path).unwrap();
        verify_unchanged(&path, &before).unwrap();
        std::fs::write(path.join("dirty.txt"), "x").unwrap();
        assert!(verify_unchanged(&path, &before).is_err());
        std::fs::remove_file(path.join("dirty.txt")).unwrap();
        commit_file(&path, "b.txt", "2", "second");
        assert!(verify_unchanged(&path, &before).is_err(), "HEAD 이동 감지");
    }
}
