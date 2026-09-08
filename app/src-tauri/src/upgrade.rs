//! Versioned, resumable desktop upgrades. Build and validate a sibling copy before
//! swapping it into place; the previous tree remains a user-accessible backup.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

const REVISION: &str = "workspace-upgrade-1";
static READY: AtomicBool = AtomicBool::new(true);
static LOCK: Mutex<()> = Mutex::new(());
static REPORT: Mutex<Option<UpgradeReport>> = Mutex::new(None);

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeReport {
    pub id: String,
    pub status: String,
    pub steps: Vec<String>,
    pub backups: Vec<String>,
    pub error: Option<String>,
    pub migrated: usize,
    #[serde(default)]
    pub changed: bool,
    #[serde(default)]
    pub notices: Vec<String>,
    swaps: Vec<Swap>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Swap {
    target: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
    before: Option<String>,
    after: String,
    done: bool,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("저장 경로가 없습니다")?).map_err(err)?;
    crate::config::write_atomic(path, &serde_json::to_vec_pretty(value).map_err(err)?).map_err(err)
}
fn read_json(path: &Path) -> Result<Value, String> {
    serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)
}
pub(crate) fn files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            let kind = entry.file_type().map_err(err)?;
            if kind.is_symlink() {
                return Err(format!(
                    "심볼릭 링크가 있어 자동 교체를 중단했습니다: {}",
                    entry.path().display()
                ));
            }
            if kind.is_dir() {
                walk(&entry.path(), out)?;
            } else if kind.is_file() {
                out.push(entry.path());
            } else {
                return Err(format!("일반 파일이 아닙니다: {}", entry.path().display()));
            }
        }
        Ok(())
    }
    if fs::symlink_metadata(root)
        .map_err(err)?
        .file_type()
        .is_symlink()
    {
        return Err(format!("교체 대상이 심볼릭 링크입니다: {}", root.display()));
    }
    let mut out = Vec::new();
    walk(root, &mut out)?;
    out.sort();
    Ok(out)
}
fn tree_hash(root: &Path) -> Result<String, String> {
    let mut digest = Sha256::new();
    for path in files(root)? {
        digest.update(
            path.strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/")
                .as_bytes(),
        );
        digest.update([0]);
        digest.update(hash(&fs::read(path).map_err(err)?).as_bytes());
    }
    Ok(hex::encode(digest.finalize()))
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    files(source)?; // Reject links and special files before copying anything.
    fn copy(source: &Path, destination: &Path) -> Result<(), String> {
        fs::create_dir_all(destination).map_err(err)?;
        for entry in fs::read_dir(source).map_err(err)? {
            let entry = entry.map_err(err)?;
            let target = destination.join(entry.file_name());
            let kind = entry.file_type().map_err(err)?;
            if kind.is_dir() {
                copy(&entry.path(), &target)?;
            } else if kind.is_file() {
                fs::copy(entry.path(), target).map_err(err)?;
            } else {
                return Err("복사 중 파일 종류가 변경되었습니다".into());
            }
        }
        Ok(())
    }
    copy(source, destination)
}
fn save(report: &UpgradeReport, journal: &Path) -> Result<(), String> {
    write_json(journal, report)
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(format!("안전한 절대경로가 아닙니다: {}", path.display()));
    }
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!(
                    "경로에 심볼릭 링크가 있습니다: {}",
                    ancestor.display()
                ))
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(err(error)),
            _ => (),
        }
    }
    Ok(())
}

fn finish_swap(swap: &mut Swap) -> Result<(), String> {
    if swap.done {
        return Ok(());
    }
    validate_path(&swap.target)?;
    validate_path(&swap.staging)?;
    validate_path(&swap.backup)?;
    if !swap.staging.exists() {
        if swap.target.is_dir() && tree_hash(&swap.target)? == swap.after {
            swap.done = true;
            return Ok(());
        }
        return Err(format!(
            "업그레이드 임시 사본을 찾지 못했습니다: {}",
            swap.staging.display()
        ));
    }
    if tree_hash(&swap.staging)? != swap.after {
        return Err("검증 후 업그레이드 사본이 변경되었습니다".into());
    }
    if swap.target.exists() {
        if swap.backup.exists() {
            return Err(
                "교체 중 대상 폴더가 다시 생성되었습니다. 백업을 보존하고 중단합니다".into(),
            );
        }
        if Some(tree_hash(&swap.target)?) != swap.before {
            return Err(
                "이전 데이터가 복사 이후 변경되었습니다. 기존 데이터를 보존하고 중단합니다".into(),
            );
        }
        fs::create_dir_all(swap.backup.parent().ok_or("백업 상위 경로 없음")?).map_err(err)?;
        fs::rename(&swap.target, &swap.backup).map_err(err)?;
    } else if swap.before.is_some() && !swap.backup.is_dir() {
        return Err("교체할 원본과 백업을 찾지 못했습니다".into());
    }
    // If the process stops between these renames, the journal completes this step.
    fs::rename(&swap.staging, &swap.target).map_err(err)?;
    swap.done = true;
    Ok(())
}
fn replace_tree(
    report: &mut UpgradeReport,
    journal: &Path,
    target: &Path,
    build: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    validate_path(target)?;
    if report
        .swaps
        .iter()
        .any(|swap| swap.target == target && swap.done)
    {
        return Ok(());
    }
    let parent = target
        .parent()
        .ok_or("루트 디렉터리는 업그레이드할 수 없습니다")?;
    fs::create_dir_all(parent).map_err(err)?;
    let name = target
        .file_name()
        .ok_or("대상 폴더 이름이 없습니다")?
        .to_string_lossy();
    let suffix = &report.id[..16];
    let staging = parent.join(format!(".{name}.sawhorse-stage-{suffix}"));
    let backup = if journal
        .ancestors()
        .nth(5)
        .is_some_and(|home| target.starts_with(home))
    {
        let backups = journal.parent().unwrap().join("backups");
        fs::create_dir_all(&backups).map_err(err)?;
        backups.join(format!(
            "{name}-{}",
            &hash(target.to_string_lossy().as_bytes())[..16]
        ))
    } else {
        parent.join(format!(".{name}.sawhorse-backup-{suffix}"))
    };
    if backup.exists() {
        return Err(format!(
            "등록되지 않은 백업이 이미 있습니다: {}",
            backup.display()
        ));
    }
    let before = if target.exists() {
        Some(tree_hash(target)?)
    } else {
        None
    };
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(err)?;
    }
    build(&staging)?;
    let after = tree_hash(&staging)?;
    report.swaps.push(Swap {
        target: target.into(),
        staging,
        backup: backup.clone(),
        before,
        after,
        done: false,
    });
    save(report, journal)?;
    finish_swap(report.swaps.last_mut().unwrap())?;
    if backup.exists() {
        report.backups.push(backup.display().to_string());
    }
    save(report, journal)
}

