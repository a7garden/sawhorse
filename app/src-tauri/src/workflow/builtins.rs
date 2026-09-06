use super::model::*;

fn artifact(role: &str, label: &str, template: &str) -> ArtifactDefinition {
    ArtifactDefinition {
        role: role.into(),
        label: label.into(),
        path: format!("work/{{workId}}/{role}.md"),
        template: template.into(),
    }
}

fn node(
    id: &str,
    label: &str,
    kind: NodeKind,
    inputs: &[&str],
    outputs: &[&str],
    roles: &[&str],
) -> WorkflowNode {
    WorkflowNode {
        id: id.into(),
        label: label.into(),
        kind,
        inputs: inputs.iter().map(|value| (*value).into()).collect(),
        outputs: outputs.iter().map(|value| (*value).into()).collect(),
        allowed_roles: roles.iter().map(|value| (*value).into()).collect(),
        ..Default::default()
    }
}

fn edge(from: &str, to: &str, on: &str) -> WorkflowEdge {
    WorkflowEdge {
        from: from.into(),
        to: to.into(),
        on: on.into(),
        ..Default::default()
    }
}

fn revision_edge(from: &str, to: &str, loop_ref: &str) -> WorkflowEdge {
    WorkflowEdge {
        loop_ref: Some(loop_ref.into()),
        ..edge(from, to, "revise")
    }
}

const INTENT: &str = "# 의도\n\n## 사용자 문제\n<!-- 누구의 어떤 문제인지 작성하세요. -->\n\n## 성공 기준\n<!-- 관찰 가능한 완료 기준을 작성하세요. -->\n\n## 범위\n<!-- 포함·제외 범위를 작성하세요. -->\n";
const SPEC: &str = "# 명세\n\n## 요구사항\n<!-- 검증 가능한 요구사항을 작성하세요. -->\n\n## 인터페이스와 데이터\n<!-- 입력·출력·호환성 제약을 작성하세요. -->\n\n## 수용 기준\n<!-- 완료를 판정할 사례를 작성하세요. -->\n";
const PLAN: &str = "# 실행 계획\n\n## 작업 순서\n<!-- 구현 단계를 작성하세요. -->\n\n## 위험과 의존성\n<!-- 위험·완화책·선행 작업을 작성하세요. -->\n\n## 검증 계획\n<!-- 실행할 검증 명령과 기대 결과를 작성하세요. -->\n";
const VERIFICATION: &str = "# 검증 근거\n\n## 실행 결과\n<!-- 실제 실행한 검증과 결과를 작성하세요. -->\n\n## 검토 결정\n<!-- 통과·보류·반려와 근거를 작성하세요. -->\n\n## 잔여 위험\n<!-- 알려진 제한과 후속 조치를 작성하세요. -->\n";
const RELEASE: &str = "# 배포 기록\n\n## 변경 내용\n<!-- 배포한 변경을 작성하세요. -->\n\n## 배포 절차와 결과\n<!-- 실제 절차·시각·결과를 작성하세요. -->\n\n## 롤백\n<!-- 롤백 조건과 방법을 작성하세요. -->\n";
const LEARNING: &str = "# 운영·학습\n\n## 관찰\n<!-- 운영에서 관찰한 사실을 작성하세요. -->\n\n## 학습\n<!-- 다음 작업에 반영할 학습을 작성하세요. -->\n\n## 후속 조치\n<!-- 소유자와 기한이 있는 후속 조치를 작성하세요. -->\n";

fn sdd_artifacts() -> Vec<ArtifactDefinition> {
    vec![
        artifact("intent", "의도", INTENT),
        artifact("spec", "명세", SPEC),
        artifact("plan", "실행 계획", PLAN),
        artifact("verification", "검증 근거", VERIFICATION),
        artifact("release", "배포 기록", RELEASE),
        artifact("learning", "운영·학습", LEARNING),
    ]
}

