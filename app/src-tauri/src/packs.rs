// packs.rs — 기능 확장(pack) 레지스트리.
//
// 팩 하나가 사용자가 독립적으로 켜고 끌 수 있는 기능 하나다: 작업공간 레이아웃 + 설정 스키마 + 실행 액션 +
// 화면(뷰) + 에이전트 스킬. 팩은 선언만 하고 코드를 들고 오지 않는다 — 렌더·검증·실행은
// 전부 호스트가 한다. 표현력의 상한은 의도한 것이고, 모자란 부분은 스킬이 채운다.
//
// 발견 순서: 사용자 팩(~/.claude/sawhorse/packs/<id>) > 내장 팩(<플러그인 루트>/packs/<id>).
// 모든 팩이 자기 `skills/` 를 소유한다 — 폴백(플러그인 루트 skills/ 참조)은 없다. 내장 팩의
// 스킬은 `plugin/.claude-plugin/plugin.json` 의 `skills` 배열이 선언한다.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::ConfigView;
use crate::notes::NoteQuery;

pub const MANIFEST: &str = "pack.json";

// ---------- 매니페스트 ----------

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
    /// 팩 폴더 기준 상대 경로
    pub src: String,
    /// 작업공간 기준 상대 경로
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

/// 설정 화면이 폼을 자동 생성하는 근거. 값은 config.json 의 packs.<id>.settings 에 산다.
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
/// 사이드바 섹션 태그. 호스트가 섹션 목록과 순서를 소유하고, 팩 뷰는 이 중 하나를 고른다.
/// 빈 값이면 사이드바 맨 아래 「기타」 섹션으로 밀린다.
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
    /// `{{key}}` 자리에 파라미터가 들어가는 프롬프트 템플릿
    pub prompt: String,
    /// workspace | project | path:<절대경로>
    #[serde(default = "default_cwd")]
    pub cwd: String,
    pub params: Vec<ActionParam>,
    pub schedule: Option<ActionSchedule>,
    /// 홈 화면 빠른 실행 카드로 올릴지
    pub featured: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ViewColumn {
    /// 프론트매터 필드 이름
    pub field: String,
    pub label: String,
    /// "" | "title" | "path" — 프론트매터가 아니라 노트 자체에서 오는 값
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
    /// kind=native 일 때 앱이 이미 들고 있는 화면 이름 (issues/todos/docs)
    pub component: String,
    /// 사이드바 섹션 태그 — VIEW_GROUPS 중 하나. 빈 값은 「기타」.
    #[serde(default)]
    pub group: String,
    pub query: NoteQuery,
    pub columns: Vec<ViewColumn>,
    pub group_by: String,
    /// none | multiple. multiple은 table/review-queue에서 체크한 행만 액션에 전달한다.
    pub selection: String,
    /// 이 뷰에서 실행할 수 있는 액션 id 목록
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
    /// 사람이 손으로 쓰는 파일이므로, 고칠 수 있는 것은 고치고 못 고치는 것만 거절한다.
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

// ---------- 발견 ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PackSource {
    /// 앱/저장소에 동봉된 팩
    Builtin,
    /// ~/.claude/sawhorse/packs 아래 사용자가 넣은 팩
    User,
}

#[derive(Clone, Debug)]
pub struct Pack {
    pub manifest: PackManifest,
    pub dir: PathBuf,
    /// 이 팩의 스킬 본문이 사는 곳
    pub skills_dir: PathBuf,
    pub source: PackSource,
    pub enabled: bool,
}

/// 매니페스트를 읽지 못한 팩. 앱은 계속 뜨고 확장 화면이 사유를 보여준다.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BrokenPack {
    pub dir: String,
    pub error: String,
}

pub fn user_packs_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("sawhorse").join("packs")
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
                // 팩이 자기 스킬을 소유한다 — skills_dir 은 늘 팩 폴더 안이다.
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

    /// 활성 팩에서만 액션을 찾는다 — 꺼진 팩의 액션이 예약·실행되면 "끈다"가 거짓말이 된다.
    pub fn action(&self, pack_id: &str, action_id: &str) -> Option<(&Pack, &PackAction)> {
        let p = self.get(pack_id).filter(|p| p.enabled)?;
        p.manifest.action(action_id).map(|a| (p, a))
    }

    pub fn view(&self, pack_id: &str, view_id: &str) -> Option<(&Pack, &PackView)> {
        let p = self.get(pack_id).filter(|p| p.enabled)?;
        p.manifest.view(view_id).map(|v| (p, v))
    }
}

/// 내장 + 사용자 팩을 모아 활성 여부까지 확정한다.
/// `enabled` 가 비어 있으면 전부 활성 — 기존 사용자가 업그레이드했을 때 화면이 사라지지 않게.
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
    // 같은 id 면 사용자 팩이 이긴다 (커스터마이즈 경로)
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
            // 1.0의 업무방식 묶음을 켜 둔 사용자는 기능별 확장으로 자연스럽게
            // 넘어간다. 첫 토글 저장 때 정규 id 목록으로 치환된다.
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

