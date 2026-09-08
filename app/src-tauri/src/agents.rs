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

fn agent_home_in(base: &Path, agent: &str) -> PathBuf {
    match agent {
        CODEX => base.join(".codex"),
        _ => base.join(".claude"),
    }
}

pub fn agent_home(agent: &str) -> PathBuf {
    agent_home_in(&home(), agent)
}

/// 이 팩의 Claude Code skills-dir 플러그인이 materialize 되는 폴더.
/// 내장 팩은 `sawhorse` 플러그인 하나를 공유하고, 사용자 팩은 `sawhorse-<id>` 를
/// 각자 받는다 — 결정 1(팩 하나 = 플러그인 하나)의 물리적 실체다. 이 폴더에
/// `.claude-plugin/plugin.json` 이 있으면 Claude Code 가 `sawhorse[@skills-dir]` 로
/// 자동 적재하므로 마켓플레이스 설치 단계가 없다.
fn claude_plugin_home_in(base: &Path, pack: &Pack) -> PathBuf {
    let name = match pack.source {
        crate::packs::PackSource::Builtin => "sawhorse".to_string(),
        crate::packs::PackSource::User => format!("sawhorse-{}", pack.manifest.id),
    };
    agent_home_in(base, CLAUDE).join("skills").join(name)
}

/// 설치·치환의 기준이 되는 콘텐츠 루트. 내장 팩은 번들(또는 저장소)의 plugin/,
/// 사용자 팩은 팩 폴더 자체가 루트다.
fn content_root_of(pack: &Pack) -> PathBuf {
    match pack.source {
        crate::packs::PackSource::Builtin => crate::plugin::resolve_root().unwrap_or_else(|_| {
            pack.dir
                .parent()
                .and_then(|p| p.parent())
                .map(Path::to_path_buf)
                .unwrap_or_else(|| pack.dir.clone())
        }),
        crate::packs::PackSource::User => pack.dir.clone(),
    }
}

/// Codex 가 참조할 콘텐츠 루트 — 사용자 머신에 materialize 된 사본이 최선이고,
/// 없으면 마켓플레이스 설치 경로, 그것도 없으면 번들 경로다.
fn codex_content_root(base: &Path, pack: &Pack) -> PathBuf {
    let materialized = claude_plugin_home_in(base, pack);
    if materialized.is_dir() {
        return materialized;
    }
    if pack.source == crate::packs::PackSource::Builtin {
        let installs = plugin_installs(&crate::plugin::plugin_name().unwrap_or_default());
        if let Some(first) = installs.first() {
            if !first.install_path.is_empty() {
                return PathBuf::from(&first.install_path);
            }
        }
    }
    content_root_of(pack)
}

/// materialize 된 플러그인 트리 안에서 이 팩 스킬의 파일 경로.
/// 내장 팩은 plugin 루트 기준 상대경로(packs/<id>/skills/…)를 그대로 미러링하고,
/// 사용자 팩은 자기 플러그인 루트 바로 아래 skills/ 를 쓴다.
fn claude_skill_target_in(base: &Path, pack: &Pack, name: &str) -> PathBuf {
    let src_root = content_root_of(pack);
    let rel = pack
        .dir
        .strip_prefix(&src_root)
        .map(|p| p.to_path_buf())
        .unwrap_or_default();
    claude_plugin_home_in(base, pack)
        .join(rel)
        .join("skills")
        .join(name)
        .join("SKILL.md")
}

