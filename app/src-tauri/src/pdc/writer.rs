//! PDC 작성기 — Stage 2 canonical Writer/Mutator (PDC-2.0 §3.1, §4, §5.4, §10).
//!
//! 새 정문서 생성은 v2(`pdc-document/2`)만 쓴다 — Markdown(`pdc-markdown/1`,
//! 소문자 `.md`)이 기본이고 HTML(`pdc-html/1`)이 1급이다. `.djot` 생성과
//! `pdc-document/1` 봉투 생성은 금지다(§4.4·§14). 기존 v1 문서의 패치 능력은
//! 코퍼스 작성기 사례(v1 metadata-patch·no-op·external-change)를 만족하기 위해
//! 유지되지만, 문서 화면은 v1을 읽기 전용 레거시로 표시한다(`commands`).
//!
//! 모든 쓰기는:
//!
//! 1. 공간 파일 잠금 아래 현재 바이트를 읽고,
//! 2. 편집 시작 시점 다이제스트와 비교해 외부 변경을 막고(§10.3 — 통지 없는
//!    last-writer-wins는 금지다),
//! 3. 결과 바이트가 현재와 같으면(no-op) `updated`조차 올리지 않고 아무것도
//!    쓰지 않으며(§10.1),
//! 4. 메타 전용 패치는 본문 바이트를, 본문 패치는 봉투 철자를 행 단위로 그대로
//!    보존한다(§10.1 — 주석·인용·키 순서·사용자 속성 포함),
//! 5. 결과를 판독기로 재판독해 Valid/LegacyValid임을 확인한 뒤 원자적으로
//!    치환한다.
//!
//! 새 문서 ID는 UUIDv7(§7.1), 타임스탬프는 정칙 밀리초 UTC(§5.1)다. 새 문서는
//! 항상 정칙 키 순서(§5.4)로 직렬화하고, 기존 문서 패치는 대상 키의 줄만
//! 바꾼다. 이 모듈은 새 계약 의미를 정의하지 않는다 — 권위는 외부
//! portable-document-contract 저장소다.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::contract;
use super::envelope::{self, EnvValue, Envelope};
use super::reader;
use super::transport::{self, Outcome};
use super::yamlfront;

/// 생성 가능한 이송 = 바디 프로필 선택(§4.2, §4.3). Djot은 v2 작성기의
/// 생성 대상이 아니다(§4.4).
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    /// 일반 정문서 — Obsidian 호환 Markdown(`pdc-markdown/1`), 소문자 `.md`.
    Markdown,
    /// 서식 있는 정문서 — 원본 보존 HTML(`pdc-html/1`).
    Html,
}

impl TransportKind {
    /// 새 문서 생성용 확장자 선택. `.djot`은 거부된다(§4.4).
    pub fn from_creatable_extension(extension: &str) -> Result<Self, String> {
        match extension {
            "md" => Ok(Self::Markdown),
            "html" => Ok(Self::Html),
            "djot" => Err("pdc-djot/1 문서는 v2 작성기가 만들 수 없다(§4.4)".into()),
            other => Err(format!("pdc-document 이송 확장자가 아니다: {other}")),
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Html => "html",
        }
    }

    /// 봉투 `body` 값(§2 바디 프로필 식별자).
    pub fn profile(self) -> &'static str {
        match self {
            Self::Markdown => contract::TRANSPORT_MARKDOWN,
            Self::Html => contract::TRANSPORT_HTML,
        }
    }

    /// 봉투 직렬화 문양. v1 djot 패치도 `---` 울타리라서 Markdown과 같다.
    fn for_extension(extension: &str) -> Self {
        match extension {
            "html" => Self::Html,
            _ => Self::Markdown,
        }
    }
}

/// 봉투 해석 문법 — 형식 식별자가 고른다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Grammar {
    /// `pdc-document/1` 동결 제약 문법.
    V1,
    /// `pdc-document/2` 안전 YAML 문법.
    V2,
}

/// 정칙 밀리초 UTC 타임스탬프(§5.1 `YYYY-MM-DDTHH:MM:SS.sssZ`).
pub fn now_stamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

// ---------- 봉투 직렬화 ----------

/// v1 한 줄 스칼라 값의 리터럴. 해석기(`envelope::parse_scalar`)와 정확히 반대
/// 사이다: 애매해질 수 있는 값은 두 번 따옴표로 감싸고, 해석기가 그대로
/// 벗겨주므로 왕복이 값 보존이다. 개행·탭은 봉투 값 자체가 될 수 없다.
fn scalar_literal_v1(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r', '\t']) {
        return Err(format!("봉투 값에 줄바꿈·탭이 있을 수 없다: {value:?}"));
    }
    let needs_quotes = value.is_empty()
        || value != value.trim()
        || matches!(value, "true" | "false")
        || value.starts_with(['"', '\'', '[', '&', '*', '!', '?', '>', '|'])
        || value.contains(" #")
        || value.contains(',');
    Ok(if needs_quotes {
        format!("\"{value}\"")
    } else {
        value.to_string()
    })
}

/// v2 안전 YAML 스칼라 리터럴. Core Schema 해석기가 문자열로 읽도록 모호한
/// 철자는 전부 두 따옴표로 감싸고, 안의 따옴표·백슬래시는 벗겨난다
/// (`yamlfront::parse`가 역이행한다).
fn scalar_literal_v2(value: &str) -> Result<String, String> {
    if value.contains(['\n', '\r', '\t']) {
        return Err(format!("봉투 값에 줄바꿈·탭이 있을 수 없다: {value:?}"));
    }
    let plain_ok = !value.is_empty()
        && value == value.trim()
        && !matches!(
            value,
            "true" | "True" | "TRUE" | "false" | "False" | "FALSE" | "null" | "Null" | "NULL" | "~"
        )
        && value.parse::<i64>().is_err()
        && value.parse::<f64>().is_err()
        && !value.starts_with(['+', '-'])
        && !value.starts_with([
            '"', '\'', '[', ']', '{', '}', ',', '&', '*', '!', '?', '>', '|', '%', '@', '`', '#',
            ':',
        ])
        && !value.starts_with("0x")
        && !value.starts_with("0o")
        && !matches!(
            value
                .strip_prefix(['+', '-'])
                .unwrap_or(value)
                .to_ascii_lowercase()
                .as_str(),
            ".inf" | ".nan"
        )
        && !value.contains(": ")
        && !value.ends_with(':')
        && !value.contains(" #")
        && !value.contains('#');
    if plain_ok {
        return Ok(value.to_string());
    }
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('"');
    for c in value.chars() {
        match c {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            c if (c as u32) < 0x20 => {
                return Err(format!("봉투 값에 제어 문자가 있을 수 없다: {value:?}"));
            }
            c => escaped.push(c),
        }
    }
    escaped.push('"');
    Ok(escaped)
}

