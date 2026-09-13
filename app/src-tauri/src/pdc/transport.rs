//! 이송 형식 봉투 추출 — PDC-1.0 §4 (Stage 1 판독기).
//!
//! Djot(`---` 봉투)과 HTML(`<!--` 주석 래핑 봉투) 두 이송에서 봉투 바이트
//! 범위와 본문 바이트 범위를 원문에서 잘라낸다. 원문 바이트는 절대 다시
//! 쓰이지 않는다 — 모든 오프셋은 원본 바이트 기준이다. CRLF는 봉투 해석에만
//! LF로 정규화한다(§4.1)고 본문에는 손대지 않는다.
//!
//! 진단 코드는 적합성 말뭉치의 기대 어휘를 그대로 쓴다: `invalid_transport`,
//! `document_too_large` 등.

#![allow(dead_code)] // Stage 1 판독기 — Stage 2 작성기·Stage 3 importer가 소비한다.

use super::contract;

/// 판독 결과의 기계 판독 코드. 적합성 말뭉치 `expect` 어휘와 1:1이다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 적합한 정문서.
    Valid,
    /// 봉투 없는 표시 가능 레거시 HTML(§4.3) — 잘못됨이 아니라 레거시다.
    LegacyHtml,
    /// 이송 위반(봉투 없음·프로필 불일치·BOM·조기 주석 닫기 등).
    InvalidTransport(String),
    /// 미지 주요 버전의 바디 프로필(§2) — malformed가 아니라 미지원.
    UnsupportedBodyVersion(String),
    /// 정칙이 아닌 문서 ID(§7.1).
    InvalidDocumentId,
    /// 봉투 문법·필수 필드 위반(§5).
    InvalidEnvelope(String),
    /// 실행 가능·안전하지 않은 구조(§6) — 원본 보존, 안전한 표시만 허용.
    UnsafeContent(Vec<String>),
    /// 한 문서 안의 중복 `b-<uuid>` 표적(§7.2).
    DuplicateBlockId,
    /// 4 MiB 초과(§4.1).
    DocumentTooLarge,
    /// 중첩 깊이 256 초과(§4.2/§4.3).
    DocumentTooComplex,
}

impl Outcome {
    /// 말뭉치 `expect` 어휘와 일치하는 코드.
    pub fn code(&self) -> &'static str {
        match self {
            Outcome::Valid => "valid",
            Outcome::LegacyHtml => "legacy_html",
            Outcome::InvalidTransport(_) => "invalid_transport",
            Outcome::UnsupportedBodyVersion(_) => "unsupported_body_version",
            Outcome::InvalidDocumentId => "invalid_document_id",
            Outcome::InvalidEnvelope(_) => "invalid_envelope",
            Outcome::UnsafeContent(_) => "unsafe_content",
            Outcome::DuplicateBlockId => "duplicate_block_id",
            Outcome::DocumentTooLarge => "document_too_large",
            Outcome::DocumentTooComplex => "document_too_complex",
        }
    }
}

/// 추출 성공물: 봉투 YAML 바이트 범위, 본문 바이트 범위, 본문 프로필.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Transport {
    /// 본문 프로필 식별자(봉투 `body` 값).
    pub body_profile: String,
    /// 원본 바이트에서 봉투 YAML이 차지하는 범위(`---` 경계선 제외).
    pub envelope_range: (usize, usize),
    /// 원본 바이트에서 본문이 차지하는 범위(봉투 닫음 다음 줄부터).
    pub body_range: (usize, usize),
}

/// 이송 추출의 판정: 성공은 [`Transport`], 실패는 [`Outcome`] 진단.
pub type Extracted = Result<Transport, Outcome>;

/// 파일 전체 크기 상한(§4.1: 봉투와 본문을 합해 4 MiB).
pub fn size_ok(len: usize) -> bool {
    len <= contract::DOCUMENT_MAX_BYTES as usize
}

/// UTF-8 BOM은 이송 위반이다(§4.1 — 조용히 떼어내지 않는다).
pub fn has_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xEF, 0xBB, 0xBF])
}

/// 원본 바이트를 줄 단위 `(시작, 끝)` 범위로 나눈다. 끝은 줄바꿈 포함.
/// `\r\n`과 `\n` 모두 줄바꿈이고 마지막 줄은 줄바꿈이 없을 수 있다.
fn line_ranges(bytes: &[u8]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0usize;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < bytes.len() {
        ranges.push((start, bytes.len()));
    }
    ranges
}

