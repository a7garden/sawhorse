use std::collections::{HashMap, HashSet, VecDeque};

use super::model::*;

const ALLOWED_ROLES: [&str; 5] = ["research", "planner", "implementer", "verifier", "reviewer"];

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && crate::workspace_io::portable_component(value)
        && !matches!(value, "." | "..")
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_version(value: &str) -> bool {
    semver::Version::parse(value).is_ok()
}

fn valid_extension_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 38
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn issue(
    issues: &mut Vec<ValidationIssue>,
    severity: IssueSeverity,
    code: &str,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    issues.push(ValidationIssue {
        severity,
        code: code.into(),
        path: path.into(),
        message: message.into(),
    });
}

fn validate_artifact_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return Err("artifact path는 볼트 상대경로여야 합니다");
    }
    if path.contains("..")
        || path
            .split(['/', '\\'])
            .any(|part| part.is_empty() || part == ".")
    {
        return Err("artifact path에 빈 경로, . 또는 ..를 사용할 수 없습니다");
    }
    let mut without_allowed = path.replace("{workId}", "work");
    without_allowed = without_allowed.replace("{projectId}", "project");
    if without_allowed.contains('{') || without_allowed.contains('}') {
        return Err("지원하지 않는 artifact path placeholder입니다");
    }
    if without_allowed.contains('\\')
        || !without_allowed
            .split('/')
            .all(crate::workspace_io::portable_component)
    {
        return Err("artifact path는 / 구분자와 Windows/macOS 공통 파일명을 사용해야 합니다");
    }
    let first = without_allowed
        .split(['/', '\\'])
        .next()
        .unwrap_or_default();
    if first == ".sawhorse" {
        return Err("내부 .sawhorse 영역에는 artifact를 둘 수 없습니다");
    }
    Ok(())
}

