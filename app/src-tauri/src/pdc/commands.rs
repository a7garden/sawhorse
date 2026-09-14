//! PDC Tauri 명령 — Stage 2 문서 화면(에디터·목록·미리보기)의 백엔드 창구.
//!
//! 모든 명령은 공간 루트(`document_spaces::resolve_root`) 안에서만 동작하고
//! 원본 바이트 보존·예상 다이제스트 충돌·no-op 규칙은 [`super::writer`]가
//! 단일 출처로 책진다. 표면 진단 코드는 계약 §13 어휘를 쓴다.

use std::path::PathBuf;

use serde::Serialize;

use super::assets::AssetStored;
use super::preview;
use super::reader::{self, ReadDocument};
use super::transport::Outcome;
use super::writer::{self, Created, NewDocument, SaveOutcome, SavePatch, TransportKind};

fn vault_root() -> Result<PathBuf, String> {
    crate::sdlc::vault_root()
}

fn space_root(space_id: Option<&str>) -> Result<PathBuf, String> {
    crate::document_spaces::resolve_root(&vault_root()?, space_id)
}

// ---------- 스캔 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdcDocumentSummary {
    pub path: String,
    pub id: Option<String>,
    /// 봉투 제목 그대로(빈 제목은 빈 문자열).
    pub title: Option<String>,
    /// 폴백이 적용된 표시 제목(§5.1 — 첫 H1 → 파일 이름 줄기).
    pub display_title: String,
    pub updated: Option<String>,
    pub created: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub favorite: bool,
    pub deleted: bool,
    pub body_profile: Option<String>,
    /// 계약 §13 진단 코드 — `valid`, `legacy_document_version`,
    /// `legacy_markdown`, `legacy_html`, `invalid_query` 등.
    pub code: String,
    pub message: Option<String>,
    /// v2 정문서만 이 경로로 편집할 수 있다 — v1·레거시·진단 문서는 표시 전용.
    pub editable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateIdGroup {
    pub id: String,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdcScan {
    pub documents: Vec<PdcDocumentSummary>,
    pub duplicate_ids: Vec<DuplicateIdGroup>,
}

#[tauri::command]
pub fn pdc_scan_documents(space_id: Option<String>) -> Result<PdcScan, String> {
    let scan = reader::scan_registered(&vault_root()?, space_id.as_deref())?;
    Ok(PdcScan {
        documents: scan.documents.iter().map(to_summary).collect(),
        duplicate_ids: scan
            .duplicate_ids
            .into_iter()
            .map(|(id, paths)| DuplicateIdGroup { id, paths })
            .collect(),
    })
}

fn to_summary(document: &ReadDocument) -> PdcDocumentSummary {
    let envelope = document.envelope.as_ref();
    let title = envelope
        .and_then(|env| env.text("title"))
        .map(str::to_string);
    let text_seq = |key: &str| -> Vec<String> {
        envelope
            .and_then(|env| env.get(key))
            .and_then(super::envelope::EnvValue::as_text_seq)
            .map(|items| items.into_iter().map(str::to_string).collect())
            .unwrap_or_default()
    };
    let flag = |key: &str| -> bool {
        envelope
            .and_then(|env| env.get(key))
            .and_then(super::envelope::EnvValue::as_flag)
            .unwrap_or(false)
    };
    PdcDocumentSummary {
        path: document.path.clone(),
        id: document.id().map(str::to_string),
        display_title: display_title(document),
        title,
        created: envelope
            .and_then(|env| env.text("created"))
            .map(str::to_string),
        updated: envelope
            .and_then(|env| env.text("updated"))
            .map(str::to_string),
        tags: text_seq("tags"),
        aliases: text_seq("aliases"),
        favorite: flag("favorite"),
        deleted: flag("deleted"),
        body_profile: envelope
            .and_then(|env| env.text("body"))
            .map(str::to_string),
        code: surface_code(document),
        message: diagnostic_message(&document.outcome),
        editable: is_canonical_v2(document),
    }
}

/// 표시 계약의 진단 코드(§13). 코퍼스 어휘의 `legacy_valid`는 앱 표면에서
/// `legacy_document_version`으로 노출된다.
fn surface_code(document: &ReadDocument) -> String {
    match document.outcome {
        Outcome::Valid => match document.format() {
            Some(super::contract::DOCUMENT_FORMAT_V2) => "valid".into(),
            _ => "legacy_document_version".into(),
        },
        ref outcome => outcome.code().to_string(),
    }
}

/// v2 정문서만 편집 가능하다 — v1·레거시·진단 문서는 읽기 전용이다(§14).
fn is_canonical_v2(document: &ReadDocument) -> bool {
    document.outcome == Outcome::Valid
        && document.format() == Some(super::contract::DOCUMENT_FORMAT_V2)
}

/// 표시 제목 폴백(§5.1): 빈 제목이면 첫 수준-1 표제의 평문, 그다음 파일
/// 이름 줄기. HTML은 `<h1>` → `<title>` → 줄기 순서다.
fn display_title(document: &ReadDocument) -> String {
    let stem = document
        .path
        .rsplit('/')
        .next()
        .unwrap_or(&document.path)
        .trim_end_matches(".djot")
        .trim_end_matches(".html")
        .trim_end_matches(".md")
        .to_string();
    let envelope_title = document
        .envelope
        .as_ref()
        .and_then(|env| env.text("title"))
        .unwrap_or("");
    if !envelope_title.trim().is_empty() {
        return envelope_title.to_string();
    }
    let body = String::from_utf8_lossy(document.body());
    if document.outcome == Outcome::LegacyMarkdown {
        return first_h1_djot(&body).unwrap_or(stem);
    }
    match document.envelope.as_ref().and_then(|env| env.text("body")) {
        Some(profile) if profile.starts_with("pdc-markdown") || profile.starts_with("pdc-djot") => {
            first_h1_djot(&body).unwrap_or(stem)
        }
        Some(profile) if profile.starts_with("pdc-html") => first_tag_text(&body, "h1")
            .or_else(|| first_tag_text(&body, "title"))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(stem),
        _ => stem,
    }
}

/// 첫 수준-1 ATX 표제의 평문 — Markdown과 Djot이 같은 `# ` 문양을 쓴다.
fn first_h1_djot(body: &str) -> Option<String> {
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let rest = rest.trim();
            // 표제 줄 뒤의 블록 속성 `{#... .class}`와 caret 표적은 표시
            // 텍스트가 아니다.
            let cut = rest.find(['{', '^']).unwrap_or(rest.len());
            let text = rest[..cut].trim_end();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

/// 첫 `<tag ...>내용</tag>`의 태그 벗긴 내용. 대소문자 무시, 중첩 없음 가정의
/// 표시용 근사다.
fn first_tag_text(body: &str, tag: &str) -> Option<String> {
    let lower = body.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = lower.find(&open)?;
    let after_open = lower[start..].find('>')? + start + 1;
    let close = lower[after_open..].find(&format!("</{tag}"))? + after_open;
    let inner = body.get(after_open..close)?;
    let mut text = String::new();
    let mut in_tag = false;
    for c in inner.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => text.push(c),
            _ => {}
        }
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(text).filter(|value| !value.is_empty())
}

fn diagnostic_message(outcome: &Outcome) -> Option<String> {
    match outcome {
        Outcome::Valid
        | Outcome::LegacyValid
        | Outcome::LegacyHtml
        | Outcome::LegacyMarkdown
        | Outcome::ValidUnexecuted
        | Outcome::InvalidDocumentId => None,
        Outcome::UnsupportedDocumentVersion(version) => Some(format!(
            "미지원 주요 버전의 문서다: {version} — 읽기 전용 레거시다"
        )),
        Outcome::InvalidQuery(reason) => Some(format!("질의가 부적절하다: {reason}")),
        Outcome::InvalidTransport(reason)
        | Outcome::InvalidEnvelope(reason)
        | Outcome::UnsupportedBodyVersion(reason) => Some(reason.clone()),
        Outcome::UnsafeContent(constructs) => Some(constructs.join("; ")),
        Outcome::DuplicateBlockId => Some("같은 블록 표적 ID가 두 번 나온다".into()),
        Outcome::DocumentTooLarge => Some("문서는 4 MiB를 넘을 수 없다".into()),
        Outcome::DocumentTooComplex => Some("중첩·노드 상한을 넘는다".into()),
    }
}

// ---------- 읽기 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdcEnvelopeView {
    pub id: String,
    pub title: String,
    pub created: String,
    pub updated: String,
    pub profile: Option<String>,
    pub lang: Option<String>,
    pub tags: Vec<String>,
    pub aliases: Vec<String>,
    pub favorite: bool,
    pub deleted: bool,
    pub deleted_at: Option<String>,
    pub body_profile: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdcDocumentView {
    pub path: String,
    /// 원문 전체 — 원본 보존의 증거이자 표시 전용 소스 뷰의 내용이다.
    pub source: String,
    pub digest: String,
    /// 본문 바이트(이송 추출 성공 시). 레거시 항목은 원문 전체다.
    pub body: String,
    pub envelope: Option<PdcEnvelopeView>,
    pub code: String,
    pub message: Option<String>,
    pub editable: bool,
}

#[tauri::command]
pub fn pdc_read_document(
    space_id: Option<String>,
    path: String,
) -> Result<PdcDocumentView, String> {
    let root = space_root(space_id.as_deref())?;
    let extension = writer::extension_of(&path)?;
    let absolute = writer::resolve_relative(&root, &path)?;
    let bytes = std::fs::read(&absolute).map_err(|e| {
        format!(
            "not-found: 문서를 읽을 수 없다({}): {e}",
            absolute.display()
        )
    })?;
    let digest = writer::sha256_hex(&bytes);
    let document = reader::read_document(extension, bytes.clone());
    let whole_file = matches!(
        document.outcome,
        Outcome::LegacyHtml | Outcome::LegacyMarkdown
    ) || document.body_range == (0, bytes.len());
    let extraction_failed = document.body_range == (bytes.len(), bytes.len());
    let body = if extraction_failed && !whole_file {
        // 이송 추출 실패 — 본문 범위가 없다.
        String::new()
    } else if whole_file || document.body_range.1 == 0 {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        String::from_utf8_lossy(document.body()).into_owned()
    };
    let envelope = document.envelope.as_ref().map(|env| PdcEnvelopeView {
        id: env.text("id").unwrap_or_default().to_string(),
        title: env.text("title").unwrap_or_default().to_string(),
        created: env.text("created").unwrap_or_default().to_string(),
        updated: env.text("updated").unwrap_or_default().to_string(),
        profile: env.text("profile").map(str::to_string),
        lang: env.text("lang").map(str::to_string),
        tags: text_seq_view(env.get("tags")),
        aliases: text_seq_view(env.get("aliases")),
        favorite: env
            .get("favorite")
            .and_then(super::envelope::EnvValue::as_flag)
            .unwrap_or(false),
        deleted: env
            .get("deleted")
            .and_then(super::envelope::EnvValue::as_flag)
            .unwrap_or(false),
        deleted_at: env.text("deleted_at").map(str::to_string),
        body_profile: env.text("body").unwrap_or_default().to_string(),
    });
    Ok(PdcDocumentView {
        path,
        source: String::from_utf8_lossy(&bytes).into_owned(),
        digest,
        body,
        envelope,
        code: surface_code(&document),
        message: diagnostic_message(&document.outcome),
        editable: is_canonical_v2(&document),
    })
}

fn text_seq_view(value: Option<&super::envelope::EnvValue>) -> Vec<String> {
    value
        .and_then(super::envelope::EnvValue::as_text_seq)
        .map(|items| items.into_iter().map(str::to_string).collect())
        .unwrap_or_default()
}

// ---------- 생성·저장·이동 ----------

#[tauri::command]
pub fn pdc_create_document(
    space_id: Option<String>,
    dir: String,
    stem: String,
    transport: String,
    title: String,
    body: String,
    tags: Option<Vec<String>>,
    aliases: Option<Vec<String>>,
) -> Result<Created, String> {
    let kind = TransportKind::from_creatable_extension(&transport)?;
    writer::create_document(
        &space_root(space_id.as_deref())?,
        &dir,
        &stem,
        kind,
        &NewDocument {
            title,
            body,
            tags: tags.unwrap_or_default(),
            aliases: aliases.unwrap_or_default(),
            ..NewDocument::default()
        },
    )
}

#[tauri::command]
pub fn pdc_save_document(
    space_id: Option<String>,
    path: String,
    expected_digest: String,
    patch: SavePatch,
) -> Result<SaveOutcome, String> {
    let root = space_root(space_id.as_deref())?;
    // v1·레거시 문서는 문서 화면에서 읽기 전용이다(§14 — 자동 변환 금지).
    let extension = writer::extension_of(&path)?;
    let absolute = writer::resolve_relative(&root, &path)?;
    let bytes = std::fs::read(&absolute).map_err(|e| {
        format!(
            "not-found: 문서를 읽을 수 없다({}): {e}",
            absolute.display()
        )
    })?;
    let document = reader::read_document(extension, bytes);
    if document.outcome == Outcome::LegacyValid {
        return Err(
            "legacy_document_version: pdc-document/1 문서는 읽기 전용 레거시다 — 편집은 \
             명시적 사용자 승인 변환(§14)만 가능하다"
                .into(),
        );
    }
    writer::save_document(&root, &path, &expected_digest, &patch)
}

#[tauri::command]
pub fn pdc_move_document(
    space_id: Option<String>,
    from: String,
    to: String,
    expected_digest: String,
) -> Result<(), String> {
    writer::move_document(
        &space_root(space_id.as_deref())?,
        &from,
        &to,
        &expected_digest,
    )
}

// ---------- 미리보기 ----------

/// Markdown 본문을 렌더·소독해 돌려준다(v2 정문서 기본 프로필). 자산 URI
/// (`pdc://asset/sha256/…`)는 플랫폼별 호스트 프로토콜 치환과 함께 프론트
/// 샌드박스가 처리한다(§11.2).
#[tauri::command]
pub fn pdc_preview_markdown(body: String) -> Result<String, String> {
    preview::markdown_preview(&body)
}

/// v1 레거시 Djot 본문의 읽기 전용 미리보기.
#[tauri::command]
pub fn pdc_preview_djot(body: String) -> Result<String, String> {
    preview::djot_preview(&body)
}

// ---------- 자산 ----------

#[tauri::command]
pub fn pdc_add_asset(
    space_id: Option<String>,
    bytes: Vec<u8>,
    filename: Option<String>,
    media_type: Option<String>,
) -> Result<AssetStored, String> {
    assets::add_asset(
        &space_root(space_id.as_deref())?,
        bytes,
        filename,
        media_type,
    )
}

#[tauri::command]
pub fn pdc_load_asset(
    space_id: Option<String>,
    digest: String,
) -> Result<(Vec<u8>, String), String> {
    let root = space_root(space_id.as_deref())?;
    let (bytes, media) = assets::load_asset(&root, &digest)?;
    Ok((bytes, media.to_string()))
}

use super::assets;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_fallbacks_follow_profile_order() {
        assert_eq!(
            first_h1_djot("```js\n# 가짜\n```\n\n# 진짜 {#b-x}\n").as_deref(),
            Some("진짜")
        );
        assert_eq!(
            first_h1_djot("# 제목 ^b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32\n").as_deref(),
            Some("제목")
        );
        assert_eq!(
            first_tag_text("<article><h1>표제</h1><p>본문</p></article>", "h1").as_deref(),
            Some("표제")
        );
        assert_eq!(
            first_tag_text(
                "<html><head><title>문서 제목</title></head></html>",
                "title"
            )
            .as_deref(),
            Some("문서 제목")
        );
    }
}