/// 줄 내용을 `\r` 제거해 LF 정규화한 뷰를 돌려준다(봉투 해석 전용).
fn line_text(bytes: &[u8], range: (usize, usize)) -> Vec<u8> {
    let mut end = range.1;
    while end > range.0 && (bytes[end - 1] == b'\n' || bytes[end - 1] == b'\r') {
        end -= 1;
    }
    bytes[range.0..end].to_vec()
}

fn is_line(bytes: &[u8], range: (usize, usize), expected: &[u8]) -> bool {
    line_text(bytes, range) == expected
}

/// Djot 이송(§4.2): 첫 줄이 정확히 `---`이고 그다음 정확한 `---` 줄이 닫는다.
fn extract_djot(bytes: &[u8]) -> Extracted {
    let lines = line_ranges(bytes);
    let first = lines
        .first()
        .copied()
        .ok_or_else(|| Outcome::InvalidTransport("빈 문서".into()))?;
    if !is_line(bytes, first, b"---") {
        return Err(Outcome::InvalidTransport(
            "첫 줄이 `---` 봉투가 아니다(봉투 없는 Djot은 이송 위반이다)".into(),
        ));
    }
    let mut close = None;
    for range in lines.iter().skip(1) {
        if is_line(bytes, *range, b"---") {
            close = Some(*range);
            break;
        }
    }
    let Some(close) = close else {
        return Err(Outcome::InvalidTransport("봉투가 닫히지 않았다".into()));
    };
    Ok(Transport {
        body_profile: String::new(), // envelope.rs가 채워 검증한다.
        envelope_range: (first.1, close.0),
        body_range: (close.1, bytes.len()),
    })
}

/// HTML 이송(§4.3): `<!--` / `---` / 봉투 / `---` / `-->`의 정확한 줄 배열.
/// 첫두 줄이 이송 문양이 아닌 파일은 [`extract_html_or_legacy`]에서 레거시로
/// 분류되므로 여기서는 문양이 있다고 가정하고 구조만 검증한다.
fn extract_html(bytes: &[u8]) -> Extracted {
    let lines = line_ranges(bytes);
    if lines.len() < 2 {
        return Err(Outcome::InvalidTransport("HTML 봉투가 잘렸다".into()));
    }
    let mut close_index = None;
    for index in 2..lines.len() {
        if is_line(bytes, lines[index], b"---") {
            close_index = Some(index);
            break;
        }
    }
    let Some(close_index) = close_index else {
        return Err(Outcome::InvalidTransport("HTML 봉투가 닫히지 않았다".into()));
    };
    // 닫는 `---` 바로 다음 줄이 정확히 `-->`여야 한다.
    match lines.get(close_index + 1) {
        Some(range) if is_line(bytes, *range, b"-->") => {}
        _ => {
            return Err(Outcome::InvalidTransport(
                "봉투 닫음 다음에 `-->` 줄이 없다".into(),
            ))
        }
    }
    // 봉투 내부에 조기 주석 닫기(`-->`, `--!>`)가 있으면 브라우저가 봉투를
    // 먼저 끝내므로 이송 위반이다(§4.3).
    let envelope_start = lines[2].0;
    let envelope_end = lines[close_index].0;
    let envelope = &bytes[envelope_start..envelope_end];
    for marker in [b"-->".as_slice(), b"--!>".as_slice()] {
        if find_subslice(envelope, marker).is_some() {
            return Err(Outcome::InvalidTransport(
                "봉투 안에 조기 주석 닫기(`-->`)가 있다".into(),
            ));
        }
    }
    Ok(Transport {
        body_profile: String::new(),
        envelope_range: (envelope_start, envelope_end),
        body_range: (lines[close_index + 1].1, bytes.len()),
    })
}

/// HTML 파일이 PDC 이송인지 — 아니면 표시 가능 레거시 HTML인지(§4.3).
/// 레거시는 malformed가 아니라 별도로 표시 가능한 항목이다.
fn extract_html_or_legacy(bytes: &[u8]) -> Extracted {
    let lines = line_ranges(bytes);
    let opener =
        lines.len() >= 2 && is_line(bytes, lines[0], b"<!--") && is_line(bytes, lines[1], b"---");
    if !opener {
        return Err(Outcome::LegacyHtml);
    }
    extract_html(bytes)
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&index| &haystack[index..index + needle.len()] == needle)
}


