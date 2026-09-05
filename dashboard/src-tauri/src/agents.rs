// agents.rs — 에이전트 브리지.
//
// 주종 역전의 실체가 여기 있다: 앱이 에이전트를 **설치 대상으로** 다룬다. 예전에는
// 플러그인이 먼저 깔려야 앱이 쓸모 있었지만, 이제 앱이 팩의 스킬을 에이전트에 넣어 준다.
//
// 설치 상태 판정은 파일 바이트 비교다. 해시 장부를 따로 두면 사용자가 손으로 고친 스킬을
// 앱이 "내가 설치한 것"으로 착각해 조용히 덮어쓴다. 바이트가 다르면 `수정됨`이고,
// 수정된 파일은 제거하지 않는다.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::packs::Pack;

// ---------- 대상 에이전트 ----------

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";
pub const HERDR: &str = "herdr";

/// 스킬을 설치할 수 있는 에이전트인가 (herdr 는 실행 기반이지 설치 대상이 아니다).
pub fn is_install_target(agent: &str) -> bool {
    agent == CLAUDE || agent == CODEX
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn agent_home(agent: &str) -> PathBuf {
    match agent {
        CODEX => home().join(".codex"),
        _ => home().join(".claude"),
    }
}

/// 이 에이전트에서 스킬 하나가 사는 파일 경로.
pub fn skill_target(agent: &str, name: &str) -> PathBuf {
    match agent {
        CODEX => agent_home(CODEX).join("prompts").join(format!("{name}.md")),
        _ => agent_home(CLAUDE).join("skills").join(name).join("SKILL.md"),
    }
}

/// Codex 는 프론트매터 대신 파일명이 슬래시 커맨드가 된다. 원본을 그대로 넣으면
/// YAML 이 본문에 노출되므로, 머리말을 트리거 안내로 바꾼 파생본을 만든다.
pub fn render_for(agent: &str, pack_id: &str, name: &str, source: &str) -> String {
    if agent != CODEX {
        return source.to_string();
    }
    let normalized = source.replace("\r\n", "\n");
    let body = match crate::vault::split_frontmatter(&normalized) {
        Some(split) => split.after_close.trim_start().to_string(),
        None => normalized.trim_start().to_string(),
    };
    format!(
        "# {name}\n\n\
         > sawhorse 워크벤치가 설치한 프롬프트입니다. `/{name}` 으로 실행하세요.\n\
         > 원본: `{pack_id}` 팩의 Claude Code 스킬 `{name}`.\n\n\
         {body}"
    )
}

// ---------- 상태 ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillState {
    /// 설치됨 + 내용 동일
    Installed,
    /// 파일은 있는데 내용이 다르다 (사용자가 고쳤거나 팩이 갱신됨)
    Modified,
    Missing,
    /// 팩이 이름만 선언하고 SKILL.md 가 없다
    NoSource,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SkillStatus {
    pub skill: String,
    pub agent: String,
    pub state: SkillState,
    pub target: String,
}

fn source_path(pack: &Pack, name: &str) -> PathBuf {
    pack.skills_dir.join(name).join("SKILL.md")
}

pub fn skill_status(pack: &Pack, agent: &str, name: &str) -> SkillStatus {
    let target = skill_target(agent, name);
    let state = match std::fs::read_to_string(source_path(pack, name)) {
        Err(_) => SkillState::NoSource,
        Ok(src) => {
            let expected = render_for(agent, &pack.manifest.id, name, &src);
            match std::fs::read_to_string(&target) {
                Err(_) => SkillState::Missing,
                Ok(found) if found.replace("\r\n", "\n") == expected.replace("\r\n", "\n") => {
                    SkillState::Installed
                }
                Ok(_) => SkillState::Modified,
            }
        }
    };
    SkillStatus { skill: name.into(), agent: agent.into(), state, target: target.display().to_string() }
}

pub fn pack_skill_status(pack: &Pack, agent: &str) -> Vec<SkillStatus> {
    pack.manifest.skills.iter().map(|s| skill_status(pack, agent, s)).collect()
}

// ---------- 설치 ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub installed: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

/// 팩의 스킬을 에이전트에 쓴다. `force` 가 아니면 내용이 다른 파일(사용자 수정본)은 건드리지 않는다.
pub fn install_pack_skills(pack: &Pack, agent: &str, force: bool) -> Result<InstallReport, String> {
    if !is_install_target(agent) {
        return Err(format!("{agent} 에는 스킬을 설치할 수 없습니다"));
    }
    let mut report = InstallReport::default();
    for name in &pack.manifest.skills {
        let src = match std::fs::read_to_string(source_path(pack, name)) {
            Ok(s) => s,
            Err(_) => {
                report.failed.push(format!("{name}: 팩에 SKILL.md 가 없습니다"));
                continue;
            }
        };
        let target = skill_target(agent, name);
        let expected = render_for(agent, &pack.manifest.id, name, &src);
        if let Ok(found) = std::fs::read_to_string(&target) {
            let same = found.replace("\r\n", "\n") == expected.replace("\r\n", "\n");
            if same {
                report.skipped.push(format!("{name}: 이미 최신"));
                continue;
            }
            if !force {
                report.skipped.push(format!("{name}: 수정된 파일이 있어 건너뜀"));
                continue;
            }
        }
        if let Some(parent) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                report.failed.push(format!("{name}: 폴더 생성 실패 ({e})"));
                continue;
            }
        }
        match crate::config::write_atomic(&target, expected.as_bytes()) {
            Ok(()) => report.installed.push(name.clone()),
            Err(e) => report.failed.push(format!("{name}: 쓰기 실패 ({e})")),
        }
    }
    Ok(report)
}

