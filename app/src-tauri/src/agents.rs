// agents.rs — agent bridge.
//
// Dependency inversion, in the flesh: the app treats agents as **installation targets**. It used to be
// that plugins had to be installed before the app was any use; now the app puts the pack's skills into the agent.
//
// Install-state detection is a file byte comparison. Keeping a separate hash ledger would make the app
// mistake a hand-edited skill for one it installed and quietly overwrite it. If the bytes differ the
// state is `수정됨` (modified), and modified files are not removed.
//
// Detection covers more than the two agents that can receive skills (Claude Code, Codex). The wizard's job
// is to list the CLIs the user runs and let them pick a default, so agents we cannot install skills into
// also stay in the catalog — instead, each entry states its own scope in its note.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::packs::Pack;

// ---------- Install-target agents ----------

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";

/// Canonical list of skill install-target agents. Status queries and the UI read it in this order —
/// adding a target means growing this one line; the schema and UI stay unchanged.
pub fn install_targets() -> &'static [&'static str] {
    &[CLAUDE, CODEX]
}

/// Can this agent receive skill installs? The rest of the catalog is detection-only.
pub fn is_install_target(agent: &str) -> bool {
    install_targets().contains(&agent)
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

/// The folder where this pack's Claude Code skills-dir plugin materializes.
/// Builtin packs share one `sawhorse` plugin; user packs each get their own
/// `sawhorse-<id>` — the physical embodiment of decision 1 (one pack = one plugin). With
/// `.claude-plugin/plugin.json` in this folder, Claude Code loads it automatically as
/// `sawhorse[@skills-dir]`, so there is no marketplace install step.
fn claude_plugin_home_in(base: &Path, pack: &Pack) -> PathBuf {
    let name = match pack.source {
        crate::packs::PackSource::Builtin => "sawhorse".to_string(),
        crate::packs::PackSource::User => format!("sawhorse-{}", pack.manifest.id),
    };
    agent_home_in(base, CLAUDE).join("skills").join(name)
}

/// The content root that installs and substitutions are based on. Builtin packs use the plugin/
/// directory of the bundle (or repository); for user packs the pack folder itself is the root.
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

/// Content root for Codex to reference — the copy materialized on the user's machine is best;
/// otherwise the marketplace install path, and failing that, the bundle path.
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

/// File path of this pack's skill inside the materialized plugin tree.
/// Builtin packs mirror their plugin-root-relative path (packs/<id>/skills/…) as is;
/// user packs use skills/ directly under their own plugin root.
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

/// Codex has no concept of plugins, namespaces, or `${CLAUDE_PLUGIN_ROOT}`. Only for it
/// do we build a derivative: the frontmatter becomes a trigger hint, script references are replaced
/// with materialized absolute paths, and `/sawhorse:skill` references are rewritten to namespace-free `/skill`.
/// Claude Code gets the original as is — the skills-dir plugin fills in the rest.
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
         > Sawhorse가 설치한 프롬프트입니다. `/{name}` 으로 실행하세요.\n\
         > 원본: `{ns}` 플러그인의 스킬 `{name}`.\n\n\
         {body}"
    )
}

// ---------- State ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkillState {
    /// Installed + content identical
    Installed,
    /// File exists but its content differs (user edited it, or the pack was updated)
    Modified,
    Missing,
    /// Pack declares the name but ships no SKILL.md
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

/// What should actually be written to the agent. Claude gets the original; Codex gets the render_for derivative.
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

// ---------- Install ----------

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub installed: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

/// Expands the whole `src` tree into `dest`. Files with identical bytes are left untouched (idempotent);
/// unless `force` is set, files with different content (user modifications) are left alone.
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

/// Minimal manifest that makes a user pack folder load as a skills-dir plugin.
/// The app owns this file, so it is rewritten to the canonical copy on every install. True if it changed.
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

