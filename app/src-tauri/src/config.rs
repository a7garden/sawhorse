// config.json load/save. The plugin (setup/improve skills, improve-xlsx.mjs) owns
// this file's schema; the dashboard only merges known keys and preserves the rest
// (including key order, via serde_json preserve_order).

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use arc_swap::ArcSwap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("sawhorse").join("config.json")
}

fn load_raw_at(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

// ---------- wire types ----------

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct RoutineSched {
    pub enabled: bool,
    pub time: String,
}

impl Default for RoutineSched {
    fn default() -> Self {
        // missing/disabled by default; Schedules::default() overrides the three real routines
        Self {
            enabled: false,
            time: "00:00".into(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Schedules {
    pub morning: RoutineSched,
    pub lunch: RoutineSched,
    pub evening: RoutineSched,
}

impl Default for Schedules {
    fn default() -> Self {
        Self {
            morning: RoutineSched {
                enabled: true,
                time: "09:00".into(),
            },
            lunch: RoutineSched {
                enabled: true,
                time: "12:30".into(),
            },
            evening: RoutineSched {
                enabled: true,
                time: "18:00".into(),
            },
        }
    }
}

/// Where dashboard jobs actually run. `auto` prefers herdr and silently falls
/// back to the headless `claude -p` runner when herdr is unusable.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct HerdrCfg {
    /// "auto" | "herdr" | "headless"
    pub mode: String,
    pub bin: String,
    /// named herdr session; empty = default session
    pub session: String,
    pub workspace_label: String,
    /// "closeOnSuccess" | "keep" | "closeAlways"
    pub cleanup: String,
    /// concurrent jobs in herdr mode (headless is always 1)
    pub max_parallel: u32,
    pub start_timeout_sec: u32,
    /// 0 = wait forever
    pub job_timeout_min: u32,
    /// herdr toast when a job needs approval or finishes
    pub notify: bool,
    /// Skills assess child tasks; auto maps supported Claude models by complexity.
    pub child_model_policy: String,
}

impl Default for HerdrCfg {
    fn default() -> Self {
        Self {
            mode: "auto".into(),
            bin: "herdr".into(),
            session: String::new(),
            workspace_label: "sawhorse".into(),
            cleanup: "closeAlways".into(),
            max_parallel: 2,
            start_timeout_sec: 60,
            job_timeout_min: 120,
            notify: true,
            child_model_policy: "auto".into(),
        }
    }
}

pub const HERDR_MODES: [&str; 3] = ["auto", "herdr", "headless"];
pub const HERDR_CLEANUPS: [&str; 3] = ["closeOnSuccess", "keep", "closeAlways"];

impl HerdrCfg {
    /// Config values arrive from a hand-editable file; clamp instead of failing.
    pub fn sanitized(&self) -> Self {
        let mut c = self.clone();
        if !HERDR_MODES.contains(&c.mode.as_str()) {
            c.mode = "auto".into();
        }
        if !HERDR_CLEANUPS.contains(&c.cleanup.as_str()) {
            c.cleanup = "closeAlways".into();
        }
        if c.bin.trim().is_empty() {
            c.bin = "herdr".into();
        }
        if c.workspace_label.trim().is_empty() {
            c.workspace_label = "sawhorse".into();
        }
        c.max_parallel = c.max_parallel.clamp(1, 8);
        if !matches!(c.child_model_policy.as_str(), "auto" | "inherit") {
            c.child_model_policy = "auto".into();
        }
        c.start_timeout_sec = c.start_timeout_sec.clamp(10, 600);
        c
    }
}

/// 카탈로그에 없는 에이전트를 사용자가 직접 등록하는 항목. 사내 도구나 직접 만든 CLI 가
/// 마법사 감지 목록에 뜨게 하는 유일한 방법이다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct CustomAgent {
    pub id: String,
    pub name: String,
    /// 실행 파일 이름 또는 절대 경로. 비어 있으면 `id` 를 이름으로 본다.
    pub bin: String,
    pub install_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DashboardCfg {
    pub schedules: Schedules,
    pub excel_output_dir: String,
    pub claude_bin: String,
    pub permission_mode: String,
    pub launch_at_login: bool,
    pub herdr: HerdrCfg,
    /// 마법사에서 고른 기본 에이전트. 스킬 설치 대상과 안내의 기준이 된다.
    /// 잡 실행기는 아직 Claude Code 에 묶여 있어 이 값이 실행기를 바꾸지는 않는다.
    pub default_agent: String,
    pub custom_agents: Vec<CustomAgent>,
    /// 승인 정책·통합 방식(설계 255-264줄). 새 세션의 초기값 계산에만 쓰고,
    /// 활성 세션은 시작 때 찍은 policy snapshot을 따른다.
    pub collaboration: crate::collab::model::CollaborationPolicy,
}

impl Default for DashboardCfg {
    fn default() -> Self {
        Self {
            schedules: Schedules::default(),
            excel_output_dir: String::new(),
            claude_bin: "claude".into(),
            permission_mode: "bypassPermissions".into(),
            launch_at_login: false,
            herdr: HerdrCfg::default(),
            default_agent: "claude".into(),
            custom_agents: Vec::new(),
            collaboration: Default::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ProjectCfg {
    #[serde(default)]
    pub name: String,
    pub path: String,
    pub work_branch: String,
    pub portable_base: String,
    pub id_prefix: String,
    pub verify: String,
}

/// 확장(pack) 블록. 호스트 소유이고 플러그인은 모르는 키로 무시한다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PacksCfg {
    /// 활성 팩 id. **비어 있으면 전부 활성** — 업그레이드한 기존 사용자의 화면이 사라지지 않게.
    pub enabled: Vec<String>,
    /// 팩 id -> 그 팩의 설정 값 (스키마는 팩이 선언)
    pub settings: Map<String, Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub exists: bool,
    pub vault_path: String,
    pub default_project: String,
    pub projects: Vec<ProjectCfg>,
    /// 새 코어 프로젝트 정본. key는 등록 때 생성한 UUID projectId다(설계 294-295줄).
    pub core_projects: BTreeMap<String, crate::collab::model::CoreProject>,
    pub dashboard: DashboardCfg,
    pub packs: PacksCfg,
    /// `dashboard.schedules` 원본 전체. 정규 키는 `<packId>.<actionId>` 이고
    /// 예전 키(`morning`)도 그대로 실려 온다 — 별칭 폴백은 `schedule_override` 가 한다.
    pub schedules: BTreeMap<String, RoutineSched>,
}

impl ConfigView {
    /// 예약 재정의 조회. 정규 키 우선, 없으면 예전 루틴 키(`morning` 등)를 본다.
    pub fn schedule_override(&self, key: &str, legacy: &str) -> Option<RoutineSched> {
        self.schedules
            .get(key)
            .or_else(|| self.schedules.get(legacy))
            .cloned()
    }

    pub fn pack_settings(&self, pack_id: &str) -> Map<String, Value> {
        self.packs
            .settings
            .get(pack_id)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    }

    #[allow(dead_code)] // 팩 설정 단일 값 조회 — 현재는 테스트/향후 네이티브 뷰용
    pub fn pack_setting_str(&self, pack_id: &str, key: &str) -> String {
        self.pack_settings(pack_id)
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    }
}

pub fn view(raw: &Value, exists: bool) -> ConfigView {
    let obj = raw.as_object();
    let vault_path = obj
        .and_then(|o| o.get("vaultPath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let improve = obj
        .and_then(|o| o.get("improve"))
        .and_then(Value::as_object);
    let default_project = improve
        .and_then(|i| i.get("defaultProject"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let projects = improve
        .and_then(|i| i.get("projects"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(name, pv)| {
                    let mut p: ProjectCfg = serde_json::from_value(pv.clone()).unwrap_or_default();
                    p.name = name.clone();
                    p
                })
                .collect()
        })
        .unwrap_or_default();
    let core_projects = obj
        .and_then(|o| o.get("projects"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(id, pv)| {
                    serde_json::from_value::<crate::collab::model::CoreProject>(pv.clone())
                        .ok()
                        .map(|p| (id.clone(), p))
                })
                .collect()
        })
        .unwrap_or_default();
    let dashboard = obj
        .and_then(|o| o.get("dashboard"))
        .and_then(|v| serde_json::from_value::<DashboardCfg>(v.clone()).ok())
        .unwrap_or_default();
    let packs = obj
        .and_then(|o| o.get("packs"))
        .and_then(|v| serde_json::from_value::<PacksCfg>(v.clone()).ok())
        .unwrap_or_default();
    let schedules = obj
        .and_then(|o| o.get("dashboard"))
        .and_then(|d| d.get("schedules"))
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| {
                    serde_json::from_value::<RoutineSched>(v.clone())
                        .ok()
                        .map(|s| (k.clone(), s))
                })
                .collect()
        })
        .unwrap_or_default();
    ConfigView {
        exists,
        vault_path,
        default_project,
        projects,
        core_projects,
        dashboard,
        packs,
        schedules,
    }
}

pub fn load_view() -> ConfigView {
    SNAPSHOT.load_full().as_ref().clone()
}

/// 프로세스 공유 설정 스냅샷. 틱마다 파일을 다시 읽지 않게 한다 — 읽기는
/// `load_view()`(스냅샷 조회), 갱신은 `refresh_view()`(저장 직후·파일 감시)만 한다.
static SNAPSHOT: LazyLock<ArcSwap<ConfigView>> =
    LazyLock::new(|| ArcSwap::from_pointee(load_view_from_disk()));

fn load_view_from_disk() -> ConfigView {
    let path = config_path();
    let exists = path.is_file();
    view(&load_raw_at(&path), exists)
}

/// 디스크에서 다시 읽어 스냅샷을 교체한다.
pub fn refresh_view() {
    SNAPSHOT.store(Arc::new(load_view_from_disk()));
}

// ---------- save ----------

pub const PERMISSION_MODES: [&str; 3] = ["default", "acceptEdits", "bypassPermissions"];

fn validate_hhmm(s: &str) -> Result<(), String> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 2 {
        return Err(format!("시각 형식은 HH:MM 이어야 합니다: {s}"));
    }
    let h: u32 = parts[0].parse().map_err(|_| format!("잘못된 시: {s}"))?;
    let m: u32 = parts[1].parse().map_err(|_| format!("잘못된 분: {s}"))?;
    if h > 23 || m > 59 {
        return Err(format!("범위를 벗어난 시각: {s}"));
    }
    Ok(())
}

fn validate_herdr_key(key: &str, v: &Value) -> Result<(), String> {
    match key {
        "childModelPolicy" => {
            if !matches!(v.as_str(), Some("auto" | "inherit")) {
                return Err("하위 모델 정책은 auto 또는 inherit이어야 합니다".into());
            }
        }
        "mode" => {
            let m = v
                .as_str()
                .ok_or_else(|| "herdr.mode는 문자열이어야 합니다".to_string())?;
            if !HERDR_MODES.contains(&m) {
                return Err(format!("알 수 없는 herdr 실행 모드: {m}"));
            }
        }
        "cleanup" => {
            let c = v
                .as_str()
                .ok_or_else(|| "herdr.cleanup은 문자열이어야 합니다".to_string())?;
            if !HERDR_CLEANUPS.contains(&c) {
                return Err(format!("알 수 없는 herdr 정리 정책: {c}"));
            }
        }
        "bin" | "session" | "workspaceLabel" => {
            if !v.is_string() {
                return Err(format!("herdr.{key}는 문자열이어야 합니다"));
            }
        }
        "maxParallel" => match v.as_u64() {
            Some(n) if (1..=8).contains(&n) => {}
            _ => return Err("herdr.maxParallel은 1~8 사이의 정수여야 합니다".into()),
        },
        "startTimeoutSec" => match v.as_u64() {
            Some(n) if (10..=600).contains(&n) => {}
            _ => return Err("herdr.startTimeoutSec은 10~600 사이여야 합니다".into()),
        },
        "jobTimeoutMin" => {
            if v.as_u64().is_none() {
                return Err("herdr.jobTimeoutMin은 정수여야 합니다 (0 = 무제한)".into());
            }
        }
        "notify" => {
            if !v.is_boolean() {
                return Err("herdr.notify는 참/거짓이어야 합니다".into());
            }
        }
        _ => {} // unknown herdr keys pass through untouched
    }
    Ok(())
}
/// 승인 정책 키 검증. 정책값은 설계 255-264줄·238-241줄의 허용 집합으로 제한한다.
fn validate_collaboration_key(key: &str, v: &Value) -> Result<(), String> {
    let as_enum = |allowed: &[&str]| -> Result<(), String> {
        let s = v
            .as_str()
            .ok_or_else(|| format!("collaboration.{key}는 문자열이어야 합니다"))?;
        if allowed.contains(&s) {
            Ok(())
        } else {
            Err(format!("알 수 없는 collaboration.{key}: {s}"))
        }
    };
    match key {
        "localIntegrationApproval" => as_enum(&["required", "autoAfterPreflight"]),
        "verificationMode" => as_enum(&["perChange"]),
        "failurePolicy" => as_enum(&["pause"]),
        "integrationStrategy" => as_enum(&["mergeCommit"]),
        "remoteWriteApproval" => as_enum(&["required"]),
        _ => Ok(()), // 미래 키는 보존만 한다
    }
}

/// Merge a patch (ConfigPatch from the frontend) into the raw config and write it back.
/// Unknown keys anywhere in the document are preserved untouched.
pub fn save_patch_at(path: &Path, patch: &Value) -> Result<ConfigView, String> {
    let mut raw = load_raw_at(path);
    let obj = raw
        .as_object_mut()
        .ok_or_else(|| "config.json 루트가 객체가 아닙니다".to_string())?;

    if let Some(vp) = patch.get("vaultPath") {
        if !vp.is_string() {
            return Err("vaultPath는 문자열이어야 합니다".into());
        }
        obj.insert("vaultPath".into(), vp.clone());
    }

    if let Some(dp) = patch.get("defaultProject") {
        if !dp.is_string() {
            return Err("defaultProject는 문자열이어야 합니다".into());
        }
        obj.entry("improve")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "improve 블록이 객체가 아닙니다".to_string())?
            .insert("defaultProject".into(), dp.clone());
    }

    if let Some(arr) = patch.get("projects") {
        let list = arr
            .as_array()
            .ok_or_else(|| "projects는 배열이어야 합니다".to_string())?;
        let mut map = Map::new();
        for pv in list {
            let p: ProjectCfg = serde_json::from_value(pv.clone())
                .map_err(|e| format!("프로젝트 항목 파싱 실패: {e}"))?;
            if p.name.trim().is_empty() {
                return Err("프로젝트명이 빈 프로젝트 항목이 있습니다".into());
            }
            map.insert(
                p.name.clone(),
                serde_json::json!({
                    "path": p.path, "workBranch": p.work_branch,
                    "portableBase": p.portable_base, "idPrefix": p.id_prefix,
                    "verify": p.verify,
                }),
            );
        }
        obj.entry("improve")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "improve 블록이 객체가 아닙니다".to_string())?
            .insert("projects".into(), Value::Object(map));
    }

    if let Some(map) = patch.get("coreProjects").and_then(Value::as_object) {
        // 새 코어 프로젝트 정본(설계 294-300줄). key는 UUID projectId. legacy
        // improve.projects와 별개 블록이라 서로를 지우지 않는다 — rollback 대응.
        let mut cleaned = Map::new();
        for (id, pv) in map {
            if id.trim().is_empty() {
                return Err("coreProjects 항목의 projectId가 비어 있습니다".into());
            }
            let p: crate::collab::model::CoreProject = serde_json::from_value(pv.clone())
                .map_err(|e| format!("coreProjects.{id} 파싱 실패: {e}"))?;
            if p.path.trim().is_empty() {
                return Err(format!("coreProjects.{id}에 path가 필요합니다"));
            }
            let mut value = serde_json::to_value(&p)
                .map_err(|e| format!("coreProjects.{id} 직렬화 실패: {e}"))?;
            // 통합 경로가 비어 있으면 프로젝트 path 자체를 쓴다(설계 269-271줄).
            if value
                .get("integration")
                .and_then(|i| i.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .is_empty()
            {
                value["integration"]["path"] = Value::String(p.path.clone());
            }
            cleaned.insert(id.clone(), value);
        }
        obj.insert("projects".into(), Value::Object(cleaned));
    }

    if let Some(dash) = patch.get("dashboard").and_then(Value::as_object) {
        let target = obj
            .entry("dashboard")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "dashboard 블록이 객체가 아닙니다".to_string())?;
        for (k, v) in dash {
            match k.as_str() {
                "schedules" => {
                    let sv = v
                        .as_object()
                        .ok_or_else(|| "schedules는 객체여야 합니다".to_string())?;
                    let st = target
                        .entry("schedules")
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut()
                        .ok_or_else(|| "schedules 블록이 객체가 아닙니다".to_string())?;
                    for (routine, rv) in sv {
                        if let Some(time) = rv.get("time").and_then(Value::as_str) {
                            validate_hhmm(time)?;
                        }
                        st.insert(routine.clone(), rv.clone());
                    }
                }
                "permissionMode" => {
                    let mode = v
                        .as_str()
                        .ok_or_else(|| "permissionMode는 문자열이어야 합니다".to_string())?;
                    if !PERMISSION_MODES.contains(&mode) {
                        return Err(format!("알 수 없는 permissionMode: {mode}"));
                    }
                    target.insert(k.clone(), v.clone());
                }
                "claudeBin" | "excelOutputDir" | "defaultAgent" => {
                    if !v.is_string() {
                        return Err(format!("{k}는 문자열이어야 합니다"));
                    }
                    target.insert(k.clone(), v.clone());
                }
                "customAgents" => {
                    // 목록 통째 교체. 항목 하나가 망가져 있으면 전부 거절해서 반쯤 저장된
                    // 상태를 만들지 않는다.
                    let list = v
                        .as_array()
                        .ok_or_else(|| "customAgents는 배열이어야 합니다".to_string())?;
                    for item in list {
                        let o = item
                            .as_object()
                            .ok_or_else(|| "customAgents 항목은 객체여야 합니다".to_string())?;
                        let id = o.get("id").and_then(Value::as_str).unwrap_or("").trim();
                        if id.is_empty() {
                            return Err("customAgents 항목에는 id가 필요합니다".into());
                        }
                        for key in ["id", "name", "bin", "installUrl"] {
                            if o.get(key).is_some_and(|x| !x.is_string()) {
                                return Err(format!("customAgents.{key}는 문자열이어야 합니다"));
                            }
                        }
                    }
                    target.insert(k.clone(), v.clone());
                }
                "herdr" => {
                    let hv = v
                        .as_object()
                        .ok_or_else(|| "herdr는 객체여야 합니다".to_string())?;
                    let ht = target
                        .entry("herdr")
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut()
                        .ok_or_else(|| "herdr 블록이 객체가 아닙니다".to_string())?;
                    for (hk, hvv) in hv {
                        validate_herdr_key(hk, hvv)?;
                        ht.insert(hk.clone(), hvv.clone());
                    }
                }
                "collaboration" => {
                    let cv = v
                        .as_object()
                        .ok_or_else(|| "collaboration은 객체여야 합니다".to_string())?;
                    let ct = target
                        .entry("collaboration")
                        .or_insert_with(|| Value::Object(Map::new()))
                        .as_object_mut()
                        .ok_or_else(|| "collaboration 블록이 객체가 아닙니다".to_string())?;
                    for (ck, cvv) in cv {
                        validate_collaboration_key(ck, cvv)?;
                        ct.insert(ck.clone(), cvv.clone());
                    }
                }
                _ => {} // launchAtLogin and unknown keys are ignored here
            }
        }
    }

    if let Some(packs) = patch.get("packs").and_then(Value::as_object) {
        let target = obj
            .entry("packs")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "packs 블록이 객체가 아닙니다".to_string())?;
        if let Some(enabled) = packs.get("enabled") {
            let list = enabled
                .as_array()
                .ok_or_else(|| "packs.enabled는 배열이어야 합니다".to_string())?;
            if list.iter().any(|v| !v.is_string()) {
                return Err("packs.enabled 항목은 문자열이어야 합니다".into());
            }
            target.insert("enabled".into(), enabled.clone());
        }
        if let Some(settings) = packs.get("settings") {
            let map = settings
                .as_object()
                .ok_or_else(|| "packs.settings는 객체여야 합니다".to_string())?;
            let st = target
                .entry("settings")
                .or_insert_with(|| Value::Object(Map::new()))
                .as_object_mut()
                .ok_or_else(|| "packs.settings 블록이 객체가 아닙니다".to_string())?;
            // 팩 단위로 통째 교체 — 팩 스키마는 팩이 아는 것이고 호스트는 키를 모른다.
            for (pack_id, values) in map {
                if !values.is_object() {
                    return Err(format!("packs.settings.{pack_id}는 객체여야 합니다"));
                }
                st.insert(pack_id.clone(), values.clone());
            }
        }
    }

    write_atomic(path, serde_json::to_string_pretty(&raw).unwrap().as_bytes())
        .map_err(|e| format!("config.json 저장 실패: {e}"))?;
    Ok(view(&raw, true))
}

pub fn save_patch(patch: &Value) -> Result<ConfigView, String> {
    let view = save_patch_at(&config_path(), patch)?;
    refresh_view();
    Ok(view)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all().ok();
    }
    std::fs::rename(&tmp, path)
}

