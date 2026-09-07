// Vault access: issue-note frontmatter scan/approval, journal todos,
// vault tree + note reading. Writes are limited to: approval 3-key update and
// todo checkbox toggles/additions. Everything else is read-only.

use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use serde::Serialize;
use serde_json::{Map as JsonMap, Value as Json};
use serde_yaml::{Mapping, Value as Yaml};

use crate::config::write_atomic;

// ---------- low-level frontmatter splitting ----------

pub struct SplitNote {
    pub yaml: String,
    pub after_close: String,
}

pub fn split_frontmatter(text: &str) -> Option<SplitNote> {
    if !text.starts_with("---") {
        return None;
    }
    let first_nl = text.find('\n')?;
    let head = &text[..first_nl];
    if head.trim_end_matches('\r') != "---" {
        return None;
    }
    let rest = &text[first_nl + 1..];
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        let t = line.trim_end_matches(|c| c == '\n' || c == '\r');
        if t == "---" || t == "..." {
            return Some(SplitNote {
                yaml: rest[..offset].to_string(),
                after_close: rest[offset + line.len()..].to_string(),
            });
        }
        offset += line.len();
    }
    None
}

fn parse_mapping(yaml: &str) -> Result<Mapping, String> {
    serde_yaml::from_str::<Mapping>(yaml).map_err(|e| format!("frontmatter 파싱 실패: {e}"))
}

