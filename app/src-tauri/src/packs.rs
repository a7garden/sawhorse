// packs.rs — the feature-pack ("pack") registry.
//
// A pack is one feature a user can toggle independently: workspace layout + settings schema + run actions +
// screens (views) + agent skills. A pack only declares; it carries no code — rendering, validation, and
// execution are all done by the host. The cap on expressiveness is intentional; skills fill the gaps.
//
// Discovery order: user packs (~/.sawhorse/packs/<id>) > builtin packs (<plugin root>/packs/<id>).
// Every pack owns its own `skills/` — there is no fallback (no plugin-root skills/ lookup). A builtin pack's
// skills are declared by the `skills` array in `plugin/.claude-plugin/plugin.json`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::ConfigView;
use crate::notes::NoteQuery;

pub const MANIFEST: &str = "pack.json";

// ---------- manifest ----------

fn default_icon() -> String {
    "package".into()
}
fn default_cwd() -> String {
    "workspace".into()
}
fn default_view_kind() -> String {
    "notes".into()
}
fn default_field_type() -> String {
    "text".into()
}
fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FileSeed {
    /// Path relative to the pack folder
    pub src: String,
    /// Path relative to the workspace
    pub dest: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct WorkspaceSpec {
    pub folders: Vec<String>,
    pub files: Vec<FileSeed>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Column {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
}

/// Basis for the settings screen's auto-generated form. Values live in config.json under packs.<id>.settings.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SettingField {
    pub key: String,
    /// text | path | number | bool | select | table
    #[serde(rename = "type", default = "default_field_type")]
    pub kind: String,
    pub label: String,
    pub description: String,
    pub placeholder: String,
    pub options: Vec<Choice>,
    pub columns: Vec<Column>,
}

pub const SETTING_TYPES: [&str; 6] = ["text", "path", "number", "bool", "select", "table"];
pub const PARAM_TYPES: [&str; 4] = ["text", "list", "select", "project"];
pub const VIEW_KINDS: [&str; 10] = [
    "notes",
    "native",
    "table",
    "board",
    "form",
    "document",
    "timeline",
    "review-queue",
    "graph",
    "metrics",
];
pub const VIEW_SELECTION_MODES: [&str; 2] = ["none", "multiple"];
/// Sidebar section tags. The host owns the section list and its order; a pack view picks one of these.
/// An empty value sinks the view into the "Other" section at the bottom of the sidebar.
pub const VIEW_GROUPS: [&str; 5] = ["work", "execution", "vault", "reading", "automation"];
pub const SCHEDULE_KINDS: [&str; 2] = ["daily", "weekdays"];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ActionParam {
    pub key: String,
    /// text | list | select | project
    #[serde(rename = "type", default = "default_field_type")]
    pub kind: String,
    pub label: String,
    pub options: Vec<Choice>,
    pub required: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionSchedule {
    /// daily | weekdays
    pub kind: String,
    /// HH:MM
    pub time: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PackAction {
    pub id: String,
    pub label: String,
    pub description: String,
    /// Prompt template with parameters substituted into `{{key}}` slots
    pub prompt: String,
    /// workspace | project | path:<absolute path>
    #[serde(default = "default_cwd")]
    pub cwd: String,
    pub params: Vec<ActionParam>,
    pub schedule: Option<ActionSchedule>,
    /// Whether to surface on the home screen's quick-run card
    pub featured: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ViewColumn {
    /// Frontmatter field name
    pub field: String,
    pub label: String,
    /// "" | "title" | "path" — values taken from the note itself, not from frontmatter
    pub source: String,
    /// text | badge | list | check | date
    #[serde(rename = "type", default = "default_field_type")]
    pub kind: String,
    pub width: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PackView {
    pub id: String,
    pub label: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    /// notes | native
    #[serde(rename = "type", alias = "kind", default = "default_view_kind")]
    pub kind: String,
    /// When kind=native, the name of a screen the app already ships (issues/todos/docs)
    pub component: String,
    /// Sidebar section tag — one of VIEW_GROUPS. Empty means "Other".
    #[serde(default)]
    pub group: String,
    pub query: NoteQuery,
    pub columns: Vec<ViewColumn>,
    pub group_by: String,
    /// none | multiple. multiple passes only the rows checked in table/review-queue to the action.
    pub selection: String,
    /// Ids of the actions runnable from this view
    pub actions: Vec<String>,
    pub empty: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct PackManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    #[serde(default = "default_icon")]
    pub icon: String,
    pub skills: Vec<String>,
    pub workspace: WorkspaceSpec,
    pub settings: Vec<SettingField>,
    pub actions: Vec<PackAction>,
    pub views: Vec<PackView>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn validate_hhmm(s: &str) -> bool {
    let mut it = s.split(':');
    let (Some(h), Some(m), None) = (it.next(), it.next(), it.next()) else {
        return false;
    };
    matches!((h.parse::<u32>(), m.parse::<u32>()), (Ok(h), Ok(m)) if h < 24 && m < 60)
}

impl PackManifest {
    /// A hand-written file, so fix what can be fixed and reject only what cannot.
    pub fn validate(&mut self) -> Result<(), String> {
        if !valid_id(&self.id) {
            return Err(format!(
                "팩 id 가 올바르지 않습니다 (소문자·숫자·하이픈): {:?}",
                self.id
            ));
        }
        if self.name.trim().is_empty() {
            self.name = self.id.clone();
        }
        let mut seen_skills = std::collections::HashSet::new();
        for skill in &self.skills {
            if !valid_id(skill) || !seen_skills.insert(skill) {
                return Err(format!(
                    "스킬 이름이 유효하고 중복되지 않아야 합니다: {skill}"
                ));
            }
        }
        for f in &mut self.settings {
            if f.key.trim().is_empty() {
                return Err("설정 항목에 key 가 없습니다".into());
            }
            if !SETTING_TYPES.contains(&f.kind.as_str()) {
                return Err(format!("알 수 없는 설정 타입: {}", f.kind));
            }
            if f.label.trim().is_empty() {
                f.label = f.key.clone();
            }
        }
        let mut seen_actions = Vec::new();
        for a in &mut self.actions {
            if a.id.trim().is_empty() {
                return Err("액션에 id 가 없습니다".into());
            }
            if seen_actions.contains(&a.id) {
                return Err(format!("액션 id 가 중복입니다: {}", a.id));
            }
            seen_actions.push(a.id.clone());
            if a.prompt.trim().is_empty() {
                return Err(format!("액션 {} 에 prompt 가 없습니다", a.id));
            }
            if a.label.trim().is_empty() {
                a.label = a.id.clone();
            }
            if !(a.cwd == "workspace" || a.cwd == "project" || a.cwd.starts_with("path:")) {
                return Err(format!("알 수 없는 cwd 지정: {}", a.cwd));
            }
            for p in &mut a.params {
                if !PARAM_TYPES.contains(&p.kind.as_str()) {
                    return Err(format!("알 수 없는 파라미터 타입: {}", p.kind));
                }
                if p.label.trim().is_empty() {
                    p.label = p.key.clone();
                }
            }
            if let Some(s) = &a.schedule {
                if !SCHEDULE_KINDS.contains(&s.kind.as_str()) {
                    return Err(format!("알 수 없는 예약 종류: {}", s.kind));
                }
                if !validate_hhmm(&s.time) {
                    return Err(format!("예약 시각 형식이 HH:MM 이 아닙니다: {}", s.time));
                }
            }
        }
        let mut seen_views = Vec::new();
        for v in &mut self.views {
            if v.id.trim().is_empty() {
                return Err("뷰에 id 가 없습니다".into());
            }
            if seen_views.contains(&v.id) {
                return Err(format!("뷰 id 가 중복입니다: {}", v.id));
            }
            seen_views.push(v.id.clone());
            if !VIEW_KINDS.contains(&v.kind.as_str()) {
                return Err(format!("알 수 없는 뷰 종류: {}", v.kind));
            }
            if !v.group.is_empty() && !VIEW_GROUPS.contains(&v.group.as_str()) {
                return Err(format!("알 수 없는 뷰 그룹: {}", v.group));
            }
            if v.selection.is_empty() {
                v.selection = "none".into();
            }
            if !VIEW_SELECTION_MODES.contains(&v.selection.as_str()) {
                return Err(format!("알 수 없는 뷰 선택 방식: {}", v.selection));
            }
            if v.selection == "multiple" && !matches!(v.kind.as_str(), "table" | "review-queue") {
                return Err(format!(
                    "다중 선택은 table/review-queue 뷰에서만 지원합니다: {}",
                    v.id
                ));
            }
            if v.kind == "native" && v.component.trim().is_empty() {
                return Err(format!("네이티브 뷰 {} 에 component 가 없습니다", v.id));
            }
            if v.label.trim().is_empty() {
                v.label = v.id.clone();
            }
            for a in &v.actions {
                if !seen_actions.contains(a) {
                    return Err(format!("뷰 {} 가 없는 액션을 참조합니다: {a}", v.id));
                }
            }
        }
        Ok(())
    }

    pub fn action(&self, id: &str) -> Option<&PackAction> {
        self.actions.iter().find(|a| a.id == id)
    }

    pub fn view(&self, id: &str) -> Option<&PackView> {
        self.views.iter().find(|v| v.id == id)
    }
}

// ---------- discovery ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PackSource {
    /// Pack shipped with the app/repository
    Builtin,
    /// Pack placed by the user under ~/.sawhorse/packs
    User,
}

#[derive(Clone, Debug)]
pub struct Pack {
    pub manifest: PackManifest,
    pub dir: PathBuf,
    /// Where this pack's skill bodies live
    pub skills_dir: PathBuf,
    pub source: PackSource,
    pub enabled: bool,
}

/// A pack whose manifest failed to load. The app still starts; the extensions screen shows the reason.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrokenPack {
    pub dir: String,
    pub error: String,
}

pub fn user_packs_dir() -> PathBuf {
    crate::config::app_home().join("packs")
}

fn read_manifest(path: &Path) -> Result<PackManifest, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("pack.json 읽기 실패: {e}"))?;
    let mut m: PackManifest =
        serde_json::from_str(&text).map_err(|e| format!("pack.json 파싱 실패: {e}"))?;
    m.validate()?;
    Ok(m)
}

fn scan_dir(root: &Path, source: PackSource) -> (Vec<Pack>, Vec<BrokenPack>) {
    let mut ok = Vec::new();
    let mut broken = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return (ok, broken);
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    dirs.sort();
    for dir in dirs {
        let manifest_path = dir.join(MANIFEST);
        if !manifest_path.is_file() {
            continue;
        }
        match read_manifest(&manifest_path) {
            Ok(manifest) => {
                // A pack owns its skills — skills_dir is always inside the pack folder.
                ok.push(Pack {
                    manifest,
                    skills_dir: dir.join("skills"),
                    dir,
                    source,
                    enabled: true,
                });
            }
            Err(error) => broken.push(BrokenPack {
                dir: dir.display().to_string(),
                error,
            }),
        }
    }
    (ok, broken)
}

#[derive(Clone, Debug, Default)]
pub struct Registry {
    pub packs: Vec<Pack>,
    pub broken: Vec<BrokenPack>,
}

impl Registry {
    pub fn enabled(&self) -> impl Iterator<Item = &Pack> {
        self.packs.iter().filter(|p| p.enabled)
    }

    pub fn get(&self, id: &str) -> Option<&Pack> {
        self.packs.iter().find(|p| p.manifest.id == id)
    }

    /// Looks up actions in enabled packs only — if a disabled pack's action were scheduled or run, "disabled" would be a lie.
    pub fn action(&self, pack_id: &str, action_id: &str) -> Option<(&Pack, &PackAction)> {
        let p = self.get(pack_id).filter(|p| p.enabled)?;
        p.manifest.action(action_id).map(|a| (p, a))
    }

    pub fn view(&self, pack_id: &str, view_id: &str) -> Option<(&Pack, &PackView)> {
        let p = self.get(pack_id).filter(|p| p.enabled)?;
        p.manifest.view(view_id).map(|v| (p, v))
    }
}

/// Collects builtin + user packs and settles their enabled state.
/// Empty `enabled` means everything enabled — so screens don't vanish when existing users upgrade.
pub fn load_registry_from(
    builtin_root: Option<&Path>,
    user_root: &Path,
    enabled: &[String],
) -> Registry {
    let mut packs: Vec<Pack> = Vec::new();
    let mut broken: Vec<BrokenPack> = Vec::new();

    if let Some(root) = builtin_root {
        let (ok, bad) = scan_dir(&root.join("packs"), PackSource::Builtin);
        packs.extend(ok);
        broken.extend(bad);
    }
    let (ok, bad) = scan_dir(user_root, PackSource::User);
    broken.extend(bad);
    // Same id: the user pack wins (the customization path)
    for p in ok {
        if let Some(slot) = packs.iter_mut().find(|b| b.manifest.id == p.manifest.id) {
            *slot = p;
        } else {
            packs.push(p);
        }
    }

    // Tauri copies bundled resources into target/{debug,release} but does not remove files
    // deleted from the source directory.  During the feature-pack migration that can leave
    // the retired starter/si bundles beside their replacements, contributing the same
    // journal, concepts and vault navigation a second time.  Ignore only stale *builtin*
    // bundles when the complete replacement set is present; an explicitly installed user
    // pack with either id remains a valid override/custom extension.
    let has_builtin = |id: &str| {
        packs
            .iter()
            .any(|p| p.source == PackSource::Builtin && p.manifest.id == id)
    };
    let journal_replaced = has_builtin("journal");
    let si_replaced = ["concepts", "todos", "project-docs"]
        .iter()
        .all(|id| has_builtin(id));
    packs.retain(|p| {
        p.source != PackSource::Builtin
            || !((p.manifest.id == "starter" && journal_replaced)
                || (p.manifest.id == "si" && si_replaced))
    });

    for p in &mut packs {
        p.enabled = enabled.is_empty()
            || enabled.iter().any(|e| e == &p.manifest.id)
            // Users who enabled a 1.0 workflow bundle move over to per-feature packs naturally.
            // The first toggle save replaces this with the canonical id list.
            || match p.manifest.id.as_str() {
                "journal" => enabled.iter().any(|e| e == "starter" || e == "si"),
                "concepts" | "project-docs" | "todos" => enabled.iter().any(|e| e == "si"),
                _ => false,
            };
    }
    packs.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    Registry { packs, broken }
}

pub fn load_registry(enabled: &[String]) -> Registry {
    let builtin = crate::plugin::resolve_root().ok();
    load_registry_from(builtin.as_deref(), &user_packs_dir(), enabled)
}

/// The namespace this pack's skills run under in the agent.
/// Builtin packs ride on the single `sawhorse` plugin, while user packs install their own skills-dir
/// plugin (`~/.claude/skills/sawhorse-<id>/`), so it differs per pack.
/// `{{ns}}` in `render_prompt` is the only consumer.
pub fn namespace(pack: &Pack) -> String {
    match pack.source {
        PackSource::Builtin => "sawhorse".into(),
        PackSource::User => format!("sawhorse-{}", pack.manifest.id),
    }
}

// ---------- prompts · cwd ----------

/// Substitutes `{{key}}` slots. Lists are joined with spaces.
///
/// Newlines and backticks are stripped **from substituted values only** — some paths deliver the prompt as a
/// single slash-command line, so a newline inside a parameter would truncate the command. The template's own
/// newlines are preserved: packs must be able to write multi-line unattended run instructions.
///
/// `ns` is a reserved variable — if a pack prompt wrote the namespace (`/sawhorse:issues`) directly,
/// cloning a pack would require a bulk rewrite, so prompts write `/{{ns}}:issues` and the render entry point **always**
/// injects it. It is never filled from user parameters (an unfilled `{{…}}` is silently removed, so a missing
/// `ns` would degrade into the broken `/:issues` — the signature prevents this at the source).
pub fn render_prompt(template: &str, ns: &str, params: &Map<String, Value>) -> String {
    let mut out = template.replace("{{ns}}", ns);
    for (k, v) in params {
        let raw = match v {
            Value::String(s) => s.clone(),
            Value::Array(items) => items
                .iter()
                .map(|i| match i {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(" "),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        let cleaned: String = raw
            .chars()
            .map(|c| {
                if c == '\n' || c == '\r' || c == '`' {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        out = out.replace(&format!("{{{{{k}}}}}"), cleaned.trim());
    }
    // unfilled slots leave no trace
    while let Some(start) = out.find("{{") {
        let Some(rel) = out[start..].find("}}") else {
            break;
        };
        out.replace_range(start..start + rel + 2, "");
    }
    // collapse only the double spaces left by empty slots, per line; keep the line structure intact
    out.lines()
        .map(|line| {
            line.split(' ')
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

/// Where an action should run. `project` also accepts the legacy `improve.projects` as compatible input —
/// registering code project paths is already canonical there; falls back to the workspace when absent.
pub fn resolve_cwd(
    action: &PackAction,
    params: &Map<String, Value>,
    view: &ConfigView,
) -> Result<String, String> {
    if let Some(abs) = action.cwd.strip_prefix("path:") {
        let abs = abs.trim();
        if abs.is_empty() {
            return Err("path: cwd 에 경로가 비어 있습니다".into());
        }
        return Ok(abs.to_string());
    }
    if action.cwd == "project" {
        let name = params
            .get("project")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| view.default_project.clone());
        if !name.is_empty() {
            if let Some(p) = view.projects.iter().find(|p| p.name == name) {
                if !p.path.is_empty() {
                    return Ok(p.path.clone());
                }
            }
        }
    }
    if view.vault_path.is_empty() {
        return Err("작업공간(볼트) 경로가 설정되지 않았습니다".into());
    }
    Ok(view.vault_path.clone())
}

// ---------- scheduled entries ----------

/// The smallest unit the scheduler sees. `decide()` walks only this list, so the three routines are nothing special.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduledEntry {
    /// "<packId>.<actionId>" — both the settings key and the last_run key
    pub key: String,
    pub pack_id: String,
    pub action_id: String,
    pub label: String,
    /// daily | weekdays | once (once is for host built-in tasks only)
    pub kind: String,
    pub time: String,
    pub enabled: bool,
    /// once-only run date (YYYY-MM-DD). Absent for daily/weekdays. Created only from code.
    pub date: Option<String>,
    pub days: Vec<u32>,
}

/// Schedulable actions from enabled packs merged with the user's config overrides.
pub fn scheduled_entries(reg: &Registry, view: &ConfigView) -> Vec<ScheduledEntry> {
    let mut out = Vec::new();
    for pack in reg.enabled() {
        for action in &pack.manifest.actions {
            let Some(sched) = &action.schedule else {
                continue;
            };
            let key = format!("{}.{}", pack.manifest.id, action.id);
            let over = view.schedule_override(&key, &action.id);
            out.push(ScheduledEntry {
                label: format!("{} ({})", action.label, pack.manifest.name),
                pack_id: pack.manifest.id.clone(),
                action_id: action.id.clone(),
                kind: sched.kind.clone(),
                time: over
                    .as_ref()
                    .map(|o| o.time.clone())
                    .unwrap_or_else(|| sched.time.clone()),
                enabled: over.as_ref().map(|o| o.enabled).unwrap_or(sched.enabled),
                key,
                date: None,
                days: vec![],
            });
        }
    }
    out.sort_by(|a, b| a.time.cmp(&b.time).then(a.key.cmp(&b.key)));
    out
}

// ---------- frontend contract ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    #[serde(flatten)]
    pub manifest: PackManifest,
    pub dir: String,
    pub source: PackSource,
    pub enabled: bool,
    /// Skills this pack actually carries (only those with files present)
    pub available_skills: Vec<String>,
    pub settings_values: Map<String, Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackRegistryView {
    pub packs: Vec<PackInfo>,
    pub broken: Vec<BrokenPack>,
}

pub fn registry_view(reg: &Registry, view: &ConfigView) -> PackRegistryView {
    let packs = reg
        .packs
        .iter()
        .map(|p| PackInfo {
            available_skills: p
                .manifest
                .skills
                .iter()
                .filter(|s| p.skills_dir.join(s).join("SKILL.md").is_file())
                .cloned()
                .collect(),
            settings_values: view.pack_settings(&p.manifest.id),
            manifest: p.manifest.clone(),
            dir: p.dir.display().to_string(),
            source: p.source,
            enabled: p.enabled,
        })
        .collect();
    PackRegistryView {
        packs,
        broken: reg.broken.clone(),
    }
}

/// One sidebar entry.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavEntry {
    pub pack_id: String,
    pub pack_name: String,
    pub view_id: String,
    pub label: String,
    pub icon: String,
    /// notes | native — the wire name matches the view manifest's `type`
    #[serde(rename = "type")]
    pub kind: String,
    pub component: String,
    /// Sidebar section tag (VIEW_GROUPS). The frontend files empty values under "Other".
    pub group: String,
}

pub fn nav_entries(reg: &Registry) -> Vec<NavEntry> {
    let mut out = Vec::new();
    for pack in reg.enabled() {
        for v in &pack.manifest.views {
            out.push(NavEntry {
                pack_id: pack.manifest.id.clone(),
                pack_name: pack.manifest.name.clone(),
                view_id: v.id.clone(),
                label: v.label.clone(),
                icon: v.icon.clone(),
                kind: v.kind.clone(),
                component: v.component.clone(),
                group: v.group.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sw-packs-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_pack(root: &Path, id: &str, extra: &str) {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        let json = format!(r#"{{ "id": "{id}", "name": "{id} 팩", "version": "1.0.0" {extra} }}"#);
        fs::write(dir.join(MANIFEST), json).unwrap();
    }

    #[test]
    fn manifest_rejects_bad_ids_and_types() {
        let mut m = PackManifest {
            id: "Bad Id".into(),
            ..Default::default()
        };
        assert!(m.validate().is_err());

        let mut m = PackManifest {
            id: "ok".into(),
            ..Default::default()
        };
        m.settings.push(SettingField {
            key: "a".into(),
            kind: "wat".into(),
            ..Default::default()
        });
        assert!(m.validate().unwrap_err().contains("설정 타입"));

        let mut m = PackManifest {
            id: "ok".into(),
            ..Default::default()
        };
        m.actions.push(PackAction {
            id: "x".into(),
            prompt: "hi".into(),
            cwd: "elsewhere".into(),
            ..Default::default()
        });
        assert!(m.validate().unwrap_err().contains("cwd"));
    }

    #[test]
    fn manifest_fills_labels_and_catches_dangling_action_refs() {
        let mut m = PackManifest {
            id: "ok".into(),
            ..Default::default()
        };
        m.actions.push(PackAction {
            id: "run".into(),
            prompt: "/x".into(),
            cwd: "workspace".into(),
            ..Default::default()
        });
        m.views.push(PackView {
            id: "v".into(),
            kind: "notes".into(),
            actions: vec!["run".into()],
            ..Default::default()
        });
        m.validate().unwrap();
        assert_eq!(m.actions[0].label, "run", "빈 라벨은 id 로 채운다");
        assert_eq!(m.views[0].label, "v");

        m.views[0].actions = vec!["nope".into()];
        assert!(m.validate().unwrap_err().contains("nope"));
    }

    #[test]
    fn multiple_selection_is_limited_to_row_views() {
        let mut table = PackManifest {
            id: "ok".into(),
            views: vec![PackView {
                id: "issues".into(),
                kind: "table".into(),
                selection: "multiple".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        table.validate().unwrap();
        assert_eq!(table.views[0].selection, "multiple");

        table.views[0].kind = "board".into();
        assert!(table.validate().unwrap_err().contains("table/review-queue"));
    }

    #[test]
    fn schedule_must_be_hhmm() {
        let mut m = PackManifest {
            id: "ok".into(),
            ..Default::default()
        };
        m.actions.push(PackAction {
            id: "a".into(),
            prompt: "/x".into(),
            cwd: "workspace".into(),
            schedule: Some(ActionSchedule {
                kind: "daily".into(),
                time: "9시".into(),
                enabled: true,
            }),
            ..Default::default()
        });
        assert!(m.validate().unwrap_err().contains("HH:MM"));
        assert!(validate_hhmm("09:00") && validate_hhmm("23:59"));
        assert!(!validate_hhmm("24:00") && !validate_hhmm("9") && !validate_hhmm("1:2:3"));
    }

    #[test]
    fn user_pack_overrides_builtin_and_broken_is_reported() {
        let builtin = tempdir("builtin");
        let user = tempdir("user");
        fs::create_dir_all(builtin.join("packs/si/skills")).unwrap();
        fs::create_dir_all(user.join("si").join("skills")).unwrap();
        write_pack(&builtin.join("packs"), "si", r#", "description": "내장" "#);
        write_pack(&builtin.join("packs"), "other", "");
        write_pack(&user, "si", r#", "description": "사용자" "#);
        fs::create_dir_all(user.join("busted")).unwrap();
        fs::write(user.join("busted").join(MANIFEST), "{ not json").unwrap();

        let reg = load_registry_from(Some(&builtin), &user, &[]);
        assert_eq!(reg.packs.len(), 2);
        let si = reg.get("si").unwrap();
        assert_eq!(si.manifest.description, "사용자");
        assert_eq!(si.source, PackSource::User);
        assert_eq!(si.skills_dir, user.join("si").join("skills"));
        let other = reg.get("other").unwrap();
        assert_eq!(
            other.skills_dir,
            builtin.join("packs/other/skills"),
            "폴백은 없다 — 팩은 자기 skills/ 를 본다 (없으면 빈 폴더)"
        );
        assert_eq!(
            namespace(other),
            "sawhorse",
            "내장 팩의 네임스페이스는 sawhorse"
        );
        assert_eq!(
            namespace(&si),
            "sawhorse-si",
            "사용자 팩은 자기 네임스페이스"
        );
        assert_eq!(reg.broken.len(), 1);
        assert!(reg.broken[0].error.contains("파싱"));

        fs::remove_dir_all(&builtin).unwrap();
        fs::remove_dir_all(&user).unwrap();
    }

    #[test]
    fn stale_builtin_bundles_do_not_duplicate_replacement_navigation() {
        let builtin = tempdir("stale-bundles");
        let packs = builtin.join("packs");
        write_pack(
            &packs,
            "starter",
            r#", "views": [{"id":"logs","label":"일지","group":"vault"}]"#,
        );
        write_pack(
            &packs,
            "si",
            r#", "views": [
                {"id":"concepts","label":"개념","group":"vault"},
                {"id":"vault","label":"점검","type":"native","component":"vault","group":"vault"}
            ]"#,
        );
        write_pack(
            &packs,
            "journal",
            r#", "views": [{"id":"logs","label":"일지","group":"vault"}]"#,
        );
        write_pack(
            &packs,
            "concepts",
            r#", "views": [{"id":"concepts","label":"개념","group":"vault"}]"#,
        );
        write_pack(&packs, "todos", "");
        write_pack(&packs, "project-docs", "");

        let reg = load_registry_from(Some(&builtin), Path::new("/nonexistent"), &[]);
        assert!(reg.get("starter").is_none());
        assert!(reg.get("si").is_none());
        let nav = nav_entries(&reg);
        assert_eq!(nav.iter().filter(|entry| entry.label == "일지").count(), 1);
        assert_eq!(nav.iter().filter(|entry| entry.label == "개념").count(), 1);
        assert_eq!(nav.iter().filter(|entry| entry.label == "점검").count(), 0);

        fs::remove_dir_all(&builtin).unwrap();
    }

    #[test]
    fn empty_enabled_list_means_everything_on() {
        let builtin = tempdir("enable");
        write_pack(&builtin.join("packs"), "a", "");
        write_pack(&builtin.join("packs"), "b", "");

        let all = load_registry_from(Some(&builtin), Path::new("/nonexistent"), &[]);
        assert!(all.packs.iter().all(|p| p.enabled));

        let only_a = load_registry_from(Some(&builtin), Path::new("/nonexistent"), &["a".into()]);
        assert!(only_a.get("a").unwrap().enabled);
        assert!(!only_a.get("b").unwrap().enabled);
        assert_eq!(only_a.enabled().count(), 1);
        assert!(
            only_a.action("b", "anything").is_none(),
            "꺼진 팩의 액션은 보이지 않는다"
        );

        fs::remove_dir_all(&builtin).unwrap();
    }

    #[test]
    fn prompt_renders_lists_and_drops_empty_slots() {
        let mut p = Map::new();
        p.insert("ids".into(), serde_json::json!(["FDR-1", "FDR-2"]));
        assert_eq!(
            render_prompt("/{{ns}}:issues 설계 {{ids}}", "sawhorse", &p),
            "/sawhorse:issues 설계 FDR-1 FDR-2"
        );
        assert_eq!(
            render_prompt("/{{ns}}:capture", "sawhorse-starter", &Map::new()),
            "/sawhorse-starter:capture",
            "사용자 팩 네임스페이스도 같은 경로다"
        );
        assert_eq!(
            render_prompt("/x {{missing}} 끝", "sawhorse", &Map::new()),
            "/x 끝"
        );

        let mut nl = Map::new();
        nl.insert("t".into(), serde_json::json!("첫 줄\n둘째 `줄`"));
        assert_eq!(
            render_prompt("/note {{t}}", "sawhorse", &nl),
            "/note 첫 줄 둘째 줄"
        );

        // the template's own newlines must survive so multi-line unattended instructions are possible
        let multi = render_prompt(
            "첫 줄 지시\n둘째 줄 {{missing}} 지시",
            "sawhorse",
            &Map::new(),
        );
        assert_eq!(multi, "첫 줄 지시\n둘째 줄 지시");
    }

    #[test]
    fn cwd_resolution_covers_four_paths() {
        let mut view = crate::config::view(
            &serde_json::json!({
                "vaultPath": "/vault",
                "improve": { "defaultProject": "FDR",
                             "projects": { "FDR": { "path": "/code/fdr" }, "NOPATH": { "path": "" } } }
            }),
            true,
        );

        let ws = PackAction {
            cwd: "workspace".into(),
            ..Default::default()
        };
        assert_eq!(resolve_cwd(&ws, &Map::new(), &view).unwrap(), "/vault");

        let abs = PackAction {
            cwd: "path:/tmp/here".into(),
            ..Default::default()
        };
        assert_eq!(resolve_cwd(&abs, &Map::new(), &view).unwrap(), "/tmp/here");

        let proj = PackAction {
            cwd: "project".into(),
            ..Default::default()
        };
        assert_eq!(
            resolve_cwd(&proj, &Map::new(), &view).unwrap(),
            "/code/fdr",
            "기본 프로젝트 폴백"
        );

        let mut params = Map::new();
        params.insert("project".into(), serde_json::json!("NOPATH"));
        assert_eq!(
            resolve_cwd(&proj, &params, &view).unwrap(),
            "/vault",
            "경로 없는 프로젝트는 작업공간으로 떨어진다"
        );

        view.vault_path = String::new();
        assert!(resolve_cwd(&ws, &Map::new(), &view).is_err());
    }

    #[test]
    fn scheduled_entries_apply_config_overrides() {
        let builtin = tempdir("sched");
        write_pack(
            &builtin.join("packs"),
            "si",
            r#", "actions": [
                 {"id":"morning","label":"아침","prompt":"/m","schedule":{"kind":"daily","time":"09:00"}},
                 {"id":"adhoc","label":"수동","prompt":"/a"}
               ]"#,
        );
        let reg = load_registry_from(Some(&builtin), Path::new("/nonexistent"), &[]);
        let view = crate::config::view(
            &serde_json::json!({"dashboard": {"schedules": {"si.morning": {"enabled": false, "time": "07:30"}}}}),
            true,
        );
        let entries = scheduled_entries(&reg, &view);
        assert_eq!(entries.len(), 1, "예약 없는 액션은 엔트리가 아니다");
        assert_eq!(entries[0].key, "si.morning");
        assert_eq!(entries[0].time, "07:30");
        assert!(!entries[0].enabled);
        assert!(entries[0].label.contains("아침"));
        fs::remove_dir_all(&builtin).unwrap();
    }

    /// Wire-name lock. Several places need a Rust field named `kind` to serialize as JSON `type`;
    /// a single mismatch quietly blanks a screen.
    #[test]
    fn wire_names_match_the_frontend_contract() {
        let nav = NavEntry {
            pack_id: "si".into(),
            pack_name: "SI".into(),
            view_id: "issues".into(),
            label: "이슈".into(),
            icon: "list-checks".into(),
            kind: "native".into(),
            component: "issues".into(),
            group: "work".into(),
        };
        let j = serde_json::to_value(&nav).unwrap();
        assert_eq!(
            j["type"], "native",
            "NavEntry.kind 는 JSON 에서 type 이어야 한다"
        );
        assert_eq!(j["packId"], "si");
        assert_eq!(j["viewId"], "issues");
        assert_eq!(j["group"], "work", "NavEntry.group 는 사이드바 섹션 태그다");

        let view = PackView {
            id: "v".into(),
            kind: "notes".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&view).unwrap()["type"], "notes");
        let field = SettingField {
            key: "k".into(),
            kind: "path".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&field).unwrap()["type"], "path");
        let param = ActionParam {
            key: "p".into(),
            kind: "list".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&param).unwrap()["type"], "list");
        let col = ViewColumn {
            field: "f".into(),
            kind: "badge".into(),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&col).unwrap()["type"], "badge");

        // the manifest reads `type` and still accepts the old `kind`
        let parsed: PackView =
            serde_json::from_str(r#"{"id":"a","type":"native","component":"x"}"#).unwrap();
        assert_eq!(parsed.kind, "native");
        let legacy: PackView =
            serde_json::from_str(r#"{"id":"a","kind":"native","component":"x"}"#).unwrap();
        assert_eq!(legacy.kind, "native");
    }

    /// Do the shipped packs actually parse — a lock against deploying a broken manifest.
    #[test]
    fn skill_names_are_unique_safe_directory_names() {
        for skills in [vec!["../escape"], vec!["/absolute"], vec!["wiki", "wiki"]] {
            let mut manifest = PackManifest {
                id: "demo".into(),
                skills: skills.into_iter().map(str::to_owned).collect(),
                ..Default::default()
            };
            assert!(manifest.validate().is_err());
        }
    }

    #[test]
    fn shipped_packs_parse() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugin");
        let reg = load_registry_from(Some(&root), Path::new("/nonexistent"), &[]);
        assert!(reg.broken.is_empty(), "깨진 팩: {:?}", reg.broken);
        assert!(reg.get("si").is_none(), "업종 묶음은 확장 단위가 아니다");
        assert!(
            reg.get("starter").is_none(),
            "starter는 일지 기능으로 대체됐다"
        );

        for id in ["journal", "concepts", "todos", "project-docs"] {
            let pack = reg
                .get(id)
                .unwrap_or_else(|| panic!("{id} 기능 확장이 있어야 한다"));
            for name in &pack.manifest.skills {
                assert!(
                    pack.skills_dir.join(name).join("SKILL.md").is_file(),
                    "{id} 확장이 없는 스킬을 선언했다: {name}"
                );
            }
            for seed in &pack.manifest.workspace.files {
                assert!(
                    pack.dir.join(&seed.src).is_file(),
                    "없는 원본: {}",
                    seed.src
                );
            }
            assert!(
                pack.manifest
                    .views
                    .iter()
                    .all(|view| view.component != "vault"),
                "점검은 네이티브 코어 화면이어야 한다"
            );
        }

        let journal = reg.get("journal").unwrap();
        assert!(journal.manifest.views.iter().any(|view| view.id == "logs"));
        assert!(journal.manifest.skills.contains(&"daily-log".to_string()));
        assert!(!journal.manifest.settings.is_empty());

        let concepts = reg.get("concepts").unwrap();
        assert!(concepts
            .manifest
            .views
            .iter()
            .any(|view| view.id == "concepts"));
        assert_eq!(concepts.manifest.skills, vec!["wiki".to_string()]);

        let todos = reg.get("todos").unwrap();
        assert!(todos
            .manifest
            .views
            .iter()
            .any(|view| view.component == "todos"));
        assert!(todos.manifest.skills.is_empty());
    }

    #[test]
    fn legacy_bundle_ids_enable_their_replacement_features() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugin");
        let old_si = load_registry_from(Some(&root), Path::new("/nonexistent"), &["si".into()]);
        for id in ["journal", "concepts", "todos", "project-docs"] {
            assert!(old_si.get(id).is_some_and(|pack| pack.enabled), "{id}");
        }

        let old_starter =
            load_registry_from(Some(&root), Path::new("/nonexistent"), &["starter".into()]);
        assert!(old_starter.get("journal").is_some_and(|pack| pack.enabled));
        assert!(old_starter
            .packs
            .iter()
            .filter(|pack| pack.manifest.id != "journal")
            .all(|pack| !pack.enabled));
    }

    #[test]
    fn nav_entries_only_from_enabled_packs() {
        let builtin = tempdir("nav");
        write_pack(
            &builtin.join("packs"),
            "a",
            r#", "views": [{"id":"v1","label":"뷰1","group":"work"}]"#,
        );
        write_pack(
            &builtin.join("packs"),
            "b",
            r#", "views": [{"id":"v2","label":"뷰2"}]"#,
        );
        let reg = load_registry_from(Some(&builtin), Path::new("/nonexistent"), &["a".into()]);
        let nav = nav_entries(&reg);
        assert_eq!(nav.len(), 1);
        assert_eq!(nav[0].view_id, "v1");
        assert_eq!(nav[0].kind, "notes", "뷰 종류 기본값");
        assert_eq!(nav[0].group, "work", "뷰 그룹이 사이드바 태그로 흘러간다");
        fs::remove_dir_all(&builtin).unwrap();
    }

    #[test]
    fn view_group_must_be_known() {
        let mut m = PackManifest {
            id: "ok".into(),
            ..Default::default()
        };
        m.views.push(PackView {
            id: "v".into(),
            group: "nope".into(),
            kind: "notes".into(),
            ..Default::default()
        });
        assert!(m.validate().unwrap_err().contains("그룹"));
        m.views[0].group = "vault".into();
        assert!(m.validate().is_ok(), "빈 그룹과 나열된 그룹은 허용된다");
        m.views[0].group = String::new();
        assert!(m.validate().is_ok());
    }
}