/// Installs the pack's skills into an agent.
///
/// * Claude Code — **materializes the plugin** instead of making personal skill copies.
///   Builtin packs expand the whole plugin (~/.claude/skills/sawhorse) and user packs expand their
///   own folder as sawhorse-<id>, generating a minimal plugin.json. When a marketplace install is
///   detected, no copy of the builtin pack is made (avoids duplicate commands).
/// * Codex — one prompt file per skill (~/.codex/prompts/<name>.md).
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

    // Claude Code: materialize the skills-dir plugin
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

/// Removes only files that are exactly what we wrote — user modifications stay.
/// Claude shares one plugin across builtin packs, so this digs out only this pack's skills/.
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
                    // Do not leave an empty folder behind
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

// ---------- Browsing skills installed in an agent ----------

/// One skill actually found in an agent's folder. Unlike pack state (`SkillStatus`), it ignores
/// provenance — skills added via npx skills or by hand all show up.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillEntry {
    pub name: String,
    pub description: String,
    pub path: String,
    /// Name of the top-level folder (plugin/collection) the skill belongs to. Empty for skills
    /// directly under home; Codex slash prompts use "prompts".
    pub group: String,
    /// Whether sawhorse materialized this copy
    pub managed: bool,
}

/// Pulls the single `description:` line out of the frontmatter. For the browse list, a missing
/// description stays an empty string.
fn frontmatter_description(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            return rest
                .trim()
                .trim_matches(|c| c == '"' || c == '\'')
                .to_string();
        }
    }
    String::new()
}

fn push_skill_md(entries: &mut Vec<AgentSkillEntry>, skill_md: &Path, group: &str, managed: bool) {
    let Some(name) = skill_md
        .parent()
        .and_then(Path::file_name)
        .map(|n| n.to_string_lossy().to_string())
    else {
        return;
    };
    let description = std::fs::read_to_string(skill_md)
        .map(|s| frontmatter_description(&s))
        .unwrap_or_default();
    entries.push(AgentSkillEntry {
        name,
        description,
        path: skill_md.display().to_string(),
        group: group.into(),
        managed,
    });
}

/// Walks down looking for `SKILL.md`. Plugin trees can get deep, so only the depth is limited.
fn walk_skill_md(
    dir: &Path,
    group: &str,
    managed: bool,
    depth: u8,
    entries: &mut Vec<AgentSkillEntry>,
) {
    if depth > 4 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    paths.sort();
    for p in paths {
        if !p.is_dir() {
            continue;
        }
        let md = p.join("SKILL.md");
        if md.is_file() {
            push_skill_md(entries, &md, group, managed);
        } else {
            walk_skill_md(&p, group, managed, depth + 1, entries);
        }
    }
}

/// Scans `<dir>/*`: a folder with SKILL.md directly inside is one skill; otherwise it is treated
/// as a plugin/collection folder and the SKILL.md files inside are gathered.
fn scan_skills_dir(dir: &Path, entries: &mut Vec<AgentSkillEntry>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut tops: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    tops.sort();
    for top in tops {
        if !top.is_dir() {
            continue;
        }
        let group = top
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let managed = group == "sawhorse" || group.starts_with("sawhorse-");
        let direct = top.join("SKILL.md");
        if direct.is_file() {
            push_skill_md(entries, &direct, "", managed);
        } else {
            walk_skill_md(&top, &group, managed, 0, entries);
        }
    }
}

pub fn list_agent_skills(agent: &str) -> Result<Vec<AgentSkillEntry>, String> {
    list_agent_skills_in(&home(), agent)
}

pub fn list_agent_skills_in(base: &Path, agent: &str) -> Result<Vec<AgentSkillEntry>, String> {
    if !is_install_target(agent) {
        return Err(format!("{agent} 의 스킬 목록 조회는 지원하지 않습니다"));
    }
    let mut entries = Vec::new();
    let home = agent_home_in(base, agent);
    scan_skills_dir(&home.join("skills"), &mut entries);
    if agent == CODEX {
        // Slash prompts the app converted and installed are also part of the browse list.
        if let Ok(rd) = std::fs::read_dir(home.join("prompts")) {
            let mut files: Vec<PathBuf> = rd
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "md"))
                .collect();
            files.sort();
            for f in files {
                let text = std::fs::read_to_string(&f).unwrap_or_default();
                entries.push(AgentSkillEntry {
                    name: f
                        .file_stem()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    description: frontmatter_description(&text),
                    path: f.display().to_string(),
                    group: "prompts".into(),
                    managed: text.contains("sawhorse 워크벤치가 설치한 프롬프트")
                        || text.contains("Sawhorse가 설치한 프롬프트"),
                });
            }
        }
    }
    Ok(entries)
}