fn bundle_skills(bundle: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let manifest = read_json(&bundle.join(".claude-plugin/plugin.json"))?;
    let mut skills = Vec::new();
    for dir in manifest["skills"]
        .as_array()
        .ok_or("플러그인 skills 선언 없음")?
    {
        let dir = dir.as_str().ok_or("스킬 경로 오류")?;
        let dir = bundle.join(dir);
        for entry in fs::read_dir(dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry.path().join("SKILL.md").is_file() {
                skills.push((
                    entry.file_name().to_string_lossy().to_string(),
                    entry.path(),
                ));
            }
        }
    }
    Ok(skills)
}

fn install_agents(
    home: &Path,
    bundle: &Path,
    report: &mut UpgradeReport,
    journal: &Path,
) -> Result<(), String> {
    // Replace only Sawhorse's own registered installations, never another plugin.
    let registry_path = home.join(".claude/plugins/installed_plugins.json");
    let mut registry = if registry_path.exists() {
        read_json(&registry_path)?
    } else {
        serde_json::json!({})
    };
    let mut targets = Vec::new();
    if let Some(plugins) = registry["plugins"].as_object_mut() {
        for (name, entries) in plugins {
            if name != "sawhorse" && !name.starts_with("sawhorse@") {
                continue;
            }
            for entry in entries
                .as_array_mut()
                .ok_or("플러그인 설치 기록 형식 오류")?
            {
                let path = PathBuf::from(
                    entry["installPath"]
                        .as_str()
                        .ok_or("Sawhorse 설치 경로 없음")?,
                );
                if !path.is_absolute()
                    || !path.starts_with(home.join(".claude/plugins"))
                    || path == home.join(".claude/plugins")
                    || bundle.starts_with(&path)
                {
                    return Err(format!(
                        "자동 교체할 수 없는 플러그인 경로: {}",
                        path.display()
                    ));
                }
                if path.exists()
                    && read_json(&path.join(".claude-plugin/plugin.json"))?["name"] != "sawhorse"
                {
                    return Err(format!(
                        "Sawhorse 소유가 아닌 설치 경로: {}",
                        path.display()
                    ));
                }
                targets.push(path);
                entry["version"] =
                    read_json(&bundle.join(".claude-plugin/plugin.json"))?["version"].clone();
            }
        }
    }
    let materialized = home.join(".claude/skills/sawhorse");
    if targets.is_empty() || materialized.exists() {
        targets.push(materialized.clone());
    }
    targets.sort();
    targets.dedup();
    for pair in targets.windows(2) {
        if pair[1].starts_with(&pair[0]) {
            return Err("플러그인 설치 경로가 서로 겹칩니다".into());
        }
    }
    for target in &targets {
        replace_tree(report, journal, target, |stage| copy_tree(bundle, stage))?;
    }
    if registry_path.exists() {
        let backup = journal
            .parent()
            .unwrap()
            .join("installed_plugins.before.json");
        if !backup.exists() {
            fs::copy(&registry_path, &backup).map_err(err)?;
        }
        write_json(&registry_path, &registry)?;
        if !report.backups.contains(&backup.display().to_string()) {
            report.backups.push(backup.display().to_string());
        }
    }
    // Codex's old slash-command prompts and Claude's pre-plugin personal skills.
    let mut skills = bundle_skills(bundle)?;
    for (source, manifest, _) in shipped_packages(bundle)? {
        let adapter = home
            .join(".claude/sawhorse/packs")
            .join(format!("x-{}", manifest.id));
        if !adapter.is_dir()
            || read_json(&adapter.join("pack.json"))?["version"] != manifest.version
        {
            continue;
        }
        for path in &manifest.contributions.skills {
            let dir = source.join(path);
            let name = dir
                .file_name()
                .ok_or("확장 스킬 이름 없음")?
                .to_string_lossy()
                .to_string();
            // Render against the persistent adapter, never the temporary copy.
            skills.push((name.clone(), adapter.join("skills").join(name)));
        }
    }
    if home.join(".codex").is_dir() {
        let target = home.join(".codex/prompts");
        let content_root = targets.first().ok_or("설치 대상 없음")?;
        replace_tree(report, journal, &target, |stage| {
            if target.exists() {
                copy_tree(&target, stage)?;
            } else {
                fs::create_dir_all(stage).map_err(err)?;
            }
            for (name, dir) in &skills {
                let out = stage.join(format!("{name}.md"));
                if out.exists() && !fs::read_to_string(&out).map_err(err)?.contains("sawhorse") {
                    return Err(format!("사용자의 다른 프롬프트와 이름이 겹칩니다: {name}"));
                }
                let body = fs::read_to_string(dir.join("SKILL.md")).map_err(err)?;
                let adapter_root = dir
                    .parent()
                    .and_then(Path::parent)
                    .filter(|root| root.starts_with(home.join(".claude/sawhorse/packs")));
                let namespace = adapter_root
                    .and_then(Path::file_name)
                    .map(|name| format!("sawhorse-{}", name.to_string_lossy()));
                fs::write(
                    out,
                    crate::agents::render_for(
                        crate::agents::CODEX,
                        name,
                        &body,
                        namespace.as_deref().unwrap_or("sawhorse"),
                        adapter_root.unwrap_or(content_root),
                    ),
                )
                .map_err(err)?;
            }
            for name in ["improve", "improve-excel"] {
                let path = stage.join(format!("{name}.md"));
                if path.exists() && fs::read_to_string(&path).map_err(err)?.contains("sawhorse") {
                    fs::remove_file(path).map_err(err)?;
                }
            }
            Ok(())
        })?;
    }
    let retired_names: Vec<_> = skills
        .iter()
        .map(|(name, _)| name.as_str())
        .chain(["improve", "improve-excel"])
        .collect();
    for agent in [".claude", ".codex"] {
        for name in &retired_names {
            let target = home.join(agent).join("skills").join(name);
            let skill = target.join("SKILL.md");
            if skill.is_file()
                && fs::read_to_string(&skill)
                    .map_err(err)?
                    .contains("sawhorse")
            {
                replace_tree(report, journal, &target, |stage| {
                    fs::create_dir_all(stage).map_err(err)?;
                    write_json(
                        &stage.join("retired.json"),
                        &serde_json::json!({"replacement":"sawhorse plugin"}),
                    )
                })?;
            }
        }
    }
    // 1.0의 업무방식 묶음은 기능 확장으로 분해됐다. 옛 override가 사용자 팩으로
    // 다시 나타나 경계를 되돌리지 않도록 백업 가능한 retired 표식으로 치환한다.
    for id in ["si", "starter"] {
        let target = home.join(".claude/sawhorse/packs").join(id);
        if target.exists() {
            replace_tree(report, journal, &target, |stage| {
                fs::create_dir_all(stage).map_err(err)?;
                write_json(
                    &stage.join("retired.json"),
                    &serde_json::json!({
                        "replacement": if id == "starter" {
                            serde_json::json!(["journal"])
                        } else {
                            serde_json::json!(["journal", "concepts", "todos", "project-docs"])
                        }
                    }),
                )
            })?;
        }
    }
    let tasks = home.join(".claude/sawhorse/tasks");
    if tasks.is_dir() {
        let mut notices = Vec::new();
        replace_tree(report, journal, &tasks, |stage| {
            copy_tree(&tasks, stage)?;
            for path in files(stage)? {
                // Task history and archived requests are immutable records.
                if path.parent() != Some(stage)
                    || path.extension().and_then(|ext| ext.to_str()) != Some("json")
                {
                    continue;
                }
                let mut value = read_json(&path)?;
                fn rewrite(value: &mut Value, notices: &mut Vec<String>) {
                    if let Some(object) = value.as_object_mut() {
                        let retired_export = object
                            .get("prompt")
                            .and_then(Value::as_str)
                            .is_some_and(|p| p.contains("/sawhorse:improve-excel"));
                        if retired_export && object.contains_key("enabled") {
                            object.insert("enabled".into(), Value::Bool(false));
                            notices.push(format!("이전 엑셀 자동화 ‘{}’를 일시 중지했습니다. 프로젝트에서 XLSX Export를 활성화한 뒤 새 내보내기 액션으로 바꾸세요.", object.get("title").and_then(Value::as_str).unwrap_or("제목 없음")));
                        }
                    }
                    match value {
                        Value::Object(object) => {
                            for (key, value) in object {
                                if key == "prompt" {
                                    if let Some(prompt) = value.as_str() {
                                        // Keep retired XLSX requests explicit; never route them to an ungranted package.
                                        let prompt = prompt
                                            .replace("/sawhorse:improve ", "/sawhorse:issues ");
                                        *value = Value::String(if prompt == "/sawhorse:improve" {
                                            "/sawhorse:issues".into()
                                        } else {
                                            prompt
                                        });
                                    }
                                } else {
                                    rewrite(value, notices);
                                }
                            }
                        }
                        Value::Array(array) => {
                            for value in array {
                                rewrite(value, notices);
                            }
                        }
                        _ => (),
                    }
                }
                rewrite(&mut value, &mut notices);
                write_json(&path, &value)?;
            }
            Ok(())
        })?;
        report.notices.extend(notices);
    }
    report.notices.sort();
    report.notices.dedup();
    report
        .steps
        .push("Sawhorse 플러그인과 에이전트 스킬 갱신".into());
    Ok(())
}

