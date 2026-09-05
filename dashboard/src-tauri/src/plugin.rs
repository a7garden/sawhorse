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

/// 리소스 디렉터리 → exe 디렉터리 상위 탐색 → 빌드 머신 저장소 폴백. 설정 키 불필요.
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
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
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

pub fn list_skills(root: &Path) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root.join("skills")) else {
        return out;
    };
    for entry in rd.flatten() {
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
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
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

pub fn read_skill(root: &Path, name: &str) -> Result<String, String> {
    read_skill_at(&root.join("skills"), name)
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
            assert!(read_skill(&root, bad).is_err(), "{bad}");
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
    fn install_skill_writes_claude_and_codex_variants() {
        let home = tempdir("home");
        let repo = tempdir("repo");
        fs::create_dir_all(repo.join("skills/workbench")).unwrap();
        fs::write(
            repo.join("skills/workbench/SKILL.md"),
            "---\nname: workbench\ndescription: d\n---\n본문",
        )
        .unwrap();

        let s = install_skill_at(&home, &repo, "claude", true).unwrap();
        assert!(s.written);
        assert!(home.join(".claude/skills/workbench/SKILL.md").is_file());

        let c = install_skill_at(&home, &repo, "codex", true).unwrap();
        assert!(c.written);
        let codex = fs::read_to_string(home.join(".codex/prompts/workbench.md")).unwrap();
        assert!(
            !codex.starts_with("---"),
            "codex본은 프론트매터로 시작하지 않는다"
        );
        assert!(
            !codex.contains("description:"),
            "codex본에서 프론트매터 필드가 제거된다"
        );
        assert!(codex.contains("본문"));

        assert!(install_skill_at(&home, &repo, "unknown", true).is_err());
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&repo).unwrap();
    }

    #[test]
    fn skill_status_at_reports_existence_without_writing() {
        let home = tempdir("home");
        let repo = tempdir("repo");
        fs::create_dir_all(repo.join("skills/workbench")).unwrap();
        fs::write(
            repo.join("skills/workbench/SKILL.md"),
            "---\nname: w\n---\n본문",
        )
        .unwrap();

        let before = skill_status_at(&home);
        assert_eq!(before.len(), 2);
        assert!(
            before.iter().all(|s| !s.written),
            "아무것도 설치 전이면 전부 미설치"
        );
        assert!(
            !home.join(".claude").exists() && !home.join(".codex").exists(),
            "status 조회는 어떤 경로도 만들면 안 된다",
        );

        install_skill_at(&home, &repo, "claude", true).unwrap();
        let after = skill_status_at(&home);
        let claude = after.iter().find(|s| s.target == "claude").unwrap();
        let codex = after.iter().find(|s| s.target == "codex").unwrap();
        assert!(claude.written);
        assert!(claude.path.ends_with(".claude/skills/workbench/SKILL.md"));
        assert!(!codex.written);
        assert!(
            !home.join(".codex").exists(),
            "status는 codex 경로를 만들면 안 된다"
        );
        fs::remove_dir_all(&home).unwrap();
        fs::remove_dir_all(&repo).unwrap();
    }
}

// ---------- workbench skill installer ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstall {
    pub target: String,
    pub path: String,
    pub written: bool,
}

/// 대상별 설치 위치. 홈 기준 고정 상대경로만 조립한다 — 외부 입력 경로 결합 없음.
fn skill_dest(home: &Path, target: &str) -> Result<PathBuf, String> {
    match target {
        "claude" => Ok(home.join(".claude/skills/workbench/SKILL.md")),
        "codex" => Ok(home.join(".codex/prompts/workbench.md")),
        _ => Err(format!("알 수 없는 대상: {target} (claude|codex)")),
    }
}

/// 존재 여부만 조회한다. 파일을 만들거나 수정하지 않는다.
fn skill_entry(home: &Path, target: &str) -> Result<SkillInstall, String> {
    let dest = skill_dest(home, target)?;
    Ok(SkillInstall {
        target: target.into(),
        path: dest.display().to_string(),
        written: dest.is_file(),
    })
}

/// SKILL.md 앞의 YAML 프론트매터 블록을 떼어낸다.
fn strip_frontmatter(text: &str) -> &str {
    let rest = match text
        .strip_prefix("---\r\n")
        .or_else(|| text.strip_prefix("---\n"))
    {
        Some(r) => r,
        None => return text,
    };
    match rest.find("\n---") {
        Some(i) => rest[i + 4..].trim_start_matches(['\n', '\r']),
        None => text,
    }
}
/// write=true면 실제로 기록하고, write=false면 존재 여부만 조회한다(status 모드).
fn install_skill_at(
    home: &Path,
    root: &Path,
    target: &str,
    write: bool,
) -> Result<SkillInstall, String> {
    if !write {
        return skill_entry(home, target);
    }
    let dest = skill_dest(home, target)?;
    let source = read_skill(root, "workbench")?;
    let body = match target {
        // Codex 프롬프트는 프론트매터 대신 트리거 안내 헤더로 시작한다.
        "codex" => format!(
            "# workbench — 워크벤치 작업 등록 (사용자가 워크벤치 작업을 만들자고 하면 이 절차를 따른다)\n\n{}",
            strip_frontmatter(&source)
        ),
        _ => source,
    };
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("디렉터리 생성 실패: {e}"))?;
    }
    std::fs::write(&dest, body).map_err(|e| format!("스킬 설치 실패: {e}"))?;
    Ok(SkillInstall {
        target: target.into(),
        path: dest.display().to_string(),
        written: true,
    })
}

/// config.json(~/.claude/sawhorse/config.json)에서 홈을 유도한다.
/// ancestors는 자기 자신을 포함하므로 파일=0, sawhorse=1, .claude=2, 홈=3.
fn derived_home() -> Option<PathBuf> {
    crate::config::config_path()
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
}

pub fn install_skill(target: &str) -> Result<SkillInstall, String> {
    let root = resolve_root()?;
    let home = derived_home().ok_or("홈 디렉터리를 찾지 못했다")?;
    install_skill_at(&home, &root, target, true)
}

/// 홈 주입형 상태 조회 — 테스트가 실제 홈 오염 없이 검증할 수 있다.
fn skill_status_at(home: &Path) -> Vec<SkillInstall> {
    ["claude", "codex"]
        .into_iter()
        .map(|t| {
            skill_entry(home, t).unwrap_or(SkillInstall {
                target: t.into(),
                path: String::new(),
                written: false,
            })
        })
        .collect()
}

/// 설정 카드용 상태 조회. 읽기 전용 — 그 어떤 파일도 쓰지 않는다.
pub fn skill_status() -> Vec<SkillInstall> {
    match derived_home() {
        Some(home) => skill_status_at(&home),
        None => vec![],
    }
}