/// Keeps the browse UI from reading arbitrary files: only the install-target agents' homes and
/// the `npx skills` shared store (~/.agents) are allowed. A skill in an agent folder may be a
/// symlink into the shared store, so the check uses the canonicalized path.
pub fn read_agent_skill(path: &str) -> Result<String, String> {
    let canon = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("경로를 열 수 없습니다: {e}"))?;
    let allowed = install_targets()
        .iter()
        .map(|a| agent_home(a))
        .chain(std::iter::once(home().join(".agents")))
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canon.starts_with(&root));
    if !allowed {
        return Err("에이전트 폴더 밖의 파일은 열람할 수 없습니다".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > 1024 * 1024 {
        return Err("1MB 를 넘는 파일은 열람하지 않습니다".into());
    }
    std::fs::read_to_string(&canon).map_err(|e| format!("읽기 실패: {e}"))
}

// ---------- Detection ----------

/// What the app knows about one agent. The catalog lives in code; CLIs not listed here are added
/// by the user in settings (`dashboard.customAgents`) — for in-house tools and homegrown agents.
pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    /// Executable names to look for. The first one found wins.
    pub bins: &'static [&'static str],
    /// An empty string means no install location is registered, so the UI shows no install button.
    /// Pointing at nothing beats pretending to know an unknown location.
    pub install_url: &'static str,
    pub install_hint: &'static str,
    /// Whether the app can run jobs **directly** with this agent. SDD runs go through Herdr's
    /// common agent protocol, so this is true for any kind Herdr supports.
    pub runs_jobs: bool,
    pub note: &'static str,
}

/// Note for agents that can run via Herdr but cannot receive Sawhorse skill installs.
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

// ---------- Model catalog ----------

/// One model exported by the catalog.
pub struct ModelSpec {
    pub id: &'static str,
    pub label: &'static str,
}

/// Per-agent model source of truth. CLI lineups change with app updates, so this list is
/// canonical. Models the user has actually used recently are collected from run history (runs/)
/// and appended after this catalog — the union of the two sources is what the UI offers.
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
        // Read ids written by the 0.1-era settings as Herdr's canonical kind.
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
    /// The executable path actually found. Showing which copy was picked on a machine with several
    /// same-named installs lets users sort out "why is an old version showing up" on their own.
    pub path: String,
    pub home: String,
    /// Whether this is a skill install target
    pub installable: bool,
    /// Whether the app can run jobs directly with this agent
    pub runs_jobs: bool,
    pub install_url: String,
    pub install_hint: String,
    /// Whether the user added this entry in settings
    pub custom: bool,
    /// One-line note shown to the user
    pub note: String,
}

/// Intermediate shape that flattens catalog and user entries into the same form.
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
    // The settings' claudeBin outranks the catalog name — that value is the command the job runner invokes.
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
        // For an id the catalog already knows, just prepend the executable — this corrects a wrongly resolved path.
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
    // Probe versions only for found binaries, concurrently. One slow binary never stalls the whole list.
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
    // Show installed ones first. Within a group, the order stays exactly as in the catalog.
    out.sort_by_key(|a| !a.detected);
    out
}

/// Replaces the settings' default agent with a value that is actually usable. If the saved value is
/// missing on this machine, pick a detected local runner and fall back to a safe legacy value only
/// when nothing is detected. The settings file can also be hand-edited, so readers always get a sane value.
pub fn effective_default(dash: &crate::config::DashboardCfg, detected: &[AgentPresence]) -> String {
    let want = normalize_id(&dash.default_agent);
    if let Some(saved) = detected
        .iter()
        .find(|agent| agent.id == want && agent.detected && agent.runs_jobs)
    {
        return saved.id.clone();
    }

    // Prefer an agent the user installed on PATH over helper CLIs inside the app bundle.
    // E.g. when the codex shipped in ChatGPT.app and ~/.bun/bin/omp are both present, pick omp.
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

    // Even when detection fails offline or on first run, the saved value is not lost.
    if can_run_jobs(want) {
        return want.to_string();
    }
    CLAUDE.to_string()
}

