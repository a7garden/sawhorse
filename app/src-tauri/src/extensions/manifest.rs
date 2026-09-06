// 확장 manifest 계약. 설계 591-679줄: bundle → component → configured instance 3층.
//
// - bundle: 설치·업데이트하는 배포 단위(extension.json)
// - component: bundle 안의 pack 또는 connector 구현
// - instance: 사용자가 연결한 계정·저장소·feed 묶음. grant·secret ref·cursor는
//   bundle이 아니라 instance에 귀속된다(설계 597줄).
//
// MVP 실행 신뢰 단계(648-659줄): `builtin:github`, `builtin:rss` 같은 호스트 구현
// 어댑터와 선언형 설정만 허용한다. 사용자 bundle이 같은 ID의 내장 connector를
// 조용히 덮어쓰지 못한다(612-614줄).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// connector가 요청하는 권한(설계 630-634줄 예시).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionRequests {
    /// 읽기·쓰기 수준. 예: repository: ["read"], issues: ["read", "write"]
    pub repository: Vec<String>,
    pub issues: Vec<String>,
    /// 네트워크 도메인 allowlist.
    pub network: Vec<String>,
    /// secret ref 이름(예: github.oauth). 토큰 자체는 manifest에 절대 넣지 않는다.
    pub secrets: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceContribution {
    pub id: String,
    /// issue | article. wire에서는 설계 예시 그대로 `type`이다.
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    /// 사전 등록된 호스트 renderer만 허용한다(설계 673-674줄).
    pub renderer: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ComponentContribution {
    #[serde(default)]
    pub sources: Vec<SourceContribution>,
    #[serde(default)]
    pub views: Vec<ViewContribution>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtensionComponent {
    pub id: String,
    /// connector | pack. wire에서는 설계 예시 그대로 `type`이다.
    #[serde(rename = "type")]
    pub kind: String,
    /// builtin:github | builtin:rss | (추후 wasi:...)
    pub adapter: String,
    #[serde(default)]
    pub requests: PermissionRequests,
    #[serde(default)]
    pub subscriptions: Vec<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub contributes: ComponentContribution,
}

impl Default for ExtensionComponent {
    fn default() -> Self {
        ExtensionComponent {
            id: String::new(),
            kind: "connector".into(),
            adapter: String::new(),
            requests: Default::default(),
            subscriptions: vec![],
            commands: vec![],
            contributes: Default::default(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExtensionManifest {
    pub schema_version: u32,
    /// bundle ID. 전역에서 유일해야 한다(설계 611줄).
    pub id: String,
    pub name: String,
    pub version: String,
    /// 호스트 코어 최소 버전. semantic compare는 major만 본다(MVP).
    pub min_core_version: String,
    #[serde(default)]
    pub components: Vec<ExtensionComponent>,
}

impl Default for ExtensionManifest {
    fn default() -> Self {
        ExtensionManifest {
            schema_version: 1,
            id: String::new(),
            name: String::new(),
            version: "0.0.0".into(),
            min_core_version: "0.0.0".into(),
            components: vec![],
        }
    }
}

impl ExtensionManifest {
    pub fn parse(json: &str) -> Result<ExtensionManifest, String> {
        let m: ExtensionManifest =
            serde_json::from_str(json).map_err(|e| format!("extension.json 해석 실패: {e}"))?;
        m.validate()?;
        Ok(m)
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SUPPORTED_SCHEMA_VERSION {
            return Err(format!(
                "지원하지 않는 schemaVersion: {}",
                self.schema_version
            ));
        }
        let id_ok = !self.id.is_empty()
            && self.id.len() <= 40
            && self
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
        if !id_ok {
            return Err(format!("bundle id 규칙 위반: '{}'", self.id));
        }
        if self.components.is_empty() {
            return Err("component가 하나 이상 필요하다".into());
        }
        let mut seen = std::collections::HashSet::new();
        for c in &self.components {
            if !seen.insert(c.id.as_str()) {
                return Err(format!("component id 중복: {}", c.id));
            }
            match c.kind.as_str() {
                "connector" | "pack" => {}
                other => return Err(format!("알 수 없는 component kind: {other}")),
            }
            if c.kind == "connector"
                && !c.adapter.starts_with("builtin:")
                && !c.adapter.starts_with("wasi:")
            {
                return Err(format!(
                    "connector {}의 adapter는 builtin: 또는 wasi: 접두사가 필요하다 (샌드박스 없는 native connector는 허용하지 않는다, 설계 658-659줄)",
                    c.id
                ));
            }
        }
        Ok(())
    }

    pub fn component(&self, id: &str) -> Option<&ExtensionComponent> {
        self.components.iter().find(|c| c.id == id)
    }
}

// ---------- discovery ----------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredBundle {
    pub manifest: ExtensionManifest,
    /// builtin | user
    pub source: String,
    pub dir: String,
}

/// 내장 확장은 앱 리소스에서, 사용자 확장은 ~/.claude/sawhorse/extensions/에서 발견한다(설계 608-610줄).
pub fn discover(builtin_root: Option<&Path>) -> Result<Vec<DiscoveredBundle>, String> {
    let mut out = Vec::new();
    let mut push_dir = |dir: &Path, source: &str| {
        let manifest_path = dir.join("extension.json");
        if let Ok(json) = std::fs::read_to_string(&manifest_path) {
            match ExtensionManifest::parse(&json) {
                Ok(m) => out.push(DiscoveredBundle {
                    manifest: m,
                    source: source.to_string(),
                    dir: dir.to_string_lossy().to_string(),
                }),
                Err(e) => eprintln!("extension.json 무시: {manifest_path:?}: {e}"),
            }
        }
    };
    if let Some(root) = builtin_root {
        if let Ok(entries) = std::fs::read_dir(root) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    push_dir(&e.path(), "builtin");
                }
            }
        }
    }
    let user_root = user_extensions_dir();
    if std::fs::create_dir_all(&user_root).is_ok() {
        if let Ok(entries) = std::fs::read_dir(&user_root) {
            for e in entries.flatten() {
                if e.path().is_dir() {
                    push_dir(&e.path(), "user");
                }
            }
        }
    }
    Ok(out)
}

pub fn user_extensions_dir() -> PathBuf {
    crate::collab::workbench_root().join("extensions")
}

/// 사용자 bundle이 내장 connector를 덮어쓰려는 시도 검사(설계 612-614줄).
/// 개발자 모드에서만 명시적 override를 허용한다.
pub fn check_override_conflicts(
    bundles: &[DiscoveredBundle],
    allow_override: bool,
) -> Result<(), String> {
    let mut by_id: BTreeMap<&str, &str> = BTreeMap::new();
    for b in bundles {
        match by_id.get(b.manifest.id.as_str()) {
            None => {
                by_id.insert(&b.manifest.id, b.source.as_str());
            }
            Some(existing_source) => {
                let user_wins = b.source == "user" && *existing_source == "builtin";
                if user_wins && !allow_override {
                    return Err(format!(
                        "사용자 bundle '{}'이 내장 bundle을 덮어쓸 수 없다 (개발자 모드 override 필요)",
                        b.manifest.id
                    ));
                }
                by_id.insert(&b.manifest.id, b.source.as_str());
            }
        }
    }
    Ok(())
}

// ---------- instance · grant ----------

/// 설정된 connector instance. 사용자가 계정·저장소·feed를 연결한 단위.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectorInstance {
    pub instance_id: String,
    pub extension_id: String,
    pub component_id: String,
    /// adapter별 설정(feed URL 목록, GitHub account/repo 등).
    pub config: serde_json::Value,
    /// 승인된 권한. manifest 요청과 다르면 paused다.
    pub grant: PermissionRequests,
    /// 권한 증가 재승인 전까지 기능 정지(설계 664줄).
    pub paused: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 업데이트 시 권한 증가 검사. 증가가 있으면 true — instance를 paused로 둔다(설계 664줄).
pub fn permission_increased(old: &PermissionRequests, new: &PermissionRequests) -> bool {
    let added =
        |old_list: &[String], new_list: &[String]| new_list.iter().any(|v| !old_list.contains(v));
    added(&old.repository, &new.repository)
        || added(&old.issues, &new.issues)
        || added(&old.network, &new.network)
        || added(&old.secrets, &new.secrets)
}

/// 확장 capability 카탈로그(설계 671-672줄). `local_integrate`는 확장 capability가 아니다.
pub const CAPABILITY_REMOTE_BRANCH_PUSH: &str = "remote_branch_push";
pub const CAPABILITY_PULL_REQUEST_CREATE: &str = "pull_request_create";
pub const CAPABILITY_ISSUE_WRITE: &str = "issue_write";
pub const CAPABILITY_SECRET_USE: &str = "secret_use";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_design_example_manifest() {
        let json = r#"{
            "schemaVersion": 1,
            "id": "github",
            "name": "GitHub",
            "version": "0.1.0",
            "components": [{
                "id": "issues",
                "type": "connector",
                "adapter": "builtin:github",
                "requests": {
                    "repository": ["read"],
                    "issues": ["read"],
                    "network": ["api.github.com"],
                    "secrets": ["github.oauth"]
                },
                "subscriptions": ["issue.changed", "integration.verified"],
                "commands": ["github.syncIssues", "github.publishIssue"],
                "contributes": {
                    "sources": [{ "id": "issues", "type": "issue" }],
                    "views": [{ "id": "github-sync", "renderer": "sync-status" }]
                }
            }]
        }"#;
        let m = ExtensionManifest::parse(json).unwrap();
        assert_eq!(m.id, "github");
        let c = m.component("issues").unwrap();
        assert_eq!(c.requests.network, vec!["api.github.com".to_string()]);
        assert_eq!(c.kind, "connector");
        assert_eq!(c.contributes.sources[0].kind, "issue");
    }

    #[test]
    fn rejects_unknown_kind_and_bad_adapter() {
        let json = r#"{
            "schemaVersion": 1, "id": "x", "name": "X", "version": "0.1.0",
            "components": [{ "id": "c", "type": "native-code", "adapter": "builtin:x" }]
        }"#;
        assert!(ExtensionManifest::parse(json).is_err());
        let json2 = r#"{
            "schemaVersion": 1, "id": "x", "name": "X", "version": "0.1.0",
            "components": [{ "id": "c", "type": "connector", "adapter": "./evil-binary" }]
        }"#;
        assert!(
            ExtensionManifest::parse(json2).is_err(),
            "샌드박스 없는 native adapter 거부"
        );
    }

    #[test]
    fn rejects_duplicate_component_ids() {
        let json = r#"{
            "schemaVersion": 1, "id": "x", "name": "X", "version": "0.1.0",
            "components": [
                { "id": "c", "type": "connector", "adapter": "builtin:x" },
                { "id": "c", "type": "connector", "adapter": "builtin:y" }
            ]
        }"#;
        assert!(ExtensionManifest::parse(json).is_err());
    }

    #[test]
    fn permission_increase_detection() {
        let old = PermissionRequests {
            repository: vec!["read".into()],
            issues: vec!["read".into()],
            network: vec!["api.github.com".into()],
            secrets: vec![],
        };
        let same = old.clone();
        assert!(!permission_increased(&old, &same));
        let escalated = PermissionRequests {
            issues: vec!["read".into(), "write".into()],
            secrets: vec!["github.oauth".into()],
            ..old.clone()
        };
        assert!(permission_increased(&old, &escalated));
    }

    #[test]
    fn user_bundle_cannot_shadow_builtin() {
        let mk = |source: &str| DiscoveredBundle {
            manifest: ExtensionManifest {
                id: "github".into(),
                ..Default::default()
            },
            source: source.into(),
            dir: String::new(),
        };
        let bundles = vec![mk("builtin"), mk("user")];
        assert!(check_override_conflicts(&bundles, false).is_err());
        assert!(check_override_conflicts(&bundles, true).is_ok());
    }
}
