// config.json load/save. The plugin (setup/improve skills, improve-xlsx.mjs) owns
// this file's schema; the dashboard only merges known keys and preserves the rest
// (including key order, via serde_json preserve_order).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub fn config_path() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".claude").join("si-workbench").join("config.json")
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
        Self { enabled: false, time: "00:00".into() }
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
            morning: RoutineSched { enabled: true, time: "09:00".into() },
            lunch: RoutineSched { enabled: true, time: "12:30".into() },
            evening: RoutineSched { enabled: true, time: "18:00".into() },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct DashboardCfg {
    pub schedules: Schedules,
    pub excel_output_dir: String,
    pub claude_bin: String,
    pub permission_mode: String,
    pub launch_at_login: bool,
}

impl Default for DashboardCfg {
    fn default() -> Self {
        Self {
            schedules: Schedules::default(),
            excel_output_dir: String::new(),
            claude_bin: "claude".into(),
            permission_mode: "bypassPermissions".into(),
            launch_at_login: false,
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    pub exists: bool,
    pub vault_path: String,
    pub default_project: String,
    pub projects: Vec<ProjectCfg>,
    pub dashboard: DashboardCfg,
}

pub fn view(raw: &Value, exists: bool) -> ConfigView {
    let obj = raw.as_object();
    let vault_path = obj
        .and_then(|o| o.get("vaultPath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let improve = obj.and_then(|o| o.get("improve")).and_then(Value::as_object);
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
    let dashboard = obj
        .and_then(|o| o.get("dashboard"))
        .and_then(|v| serde_json::from_value::<DashboardCfg>(v.clone()).ok())
        .unwrap_or_default();
    ConfigView { exists, vault_path, default_project, projects, dashboard }
}

pub fn load_view() -> ConfigView {
    let path = config_path();
    let exists = path.is_file();
    view(&load_raw_at(&path), exists)
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
        let list = arr.as_array().ok_or_else(|| "projects는 배열이어야 합니다".to_string())?;
        let mut map = Map::new();
        for pv in list {
            let p: ProjectCfg = serde_json::from_value(pv.clone())
                .map_err(|e| format!("프로젝트 항목 파싱 실패: {e}"))?;
            if p.name.trim().is_empty() {
                return Err("사업명이 빈 프로젝트 항목이 있습니다".into());
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

    if let Some(dash) = patch.get("dashboard").and_then(Value::as_object) {
        let target = obj
            .entry("dashboard")
            .or_insert_with(|| Value::Object(Map::new()))
            .as_object_mut()
            .ok_or_else(|| "dashboard 블록이 객체가 아닙니다".to_string())?;
        for (k, v) in dash {
            match k.as_str() {
                "schedules" => {
                    let sv = v.as_object().ok_or_else(|| "schedules는 객체여야 합니다".to_string())?;
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
                    let mode = v.as_str().ok_or_else(|| "permissionMode는 문자열이어야 합니다".to_string())?;
                    if !PERMISSION_MODES.contains(&mode) {
                        return Err(format!("알 수 없는 permissionMode: {mode}"));
                    }
                    target.insert(k.clone(), v.clone());
                }
                "claudeBin" | "excelOutputDir" => {
                    if !v.is_string() {
                        return Err(format!("{k}는 문자열이어야 합니다"));
                    }
                    target.insert(k.clone(), v.clone());
                }
                _ => {} // launchAtLogin and unknown keys are ignored here
            }
        }
    }

    write_atomic(path, serde_json::to_string_pretty(&raw).unwrap().as_bytes())
        .map_err(|e| format!("config.json 저장 실패: {e}"))?;
    Ok(view(&raw, true))
}

pub fn save_patch(patch: &Value) -> Result<ConfigView, String> {
    save_patch_at(&config_path(), patch)
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
    pub projects: Vec<ProjectDiag>,
}

fn build_command(bin: &str, args: &[&str]) -> std::process::Command {
    #[cfg(windows)]
    {
        let mut c = std::process::Command::new("cmd");
        c.arg("/c").arg(bin).args(args);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = std::process::Command::new(bin);
        c.args(args);
        c
    }
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

pub async fn run_diagnostics(view: &ConfigView) -> Diagnostics {
    let vault_ok = !view.vault_path.is_empty() && Path::new(&view.vault_path).is_dir();
    let claude = probe(&view.dashboard.claude_bin, &["--version"], None).await;
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
        projects.push(ProjectDiag { name: p.name.clone(), path_ok, git_ok, branch_ok });
    }
    Diagnostics {
        config_exists: view.exists,
        vault_path_ok: vault_ok,
        claude_ok: claude.is_some(),
        claude_version: claude,
        projects,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "swdash-test-{}-{}.json",
            tag,
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn view_defaults_when_missing() {
        let v = view(&Value::Object(Map::new()), false);
        assert!(!v.exists);
        assert_eq!(v.vault_path, "");
        assert_eq!(v.dashboard.permission_mode, "bypassPermissions");
        assert_eq!(v.dashboard.claude_bin, "claude");
        assert_eq!(v.dashboard.schedules.morning.time, "09:00");
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
        write_atomic(&path, serde_json::to_string_pretty(&initial).unwrap().as_bytes()).unwrap();

        let patch = serde_json::json!({
            "vaultPath": "C:\\new",
            "dashboard": {"claudeBin": "/usr/local/bin/claude"}
        });
        let v = save_patch_at(&path, &patch).unwrap();

        assert_eq!(v.vault_path, "C:\\new");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("customTop"), "unknown key dropped: {text}");
        assert!(text.contains("unknownProjectKey"), "project unknown key dropped: {text}");
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
        assert!(v.dashboard.schedules.morning.enabled, "morning must keep default");
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