// ---------- diagnostics ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDiag {
    pub name: String,
    pub path_ok: bool,
    pub git_ok: bool,
    pub branch_ok: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub config_exists: bool,
    pub vault_path_ok: bool,
    pub claude_ok: bool,
    pub claude_version: Option<String>,
    pub herdr: HerdrDiag,
    pub projects: Vec<ProjectDiag>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HerdrDiag {
    /// configured mode, echoed so the UI can explain the effective runner
    pub mode: String,
    pub bin_ok: bool,
    pub version: Option<String>,
    pub server_ok: bool,
    /// what the next job would actually use: "herdr" | "headless"
    pub effective_runner: String,
    /// herdr를 못 쓸 때 그 이유. herdr가 실제로 쓰이면 없다.
    pub reason: Option<String>,
}

fn build_command(bin: &str, args: &[&str]) -> std::process::Command {
    crate::spawn::platform_command(bin, args)
}

async fn probe(bin: &str, args: &[&str], cwd: Option<&Path>) -> Option<String> {
    let mut c = build_command(bin, args);
    if let Some(dir) = cwd {
        c.current_dir(dir);
    }
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        tokio::process::Command::from(c).output(),
    )
    .await
    .ok()?
    .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !s.is_empty() {
        Some(s.lines().next().unwrap_or("").to_string())
    } else {
        None
    }
}