/// 확장자로 이송을 골라 봉투를 추출한다. HTML은 봉투 문양이 없으면
/// [`Outcome::LegacyHtml`]로 돌아간다(§4.3 — 레거시는 표시 가능 항목이다).
pub fn extract(extension: &str, bytes: &[u8]) -> Extracted {
    if has_bom(bytes) {
        return Err(Outcome::InvalidTransport("UTF-8 BOM이 있다".into()));
    }
    if !size_ok(bytes.len()) {
        return Err(Outcome::DocumentTooLarge);
    }
    match extension {
        "djot" => extract_djot(bytes),
        "html" => extract_html_or_legacy(bytes),
        other => Err(Outcome::InvalidTransport(format!(
            "알 수 없는 이송 확장자: {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL_DJOT: &str = "---\nformat: pdc-document/1\nbody: pdc-djot/1\n---\n# Body\n";
    const MINIMAL_HTML: &str = "<!--\n---\nformat: pdc-document/1\n---\n-->\n<h1>Body</h1>\n";

    #[test]
    fn djot_envelope_and_body_ranges_split_cleanly() {
        let transport = extract("djot", MINIMAL_DJOT.as_bytes()).unwrap();
        let envelope = &MINIMAL_DJOT.as_bytes()[transport.envelope_range.0..transport.envelope_range.1];
        let body = &MINIMAL_DJOT.as_bytes()[transport.body_range.0..transport.body_range.1];
        assert_eq!(envelope, b"format: pdc-document/1\nbody: pdc-djot/1\n");
        assert_eq!(body, b"# Body\n");
    }

    #[test]
    fn html_envelope_excludes_comment_wrapper() {
        let transport = extract("html", MINIMAL_HTML.as_bytes()).unwrap();
        let envelope = &MINIMAL_HTML.as_bytes()[transport.envelope_range.0..transport.envelope_range.1];
        let body = &MINIMAL_HTML.as_bytes()[transport.body_range.0..transport.body_range.1];
        assert_eq!(envelope, b"format: pdc-document/1\n");
        assert_eq!(body, b"<h1>Body</h1>\n");
    }

    #[test]
    fn crlf_is_normalized_for_envelope_only() {
        let crlf = "<!--\r\n---\r\nformat: pdc-document/1\r\n---\r\n-->\r\n<p>body</p>\r\n";
        let transport = extract("html", crlf.as_bytes()).unwrap();
        let body = &crlf.as_bytes()[transport.body_range.0..transport.body_range.1];
        // 본문 bytes는 원본 그대로다 — 정규화는 봉투 해석에만 적용된다.
        assert_eq!(body, b"<p>body</p>\r\n");
    }

    #[test]
    fn djot_without_envelope_is_invalid_transport() {
        let outcome = extract("djot", b"# Not a PDC document\n").unwrap_err();
        assert_eq!(outcome.code(), "invalid_transport");
    }

    #[test]
    fn unclosed_djot_envelope_is_invalid_transport() {
        let outcome = extract("djot", b"---\nformat: x\n").unwrap_err();
        assert_eq!(outcome.code(), "invalid_transport");
    }

    #[test]
    fn html_without_transport_marker_is_legacy() {
        let outcome = extract("html", b"<!doctype html>\n<html></html>\n").unwrap_err();
        assert_eq!(outcome.code(), "legacy_html");
    }

    #[test]
    fn unclosed_html_envelope_is_invalid_transport_not_legacy() {
        let bytes = b"<!--\n---\nformat: x\n<h1>never closes</h1>\n";
        let outcome = extract("html", bytes).unwrap_err();
        assert_eq!(outcome.code(), "invalid_transport");
    }

    #[test]
    fn premature_comment_close_inside_envelope_is_invalid_transport() {
        let bytes = b"<!--\n---\ntitle: premature --> close\n---\n-->\n<h1>x</h1>\n";
        let outcome = extract("html", bytes).unwrap_err();
        assert_eq!(outcome.code(), "invalid_transport");
    }

    #[test]
    fn bom_is_invalid_transport() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(MINIMAL_DJOT.as_bytes());
        assert_eq!(extract("djot", &bytes).unwrap_err().code(), "invalid_transport");
    }

    #[test]
    fn oversized_document_is_too_large() {
        let big = vec![b'x'; contract::DOCUMENT_MAX_BYTES as usize + 1];
        assert_eq!(extract("djot", &big).unwrap_err().code(), "document_too_large");
    }

    #[test]
    fn unknown_extension_is_invalid_transport() {
        assert_eq!(extract("md", b"---\n---\n").unwrap_err().code(), "invalid_transport");
    }
}
