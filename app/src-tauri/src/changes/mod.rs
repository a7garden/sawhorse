use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const CHANGESET_FORMAT_VERSION: u32 = 1;
const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Create,
    Write,
    Move,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeOperationInput {
    pub kind: Option<ChangeKind>,
    pub source: Option<String>,
    pub target: String,
    pub content: Option<String>,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeSetPreviewInput {
    pub operations: Vec<ChangeOperationInput>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum OperationStatus {
    Pending,
    Applying,
    Applied,
    RolledBack,
    Conflict,
}

impl Default for OperationStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeOperation {
    pub id: String,
    pub kind: Option<ChangeKind>,
    pub source: Option<String>,
    pub target: String,
    pub content: Option<String>,
    pub reason: String,
    pub expected_source_hash: Option<String>,
    pub expected_target_hash: Option<String>,
    pub target_must_be_absent: bool,
    pub backup_path: Option<String>,
    pub applied_hash: Option<String>,
    pub status: OperationStatus,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeSetStatus {
    Previewed,
    Applying,
    Applied,
    RollingBack,
    RolledBack,
    Conflict,
}

impl Default for ChangeSetStatus {
    fn default() -> Self {
        Self::Previewed
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ChangeSet {
    pub format_version: u32,
    pub id: String,
    pub root_identity: String,
    pub status: ChangeSetStatus,
    pub created_at: String,
    pub updated_at: String,
    pub operations: Vec<ChangeOperation>,
}

fn apply_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn digest_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn file_hash(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| digest_bytes(&bytes))
        .map_err(|error| format!("파일 hash 읽기 실패: {error}"))
}

pub(crate) fn guarded_file_hash(root: &Path, relative: &str) -> Result<String, String> {
    let path = checked_path(root, relative)?;
    if !path.is_file() {
        return Err(format!("변경 대상 source 파일이 없습니다: {relative}"));
    }
    file_hash(&path)
}

fn root_identity(root: &Path) -> Result<String, String> {
    let canonical = root
        .canonicalize()
        .map_err(|error| format!("볼트 identity 확인 실패: {error}"))?;
    let metadata =
        fs::metadata(&canonical).map_err(|error| format!("볼트 metadata 확인 실패: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(format!(
            "{}|{}:{}",
            canonical.display(),
            metadata.dev(),
            metadata.ino()
        ))
    }
    #[cfg(not(unix))]
    {
        Ok(canonical.display().to_string())
    }
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || value.replace('\\', "/").starts_with(".sawhorse/")
    {
        return Err(format!("안전하지 않은 볼트 상대경로입니다: {value}"));
    }
    Ok(path.to_path_buf())
}

fn checked_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = relative_path(value)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("볼트 경로 확인 실패: {error}"))?;
    let mut probe = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("안전하지 않은 볼트 상대경로입니다".into());
        };
        probe.push(name);
        if let Ok(metadata) = fs::symlink_metadata(&probe) {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "symlink 경로에는 변경을 적용할 수 없습니다: {value}"
                ));
            }
            let actual = probe
                .canonicalize()
                .map_err(|error| format!("경로 확인 실패: {error}"))?;
            if !actual.starts_with(&canonical_root) {
                return Err(format!("볼트 밖 경로입니다: {value}"));
            }
        }
    }
    Ok(root.join(relative))
}

fn journal_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    Uuid::parse_str(id).map_err(|_| "유효하지 않은 ChangeSet ID입니다".to_string())?;
    Ok(root
        .join(".sawhorse")
        .join("changes")
        .join(format!("{id}.json")))
}

