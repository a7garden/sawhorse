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
/// Post-release retrospectives are captured here. A separate `learning.md`
/// document was used by no one — writing it in one pass during release is what actually sticks.
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
    // The node id used to be `plan`. The artifact role is also `plan` (execution plan),
    // so one word pointed at two different things. Aligned with the artifact this node produces.
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

    // Dropped the `maintain` (learning) node that used to be the terminus. It had no
    // outgoing edge so it could not form a cycle, and neither the code reading
    // `learning.md` nor the file itself existed in the vault. Operations is a period,
    // not a finish line, so as a phase it never closes the item. Post-release
    // observations go in the retrospective section of the release record; follow-up
    // items are linked via `dependsOn`.
    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: DEFAULT_WORKFLOW_ID.into(),
        label: "기본 SDD".into(),
        description: "의도에서 설계, 구현, 검증, 배포까지 이어지는 기본 흐름".into(),
        version: DEFAULT_WORKFLOW_VERSION.into(),
        entry: "intent".into(),
        requirements: vec![],
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
        requirements: vec![],
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
/// Skeleton used by 1.0.0. Cannot be removed because already-created items pin this
/// version via digest. New items use `ISSUE_DESIGN` below.
const ISSUE_DESIGN_V1: &str = "# 설계\n\n## 방안 비교\n<!-- 대안과 장단점, 영향 범위를 작성하세요. -->\n\n## 선택\n<!-- 채택안과 이유를 작성하세요. -->\n\n## 실행 대상\n<!-- 승인 범위. 비어 있으면 승인해도 실행하지 않습니다. -->\n\n| 대상 | 실행 내용 |\n|---|---|\n\n## 검증 방법\n<!-- 완료 조건과 확인 방법을 작성하세요. -->\n\n## 위험 및 되돌리기\n<!-- 실패·취소 시 영향과 되돌리는 방법을 작성하세요. -->\n";
const ISSUE_RESULT_V1: &str = "# 결과\n\n## 적용 내역\n<!-- 실행 유형에 맞는 산출물·커밋·회의록을 작성하세요. -->\n\n## 증거\n<!-- 검증 결과와 확인 가능한 링크를 작성하세요. -->\n\n## 남은 일\n<!-- 미해결 항목과 후속 조치를 작성하세요. -->\n";

/// Sections copied verbatim from what the vault actually uses. `변경 대상` (change targets)
/// and `되돌리기 영향` (rollback impact) displaced the old `실행 대상` (execution targets)
/// and `위험 및 되돌리기` (risks and rollback); `검토 의견` (review comments), `목업` (mockup),
/// and `개정 이력` (revision history) are sections written by hand despite not being in the
/// template. The `###` heading level also follows real-world usage.
const ISSUE_DESIGN: &str = "# 설계\n\n### 방안 비교\n<!-- 대안과 장단점, 영향 범위를 작성하세요. -->\n\n| 안 | 내용 | 장점 | 단점 | 영향 범위 |\n|---|---|---|---|---|\n\n### 선택\n<!-- 채택안과 이유. 사용자 제안과 다르면 무엇이 어떻게 다른지 먼저 밝히세요. -->\n\n### 변경 대상\n<!-- 승인 범위. 비어 있으면 승인해도 수행하지 않습니다. -->\n\n| 파일 | 변경 내용 |\n|---|---|\n\n### 목업\n<!-- 화면이 바뀌면 목업을 첨부하세요. 없으면 이 절을 지우세요. -->\n\n### 검증 방법\n<!-- 완료 조건과 확인 방법을 시나리오별로 작성하세요. -->\n\n| 시나리오 | 기대 |\n|---|---|\n\n### 되돌리기 영향\n<!-- 실패·취소 시 영향과 되돌리는 방법을 작성하세요. -->\n\n### 검토 의견\n<!-- 승인·보류·반려와 그 근거를 작성하세요. -->\n\n### 개정 이력\n<!-- 설계를 고친 날짜와 사유를 작성하세요. -->\n";
const ISSUE_RESULT: &str = "# 결과\n\n### 적용 내역\n<!-- 실행 유형에 맞는 산출물·커밋·회의록을 작성하세요. -->\n\n### 증거 및 되돌리기\n<!-- 검증 결과, 확인 가능한 링크, 되돌리는 방법을 작성하세요. -->\n\n### 남은 것\n<!-- 미해결 항목과 후속 조치를 작성하세요. -->\n";

