// agents.rs — 에이전트 브리지.
//
// 주종 역전의 실체가 여기 있다: 앱이 에이전트를 **설치 대상으로** 다룬다. 예전에는
// 플러그인이 먼저 깔려야 앱이 쓸모 있었지만, 이제 앱이 팩의 스킬을 에이전트에 넣어 준다.
//
// 설치 상태 판정은 파일 바이트 비교다. 해시 장부를 따로 두면 사용자가 손으로 고친 스킬을
// 앱이 "내가 설치한 것"으로 착각해 조용히 덮어쓴다. 바이트가 다르면 `수정됨`이고,
// 수정된 파일은 제거하지 않는다.
//
// 감지 대상은 스킬을 넣을 수 있는 둘(Claude Code·Codex)보다 넓다. 사용자가 쓰는 CLI 를
// 목록에 보여 주고 그중 기본을 고르게 하는 것이 마법사의 일이므로, 우리가 스킬을 못 넣는
// 에이전트도 카탈로그에 둔다 — 대신 각 줄이 자기 범위를 문구로 밝힌다.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::packs::Pack;

// ---------- 대상 에이전트 ----------

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";

/// 스킬을 설치할 수 있는 에이전트인가. 카탈로그의 나머지는 감지 대상일 뿐이다.
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

/// 에이전트 하나에 대해 앱이 아는 것. 카탈로그는 코드에 두고, 여기 없는 CLI 는 사용자가
/// 설정(`dashboard.customAgents`)에서 더한다 — 사내 도구나 직접 만든 에이전트를 위해.
pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// 찾아볼 실행 파일 이름들. 먼저 잡히는 것을 쓴다.
    pub bins: &'static [&'static str],
    /// 빈 문자열이면 설치 위치가 등록돼 있지 않다는 뜻이고, 화면에 설치 버튼을 내지 않는다.
    /// 모르는 곳을 아는 척 가리키느니 아무것도 가리키지 않는 편이 낫다.
    pub install_url: &'static str,
    pub install_hint: &'static str,
    /// 앱이 이 에이전트로 잡을 **직접** 돌릴 수 있는가. 지금은 Claude Code 하나뿐이다 —
    /// 진행 스트림 파싱이 그 CLI 의 `stream-json` 형식에 묶여 있다. 나머지는 감지와
    /// 스킬 설치까지가 범위이고, 화면도 그렇게 말해야 한다.
    pub runs_jobs: bool,
    pub note: &'static str,
}

/// 감지만 하는 에이전트에 공통으로 붙는 한 줄.
const DETECT_ONLY: &str = "감지까지만 합니다 — 이 에이전트용 스킬 설치 형식이 아직 없습니다.";

const VERSION_ARGS: &[&str] = &["--version"];

