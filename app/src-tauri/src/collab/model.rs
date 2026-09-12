// Type contract for the collaboration ledger. Rust representation of the candidate contract (design lines 180-229) and the table list (design lines 544-552).
//
// Rules:
// - wire (DB and frontend) is camelCase; every new field gets `#[serde(default)]` so existing rows and responses keep working.
// - Status strings are stored and sent exactly as written in the design (e.g. `readyToFinalize`, `authorized_by_policy`).
// - digest is sha256 over canonical JSON with a fixed struct field order; it never depends on map iteration order.

use serde::{Deserialize, Serialize};

// ---------- Status ----------

/// Session status (design line 794). Only `readyToFinalize` is camelCase — as written in the design.
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

/// direct: pin the representative checkout's existing workBranch as the integration target (default).
/// isolated: check out a session-dedicated integration branch once and keep the outputs there.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SessionMode {
    Direct,
    Isolated,
}

/// Integration attempt phase. The value of integration_attempt.phase and the decision key for restart recovery rules (design lines 479-486).
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

/// Candidate state machine (design lines 324-353). The queue progresses while not in a terminal state.
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

    /// Status with no further automatic progression. Only `redundant` and resolved terminal states pass the queue (design line 367).
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

// ---------- Human and policy decisions ----------

/// Who authorized. Automatic policy never masquerades as human approval (design lines 317-320).
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
    /// Human approval per candidate (required) or automatic authorization once preflight passes (autoAfterPreflight).
    pub local_integration_approval: PolicyMode,
    /// One candidate at a time (perChange) or approved batches (approvedBatch — phase 4).
    pub verification_mode: String,
    /// Stops the queue on verification failure. MVP fixes this to pause.
    pub failure_policy: String,
    /// `--no-ff` merge commit. MVP fixes this to mergeCommit.
    pub integration_strategy: String,
    /// Remote writes need a separate approval from local merges (invariant 6).
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

// ---------- Verification profile ----------

/// Saved verification commands. argv comes only from human-saved profiles (design lines 290-291).
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
    /// Manual confirmation prompts. If empty, the candidate becomes verified right after automated checks pass.
    pub manual: Vec<String>,
}

// ---------- Project registry ----------

/// top-level host-owned `projects` entry. The key is the UUID projectId created at registration (design lines 294-295).
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
    /// Absolute path of the integration checkout. Defaults to the project path itself.
    pub path: String,
    /// Integration target branch. Kept for the whole session in direct mode.
    pub branch: String,
    /// Profile name at session start. If empty, the default profile is looked up.
    pub verify_profile: String,
}

// ---------- Ledger rows ----------

/// Session. Groups multiple agent runs and candidates under one goal (design line 104).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub goal: String,
    pub status: SessionStatus,
    pub mode: SessionMode,
    /// Absolute path of the representative checkout (integration checkout — not called `workspace`).
    pub integration_path: String,
    pub integration_branch: String,
    /// Integration HEAD at session start. The value the issue note's `base` field points to.
    pub target_start_sha: String,
    /// Policy snapshot version verified at start. The effective policy valid for the session.
    pub policy_version: i64,
    pub verification_profile: String,
    pub created_at: String,
    pub finalized_at: String,
    /// Reason a human must pause things (dirty checkout, HEAD drift, etc.). Empty means normal.
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

/// One agent run. Links Job (run record) and ChangeSet (unit of change) via `job_id` (design line 69).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRun {
    pub id: String,
    pub session_id: String,
    /// Existing JobManager job ID. Referenced only when present (design lines 839-840).
    pub job_id: String,
    /// Task definition ID (t-...) the lane executes. Empty means free-form work.
    pub task_id: String,
    /// Agent branch following the `sawhorse/agent/<session-id>/<task-id>` recommended convention.
    pub branch: String,
    /// Absolute path of the dedicated worktree. Agents never get the representative path.
    pub worktree_path: String,
    /// Managed (Claude) or manual inbox submission (Codex).
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

/// One entry of a candidate's exact change manifest. Old/new blob, mode, and rename relation for one path (design line 189).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ManifestEntry {
    /// Path relative to the repository root. Always `/`-separated.
    pub path: String,
    /// Empty string for additions.
    pub old_blob: String,
    /// Empty string for deletions.
    pub new_blob: String,
    /// `100644` / `100755` / `120000` / `160000`.
    pub mode: String,
    pub rename_from: String,
    pub binary: bool,
}

