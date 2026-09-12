//! HTML 산출물 저장 서비스 — shdoc/1 원문의 읽기·게이트 지원 (v2 설계 §5·§7).
//!
//! `sdlc.rs`의 `read_document`/`write_document_at`은 내용을 가리지 않으므로 HTML
//! 산출물도 같은 경로로 저장된다. 이 모듈은 HTML 전용 관심사만 담는다: 읽기 시
//! 파싱·검증 진단 제공, 게이트용 실질성 검사, 경로 형식 판별.

use std::path::Path;

use super::codec::{
    is_html_element, parse_dom, parse_native_html, source_digest, text_content, walk_elements,
    SHDOC_MAX_BYTES,
};
use super::model::ShdocDocument;
use super::validation::{validate, ShdocValidation};

/// HTML 산출물 읽기 결과. 원문을 보존하고 파싱·검증 진단을 곁들인다.
/// 파싱에 실패해도 원문은 돌려준다(원문 보존 원칙, 설계 §5 "미지원 구조").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HtmlDocument {
    /// 원문 bytes(UTF-8 문자열). 정본이다.
    pub html: String,
    /// 원문 bytes의 SHA-256 hex.
    pub source_digest: String,
    /// 파싱 성공 시 모델. 실패·미지원 구조면 `None`.
    pub parsed: Option<ShdocDocument>,
    /// 구조·안전성 검사 결과(원문 기준).
    pub validation: ShdocValidation,
}

/// HTML 산출물 경로인가(확장자 기준). 게이트·스캔의 형식 분기에 쓴다.
pub fn is_html_artifact_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