pub fn validate(definition: &WorkflowDefinition) -> ValidationReport {
    let mut issues = Vec::new();
    if definition.definition_version != DEFINITION_VERSION {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "definition-version",
            "definitionVersion",
            format!(
                "지원하지 않는 definitionVersion입니다: {}",
                definition.definition_version
            ),
        );
    }
    if !valid_id(&definition.id) {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "invalid-id",
            "id",
            "workflow id는 영문, 숫자, -, _, .만 사용할 수 있습니다",
        );
    }
    if definition.label.trim().is_empty() {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "missing-label",
            "label",
            "표시 이름이 필요합니다",
        );
    }
    if !valid_version(&definition.version) {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "invalid-version",
            "version",
            "workflow version은 유효한 SemVer(x.y.z)여야 합니다",
        );
    }

    let mut requirement_ids = HashSet::new();
    for (index, requirement) in definition.requirements.iter().enumerate() {
        let path = format!("requirements[{index}]");
        let kind = match requirement.kind {
            WorkflowRequirementKind::Program => "program",
            WorkflowRequirementKind::Extension => "extension",
        };
        if !valid_id(&requirement.id) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-requirement-id",
                format!("{path}.id"),
                "requirement id는 영문, 숫자, -, _, .만 사용할 수 있습니다",
            );
        } else if !requirement_ids.insert((kind, requirement.id.as_str())) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "duplicate-requirement",
                format!("{path}.id"),
                format!("중복 workflow requirement입니다: {kind}:{}", requirement.id),
            );
        }
        if requirement.label.trim().is_empty() || requirement.reason.trim().is_empty() {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "incomplete-requirement",
                path.clone(),
                "requirement에는 표시 이름과 필요한 이유가 있어야 합니다",
            );
        }
        if !requirement.install_url.is_empty() && !requirement.install_url.starts_with("https://") {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-install-url",
                format!("{path}.installUrl"),
                "설치 링크는 비워 두거나 https:// URL이어야 합니다",
            );
        }
        match requirement.kind {
            WorkflowRequirementKind::Program => {
                let valid_command = |command: &str| {
                    !command.is_empty()
                        && command.len() <= 128
                        && command.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'-' | b'_' | b'.' | b'+')
                        })
                };
                if requirement.commands.is_empty()
                    || requirement
                        .commands
                        .iter()
                        .any(|command| !valid_command(command))
                {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "invalid-program-commands",
                        format!("{path}.commands"),
                        "program requirement에는 이식 가능한 실행 파일 이름이 하나 이상 필요합니다",
                    );
                }
                if !requirement.version.is_empty() {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "program-version-not-supported",
                        format!("{path}.version"),
                        "program 버전 범위는 아직 지원하지 않습니다. version을 비워 주세요",
                    );
                }
                if requirement.minimum_major > 0
                    && (requirement.version_args.is_empty()
                        || requirement
                            .version_args
                            .iter()
                            .any(|argument| !matches!(argument.as_str(), "--version" | "-V")))
                {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "invalid-version-probe",
                        format!("{path}.versionArgs"),
                        "최소 버전을 검사하려면 versionArgs에 --version 또는 -V만 사용할 수 있습니다",
                    );
                }
            }
            WorkflowRequirementKind::Extension => {
                if !valid_extension_id(&requirement.id) {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "invalid-extension-requirement-id",
                        format!("{path}.id"),
                        "extension requirement ID는 패키지 ID와 같은 소문자·숫자·하이픈 형식이어야 합니다",
                    );
                }
                if !requirement.commands.is_empty() {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "extension-has-commands",
                        format!("{path}.commands"),
                        "extension requirement에는 commands를 둘 수 없습니다",
                    );
                }
                if semver::VersionReq::parse(&requirement.version).is_err() {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "invalid-extension-version",
                        format!("{path}.version"),
                        "extension requirement에는 유효한 SemVer 범위가 필요합니다",
                    );
                }
                if requirement.minimum_major > 0 || !requirement.version_args.is_empty() {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "extension-has-program-version",
                        path,
                        "extension requirement에는 minimumMajor/versionArgs를 둘 수 없습니다",
                    );
                }
            }
        }
    }

    let mut artifact_roles = HashSet::new();
    let mut artifact_paths = HashSet::new();
    for (index, artifact) in definition.artifacts.iter().enumerate() {
        let path = format!("artifacts[{index}]");
        if !valid_id(&artifact.role) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-artifact-role",
                format!("{path}.role"),
                "artifact role이 유효하지 않습니다",
            );
        } else if !artifact_roles.insert(artifact.role.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "duplicate-artifact-role",
                format!("{path}.role"),
                format!("중복 artifact role입니다: {}", artifact.role),
            );
        }
        if artifact.label.trim().is_empty() {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-artifact-label",
                format!("{path}.label"),
                "artifact 표시 이름이 필요합니다",
            );
        }
        if let Err(message) = validate_artifact_path(&artifact.path) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-artifact-path",
                format!("{path}.path"),
                message,
            );
        } else if !artifact_paths.insert(artifact.path.to_lowercase()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "duplicate-artifact-path",
                format!("{path}.path"),
                "두 artifact가 같은 경로를 사용할 수 없습니다",
            );
        }
        if artifact.template.len() > 1024 * 1024 {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "template-too-large",
                format!("{path}.template"),
                "artifact template은 1 MiB를 넘을 수 없습니다",
            );
        }
    }

    let mut node_ids = HashSet::new();
    for (index, node) in definition.nodes.iter().enumerate() {
        let path = format!("nodes[{index}]");
        if !valid_id(&node.id) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-node-id",
                format!("{path}.id"),
                "node id가 유효하지 않습니다",
            );
        } else if !node_ids.insert(node.id.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "duplicate-node-id",
                format!("{path}.id"),
                format!("중복 node id입니다: {}", node.id),
            );
        }
        if node.label.trim().is_empty() {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-node-label",
                format!("{path}.label"),
                "node 표시 이름이 필요합니다",
            );
        }
        for (field, roles) in [("inputs", &node.inputs), ("outputs", &node.outputs)] {
            for role in roles {
                if !artifact_roles.contains(role.as_str()) {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "unknown-artifact-role",
                        format!("{path}.{field}"),
                        format!("정의되지 않은 artifact role입니다: {role}"),
                    );
                }
            }
        }
        for role in &node.allowed_roles {
            if !ALLOWED_ROLES.contains(&role.as_str()) {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "unknown-agent-role",
                    format!("{path}.allowedRoles"),
                    format!("지원하지 않는 agent role입니다: {role}"),
                );
            }
        }
        match node.kind {
            NodeKind::Artifact if node.artifact_role.is_none() => issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-artifact-role",
                format!("{path}.artifactRole"),
                "artifact node에는 artifactRole이 필요합니다",
            ),
            NodeKind::Agent | NodeKind::Check if node.action_ref.is_none() => issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-action-ref",
                format!("{path}.actionRef"),
                "agent/check node에는 등록된 actionRef가 필요합니다",
            ),
            NodeKind::Human if node.decision.is_none() => issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-decision",
                format!("{path}.decision"),
                "human node에는 decision 계약이 필요합니다",
            ),
            NodeKind::Subworkflow if node.workflow_ref.is_none() => issue(
                &mut issues,
                IssueSeverity::Error,
                "missing-workflow-ref",
                format!("{path}.workflowRef"),
                "subworkflow node에는 정확한 workflowRef 버전이 필요합니다",
            ),
            _ => {}
        }
        if let Some(role) = &node.artifact_role {
            if !artifact_roles.contains(role.as_str()) {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "unknown-artifact-role",
                    format!("{path}.artifactRole"),
                    format!("정의되지 않은 artifact role입니다: {role}"),
                );
            }
        }
        if let Some(reference) = &node.workflow_ref {
            if !valid_id(&reference.id) || !valid_version(&reference.version) {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "invalid-workflow-ref",
                    format!("{path}.workflowRef"),
                    "subworkflow는 정확한 id와 x.y.z version을 가져야 합니다",
                );
            }
            if reference.id == definition.id && reference.version == definition.version {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "recursive-workflow",
                    format!("{path}.workflowRef"),
                    "workflow는 자신을 하위 흐름으로 참조할 수 없습니다",
                );
            }
        }
    }

    if !node_ids.contains(definition.entry.as_str()) {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "unknown-entry",
            "entry",
            "entry가 정의된 node를 가리키지 않습니다",
        );
    }

    let mut loop_ids = HashSet::new();
    for (index, loop_definition) in definition.loops.iter().enumerate() {
        if !valid_id(&loop_definition.id) || !loop_ids.insert(loop_definition.id.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-loop",
                format!("loops[{index}].id"),
                "loop id가 유효하고 중복되지 않아야 합니다",
            );
        }
        if !(1..=10_000).contains(&loop_definition.max_iterations) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-loop-limit",
                format!("loops[{index}].maxIterations"),
                "maxIterations는 1~10000이어야 합니다",
            );
        }
    }

    let mut adjacency: HashMap<&str, Vec<(&str, Option<&str>)>> = HashMap::new();
    let mut edge_keys = HashSet::new();
    let mut referenced_loops = HashSet::new();
    for (index, edge) in definition.edges.iter().enumerate() {
        let path = format!("edges[{index}]");
        if !node_ids.contains(edge.from.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "unknown-edge-node",
                format!("{path}.from"),
                format!("정의되지 않은 시작 node입니다: {}", edge.from),
            );
        }
        if !node_ids.contains(edge.to.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "unknown-edge-node",
                format!("{path}.to"),
                format!("정의되지 않은 대상 node입니다: {}", edge.to),
            );
        }
        if !valid_id(&edge.on) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "invalid-event",
                format!("{path}.on"),
                "edge event가 유효하지 않습니다",
            );
        }
        if !edge_keys.insert((&edge.from, &edge.to, &edge.on)) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "duplicate-edge",
                path.clone(),
                "같은 from/to/event edge가 중복되었습니다",
            );
        }
        if let Some(reference) = &edge.loop_ref {
            referenced_loops.insert(reference.as_str());
            if !loop_ids.contains(reference.as_str()) {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "unknown-loop-ref",
                    format!("{path}.loopRef"),
                    format!("정의되지 않은 loopRef입니다: {reference}"),
                );
            }
        }
        if let Some(condition) = &edge.condition {
            if !valid_id(&condition.field) {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "invalid-condition-field",
                    format!("{path}.condition.field"),
                    "condition field는 안전한 fact key여야 합니다",
                );
            }
            if matches!(
                condition.operator,
                ConditionOperator::Equals | ConditionOperator::NotEquals
            ) && condition.value.is_none()
            {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "missing-condition-value",
                    format!("{path}.condition.value"),
                    "equals/not-equals 조건에는 value가 필요합니다",
                );
            }
        }
        adjacency
            .entry(edge.from.as_str())
            .or_default()
            .push((edge.to.as_str(), edge.loop_ref.as_deref()));
    }

    for loop_id in loop_ids.difference(&referenced_loops) {
        issue(
            &mut issues,
            IssueSeverity::Warning,
            "unused-loop",
            "loops",
            format!("사용되지 않는 loop입니다: {loop_id}"),
        );
    }

    // Ambiguous unconditional branches would make the host choose arbitrary behavior.
    let mut branch_groups: HashMap<(&str, &str), Vec<&WorkflowEdge>> = HashMap::new();
    for edge in &definition.edges {
        branch_groups
            .entry((edge.from.as_str(), edge.on.as_str()))
            .or_default()
            .push(edge);
    }
    for ((from, event), edges) in branch_groups {
        if edges.len() > 1 && edges.iter().any(|edge| edge.condition.is_none()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "ambiguous-branch",
                "edges",
                format!("{from}의 {event} 분기는 모두 명시적 condition이 필요합니다"),
            );
        }
    }

    // Reachability is independent from whether a cycle is an explicit bounded loop.
    let mut reachable = HashSet::new();
    let mut queue = VecDeque::from([definition.entry.as_str()]);
    while let Some(node) = queue.pop_front() {
        if !reachable.insert(node) {
            continue;
        }
        for (next, _) in adjacency.get(node).into_iter().flatten() {
            queue.push_back(next);
        }
    }
    for (index, node) in definition.nodes.iter().enumerate() {
        if !reachable.contains(node.id.as_str()) {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "unreachable-node",
                format!("nodes[{index}]"),
                format!("entry에서 도달할 수 없는 node입니다: {}", node.id),
            );
        }
        let outgoing = adjacency.get(node.id.as_str()).map(Vec::len).unwrap_or(0);
        if matches!(node.kind, NodeKind::End) && outgoing > 0 {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "end-has-edge",
                format!("nodes[{index}]"),
                "end node에는 나가는 edge가 없어야 합니다",
            );
        } else if !matches!(node.kind, NodeKind::End) && outgoing == 0 {
            issue(
                &mut issues,
                IssueSeverity::Error,
                "dead-end-node",
                format!("nodes[{index}]"),
                "end가 아닌 node에는 나가는 edge가 필요합니다",
            );
        }
    }
    if !definition
        .nodes
        .iter()
        .any(|node| matches!(node.kind, NodeKind::End) && reachable.contains(node.id.as_str()))
    {
        // Long-running workflows may intentionally end at an artifact node, but report it.
        issue(
            &mut issues,
            IssueSeverity::Warning,
            "no-end-node",
            "nodes",
            "도달 가능한 end node가 없습니다. 마지막 node는 계속 대기 상태로 남습니다",
        );
    }

    // Every graph back-edge must be explicitly tied to a bounded loop.
    fn visit<'a>(
        node: &'a str,
        adjacency: &HashMap<&'a str, Vec<(&'a str, Option<&'a str>)>>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
        missing: &mut Vec<(String, String)>,
    ) {
        if !visiting.insert(node) {
            return;
        }
        for (next, loop_ref) in adjacency.get(node).into_iter().flatten() {
            if visiting.contains(next) && loop_ref.is_none() {
                missing.push((node.into(), (*next).into()));
            }
            if !visited.contains(next) {
                visit(next, adjacency, visiting, visited, missing);
            }
        }
        visiting.remove(node);
        visited.insert(node);
    }
    let mut missing = Vec::new();
    visit(
        definition.entry.as_str(),
        &adjacency,
        &mut HashSet::new(),
        &mut HashSet::new(),
        &mut missing,
    );
    for (from, to) in missing {
        issue(
            &mut issues,
            IssueSeverity::Error,
            "unbounded-cycle",
            "edges",
            format!("{from} → {to} 순환에는 bounded loopRef가 필요합니다"),
        );
    }

    ValidationReport {
        valid: !issues
            .iter()
            .any(|candidate| candidate.severity == IssueSeverity::Error),
        issues,
    }
}

