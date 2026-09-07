use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const SCHEMA_FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct VaultSchema {
    pub schema_format_version: u32,
    pub id: String,
    pub revision: u32,
    pub types: Vec<ArtifactTypeDefinition>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ArtifactTypeDefinition {
    pub id: String,
    pub label: String,
    pub storage: StorageDefinition,
    pub fields: Vec<FieldDefinition>,
    pub required_field_ids: Vec<String>,
    pub body: BodyDefinition,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct StorageDefinition {
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct FieldDefinition {
    pub id: String,
    pub key: String,
    pub label: String,
    pub value_schema: Value,
    /// Previous frontmatter keys that can be deterministically renamed.
    pub aliases: Vec<String>,
    /// An explicit default may be inserted; unknown values are never invented.
    pub default_value: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct BodyDefinition {
    pub template_ref: Option<String>,
    pub required_section_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiagnostic {
    pub severity: Severity,
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SchemaValidationReport {
    pub valid: bool,
    pub diagnostics: Vec<SchemaDiagnostic>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ScannedArtifact {
    pub path: String,
    pub id: String,
    pub type_id: String,
    pub schema_revision: Option<u32>,
    pub project_id: Option<String>,
    pub expected_path: Option<String>,
    pub content_hash: String,
    pub diagnostics: Vec<SchemaDiagnostic>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaScanResult {
    pub schema_id: String,
    pub schema_revision: u32,
    pub scanned_files: u64,
    pub managed_artifacts: Vec<ScannedArtifact>,
    pub unmanaged_markdown: Vec<String>,
    pub diagnostics: Vec<SchemaDiagnostic>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaMoveProposal {
    pub artifact_id: String,
    pub type_id: String,
    pub source: String,
    pub target: String,
    pub expected_source_hash: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaMigrationPlan {
    pub schema_id: String,
    pub schema_revision: u32,
    pub moves: Vec<SchemaMoveProposal>,
    pub rewrites: Vec<SchemaRewriteProposal>,
    pub conflicts: Vec<SchemaDiagnostic>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaRewriteProposal {
    pub artifact_id: Option<String>,
    pub source: String,
    pub target: String,
    pub expected_source_hash: String,
    pub content: String,
    pub field_changes: u32,
    pub link_changes: u32,
    pub reason: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaDraftRecord {
    pub draft_id: String,
    pub schema: VaultSchema,
    pub validation: SchemaValidationReport,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SchemaDraftSaveInput {
    pub draft_id: String,
    pub schema: VaultSchema,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ActiveSchemaState {
    pub id: String,
    pub revision: u32,
}

fn id_valid(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
}

fn diagnostic(
    list: &mut Vec<SchemaDiagnostic>,
    severity: Severity,
    code: &str,
    path: impl Into<String>,
    message: impl Into<String>,
) {
    list.push(SchemaDiagnostic {
        severity,
        code: code.into(),
        path: path.into(),
        message: message.into(),
    });
}

fn validate_storage_path(path: &str) -> Result<(), &'static str> {
    if path.is_empty() || path.starts_with('/') || path.starts_with('\\') || !path.ends_with(".md")
    {
        return Err("storage.path는 .md로 끝나는 볼트 상대경로여야 합니다");
    }
    let mut rendered = path.to_string();
    for placeholder in ["{id}", "{projectId}", "{slug}"] {
        rendered = rendered.replace(placeholder, "value");
    }
    if rendered.contains('{') || rendered.contains('}') {
        return Err("지원하지 않는 storage.path placeholder입니다");
    }
    if rendered
        .split(['/', '\\'])
        .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err("storage.path에 빈 경로, . 또는 ..를 사용할 수 없습니다");
    }
    let parts: Vec<_> = rendered.split(['/', '\\']).collect();
    if parts
        .iter()
        .any(|part| part.starts_with('.') || part.contains(':'))
    {
        return Err("숨김 상태 디렉터리나 절대경로에는 사용자 문서를 둘 수 없습니다");
    }
    let host_record = matches!(parts.first().copied(), Some("calendar" | "runs"))
        || (parts.len() == 3
            && matches!(
                (parts[0], parts[2]),
                ("work", "work.md") | ("projects", "project.md")
            ));
    if host_record {
        return Err(
            "작업·프로젝트·일정·실행 레코드는 앱이 관리합니다. 사용자 문서 경로를 지정하세요",
        );
    }
    Ok(())
}

fn validate_value_schema(schema: &Value) -> Result<(), String> {
    let object = schema
        .as_object()
        .ok_or_else(|| "valueSchema는 JSON object여야 합니다".to_string())?;
    if let Some(value_type) = object.get("type") {
        let Some(value_type) = value_type.as_str() else {
            return Err("valueSchema.type은 문자열이어야 합니다".into());
        };
        if ![
            "string", "number", "integer", "boolean", "array", "object", "null",
        ]
        .contains(&value_type)
        {
            return Err(format!(
                "지원하지 않는 valueSchema.type입니다: {value_type}"
            ));
        }
    }
    if object
        .get("enum")
        .is_some_and(|enumeration| !enumeration.is_array())
    {
        return Err("valueSchema.enum은 배열이어야 합니다".into());
    }
    for key in ["minLength", "maxLength"] {
        if object
            .get(key)
            .is_some_and(|value| value.as_u64().is_none())
        {
            return Err(format!("valueSchema.{key}은 0 이상의 정수여야 합니다"));
        }
    }
    Ok(())
}

pub fn validate(schema: &VaultSchema) -> SchemaValidationReport {
    let mut diagnostics = Vec::new();
    if schema.schema_format_version != SCHEMA_FORMAT_VERSION {
        diagnostic(
            &mut diagnostics,
            Severity::Error,
            "schema-format-version",
            "schemaFormatVersion",
            format!(
                "지원하지 않는 schemaFormatVersion입니다: {}",
                schema.schema_format_version
            ),
        );
    }
    if !id_valid(&schema.id) {
        diagnostic(
            &mut diagnostics,
            Severity::Error,
            "invalid-schema-id",
            "id",
            "schema id가 유효하지 않습니다",
        );
    }
    if schema.revision == 0 {
        diagnostic(
            &mut diagnostics,
            Severity::Error,
            "invalid-revision",
            "revision",
            "공개 schema revision은 1 이상이어야 합니다",
        );
    }
    let mut type_ids = HashSet::new();
    let mut storage_paths = HashSet::new();
    for (type_index, artifact_type) in schema.types.iter().enumerate() {
        let base = format!("types[{type_index}]");
        if !id_valid(&artifact_type.id) || !type_ids.insert(artifact_type.id.as_str()) {
            diagnostic(
                &mut diagnostics,
                Severity::Error,
                "invalid-type-id",
                format!("{base}.id"),
                "type id가 유효하고 중복되지 않아야 합니다",
            );
        }
        if artifact_type.label.trim().is_empty() {
            diagnostic(
                &mut diagnostics,
                Severity::Error,
                "missing-type-label",
                format!("{base}.label"),
                "type 표시 이름이 필요합니다",
            );
        }
        if let Err(message) = validate_storage_path(&artifact_type.storage.path) {
            diagnostic(
                &mut diagnostics,
                Severity::Error,
                "invalid-storage-path",
                format!("{base}.storage.path"),
                message,
            );
        } else if !storage_paths.insert(artifact_type.storage.path.as_str()) {
            diagnostic(
                &mut diagnostics,
                Severity::Error,
                "duplicate-storage-path",
                format!("{base}.storage.path"),
                "두 문서 type이 같은 storage pattern을 사용할 수 없습니다",
            );
        }
        let mut field_ids = HashSet::new();
        let mut field_keys = HashSet::new();
        let mut field_aliases = HashSet::new();
        for (field_index, field) in artifact_type.fields.iter().enumerate() {
            let path = format!("{base}.fields[{field_index}]");
            if !id_valid(&field.id) || !field_ids.insert(field.id.as_str()) {
                diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    "invalid-field-id",
                    format!("{path}.id"),
                    "field id가 유효하고 중복되지 않아야 합니다",
                );
            }
            if field.key.trim().is_empty()
                || field.key.contains(['\n', '\r', ':'])
                || !field_keys.insert(field.key.as_str())
            {
                diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    "invalid-field-key",
                    format!("{path}.key"),
                    "frontmatter key가 안전하고 중복되지 않아야 합니다",
                );
            }
            if let Err(message) = validate_value_schema(&field.value_schema) {
                diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    "invalid-value-schema",
                    format!("{path}.valueSchema"),
                    message,
                );
            }
            for alias in &field.aliases {
                if alias.trim().is_empty()
                    || alias.contains(['\n', '\r', ':'])
                    || alias == &field.key
                    || !field_aliases.insert(alias.as_str())
                    || field_keys.contains(alias.as_str())
                {
                    diagnostic(
                        &mut diagnostics,
                        Severity::Error,
                        "invalid-field-alias",
                        format!("{path}.aliases"),
                        "field alias는 안전하고 현재 key 및 다른 alias와 겹치지 않아야 합니다",
                    );
                }
            }
            if let Some(default_value) = &field.default_value {
                if !value_matches(&field.value_schema, default_value) {
                    diagnostic(
                        &mut diagnostics,
                        Severity::Error,
                        "invalid-field-default",
                        format!("{path}.defaultValue"),
                        "명시한 기본값이 valueSchema와 맞지 않습니다",
                    );
                }
            }
        }
        for (field_index, field) in artifact_type.fields.iter().enumerate() {
            for alias in &field.aliases {
                if field_keys.contains(alias.as_str()) {
                    diagnostic(
                        &mut diagnostics,
                        Severity::Error,
                        "field-alias-collision",
                        format!("{base}.fields[{field_index}].aliases"),
                        format!("alias가 현재 frontmatter key와 겹칩니다: {alias}"),
                    );
                }
            }
        }
        for required in &artifact_type.required_field_ids {
            if !field_ids.contains(required.as_str()) {
                diagnostic(
                    &mut diagnostics,
                    Severity::Error,
                    "unknown-required-field",
                    format!("{base}.requiredFieldIds"),
                    format!("정의되지 않은 required field입니다: {required}"),
                );
            }
        }
    }
    SchemaValidationReport {
        valid: !diagnostics
            .iter()
            .any(|entry| entry.severity == Severity::Error),
        diagnostics,
    }
}

fn frontmatter(markdown: &str) -> Result<serde_yaml::Mapping, String> {
    let rest = markdown
        .strip_prefix("---\n")
        .or_else(|| markdown.strip_prefix("---\r\n"))
        .ok_or_else(|| "YAML frontmatter가 없습니다".to_string())?;
    let (yaml, _) = rest
        .split_once("\n---\n")
        .or_else(|| rest.split_once("\r\n---\r\n"))
        .ok_or_else(|| "YAML frontmatter 끝 표식이 없습니다".to_string())?;
    serde_yaml::from_str(yaml).map_err(|error| format!("frontmatter 파싱 실패: {error}"))
}

fn yaml_string(mapping: &serde_yaml::Mapping, key: &str) -> Option<String> {
    mapping
        .get(serde_yaml::Value::String(key.into()))
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_string)
}

fn yaml_u32(mapping: &serde_yaml::Mapping, key: &str) -> Option<u32> {
    mapping
        .get(serde_yaml::Value::String(key.into()))
        .and_then(serde_yaml::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn markdown_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(directory).map_err(|error| format!("볼트 스캔 실패: {error}"))?
        {
            let entry = entry.map_err(|error| format!("볼트 항목 스캔 실패: {error}"))?;
            let file_type = entry
                .file_type()
                .map_err(|error| format!("볼트 항목 종류 확인 실패: {error}"))?;
            let path = entry.path();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                visit(root, &path, output)?;
            } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
                output.push(path);
            }
        }
        Ok(())
    }
    let mut output = Vec::new();
    visit(root, root, &mut output)?;
    output.sort();
    Ok(output)
}

fn safe_component(value: &str) -> Result<&str, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || !matches!(path.components().next(), Some(Component::Normal(_)))
    {
        Err(format!("경로 placeholder 값이 안전하지 않습니다: {value}"))
    } else {
        Ok(value)
    }
}

fn expected_path(
    artifact_type: &ArtifactTypeDefinition,
    id: &str,
    project_id: Option<&str>,
    slug: Option<&str>,
) -> Result<String, String> {
    let mut path = artifact_type.storage.path.clone();
    path = path.replace("{id}", safe_component(id)?);
    if path.contains("{projectId}") {
        path = path.replace(
            "{projectId}",
            safe_component(project_id.ok_or("projectId가 필요합니다")?)?,
        );
    }
    if path.contains("{slug}") {
        path = path.replace("{slug}", safe_component(slug.unwrap_or(id))?);
    }
    validate_storage_path(&path).map_err(str::to_string)?;
    Ok(path.replace('\\', "/"))
}

fn value_matches(schema: &Value, value: &Value) -> bool {
    let Some(object) = schema.as_object() else {
        return false;
    };
    if let Some(enumeration) = object.get("enum").and_then(Value::as_array) {
        if !enumeration.contains(value) {
            return false;
        }
    }
    if let Some(value_type) = object.get("type").and_then(Value::as_str) {
        let matches = match value_type {
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
            "boolean" => value.is_boolean(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            "null" => value.is_null(),
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    if let Some(text) = value.as_str() {
        if object
            .get("minLength")
            .and_then(Value::as_u64)
            .is_some_and(|minimum| text.chars().count() < minimum as usize)
        {
            return false;
        }
        if object
            .get("maxLength")
            .and_then(Value::as_u64)
            .is_some_and(|maximum| text.chars().count() > maximum as usize)
        {
            return false;
        }
    }
    true
}

pub fn scan(root: &Path, schema: &VaultSchema) -> Result<SchemaScanResult, String> {
    let report = validate(schema);
    if !report.valid {
        return Err(format!(
            "schema가 유효하지 않습니다: {:?}",
            report.diagnostics
        ));
    }
    let type_map: HashMap<_, _> = schema
        .types
        .iter()
        .map(|artifact_type| (artifact_type.id.as_str(), artifact_type))
        .collect();
    let paths = markdown_paths(root)?;
    let mut result = SchemaScanResult {
        schema_id: schema.id.clone(),
        schema_revision: schema.revision,
        scanned_files: paths.len() as u64,
        ..Default::default()
    };
    let mut document_ids: HashSet<String> = HashSet::new();
    for path in paths {
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let markdown = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(error) => {
                diagnostic(
                    &mut result.diagnostics,
                    Severity::Error,
                    "read-failed",
                    relative,
                    error.to_string(),
                );
                continue;
            }
        };
        let mapping = match frontmatter(&markdown) {
            Ok(mapping) => mapping,
            Err(_) => {
                result.unmanaged_markdown.push(relative);
                continue;
            }
        };
        let Some(type_id) = yaml_string(&mapping, "typeId") else {
            result.unmanaged_markdown.push(relative);
            continue;
        };
        let id = yaml_string(&mapping, "id").unwrap_or_default();
        let project_id = yaml_string(&mapping, "projectId");
        let slug = yaml_string(&mapping, "slug");
        let mut artifact = ScannedArtifact {
            path: relative.clone(),
            id: id.clone(),
            type_id: type_id.clone(),
            schema_revision: yaml_u32(&mapping, "schemaRevision"),
            project_id: project_id.clone(),
            content_hash: hex::encode(Sha256::digest(markdown.as_bytes())),
            ..Default::default()
        };
        if !id_valid(&id) {
            diagnostic(
                &mut artifact.diagnostics,
                Severity::Error,
                "invalid-document-id",
                &relative,
                "관리 문서에는 유효한 id가 필요합니다",
            );
        } else if !document_ids.insert(id.clone()) {
            diagnostic(
                &mut artifact.diagnostics,
                Severity::Error,
                "duplicate-document-id",
                &relative,
                format!("중복 문서 id입니다: {id}"),
            );
        }
        let Some(artifact_type) = type_map.get(type_id.as_str()) else {
            diagnostic(
                &mut artifact.diagnostics,
                Severity::Error,
                "unknown-type",
                &relative,
                format!("schema에 없는 typeId입니다: {type_id}"),
            );
            result.managed_artifacts.push(artifact);
            continue;
        };
        match expected_path(artifact_type, &id, project_id.as_deref(), slug.as_deref()) {
            Ok(expected) => {
                if expected != relative {
                    diagnostic(
                        &mut artifact.diagnostics,
                        Severity::Warning,
                        "path-mismatch",
                        &relative,
                        format!("schema 경로는 {expected}입니다"),
                    );
                }
                artifact.expected_path = Some(expected);
            }
            Err(error) => diagnostic(
                &mut artifact.diagnostics,
                Severity::Error,
                "path-resolution",
                &relative,
                error,
            ),
        }
        let fields: HashMap<_, _> = artifact_type
            .fields
            .iter()
            .map(|field| (field.id.as_str(), field))
            .collect();
        for required in &artifact_type.required_field_ids {
            let field = fields
                .get(required.as_str())
                .expect("validated required field");
            if !mapping.contains_key(serde_yaml::Value::String(field.key.clone())) {
                let has_alias = field
                    .aliases
                    .iter()
                    .any(|alias| mapping.contains_key(serde_yaml::Value::String(alias.clone())));
                if has_alias || field.default_value.is_some() {
                    diagnostic(
                        &mut artifact.diagnostics,
                        Severity::Warning,
                        "migratable-required-field",
                        &relative,
                        format!(
                            "필수 field를 명시된 alias/default로 변환합니다: {}",
                            field.key
                        ),
                    );
                } else {
                    diagnostic(
                        &mut artifact.diagnostics,
                        Severity::Error,
                        "missing-required-field",
                        &relative,
                        format!("필수 field가 없습니다: {} ({})", field.label, field.key),
                    );
                }
            }
        }
        for field in &artifact_type.fields {
            if let Some(value) = mapping.get(serde_yaml::Value::String(field.key.clone())) {
                let json_value = serde_json::to_value(value).unwrap_or(Value::Null);
                if !value_matches(&field.value_schema, &json_value) {
                    diagnostic(
                        &mut artifact.diagnostics,
                        Severity::Error,
                        "invalid-field-value",
                        &relative,
                        format!("field 값이 valueSchema와 맞지 않습니다: {}", field.key),
                    );
                }
            }
        }
        result.managed_artifacts.push(artifact);
    }
    result.diagnostics.extend(
        result
            .managed_artifacts
            .iter()
            .flat_map(|artifact| artifact.diagnostics.clone()),
    );
    Ok(result)
}

pub fn plan(scan: &SchemaScanResult) -> SchemaMigrationPlan {
    let mut plan = SchemaMigrationPlan {
        schema_id: scan.schema_id.clone(),
        schema_revision: scan.schema_revision,
        ..Default::default()
    };
    let current_paths: HashSet<_> = scan
        .managed_artifacts
        .iter()
        .map(|artifact| artifact.path.as_str())
        .collect();
    let mut targets = HashSet::new();
    for artifact in &scan.managed_artifacts {
        for issue in artifact
            .diagnostics
            .iter()
            .filter(|issue| issue.severity == Severity::Error)
        {
            plan.conflicts.push(issue.clone());
        }
        let Some(target) = artifact.expected_path.as_deref() else {
            continue;
        };
        if target == artifact.path {
            continue;
        }
        if current_paths.contains(target) || !targets.insert(target) {
            diagnostic(
                &mut plan.conflicts,
                Severity::Error,
                "target-collision",
                target,
                "둘 이상의 문서가 같은 대상 경로를 사용하거나 대상이 이미 있습니다",
            );
            continue;
        }
        plan.moves.push(SchemaMoveProposal {
            artifact_id: artifact.id.clone(),
            type_id: artifact.type_id.clone(),
            source: artifact.path.clone(),
            target: target.into(),
            expected_source_hash: artifact.content_hash.clone(),
            reason: format!(
                "schema {} revision {} storage.path 적용",
                scan.schema_id, scan.schema_revision
            ),
        });
    }
    plan
}

fn frontmatter_parts(markdown: &str) -> Result<(serde_yaml::Mapping, &str), String> {
    let (offset, rest) = if let Some(rest) = markdown.strip_prefix("---\n") {
        (4, rest)
    } else if let Some(rest) = markdown.strip_prefix("---\r\n") {
        (5, rest)
    } else {
        return Err("YAML frontmatter가 없습니다".into());
    };
    let (yaml_len, delimiter_len) = if let Some(index) = rest.find("\n---\n") {
        (index, 5)
    } else if let Some(index) = rest.find("\r\n---\r\n") {
        (index, 8)
    } else {
        return Err("YAML frontmatter 끝 표식이 없습니다".into());
    };
    let mapping = serde_yaml::from_str(&rest[..yaml_len])
        .map_err(|error| format!("frontmatter 파싱 실패: {error}"))?;
    let body_start = offset + yaml_len + delimiter_len;
    Ok((mapping, &markdown[body_start..]))
}

fn migrate_frontmatter(
    markdown: &str,
    artifact_type: &ArtifactTypeDefinition,
    revision: u32,
) -> Result<(String, u32), String> {
    let (mut mapping, body) = frontmatter_parts(markdown)?;
    let mut changes = 0;
    for field in &artifact_type.fields {
        let target = serde_yaml::Value::String(field.key.clone());
        if mapping.contains_key(&target) {
            continue;
        }
        let mut migrated = None;
        for alias in &field.aliases {
            if let Some(value) = mapping.remove(serde_yaml::Value::String(alias.clone())) {
                migrated = Some(value);
                break;
            }
        }
        if migrated.is_none() {
            migrated = field
                .default_value
                .as_ref()
                .map(serde_yaml::to_value)
                .transpose()
                .map_err(|error| format!("field 기본값 변환 실패: {error}"))?;
        }
        if let Some(value) = migrated {
            mapping.insert(target, value);
            changes += 1;
        }
    }
    let revision_key = serde_yaml::Value::String("schemaRevision".into());
    let revision_value = serde_yaml::Value::Number(revision.into());
    if mapping.get(&revision_key) != Some(&revision_value) {
        mapping.insert(revision_key, revision_value);
        changes += 1;
    }
    if changes == 0 {
        return Ok((markdown.into(), 0));
    }
    let yaml = serde_yaml::to_string(&mapping)
        .map_err(|error| format!("frontmatter 직렬화 실패: {error}"))?;
    Ok((
        format!("---\n{}---\n{}", yaml.trim_start_matches("---\n"), body),
        changes,
    ))
}

fn occurrence_count(haystack: &str, needle: &str) -> u32 {
    if needle.is_empty() {
        0
    } else {
        haystack.match_indices(needle).count() as u32
    }
}

fn rewrite_links(markdown: &str, moves: &[(String, String)]) -> (String, u32) {
    let mut output = markdown.to_string();
    let mut replacements = Vec::new();
    for (index, (source, target)) in moves.iter().enumerate() {
        let old_stem = source.strip_suffix(".md").unwrap_or(source);
        let new_stem = target.strip_suffix(".md").unwrap_or(target);
        for (pattern_index, (from, to)) in [
            (format!("[[{source}]]"), format!("[[{target}]]")),
            (format!("[[{old_stem}]]"), format!("[[{new_stem}]]")),
            (format!("]({source})"), format!("]({target})")),
            (format!("](<{source}>)"), format!("](<{target}>)")),
        ]
        .into_iter()
        .enumerate()
        {
            let count = occurrence_count(&output, &from);
            if count == 0 {
                continue;
            }
            let marker = format!(
                "__SAWHORSE_LINK_{index}_{pattern_index}_{}__",
                Uuid::new_v4()
            );
            output = output.replace(&from, &marker);
            replacements.push((marker, to, count));
        }
    }
    let mut changed = 0;
    for (marker, value, count) in replacements {
        output = output.replace(&marker, &value);
        changed += count;
    }
    (output, changed)
}

pub fn plan_at(
    root: &Path,
    schema: &VaultSchema,
    scan: &SchemaScanResult,
) -> Result<SchemaMigrationPlan, String> {
    let report = validate(schema);
    if !report.valid {
        return Err("유효하지 않은 schema로 변경 계획을 만들 수 없습니다".into());
    }
    if scan.schema_id != schema.id || scan.schema_revision != schema.revision {
        return Err("scan 결과와 schema revision이 다릅니다".into());
    }
    let mut result = plan(scan);
    let move_pairs = result
        .moves
        .iter()
        .map(|proposal| (proposal.source.clone(), proposal.target.clone()))
        .collect::<Vec<_>>();
    let move_targets = move_pairs.iter().cloned().collect::<HashMap<_, _>>();
    let managed = scan
        .managed_artifacts
        .iter()
        .map(|artifact| (artifact.path.as_str(), artifact))
        .collect::<HashMap<_, _>>();
    let types = schema
        .types
        .iter()
        .map(|artifact_type| (artifact_type.id.as_str(), artifact_type))
        .collect::<HashMap<_, _>>();
    for path in markdown_paths(root)? {
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        let original = fs::read_to_string(&path)
            .map_err(|error| format!("migration source 읽기 실패: {error}"))?;
        let mut content = original.clone();
        let mut field_changes = 0;
        let artifact_id = managed
            .get(relative.as_str())
            .map(|artifact| artifact.id.clone());
        if let Some(artifact) = managed.get(relative.as_str()) {
            if let Some(artifact_type) = types.get(artifact.type_id.as_str()) {
                let migrated = migrate_frontmatter(&content, artifact_type, schema.revision)?;
                content = migrated.0;
                field_changes = migrated.1;
            }
        }
        let rewritten = rewrite_links(&content, &move_pairs);
        content = rewritten.0;
        let link_changes = rewritten.1;
        if content == original {
            continue;
        }
        result.rewrites.push(SchemaRewriteProposal {
            artifact_id,
            source: relative.clone(),
            target: move_targets
                .get(&relative)
                .cloned()
                .unwrap_or_else(|| relative.clone()),
            expected_source_hash: hex::encode(Sha256::digest(original.as_bytes())),
            content,
            field_changes,
            link_changes,
            reason: format!(
                "schema {} revision {} field/link migration",
                schema.id, schema.revision
            ),
        });
    }
    Ok(result)
}

pub fn changeset_for_plan(
    root: &Path,
    plan: &SchemaMigrationPlan,
) -> Result<crate::changes::ChangeSet, String> {
    if !plan.conflicts.is_empty() {
        return Err("충돌이 있는 schema migration plan은 ChangeSet으로 만들 수 없습니다".into());
    }

    let mut operations = Vec::with_capacity(plan.moves.len());
    for proposal in &plan.moves {
        let current_hash = crate::changes::guarded_file_hash(root, &proposal.source)?;
        if current_hash != proposal.expected_source_hash {
            return Err(format!(
                "schema scan 이후 source가 변경되었습니다: {}",
                proposal.source
            ));
        }
        operations.push(crate::changes::ChangeOperationInput {
            kind: Some(crate::changes::ChangeKind::Move),
            source: Some(proposal.source.clone()),
            target: proposal.target.clone(),
            content: plan
                .rewrites
                .iter()
                .find(|rewrite| rewrite.source == proposal.source)
                .map(|rewrite| rewrite.content.clone()),
            reason: proposal.reason.clone(),
        });
    }
    for proposal in &plan.rewrites {
        if plan
            .moves
            .iter()
            .any(|movement| movement.source == proposal.source)
        {
            continue;
        }
        let current_hash = crate::changes::guarded_file_hash(root, &proposal.source)?;
        if current_hash != proposal.expected_source_hash {
            return Err(format!(
                "schema scan 이후 source가 변경되었습니다: {}",
                proposal.source
            ));
        }
        operations.push(crate::changes::ChangeOperationInput {
            kind: Some(crate::changes::ChangeKind::Write),
            source: None,
            target: proposal.target.clone(),
            content: Some(proposal.content.clone()),
            reason: proposal.reason.clone(),
        });
    }

    if operations.is_empty() {
        return Err("적용할 schema 변경이 없습니다".into());
    }

    crate::changes::preview(root, crate::changes::ChangeSetPreviewInput { operations })
}

fn valid_storage_key(value: &str) -> bool {
    id_valid(value)
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "schema 저장 경로가 잘못되었습니다".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("schema 폴더 생성 실패: {error}"))?;
    let temporary = parent.join(format!(".{}.tmp", Uuid::new_v4()));
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|error| format!("schema 직렬화 실패: {error}"))?;
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("schema 임시 파일 생성 실패: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("schema 임시 파일 쓰기 실패: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("schema 임시 파일 동기화 실패: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("schema 파일 교체 실패: {error}")
    })
}

fn schema_path(root: &Path, id: &str, revision: u32) -> Result<PathBuf, String> {
    if !valid_storage_key(id) || revision == 0 {
        return Err("유효하지 않은 schema id/revision입니다".into());
    }
    Ok(root
        .join(".sawhorse")
        .join("schemas")
        .join(id)
        .join(format!("{revision}.json")))
}

fn draft_path(root: &Path, draft_id: &str) -> Result<PathBuf, String> {
    if !valid_storage_key(draft_id) {
        return Err("유효하지 않은 schema draft ID입니다".into());
    }
    Ok(root
        .join(".sawhorse")
        .join("drafts")
        .join("schemas")
        .join(format!("{draft_id}.json")))
}

pub fn save_draft_at(
    root: &Path,
    input: SchemaDraftSaveInput,
) -> Result<SchemaDraftRecord, String> {
    let record = SchemaDraftRecord {
        draft_id: input.draft_id,
        validation: validate(&input.schema),
        schema: input.schema,
        updated_at: Utc::now().to_rfc3339(),
    };
    write_json_atomic(&draft_path(root, &record.draft_id)?, &record)?;
    Ok(record)
}

pub fn list_drafts_at(root: &Path) -> Result<Vec<SchemaDraftRecord>, String> {
    let directory = root.join(".sawhorse").join("drafts").join("schemas");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = fs::read_dir(directory)
        .map_err(|error| format!("schema draft 목록 실패: {error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    let mut records = Vec::new();
    for path in paths {
        let mut record: SchemaDraftRecord = serde_json::from_slice(
            &fs::read(path).map_err(|error| format!("schema draft 읽기 실패: {error}"))?,
        )
        .map_err(|error| format!("schema draft 파싱 실패: {error}"))?;
        record.validation = validate(&record.schema);
        records.push(record);
    }
    records.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(records)
}

pub fn publish_at(root: &Path, schema: VaultSchema) -> Result<VaultSchema, String> {
    let report = validate(&schema);
    if !report.valid {
        return Err(format!(
            "유효하지 않은 schema는 발행할 수 없습니다: {:?}",
            report.diagnostics
        ));
    }
    let path = schema_path(root, &schema.id, schema.revision)?;
    if path.exists() {
        let existing: VaultSchema = serde_json::from_slice(
            &fs::read(&path).map_err(|error| format!("schema 읽기 실패: {error}"))?,
        )
        .map_err(|error| format!("schema 파싱 실패: {error}"))?;
        if existing == schema {
            return Ok(schema);
        }
        return Err(format!(
            "이미 발행된 schema {} revision {}은 바꿀 수 없습니다",
            schema.id, schema.revision
        ));
    }
    write_json_atomic(&path, &schema)?;
    Ok(schema)
}

pub fn catalog_at(root: &Path) -> Result<Vec<VaultSchema>, String> {
    let directory = root.join(".sawhorse").join("schemas");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for package in fs::read_dir(directory).map_err(|error| format!("schema 목록 실패: {error}"))?
    {
        let package = package.map_err(|error| format!("schema 목록 항목 실패: {error}"))?;
        if !package.path().is_dir() {
            continue;
        }
        for item in fs::read_dir(package.path())
            .map_err(|error| format!("schema revision 목록 실패: {error}"))?
        {
            let path = item
                .map_err(|error| format!("schema revision 항목 실패: {error}"))?
                .path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                paths.push(path);
            }
        }
    }
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let schema: VaultSchema = serde_json::from_slice(
                &fs::read(path).map_err(|error| format!("schema 읽기 실패: {error}"))?,
            )
            .map_err(|error| format!("schema 파싱 실패: {error}"))?;
            if !validate(&schema).valid {
                return Err("저장된 schema가 유효하지 않습니다".into());
            }
            Ok(schema)
        })
        .collect()
}

fn workspace_path(root: &Path) -> PathBuf {
    root.join(".sawhorse").join("workspace.json")
}

pub fn active_schema_at(root: &Path) -> Result<Option<ActiveSchemaState>, String> {
    let path = workspace_path(root);
    if !path.is_file() {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(
        &fs::read(path).map_err(|error| format!("workspace 상태 읽기 실패: {error}"))?,
    )
    .map_err(|error| format!("workspace 상태 파싱 실패: {error}"))?;
    value
        .get("activeSchema")
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("활성 schema 상태 파싱 실패: {error}"))
}

pub fn activate_at(
    root: &Path,
    schema: &VaultSchema,
    change_set_id: Option<&str>,
) -> Result<ActiveSchemaState, String> {
    let published = schema_path(root, &schema.id, schema.revision)?;
    if !published.is_file() {
        return Err("schema를 먼저 불변 revision으로 발행하세요".into());
    }
    if let Some(id) = change_set_id {
        let set = crate::changes::get(root, id)?;
        if set.status != crate::changes::ChangeSetStatus::Applied {
            return Err("완전히 적용된 ChangeSet만 schema 활성화에 사용할 수 있습니다".into());
        }
    }
    let scanned = scan(root, schema)?;
    if scanned
        .diagnostics
        .iter()
        .any(|issue| issue.severity == Severity::Error)
        || scanned
            .managed_artifacts
            .iter()
            .any(|artifact| artifact.expected_path.as_deref() != Some(artifact.path.as_str()))
    {
        return Err("전체 볼트 검증이 끝나지 않아 schema 활성 포인터를 바꾸지 않았습니다".into());
    }
    let state = ActiveSchemaState {
        id: schema.id.clone(),
        revision: schema.revision,
    };
    let path = workspace_path(root);
    let mut workspace: Value = if path.is_file() {
        serde_json::from_slice(
            &fs::read(&path).map_err(|error| format!("workspace 상태 읽기 실패: {error}"))?,
        )
        .map_err(|error| format!("workspace 상태 파싱 실패: {error}"))?
    } else {
        serde_json::json!({"formatVersion": 1})
    };
    let object = workspace
        .as_object_mut()
        .ok_or_else(|| "workspace.json 최상위 값은 object여야 합니다".to_string())?;
    object.insert(
        "activeSchema".into(),
        serde_json::to_value(&state).map_err(|error| error.to_string())?,
    );
    object.insert("schemaMaintenance".into(), Value::Bool(false));
    write_json_atomic(&path, &workspace)?;
    Ok(state)
}

#[tauri::command]
pub fn schema_validate(schema: VaultSchema) -> SchemaValidationReport {
    validate(&schema)
}

#[tauri::command]
pub fn schema_scan(schema: VaultSchema) -> Result<SchemaScanResult, String> {
    let root = crate::sdlc::vault_root()?;
    scan(&root, &schema)
}

#[tauri::command]
pub fn schema_plan(
    schema: VaultSchema,
    scan: SchemaScanResult,
) -> Result<SchemaMigrationPlan, String> {
    plan_at(&crate::sdlc::vault_root()?, &schema, &scan)
}

#[tauri::command]
pub fn schema_changeset_preview(
    plan: SchemaMigrationPlan,
) -> Result<crate::changes::ChangeSet, String> {
    let root = crate::sdlc::vault_root()?;
    changeset_for_plan(&root, &plan)
}

#[tauri::command]
pub fn schema_catalog() -> Result<Vec<VaultSchema>, String> {
    catalog_at(&crate::sdlc::vault_root()?)
}

#[tauri::command]
pub fn schema_draft_list() -> Result<Vec<SchemaDraftRecord>, String> {
    list_drafts_at(&crate::sdlc::vault_root()?)
}

#[tauri::command]
pub fn schema_draft_save(input: SchemaDraftSaveInput) -> Result<SchemaDraftRecord, String> {
    save_draft_at(&crate::sdlc::vault_root()?, input)
}

#[tauri::command]
pub fn schema_publish(schema: VaultSchema) -> Result<VaultSchema, String> {
    publish_at(&crate::sdlc::vault_root()?, schema)
}

#[tauri::command]
pub fn schema_activate(
    schema: VaultSchema,
    change_set_id: Option<String>,
) -> Result<ActiveSchemaState, String> {
    activate_at(
        &crate::sdlc::vault_root()?,
        &schema,
        change_set_id.as_deref(),
    )
}

#[tauri::command]
pub fn schema_active() -> Result<Option<ActiveSchemaState>, String> {
    active_schema_at(&crate::sdlc::vault_root()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn schema() -> VaultSchema {
        VaultSchema {
            schema_format_version: 1,
            id: "team-vault".into(),
            revision: 3,
            types: vec![ArtifactTypeDefinition {
                id: "team-vault.issue".into(),
                label: "요청".into(),
                storage: StorageDefinition {
                    path: "projects/{projectId}/issues/{id}.md".into(),
                },
                fields: vec![
                    FieldDefinition {
                        id: "title".into(),
                        key: "title".into(),
                        label: "제목".into(),
                        value_schema: serde_json::json!({"type":"string","minLength":1}),
                        ..Default::default()
                    },
                    FieldDefinition {
                        id: "status".into(),
                        key: "진행상태".into(),
                        label: "상태".into(),
                        value_schema: serde_json::json!({"enum":["접수","진행","완료"]}),
                        ..Default::default()
                    },
                ],
                required_field_ids: vec!["title".into(), "status".into()],
                ..Default::default()
            }],
        }
    }

    fn tempdir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("sawhorse-schema-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn validates_stable_ids_keys_and_storage_boundaries() {
        assert!(validate(&schema()).valid);
        let mut invalid = schema();
        invalid.types[0].storage.path = ".sawhorse/runtime.sqlite".into();
        invalid.types[0].required_field_ids.push("missing".into());
        let report = validate(&invalid);
        assert!(!report.valid);
        assert!(report
            .diagnostics
            .iter()
            .any(|entry| entry.code == "invalid-storage-path"));
        assert!(report
            .diagnostics
            .iter()
            .any(|entry| entry.code == "unknown-required-field"));
    }

    #[test]
    fn user_schema_cannot_replace_host_records_or_hidden_state() {
        for path in [
            "work/{id}/work.md",
            "projects/{id}/project.md",
            "calendar/{id}.md",
            "runs/{id}.md",
            ".sawhorse/record.md",
            ".git/record.md",
            r".sawhorse\record.md",
            r"C:\record.md",
        ] {
            let mut candidate = schema();
            candidate.types[0].storage.path = path.into();
            assert!(!validate(&candidate).valid, "{path}");
        }
        let mut candidate = schema();
        candidate.types[0].storage.path = "문서/{id}.md".into();
        assert!(validate(&candidate).valid);
    }

    #[test]
    fn schema_scan_does_not_read_hidden_state_as_documents() {
        let root = tempdir();
        for dir in [".git", ".obsidian", ".trash", ".sawhorse"] {
            fs::create_dir_all(root.join(dir)).unwrap();
            fs::write(
                root.join(dir).join("state.md"),
                "---\nid: hidden\ntypeId: unknown\n---\n",
            )
            .unwrap();
        }
        fs::write(root.join("visible.md"), "# Document\n").unwrap();
        let result = scan(&root, &schema()).unwrap();
        assert_eq!(result.scanned_files, 1);
        assert_eq!(result.unmanaged_markdown, ["visible.md"]);
        assert!(result.diagnostics.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_preserves_unmanaged_markdown_and_plans_only_deterministic_moves() {
        let root = tempdir();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("notes.md"), "# Unmanaged\n").unwrap();
        fs::write(
            root.join("old/issue.md"),
            "---\nid: issue-1\ntypeId: team-vault.issue\nschemaRevision: 2\nprojectId: alpha\ntitle: 로그인 요청\n진행상태: 접수\n---\n\n# 요청\n",
        )
        .unwrap();
        let result = scan(&root, &schema()).unwrap();
        assert_eq!(result.scanned_files, 2);
        assert_eq!(result.unmanaged_markdown, ["notes.md"]);
        assert!(result
            .diagnostics
            .iter()
            .any(|entry| entry.code == "path-mismatch"));
        let migration = plan(&result);
        assert!(migration.conflicts.is_empty());
        assert_eq!(
            migration.moves[0].target,
            "projects/alpha/issues/issue-1.md"
        );
        assert!(
            root.join("old/issue.md").exists(),
            "planning must not mutate the vault"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_required_and_invalid_enum_are_reported_without_inventing_values() {
        let root = tempdir();
        fs::write(
            root.join("issue.md"),
            "---\nid: issue-1\ntypeId: team-vault.issue\nprojectId: alpha\ntitle: ''\n진행상태: 알수없음\n---\n",
        )
        .unwrap();
        let result = scan(&root, &schema()).unwrap();
        assert!(
            result
                .diagnostics
                .iter()
                .filter(|entry| entry.code == "invalid-field-value")
                .count()
                >= 2
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_plan_uses_the_shared_changeset_apply_and_rollback_path() {
        let root = tempdir();
        fs::create_dir_all(root.join(".sawhorse")).unwrap();
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(
            root.join("old/issue.md"),
            "---\nid: issue-1\ntypeId: team-vault.issue\nschemaRevision: 2\nprojectId: alpha\ntitle: 로그인 요청\n진행상태: 접수\n---\n",
        )
        .unwrap();

        let scan = scan(&root, &schema()).unwrap();
        let migration = plan(&scan);
        let set = changeset_for_plan(&root, &migration).unwrap();
        let applied = crate::changes::apply(&root, &set.id).unwrap();
        assert_eq!(applied.status, crate::changes::ChangeSetStatus::Applied);
        assert!(!root.join("old/issue.md").exists());
        assert!(root.join("projects/alpha/issues/issue-1.md").exists());

        let rolled_back = crate::changes::rollback(&root, &set.id).unwrap();
        assert_eq!(
            rolled_back.status,
            crate::changes::ChangeSetStatus::RolledBack
        );
        assert!(root.join("old/issue.md").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_renames_fields_rewrites_links_and_activates_only_after_validation() {
        let root = tempdir();
        fs::create_dir_all(root.join(".sawhorse")).unwrap();
        fs::create_dir_all(root.join("old")).unwrap();
        let mut target = schema();
        target.types[0].fields[1].aliases = vec!["status".into()];
        fs::write(
            root.join("old/issue.md"),
            "---\nid: issue-1\ntypeId: team-vault.issue\nschemaRevision: 2\nprojectId: alpha\ntitle: 로그인 요청\nstatus: 접수\n---\n\n# 요청\n",
        )
        .unwrap();
        fs::write(root.join("index.md"), "[요청](old/issue.md)\n").unwrap();

        let scanned = scan(&root, &target).unwrap();
        let migration = plan_at(&root, &target, &scanned).unwrap();
        assert_eq!(migration.moves.len(), 1);
        assert_eq!(migration.rewrites.len(), 2);
        let set = changeset_for_plan(&root, &migration).unwrap();
        crate::changes::apply(&root, &set.id).unwrap();
        let moved = fs::read_to_string(root.join("projects/alpha/issues/issue-1.md")).unwrap();
        assert!(moved.contains("진행상태: 접수"));
        assert!(!moved.contains("\nstatus:"));
        assert!(fs::read_to_string(root.join("index.md"))
            .unwrap()
            .contains("projects/alpha/issues/issue-1.md"));

        publish_at(&root, target.clone()).unwrap();
        let active = activate_at(&root, &target, Some(&set.id)).unwrap();
        assert_eq!(active.revision, 3);
        assert_eq!(active_schema_at(&root).unwrap(), Some(active));
        fs::remove_dir_all(root).unwrap();
    }
}