/// Candidate approval identity. A canonical digest, not the branch name or patch-id (design lines 176-178).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeSet {
    pub id: String,
    pub session_id: String,
    pub task_id: String,
    /// Stable key of the registered repository identity (first 16 hex chars of the sha256 of the canonical repo root).
    pub repository_id: String,
    pub base_sha: String,
    pub source_sha: String,
    pub base_tree_sha: String,
    pub source_tree_sha: String,
    /// Canonical JSON of `Vec<ManifestEntry>`. Recomputed without trusting agent input.
    pub manifest_json: String,
    /// Canonical JSON of dependent candidate digests or verified merge SHAs.
    pub dependency_json: String,
    /// Hash of the session verification profile content — changing the profile triggers re-approval.
    pub verification_plan_hash: String,
    /// Immutable digest binding approval and merge. Includes base/source/tree/manifest/dependency.
    pub digest: String,
    pub status: ChangeSetStatus,
    pub summary: String,
    /// Reason for being superseded and the replacing candidate. Empty if not applicable.
    pub superseded_by: String,
    /// Recorded on the originally failed candidate when a repair candidate is verified (design line 366).
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

/// Record of merging and checking one candidate against a specific integration HEAD (design line 107).
/// This row is the write-ahead ledger for Git changes — advance it before every actual Git step (design lines 459-477).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationAttempt {
    pub id: String,
    pub candidate_id: String,
    pub session_id: String,
    pub operation: String,
    /// prepared → merging → merged → verifying → verified | verification_failed | ...
    pub phase: AttemptPhase,
    /// Integration HEAD immediately before the Git change.
    pub pre_head: String,
    /// Expected tree obtained via merge/revert simulation. Compared against the actual write-tree.
    pub planned_tree_sha: String,
    pub source_sha: String,
    /// Summary of baseline (pre-merge) command and health results. Bound to the failure evidence.
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

/// Record of one execution of a check from the verification profile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckRun {
    pub id: String,
    pub attempt_id: String,
    /// command | http | manual | baseline_command | baseline_http
    pub kind: String,
    pub name: String,
    pub status: String,
    /// Artifact file reference (content-hash name). Log bodies are not stored in the DB.
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

/// Human approval record. Holds user, time, digest, expected integration HEAD, and policy version (design line 318).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Approval {
    pub id: String,
    pub candidate_id: String,
    pub digest: String,
    /// Integration HEAD seen at approval time. Any difference forces re-approval (design lines 378-380).
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

/// Identity of the approval signal. `kind: policy` means automatic authorization (design lines 319-320).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthorizationDecision {
    pub id: String,
    pub candidate_id: String,
    pub kind: AuthorizationKind,
    pub policy_version: i64,
    /// ID referenced by the merge trailer `Sawhorse-Authorization`.
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

/// Policy snapshot fixed at session start. Global or project setting changes never silently alter an active session.
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

/// Audit event. Internal state transitions and event_outbox are recorded in the same transaction.
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

// ---------- Inbox wire ----------

/// Candidate request file written by agents (design lines 202-216). Not trusted until verified.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProposeRequest {
    pub op: String,
    pub session_id: String,
    pub task_id: String,
    pub agent: String,
    /// For display and diagnostics. Not trusted as a merge input (design line 218).
    pub worktree: String,
    pub base_sha: String,
    pub source_sha: String,
    pub summary: String,
    pub checks: Vec<ProposedCheck>,
    /// Dependent candidate digest or verified merge SHA.
    pub depends_on: Vec<String>,
    /// Issue note change intent (session mode). The core applies it once, after verification.
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

/// Intent to change a shared issue note. Lanes never edit the note directly (design lines 76-78).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteIntent {
    pub note_path: String,
    /// Rejected if expected_local_hash differs from the current file hash.
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

/// Candidate snapshot sent to the dashboard review screen. Sends the manifest structured alongside.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSetView {
    #[serde(flatten)]
    pub change_set: ChangeSet,
    pub manifest: Vec<ManifestEntry>,
    pub depends_on: Vec<String>,
    pub session_goal: String,
    /// Files caught on risky paths (semantic overlap).
    pub overlap_paths: Vec<String>,
    /// Integration HEAD expected at approval time (relative to now).
    pub expected_head: String,
    pub approvals: Vec<Approval>,
}

/// Session detail screen response.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    #[serde(flatten)]
    pub session: Session,
    pub agent_runs: Vec<AgentRun>,
    pub change_sets: Vec<ChangeSetView>,
    /// Current state of the integration checkout (path, branch, HEAD, cleanliness).
    pub integration_head: String,
    pub integration_clean: bool,
}

/// digest input. Field order is the canonical order.
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
    // Preserve field boundaries as delimiters. Append length+value instead of a bare length prefix.
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

/// Alias used by tests and fixtures. The body is digest_payload.
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