fn fm_str(map: &Mapping, key: &str) -> String {
    map.get(Yaml::from(key))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn fm_bool(map: &Mapping, key: &str) -> bool {
    map.get(Yaml::from(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn fm_list(map: &Mapping, key: &str) -> Vec<String> {
    map.get(Yaml::from(key))
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .map(|v| match v {
                    Yaml::String(s) => s.clone(),
                    other => serde_yaml::to_string(other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn yaml_to_json(v: &Yaml) -> Json {
    match v {
        Yaml::Null => Json::Null,
        Yaml::Bool(b) => Json::Bool(*b),
        Yaml::Number(n) => {
            if let Some(i) = n.as_i64() {
                Json::from(i)
            } else if let Some(u) = n.as_u64() {
                Json::from(u)
            } else {
                Json::from(n.as_f64().unwrap_or(0.0))
            }
        }
        Yaml::String(s) => Json::String(s.clone()),
        Yaml::Sequence(seq) => Json::Array(seq.iter().map(yaml_to_json).collect()),
        Yaml::Mapping(m) => {
            let mut out = JsonMap::new();
            for (k, val) in m {
                let key = match k {
                    Yaml::String(s) => s.clone(),
                    other => serde_yaml::to_string(other)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                };
                out.insert(key, yaml_to_json(val));
            }
            Json::Object(out)
        }
        Yaml::Tagged(tagged) => yaml_to_json(&tagged.value),
    }
}

pub(crate) fn mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- 프로젝트 폴더 ----------

/// 프로젝트 문서가 사는 볼트 루트. 새로 쓰는 경로는 항상 이 이름이다.
pub const PROJECT_ROOT: &str = "프로젝트";
/// SI 업무 전용이던 시절의 이름. 읽기만 호환하며 새로 만들지 않는다.
pub const LEGACY_PROJECT_ROOT: &str = "사업";

/// 한 프로젝트의 문서 폴더. 정본 위치가 있으면 그것만 쓰고, 없을 때만 예전
/// `사업/`을 읽는다. 마이그레이션 도중 같은 이슈가 두 루트에서 두 번 잡히는
/// 것을 막으려는 것이다. 둘 다 없으면 정본 경로를 돌려준다 — 진단 메시지가
/// 사용자에게 안내할 경로는 새 위치여야 한다.
pub(crate) fn project_dir(vault: &Path, project: &str) -> PathBuf {
    let canonical = vault.join(PROJECT_ROOT).join(project);
    if canonical.is_dir() {
        return canonical;
    }
    let legacy = vault.join(LEGACY_PROJECT_ROOT).join(project);
    if legacy.is_dir() {
        legacy
    } else {
        canonical
    }
}

// ---------- issue notes ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementNote {
    pub project: String,
    pub path: String,
    pub id: String,
    pub title: String,
    pub url: String,
    pub category: String,
    pub issue_type: String,
    pub execution_type: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub milestone: String,
    pub priority: String,
    pub status: String,
    pub state: String,
    pub approval_required: bool,
    pub approve: bool,
    pub approved: String,
    pub verified: String,
    pub depends_on: Vec<String>,
    pub dependents: Vec<String>,
    pub commits: Vec<String>,
    /// 세션 모드: 세션의 target_start_sha(설계 85줄). 레거시 노트는 빈 값.
    pub base: String,
    /// 세션 모드: 통합 대상 branch(설계 86줄).
    pub branch: String,
    pub github_repo: String,
    pub github_number: String,
    pub github_url: String,
    pub github_state: String,
    /// 마지막 원격 갱신 시각. connector 단계에서 typed로 읽는다(설계 687-688줄).
    pub github_updated: String,
    pub closed: String,
    pub legacy: bool,
    /// 이 노트를 옮겨 만든 개발 항목 ID. 비어 있으면 아직 이관 전이다.
    pub migrated_to: String,
    pub mtime_ms: u64,
}

fn is_issue_note(file_name: &str) -> bool {
    // 이슈 노트만. MOC, 인박스, 뷰는 제외.
    file_name.ends_with(".md")
        && file_name != "이슈.md"
        && file_name != "개선.md"
        && !file_name.ends_with("이슈목록.md")
        && !file_name.ends_with("문제목록.md")
}

pub(crate) fn note_from_file(
    project: &str,
    path: &Path,
    map: &Mapping,
    legacy: bool,
) -> ImprovementNote {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let id = fm_str(map, "id");
    let title = match stem.strip_prefix(&format!("{id} ")) {
        Some(t) => t.to_string(),
        None => stem,
    };
    ImprovementNote {
        project: project.to_string(),
        path: path.to_string_lossy().to_string(),
        id,
        title,
        url: fm_str(map, "url"),
        category: fm_str(map, "category"),
        issue_type: {
            let value = fm_str(map, "issue_type");
            if value.is_empty() {
                fm_str(map, "category")
            } else {
                value
            }
        },
        execution_type: {
            let value = fm_str(map, "execution_type");
            if value.is_empty() {
                if legacy {
                    "코드".into()
                } else {
                    "작업".into()
                }
            } else {
                value
            }
        },
        labels: fm_list(map, "labels"),
        assignees: fm_list(map, "assignees"),
        milestone: fm_str(map, "milestone"),
        priority: fm_str(map, "priority"),
        status: fm_str(map, "status"),
        state: {
            let value = fm_str(map, "state");
            if value.is_empty() {
                match fm_str(map, "status").as_str() {
                    "완료" | "취소" | "구현완료" | "반려" => "closed".into(),
                    _ => "open".into(),
                }
            } else {
                value
            }
        },
        approval_required: map
            .get(Yaml::from("approval_required"))
            .and_then(|v| v.as_bool())
            .unwrap_or(true),
        approve: fm_bool(map, "approve"),
        approved: fm_str(map, "approved"),
        verified: fm_str(map, "verified"),
        depends_on: fm_list(map, "depends_on"),
        dependents: fm_list(map, "dependents"),
        commits: fm_list(map, "commits"),
        base: fm_str(map, "base"),
        branch: fm_str(map, "branch"),
        github_repo: fm_str(map, "github_repo"),
        github_number: fm_str(map, "github_number"),
        github_url: fm_str(map, "github_url"),
        github_state: fm_str(map, "github_state"),
        github_updated: fm_str(map, "github_updated"),
        closed: fm_str(map, "closed"),
        legacy,
        migrated_to: fm_str(map, "migrated_to"),
        mtime_ms: mtime_ms(path),
    }
}

/// Merge configured projects with every first-level project directory in the
/// vault. Both the canonical `프로젝트/` root and the legacy `사업/` root count,
/// so a half-migrated vault still lists each project exactly once.
/// A project without a codebase config can still own and display generic issues.
pub fn project_pairs(vault: &Path, configured: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = configured.to_vec();
    for root in [PROJECT_ROOT, LEGACY_PROJECT_ROOT] {
        let Ok(entries) = std::fs::read_dir(vault.join(root)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if path.is_dir() && !out.iter().any(|(known, _)| known == name) {
                out.push((name.to_string(), String::new()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Scan new issue notes and legacy improvement notes. Legacy notes are never
/// rewritten here; the dashboard only marks them so users can migrate safely.
pub fn scan_issues(
    vault: &Path,
    project_filter: Option<&str>,
    projects: &[String],
) -> Vec<ImprovementNote> {
    let mut out = Vec::new();
    for project in projects {
        if let Some(f) = project_filter {
            if f != project {
                continue;
            }
        }
        for (dir_name, note_type, legacy) in [("이슈", "이슈", false), ("개선", "개선", true)]
        {
            let dir = project_dir(vault, project).join(dir_name);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !is_issue_note(name) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let Some(split) = split_frontmatter(&text) else {
                    continue;
                };
                let Ok(map) = parse_mapping(&split.yaml) else {
                    continue;
                };
                let note_kind = fm_str(&map, "type");
                // Some pre-template legacy notes have no type at all; retain
                // the historical scanner's permissive behavior for them only.
                if note_kind == note_type || (legacy && note_kind.is_empty()) {
                    out.push(note_from_file(project, &path, &map, legacy));
                }
            }
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

/// Compatibility entry point retained for older dashboard clients.
pub fn scan_improvements(
    vault: &Path,
    project_filter: Option<&str>,
    projects: &[String],
) -> Vec<ImprovementNote> {
    scan_issues(vault, project_filter, projects)
}

/// Human approval. Same write the vault checkbox performs: approve→true,
/// approved→today, status→승인. Preconditions guard against skill-side misuse.
pub fn approve_note(path: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("노트 읽기 실패: {e}"))?;
    let split = split_frontmatter(&text).ok_or("frontmatter가 없는 노트입니다")?;
    let mut map = parse_mapping(&split.yaml)?;

    if fm_bool(&map, "approve") {
        return Err("이미 승인된 이슈입니다".into());
    }
    let status = fm_str(&map, "status");
    if status != "승인대기" {
        return Err(format!("승인대기 상태가 아닙니다 (현재: {status})"));
    }
    // 실행 대상 게이트: 설계 없이 체크만 켜진 건은 승인 무효.
    // Legacy notes retain their historical heading for read-only compatibility.
    let body = &split.after_close;
    if !body.contains("### 실행 대상") && !body.contains("### 변경 대상") {
        return Err("설계서에 '### 실행 대상' 절이 없어 승인할 수 없습니다".into());
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    map.insert(Yaml::from("approve"), Yaml::from(true));
    map.insert(Yaml::from("approved"), Yaml::from(today));
    map.insert(Yaml::from("status"), Yaml::from("승인"));

    let new_yaml =
        serde_yaml::to_string(&map).map_err(|e| format!("frontmatter 직렬화 실패: {e}"))?;
    let new_text = format!("---\n{new_yaml}---\n{}", split.after_close);
    write_atomic(path, new_text.as_bytes()).map_err(|e| format!("노트 저장 실패: {e}"))?;
    Ok(())
}

/// Read one improvement note: body markdown + frontmatter as JSON.
pub fn read_note(path: &Path) -> Result<(Json, String), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("노트 읽기 실패: {e}"))?;
    let split = split_frontmatter(&text).ok_or("frontmatter가 없는 노트입니다")?;
    let map = parse_mapping(&split.yaml)?;
    let mut obj = JsonMap::new();
    for (k, v) in &map {
        let key = match k {
            Yaml::String(s) => s.clone(),
            other => serde_yaml::to_string(other)
                .unwrap_or_default()
                .trim()
                .to_string(),
        };
        obj.insert(key, yaml_to_json(v));
    }
    Ok((Json::Object(obj), split.after_close))
}

/// Resolve each project's inbox list files: 이슈/<idPrefix> 이슈목록.md (new) and
/// 개선/<idPrefix> 문제목록.md (legacy). Projects with an empty id_prefix match
/// any `*이슈목록.md`/`*문제목록.md`; missing folders yield no entries.
fn problem_list_paths(
    vault: &Path,
    projects: &[(String, String)],
) -> Vec<(String, String, PathBuf)> {
    let mut out = Vec::new();
    for (name, id_prefix) in projects {
        for (dir_name, suffix) in [("이슈", "이슈목록.md"), ("개선", "문제목록.md")] {
            let dir = project_dir(vault, name).join(dir_name);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                let matches = if id_prefix.is_empty() {
                    fname.ends_with(suffix)
                } else {
                    fname == &format!("{id_prefix} {suffix}")
                };
                if matches {
                    out.push((name.clone(), id_prefix.clone(), path));
                }
            }
        }
    }
    out
}

/// Count unpromoted items in the new issue inbox and the legacy problem inbox.
pub fn inbox_count(vault: &Path, projects: &[(String, String)], filter: Option<&str>) -> u64 {
    problem_list_paths(vault, projects)
        .into_iter()
        .filter(|(name, _, _)| filter.map(|f| f == name.as_str()).unwrap_or(true))
        .map(|(_, _, path)| {
            std::fs::read_to_string(&path)
                .map(|text| section_items(&text, "## 신규 (미승격)").len() as u64)
                .unwrap_or(0)
        })
        .sum()
}

fn section_items(text: &str, header: &str) -> Vec<String> {
    let mut items = Vec::new();
    let mut in_section = false;
    for line in text.lines() {
        let t = line.trim_end();
        if t.starts_with("## ") {
            if in_section {
                break;
            }
            in_section = t == header;
            continue;
        }
        if in_section && t.starts_with("- ") {
            items.push(t[2..].trim().to_string());
        }
    }
    items
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnpromotedItem {
    pub project: String,
    pub id_prefix: String,
    pub text: String,
    pub list_path: String,
}

/// List unpromoted items (`## 신규 (미승격)`) from issue and legacy inboxes.
pub fn list_unpromoted(vault: &Path, projects: &[(String, String)]) -> Vec<UnpromotedItem> {
    let mut out = Vec::new();
    for (name, id_prefix, path) in problem_list_paths(vault, projects) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        for item in section_items(&text, "## 신규 (미승격)") {
            out.push(UnpromotedItem {
                project: name.clone(),
                id_prefix: id_prefix.clone(),
                text: item,
                list_path: path.to_string_lossy().to_string(),
            });
        }
    }
    out
}

// ---------- vault audit ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuditIssue {
    pub severity: String, // "error" | "warn" | "info"
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JournalAudit {
    pub today_exists: bool,
    pub missing: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultAudit {
    pub issues: Vec<AuditIssue>,
    pub journal: JournalAudit,
    pub scanned_at_ms: u64,
}

/// Canonical issue vocabulary plus legacy improvement values.
const STATUS_SET: [&str; 12] = [
    "제안",
    "승인대기",
    "승인",
    "진행중",
    "부분완료",
    "완료",
    "보류",
    "취소",
    "구현중",
    "부분구현",
    "구현완료",
    "반려",
];

fn is_closed_status(status: &str) -> bool {
    matches!(status, "완료" | "취소" | "구현완료" | "반려")
}

fn milestone_ids(vault: &Path, project: &str) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(vault.join("calendar")) {
        for entry in entries.flatten() {
            if let Ok(text) = std::fs::read_to_string(entry.path()) {
                if let Some(split) = split_frontmatter(&text) {
                    if let Ok(map) = parse_mapping(&split.yaml) {
                        if fm_str(&map, "kind") == "milestone" {
                            ids.insert(fm_str(&map, "id"));
                        }
                    }
                }
            }
        }
    }
    let dir = project_dir(vault, project).join("마일스톤");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return ids;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let Some(split) = split_frontmatter(&text) else {
            continue;
        };
        let Ok(map) = parse_mapping(&split.yaml) else {
            continue;
        };
        if fm_str(&map, "type") == "마일스톤" {
            let id = fm_str(&map, "id");
            if !id.is_empty() {
                ids.insert(id);
            }
        }
    }
    ids
}

pub fn audit_vault(vault: &Path, projects: &[(String, String)]) -> VaultAudit {
    let mut issues = Vec::new();

    // 이슈 노트 규칙: status/state, 승인 기록, 의존성, 마일스톤 참조.
    let names: Vec<String> = projects.iter().map(|(n, _)| n.clone()).collect();
    let notes = scan_issues(vault, None, &names);
    let ids: std::collections::HashSet<&str> = notes.iter().map(|n| n.id.as_str()).collect();
    for n in &notes {
        if !STATUS_SET.contains(&n.status.as_str()) {
            issues.push(AuditIssue {
                severity: "error".into(),
                path: n.path.clone(),
                message: format!("{}: status '{}' — 허용 집합 밖", n.id, n.status),
            });
        }
        if n.approve {
            if !matches!(
                n.status.as_str(),
                "승인" | "진행중" | "부분완료" | "완료" | "구현중" | "부분구현" | "구현완료"
            ) {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!(
                        "{}: approve=true인데 status='{}' — 승인 3키 불일치",
                        n.id, n.status
                    ),
                });
            }
            if chrono::NaiveDate::parse_from_str(&n.approved, "%Y-%m-%d").is_err() {
                issues.push(AuditIssue {
                    severity: "warn".into(),
                    path: n.path.clone(),
                    message: format!("{}: approved '{}' — YYYY-MM-DD 아님", n.id, n.approved),
                });
            }
        }
        if !n.legacy {
            let expected_state = if is_closed_status(&n.status) {
                "closed"
            } else {
                "open"
            };
            if n.state != expected_state {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!(
                        "{}: status '{}'이면 state는 '{}'이어야 함",
                        n.id, n.status, expected_state
                    ),
                });
            }
            if is_closed_status(&n.status)
                && chrono::NaiveDate::parse_from_str(&n.closed, "%Y-%m-%d").is_err()
            {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!(
                        "{}: closed '{}' — 완료/취소 이슈는 YYYY-MM-DD 종료일 필요",
                        n.id, n.closed
                    ),
                });
            }
            if !n.milestone.is_empty() && !milestone_ids(vault, &n.project).contains(&n.milestone) {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!("{}: milestone '{}' 문서 없음", n.id, n.milestone),
                });
            }
        }
        for d in n.depends_on.iter().chain(n.dependents.iter()) {
            if !ids.contains(d.as_str()) {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!("{}: 의존성 '{d}' 노트 없음 (dangling)", n.id),
                });
            }
        }
    }

    // 일지 (4)
    let today = chrono::Local::now().date_naive();
    let today_exists = journal_path(vault).is_file();
    if !today_exists {
        issues.push(AuditIssue {
            severity: "error".into(),
            path: String::new(),
            message: "오늘 일지가 없습니다".into(),
        });
    }
    let mut missing = Vec::new();
    for i in 1..=7 {
        let d = today - chrono::Duration::days(i);
        if !vault.join("일지").join(format!("{d}.md")).is_file() {
            missing.push(d.to_string());
        }
    }
    if !missing.is_empty() {
        issues.push(AuditIssue {
            severity: "info".into(),
            path: String::new(),
            message: format!("최근 7일 중 일지 없는 날: {}", missing.join(", ")),
        });
    }

    // Legacy notes remain readable, but their folders/inboxes are not required
    // in a workspace whose work and milestones are owned by the host.

    VaultAudit {
        issues,
        journal: JournalAudit {
            today_exists,
            missing,
        },
        scanned_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }
}

// ---------- journal todos ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub index: usize,
    pub text: String,
    pub checked: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TodoSections {
    pub date: String,
    pub today: Vec<TodoItem>,
    pub tomorrow: Vec<TodoItem>,
    pub file_exists: bool,
}

pub fn journal_path(vault: &Path) -> PathBuf {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    vault.join("일지").join(format!("{date}.md"))
}

fn section_header(section: &str) -> Result<&'static str, String> {
    match section {
        "today" => Ok("## 오늘 할 일"),
        "tomorrow" => Ok("## 내일 할 일"),
        other => Err(format!("알 수 없는 섹션: {other}")),
    }
}