/// Request → design → perform. Every dev item in the vault uses this flow regardless of
/// execution type, so it is the default flow. Same repository and state vocabulary as dev
/// items, but without forcing planning/deployment/learning artifacts. The planning content
/// is already covered by the `변경 대상` (change targets), `검증 방법` (verification method),
/// and `되돌리기 영향` (rollback impact) sections of the design doc. Artifact roles are
/// shared with SDD so harness prompts and skills attach as-is.
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

    // `실행` (execute) is reserved for job/harness runs; this step is written as `수행` (perform).
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
        requirements: vec![],
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

/// Frozen 1.0.0. Already-created dev items pin this definition via `workflowDigest`, so
/// changing even one character would prevent those items from opening. New items use
/// 1.1.0; this version remains only to open existing items. Never modify.
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
        // Frozen version: must not follow the constant. Pinned as a literal.
        version: "1.0.0".into(),
        entry: "request".into(),
        requirements: vec![],
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

/// A scratch note becomes a reviewable design before implementation is authorized.
pub fn intent_flow() -> WorkflowDefinition {
    let mut design = node(
        "design",
        "설계",
        NodeKind::Agent,
        &["intent"],
        &["spec", "plan"],
        &["planner", "research"],
    );
    design.action_ref = Some("intent-design".into());
    design.instructions = "Read intent.md verbatim and open every attached image relative to that file. Preserve the original intent. Inspect the repository, then write spec.md with the interpreted intent, requirements, acceptance criteria, assumptions and open questions. Write plan.md as bounded work units with stable IDs, checkboxes, scope/files, dependencies and verification for each unit. Prepare the complete design for human review. Do not implement or edit repository code before approval.".into();
    let mut build = node(
        "build",
        "구현·검증",
        NodeKind::Agent,
        &["intent", "spec", "plan"],
        &["verification"],
        &["implementer", "verifier"],
    );
    build.action_ref = Some("intent-implementation".into());
    build.requires_completed_dependencies = true;
    build.instructions = "The human has approved the design and work units. Implement every approved unit, run relevant checks, fix failures and continue until implementation and verification are finished. Record each work unit ID, changes, actual commands, results and remaining blockers in verification.md. Do not silently expand the approved scope. Never claim completion from an idle signal or invent test results.".into();
    WorkflowDefinition {
        definition_version: DEFINITION_VERSION,
        id: "intent-flow".into(),
        version: "1.0.0".into(),
        label: "메모에서 구현까지".into(),
        description: "자유로운 의도와 이미지 → 작업 분해·설계 → 사람의 승인 → 구현·검증".into(),
        entry: "design".into(),
        requirements: vec![],
        artifacts: vec![
            artifact("intent", "원본 의도", ""),
            artifact("spec", "설계", SPEC),
            artifact("plan", "작업 단위", PLAN),
            artifact("verification", "구현 결과", VERIFICATION),
        ],
        nodes: vec![design, build],
        edges: vec![
            edge("design", "build", "approved"),
            revision_edge("build", "design", "intent-revision"),
        ],
        loops: vec![LoopDefinition {
            id: "intent-revision".into(),
            max_iterations: 20,
            on_limit: LoopLimitAction::Pause,
        }],
    }
}