/// 이 팩의 스킬이 에이전트에서 도는 네임스페이스.
/// 내장 팩은 `sawhorse` 플러그인 하나에 실리고, 사용자 팩은 자기만의 skills-dir
/// 플러그인(`~/.claude/skills/sawhorse-<id>/`)으로 설치되므로 팩마다 다르다.
/// `render_prompt` 의 `{{ns}}` 가 유일한 소비자다.
pub fn namespace(pack: &Pack) -> String {
    match pack.source {
        PackSource::Builtin => "sawhorse".into(),
        PackSource::User => format!("sawhorse-{}", pack.manifest.id),
    }
}

// ---------- 프롬프트 · cwd ----------

/// `{{key}}` 치환. 리스트는 공백으로 잇는다.
///
/// **치환값에서만** 개행·백틱을 지운다 — 프롬프트가 슬래시 커맨드 한 줄로 전달되는 경로가
/// 있어 파라미터에 줄바꿈이 섞이면 명령이 잘린다. 템플릿 자체의 줄바꿈은 보존한다:
/// 팩이 여러 줄짜리 무인 실행 지시를 쓸 수 있어야 한다.
///
/// `ns` 는 예약 변수다 — 팩 프롬프트가 네임스페이스(`/sawhorse:issues`)를 직접 쓰면
/// 팩 복제 때 일괄 수정이 필요해지므로 `/{{ns}}:issues` 로 쓰고, 렌더 진입점이 **항상**
/// 주입한다. 사용자 파라미터로는 절대 채워지지 않는다(채워지지 않은 `{{…}}` 는 조용히
/// 지워지므로 `ns` 누락은 `/:issues` 라는 치명적 망가짐이 된다 — 서명으로 원천 차단).
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
    // 채워지지 않은 자리는 흔적을 남기지 않는다
    while let Some(start) = out.find("{{") {
        let Some(rel) = out[start..].find("}}") else {
            break;
        };
        out.replace_range(start..start + rel + 2, "");
    }
    // 빈 자리가 남긴 이중 공백만 줄 단위로 정리하고, 줄 구조는 그대로 둔다
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

/// 액션이 어디서 돌아야 하는가. project 는 레거시 `improve.projects` 도 호환 입력으로 쓴다 —
/// 코드 프로젝트 경로 등록은 이미 그쪽이 정본이고, 없으면 작업공간으로 떨어진다.
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

// ---------- 예약 엔트리 ----------

/// 스케줄러가 보는 최소 단위. `decide()` 는 이 목록만 순회하므로 루틴 3개가 특별하지 않다.
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduledEntry {
    /// "<packId>.<actionId>" — 설정 키이자 last_run 키
    pub key: String,
    pub pack_id: String,
    pub action_id: String,
    pub label: String,
    /// daily | weekdays | once (once는 호스트 내장 작업 전용)
    pub kind: String,
    pub time: String,
    pub enabled: bool,
    /// once 전용 실행 날짜(YYYY-MM-DD). daily·weekdays는 없다. 코드에서만 만든다.
    pub date: Option<String>,
}

/// 활성 팩의 예약 가능한 액션 + config 의 사용자 재정의를 합친 결과.
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
            });
        }
    }
    out.sort_by(|a, b| a.time.cmp(&b.time).then(a.key.cmp(&b.key)));
    out
}

// ---------- 프론트엔드 계약 ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    #[serde(flatten)]
    pub manifest: PackManifest,
    pub dir: String,
    pub source: PackSource,
    pub enabled: bool,
    /// 이 팩이 실제로 들고 있는 스킬(파일이 있는 것만)
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

/// 사이드바 한 줄.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NavEntry {
    pub pack_id: String,
    pub pack_name: String,
    pub view_id: String,
    pub label: String,
    pub icon: String,
    /// notes | native — 프론트엔드 계약 이름은 뷰 매니페스트와 같은 `type` 이다
    #[serde(rename = "type")]
    pub kind: String,
    pub component: String,
    /// 사이드바 섹션 태그 (VIEW_GROUPS). 빈 값이면 프론트가 「기타」로 분류한다.
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

        // 템플릿 자체의 줄바꿈은 살아 있어야 여러 줄 무인 지시를 쓸 수 있다
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

    /// 프론트엔드 계약 이름 자물쇠. Rust 필드가 `kind` 인데 JSON 이 `type` 이어야 하는
    /// 자리가 여럿이라, 하나만 어긋나도 화면이 조용히 빈다.
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

        // 매니페스트는 `type` 으로 읽히고 예전 `kind` 도 받아 준다
        let parsed: PackView =
            serde_json::from_str(r#"{"id":"a","type":"native","component":"x"}"#).unwrap();
        assert_eq!(parsed.kind, "native");
        let legacy: PackView =
            serde_json::from_str(r#"{"id":"a","kind":"native","component":"x"}"#).unwrap();
        assert_eq!(legacy.kind, "native");
    }

    /// 동봉한 팩이 실제로 파싱되는지 — 깨진 매니페스트를 배포하지 않기 위한 자물쇠.
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