fn parse_todo_line(line: &str) -> Option<(bool, String)> {
    let t = line.trim_start();
    let rest = t.strip_prefix("- [")?;
    let (mark, after) = rest.split_once(']')?;
    let checked = match mark {
        " " => false,
        "x" | "X" => true,
        _ => return None,
    };
    Some((checked, after.trim_start().to_string()))
}

struct SectionItems {
    /// line indices of checkbox items within the section
    item_lines: Vec<(usize, TodoItem)>,
}

fn find_items(lines: &[&str], header: &str) -> SectionItems {
    let mut item_lines = Vec::new();
    let mut in_section = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_end_matches(|c| c == '\n' || c == '\r');
        if t.starts_with("## ") {
            in_section = t == header;
            continue;
        }
        if in_section {
            if let Some((checked, text)) = parse_todo_line(t) {
                item_lines.push((
                    i,
                    TodoItem {
                        index: item_lines.len(),
                        text,
                        checked,
                    },
                ));
            }
        }
    }
    SectionItems { item_lines }
}

fn collect_todos(lines: &[&str], header: &str) -> Vec<TodoItem> {
    find_items(lines, header)
        .item_lines
        .into_iter()
        .map(|(_, item)| item)
        .collect()
}

pub fn list_todos(vault: &Path) -> TodoSections {
    let path = journal_path(vault);
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let exists = path.is_file();
    if !exists {
        return TodoSections {
            date,
            today: vec![],
            tomorrow: vec![],
            file_exists: false,
        };
    }
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    TodoSections {
        date,
        today: collect_todos(&lines, "## 오늘 할 일"),
        tomorrow: collect_todos(&lines, "## 내일 할 일"),
        file_exists: true,
    }
}