/// What the next job would actually run on, without launching anything.
pub async fn herdr_diagnostics(cfg: &HerdrCfg) -> HerdrDiag {
    let cfg = cfg.sanitized();
    let h = crate::herdr::Herdr::new(&cfg);
    let (version, server_ok) = if cfg.mode == "headless" {
        (None, false)
    } else {
        let v = h.version().await;
        let up = v.is_some() && h.reachable().await;
        (v, up)
    };
    let effective = match cfg.mode.as_str() {
        "headless" => "headless",
        "herdr" => "herdr",
        _ if server_ok => "herdr",
        _ => "headless",
    };
    // 폴백은 조용히 일어나지 않는다 — 다음 잡이 headless로 돌 거면 이유를 함께 알린다.
    let reason = if effective == "herdr" {
        None
    } else {
        Some(match cfg.mode.as_str() {
            "headless" => "설정에서 headless 모드를 쓴다".to_string(),
            "herdr" if version.is_none() => "herdr 실행 파일을 찾지 못했다".to_string(),
            "herdr" => "herdr 서버에 연결하지 못했다".to_string(),
            _ => "herdr에 연결할 수 없어 headless로 실행한다".to_string(),
        })
    };
    HerdrDiag {
        mode: cfg.mode.clone(),
        bin_ok: version.is_some(),
        version,
        server_ok,
        effective_runner: effective.into(),
        reason,
    }
}