/// 플로우 시퀀스에 안전한 항목인가 — 해석기가 플로우를 쉼표로 나누므로
///(`parse_flow_seq`) 쉼표가 있으면 블록 시퀀스로 써야 한다.
fn flow_safe(item: &str) -> bool {
    !item.contains(',') && !item.contains(" #") && !item.contains(['\n', '\r', '\t'])
}

fn seq_literal_lines(key: &str, items: &[String]) -> Result<Vec<String>, String> {
    if items.is_empty() {
        // 빈 값은 금지다(§5) — 빈 시퀀스는 키 생략이 정칙이다(§5.2 기본값).
        return Err("빈 시퀀스는 키를 생략해야 한다".into());
    }
    if items.iter().all(|item| flow_safe(item)) {
        let joined = items
            .iter()
            .map(|item| scalar_literal_v2(item))
            .collect::<Result<Vec<_>, _>>()?
            .join(", ");
        return Ok(vec![format!("{key}: [{joined}]")]);
    }
    let mut lines = vec![format!("{key}:")];
    for item in items {
        if item.is_empty() {
            return Err("빈 시퀀스 항목이 있다".into());
        }
        scalar_literal_v2(item)?; // 개행·탭만 여전히 금지다.
        lines.push(format!("  - {item}"));
    }
    Ok(lines)
}

fn map_literal_lines(key: &str, map: &[(String, EnvValue)]) -> Result<Vec<String>, String> {
    let mut lines = vec![format!("{key}:")];
    for (child, value) in map {
        let scalar = match value {
            EnvValue::Text(text) => scalar_literal_v2(text)?,
            EnvValue::Flag(flag) => flag.to_string(),
            EnvValue::Number(number) => number.clone(),
            _ => return Err("중첩 맵 값은 스칼라만 가능하다(§5)".into()),
        };
        lines.push(format!("  {child}: {scalar}"));
    }
    Ok(lines)
}

fn entry_lines(key: &str, value: &EnvValue) -> Result<Vec<String>, String> {
    match value {
        EnvValue::Flag(flag) => Ok(vec![format!("{key}: {flag}")]),
        EnvValue::Text(text) => Ok(vec![format!("{key}: {}", scalar_literal_v2(text)?)]),
        EnvValue::Number(number) => Ok(vec![format!("{key}: {number}")]),
        EnvValue::Null => Ok(vec![format!("{key}: null")]),
        EnvValue::Seq(items) => seq_literal_lines(
            key,
            &items
                .iter()
                .map(|item| item.as_text().map(str::to_string))
                .collect::<Option<Vec<_>>>()
                .ok_or_else(|| "생성 시퀀스는 문자열 항목만 담는다".to_string())?,
        ),
        EnvValue::Map(map) => map_literal_lines(key, map),
    }
}

/// 봉투 엔트리를 봉투 텍스트로 직렬화한다. 각 줄은 `\n`으로 끝난다.
fn serialize_entries(entries: &[(String, EnvValue)]) -> Result<String, String> {
    let mut out = String::new();
    for (key, value) in entries {
        for line in entry_lines(key, value)? {
            out.push_str(&line);
            out.push('\n');
        }
    }
    Ok(out)
}

/// 정칙 키 순서(§5.4): 알려진 키는 고정 순서, 사용자 속성은 관찰 순서.
/// 새 문서와 전면 재직렬화에만 쓴다.
const CANONICAL_KEYS: [&str; 14] = [
    "format",
    "body",
    "id",
    "created",
    "updated",
    "title",
    "profile",
    "lang",
    "tags",
    "aliases",
    "cssclasses",
    "favorite",
    "deleted",
    "deleted_at",
];

pub fn canonical_order(entries: &[(String, EnvValue)]) -> Vec<(String, EnvValue)> {
    let mut known: Vec<(usize, (String, EnvValue))> = Vec::new();
    let mut unknown: Vec<(String, EnvValue)> = Vec::new();
    for (key, value) in entries {
        if let Some(rank) = CANONICAL_KEYS.iter().position(|candidate| candidate == key) {
            known.push((rank, (key.clone(), value.clone())));
        } else {
            unknown.push((key.clone(), value.clone()));
        }
    }
    known.sort_by_key(|(rank, _)| *rank);
    let mut ordered: Vec<(String, EnvValue)> = known.into_iter().map(|(_, entry)| entry).collect();
    ordered.extend(unknown);
    ordered
}

/// 이송으로 완전한 문서 바이트를 만든다(§4.2, §4.3). HTML 봉투 안에 조기 주석
/// 닫기(`-->`, `--!>`)가 있으면 쓰기를 거부한다(§4.3 — 부분 봉투를 내보내선
/// 안 된다).
pub fn render_transport(
    kind: TransportKind,
    envelope_text: &str,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    match kind {
        TransportKind::Markdown => {
            out.extend_from_slice(b"---\n");
            out.extend_from_slice(envelope_text.as_bytes());
            out.extend_from_slice(b"---\n");
        }
        TransportKind::Html => {
            if envelope_text.contains("-->") || envelope_text.contains("--!>") {
                return Err(
                    "invalid_transport: 봉투 값에 조기 주석 닫기(`-->`)가 있어 쓸 수 없다".into(),
                );
            }
            out.extend_from_slice(b"<!--\n---\n");
            out.extend_from_slice(envelope_text.as_bytes());
            out.extend_from_slice(b"---\n-->\n");
        }
    }
    out.extend_from_slice(body);
    if out.len() as u64 > contract::DOCUMENT_MAX_BYTES {
        return Err("document_too_large: 문서는 4 MiB를 넘을 수 없다".into());
    }
    Ok(out)
}

/// 새 문서 본문의 정칙 철자(§4.1 LF, §6.1 마지막 LF). 기존 문서에는 절대
/// 적용하지 않는다 — 그쪽은 무조건 보존이다.
fn normalize_new_body(body: &str) -> Result<String, String> {
    if body.starts_with('\u{feff}') {
        return Err("invalid_transport: 본문이 BOM으로 시작한다".into());
    }
    let mut body = body.replace("\r\n", "\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    Ok(body)
}

// ---------- 경로 검증 ----------

/// 공간 루트 기준 상대 경로를 검증해 절대 경로로 바꾼다. 점 접두 구성요소는
/// 발견에서 제외되므로(§3.2) 쓰기 대상이 될 수 없다.
pub(crate) fn resolve_relative(space_root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative.trim().replace('\\', "/");
    if relative.is_empty() {
        return Err("경로가 비어 있다".into());
    }
    let mut path = space_root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component.starts_with('.') {
            return Err(format!("경로 구성요소가 부적절하다: {component:?}"));
        }
        path.push(component);
    }
    crate::workspace_io::check_path(space_root, &path)?;
    Ok(path)
}