/// Toggle one checkbox line. Only the mark char changes; every other byte of the
/// file is preserved ([PRESERVE] contract).
pub fn toggle_todo(vault: &Path, section: &str, index: usize, checked: bool) -> Result<(), String> {
    let header = section_header(section)?;
    let path = journal_path(vault);
    if !path.is_file() {
        return Err("오늘 일지 파일이 없습니다".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("일지 읽기 실패: {e}"))?;
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_string).collect();
    let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
    let items = find_items(&refs, header);
    let Some((line_no, _)) = items
        .item_lines
        .into_iter()
        .find(|(_, item)| item.index == index)
    else {
        return Err("해당 항목을 찾을 수 없습니다".into());
    };
    let line = &mut lines[line_no];
    let (from, to) = if checked {
        ("[ ]", "[x]")
    } else {
        ("[x]", "[ ]")
    };
    if !line.contains(from) {
        // tolerate X uppercase
        if checked || !line.contains("[X]") {
            return Err("체크박스 형식이 아닌 항목입니다".into());
        }
        *line = line.replacen("[X]", "[ ]", 1);
    } else {
        *line = line.replacen(from, to, 1);
    }
    let out: String = lines.concat();
    write_atomic(&path, out.as_bytes()).map_err(|e| format!("일지 저장 실패: {e}"))?;
    Ok(())
}

/// Append `- [ ] <text>` to the section (creates today's journal from the
/// plugin's template shape when missing). Never touches other lines.
pub fn add_todo(vault: &Path, section: &str, text: &str) -> Result<(), String> {
    let header = section_header(section)?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("빈 항목입니다".into());
    }
    let path = journal_path(vault);
    if !path.is_file() {
        let skeleton = journal_skeleton();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("일지 폴더 생성 실패: {e}"))?;
        }
        write_atomic(&path, skeleton.as_bytes()).map_err(|e| format!("일지 생성 실패: {e}"))?;
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("일지 읽기 실패: {e}"))?;
    let mut lines: Vec<String> = content.split_inclusive('\n').map(str::to_string).collect();

    let header_idx = lines
        .iter()
        .position(|l| l.trim_end_matches(|c| c == '\n' || c == '\r') == header)
        .ok_or_else(|| format!("'{header}' 섹션이 일지에 없습니다"))?;

    // insertion point: right after the last checkbox item of the section,
    // or right after the header when the section has none
    let mut insert_at = header_idx + 1;
    let mut in_section = false;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_end_matches(|c| c == '\n' || c == '\r');
        if t.starts_with("## ") {
            if in_section && i > header_idx {
                break;
            }
            in_section = t == header;
            continue;
        }
        if in_section && parse_todo_line(t).is_some() {
            insert_at = i + 1;
        }
        if in_section && i + 1 < lines.len() {
            let next = lines[i + 1].trim_end_matches(|c| c == '\n' || c == '\r');
            if next.starts_with("## ") {
                break;
            }
        }
    }
    lines.insert(insert_at, format!("- [ ] {trimmed}\n"));
    let out: String = lines.concat();
    write_atomic(&path, out.as_bytes()).map_err(|e| format!("일지 저장 실패: {e}"))?;
    Ok(())
}

fn journal_skeleton() -> String {
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    format!(
        r#"---
type: 일지
tags: []
---

## 오늘 할 일

- [ ]

## 업무기록

<!-- sawhorse:auto:start -->
<!-- sawhorse:auto:end -->

## 개념 수집

## 비고

## 내일 할 일

- [ ]
"#
    )
    .replace("{date}", &date)
}

// ---------- vault tree + notes ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultNode {
    pub name: String,
    pub rel: String,
    pub dir: bool,
    pub size: u64,
    pub mtime_ms: u64,
}

const SKIP_DIRS: [&str; 6] = [
    ".obsidian",
    ".git",
    ".trash",
    "첨부",
    "node_modules",
    ".smart-env",
];

pub fn vault_tree(vault: &Path) -> Vec<VaultNode> {
    let mut out = Vec::new();
    walk(vault, vault, &mut out, 0);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<VaultNode>, depth: usize) {
    if depth > 8 || out.len() > 8000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<(bool, String, PathBuf, u64, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if path.is_dir() {
                if SKIP_DIRS.contains(&name.as_str()) {
                    return None;
                }
                Some((true, name, path, 0, 0))
            } else {
                let ext = path.extension()?.to_str()?;
                if ext != "md" && ext != "base" {
                    return None;
                }
                let md = e.metadata().ok()?;
                let mt = mtime_ms(&path);
                Some((false, name, path, md.len(), mt))
            }
        })
        .collect();
    items.sort_by(|a, b| (b.0, &a.1).cmp(&(a.0, &b.1)));
    for (is_dir, name, path, size, mt) in items {
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        out.push(VaultNode {
            name,
            rel: rel.clone(),
            dir: is_dir,
            size,
            mtime_ms: mt,
        });
        if is_dir {
            walk(root, &path, out, depth + 1);
        }
    }
}