pub fn validate_registry(definitions: &[WorkflowDefinition]) -> Vec<ValidationIssue> {
    let available: HashSet<_> = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), definition.version.as_str()))
        .collect();
    let mut issues = Vec::new();
    let mut revisions = HashMap::new();
    let mut portable_revisions = HashMap::new();
    let mut portable_ids = HashMap::new();
    for definition in definitions {
        let key = (definition.id.as_str(), definition.version.as_str());
        if let Some(previous) =
            portable_ids.insert(definition.id.to_ascii_lowercase(), definition.id.as_str())
        {
            if previous != definition.id {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "nonportable-workflow-id",
                    &definition.id,
                    "대소문자만 다른 workflow ID는 Windows/macOS에서 충돌합니다",
                );
            }
        }
        let portable_key = (
            definition.id.to_ascii_lowercase(),
            definition.version.to_ascii_lowercase(),
        );
        if let Some(previous) = portable_revisions.insert(portable_key, key) {
            if previous != key {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "nonportable-workflow-version",
                    format!("{}@{}", definition.id, definition.version),
                    "대소문자만 다른 ID/version은 Windows/macOS에서 충돌합니다",
                );
            }
        }
        if let Some(existing) = revisions.insert(key, definition) {
            if existing != definition {
                issue(
                    &mut issues,
                    IssueSeverity::Error,
                    "conflicting-workflow-version",
                    format!("{}@{}", definition.id, definition.version),
                    "같은 workflow id/version에 서로 다른 정의가 있습니다",
                );
            }
            continue;
        }
        issues.extend(
            validate(definition)
                .issues
                .into_iter()
                .filter_map(|mut entry| {
                    if entry.severity != IssueSeverity::Error {
                        return None;
                    }
                    entry.path = format!("{}@{}.{}", definition.id, definition.version, entry.path);
                    Some(entry)
                }),
        );
        for (index, node) in definition.nodes.iter().enumerate() {
            if node.kind != NodeKind::Subworkflow {
                continue;
            }
            if let Some(reference) = &node.workflow_ref {
                if !available.contains(&(reference.id.as_str(), reference.version.as_str())) {
                    issue(
                        &mut issues,
                        IssueSeverity::Error,
                        "missing-subworkflow",
                        format!("{}@{}.nodes[{index}]", definition.id, definition.version),
                        format!(
                            "고정한 하위 workflow를 찾을 수 없습니다: {}@{}",
                            reference.id, reference.version
                        ),
                    );
                }
            }
        }
    }
    if let Err(cycle) = dependency_order(definitions) {
        issues.push(cycle);
    }
    issues
}