/// 생성 대상 폴더 검증 — 빈 값(공간 루트)은 허용하고 점 접두 구성요소는
/// 금지한다(발견에서 보이지 않는 자리에 문서를 쓰면 안 된다).
fn validate_rel_dir(dir: &str) -> Result<String, String> {
    let dir = dir.trim().replace('\\', "/").trim_matches('/').to_string();
    if dir.is_empty() {
        return Ok(String::new());
    }
    for component in dir.split('/') {
        if component.is_empty() || component.starts_with('.') {
            return Err(format!("문서 폴더 구성요소가 부적절하다: {component:?}"));
        }
    }
    Ok(dir)
}

/// 발견되는 모든 문서 확장자. `.djot`은 레거시 패치 경로(코퍼스 작성기 사례)
/// 때문에 여전히 목록에 있지만 새로 만들 수는 없다.
pub(crate) fn extension_of(relative: &str) -> Result<&'static str, String> {
    let name = relative.rsplit('/').next().unwrap_or(relative);
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match extension.as_str() {
        "md" => Ok("md"),
        "html" => Ok("html"),
        "djot" => Ok("djot"),
        _ => Err(format!("pdc-document 이송 확장자가 아니다: {name}")),
    }
}

fn validate_stem(stem: &str) -> Result<(), String> {
    if stem.is_empty()
        || stem.len() > 128
        || stem.starts_with('.')
        || stem.ends_with([' ', '.'])
        || stem.contains(['/', '\\', '\0'])
        || stem.chars().any(char::is_control)
    {
        return Err(format!("파일 이름이 부적절하다: {stem:?}"));
    }
    Ok(())
}

// ---------- 볼트 표시 ----------

/// 첫 정칙 쓰기 전 `.pdc/vault.json`을 보장한다(§3.1). 이미 있으면 절대
/// 고치지 않는다 — 알 수 없는 속성 보존이고, 손상 표시는 진단의 영역이다.
pub fn ensure_vault_manifest(space_root: &Path) -> Result<(), String> {
    let dir = space_root.join(".pdc");
    let path = dir.join("vault.json");
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("write-failed: {e}"))?;
    let manifest = serde_json::json!({
        "format": contract::VAULT_MANIFEST_FORMAT,
        "id": uuid::Uuid::now_v7().to_string(),
        "created": now_stamp(),
    });
    let mut text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    text.push('\n');
    crate::workspace_io::write_atomic(&path, text.as_bytes(), false)
}

// ---------- 봉투 행 패치 ----------

/// v1 봉투의 최상위 키별 줄 범위 `[key, 시작 줄, 끝 줄)`. 해석기의 소비
/// 규칙을 그대로 따라간다: 값이 빈 키는 두 칸 들여쓰기 연속 줄(중첩 맵·블록
/// 시퀀스)을, 리터럴 블록 표지(`|`)는 빈 줄까지 내용으로 흡수한다.
fn key_spans_v1(lines: &[&str]) -> Result<Vec<(String, usize, usize)>, String> {
    let mut spans = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        if line.is_empty() {
            return Err("invalid_envelope: 봉투에 빈 줄이 있다".into());
        }
        let Some(colon) = line.find(':') else {
            return Err(format!("invalid_envelope: 봉투 줄에 `:`이 없다: {line}"));
        };
        let key = line[..colon].trim_end().to_string();
        let raw = line[colon + 1..].trim();
        let mut end = index + 1;
        if raw.is_empty() {
            while end < lines.len() && !lines[end].is_empty() && two_space_indent(lines[end]) {
                end += 1;
            }
        } else if matches!(raw, "|" | "|-" | "|+") {
            while end < lines.len() && (lines[end].is_empty() || two_space_indent(lines[end])) {
                end += 1;
            }
        }
        spans.push((key, index, end));
        index = end;
    }
    Ok(spans)
}

fn two_space_indent(line: &str) -> bool {
    line.starts_with("  ") && !line.starts_with("   ")
}

/// v2 안전 YAML 봉투의 최상위 키별 줄 범위. 최상위 항목은 col-0 줄이다 —
/// `key:` 문양이면 키 항목, `#`이면 주석 덩이, 그 외(빈 줄 등)는 통과 덩이.
/// 키 항목의 범위는 다음 col-0 줄 전까지로 중첩 맵·시퀀스·블록 스칼라·빈 줄을
/// 모두 흡수한다. 검증을 통과한 봉투만 여기 오므로 이 근사는 안전하다.
fn key_spans_v2(lines: &[&str]) -> Vec<(String, usize, usize)> {
    let starts: Vec<(String, usize)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            if line.is_empty() || line.starts_with([' ', '\t']) || line.starts_with('#') {
                return None;
            }
            let colon = line.find(':')?;
            let key = line[..colon].trim_end();
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), index))
        })
        .collect();
    (0..lines.len())
        .filter_map(|index| {
            let (key, _) = starts.iter().find(|(_, start)| *start == index)?;
            let end = starts
                .iter()
                .map(|(_, start)| *start)
                .filter(|next| *next > index)
                .min()
                .unwrap_or(lines.len());
            Some((key.clone(), index, end))
        })
        .collect()
}

