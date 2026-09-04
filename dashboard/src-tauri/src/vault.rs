// Vault access: improvement-note frontmatter scan/approval, journal todos,
// vault tree + note reading. Writes are limited to: approval 3-key update and
// todo checkbox toggles/additions. Everything else is read-only.

use std::path::{Path, PathBuf};

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
    map.get(Yaml::from(key)).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn fm_list(map: &Mapping, key: &str) -> Vec<String> {
    map.get(Yaml::from(key))
        .and_then(|v| v.as_sequence())
        .map(|seq| {
            seq.iter()
                .map(|v| match v {
                    Yaml::String(s) => s.clone(),
                    other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn yaml_to_json(v: &Yaml) -> Json {
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
                    other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
                };
                out.insert(key, yaml_to_json(val));
            }
            Json::Object(out)
        }
        Yaml::Tagged(tagged) => yaml_to_json(&tagged.value),
    }
}

fn mtime_ms(path: &Path) -> u64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- improvement notes ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImprovementNote {
    pub project: String,
    pub path: String,
    pub id: String,
    pub title: String,
    pub url: String,
    pub category: String,
    pub priority: String,
    pub status: String,
    pub approve: bool,
    pub approved: String,
    pub verified: String,
    pub depends_on: Vec<String>,
    pub dependents: Vec<String>,
    pub commits: Vec<String>,
    pub mtime_ms: u64,
}

fn is_problem_note(file_name: &str) -> bool {
    // 문제 노트만. MOC(개선.md), 인박스(*문제목록.md), 뷰(*.base)는 제외.
    file_name.ends_with(".md")
        && file_name != "개선.md"
        && !file_name.ends_with("문제목록.md")
}

fn note_from_file(project: &str, path: &Path, map: &Mapping) -> ImprovementNote {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
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
        priority: fm_str(map, "priority"),
        status: fm_str(map, "status"),
        approve: fm_bool(map, "approve"),
        approved: fm_str(map, "approved"),
        verified: fm_str(map, "verified"),
        depends_on: fm_list(map, "depends_on"),
        dependents: fm_list(map, "dependents"),
        commits: fm_list(map, "commits"),
        mtime_ms: mtime_ms(path),
    }
}

/// Scan improvement notes (frontmatter only) under <vault>/사업/<사업명>/개선/.
pub fn scan_improvements(vault: &Path, project_filter: Option<&str>, projects: &[String]) -> Vec<ImprovementNote> {
    let mut out = Vec::new();
    for project in projects {
        if let Some(f) = project_filter {
            if f != project {
                continue;
            }
        }
        let dir = vault.join("사업").join(project).join("개선");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            if !is_problem_note(name) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Some(split) = split_frontmatter(&text) else { continue };
            let Ok(map) = parse_mapping(&split.yaml) else { continue };
            out.push(note_from_file(project, &path, &map));
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

/// Human approval. Same write the vault checkbox performs: approve→true,
/// approved→today, status→승인. Preconditions guard against skill-side misuse.
pub fn approve_note(path: &Path) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("노트 읽기 실패: {e}"))?;
    let split = split_frontmatter(&text).ok_or("frontmatter가 없는 노트입니다")?;
    let mut map = parse_mapping(&split.yaml)?;

    if fm_bool(&map, "approve") {
        return Err("이미 승인된 문제입니다".into());
    }
    let status = fm_str(&map, "status");
    if status != "승인대기" {
        return Err(format!("승인대기 상태가 아닙니다 (현재: {status})"));
    }
    // 변경 대상 게이트: 설계 없이 체크만 켜진 건은 승인 무효 (improve 스킬 불변식 4번과 동일)
    let body = &split.after_close;
    if !body.contains("### 변경 대상") {
        return Err("설계서에 '### 변경 대상' 절이 없어 승인할 수 없습니다".into());
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    map.insert(Yaml::from("approve"), Yaml::from(true));
    map.insert(Yaml::from("approved"), Yaml::from(today));
    map.insert(Yaml::from("status"), Yaml::from("승인"));

    let new_yaml = serde_yaml::to_string(&map).map_err(|e| format!("frontmatter 직렬화 실패: {e}"))?;
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
            other => serde_yaml::to_string(other).unwrap_or_default().trim().to_string(),
        };
        obj.insert(key, yaml_to_json(v));
    }
    Ok((Json::Object(obj), split.after_close))
}

