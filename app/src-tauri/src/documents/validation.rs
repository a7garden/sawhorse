//! shdoc/1 문서 검증 — 표시·편집 허용 여부 판정 (v2 설계 §5 계약 표).
//!
//! 검사는 전달받은 문서 구조(`ShdocDocument`)를 신뢰하지 않고 원문 `text`를
//! html5ever로 다시 파싱해 수행한다. 원문은 신뢰할 수 없는 입력이다.

use std::collections::HashSet;

use super::codec::{
    attr_value, element_attrs, element_local_name, head_meta, max_element_depth, parse_dom,
    walk_elements, SHDOC_MAX_BYTES,
};
use super::model::{ShdocDocument, SHDOC_FORMAT_VERSION};

/// DOM 요소 중첩 깊이 상한. 이보다 깊은 문서는 표시·편집 대상으로 거부한다.
const MAX_DOM_DEPTH: usize = 256;

/// 검증 결과. `errors`가 비어 있어야 표시·편집 경로로 진입할 수 있다.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct ShdocValidation {
    /// 문서를 거부해야 하는 위반 목록.
    pub errors: Vec<String>,
    /// 거부까지는 아니지만 기록해야 할 사항 목록.
    pub warnings: Vec<String>,
}

/// shdoc/1 규칙(설계 §5 표)으로 문서를 검증한다.
///
/// - 금지 요소: `script`, `iframe`, `object`, `embed`, `base`, `form`,
///   외부 CSS/자원을 로드하는 `link` → 오류
/// - `on*` 이벤트 핸들러 속성, 인라인 `style` 속성 → 오류
/// - 외부 http(s) 자원: CSS/폰트 계열은 오류, `img` 등 미디어 `src`는 경고
/// - 중복 블록 ID, document-id 메타 누락·빈 값, format 메타 불일치 → 오류
/// - DOM 깊이 > 256 → 오류
pub fn validate(text: &str, doc: &ShdocDocument) -> ShdocValidation {
    let mut result = ShdocValidation::default();
    if text.len() > SHDOC_MAX_BYTES {
        result
            .errors
            .push("문서는 4 MiB를 넘을 수 없습니다".to_string());
        return result;
    }
    let dom = parse_dom(text);

    match head_meta(&dom, "sawhorse:format") {
        Some(value) if value.eq_ignore_ascii_case(SHDOC_FORMAT_VERSION) => {}
        _ => result
            .errors
            .push("sawhorse:format 메타가 shdoc/1이 아닙니다".to_string()),
    }
    match head_meta(&dom, "sawhorse:document-id") {
        Some(value) if !value.trim().is_empty() => {}
        _ => result
            .errors
            .push("sawhorse:document-id 메타가 누락되었거나 비어 있습니다".to_string()),
    }

    let mut forbidden: HashSet<String> = HashSet::new();
    let mut handlers: HashSet<String> = HashSet::new();
    let mut style_seen = false;
    walk_elements(&dom.document, &mut |element| {
        let Some(local) = element_local_name(element) else {
            return;
        };
        if matches!(
            local.as_str(),
            "script" | "iframe" | "object" | "embed" | "base" | "form"
        ) {
            forbidden.insert(local.clone());
        }
        if local == "link" {
            let rel = attr_value(element, "rel")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let href = attr_value(element, "href").unwrap_or_default();
            let loads_css = rel.split_ascii_whitespace().any(|t| t == "stylesheet");
            if loads_css || is_external_url(&href) {
                result
                    .errors
                    .push("외부 CSS/자원을 로드하는 link 요소는 금지됩니다".to_string());
            }
        }
        let media = matches!(
            local.as_str(),
            "img" | "source" | "video" | "audio" | "track"
        );
        for (name, value) in element_attrs(element) {
            if name.starts_with("on") && name.len() > 2 {
                handlers.insert(name.clone());
            }
            if name == "style" {
                style_seen = true;
            }
            if media && matches!(name.as_str(), "src" | "poster") && is_external_url(&value) {
                result
                    .warnings
                    .push(format!("외부 미디어 참조입니다: {value}"));
            }
        }
    });
    for element in ["script", "iframe", "object", "embed", "base", "form"] {
        if forbidden.contains(element) {
            result
                .errors
                .push(format!("금지된 요소가 포함되어 있습니다: {element}"));
        }
    }
    for handler in &handlers {
        result
            .errors
            .push(format!("이벤트 핸들러 속성은 금지됩니다: {handler}"));
    }
    if style_seen {
        result
            .errors
            .push("인라인 style 속성은 금지됩니다".to_string());
    }

    let depth = max_element_depth(&dom.document);
    if depth > MAX_DOM_DEPTH {
        result.errors.push(format!(
            "DOM 깊이가 {MAX_DOM_DEPTH}을 초과했습니다 (현재 {depth})"
        ));
    }

    let mut seen_ids: HashSet<&str> = HashSet::new();
    for block in &doc.blocks {
        if !seen_ids.insert(block.block_id.as_str()) {
            result
                .errors
                .push(format!("중복 블록 ID가 있습니다: {}", block.block_id));
        }
    }

    result
}