/// Codex 는 플러그인·네임스페이스·`${CLAUDE_PLUGIN_ROOT}` 개념이 없다. 그래서만
/// 파생본을 만든다: 프론트매터를 트리거 안내로 바꾸고, 스크립트 참조를 materialize 된
/// 절대경로로 치환하며, `/sawhorse:skill` 참조를 네임스페이스 없는 `/skill` 로 고친다.
/// Claude Code 는 원본 그대로다 — skills-dir 플러그인이 나머지를 알아서 채운다.
pub fn render_for(agent: &str, name: &str, source: &str, ns: &str, content_root: &Path) -> String {
    if agent != CODEX {
        return source.to_string();
    }
    let normalized = source.replace("\r\n", "\n");
    let body = match crate::vault::split_frontmatter(&normalized) {
        Some(split) => split.after_close.trim_start().to_string(),
        None => normalized.trim_start().to_string(),
    };
    let body = body
        .replace("${CLAUDE_PLUGIN_ROOT}", &content_root.display().to_string())
        .replace(&format!("/{ns}:"), "/");
    format!(
        "# {name}\n\n\
         > sawhorse 워크벤치가 설치한 프롬프트입니다. `/{name}` 으로 실행하세요.\n\
         > 원본: `{ns}` 플러그인의 스킬 `{name}`.\n\n\
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
    skill_status_in(&home(), pack, agent, name)
}

pub fn skill_status_in(base: &Path, pack: &Pack, agent: &str, name: &str) -> SkillStatus {
    let src = match std::fs::read_to_string(source_path(pack, name)) {
        Ok(s) => s,
        Err(_) => {
            return SkillStatus {
                skill: name.into(),
                agent: agent.into(),
                state: SkillState::NoSource,
                target: String::new(),
            };
        }
    };
    let expected = expected_content(base, pack, agent, name, &src);
    let target = match agent {
        CODEX => agent_home_in(base, CODEX)
            .join("prompts")
            .join(format!("{name}.md")),
        _ => claude_skill_target_in(base, pack, name),
    };
    let state = match std::fs::read_to_string(&target) {
        Err(_) => SkillState::Missing,
        Ok(found) if found.replace("\r\n", "\n") == expected.replace("\r\n", "\n") => {
            SkillState::Installed
        }
        Ok(_) => SkillState::Modified,
    };
    SkillStatus {
        skill: name.into(),
        agent: agent.into(),
        state,
        target: target.display().to_string(),
    }
}

/// 에이전트에 실제로 써야 할 내용. Claude 는 원본, Codex 는 render_for 파생본.
fn expected_content(base: &Path, pack: &Pack, agent: &str, name: &str, src: &str) -> String {
    match agent {
        CODEX => {
            let root = codex_content_root(base, pack);
            render_for(agent, name, src, &crate::packs::namespace(pack), &root)
        }
        _ => src.to_string(),
    }
}

pub fn pack_skill_status(pack: &Pack, agent: &str) -> Vec<SkillStatus> {
    pack.manifest
        .skills
        .iter()
        .map(|s| skill_status(pack, agent, s))
        .collect()
}

// ---------- 설치 ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub installed: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

/// `src` 트리를 `dest` 로 통째로 펼친다. 바이트가 같은 파일은 건드리지 않고(멱등),
/// `force` 가 아니면 내용이 다른 파일(사용자 수정본)은 남긴다.
fn materialize_tree(
    src_root: &Path,
    dest_root: &Path,
    force: bool,
) -> Result<InstallReport, String> {
    let mut report = InstallReport::default();
    copy_rec(src_root, src_root, dest_root, force, &mut report)?;
    Ok(report)
}

const MATERIALIZE_SKIP: &[&str] = &[".DS_Store", "Thumbs.db"];

fn copy_rec(
    root: &Path,
    dir: &Path,
    dest_root: &Path,
    force: bool,
    report: &mut InstallReport,
) -> Result<(), String> {
    let rd = std::fs::read_dir(dir).map_err(|e| format!("{} 읽기 실패: {e}", dir.display()))?;
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for from in entries {
        let name = from
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if MATERIALIZE_SKIP.contains(&name.as_str()) {
            continue;
        }
        let rel = from.strip_prefix(root).unwrap_or(&from).to_path_buf();
        let to = dest_root.join(&rel);
        if from.is_dir() {
            std::fs::create_dir_all(&to).map_err(|e| format!("{} 생성 실패: {e}", to.display()))?;
            copy_rec(root, &from, dest_root, force, report)?;
            continue;
        }
        let bytes =
            std::fs::read(&from).map_err(|e| format!("{} 읽기 실패: {e}", rel.display()))?;
        if let Ok(found) = std::fs::read(&to) {
            if found == bytes {
                report.skipped.push(format!("{}: 이미 최신", rel.display()));
                continue;
            }
            if !force {
                report.skipped.push(format!(
                    "{}: 수정된 파일이 있어 건드리지 않음",
                    rel.display()
                ));
                continue;
            }
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("{} 생성 실패: {e}", parent.display()))?;
        }
        match std::fs::write(&to, &bytes) {
            Ok(()) => report.installed.push(rel.display().to_string()),
            Err(e) => report
                .failed
                .push(format!("{}: 쓰기 실패 ({e})", rel.display())),
        }
    }
    Ok(())
}

