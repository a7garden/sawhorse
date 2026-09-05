// 협업 장부의 타입 계약. 설계 180-229줄 후보 계약과 544-552줄 테이블 목록의 러스트 표현.
//
// 규칙:
// - wire(DB·프론트)는 camelCase, 신규 필드는 전부 `#[serde(default)]` — 기존 행·응답이 깨지지 않게.
// - 상태 문자열은 설계 텍스트 그대로 저장·전송한다(예: `readyToFinalize`, `authorized_by_policy`).
// - digest는 구조체 필드 순서가 고정된 canonical JSON 위의 sha256이다. Map 순회에 의존하지 않는다.

use serde::{Deserialize, Serialize};

// ---------- 상태 ----------

/// 세션 상태(설계 794줄). `readyToFinalize`만 camelCase다 — 설계 표기 그대로.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Active,
    Paused,
    #[serde(rename = "readyToFinalize")]
    ReadyToFinalize,
    Finalized,
}

impl SessionStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionStatus::Active => "active",
            SessionStatus::Paused => "paused",
            SessionStatus::ReadyToFinalize => "readyToFinalize",
            SessionStatus::Finalized => "finalized",
        }
    }
}

/// direct: 대표 체크아웃의 기존 workBranch를 통합 대상으로 고정(기본).
/// isolated: 세션 전용 integration branch를 한 번 checkout해 산출물로 남긴다.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Direct,
    Isolated,
}

/// 통합 시도 단계. integration_attempt.phase의 값이며 재시작 복구 규칙(설계 479-486줄)의 판정 키다.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptPhase {
    #[serde(rename = "prepared")]
    Prepared,
    #[serde(rename = "merging")]
    Merging,
    #[serde(rename = "merged")]
    Merged,
    #[serde(rename = "verifying")]
    Verifying,
    #[serde(rename = "verified")]
    Verified,
    #[serde(rename = "verification_failed")]
    VerificationFailed,
    #[serde(rename = "conflict_aborted")]
    ConflictAborted,
    #[serde(rename = "baseline_failed")]
    BaselineFailed,
    #[serde(rename = "reverting")]
    Reverting,
    #[serde(rename = "reverted")]
    Reverted,
    #[serde(rename = "revert_conflicted")]
    RevertConflicted,
    #[serde(rename = "recovery_required")]
    RecoveryRequired,
}

impl AttemptPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            AttemptPhase::Prepared => "prepared",
            AttemptPhase::Merging => "merging",
            AttemptPhase::Merged => "merged",
            AttemptPhase::Verifying => "verifying",
            AttemptPhase::Verified => "verified",
            AttemptPhase::VerificationFailed => "verification_failed",
            AttemptPhase::ConflictAborted => "conflict_aborted",
            AttemptPhase::BaselineFailed => "baseline_failed",
            AttemptPhase::Reverting => "reverting",
            AttemptPhase::Reverted => "reverted",
            AttemptPhase::RevertConflicted => "revert_conflicted",
            AttemptPhase::RecoveryRequired => "recovery_required",
        }
    }
}

/// 후보 상태머신(설계 324-353줄). terminal이 아닌 상태에서는 큐가 진행된다.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeSetStatus {
    Working,
    ReviewPending,
    ChangesRequested,
    Approved,
    AuthorizedByPolicy,
    Queued,
    Integrating,
    Conflicted,
    Integrated,
    AutomatedVerifying,
    ManualVerificationPending,
    VerificationFailed,
    FixForward,
    Reverting,
    Reverted,
    Verified,
    Superseded,
    StaleContext,
    BaselineFailed,
    Redundant,
    ResolvedWithRepair,
    RecoveryRequired,
    RevertConflicted,
    Rejected,
}

