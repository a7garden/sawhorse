//! A date-independent task list, with live projections of existing journal checklists.
//! All task content stays in the vault as Markdown. Revisions prevent stale row edits.
use chrono::{Days, NaiveDate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const FILE: &str = "할 일.md";
const META: &str = " <!-- sawhorse-todo:";
static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: String,
    pub text: String,
    pub checked: bool,
    pub due_date: Option<String>,
    pub priority: String,
    pub source: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Metadata {
    due_date: Option<String>,
    #[serde(default = "normal")]
    priority: String,
    #[serde(default)]
    deleted: bool,
}
fn normal() -> String {
    "normal".into()
}

struct Row {
    todo: Todo,
    path: PathBuf,
    line: usize,
    content: std::sync::Arc<String>,
}

fn read_rows(vault: &Path) -> Result<Vec<Row>, String> {
    let mut files = vec![(vault.join(FILE), None)];
    let journal = vault.join("일지");
    if journal.exists() {
        for entry in std::fs::read_dir(&journal).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            if let Some(date) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
            {
                files.push((path, Some(date)));
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut rows = vec![];
    for (path, date) in files {
        if !path.exists() {
            continue;
        }
        let root = vault.canonicalize().map_err(|e| e.to_string())?;
        if !path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .starts_with(&root)
        {
            return Err("할 일 파일이 볼트 밖을 가리킵니다".into());
        }
        let content = std::sync::Arc::new(
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?,
        );
        let source = path
            .strip_prefix(vault)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .to_string();
        let mut active = date.is_none();
        let mut due = date;
        let mut fence: Option<char> = None;
        for (line, raw) in content.split_inclusive('\n').enumerate() {
            let t = raw.trim();
            if t.starts_with("```") || t.starts_with("~~~") {
                let marker = t.chars().next().unwrap();
                if fence == Some(marker) {
                    fence = None;
                } else if fence.is_none() {
                    fence = Some(marker);
                }
                continue;
            }
            if fence.is_some() {
                continue;
            }
            if date.is_some() && t.starts_with("# ") {
                active = false;
            }
            if date.is_some() && t.starts_with("## ") {
                active = matches!(t, "## 오늘 할 일" | "## 내일 할 일");
                due = if t == "## 내일 할 일" {
                    date.and_then(|d| d.checked_add_days(Days::new(1)))
                } else {
                    date
                };
                continue;
            }
            if !active {
                continue;
            }
            let Some(after) = t.strip_prefix("- [") else {
                continue;
            };
            let Some((mark, body)) = after.split_once(']') else {
                continue;
            };
            if !matches!(mark, " " | "x" | "X") {
                continue;
            }
            let (text, metadata) = if let Some((text, json)) = body.trim_start().rsplit_once(META) {
                let metadata: Metadata =
                    serde_json::from_str(json.strip_suffix(" -->").ok_or("할 일 메타데이터 오류")?)
                        .map_err(|e| e.to_string())?;
                (text.to_string(), metadata)
            } else {
                (
                    body.trim().to_string(),
                    Metadata {
                        due_date: due.map(|d| d.to_string()),
                        priority: normal(),
                        deleted: false,
                    },
                )
            };
            if metadata.deleted || text.trim().is_empty() {
                continue;
            }
            if let Some(ref date) = metadata.due_date {
                if NaiveDate::parse_from_str(date, "%Y-%m-%d")
                    .map(|d| d.to_string())
                    .ok()
                    .as_ref()
                    != Some(date)
                {
                    return Err(format!("{source}: 잘못된 할 일 마감일 {date}"));
                }
            }
            if !matches!(metadata.priority.as_str(), "high" | "normal" | "low") {
                return Err(format!("{source}: 잘못된 할 일 우선순위"));
            }
            let revision = hex::encode(Sha256::digest(raw.as_bytes()));
            rows.push(Row {
                todo: Todo {
                    id: format!("{source}:{line}:{revision}"),
                    text,
                    checked: mark != " ",
                    due_date: metadata.due_date,
                    priority: metadata.priority,
                    source: source.clone(),
                },
                path: path.clone(),
                line,
                content: content.clone(),
            });
        }
    }
    Ok(rows)
}

pub fn list(vault: &Path) -> Result<Vec<Todo>, String> {
    let _guard = LOCK.lock();
    Ok(read_rows(vault)?.into_iter().map(|r| r.todo).collect())
}

pub fn save(
    vault: &Path,
    id: Option<String>,
    text: String,
    checked: bool,
    due_date: Option<String>,
    priority: String,
    deleted: bool,
) -> Result<(), String> {
    let _guard = LOCK.lock();
    let text = text.trim();
    if text.is_empty()
        || text.len() > 4000
        || text.contains(['\n', '\r'])
        || text.contains(META.trim())
    {
        return Err("할 일은 1~4000바이트의 한 줄로 입력하세요".into());
    }
    if !matches!(priority.as_str(), "high" | "normal" | "low") {
        return Err("잘못된 우선순위입니다".into());
    }
    if let Some(ref date) = due_date {
        if NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map(|d| d.to_string())
            .ok()
            .as_ref()
            != Some(date)
        {
            return Err("날짜는 YYYY-MM-DD 형식이어야 합니다".into());
        }
    }
    let metadata = serde_json::to_string(&Metadata {
        due_date,
        priority,
        deleted,
    })
    .map_err(|e| e.to_string())?;
    let new_line = format!(
        "- [{}] {text}{META}{metadata} -->",
        if checked { "x" } else { " " }
    );
    if let Some(id) = id {
        let row = read_rows(vault)?
            .into_iter()
            .find(|r| r.todo.id == id)
            .ok_or("할 일이 변경되었습니다. 새로고침한 뒤 다시 시도하세요.")?;
        let mut lines: Vec<String> = row
            .content
            .split_inclusive('\n')
            .map(str::to_string)
            .collect();
        let old = &lines[row.line];
        let indent = &old[..old.len() - old.trim_start().len()];
        let ending = if old.ends_with("\r\n") {
            "\r\n"
        } else if old.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        lines[row.line] = format!("{indent}{new_line}{ending}");
        // Catch edits by external editors between scanning and writing.
        if std::fs::read_to_string(&row.path).map_err(|e| e.to_string())? != *row.content {
            return Err("파일이 변경되었습니다. 새로고침한 뒤 다시 시도하세요.".into());
        }
        crate::config::write_atomic(&row.path, lines.concat().as_bytes()).map_err(|e| e.to_string())
    } else {
        if deleted {
            return Err("새 할 일은 삭제 상태로 만들 수 없습니다".into());
        }
        let path = vault.join(FILE);
        if path.exists()
            && !path
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(vault.canonicalize().map_err(|e| e.to_string())?)
        {
            return Err("할 일 파일이 볼트 밖을 가리킵니다".into());
        }
        let mut content = if path.exists() {
            std::fs::read_to_string(&path).map_err(|e| e.to_string())?
        } else {
            "# 할 일\n\n".into()
        };
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&new_line);
        content.push('\n');
        std::fs::create_dir_all(vault).map_err(|e| e.to_string())?;
        crate::config::write_atomic(&path, content.as_bytes()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_history_dates_and_preservation() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("일지")).unwrap();
        let path = vault.path().join("일지/2025-12-31.md");
        let content = "# 일지\r\n## 오늘 할 일\r\n- [ ] 지난 업무\r\n## 내일 할 일\r\n- [x] 새해 업무\r\n## 메모\r\n- [ ] 그대로\r\n";
        std::fs::write(&path, content).unwrap();
        let rows = list(vault.path()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1].due_date.as_deref(), Some("2026-01-01"));
        save(
            vault.path(),
            Some(rows[0].id.clone()),
            "일정 변경".into(),
            true,
            None,
            "high".into(),
            false,
        )
        .unwrap();
        let output = std::fs::read_to_string(&path).unwrap();
        assert!(output.starts_with("# 일지\r\n## 오늘 할 일\r\n- [x] 일정 변경"));
        assert!(output.ends_with("## 내일 할 일\r\n- [x] 새해 업무\r\n## 메모\r\n- [ ] 그대로\r\n"));
        assert_eq!(list(vault.path()).unwrap()[0].due_date, None);
        assert!(save(
            vault.path(),
            Some(rows[0].id.clone()),
            "stale".into(),
            false,
            None,
            normal(),
            false
        )
        .is_err());
    }
    #[test]
    fn independent_tasks_crud_validation_and_external_edits() {
        let vault = tempfile::tempdir().unwrap();
        save(
            vault.path(),
            None,
            "언젠가".into(),
            false,
            None,
            normal(),
            false,
        )
        .unwrap();
        save(
            vault.path(),
            None,
            "장기 계획".into(),
            false,
            Some("2027-05-30".into()),
            "high".into(),
            false,
        )
        .unwrap();
        let rows = list(vault.path()).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].due_date, None);
        save(
            vault.path(),
            Some(rows[0].id.clone()),
            rows[0].text.clone(),
            false,
            None,
            normal(),
            true,
        )
        .unwrap();
        assert_eq!(list(vault.path()).unwrap().len(), 1);
        assert!(std::fs::read_to_string(vault.path().join(FILE))
            .unwrap()
            .contains("언젠가"));
        assert!(save(
            vault.path(),
            None,
            "bad\n- [ ] injected".into(),
            false,
            None,
            normal(),
            false
        )
        .is_err());
        assert!(save(
            vault.path(),
            None,
            "bad".into(),
            false,
            Some("2026-02-30".into()),
            normal(),
            false
        )
        .is_err());
        let before = std::fs::read_to_string(vault.path().join(FILE)).unwrap();
        std::fs::write(vault.path().join(FILE), format!("\n{before}")).unwrap();
        assert!(save(
            vault.path(),
            Some(rows[1].id.clone()),
            "stale".into(),
            true,
            None,
            normal(),
            false
        )
        .is_err());
    }
    #[test]
    fn legacy_widget_hides_metadata_and_deleted_rows() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("일지")).unwrap();
        let path = crate::vault::journal_path(vault.path());
        std::fs::write(
            path,
            "## 오늘 할 일\n- [ ] \n- [ ] 업무\n```md\n- [ ] 예제\n```\n",
        )
        .unwrap();
        let rows = list(vault.path()).unwrap();
        assert_eq!(rows.len(), 1);
        save(
            vault.path(),
            Some(rows[0].id.clone()),
            "수정한 업무".into(),
            true,
            None,
            "high".into(),
            false,
        )
        .unwrap();
        let legacy = crate::vault::list_todos(vault.path());
        assert_eq!(legacy.today[1].text, "수정한 업무");
        assert!(legacy.today[1].checked);
        let row = list(vault.path()).unwrap().remove(0);
        save(
            vault.path(),
            Some(row.id),
            row.text,
            true,
            None,
            normal(),
            true,
        )
        .unwrap();
        assert!(list(vault.path()).unwrap().is_empty());
        assert!(!crate::vault::list_todos(vault.path())
            .today
            .iter()
            .any(|item| item.text == "수정한 업무"));
    }
}
