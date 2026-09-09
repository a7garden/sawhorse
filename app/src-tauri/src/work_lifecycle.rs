//! SDD v2 decisions and the durable agent interview/completion protocol.
//! Work stage is authoritative in work.md; this sidecar holds evidence and queue state.
use super::*;
use serde_json::json;

pub fn supports(work: &WorkItem) -> bool {
    work.workflow_id == "intent-flow" && work.workflow_version == "2.0.0"
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Interview {
    pub id: String,
    pub run_id: String,
    pub stage: String,
    pub question: String,
    pub options: Vec<String>,
    pub answer: String,
    pub answered_at: String,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Lifecycle {
    pub revision: u64,
    pub clarified: bool,
    pub queued: bool,
    pub error: String,
    pub scope: Vec<String>,
    pub interviews: Vec<Interview>,
    pub commits: Vec<String>,
    pub revert_commits: Vec<String>,
    pub run_id: String,
    pub run_repo: String,
    pub base_commit: String,
    pub target_ref: String,
    pub target_repo: String,
    pub processed: Vec<String>,
    pub approved_inputs: Vec<String>,
    pub integration_pending: bool,
    pub integration_before: String,
    pub integration_sources: Vec<String>,
    pub integrated_run: String,
    pub messages: Vec<PeerMessage>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PeerMessage {
    pub from: String,
    pub to: String,
    pub text: String,
    pub at: String,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentRequest {
    pub id: String,
    pub kind: String,
    pub question: String,
    pub options: Vec<String>,
    pub depends_on: Vec<String>,
    pub scope: Vec<String>,
    pub commits: Vec<String>,
    pub to: String,
    pub text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionInput {
    pub work_id: String,
    pub action: String,
    pub expected_stage: String,
    pub revision: u64,
    pub note: String,
    pub input_digest: String,
}

fn state_path(root: &Path, id: &str) -> PathBuf {
    work_path(root, id).with_file_name("lifecycle.json")
}
pub fn read(root: &Path, id: &str) -> Result<Lifecycle, String> {
    validate_id(id)?;
    let path = state_path(root, id);
    safe_path(root, &path)?;
    if !path.exists() {
        return Ok(Lifecycle::default());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn save(root: &Path, id: &str, state: &mut Lifecycle) -> Result<(), String> {
    state.revision += 1;
    write_atomic(
        root,
        &state_path(root, id),
        &serde_json::to_string_pretty(state).map_err(|e| e.to_string())?,
    )
}
fn persist_work(
    root: &Path,
    work: &mut WorkItem,
    stage: &str,
    status: &str,
    note: &str,
) -> Result<(), String> {
    work.decisions.push(Decision {
        stage: work.stage.clone(),
        at: now(),
        note: note.into(),
    });
    work.stage = stage.into();
    work.status = status.into();
    work.updated_at = now();
    apply_closure(work);
    let mut header = work.clone();
    header.description.clear();
    write_atomic(
        root,
        &work_path(root, &work.id),
        &markdown(&header, &work.description)?,
    )
}
fn require_docs(root: &Path, work: &WorkItem, roles: &[&str]) -> Result<(), String> {
    for role in roles {
        if !substantial(&read_document(root, &work.id, role)?.markdown) {
            return Err(format!("{role}.md에 실질적인 내용이 필요합니다"));
        }
    }
    Ok(())
}
fn approved_inputs(root: &Path, work: &WorkItem) -> Result<Vec<String>, String> {
    let mut inputs = intent_design_revisions(root, &work.id)?;
    inputs.push(serde_json::to_string(&work.depends_on).map_err(|e| e.to_string())?);
    inputs.push(work.project_id.clone());
    if !work.project_id.is_empty() {
        let project = project_by_id(root, &work.project_id)?;
        inputs.push(project.repo_path);
        inputs.push(serde_json::to_string(&project.verify_commands).map_err(|e| e.to_string())?);
    }
    inputs.push(resources::design_digest(root, &work.project_id)?);
    Ok(inputs)
}
pub fn check_approval(root: &Path, work: &WorkItem) -> Result<(), String> {
    if !supports(work) || !matches!(work.stage.as_str(), "queued" | "build" | "unconfirmed") {
        return Ok(());
    }
    if read(root, &work.id)?.approved_inputs != approved_inputs(root, work)? {
        return Err(
            "의도·설계·의존성·프로젝트 디자인이 승인 이후 변경되었습니다. 설계를 다시 검토하세요"
                .into(),
        );
    }
    Ok(())
}
fn dependents(root: &Path, id: &str) -> Result<Vec<WorkItem>, String> {
    let work = snapshot(root)?.work;
    let mut ids = HashSet::from([id.to_string()]);
    loop {
        let old = ids.len();
        for item in &work {
            if !matches!(item.stage.as_str(), "cancelled" | "discarded")
                && !matches!(item.status.as_str(), "cancelled" | "rejected")
                && item.depends_on.iter().any(|d| ids.contains(d))
            {
                ids.insert(item.id.clone());
            }
        }
        if ids.len() == old {
            break;
        }
    }
    Ok(work
        .into_iter()
        .filter(|w| w.id != id && ids.contains(&w.id))
        .collect())
}
#[tauri::command]
pub fn sdd_lifecycle(work_id: String) -> Result<Lifecycle, String> {
    read(&vault_root()?, &work_id)
}
#[tauri::command]
pub fn sdd_discard_impact(work_id: String) -> Result<Vec<WorkItem>, String> {
    dependents(&vault_root()?, &work_id)
}
#[tauri::command]
pub fn sdd_lifecycle_action(input: ActionInput) -> Result<WorkItem, String> {
    action_at(&vault_root()?, input)
}
pub fn action_at(root: &Path, input: ActionInput) -> Result<WorkItem, String> {
    let _guard = mutation_lock();
    let mut work = work_by_id(root, &input.work_id)?;
    if !supports(&work) {
        return Err("SDD v2 작업이 아닙니다".into());
    }
    let mut state = read(root, &work.id)?;
    if input.expected_stage != work.stage || input.revision != state.revision {
        return Err("작업이 변경되었습니다. 새 상태를 읽고 다시 시도하세요".into());
    }
    if input.note.trim().is_empty() {
        return Err("결정 사유가 필요합니다".into());
    }
    if crate::sdlc_harness::has_active_work(root, &work.id)? {
        return Err("실행을 중단하거나 끝날 때까지 기다린 뒤 결정하세요".into());
    }
    let stage = work.stage.as_str();
    if matches!(input.action.as_str(), "design" | "approve")
        && state.interviews.iter().any(|q| q.answer.is_empty())
    {
        return Err("대기 중인 인터뷰에 먼저 답해주세요".into());
    }
    let (next, status) = match (input.action.as_str(), stage) {
        ("clarify", "inbox") => ("clarify", "ready"),
        ("design", "clarify") if state.clarified => {
            require_docs(root, &work, &["brief"])?;
            ("design", "ready")
        }
        ("approve", "approval") => {
            if input.input_digest.is_empty()
                || input.input_digest != work_input_digest(root, &work)?
            {
                return Err("읽고 검토한 설계 버전이 필요합니다. 새로고침하세요".into());
            }
            require_docs(root, &work, &["intent", "brief", "spec", "plan"])?;
            validate_work_graph(root, &work)?;
            if state.scope.is_empty() {
                return Err("설계에 변경 범위가 기록되어야 합니다".into());
            }
            state.approved_inputs = approved_inputs(root, &work)?;
            write_atomic(
                root,
                &work_path(root, &work.id).with_file_name("approved-design.json"),
                &serde_json::to_string(&intent_design_revisions(root, &work.id)?)
                    .map_err(|e| e.to_string())?,
            )?;
            intent_history::capture(root, &work, "design-review", &input.note)?;
            work.approve = true;
            work.approved = Utc::now().date_naive().to_string();
            ("queued", "ready")
        }
        ("revise", "approval" | "queued") => {
            state.queued = false;
            state.approved_inputs.clear();
            work.approve = false;
            ("design", "ready")
        }
        ("confirm", "unconfirmed") => {
            check_approval(root, &work)?;
            intent_history::capture(root, &work, "result-review", &input.note)?;
            ("done", "done")
        }
        ("cancel", "inbox" | "clarify" | "design" | "approval" | "queued") => {
            let affected = dependents(root, &work.id)?;
            if !affected.is_empty() {
                return Err(format!(
                    "먼저 의존 작업을 취소하거나 의존성을 수정하세요: {}",
                    affected
                        .iter()
                        .map(|w| w.title.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            state.queued = false;
            ("cancelled", "cancelled")
        }
        ("discard", "unconfirmed" | "done") => {
            let affected = dependents(root, &work.id)?;
            if !affected.is_empty() {
                return Err(format!(
                    "먼저 후행 의존 작업을 폐기·취소하세요: {}",
                    affected
                        .iter()
                        .map(|w| w.title.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            if state.commits.is_empty() {
                return Err("폐기할 구현 커밋 기록이 없습니다".into());
            }
            state.run_repo.clear();
            state.run_id.clear();
            state.base_commit.clear();
            state.queued = true;
            ("discarding", "ready")
        }
        ("retry", "build" | "discarding") => {
            recover_integration(root, &work, &mut state)?;
            if !state.integrated_run.is_empty() && state.integrated_run == state.run_id {
                state.queued = false;
                if stage == "discarding" {
                    ("discarded", "cancelled")
                } else {
                    ("unconfirmed", "review")
                }
            } else {
                state.queued = true;
                (stage, "ready")
            }
        }
        _ => return Err("현재 단계에서 할 수 없는 결정입니다".into()),
    };
    let next = next.to_string();
    state.error.clear();
    save(root, &work.id, &mut state)?;
    persist_work(
        root,
        &mut work,
        &next,
        status,
        &format!("{}: {}", input.action, input.note),
    )?;
    Ok(work)
}
#[tauri::command]
pub fn sdd_queue_implementation(work_ids: Vec<String>) -> Result<(), String> {
    queue_at(&vault_root()?, &work_ids)
}
fn queue_at(root: &Path, work_ids: &[String]) -> Result<(), String> {
    let _guard = mutation_lock();
    if work_ids.is_empty() || work_ids.len() > 100 {
        return Err("구현 대기 작업을 1~100개 선택하세요".into());
    }
    let unique: HashSet<_> = work_ids.iter().collect();
    if unique.len() != work_ids.len() {
        return Err("작업 ID가 중복되었습니다".into());
    }
    // Validate the whole selection before any writes. Dependency readiness is checked by the scheduler.
    for id in work_ids {
        let work = work_by_id(root, id)?;
        if !supports(&work) || work.stage != "queued" {
            return Err(format!("구현 대기 상태가 아닙니다: {id}"));
        }
        check_approval(root, &work)?;
    }
    for id in work_ids {
        let mut state = read(root, id)?;
        state.queued = true;
        state.error.clear();
        save(root, id, &mut state)?;
    }
    Ok(())
}

pub fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = crate::spawn::no_window(std::process::Command::new("git"))
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
fn full_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}
fn path_allowed(file: &str, scopes: &[String]) -> bool {
    scopes.iter().any(|s| {
        s == "." || file == s || file.starts_with(&format!("{}/", s.trim_end_matches('/')))
    })
}
fn validate_scope(scope: &[String]) -> Result<(), String> {
    if scope.is_empty() || scope.len() > 200 {
        return Err("변경 범위는 1~200개 경로로 지정하세요".into());
    }
    for path in scope {
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\\')
            || path.contains(':')
            || path.split('/').any(|p| p == ".." || p == ".git")
        {
            return Err(format!("저장소 상대 경로가 아닙니다: {path}"));
        }
    }
    Ok(())
}
fn overlap(a: &[String], b: &[String]) -> bool {
    a.iter().any(|p| path_allowed(p, b)) || b.iter().any(|p| path_allowed(p, a))
}
fn dependency_ready(work: &WorkItem, all: &[WorkItem]) -> bool {
    work.depends_on.iter().all(|id| {
        all.iter().any(|d| {
            d.id == *id && (d.status == "done" || (supports(d) && d.stage == "unconfirmed"))
        })
    })
}
/// Called under the launch mutex, before constructing the run prompt.
pub fn prepare_repository(
    root: &Path,
    work: &WorkItem,
    run_id: &str,
    repo: &str,
) -> Result<String, String> {
    if !supports(work) || !matches!(work.stage.as_str(), "build" | "discarding") {
        return Ok(repo.into());
    }
    let _guard = mutation_lock();
    let mut state = read(root, &work.id)?;
    if state.integration_pending {
        return Err("중단된 Git 통합을 확인해야 합니다".into());
    }
    if !state.run_repo.is_empty() && Path::new(&state.run_repo).is_dir() {
        return Ok(state.run_repo);
    }
    let base = git(Path::new(repo), &["rev-parse", "HEAD"])?;
    let target_ref = git(Path::new(repo), &["symbolic-ref", "--quiet", "HEAD"])
        .map_err(|_| "구현 대상 저장소에서 브랜치를 체크아웃하세요".to_string())?;
    state.target_ref = target_ref;
    state.target_repo = Path::new(repo)
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let folder = root.join("runs/worktrees").join(run_id);
    safe_path(root, &folder)?;
    fs::create_dir_all(folder.parent().unwrap()).map_err(|e| e.to_string())?;
    git(
        Path::new(repo),
        &[
            "worktree",
            "add",
            "--detach",
            &folder.to_string_lossy(),
            &base,
        ],
    )?;
    state.base_commit = base;
    state.run_repo = folder.to_string_lossy().into_owned();
    save(root, &work.id, &mut state)?;
    Ok(state.run_repo)
}
pub fn record_launch(
    root: &Path,
    work: &WorkItem,
    stage: &str,
    run_id: &str,
) -> Result<(), String> {
    let _guard = mutation_lock();
    let mut current = work_by_id(root, &work.id)?;
    if current.stage != stage || !matches!(stage, "clarify" | "design" | "build" | "discarding") {
        return Err("실행 단계가 변경되었습니다".into());
    }
    let mut state = read(root, &work.id)?;
    if state.interviews.iter().any(|q| q.answer.is_empty()) {
        return Err("대기 중인 인터뷰에 먼저 답해주세요".into());
    }
    state.run_id = run_id.into();
    if stage == "clarify" {
        state.clarified = false;
    }
    state.queued = false;
    state.error.clear();
    save(root, &work.id, &mut state)?;
    intent_history::capture(root, &current, "run-input", run_id)?;
    persist_work(
        root,
        &mut current,
        stage,
        "running",
        &format!("에이전트 실행: {run_id}"),
    )
}

pub fn protocol_prompt(root: &Path, work: &WorkItem, run_id: &str) -> Result<String, String> {
    let design = resources::project_context(root, &work.project_id)?;
    if !supports(work) {
        return Ok(design);
    }
    let state = read(root, &work.id)?;
    let request_dir = root.join("runs/protocol").join(run_id);
    safe_path(root, &request_dir)?;
    fs::create_dir_all(&request_dir).map_err(|e| e.to_string())?;
    Ok(format!(
        r#"
{design}
SDD v2 host protocol (never edit lifecycle.json or work.md):
Write one JSON request per unique id atomically to {requests}/<id>.json. Read <id>.reply for the host response. Requests are consumed periodically.
Interview: {{"id":"unique-id","kind":"question","question":"one self-contained question","options":["choice"]}}. Write the question then finish your turn; the app shows an interview panel. Never invent an answer or mark complete with unanswered questions. Answers are preserved below and in reply files.
Completion: {{"id":"unique-id","kind":"complete","dependsOn":["work-id"],"scope":["src/file.ts"],"commits":["full SHA"]}}. Finish your turn after writing evidence and this request. The host validates output and recorded commits before advancing. An idle turn alone never advances a work item. For design, dependencies and scope are mandatory (use [] when no dependencies). For build/discarding, every commit since the supplied base must be listed oldest first and include the exact trailer Sawhorse-Work: {work_id}. No uncommitted files may remain. In verification.md (or rollback.md), include result: passed, command: <actual verification command>, exitCode: 0, codeRevision: <last submitted full commit SHA>. A failing or unverified result must remain in implementation. These fields describe real checks; never fabricate evidence.
A2A is enabled: inspect {vault}/work/*/work.md and lifecycle.json for peer stages, priorities, scope and messages. Message a related peer via {{"id":"unique-id","kind":"message","to":"work-id","text":"scope conflict or coordination request"}}. Poll your lifecycle.json messages and request replies while working. The host serializes overlapping scopes, prioritizes urgent/high work and waits for dependencies; independent scopes execute in parallel in separate worktrees. If you discover overlap, send a message and yield the conflicting change; do not overwrite a peer's scope. Do not edit another run's files. Only commit your approved files. Git integration is host owned.
Original implementation hashes (for discard): {commits}
Assigned worktree base: {base}
Approved scope: {scope}
Interview history: {interviews}
"#,
        requests = request_dir.display(),
        vault = root.display(),
        work_id = work.id,
        commits = serde_json::to_string(&state.commits).unwrap(),
        base = state.base_commit,
        scope = serde_json::to_string(&state.scope).unwrap(),
        interviews = serde_json::to_string(&state.interviews).unwrap()
    ))
}

fn integrate(
    root: &Path,
    work: &WorkItem,
    state: &mut Lifecycle,
    commits: &[String],
) -> Result<Vec<String>, String> {
    recover_integration(root, work, state)?;
    if !state.integrated_run.is_empty() && state.integrated_run == state.run_id {
        return Ok(if work.stage == "discarding" {
            state.revert_commits.clone()
        } else {
            state.commits.clone()
        });
    }
    if commits.is_empty() || commits.iter().any(|s| !full_sha(s)) {
        return Err("전체 커밋 해시가 필요합니다".into());
    }
    if state.integration_pending {
        return Err("이전 Git 통합이 중단되었습니다. 저장소 이력을 확인하세요".into());
    }
    let repo = Path::new(&state.run_repo);
    if !git(repo, &["status", "--porcelain"])?.is_empty() {
        return Err("실행 worktree에 커밋되지 않은 변경이 있습니다".into());
    }
    git(
        repo,
        &["merge-base", "--is-ancestor", &state.base_commit, "HEAD"],
    )?;
    let range = format!("{}..HEAD", state.base_commit);
    let actual = git(repo, &["rev-list", "--reverse", &range])?
        .lines()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if actual != commits {
        return Err("실제 worktree 커밋과 제출한 해시가 일치하지 않습니다".into());
    }
    if !git(repo, &["rev-list", "--merges", &range])?.is_empty() {
        return Err("구현 범위에 병합 커밋을 포함할 수 없습니다".into());
    }
    for sha in commits {
        let paths = git(
            repo,
            &[
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                "-z",
                sha,
            ],
        )?;
        if paths
            .split('\0')
            .filter(|p| !p.is_empty())
            .any(|p| !path_allowed(p, &state.scope))
        {
            return Err(format!("승인 범위 밖의 변경을 포함하는 커밋입니다: {sha}"));
        }
        let message = git(repo, &["log", "-1", "--format=%B", sha])?;
        if !message
            .lines()
            .any(|l| l == format!("Sawhorse-Work: {}", work.id))
        {
            return Err(format!("작업 소유권 trailer가 없습니다: {sha}"));
        }
    }
    if work.stage == "discarding" {
        let messages = commits
            .iter()
            .map(|sha| git(repo, &["log", "-1", "--format=%B", sha]))
            .collect::<Result<Vec<_>, _>>()?
            .join("\n");
        for original in &state.commits {
            if !messages.contains(&format!("This reverts commit {original}")) {
                return Err(format!("되돌린 원본 커밋 기록이 없습니다: {original}"));
            }
        }
    }
    let files = git(
        repo,
        &["diff", "--name-only", "-z", &state.base_commit, "HEAD"],
    )?;
    if files
        .split('\0')
        .filter(|p| !p.is_empty())
        .any(|p| !path_allowed(p, &state.scope))
    {
        return Err("승인된 변경 범위 밖의 커밋입니다. 설계 범위를 확인하세요".into());
    }
    let project = project_by_id(root, &work.project_id)?;
    let target = Path::new(&project.repo_path);
    if target
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        != state.target_repo
        || git(target, &["symbolic-ref", "--quiet", "HEAD"])? != state.target_ref
    {
        return Err("구현 시작 후 대상 저장소 또는 브랜치가 변경되었습니다. 원래 브랜치로 돌아온 뒤 다시 시도하세요".into());
    }
    if !git(target, &["status", "--porcelain"])?.is_empty() {
        return Err(
            "프로젝트에 미커밋 변경이 있어 통합을 기다립니다. 사용자 변경을 먼저 정리하세요".into(),
        );
    }
    let before = git(target, &["rev-parse", "HEAD"])?;
    state.integration_before = before.clone();
    state.integration_sources = commits.to_vec();
    state.integration_pending = true;
    save(root, &work.id, state)?;
    let mut args = vec!["cherry-pick", "-x"];
    args.extend(commits.iter().map(String::as_str));
    if let Err(error) = git(target, &args) {
        let aborted = git(target, &["cherry-pick", "--abort"]);
        if aborted.is_ok() && git(target, &["rev-parse", "HEAD"])? == before {
            state.integration_pending = false;
            save(root, &work.id, state)?;
        }
        return Err(format!(
            "통합 실패. worktree의 변경을 보존했습니다: {error}"
        ));
    }
    let integrated = git(
        target,
        &["rev-list", "--reverse", &format!("{before}..HEAD")],
    )?
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    // Persist exact target hashes before allowing another task or result confirmation.
    if work.stage == "discarding" {
        state.revert_commits = integrated.clone();
    } else {
        state.commits = integrated.clone();
    }
    state.integrated_run = state.run_id.clone();
    state.integration_pending = false;
    save(root, &work.id, state)?;
    Ok(integrated)
}

fn handle_request(
    root: &Path,
    work: &mut WorkItem,
    state: &mut Lifecycle,
    run_id: &str,
    req: &AgentRequest,
    settled: bool,
) -> Result<(), String> {
    validate_id(&req.id)?;
    match req.kind.as_str() {
        "question" => {
            if !matches!(
                work.stage.as_str(),
                "clarify" | "design" | "build" | "discarding"
            ) || req.question.trim().is_empty()
                || req.question.len() > 8000
                || req.options.len() > 8
            {
                return Err("유효한 인터뷰 질문이 아닙니다".into());
            }
            state.interviews.push(Interview {
                id: req.id.clone(),
                run_id: run_id.into(),
                stage: work.stage.clone(),
                question: req.question.clone(),
                options: req.options.clone(),
                ..Default::default()
            });
            let stage = work.stage.clone();
            persist_work(root, work, &stage, "blocked", "사용자 인터뷰 대기")?;
        }
        "message" => {
            if req.text.trim().is_empty() || req.text.len() > 8000 || req.to == work.id {
                return Err("메시지 대상과 내용을 확인하세요".into());
            }
            let target = work_by_id(root, &req.to)?;
            if target.project_id != work.project_id || !supports(&target) {
                return Err("같은 프로젝트의 SDD 작업에만 메시지를 보낼 수 있습니다".into());
            }
            let message = PeerMessage {
                from: work.id.clone(),
                to: req.to.clone(),
                text: req.text.clone(),
                at: now(),
            };
            let mut peer = read(root, &req.to)?;
            peer.messages.push(message.clone());
            save(root, &req.to, &mut peer)?;
            state.messages.push(message);
        }
        "complete" => {
            if !settled {
                return Err("완료 요청은 에이전트 턴이 끝난 뒤 처리됩니다".into());
            }
            if state.interviews.iter().any(|q| q.answer.is_empty()) {
                return Err("답변되지 않은 인터뷰가 있습니다".into());
            }
            match work.stage.as_str() {
                "clarify" => {
                    require_docs(root, work, &["brief"])?;
                    state.clarified = true;
                    persist_work(
                        root,
                        work,
                        "clarify",
                        "review",
                        "구체화 완료 · 사용자 방향 확인 대기",
                    )?;
                }
                "design" => {
                    require_docs(root, work, &["spec", "plan"])?;
                    validate_scope(&req.scope)?;
                    work.depends_on = req.depends_on.clone();
                    validate_work_graph(root, work)?;
                    state.scope = req.scope.clone();
                    persist_work(
                        root,
                        work,
                        "approval",
                        "review",
                        "설계·의존성 검토 완료 · 승인 대기",
                    )?;
                }
                "build" | "discarding" => {
                    let reverting = work.stage == "discarding";
                    if !reverting {
                        check_approval(root, work)?;
                    }
                    if reverting && !dependents(root, &work.id)?.is_empty() {
                        return Err("폐기 요청 후 새 후행 의존성이 생겼습니다".into());
                    }
                    require_docs(
                        root,
                        work,
                        &[if reverting {
                            "rollback"
                        } else {
                            "verification"
                        }],
                    )?;
                    let role = if reverting {
                        "rollback"
                    } else {
                        "verification"
                    };
                    let evidence = read_document(root, &work.id, role)?.markdown;
                    ensure_passing_evidence(&evidence, role)?;
                    if req.commits.last().map(String::as_str)
                        != evidence_field(&evidence, "codeRevision")
                    {
                        return Err(
                            "검증한 codeRevision과 마지막 구현 커밋이 일치해야 합니다".into()
                        );
                    }
                    integrate(root, work, state, &req.commits)?;
                    persist_work(
                        root,
                        work,
                        if reverting {
                            "discarded"
                        } else {
                            "unconfirmed"
                        },
                        if reverting { "cancelled" } else { "review" },
                        if reverting {
                            "커밋 되돌리기·검증 완료"
                        } else {
                            "구현·검증·커밋 완료 · 사용자 확인 대기"
                        },
                    )?;
                }
                _ => return Err("이 단계는 에이전트가 완료할 수 없습니다".into()),
            }
        }
        _ => return Err("알 수 없는 에이전트 요청입니다".into()),
    }
    Ok(())
}
/// The harness binds identity/stage and only accepts completion after the agent settles.
pub fn process_requests(
    root: &Path,
    id: &str,
    run_id: &str,
    stage: &str,
    settled: bool,
) -> Result<(), String> {
    let _guard = mutation_lock();
    let mut work = work_by_id(root, id)?;
    if !supports(&work) {
        return Ok(());
    }
    let mut state = read(root, id)?;
    if state.run_id != run_id || work.stage != stage {
        return Ok(());
    }
    let folder = root.join("runs/protocol").join(run_id);
    safe_path(root, &folder)?;
    if !folder.exists() {
        return Ok(());
    }
    let mut paths = fs::read_dir(&folder)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "json"))
        .collect::<Vec<_>>();
    paths.sort();
    let pending = paths
        .into_iter()
        .filter(|path| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|id| !state.processed.contains(&format!("{run_id}:{id}")))
        })
        .take(100)
        .collect::<Vec<_>>();
    for path in pending {
        safe_path(root, &path)?;
        let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if raw.len() > 64_000 {
            continue;
        }
        let req: AgentRequest = match serde_json::from_str(&raw) {
            Ok(req) => req,
            Err(_) => continue,
        };
        if state.processed.contains(&format!("{run_id}:{}", req.id))
            || (req.kind == "complete" && !settled)
        {
            continue;
        }
        // A filename is a request identity; do not let retries alias another request.
        if path.file_stem().and_then(|s| s.to_str()) != Some(req.id.as_str()) {
            continue;
        }
        let result = handle_request(root, &mut work, &mut state, run_id, &req, settled);
        let reply = match result {
            Ok(()) => {
                state.error.clear();
                json!({"accepted":true})
            }
            Err(error) => {
                state.error = error.clone();
                json!({"accepted":false,"error":error})
            }
        };
        state.processed.push(format!("{run_id}:{}", req.id));
        save(root, id, &mut state)?;
        write_atomic(root, &path.with_extension("reply"), &reply.to_string())?;
        if work.stage != stage {
            break;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn sdd_answer_interview(
    work_id: String,
    question_id: String,
    answer: String,
    revision: u64,
) -> Result<Lifecycle, String> {
    let root = vault_root()?;
    let _guard = mutation_lock();
    let mut work = work_by_id(&root, &work_id)?;
    let mut state = read(&root, &work_id)?;
    if state.revision != revision {
        return Err("인터뷰가 변경되었습니다. 새로고침하세요".into());
    }
    if answer.trim().is_empty() || answer.len() > 16000 {
        return Err("답변을 1~16000 바이트로 입력하세요".into());
    }
    let question = state
        .interviews
        .iter_mut()
        .find(|q| q.id == question_id && q.answer.is_empty())
        .ok_or("답변할 질문이 없습니다")?;
    if question.stage != work.stage {
        return Err("질문의 단계가 변경되었습니다".into());
    }
    question.answer = answer.trim().into();
    question.answered_at = now();
    let reply = root
        .join("runs/protocol")
        .join(&question.run_id)
        .join(format!("{}.reply", question.id));
    write_atomic(
        &root,
        &reply,
        &json!({"accepted":true,"answer":question.answer}).to_string(),
    )?;
    if !state.interviews.iter().any(|q| q.answer.is_empty()) {
        let stage = work.stage.clone();
        persist_work(
            &root,
            &mut work,
            &stage,
            "ready",
            "인터뷰 답변 완료 · 계속 진행 가능",
        )?;
    }
    save(&root, &work_id, &mut state)?;
    Ok(state)
}

/// Queue survives restarts; the launch mutex prevents duplicate sessions.
pub async fn tick(root: &Path) -> Result<(), String> {
    let all = snapshot(root)?.work;
    let mut candidates = all
        .iter()
        .filter(|w| {
            supports(w)
                && matches!(w.stage.as_str(), "queued" | "build" | "discarding")
                && read(root, &w.id).is_ok_and(|s| s.queued)
        })
        .cloned()
        .collect::<Vec<_>>();
    candidates.sort_by_key(|w| {
        (
            PRIORITIES
                .iter()
                .position(|p| *p == w.priority)
                .unwrap_or(2),
            w.created_at.clone(),
            w.id.clone(),
        )
    });
    for mut work in candidates {
        if crate::sdlc_harness::has_active_work(root, &work.id)?
            || !dependency_ready(&work, &snapshot(root)?.work)
        {
            continue;
        }
        let mut state = read(root, &work.id)?;
        let project = project_by_id(root, &work.project_id)?;
        let mut conflict = None;
        for peer in &all {
            if peer.id == work.id
                || !supports(peer)
                || !matches!(peer.stage.as_str(), "build" | "discarding")
            {
                continue;
            }
            let peer_project = project_by_id(root, &peer.project_id)?;
            if peer_project.repo_path == project.repo_path
                && crate::sdlc_harness::has_active_work(root, &peer.id)?
                && overlap(&state.scope, &read(root, &peer.id)?.scope)
            {
                conflict = Some(peer.id.clone());
                break;
            }
        }
        if let Some(peer) = conflict {
            let message = format!("변경 범위가 겹쳐 {peer} 완료 후 시작합니다");
            if state.error != message {
                let _guard = mutation_lock();
                state.error = message;
                save(root, &work.id, &mut state)?;
            }
            continue;
        }
        let was_queued = work.stage == "queued";
        {
            let _guard = mutation_lock();
            if work.stage == "queued" {
                persist_work(
                    root,
                    &mut work,
                    "build",
                    "ready",
                    "일괄 구현 큐에서 실행 접수",
                )?;
            }
        }
        let result = crate::sdlc_harness::sdd_launch(LaunchInput {
            work_id: work.id.clone(),
            project_id: work.project_id.clone(),
            role: "implementer".into(),
            agent: project.default_agent,
            model: project.default_model,
            instructions: "승인된 작업을 완료하고 실제 근거와 커밋을 제출하세요.".into(),
            ..Default::default()
        })
        .await;
        if let Err(error) = result {
            let _guard = mutation_lock();
            let mut state = read(root, &work.id)?;
            // Capacity is transient. Other failures remain visible and require an explicit retry.
            if !error.contains("동시 실행 한도") && !error.contains("변경 범위가 겹쳐")
            {
                state.queued = false;
            }
            if was_queued {
                persist_work(root, &mut work, "queued", "ready", "실행 시작 대기")?;
            }
            state.error = error;
            save(root, &work.id, &mut state)?;
        }
    }
    Ok(())
}

pub fn launch_gate(root: &Path, work: &WorkItem) -> Result<(), String> {
    if !supports(work) {
        return Ok(());
    }
    let state = read(root, &work.id)?;
    if state.interviews.iter().any(|q| q.answer.is_empty()) {
        return Err("대기 중인 인터뷰에 먼저 답해주세요".into());
    }
    if !matches!(work.stage.as_str(), "build" | "discarding") {
        return Ok(());
    }
    check_approval(root, work)?;
    let all = snapshot(root)?.work;
    if work.stage == "build" && !dependency_ready(work, &all) {
        return Err("선행 의존 작업의 구현 완료를 기다립니다".into());
    }
    if work.stage == "discarding" && !dependents(root, &work.id)?.is_empty() {
        return Err("후행 의존 작업을 먼저 폐기·취소하세요".into());
    }
    let project = project_by_id(root, &work.project_id)?;
    let identity = git(
        Path::new(&project.repo_path),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    for peer in all.iter().filter(|p| {
        p.id != work.id && supports(p) && matches!(p.stage.as_str(), "build" | "discarding")
    }) {
        let peer_project = project_by_id(root, &peer.project_id)?;
        if git(
            Path::new(&peer_project.repo_path),
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .ok()
        .as_ref()
            == Some(&identity)
            && crate::sdlc_harness::has_active_work(root, &peer.id)?
            && overlap(&state.scope, &read(root, &peer.id)?.scope)
        {
            return Err(format!("변경 범위가 겹쳐 {} 완료 후 시작합니다", peer.id));
        }
    }
    Ok(())
}

/// A persisted integration intent closes the crash window between Git and Markdown writes.
fn recover_integration(root: &Path, work: &WorkItem, state: &mut Lifecycle) -> Result<(), String> {
    if !state.integration_pending {
        return Ok(());
    }
    let project = project_by_id(root, &work.project_id)?;
    let repo = Path::new(&project.repo_path);
    if repo
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        != state.target_repo
        || git(repo, &["symbolic-ref", "--quiet", "HEAD"])? != state.target_ref
    {
        return Err("통합 복구 전에 원래 프로젝트와 브랜치로 돌아오세요".into());
    }
    let head = git(repo, &["rev-parse", "HEAD"])?;
    let pending = git(repo, &["rev-parse", "--verify", "CHERRY_PICK_HEAD"]).is_ok();
    if head == state.integration_before && !pending {
        state.integration_pending = false;
        save(root, &work.id, state)?;
        return Ok(());
    }
    if pending {
        return Err(
            "중단된 cherry-pick을 저장소에서 먼저 완료하거나 중단하세요. 기존 변경은 보존됩니다"
                .into(),
        );
    }
    let commits = git(
        repo,
        &[
            "rev-list",
            "--reverse",
            &format!("{}..HEAD", state.integration_before),
        ],
    )?
    .lines()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if commits.len() != state.integration_sources.len() {
        return Err("통합 중 저장소 이력이 변경되었습니다. 기록된 커밋을 확인하세요".into());
    }
    for (sha, source) in commits.iter().zip(&state.integration_sources) {
        let message = git(repo, &["log", "-1", "--format=%B", sha])?;
        if !message
            .lines()
            .any(|l| l == format!("(cherry picked from commit {source})"))
        {
            return Err("통합 복구 커밋 출처가 일치하지 않습니다".into());
        }
    }
    if work.stage == "discarding" {
        state.revert_commits = commits;
    } else {
        state.commits = commits;
    }
    state.integrated_run = state.run_id.clone();
    state.integration_pending = false;
    save(root, &work.id, state)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("vault");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&repo).unwrap();
        initialize(&root).unwrap();
        git(&repo, &["init", "-q"]).unwrap();
        git(&repo, &["config", "user.email", "test@example.test"]).unwrap();
        git(&repo, &["config", "user.name", "Test"]).unwrap();
        git(&repo, &["config", "commit.gpgsign", "false"]).unwrap();
        git(&repo, &["config", "core.autocrlf", "false"]).unwrap();
        fs::write(repo.join("feature.txt"), "before\n").unwrap();
        git(&repo, &["add", "feature.txt"]).unwrap();
        git(&repo, &["commit", "-qm", "initial"]).unwrap();
        save_project_at(
            &root,
            Project {
                id: "p".into(),
                name: "Project".into(),
                repo_path: repo.to_string_lossy().into_owned(),
                default_agent: "codex".into(),
                ..Default::default()
            },
        )
        .unwrap();
        (temp, root, repo)
    }
    fn capture(root: &Path, id: &str) -> WorkItem {
        capture_intent_at(
            root,
            CaptureIntentInput {
                work: WorkItem {
                    id: id.into(),
                    title: id.into(),
                    project_id: "p".into(),
                    ..Default::default()
                },
                markdown: "Make a useful feature".into(),
                attachments: vec![],
            },
        )
        .unwrap()
    }
    fn action(root: &Path, id: &str, action: &str) -> Result<WorkItem, String> {
        let work = work_by_id(root, id)?;
        action_at(
            root,
            ActionInput {
                work_id: id.into(),
                action: action.into(),
                expected_stage: work.stage.clone(),
                revision: read(root, id)?.revision,
                note: action.into(),
                input_digest: work_input_digest(root, &work)?,
            },
        )
    }
    fn document(root: &Path, id: &str, role: &str) {
        let doc = read_document(root, id, role).unwrap();
        write_document_at(root, id, role, format!("# {role}\n\nActual output and acceptance criteria. Tested using a reproducible command."), &doc.revision).unwrap();
    }
    fn request(root: &Path, id: &str, run: &str, value: serde_json::Value, settled: bool) {
        let work = work_by_id(root, id).unwrap();
        protocol_prompt(root, &work, run).unwrap();
        let folder = root.join("runs/protocol").join(run);
        fs::write(
            folder.join(format!("{}.json", value["id"].as_str().unwrap())),
            value.to_string(),
        )
        .unwrap();
        process_requests(root, id, run, &work.stage, settled).unwrap();
    }
    fn approved(root: &Path, id: &str) -> WorkItem {
        capture(root, id);
        let work = action(root, id, "clarify").unwrap();
        record_launch(root, &work, "clarify", &format!("{id}-clarify")).unwrap();
        document(root, id, "brief");
        request(
            root,
            id,
            &format!("{id}-clarify"),
            json!({"id":"finish","kind":"complete"}),
            true,
        );
        let work = action(root, id, "design").unwrap();
        record_launch(root, &work, "design", &format!("{id}-design")).unwrap();
        document(root, id, "spec");
        document(root, id, "plan");
        request(
            root,
            id,
            &format!("{id}-design"),
            json!({"id":"finish","kind":"complete","dependsOn":[],"scope":["feature.txt"]}),
            true,
        );
        action(root, id, "approve").unwrap()
    }
    #[test]
    fn inbox_clarification_and_approval_are_separate_durable_decisions() {
        let (_tmp, root, _) = fixture();
        let work = capture(&root, "w");
        assert_eq!(work.stage, "inbox");
        assert!(action(&root, "w", "approve").is_err());
        assert!(action(&root, "w", "design").is_err());
        let work = action(&root, "w", "clarify").unwrap();
        record_launch(&root, &work, "clarify", "run").unwrap();
        document(&root, "w", "brief");
        request(
            &root,
            "w",
            "run",
            json!({"id":"q","kind":"question","question":"Which audience?","options":["Team","Public"]}),
            true,
        );
        request(
            &root,
            "w",
            "run",
            json!({"id":"finish","kind":"complete"}),
            true,
        );
        assert!(!read(&root, "w").unwrap().clarified);
        assert_eq!(work_by_id(&root, "w").unwrap().status, "blocked");
        assert!(action(&root, "w", "design").is_err());
        assert!(launch_gate(&root, &work_by_id(&root, "w").unwrap()).is_err());
        let queued = approved(&root, "a");
        assert_eq!(queued.stage, "queued");
        assert_eq!(queued.status, "ready");
        assert!(!read(&root, "a").unwrap().queued);
        queue_at(&root, &["a".into()]).unwrap();
        assert!(read(&root, "a").unwrap().queued);
        assert_eq!(work_by_id(&root, "a").unwrap().stage, "queued");
        assert!(workflow_command_at(
            &root,
            WorkflowCommandInput {
                work_id: "a".into(),
                event: "work:start".into(),
                note: "bypass".into(),
                ..Default::default()
            }
        )
        .is_err());
        document(&root, "a", "brief"); // Identical content is the same reviewed input.
        fs::write(root.join("work/a/brief.md"), "changed requirement").unwrap();
        assert!(check_approval(&root, &queued).is_err());
    }
    #[test]
    fn completion_requires_reported_commits_and_discard_reverts_exact_history() {
        let (_tmp, root, repo) = fixture();
        let mut work = approved(&root, "w");
        persist_work(&root, &mut work, "build", "ready", "test queued launch").unwrap();
        let folder =
            prepare_repository(&root, &work, "build-run", &repo.to_string_lossy()).unwrap();
        record_launch(&root, &work, "build", "build-run").unwrap();
        document(&root, "w", "verification");
        process_requests(&root, "w", "build-run", "build", true).unwrap();
        assert_eq!(
            work_by_id(&root, "w").unwrap().stage,
            "build",
            "idle alone is never completion"
        );
        fs::write(Path::new(&folder).join("feature.txt"), "after\n").unwrap();
        git(Path::new(&folder), &["add", "feature.txt"]).unwrap();
        git(
            Path::new(&folder),
            &["commit", "-qm", "Implement\n\nSawhorse-Work: w"],
        )
        .unwrap();
        let sha = git(Path::new(&folder), &["rev-parse", "HEAD"]).unwrap();
        fs::write(
            root.join("work/w/verification.md"),
            format!("result: passed\ncommand: test feature\nexitCode: 0\ncodeRevision: {sha}\n"),
        )
        .unwrap();
        request(
            &root,
            "w",
            "build-run",
            json!({"id":"finish","kind":"complete","commits":[sha]}),
            false,
        );
        assert_eq!(work_by_id(&root, "w").unwrap().stage, "build");
        process_requests(&root, "w", "build-run", "build", true).unwrap();
        assert_eq!(read(&root, "w").unwrap().error, "");
        assert_eq!(work_by_id(&root, "w").unwrap().stage, "unconfirmed");
        assert_eq!(
            fs::read_to_string(repo.join("feature.txt")).unwrap(),
            "after\n"
        );
        let original = read(&root, "w").unwrap().commits[0].clone();
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]).unwrap(), original);
        action(&root, "w", "confirm").unwrap();
        assert_eq!(work_by_id(&root, "w").unwrap().status, "done");
        let mut dep = capture(&root, "dependent");
        dep.depends_on = vec!["w".into()];
        save_work_at(&root, dep).unwrap();
        assert!(action(&root, "w", "discard")
            .unwrap_err()
            .contains("dependent"));
        action(&root, "dependent", "cancel").unwrap();
        let work = action(&root, "w", "discard").unwrap();
        let folder =
            prepare_repository(&root, &work, "revert-run", &repo.to_string_lossy()).unwrap();
        record_launch(&root, &work, "discarding", "revert-run").unwrap();
        git(Path::new(&folder), &["revert", "--no-edit", &original]).unwrap();
        git(
            Path::new(&folder),
            &[
                "commit",
                "--amend",
                "-qm",
                &format!("Revert feature\n\nThis reverts commit {original}.\n\nSawhorse-Work: w"),
            ],
        )
        .unwrap();
        let revert = git(Path::new(&folder), &["rev-parse", "HEAD"]).unwrap();
        document(&root, "w", "rollback");
        fs::write(root.join("work/w/rollback.md"), format!("result: passed\ncommand: test reverted feature\nexitCode: 0\ncodeRevision: {revert}\n")).unwrap();
        request(
            &root,
            "w",
            "revert-run",
            json!({"id":"finish","kind":"complete","commits":[revert]}),
            true,
        );
        assert_eq!(read(&root, "w").unwrap().error, "");
        assert_eq!(work_by_id(&root, "w").unwrap().stage, "discarded");
        assert_eq!(
            fs::read_to_string(repo.join("feature.txt")).unwrap(),
            "before\n"
        );
        assert_eq!(read(&root, "w").unwrap().revert_commits.len(), 1);
    }
    #[test]
    fn integration_rejects_changed_branch_and_stale_evidence_then_recovers_without_duplication() {
        let (_tmp, root, repo) = fixture();
        let mut work = approved(&root, "w");
        persist_work(&root, &mut work, "build", "ready", "test launch").unwrap();
        let folder = prepare_repository(&root, &work, "run", &repo.to_string_lossy()).unwrap();
        record_launch(&root, &work, "build", "run").unwrap();
        let branch = git(&repo, &["symbolic-ref", "--short", "HEAD"]).unwrap();
        let before = git(&repo, &["rev-parse", "HEAD"]).unwrap();
        fs::write(Path::new(&folder).join("feature.txt"), "implemented\n").unwrap();
        git(Path::new(&folder), &["add", "feature.txt"]).unwrap();
        git(
            Path::new(&folder),
            &["commit", "-qm", "Implement\n\nSawhorse-Work: w"],
        )
        .unwrap();
        let sha = git(Path::new(&folder), &["rev-parse", "HEAD"]).unwrap();
        fs::write(
            root.join("work/w/verification.md"),
            format!("result: passed\ncommand: test feature\nexitCode: 0\ncodeRevision: {before}\n"),
        )
        .unwrap();
        request(
            &root,
            "w",
            "run",
            json!({"id":"stale","kind":"complete","commits":[sha]}),
            true,
        );
        assert!(read(&root, "w").unwrap().error.contains("codeRevision"));
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]).unwrap(), before);
        fs::write(
            root.join("work/w/verification.md"),
            format!("result: passed\ncommand: test feature\nexitCode: 0\ncodeRevision: {sha}\n"),
        )
        .unwrap();
        git(&repo, &["checkout", "-qb", "other"]).unwrap();
        request(
            &root,
            "w",
            "run",
            json!({"id":"branch","kind":"complete","commits":[sha]}),
            true,
        );
        assert!(read(&root, "w").unwrap().error.contains("브랜치"));
        git(&repo, &["checkout", "-q", &branch]).unwrap();
        // Simulate a process stopping after cherry-pick but before persisting its outcome.
        let mut state = read(&root, "w").unwrap();
        state.integration_pending = true;
        state.integration_before = before;
        state.integration_sources = vec![sha.clone()];
        save(&root, "w", &mut state).unwrap();
        git(&repo, &["cherry-pick", "-x", &sha]).unwrap();
        let integrated = git(&repo, &["rev-parse", "HEAD"]).unwrap();
        let recovered = action(&root, "w", "retry").unwrap();
        assert_eq!(recovered.stage, "unconfirmed");
        let state = read(&root, "w").unwrap();
        assert!(!state.queued);
        assert!(!state.integration_pending);
        assert_eq!(state.commits, vec![integrated.clone()]);
        assert_eq!(git(&repo, &["rev-parse", "HEAD"]).unwrap(), integrated);
    }
    #[test]
    fn scope_and_dependency_guards_do_not_conflate_completion_with_acceptance() {
        assert!(overlap(&["src".into()], &["src/a.ts".into()]));
        assert!(!overlap(&["src/a.ts".into()], &["src/b.ts".into()]));
        assert!(validate_scope(&["../escape".into()]).is_err());
        assert!(validate_scope(&[".git/config".into()]).is_err());
        let prerequisite = WorkItem {
            id: "a".into(),
            workflow_id: "intent-flow".into(),
            workflow_version: "2.0.0".into(),
            stage: "unconfirmed".into(),
            status: "review".into(),
            ..Default::default()
        };
        let work = WorkItem {
            depends_on: vec!["a".into()],
            ..Default::default()
        };
        assert!(dependency_ready(&work, &[prerequisite.clone()]));
        let mut cancelled = prerequisite;
        cancelled.stage = "cancelled".into();
        cancelled.status = "cancelled".into();
        assert!(!dependency_ready(&work, &[cancelled]));
    }
    #[test]
    fn stale_actions_and_incomplete_batches_do_not_change_any_work() {
        let (_tmp, root, _) = fixture();
        let a = approved(&root, "a");
        capture(&root, "b");
        assert!(queue_at(&root, &["a".into(), "b".into()]).is_err());
        assert!(!read(&root, "a").unwrap().queued);
        assert!(action_at(
            &root,
            ActionInput {
                work_id: "a".into(),
                action: "revise".into(),
                expected_stage: "queued".into(),
                revision: 0,
                note: "stale".into(),
                input_digest: "".into()
            }
        )
        .is_err());
        assert_eq!(work_by_id(&root, "a").unwrap().stage, a.stage);
    }
}