fn shipped_packages(
    bundle: &Path,
) -> Result<
    Vec<(
        PathBuf,
        crate::extensions::package::ExtensionPackageManifest,
        String,
    )>,
    String,
> {
    let mut packages = Vec::new();
    for entry in fs::read_dir(bundle.join("extension-packages")).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if path.is_dir() && path.join("extension.json").is_file() {
            let (manifest, digest) = crate::extensions::package::verify_directory(&path)?;
            packages.push((path, manifest, digest));
        }
    }
    Ok(packages)
}
fn install_extension_packages(
    home: &Path,
    bundle: &Path,
    vault: Option<&Path>,
    report: &mut UpgradeReport,
    journal: &Path,
) -> Result<(), String> {
    let target = home.join(".claude/sawhorse/extension-packages");
    let locked = vault
        .filter(|root| root.join(".sawhorse/extensions.lock.json").is_file())
        .map(crate::extensions::package::read_lock)
        .transpose()?
        .unwrap_or_default();
    let packages = shipped_packages(bundle)?
        .into_iter()
        .filter(|(_, manifest, _)| {
            target.join(&manifest.id).is_dir()
                || locked
                    .projects
                    .values()
                    .flatten()
                    .any(|entry| entry.id == manifest.id)
        })
        .collect::<Vec<_>>();
    if packages.is_empty() {
        return Ok(());
    }
    replace_tree(report, journal, &target, |stage| {
        if target.exists() {
            copy_tree(&target, stage)?;
        } else {
            fs::create_dir_all(stage).map_err(err)?;
        }
        for (source, manifest, digest) in &packages {
            // Older immutable packages stay available to pinned work. Active locks
            // switch to the verified bundled version without erasing that history.
            let dest = stage
                .join(&manifest.id)
                .join(&manifest.version)
                .join(digest);
            if dest.exists() {
                fs::remove_dir_all(&dest).map_err(err)?;
            }
            copy_tree(source, &dest)?;
            write_json(
                &PathBuf::from(format!("{}.install.json", dest.display())),
                &serde_json::json!({
                    "source": format!("bundled:{}", manifest.id), "commit": null,
                    "installedAt": chrono::Utc::now().to_rfc3339()
                }),
            )?;
        }
        Ok(())
    })?;
    for (source, manifest, _) in &packages {
        if !target.join(&manifest.id).is_dir() {
            continue;
        }
        let adapter = home
            .join(".claude/sawhorse/packs")
            .join(format!("x-{}", manifest.id));
        if locked
            .projects
            .values()
            .flatten()
            .filter(|entry| entry.id == manifest.id)
            .map(|entry| newer(&entry.version, &manifest.version))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .any(|value| value)
        {
            continue;
        }
        if adapter.join("pack.json").is_file() {
            let installed = read_json(&adapter.join("pack.json"))?;
            if newer(
                installed["version"].as_str().unwrap_or(""),
                &manifest.version,
            )? {
                continue;
            }
        }
        replace_tree(report, journal, &adapter, |stage| {
            fs::create_dir_all(stage).map_err(err)?;
            let actions = manifest
                .contributions
                .actions
                .iter()
                .map(|path| read_json(&source.join(path)))
                .collect::<Result<Vec<_>, _>>()?;
            let views = manifest
                .contributions
                .views
                .iter()
                .map(|path| read_json(&source.join(path)))
                .collect::<Result<Vec<_>, _>>()?;
            let mut names = Vec::new();
            for path in &manifest.contributions.skills {
                let name = Path::new(path)
                    .file_name()
                    .ok_or("확장 스킬 이름 없음")?
                    .to_string_lossy()
                    .to_string();
                copy_tree(&source.join(path), &stage.join("skills").join(&name))?;
                names.push(name);
            }
            write_json(
                &stage.join("pack.json"),
                &serde_json::json!({
                    "id": format!("x-{}", manifest.id), "name": manifest.name, "version": manifest.version,
                    "author": manifest.publisher, "skills": names, "actions": actions, "views": views
                }),
            )
        })?;
        let plugin = home
            .join(".claude/skills")
            .join(format!("sawhorse-x-{}", manifest.id));
        replace_tree(report, journal, &plugin, |stage| {
            copy_tree(&adapter, stage)?;
            write_json(
                &stage.join(".claude-plugin/plugin.json"),
                &serde_json::json!({
                    "name": format!("sawhorse-x-{}", manifest.id), "version": manifest.version, "skills": ["./skills"]
                }),
            )
        })?;
    }
    report.steps.push("설치된 번들 확장 패키지 갱신".into());
    Ok(())
}
fn newer(installed: &str, bundled: &str) -> Result<bool, String> {
    Ok(semver::Version::parse(installed).map_err(err)?
        > semver::Version::parse(bundled).map_err(err)?)
}
fn upgrade_extension_locks(vault: &Path, bundle: &Path) -> Result<Vec<String>, String> {
    let path = vault.join(".sawhorse/extensions.lock.json");
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let mut notices = Vec::new();
    let mut lock = crate::extensions::package::read_lock(vault)?;
    let mut raw_lock = read_json(&path)?;
    let packages = shipped_packages(bundle)?;
    for (project, locked) in &mut lock.projects {
        crate::sdlc::validate_id(project)?;
        let mut changed = false;
        for (index, entry) in locked.iter_mut().enumerate() {
            let Some((source, manifest, digest)) = packages
                .iter()
                .find(|(_, manifest, _)| manifest.id == entry.id)
            else {
                continue;
            };
            if newer(&entry.version, &manifest.version)? {
                continue;
            }
            if manifest
                .permissions
                .iter()
                .any(|permission| !entry.permissions.contains(permission))
            {
                notices.push(format!("{project} / {} 확장은 새 권한이 필요해 기존 버전을 유지했습니다. 프로젝트의 확장 설정에서 새 버전을 활성화하세요.", entry.id));
                continue;
            }
            for path in &manifest.contributions.workflows {
                crate::workflow::publish_at(
                    vault,
                    serde_json::from_value(read_json(&source.join(path))?).map_err(err)?,
                )?;
            }
            for path in &manifest.contributions.schemas {
                crate::schemas::publish_at(
                    vault,
                    serde_json::from_value(read_json(&source.join(path))?).map_err(err)?,
                )?;
            }
            entry.version = manifest.version.clone();
            entry.digest = digest.clone();
            entry
                .permissions
                .retain(|permission| manifest.permissions.contains(permission));
            entry.source = format!("bundled:{}", manifest.id);
            entry.commit = None;
            let updated = serde_json::to_value(entry).map_err(err)?;
            let original = raw_lock["projects"][project][index]
                .as_object_mut()
                .ok_or("확장 잠금 항목 형식 오류")?;
            original.extend(updated.as_object().ok_or("확장 잠금 직렬화 오류")?.clone());
            changed = true;
        }
        if !changed {
            continue;
        }
        let profile = vault
            .join(".sawhorse/profiles")
            .join(format!("{project}.json"));
        let mut value = if profile.exists() {
            read_json(&profile)?
        } else {
            serde_json::json!({"formatVersion":1,"projectId":project})
        };
        let mut extensions = raw_lock["projects"][project].clone();
        if let Some(existing) = value["extensions"].as_array() {
            for entry in extensions.as_array_mut().ok_or("프로필 확장 형식 오류")? {
                if let Some(previous) = existing
                    .iter()
                    .find(|previous| previous["id"] == entry["id"])
                {
                    if let Some(mut merged) = previous.as_object().cloned() {
                        merged.extend(entry.as_object().ok_or("프로필 확장 항목 오류")?.clone());
                        *entry = Value::Object(merged);
                    }
                }
            }
        }
        value["extensions"] = extensions;
        write_json(&profile, &value)?;
    }
    write_json(&path, &raw_lock)?;
    Ok(notices)
}