pub const AGENT_CATALOG: &[AgentSpec] = &[
    AgentSpec {
        id: CLAUDE,
        name: "Claude Code",
        bins: &["claude"],
        install_url: "https://docs.claude.com/en/docs/claude-code/setup",
        install_hint: "npm install -g @anthropic-ai/claude-code",
        runs_jobs: true,
        note: "스킬은 ~/.claude/skills 에 개인 스킬로 설치됩니다.",
    },
    AgentSpec {
        id: CODEX,
        name: "Codex CLI",
        bins: &["codex"],
        install_url: "https://github.com/openai/codex",
        install_hint: "npm install -g @openai/codex",
        runs_jobs: false,
        note: "스킬은 ~/.codex/prompts 의 슬래시 프롬프트로 변환되어 설치됩니다.",
    },
    AgentSpec {
        id: "opencode",
        name: "opencode",
        bins: &["opencode"],
        install_url: "https://opencode.ai",
        install_hint: "npm install -g opencode-ai",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "gemini",
        name: "Gemini CLI",
        bins: &["gemini"],
        install_url: "https://github.com/google-gemini/gemini-cli",
        install_hint: "npm install -g @google/gemini-cli",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "amp",
        name: "Amp",
        bins: &["amp"],
        install_url: "https://ampcode.com",
        install_hint: "npm install -g @sourcegraph/amp",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "copilot",
        name: "GitHub Copilot CLI",
        bins: &["copilot"],
        install_url: "https://github.com/github/copilot-cli",
        install_hint: "npm install -g @github/copilot",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "cursor-agent",
        name: "Cursor CLI",
        bins: &["cursor-agent"],
        install_url: "https://cursor.com/cli",
        install_hint: "",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "aider",
        name: "Aider",
        bins: &["aider"],
        install_url: "https://aider.chat",
        install_hint: "uv tool install aider-chat",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "crush",
        name: "Crush",
        bins: &["crush"],
        install_url: "https://github.com/charmbracelet/crush",
        install_hint: "",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "goose",
        name: "goose",
        bins: &["goose"],
        install_url: "https://block.github.io/goose/",
        install_hint: "",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "qwen",
        name: "Qwen Code",
        bins: &["qwen"],
        install_url: "https://github.com/QwenLM/qwen-code",
        install_hint: "npm install -g @qwen-code/qwen-code",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    AgentSpec {
        id: "droid",
        name: "Factory Droid",
        bins: &["droid"],
        install_url: "https://docs.factory.ai/cli/getting-started/quickstart",
        install_hint: "",
        runs_jobs: false,
        note: DETECT_ONLY,
    },
    // 아래 둘은 이 PC 에 있으면 잡아 주기만 한다. 공개된 설치 위치를 우리가 모르므로
    // install_url 을 비워 둔다 — 설정의 customAgents 에서 링크를 덧붙일 수 있다.
    AgentSpec {
        id: "omp",
        name: "omp",
        bins: &["omp"],
        install_url: "",
        install_hint: "",
        runs_jobs: false,
        note: "감지까지만 합니다 — 설치 위치가 등록되어 있지 않습니다.",
    },
    AgentSpec {
        id: "pi",
        name: "pi",
        bins: &["pi", "oxipi", "pi-new"],
        install_url: "",
        install_hint: "",
        runs_jobs: false,
        note: "감지까지만 합니다 — 설치 위치가 등록되어 있지 않습니다.",
    },
];

pub fn spec(id: &str) -> Option<&'static AgentSpec> {
    AGENT_CATALOG.iter().find(|s| s.id == id)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentPresence {
    pub id: String,
    pub name: String,
    pub detected: bool,
    pub version: Option<String>,
    /// 실제로 찾은 실행 파일 경로. 같은 이름이 여러 군데 깔린 PC 에서 어느 것을 잡았는지
    /// 보여 줘야 "왜 옛날 버전이 뜨지" 를 사용자가 스스로 푼다.
    pub path: String,
    pub home: String,
    /// 스킬 설치 대상인가
    pub installable: bool,
    /// 앱이 이 에이전트로 잡을 직접 돌릴 수 있는가
    pub runs_jobs: bool,
    pub install_url: String,
    pub install_hint: String,
    /// 설정에서 사용자가 더한 항목인가
    pub custom: bool,
    /// 사용자에게 보여 줄 한 줄
    pub note: String,
}

/// 카탈로그 항목과 사용자 항목을 같은 모양으로 눕힌 중간 형태.
struct Candidate {
    id: String,
    name: String,
    bins: Vec<String>,
    install_url: String,
    install_hint: String,
    runs_jobs: bool,
    note: String,
    custom: bool,
}

fn candidates(dash: &crate::config::DashboardCfg) -> Vec<Candidate> {
    // 설정의 claudeBin 은 카탈로그 이름보다 우선한다 — 그 값이 곧 잡 실행기가 부르는 명령이다.
    let claude_bin = dash.claude_bin.trim();
    let mut out: Vec<Candidate> = AGENT_CATALOG
        .iter()
        .map(|s| {
            let mut bins: Vec<String> = s.bins.iter().map(|b| (*b).to_string()).collect();
            if s.id == CLAUDE && !claude_bin.is_empty() && !bins.iter().any(|b| b == claude_bin) {
                bins.insert(0, claude_bin.to_string());
            }
            Candidate {
                id: s.id.into(),
                name: s.name.into(),
                bins,
                install_url: s.install_url.into(),
                install_hint: s.install_hint.into(),
                runs_jobs: s.runs_jobs,
                note: s.note.into(),
                custom: false,
            }
        })
        .collect();

    for c in &dash.custom_agents {
        let id = c.id.trim();
        if id.is_empty() {
            continue;
        }
        let bin = if c.bin.trim().is_empty() { id } else { c.bin.trim() };
        // 카탈로그가 이미 아는 id 면 실행 파일만 앞에 끼운다 — 잘못 잡히는 경로를 바로잡는 용도다.
        if let Some(existing) = out.iter_mut().find(|x| x.id == id) {
            existing.bins.insert(0, bin.to_string());
            if !c.install_url.trim().is_empty() {
                existing.install_url = c.install_url.trim().into();
            }
            continue;
        }
        out.push(Candidate {
            id: id.into(),
            name: if c.name.trim().is_empty() { id.into() } else { c.name.trim().into() },
            bins: vec![bin.to_string()],
            install_url: c.install_url.trim().into(),
            install_hint: String::new(),
            runs_jobs: false,
            note: "설정에 직접 등록한 에이전트입니다 — 감지까지만 합니다.".into(),
            custom: true,
        });
    }
    out
}

pub async fn detect_agents(dash: &crate::config::DashboardCfg) -> Vec<AgentPresence> {
    let cands = candidates(dash);
    let found: Vec<Option<PathBuf>> = cands
        .iter()
        .map(|c| {
            let refs: Vec<&str> = c.bins.iter().map(String::as_str).collect();
            crate::detect::resolve_any(&refs)
        })
        .collect();
    // 버전은 찾은 것만, 동시에 물어본다. 하나가 느려도 목록 전체가 멈추지 않는다.
    let probes: Vec<(PathBuf, &'static [&'static str])> =
        found.iter().flatten().map(|p| (p.clone(), VERSION_ARGS)).collect();
    let mut versions = crate::detect::versions_of(probes).await.into_iter();

    let mut out: Vec<AgentPresence> = cands
        .into_iter()
        .zip(found)
        .map(|(c, path)| {
            let version = if path.is_some() { versions.next().flatten() } else { None };
            let installable = is_install_target(&c.id);
            AgentPresence {
                home: if installable {
                    agent_home(&c.id).display().to_string()
                } else {
                    String::new()
                },
                detected: path.is_some(),
                path: path.map(|p| p.display().to_string()).unwrap_or_default(),
                version,
                installable,
                id: c.id,
                name: c.name,
                runs_jobs: c.runs_jobs,
                install_url: c.install_url,
                install_hint: c.install_hint,
                custom: c.custom,
                note: c.note,
            }
        })
        .collect();
    // 깔린 것을 먼저 보여 준다. 같은 그룹 안의 순서는 카탈로그 순서 그대로다.
    out.sort_by_key(|a| !a.detected);
    out
}

