// notes.rs — 선언형 노트 질의 엔진. 팩의 뷰가 쓰는 유일한 데이터 소스.
//
// 호스트는 필드의 **의미를 모른다**. 프론트매터를 그대로 실어 보내고, 무엇을 어떤 라벨로
// 보여줄지는 뷰가 정한다. 이 무지가 팩 아키텍처의 조건이다 — 호스트가 `status` 나 `프로젝트` 를
// 알기 시작하면 그 순간 다시 SI 전용 앱이 된다.
//
// 글로브는 `*` 한 단계만 지원한다. `**` 를 허용하면 큰 볼트에서 UI 가 멈추고, 그 비용을
// 팩 저자가 예측할 수 없다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::vault::{mtime_ms, split_frontmatter, yaml_to_json};

const MAX_ROWS: usize = 2000;

// ---------- 질의 ----------

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Predicate {
    pub field: String,
    /// eq | ne | in | contains | exists | truthy | notEmpty
    #[serde(default = "default_op")]
    pub op: String,
    pub value: Value,
}

fn default_op() -> String {
    "eq".into()
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Sort {
    pub field: String,
    /// "" | "title" | "mtime"
    pub source: String,
    pub desc: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct NoteQuery {
    /// 작업공간 기준 폴더 글로브. 예: "일지", "프로젝트/*/이슈"
    pub folders: Vec<String>,
    /// 제외할 파일명 글로브. 예: "*목록.md"
    pub exclude: Vec<String>,
    #[serde(rename = "where")]
    pub predicates: Vec<Predicate>,
    pub sort: Option<Sort>,
    pub limit: Option<usize>,
}

impl NoteQuery {
    pub fn is_empty(&self) -> bool {
        self.folders.is_empty()
    }
}

// ---------- 결과 ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    /// 절대 경로 (노트 열기·승인에 쓴다)
    pub path: String,
    /// 작업공간 기준 상대 경로
    pub rel: String,
    /// `# 제목` 첫 헤딩, 없으면 파일명
    pub title: String,
    pub mtime_ms: u64,
    /// 프론트매터 원본
    pub fields: Map<String, Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub rows: Vec<NoteRow>,
    /// 실제로 걸린 폴더들 (뷰가 "폴더가 아직 없습니다" 를 구분하기 위해)
    pub folders: Vec<String>,
    pub truncated: bool,
}

// ---------- 글로브 ----------

/// `*` 는 세그먼트 안에서만 임의 문자열. `/` 는 넘지 않는다.
pub fn wildcard_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    // 첫 조각은 접두사로 고정
    if let Some(first) = parts.first() {
        if !rest.starts_with(first) {
            return false;
        }
        rest = &rest[first.len()..];
    }
    // 마지막 조각은 접미사로 고정
    let last = parts[parts.len() - 1];
    let middles = &parts[1..parts.len() - 1];
    for m in middles {
        if m.is_empty() {
            continue;
        }
        match rest.find(m) {
            Some(i) => rest = &rest[i + m.len()..],
            None => return false,
        }
    }
    rest.len() >= last.len() && rest.ends_with(last)
}

/// 패턴을 작업공간 아래 실제 디렉터리 목록으로 펼친다.
fn expand_folders(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let pattern = pattern.trim().trim_matches('/');
    if pattern.is_empty() {
        return vec![root.to_path_buf()];
    }
    let mut current = vec![root.to_path_buf()];
    for seg in pattern.split('/') {
        if seg == "." || seg == ".." {
            return Vec::new(); // 작업공간 탈출 시도는 조용히 빈 결과
        }
        let mut next = Vec::new();
        for dir in &current {
            if seg.contains('*') {
                let Ok(rd) = std::fs::read_dir(dir) else {
                    continue;
                };
                let mut hits: Vec<PathBuf> = rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_dir()
                            && p.file_name()
                                .and_then(|n| n.to_str())
                                .is_some_and(|n| wildcard_match(seg, n))
                    })
                    .collect();
                hits.sort();
                next.extend(hits);
            } else {
                let p = dir.join(seg);
                if p.is_dir() {
                    next.push(p);
                }
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

// ---------- 술어 ----------

fn as_strings(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect(),
        Value::Null => vec![],
        other => vec![other.to_string()],
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0) != 0.0,
        Some(Value::Object(o)) => !o.is_empty(),
    }
}