impl ChangeSetStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeSetStatus::Working => "working",
            ChangeSetStatus::ReviewPending => "review_pending",
            ChangeSetStatus::ChangesRequested => "changes_requested",
            ChangeSetStatus::Approved => "approved",
            ChangeSetStatus::AuthorizedByPolicy => "authorized_by_policy",
            ChangeSetStatus::Queued => "queued",
            ChangeSetStatus::Integrating => "integrating",
            ChangeSetStatus::Conflicted => "conflicted",
            ChangeSetStatus::Integrated => "integrated",
            ChangeSetStatus::AutomatedVerifying => "automated_verifying",
            ChangeSetStatus::ManualVerificationPending => "manual_verification_pending",
            ChangeSetStatus::VerificationFailed => "verification_failed",
            ChangeSetStatus::FixForward => "fix_forward",
            ChangeSetStatus::Reverting => "reverting",
            ChangeSetStatus::Reverted => "reverted",
            ChangeSetStatus::Verified => "verified",
            ChangeSetStatus::Superseded => "superseded",
            ChangeSetStatus::StaleContext => "stale_context",
            ChangeSetStatus::BaselineFailed => "baseline_failed",
            ChangeSetStatus::Redundant => "redundant",
            ChangeSetStatus::ResolvedWithRepair => "resolved_with_repair",
            ChangeSetStatus::RecoveryRequired => "recovery_required",
            ChangeSetStatus::RevertConflicted => "revert_conflicted",
            ChangeSetStatus::Rejected => "rejected",
        }
    }

    /// 더 이상 자동 진행이 없는 상태. `redundant`와 해소된 terminal만 큐를 통과시킨다(설계 367줄).
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            ChangeSetStatus::Verified
                | ChangeSetStatus::Reverted
                | ChangeSetStatus::Superseded
                | ChangeSetStatus::Rejected
                | ChangeSetStatus::Redundant
                | ChangeSetStatus::ResolvedWithRepair
        )
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "working" => ChangeSetStatus::Working,
            "review_pending" => ChangeSetStatus::ReviewPending,
            "changes_requested" => ChangeSetStatus::ChangesRequested,
            "approved" => ChangeSetStatus::Approved,
            "authorized_by_policy" => ChangeSetStatus::AuthorizedByPolicy,
            "queued" => ChangeSetStatus::Queued,
            "integrating" => ChangeSetStatus::Integrating,
            "conflicted" => ChangeSetStatus::Conflicted,
            "integrated" => ChangeSetStatus::Integrated,
            "automated_verifying" => ChangeSetStatus::AutomatedVerifying,
            "manual_verification_pending" => ChangeSetStatus::ManualVerificationPending,
            "verification_failed" => ChangeSetStatus::VerificationFailed,
            "fix_forward" => ChangeSetStatus::FixForward,
            "reverting" => ChangeSetStatus::Reverting,
            "reverted" => ChangeSetStatus::Reverted,
            "verified" => ChangeSetStatus::Verified,
            "superseded" => ChangeSetStatus::Superseded,
            "stale_context" => ChangeSetStatus::StaleContext,
            "baseline_failed" => ChangeSetStatus::BaselineFailed,
            "redundant" => ChangeSetStatus::Redundant,
            "resolved_with_repair" => ChangeSetStatus::ResolvedWithRepair,
            "recovery_required" => ChangeSetStatus::RecoveryRequired,
            "revert_conflicted" => ChangeSetStatus::RevertConflicted,
            "rejected" => ChangeSetStatus::Rejected,
            _ => return None,
        })
    }
}

// ---------- 사람·정책 판정 ----------