/// 사용자 팩 폴더가 skills-dir 플러그인으로 로드되게 하는 최소 매니페스트.
/// 앱이 소유한 파일이라 매 설치마다 정본으로 다시 쓴다. 바뀌었으면 true.
fn write_user_plugin_manifest(dest_root: &Path, id: &str) -> Result<bool, String> {
    let dir = dest_root.join(".claude-plugin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("폴더 생성 실패: {e}"))?;
    let body = serde_json::json!({
        "name": format!("sawhorse-{id}"),
        "description": format!("sawhorse 사용자 팩 `{id}`"),
        "skills": ["./skills"],
    });
    let text = format!(
        "{}\n",
        serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?
    );
    let path = dir.join("plugin.json");
    let unchanged = match std::fs::read_to_string(&path) {
        Ok(s) => s.replace("\r\n", "\n") == text,
        Err(_) => false,
    };
    if unchanged {
        return Ok(false);
    }
    crate::config::write_atomic(&path, text.as_bytes())
        .map_err(|e| format!("plugin.json 쓰기 실패: {e}"))?;
    Ok(true)
}

/// 팩의 스킬을 에이전트에 넣는다.
///
/// * Claude Code — 개인 스킬 사본을 만들지 않고 **플러그인을 materialize** 한다.
///   내장 팩은 플러그인 전체(~/.claude/skills/sawhorse)를, 사용자 팩은 자기 폴더를
///   sawhorse-<id> 로 펼치고 최소 plugin.json 을 생성한다. 마켓플레이스 설치가
///   감지되면 내장 팩의 사본은 만들지 않는다(중복 커맨드 방지).
/// * Codex — 스킬마다 프롬프트 파일 하나(~/.codex/prompts/<name>.md).
pub fn install_pack_skills(pack: &Pack, agent: &str, force: bool) -> Result<InstallReport, String> {
    install_pack_skills_in(&home(), pack, agent, force)
}

pub fn install_pack_skills_in(
    base: &Path,
    pack: &Pack,
    agent: &str,
    force: bool,
) -> Result<InstallReport, String> {
    if !is_install_target(agent) {
        return Err(format!("{agent} 에는 스킬을 설치할 수 없습니다"));
    }
    if agent == CODEX {
        let mut report = InstallReport::default();
        for name in &pack.manifest.skills {
            let src = match std::fs::read_to_string(source_path(pack, name)) {
                Ok(s) => s,
                Err(_) => {
                    report
                        .failed
                        .push(format!("{name}: 팩에 SKILL.md 가 없습니다"));
                    continue;
                }
            };
            let expected = expected_content(base, pack, agent, name, &src);
            let target = agent_home_in(base, CODEX)
                .join("prompts")
                .join(format!("{name}.md"));
            write_if_needed(&target, expected.as_bytes(), force, name, &mut report);
        }
        return Ok(report);
    }

    // Claude Code: skills-dir 플러그인 materialize
    if pack.source == crate::packs::PackSource::Builtin {
        let installs = plugin_installs(&crate::plugin::plugin_name().unwrap_or_default());
        if !installs.is_empty() {
            return Ok(InstallReport {
                skipped: vec![format!(
                    "마켓플레이스 설치 감지({}) — 앱 사본을 만들지 않는다",
                    installs
                        .iter()
                        .map(|i| format!("{} v{}", i.key, i.version))
                        .collect::<Vec<_>>()
                        .join(", ")
                )],
                ..Default::default()
            });
        }
    }
    let dest = claude_plugin_home_in(base, pack);
    let src_root = content_root_of(pack);
    let mut report = materialize_tree(&src_root, &dest, force)?;
    if pack.source == crate::packs::PackSource::User
        && write_user_plugin_manifest(&dest, &pack.manifest.id)?
    {
        report.installed.push(".claude-plugin/plugin.json".into());
    }
    Ok(report)
}

fn write_if_needed(
    target: &Path,
    expected: &[u8],
    force: bool,
    name: &str,
    report: &mut InstallReport,
) {
    if let Ok(found) = std::fs::read(&target) {
        if found == expected {
            report.skipped.push(format!("{name}: 이미 최신"));
            return;
        }
        if !force {
            report
                .skipped
                .push(format!("{name}: 수정된 파일이 있어 건너뜀"));
            return;
        }
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            report.failed.push(format!("{name}: 폴더 생성 실패 ({e})"));
            return;
        }
    }
    match crate::config::write_atomic(target, expected) {
        Ok(()) => report.installed.push(name.to_string()),
        Err(e) => report.failed.push(format!("{name}: 쓰기 실패 ({e})")),
    }
}