/// Read a markdown note inside the vault (path traversal guarded).
pub fn read_vault_note(vault: &Path, rel: &str) -> Result<(String, String), String> {
    if rel.split('/').any(|seg| seg == "..") || rel.starts_with('/') {
        return Err("잘못된 경로입니다".into());
    }
    let path = vault.join(rel);
    let canonical_root = vault
        .canonicalize()
        .map_err(|e| format!("볼트 경로 오류: {e}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("파일 경로 오류: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("볼트 밖 경로입니다".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("파일 읽기 실패: {e}"))?;
    let title = text
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("제목 없음")
                .to_string()
        });
    Ok((title, text))
}

// ---------- embedded note assets (images) ----------

/// Notes embed screenshots; the webview cannot read the filesystem, so images
/// come back as data URLs. Anything larger is a note-authoring mistake.
const ASSET_MAX_BYTES: u64 = 16 * 1024 * 1024;

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// Markdown link destinations arrive percent-encoded (`%20`); Obsidian embeds do not.
fn percent_decode(src: &str) -> String {
    let bytes = src.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| src.to_string())
}

/// Obsidian's "shortest path" embeds carry only the file name, so fall back to a
/// bounded search of the vault (첨부/ included — vault_tree skips it, we must not).
fn find_by_name(dir: &Path, name: &str, depth: usize, budget: &mut u32) -> Option<PathBuf> {
    if depth > 8 || *budget == 0 {
        return None;
    }
    let entries = std::fs::read_dir(dir).ok()?;
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if path.is_dir() {
            if !file_name.starts_with('.') && file_name != "node_modules" {
                dirs.push(path);
            }
        } else if file_name.eq_ignore_ascii_case(name) {
            return Some(path);
        }
    }
    for sub in dirs {
        if let Some(hit) = find_by_name(&sub, name, depth + 1, budget) {
            return Some(hit);
        }
    }
    None
}