pub fn matches(fields: &Map<String, Value>, p: &Predicate) -> bool {
    let got = fields.get(&p.field);
    match p.op.as_str() {
        "exists" => got.is_some(),
        "truthy" | "notEmpty" => truthy(got),
        "eq" => as_strings(got.unwrap_or(&Value::Null)) == as_strings(&p.value),
        "ne" => as_strings(got.unwrap_or(&Value::Null)) != as_strings(&p.value),
        "in" => {
            let wanted = as_strings(&p.value);
            as_strings(got.unwrap_or(&Value::Null))
                .iter()
                .any(|g| wanted.contains(g))
        }
        "contains" => {
            let needle = as_strings(&p.value).join(" ").to_lowercase();
            as_strings(got.unwrap_or(&Value::Null))
                .join(" ")
                .to_lowercase()
                .contains(&needle)
        }
        _ => true, // 모르는 연산자는 거르지 않는다 (팩 오타로 화면이 비지 않게)
    }
}

// ---------- 실행 ----------

fn first_heading(body: &str) -> Option<String> {
    body.lines()
        .find(|l| l.starts_with("# "))
        .map(|l| l[2..].trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn read_row(root: &Path, path: &Path) -> Option<NoteRow> {
    let text = std::fs::read_to_string(path).ok()?;
    let (fields, body) = match split_frontmatter(&text) {
        Some(sp) => {
            let map = serde_yaml::from_str::<serde_yaml::Value>(&sp.yaml)
                .ok()
                .map(|y| yaml_to_json(&y))
                .and_then(|j| match j {
                    Value::Object(o) => Some(o),
                    _ => None,
                })
                .unwrap_or_default();
            (map, sp.after_close)
        }
        None => (Map::new(), text.clone()),
    };
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let rel = path
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    Some(NoteRow {
        title: first_heading(&body).unwrap_or(stem),
        path: path.display().to_string(),
        rel,
        mtime_ms: mtime_ms(path),
        fields,
    })
}

fn sort_key(row: &NoteRow, sort: &Sort) -> String {
    match sort.source.as_str() {
        "title" => row.title.clone(),
        "mtime" => format!("{:020}", row.mtime_ms),
        _ => row
            .fields
            .get(&sort.field)
            .map(|v| as_strings(v).join(" "))
            .unwrap_or_default(),
    }
}

pub fn query(root: &Path, q: &NoteQuery) -> QueryResult {
    let mut folders: Vec<String> = Vec::new();
    let mut rows: Vec<NoteRow> = Vec::new();
    let mut truncated = false;

    if root.as_os_str().is_empty() || !root.is_dir() {
        return QueryResult {
            rows,
            folders,
            truncated,
        };
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    for pattern in &q.folders {
        for d in expand_folders(root, pattern) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }

    'outer: for dir in dirs {
        if let Ok(rel) = dir.strip_prefix(root) {
            folders.push(rel.to_string_lossy().replace('\\', "/"));
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("md"))
            .collect();
        files.sort();
        for file in files {
            let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if q.exclude.iter().any(|pat| wildcard_match(pat, name)) {
                continue;
            }
            let Some(row) = read_row(root, &file) else {
                continue;
            };
            if !q.predicates.iter().all(|p| matches(&row.fields, p)) {
                continue;
            }
            rows.push(row);
            if rows.len() >= MAX_ROWS {
                truncated = true;
                break 'outer;
            }
        }
    }

    if let Some(sort) = &q.sort {
        rows.sort_by_key(|r| sort_key(r, sort));
        if sort.desc {
            rows.reverse();
        }
    }
    if let Some(limit) = q.limit {
        if rows.len() > limit {
            rows.truncate(limit);
            truncated = true;
        }
    }
    QueryResult {
        rows,
        folders,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sw-notes-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn note(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn wildcard_rules() {
        assert!(wildcard_match("*.md", "a.md"));
        assert!(wildcard_match("*목록.md", "FDR 문제목록.md"));
        assert!(!wildcard_match("*목록.md", "FDR-001 제목.md"));
        assert!(wildcard_match("이슈", "이슈"));
        assert!(!wildcard_match("이슈", "이슈들"));
        assert!(wildcard_match("*", "무엇이든"));
        assert!(wildcard_match("a*c*e", "abcde"));
        assert!(!wildcard_match("a*c*e", "abcd"));
    }

    #[test]
    fn folders_expand_one_level_and_never_escape() {
        let root = tempdir("glob");
        note(
            &root,
            "프로젝트/알파/이슈/A-1.md",
            "---\ntype: 이슈\n---\n# 첫째\n",
        );
        note(&root, "프로젝트/베타/이슈/B-1.md", "---\ntype: 이슈\n---\n");
        note(&root, "프로젝트/베타/회의/M-1.md", "---\ntype: 회의\n---\n");

        let dirs = expand_folders(&root, "프로젝트/*/이슈");
        assert_eq!(dirs.len(), 2);
        assert!(expand_folders(&root, "../바깥").is_empty());
        assert!(expand_folders(&root, "없는폴더").is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn query_filters_excludes_and_reads_title() {
        let root = tempdir("query");
        note(
            &root,
            "프로젝트/알파/이슈/A-1.md",
            "---\ntype: 이슈\nstatus: 승인대기\n---\n\n# 로그인 오류\n본문",
        );
        note(
            &root,
            "프로젝트/알파/이슈/A-2.md",
            "---\ntype: 이슈\nstatus: 완료\n---\n",
        );
        note(
            &root,
            "프로젝트/알파/이슈/알파 문제목록.md",
            "---\ntype: 이슈\n---\n",
        );
        note(&root, "프로젝트/알파/이슈/메모.md", "프론트매터 없음");

        let q = NoteQuery {
            folders: vec!["프로젝트/*/이슈".into()],
            exclude: vec!["*목록.md".into()],
            predicates: vec![Predicate {
                field: "type".into(),
                op: "eq".into(),
                value: serde_json::json!("이슈"),
            }],
            ..Default::default()
        };
        let r = query(&root, &q);
        assert_eq!(r.rows.len(), 2, "목록 파일과 프론트매터 없는 노트는 빠진다");
        assert_eq!(r.rows[0].title, "로그인 오류");
        assert_eq!(r.rows[1].title, "A-2", "헤딩이 없으면 파일명");
        assert_eq!(r.rows[0].rel, "프로젝트/알파/이슈/A-1.md");
        assert_eq!(r.folders, vec!["프로젝트/알파/이슈"]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn predicates_cover_every_operator() {
        let mut f = Map::new();
        f.insert("status".into(), serde_json::json!("승인대기"));
        f.insert("labels".into(), serde_json::json!(["버그", "긴급"]));
        f.insert("approve".into(), serde_json::json!(false));
        f.insert("note".into(), serde_json::json!(""));

        let p = |field: &str, op: &str, value: Value| Predicate {
            field: field.into(),
            op: op.into(),
            value,
        };
        assert!(matches(
            &f,
            &p("status", "eq", serde_json::json!("승인대기"))
        ));
        assert!(matches(&f, &p("status", "ne", serde_json::json!("완료"))));
        assert!(matches(
            &f,
            &p("status", "in", serde_json::json!(["완료", "승인대기"]))
        ));
        assert!(matches(&f, &p("labels", "in", serde_json::json!(["긴급"]))));
        assert!(matches(
            &f,
            &p("labels", "contains", serde_json::json!("버그"))
        ));
        assert!(matches(&f, &p("approve", "exists", Value::Null)));
        assert!(!matches(&f, &p("approve", "truthy", Value::Null)));
        assert!(!matches(&f, &p("note", "notEmpty", Value::Null)));
        assert!(!matches(&f, &p("missing", "exists", Value::Null)));
        assert!(
            matches(&f, &p("status", "몰라요", Value::Null)),
            "모르는 연산자는 통과"
        );
    }

    #[test]
    fn sort_and_limit() {
        let root = tempdir("sort");
        note(&root, "일지/2026-09-01.md", "---\ntype: 일지\n---\n");
        note(&root, "일지/2026-09-03.md", "---\ntype: 일지\n---\n");
        note(&root, "일지/2026-09-02.md", "---\ntype: 일지\n---\n");

        let mut q = NoteQuery {
            folders: vec!["일지".into()],
            sort: Some(Sort {
                field: String::new(),
                source: "title".into(),
                desc: true,
            }),
            ..Default::default()
        };
        let r = query(&root, &q);
        assert_eq!(r.rows[0].title, "2026-09-03");

        q.limit = Some(2);
        let r = query(&root, &q);
        assert_eq!(r.rows.len(), 2);
        assert!(r.truncated);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_vault_is_empty_not_an_error() {
        let r = query(
            Path::new("/nonexistent-vault"),
            &NoteQuery {
                folders: vec!["일지".into()],
                ..Default::default()
            },
        );
        assert!(r.rows.is_empty() && r.folders.is_empty());
    }
}