pub fn sdd() -> WorkflowDefinition {
    let mut plan = node(
        "plan",
        "의도",
        NodeKind::Artifact,
        &[],
        &["intent"],
        &["research", "planner"],
    );
    plan.artifact_role = Some("intent".into());
    plan.instructions = "문제, 성공 기준, 범위와 미확인 사항을 intent에 기록합니다.".into();

    let mut design = node(
        "design",
        "설계",
        NodeKind::Agent,
        &["intent"],
        &["spec"],
        &["research", "planner", "reviewer"],
    );
    design.action_ref = Some("spec-writer".into());
    design.instructions = "승인된 의도를 검증 가능한 명세와 수용 기준으로 구체화합니다.".into();

    let mut build = node(
        "build",
        "구현",
        NodeKind::Agent,
        &["spec"],
        &["plan"],
        &["planner", "implementer", "reviewer"],
    );
    build.action_ref = Some("implementation".into());
    build.instructions = "승인된 명세 안에서 계획을 세우고 구현합니다.".into();
    build.requires_completed_dependencies = true;

    let mut test = node(
        "test",
        "검증",
        NodeKind::Check,
        &["plan"],
        &["verification"],
        &["implementer", "verifier", "reviewer"],
    );
    test.action_ref = Some("project-verification".into());
    test.instructions = "실제 검증 명령과 결과, 증거 경로와 잔여 위험을 기록합니다.".into();
    test.requires_completed_dependencies = true;

    let mut deploy = node(
        "deploy",
        "배포",
        NodeKind::Human,
        &["verification"],
        &["release"],
        &["verifier", "reviewer"],
    );
    deploy.decision = Some("approve-or-revise".into());
    deploy.instructions = "검증 근거를 검토하고 실제 배포 및 되돌리기 결과를 기록합니다.".into();
    deploy.requires_completed_dependencies = true;

    let mut maintain = node(
        "maintain",
        "학습",
        NodeKind::Artifact,
        &["release"],
        &["learning"],
        &["research", "reviewer"],
    );
    maintain.artifact_role = Some("learning".into());
    maintain.instructions = "운영 관찰, 학습과 다음 의도를 기록합니다.".into();
    maintain.requires_completed_dependencies = true;

    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: DEFAULT_WORKFLOW_ID.into(),
        label: "기본 SDD".into(),
        description: "의도에서 설계, 구현, 검증, 배포와 운영 학습까지 이어지는 기본 흐름".into(),
        version: DEFAULT_WORKFLOW_VERSION.into(),
        entry: "plan".into(),
        artifacts: sdd_artifacts(),
        nodes: vec![plan, design, build, test, deploy, maintain],
        edges: vec![
            edge("plan", "design", "approved"),
            edge("design", "build", "approved"),
            edge("build", "test", "succeeded"),
            edge("test", "deploy", "verified"),
            edge("deploy", "maintain", "released"),
            revision_edge("design", "plan", "sdd-revision"),
            revision_edge("build", "design", "sdd-revision"),
            revision_edge("test", "build", "sdd-revision"),
            revision_edge("deploy", "test", "sdd-revision"),
            revision_edge("maintain", "deploy", "sdd-revision"),
        ],
        loops: vec![LoopDefinition {
            id: "sdd-revision".into(),
            max_iterations: 20,
            on_limit: LoopLimitAction::Pause,
        }],
    }
}

