//! Durable autonomous goals. This sidecar owns the queue; work.md is its projection.
use super::*;

pub const WORKFLOW: &str = "goal-main";
pub const RETRY_SECONDS: i64 = 3600;

/// Called with goal-control and harness-launch held, so adoption cannot race a launch.
pub fn adopt_locked(root: &Path, id: &str) -> Result<GoalState, String> {
    let _guard = mutation_lock();
    let mut work = work_by_id(root, id)?;
    if CLOSED_STATUSES.contains(&work.status.as_str()) {
        return Err("완료하거나 취소한 작업은 시작할 수 없습니다".into());
    }
    if work.workflow_id == WORKFLOW {
        return read(root, id);
    }
    if work.workflow_id == "mockup-review" || work.artifacts.iter().any(|a| a == "mockup") {
        return Err("목업 검토 항목은 작업 상세에서 진행하세요".into());
    }
    if lifecycle::supports(&work) {
        let lifecycle = lifecycle::read(root, id)?;
        if matches!(work.stage.as_str(), "build" | "unconfirmed" | "discarding")
            || !lifecycle.run_repo.is_empty()
        {
            return Err("이미 구현한 작업의 통합·결과 확인을 먼저 마쳐 주세요".into());
        }
    }
    let project = project_by_id(root, &work.project_id)?;
    if !Path::new(&project.repo_path).is_dir()
        || !matches!(
            crate::agents::normalize_id(&project.default_agent),
            "codex" | "claude"
        )
    {
        return Err("프로젝트 저장소와 Codex 또는 Claude 기본 에이전트가 필요합니다".into());
    }
    let source_definition = workflow_definition_for_work(root, &work)?;
    let sources = source_definition
        .artifacts
        .iter()
        .map(|artifact| {
            resolved_artifact_path(root, &work, &source_definition, &artifact.role)
                .map(|path| format!("- {}: {}", artifact.role, path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?
        .join("\n");
    let backup = work_path(root, id).with_file_name("goal-source.md");
    safe_path(root, &backup)?;
    if !backup.exists() {
        write_atomic(
            root,
            &backup,
            &fs::read_to_string(work_path(root, id)).map_err(|e| e.to_string())?,
        )?;
    }
    let state = GoalState {
        work_id: id.into(), phase: "plan".into(), status: "paused".into(), max_parallel: 3,
        objective: format!("{}\n\n{}\n\n기존 작업의 의도와 수용 기준을 달성하세요. 기존 설계·구현·검증 근거를 먼저 읽고 남은 작업을 자율 수행하세요.\n원래 작업 기록: {}\n기존 산출물:\n{}", work.title, work.description, backup.display(), sources),
        scope: vec![".".into()], ..Default::default()
    };
    let definition = workflow::builtins::goal();
    work.decisions.push(Decision {
        stage: work.stage.clone(),
        at: now(),
        note: "선택한 작업을 골 모드로 전환하여 자율 실행".into(),
    });
    work.workflow_id = WORKFLOW.into();
    work.workflow_version = definition.version.clone();
    work.workflow_digest = workflow::definition_digest(&definition)?;
    work.workflow_instance_id = None;
    work.active_nodes.clear();
    work.stage = "pursue".into();
    work.status = "blocked".into();
    work.updated_at = now();
    let evidence = work_path(root, id).with_file_name("evidence.md");
    safe_path(root, &evidence)?;
    if !evidence.exists() {
        write_atomic(root, &evidence, "# 진행 및 검증 근거\n")?;
    }
    work.artifacts = vec!["evidence".into()];
    // Persist paused state before switching the work identity. A crash never
    // starts a half-adopted task, and a retry repairs the same work ID.
    write_atomic(
        root,
        &work_path(root, id).with_file_name("goal.json"),
        &serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?,
    )?;
    let body = work.description.clone();
    work.description.clear();
    write_atomic(root, &work_path(root, id), &markdown(&work, &body)?)?;
    Ok(state)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GoalState {
    pub work_id: String,
    pub parent_id: Option<String>,
    pub objective: String,
    pub status: String,
    pub phase: String,
    pub max_parallel: usize,
    pub iteration: u64,
    pub run_id: Option<String>,
    pub next_retry_at: Option<String>,
    pub last_error: String,
    pub evidence: String,
    pub scope: Vec<String>,
    pub tasks: Vec<GoalTask>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GoalTask {
    pub id: String,
    pub title: String,
    pub objective: String,
    pub scope: Vec<String>,
    pub depends_on: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGoal {
    pub id: String,
    pub project_id: String,
    pub objective: String,
    pub max_parallel: usize,
    pub start: bool,
}

pub fn read(root: &Path, id: &str) -> Result<GoalState, String> {
    validate_id(id)?;
    let path = work_path(root, id).with_file_name("goal.json");
    safe_path(root, &path)?;
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn save(root: &Path, state: &GoalState) -> Result<(), String> {
    validate_id(&state.work_id)?;
    let path = work_path(root, &state.work_id).with_file_name("goal.json");
    safe_path(root, &path)?;
    let contents = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    if fs::read_to_string(&path).ok().as_deref() != Some(contents.as_str()) {
        write_atomic(root, &path, &contents)?;
    }
    // If interrupted between the writes, the next tick repairs this projection.
    let _guard = mutation_lock();
    let mut work = work_by_id(root, &state.work_id)?;
    let status = match state.status.as_str() {
        "completed" => "done",
        "cancelled" => "cancelled",
        "paused" | "waiting-quota" => "blocked",
        "running" => "running",
        _ => "ready",
    };
    let stage = if state.status == "completed" {
        "done"
    } else {
        "pursue"
    };
    if work.status != status || work.stage != stage {
        work.status = status.into();
        work.stage = stage.into();
        work.updated_at = now();
        apply_closure(&mut work);
        let mut header = work.clone();
        header.description.clear();
        write_atomic(
            root,
            &work_path(root, &work.id),
            &markdown(&header, &work.description)?,
        )?;
    }
    Ok(())
}

pub fn create_at(root: &Path, input: CreateGoal) -> Result<WorkItem, String> {
    validate_id(&input.id)?;
    if input.objective.trim().is_empty() || input.objective.len() > 32_000 {
        return Err("목표는 비어 있지 않은 32,000바이트 이하 문자열이어야 합니다".into());
    }
    if !(1..=16).contains(&input.max_parallel) {
        return Err("병렬 작업 수는 1~16이어야 합니다".into());
    }
    let project = project_by_id(root, &input.project_id)?;
    if !matches!(
        crate::agents::normalize_id(&project.default_agent),
        "codex" | "claude"
    ) {
        return Err("골 모드는 프로젝트 기본 에이전트로 Codex 또는 Claude가 필요합니다".into());
    }
    if !Path::new(&project.repo_path).is_dir() {
        return Err("목표를 실행할 프로젝트 저장소가 필요합니다".into());
    }
    let _lock = crate::workspace_io::lock(root, "goal-control")?;
    if let Ok(existing) = read(root, &input.id) {
        if existing.objective != input.objective
            || work_by_id(root, &input.id)?.project_id != input.project_id
        {
            return Err("이미 다른 목표가 사용 중인 ID입니다".into());
        }
        return work_by_id(root, &input.id);
    }
    if work_path(root, &input.id).exists() {
        let work = work_by_id(root, &input.id)?;
        if work.workflow_id != WORKFLOW
            || work.description != input.objective
            || work.project_id != input.project_id
        {
            return Err("이미 사용 중인 작업 ID입니다".into());
        }
    }
    save_work_at(
        root,
        WorkItem {
            id: input.id.clone(),
            project_id: input.project_id,
            title: input
                .objective
                .lines()
                .next()
                .unwrap_or("목표")
                .chars()
                .take(100)
                .collect(),
            description: input.objective.clone(),
            workflow_id: WORKFLOW.into(),
            workflow_version: "1.0.0".into(),
            ..Default::default()
        },
    )?;
    save(
        root,
        &GoalState {
            work_id: input.id.clone(),
            objective: input.objective,
            status: if input.start { "ready" } else { "paused" }.into(),
            phase: "plan".into(),
            max_parallel: input.max_parallel,
            scope: vec![".".into()],
            ..Default::default()
        },
    )?;
    work_by_id(root, &input.id)
}

pub fn materialize_tasks(root: &Path, parent: &GoalState) -> Result<(), String> {
    let project_id = work_by_id(root, &parent.work_id)?.project_id;
    for task in &parent.tasks {
        if !work_path(root, &task.id).exists() {
            save_work_at(
                root,
                WorkItem {
                    id: task.id.clone(),
                    project_id: project_id.clone(),
                    title: task.title.clone(),
                    description: task.objective.clone(),
                    depends_on: Vec::new(),
                    workflow_id: WORKFLOW.into(),
                    workflow_version: "1.0.0".into(),
                    tags: vec![format!("goal:{}", parent.work_id)],
                    ..Default::default()
                },
            )?;
        }
        if !work_path(root, &task.id)
            .with_file_name("goal.json")
            .exists()
        {
            save(
                root,
                &GoalState {
                    work_id: task.id.clone(),
                    parent_id: Some(parent.work_id.clone()),
                    objective: task.objective.clone(),
                    scope: task.scope.clone(),
                    phase: "work".into(),
                    status: "ready".into(),
                    max_parallel: parent.max_parallel,
                    ..Default::default()
                },
            )?;
        }
    }
    // All IDs exist before writing dependency edges, including forward references.
    for task in &parent.tasks {
        let mut work = work_by_id(root, &task.id)?;
        if work.depends_on != task.depends_on {
            work.depends_on = task.depends_on.clone();
            save_work_at(root, work)?;
        }
    }
    Ok(())
}

pub fn due(state: &GoalState, at: chrono::DateTime<Utc>) -> bool {
    !matches!(state.status.as_str(), "paused" | "cancelled" | "completed")
        && state.next_retry_at.as_ref().is_none_or(|time| {
            chrono::DateTime::parse_from_rfc3339(time).is_ok_and(|time| time <= at)
        })
}

pub fn quota_error(error: &str) -> bool {
    let text = error.to_lowercase();
    [
        "rate_limit",
        "rate limit",
        "usage limit",
        "usage_limit",
        "insufficient_quota",
        "quota exceeded",
        "quota exhausted",
        "out of credits",
        "credit balance is too low",
        "token limit reached",
        "you've hit your limit",
        "you have hit your limit",
        "too many requests",
        "사용량 한도",
        "토큰 소진",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

pub fn defer(state: &mut GoalState, error: String, at: chrono::DateTime<Utc>) {
    let quota = quota_error(&error);
    state.status = if quota { "waiting-quota" } else { "ready" }.into();
    state.next_retry_at =
        Some((at + chrono::Duration::seconds(if quota { RETRY_SECONDS } else { 20 })).to_rfc3339());
    state.last_error = error;
    state.run_id = None;
}

pub fn scope_valid(scope: &[String]) -> bool {
    !scope.is_empty()
        && scope.len() <= 32
        && scope.iter().all(|s| {
            s.len() <= 240
                && (s == "."
                    || (!s.is_empty()
                        && !s.contains('\\')
                        && Path::new(s)
                            .components()
                            .all(|p| matches!(p, Component::Normal(_)))))
        })
}

pub fn scopes_overlap(left: &[String], right: &[String]) -> bool {
    left.iter().any(|a| {
        right.iter().any(|b| {
            a == "." || b == "." || Path::new(a).starts_with(b) || Path::new(b).starts_with(a)
        })
    })
}

#[tauri::command]
pub fn goal_create(input: CreateGoal) -> Result<WorkItem, String> {
    create_at(&vault_root()?, input)
}

#[tauri::command]
pub fn goal_state(work_id: String) -> Result<Vec<GoalState>, String> {
    let root = vault_root()?;
    let state = read(&root, &work_id)?;
    let mut result = vec![state.clone()];
    for task in &state.tasks {
        result.push(read(&root, &task.id)?);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quota_retries_hourly_without_a_retry_limit_and_survives_serialization() {
        let at = Utc::now();
        let mut state = GoalState::default();
        for _ in 0..100 {
            defer(&mut state, "You've hit your usage limit".into(), at);
            state = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
            assert!(!due(&state, at + chrono::Duration::seconds(3599)));
            assert!(due(&state, at + chrono::Duration::seconds(3600)));
        }
        state.status = "paused".into();
        assert!(!due(&state, at + chrono::Duration::hours(2)));
        assert!(!quota_error("context window exceeded"));
        assert!(!quota_error("authentication failed"));
    }
    #[test]
    fn scopes_serialize_overlapping_paths_only() {
        let scope = |s: &str| vec![s.to_string()];
        assert!(scopes_overlap(&scope("src"), &scope("src/game.ts")));
        assert!(!scopes_overlap(&scope("src/a"), &scope("src/ab")));
        assert!(scopes_overlap(&scope("."), &scope("assets")));
        assert!(!scope_valid(&scope("../outside")));
        assert!(!scope_valid(&scope("/tmp")));
    }
}
