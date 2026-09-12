// Extension manifest contract. Design lines 591-679: three layers — bundle → component → configured instance.
//
// - bundle: the deployed unit that gets installed/updated (extension.json)
// - component: a pack or connector implementation inside the bundle
// - instance: the account/repository/feed bundle a user connected. Grants, secret refs,
//   and cursors belong to the instance, not the bundle (design 597).
//
// MVP execution trust tier (648-659): only host-implemented adapters like `builtin:github`
// and `builtin:rss` with declarative config. A user bundle cannot silently overwrite a
// built-in connector with the same ID (612-614).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// Permissions requested by a connector (design 630-634 example).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionRequests {
    /// Read/write levels. E.g. repository: ["read"], issues: ["read", "write"]
    pub repository: Vec<String>,
    pub issues: Vec<String>,
    /// Network domain allowlist.
    pub network: Vec<String>,
    /// Secret ref names (e.g. github.oauth). The token itself never goes into the manifest.
    pub secrets: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SourceContribution {
    pub id: String,
    /// issue | article. On the wire it is `type`, as in the design example.
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ViewContribution {
    pub id: String,
    /// Only pre-registered host renderers are allowed (design 673-674).
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
    /// connector | pack. On the wire it is `type`, as in the design example.
    #[serde(rename = "type")]
    pub kind: String,
    /// builtin:github | builtin:rss | (later wasi:...)
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
    /// Bundle ID. Must be globally unique (design 611).
    pub id: String,
    pub name: String,
    pub version: String,
    /// Minimum host core version. Semantic compare looks at major only (MVP).
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

/// Built-in extensions are discovered from app resources, user extensions from ~/.claude/sawhorse/extensions/ (design 608-610).
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

/// Checks attempts by a user bundle to overwrite a built-in connector (design 612-614).
/// Explicit override is allowed only in developer mode.
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

/// A configured connector instance. The unit where a user connected account, repository, or feed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ConnectorInstance {
    pub instance_id: String,
    pub extension_id: String,
    pub component_id: String,
    /// Per-adapter config (feed URL list, GitHub account/repo, etc.).
    pub config: serde_json::Value,
    /// Approved permissions. Paused when differing from the manifest request.
    pub grant: PermissionRequests,
    /// Suspended until increased permissions are re-approved (design 664).
    pub paused: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Permission-increase check on update. True when increased — the instance goes paused (design 664).
pub fn permission_increased(old: &PermissionRequests, new: &PermissionRequests) -> bool {
    let added =
        |old_list: &[String], new_list: &[String]| new_list.iter().any(|v| !old_list.contains(v));
    added(&old.repository, &new.repository)
        || added(&old.issues, &new.issues)
        || added(&old.network, &new.network)
        || added(&old.secrets, &new.secrets)
}

/// Extension capability catalog (design 671-672). `local_integrate` is not an extension capability.
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
