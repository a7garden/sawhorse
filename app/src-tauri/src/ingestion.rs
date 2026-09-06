use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const FORMAT_VERSION: u32 = 1;
const ANALYZER_REVISION: &str = "static-inventory-v1";
const TEMPLATE_REVISION: &str = "project-docs-v1";
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES: u64 = 512 * 1024 * 1024;
const DEFAULT_BATCH: u32 = 200;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IngestionSourceInput {
    pub path: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IngestionStartInput {
    pub project_id: String,
    pub sources: Vec<IngestionSourceInput>,
    pub output_prefix: String,
    pub auto_apply: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum IngestionStatus {
    Paused,
    Running,
    WaitingReview,
    Applied,
    Cancelled,
    Failed,
}

impl Default for IngestionStatus {
    fn default() -> Self {
        Self::Paused
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PlannedInputFile {
    pub source_label: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub expected_digest: String,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SnapshotFile {
    pub id: String,
    pub source_label: String,
    pub original_path: String,
    pub relative_path: String,
    pub evidence_path: String,
    pub digest: String,
    pub size: u64,
    pub media_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProvenanceReference {
    pub claim: String,
    pub snapshot_file_id: String,
    pub evidence_path: String,
    pub location: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IngestionDraft {
    pub path: String,
    pub content: String,
    pub provenance: Vec<ProvenanceReference>,
    pub conflict: bool,
    pub conflict_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct IngestionJob {
    pub format_version: u32,
    pub id: String,
    pub key: String,
    pub project_id: String,
    pub output_prefix: String,
    pub status: IngestionStatus,
    pub stage: String,
    pub planned_files: Vec<PlannedInputFile>,
    pub snapshots: Vec<SnapshotFile>,
    pub drafts: Vec<IngestionDraft>,
    pub processed_files: u32,
    pub total_files: u32,
    pub processed_bytes: u64,
    pub change_set_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub error: Option<String>,
    pub auto_apply: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
struct MergeBase {
    generated_digest: String,
    content: String,
}

fn lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn now() -> String {
    Utc::now().to_rfc3339()
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "ingestion 저장 경로가 잘못되었습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("ingestion 폴더 생성 실패: {error}"))?;
    let temporary = parent.join(format!(".ingestion-{}.tmp", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("ingestion 임시 파일 생성 실패: {error}"))?;
        file.write_all(bytes)
            .map_err(|error| format!("ingestion 임시 파일 쓰기 실패: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("ingestion 임시 파일 동기화 실패: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("ingestion 파일 확정 실패: {error}")
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_relative(value: &str) -> Result<String, String> {
    let normalized = value.replace('\\', "/").trim_matches('/').to_string();
    let path = Path::new(&normalized);
    if normalized.is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || normalized.starts_with(".sawhorse/")
    {
        return Err(format!("안전하지 않은 볼트 상대경로입니다: {value}"));
    }
    Ok(normalized)
}

fn open(root: &Path) -> Result<Connection, String> {
    fs::create_dir_all(root.join(".sawhorse"))
        .map_err(|error| format!("ingestion 장부 폴더 생성 실패: {error}"))?;
    let connection = Connection::open(root.join(".sawhorse/runtime.sqlite"))
        .map_err(|error| format!("ingestion 장부 열기 실패: {error}"))?;
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS ingestion_jobs (
           id TEXT PRIMARY KEY,
           job_key TEXT NOT NULL UNIQUE,
           project_id TEXT NOT NULL,
           status TEXT NOT NULL,
           state_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ingestion_project ON ingestion_jobs(project_id, updated_at DESC);",
    ).map_err(|error| format!("ingestion 장부 초기화 실패: {error}"))?;
    Ok(connection)
}

fn status_text(status: &IngestionStatus) -> &'static str {
    match status {
        IngestionStatus::Paused => "paused",
        IngestionStatus::Running => "running",
        IngestionStatus::WaitingReview => "waiting-review",
        IngestionStatus::Applied => "applied",
        IngestionStatus::Cancelled => "cancelled",
        IngestionStatus::Failed => "failed",
    }
}

fn save(connection: &Connection, job: &IngestionJob) -> Result<(), String> {
    let json =
        serde_json::to_string(job).map_err(|error| format!("ingestion 직렬화 실패: {error}"))?;
    connection.execute(
        "INSERT INTO ingestion_jobs(id,job_key,project_id,status,state_json,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status,state_json=excluded.state_json,updated_at=excluded.updated_at",
        params![job.id, job.key, job.project_id, status_text(&job.status), json, job.created_at, job.updated_at],
    ).map(|_| ()).map_err(|error| format!("ingestion 저장 실패: {error}"))
}

fn decode(json: String) -> Result<IngestionJob, String> {
    let job: IngestionJob = serde_json::from_str(&json)
        .map_err(|error| format!("ingestion 장부 파싱 실패: {error}"))?;
    if job.format_version != FORMAT_VERSION {
        return Err("지원하지 않는 ingestion 형식입니다".into());
    }
    Ok(job)
}

fn load(connection: &Connection, id: &str) -> Result<IngestionJob, String> {
    if !valid_id(id) {
        return Err("유효하지 않은 ingestion ID입니다".into());
    }
    connection
        .query_row(
            "SELECT state_json FROM ingestion_jobs WHERE id=?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("ingestion 읽기 실패: {error}"))?
        .map(decode)
        .transpose()?
        .ok_or_else(|| "ingestion job을 찾을 수 없습니다".into())
}

fn ignored(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".sawhorse" | "node_modules" | "target" | "dist" | "build" | ".next" | ".cache"
    )
}

fn enumerate(source: &IngestionSourceInput) -> Result<Vec<PlannedInputFile>, String> {
    let source_path = PathBuf::from(&source.path);
    let canonical = source_path
        .canonicalize()
        .map_err(|error| format!("입력 경로 확인 실패: {error}"))?;
    let label = if source.label.trim().is_empty() {
        canonical
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("source")
            .to_string()
    } else {
        source.label.trim().to_string()
    };
    fn visit(
        base: &Path,
        path: &Path,
        label: &str,
        output: &mut Vec<PlannedInputFile>,
    ) -> Result<(), String> {
        let metadata =
            fs::symlink_metadata(path).map_err(|error| format!("입력 metadata 실패: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Ok(());
        }
        if metadata.is_file() {
            if metadata.len() <= MAX_FILE_BYTES {
                let bytes =
                    fs::read(path).map_err(|error| format!("입력 digest 읽기 실패: {error}"))?;
                output.push(PlannedInputFile {
                    source_label: label.into(),
                    absolute_path: path.display().to_string(),
                    relative_path: path
                        .strip_prefix(base)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    expected_digest: digest(&bytes),
                    size: bytes.len() as u64,
                });
            }
            return Ok(());
        }
        if !metadata.is_dir() {
            return Ok(());
        }
        let mut entries = fs::read_dir(path)
            .map_err(|error| format!("입력 폴더 읽기 실패: {error}"))?
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if ignored(&entry.file_name().to_string_lossy()) {
                continue;
            }
            visit(base, &entry.path(), label, output)?;
            if output.len() > MAX_FILES {
                return Err(format!("입력 파일은 최대 {MAX_FILES}개입니다"));
            }
        }
        Ok(())
    }
    let base = if canonical.is_file() {
        canonical.parent().unwrap_or(&canonical)
    } else {
        &canonical
    };
    let mut files = Vec::new();
    visit(base, &canonical, &label, &mut files)?;
    if files.iter().map(|file| file.size).sum::<u64>() > MAX_SNAPSHOT_BYTES {
        return Err("입력 snapshot 전체 크기 상한을 넘었습니다".into());
    }
    Ok(files)
}

fn media_type(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" => "text/markdown",
        "txt" | "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "java" | "kt" | "c" | "h"
        | "cpp" | "toml" | "yaml" | "yml" | "json" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ => "application/octet-stream",
    }
    .into()
}

fn start_key(input: &IngestionStartInput, files: &[PlannedInputFile]) -> Result<String, String> {
    let value = serde_json::json!({ "projectId": input.project_id, "sources": input.sources, "files": files, "outputPrefix": input.output_prefix, "analyzer": ANALYZER_REVISION, "template": TEMPLATE_REVISION });
    serde_json::to_vec(&value)
        .map(|bytes| digest(&bytes))
        .map_err(|error| error.to_string())
}

pub fn start_at(root: &Path, input: IngestionStartInput) -> Result<IngestionJob, String> {
    let _guard = lock()
        .lock()
        .map_err(|_| "ingestion lock이 손상되었습니다".to_string())?;
    if !valid_id(&input.project_id) || input.sources.is_empty() {
        return Err("유효한 project ID와 하나 이상의 입력 source가 필요합니다".into());
    }
    let output_prefix = safe_relative(if input.output_prefix.trim().is_empty() {
        "generated"
    } else {
        &input.output_prefix
    })?;
    let mut planned_files = Vec::new();
    for source in &input.sources {
        planned_files.extend(enumerate(source)?);
    }
    planned_files.sort_by(|left, right| {
        left.source_label
            .cmp(&right.source_label)
            .then(left.relative_path.cmp(&right.relative_path))
    });
    planned_files.dedup_by(|left, right| left.absolute_path == right.absolute_path);
    let key = start_key(&input, &planned_files)?;
    let connection = open(root)?;
    if let Some(json) = connection
        .query_row(
            "SELECT state_json FROM ingestion_jobs WHERE job_key=?1",
            [&key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("ingestion 중복 확인 실패: {error}"))?
    {
        return decode(json);
    }
    let timestamp = now();
    let job = IngestionJob {
        format_version: FORMAT_VERSION,
        id: Uuid::new_v4().to_string(),
        key,
        project_id: input.project_id,
        output_prefix,
        status: IngestionStatus::Paused,
        stage: "snapshot".into(),
        total_files: planned_files.len() as u32,
        planned_files,
        created_at: timestamp.clone(),
        updated_at: timestamp,
        auto_apply: input.auto_apply,
        ..Default::default()
    };
    save(&connection, &job)?;
    Ok(job)
}

fn evidence_relative(job: &IngestionJob, file_digest: &str, extension: Option<&str>) -> String {
    let suffix = extension
        .filter(|value| value.len() <= 12 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    format!(
        ".sawhorse/evidence/ingestion/{}/{}{}",
        job.key, file_digest, suffix
    )
}

fn merge_bases_path(root: &Path) -> PathBuf {
    root.join(".sawhorse/ingestion/merge-bases.json")
}

fn merge_bases(root: &Path) -> Result<BTreeMap<String, MergeBase>, String> {
    let path = merge_bases_path(root);
    if !path.is_file() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("merge base 읽기 실패: {error}"))?,
    )
    .map_err(|error| format!("merge base 파싱 실패: {error}"))
}

fn draft_for(
    root: &Path,
    path: String,
    content: String,
    provenance: Vec<ProvenanceReference>,
) -> Result<IngestionDraft, String> {
    let target = root.join(&path);
    let mut conflict = false;
    let mut reason = None;
    if target.is_file() {
        let current =
            fs::read_to_string(&target).map_err(|error| format!("기존 문서 읽기 실패: {error}"))?;
        if current != content {
            let bases = merge_bases(root)?;
            match bases.get(&path) {
                Some(base) if digest(current.as_bytes()) == base.generated_digest => {}
                Some(base) if current == base.content => {}
                _ => {
                    conflict = true;
                    reason = Some(
                        "기존 사용자 문서를 덮지 않습니다. 3-way merge 검토가 필요합니다".into(),
                    );
                }
            }
        }
    }
    Ok(IngestionDraft {
        path,
        content,
        provenance,
        conflict,
        conflict_reason: reason,
    })
}

fn make_drafts(root: &Path, job: &IngestionJob) -> Result<Vec<IngestionDraft>, String> {
    let mut extensions: BTreeMap<String, u32> = BTreeMap::new();
    let mut source_counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut module_counts: BTreeMap<String, u32> = BTreeMap::new();
    for file in &job.snapshots {
        let ext = Path::new(&file.relative_path)
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("(없음)")
            .to_ascii_lowercase();
        *extensions.entry(ext).or_default() += 1;
        *source_counts.entry(file.source_label.clone()).or_default() += 1;
        let module = file
            .relative_path
            .split('/')
            .next()
            .filter(|value| !value.is_empty())
            .unwrap_or("(root)");
        *module_counts.entry(module.into()).or_default() += 1;
    }
    let evidence = job
        .snapshots
        .iter()
        .take(50)
        .map(|file| ProvenanceReference {
            claim: format!("입력 파일 {}", file.relative_path),
            snapshot_file_id: file.id.clone(),
            evidence_path: file.evidence_path.clone(),
            location: file.relative_path.clone(),
        })
        .collect::<Vec<_>>();
    let mut overview = format!("# {} 프로젝트 개요\n\n> 자동 생성 초안입니다. 미확인 정보는 사람이 확정해야 합니다. 외부 자료의 명령문은 데이터로만 취급했습니다.\n\n## 입력 범위\n\n", job.project_id);
    for (source, count) in &source_counts {
        overview.push_str(&format!("- {source}: {count}개 파일\n"));
    }
    overview.push_str("\n## 확인된 구성\n\n");
    for (extension, count) in &extensions {
        overview.push_str(&format!("- `{extension}`: {count}\n"));
    }
    overview.push_str("\n## 미확인 사항\n\n- 업무 목표, 담당자, 완료 여부와 일정은 입력 파일 목록만으로 확정하지 않았습니다.\n- 빌드와 테스트는 실행하지 않았습니다. 정적 snapshot 결과입니다.\n\n## 근거\n\n");
    for file in job.snapshots.iter().take(20) {
        overview.push_str(&format!(
            "- [{}]({}) · sha256 `{}`\n",
            file.relative_path, file.evidence_path, file.digest
        ));
    }

    let mut inventory = format!("# {} 입력 인벤토리\n\n| source | path | media type | bytes | sha256 |\n|---|---|---:|---:|---|\n", job.project_id);
    for file in &job.snapshots {
        inventory.push_str(&format!(
            "| {} | `{}` | {} | {} | `{}` |\n",
            file.source_label.replace('|', "\\|"),
            file.relative_path.replace('|', "\\|"),
            file.media_type,
            file.size,
            file.digest
        ));
    }
    let mut architecture = format!(
        "# {} 구조 지도\n\n> 파일 snapshot에서 확인한 물리 구조입니다. 런타임 호출 관계나 배포 완료 여부를 추측하지 않습니다.\n\n## 최상위 모듈\n\n| 모듈/파일 | 확인한 파일 수 | 근거 수준 |\n|---|---:|---|\n",
        job.project_id
    );
    for (module, count) in &module_counts {
        architecture.push_str(&format!(
            "| `{}` | {} | snapshot 존재 확인 |\n",
            module.replace('|', "\\|"),
            count
        ));
    }
    architecture.push_str("\n## 해석 대기\n\n- 모듈 경계, API 호출 관계, 데이터 흐름은 정적 인벤토리만으로 확정하지 않았습니다.\n- 빌드·테스트·배포 상태는 실행 증거가 추가될 때 갱신해야 합니다.\n\n## 근거\n\n");
    for file in job.snapshots.iter().take(30) {
        architecture.push_str(&format!(
            "- `{}` → [{}]({})\n",
            file.relative_path, file.id, file.evidence_path
        ));
    }

    let mut traceability = format!(
        "# {} 근거 추적표\n\n| 분류 | 확인된 항목 | 상태 | snapshot |\n|---|---|---|---|\n",
        job.project_id
    );
    for file in &job.snapshots {
        let classification = if file.media_type.starts_with("text/") {
            "정적 텍스트/코드"
        } else if file.media_type == "application/pdf"
            || file.media_type.contains("wordprocessingml")
        {
            "추출기 필요 문서"
        } else {
            "바이너리/미지원"
        };
        traceability.push_str(&format!(
            "| {classification} | `{}` | 존재 확인, 의미 미검토 | [{}]({}) |\n",
            file.relative_path.replace('|', "\\|"),
            file.id,
            file.evidence_path
        ));
    }
    traceability.push_str("\n## 미확인·상충\n\n- 요구사항과 현재 구현의 대응은 의미 분석 또는 사람 검토 전까지 미확인입니다.\n- 제안 문서의 예정 사항을 구현 완료로 승격하지 않습니다.\n");
    let base = format!("{}/{}/", job.output_prefix, job.project_id);
    Ok(vec![
        draft_for(
            root,
            format!("{base}project-overview.md"),
            overview,
            evidence.clone(),
        )?,
        draft_for(
            root,
            format!("{base}source-inventory.md"),
            inventory,
            evidence.clone(),
        )?,
        draft_for(
            root,
            format!("{base}architecture-map.md"),
            architecture,
            evidence.clone(),
        )?,
        draft_for(
            root,
            format!("{base}traceability.md"),
            traceability,
            evidence,
        )?,
    ])
}

pub fn resume_at(root: &Path, id: &str, max_files: Option<u32>) -> Result<IngestionJob, String> {
    let _guard = lock()
        .lock()
        .map_err(|_| "ingestion lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut job = load(&connection, id)?;
    if matches!(
        job.status,
        IngestionStatus::Cancelled | IngestionStatus::Applied
    ) {
        return Err("취소되거나 적용된 ingestion은 재개할 수 없습니다".into());
    }
    job.status = IngestionStatus::Running;
    job.stage = "snapshot".into();
    job.updated_at = now();
    save(&connection, &job)?;
    let limit = max_files.unwrap_or(DEFAULT_BATCH).clamp(1, 2_000) as usize;
    for planned in job
        .planned_files
        .iter()
        .skip(job.processed_files as usize)
        .take(limit)
        .cloned()
        .collect::<Vec<_>>()
    {
        let path = PathBuf::from(&planned.absolute_path);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("snapshot source 확인 실패: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_FILE_BYTES
        {
            job.status = IngestionStatus::Failed;
            job.error = Some(format!(
                "시작 이후 입력 파일 종류 또는 크기가 변경되었습니다: {}",
                planned.relative_path
            ));
            job.updated_at = now();
            save(&connection, &job)?;
            return Ok(job);
        }
        let bytes =
            fs::read(&path).map_err(|error| format!("snapshot source 읽기 실패: {error}"))?;
        if digest(&bytes) != planned.expected_digest {
            job.status = IngestionStatus::Failed;
            job.error = Some(format!(
                "시작 이후 입력 파일 내용이 변경되었습니다: {}",
                planned.relative_path
            ));
            job.updated_at = now();
            save(&connection, &job)?;
            return Ok(job);
        }
        if job.processed_bytes + bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
            job.status = IngestionStatus::Failed;
            job.error = Some("snapshot 전체 크기 상한을 넘었습니다".into());
            save(&connection, &job)?;
            return Ok(job);
        }
        let file_digest = digest(&bytes);
        let relative = evidence_relative(
            &job,
            &file_digest,
            path.extension().and_then(|value| value.to_str()),
        );
        let evidence = root.join(&relative);
        if !evidence.is_file() {
            write_atomic(&evidence, &bytes)?;
        } else if digest(
            &fs::read(&evidence)
                .map_err(|error| format!("기존 evidence snapshot 읽기 실패: {error}"))?,
        ) != file_digest
        {
            job.status = IngestionStatus::Failed;
            job.error = Some(format!(
                "기존 evidence snapshot의 내용 hash가 다릅니다: {relative}"
            ));
            job.updated_at = now();
            save(&connection, &job)?;
            return Ok(job);
        }
        job.snapshots.push(SnapshotFile {
            id: format!("src-{}", &file_digest[..16]),
            source_label: planned.source_label,
            original_path: planned.absolute_path,
            relative_path: planned.relative_path.clone(),
            evidence_path: relative,
            digest: file_digest,
            size: bytes.len() as u64,
            media_type: media_type(&planned.relative_path),
        });
        job.processed_files += 1;
        job.processed_bytes += bytes.len() as u64;
        job.updated_at = now();
        save(&connection, &job)?;
    }
    if job.processed_files >= job.total_files {
        job.stage = "draft".into();
        job.drafts = make_drafts(root, &job)?;
        job.status = IngestionStatus::WaitingReview;
        job.stage = "review".into();
    } else {
        job.status = IngestionStatus::Paused;
    }
    job.updated_at = now();
    save(&connection, &job)?;
    if job.auto_apply
        && job.status == IngestionStatus::WaitingReview
        && !job.drafts.iter().any(|draft| draft.conflict)
    {
        drop(connection);
        drop(_guard);
        return apply_at(root, &job.id);
    }
    Ok(job)
}

pub fn pause_at(root: &Path, id: &str) -> Result<IngestionJob, String> {
    let _guard = lock()
        .lock()
        .map_err(|_| "ingestion lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut job = load(&connection, id)?;
    if job.status == IngestionStatus::Running {
        job.status = IngestionStatus::Paused;
        job.updated_at = now();
        save(&connection, &job)?;
    }
    Ok(job)
}

pub fn cancel_at(root: &Path, id: &str) -> Result<IngestionJob, String> {
    let _guard = lock()
        .lock()
        .map_err(|_| "ingestion lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut job = load(&connection, id)?;
    if job.status != IngestionStatus::Applied {
        job.status = IngestionStatus::Cancelled;
        job.updated_at = now();
        save(&connection, &job)?;
    }
    Ok(job)
}

pub fn apply_at(root: &Path, id: &str) -> Result<IngestionJob, String> {
    let _guard = lock()
        .lock()
        .map_err(|_| "ingestion lock이 손상되었습니다".to_string())?;
    let connection = open(root)?;
    let mut job = load(&connection, id)?;
    if job.status != IngestionStatus::WaitingReview {
        return Err("검토 대기 중인 ingestion만 적용할 수 있습니다".into());
    }
    if job.drafts.iter().any(|draft| draft.conflict) {
        return Err("사용자 문서 충돌을 먼저 해결해야 합니다".into());
    }
    let mut operations = Vec::new();
    for draft in &job.drafts {
        let target = root.join(&draft.path);
        let kind = if target.is_file() {
            crate::changes::ChangeKind::Write
        } else {
            crate::changes::ChangeKind::Create
        };
        operations.push(crate::changes::ChangeOperationInput {
            kind: Some(kind),
            target: draft.path.clone(),
            content: Some(draft.content.clone()),
            reason: format!("ingestion {} 근거 기반 문서 초안", job.id),
            ..Default::default()
        });
    }
    let set = crate::changes::preview(root, crate::changes::ChangeSetPreviewInput { operations })?;
    let applied = crate::changes::apply(root, &set.id)?;
    if applied.status != crate::changes::ChangeSetStatus::Applied {
        job.change_set_id = Some(set.id);
        job.status = IngestionStatus::Failed;
        job.error = Some("문서 ChangeSet 적용 중 충돌했습니다".into());
        save(&connection, &job)?;
        return Ok(job);
    }
    let mut bases = merge_bases(root)?;
    for draft in &job.drafts {
        bases.insert(
            draft.path.clone(),
            MergeBase {
                generated_digest: digest(draft.content.as_bytes()),
                content: draft.content.clone(),
            },
        );
    }
    let base_path = merge_bases_path(root);
    write_atomic(
        &base_path,
        &serde_json::to_vec_pretty(&bases).map_err(|error| error.to_string())?,
    )?;
    job.change_set_id = Some(set.id);
    job.status = IngestionStatus::Applied;
    job.stage = "completed".into();
    job.updated_at = now();
    save(&connection, &job)?;
    Ok(job)
}

pub fn get_at(root: &Path, id: &str) -> Result<IngestionJob, String> {
    load(&open(root)?, id)
}
pub fn list_at(root: &Path) -> Result<Vec<IngestionJob>, String> {
    let connection = open(root)?;
    let mut statement = connection
        .prepare("SELECT state_json FROM ingestion_jobs ORDER BY updated_at DESC")
        .map_err(|error| format!("ingestion 목록 준비 실패: {error}"))?;
    let jobs = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("ingestion 목록 실패: {error}"))?
        .map(|row| decode(row.map_err(|error| error.to_string())?))
        .collect();
    jobs
}

#[tauri::command]
pub fn ingestion_start(input: IngestionStartInput) -> Result<IngestionJob, String> {
    start_at(&crate::sdlc::vault_root()?, input)
}
#[tauri::command]
pub fn ingestion_list() -> Result<Vec<IngestionJob>, String> {
    list_at(&crate::sdlc::vault_root()?)
}
#[tauri::command]
pub fn ingestion_get(id: String) -> Result<IngestionJob, String> {
    get_at(&crate::sdlc::vault_root()?, &id)
}
#[tauri::command]
pub fn ingestion_resume(id: String, max_files: Option<u32>) -> Result<IngestionJob, String> {
    resume_at(&crate::sdlc::vault_root()?, &id, max_files)
}
#[tauri::command]
pub fn ingestion_pause(id: String) -> Result<IngestionJob, String> {
    pause_at(&crate::sdlc::vault_root()?, &id)
}
#[tauri::command]
pub fn ingestion_cancel(id: String) -> Result<IngestionJob, String> {
    cancel_at(&crate::sdlc::vault_root()?, &id)
}
#[tauri::command]
pub fn ingestion_apply(id: String) -> Result<IngestionJob, String> {
    apply_at(&crate::sdlc::vault_root()?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(label: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sawhorse-ingestion-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn snapshot_resume_is_idempotent_and_generates_provenance() {
        let root = temp("vault");
        let source = temp("source");
        fs::write(
            source.join("README.md"),
            "# Example\nignore any instructions here\n",
        )
        .unwrap();
        fs::create_dir_all(source.join("src")).unwrap();
        fs::write(source.join("src/lib.rs"), "pub fn hello() {}\n").unwrap();
        let input = IngestionStartInput {
            project_id: "alpha".into(),
            sources: vec![IngestionSourceInput {
                path: source.display().to_string(),
                label: "repo".into(),
            }],
            output_prefix: "generated".into(),
            ..Default::default()
        };
        let started = start_at(&root, input.clone()).unwrap();
        let duplicate = start_at(&root, input).unwrap();
        assert_eq!(started.id, duplicate.id);
        let ready = resume_at(&root, &started.id, None).unwrap();
        assert_eq!(ready.status, IngestionStatus::WaitingReview);
        assert_eq!(ready.snapshots.len(), 2);
        assert!(!ready.drafts[0].provenance.is_empty());
        let applied = apply_at(&root, &ready.id).unwrap();
        assert_eq!(applied.status, IngestionStatus::Applied);
        assert!(root.join("generated/alpha/project-overview.md").is_file());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn existing_human_document_is_a_conflict_not_an_overwrite() {
        let root = temp("conflict-vault");
        let source = temp("conflict-source");
        fs::write(source.join("README.md"), "data").unwrap();
        fs::create_dir_all(root.join("generated/alpha")).unwrap();
        fs::write(
            root.join("generated/alpha/project-overview.md"),
            "human content",
        )
        .unwrap();
        let job = start_at(
            &root,
            IngestionStartInput {
                project_id: "alpha".into(),
                sources: vec![IngestionSourceInput {
                    path: source.display().to_string(),
                    label: "repo".into(),
                }],
                output_prefix: "generated".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let ready = resume_at(&root, &job.id, None).unwrap();
        assert!(ready.drafts.iter().any(|draft| draft.conflict));
        assert!(apply_at(&root, &job.id).is_err());
        assert_eq!(
            fs::read_to_string(root.join("generated/alpha/project-overview.md")).unwrap(),
            "human content"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source).unwrap();
    }

    #[test]
    fn auto_apply_finishes_clean_drafts_and_changed_input_gets_a_new_job_key() {
        let root = temp("auto-vault");
        let source = temp("auto-source");
        fs::write(source.join("README.md"), "first snapshot").unwrap();
        let input = IngestionStartInput {
            project_id: "alpha".into(),
            sources: vec![IngestionSourceInput {
                path: source.display().to_string(),
                label: "repo".into(),
            }],
            output_prefix: "generated".into(),
            auto_apply: true,
        };
        let first = start_at(&root, input.clone()).unwrap();
        let applied = resume_at(&root, &first.id, None).unwrap();
        assert_eq!(applied.status, IngestionStatus::Applied);
        assert!(root.join("generated/alpha/traceability.md").is_file());

        fs::write(source.join("README.md"), "second snapshot").unwrap();
        let changed = start_at(&root, input).unwrap();
        assert_ne!(changed.id, first.id);
        assert_ne!(changed.key, first.key);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(source).unwrap();
    }
}
