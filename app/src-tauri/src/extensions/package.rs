use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Utc;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const MANIFEST_VERSION: u32 = 2;
const ENGINE_VERSION: &str = "1.0.0";
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 4_096;

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("sawhorse-extension-{}", Uuid::new_v4())))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PackageDependency {
    pub id: String,
    pub requirement: String,
    pub optional: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PackageContributions {
    pub workflows: Vec<String>,
    pub schemas: Vec<String>,
    pub templates: Vec<String>,
    pub views: Vec<String>,
    pub actions: Vec<String>,
    pub skills: Vec<String>,
    pub analyzers: Vec<String>,
    pub exporters: Vec<String>,
}

impl PackageContributions {
    fn paths(&self) -> impl Iterator<Item = &String> {
        self.workflows
            .iter()
            .chain(&self.schemas)
            .chain(&self.templates)
            .chain(&self.views)
            .chain(&self.actions)
            .chain(&self.skills)
            .chain(&self.analyzers)
            .chain(&self.exporters)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionPackageManifest {
    pub manifest_version: u32,
    pub id: String,
    pub publisher: String,
    pub name: String,
    pub version: String,
    pub engine_api: String,
    pub dependencies: Vec<PackageDependency>,
    pub provides: Vec<String>,
    pub contributions: PackageContributions,
    /// Host-enforced scopes such as vault:read, vault:write, network:example.com.
    pub permissions: Vec<String>,
    /// Every regular payload file except extension.json.
    pub file_digests: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PortablePackage {
    pub manifest: ExtensionPackageManifest,
    pub files: BTreeMap<String, PortableFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum PortableFile {
    /// Compatibility with the initial text-only portable package draft.
    Text(String),
    Encoded {
        encoding: String,
        data: String,
    },
}

impl Default for PortableFile {
    fn default() -> Self {
        Self::Text(String::new())
    }
}

impl PortableFile {
    fn bytes(self) -> Result<Vec<u8>, String> {
        match self {
            Self::Text(value) => Ok(value.into_bytes()),
            Self::Encoded { encoding, data } if encoding == "base64" => BASE64
                .decode(data)
                .map_err(|error| format!("portable package base64 해석 실패: {error}")),
            Self::Encoded { encoding, .. } => Err(format!(
                "지원하지 않는 portable file encoding입니다: {encoding}"
            )),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionInstallInput {
    /// local-directory | local-file | git | https
    pub kind: String,
    pub location: String,
    /// Required 40-hex commit for git sources.
    pub commit: Option<String>,
    pub subdir: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct InstalledPackage {
    pub manifest: ExtensionPackageManifest,
    pub digest: String,
    pub path: String,
    pub source: String,
    pub commit: Option<String>,
    pub installed_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct LockedPackage {
    pub id: String,
    pub version: String,
    pub digest: String,
    pub permissions: Vec<String>,
    pub source: String,
    pub commit: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionLock {
    pub format_version: u32,
    pub projects: BTreeMap<String, Vec<LockedPackage>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionActivateInput {
    pub project_id: String,
    pub package_id: String,
    pub version: String,
    /// Explicit grants keyed by package ID, including dependencies.
    pub grants: BTreeMap<String, Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
struct InstallMetadata {
    source: String,
    commit: Option<String>,
    installed_at: String,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 38
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_relative(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !value.starts_with(".git/")
        && value != ".git"
}

fn valid_permission(value: &str) -> bool {
    matches!(value, "vault:read" | "vault:write")
        || value
            .strip_prefix("network:")
            .is_some_and(|host| !host.is_empty() && !host.contains(['/', '\\', ' ']))
        || value
            .strip_prefix("secret:")
            .is_some_and(|name| valid_relative(name))
        || value
            .strip_prefix("adapter:")
            .is_some_and(|name| valid_id(name))
}

fn validate_manifest(manifest: &ExtensionPackageManifest) -> Result<(), String> {
    if manifest.manifest_version != MANIFEST_VERSION {
        return Err(format!(
            "지원하지 않는 extension manifestVersion입니다: {}",
            manifest.manifest_version
        ));
    }
    if !valid_id(&manifest.id) {
        return Err("extension package ID는 소문자·숫자·하이픈 38자 이하여야 합니다".into());
    }
    Version::parse(&manifest.version)
        .map_err(|error| format!("package semver가 유효하지 않습니다: {error}"))?;
    let engine = VersionReq::parse(&manifest.engine_api)
        .map_err(|error| format!("engineApi semver 범위가 유효하지 않습니다: {error}"))?;
    if !engine.matches(&Version::parse(ENGINE_VERSION).expect("constant semver")) {
        return Err(format!(
            "현재 engine {ENGINE_VERSION}이 package 범위 {}와 맞지 않습니다",
            manifest.engine_api
        ));
    }
    let mut dependencies = HashSet::new();
    for dependency in &manifest.dependencies {
        if !valid_id(&dependency.id) || !dependencies.insert(&dependency.id) {
            return Err(format!(
                "dependency ID가 유효하지 않거나 중복입니다: {}",
                dependency.id
            ));
        }
        VersionReq::parse(&dependency.requirement).map_err(|error| {
            format!(
                "dependency {} 범위가 유효하지 않습니다: {error}",
                dependency.id
            )
        })?;
    }
    let mut permissions = HashSet::new();
    for permission in &manifest.permissions {
        if !valid_permission(permission) || !permissions.insert(permission) {
            return Err(format!(
                "알 수 없거나 중복된 permission입니다: {permission}"
            ));
        }
    }
    for path in manifest.contributions.paths() {
        let is_skill_directory = manifest.contributions.skills.contains(path)
            && manifest
                .file_digests
                .keys()
                .any(|file| file.starts_with(&format!("{path}/")));
        if path == "extension.json"
            || !valid_relative(path)
            || (!manifest.file_digests.contains_key(path) && !is_skill_directory)
        {
            return Err(format!(
                "contribution이 안전한 digest 대상 파일을 가리켜야 합니다: {path}"
            ));
        }
    }
    if !manifest.contributions.actions.is_empty()
        && (!manifest
            .permissions
            .contains(&format!("adapter:{}", manifest.id))
            || !manifest.permissions.contains(&"vault:write".to_string()))
    {
        return Err(
            "action contribution package는 자신의 adapter와 vault:write 권한을 요청해야 합니다"
                .into(),
        );
    }
    if !manifest.contributions.views.is_empty()
        && !manifest.permissions.contains(&"vault:read".to_string())
    {
        return Err("view contribution package는 vault:read 권한을 요청해야 합니다".into());
    }
    for (path, digest) in &manifest.file_digests {
        if !valid_relative(path)
            || digest.len() != 64
            || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(format!("fileDigests 항목이 유효하지 않습니다: {path}"));
        }
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn payload_files(root: &Path) -> Result<BTreeMap<String, Vec<u8>>, String> {
    fn visit(
        root: &Path,
        directory: &Path,
        output: &mut BTreeMap<String, Vec<u8>>,
    ) -> Result<(), String> {
        for entry in
            fs::read_dir(directory).map_err(|error| format!("package 파일 목록 실패: {error}"))?
        {
            let entry = entry.map_err(|error| format!("package 파일 항목 실패: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("package 파일 종류 실패: {error}"))?;
            let path = entry.path();
            if entry.file_name() == ".git" {
                continue;
            }
            if file_type.is_symlink() {
                return Err(format!(
                    "package에는 symlink를 넣을 수 없습니다: {}",
                    path.display()
                ));
            }
            if file_type.is_dir() {
                visit(root, &path, output)?;
                continue;
            }
            if !file_type.is_file() {
                return Err("package에는 일반 파일만 넣을 수 있습니다".into());
            }
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "package 경로 계산 실패".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            if relative == "extension.json" {
                continue;
            }
            if !valid_relative(&relative) {
                return Err(format!("안전하지 않은 package 경로입니다: {relative}"));
            }
            let bytes =
                fs::read(&path).map_err(|error| format!("package 파일 읽기 실패: {error}"))?;
            output.insert(relative, bytes);
        }
        Ok(())
    }
    let mut output = BTreeMap::new();
    visit(root, root, &mut output)?;
    if output.len() > MAX_PACKAGE_FILES
        || output.values().map(|value| value.len() as u64).sum::<u64>() > MAX_PACKAGE_BYTES
    {
        return Err("package 크기 또는 파일 수 상한을 넘었습니다".into());
    }
    Ok(output)
}

fn verify_directory(root: &Path) -> Result<(ExtensionPackageManifest, String), String> {
    let manifest: ExtensionPackageManifest = serde_json::from_slice(
        &fs::read(root.join("extension.json"))
            .map_err(|error| format!("extension.json 읽기 실패: {error}"))?,
    )
    .map_err(|error| format!("extension.json 파싱 실패: {error}"))?;
    validate_manifest(&manifest)?;
    let files = payload_files(root)?;
    if files.len() != manifest.file_digests.len() {
        return Err("fileDigests가 package의 모든 payload 파일을 정확히 포함해야 합니다".into());
    }
    for (path, bytes) in &files {
        if manifest.file_digests.get(path).map(String::as_str) != Some(digest(bytes).as_str()) {
            return Err(format!("package 파일 digest가 다릅니다: {path}"));
        }
    }
    let canonical =
        serde_json::to_vec(&manifest).map_err(|error| format!("manifest 직렬화 실패: {error}"))?;
    Ok((manifest, digest(&canonical)))
}

fn write_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "저장 경로가 잘못되었습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("저장 폴더 생성 실패: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("JSON 직렬화 실패: {error}"))?;
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("임시 파일 생성 실패: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("임시 파일 쓰기 실패: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("임시 파일 동기화 실패: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("파일 교체 실패: {error}")
    })
}

fn packages_root() -> PathBuf {
    crate::collab::workbench_root().join("extension-packages")
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|error| format!("package 대상 폴더 생성 실패: {error}"))?;
    for entry in fs::read_dir(source).map_err(|error| format!("package 복사 목록 실패: {error}"))?
    {
        let entry = entry.map_err(|error| format!("package 복사 항목 실패: {error}"))?;
        if entry.file_name() == ".git" {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("package 복사 종류 실패: {error}"))?;
        if file_type.is_symlink() {
            return Err("symlink package는 설치할 수 없습니다".into());
        }
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination)
                .map_err(|error| format!("package 파일 복사 실패: {error}"))?;
        }
    }
    Ok(())
}

fn metadata_path(directory: &Path) -> PathBuf {
    PathBuf::from(format!("{}.install.json", directory.display()))
}

fn install_directory(
    source: &Path,
    source_label: String,
    commit: Option<String>,
) -> Result<InstalledPackage, String> {
    let (manifest, package_digest) = verify_directory(source)?;
    let destination = packages_root()
        .join(&manifest.id)
        .join(&manifest.version)
        .join(&package_digest);
    let installed_at = Utc::now().to_rfc3339();
    if !destination.is_dir() {
        let parent = destination
            .parent()
            .ok_or_else(|| "package 대상 경로가 잘못되었습니다".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("package 저장소 생성 실패: {error}"))?;
        let staging = parent.join(format!(".staging-{}", Uuid::new_v4()));
        copy_tree(source, &staging)?;
        verify_directory(&staging)?;
        fs::rename(&staging, &destination).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!("package 설치 교체 실패: {error}")
        })?;
    }
    let metadata = InstallMetadata {
        source: source_label.clone(),
        commit: commit.clone(),
        installed_at: installed_at.clone(),
    };
    write_atomic(&metadata_path(&destination), &metadata)?;
    Ok(InstalledPackage {
        manifest,
        digest: package_digest,
        path: destination.display().to_string(),
        source: source_label,
        commit,
        installed_at,
    })
}

fn materialize_portable(portable: PortablePackage, directory: &Path) -> Result<(), String> {
    validate_manifest(&portable.manifest)?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("portable package 폴더 생성 실패: {error}"))?;
    write_atomic(&directory.join("extension.json"), &portable.manifest)?;
    for (path, content) in portable.files {
        if path == "extension.json" || !valid_relative(&path) {
            return Err(format!("portable package 경로가 안전하지 않습니다: {path}"));
        }
        let target = directory.join(path);
        let parent = target
            .parent()
            .ok_or_else(|| "portable package 경로가 잘못되었습니다".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("portable package 폴더 생성 실패: {error}"))?;
        fs::write(target, content.bytes()?)
            .map_err(|error| format!("portable package 쓰기 실패: {error}"))?;
    }
    Ok(())
}

fn read_metadata(path: &Path) -> InstallMetadata {
    fs::read(metadata_path(path))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub fn list_installed() -> Result<Vec<InstalledPackage>, String> {
    let root = packages_root();
    let mut installed = Vec::new();
    if root.is_dir() {
        for package in fs::read_dir(&root)
            .map_err(|error| format!("설치 package 목록 실패: {error}"))?
            .filter_map(Result::ok)
        {
            if !package.path().is_dir() {
                continue;
            }
            for version in fs::read_dir(package.path())
                .map_err(|error| format!("package 버전 목록 실패: {error}"))?
                .filter_map(Result::ok)
            {
                if !version.path().is_dir() {
                    continue;
                }
                for revision in fs::read_dir(version.path())
                    .map_err(|error| format!("package digest 목록 실패: {error}"))?
                    .filter_map(Result::ok)
                {
                    let path = revision.path();
                    if !path.is_dir() || !path.join("extension.json").is_file() {
                        continue;
                    }
                    let (manifest, package_digest) = verify_directory(&path)?;
                    if revision.file_name().to_string_lossy() != package_digest {
                        return Err("설치 package 경로 digest가 내용과 다릅니다".into());
                    }
                    let metadata = read_metadata(&path);
                    installed.push(InstalledPackage {
                        manifest,
                        digest: package_digest,
                        path: path.display().to_string(),
                        source: metadata.source,
                        commit: metadata.commit,
                        installed_at: metadata.installed_at,
                    });
                }
            }
        }
    }
    if let Ok(plugin_root) = crate::plugin::resolve_root() {
        let builtin_root = plugin_root.join("extension-packages");
        if builtin_root.is_dir() {
            for entry in fs::read_dir(builtin_root)
                .map_err(|error| format!("내장 package 목록 실패: {error}"))?
                .filter_map(Result::ok)
            {
                let path = entry.path();
                if !path.is_dir() || !path.join("extension.json").is_file() {
                    continue;
                }
                let (manifest, package_digest) = verify_directory(&path)?;
                installed.push(InstalledPackage {
                    manifest,
                    digest: package_digest,
                    path: path.display().to_string(),
                    source: "builtin".into(),
                    commit: None,
                    installed_at: String::new(),
                });
            }
        }
    }
    installed.sort_by(|left, right| {
        left.manifest
            .id
            .cmp(&right.manifest.id)
            .then_with(|| right.manifest.version.cmp(&left.manifest.version))
    });
    Ok(installed)
}

fn lock_path(root: &Path) -> PathBuf {
    root.join(".sawhorse").join("extensions.lock.json")
}

pub fn read_lock(root: &Path) -> Result<ExtensionLock, String> {
    let path = lock_path(root);
    if !path.is_file() {
        return Ok(ExtensionLock {
            format_version: 1,
            ..Default::default()
        });
    }
    let lock: ExtensionLock = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("extension lock 읽기 실패: {error}"))?,
    )
    .map_err(|error| format!("extension lock 파싱 실패: {error}"))?;
    if lock.format_version != 1 {
        return Err("지원하지 않는 extension lock 형식입니다".into());
    }
    Ok(lock)
}

fn resolve_closure(
    installed: &[InstalledPackage],
    root_id: &str,
    version: &str,
) -> Result<Vec<InstalledPackage>, String> {
    fn visit(
        installed: &[InstalledPackage],
        id: &str,
        requirement: &VersionReq,
        visiting: &mut HashSet<String>,
        output: &mut BTreeMap<String, InstalledPackage>,
    ) -> Result<(), String> {
        if let Some(selected) = output.get(id) {
            let selected_version = Version::parse(&selected.manifest.version)
                .map_err(|error| format!("설치 package semver가 유효하지 않습니다: {error}"))?;
            if requirement.matches(&selected_version) {
                return Ok(());
            }
            return Err(format!(
                "extension dependency 버전 요구가 충돌합니다: {id} {requirement} (이미 {} 선택)",
                selected.manifest.version
            ));
        }
        if !visiting.insert(id.into()) {
            return Err(format!("extension dependency 순환입니다: {id}"));
        }
        let mut matches = installed
            .iter()
            .filter(|package| {
                package.manifest.id == id
                    && Version::parse(&package.manifest.version)
                        .ok()
                        .is_some_and(|version| requirement.matches(&version))
            })
            .cloned()
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| {
            Version::parse(&right.manifest.version)
                .unwrap()
                .cmp(&Version::parse(&left.manifest.version).unwrap())
        });
        let package = matches.into_iter().next().ok_or_else(|| {
            format!("dependency를 정확히 해석할 설치 버전이 없습니다: {id} {requirement}")
        })?;
        for dependency in &package.manifest.dependencies {
            if dependency.optional {
                continue;
            }
            visit(
                installed,
                &dependency.id,
                &VersionReq::parse(&dependency.requirement).map_err(|error| error.to_string())?,
                visiting,
                output,
            )?;
        }
        visiting.remove(id);
        output.insert(id.into(), package);
        Ok(())
    }
    let exact = VersionReq::parse(&format!("={version}")).map_err(|error| error.to_string())?;
    let mut output = BTreeMap::new();
    visit(installed, root_id, &exact, &mut HashSet::new(), &mut output)?;
    Ok(output.into_values().collect())
}

pub fn resolve_installed(package_id: &str, version: &str) -> Result<Vec<InstalledPackage>, String> {
    resolve_closure(&list_installed()?, package_id, version)
}

fn read_json<T: for<'de> Deserialize<'de>>(root: &Path, relative: &str) -> Result<T, String> {
    if !valid_relative(relative) {
        return Err("안전하지 않은 contribution 경로입니다".into());
    }
    serde_json::from_slice(
        &fs::read(root.join(relative))
            .map_err(|error| format!("contribution 읽기 실패: {error}"))?,
    )
    .map_err(|error| format!("contribution 파싱 실패: {error}"))
}

fn activate_contributions(root: &Path, package: &InstalledPackage) -> Result<(), String> {
    let directory = Path::new(&package.path);
    for path in &package.manifest.contributions.workflows {
        crate::workflow::publish_at(root, read_json(directory, path)?)?;
    }
    for path in &package.manifest.contributions.schemas {
        crate::schemas::publish_at(root, read_json(directory, path)?)?;
    }
    let actions = package
        .manifest
        .contributions
        .actions
        .iter()
        .map(|path| read_json::<crate::packs::PackAction>(directory, path))
        .collect::<Result<Vec<_>, _>>()?;
    let views = package
        .manifest
        .contributions
        .views
        .iter()
        .map(|path| read_json::<crate::packs::PackView>(directory, path))
        .collect::<Result<Vec<_>, _>>()?;
    if actions.is_empty() && views.is_empty() && package.manifest.contributions.skills.is_empty() {
        return Ok(());
    }
    let adapter_id = format!("x-{}", package.manifest.id);
    let adapter_root = crate::packs::user_packs_dir().join(&adapter_id);
    let staging =
        crate::packs::user_packs_dir().join(format!(".staging-{adapter_id}-{}", Uuid::new_v4()));
    fs::create_dir_all(&staging)
        .map_err(|error| format!("extension UI adapter 생성 실패: {error}"))?;
    let mut skill_names = Vec::new();
    for skill_path in &package.manifest.contributions.skills {
        let source = directory.join(skill_path);
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "skill contribution 이름이 잘못되었습니다".to_string())?;
        if !valid_id(name) {
            return Err(format!(
                "skill contribution 폴더명이 유효하지 않습니다: {name}"
            ));
        }
        copy_tree(&source, &staging.join("skills").join(name))?;
        skill_names.push(name.into());
    }
    let mut manifest = crate::packs::PackManifest {
        id: adapter_id.clone(),
        name: package.manifest.name.clone(),
        version: package.manifest.version.clone(),
        description: format!("{} package contribution", package.manifest.id),
        author: package.manifest.publisher.clone(),
        skills: skill_names,
        actions,
        views,
        ..Default::default()
    };
    manifest.validate()?;
    write_atomic(&staging.join(crate::packs::MANIFEST), &manifest)?;
    if adapter_root.exists() {
        let backup =
            crate::packs::user_packs_dir().join(format!(".old-{adapter_id}-{}", Uuid::new_v4()));
        fs::rename(&adapter_root, &backup)
            .map_err(|error| format!("extension UI adapter 백업 실패: {error}"))?;
        fs::rename(&staging, &adapter_root).map_err(|error| {
            let _ = fs::rename(&backup, &adapter_root);
            format!("extension UI adapter 교체 실패: {error}")
        })?;
        let _ = fs::remove_dir_all(backup);
    } else {
        fs::rename(&staging, &adapter_root)
            .map_err(|error| format!("extension UI adapter 활성화 실패: {error}"))?;
    }
    Ok(())
}

fn preflight_contributions(root: &Path, packages: &[InstalledPackage]) -> Result<(), String> {
    let mut workflows = crate::workflow::catalog(Some(root))?;
    let mut schemas = crate::schemas::catalog_at(root)?;
    for package in packages {
        let directory = Path::new(&package.path);
        for path in &package.manifest.contributions.workflows {
            let definition: crate::workflow::WorkflowDefinition = read_json(directory, path)?;
            let report = crate::workflow::validation::validate(&definition);
            if !report.valid {
                return Err(format!(
                    "package {} workflow contribution이 유효하지 않습니다: {:?}",
                    package.manifest.id, report.issues
                ));
            }
            if let Some(existing) = workflows.iter().find(|candidate| {
                candidate.id == definition.id && candidate.version == definition.version
            }) {
                if existing != &definition {
                    return Err(format!(
                        "package {} workflow {}@{}가 기존 불변 버전과 충돌합니다",
                        package.manifest.id, definition.id, definition.version
                    ));
                }
            } else {
                workflows.push(definition);
            }
        }
        for path in &package.manifest.contributions.schemas {
            let schema: crate::schemas::VaultSchema = read_json(directory, path)?;
            let report = crate::schemas::validate(&schema);
            if !report.valid {
                return Err(format!(
                    "package {} schema contribution이 유효하지 않습니다: {:?}",
                    package.manifest.id, report.diagnostics
                ));
            }
            if let Some(existing) = schemas.iter().find(|candidate| {
                candidate.id == schema.id && candidate.revision == schema.revision
            }) {
                if existing != &schema {
                    return Err(format!(
                        "package {} schema {} revision {}이 기존 불변 버전과 충돌합니다",
                        package.manifest.id, schema.id, schema.revision
                    ));
                }
            } else {
                schemas.push(schema);
            }
        }
        let actions = package
            .manifest
            .contributions
            .actions
            .iter()
            .map(|path| read_json::<crate::packs::PackAction>(directory, path))
            .collect::<Result<Vec<_>, _>>()?;
        let views = package
            .manifest
            .contributions
            .views
            .iter()
            .map(|path| read_json::<crate::packs::PackView>(directory, path))
            .collect::<Result<Vec<_>, _>>()?;
        let mut skill_names = Vec::new();
        for path in &package.manifest.contributions.skills {
            if !directory.join(path).is_dir() {
                return Err(format!(
                    "package skill contribution 폴더가 없습니다: {path}"
                ));
            }
            let name = Path::new(path)
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "package skill contribution 이름이 잘못되었습니다".to_string())?;
            if !valid_id(name) {
                return Err(format!(
                    "package skill contribution 이름이 유효하지 않습니다: {name}"
                ));
            }
            skill_names.push(name.into());
        }
        let mut adapter = crate::packs::PackManifest {
            id: format!("x-{}", package.manifest.id),
            name: package.manifest.name.clone(),
            version: package.manifest.version.clone(),
            skills: skill_names,
            actions,
            views,
            ..Default::default()
        };
        adapter.validate().map_err(|error| {
            format!(
                "package {} 선언형 adapter가 유효하지 않습니다: {error}",
                package.manifest.id
            )
        })?;
    }
    let issues = crate::workflow::validation::validate_registry(&workflows);
    if !issues.is_empty() {
        return Err(format!("package workflow registry 검증 실패: {issues:?}"));
    }
    Ok(())
}

fn merge_project_packages(
    existing: Vec<LockedPackage>,
    replacements: Vec<LockedPackage>,
) -> Vec<LockedPackage> {
    let replacing = replacements
        .iter()
        .map(|package| package.id.as_str())
        .collect::<HashSet<_>>();
    let mut merged = existing
        .into_iter()
        .filter(|package| !replacing.contains(package.id.as_str()))
        .collect::<Vec<_>>();
    merged.extend(replacements);
    merged.sort_by(|left, right| left.id.cmp(&right.id));
    merged
}

pub fn activate_at(root: &Path, input: ExtensionActivateInput) -> Result<ExtensionLock, String> {
    if !valid_id(&input.project_id) {
        return Err("유효하지 않은 project ID입니다".into());
    }
    let closure = resolve_installed(&input.package_id, &input.version)?;
    let mut locked = Vec::new();
    for package in &closure {
        let grants = input
            .grants
            .get(&package.manifest.id)
            .cloned()
            .unwrap_or_default();
        if package
            .manifest
            .permissions
            .iter()
            .any(|permission| !grants.contains(permission))
        {
            return Err(format!(
                "package {}의 요청 권한을 명시적으로 승인해야 합니다: {:?}",
                package.manifest.id, package.manifest.permissions
            ));
        }
        if grants
            .iter()
            .any(|permission| !package.manifest.permissions.contains(permission))
        {
            return Err(format!(
                "package {}가 요청하지 않은 권한은 승인할 수 없습니다",
                package.manifest.id
            ));
        }
        locked.push(LockedPackage {
            id: package.manifest.id.clone(),
            version: package.manifest.version.clone(),
            digest: package.digest.clone(),
            permissions: grants,
            source: package.source.clone(),
            commit: package.commit.clone(),
        });
    }
    preflight_contributions(root, &closure)?;
    for package in &closure {
        activate_contributions(root, package)?;
    }
    locked.sort_by(|left, right| left.id.cmp(&right.id));
    let mut lock = read_lock(root)?;
    let merged = merge_project_packages(
        lock.projects.remove(&input.project_id).unwrap_or_default(),
        locked,
    );
    lock.projects.insert(input.project_id.clone(), merged);
    write_atomic(&lock_path(root), &lock)?;
    let profile_path = root
        .join(".sawhorse")
        .join("profiles")
        .join(format!("{}.json", input.project_id));
    let mut profile: serde_json::Value = if profile_path.is_file() {
        serde_json::from_slice(
            &fs::read(&profile_path)
                .map_err(|error| format!("project profile 읽기 실패: {error}"))?,
        )
        .map_err(|error| format!("project profile 파싱 실패: {error}"))?
    } else {
        serde_json::json!({"formatVersion": 1, "projectId": input.project_id})
    };
    profile
        .as_object_mut()
        .ok_or_else(|| "project profile은 object여야 합니다".to_string())?
        .insert(
            "extensions".into(),
            serde_json::to_value(lock.projects.get(&input.project_id))
                .map_err(|error| error.to_string())?,
        );
    write_atomic(&profile_path, &profile)?;
    Ok(lock)
}

pub fn authorize_at(
    root: &Path,
    project_id: &str,
    package_id: &str,
    permission: &str,
) -> Result<(), String> {
    let lock = read_lock(root)?;
    let package = lock
        .projects
        .get(project_id)
        .and_then(|packages| packages.iter().find(|package| package.id == package_id))
        .ok_or_else(|| "프로젝트에 고정·활성화되지 않은 extension package입니다".to_string())?;
    if !package
        .permissions
        .iter()
        .any(|granted| granted == permission)
    {
        return Err(format!("extension 권한이 없습니다: {permission}"));
    }
    Ok(())
}

pub fn export_portable(
    package_id: &str,
    version: &str,
    package_digest: &str,
) -> Result<PortablePackage, String> {
    let package = list_installed()?
        .into_iter()
        .find(|package| {
            package.manifest.id == package_id
                && package.manifest.version == version
                && package.digest == package_digest
        })
        .ok_or_else(|| "내보낼 설치 package를 찾을 수 없습니다".to_string())?;
    let (manifest, verified_digest) = verify_directory(Path::new(&package.path))?;
    if verified_digest != package_digest {
        return Err("내보내기 직전 package digest가 변경되었습니다".into());
    }
    let files = payload_files(Path::new(&package.path))?
        .into_iter()
        .map(|(path, bytes)| {
            (
                path,
                PortableFile::Encoded {
                    encoding: "base64".into(),
                    data: BASE64.encode(bytes),
                },
            )
        })
        .collect();
    Ok(PortablePackage { manifest, files })
}

#[tauri::command]
pub async fn extension_package_install(
    input: ExtensionInstallInput,
) -> Result<InstalledPackage, String> {
    let temporary = TemporaryDirectory::new();
    let result = match input.kind.as_str() {
        "local-directory" => install_directory(
            Path::new(&input.location),
            format!("local:{}", input.location),
            None,
        ),
        "local-file" => {
            let portable: PortablePackage = serde_json::from_slice(
                &fs::read(&input.location)
                    .map_err(|error| format!("portable package 읽기 실패: {error}"))?,
            )
            .map_err(|error| format!("portable package 파싱 실패: {error}"))?;
            materialize_portable(portable, temporary.path())?;
            install_directory(temporary.path(), format!("local:{}", input.location), None)
        }
        "https" => {
            if !input.location.starts_with("https://") {
                return Err("HTTPS package URL만 허용합니다".into());
            }
            let (_, host) = super::broker::validate_url_scheme(&input.location)?;
            let response = super::broker::ExtensionContext {
                instance_id: format!("package-install-{}", Uuid::new_v4()),
                granted_domains: vec![host],
                capabilities: Vec::new(),
            }
            .guarded_get(&input.location, 5)
            .await
            .map_err(|error| format!("package 다운로드 실패: {error}"))?;
            if !response.final_url.starts_with("https://") {
                return Err("package 다운로드가 HTTPS 밖으로 redirect되었습니다".into());
            }
            if !(200..300).contains(&response.status) {
                return Err(format!("package 다운로드 HTTP 오류: {}", response.status));
            }
            if response.body.len() as u64 > MAX_PACKAGE_BYTES {
                return Err("다운로드 package 크기 상한을 넘었습니다".into());
            }
            let portable: PortablePackage = serde_json::from_slice(&response.body)
                .map_err(|error| format!("portable package 파싱 실패: {error}"))?;
            materialize_portable(portable, temporary.path())?;
            install_directory(temporary.path(), input.location.clone(), None)
        }
        "git" => {
            let commit = input
                .commit
                .clone()
                .filter(|value| {
                    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                .ok_or_else(|| "Git package는 정확한 40자리 commit이 필요합니다".to_string())?;
            fs::create_dir_all(temporary.path())
                .map_err(|error| format!("Git package 임시 폴더 생성 실패: {error}"))?;
            let status = Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(temporary.path())
                .status()
                .map_err(|error| format!("git init 실패: {error}"))?;
            if !status.success() {
                return Err("git init 실패".into());
            }
            for args in [
                vec!["remote", "add", "origin", input.location.as_str()],
                vec![
                    "fetch",
                    "--quiet",
                    "--depth",
                    "1",
                    "origin",
                    commit.as_str(),
                ],
                vec!["checkout", "--quiet", "--detach", "FETCH_HEAD"],
            ] {
                let status = Command::new("git")
                    .args(args)
                    .current_dir(temporary.path())
                    .status()
                    .map_err(|error| format!("Git package 가져오기 실패: {error}"))?;
                if !status.success() {
                    return Err("Git package 가져오기 실패".into());
                }
            }
            let output = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(temporary.path())
                .output()
                .map_err(|error| format!("Git commit 확인 실패: {error}"))?;
            if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != commit
            {
                return Err("가져온 Git commit이 요청한 commit과 다릅니다".into());
            }
            let source = if let Some(subdir) = input.subdir.as_deref() {
                if !valid_relative(subdir) {
                    return Err("Git package subdir가 안전하지 않습니다".into());
                }
                temporary.path().join(subdir)
            } else {
                temporary.path().to_path_buf()
            };
            install_directory(&source, format!("git:{}", input.location), Some(commit))
        }
        _ => Err("지원하는 설치 source는 local-directory, local-file, git, https입니다".into()),
    };
    result
}

#[tauri::command]
pub fn extension_package_list() -> Result<Vec<InstalledPackage>, String> {
    list_installed()
}

#[tauri::command]
pub fn extension_package_resolve(
    package_id: String,
    version: String,
) -> Result<Vec<InstalledPackage>, String> {
    resolve_installed(&package_id, &version)
}

#[tauri::command]
pub fn extension_package_activate(input: ExtensionActivateInput) -> Result<ExtensionLock, String> {
    activate_at(&crate::sdlc::vault_root()?, input)
}

#[tauri::command]
pub fn extension_package_lock() -> Result<ExtensionLock, String> {
    read_lock(&crate::sdlc::vault_root()?)
}

#[tauri::command]
pub fn extension_package_export(
    package_id: String,
    version: String,
    digest: String,
) -> Result<PortablePackage, String> {
    export_portable(&package_id, &version, &digest)
}

#[tauri::command]
pub fn extension_package_authorize(
    project_id: String,
    package_id: String,
    permission: String,
) -> Result<(), String> {
    authorize_at(
        &crate::sdlc::vault_root()?,
        &project_id,
        &package_id,
        &permission,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(
        root: &Path,
        id: &str,
        dependency: Option<PackageDependency>,
        permission: Option<&str>,
    ) {
        fs::create_dir_all(root.join("workflows")).unwrap();
        let workflow = crate::workflow::builtins::tdd();
        let body = serde_json::to_string_pretty(&workflow).unwrap();
        fs::write(root.join("workflows/tdd.json"), &body).unwrap();
        let manifest = ExtensionPackageManifest {
            manifest_version: 2,
            id: id.into(),
            publisher: "test".into(),
            name: id.into(),
            version: "1.2.3".into(),
            engine_api: "^1.0".into(),
            dependencies: dependency.into_iter().collect(),
            contributions: PackageContributions {
                workflows: vec!["workflows/tdd.json".into()],
                ..Default::default()
            },
            permissions: permission.into_iter().map(str::to_string).collect(),
            file_digests: BTreeMap::from([("workflows/tdd.json".into(), digest(body.as_bytes()))]),
            ..Default::default()
        };
        write_atomic(&root.join("extension.json"), &manifest).unwrap();
    }

    #[test]
    fn verifies_all_files_and_rejects_tampering() {
        let root = std::env::temp_dir().join(format!("sawhorse-package-test-{}", Uuid::new_v4()));
        package(&root, "team-flow", None, None);
        assert!(verify_directory(&root).is_ok());
        fs::write(root.join("workflows/tdd.json"), "tampered").unwrap();
        assert!(verify_directory(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundled_ui_mockup_package_and_contributions_are_valid() {
        let package_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugin/extension-packages/ui-mockup");
        let (manifest, _) = verify_directory(&package_root).unwrap();
        let workflow: crate::workflow::WorkflowDefinition =
            read_json(&package_root, &manifest.contributions.workflows[0]).unwrap();
        let report = crate::workflow::validation::validate(&workflow);
        assert!(report.valid, "깨진 목업 workflow: {:?}", report.issues);
        assert_eq!(workflow.version, "1.1.0");
        assert!(workflow
            .artifacts
            .iter()
            .any(|artifact| artifact.role == "feedback"));
        assert!(workflow
            .artifacts
            .iter()
            .any(|artifact| artifact.role == "proposal"));
        assert!(workflow
            .edges
            .iter()
            .any(|edge| edge.on == "changes-requested"));
        assert!(workflow
            .edges
            .iter()
            .any(|edge| edge.on == "revised" && edge.loop_ref.is_some()));

        let mut adapter = crate::packs::PackManifest {
            id: format!("x-{}", manifest.id),
            name: manifest.name,
            actions: manifest
                .contributions
                .actions
                .iter()
                .map(|path| read_json(&package_root, path).unwrap())
                .collect(),
            views: manifest
                .contributions
                .views
                .iter()
                .map(|path| read_json(&package_root, path).unwrap())
                .collect(),
            ..Default::default()
        };
        adapter.validate().unwrap();
        assert_eq!(adapter.views[0].selection, "multiple");
        assert_eq!(adapter.views[1].selection, "multiple");
    }

    #[test]
    fn permission_scope_must_be_explicit_and_known() {
        let mut manifest = ExtensionPackageManifest {
            manifest_version: 2,
            id: "team-flow".into(),
            version: "1.0.0".into(),
            engine_api: "^1".into(),
            permissions: vec!["native:root".into()],
            ..Default::default()
        };
        assert!(validate_manifest(&manifest).is_err());
        manifest.permissions = vec!["vault:write".into()];
        assert!(validate_manifest(&manifest).is_ok());
    }

    fn installed(
        id: &str,
        version: &str,
        dependencies: Vec<PackageDependency>,
    ) -> InstalledPackage {
        InstalledPackage {
            manifest: ExtensionPackageManifest {
                manifest_version: 2,
                id: id.into(),
                version: version.into(),
                engine_api: "^1".into(),
                dependencies,
                ..Default::default()
            },
            digest: format!("digest-{id}-{version}"),
            ..Default::default()
        }
    }

    fn dependency(id: &str, requirement: &str) -> PackageDependency {
        PackageDependency {
            id: id.into(),
            requirement: requirement.into(),
            optional: false,
        }
    }

    #[test]
    fn dependency_diamond_rejects_incompatible_selected_versions() {
        let packages = vec![
            installed(
                "root",
                "1.0.0",
                vec![dependency("left", "^1"), dependency("right", "^1")],
            ),
            installed("left", "1.0.0", vec![dependency("shared", "^1")]),
            installed("right", "1.0.0", vec![dependency("shared", "^2")]),
            installed("shared", "1.0.0", Vec::new()),
            installed("shared", "2.0.0", Vec::new()),
        ];
        let error = resolve_closure(&packages, "root", "1.0.0").unwrap_err();
        assert!(error.contains("충돌"));
    }

    #[test]
    fn project_activation_merge_preserves_unrelated_locks() {
        let prior = LockedPackage {
            id: "other".into(),
            version: "1.0.0".into(),
            ..Default::default()
        };
        let old_root = LockedPackage {
            id: "root".into(),
            version: "1.0.0".into(),
            ..Default::default()
        };
        let new_root = LockedPackage {
            id: "root".into(),
            version: "2.0.0".into(),
            ..Default::default()
        };
        let merged = merge_project_packages(vec![prior, old_root], vec![new_root]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|package| package.id == "other"));
        assert_eq!(
            merged
                .iter()
                .find(|package| package.id == "root")
                .unwrap()
                .version,
            "2.0.0"
        );
    }

    #[test]
    fn authorization_is_scoped_to_the_exact_project_lock() {
        let root = std::env::temp_dir().join(format!("sawhorse-lock-test-{}", Uuid::new_v4()));
        let lock = ExtensionLock {
            format_version: 1,
            projects: BTreeMap::from([(
                "alpha".into(),
                vec![LockedPackage {
                    id: "team-flow".into(),
                    version: "1.0.0".into(),
                    digest: "fixed".into(),
                    permissions: vec!["vault:read".into()],
                    ..Default::default()
                }],
            )]),
        };
        write_atomic(&lock_path(&root), &lock).unwrap();
        assert!(authorize_at(&root, "alpha", "team-flow", "vault:read").is_ok());
        assert!(authorize_at(&root, "beta", "team-flow", "vault:read").is_err());
        assert!(authorize_at(&root, "alpha", "team-flow", "vault:write").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn portable_package_round_trips_binary_payloads() {
        let root = std::env::temp_dir().join(format!("sawhorse-portable-test-{}", Uuid::new_v4()));
        let bytes = vec![0, 159, 146, 150, 255];
        let manifest = ExtensionPackageManifest {
            manifest_version: 2,
            id: "binary-data".into(),
            version: "1.0.0".into(),
            engine_api: "^1".into(),
            file_digests: BTreeMap::from([("payload.bin".into(), digest(&bytes))]),
            ..Default::default()
        };
        materialize_portable(
            PortablePackage {
                manifest,
                files: BTreeMap::from([(
                    "payload.bin".into(),
                    PortableFile::Encoded {
                        encoding: "base64".into(),
                        data: BASE64.encode(&bytes),
                    },
                )]),
            },
            &root,
        )
        .unwrap();
        assert_eq!(fs::read(root.join("payload.bin")).unwrap(), bytes);
        assert!(verify_directory(&root).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