/// Count unpromoted items in `<idPrefix> 문제목록.md` (## 신규 (미승격) section).
pub fn inbox_count(vault: &Path, projects: &[(String, String)], filter: Option<&str>) -> u64 {
    let mut total = 0;
    for (name, id_prefix) in projects {
        if let Some(f) = filter {
            if f != name {
                continue;
            }
        }
        let dir = vault.join("사업").join(name).join("개선");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let matches = if id_prefix.is_empty() {
                fname.ends_with("문제목록.md")
            } else {
                fname == &format!("{id_prefix} 문제목록.md")
            };
            if !matches {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            total += section_items(&text, "## 신규 (미승격)").len() as u64;
        }
    }
    total
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

/// List unpromoted items (`## 신규 (미승격)`) from each project's 문제목록.md.
pub fn list_unpromoted(vault: &Path, projects: &[(String, String)]) -> Vec<UnpromotedItem> {
    let mut out = Vec::new();
    for (name, id_prefix) in projects {
        let dir = vault.join("사업").join(name).join("개선");
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(fname) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let matches = if id_prefix.is_empty() {
                fname.ends_with("문제목록.md")
            } else {
                fname == &format!("{id_prefix} 문제목록.md")
            };
            if !matches {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            for item in section_items(&text, "## 신규 (미승격)") {
                out.push(UnpromotedItem {
                    project: name.clone(),
                    id_prefix: id_prefix.clone(),
                    text: item,
                    list_path: path.to_string_lossy().to_string(),
                });
            }
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

/// skills/improve/SKILL.md frontmatter 어휘 (2026-09 기준)
const STATUS_SET: [&str; 8] =
    ["제안", "승인대기", "승인", "구현중", "부분구현", "구현완료", "보류", "반려"];

pub fn audit_vault(vault: &Path, projects: &[String]) -> VaultAudit {
    let mut issues = Vec::new();

    // 개선 노트 규칙 (1: status 어휘, 2: 승인 3키, 3: dangling 의존성)
    let notes = scan_improvements(vault, None, projects);
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
            if n.status != "승인" {
                issues.push(AuditIssue {
                    severity: "error".into(),
                    path: n.path.clone(),
                    message: format!("{}: approve=true인데 status='{}' — 승인 3키 불일치", n.id, n.status),
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

    // 구조 (5)
    for project in projects {
        let dir = vault.join("사업").join(project).join("개선");
        if !dir.is_dir() {
            issues.push(AuditIssue {
                severity: "info".into(),
                path: dir.to_string_lossy().to_string(),
                message: format!("'{project}' 개선 폴더 없음 (init-vault 기준 구조)"),
            });
        }
    }

    VaultAudit {
        issues,
        journal: JournalAudit { today_exists, missing },
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
                    TodoItem { index: item_lines.len(), text, checked },
                ));
            }
        }
    }
    SectionItems { item_lines }
}

fn collect_todos(lines: &[&str], header: &str) -> Vec<TodoItem> {
    find_items(lines, header).item_lines.into_iter().map(|(_, item)| item).collect()
}

pub fn list_todos(vault: &Path) -> TodoSections {
    let path = journal_path(vault);
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let exists = path.is_file();
    if !exists {
        return TodoSections { date, today: vec![], tomorrow: vec![], file_exists: false };
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
    let Some((line_no, _)) = items.item_lines.into_iter().find(|(_, item)| item.index == index) else {
        return Err("해당 항목을 찾을 수 없습니다".into());
    };
    let line = &mut lines[line_no];
    let (from, to) = if checked { ("[ ]", "[x]") } else { ("[x]", "[ ]") };
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

<!-- si-workbench:auto:start -->
<!-- si-workbench:auto:end -->

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

const SKIP_DIRS: [&str; 6] = [".obsidian", ".git", ".trash", "첨부", "node_modules", ".smart-env"];

pub fn vault_tree(vault: &Path) -> Vec<VaultNode> {
    let mut out = Vec::new();
    walk(vault, vault, &mut out, 0);
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<VaultNode>, depth: usize) {
    if depth > 8 || out.len() > 8000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
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
        out.push(VaultNode { name, rel: rel.clone(), dir: is_dir, size, mtime_ms: mt });
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
    let canonical_root = vault.canonicalize().map_err(|e| format!("볼트 경로 오류: {e}"))?;
    let canonical = path.canonicalize().map_err(|e| format!("파일 경로 오류: {e}"))?;
    if !canonical.starts_with(&canonical_root) {
        return Err("볼트 밖 경로입니다".into());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("파일 읽기 실패: {e}"))?;
    let title = text
        .lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::to_string)
        .unwrap_or_else(|| {
            path.file_stem().and_then(|s| s.to_str()).unwrap_or("제목 없음").to_string()
        });
    Ok((title, text))
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
    let Ok(v) = serde_json::from_str::<Json>(text) else { return vec![] };
    let Some(vaults) = v.get("vaults").and_then(Json::as_object) else { return vec![] };
    let mut out = Vec::new();
    for entry in vaults.values() {
        let Some(p) = entry.get("path").and_then(Json::as_str) else { continue };
        let open = entry.get("open").and_then(Json::as_bool).unwrap_or(false);
        out.push((p.to_string(), open));
    }
    out
}

/// Known vaults from Obsidian's own config, existing dirs first (open first).
pub fn detect_obsidian_vaults() -> Vec<VaultCandidate> {
    let Some(cfg_dir) = dirs::config_dir() else { return vec![] };
    let registry = cfg_dir.join("obsidian").join("obsidian.json");
    let Ok(text) = std::fs::read_to_string(registry) else { return vec![] };
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
        let root = std::env::temp_dir().join(format!("swdash-vault-{}-{}", tag, uuid::Uuid::new_v4()));
        let improve = root.join("사업").join("FDR").join("개선");
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
        std::fs::write(
            improve.join("개선.md"),
            "# FDR 개선\n\nMOC 문서다.\n",
        )
        .unwrap();
        std::fs::write(
            improve.join("FDR 문제목록.md"),
            "# FDR 문제목록\n\n![[FDR 개선.base#화면별]]\n\n## 신규 (미승격)\n\n- 목업 버튼 위치가 어색함 (fdrView.do)\n- 엑셀 다운로드 시 인코딩 깨짐\n\n## 승격 이력\n\n- FDR-001 (2026-09-01)\n",
        )
        .unwrap();
        std::fs::write(root.join(".obsidian").join("app.json"), "{}").unwrap();
        root
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
    fn approve_updates_three_keys_and_preserves_body() {
        let vault = fixture_vault("approve");
        let path = vault.join("사업").join("FDR").join("개선").join("FDR-001 검색 버튼 오류.md");
        let before = std::fs::read_to_string(&path).unwrap();
        let body_before = split_frontmatter(&before).unwrap().after_close;

        approve_note(&path).unwrap();

        let after = std::fs::read_to_string(&path).unwrap();
        let split = split_frontmatter(&after).unwrap();
        assert_eq!(split.after_close, body_before, "body bytes must be untouched");
        let map = parse_mapping(&split.yaml).unwrap();
        assert_eq!(fm_bool(&map, "approve"), true);
        assert_eq!(fm_str(&map, "approved"), chrono::Local::now().format("%Y-%m-%d").to_string());
        assert_eq!(fm_str(&map, "id"), "FDR-001");
        assert_eq!(fm_list(&map, "commits").len(), 0);

        // idempotence / gate: second approval and non-대기 status both fail
        assert!(approve_note(&path).is_err());
        let path2 = vault.join("사업").join("FDR").join("개선").join("FDR-002 페이징 개선.md");
        assert!(approve_note(&path2).is_err(), "제안 상태는 승인 불가");
    }

    #[test]
    fn approve_requires_design_section() {
        let vault = fixture_vault("nogate");
        let improve = vault.join("사업").join("FDR").join("개선");
        let path = improve.join("FDR-003 설계없음.md");
        std::fs::write(&path, "---\nid: FDR-003\nstatus: 승인대기\napprove: false\n---\n\n## 문제상황\n본문만 있다.\n").unwrap();
        let err = approve_note(&path).unwrap_err();
        assert!(err.contains("변경 대상"), "unexpected: {err}");
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
        let p = vault.join("사업").join("FDR").join("개선").join(name);
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
            std::fs::write(vault.join("일지").join(format!("{d}.md")), "---\ntype: 일지\n---\n").unwrap();
        }
        let audit = audit_vault(&vault, &["FDR".to_string()]);
        assert!(audit.issues.is_empty(), "unexpected: {:?}", audit.issues);
        assert!(audit.journal.today_exists);
    }

    #[test]
    fn audit_flags_bad_status_and_approval_mismatch() {
        let vault = fixture_vault("audit-bad");
        audit_write_note(&vault, "FDR-003 상태 오타.md", "id: FDR-003\nstatus: 완료\napprove: false\n");
        audit_write_note(&vault, "FDR-004 승인 불일치.md", "id: FDR-004\nstatus: 승인대기\napprove: true\napproved: 9월1일\n");
        let audit = audit_vault(&vault, &["FDR".to_string()]);
        let msgs: Vec<&str> = audit.issues.iter().map(|i| i.message.as_str()).collect();
        assert!(msgs.iter().any(|m| m.contains("FDR-003") && m.contains("허용 집합 밖")));
        assert!(msgs.iter().any(|m| m.contains("FDR-004") && m.contains("3키 불일치")));
        assert!(msgs.iter().any(|m| m.contains("FDR-004") && m.contains("YYYY-MM-DD")));
    }

    #[test]
    fn audit_flags_dangling_dependency() {
        let vault = fixture_vault("audit-dep");
        audit_write_note(&vault, "FDR-005 유령 의존.md", "id: FDR-005\nstatus: 제안\napprove: false\ndepends_on: [FDR-999]\n");
        let audit = audit_vault(&vault, &["FDR".to_string()]);
        assert!(audit.issues.iter().any(|i| i.message.contains("FDR-999")));
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
        let diffs: Vec<usize> = b.iter().zip(a.iter()).enumerate().filter_map(|(i, (x, y))| (x != y).then_some(i)).collect();
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
        assert!(text.contains("si-workbench:auto:start"), "skeleton must keep auto markers");
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
        let path = vault.join("사업").join("FDR").join("개선").join("FDR-001 검색 버튼 오류.md");
        let (fm, body) = read_note(&path).unwrap();
        assert_eq!(fm["id"], "FDR-001");
        assert!(body.contains("## 문제상황"));
        assert!(!body.starts_with("---"));
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