/// 문서를 권한 있는 표시 경로에 올려도 안전한지 판정한다. 구조를 파싱할 수
/// 없거나 오류가 하나라도 있으면 거짓이다(경고는 표시 여부에 영향을 주지 않는다).
#[allow(dead_code)] // 프론트 표시 게이트 예비 — 현재는 HtmlDocumentView 조립이 진단을 제공한다.
pub fn is_safe_for_display(text: &str) -> bool {
    match super::codec::parse_native_html(text) {
        Ok(doc) => validate(text, &doc).errors.is_empty(),
        Err(_) => false,
    }
}

/// 값이 외부 http(s) 자원을 가리키는지 확인한다(스킴 대소문자 무시).
fn is_external_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 검증 테스트용 최소 정상 문서.
    fn base_fixture() -> String {
        [
            "<!doctype html>",
            "<html lang=\"ko\"><head>",
            "<meta charset=\"utf-8\">",
            "<meta name=\"sawhorse:format\" content=\"shdoc/1\">",
            "<meta name=\"sawhorse:document-id\" content=\"doc-validate\">",
            "<title>검증 대상</title>",
            "</head><body><main><article id=\"document\">",
            "<section id=\"b-one\" data-sh-kind=\"requirement\"><p>요구사항 본문</p></section>",
            "</article></main></body></html>",
        ]
        .join("\n")
    }

    #[test]
    fn 정상_문서는_오류_없음() {
        let text = base_fixture();
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result.errors.is_empty(), "오류: {:?}", result.errors);
        assert!(result.warnings.is_empty());
        assert!(is_safe_for_display(&text));
    }

    #[test]
    fn script_포함_문서_거부() {
        let text = base_fixture().replace("</article>", "<script>alert('x')</script></article>");
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result
            .errors
            .iter()
            .any(|e| e.contains("script") && e.contains("금지")));
        assert!(!is_safe_for_display(&text));
    }

    #[test]
    fn 중복_블록_id_거부() {
        let text = base_fixture().replace(
            "</article>",
            "<section id=\"b-one\"><p>같은 ID 재사용</p></section></article>",
        );
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        assert_eq!(doc.blocks.len(), 2);
        let result = validate(&text, &doc);
        assert!(result
            .errors
            .iter()
            .any(|e| e.contains("중복 블록 ID") && e.contains("b-one")));
    }

    #[test]
    fn 외부_css는_오류_외부_이미지는_경고() {
        let text = base_fixture()
            .replace(
                "<title>검증 대상</title>",
                "<link rel=\"stylesheet\" href=\"https://cdn.example.com/doc.css\">\
                 \n<title>검증 대상</title>",
            )
            .replace(
                "<p>요구사항 본문</p>",
                "<p>그림 <img src=\"https://cdn.example.com/f.png\" alt=\"외부\"> 참조</p>",
            );
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result.errors.iter().any(|e| e.contains("link")));
        assert!(result
            .warnings
            .iter()
            .any(|w| w.contains("https://cdn.example.com/f.png")));
        // 외부 이미지는 경로만으로는 표시를 막지 않는다.
        assert!(!result.errors.iter().any(|e| e.contains("img")));
        assert!(!is_safe_for_display(&text));
    }

    #[test]
    fn 이벤트_핸들러와_인라인_style_거부() {
        let text = base_fixture().replace(
            "<p>요구사항 본문</p>",
            "<p onclick=\"go()\" style=\"color:red\">본문</p>",
        );
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result
            .errors
            .iter()
            .any(|e| e.contains("이벤트 핸들러") && e.contains("onclick")));
        assert!(result.errors.iter().any(|e| e.contains("style")));
        assert!(!is_safe_for_display(&text));
    }

    #[test]
    fn document_id_누락_오류() {
        let text = base_fixture().replace(
            "<meta name=\"sawhorse:document-id\" content=\"doc-validate\">\n",
            "",
        );
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result.errors.iter().any(|e| e.contains("document-id")));
    }

    #[test]
    fn format_메타_불일치_오류() {
        // 원문은 shdoc/2인데 문서 구조가 shdoc/1을 주장하는 경우: 검증은 원문을 신뢰한다.
        let text = base_fixture().replace("content=\"shdoc/1\"", "content=\"shdoc/2\"");
        let doc = ShdocDocument {
            format_version: SHDOC_FORMAT_VERSION.to_string(),
            document_id: "doc-validate".to_string(),
            profile: None,
            lang: None,
            title: "검증 대상".to_string(),
            blocks: Vec::new(),
        };
        let result = validate(&text, &doc);
        assert!(result.errors.iter().any(|e| e.contains("sawhorse:format")));
        assert!(!is_safe_for_display(&text));
    }

    #[test]
    fn 깊이_초과_거부() {
        let mut text = base_fixture();
        let opening = "<div>".repeat(300);
        let closing = "</div>".repeat(300);
        text = text.replace(
            "</article>",
            &format!("{opening}깊은 중첩{closing}</article>"),
        );
        let doc = super::super::codec::parse_native_html(&text).expect("파싱 성공");
        let result = validate(&text, &doc);
        assert!(result
            .errors
            .iter()
            .any(|e| e.contains("DOM 깊이") && e.contains("초과")));
        assert!(!is_safe_for_display(&text));
    }
}