/// 승인 주체 구분. 자동 정책은 사람 승인으로 위장하지 않는다(설계 317-320줄).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthorizationKind {
    Human,
    Policy,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PolicyMode {
    Required,
    AutoAfterPreflight,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CollaborationPolicy {
    /// 후보마다 사람 승인(required) 또는 사전검사 통과 시 자동 허가(autoAfterPreflight).
    pub local_integration_approval: PolicyMode,
    /// 후보 하나씩(perChange) 또는 승인 배치(approvedBatch — 4단계).
    pub verification_mode: String,
    /// 검증 실패 시 큐를 멈춘다. MVP는 pause 고정.
    pub failure_policy: String,
    /// `--no-ff` merge commit. MVP는 mergeCommit 고정.
    pub integration_strategy: String,
    /// 원격 쓰기는 로컬 병합과 별개 승인(불변식 6).
    pub remote_write_approval: String,
}

impl Default for CollaborationPolicy {
    fn default() -> Self {
        CollaborationPolicy {
            local_integration_approval: PolicyMode::Required,
            verification_mode: "perChange".into(),
            failure_policy: "pause".into(),
            integration_strategy: "mergeCommit".into(),
            remote_write_approval: "required".into(),
        }
    }
}

// ---------- 검증 프로필 ----------

/// 저장된 검증 명령. argv는 사람이 저장한 프로필에서만 온다(설계 290-291줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VerifyCheck {
    Command { cwd: String, argv: Vec<String> },
    Http { url: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VerifyProfile {
    pub checks: Vec<VerifyCheck>,
    /// 수동 확인 문구. 비어 있으면 자동 검사 성공 뒤 곧바로 verified.
    pub manual: Vec<String>,
}

// ---------- 프로젝트 정본 ----------

/// top-level host-owned `projects` 항목. key는 등록 때 만든 UUID projectId다(설계 294-295줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CoreProject {
    pub path: String,
    pub integration: IntegrationTarget,
    pub verify_profiles: std::collections::BTreeMap<String, VerifyProfile>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationTarget {
    /// 통합 체크아웃 절대경로. 기본값은 프로젝트 path 자체.
    pub path: String,
    /// 통합 대상 branch. direct 모드에서 세션 내내 유지된다.
    pub branch: String,
    /// 세션 시작 시 프로필 이름. 비어 있으면 기본 프로필을 찾는다.
    pub verify_profile: String,
}

// ---------- 장부 행 ----------

/// 세션. 하나의 목표에 여러 에이전트 실행과 후보를 묶는다(설계 104줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub goal: String,
    pub status: SessionStatus,
    pub mode: SessionMode,
    /// 대표 체크아웃 절대경로(integration checkout — `workspace`라 부르지 않는다).
    pub integration_path: String,
    pub integration_branch: String,
    /// 세션 시작 때의 통합 HEAD. 이슈 노트의 `base` 필드가 가리키는 값.
    pub target_start_sha: String,
    /// 시작 때 확인한 정책 스냅샷 버전. 세션 동안 유효한 effective policy.
    pub policy_version: i64,
    pub verification_profile: String,
    pub created_at: String,
    pub finalized_at: String,
    /// 사람이 멈춰야 하는 사유(dirty checkout, HEAD 이탈 등). 비어 있으면 정상.
    pub paused_reason: String,
}

impl Default for Session {
    fn default() -> Self {
        Session {
            id: String::new(),
            project_id: String::new(),
            goal: String::new(),
            status: SessionStatus::Active,
            mode: SessionMode::Direct,
            integration_path: String::new(),
            integration_branch: String::new(),
            target_start_sha: String::new(),
            policy_version: 1,
            verification_profile: String::new(),
            created_at: String::new(),
            finalized_at: String::new(),
            paused_reason: String::new(),
        }
    }
}

/// 에이전트 실행 한 번. Job(실행 기록)과 ChangeSet(변경 단위)을 `job_id`로 잇는다(설계 69줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRun {
    pub id: String,
    pub session_id: String,
    /// 기존 JobManager 잡 ID. 있을 때만 참조한다(설계 839-840줄).
    pub job_id: String,
    /// 레인이 수행할 task 정의 ID(t-...). 비어 있으면 자유 작업.
    pub task_id: String,
    /// `sawhorse/agent/<session-id>/<task-id>` 권장 규칙의 agent branch.
    pub branch: String,
    /// 전용 worktree 절대경로. 에이전트는 대표 경로를 받지 않는다.
    pub worktree_path: String,
    /// 관리형(Claude) 또는 수동 인박스 제출(Codex).
    pub driver: String,
    pub status: String,
    pub created_at: String,
    pub finished_at: String,
}

impl Default for AgentRun {
    fn default() -> Self {
        AgentRun {
            id: String::new(),
            session_id: String::new(),
            job_id: String::new(),
            task_id: String::new(),
            branch: String::new(),
            worktree_path: String::new(),
            driver: String::new(),
            status: "pending".into(),
            created_at: String::new(),
            finished_at: String::new(),
        }
    }
}

/// 후보의 exact change manifest 항목. 경로 하나의 old/new blob·mode·rename 관계(설계 189줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ManifestEntry {
    /// 저장소 루트 기준 상대경로. 항상 `/` 구분자.
    pub path: String,
    /// 추가일 때 빈 문자열.
    pub old_blob: String,
    /// 삭제일 때 빈 문자열.
    pub new_blob: String,
    /// `100644` / `100755` / `120000` / `160000`.
    pub mode: String,
    pub rename_from: String,
    pub binary: bool,
}