/// 우리가 넣은 그대로인 파일만 지운다 — 사용자가 고친 것은 남긴다.
pub fn uninstall_pack_skills(pack: &Pack, agent: &str) -> Result<InstallReport, String> {
    if !is_install_target(agent) {
        return Err(format!("{agent} 에는 설치된 스킬이 없습니다"));
    }
    let mut report = InstallReport::default();
    for name in &pack.manifest.skills {
        match skill_status(pack, agent, name).state {
            SkillState::Installed => {
                let target = skill_target(agent, name);
                let removed = std::fs::remove_file(&target).is_ok();
                if removed {
                    // Claude 스킬은 폴더 하나를 통째로 쓰므로 빈 폴더를 남기지 않는다
                    if agent == CLAUDE {
                        let _ = std::fs::remove_dir(target.parent().unwrap_or(&target));
                    }
                    report.installed.push(name.clone());
                } else {
                    report.failed.push(format!("{name}: 삭제 실패"));
                }
            }
            SkillState::Modified => report.skipped.push(format!("{name}: 수정본이라 남겨둠")),
            _ => report.skipped.push(format!("{name}: 설치되어 있지 않음")),
        }
    }
    Ok(report)
}

// ---------- 감지 ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresence {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub version: Option<String>,
    pub home: String,
    /// 스킬 설치 대상인가
    pub installable: bool,
    /// 사용자에게 보여줄 한 줄 (미설치 시 안내)
    pub note: String,
}

fn spawn(bin: &str, args: &[&str]) -> tokio::process::Command {
    #[cfg(windows)]
    {
        let mut c = tokio::process::Command::new("cmd");
        c.arg("/c").arg(bin).args(args);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = tokio::process::Command::new(bin);
        c.args(args);
        c
    }
}

async fn version_of(bin: &str) -> Option<String> {
    let mut c = spawn(bin, &["--version"]);
    c.stdin(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(4), c.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    s.lines().next().map(str::to_string).filter(|l| !l.is_empty())
}

pub async fn detect_agents(claude_bin: &str, herdr_bin: &str) -> Vec<AgentPresence> {
    let claude = version_of(claude_bin).await;
    let codex = version_of("codex").await;
    let herdr = version_of(herdr_bin).await;
    vec![
        AgentPresence {
            id: CLAUDE.into(),
            name: "Claude Code".into(),
            detected: claude.is_some(),
            version: claude,
            home: agent_home(CLAUDE).display().to_string(),
            installable: true,
            note: "스킬은 ~/.claude/skills 에 개인 스킬로 설치됩니다".into(),
        },
        AgentPresence {
            id: CODEX.into(),
            name: "Codex".into(),
            detected: codex.is_some(),
            version: codex,
            home: agent_home(CODEX).display().to_string(),
            installable: true,
            note: "스킬은 ~/.codex/prompts 의 슬래시 프롬프트로 변환되어 설치됩니다".into(),
        },
        AgentPresence {
            id: HERDR.into(),
            name: "herdr".into(),
            detected: herdr.is_some(),
            version: herdr,
            home: String::new(),
            installable: false,
            note: "터미널 실행 기반. 설치되어 있으면 잡이 사람이 볼 수 있는 세션에서 돕니다".into(),
        },
    ]
}

// ---------- Claude Code 플러그인 설치 감지 ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstall {
    pub key: String,
    pub version: String,
    pub install_path: String,
}

fn installed_plugins_path() -> PathBuf {
    agent_home(CLAUDE).join("plugins").join("installed_plugins.json")
}