/// New captures use a separate immutable contract; existing v1 work keeps its digest.
pub fn intent_flow_v2() -> WorkflowDefinition {
    let mut definition = intent_flow();
    definition.version = "2.0.0".into();
    definition.label = "SDD · 의도에서 완료까지".into();
    definition.description =
        "의도 인박스 → 인터뷰·구체화 → 설계 → 승인 대기 → 구현 대기 → 병렬 구현·커밋 → 결과 확인"
            .into();
    definition.entry = "inbox".into();
    definition.artifacts.push(artifact("brief", "구체화 방향", "# 구체화 방향\n\n## 문제와 목표\n\n## 범위와 제외 범위\n\n## 수용 기준\n\n## 결정과 열린 질문\n"));
    definition.artifacts.push(artifact(
        "rollback",
        "폐기 기록",
        "# 폐기 기록\n\n## 대상 커밋\n\n## 영향과 의존성\n\n## 되돌리기 검증\n",
    ));
    definition.nodes = vec![
        node("inbox", "의도", NodeKind::Human, &[], &[], &[]),
        node(
            "clarify",
            "구체화",
            NodeKind::Agent,
            &["intent"],
            &["brief"],
            &["planner", "research"],
        ),
        node(
            "design",
            "설계",
            NodeKind::Agent,
            &["intent", "brief"],
            &["spec", "plan"],
            &["planner", "research"],
        ),
        node(
            "approval",
            "승인 대기",
            NodeKind::Human,
            &["brief", "spec", "plan"],
            &[],
            &[],
        ),
        node(
            "queued",
            "구현 대기",
            NodeKind::Human,
            &["spec", "plan"],
            &[],
            &[],
        ),
        node(
            "build",
            "구현",
            NodeKind::Agent,
            &["intent", "brief", "spec", "plan"],
            &["verification"],
            &["implementer", "verifier"],
        ),
        node(
            "unconfirmed",
            "완료·미확인",
            NodeKind::Human,
            &["verification"],
            &[],
            &[],
        ),
        node("done", "완료", NodeKind::End, &[], &[], &[]),
        node(
            "discarding",
            "폐기 중",
            NodeKind::Agent,
            &["verification"],
            &["rollback"],
            &["implementer", "verifier"],
        ),
        node("discarded", "폐기", NodeKind::End, &[], &[], &[]),
        node("cancelled", "취소", NodeKind::End, &[], &[], &[]),
    ];
    for node in &mut definition.nodes {
        if node.kind == NodeKind::Human {
            node.decision = Some("approval".into());
        }
        if node.kind == NodeKind::Agent {
            node.action_ref = Some(format!("sdd-{}", node.id));
        }
        node.instructions = match node.id.as_str() {
            "clarify" => "Preserve the original intent. Write brief.md with the problem, desired outcome, scope, exclusions and acceptance criteria. Ask user decisions through the harness interview protocol. Do not design or implement yet.",
            "design" => "Read the accepted brief and project DESIGN.md. Write spec.md and plan.md. Inspect ALL work records for dependencies; submit dependsOn (IDs) and scope (repository-relative file paths) with the completion request. Ask technical/product decisions through interviews. Do not edit source code.",
            "build" => "Implement the approved spec and plan in the assigned worktree. Coordinate with peers through A2A. Run relevant checks, commit every task change without another approval, include Sawhorse-Work: <workId> in each commit message, and submit full commit hashes in chronological order. Record actual results in verification.md. Do not push or deploy.",
            "discarding" => "Review the exact recorded implementation commits and dependency impact. Revert those commits newest first in the assigned worktree, preserving unrelated changes. Resolve conflicts, validate the result, commit with Sawhorse-Work: <workId>, record rollback.md and submit the new revert hashes. Never reset shared history.",
            _ => "Human decision; the host owns this transition.",
        }.into();
    }
    definition.edges = vec![
        edge("inbox", "clarify", "clarify"),
        edge("clarify", "design", "design"),
        edge("design", "approval", "completed"),
        edge("approval", "queued", "approved"),
        edge("queued", "build", "start"),
        edge("build", "unconfirmed", "completed"),
        edge("unconfirmed", "done", "confirmed"),
        edge("unconfirmed", "discarding", "discard"),
        edge("discarding", "discarded", "completed"),
        edge("inbox", "cancelled", "cancel"),
        edge("clarify", "cancelled", "cancel"),
        edge("design", "cancelled", "cancel"),
        edge("approval", "cancelled", "cancel"),
        edge("queued", "cancelled", "cancel"),
    ];
    definition.loops.clear();
    definition
}

/// Purpose-specific prototypes are kept immutable for resuming existing work.
/// They cannot be enabled as project processes or selected for new work.
pub fn is_selectable(id: &str) -> bool {
    !matches!(id, "bugfix-main" | "refactor-main")
}

pub fn require_selectable(id: &str) -> Result<(), String> {
    if is_selectable(id) { Ok(()) } else {
        Err("버그 수정과 리팩토링은 작업 유형입니다. 진행 방식으로 SDD·TDD 등의 워크플로우를 선택하세요".into())
    }
}