pub fn ready() -> bool {
    READY.load(Ordering::Acquire)
}
pub fn ensure_ready() -> Result<(), String> {
    if ready() {
        Ok(())
    } else {
        Err("데이터 업그레이드가 완료되지 않았습니다. 업그레이드 화면에서 재시도하세요".into())
    }
}
pub fn run_at(home: &Path, bundle: &Path, vault: Option<&Path>) -> Result<UpgradeReport, String> {
    validate_path(home)?;
    validate_path(bundle)?;
    if let Some(vault) = vault {
        validate_path(vault)?;
    }
    let identity = format!(
        "{REVISION}:{}:{}",
        tree_hash(bundle)?,
        vault.map(|p| p.to_string_lossy()).unwrap_or_default()
    );
    let id = hash(identity.as_bytes());
    let journal = home
        .join(".claude/sawhorse/upgrades")
        .join(&id)
        .join("report.json");
    validate_path(&journal)?;
    let mut report: UpgradeReport = if journal.exists() {
        serde_json::from_slice(&fs::read(&journal).map_err(err)?).map_err(err)?
    } else {
        UpgradeReport {
            id,
            status: "running".into(),
            ..Default::default()
        }
    };
    if report.status == "completed" {
        report.changed = false;
        return Ok(report);
    }
    let outcome = (|| {
        // A failed pre-swap validation can be retried after the user fixes the
        // source. Only discard staging when the original has never been renamed.
        let mut i = 0;
        while i < report.swaps.len() {
            let swap = &report.swaps[i];
            if !swap.done
                && swap.target.is_dir()
                && !swap.backup.exists()
                && (Some(tree_hash(&swap.target)?) != swap.before
                    || !swap.staging.exists()
                    || tree_hash(&swap.staging)? != swap.after)
            {
                if swap.staging.exists() {
                    fs::remove_dir_all(&swap.staging).map_err(err)?;
                }
                report.swaps.remove(i);
                save(&report, &journal)?;
                continue;
            }
            i += 1;
        }
        for i in 0..report.swaps.len() {
            finish_swap(&mut report.swaps[i])?;
            let backup = report.swaps[i].backup.display().to_string();
            if report.swaps[i].backup.exists() && !report.backups.contains(&backup) {
                report.backups.push(backup);
            }
            save(&report, &journal)?;
        }
        install_extension_packages(home, bundle, vault, &mut report, &journal)?;
        if let Some(vault) = vault {
            if journal.starts_with(vault) {
                return Err(
                    "볼트가 업그레이드 기록 폴더를 포함합니다. 별도 작업공간 경로가 필요합니다"
                        .into(),
                );
            }
            let mut count = report.migrated;
            let mut notices = Vec::new();
            replace_tree(&mut report, &journal, vault, |stage| {
                if !vault.is_dir() {
                    return Err(format!("기존 볼트를 찾을 수 없습니다: {}", vault.display()));
                }
                copy_tree(vault, stage)?;
                crate::sdlc::initialize(stage)?;
                count = crate::sdlc::upgrade_legacy_at(stage, &read_config(home)?)?;
                let reg = crate::packs::load_registry_from(
                    Some(bundle),
                    &bundle.join(".no-user-packs"),
                    &crate::config::view(&read_config(home)?, true).packs.enabled,
                );
                let packs: Vec<_> = reg.enabled().collect();
                for relative in [
                    "템플릿/개선.md",
                    "템플릿/이슈.md",
                    "템플릿/마일스톤.md",
                    "프로젝트/개선.base",
                    "프로젝트/이슈.base",
                    "프로젝트/마일스톤.base",
                ] {
                    let path = stage.join(relative);
                    if path.is_file() {
                        fs::remove_file(path).map_err(err)?;
                    }
                }
                notices = upgrade_extension_locks(stage, bundle)?;
                let seeded = crate::workspace::provision(stage, &packs)?;
                if !seeded.failed.is_empty() {
                    return Err(format!("문서 자산 준비 실패: {:?}", seeded.failed));
                }
                let snapshot = crate::sdlc::snapshot(stage)?;
                if !snapshot.diagnostics.is_empty() {
                    return Err(format!(
                        "이관 검증 실패: {}",
                        snapshot.diagnostics.join("\n")
                    ));
                }
                Ok(())
            })?;
            report.migrated = count;
            report.notices.extend(notices);
            report
                .steps
                .push("볼트 데이터 변환·검증 및 원본 백업".into());
            save(&report, &journal)?;
        }
        install_agents(home, bundle, &mut report, &journal)?;
        Ok::<_, String>(())
    })();
    report.status = if outcome.is_ok() {
        "completed"
    } else {
        "failed"
    }
    .into();
    report.steps.sort();
    report.steps.dedup();
    report.changed = outcome.is_ok();
    report.error = outcome.err();
    save(&report, &journal)?;
    Ok(report)
}
fn read_config(home: &Path) -> Result<Value, String> {
    let path = home.join(".claude/sawhorse/config.json");
    if path.exists() {
        read_json(&path)
    } else {
        Ok(serde_json::json!({}))
    }
}
pub fn startup() {
    let _guard = LOCK.lock();
    READY.store(false, Ordering::Release);
    let result = (|| {
        let home = dirs::home_dir().ok_or("사용자 홈을 찾을 수 없습니다")?;
        let bundle = crate::plugin::resolve_root()?;
        let config = read_config(&home)?;
        let vault = config["vaultPath"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);
        if vault.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err("볼트는 절대경로여야 합니다".into());
        }
        run_at(&home, &bundle, vault.as_deref())
    })();
    let report = result.unwrap_or_else(|error| UpgradeReport {
        status: "failed".into(),
        error: Some(error),
        ..Default::default()
    });
    READY.store(report.status == "completed", Ordering::Release);
    *REPORT.lock() = Some(report);
}
#[tauri::command]
pub fn upgrade_status() -> UpgradeReport {
    REPORT.lock().clone().unwrap_or_default()
}
#[tauri::command]
pub async fn upgrade_retry(app: tauri::AppHandle) -> Result<UpgradeReport, String> {
    tauri::async_runtime::spawn_blocking(startup)
        .await
        .map_err(err)?;
    let report = upgrade_status();
    if report.status == "completed" {
        app.restart();
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        root: PathBuf,
        home: PathBuf,
        vault: PathBuf,
        bundle: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("sawhorse-upgrade-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let home = root.join("home");
            let vault = root.join("vault");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&vault).unwrap();
            let bundle = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../plugin")
                .canonicalize()
                .unwrap();
            Self {
                root,
                home,
                vault,
                bundle,
            }
        }
        fn write(&self, relative: &str, content: &str) {
            let path = self.root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, content).unwrap();
        }
        fn run(&self) -> UpgradeReport {
            run_at(&self.home, &self.bundle, Some(&self.vault)).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    #[ignore = "requires SAWHORSE_UPGRADE_FIXTURE pointing to a disposable copy in the temp directory"]
    fn supplied_vault_copy_can_complete_upgrade() {
        let source =
            PathBuf::from(std::env::var_os("SAWHORSE_UPGRADE_FIXTURE").expect("fixture path"))
                .canonicalize()
                .unwrap();
        assert!(source.starts_with(std::env::temp_dir().canonicalize().unwrap()));
        let before = tree_hash(&source).unwrap();
        let f = Fixture::new();
        copy_tree(&source, &f.vault).unwrap();
        if let Some(config) = std::env::var_os("SAWHORSE_UPGRADE_FIXTURE_CONFIG") {
            let config = PathBuf::from(config).canonicalize().unwrap();
            assert!(config.starts_with(std::env::temp_dir().canonicalize().unwrap()));
            let config: Value = read_json(&config).unwrap();
            write_json(&f.home.join(".claude/sawhorse/config.json"), &config).unwrap();
        }
        let report = f.run();
        assert_eq!(tree_hash(&source).unwrap(), before);
        assert_eq!(report.status, "completed", "{:?}", report.error);
        let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
        assert!(
            snapshot.diagnostics.is_empty(),
            "{:?}",
            snapshot.diagnostics
        );
        println!(
            "Validated {} work items and {} events",
            snapshot.work.len(),
            snapshot.events.len()
        );
        if let Some(destination) = std::env::var_os("SAWHORSE_UPGRADE_FIXTURE_EXPORT") {
            let destination = PathBuf::from(destination);
            assert!(destination.is_absolute());
            assert!(!destination.exists());
            let parent = destination.parent().unwrap().canonicalize().unwrap();
            assert!(parent.starts_with(std::env::temp_dir().canonicalize().unwrap()));
            copy_tree(&f.vault, &destination).unwrap();
            write_json(&destination.with_extension("report.json"), &report).unwrap();
        }
    }
    #[test]
    fn upgrades_legacy_data_and_owned_plugins_once_preserving_originals() {
        let f = Fixture::new();
        let source = "---\ntype: 개선\nid: FDR-001\nstatus: 제안\npriority: 중요\ncustom: keep-me\n---\n\n## 문제상황\n\n검색 오류\n\n## 설계\n\n파일 수정\n";
        f.write("vault/프로젝트/FDR/개선/FDR-001 검색.md", source);
        f.write("vault/일지/2026-09-07.md", "personal journal");
        f.write("vault/첨부/screen.png", "image");
        f.write(
            "home/.claude/skills/sawhorse/.claude-plugin/plugin.json",
            "{\"name\":\"sawhorse\"}",
        );
        f.write(
            "home/.claude/skills/sawhorse/skills/improve/SKILL.md",
            "custom sawhorse old skill",
        );
        f.write(
            "home/.claude/skills/improve/SKILL.md",
            "sawhorse personal skill",
        );
        f.write("home/.claude/skills/other/SKILL.md", "unrelated skill");
        f.write("home/.codex/prompts/improve.md", "sawhorse obsolete prompt");
        f.write("home/.codex/prompts/private.md", "private prompt");
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        assert_eq!(report.migrated, 1);
        assert!(f.vault.join("work/FDR-001/work.md").is_file());
        assert_eq!(
            fs::read_to_string(f.vault.join("work/FDR-001/legacy-source.md")).unwrap(),
            source
        );
        assert_eq!(
            fs::read_to_string(f.vault.join("일지/2026-09-07.md")).unwrap(),
            "personal journal"
        );
        assert_eq!(fs::read(f.vault.join("첨부/screen.png")).unwrap(), b"image");
        assert!(!f
            .home
            .join(".claude/skills/sawhorse/skills/improve")
            .exists());
        assert!(!f.home.join(".claude/skills/improve/SKILL.md").exists());
        assert!(!f.home.join(".codex/prompts/improve.md").exists());
        assert!(f.home.join(".codex/prompts/sdd.md").is_file());
        assert_eq!(
            fs::read_to_string(f.home.join(".codex/prompts/private.md")).unwrap(),
            "private prompt"
        );
        assert_eq!(
            fs::read_to_string(f.home.join(".claude/skills/other/SKILL.md")).unwrap(),
            "unrelated skill"
        );
        let old = report
            .swaps
            .iter()
            .find(|swap| swap.target == f.vault)
            .unwrap();
        assert_eq!(
            fs::read_to_string(old.backup.join("프로젝트/FDR/개선/FDR-001 검색.md")).unwrap(),
            source
        );
        let before = tree_hash(&f.vault).unwrap();
        let again = f.run();
        assert_eq!(again.status, "completed");
        assert!(!again.changed);
        assert_eq!(again.swaps.len(), report.swaps.len());
        assert_eq!(tree_hash(&f.vault).unwrap(), before);
    }
    #[test]
    fn failed_conversion_keeps_the_original_vault_and_can_retry() {
        let f = Fixture::new();
        f.write(
            "vault/프로젝트/P/마일스톤/M.md",
            "---\ntype: 마일스톤\nid: M\ndue: invalid\n---\nOriginal\n",
        );
        let before = tree_hash(&f.vault).unwrap();
        let report = f.run();
        assert_eq!(report.status, "failed");
        assert_eq!(tree_hash(&f.vault).unwrap(), before);
        f.write(
            "vault/프로젝트/P/마일스톤/M.md",
            "---\ntype: 마일스톤\nid: M\ndue: 2026-10-01\n---\nOriginal\n",
        );
        let retry = f.run();
        assert_eq!(retry.status, "completed", "{:?}", retry.error);
        assert!(f.vault.join("calendar/M.md").is_file());
    }
    #[test]
    fn recovery_completes_a_swap_interrupted_between_renames() {
        let f = Fixture::new();
        f.write("vault/old.md", "old");
        let stage = f.root.join("stage");
        fs::create_dir_all(&stage).unwrap();
        fs::write(stage.join("new.md"), "new").unwrap();
        let backup = f.root.join("backup");
        let mut swap = Swap {
            target: f.vault.clone(),
            before: Some(tree_hash(&f.vault).unwrap()),
            after: tree_hash(&stage).unwrap(),
            staging: stage,
            backup: backup.clone(),
            done: false,
        };
        fs::rename(&f.vault, &backup).unwrap();
        finish_swap(&mut swap).unwrap();
        assert!(swap.done);
        assert!(f.vault.join("new.md").is_file());
        assert!(backup.join("old.md").is_file());
        finish_swap(&mut swap).unwrap();
    }
    #[test]
    fn changed_source_is_never_replaced_after_validation() {
        let f = Fixture::new();
        f.write("vault/old.md", "old");
        let stage = f.root.join("stage");
        copy_tree(&f.vault, &stage).unwrap();
        let mut swap = Swap {
            target: f.vault.clone(),
            before: Some(tree_hash(&f.vault).unwrap()),
            after: tree_hash(&stage).unwrap(),
            staging: stage,
            backup: f.root.join("backup"),
            done: false,
        };
        f.write("vault/old.md", "new user content");
        assert!(finish_swap(&mut swap).is_err());
        assert_eq!(
            fs::read_to_string(f.vault.join("old.md")).unwrap(),
            "new user content"
        );
    }
    #[test]
    fn duplicate_ids_across_projects_keep_both_items_and_project_paths() {
        let f = Fixture::new();
        for name in ["A", "B"] {
            f.write(
                &format!("vault/프로젝트/{name}/이슈/1.md"),
                "---\ntype: 이슈\nid: ISSUE-1\nstatus: 제안\n---\n## 배경 및 요청\nrequest\n",
            );
        }
        f.write(
            "home/.claude/sawhorse/config.json",
            "{\"improve\":{\"projects\":{\"A\":{\"path\":\"/repo/a\",\"verify\":\"npm test\"}}}}",
        );
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
        assert_eq!(snapshot.work.len(), 2);
        assert_eq!(
            snapshot
                .projects
                .iter()
                .find(|p| p.name == "A")
                .unwrap()
                .repo_path,
            "/repo/a"
        );
    }
    #[test]
    fn registered_plugin_copies_and_automations_upgrade_without_touching_others() {
        let f = Fixture::new();
        let install = f.home.join(".claude/plugins/cache/market/sawhorse/old");
        f.write(
            "home/.claude/plugins/cache/market/sawhorse/old/.claude-plugin/plugin.json",
            r#"{"name":"sawhorse","version":"0.1.0"}"#,
        );
        f.write(
            "home/.claude/plugins/cache/market/sawhorse/old/skills/improve/SKILL.md",
            "old",
        );
        let other = serde_json::json!([{"installPath":"/unrelated/plugin","version":"7"}]);
        write_json(
            &f.home.join(".claude/plugins/installed_plugins.json"),
            &serde_json::json!({
                "version":2, "custom":"preserved", "plugins":{
                    "sawhorse@market":[{"installPath":install,"version":"0.1.0","scope":"user"}],
                    "other@market":other
                }
            }),
        )
        .unwrap();
        f.write(
            "home/.claude/sawhorse/tasks/improve.json",
            r#"{"prompt":"/sawhorse:improve all","enabled":true}"#,
        );
        f.write(
            "home/.claude/sawhorse/tasks/export.json",
            r#"{"title":"Old export","prompt":"/sawhorse:improve-excel A","enabled":true}"#,
        );
        f.write(
            "home/.claude/sawhorse/tasks/archive/history.json",
            r#"{"prompt":"/sawhorse:improve","enabled":false}"#,
        );
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        assert!(!install.join("skills/improve").exists());
        let registry = read_json(&f.home.join(".claude/plugins/installed_plugins.json")).unwrap();
        assert_eq!(registry["plugins"]["other@market"], other);
        assert_eq!(registry["custom"], "preserved");
        assert_eq!(
            read_json(&f.home.join(".claude/sawhorse/tasks/improve.json")).unwrap()["prompt"],
            "/sawhorse:issues all"
        );
        assert_eq!(
            read_json(&f.home.join(".claude/sawhorse/tasks/export.json")).unwrap()["enabled"],
            false
        );
        assert_eq!(
            read_json(&f.home.join(".claude/sawhorse/tasks/archive/history.json")).unwrap()
                ["prompt"],
            "/sawhorse:improve"
        );
        assert_eq!(report.notices.len(), 1);
    }
    fn xlsx_lock(f: &Fixture, version: &str, permissions: &[&str]) {
        write_json(&f.vault.join(".sawhorse/extensions.lock.json"), &serde_json::json!({
            "formatVersion":1,"custom":"keep","projects":{"demo":[{
                "id":"xlsx-export","version":version,"digest":"old-digest","source":"bundled:xlsx-export",
                "permissions":permissions,"customEntry":"keep"
            },{"id":"third-party","version":"3.0.0","digest":"custom","permissions":[],"extra":42}]}
        })).unwrap();
    }
    #[test]
    fn extension_upgrade_repairs_missing_store_and_keeps_unknown_metadata() {
        let f = Fixture::new();
        xlsx_lock(
            &f,
            "1.0.0",
            &["vault:read", "vault:write", "adapter:xlsx-export"],
        );
        f.write("home/.codex/prompts/private.md", "private");
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        let lock = read_json(&f.vault.join(".sawhorse/extensions.lock.json")).unwrap();
        let entry = &lock["projects"]["demo"][0];
        assert_eq!(entry["version"], "1.1.0");
        assert_eq!(entry["customEntry"], "keep");
        assert_eq!(lock["custom"], "keep");
        assert_eq!(lock["projects"]["demo"][1]["extra"], 42);
        assert!(f
            .home
            .join(".claude/sawhorse/extension-packages/xlsx-export/1.1.0")
            .join(entry["digest"].as_str().unwrap())
            .join("extension.json")
            .is_file());
        assert!(f
            .home
            .join(".claude/skills/sawhorse-x-xlsx-export/skills/xlsx-export/SKILL.md")
            .is_file());
        assert!(f.home.join(".codex/prompts/xlsx-export.md").is_file());
    }
    #[test]
    fn newer_extension_lock_is_preserved_and_new_permissions_are_not_granted() {
        let f = Fixture::new();
        xlsx_lock(&f, "9.0.0", &[]);
        let before = read_json(&f.vault.join(".sawhorse/extensions.lock.json")).unwrap();
        upgrade_extension_locks(&f.vault, &f.bundle).unwrap();
        assert_eq!(
            read_json(&f.vault.join(".sawhorse/extensions.lock.json")).unwrap(),
            before
        );
        xlsx_lock(&f, "1.0.0", &["vault:read"]);
        let original = read_json(&f.vault.join(".sawhorse/extensions.lock.json")).unwrap();
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        assert!(report.notices.iter().any(|notice| notice.contains("권한")));
        assert_eq!(
            read_json(&f.vault.join(".sawhorse/extensions.lock.json")).unwrap(),
            original
        );
    }
    #[test]
    fn milestones_dependencies_and_attachment_destinations_survive_migration() {
        let f = Fixture::new();
        f.write(
            "vault/사업/A/마일스톤/ship.md",
            "---\ntype: 마일스톤\nid: SHIP\ndue: 2026-10-01\n---\nship notes",
        );
        f.write(
            "vault/사업/A/이슈/1.md",
            "---\ntype: 이슈\nid: ONE\nstatus: 완료\n---\n## 배경 및 요청\none",
        );
        f.write("vault/사업/A/이슈/2.md", "---\ntype: 이슈\nid: TWO\npriority: 최우선\nmilestone: SHIP\ndepends_on: [ONE]\n---\n## 배경 및 요청\n![screen](./screen.png)\n[web](https://example.com)\n");
        f.write("vault/사업/A/이슈/screen.png", "image");
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
        let work = snapshot.work.iter().find(|w| w.id == "TWO").unwrap();
        assert_eq!(work.depends_on, ["ONE"]);
        assert_eq!(work.milestone, "SHIP");
        assert_eq!(work.priority, "urgent");
        assert!(snapshot.events.iter().any(|event| event.id == "SHIP"));
        let intent = fs::read_to_string(f.vault.join("work/TWO/intent.md")).unwrap();
        assert!(intent.contains("../../사업/A/이슈/./screen.png"));
        assert!(intent.contains("https://example.com"));
        assert!(!intent.contains("sawhorse-stage"));
    }
    #[test]
    fn undated_legacy_milestones_migrate_without_inventing_deadlines() {
        for due in ["", "due: \"\"\n", "due: null\n"] {
            let f = Fixture::new();
            let source = format!("---\ntype: 마일스톤\nid: SHIP\n{due}---\nSchedule undecided");
            f.write("vault/사업/A/이슈/ship.md", &source);
            f.write(
                "vault/사업/A/이슈/member.md",
                "---\ntype: 이슈\nid: MEMBER\nmilestone: SHIP\n---\nMember request",
            );
            let report = f.run();
            assert_eq!(report.status, "completed", "{:?}", report.error);
            let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
            assert!(
                snapshot.diagnostics.is_empty(),
                "{:?}",
                snapshot.diagnostics
            );
            let event = snapshot
                .events
                .iter()
                .find(|event| event.id == "SHIP")
                .unwrap();
            assert!(event.date.is_empty());
            assert_eq!(event.notes, source);
            assert_eq!(snapshot.work[0].milestone, "SHIP");
            assert_eq!(f.run().status, "completed");
        }
    }
    #[test]
    fn wiki_links_and_forward_dependencies_survive_migration() {
        let f = Fixture::new();
        f.write(
            "vault/사업/A/이슈/A.md",
            "---\ntype: 이슈\nid: A\ndepends_on: [\"[[Z Last|Misleading alias]]\"]\n---\nFirst",
        );
        f.write(
            "vault/사업/A/이슈/B.md",
            "---\ntype: 이슈\nid: B\ndepends_on: [Z]\n---\nSecond",
        );
        f.write(
            "vault/사업/A/이슈/C.md",
            "---\ntype: 이슈\nid: C\ndepends_on: [\"[[사업/A/이슈/Z Last.md]]\"]\n---\nThird",
        );
        f.write(
            "vault/사업/A/이슈/Z Last.md",
            "---\ntype: 이슈\nid: Z\n---\nLast",
        );
        let report = f.run();
        assert_eq!(report.status, "completed", "{:?}", report.error);
        let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
        assert!(
            snapshot.diagnostics.is_empty(),
            "{:?}",
            snapshot.diagnostics
        );
        for id in ["A", "B", "C"] {
            assert_eq!(
                snapshot
                    .work
                    .iter()
                    .find(|w| w.id == id)
                    .unwrap()
                    .depends_on,
                ["Z"]
            );
        }
        f.write("vault/사업/A/이슈/D.md", "---\ntype: 이슈\nid: D\ndepends_on: [\"[[Z Last|Already migrated target]]\"]\n---\nAdded later");
        crate::sdlc::upgrade_legacy_at(&f.vault, &serde_json::json!({})).unwrap();
        let snapshot = crate::sdlc::snapshot(&f.vault).unwrap();
        assert!(
            snapshot.diagnostics.is_empty(),
            "{:?}",
            snapshot.diagnostics
        );
        assert_eq!(
            snapshot
                .work
                .iter()
                .find(|w| w.id == "D")
                .unwrap()
                .depends_on,
            ["Z"]
        );
    }
    #[test]
    fn stale_migration_stamp_blocks_replacement() {
        let f = Fixture::new();
        f.write(
            "vault/프로젝트/A/이슈/1.md",
            "---\ntype: 이슈\nid: ONE\nmigrated_to: MISSING\n---\noriginal",
        );
        let before = tree_hash(&f.vault).unwrap();
        let report = f.run();
        assert_eq!(report.status, "failed");
        assert_eq!(tree_hash(&f.vault).unwrap(), before);
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_data_is_never_followed_or_replaced() {
        let f = Fixture::new();
        f.write("outside/private.md", "private");
        std::os::unix::fs::symlink(f.root.join("outside"), f.vault.join("linked")).unwrap();
        let report = f.run();
        assert_eq!(report.status, "failed");
        assert!(f.vault.join("linked").is_symlink());
        assert_eq!(
            fs::read_to_string(f.root.join("outside/private.md")).unwrap(),
            "private"
        );
    }
}