/// 후보 승인 identity. branch 이름·patch-id가 아닌 canonical digest(설계 176-178줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeSet {
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    /// 등록된 repository identity의 안정적 키(canonical repo root의 sha256 앞 16자).
    pub repository_id: String,
    pub base_sha: String,
    pub source_sha: String,
    pub base_tree_sha: String,
    pub source_tree_sha: String,
    /// `Vec<ManifestEntry>`의 canonical JSON. 에이전트 입력을 신뢰하지 않고 재계산한 값.
    pub manifest_json: String,
    /// 의존 후보 digest 또는 verified merge SHA 배열의 canonical JSON.
    pub dependency_json: String,
    /// 세션 검증 프로필 내용의 해시 — 프로필이 바뀌면 재승인 대상이 된다.
    pub verification_plan_hash: String,
    /// 승인·병합이 묶이는 불변 digest. base/source/tree/manifest/dependency 전부 포함.
    pub digest: String,
    pub status: ChangeSetStatus,
    pub summary: String,
    /// superseded가 된 이유와 대체 후보. 비어 있으면 해당 없음.
    pub superseded_by: String,
    /// repair 후보가 verified일 때 원래 실패 후보에 기록(설계 366줄).
    pub remediated_by: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Default for ChangeSet {
    fn default() -> Self {
        ChangeSet {
            id: String::new(),
            session_id: String::new(),
            task_id: String::new(),
            repository_id: String::new(),
            base_sha: String::new(),
            source_sha: String::new(),
            base_tree_sha: String::new(),
            source_tree_sha: String::new(),
            manifest_json: String::new(),
            dependency_json: String::new(),
            verification_plan_hash: String::new(),
            digest: String::new(),
            status: ChangeSetStatus::Working,
            summary: String::new(),
            superseded_by: String::new(),
            remediated_by: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }
}

/// 후보 하나를 특정 통합 HEAD에 병합하고 검사한 기록(설계 107줄).
/// 이 행이 곧 Git 변경의 write-ahead 장부다 — 실제 Git 단계마다 먼저 전진시킨다(설계 459-477줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationAttempt {
    pub id: String,
    pub candidate_id: String,
    pub session_id: String,
    pub operation: String,
    /// prepared → merging → merged → verifying → verified | verification_failed | ...
    pub phase: AttemptPhase,
    /// Git 변경 직전의 통합 HEAD.
    pub pre_head: String,
    /// merge/revert simulation으로 얻은 예상 tree. 실제 write-tree와 대조한다.
    pub planned_tree_sha: String,
    pub source_sha: String,
    /// baseline(병합 전) 명령·health 결과 요약. 실패 증거와 묶인다.
    pub baseline_json: String,
    pub merge_sha: String,
    pub revert_sha: String,
    pub failure_detail: String,
    pub created_at: String,
    pub finished_at: String,
}

impl Default for IntegrationAttempt {
    fn default() -> Self {
        IntegrationAttempt {
            id: String::new(),
            candidate_id: String::new(),
            session_id: String::new(),
            operation: "merge".into(),
            phase: AttemptPhase::Prepared,
            pre_head: String::new(),
            planned_tree_sha: String::new(),
            source_sha: String::new(),
            baseline_json: String::new(),
            merge_sha: String::new(),
            revert_sha: String::new(),
            failure_detail: String::new(),
            created_at: String::new(),
            finished_at: String::new(),
        }
    }
}

/// 검증 프로필의 check 한 번 실행 기록.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckRun {
    pub id: String,
    pub attempt_id: String,
    /// command | http | manual | baseline_command | baseline_http
    pub kind: String,
    pub name: String,
    pub status: String,
    /// artifact 파일 참조(content hash 이름). 로그 본문은 DB에 넣지 않는다.
    pub log_ref: String,
    pub started_at: String,
    pub finished_at: String,
}

impl Default for CheckRun {
    fn default() -> Self {
        CheckRun {
            id: String::new(),
            attempt_id: String::new(),
            kind: String::new(),
            name: String::new(),
            status: "pending".into(),
            log_ref: String::new(),
            started_at: String::new(),
            finished_at: String::new(),
        }
    }
}