pub fn all() -> Vec<WorkflowDefinition> {
    let mut definitions = vec![
        goal(),
        sdd(),
        tdd(),
        sdd_with_tdd(),
        issue(),
        issue_v1(),
        intent_flow(),
        intent_flow_v2(),
    ];
    // Published definitions and their digests remain immutable. Naming-only
    // revisions are additive, including exact references to older TDD children.
    for (mut definition, label, version) in [
        (sdd(), "SDD · 명세 기반 개발", "1.1.1"),
        (intent_flow_v2(), "Intent · 의도 기반 개발", "2.0.1"),
        (tdd(), "TDD · 테스트 기반 개발", "1.0.1"),
        (sdd_with_tdd(), "SDD + TDD · 명세·테스트 기반 개발", "1.1.1"),
        (issue(), "Issue · 요청 해결", "1.1.1"),
        (goal(), "Goal · 목표 달성", "1.0.1"),
    ] {
        definition.label = label.into();
        definition.version = version.into();
        definitions.push(definition);
    }
    // Compatibility catalog only: hidden from new-project and gallery choices.
    definitions.extend([bugfix(), refactor()]);
    definitions
}

/// Maintenance flows share the host's standard artifact and action contracts.
/// Their intake, implementation constraints and verification evidence differ.
fn maintenance(
    id: &str,
    label: &str,
    description: &str,
    intake_label: &str,
    intake_template: &str,
    design_instructions: &str,
    build_instructions: &str,
    verify_instructions: &str,
) -> WorkflowDefinition {
    let mut definition = sdd();
    definition.id = id.into();
    definition.label = label.into();
    definition.description = description.into();
    definition.version = "1.0.0".into();
    definition.artifacts.retain(|item| item.role != "release");
    definition.artifacts[0] = artifact("intent", intake_label, intake_template);
    definition.nodes.retain(|item| item.id != "deploy");
    definition.nodes[0].label = intake_label.into();
    definition.nodes[0].instructions = "대상 문제, 범위와 완료 기준을 기록합니다.".into();
    definition.nodes[1].instructions = design_instructions.into();
    definition.nodes[2].instructions = build_instructions.into();
    definition.nodes[3].instructions = verify_instructions.into();
    let mut approval = node("approval", "변경 승인", NodeKind::Human, &["intent", "spec"], &[], &["reviewer"]);
    approval.decision = Some("approve-or-revise".into());
    approval.instructions = "분석 근거, 변경 범위와 검증 계획을 검토하고 승인하거나 설계를 보완합니다.".into();
    definition.nodes.insert(2, approval);
    definition.nodes.push(node("done", "완료", NodeKind::End, &["verification"], &[], &[]));
    definition.edges = vec![
        edge("intent", "design", "approved"),
        edge("design", "approval", "succeeded"),
        edge("approval", "build", "approved"),
        edge("build", "test", "succeeded"),
        edge("test", "done", "verified"),
        revision_edge("approval", "design", "maintenance-revision"),
        revision_edge("test", "build", "maintenance-revision"),
        revision_edge("build", "design", "maintenance-revision"),
    ];
    definition.loops = vec![LoopDefinition { id: "maintenance-revision".into(), max_iterations: 20, on_limit: LoopLimitAction::Pause }];
    definition
}

pub fn bugfix() -> WorkflowDefinition {
    let mut definition = maintenance(
        "bugfix-main", "Bugfix · 버그 수정",
        "버그 재현과 원인 분석, 변경 승인, 최소 수정과 회귀 검증을 잇는 흐름",
        "버그 보고",
        "# 버그 보고\n\n## 재현 절차와 환경\n\n## 기대 동작과 실제 동작\n\n## 영향 범위\n\n## 완료 기준\n",
        "버그를 재현하고 실제 결과를 기록합니다. 근본 원인과 추정을 구분하고 최소 수정 범위, 회귀 테스트 및 검증 명령을 명세에 작성합니다. 재현할 수 없으면 부족한 조건을 밝힙니다.",
        "승인된 원인을 해결하는 최소 변경을 구현합니다. 가능하면 먼저 버그를 재현하는 실패 테스트를 추가하고, 수정 전 실패와 수정 후 성공을 실행 계획에 기록합니다. 관련 없는 구조 변경은 별도 작업으로 남깁니다.",
        "원래 재현 절차와 관련 회귀 테스트를 실제로 실행합니다. 수정 전후 결과, 명령, 코드 revision과 잔여 영향을 검증 근거에 기록합니다. 오류가 남으면 수정을 보완합니다.",
    );
    definition.nodes[1].label = "원인 분석".into();
    definition.nodes[3].label = "버그 수정".into();
    definition.nodes[4].label = "회귀 검증".into();
    definition
}