/// 경로의 HTML 산출물을 읽어 원문·digest·파싱·검증을 묶는다.
/// 파일이 없으면 Err. 읽기 성공 시 파싱 실패는 Err가 아니라 `parsed: None` +
/// `validation.errors`로 보고한다.
pub fn read_html_at(path: &Path) -> Result<HtmlDocument, String> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        format!(
            "HTML 문서 정보를 읽을 수 없습니다: {}: {error}",
            path.display()
        )
    })?;
    if metadata.len() > SHDOC_MAX_BYTES as u64 {
        return Err(format!(
            "HTML 문서는 4 MiB를 넘을 수 없습니다: {}",
            path.display()
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("HTML 문서를 읽을 수 없습니다: {}: {error}", path.display()))?;
    let html = String::from_utf8(bytes)
        .map_err(|_| format!("HTML 문서가 UTF-8이 아닙니다: {}", path.display()))?;
    let digest = source_digest(html.as_bytes());
    match parse_native_html(&html) {
        Ok(parsed) => {
            let validation = validate(&html, &parsed);
            Ok(HtmlDocument {
                html,
                source_digest: digest,
                parsed: Some(parsed),
                validation,
            })
        }
        Err(error) => {
            // 원문 보존 원칙: 파싱 실패는 원문을 버리는 이유가 되지 않는다.
            let mut validation = ShdocValidation::default();
            validation.errors.push(format!("HTML 파싱 실패: {error}"));
            Ok(HtmlDocument {
                html,
                source_digest: digest,
                parsed: None,
                validation,
            })
        }
    }
}

/// HTML 산출물의 게이트 실질성. 표시 가능한 텍스트(제목·문단·목록 항목 등)가
/// 있어야 true다. 태그·주석·공백만 있는 문서는 거짓. `sdlc::substantial`의
/// HTML 버전 — 프론트매터가 없고 주석이 `<!-- -->` 임을 감안해 태그를 벗긴
/// 뒤 텍스트 밀도를 검사한다.
pub fn substantial_html(html: &str) -> bool {
    let dom = parse_dom(html);
    // script/style은 원시 텍스트 요소라 요소 자손을 가지지 않으므로 모든 텍스트
    // 노드는 (a) script/style 내부 = 비가시, (b) 그 외 = 가시로 정확히 나뉜다.
    // 전체 텍스트의 비공백 문자 수에서 비가시 성분을 빼면 가시 텍스트의 밀도만
    // 남는다. 주석·doctype은 `text_content`가 수집하지 않는다.
    let mut invisible = 0usize;
    walk_elements(&dom.document, &mut |element| {
        if is_html_element(element, "script") || is_html_element(element, "style") {
            invisible += text_content(element)
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .count();
        }
    });
    text_content(&dom.document)
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .count()
        > invisible
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn tempdir(tag: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sawhorse-shdoc-svc-{tag}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    /// 정상 shdoc/1 문서. `extra_body`는 article 안에 추가 조각을 넣는다.
    fn shdoc_fixture(extra_body: &str) -> String {
        let mut html = String::from(
            "<!doctype html>\n<html lang=\"ko\">\n<head>\n  \
             <meta charset=\"utf-8\">\n  \
             <meta name=\"sawhorse:format\" content=\"shdoc/1\">\n  \
             <meta name=\"sawhorse:document-id\" content=\"doc-svc-001\">\n  \
             <title>서비스 테스트 문서</title>\n\
             </head>\n\
             <body><main><article id=\"document\">\n  \
             <h1>서비스 테스트 문서</h1>\n  \
             <section id=\"b-intro\" data-sh-kind=\"requirement\">\n    \
             <h2>소개</h2>\n    <p>본문 단락이다.</p>\n  \
             </section>\n",
        );
        html.push_str(extra_body);
        html.push_str("</article></main></body></html>\n");
        html
    }

    #[test]
    fn html_artifact_path_matches_html_and_htm_case_insensitively() {
        assert!(is_html_artifact_path(Path::new("doc.html")));
        assert!(is_html_artifact_path(Path::new("doc.HTML")));
        assert!(is_html_artifact_path(Path::new("doc.Htm")));
        assert!(is_html_artifact_path(Path::new("work/spec.htm")));
        assert!(!is_html_artifact_path(Path::new("doc.md")));
        assert!(!is_html_artifact_path(Path::new("doc.markdown")));
        assert!(!is_html_artifact_path(Path::new("noext")));
    }

    #[test]
    fn read_html_at_returns_parsed_document_with_digest_and_clean_validation() {
        let root = tempdir("read-ok");
        let path = root.join("doc.html");
        let html = shdoc_fixture("");
        fs::write(&path, &html).unwrap();

        let result = read_html_at(&path).unwrap();

        assert_eq!(result.html, html);
        assert_eq!(result.source_digest, source_digest(html.as_bytes()));
        let parsed = result.parsed.expect("정상 문서는 파싱에 성공한다");
        assert_eq!(parsed.document_id, "doc-svc-001");
        assert_eq!(parsed.title, "서비스 테스트 문서");
        assert!(parsed.blocks.iter().any(|b| b.block_id == "b-intro"));
        assert!(
            result.validation.errors.is_empty(),
            "{:?}",
            result.validation.errors
        );
    }

    #[test]
    fn read_html_at_keeps_parsed_model_but_flags_script() {
        let root = tempdir("read-script");
        let path = root.join("doc.html");
        fs::write(&path, shdoc_fixture("  <script>alert(1)</script>\n")).unwrap();

        let result = read_html_at(&path).unwrap();

        assert!(
            result.parsed.is_some(),
            "script은 검증 오류이지 파싱 실패가 아니다"
        );
        assert!(
            result
                .validation
                .errors
                .iter()
                .any(|error| error.contains("script")),
            "{:?}",
            result.validation.errors
        );
    }

    #[test]
    fn read_html_at_returns_err_for_missing_file() {
        let root = tempdir("read-missing");
        assert!(read_html_at(&root.join("없음.html")).is_err());
    }

    #[test]
    fn read_html_at_preserves_broken_original_with_parse_diagnostic() {
        let root = tempdir("read-broken");
        let path = root.join("broken.html");
        // sawhorse:format 메타가 없고 닫힌 태그(`</section</body>`)가 깨진 원문.
        let broken = "<!doctype html>\n<html lang=\"ko\">\n\
                      <head><title>깨진 문서</title></head>\n\
                      <body><section id=\"b\"><p>닫힌 태그가 깨진 원문</section</body></html>\n";
        fs::write(&path, broken).unwrap();

        let result = read_html_at(&path).unwrap();

        assert_eq!(
            result.html, broken,
            "파싱 실패 시에도 원문을 그대로 반환한다"
        );
        assert!(result.parsed.is_none());
        assert!(
            result
                .validation
                .errors
                .iter()
                .any(|error| error.starts_with("HTML 파싱 실패:")),
            "{:?}",
            result.validation.errors
        );
    }

    #[test]
    fn substantial_html_accepts_headings_and_paragraphs() {
        assert!(substantial_html(
            "<section><h2>제목</h2><p>본문</p></section>"
        ));
        // 가시 텍스트가 있으면 style 내부 텍스트가 섞여 있어도 참이다.
        assert!(substantial_html(
            "<style>body{}</style><main><p>가시 본문</p></main>"
        ));
    }

    #[test]
    fn substantial_html_rejects_comments_whitespace_and_raw_text_only() {
        assert!(!substantial_html("<p><!-- 주석 --></p>"));
        assert!(!substantial_html("<body>\n  <p>   </p>\n</body>"));
        assert!(!substantial_html("<style>body{}</style>"));
        assert!(!substantial_html("<script>alert(1)</script>"));
        assert!(!substantial_html(""));
    }
}
