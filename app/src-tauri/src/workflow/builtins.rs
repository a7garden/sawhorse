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
/// 배포 후 회고를 여기서 받는다. 별도 문서였던 `learning.md` 는 아무도 쓰지
/// 않았다 — 배포하면서 한 번에 적는 편이 실제로 적힌다.
const RELEASE: &str = "# 배포 기록\n\n## 변경 내용\n<!-- 배포한 변경을 작성하세요. -->\n\n## 배포 절차와 결과\n<!-- 실제 절차·시각·결과를 작성하세요. -->\n\n## 롤백\n<!-- 롤백 조건과 방법을 작성하세요. -->\n\n## 회고\n<!-- 배포 후 관찰한 사실과 다음 일감에 넘길 학습을 작성하세요. 후속 일감은 별도 개발 항목으로 만들고 dependsOn 으로 잇습니다. -->\n";

fn sdd_artifacts() -> Vec<ArtifactDefinition> {
    vec![
        artifact("intent", "의도", INTENT),
        artifact("spec", "명세", SPEC),
        artifact("plan", "실행 계획", PLAN),
        artifact("verification", "검증 근거", VERIFICATION),
        artifact("release", "배포 기록", RELEASE),
    ]
}

pub fn sdd() -> WorkflowDefinition {
    // 노드 id 는 `plan` 이었다. 산출물 role 에도 `plan`(실행 계획)이 있어서 한
    // 낱말이 서로 다른 둘을 가리켰다. 이 노드가 내는 산출물 이름으로 맞춘다.
    let mut intent = node(
        "intent",
        "의도",
        NodeKind::Artifact,
        &[],
        &["intent"],
        &["research", "planner"],
    );
    intent.artifact_role = Some("intent".into());
    intent.instructions = "문제, 성공 기준, 범위와 미확인 사항을 intent에 기록합니다.".into();

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
    deploy.instructions =
        "검증 근거를 검토하고 실제 배포·되돌리기 결과와 배포 후 회고를 기록합니다.".into();
    deploy.requires_completed_dependencies = true;

    // 종착점이던 `maintain`(학습) 노드를 뺐다. 나가는 간선이 없어 순환을 만들지
    // 못했고, `learning.md` 를 읽는 코드도 볼트의 실제 파일도 없었다. 운영은
    // 끝나는 일이 아니라 기간이라 단계로 두면 항목이 닫히지 않는다. 배포 후 관찰은
    // 배포 기록의 회고 절에 적고, 다음 일감은 `dependsOn` 으로 잇는다.
    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: DEFAULT_WORKFLOW_ID.into(),
        label: "기본 SDD".into(),
        description: "의도에서 설계, 구현, 검증, 배포까지 이어지는 기본 흐름".into(),
        version: DEFAULT_WORKFLOW_VERSION.into(),
        entry: "intent".into(),
        artifacts: sdd_artifacts(),
        nodes: vec![intent, design, build, test, deploy],
        edges: vec![
            edge("intent", "design", "approved"),
            edge("design", "build", "approved"),
            edge("build", "test", "succeeded"),
            edge("test", "deploy", "verified"),
            revision_edge("design", "intent", "sdd-revision"),
            revision_edge("build", "design", "sdd-revision"),
            revision_edge("test", "build", "sdd-revision"),
            revision_edge("deploy", "test", "sdd-revision"),
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

const ISSUE_REQUEST: &str = "# 요청\n\n## 배경\n<!-- 무엇을 해결하거나 결정해야 하는지, 재현 절차와 요청 맥락을 작성하세요. -->\n\n## 원하는 결과\n<!-- 무엇이 되어 있으면 끝인지 작성하세요. -->\n\n## 근거 및 분석\n<!-- 확인한 근거와 추정을 구분해 작성하세요. -->\n";
/// 1.0.0 이 쓰던 골격. 이미 만들어진 항목이 digest 로 이 판을 고정하고 있어서
/// 지우지 못한다. 새 항목은 아래 `ISSUE_DESIGN` 을 쓴다.
const ISSUE_DESIGN_V1: &str = "# 설계\n\n## 방안 비교\n<!-- 대안과 장단점, 영향 범위를 작성하세요. -->\n\n## 선택\n<!-- 채택안과 이유를 작성하세요. -->\n\n## 실행 대상\n<!-- 승인 범위. 비어 있으면 승인해도 실행하지 않습니다. -->\n\n| 대상 | 실행 내용 |\n|---|---|\n\n## 검증 방법\n<!-- 완료 조건과 확인 방법을 작성하세요. -->\n\n## 위험 및 되돌리기\n<!-- 실패·취소 시 영향과 되돌리는 방법을 작성하세요. -->\n";
const ISSUE_RESULT_V1: &str = "# 결과\n\n## 적용 내역\n<!-- 실행 유형에 맞는 산출물·커밋·회의록을 작성하세요. -->\n\n## 증거\n<!-- 검증 결과와 확인 가능한 링크를 작성하세요. -->\n\n## 남은 일\n<!-- 미해결 항목과 후속 조치를 작성하세요. -->\n";

/// 볼트에서 실제로 쓰는 절을 그대로 옮겼다. `변경 대상`·`되돌리기 영향` 은 옛
/// `실행 대상`·`위험 및 되돌리기` 를 밀어낸 이름이고, `검토 의견`·`목업`·`개정
/// 이력` 은 템플릿에 없는데도 손으로 만들어 쓰던 절이다. 머리글이 `###` 인 것도
/// 실사용을 따른 것이다.
const ISSUE_DESIGN: &str = "# 설계\n\n### 방안 비교\n<!-- 대안과 장단점, 영향 범위를 작성하세요. -->\n\n| 안 | 내용 | 장점 | 단점 | 영향 범위 |\n|---|---|---|---|---|\n\n### 선택\n<!-- 채택안과 이유. 사용자 제안과 다르면 무엇이 어떻게 다른지 먼저 밝히세요. -->\n\n### 변경 대상\n<!-- 승인 범위. 비어 있으면 승인해도 수행하지 않습니다. -->\n\n| 파일 | 변경 내용 |\n|---|---|\n\n### 목업\n<!-- 화면이 바뀌면 목업을 첨부하세요. 없으면 이 절을 지우세요. -->\n\n### 검증 방법\n<!-- 완료 조건과 확인 방법을 시나리오별로 작성하세요. -->\n\n| 시나리오 | 기대 |\n|---|---|\n\n### 되돌리기 영향\n<!-- 실패·취소 시 영향과 되돌리는 방법을 작성하세요. -->\n\n### 검토 의견\n<!-- 승인·보류·반려와 그 근거를 작성하세요. -->\n\n### 개정 이력\n<!-- 설계를 고친 날짜와 사유를 작성하세요. -->\n";
const ISSUE_RESULT: &str = "# 결과\n\n### 적용 내역\n<!-- 실행 유형에 맞는 산출물·커밋·회의록을 작성하세요. -->\n\n### 증거 및 되돌리기\n<!-- 검증 결과, 확인 가능한 링크, 되돌리는 방법을 작성하세요. -->\n\n### 남은 것\n<!-- 미해결 항목과 후속 조치를 작성하세요. -->\n";

/// 요청 → 설계 → 수행. 볼트의 개발 항목이 실행 유형과 무관하게 전부 이 흐름을
/// 쓰고 있어서 기본 흐름으로 둔다. 개발 항목과 같은 저장소·같은 상태 어휘를 쓰되,
/// 계획·배포·학습 산출물까지 강요하지 않는다. 계획에 해당하는 내용은 설계 문서의
/// `변경 대상`·`검증 방법`·`되돌리기 영향` 절이 이미 담고 있다. 산출물 role 은
/// SDD 와 공유해서 하네스 프롬프트와 스킬이 그대로 붙는다.
pub fn issue() -> WorkflowDefinition {
    let mut request = node(
        "request",
        "요청",
        NodeKind::Artifact,
        &[],
        &["intent"],
        &["research", "planner"],
    );
    request.artifact_role = Some("intent".into());
    request.instructions = "배경, 원하는 결과, 확인한 근거를 요청 문서에 기록합니다.".into();

    let mut design = node(
        "design",
        "설계",
        NodeKind::Human,
        &["intent"],
        &["spec"],
        &["research", "planner", "reviewer"],
    );
    design.decision = Some("approve-or-revise".into());
    design.instructions =
        "방안과 변경 대상, 검증 방법을 설계에 적고 사람의 수행 승인을 받습니다.".into();

    // `실행` 은 잡·하네스 런을 가리키는 말로 되돌리고, 이 단계는 `수행` 으로 적는다.
    let mut resolve = node(
        "resolve",
        "수행",
        NodeKind::Agent,
        &["spec"],
        &["verification"],
        &["implementer", "verifier", "reviewer"],
    );
    resolve.action_ref = Some("implementation".into());
    resolve.instructions = "승인된 변경 대상만 수행하고 증거와 검증 결과를 남깁니다.".into();
    resolve.requires_completed_dependencies = true;

    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: ISSUE_WORKFLOW_ID.into(),
        label: "이슈".into(),
        description: "요청에서 설계, 사람 승인, 수행과 증거까지 이어지는 경량 흐름".into(),
        version: ISSUE_WORKFLOW_VERSION.into(),
        entry: "request".into(),
        artifacts: vec![
            artifact("intent", "요청", ISSUE_REQUEST),
            artifact("spec", "설계", ISSUE_DESIGN),
            artifact("verification", "결과", ISSUE_RESULT),
        ],
        nodes: vec![request, design, resolve],
        edges: vec![
            edge("request", "design", "approved"),
            edge("design", "resolve", "approved"),
            revision_edge("design", "request", "issue-revision"),
            revision_edge("resolve", "design", "issue-revision"),
        ],
        loops: vec![LoopDefinition {
            id: "issue-revision".into(),
            max_iterations: 20,
            on_limit: LoopLimitAction::Pause,
        }],
    }
}

/// 동결된 1.0.0. 이미 만들어진 개발 항목이 `workflowDigest` 로 이 정의를 고정하고
/// 있어서, 한 글자만 바꿔도 그 항목들이 열리지 않는다. 새 항목은 1.1.0 을 쓰고
/// 이 판은 기존 항목을 여는 용도로만 남긴다. 절대 수정하지 말 것.
fn issue_v1() -> WorkflowDefinition {
    let mut request = node(
        "request",
        "요청",
        NodeKind::Artifact,
        &[],
        &["intent"],
        &["research", "planner"],
    );
    request.artifact_role = Some("intent".into());
    request.instructions = "배경, 원하는 결과, 확인한 근거를 요청 문서에 기록합니다.".into();

    let mut design = node(
        "design",
        "설계",
        NodeKind::Human,
        &["intent"],
        &["spec"],
        &["research", "planner", "reviewer"],
    );
    design.decision = Some("approve-or-revise".into());
    design.instructions =
        "방안과 실행 대상, 검증 방법을 설계에 적고 사람의 실행 승인을 받습니다.".into();

    let mut execute = node(
        "execute",
        "실행",
        NodeKind::Agent,
        &["spec"],
        &["verification"],
        &["implementer", "verifier", "reviewer"],
    );
    execute.action_ref = Some("implementation".into());
    execute.instructions = "승인된 실행 대상만 수행하고 증거와 검증 결과를 남깁니다.".into();
    execute.requires_completed_dependencies = true;

    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: ISSUE_WORKFLOW_ID.into(),
        label: "이슈".into(),
        description: "요청에서 설계, 사람 승인, 실행과 증거까지 이어지는 경량 흐름".into(),
        // 동결된 판이므로 상수를 따라가면 안 된다. 리터럴로 고정한다.
        version: "1.0.0".into(),
        entry: "request".into(),
        artifacts: vec![
            artifact("intent", "요청", ISSUE_REQUEST),
            artifact("spec", "설계", ISSUE_DESIGN_V1),
            artifact("verification", "결과", ISSUE_RESULT_V1),
        ],
        nodes: vec![request, design, execute],
        edges: vec![
            edge("request", "design", "approved"),
            edge("design", "execute", "approved"),
            revision_edge("design", "request", "issue-revision"),
            revision_edge("execute", "design", "issue-revision"),
        ],
        loops: vec![LoopDefinition {
            id: "issue-revision".into(),
            max_iterations: 20,
            on_limit: LoopLimitAction::Pause,
        }],
    }
}

pub fn all() -> Vec<WorkflowDefinition> {
    vec![sdd(), tdd(), sdd_with_tdd(), issue(), issue_v1()]
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