/// 우리가 넣은 그대로인 것만 지운다 — 사용자가 고친 것은 남긴다.
/// Claude 는 내장 팩끼리 플러그인 하나를 공유하므로 이 팩의 skills/ 만 파낸다.
pub fn uninstall_pack_skills(pack: &Pack, agent: &str) -> Result<InstallReport, String> {
    uninstall_pack_skills_in(&home(), pack, agent)
}

pub fn uninstall_pack_skills_in(
    base: &Path,
    pack: &Pack,
    agent: &str,
) -> Result<InstallReport, String> {
    if !is_install_target(agent) {
        return Err(format!("{agent} 에는 설치된 스킬이 없습니다"));
    }
    let mut report = InstallReport::default();
    if agent == CLAUDE && pack.source == crate::packs::PackSource::User {
        let dest = claude_plugin_home_in(base, pack);
        if dest.is_dir() && std::fs::remove_dir_all(&dest).is_ok() {
            report
                .installed
                .push(format!("sawhorse-{} (플러그인 폴더)", pack.manifest.id));
        } else {
            report.skipped.push("설치되어 있지 않음".into());
        }
        return Ok(report);
    }
    for name in &pack.manifest.skills {
        match skill_status_in(base, pack, agent, name).state {
            SkillState::Installed => {
                let target = match agent {
                    CODEX => agent_home_in(base, CODEX)
                        .join("prompts")
                        .join(format!("{name}.md")),
                    _ => claude_skill_target_in(base, pack, name),
                };
                let removed = std::fs::remove_file(&target).is_ok();
                if removed {
                    // 빈 폴더를 남기지 않는다
                    if let Some(parent) = target.parent() {
                        let _ = std::fs::remove_dir(parent);
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
    /// 앱이 이 에이전트로 잡을 **직접** 돌릴 수 있는가. SDD 실행은 Herdr의
    /// 공통 agent protocol을 쓰므로 Herdr가 지원하는 kind라면 true다.
    pub runs_jobs: bool,
    pub note: &'static str,
}

/// Herdr로 실행할 수 있지만 Sawhorse 스킬을 직접 설치하지는 못하는 에이전트 안내.
const HERDR_ONLY: &str =
    "Herdr에서 작업을 실행할 수 있습니다. 전용 스킬 설치 형식은 아직 없습니다.";
const DETECT_ONLY: &str = "감지까지만 합니다 — Herdr가 지원하는 에이전트 종류가 아닙니다.";

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
        runs_jobs: true,
        note: "스킬은 ~/.codex/prompts 의 슬래시 프롬프트로 변환되어 설치됩니다.",
    },
    AgentSpec {
        id: "opencode",
        name: "opencode",
        bins: &["opencode"],
        install_url: "https://opencode.ai",
        install_hint: "npm install -g opencode-ai",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "gemini",
        name: "Gemini CLI",
        bins: &["gemini"],
        install_url: "https://github.com/google-gemini/gemini-cli",
        install_hint: "npm install -g @google/gemini-cli",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "amp",
        name: "Amp",
        bins: &["amp"],
        install_url: "https://ampcode.com",
        install_hint: "npm install -g @sourcegraph/amp",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "copilot",
        name: "GitHub Copilot CLI",
        bins: &["copilot"],
        install_url: "https://github.com/github/copilot-cli",
        install_hint: "npm install -g @github/copilot",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "cursor",
        name: "Cursor CLI",
        bins: &["cursor-agent"],
        install_url: "https://cursor.com/cli",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
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
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "droid",
        name: "Factory Droid",
        bins: &["droid"],
        install_url: "https://docs.factory.ai/cli/getting-started/quickstart",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "omp",
        name: "Oh My Pi",
        bins: &["omp"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "pi",
        name: "pi",
        bins: &["pi", "oxipi", "pi-new"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "devin",
        name: "Devin CLI",
        bins: &["devin"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "agy",
        name: "Agy",
        bins: &["agy"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "cline",
        name: "Cline CLI",
        bins: &["cline"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "mastracode",
        name: "Mastra Code",
        bins: &["mastracode"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "kimi",
        name: "Kimi CLI",
        bins: &["kimi"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "kiro",
        name: "Kiro CLI",
        bins: &["kiro"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "grok",
        name: "Grok CLI",
        bins: &["grok"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "hermes",
        name: "Hermes",
        bins: &["hermes"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "kilo",
        name: "Kilo Code",
        bins: &["kilo"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "qodercli",
        name: "Qoder CLI",
        bins: &["qodercli"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "maki",
        name: "Maki",
        bins: &["maki"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
    AgentSpec {
        id: "muse",
        name: "Muse",
        bins: &["muse"],
        install_url: "",
        install_hint: "",
        runs_jobs: true,
        note: HERDR_ONLY,
    },
];

// ---------- 모델 카탈로그 ----------

/// 카탈로그가 내보낼 모델 하나.
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
}

/// 에이전트별 모델 정본. CLI 라인업은 앱 업데이트 때 바뀌는 값이므로 이 줄이
/// 정본이다. 사용자가 최근에 실제로 쓴 모델은 실행 기록(runs/)에서 수집해
/// 이 카탈로그 뒤에 붙인다 — 두 출처의 합이 화면의 선택지다.
pub const MODEL_CATALOGS: &[(&str, &[ModelSpec])] = &[
    (
        CLAUDE,
        &[
            ModelSpec {
                id: "opus",
                label: "Opus (alias)",
            },
            ModelSpec {
                id: "sonnet",
                label: "Sonnet (alias)",
            },
            ModelSpec {
                id: "fable",
                label: "Fable (alias)",
            },
            ModelSpec {
                id: "haiku",
                label: "Haiku (alias)",
            },
        ],
    ),
    (
        CODEX,
        &[
            ModelSpec {
                id: "gpt-5.1-codex-max",
                label: "GPT-5.1 Codex Max",
            },
            ModelSpec {
                id: "gpt-5.1-codex",
                label: "GPT-5.1 Codex",
            },
            ModelSpec {
                id: "gpt-5-codex",
                label: "GPT-5 Codex",
            },
            ModelSpec {
                id: "o3",
                label: "o3",
            },
        ],
    ),
];

pub fn normalize_id(id: &str) -> &str {
    match id.trim() {
        // 0.1 계열 설정에서 쓴 id를 Herdr의 canonical kind로 읽는다.
        "cursor-agent" => "cursor",
        other => other,
    }
}

pub fn spec(id: &str) -> Option<&'static AgentSpec> {
    let id = normalize_id(id);
    AGENT_CATALOG.iter().find(|s| s.id == id)
}

pub fn can_run_jobs(id: &str) -> bool {
    spec(id).is_some_and(|agent| agent.runs_jobs)
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
        let id = normalize_id(&c.id);
        if id.is_empty() {
            continue;
        }
        let bin = if c.bin.trim().is_empty() {
            id
        } else {
            c.bin.trim()
        };
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
            name: if c.name.trim().is_empty() {
                id.into()
            } else {
                c.name.trim().into()
            },
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
    let probes: Vec<(PathBuf, &'static [&'static str])> = found
        .iter()
        .flatten()
        .map(|p| (p.clone(), VERSION_ARGS))
        .collect();
    let mut versions = crate::detect::versions_of(probes).await.into_iter();

    let mut out: Vec<AgentPresence> = cands
        .into_iter()
        .zip(found)
        .map(|(c, path)| {
            let version = if path.is_some() {
                versions.next().flatten()
            } else {
                None
            };
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

/// 설정의 기본 에이전트를 실제로 쓸 수 있는 값으로 바꾼다. 저장값이 현재 PC에 없으면
/// 감지된 로컬 실행기를 고르고, 아무것도 감지되지 않았을 때만 안전한 레거시 값으로
/// 떨어진다. 설정 파일은 손으로도 고쳐지므로 읽는 쪽이 항상 정상값을 받게 한다.
pub fn effective_default(dash: &crate::config::DashboardCfg, detected: &[AgentPresence]) -> String {
    let want = normalize_id(&dash.default_agent);
    if let Some(saved) = detected
        .iter()
        .find(|agent| agent.id == want && agent.detected && agent.runs_jobs)
    {
        return saved.id.clone();
    }

    // 앱 번들 안의 보조 CLI보다 사용자가 PATH에 설치한 에이전트를 먼저 쓴다.
    // 예: ChatGPT.app이 제공하는 codex와 ~/.bun/bin/omp가 함께 있을 때는 omp.
    let runnable = detected
        .iter()
        .filter(|agent| agent.detected && agent.runs_jobs);
    if let Some(local) = runnable
        .clone()
        .find(|agent| !agent.path.contains(".app/Contents/Resources/"))
    {
        return local.id.clone();
    }
    if let Some(first) = runnable.into_iter().next() {
        return first.id.clone();
    }

    // 오프라인/초기 감지 실패 때도 저장값을 잃지는 않는다.
    if can_run_jobs(want) {
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
    agent_home(CLAUDE)
        .join("plugins")
        .join("installed_plugins.json")
}

/// 같은 스킬이 플러그인으로도 설치돼 있으면 개인 스킬 설치를 권하지 않는다
/// (중복 등록은 슬래시 커맨드가 두 벌 뜨는 혼란을 만든다).
pub fn plugin_installs_at(path: &Path, plugin_name: &str) -> Vec<PluginInstall> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    let Some(map) = v.get("plugins").and_then(|p| p.as_object()) else {
        return vec![];
    };
    let prefix = format!("{plugin_name}@");
    map.iter()
        .filter(|(k, _)| k.starts_with(&prefix) || k.as_str() == plugin_name)
        .filter_map(|(k, entries)| {
            let first = entries.as_array()?.first()?;
            Some(PluginInstall {
                key: k.clone(),
                version: first
                    .get("version")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .into(),
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
        let root = Path::new("/tmp/claude-root");
        let body = "---\nname: morning\ndescription: 아침\n---\n\n`node ${CLAUDE_PLUGIN_ROOT}/scripts/x.mjs` 실행. `/sawhorse:morning` 참고.\n";
        let out = render_for(CODEX, "morning", body, "sawhorse", root);
        assert!(!out.contains("description:"), "프론트매터가 남으면 안 된다");
        assert!(out.starts_with("# morning"));
        assert!(out.contains("`/morning`"));
        // 설계 7: ${CLAUDE_PLUGIN_ROOT} 는 materialize 된 절대경로로 치환된다
        assert!(out.contains("/tmp/claude-root/scripts/x.mjs"), "{out}");
        assert!(!out.contains("CLAUDE_PLUGIN_ROOT"), "{out}");
        // 설계 Codex 규칙: 네임스페이스가 없으므로 /sawhorse:morning → /morning
        assert!(out.contains("`/morning` 참고"), "{out}");
        assert!(!out.contains("sawhorse:morning"), "{out}");
        assert!(out.contains("실행"), "본문이 살아 있다");
        // Claude 는 원본 그대로
        assert_eq!(render_for(CLAUDE, "morning", src, "sawhorse", root), src);
    }

    #[test]
    fn install_roundtrip_respects_user_edits() {
        let packdir = tempdir("pack");
        let fakehome = tempdir("home");
        let pack = fake_pack(&packdir, &[("alpha", "---\nname: alpha\n---\n첫 판\n")]);

        // 사용자 팩 → 자기 skills-dir 플러그인(sawhorse-demo) 으로 materialize
        let r = install_pack_skills_in(&fakehome, &pack, CLAUDE, false).unwrap();
        assert_eq!(r.installed.len(), 2, "SKILL.md + 생성된 plugin.json: {r:?}");
        let plugin_dir = fakehome.join(".claude/skills/sawhorse-demo");
        assert_eq!(
            fs::read_to_string(plugin_dir.join("skills/alpha/SKILL.md")).unwrap(),
            "---\nname: alpha\n---\n첫 판\n"
        );
        let manifest = fs::read_to_string(plugin_dir.join(".claude-plugin/plugin.json")).unwrap();
        assert!(
            manifest.contains("sawhorse-demo"),
            "스킬 디렉터리 플러그인 이름: {manifest}"
        );
        // 설치 상태는 materialize 된 파일을 본다
        assert_eq!(
            skill_status_in(&fakehome, &pack, CLAUDE, "alpha").state,
            SkillState::Installed
        );

        // 소스를 고친 뒤 force 없이 → 수정본으로 남기고 건너뜀
        fs::write(
            packdir.join("skills/alpha/SKILL.md"),
            "---\nname: alpha\n---\n둘째 판\n",
        )
        .unwrap();
        let r2 = install_pack_skills_in(&fakehome, &pack, CLAUDE, false).unwrap();
        assert!(
            r2.skipped.iter().any(|s| s.contains("수정된 파일")),
            "{r2:?}"
        );
        assert_eq!(
            skill_status_in(&fakehome, &pack, CLAUDE, "alpha").state,
            SkillState::Modified
        );
        // force 면 갱신한다
        let r3 = install_pack_skills_in(&fakehome, &pack, CLAUDE, true).unwrap();
        assert!(r3.installed.iter().any(|s| s.contains("alpha")), "{r3:?}");

        let rc = install_pack_skills_in(&fakehome, &pack, CODEX, false).unwrap();
        assert_eq!(rc.installed, vec!["alpha"]);
        // Codex 는 프롬프트 파일 하나 — 네임스페이스 제거 + 루트 치환이 적용된 본문
        let codex = fs::read_to_string(fakehome.join(".codex/prompts/alpha.md")).unwrap();
        assert!(codex.starts_with("# alpha"));
        assert!(codex.contains("둘째 판"), "갱신된 본문이 반영된다: {codex}");
        assert_eq!(
            skill_status_in(&fakehome, &pack, CODEX, "alpha").state,
            SkillState::Installed
        );

        // 소스가 없으면 NoSource
        let empty = fake_pack(&tempdir("empty"), &[]);
        let mut p = empty.clone();
        p.manifest.skills = vec!["nope".into()];
        assert_eq!(
            skill_status_in(&fakehome, &p, CLAUDE, "nope").state,
            SkillState::NoSource
        );

        // 설치 대상이 아닌 에이전트는 거절
        assert!(install_pack_skills(&pack, "opencode", false).is_err());
        assert!(uninstall_pack_skills(&pack, "opencode").is_err());

        // 사용자 팩 제거는 플러그인 폴더째 — 남겨진 수정본도 같이 가진다(폴더 주인이 앱)
        let ru = uninstall_pack_skills_in(&fakehome, &pack, CLAUDE).unwrap();
        assert!(
            ru.installed.iter().any(|s| s.contains("sawhorse-demo")),
            "{ru:?}"
        );
        assert!(!plugin_dir.exists());

        fs::remove_dir_all(&packdir).unwrap();
        fs::remove_dir_all(&fakehome).unwrap();
    }

    #[test]
    fn skill_targets_differ_per_agent() {
        let packdir = tempdir("pack");
        let fakehome = tempdir("home");
        let pack = fake_pack(&packdir, &[("alpha", "본문")]);
        // 사용자 팩: ~/.claude/skills/sawhorse-<id>/ 바로 아래 skills/
        let c = claude_skill_target_in(&fakehome, &pack, "alpha");
        assert!(
            c.ends_with(".claude/skills/sawhorse-demo/skills/alpha/SKILL.md"),
            "{c:?}"
        );
        // Codex: 프롬프트 파일 하나
        let x = agent_home_in(&fakehome, CODEX).join("prompts/alpha.md");
        assert!(x.ends_with(".codex/prompts/alpha.md"), "{x:?}");
        assert!(
            is_install_target(CLAUDE) && is_install_target(CODEX) && !is_install_target("opencode")
        );
        fs::remove_dir_all(&packdir).unwrap();
        fs::remove_dir_all(&fakehome).unwrap();
    }

    #[test]
    fn catalog_is_well_formed_and_covers_herdr_agents() {
        let mut seen = std::collections::BTreeSet::new();
        for spec in AGENT_CATALOG {
            assert!(seen.insert(spec.id), "id 가 겹친다: {}", spec.id);
            assert!(
                !spec.name.is_empty() && !spec.bins.is_empty(),
                "{}",
                spec.id
            );
            assert!(
                spec.install_url.is_empty() || spec.install_url.starts_with("https://"),
                "{} 의 설치 링크는 https 여야 한다 (open_external 이 https 만 연다)",
                spec.id
            );
            // 스킬 설치 대상이 아닌 항목은 실행 또는 감지 범위를 화면에 말해 줘야 한다.
            if !is_install_target(spec.id) {
                assert!(
                    spec.note.contains("Herdr"),
                    "{} 의 안내 문구가 범위를 밝히지 않는다",
                    spec.id
                );
            }
        }
        for kind in [
            "pi",
            "claude",
            "codex",
            "gemini",
            "cursor",
            "devin",
            "agy",
            "cline",
            "omp",
            "mastracode",
            "opencode",
            "copilot",
            "kimi",
            "kiro",
            "droid",
            "amp",
            "grok",
            "hermes",
            "kilo",
            "qodercli",
            "qwen",
            "maki",
            "muse",
        ] {
            assert!(
                can_run_jobs(kind),
                "Herdr kind가 카탈로그에서 빠졌다: {kind}"
            );
        }
    }

    fn dash(
        default_agent: &str,
        custom: Vec<crate::config::CustomAgent>,
    ) -> crate::config::DashboardCfg {
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
        let d = dash(
            "claude",
            vec![
                custom("myagent", "/opt/my/agent"),
                custom(CODEX, "/opt/codex"),
            ],
        );
        let list = candidates(&d);

        let mine = list
            .iter()
            .find(|c| c.id == "myagent")
            .expect("사용자 항목이 목록에 없다");
        assert!(mine.custom && !mine.runs_jobs);
        assert_eq!(mine.name, "myagent", "이름을 비우면 id 를 쓴다");
        assert_eq!(mine.bins, vec!["/opt/my/agent"]);

        // 아는 id 는 새 줄을 만들지 않고 실행 파일만 앞에 끼운다
        assert_eq!(list.iter().filter(|c| c.id == CODEX).count(), 1);
        let codex = list.iter().find(|c| c.id == CODEX).unwrap();
        assert_eq!(codex.bins.first().map(String::as_str), Some("/opt/codex"));
        assert!(!codex.custom);

        // id 가 비면 조용히 버린다 (손으로 고친 설정 파일이 목록을 망가뜨리지 않게)
        assert_eq!(
            candidates(&dash("claude", vec![custom("  ", "x")])).len(),
            AGENT_CATALOG.len()
        );
    }

    #[test]
    fn claude_bin_setting_wins_over_the_catalog_name() {
        let mut d = dash("claude", vec![]);
        d.claude_bin = "/usr/local/bin/claude-2".into();
        let list = candidates(&d);
        let claude = list.iter().find(|c| c.id == CLAUDE).unwrap();
        assert_eq!(
            claude.bins.first().map(String::as_str),
            Some("/usr/local/bin/claude-2")
        );
        assert!(
            claude.bins.iter().any(|b| b == "claude"),
            "기본 이름도 폴백으로 남는다"
        );
    }

    #[test]
    fn effective_default_prefers_an_installed_runner() {
        let presence = |id: &str, path: &str| AgentPresence {
            id: id.into(),
            name: id.into(),
            detected: true,
            version: None,
            path: path.into(),
            home: String::new(),
            installable: is_install_target(id),
            runs_jobs: can_run_jobs(id),
            install_url: String::new(),
            install_hint: String::new(),
            custom: false,
            note: String::new(),
        };
        let installed = vec![
            presence(CODEX, "/Applications/ChatGPT.app/Contents/Resources/codex"),
            presence("omp", "/Users/me/.bun/bin/omp"),
        ];
        assert_eq!(effective_default(&dash("codex", vec![]), &installed), CODEX);
        assert_eq!(
            effective_default(&dash("claude", vec![]), &installed),
            "omp"
        );
        assert_eq!(effective_default(&dash("", vec![]), &installed), "omp");
        assert_eq!(effective_default(&dash("nope", vec![]), &[]), CLAUDE);
        assert_eq!(normalize_id("cursor-agent"), "cursor");
    }

    #[tokio::test]
    async fn detection_reports_the_resolved_path_and_sorts_found_first() {
        let list = detect_agents(&dash(
            "claude",
            vec![custom("sw-nope", "sawhorse-no-such-bin")],
        ))
        .await;
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