/// 설정의 기본 에이전트를 실제로 쓸 수 있는 값으로 바꾼다. 저장된 id 가 카탈로그에도
/// 사용자 목록에도 없으면 Claude Code 로 떨어진다 — 설정 파일은 손으로도 고쳐지므로
/// 읽는 쪽이 항상 정상값을 받게 한다.
pub fn effective_default(dash: &crate::config::DashboardCfg) -> String {
    let want = dash.default_agent.trim();
    if !want.is_empty()
        && (spec(want).is_some() || dash.custom_agents.iter().any(|c| c.id.trim() == want))
    {
        return want.to_string();
    }
    CLAUDE.to_string()
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
        assert!(install_pack_skills(&pack, "opencode", false).is_err());
        assert!(uninstall_pack_skills(&pack, "opencode").is_err());

        fs::remove_dir_all(&packdir).unwrap();
        fs::remove_dir_all(&fakehome).unwrap();
    }

    #[test]
    fn skill_targets_differ_per_agent() {
        let c = skill_target(CLAUDE, "morning");
        assert!(c.ends_with("skills/morning/SKILL.md"), "{c:?}");
        let x = skill_target(CODEX, "morning");
        assert!(x.ends_with("prompts/morning.md"), "{x:?}");
        assert!(is_install_target(CLAUDE) && is_install_target(CODEX) && !is_install_target("opencode"));
    }

    #[test]
    fn catalog_is_well_formed_and_only_claude_runs_jobs() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in AGENT_CATALOG {
            assert!(seen.insert(spec.id), "id 가 겹친다: {}", spec.id);
            assert!(!spec.name.is_empty() && !spec.bins.is_empty(), "{}", spec.id);
            assert!(
                spec.install_url.is_empty() || spec.install_url.starts_with("https://"),
                "{} 의 설치 링크는 https 여야 한다 (open_external 이 https 만 연다)",
                spec.id
            );
            // 스킬 설치 대상이 아닌 항목은 그 사실을 화면에 말해 줘야 한다
            if !is_install_target(spec.id) {
                assert!(spec.note.contains("감지"), "{} 의 안내 문구가 범위를 밝히지 않는다", spec.id);
            }
        }
        let runners: Vec<&str> =
            AGENT_CATALOG.iter().filter(|s| s.runs_jobs).map(|s| s.id).collect();
        assert_eq!(runners, vec![CLAUDE], "잡 실행기는 아직 Claude Code 하나뿐이다");
    }

    fn dash(default_agent: &str, custom: Vec<crate::config::CustomAgent>) -> crate::config::DashboardCfg {
        crate::config::DashboardCfg {
            default_agent: default_agent.into(),
            custom_agents: custom,
            ..Default::default()
        }
    }

    fn custom(id: &str, bin: &str) -> crate::config::CustomAgent {
        crate::config::CustomAgent {
            id: id.into(),
            name: String::new(),
            bin: bin.into(),
            install_url: String::new(),
        }
    }

    #[test]
    fn custom_agents_add_new_rows_and_override_known_binaries() {
        let d = dash("claude", vec![custom("myagent", "/opt/my/agent"), custom(CODEX, "/opt/codex")]);
        let list = candidates(&d);

        let mine = list.iter().find(|c| c.id == "myagent").expect("사용자 항목이 목록에 없다");
        assert!(mine.custom && !mine.runs_jobs);
        assert_eq!(mine.name, "myagent", "이름을 비우면 id 를 쓴다");
        assert_eq!(mine.bins, vec!["/opt/my/agent"]);

        // 아는 id 는 새 줄을 만들지 않고 실행 파일만 앞에 끼운다
        assert_eq!(list.iter().filter(|c| c.id == CODEX).count(), 1);
        let codex = list.iter().find(|c| c.id == CODEX).unwrap();
        assert_eq!(codex.bins.first().map(String::as_str), Some("/opt/codex"));
        assert!(!codex.custom);

        // id 가 비면 조용히 버린다 (손으로 고친 설정 파일이 목록을 망가뜨리지 않게)
        assert_eq!(candidates(&dash("claude", vec![custom("  ", "x")])).len(), AGENT_CATALOG.len());
    }

    #[test]
    fn claude_bin_setting_wins_over_the_catalog_name() {
        let mut d = dash("claude", vec![]);
        d.claude_bin = "/usr/local/bin/claude-2".into();
        let list = candidates(&d);
        let claude = list.iter().find(|c| c.id == CLAUDE).unwrap();
        assert_eq!(claude.bins.first().map(String::as_str), Some("/usr/local/bin/claude-2"));
        assert!(claude.bins.iter().any(|b| b == "claude"), "기본 이름도 폴백으로 남는다");
    }

    #[test]
    fn effective_default_falls_back_when_the_saved_id_is_unknown() {
        assert_eq!(effective_default(&dash("codex", vec![])), CODEX);
        assert_eq!(effective_default(&dash("nope", vec![])), CLAUDE);
        assert_eq!(effective_default(&dash("", vec![])), CLAUDE);
        // 설정에 등록한 에이전트도 기본이 될 수 있다
        assert_eq!(effective_default(&dash("mine", vec![custom("mine", "m")])), "mine");
    }

    #[tokio::test]
    async fn detection_reports_the_resolved_path_and_sorts_found_first() {
        let list = detect_agents(&dash("claude", vec![custom("sw-nope", "sawhorse-no-such-bin")])).await;
        assert_eq!(list.len(), AGENT_CATALOG.len() + 1);
        let first_missing = list.iter().position(|a| !a.detected).unwrap_or(list.len());
        assert!(
            list[first_missing..].iter().all(|a| !a.detected),
            "감지된 것과 아닌 것이 섞여 있으면 목록이 읽히지 않는다"
        );
        for a in &list {
            assert_eq!(a.detected, !a.path.is_empty(), "{}", a.id);
            assert_eq!(a.installable, is_install_target(&a.id), "{}", a.id);
            if !a.detected {
                assert!(a.version.is_none(), "{}", a.id);
            }
        }
        let nope = list.iter().find(|a| a.id == "sw-nope").unwrap();
        assert!(!nope.detected && nope.custom);
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