/// 대상 키의 줄만 바꾸거나 지운다. `None` 값은 키 삭제다. 손대지 않은 키는
/// `\r` 철자·주석까지 줄 단위로 그대로 남는다(§10.1 보존). 봉투에 없던 키
/// 패치는 끝에 붙는다 — 부분 재직렬화에서는 관찰 순서 보존이 우선이다(§5.4).
fn patch_envelope(
    original: &str,
    patches: &[(String, Option<Vec<String>>)],
    grammar: Grammar,
) -> Result<String, String> {
    let body = original.strip_suffix('\n').unwrap_or(original);
    let lines: Vec<&str> = body.split('\n').collect();
    let spans = match grammar {
        Grammar::V1 => key_spans_v1(&lines)?,
        Grammar::V2 => key_spans_v2(&lines),
    };
    let patch_map: HashMap<&str, &Option<Vec<String>>> = patches
        .iter()
        .map(|(key, value)| (key.as_str(), value))
        .collect();
    let mut out = String::new();
    let mut index = 0usize;
    while index < lines.len() {
        if let Some((key, _, end)) = spans.iter().find(|(_, start, _)| *start == index) {
            if let Some(patch) = patch_map.get(key.as_str()) {
                if let Some(new_lines) = patch.as_deref() {
                    for line in new_lines {
                        out.push_str(line);
                        out.push('\n');
                    }
                }
                index = *end;
                continue;
            }
        }
        out.push_str(lines[index]);
        out.push('\n');
        index += 1;
    }
    for (key, value) in patches {
        if spans.iter().any(|(existing, _, _)| existing == key) {
            continue;
        }
        if let Some(new_lines) = value {
            let _ = key;
            for line in new_lines {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    Ok(out)
}

// ---------- 생성 ----------

/// 새 정문서의 표준 메타. `deleted`는 새 문서에 쓰지 않는다(기본값 false).
#[derive(Clone, Debug, Default)]
pub struct NewDocument {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub cssclasses: Vec<String>,
    pub favorite: bool,
    pub profile: Option<String>,
    pub lang: Option<String>,
}

/// 생성 결과. `path`는 공간 루트 기준 `/` 구분 상대 경로다.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
    pub id: String,
    pub digest: String,
    pub updated: String,
}

/// 새 정문서를 만든다(§7.1 UUIDv7, §3.1 표시 먼저, create-if-absent).
/// v2 전용이다 — `.djot` 생성은 [`TransportKind::from_creatable_extension`]이
/// 거부한다. 직렬화 결과는 판독기로 재판독해 Valid를 확인한다 — 쓰여지는
/// 바이트는 언제나 판독기가 받아들이는 바이트다.
pub fn create_document(
    space_root: &Path,
    dir: &str,
    stem: &str,
    kind: TransportKind,
    doc: &NewDocument,
) -> Result<Created, String> {
    create_document_with_stamp(space_root, dir, stem, kind, doc, &now_stamp())
}

/// `stamp` 주입형 생성 — 시험에서 created/updated를 고정하기 위한 유일한 차이다.
pub fn create_document_with_stamp(
    space_root: &Path,
    dir: &str,
    stem: &str,
    kind: TransportKind,
    doc: &NewDocument,
    stamp: &str,
) -> Result<Created, String> {
    validate_stem(stem)?;
    let dir = validate_rel_dir(dir)?;
    ensure_vault_manifest(space_root)?;
    let id = uuid::Uuid::now_v7().to_string();
    let mut entries: Vec<(String, EnvValue)> = vec![
        (
            "format".into(),
            EnvValue::Text(contract::DOCUMENT_FORMAT_V2.into()),
        ),
        ("body".into(), EnvValue::Text(kind.profile().into())),
        ("id".into(), EnvValue::Text(id.clone())),
        ("created".into(), EnvValue::Text(stamp.to_string())),
        ("updated".into(), EnvValue::Text(stamp.to_string())),
        ("title".into(), EnvValue::Text(doc.title.clone())),
    ];
    if let Some(profile) = doc.profile.as_deref().filter(|value| !value.is_empty()) {
        entries.push(("profile".into(), EnvValue::Text(profile.into())));
    }
    if let Some(lang) = doc.lang.as_deref().filter(|value| !value.is_empty()) {
        entries.push(("lang".into(), EnvValue::Text(lang.into())));
    }
    if !doc.tags.is_empty() {
        entries.push((
            "tags".into(),
            EnvValue::Seq(doc.tags.iter().cloned().map(EnvValue::Text).collect()),
        ));
    }
    if !doc.aliases.is_empty() {
        entries.push((
            "aliases".into(),
            EnvValue::Seq(doc.aliases.iter().cloned().map(EnvValue::Text).collect()),
        ));
    }
    if !doc.cssclasses.is_empty() {
        entries.push((
            "cssclasses".into(),
            EnvValue::Seq(doc.cssclasses.iter().cloned().map(EnvValue::Text).collect()),
        ));
    }
    if doc.favorite {
        entries.push(("favorite".into(), EnvValue::Flag(true)));
    }
    let envelope_text = serialize_entries(&canonical_order(&entries))?;
    let body = normalize_new_body(&doc.body)?;
    let bytes = render_transport(kind, &envelope_text, body.as_bytes())?;
    let recheck = reader::read_document(kind.extension(), bytes.clone());
    if recheck.outcome != Outcome::Valid {
        return Err(format!(
            "{}: 새 문서가 판독기를 통과하지 못했다 — {}",
            recheck.outcome.code(),
            diagnostic_detail(&recheck.outcome)
        ));
    }
    let relative = if dir.is_empty() {
        format!("{stem}.{}", kind.extension())
    } else {
        format!("{dir}/{stem}.{}", kind.extension())
    };
    let path = space_root.join(&relative);
    crate::workspace_io::write_atomic(&path, &bytes, false).map_err(|error| {
        if error.contains("noclobber") || error.contains("AlreadyExists") {
            format!("already-exists: 같은 이름의 파일이 있다: {relative}")
        } else {
            error
        }
    })?;
    Ok(Created {
        path: relative,
        id,
        digest: sha256_hex(&bytes),
        updated: stamp.to_string(),
    })
}

fn diagnostic_detail(outcome: &Outcome) -> String {
    match outcome {
        Outcome::InvalidTransport(reason)
        | Outcome::InvalidEnvelope(reason)
        | Outcome::UnsupportedBodyVersion(reason)
        | Outcome::UnsupportedDocumentVersion(reason)
        | Outcome::InvalidQuery(reason) => reason.clone(),
        Outcome::UnsafeContent(constructs) => constructs.join("; "),
        _ => outcome.code().to_string(),
    }
}

// ---------- 저장 ----------

/// 기존 문서 패치. `None` 필드는 손대지 않는다. `body`가 있으면 본문 전체를
/// 바꾼다(봉투는 행 패치로 보존). `deleted` 전환은 `deleted_at` 짝을 함께
/// 만족시킨다(§5.2).
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct SavePatch {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    pub favorite: Option<bool>,
    pub deleted: Option<bool>,
    pub body: Option<String>,
}

/// 저장 결과. `Conflict`는 통지된 외부 변경(§10.3)이다 — 현재 다이제스트를
/// 돌려주고 덮어쓰려면 사용자의 명시적 결정이 필요하다.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveOutcome {
    Saved {
        digest: String,
        updated: String,
        size: usize,
    },
    /// 바이트 단위 무변화 — 파일을 건드리지 않았다(§10.1).
    Unchanged { digest: String },
    Conflict {
        current_digest: String,
        current_updated: Option<String>,
    },
}

/// 기존 정문서를 패치한다. 검증을 통과한(v2 `valid`·v1 `legacy_valid`) 문서만
/// 대상이다 — 진단 문서는 표시 전용이다. 봉투가 줄 편집 불가능한 모양(플로우
/// 스타일 루트 등)이면 쓰기를 거부한다(§13 `unsupported_lossless_edit`).
pub fn save_document(
    space_root: &Path,
    relative_path: &str,
    expected_digest: &str,
    patch: &SavePatch,
) -> Result<SaveOutcome, String> {
    save_document_with_stamp(
        space_root,
        relative_path,
        expected_digest,
        patch,
        &now_stamp(),
    )
}

pub fn save_document_with_stamp(
    space_root: &Path,
    relative_path: &str,
    expected_digest: &str,
    patch: &SavePatch,
    stamp: &str,
) -> Result<SaveOutcome, String> {
    let extension = extension_of(relative_path)?;
    let path = resolve_relative(space_root, relative_path)?;
    let _lock = crate::workspace_io::lock(space_root, "pdc-documents")?;
    let current = std::fs::read(&path)
        .map_err(|e| format!("not-found: 문서를 읽을 수 없다({}): {e}", path.display()))?;
    let digest = sha256_hex(&current);
    if digest != expected_digest {
        return Ok(SaveOutcome::Conflict {
            current_digest: digest,
            current_updated: current_envelope_updated(&current, extension),
        });
    }
    let document = reader::read_document(extension, current.clone());
    match document.outcome {
        Outcome::Valid | Outcome::LegacyValid => {}
        other => {
            return Err(format!(
                "{}: 진단 있는 문서는 이 경로로 저장할 수 없다 — {}",
                other.code(),
                diagnostic_detail(&other)
            ));
        }
    }
    let grammar = match document.format() {
        Some(contract::DOCUMENT_FORMAT_V2) => Grammar::V2,
        Some(contract::DOCUMENT_FORMAT) => Grammar::V1,
        _ => {
            return Err("legacy_document_version: 봉투 형식을 판정할 수 없어 쓸 수 없다".into());
        }
    };
    let transport = transport::extract(extension, &current)
        .map_err(|outcome| format!("{}: {}", outcome.code(), diagnostic_detail(&outcome)))?;
    let envelope_text =
        String::from_utf8(current[transport.envelope_range.0..transport.envelope_range.1].to_vec())
            .map_err(|_| "invalid_transport: 봉투가 UTF-8이 아니다".to_string())?;
    if grammar == Grammar::V2 {
        let lines: Vec<&str> = envelope_text.trim_end_matches('\n').split('\n').collect();
        let spans = key_spans_v2(&lines);
        for required in ["format", "body", "id", "created", "updated", "title"] {
            if !spans.iter().any(|(key, _, _)| key == required) {
                return Err(
                    "unsupported_lossless_edit: 봉투 최상위 키가 블록 줄 편집을 지원하지 \
                     않는다 — 이 문서는 원본 보존을 위해 읽기 전용이다"
                        .into(),
                );
            }
        }
    }
    let scalar = |value: &str| match grammar {
        Grammar::V1 => scalar_literal_v1(value),
        Grammar::V2 => scalar_literal_v2(value),
    };

    let mut patches: Vec<(String, Option<Vec<String>>)> = Vec::new();
    if let Some(title) = &patch.title {
        patches.push((
            "title".into(),
            Some(vec![format!("title: {}", scalar(title)?)]),
        ));
    }
    if let Some(tags) = &patch.tags {
        patches.push(("tags".into(), seq_patch("tags", tags)?));
    }
    if let Some(aliases) = &patch.aliases {
        patches.push(("aliases".into(), seq_patch("aliases", aliases)?));
    }
    if let Some(favorite) = patch.favorite {
        patches.push((
            "favorite".into(),
            Some(vec![format!("favorite: {favorite}")]),
        ));
    }
    apply_deleted_patch(
        &document.envelope,
        &mut patches,
        patch.deleted,
        stamp,
        &scalar,
    )?;

    let new_body: Vec<u8> = match &patch.body {
        Some(body) => normalize_new_body(body)?.into_bytes(),
        None => current[transport.body_range.0..transport.body_range.1].to_vec(),
    };

    // no-op 판정은 `updated`를 올리기 전 후보로 한다(§10.1 — no-op는
    // `updated`를 바꾸지 않는다).
    let candidate = patch_envelope(&envelope_text, &patches, grammar)?;
    let candidate_bytes = render_transport(
        TransportKind::for_extension(extension),
        &candidate,
        &new_body,
    )?;
    if candidate_bytes == current {
        return Ok(SaveOutcome::Unchanged { digest });
    }
    patches.push((
        "updated".into(),
        Some(vec![format!("updated: {}", scalar(stamp)?)]),
    ));
    let patched_envelope = patch_envelope(&envelope_text, &patches, grammar)?;
    let bytes = render_transport(
        TransportKind::for_extension(extension),
        &patched_envelope,
        &new_body,
    )?;
    let recheck = reader::read_document(extension, bytes.clone());
    if !matches!(recheck.outcome, Outcome::Valid | Outcome::LegacyValid) {
        return Err(format!(
            "{}: 저장 결과가 판독기를 통과하지 못했다 — {}",
            recheck.outcome.code(),
            diagnostic_detail(&recheck.outcome)
        ));
    }
    crate::workspace_io::write_atomic(&path, &bytes, true)?;
    Ok(SaveOutcome::Saved {
        digest: sha256_hex(&bytes),
        updated: stamp.to_string(),
        size: bytes.len(),
    })
}

/// 시퀀스 패치 줄. 빈 시퀀스는 키 삭제다(§5.2 — 기본값이 빈 시퀀스고 봉투는
/// 빈 값을 금지한다).
fn seq_patch(key: &str, items: &[String]) -> Result<Option<Vec<String>>, String> {
    if items.is_empty() {
        return Ok(None);
    }
    Ok(Some(seq_literal_lines(key, items)?))
}

fn apply_deleted_patch(
    envelope: &Option<Envelope>,
    patches: &mut Vec<(String, Option<Vec<String>>)>,
    target: Option<bool>,
    stamp: &str,
    scalar: &dyn Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    let Some(target) = target else { return Ok(()) };
    let current = envelope
        .as_ref()
        .and_then(|env| env.get("deleted"))
        .and_then(|value| match value {
            EnvValue::Flag(flag) => Some(*flag),
            _ => None,
        })
        .unwrap_or(false);
    if target && !current {
        patches.push(("deleted".into(), Some(vec!["deleted: true".into()])));
        patches.push((
            "deleted_at".into(),
            Some(vec![format!("deleted_at: {}", scalar(stamp)?)]),
        ));
    } else if !target && current {
        patches.push(("deleted".into(), None));
        patches.push(("deleted_at".into(), None));
    }
    Ok(())
}

fn current_envelope_updated(current: &[u8], extension: &str) -> Option<String> {
    let transport = transport::extract(extension, current).ok()?;
    let slice = &current[transport.envelope_range.0..transport.envelope_range.1];
    let format = std::str::from_utf8(slice).ok()?.lines().find_map(|line| {
        let line = line.strip_suffix('\r').unwrap_or(line);
        line.strip_prefix("format:")
            .map(|rest| rest.trim().to_string())
    })?;
    let updated = if format == contract::DOCUMENT_FORMAT_V2 {
        let envelope = yamlfront::parse(slice).ok()?;
        envelope.text("updated").map(str::to_string)
    } else {
        let envelope = envelope::parse(slice).ok()?;
        envelope.text("updated").map(str::to_string)
    };
    updated
}

// ---------- 이동·이름 바꾸기 ----------

/// 문서를 이동하거나 이름을 바꾼다. ID는 경로와 무관하다(§7.1). 확장자를
/// 바꾸는 것은 바디 프로필 변환이므로(§14) 여기서 거부한다.
pub fn move_document(
    space_root: &Path,
    from_relative: &str,
    to_relative: &str,
    expected_digest: &str,
) -> Result<(), String> {
    let from_extension = extension_of(from_relative)?;
    let to_extension = extension_of(to_relative)?;
    if from_extension != to_extension {
        return Err("unsupported: 바디 프로필 변환은 이동으로 할 수 없다".into());
    }
    let from = resolve_relative(space_root, from_relative)?;
    let to = resolve_relative(space_root, to_relative)?;
    let _lock = crate::workspace_io::lock(space_root, "pdc-documents")?;
    let current = std::fs::read(&from)
        .map_err(|e| format!("not-found: 문서를 읽을 수 없다({}): {e}", from.display()))?;
    if sha256_hex(&current) != expected_digest {
        return Err(
            "external-change-conflict: 문서가 외부에서 변경됐다. 다시 읽은 뒤 시도하라".into(),
        );
    }
    if to.exists() {
        return Err(format!(
            "already-exists: 이동할 자리에 파일이 있다: {to_relative}"
        ));
    }
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("write-failed: {e}"))?;
    }
    std::fs::rename(&from, &to).map_err(|e| format!("write-failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_space(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "swdash-pdc-writer-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn new_md(title: &str, body: &str) -> NewDocument {
        NewDocument {
            title: title.into(),
            body: body.into(),
            ..NewDocument::default()
        }
    }

    fn corpus_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/pdc/conformance")
    }

    fn corpus() -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(corpus_dir().join("corpus.json")).unwrap())
            .unwrap()
    }

    const STAMP_A: &str = "2026-09-13T12:00:00.000Z";
    const STAMP_B: &str = "2026-09-13T13:00:00.000Z";

    #[test]
    fn create_produces_valid_v2_markdown_document_with_manifest() {
        let space = temp_space("create");
        let created = create_document(
            &space,
            "notes",
            "first",
            TransportKind::Markdown,
            &new_md("첫 문서", "# 첫 문서\n\n본문이다.\n"),
        )
        .unwrap();
        assert_eq!(created.path, "notes/first.md");
        let manifest = std::fs::read_to_string(space.join(".pdc").join("vault.json")).unwrap();
        assert!(manifest.contains("\"format\": \"pdc-vault/1\""));
        let bytes = std::fs::read(space.join(&created.path)).unwrap();
        let document = reader::read_document("md", bytes);
        assert_eq!(document.outcome, Outcome::Valid);
        assert_eq!(document.format(), Some("pdc-document/2"));
        assert_eq!(document.id(), Some(created.id.as_str()));
        // 정칙 키 순서(§5.4)
        let text = std::fs::read_to_string(space.join(&created.path)).unwrap();
        let keys: Vec<&str> = text
            .lines()
            .skip(1)
            .take_while(|line| *line != "---")
            .filter_map(|line| line.split(':').next())
            .collect();
        assert_eq!(
            keys,
            vec!["format", "body", "id", "created", "updated", "title"]
        );
    }

    #[test]
    fn create_refuses_djot_documents() {
        let space = temp_space("nodjot");
        let error = TransportKind::from_creatable_extension("djot").unwrap_err();
        assert!(error.contains("v2 작성기가 만들 수 없다"), "{error}");
        // `.djot` 확장자로 저장하려는 시도는 레거시 패치 경로로만 간다.
        assert!(!space.join("x.djot").exists());
    }

    #[test]
    fn corpus_writer_operations_are_reproduced_byte_for_byte() {
        let mut covered = 0usize;
        for case in corpus()["cases"].as_array().unwrap() {
            if case["kind"] != "operation" {
                continue;
            }
            let id = case["id"].as_str().unwrap();
            let operation = case["operation"].as_str().unwrap();
            if !matches!(
                operation,
                "no-op-round-trip" | "metadata-patch" | "external-change-before-save"
            ) {
                continue; // 판독기 동작 — reader.rs 코퍼스 시험이 소비한다.
            }
            let expected_code = case["expect"].as_str().unwrap();
            let input = case["input"].as_str().unwrap();
            let extension = input.rsplit('.').next().unwrap();
            let original = std::fs::read(corpus_dir().join(input)).unwrap();
            let space = temp_space("corpus");
            let relative = format!("doc.{extension}");
            std::fs::write(space.join(&relative), &original).unwrap();
            match operation {
                "no-op-round-trip" => {
                    let document = reader::read_document(extension, original.clone());
                    let title = document
                        .envelope
                        .as_ref()
                        .and_then(|e| e.text("title"))
                        .unwrap()
                        .to_string();
                    let body = String::from_utf8_lossy(document.body()).to_string();
                    let stamp = document
                        .envelope
                        .as_ref()
                        .and_then(|e| e.text("updated"))
                        .unwrap()
                        .to_string();
                    let outcome = save_document_with_stamp(
                        &space,
                        &relative,
                        &sha256_hex(&original),
                        &SavePatch {
                            title: Some(title),
                            body: Some(body),
                            ..Default::default()
                        },
                        &stamp,
                    )
                    .unwrap();
                    assert!(
                        matches!(outcome, SaveOutcome::Unchanged { .. }),
                        "{id}: {outcome:?}"
                    );
                    assert_eq!(
                        std::fs::read(space.join(&relative)).unwrap(),
                        original,
                        "{id}: 바이트 동일"
                    );
                }
                "metadata-patch" => {
                    let patch_json = &case["patch"];
                    let stamp = patch_json["updated"].as_str().unwrap();
                    let title = patch_json["title"].as_str().unwrap();
                    let outcome = save_document_with_stamp(
                        &space,
                        &relative,
                        &sha256_hex(&original),
                        &SavePatch {
                            title: Some(title.into()),
                            ..Default::default()
                        },
                        stamp,
                    )
                    .unwrap();
                    assert!(
                        matches!(outcome, SaveOutcome::Saved { .. }),
                        "{id}: {outcome:?}"
                    );
                    let expected = case["expected"].as_str().unwrap();
                    assert_eq!(
                        std::fs::read(space.join(&relative)).unwrap(),
                        std::fs::read(corpus_dir().join(expected)).unwrap(),
                        "{id}: 예상 산출과 바이트 동일"
                    );
                }
                "external-change-before-save" => {
                    let external = case["external"].as_str().unwrap();
                    let external_bytes = std::fs::read(corpus_dir().join(external)).unwrap();
                    std::fs::write(space.join(&relative), &external_bytes).unwrap();
                    let outcome = save_document_with_stamp(
                        &space,
                        &relative,
                        &sha256_hex(&original),
                        &SavePatch {
                            title: Some("내 편집".into()),
                            ..Default::default()
                        },
                        &now_stamp(),
                    )
                    .unwrap();
                    assert_eq!(outcome_code(&outcome), expected_code, "{id}");
                }
                other => panic!("작성기 코퍼스가 아닌 동작: {other}"),
            }
            covered += 1;
            std::fs::remove_dir_all(&space).ok();
        }
        assert_eq!(covered, 10, "작성기 코퍼스 사례 전부를 소비해야 한다");
    }

    fn outcome_code(outcome: &SaveOutcome) -> &'static str {
        match outcome {
            SaveOutcome::Saved { .. } => "saved",
            SaveOutcome::Unchanged { .. } => "byte-identical",
            SaveOutcome::Conflict { .. } => "external_change_conflict",
        }
    }

    #[test]
    fn noop_leaves_every_byte_and_updated_unchanged() {
        let space = temp_space("noop");
        let created = create_document(
            &space,
            "",
            "keep",
            TransportKind::Markdown,
            &new_md("No-op", "본문.\n"),
        )
        .unwrap();
        let path = space.join(&created.path);
        let before = std::fs::read(&path).unwrap();
        let outcome = save_document_with_stamp(
            &space,
            &created.path,
            &created.digest,
            &SavePatch {
                title: Some("No-op".into()),
                body: Some("본문.\n".into()),
                ..Default::default()
            },
            STAMP_B,
        )
        .unwrap();
        assert_eq!(
            match outcome {
                SaveOutcome::Unchanged { .. } => "unchanged",
                _ => "other",
            },
            "unchanged"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn v2_metadata_patch_preserves_comments_user_properties_and_body_bytes() {
        let space = temp_space("patch");
        let created = create_document_with_stamp(
            &space,
            "",
            "patch",
            TransportKind::Markdown,
            &new_md("이전", "본문.\n"),
            STAMP_A,
        )
        .unwrap();
        let path = space.join(&created.path);
        // 다른 앱이 쓴 것처럼 주석·사용자 속성·중첩 맵을 손으로 넣는다.
        let text = std::fs::read_to_string(&path).unwrap();
        let with_foreign = text.replace(
            "---\n",
            "---\n# 편집자 주석\nstatus: draft\nx_sawhorse:\n  legacy_id: DOC-8\n",
        );
        std::fs::write(&path, &with_foreign).unwrap();
        let digest = sha256_hex(with_foreign.as_bytes());
        let outcome = save_document_with_stamp(
            &space,
            &created.path,
            &digest,
            &SavePatch {
                title: Some("새 제목: 요약 #1".into()),
                ..Default::default()
            },
            STAMP_B,
        )
        .unwrap();
        let SaveOutcome::Saved { .. } = outcome else {
            panic!("{outcome:?}")
        };
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("# 편집자 주석\n"), "{after}");
        assert!(after.contains("status: draft\n"));
        assert!(after.contains("x_sawhorse:\n  legacy_id: DOC-8\n"));
        assert!(after.contains("title: \"새 제목: 요약 #1\""), "{after}");
        assert!(after.contains("updated: 2026-09-13T13:00:00.000Z"));
        assert!(after.ends_with("본문.\n"), "본문 바이트 보존: {after}");
    }

    #[test]
    fn body_patch_preserves_envelope_bytes_including_unknown_fields() {
        let space = temp_space("body");
        let created = create_document_with_stamp(
            &space,
            "",
            "preserve",
            TransportKind::Html,
            &NewDocument {
                title: "HTML 보존".into(),
                body: "<p>이전 본문</p>\n".into(),
                ..Default::default()
            },
            STAMP_A,
        )
        .unwrap();
        let path = space.join(&created.path);
        // 다른 앱이 쓴 것처럼 알 수 없는 확장 맵을 손으로 넣는다.
        let text = std::fs::read_to_string(&path).unwrap();
        let with_foreign = text.replace("favorite: true\n", "");
        let with_foreign =
            with_foreign.replace("---\n-->\n", "x_foreign:\n  exact: keep me\n---\n-->\n");
        std::fs::write(&path, &with_foreign).unwrap();
        let digest = sha256_hex(with_foreign.as_bytes());
        let outcome = save_document_with_stamp(
            &space,
            &created.path,
            &digest,
            &SavePatch {
                body: Some("<p>새 본문</p>\n".into()),
                ..Default::default()
            },
            STAMP_B,
        )
        .unwrap();
        let SaveOutcome::Saved { .. } = outcome else {
            panic!("{outcome:?}")
        };
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("x_foreign:\n  exact: keep me"), "{after}");
        assert!(after.contains("<p>새 본문</p>"));
        assert!(after.contains("updated: 2026-09-13T13:00:00.000Z"));
    }

    #[test]
    fn external_change_blocks_overwrite_with_conflict() {
        let space = temp_space("conflict");
        let created = create_document(
            &space,
            "",
            "conflict",
            TransportKind::Markdown,
            &new_md("Original snapshot", "# Original snapshot\n"),
        )
        .unwrap();
        // 외부 작성자가 먼저 바꿨다(external-change 픽스처 시나리오).
        std::fs::write(space.join(&created.path), "---\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: 018f47c6-ea44-79c6-a1bc-f8725f99432a\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:59:00.000Z\ntitle: External change\n---\n# External change\n\nAnother writer changed this file before the pending save.\n").unwrap();
        let outcome = save_document(
            &space,
            &created.path,
            &created.digest,
            &SavePatch {
                title: Some("내 편집".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let SaveOutcome::Conflict {
            current_updated, ..
        } = outcome
        else {
            panic!("충돌이어야 한다: {outcome:?}");
        };
        assert_eq!(current_updated.as_deref(), Some("2026-09-13T12:59:00.000Z"));
        assert!(std::fs::read_to_string(space.join(&created.path))
            .unwrap()
            .contains("External change"));
    }

    #[test]
    fn deleted_flip_keeps_deleted_at_pairing() {
        let space = temp_space("deleted");
        let created = create_document_with_stamp(
            &space,
            "",
            "trash",
            TransportKind::Markdown,
            &new_md("버릴 문서", "본문\n"),
            STAMP_A,
        )
        .unwrap();
        let outcome = save_document_with_stamp(
            &space,
            &created.path,
            &created.digest,
            &SavePatch {
                deleted: Some(true),
                ..Default::default()
            },
            STAMP_B,
        )
        .unwrap();
        let SaveOutcome::Saved { .. } = outcome else {
            panic!("{outcome:?}")
        };
        let text = std::fs::read_to_string(space.join(&created.path)).unwrap();
        assert!(text.contains("deleted: true"));
        assert!(text.contains("deleted_at: 2026-09-13T13:00:00.000Z"));
        // 복구: 두 키가 함께 사라진다.
        let digest = sha256_hex(std::fs::read(space.join(&created.path)).unwrap().as_slice());
        let outcome = save_document_with_stamp(
            &space,
            &created.path,
            &digest,
            &SavePatch {
                deleted: Some(false),
                ..Default::default()
            },
            STAMP_B,
        )
        .unwrap();
        let SaveOutcome::Saved { .. } = outcome else {
            panic!("{outcome:?}")
        };
        let text = std::fs::read_to_string(space.join(&created.path)).unwrap();
        assert!(!text.contains("deleted"), "{text}");
    }

    #[test]
    fn html_envelope_early_comment_close_is_refused() {
        let space = temp_space("arrow");
        let created = create_document(
            &space,
            "",
            "arrow",
            TransportKind::Html,
            &NewDocument {
                title: "arrow".into(),
                body: "<p>x</p>\n".into(),
                ..Default::default()
            },
        )
        .unwrap();
        // 제목에 `-->`를 넣은 메타 패치는 쓰기 거부다(§4.3).
        let outcome = save_document(
            &space,
            &created.path,
            &created.digest,
            &SavePatch {
                title: Some("악 --> 의".into()),
                ..Default::default()
            },
        );
        let error = outcome.unwrap_err();
        assert!(error.contains("조기 주석 닫기"), "{error}");
    }

    #[test]
    fn move_renames_within_space_and_keeps_identity() {
        let space = temp_space("move");
        let created = create_document(
            &space,
            "notes",
            "old",
            TransportKind::Markdown,
            &new_md("이동", "본문\n"),
        )
        .unwrap();
        move_document(
            &space,
            &created.path,
            "archive/2026/new.md",
            &created.digest,
        )
        .unwrap();
        assert!(!space.join(&created.path).exists());
        let bytes = std::fs::read(space.join("archive/2026/new.md")).unwrap();
        assert_eq!(
            reader::read_document("md", bytes).id(),
            Some(created.id.as_str())
        );
        // 확장자 변경은 프로필 변환이므로 거부다.
        let error = move_document(
            &space,
            "archive/2026/new.md",
            "archive/2026/new.html",
            &created.digest,
        )
        .unwrap_err();
        assert!(error.contains("프로필 변환"), "{error}");
    }

    #[test]
    fn v2_scalar_round_trip_preserves_values_through_the_yaml_grammar() {
        let cases = [
            "plain",
            "true",
            "false",
            "",
            " leading and trailing ",
            "with space # marker",
            "starts with [ bracket",
            "a,b",
            "\"quoted\"",
            "tail quote\"",
            "back\\slash",
            "2026-09-20",
            "42",
            ".inf",
            "null",
            "&anchor*alias!tag?complex|block",
            "유니코드 제목",
        ];
        for value in cases {
            let literal = scalar_literal_v2(value).unwrap();
            let envelope = format!("title: {literal}\n");
            let parsed = yamlfront::parse(envelope.as_bytes()).unwrap();
            assert_eq!(parsed.text("title"), Some(value), "literal: {literal:?}");
        }
    }

    #[test]
    fn v1_scalar_round_trip_preserves_values_through_the_frozen_grammar() {
        let cases = [
            "plain",
            "true",
            "false",
            "",
            " leading and trailing ",
            "with space # marker",
            "starts with [ bracket",
            "a,b",
            "\"quoted\"",
            "tail quote\"",
            "&anchor*alias!tag?complex|block",
            "유니코드 제목",
        ];
        for value in cases {
            let literal = scalar_literal_v1(value).unwrap();
            let line = format!("title: {literal}");
            let parsed = envelope::parse(line.as_bytes()).unwrap();
            assert_eq!(parsed.text("title"), Some(value), "literal: {literal:?}");
        }
    }

    #[test]
    fn flow_sequence_with_comma_uses_block_form() {
        let lines = seq_literal_lines("tags", &["a,b".into(), "plain".into()]).unwrap();
        assert_eq!(lines, vec!["tags:", "  - a,b", "  - plain"]);
        let text = format!("{}\n", lines.join("\n"));
        let parsed = yamlfront::parse(text.as_bytes()).unwrap();
        assert_eq!(
            parsed.get("tags"),
            Some(&EnvValue::Seq(vec![
                EnvValue::Text("a,b".into()),
                EnvValue::Text("plain".into())
            ]))
        );
    }

    #[test]
    fn patch_envelope_touches_only_target_lines() {
        let original = "format: pdc-document/1\nbody: pdc-djot/1\nid: x\ncreated: c\nupdated: u\ntitle: 이전\nx_sawhorse:\n  legacy_id: DOC-8\n  memo_json: |\n  여러 줄\n";
        let patched = patch_envelope(
            original,
            &[
                ("updated".into(), Some(vec!["updated: 새것".into()])),
                ("title".into(), Some(vec!["title: 새 제목".into()])),
            ],
            Grammar::V1,
        )
        .unwrap();
        assert!(patched.contains("updated: 새것"));
        assert!(patched.contains("title: 새 제목"));
        assert!(patched.contains("x_sawhorse:\n  legacy_id: DOC-8\n  memo_json: |\n  여러 줄\n"));
        assert!(patched.starts_with("format: pdc-document/1\nbody: pdc-djot/1\nid: x\n"));
    }

    #[test]
    fn v2_patch_envelope_treats_comments_as_pass_through_chunks() {
        let original = "# 편집자 주석\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: x\ncreated: c\nupdated: u\ntitle: 이전\nstatus: draft\nx_sawhorse:\n  legacy_id: DOC-8\n";
        let patched = patch_envelope(
            original,
            &[
                ("updated".into(), Some(vec!["updated: 새것".into()])),
                ("title".into(), Some(vec!["title: 새 제목".into()])),
            ],
            Grammar::V2,
        )
        .unwrap();
        assert!(patched.starts_with("# 편집자 주석\nformat: pdc-document/2\n"));
        assert!(
            patched.contains("updated: 새것\ntitle: 새 제목\nstatus: draft\n"),
            "{patched}"
        );
        assert!(patched.ends_with("x_sawhorse:\n  legacy_id: DOC-8\n"));
    }

    #[test]
    fn unknown_key_patch_appends_at_end() {
        let original =
            "format: pdc-document/1\nbody: pdc-djot/1\nid: x\ncreated: c\nupdated: u\ntitle: t\n";
        let patched = patch_envelope(
            original,
            &[(
                "deleted".into(),
                Some(vec!["deleted: true".into(), "deleted_at: d".into()]),
            )],
            Grammar::V1,
        )
        .unwrap();
        assert!(
            patched.contains("title: t\ndeleted: true\ndeleted_at: d\n"),
            "{patched}"
        );
    }
}