/// 같은 스킬이 플러그인으로도 설치돼 있으면 개인 스킬 설치를 권하지 않는다
/// (중복 등록은 슬래시 커맨드가 두 벌 뜨는 혼란을 만든다).
pub fn plugin_installs_at(path: &Path, plugin_name: &str) -> Vec<PluginInstall> {
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    let Some(map) = v.get("plugins").and_then(|p| p.as_object()) else { return vec![] };
    let prefix = format!("{plugin_name}@");
    map.iter()
        .filter(|(k, _)| k.starts_with(&prefix) || k.as_str() == plugin_name)
        .filter_map(|(k, entries)| {
            let first = entries.as_array()?.first()?;
            Some(PluginInstall {
                key: k.clone(),
                version: first.get("version").and_then(|x| x.as_str()).unwrap_or("").into(),
                install_path: first
                    .get("installPath")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .into(),
            })
        })
        .collect()
}

pub fn plugin_installs(plugin_name: &str) -> Vec<PluginInstall> {
    plugin_installs_at(&installed_plugins_path(), plugin_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::{PackManifest, PackSource};
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sw-agents-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_pack(dir: &Path, skills: &[(&str, &str)]) -> Pack {
        for (name, body) in skills {
            let d = dir.join("skills").join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("SKILL.md"), body).unwrap();
        }
        Pack {
            manifest: PackManifest {
                id: "demo".into(),
                name: "데모".into(),
                skills: skills.iter().map(|(n, _)| n.to_string()).collect(),
                ..Default::default()
            },
            dir: dir.to_path_buf(),
            skills_dir: dir.join("skills"),
            source: PackSource::User,
            enabled: true,
        }
    }

    #[test]
    fn codex_rendering_strips_frontmatter_and_adds_trigger() {
        let src = "---\nname: morning\ndescription: 아침\n---\n\n본문 첫 줄\n";
        let out = render_for(CODEX, "si", "morning", src);
        assert!(!out.contains("description:"), "프론트매터가 남으면 안 된다");
        assert!(out.starts_with("# morning"));
        assert!(out.contains("`/morning`"));
        assert!(out.contains("본문 첫 줄"));
        // Claude 는 원본 그대로
        assert_eq!(render_for(CLAUDE, "si", "morning", src), src);
    }

    #[test]
    fn install_roundtrip_respects_user_edits() {
        let packdir = tempdir("pack");
        let fakehome = tempdir("home");
        let pack = fake_pack(&packdir, &[("alpha", "---\nname: alpha\n---\n첫 판\n")]);

        // skill_target 은 실제 홈을 보므로, 여기서는 순수 함수 경로만 검증하고
        // 파일 왕복은 대상 경로를 직접 만들어 확인한다.
        let target = fakehome.join("skills/alpha/SKILL.md");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let expected = render_for(CLAUDE, "demo", "alpha", "---\nname: alpha\n---\n첫 판\n");
        crate::config::write_atomic(&target, expected.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), expected);

        // 소스가 없으면 NoSource
        let empty = fake_pack(&tempdir("empty"), &[]);
        let mut p = empty.clone();
        p.manifest.skills = vec!["nope".into()];
        assert_eq!(skill_status(&p, CLAUDE, "nope").state, SkillState::NoSource);

        // 설치 대상이 아닌 에이전트는 거절
        assert!(install_pack_skills(&pack, HERDR, false).is_err());
        assert!(uninstall_pack_skills(&pack, HERDR).is_err());

        fs::remove_dir_all(&packdir).unwrap();
        fs::remove_dir_all(&fakehome).unwrap();
    }

    #[test]
    fn skill_targets_differ_per_agent() {
        let c = skill_target(CLAUDE, "morning");
        assert!(c.ends_with("skills/morning/SKILL.md"), "{c:?}");
        let x = skill_target(CODEX, "morning");
        assert!(x.ends_with("prompts/morning.md"), "{x:?}");
        assert!(is_install_target(CLAUDE) && is_install_target(CODEX) && !is_install_target(HERDR));
    }

    #[test]
    fn plugin_installs_read_v2_registry() {
        let dir = tempdir("plugins");
        let path = dir.join("installed_plugins.json");
        fs::write(
            &path,
            r#"{"version":2,"plugins":{
                 "sawhorse@sawhorse":[{"scope":"user","installPath":"/p/sawhorse","version":"0.9.0"}],
                 "other@x":[{"scope":"user","installPath":"/p/other","version":"1"}]}}"#,
        )
        .unwrap();
        let got = plugin_installs_at(&path, "sawhorse");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].version, "0.9.0");
        assert_eq!(got[0].install_path, "/p/sawhorse");
        assert!(plugin_installs_at(&path, "nothing").is_empty());
        assert!(plugin_installs_at(Path::new("/nonexistent"), "sawhorse").is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