/// Children precede their callers. Use an explicit stack so deeply composed definitions
/// cannot overflow the host stack during validation or publication.
pub(crate) fn dependency_order(
    definitions: &[WorkflowDefinition],
) -> Result<Vec<usize>, ValidationIssue> {
    let indices: HashMap<_, _> = definitions
        .iter()
        .enumerate()
        .map(|(index, definition)| ((definition.id.as_str(), definition.version.as_str()), index))
        .collect();
    let mut state = vec![0u8; definitions.len()];
    let mut order = Vec::new();
    for start in 0..definitions.len() {
        if state[start] != 0 {
            continue;
        }
        state[start] = 1;
        let mut stack = vec![(start, 0usize)];
        while let Some((index, next_node)) = stack.last_mut() {
            let definition = &definitions[*index];
            if *next_node == definition.nodes.len() {
                state[*index] = 2;
                order.push(*index);
                stack.pop();
                continue;
            }
            let node_index = *next_node;
            *next_node += 1;
            let node = &definition.nodes[node_index];
            if node.kind != NodeKind::Subworkflow {
                continue;
            }
            let Some(child) = node.workflow_ref.as_ref().and_then(|reference| {
                indices
                    .get(&(reference.id.as_str(), reference.version.as_str()))
                    .copied()
            }) else {
                // Missing references are reported separately by validate_registry.
                continue;
            };
            if state[child] == 1 {
                let cycle_start = stack.iter().position(|(index, _)| *index == child).unwrap();
                let chain = stack[cycle_start..]
                    .iter()
                    .map(|(index, _)| *index)
                    .chain(std::iter::once(child))
                    .map(|index| {
                        format!("{}@{}", definitions[index].id, definitions[index].version)
                    })
                    .collect::<Vec<_>>()
                    .join(" → ");
                return Err(ValidationIssue {
                    severity: IssueSeverity::Error,
                    code: "recursive-subworkflow".into(),
                    path: format!(
                        "{}@{}.nodes[{node_index}].workflowRef",
                        definition.id, definition.version
                    ),
                    message: format!("하위 workflow 순환 참조는 실행할 수 없습니다: {chain}"),
                });
            }
            if state[child] == 0 {
                state[child] = 1;
                stack.push((child, 0));
            }
        }
    }
    Ok(order)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::builtins;

    #[test]
    fn bundled_definitions_validate_as_a_registry() {
        let definitions = builtins::all();
        for definition in &definitions {
            let report = validate(definition);
            assert!(report.valid, "{}: {:?}", definition.id, report.issues);
        }
        assert!(validate_registry(&definitions).is_empty());
    }

    #[test]
    fn workflow_requirements_validate_kind_specific_contracts() {
        let mut definition = builtins::sdd();
        definition.requirements = vec![WorkflowRequirement {
            kind: WorkflowRequirementKind::Extension,
            id: "xlsx-export".into(),
            label: "XLSX Export".into(),
            level: WorkflowRequirementLevel::Required,
            reason: "the final deliverable is an XLSX workbook".into(),
            version: "^1.1".into(),
            ..Default::default()
        }];
        assert!(validate(&definition).valid);

        definition.requirements[0].version = "latest".into();
        assert!(validate(&definition)
            .issues
            .iter()
            .any(|issue| issue.code == "invalid-extension-version"));

        definition.requirements[0] = WorkflowRequirement {
            kind: WorkflowRequirementKind::Program,
            id: "pandoc".into(),
            label: "Pandoc".into(),
            level: WorkflowRequirementLevel::Recommended,
            reason: "reads DOCX source material".into(),
            commands: vec!["pandoc".into()],
            version_args: vec!["--version".into()],
            minimum_major: 3,
            install_url: "https://pandoc.org/installing.html".into(),
            ..Default::default()
        };
        assert!(validate(&definition).valid);
    }

    #[test]
    fn registry_rejects_recursive_subworkflows_and_conflicting_revisions() {
        let mut parent = builtins::sdd_with_tdd();
        parent.id = "parent".into();
        let child_node = parent
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap();
        child_node.workflow_ref = Some(WorkflowRef {
            id: "child".into(),
            version: parent.version.clone(),
        });
        let mut child = parent.clone();
        child.id = "child".into();
        child
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Subworkflow)
            .unwrap()
            .workflow_ref
            .as_mut()
            .unwrap()
            .id = "parent".into();
        let issues = validate_registry(&[parent.clone(), child]);
        assert!(
            issues
                .iter()
                .any(|issue| issue.code == "recursive-subworkflow"),
            "{issues:?}"
        );
        assert!(issues
            .iter()
            .any(|issue| issue.message.contains("parent@") && issue.message.contains("child@")));

        let mut conflict = parent.clone();
        conflict.label = "different payload".into();
        assert!(validate_registry(&[parent, conflict])
            .iter()
            .any(|issue| issue.code == "conflicting-workflow-version"));
    }

    #[test]
    fn registry_validates_child_definitions_and_allows_shared_children() {
        let parent = builtins::sdd_with_tdd();
        let mut sibling = parent.clone();
        sibling.id = "sibling".into();
        let child = builtins::tdd();
        assert!(
            validate_registry(&[parent.clone(), sibling, child.clone(), child.clone()]).is_empty()
        );
        let mut invalid = child;
        invalid.entry = "missing".into();
        assert!(!validate_registry(&[parent, invalid]).is_empty());
    }

    #[test]
    fn workflow_storage_keys_reject_traversal_and_accept_semver_metadata() {
        for id in [".", "..", "../outside", "team/flow"] {
            let mut definition = builtins::tdd();
            definition.id = id.into();
            assert!(!validate(&definition).valid, "{id}");
        }
        for version in [
            "1.0.0-../../outside",
            "1.0.0-",
            "01.0.0",
            "1.0.0-alpha/../../outside",
        ] {
            let mut definition = builtins::tdd();
            definition.version = version.into();
            assert!(!validate(&definition).valid, "{version}");
        }
        for version in ["1.0.0", "1.0.0-rc.1", "1.0.0+team.1", "1.0.0-rc.1+team.1"] {
            let mut definition = builtins::tdd();
            definition.version = version.into();
            assert!(validate(&definition).valid, "{version}");
        }
    }

    #[test]
    fn arbitrary_condition_code_and_unbounded_cycles_are_rejected() {
        let mut definition = builtins::tdd();
        definition.edges[0].condition = Some(ConditionExpression {
            field: "process.exit()".into(),
            operator: ConditionOperator::Truthy,
            value: None,
        });
        definition.edges.push(edge_without_loop("done", "red"));
        let report = validate(&definition);
        assert!(!report.valid);
        assert!(report
            .issues
            .iter()
            .any(|entry| entry.code == "invalid-condition-field"));
        assert!(report
            .issues
            .iter()
            .any(|entry| entry.code == "end-has-edge"));
    }

    fn edge_without_loop(from: &str, to: &str) -> WorkflowEdge {
        WorkflowEdge {
            from: from.into(),
            to: to.into(),
            on: "again".into(),
            ..Default::default()
        }
    }

    #[test]
    fn paths_cannot_escape_or_write_internal_metadata() {
        for path in [
            "../secret",
            ".sawhorse/runtime.sqlite",
            "/tmp/out",
            "work/{other}/x",
        ] {
            let mut definition = builtins::sdd();
            definition.artifacts[0].path = path.into();
            assert!(!validate(&definition).valid, "{path}");
        }
    }
}