/// 사람 승인 기록. 사용자·시각·digest·예상 통합 HEAD·정책 버전을 담는다(설계 318줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Approval {
    pub id: String,
    pub candidate_id: String,
    pub digest: String,
    /// 승인 때 본 통합 HEAD. 이것과 다르면 무조건 재승인(설계 378-380줄).
    pub expected_head: String,
    pub policy_version: i64,
    pub decision: String,
    pub decided_by: String,
    pub reason: String,
    pub created_at: String,
}

impl Default for Approval {
    fn default() -> Self {
        Approval {
            id: String::new(),
            candidate_id: String::new(),
            digest: String::new(),
            expected_head: String::new(),
            policy_version: 1,
            decision: String::new(),
            decided_by: String::new(),
            reason: String::new(),
            created_at: String::new(),
        }
    }
}

/// 승인 신호의 정체. `kind: policy`는 자동 허가다(설계 319-320줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthorizationDecision {
    pub id: String,
    pub candidate_id: String,
    pub kind: AuthorizationKind,
    pub policy_version: i64,
    /// merge trailer `Sawhorse-Authorization`이 참조하는 ID.
    pub decision_ref: String,
    pub created_at: String,
}

impl Default for AuthorizationDecision {
    fn default() -> Self {
        AuthorizationDecision {
            id: String::new(),
            candidate_id: String::new(),
            kind: AuthorizationKind::Human,
            policy_version: 1,
            decision_ref: String::new(),
            created_at: String::new(),
        }
    }
}

/// 세션 시작 때 고정된 정책 스냅샷. 전역·프로젝트 설정 변경이 활성 세션을 몰래 바꾸지 않는다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PolicySnapshot {
    pub version: i64,
    pub project_id: String,
    pub policy_json: String,
    pub created_at: String,
    pub created_by: String,
}

impl Default for PolicySnapshot {
    fn default() -> Self {
        PolicySnapshot {
            version: 1,
            project_id: String::new(),
            policy_json: String::new(),
            created_at: String::new(),
            created_by: String::new(),
        }
    }
}

/// 감사 이벤트. 내부 상태 전이와 event_outbox가 같은 트랜잭션에서 기록된다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditEvent {
    pub id: String,
    pub kind: String,
    pub project_id: String,
    pub session_id: String,
    pub payload_json: String,
    pub created_at: String,
}

impl Default for AuditEvent {
    fn default() -> Self {
        AuditEvent {
            id: String::new(),
            kind: String::new(),
            project_id: String::new(),
            session_id: String::new(),
            payload_json: String::new(),
            created_at: String::new(),
        }
    }
}

// ---------- 인박스 wire ----------

/// 에이전트가 쓰는 후보 요청 파일(설계 202-216줄). 검증 전까지는 신뢰하지 않는다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposeRequest {
    pub op: String,
    pub session_id: String,
    pub task_id: String,
    pub agent: String,
    /// 표시·진단용. 병합 입력으로 신뢰하지 않는다(설계 218줄).
    pub worktree: String,
    pub base_sha: String,
    pub source_sha: String,
    pub summary: String,
    pub checks: Vec<ProposedCheck>,
    /// 의존 후보 digest 또는 verified merge SHA.
    pub depends_on: Vec<String>,
    /// 이슈 노트 변경 intent(세션 모드). 코어가 검증 뒤 한 번만 적용한다.
    pub note_intents: Vec<NoteIntent>,
}

