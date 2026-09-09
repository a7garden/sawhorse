//! Goal driver: one bounded agent turn per claim, durable retries and automatic verification.
use super::*;
use crate::sdlc::goals::{self as store, GoalState, GoalTask};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TurnResult {
    run_id: String,
    action: String,
    evidence: String,
    #[serde(default)]
    checks: Vec<Check>,
    #[serde(default)]
    tasks: Vec<TaskProposal>,
    #[serde(default)]
    scope: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Check {
    command: String,
    result: String,
    passed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct TaskProposal {
    key: String,
    title: String,
    objective: String,
    scope: Vec<String>,
    #[serde(default)]
    depends_on: Vec<String>,
}

fn result_path(root: &Path, run: &str) -> Result<PathBuf, String> {
    checked_run_id(run)?;
    Ok(runs_dir(root)?.join(format!("{run}.goal-result.json")))
}

pub(super) fn prompt(
    root: &Path,
    work: &sdlc::WorkItem,
    run_id: &str,
    verification: &[String],
) -> Result<String, String> {
    let state = store::read(root, &work.id)?;
    let parent = state
        .parent_id
        .as_ref()
        .map(|id| store::read(root, id))
        .transpose()?;
    let tasks = state
        .tasks
        .iter()
        .rev()
        .take(12)
        .map(|task| {
            let progress = store::read(root, &task.id)?;
            Ok(serde_json::json!({"id": task.id, "title": task.title, "status": progress.status}))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(format!(
        r#"You are pursuing a user-authorized autonomous goal in Sawhorse.
Goal: {objective}
This work: {work_objective}
{work_type}
The excerpts above may be shortened. Read the complete goal, acceptance criteria and task history from {goal_state}, and this work's full state from {work_state} before acting. Each task's full objective and evidence remain in its work directory; inspect those files as needed. Keep prompts bounded by reading durable history instead of copying it all into new reports.
Phase: {phase}. Run ID: {run_id}.
The user has authorized planning, task creation, design, implementation and verification without human stage approvals. Resolve ordinary choices yourself. Keep working toward the goal; do not stop at a plan or ask for stage approval. Respect the requested scope. Do not change host-managed work, goal, or run records.
Modify only these repository-relative paths: {scope}. Other tasks may run concurrently in other paths. If a worker needs additional paths, return action continue with an optional scope array containing the full revised scope; do not edit the additional paths this turn. The host will reserve the revised scope before the next turn. Root planners should put shared file changes in a separate task with dependencies. Do not launch unmanaged background agents. The host owns task claiming and parallel dispatch.
Read the existing repository and durable evidence before doing work. Resume partial changes without repeating completed work. Update {checkpoint} with progress, design choices, commands/results and remaining work during the turn so interruptions can resume.
Registered verification commands: {verification}
Prior checkpoint: {evidence}
Previous error: {error}
Recent task summaries (full history is in goal.json): {tasks}

In plan phase, inspect the goal and create bounded tasks with clear acceptance criteria and file scopes. Tasks with disjoint scopes run in parallel; dependsOn references keys in this batch. Use scope ["."] if uncertain, which serializes repository writes. In work phase, design, implement and test this task. In verify phase, independently inspect the actual changes and run relevant checks; never rely only on previous agents' claims. If the goal is unmet, propose corrective tasks (root only), or return continue to implement corrections. Complete only when all acceptance criteria actually pass.
Before a successful exit, atomically write this exact JSON protocol to {result_path}:
{{"runId":"{run_id}","action":"tasks|continue|complete","evidence":"concrete durable progress and verification evidence","checks":[{{"command":"actual check performed","result":"actual result","passed":true}}],"tasks":[{{"key":"unique-key","title":"task title","objective":"bounded task and acceptance criteria","scope":["src/game"],"dependsOn":[]}}]}}
Use one action. Include tasks only for action tasks, only on the root goal, at most 16 per turn. complete in verify phase requires nonempty checks with every check passing and nonempty evidence. A non-verifier complete requests an independent verification turn; it does not finish the goal. Never claim completion because time or tokens ran out. If usage is exhausted, let the provider report the error; the host persists progress and retries every hour without a retry limit.
Root goal: {is_root}. No fixed iteration limit. Return a concise final report after saving the protocol file.
"#,
        objective = parent
            .as_ref()
            .map(|p| p.objective.as_str())
            .unwrap_or(&state.objective)
            .chars()
            .take(4000)
            .collect::<String>(),
        work_type = sdlc::work_type_guidance(work),
        work_objective = state.objective.chars().take(4000).collect::<String>(),
        goal_state = sdlc::work_path(root, state.parent_id.as_deref().unwrap_or(&work.id))
            .with_file_name("goal.json")
            .display(),
        work_state = sdlc::work_path(root, &work.id)
            .with_file_name("goal.json")
            .display(),
        phase = state.phase,
        scope = serde_json::to_string(&state.scope).unwrap(),
        checkpoint = sdlc::work_path(root, &work.id)
            .with_file_name("evidence.md")
            .display(),
        verification = verification
            .join("\n")
            .chars()
            .take(2000)
            .collect::<String>(),
        evidence = tail_chars(&state.evidence, 2000),
        error = tail_chars(&state.last_error, 1000),
        tasks = serde_json::to_string(&tasks).unwrap(),
        result_path = result_path(root, run_id)?.display(),
        is_root = state.parent_id.is_none(),
    ))
}

fn validate_result(result: &TurnResult, state: &GoalState, run: &str) -> Result<(), String> {
    if result.run_id != run || result.evidence.trim().is_empty() || result.evidence.len() > 32_000 {
        return Err("골 결과의 실행 ID 또는 근거가 유효하지 않습니다".into());
    }
    if !matches!(result.action.as_str(), "tasks" | "continue" | "complete") {
        return Err("지원하지 않는 골 결과 action입니다".into());
    }
    if result.action != "tasks" && !result.tasks.is_empty() {
        return Err("tasks action에서만 하위 작업을 만들 수 있습니다".into());
    }
    if !result.scope.is_empty()
        && (state.parent_id.is_none()
            || result.action != "continue"
            || !store::scope_valid(&result.scope))
    {
        return Err(
            "하위 작업은 continue 결과에서만 유효한 변경 범위를 다시 요청할 수 있습니다".into(),
        );
    }
    if result.action == "complete"
        && state.phase == "verify"
        && (result.checks.is_empty()
            || result.checks.iter().any(|check| {
                !check.passed || check.command.trim().is_empty() || check.result.trim().is_empty()
            }))
    {
        return Err("완료 판정에는 실제로 통과한 검증과 결과가 필요합니다".into());
    }
    if result.action == "tasks" {
        if state.parent_id.is_some() || result.tasks.is_empty() || result.tasks.len() > 16 {
            return Err("루트 목표만 한 번에 1~16개 작업을 만들 수 있습니다".into());
        }
        let mut keys = HashSet::new();
        for task in &result.tasks {
            sdlc::validate_id(&task.key)?;
            if !keys.insert(task.key.clone())
                || task.title.trim().is_empty()
                || task.title.len() > 200
                || task.objective.trim().is_empty()
                || task.objective.len() > 16_000
                || !store::scope_valid(&task.scope)
            {
                return Err("중복 작업 키, 빈 작업 또는 유효하지 않은 변경 범위입니다".into());
            }
        }
        let mut resolved = HashSet::new();
        loop {
            let before = resolved.len();
            for task in &result.tasks {
                if task.depends_on.iter().all(|key| resolved.contains(key)) {
                    resolved.insert(task.key.clone());
                }
            }
            if resolved.len() == keys.len() {
                break;
            }
            if before == resolved.len() {
                return Err("작업 의존성이 순환하거나 존재하지 않는 작업을 참조합니다".into());
            }
        }
    }
    Ok(())
}

fn apply_result(root: &Path, state: &mut GoalState, run: &RunRecord) -> Result<(), String> {
    let path = result_path(root, &run.id)?;
    crate::workspace_io::check_path(root, &path)?;
    if fs::metadata(&path)
        .map_err(|e| format!("골 결과 파일 없음: {e}"))?
        .len()
        > 256_000
    {
        return Err("골 결과 파일이 너무 큽니다".into());
    }
    let result: TurnResult =
        serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("골 결과 형식 오류: {e}"))?;
    validate_result(&result, state, &run.id)?;
    if !result.scope.is_empty() {
        state.scope = result.scope;
    }
    state.evidence = result.evidence;
    state.last_error.clear();
    state.next_retry_at = None;
    state.status = "ready".into();
    match result.action.as_str() {
        "tasks" => {
            let ids: HashMap<_, _> = result
                .tasks
                .iter()
                .map(|task| {
                    (
                        task.key.clone(),
                        format!("work-{}", Uuid::new_v4().simple()),
                    )
                })
                .collect();
            state.tasks.extend(result.tasks.into_iter().map(|task| {
                GoalTask {
                    id: ids[&task.key].clone(),
                    title: task.title,
                    objective: task.objective,
                    scope: task.scope,
                    depends_on: task
                        .depends_on
                        .into_iter()
                        .map(|key| ids[&key].clone())
                        .collect(),
                }
            }));
            state.phase = "wait".into();
        }
        "complete" if state.phase == "verify" => state.status = "completed".into(),
        "complete" => state.phase = "verify".into(),
        _ => {
            state.phase = if state.parent_id.is_some() {
                "work"
            } else {
                "plan"
            }
            .into()
        }
    }
    Ok(())
}

fn cooldown_path(root: &Path) -> PathBuf {
    root.join(".sawhorse").join("goal-cooldowns.json")
}
fn cooldowns(root: &Path) -> Result<HashMap<String, String>, String> {
    let path = cooldown_path(root);
    crate::workspace_io::check_path(root, &path)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
fn defer(root: &Path, state: &mut GoalState, error: String, agent: &str) -> Result<(), String> {
    store::defer(state, error, Utc::now());
    if state.status == "waiting-quota" {
        let mut values = cooldowns(root)?;
        values.insert(agent.into(), state.next_retry_at.clone().unwrap());
        crate::workspace_io::write_atomic(
            &cooldown_path(root),
            &serde_json::to_vec(&values).unwrap(),
            true,
        )?;
    }
    Ok(())
}

fn active_for(records: &[RunRecord], id: &str) -> bool {
    records
        .iter()
        .any(|run| run.work_id == id && refreshable_status(&run.status))
}

/// Synchronous file/dispatch transaction, never held while awaiting an agent.
pub(super) fn tick(root: &Path) -> Result<(), String> {
    tick_with(
        root,
        &config::load_view().dashboard.herdr.sanitized(),
        &spawn_start,
    )
}

fn tick_with(
    root: &Path,
    cfg: &config::HerdrCfg,
    dispatch: &impl Fn(PathBuf, String),
) -> Result<(), String> {
    let _guard = match crate::workspace_io::lock(root, "goal-control") {
        Ok(guard) => guard,
        Err(e) if e.starts_with("workspace-busy") => return Ok(()),
        Err(e) => return Err(e),
    };
    let mut roots = sdlc::snapshot(root)?
        .work
        .into_iter()
        .filter(|w| w.workflow_id == store::WORKFLOW)
        .filter_map(|w| store::read(root, &w.id).ok())
        .filter(|s| s.parent_id.is_none())
        .collect::<Vec<_>>();
    roots.sort_by(|a, b| a.work_id.cmp(&b.work_id));
    for state in roots {
        store::save(root, &state)?;
        if matches!(state.status.as_str(), "paused" | "cancelled" | "completed") {
            continue;
        }
        store::materialize_tasks(root, &state)?;
        let mut members = state
            .tasks
            .iter()
            .map(|t| store::read(root, &t.id))
            .collect::<Result<Vec<_>, _>>()?;
        members.push(state);
        for mut state in members {
            store::save(root, &state)?;
            if matches!(state.status.as_str(), "paused" | "cancelled" | "completed") {
                continue;
            }
            let work = sdlc::snapshot(root)?
                .work
                .into_iter()
                .find(|w| w.id == state.work_id)
                .ok_or("목표 작업 없음")?;
            let project = sdlc::project_by_id(root, &work.project_id)?;
            let agent = crate::agents::normalize_id(&project.default_agent).to_string();
            let request_id = format!("goal:{}:{}", state.work_id, state.iteration);
            // Recover dispatch if the app exited after saving the run but before linking the state.
            if state.run_id.is_none() {
                state.run_id = inbox_run_by_request(root, &request_id)?.map(|r| r.id);
            }
            if let Some(id) = state.run_id.clone() {
                let run = load_record(root, &id)?;
                if refreshable_status(&run.status) {
                    continue;
                }
                state.iteration += 1;
                state.run_id = None;
                if run.status == "stopped" {
                    state.status = "paused".into();
                    state.last_error = "실행이 중단되었습니다. 목표를 재개하면 이어집니다.".into();
                } else if run.status == "review" {
                    if let Err(error) = apply_result(root, &mut state, &run) {
                        defer(root, &mut state, error, &agent)?;
                    }
                } else {
                    defer(
                        root,
                        &mut state,
                        run.error
                            .unwrap_or_else(|| "실행이 중단되어 이어서 재시도합니다".into()),
                        &agent,
                    )?;
                }
                store::save(root, &state)?;
                if state.phase == "wait" {
                    store::materialize_tasks(root, &state)?;
                }
                continue;
            }
            if !store::due(&state, Utc::now()) {
                continue;
            }
            if state.phase == "wait" {
                if !state
                    .tasks
                    .iter()
                    .all(|t| store::read(root, &t.id).is_ok_and(|s| s.status == "completed"))
                {
                    continue;
                }
                state.phase = "verify".into();
            }
            let dependency_work = sdlc::snapshot(root)?.work;
            if !work.depends_on.iter().all(|id| {
                dependency_work
                    .iter()
                    .any(|w| w.id == *id && w.status == "done")
            }) {
                continue;
            }
            let cooldown = cooldowns(root)?.get(&agent).cloned();
            if cooldown.as_ref().is_some_and(|time| {
                chrono::DateTime::parse_from_rfc3339(time).is_ok_and(|t| t > Utc::now())
            }) {
                state.status = "waiting-quota".into();
                state.next_retry_at = cooldown;
                store::save(root, &state)?;
                continue;
            }
            let records = list_records(root)?;
            if active_for(&records, &state.work_id) {
                continue;
            }
            let tree_id = state.parent_id.as_ref().unwrap_or(&state.work_id);
            let tree = store::read(root, tree_id)?;
            let count = records
                .iter()
                .filter(|run| {
                    refreshable_status(&run.status)
                        && (run.work_id == *tree_id
                            || tree.tasks.iter().any(|t| t.id == run.work_id))
                })
                .count();
            if count >= tree.max_parallel {
                continue;
            }
            // Workspace writes from other workflows are conservatively treated as whole-repo claims.
            if records
                .iter()
                .filter(|r| refreshable_status(&r.status))
                .any(|r| {
                    Path::new(&r.repo_path).canonicalize().ok()
                        == Path::new(&project.repo_path).canonicalize().ok()
                        && store::scopes_overlap(
                            &state.scope,
                            &store::read(root, &r.work_id)
                                .map(|s| s.scope)
                                .unwrap_or_else(|_| vec![".".into()]),
                        )
                })
            {
                continue;
            }
            state.status = "ready".into();
            state.next_retry_at = None;
            store::save(root, &state)?;
            let mut cfg = cfg.clone();
            cfg.mode = "headless".into();
            let input = LaunchInput {
                work_id: state.work_id.clone(),
                project_id: work.project_id,
                role: if state.phase == "verify" {
                    "verifier"
                } else if state.phase == "plan" {
                    "planner"
                } else {
                    "implementer"
                }
                .into(),
                agent: agent.clone(),
                model: project.default_model,
                ..Default::default()
            };
            match record_launch_with_config(root, &input, Some(&request_id), &cfg) {
                Ok(run) => {
                    state.run_id = Some(run.id.clone());
                    state.status = "running".into();
                    store::save(root, &state)?;
                    dispatch(root.to_path_buf(), run.id);
                }
                Err(error)
                    if error.contains("동시 실행 한도") || error.starts_with("workspace-busy") =>
                    {}
                Err(error) => {
                    defer(root, &mut state, error, &agent)?;
                    store::save(root, &state)?;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn goal_control(work_id: String, action: String) -> Result<(), String> {
    let root = sdlc::vault_root()?;
    control_at(&root, &work_id, &action)
}

fn control_at(root: &Path, id: &str, action: &str) -> Result<(), String> {
    if !matches!(action, "pause" | "resume" | "cancel") {
        return Err("지원하지 않는 목표 동작입니다".into());
    }
    let _guard = crate::workspace_io::lock(root, "goal-control")?;
    control_locked(root, id, action)
}

fn control_locked(root: &Path, id: &str, action: &str) -> Result<(), String> {
    let state = store::read(root, id)?;
    store::materialize_tasks(root, &state)?;
    let mut ids = state.tasks.iter().map(|t| t.id.clone()).collect::<Vec<_>>();
    ids.push(id.into());
    let records = list_records(root)?;
    if action == "resume" && ids.iter().any(|id| active_for(&records, id)) {
        return Err("실행 중단이 끝나면 목표를 재개할 수 있습니다".into());
    }
    for id in ids {
        let mut state = store::read(root, &id)?;
        if matches!(state.status.as_str(), "completed" | "cancelled") {
            continue;
        }
        state.status = match action {
            "resume" => "ready",
            "cancel" => "cancelled",
            _ => "paused",
        }
        .into();
        if action == "resume" {
            state.iteration += 1;
            state.run_id = None;
            // Keep provider cooldowns even on manual resume.
        } else {
            for run in records
                .iter()
                .filter(|r| r.work_id == id && refreshable_status(&r.status))
            {
                request_cancel(root, &run.id)?;
            }
        }
        store::save(root, &state)?;
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchItem {
    pub work_id: String,
    pub outcome: String,
    pub reason: String,
}

#[tauri::command]
pub fn goal_start_selected(work_ids: Vec<String>) -> Result<Vec<BatchItem>, String> {
    start_selected_at(&sdlc::vault_root()?, work_ids)
}

fn start_selected_at(root: &Path, work_ids: Vec<String>) -> Result<Vec<BatchItem>, String> {
    if work_ids.is_empty() || work_ids.len() > 100 {
        return Err("한 번에 1~100개 작업을 선택하세요".into());
    }
    let _control = crate::workspace_io::lock(root, "goal-control")?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for id in work_ids.into_iter().filter(|id| seen.insert(id.clone())) {
        let outcome = (|| {
            sdlc::validate_id(&id)?;
            let _launch = crate::workspace_io::lock(root, "harness-launch")?;
            let records = list_records(root)?;
            if active_for(&records, &id) {
                return Err("다른 에이전트가 실행 중인 작업입니다".into());
            }
            if let Ok(state) = store::read(root, &id) {
                if state.parent_id.is_some() {
                    return Err("하위 작업은 부모 목표에서 관리합니다".into());
                }
                if matches!(state.status.as_str(), "completed" | "cancelled") {
                    return Err("완료하거나 취소한 목표입니다".into());
                }
                if matches!(state.status.as_str(), "ready" | "running" | "waiting-quota") {
                    return Ok("already-queued");
                }
            }
            store::adopt_locked(root, &id)?;
            control_locked(root, &id, "resume")?;
            Ok::<_, String>("queued")
        })();
        result.push(match outcome {
            Ok(outcome) => BatchItem {
                work_id: id,
                outcome: outcome.into(),
                reason: String::new(),
            },
            Err(reason) => BatchItem {
                work_id: id,
                outcome: "skipped".into(),
                reason,
            },
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn normal_work(root: &Path, id: &str, status: &str, dependencies: Vec<String>) -> String {
        let dir = root.join("work").join(id);
        fs::create_dir_all(&dir).unwrap();
        let work = sdlc::WorkItem {
            id: id.into(),
            title: format!("Task {id}"),
            project_id: "game".into(),
            stage: "design".into(),
            status: status.into(),
            priority: "normal".into(),
            depends_on: dependencies,
            workflow_id: "sdd-main".into(),
            workflow_version: "1.1.0".into(),
            issue_type: "작업".into(),
            execution_type: "코드".into(),
            ..Default::default()
        };
        let original = format!(
            "---\n{}---\n\nPreserve original scope and requirements.\n",
            serde_yaml::to_string(&work).unwrap()
        );
        fs::write(dir.join("work.md"), &original).unwrap();
        fs::write(
            dir.join("spec.md"),
            "# Original design\nExisting acceptance criteria.",
        )
        .unwrap();
        original
    }

    #[test]
    fn batch_adopts_in_place_preserves_sources_skips_ineligible_and_is_idempotent() {
        let (dir, _) = fixture();
        let root = dir.path();
        let original = normal_work(root, "ordinary", "ready", vec![]);
        normal_work(root, "closed", "done", vec![]);
        let results = start_selected_at(
            root,
            vec![
                "ordinary".into(),
                "ordinary".into(),
                "closed".into(),
                "missing".into(),
            ],
        )
        .unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].outcome, "queued");
        assert!(results[1..]
            .iter()
            .all(|r| r.outcome == "skipped" && !r.reason.is_empty()));
        assert_eq!(
            fs::read_to_string(root.join("work/ordinary/goal-source.md")).unwrap(),
            original
        );
        assert!(fs::read_to_string(root.join("work/ordinary/spec.md"))
            .unwrap()
            .contains("Existing acceptance criteria"));
        let work = sdlc::snapshot(root)
            .unwrap()
            .work
            .into_iter()
            .find(|w| w.id == "ordinary")
            .unwrap();
        assert_eq!(work.workflow_id, store::WORKFLOW);
        assert_eq!(work.status, "ready");
        assert!(store::read(root, "ordinary")
            .unwrap()
            .objective
            .contains("spec.md"));
        let iteration = store::read(root, "ordinary").unwrap().iteration;
        assert_eq!(
            start_selected_at(root, vec!["ordinary".into()]).unwrap()[0].outcome,
            "already-queued"
        );
        assert_eq!(store::read(root, "ordinary").unwrap().iteration, iteration);
        assert_eq!(
            fs::read_to_string(root.join("work/ordinary/goal-source.md")).unwrap(),
            original
        );
    }

    #[test]
    fn batch_resumes_paused_goals_without_losing_quota_deadline_and_skips_claims() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        control_at(root, "goal-game", "pause").unwrap();
        let mut state = store::read(root, "goal-game").unwrap();
        state.next_retry_at = Some((Utc::now() + chrono::Duration::hours(1)).to_rfc3339());
        store::save(root, &state).unwrap();
        let result = start_selected_at(root, vec!["goal-game".into()]).unwrap();
        assert_eq!(result[0].outcome, "queued");
        assert_eq!(
            store::read(root, "goal-game").unwrap().next_retry_at,
            state.next_retry_at
        );
        tick_with(root, &cfg, &|_, _| panic!("quota is not reset")).unwrap();
        normal_work(root, "claimed", "ready", vec![]);
        let mut run = super::super::tests::record(Uuid::new_v4().to_string(), None, "running");
        run.work_id = "claimed".into();
        save_record(root, &run).unwrap();
        assert_eq!(
            start_selected_at(root, vec!["claimed".into()]).unwrap()[0].outcome,
            "skipped"
        );
        assert!(!root.join("work/claimed/goal.json").exists());
    }

    #[test]
    fn adopted_goal_can_depend_on_completed_work_in_another_workflow() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        control_at(root, "goal-game", "pause").unwrap();
        normal_work(root, "predecessor", "done", vec![]);
        normal_work(root, "dependent", "ready", vec!["predecessor".into()]);
        assert_eq!(
            start_selected_at(root, vec!["dependent".into()]).unwrap()[0].outcome,
            "queued"
        );
        tick_with(root, &cfg, &|_, _| {}).unwrap();
        assert!(store::read(root, "dependent").unwrap().run_id.is_some());
    }
    fn fixture() -> (tempfile::TempDir, config::HerdrCfg) {
        let root = tempfile::tempdir().unwrap();
        sdlc::initialize(root.path()).unwrap();
        sdlc::save_project_at(
            root.path(),
            sdlc::Project {
                id: "game".into(),
                name: "Game".into(),
                workflow_id: "goal-main".into(),
                workflow_version: "1.0.0".into(),
                repo_path: root.path().display().to_string(),
                default_agent: "codex".into(),
                ..Default::default()
            },
        )
        .unwrap();
        store::create_at(
            root.path(),
            store::CreateGoal {
                id: "goal-game".into(),
                project_id: "game".into(),
                objective: "Build and test a playable game".into(),
                max_parallel: 2,
                start: true,
                workflow_version: String::new(), issue_type: "작업".into(),
            },
        )
        .unwrap();
        (
            root,
            config::HerdrCfg {
                max_parallel: 4,
                mode: "headless".into(),
                ..Default::default()
            },
        )
    }

    fn finish(root: &Path, work: &str, action: &str, tasks: Value) {
        let state = store::read(root, work).unwrap();
        let mut run = load_record(root, state.run_id.as_deref().unwrap()).unwrap();
        fs::write(result_path(root, &run.id).unwrap(), serde_json::to_vec(&serde_json::json!({
            "runId":run.id, "action":action, "evidence":"Actual checks and changes recorded in evidence.md",
            "checks":[{"command":"game smoke test", "result":"passed", "passed":true}], "tasks":tasks
        })).unwrap()).unwrap();
        update(&mut run, "review", None);
        save_record(root, &run).unwrap();
    }

    #[test]
    fn autonomous_goal_runs_parallel_tasks_then_independent_verification_to_completion() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        let tick = || tick_with(root, &cfg, &|_, _| {}).unwrap();
        tick();
        finish(
            root,
            "goal-game",
            "tasks",
            serde_json::json!([
                {"key":"a","title":"Game","objective":"Implement game and test", "scope":["src/game"]},
                {"key":"b","title":"Art","objective":"Create art", "scope":["assets"]},
                {"key":"c","title":"Integration","objective":"Integrate and play test", "scope":["."],"dependsOn":["a","b"]}
            ]),
        );
        tick();
        tick();
        let goal = store::read(root, "goal-game").unwrap();
        let a = &goal.tasks[0].id;
        let b = &goal.tasks[1].id;
        let c = &goal.tasks[2].id;
        assert!(store::read(root, a).unwrap().run_id.is_some());
        assert!(store::read(root, b).unwrap().run_id.is_some());
        assert!(store::read(root, c).unwrap().run_id.is_none());
        let count = list_records(root).unwrap().len();
        tick();
        assert_eq!(list_records(root).unwrap().len(), count); // no duplicate claims
        finish(root, a, "complete", serde_json::json!([]));
        finish(root, b, "complete", serde_json::json!([]));
        tick();
        tick();
        for id in [a, b] {
            let state = store::read(root, id).unwrap();
            assert_eq!(state.phase, "verify");
            assert_eq!(
                load_record(root, state.run_id.as_deref().unwrap())
                    .unwrap()
                    .role,
                "verifier"
            );
            finish(root, id, "complete", serde_json::json!([]));
        }
        tick();
        tick();
        assert!(store::read(root, c).unwrap().run_id.is_some());
        finish(root, c, "complete", serde_json::json!([]));
        tick();
        tick();
        finish(root, c, "complete", serde_json::json!([]));
        tick();
        tick();
        let goal = store::read(root, "goal-game").unwrap();
        assert_eq!(goal.phase, "verify");
        finish(root, "goal-game", "complete", serde_json::json!([]));
        tick();
        tick();
        assert_eq!(store::read(root, "goal-game").unwrap().status, "completed");
        assert_eq!(
            sdlc::snapshot(root)
                .unwrap()
                .work
                .iter()
                .find(|w| w.id == "goal-game")
                .unwrap()
                .status,
            "done"
        );
    }

    #[test]
    fn quota_wait_is_durable_and_cancel_does_not_restart_work() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        tick_with(root, &cfg, &|_, _| {}).unwrap();
        let state = store::read(root, "goal-game").unwrap();
        let mut run = load_record(root, state.run_id.as_deref().unwrap()).unwrap();
        update(
            &mut run,
            "failed",
            Some("rate_limit_exceeded: usage limit".into()),
        );
        save_record(root, &run).unwrap();
        tick_with(root, &cfg, &|_, _| {}).unwrap();
        let state = store::read(root, "goal-game").unwrap();
        assert_eq!(state.status, "waiting-quota");
        assert!(cooldowns(root).unwrap().contains_key("codex"));
        tick_with(root, &cfg, &|_, _| panic!("must wait an hour")).unwrap();
        control_at(root, "goal-game", "pause").unwrap();
        control_at(root, "goal-game", "resume").unwrap();
        tick_with(root, &cfg, &|_, _| {
            panic!("manual resume must retain cooldown")
        })
        .unwrap();
        control_at(root, "goal-game", "cancel").unwrap();
        tick_with(root, &cfg, &|_, _| {
            panic!("cancelled goal must stay stopped")
        })
        .unwrap();
        assert_eq!(store::read(root, "goal-game").unwrap().status, "cancelled");
    }

    #[test]
    fn claims_are_exclusive_across_roles_and_processes_but_release_on_completion() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        let input = LaunchInput {
            work_id: "goal-game".into(),
            project_id: "game".into(),
            agent: "codex".into(),
            role: "planner".into(),
            ..Default::default()
        };
        let run = record_launch_with_config(root, &input, None, &cfg).unwrap();
        let mut second = input.clone();
        second.role = "verifier".into();
        assert!(record_launch_with_config(root, &second, None, &cfg)
            .unwrap_err()
            .contains("이미 진행 중"));
        let mut first = run;
        update(&mut first, "review", None);
        save_record(root, &first).unwrap();
        let claim = crate::workspace_io::lock(root, "harness-launch").unwrap();
        assert!(record_launch_with_config(root, &second, None, &cfg)
            .unwrap_err()
            .contains("workspace-busy"));
        drop(claim);
        assert!(record_launch_with_config(root, &second, None, &cfg).is_ok());
    }

    #[test]
    fn live_foreign_worker_is_not_reaped_and_crashed_worker_is_recoverable() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        let input = LaunchInput {
            work_id: "goal-game".into(),
            project_id: "game".into(),
            agent: "codex".into(),
            role: "planner".into(),
            ..Default::default()
        };
        let mut run = record_launch_with_config(root, &input, None, &cfg).unwrap();
        update(&mut run, "running", None);
        save_record(root, &run).unwrap();
        let owner = crate::workspace_io::lock(root, &format!("run-owner-{}", run.id)).unwrap();
        assert_eq!(
            headless::refresh(root, run.clone()).unwrap().status,
            "running"
        );
        drop(owner);
        assert_eq!(headless::refresh(root, run).unwrap().status, "failed");
    }

    #[cfg(unix)]
    #[test]
    fn detached_process_keeps_its_claim_until_it_exits() {
        let (dir, cfg) = fixture();
        let root = dir.path();
        let input = LaunchInput {
            work_id: "goal-game".into(),
            project_id: "game".into(),
            agent: "codex".into(),
            role: "planner".into(),
            ..Default::default()
        };
        let mut run = record_launch_with_config(root, &input, None, &cfg).unwrap();
        let mut child = crate::spawn::platform_command("/bin/sleep", &["30"])
            .spawn()
            .unwrap();
        run.worker_pid = Some(child.id());
        update(&mut run, "running", None);
        let recovered = headless::refresh(root, run).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(recovered.status, "unknown");
        assert_eq!(headless::refresh(root, recovered).unwrap().status, "failed");
    }
    #[test]
    fn completion_requires_matching_run_and_passing_independent_checks() {
        let state = GoalState {
            phase: "verify".into(),
            ..Default::default()
        };
        let mut result = TurnResult {
            run_id: "run".into(),
            action: "complete".into(),
            evidence: "tested".into(),
            checks: vec![],
            tasks: vec![],
            scope: vec![],
        };
        assert!(validate_result(&result, &state, "run").is_err());
        result.checks.push(Check {
            command: "test".into(),
            result: "passed".into(),
            passed: true,
        });
        assert!(validate_result(&result, &state, "other").is_err());
        assert!(validate_result(&result, &state, "run").is_ok());
        result.checks[0].passed = false;
        assert!(validate_result(&result, &state, "run").is_err());
    }
    #[test]
    fn rejects_duplicate_cyclic_and_missing_dependencies() {
        let state = GoalState::default();
        let mut result: TurnResult = serde_json::from_value(serde_json::json!({
            "runId":"run", "action":"tasks", "evidence":"plan",
            "tasks":[{"key":"a","title":"A","objective":"A","scope":["src/a"],"dependsOn":["b"]},
                     {"key":"b","title":"B","objective":"B","scope":["src/b"],"dependsOn":[]}]
        }))
        .unwrap();
        assert!(validate_result(&result, &state, "run").is_ok());
        result.tasks[1].depends_on.push("a".into());
        assert!(validate_result(&result, &state, "run").is_err());
        result.tasks[1].depends_on = vec!["missing".into()];
        assert!(validate_result(&result, &state, "run").is_err());
        result.tasks[1].key = "a".into();
        assert!(validate_result(&result, &state, "run").is_err());
    }
}
