// plugin.rs — plugin metadata + skill catalog, read at runtime from the plugin root.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

const MARKER: &str = ".claude-plugin/plugin.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub homepage: String,
    pub repository: String,
    pub keywords: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundle {
    pub root: String,
    #[serde(flatten)]
    pub meta: PluginMeta,
    pub skills: Vec<SkillInfo>,
}

/// Walk up from `start` looking for a directory containing `.claude-plugin/plugin.json`.
fn walk_up(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(MARKER).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Try each candidate (and its ancestors); error lists every searched root.
fn resolve_from(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    for c in candidates {
        if let Some(root) = walk_up(c) {
            return Ok(root);
        }
        tried.push(c.display().to_string());
    }
    Err(format!(
        "플러그인 루트를 찾지 못했다. 탐색한 위치: {}",
        tried.join(", ")
    ))
}

/// 번들된 앱에는 저장소가 없다. 실행 시점에 리소스 디렉터리를 한 번 등록해 두면
/// 그 뒤의 모든 조회(팩 레지스트리 포함)가 거기서 플러그인 루트를 찾는다.
static ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// 마커(`.claude-plugin/plugin.json`)가 실제로 있는 경로만 등록한다 — 개발 실행에서는
/// 리소스 디렉터리가 target/debug 라 마커가 없고, 그때는 아래 탐색이 그대로 쓰인다.
pub fn set_root_override(dir: PathBuf) -> bool {
    if walk_up(&dir).is_none() {
        return false;
    }
    ROOT_OVERRIDE.set(dir).is_ok()
}

/// 리소스 디렉터리(`plugin/` 번들) → exe 디렉터리 상위 탐색 → 개발 머신 저장소 플러그인
/// 폴더. 설정 키 불필요.
pub fn resolve_root() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = ROOT_OVERRIDE.get() {
        candidates.push(dir.clone());
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugin"));
    resolve_from(&candidates).map(|p| p.canonicalize().unwrap_or(p))
}

/// Parse `name`/`description` from a SKILL.md YAML frontmatter block.
fn parse_frontmatter(text: &str) -> Option<(String, String)> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let v: serde_yaml::Value = serde_yaml::from_str(&rest[..end]).ok()?;
    let name = v.get("name")?.as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let desc = v
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some((name, desc))
}