fn backup_path(root: &Path, set_id: &str, operation_id: &str) -> PathBuf {
    root.join(".sawhorse")
        .join("changes")
        .join(set_id)
        .join("backups")
        .join(operation_id)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "대상 파일의 상위 폴더가 없습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("상위 폴더 생성 실패: {error}"))?;
    let temporary = parent.join(format!(".sawhorse-{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)
            .map_err(|error| format!("임시 파일 생성 실패: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("임시 파일 쓰기 실패: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("임시 파일 동기화 실패: {error}"))?;
        fs::rename(&temporary, path).map_err(|error| format!("파일 교체 실패: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn save(root: &Path, set: &ChangeSet) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(set)
        .map_err(|error| format!("ChangeSet 직렬화 실패: {error}"))?;
    write_atomic(&journal_path(root, &set.id)?, &bytes)
}

fn load(root: &Path, id: &str) -> Result<ChangeSet, String> {
    let path = journal_path(root, id)?;
    let bytes = fs::read(path).map_err(|error| format!("ChangeSet 읽기 실패: {error}"))?;
    let set: ChangeSet = serde_json::from_slice(&bytes)
        .map_err(|error| format!("ChangeSet journal 파싱 실패: {error}"))?;
    if set.format_version != CHANGESET_FORMAT_VERSION || set.id != id {
        return Err("지원하지 않거나 identity가 다른 ChangeSet입니다".into());
    }
    Ok(set)
}

pub fn preview(root: &Path, input: ChangeSetPreviewInput) -> Result<ChangeSet, String> {
    if input.operations.is_empty() {
        return Err("ChangeSet에는 하나 이상의 작업이 필요합니다".into());
    }
    let content_bytes = input
        .operations
        .iter()
        .filter_map(|operation| operation.content.as_ref())
        .map(String::len)
        .sum::<usize>();
    if content_bytes > MAX_CONTENT_BYTES {
        return Err("ChangeSet content 합계는 64 MiB를 넘을 수 없습니다".into());
    }
    let mut occupied_targets = HashSet::new();
    let mut operations = Vec::new();
    for (index, input) in input.operations.into_iter().enumerate() {
        let kind = input
            .kind
            .clone()
            .ok_or_else(|| format!("operations[{index}].kind가 필요합니다"))?;
        let target = checked_path(root, &input.target)?;
        if !occupied_targets.insert(input.target.clone()) {
            return Err(format!("중복 ChangeSet target입니다: {}", input.target));
        }
        let (expected_source_hash, expected_target_hash, target_must_be_absent) = match kind {
            ChangeKind::Create => {
                if input.source.is_some() || input.content.is_none() || target.exists() {
                    return Err(format!(
                        "create는 source 없이 content가 필요하고 대상이 없어야 합니다: {}",
                        input.target
                    ));
                }
                (None, None, true)
            }
            ChangeKind::Write => {
                if input.source.is_some() || input.content.is_none() || !target.is_file() {
                    return Err(format!(
                        "write는 기존 일반 파일 대상과 content가 필요합니다: {}",
                        input.target
                    ));
                }
                (None, Some(file_hash(&target)?), false)
            }
            ChangeKind::Move => {
                let source_value = input
                    .source
                    .as_deref()
                    .ok_or_else(|| "move에는 source가 필요합니다".to_string())?;
                let source = checked_path(root, source_value)?;
                if !source.is_file() || target.exists() {
                    return Err(format!(
                        "move는 기존 일반 파일 source와 비어 있는 target이 필요합니다: {source_value} → {}",
                        input.target
                    ));
                }
                (Some(file_hash(&source)?), None, true)
            }
        };
        operations.push(ChangeOperation {
            id: format!("op-{:04}", index + 1),
            kind: Some(kind),
            source: input.source,
            target: input.target,
            content: input.content,
            reason: input.reason,
            expected_source_hash,
            expected_target_hash,
            target_must_be_absent,
            ..Default::default()
        });
    }
    let timestamp = now();
    let set = ChangeSet {
        format_version: CHANGESET_FORMAT_VERSION,
        id: Uuid::new_v4().to_string(),
        root_identity: root_identity(root)?,
        status: ChangeSetStatus::Previewed,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        operations,
    };
    save(root, &set)?;
    Ok(set)
}

fn conflict(root: &Path, set: &mut ChangeSet, index: usize, message: String) -> Result<(), String> {
    set.operations[index].status = OperationStatus::Conflict;
    set.operations[index].error = Some(message);
    set.status = ChangeSetStatus::Conflict;
    set.updated_at = now();
    save(root, set)
}

fn ensure_backup(root: &Path, set: &mut ChangeSet, index: usize) -> Result<(), String> {
    if set.operations[index].backup_path.is_some() {
        return Ok(());
    }
    let operation = &set.operations[index];
    if matches!(operation.kind, Some(ChangeKind::Create)) {
        // Persist intent before the first user-file mutation so recovery never
        // has to guess whether an untouched Pending create owns a new file.
        set.operations[index].status = OperationStatus::Applying;
        set.updated_at = now();
        save(root, set)?;
        return Ok(());
    }
    let source_value = if matches!(operation.kind, Some(ChangeKind::Move)) {
        operation.source.as_deref().unwrap_or_default()
    } else {
        &operation.target
    };
    let source = checked_path(root, source_value)?;
    let backup = backup_path(root, &set.id, &operation.id);
    let bytes = fs::read(&source).map_err(|error| format!("백업 원본 읽기 실패: {error}"))?;
    write_atomic(&backup, &bytes)?;
    let relative = backup
        .strip_prefix(root)
        .unwrap_or(&backup)
        .to_string_lossy()
        .replace('\\', "/");
    set.operations[index].backup_path = Some(relative);
    set.operations[index].status = OperationStatus::Applying;
    set.updated_at = now();
    save(root, set)
}

pub fn apply(root: &Path, id: &str) -> Result<ChangeSet, String> {
    let _guard = apply_lock()
        .lock()
        .map_err(|_| "ChangeSet 적용 lock이 손상되었습니다".to_string())?;
    let mut set = load(root, id)?;
    if set.root_identity != root_identity(root)? {
        return Err("ChangeSet이 생성된 볼트 identity와 현재 볼트가 다릅니다".into());
    }
    if set.status == ChangeSetStatus::Applied {
        return Ok(set);
    }
    if set.status == ChangeSetStatus::RolledBack || set.status == ChangeSetStatus::RollingBack {
        return Err("롤백된 ChangeSet은 다시 적용할 수 없습니다".into());
    }
    set.status = ChangeSetStatus::Applying;
    set.updated_at = now();
    save(root, &set)?;
    for index in 0..set.operations.len() {
        if set.operations[index].status == OperationStatus::Applied {
            continue;
        }
        let operation = set.operations[index].clone();
        let target = checked_path(root, &operation.target)?;
        // Recover an interrupted apply that changed the file before persisting status.
        let intended_hash = match operation.kind {
            Some(ChangeKind::Create | ChangeKind::Write) => operation
                .content
                .as_ref()
                .map(|content| digest_bytes(content.as_bytes())),
            Some(ChangeKind::Move) => operation
                .content
                .as_ref()
                .map(|content| digest_bytes(content.as_bytes()))
                .or_else(|| operation.expected_source_hash.clone()),
            None => None,
        };
        if target.is_file()
            && intended_hash
                .as_deref()
                .is_some_and(|expected| file_hash(&target).ok().as_deref() == Some(expected))
            && (!matches!(operation.kind, Some(ChangeKind::Move))
                || operation
                    .source
                    .as_deref()
                    .and_then(|source| checked_path(root, source).ok())
                    .is_some_and(|source| !source.exists()))
        {
            set.operations[index].applied_hash = intended_hash;
            set.operations[index].status = OperationStatus::Applied;
            set.operations[index].error = None;
            set.updated_at = now();
            save(root, &set)?;
            continue;
        }
        if matches!(operation.kind, Some(ChangeKind::Move))
            && operation.content.is_some()
            && target.is_file()
            && operation
                .source
                .as_deref()
                .and_then(|source| checked_path(root, source).ok())
                .is_some_and(|source| !source.exists())
            && operation.expected_source_hash.as_deref() == file_hash(&target).ok().as_deref()
            && operation.backup_path.is_some()
        {
            write_atomic(
                &target,
                operation.content.as_deref().unwrap_or_default().as_bytes(),
            )?;
            set.operations[index].applied_hash = Some(file_hash(&target)?);
            set.operations[index].status = OperationStatus::Applied;
            set.operations[index].error = None;
            set.updated_at = now();
            save(root, &set)?;
            continue;
        }
        match operation.kind {
            Some(ChangeKind::Create) if target.exists() => {
                conflict(
                    root,
                    &mut set,
                    index,
                    "create 대상이 미리보기 후 생겼습니다".into(),
                )?;
                return Ok(set);
            }
            Some(ChangeKind::Write) => {
                let observed = target.is_file().then(|| file_hash(&target)).transpose()?;
                if observed != operation.expected_target_hash {
                    conflict(
                        root,
                        &mut set,
                        index,
                        "write 대상이 미리보기 후 변경되었습니다".into(),
                    )?;
                    return Ok(set);
                }
            }
            Some(ChangeKind::Move) => {
                let source = checked_path(root, operation.source.as_deref().unwrap_or_default())?;
                let observed = source.is_file().then(|| file_hash(&source)).transpose()?;
                if observed != operation.expected_source_hash || target.exists() {
                    conflict(
                        root,
                        &mut set,
                        index,
                        "move source 또는 target이 미리보기 후 변경되었습니다".into(),
                    )?;
                    return Ok(set);
                }
            }
            None => return Err("ChangeSet operation kind가 없습니다".into()),
            _ => {}
        }
        ensure_backup(root, &mut set, index)?;
        match operation.kind {
            Some(ChangeKind::Create | ChangeKind::Write) => {
                write_atomic(
                    &target,
                    operation.content.as_deref().unwrap_or_default().as_bytes(),
                )?;
            }
            Some(ChangeKind::Move) => {
                let source = checked_path(root, operation.source.as_deref().unwrap_or_default())?;
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("move target 폴더 생성 실패: {error}"))?;
                }
                fs::rename(&source, &target).map_err(|error| format!("파일 이동 실패: {error}"))?;
                if let Some(content) = operation.content.as_deref() {
                    write_atomic(&target, content.as_bytes())?;
                }
            }
            None => unreachable!(),
        }
        set.operations[index].applied_hash = Some(file_hash(&target)?);
        set.operations[index].status = OperationStatus::Applied;
        set.operations[index].error = None;
        set.updated_at = now();
        save(root, &set)?;
    }
    set.status = ChangeSetStatus::Applied;
    set.updated_at = now();
    save(root, &set)?;
    Ok(set)
}

pub fn rollback(root: &Path, id: &str) -> Result<ChangeSet, String> {
    let _guard = apply_lock()
        .lock()
        .map_err(|_| "ChangeSet 롤백 lock이 손상되었습니다".to_string())?;
    let mut set = load(root, id)?;
    if set.root_identity != root_identity(root)? {
        return Err("ChangeSet이 생성된 볼트 identity와 현재 볼트가 다릅니다".into());
    }
    if set.status == ChangeSetStatus::RolledBack {
        return Ok(set);
    }
    set.status = ChangeSetStatus::RollingBack;
    set.updated_at = now();
    save(root, &set)?;
    for index in (0..set.operations.len()).rev() {
        if set.operations[index].status == OperationStatus::RolledBack {
            continue;
        }
        if set.operations[index].applied_hash.is_none()
            && set.operations[index].status == OperationStatus::Conflict
        {
            // This operation never changed the vault. Preserve the diagnostic but
            // do not let it prevent earlier successfully applied operations from
            // being rolled back.
            set.operations[index].status = OperationStatus::RolledBack;
            set.updated_at = now();
            save(root, &set)?;
            continue;
        }
        let operation = set.operations[index].clone();
        let target = checked_path(root, &operation.target)?;
        let current_hash = target.is_file().then(|| file_hash(&target)).transpose()?;
        if operation.applied_hash.is_none() {
            let may_have_been_interrupted = operation.status == OperationStatus::Applying;
            let intended_hash = match operation.kind {
                Some(ChangeKind::Create | ChangeKind::Write) => operation
                    .content
                    .as_ref()
                    .map(|content| digest_bytes(content.as_bytes())),
                Some(ChangeKind::Move) => operation
                    .content
                    .as_ref()
                    .map(|content| digest_bytes(content.as_bytes()))
                    .or_else(|| operation.expected_source_hash.clone()),
                None => None,
            };
            let move_source_absent = !matches!(operation.kind, Some(ChangeKind::Move))
                || operation
                    .source
                    .as_deref()
                    .and_then(|source| checked_path(root, source).ok())
                    .is_some_and(|source| !source.exists());
            if may_have_been_interrupted && current_hash == intended_hash && move_source_absent {
                set.operations[index].applied_hash = intended_hash;
                set.operations[index].status = OperationStatus::Applied;
                set.updated_at = now();
                save(root, &set)?;
            } else {
                set.operations[index].status = OperationStatus::RolledBack;
                set.updated_at = now();
                save(root, &set)?;
                continue;
            }
        }
        let operation = set.operations[index].clone();
        if current_hash != operation.applied_hash {
            conflict(
                root,
                &mut set,
                index,
                "적용 이후 사용자가 수정한 target은 자동 롤백하지 않습니다".into(),
            )?;
            return Ok(set);
        }
        match operation.kind {
            Some(ChangeKind::Create) => {
                fs::remove_file(&target).map_err(|error| format!("create 롤백 실패: {error}"))?;
            }
            Some(ChangeKind::Write) => {
                let backup = root.join(operation.backup_path.as_deref().unwrap_or_default());
                let bytes =
                    fs::read(&backup).map_err(|error| format!("write 백업 읽기 실패: {error}"))?;
                write_atomic(&target, &bytes)?;
            }
            Some(ChangeKind::Move) => {
                let source = checked_path(root, operation.source.as_deref().unwrap_or_default())?;
                if source.exists() {
                    conflict(
                        root,
                        &mut set,
                        index,
                        "원래 source 경로가 다시 생겨 자동 롤백하지 않습니다".into(),
                    )?;
                    return Ok(set);
                }
                if let Some(parent) = source.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|error| format!("롤백 source 폴더 생성 실패: {error}"))?;
                }
                fs::rename(&target, &source).map_err(|error| format!("move 롤백 실패: {error}"))?;
                if operation.content.is_some() {
                    let backup = root.join(operation.backup_path.as_deref().unwrap_or_default());
                    let bytes = fs::read(&backup)
                        .map_err(|error| format!("move 변환 백업 읽기 실패: {error}"))?;
                    write_atomic(&source, &bytes)?;
                }
            }
            None => return Err("ChangeSet operation kind가 없습니다".into()),
        }
        set.operations[index].status = OperationStatus::RolledBack;
        set.operations[index].error = None;
        set.updated_at = now();
        save(root, &set)?;
    }
    set.status = ChangeSetStatus::RolledBack;
    set.updated_at = now();
    save(root, &set)?;
    Ok(set)
}

#[tauri::command]
pub fn changeset_preview(input: ChangeSetPreviewInput) -> Result<ChangeSet, String> {
    let root = crate::sdlc::vault_root()?;
    preview(&root, input)
}

#[tauri::command]
pub fn changeset_apply(id: String) -> Result<ChangeSet, String> {
    let root = crate::sdlc::vault_root()?;
    apply(&root, &id)
}

#[tauri::command]
pub fn changeset_rollback(id: String) -> Result<ChangeSet, String> {
    let root = crate::sdlc::vault_root()?;
    rollback(&root, &id)
}

#[tauri::command]
pub fn changeset_get(id: String) -> Result<ChangeSet, String> {
    let root = crate::sdlc::vault_root()?;
    load(&root, &id)
}

pub(crate) fn get(root: &Path, id: &str) -> Result<ChangeSet, String> {
    load(root, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("sawhorse-changes-{}", Uuid::new_v4()));
        fs::create_dir_all(path.join(".sawhorse")).unwrap();
        path
    }

    #[test]
    fn move_applies_and_rolls_back_with_hash_guards() {
        let root = tempdir();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old/item.md"), "original").unwrap();
        let set = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Move),
                    source: Some("old/item.md".into()),
                    target: "new/item.md".into(),
                    reason: "schema path".into(),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        assert!(root.join("old/item.md").is_file());
        let applied = apply(&root, &set.id).unwrap();
        assert_eq!(applied.status, ChangeSetStatus::Applied);
        assert_eq!(
            fs::read_to_string(root.join("new/item.md")).unwrap(),
            "original"
        );
        let rolled_back = rollback(&root, &set.id).unwrap();
        assert_eq!(rolled_back.status, ChangeSetStatus::RolledBack);
        assert_eq!(
            fs::read_to_string(root.join("old/item.md")).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn apply_conflict_preserves_external_edit() {
        let root = tempdir();
        fs::write(root.join("item.md"), "before").unwrap();
        let set = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Write),
                    target: "item.md".into(),
                    content: Some("planned".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        fs::write(root.join("item.md"), "external edit").unwrap();
        let result = apply(&root, &set.id).unwrap();
        assert_eq!(result.status, ChangeSetStatus::Conflict);
        assert_eq!(
            fs::read_to_string(root.join("item.md")).unwrap(),
            "external edit"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn conflict_in_a_later_operation_does_not_block_partial_rollback() {
        let root = tempdir();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old/item.md"), "move me").unwrap();
        fs::write(root.join("edit.md"), "before").unwrap();
        let set = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![
                    ChangeOperationInput {
                        kind: Some(ChangeKind::Move),
                        source: Some("old/item.md".into()),
                        target: "new/item.md".into(),
                        ..Default::default()
                    },
                    ChangeOperationInput {
                        kind: Some(ChangeKind::Write),
                        target: "edit.md".into(),
                        content: Some("planned".into()),
                        ..Default::default()
                    },
                ],
            },
        )
        .unwrap();
        fs::write(root.join("edit.md"), "external").unwrap();

        let conflicted = apply(&root, &set.id).unwrap();
        assert_eq!(conflicted.status, ChangeSetStatus::Conflict);
        assert!(root.join("new/item.md").exists());
        let rolled_back = rollback(&root, &set.id).unwrap();
        assert_eq!(rolled_back.status, ChangeSetStatus::RolledBack);
        assert!(root.join("old/item.md").exists());
        assert!(!root.join("new/item.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("edit.md")).unwrap(),
            "external"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn create_rollback_uses_persisted_ownership_instead_of_matching_content() {
        let root = tempdir();
        let external = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Create),
                    target: "external.md".into(),
                    content: Some("same bytes".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        fs::write(root.join("external.md"), "same bytes").unwrap();
        rollback(&root, &external.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("external.md")).unwrap(),
            "same bytes",
            "a Pending create never owns an externally created matching file"
        );

        let mut interrupted = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Create),
                    target: "owned.md".into(),
                    content: Some("created by apply".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        interrupted.status = ChangeSetStatus::Applying;
        interrupted.operations[0].status = OperationStatus::Applying;
        save(&root, &interrupted).unwrap();
        fs::write(root.join("owned.md"), "created by apply").unwrap();
        let rolled_back = rollback(&root, &interrupted.id).unwrap();
        assert_eq!(rolled_back.status, ChangeSetStatus::RolledBack);
        assert!(!root.join("owned.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rollback_refuses_to_overwrite_post_apply_changes() {
        let root = tempdir();
        let set = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Create),
                    target: "created.md".into(),
                    content: Some("generated".into()),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        apply(&root, &set.id).unwrap();
        fs::write(root.join("created.md"), "user edit").unwrap();
        let result = rollback(&root, &set.id).unwrap();
        assert_eq!(result.status, ChangeSetStatus::Conflict);
        assert_eq!(
            fs::read_to_string(root.join("created.md")).unwrap(),
            "user edit"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unsafe_paths_and_symlink_escape_are_rejected() {
        let root = tempdir();
        for target in ["../outside", ".sawhorse/runtime.sqlite", "/tmp/out"] {
            assert!(preview(
                &root,
                ChangeSetPreviewInput {
                    operations: vec![ChangeOperationInput {
                        kind: Some(ChangeKind::Create),
                        target: target.into(),
                        content: Some("x".into()),
                        ..Default::default()
                    }],
                }
            )
            .is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_can_atomically_transform_content_and_restore_original() {
        let root = tempdir();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old/item.md"), "old content").unwrap();
        let set = preview(
            &root,
            ChangeSetPreviewInput {
                operations: vec![ChangeOperationInput {
                    kind: Some(ChangeKind::Move),
                    source: Some("old/item.md".into()),
                    target: "new/item.md".into(),
                    content: Some("new content".into()),
                    reason: "schema path and field migration".into(),
                }],
            },
        )
        .unwrap();
        apply(&root, &set.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("new/item.md")).unwrap(),
            "new content"
        );
        rollback(&root, &set.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("old/item.md")).unwrap(),
            "old content"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