impl Default for ProposeRequest {
    fn default() -> Self {
        ProposeRequest {
            op: "propose".into(),
            session_id: String::new(),
            task_id: String::new(),
            agent: String::new(),
            worktree: String::new(),
            base_sha: String::new(),
            source_sha: String::new(),
            summary: String::new(),
            checks: Vec::new(),
            depends_on: Vec::new(),
            note_intents: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposedCheck {
    pub name: String,
    pub status: String,
    pub log_ref: String,
}

impl Default for ProposedCheck {
    fn default() -> Self {
        ProposedCheck {
            name: String::new(),
            status: String::new(),
            log_ref: String::new(),
        }
    }
}

/// 공유 이슈 노트에 대한 변경 의도. lane은 노트를 직접 고치지 않는다(설계 76-78줄).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteIntent {
    pub note_path: String,
    /// expected_local_hash가 현재 파일 해시와 다르면 거절한다.
    pub expected_local_hash: String,
    pub field: String,
    pub value: String,
}

impl Default for NoteIntent {
    fn default() -> Self {
        NoteIntent {
            note_path: String::new(),
            expected_local_hash: String::new(),
            field: String::new(),
            value: String::new(),
        }
    }
}

/// 대시보드 검토 화면에 내려주는 후보 스냅샷. manifest를 구조화해 함께 보낸다.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetView {
    #[serde(flatten)]
    pub change_set: ChangeSet,
    pub manifest: Vec<ManifestEntry>,
    pub depends_on: Vec<String>,
    pub session_goal: String,
    /// 위험 경로(semantic overlap)에 걸린 파일 목록.
    pub overlap_paths: Vec<String>,
    /// 승인 때 예상되는 통합 HEAD(현재 기준).
    pub expected_head: String,
    pub approvals: Vec<Approval>,
}

/// 세션 상세 화면 응답.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub session: Session,
    pub agent_runs: Vec<AgentRun>,
    pub change_sets: Vec<ChangeSetView>,
    /// 통합 체크아웃의 현재 상태(path, branch, HEAD, clean 여부).
    pub integration_head: String,
    pub integration_clean: bool,
}

/// digest 계산 입력. 필드 순서가 곧 canonical 순서다.
pub(crate) fn digest_payload(
    base_sha: &str,
    source_sha: &str,
    base_tree: &str,
    source_tree: &str,
    manifest_json: &str,
    dependency_json: &str,
    verification_plan_hash: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    // 구분자로 필드 경계를 보존한다. 길이 접두 대신 길이+값을 붙인다.
    for part in [
        base_sha,
        source_sha,
        base_tree,
        source_tree,
        manifest_json,
        dependency_json,
        verification_plan_hash,
    ] {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

/// 테스트·픽스처에서 쓰는 별칭. 본체는 digest_payload.
pub fn digest_for_test(
    base_sha: &str,
    source_sha: &str,
    base_tree: &str,
    source_tree: &str,
    manifest_json: &str,
    dependency_json: &str,
    verification_plan_hash: &str,
) -> String {
    digest_payload(
        base_sha,
        source_sha,
        base_tree,
        source_tree,
        manifest_json,
        dependency_json,
        verification_plan_hash,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_order_sensitive_and_stable() {
        let a = digest_payload("b1", "s1", "t1", "t2", "[]", "[]", "ph");
        let b = digest_payload("b1", "s1", "t1", "t2", "[]", "[]", "ph");
        let c = digest_payload("s1", "b1", "t1", "t2", "[]", "[]", "ph");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn terminal_statuses_block_the_queue() {
        assert!(ChangeSetStatus::Verified.is_terminal());
        assert!(ChangeSetStatus::Redundant.is_terminal());
        assert!(!ChangeSetStatus::Queued.is_terminal());
        assert!(!ChangeSetStatus::VerificationFailed.is_terminal());
    }

    #[test]
    fn status_roundtrip() {
        for s in [
            ChangeSetStatus::Working,
            ChangeSetStatus::AuthorizedByPolicy,
            ChangeSetStatus::ResolvedWithRepair,
            ChangeSetStatus::RevertConflicted,
        ] {
            assert_eq!(ChangeSetStatus::parse(s.as_str()), Some(s));
        }
        assert_eq!(ChangeSetStatus::parse("nope"), None);
    }

    #[test]
    fn session_status_serializes_design_strings() {
        let v = serde_json::to_value(SessionStatus::ReadyToFinalize).unwrap();
        assert_eq!(v, serde_json::json!("readyToFinalize"));
        let v = serde_json::to_value(SessionStatus::Active).unwrap();
        assert_eq!(v, serde_json::json!("active"));
    }

    #[test]
    fn verify_check_uses_kind_tag() {
        let check = VerifyCheck::Command {
            cwd: "dashboard".into(),
            argv: vec!["npm".into(), "run".into(), "build".into()],
        };
        let v = serde_json::to_value(&check).unwrap();
        assert_eq!(v["kind"], "command");
        assert_eq!(v["argv"][0], "npm");
    }
}