/// Resolve an image reference found in `note` the way Obsidian does: relative to
/// the note, then to the vault root, then by file name anywhere in the vault.
pub fn resolve_note_asset(vault: &Path, note: &Path, src: &str) -> Option<PathBuf> {
    let raw = src.split('#').next().unwrap_or(src).trim();
    let raw = raw.trim_start_matches("./");
    if raw.is_empty() {
        return None;
    }
    let decoded = percent_decode(raw);
    let note_dir = note.parent().filter(|p| !p.as_os_str().is_empty());
    let mut candidates: Vec<PathBuf> = Vec::new();
    for form in [raw, decoded.as_str()] {
        let rel = Path::new(form);
        if rel.is_absolute() {
            candidates.push(rel.to_path_buf());
        }
        if let Some(dir) = note_dir {
            candidates.push(dir.join(rel));
        }
        if !vault.as_os_str().is_empty() {
            candidates.push(vault.join(rel));
        }
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let name = Path::new(decoded.as_str())
        .file_name()
        .and_then(|s| s.to_str())?;
    let root = if vault.as_os_str().is_empty() {
        note_dir?
    } else {
        vault
    };
    let mut budget = 20_000u32;
    find_by_name(root, name, 0, &mut budget)
}

/// Read an image embedded in a note and hand it back as a `data:` URL. Reads stay
/// inside the vault (or, for notes outside it, the note's own folder).
pub fn read_note_asset(vault: &Path, note: &Path, src: &str) -> Result<String, String> {
    // Some views address notes by vault-relative path, others by absolute path.
    let note = if note.is_file() || vault.as_os_str().is_empty() {
        note.to_path_buf()
    } else {
        let joined = vault.join(note);
        if joined.is_file() {
            joined
        } else {
            note.to_path_buf()
        }
    };
    let path = resolve_note_asset(vault, &note, src)
        .ok_or_else(|| format!("이미지를 찾지 못했습니다: {src}"))?;
    let mime = image_mime(&path).ok_or_else(|| format!("이미지 형식이 아닙니다: {src}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("이미지 경로 오류: {e}"))?;
    let mut roots: Vec<PathBuf> = Vec::new();
    if !vault.as_os_str().is_empty() {
        if let Ok(root) = vault.canonicalize() {
            roots.push(root);
        }
    }
    if let Some(dir) = note.parent().filter(|p| !p.as_os_str().is_empty()) {
        if let Ok(root) = dir.canonicalize() {
            roots.push(root);
        }
    }
    if !roots.iter().any(|root| canonical.starts_with(root)) {
        return Err("볼트 밖 이미지는 열 수 없습니다".into());
    }
    let size = std::fs::metadata(&canonical)
        .map_err(|e| format!("이미지 정보를 읽지 못했습니다: {e}"))?
        .len();
    if size > ASSET_MAX_BYTES {
        return Err(format!(
            "이미지가 너무 큽니다 ({}MB 초과)",
            ASSET_MAX_BYTES / 1024 / 1024
        ));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| format!("이미지 읽기 실패: {e}"))?;
    Ok(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

// ---------- Obsidian vault detection (first-run wizard helper) ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VaultCandidate {
    pub path: String,
    pub open: bool,
}

/// Parse Obsidian's vault registry JSON: {"vaults": {"<id>": {"path": ..., "open": ...}}}.
fn parse_vault_registry(text: &str) -> Vec<(String, bool)> {
    let Ok(v) = serde_json::from_str::<Json>(text) else {
        return vec![];
    };
    let Some(vaults) = v.get("vaults").and_then(Json::as_object) else {
        return vec![];
    };
    let mut out = Vec::new();
    for entry in vaults.values() {
        let Some(p) = entry.get("path").and_then(Json::as_str) else {
            continue;
        };
        let open = entry.get("open").and_then(Json::as_bool).unwrap_or(false);
        out.push((p.to_string(), open));
    }
    out
}

/// Known vaults from Obsidian's own config, existing dirs first (open first).
pub fn detect_obsidian_vaults() -> Vec<VaultCandidate> {
    let Some(cfg_dir) = dirs::config_dir() else {
        return vec![];
    };
    let registry = cfg_dir.join("obsidian").join("obsidian.json");
    let Ok(text) = std::fs::read_to_string(registry) else {
        return vec![];
    };
    let mut out: Vec<VaultCandidate> = parse_vault_registry(&text)
        .into_iter()
        .filter(|(p, _)| Path::new(p).is_dir())
        .map(|(path, open)| VaultCandidate { path, open })
        .collect();
    out.sort_by(|a, b| b.open.cmp(&a.open));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_vault(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("swdash-vault-{}-{}", tag, uuid::Uuid::new_v4()));
        let improve = root.join("프로젝트").join("FDR").join("개선");
        std::fs::create_dir_all(&improve).unwrap();
        std::fs::create_dir_all(root.join(".obsidian")).unwrap();
        std::fs::create_dir_all(root.join("첨부").join("스크린샷")).unwrap();

        std::fs::write(
            improve.join("FDR-001 검색 버튼 오류.md"),
            "---\ntype: 개선\npriority: 중요\norigin: 사용자 제안\nid: FDR-001\nurl: fdrList.do\ncategory: 버그\nstatus: 승인대기\napprove: false\napproved: \"\"\nbase: \"\"\nbranch: improve/fdr\ncommits: []\nverified: 미확인\ndepends_on: []\ndependents: []\nrelated: []\n---\n\n## 문제상황\n\n검색 버튼이 동작하지 않는다.\n\n## 설계\n\n### 변경 대상\n\n| 파일 | 변경 |\n|---|---|\n| SearchDAO.java | 조건 추가 |\n",
        )
        .unwrap();
        std::fs::write(
            improve.join("FDR-002 페이징 개선.md"),
            "---\nid: FDR-002\nurl: fdrList.do\ncategory: 성능\npriority: 보통\nstatus: 제안\napprove: false\ncommits: []\ndepends_on: [FDR-001]\n---\n\n본문.\n",
        )
        .unwrap();
        std::fs::write(improve.join("개선.md"), "# FDR 개선\n\nMOC 문서다.\n").unwrap();
        std::fs::write(
            improve.join("FDR 문제목록.md"),
            "# FDR 문제목록\n\n![[FDR 개선.base#화면별]]\n\n## 신규 (미승격)\n\n- 목업 버튼 위치가 어색함 (fdrView.do)\n- 엑셀 다운로드 시 인코딩 깨짐\n\n## 승격 이력\n\n- FDR-001 (2026-09-01)\n",
        )
        .unwrap();
        std::fs::write(root.join(".obsidian").join("app.json"), "{}").unwrap();
        root
    }

    /// 이름을 바꾸기 전 만든 볼트는 `사업/` 밖에 없다. 이관하지 않아도 프로젝트
    /// 목록과 이슈 스캔이 그대로 동작해야 한다 — 마이그레이션은 사용자가 고르는
    /// 별도 작업이지 앱 실행의 전제 조건이 아니다.
    #[test]
    fn legacy_business_root_still_lists_projects_and_issues() {
        let root =
            std::env::temp_dir().join(format!("swdash-vault-legacy-{}", uuid::Uuid::new_v4()));
        let issues = root.join("사업").join("FDR").join("이슈");
        std::fs::create_dir_all(&issues).unwrap();
        std::fs::write(
            issues.join("FDR-001 레거시 이슈.md"),
            "---\ntype: 이슈\nid: FDR-001\nstatus: 제안\nstate: open\n---\n\n본문\n",
        )
        .unwrap();

        let pairs = project_pairs(&root, &[]);
        assert_eq!(pairs, vec![("FDR".to_string(), String::new())]);

        let notes = scan_issues(&root, None, &["FDR".to_string()]);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, "FDR-001");

        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 두 루트가 함께 있으면 정본만 읽는다. 이관 도중 같은 이슈가 두 번 나오면
    /// 승인·집계가 전부 어긋나므로 중복이 없다는 것이 이 폴백의 핵심 조건이다.
    #[test]
    fn canonical_project_root_wins_over_legacy_during_migration() {
        let root = std::env::temp_dir().join(format!("swdash-vault-both-{}", uuid::Uuid::new_v4()));
        for target in ["사업", "프로젝트"] {
            let dir = root.join(target).join("FDR").join("이슈");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("FDR-001 같은 이슈.md"),
                "---\ntype: 이슈\nid: FDR-001\nstatus: 제안\nstate: open\n---\n\n본문\n",
            )
            .unwrap();
        }

        assert_eq!(project_pairs(&root, &[]).len(), 1);
        let notes = scan_issues(&root, None, &["FDR".to_string()]);
        assert_eq!(notes.len(), 1, "정본 루트의 이슈 하나만 잡혀야 한다");
        assert!(notes[0].path.contains("프로젝트"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn scan_excludes_non_problem_notes() {
        let vault = fixture_vault("scan");
        let notes = scan_improvements(&vault, None, &["FDR".to_string()]);
        assert_eq!(notes.len(), 2);
        let n1 = notes.iter().find(|n| n.id == "FDR-001").unwrap();
        assert_eq!(n1.title, "검색 버튼 오류");
        assert_eq!(n1.url, "fdrList.do");
        assert_eq!(n1.priority, "중요");
        assert!(!n1.approve);
        assert_eq!(n1.status, "승인대기");
        let n2 = notes.iter().find(|n| n.id == "FDR-002").unwrap();
        assert_eq!(n2.depends_on, vec!["FDR-001"]);
        assert_eq!(n2.title, "페이징 개선");
    }

    #[test]
    fn scan_reads_new_issue_fields_and_marks_legacy_notes() {
        let vault = fixture_vault("issue-scan");
        let issues = vault.join("프로젝트").join("FDR").join("이슈");
        std::fs::create_dir_all(&issues).unwrap();
        std::fs::write(
            issues.join("FDR-003 GitHub 연동 설계.md"),
            "---\ntype: 이슈\nid: FDR-003\nissue_type: 기능\nlabels: [연동, github]\nassignees: [won]\nmilestone: FDR-M1\nstatus: 제안\nstate: open\ngithub_repo: a7garden/sawhorse\ngithub_number: \"42\"\ngithub_url: https://github.com/a7garden/sawhorse/issues/42\n---\n\n## 배경 및 문제\n",
        ).unwrap();

        let notes = scan_issues(&vault, None, &["FDR".to_string()]);
        let issue = notes.iter().find(|n| n.id == "FDR-003").unwrap();
        assert_eq!(issue.issue_type, "기능");
        assert_eq!(issue.labels, vec!["연동", "github"]);
        assert_eq!(issue.milestone, "FDR-M1");
        assert_eq!(issue.github_number, "42");
        assert!(!issue.legacy);
        assert!(notes.iter().find(|n| n.id == "FDR-001").unwrap().legacy);
    }

    #[test]
    fn approve_updates_three_keys_and_preserves_body() {
        let vault = fixture_vault("approve");
        let path = vault
            .join("프로젝트")
            .join("FDR")
            .join("개선")
            .join("FDR-001 검색 버튼 오류.md");
        let before = std::fs::read_to_string(&path).unwrap();
        let body_before = split_frontmatter(&before).unwrap().after_close;

        approve_note(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        let split = split_frontmatter(&after).unwrap();
        assert_eq!(
            split.after_close, body_before,
            "body bytes must be untouched"
        );
        let map = parse_mapping(&split.yaml).unwrap();
        assert_eq!(fm_bool(&map, "approve"), true);
        assert_eq!(
            fm_str(&map, "approved"),
            chrono::Local::now().format("%Y-%m-%d").to_string()
        );
        assert_eq!(fm_str(&map, "id"), "FDR-001");
        assert_eq!(fm_list(&map, "commits").len(), 0);

        // idempotence / gate: second approval and non-대기 status both fail
        assert!(approve_note(&path).is_err());
        let path2 = vault
            .join("프로젝트")
            .join("FDR")
            .join("개선")
            .join("FDR-002 페이징 개선.md");
        assert!(approve_note(&path2).is_err(), "제안 상태는 승인 불가");
    }

    #[test]
    fn approve_requires_design_section() {
        let vault = fixture_vault("nogate");
        let improve = vault.join("프로젝트").join("FDR").join("개선");
        let path = improve.join("FDR-003 설계없음.md");
        std::fs::write(&path, "---\nid: FDR-003\nstatus: 승인대기\napprove: false\n---\n\n## 문제상황\n본문만 있다.\n").unwrap();
        let err = approve_note(&path).unwrap_err();
        assert!(err.contains("실행 대상"), "unexpected: {err}");
    }

    #[test]
    fn inbox_count_counts_new_section_only() {
        let vault = fixture_vault("inbox");
        let n = inbox_count(&vault, &[("FDR".to_string(), "FDR".to_string())], None);
        assert_eq!(n, 2);
    }

    #[test]
    fn list_unpromoted_reads_new_section() {
        let vault = fixture_vault("unpromoted");
        let items = list_unpromoted(&vault, &[("FDR".to_string(), "FDR".to_string())]);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].text, "목업 버튼 위치가 어색함 (fdrView.do)");
        assert_eq!(items[0].project, "FDR");
        assert!(items[0].list_path.ends_with("FDR 문제목록.md"));
    }

    fn audit_write_note(vault: &Path, name: &str, yaml: &str) {
        let p = vault.join("프로젝트").join("FDR").join("개선").join(name);
        std::fs::write(p, format!("---\n{yaml}---\n\n본문.\n")).unwrap();
    }

    #[test]
    fn audit_clean_vault_has_no_issues() {
        let vault = fixture_vault("audit-ok");
        // 오늘 일지 작성 — 없으면 error 이슈 1건 (fixture에 일지/ 디렉터리는 없다)
        std::fs::create_dir_all(vault.join("일지")).unwrap();
        std::fs::write(
            journal_path(&vault),
            "---\ntype: 일지\n---\n\n## 오늘 할 일\n\n- [ ] A\n",
        )
        .unwrap();
        // 최근 7일 일지도 작성 — 없으면 info 이슈가 나온다
        let today = chrono::Local::now().date_naive();
        for i in 1..=7 {
            let d = today - chrono::Duration::days(i);
            std::fs::write(
                vault.join("일지").join(format!("{d}.md")),
                "---\ntype: 일지\n---\n",
            )
            .unwrap();
        }
        let audit = audit_vault(&vault, &[("FDR".to_string(), "FDR".to_string())]);
        assert!(audit.issues.is_empty(), "unexpected: {:?}", audit.issues);
        assert!(audit.journal.today_exists);
    }

    #[test]
    fn audit_flags_bad_status_and_approval_mismatch() {
        let vault = fixture_vault("audit-bad");
        audit_write_note(
            &vault,
            "FDR-003 상태 오타.md",
            "id: FDR-003\nstatus: 전송완료\napprove: false\n",
        );
        audit_write_note(
            &vault,
            "FDR-004 승인 불일치.md",
            "id: FDR-004\nstatus: 승인대기\napprove: true\napproved: 9월1일\n",
        );
        let audit = audit_vault(&vault, &[("FDR".to_string(), "FDR".to_string())]);
        let msgs: Vec<&str> = audit.issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs
            .iter()
            .any(|m| m.contains("FDR-003") && m.contains("허용 집합 밖")));
        assert!(msgs
            .iter()
            .any(|m| m.contains("FDR-004") && m.contains("3키 불일치")));
        assert!(msgs
            .iter()
            .any(|m| m.contains("FDR-004") && m.contains("YYYY-MM-DD")));
    }

    #[test]
    fn audit_flags_dangling_dependency() {
        let vault = fixture_vault("audit-dep");
        audit_write_note(
            &vault,
            "FDR-005 유령 의존.md",
            "id: FDR-005\nstatus: 제안\napprove: false\ndepends_on: [FDR-999]\n",
        );
        let audit = audit_vault(&vault, &[("FDR".to_string(), "FDR".to_string())]);
        assert!(audit.issues.iter().any(|i| i.message.contains("FDR-999")));
    }

    #[test]
    fn audit_checks_new_issue_closing_and_milestone_integrity() {
        let vault = fixture_vault("audit-new-issue");
        let dir = vault.join("프로젝트").join("FDR").join("이슈");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("FDR-101 일반 이슈.md"),
            "---\ntype: 이슈\nid: FDR-101\nstatus: 완료\nstate: open\nclosed: \"\"\nmilestone: FDR-M404\napprove: true\napproved: 2026-09-05\n---\n\n## 설계\n\n### 실행 대상\n\n| 대상 | 실행 내용 |\n|---|---|\n",
        )
        .unwrap();
        let audit = audit_vault(&vault, &[("FDR".to_string(), "FDR".to_string())]);
        let messages: Vec<&str> = audit.issues.iter().map(|i| i.message.as_str()).collect();
        assert!(messages.iter().any(|m| m.contains("state는 'closed'")));
        assert!(messages.iter().any(|m| m.contains("종료일 필요")));
        assert!(messages
            .iter()
            .any(|m| m.contains("FDR-M404") && m.contains("문서 없음")));
    }

    #[test]
    fn calendar_milestones_are_valid_issue_targets() {
        let vault = fixture_vault("calendar-milestone");
        std::fs::create_dir_all(vault.join("calendar")).unwrap();
        std::fs::write(
            vault.join("calendar/event-release.md"),
            "---\nid: event-release\nkind: milestone\ntitle: Release\n---\n",
        )
        .unwrap();
        assert!(milestone_ids(&vault, "FDR").contains("event-release"));
        std::fs::remove_dir_all(vault).unwrap();
    }

    #[test]
    fn audit_does_not_require_retired_issue_folders_or_inboxes() {
        let vault = fixture_vault("audit-list");
        std::fs::create_dir_all(vault.join("프로젝트/ABC/개선")).unwrap();
        let audit = audit_vault(
            &vault,
            &[("ABC".into(), "ABC".into()), ("NEW".into(), "NEW".into())],
        );
        assert!(audit
            .issues
            .iter()
            .all(|issue| !issue.message.contains("폴더 없음")
                && !issue.message.contains("문제목록 없음")));
        std::fs::remove_dir_all(vault).unwrap();
    }

    fn todo_fixture(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("swdash-todo-{tag}-{}", uuid::Uuid::new_v4()));
        let journal = root.join("일지");
        std::fs::create_dir_all(&journal).unwrap();
        std::fs::write(
            journal.join(chrono::Local::now().format("%Y-%m-%d").to_string() + ".md"),
            "---\ntype: 일지\n---\n\n## 오늘 할 일\n\n- [ ] A업무\n- [x] B업무\n주의: 수기 메모\n\n## 업무기록\n\n## 내일 할 일\n\n- [ ] C업무\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn todos_parse_sections() {
        let vault = todo_fixture("parse");
        let t = list_todos(&vault);
        assert!(t.file_exists);
        assert_eq!(t.today.len(), 2);
        assert!(!t.today[0].checked);
        assert_eq!(t.today[0].text, "A업무");
        assert!(t.today[1].checked);
        assert_eq!(t.tomorrow.len(), 1);
        assert_eq!(t.tomorrow[0].text, "C업무");
    }

    #[test]
    fn toggle_changes_only_target_line() {
        let vault = todo_fixture("toggle");
        let path = journal_path(&vault);
        let before = std::fs::read_to_string(&path).unwrap();

        toggle_todo(&vault, "today", 0, true).unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        let b: Vec<&str> = before.lines().collect();
        let a: Vec<&str> = after.lines().collect();
        assert_eq!(b.len(), a.len());
        let diffs: Vec<usize> = b
            .iter()
            .zip(a.iter())
            .enumerate()
            .filter_map(|(i, (x, y))| (x != y).then_some(i))
            .collect();
        assert_eq!(diffs.len(), 1, "only one line may change");
        assert!(a[diffs[0]].contains("- [x] A업무"));

        // toggle back
        toggle_todo(&vault, "today", 0, false).unwrap();
        let reverted = std::fs::read_to_string(&path).unwrap();
        assert_eq!(reverted, before, "toggle must be reversible byte-for-byte");
    }

    #[test]
    fn add_appends_to_section_and_creates_skeleton() {
        let vault = todo_fixture("add");
        add_todo(&vault, "today", "D업무").unwrap();
        let t = list_todos(&vault);
        assert_eq!(t.today.len(), 3);
        assert_eq!(t.today[2].text, "D업무");
        assert!(!t.today[2].checked);

        // adding to tomorrow must not move today's items
        add_todo(&vault, "tomorrow", "E업무").unwrap();
        let t = list_todos(&vault);
        assert_eq!(t.tomorrow.len(), 2);
        assert_eq!(t.today.len(), 3);

        // skeleton creation when the journal does not exist
        let fresh = std::env::temp_dir().join(format!("swdash-fresh-{}", uuid::Uuid::new_v4()));
        add_todo(&fresh, "today", "첫 항목").unwrap();
        let t = list_todos(&fresh);
        assert!(t.file_exists);
        assert_eq!(t.today.len(), 2, "skeleton placeholder + new item");
        assert_eq!(t.today[1].text, "첫 항목");
        let text = std::fs::read_to_string(journal_path(&fresh)).unwrap();
        assert!(
            text.contains("sawhorse:auto:start"),
            "skeleton must keep auto markers"
        );
    }

    #[test]
    fn vault_tree_skips_hidden_and_attachments() {
        let vault = fixture_vault("tree");
        let nodes = vault_tree(&vault);
        let rels: Vec<&str> = nodes.iter().map(|n| n.rel.as_str()).collect();
        assert!(rels.iter().any(|r| r.contains("FDR-001")), "{rels:?}");
        assert!(rels.iter().all(|r| !r.contains(".obsidian")));
        assert!(rels.iter().all(|r| !r.starts_with("첨부")));
    }

    #[test]
    fn read_note_splits_frontmatter() {
        let vault = fixture_vault("read");
        let path = vault
            .join("프로젝트")
            .join("FDR")
            .join("개선")
            .join("FDR-001 검색 버튼 오류.md");
        let (fm, body) = read_note(&path).unwrap();
        assert_eq!(fm["id"], "FDR-001");
        assert!(body.contains("## 문제상황"));
        assert!(!body.starts_with("---"));
    }

    #[test]
    fn note_asset_resolves_relative_and_shortest_path() {
        let vault = fixture_vault("asset");
        let note = vault
            .join("프로젝트")
            .join("FDR")
            .join("개선")
            .join("FDR-001 검색 버튼 오류.md");
        let png = [0x89u8, b'P', b'N', b'G'];
        std::fs::write(
            vault.join("첨부").join("스크린샷").join("검색 오류.png"),
            png,
        )
        .unwrap();
        std::fs::write(note.parent().unwrap().join("옆.png"), png).unwrap();

        // note-relative, vault-relative, and Obsidian shortest-path (file name only)
        assert!(resolve_note_asset(&vault, &note, "옆.png").is_some());
        assert!(resolve_note_asset(&vault, &note, "첨부/스크린샷/검색 오류.png").is_some());
        assert!(resolve_note_asset(&vault, &note, "검색 오류.png").is_some());
        // markdown links arrive percent-encoded
        assert!(resolve_note_asset(&vault, &note, "%EC%98%86.png").is_some());
        assert!(resolve_note_asset(&vault, &note, "없는파일.png").is_none());

        let url = read_note_asset(&vault, &note, "옆.png").unwrap();
        assert!(url.starts_with("data:image/png;base64,"));
        // non-images and traversal stay closed
        assert!(read_note_asset(&vault, &note, "개선.md").is_err());
        assert!(read_note_asset(&vault, &note, "../../../../outside.png").is_err());
        std::fs::remove_dir_all(&vault).ok();
    }

    #[test]
    fn read_vault_note_rejects_traversal() {
        let vault = fixture_vault("trav");
        assert!(read_vault_note(&vault, "../outside.md").is_err());
        assert!(read_vault_note(&vault, "/etc/passwd").is_err());
    }
    #[test]
    fn parse_vault_registry_shapes() {
        let parsed = parse_vault_registry(
            r#"{"vaults":{"a1":{"path":"/v/main","ts":1,"open":true},"a2":{"path":"/v/old","ts":2}}}"#,
        );
        assert_eq!(parsed.len(), 2);
        assert!(parsed.iter().any(|(p, o)| p == "/v/main" && *o));
        assert!(parsed.iter().any(|(p, o)| p == "/v/old" && !o));
        assert!(parse_vault_registry("not json").is_empty());
        assert!(parse_vault_registry(r#"{"vaults":{}}"#).is_empty());
        assert!(parse_vault_registry(r#"{"other":1}"#).is_empty());
    }
}