pub fn tdd() -> WorkflowDefinition {
    let artifacts = vec![
        artifact(
            "test-intent",
            "테스트 의도",
            "# 테스트 의도\n\n## 행동과 수용 기준\n<!-- 이번 반복에서 검증할 하나의 행동을 작성하세요. -->\n\n## 범위\n<!-- 관련 회귀 범위와 제외 범위를 작성하세요. -->\n",
        ),
        artifact(
            "red-evidence",
            "Red 근거",
            "# Red 근거\n\n## 테스트 변경\n<!-- 추가하거나 바꾼 assertion을 작성하세요. -->\n\n## 의도한 실패\n<!-- 아래 키를 실제 결과로 채우세요. failureKind는 assertion이어야 합니다. -->\n<!-- result: failed -->\n<!-- failureKind: assertion -->\n<!-- command: 실행한 명령 -->\n<!-- exitCode: 1 -->\n<!-- testRevision: 7자 이상 commit/content hash -->\n",
        ),
        artifact(
            "implementation",
            "최소 구현",
            "# 최소 구현\n\n## 변경\n<!-- 테스트를 통과시키기 위한 최소 변경과 이유를 작성하세요. -->\n",
        ),
        artifact(
            "green-evidence",
            "Green 근거",
            "# Green 근거\n\n## 성공 결과\n<!-- 아래 키를 실제 결과로 채우세요. -->\n<!-- result: passed -->\n<!-- command: 실행한 명령 -->\n<!-- exitCode: 0 -->\n<!-- codeRevision: 7자 이상 commit/content hash -->\n",
        ),
        artifact(
            "refactor",
            "리팩터링",
            "# 리팩터링\n\n## 구조 개선\n<!-- 행동 변경 없이 개선한 구조와 선택 근거를 작성하세요. -->\n",
        ),
        artifact(
            "regression",
            "회귀 검증",
            "# 회귀 검증\n\n## 최종 결과\n<!-- 아래 키를 실제 결과로 채우세요. -->\n<!-- result: passed -->\n<!-- command: 실행한 대상+회귀 명령 -->\n<!-- exitCode: 0 -->\n<!-- codeRevision: 7자 이상 commit/content hash -->\n",
        ),
    ];

    let mut intent = node(
        "test-intent",
        "테스트 의도",
        NodeKind::Artifact,
        &[],
        &["test-intent"],
        &["planner", "implementer", "verifier"],
    );
    intent.artifact_role = Some("test-intent".into());
    let mut red = node(
        "red",
        "Red",
        NodeKind::Check,
        &["test-intent"],
        &["red-evidence"],
        &["implementer", "verifier"],
    );
    red.action_ref = Some("tdd-red".into());
    red.instructions = "테스트를 먼저 작성하고 대상 assertion이 의도한 이유로 실패하는지 확인합니다. 명령/환경 오류는 Red가 아닙니다.".into();
    let mut green = node(
        "green",
        "Green",
        NodeKind::Agent,
        &["red-evidence"],
        &["implementation", "green-evidence"],
        &["implementer", "verifier"],
    );
    green.action_ref = Some("tdd-green".into());
    green.instructions =
        "승인된 실패를 통과시키는 최소 구현을 만들고 대상 및 관련 회귀 테스트 성공을 기록합니다."
            .into();
    let mut refactor = node(
        "refactor",
        "리팩터링",
        NodeKind::Agent,
        &["green-evidence"],
        &["refactor"],
        &["implementer", "reviewer"],
    );
    refactor.action_ref = Some("tdd-refactor".into());
    let mut verify = node(
        "verify",
        "재검증",
        NodeKind::Check,
        &["refactor"],
        &["regression"],
        &["verifier", "reviewer"],
    );
    verify.action_ref = Some("tdd-regression".into());
    verify.instructions =
        "리팩터링 뒤 대상 테스트와 관련 회귀 검증을 다시 실행하고 revision과 함께 기록합니다."
            .into();
    let done = node("done", "완료", NodeKind::End, &["regression"], &[], &[]);

    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: "tdd-cycle".into(),
        label: "TDD 사이클".into(),
        description: "의도한 Red, 최소 Green, 리팩터링과 회귀 재검증을 증거로 남기는 반복".into(),
        version: "1.0.0".into(),
        entry: "test-intent".into(),
        artifacts,
        nodes: vec![intent, red, green, refactor, verify, done],
        edges: vec![
            edge("test-intent", "red", "approved"),
            edge("red", "green", "red-confirmed"),
            edge("green", "refactor", "green-confirmed"),
            edge("refactor", "verify", "succeeded"),
            edge("verify", "done", "verified"),
            WorkflowEdge {
                loop_ref: Some("tdd-iteration".into()),
                ..edge("green", "red", "failed")
            },
            WorkflowEdge {
                loop_ref: Some("tdd-iteration".into()),
                ..edge("verify", "red", "next-test")
            },
        ],
        loops: vec![LoopDefinition {
            id: "tdd-iteration".into(),
            max_iterations: 50,
            on_limit: LoopLimitAction::Pause,
        }],
    }
}

pub fn sdd_with_tdd() -> WorkflowDefinition {
    let mut definition = sdd();
    let nested = tdd();
    definition.id = "sdd-with-tdd".into();
    definition.label = "SDD + TDD".into();
    definition.description = "기본 SDD의 구현 노드를 TDD 하위 흐름으로 실행하는 조합".into();
    definition.artifacts.extend(nested.artifacts.clone());
    if let Some(build) = definition.nodes.iter_mut().find(|node| node.id == "build") {
        build.kind = NodeKind::Subworkflow;
        build.action_ref = None;
        build.workflow_ref = Some(WorkflowRef {
            id: nested.id,
            version: nested.version,
        });
        build.outputs.extend(
            nested
                .artifacts
                .iter()
                .map(|artifact| artifact.role.clone()),
        );
        build.instructions =
            "승인된 명세에서 test-intent를 만들고 TDD 하위 흐름의 Red, Green, 리팩터링, 회귀 검증 근거를 모두 기록합니다. SDD 실행 계획도 함께 갱신합니다.".into();
    }
    definition
}

pub fn all() -> Vec<WorkflowDefinition> {
    vec![sdd(), tdd(), sdd_with_tdd()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composed_sdd_exposes_the_nested_tdd_contract() {
        let definition = sdd_with_tdd();
        let build = definition
            .nodes
            .iter()
            .find(|node| node.id == "build")
            .unwrap();
        assert_eq!(
            build
                .workflow_ref
                .as_ref()
                .map(|reference| reference.id.as_str()),
            Some("tdd-cycle")
        );
        for role in [
            "test-intent",
            "red-evidence",
            "implementation",
            "green-evidence",
            "refactor",
            "regression",
        ] {
            assert!(definition
                .artifacts
                .iter()
                .any(|artifact| artifact.role == role));
            assert!(build.outputs.iter().any(|output| output == role));
        }
    }
}