pub fn refactor() -> WorkflowDefinition {
    let mut definition = maintenance(
        "refactor-main", "Refactor · 구조 개선",
        "현재 동작을 기준으로 개선 범위를 설계하고 승인 후 구조를 정리해 동작 보존을 검증하는 흐름",
        "개선 목표",
        "# 개선 목표\n\n## 구조 문제와 개선 이유\n\n## 보존할 동작과 인터페이스\n\n## 변경 범위와 제외 범위\n\n## 완료 기준\n",
        "현재 동작과 공개 인터페이스를 조사하고 기준 테스트 결과를 확보합니다. 테스트가 부족하면 특성화 테스트 계획을 세웁니다. 구조 개선안, 호환성 제약과 되돌릴 수 있는 작업 순서를 명세에 기록합니다.",
        "승인된 범위에서 작은 단계로 구조를 개선하고 단계마다 기준 테스트를 실행합니다. 기능 추가나 동작 변경은 별도 작업으로 분리합니다. 실행 계획에 변경 이유와 보존한 인터페이스를 기록합니다.",
        "기준 테스트와 관련 회귀 검증을 실행해 변경 전후 동작 및 공개 인터페이스가 유지되는지 확인합니다. 명령, 결과, 코드 revision과 개선 목표 충족 여부를 검증 근거에 기록합니다.",
    );
    definition.nodes[1].label = "개선 설계".into();
    definition.nodes[3].label = "구조 개선".into();
    definition.nodes[4].label = "동작 검증".into();
    definition
}

pub fn goal() -> WorkflowDefinition {
    let mut run = node("pursue", "목표 달성", NodeKind::Agent, &[], &["evidence"], &["planner", "implementer", "verifier"]);
    run.action_ref = Some("goal-pursuit".into());
    run.instructions = "목표가 달성될 때까지 작업 생성, 설계, 구현, 검증을 자율적으로 반복합니다.".into();
    WorkflowDefinition {
        id: "goal-main".into(), label: "골 모드".into(), version: "1.0.0".into(),
        description: "사람의 단계 승인 없이 목표 달성까지 반복. 사용량 한도 소진 시 1시간마다 자동 재시도.".into(),
        entry: "pursue".into(),
        artifacts: vec![artifact("evidence", "진행 및 검증 근거", "# 진행 및 검증 근거\n")],
        nodes: vec![run, node("done", "목표 달성", NodeKind::End, &[], &[], &[])],
        edges: vec![edge("pursue", "done", "verified")],
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_catalog_matches_canonical_bundles() {
        let preview: Vec<WorkflowDefinition> = serde_json::from_str(include_str!(
            "../../../src/features/workbench/samples/workflows.json"
        )).unwrap();
        assert_eq!(preview, all());
    }

    #[test]
    fn naming_revisions_preserve_published_behavior() {
        let definitions = all();
        for old in [sdd(), intent_flow_v2(), tdd(), sdd_with_tdd(), issue(), goal()] {
            assert!(definitions.contains(&old));
            let mut latest = definitions.iter().rev().find(|item| item.id == old.id).unwrap().clone();
            assert!(latest.label.contains(" · "));
            assert_ne!(latest.version, old.version);
            latest.label = old.label.clone();
            latest.version = old.version.clone();
            assert_eq!(latest, old);
        }
    }

    #[test]
    fn maintenance_flows_complete_after_approval_and_rework() {
        for definition in [bugfix(), refactor()] {
            let result = super::super::runtime::simulate(SimulationInput {
                definition,
                events: ["approved", "succeeded", "revise", "succeeded", "approved", "succeeded", "revise", "succeeded", "verified"]
                    .into_iter().map(|event| SimulationEvent { event: event.into(), ..Default::default() }).collect(),
                ..Default::default()
            });
            assert_eq!(result.status, SimulationStatus::Completed, "{result:?}");
            assert_eq!(result.trace.iter().filter(|step| step.event.as_deref() == Some("revise")).count(), 2);
        }
    }

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