/// plugin.json 의 `skills` 배열(플러그인 루트 기준 상대경로)이 가리키는 디렉터리들을 모두
/// 훑어 스킬 목록을 모은다. 배열이 없으면 루트 `skills/` 하나로 떨어진다(구버전 호환).
pub fn list_skills(root: &Path) -> Vec<SkillInfo> {
    let mut out: Vec<SkillInfo> = Vec::new();
    for dir in skill_dirs(root) {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        // A pack manifest owns its public skill catalog. Old directories left by
        // an earlier installation must not reappear just because they still exist.
        let declared = dir
            .parent()
            .filter(|parent| parent.join("pack.json").is_file())
            .map(|parent| -> Vec<String> {
                std::fs::read_to_string(parent.join("pack.json"))
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .and_then(|value| value.get("skills")?.as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect()
            });
        for entry in rd.flatten() {
            if declared
                .as_ref()
                .is_some_and(|names| !names.iter().any(|name| entry.file_name() == name.as_str()))
            {
                continue;
            }
            let p = entry.path();
            if !p.is_dir() {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(p.join("SKILL.md")) else {
                continue;
            };
            if let Some((name, description)) = parse_frontmatter(&text) {
                out.push(SkillInfo { name, description });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// plugin.json 의 `skills` 선언을 루트 기준 경로로 푼 것. 선언은 `./packs/journal/skills`
/// 처럼 `./` 를 붙일 수 있다.
fn skill_dirs(root: &Path) -> Vec<PathBuf> {
    let declared: Option<Vec<String>> = std::fs::read_to_string(root.join(MARKER))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            v.get("skills")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
        });
    match declared {
        Some(dirs) => dirs
            .iter()
            .map(|d| root.join(d.trim_start_matches("./")))
            .collect(),
        None => vec![root.join("skills")],
    }
}

pub fn plugin_info() -> Result<PluginBundle, String> {
    let root = resolve_root()?;
    let raw = std::fs::read_to_string(root.join(MARKER))
        .map_err(|e| format!("plugin.json 읽기 실패: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 파싱 실패: {e}"))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let author = match v.get("author") {
        Some(serde_json::Value::String(a)) => a.clone(),
        Some(o @ serde_json::Value::Object(_)) => o
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    };
    let keywords = v
        .get("keywords")
        .and_then(|k| k.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(PluginBundle {
        root: root.display().to_string(),
        meta: PluginMeta {
            name: s("name"),
            description: s("description"),
            version: s("version"),
            author,
            license: s("license"),
            homepage: s("homepage"),
            repository: s("repository"),
            keywords,
        },
        skills: list_skills(&root),
    })
}

/// 스킬 본문을 스킬 폴더에서 직접 읽는다. 팩마다 `skills/` 위치가 달라(내장 팩은 플러그인
/// 루트, 사용자 팩은 팩 폴더) 호출자가 디렉터리를 정한다.
pub fn read_skill_at(skills_dir: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("잘못된 스킬 이름".into());
    }
    let p = skills_dir.join(name).join("SKILL.md");
    std::fs::read_to_string(&p).map_err(|e| format!("SKILL.md 읽기 실패: {e}"))
}

/// plugin.json 의 `name` — 설치된 플러그인 감지(`agents::plugin_installs`)의 키.
pub fn plugin_name() -> Result<String, String> {
    let root = resolve_root()?;
    let raw = std::fs::read_to_string(root.join(MARKER))
        .map_err(|e| format!("plugin.json 읽기 실패: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 파싱 실패: {e}"))?;
    Ok(v.get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("swdash-plugin-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn walk_up_finds_marker_above_start() {
        let root = tempdir("root");
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(root.join(".claude-plugin/plugin.json"), "{}").unwrap();
        let deep = root.join("dashboard/src-tauri/target/debug");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(walk_up(&deep), Some(root.clone()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_from_lists_missed_candidates() {
        let a = tempdir("a");
        let b = tempdir("b");
        let msg = resolve_from(&[a.clone(), b.clone()]).unwrap_err();
        assert!(msg.contains(&a.display().to_string()));
        assert!(msg.contains(&b.display().to_string()));
        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }

    #[test]
    fn parse_frontmatter_reads_name_and_description() {
        let md = "---\nname: morning\ndescription: 출근 브리핑 스킬\n---\n\n# morning\n본문";
        let got = parse_frontmatter(md).unwrap();
        assert_eq!(got.0, "morning");
        assert_eq!(got.1, "출근 브리핑 스킬");
    }

    #[test]
    fn parse_frontmatter_tolerates_crlf_and_missing_description() {
        let got = parse_frontmatter("---\r\nname: wiki\r\n---\r\n본문").unwrap();
        assert_eq!(got.0, "wiki");
        assert_eq!(got.1, "");
        assert!(parse_frontmatter("frontmatter 없음").is_none());
        assert!(parse_frontmatter("---\ndescription: 이름 없음\n---\n").is_none());
    }

    #[test]
    fn read_skill_rejects_path_tricks() {
        let root = tempdir("guard");
        for bad in ["", "../x", "a/b", "a\\b", ".."] {
            assert!(read_skill_at(&root, bad).is_err(), "{bad}");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_skills_skips_broken_dirs_and_sorts() {
        let root = tempdir("skills");
        let mk = |n: &str, md: &str| {
            let d = root.join("skills").join(n);
            fs::create_dir_all(&d).unwrap();
            if !md.is_empty() {
                fs::write(d.join("SKILL.md"), md).unwrap();
            }
        };
        mk("zzz", "---\nname: zzz\ndescription: last\n---\n");
        mk("aaa", "---\nname: aaa\ndescription: first\n---\n");
        mk("broken", "frontmatter 없음");
        mk("empty", "");
        let got = list_skills(&root);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "aaa");
        assert_eq!(got[1].description, "last");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn pack_catalog_does_not_rediscover_retired_skill_directories() {
        let root = tempdir("retired-skills");
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(root.join(MARKER), r#"{"skills":["./packs/si/skills"]}"#).unwrap();
        for name in ["issues", "improve", "improve-excel"] {
            let path = root.join("packs/si/skills").join(name);
            fs::create_dir_all(&path).unwrap();
            fs::write(
                path.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: example\n---\n"),
            )
            .unwrap();
        }
        fs::write(root.join("packs/si/pack.json"), r#"{"skills":["issues"]}"#).unwrap();
        let skills = list_skills(&root);
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.name.as_str())
                .collect::<Vec<_>>(),
            vec!["issues"]
        );
        fs::remove_dir_all(root).unwrap();
    }

    /// 동봉된 plugin.json 의 skills 배열(팩 디렉터리 포함)을 모두 훑는지.
    #[test]
    fn list_skills_follows_plugin_json_skills_array() {
        let root = tempdir("decl");
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(
            root.join(".claude-plugin/plugin.json"),
            r#"{"skills": ["./skills", "./packs/si/skills"]}"#,
        )
        .unwrap();
        for d in [
            "skills/workbench",
            "packs/si/skills/morning",
            "packs/si/skills/zzz",
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(
            root.join("skills/workbench/SKILL.md"),
            "---\nname: workbench\ndescription: 앱 고유\n---\n",
        )
        .unwrap();
        fs::write(
            root.join("packs/si/skills/morning/SKILL.md"),
            "---\nname: morning\ndescription: first\n---\n",
        )
        .unwrap();
        // 같은 이름이 두 선언에 있으면 하나만 남는다
        fs::create_dir_all(root.join("packs/si/skills/dup")).unwrap();
        fs::write(
            root.join("packs/si/skills/dup/SKILL.md"),
            "---\nname: workbench\ndescription: dup\n---\n",
        )
        .unwrap();

        let got = list_skills(&root);
        let names: Vec<&str> = got.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, ["morning", "workbench"], "정렬 + 중복 제거");
        assert_eq!(got[1].description, "앱 고유", "첫 선언(skills/)이 이긴다");
        fs::remove_dir_all(&root).unwrap();
    }
}