// ---------- Claude Code plugin install detection ----------

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

/// Do not recommend personal-skill installs when the same skill is already installed as a plugin
/// (duplicate registration makes two copies of the slash command show up).
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
        // Design 7: ${CLAUDE_PLUGIN_ROOT} is replaced with the materialized absolute path
        assert!(out.contains("/tmp/claude-root/scripts/x.mjs"), "{out}");
        assert!(!out.contains("CLAUDE_PLUGIN_ROOT"), "{out}");
        // Design Codex rule: there are no namespaces, so /sawhorse:morning → /morning
        assert!(out.contains("`/morning` 참고"), "{out}");
        assert!(!out.contains("sawhorse:morning"), "{out}");
        assert!(out.contains("실행"), "본문이 살아 있다");
        // Claude gets the original as is
        assert_eq!(render_for(CLAUDE, "morning", src, "sawhorse", root), src);
    }

    #[test]
    fn install_roundtrip_respects_user_edits() {
        let packdir = tempdir("pack");
        let fakehome = tempdir("home");
        let pack = fake_pack(&packdir, &[("alpha", "---\nname: alpha\n---\n첫 판\n")]);

        // User pack → materialized as its own skills-dir plugin (sawhorse-demo)
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
        // Install state reads the materialized files
        assert_eq!(
            skill_status_in(&fakehome, &pack, CLAUDE, "alpha").state,
            SkillState::Installed
        );

        // After editing the source without force → left as modified and skipped
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
        // With force, update it
        let r3 = install_pack_skills_in(&fakehome, &pack, CLAUDE, true).unwrap();
        assert!(r3.installed.iter().any(|s| s.contains("alpha")), "{r3:?}");

        let rc = install_pack_skills_in(&fakehome, &pack, CODEX, false).unwrap();
        assert_eq!(rc.installed, vec!["alpha"]);
        // Codex gets one prompt file — body with namespace removal + root substitution applied
        let codex = fs::read_to_string(fakehome.join(".codex/prompts/alpha.md")).unwrap();
        assert!(codex.starts_with("# alpha"));
        assert!(codex.contains("둘째 판"), "갱신된 본문이 반영된다: {codex}");
        assert_eq!(
            skill_status_in(&fakehome, &pack, CODEX, "alpha").state,
            SkillState::Installed
        );

        // No source → NoSource
        let empty = fake_pack(&tempdir("empty"), &[]);
        let mut p = empty.clone();
        p.manifest.skills = vec!["nope".into()];
        assert_eq!(
            skill_status_in(&fakehome, &p, CLAUDE, "nope").state,
            SkillState::NoSource
        );

        // Non-install-target agents are rejected
        assert!(install_pack_skills(&pack, "opencode", false).is_err());
        assert!(uninstall_pack_skills(&pack, "opencode").is_err());

        // Uninstalling a user pack removes the whole plugin folder — leftover modified copies go with it (the app owns the folder)
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
        // User pack: skills/ directly under ~/.claude/skills/sawhorse-<id>/
        let c = claude_skill_target_in(&fakehome, &pack, "alpha");
        assert!(
            c.ends_with(".claude/skills/sawhorse-demo/skills/alpha/SKILL.md"),
            "{c:?}"
        );
        // Codex: one prompt file
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
            // Non-install-target entries must state their run or detect scope on screen.
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

        // A known id gets only its executable prepended, no new row
        assert_eq!(list.iter().filter(|c| c.id == CODEX).count(), 1);
        let codex = list.iter().find(|c| c.id == CODEX).unwrap();
        assert_eq!(codex.bins.first().map(String::as_str), Some("/opt/codex"));
        assert!(!codex.custom);

        // Empty ids are silently dropped (so a hand-edited settings file cannot break the list)
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