pub async fn run_diagnostics(view: &ConfigView) -> Diagnostics {
    let vault_ok = !view.vault_path.is_empty() && Path::new(&view.vault_path).is_dir();
    let claude = probe(&view.dashboard.claude_bin, &["--version"], None).await;
    let herdr = herdr_diagnostics(&view.dashboard.herdr).await;
    let mut projects = Vec::new();
    for p in &view.projects {
        let path = Path::new(&p.path);
        let path_ok = !p.path.is_empty() && path.is_dir();
        let git_ok = path_ok && path.join(".git").exists();
        let branch_ok = if git_ok && !p.work_branch.is_empty() {
            probe("git", &["branch", "--list", &p.work_branch], Some(path))
                .await
                .map(|s| !s.trim().is_empty())
        } else {
            None
        };
        projects.push(ProjectDiag {
            name: p.name.clone(),
            path_ok,
            git_ok,
            branch_ok,
        });
    }
    Diagnostics {
        config_exists: view.exists,
        vault_path_ok: vault_ok,
        claude_ok: claude.is_some(),
        claude_version: claude,
        herdr,
        projects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("swdash-test-{}-{}.json", tag, uuid::Uuid::new_v4()))
    }

    #[test]
    fn view_defaults_when_missing() {
        let v = view(&Value::Object(Map::new()), false);
        assert!(!v.exists);
        assert_eq!(v.vault_path, "");
        assert_eq!(v.dashboard.permission_mode, "bypassPermissions");
        assert_eq!(v.dashboard.claude_bin, "claude");
        assert_eq!(v.dashboard.schedules.morning.time, "09:00");
        assert_eq!(v.dashboard.herdr.child_model_policy, "auto");
        assert_eq!(v.dashboard.herdr.max_parallel, 2);
    }

    #[test]
    fn child_model_policy_patch_preserves_explicit_capacity_and_unknown_keys() {
        let path = temp_path("child-model");
        write_atomic(
            &path,
            br#"{"dashboard":{"herdr":{"maxParallel":1,"customKey":"keep"}}}"#,
        )
        .unwrap();
        let v = save_patch_at(
            &path,
            &serde_json::json!({"dashboard":{"herdr":{"childModelPolicy":"inherit"}}}),
        )
        .unwrap();
        assert_eq!(v.dashboard.herdr.child_model_policy, "inherit");
        assert_eq!(v.dashboard.herdr.max_parallel, 1);
        assert_eq!(
            load_raw_at(&path)["dashboard"]["herdr"]["customKey"],
            "keep"
        );
        assert!(save_patch_at(
            &path,
            &serde_json::json!({"dashboard":{"herdr":{"childModelPolicy":"cheap"}}})
        )
        .is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn patch_preserves_unknown_keys_and_order() {
        let path = temp_path("preserve");
        let initial: Value = serde_json::from_str(
            r#"{
                "vaultPath": "C:\\old",
                "customTop": {"a": 1},
                "improve": {
                    "defaultProject": "FDR",
                    "projects": {"FDR": {"path": "D:\\w", "workBranch": "improve/fdr",
                                          "portableBase": "", "idPrefix": "FDR", "verify": "mvn",
                                          "unknownProjectKey": true}}
                }
            }"#,
        )
        .unwrap();
        write_atomic(
            &path,
            serde_json::to_string_pretty(&initial).unwrap().as_bytes(),
        )
        .unwrap();

        let patch = serde_json::json!({
            "vaultPath": "C:\\new",
            "dashboard": {"claudeBin": "/usr/local/bin/claude"}
        });
        let v = save_patch_at(&path, &patch).unwrap();

        assert_eq!(v.vault_path, "C:\\new");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("customTop"), "unknown key dropped: {text}");
        assert!(
            text.contains("unknownProjectKey"),
            "project unknown key dropped: {text}"
        );
        // key order: vaultPath stays before customTop, dashboard appended last
        let vp = text.find("\"vaultPath\"").unwrap();
        let ct = text.find("\"customTop\"").unwrap();
        let db = text.find("\"dashboard\"").unwrap();
        assert!(vp < ct && ct < db);
        assert_eq!(v.dashboard.claude_bin, "/usr/local/bin/claude");
        // untouched dashboard defaults survive round-trip
        assert_eq!(v.dashboard.schedules.evening.time, "18:00");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn projects_array_becomes_map() {
        let path = temp_path("projects");
        let patch = serde_json::json!({
            "projects": [
                {"name": "FDR", "path": "D:\\w", "workBranch": "improve/fdr",
                 "portableBase": "origin/dev", "idPrefix": "FDR", "verify": "mvn -o -q compile"},
                {"name": "ABC", "path": "D:\\a", "workBranch": "improve/abc",
                 "portableBase": "", "idPrefix": "ABC", "verify": ""}
            ]
        });
        let v = save_patch_at(&path, &patch).unwrap();
        assert_eq!(v.projects.len(), 2);
        assert_eq!(v.projects[0].name, "FDR");
        assert_eq!(v.projects[0].work_branch, "improve/fdr");

        // saved file shape: projects keyed by name, no "name" field inside
        let raw = load_raw_at(&path);
        let fdr = &raw["improve"]["projects"]["FDR"];
        assert_eq!(fdr["idPrefix"], "FDR");
        assert!(fdr.get("name").is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schedules_merge_per_routine() {
        let path = temp_path("sched");
        let patch = serde_json::json!({
            "dashboard": {"schedules": {"lunch": {"enabled": false, "time": "13:10"}}}
        });
        let v = save_patch_at(&path, &patch).unwrap();
        assert!(!v.dashboard.schedules.lunch.enabled);
        assert_eq!(v.dashboard.schedules.lunch.time, "13:10");
        assert!(
            v.dashboard.schedules.morning.enabled,
            "morning must keep default"
        );
        assert_eq!(v.dashboard.schedules.morning.time, "09:00");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn invalid_inputs_rejected() {
        let path = temp_path("invalid");
        let bad_time = serde_json::json!({"dashboard": {"schedules": {"morning": {"enabled": true, "time": "25:00"}}}});
        assert!(save_patch_at(&path, &bad_time).is_err());
        let bad_mode = serde_json::json!({"dashboard": {"permissionMode": "yolo"}});
        assert!(save_patch_at(&path, &bad_mode).is_err());
        let bad_project = serde_json::json!({"projects": [{"path": "x"}]});
        assert!(save_patch_at(&path, &bad_project).is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn packs_block_saves_and_preserves_neighbours() {
        let path = temp_path("packs");
        let initial: Value = serde_json::from_str(
            r#"{"vaultPath": "/v", "packs": {"enabled": ["si"],
                 "settings": {"si": {"excelOutputDir": "/out"}, "other": {"keep": true}}}}"#,
        )
        .unwrap();
        write_atomic(
            &path,
            serde_json::to_string_pretty(&initial).unwrap().as_bytes(),
        )
        .unwrap();

        let v = save_patch_at(
            &path,
            &serde_json::json!({"packs": {"enabled": ["si", "starter"],
                                          "settings": {"si": {"excelOutputDir": "/new"}}}}),
        )
        .unwrap();
        assert_eq!(
            v.packs.enabled,
            vec!["si".to_string(), "starter".to_string()]
        );
        assert_eq!(v.pack_setting_str("si", "excelOutputDir"), "/new");
        assert!(
            v.packs.settings.get("other").is_some(),
            "패치에 없는 팩 설정은 남아야 한다"
        );

        assert!(save_patch_at(&path, &serde_json::json!({"packs": {"enabled": "si"}})).is_err());
        assert!(save_patch_at(
            &path,
            &serde_json::json!({"packs": {"settings": {"si": 1}}})
        )
        .is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schedule_map_carries_pack_keys_with_legacy_fallback() {
        let v = view(
            &serde_json::json!({"dashboard": {"schedules": {
                "morning": {"enabled": true, "time": "08:10"},
                "si.lunch": {"enabled": false, "time": "13:00"}}}}),
            true,
        );
        // 정규 키가 있으면 그것
        assert_eq!(
            v.schedule_override("si.lunch", "lunch").unwrap().time,
            "13:00"
        );
        // 없으면 예전 루틴 키
        assert_eq!(
            v.schedule_override("si.morning", "morning").unwrap().time,
            "08:10"
        );
        // 둘 다 없으면 팩 기본값을 쓰라는 뜻
        assert!(v.schedule_override("si.evening", "evening").is_none());
        // 기존 타입 계약도 유지
        assert_eq!(v.dashboard.schedules.morning.time, "08:10");
    }

    #[test]
    fn empty_packs_config_means_everything_enabled() {
        let v = view(&Value::Object(Map::new()), false);
        assert!(v.packs.enabled.is_empty());
        assert!(v.pack_settings("si").is_empty());
    }

    #[test]
    fn validate_hhmm_cases() {
        assert!(validate_hhmm("00:00").is_ok());
        assert!(validate_hhmm("23:59").is_ok());
        assert!(validate_hhmm("9:00").is_ok());
        assert!(validate_hhmm("24:00").is_err());
        assert!(validate_hhmm("12:60").is_err());
        assert!(validate_hhmm("noon").is_err());
        assert!(validate_hhmm("12").is_err());
    }
}
