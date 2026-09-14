//! 미리보기 — PDC-1.0 §11 · 공유 렌더 정책(`pdc-document-render-policy/2`).
//!
//! Djot은 생성 HTML을 정책 허용 목록으로 소독해 돌려준다(§11.2
//! sanitize-generated-html). HTML 프로필의 원본 보존 미리보기(§11.3)는 표시
//! 계층의 격리 프레임이 담당하며, 여기서는 정책 공통 규칙의 스킴 허용
//! 목록만 상수로 고정해 프론트와 하나의 출처로 쓴다. 이 모듈이 무엇을
//! 돌려주든 저장된 원본 바이트는 절대 다시 쓰이지 않는다(§10.2).

use std::collections::{HashMap, HashSet};

/// 정책 공통 허용 스킴(render-policy.json `common.allowedSchemes`).
pub const ALLOWED_SCHEMES: [&str; 4] = ["http", "https", "mailto", "pdc"];

/// `pdc-djot/1` 정책의 허용 요소(렌더 정책 profiles.pdc-djot/1). 미지 요소는
/// 내용을 남기고 벗겨지고(ammonia 기본), 금지 요소는 하위 트리째 사라진다.
const DJOT_ALLOWED_ELEMENTS: [&str; 37] = [
    "a",
    "blockquote",
    "br",
    "caption",
    "code",
    "del",
    "div",
    "em",
    "figcaption",
    "figure",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "ins",
    "li",
    "mark",
    "ol",
    "p",
    "pre",
    "section",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul",
];

const DJOT_BLOCKED_SUBTREES: [&str; 18] = [
    "applet", "audio", "base", "button", "embed", "form", "iframe", "input", "link", "meta",
    "object", "script", "select", "source", "style", "textarea", "track", "video",
];

/// `pdc-markdown/1` 본문을 렌더링하고 정책 허용 목록으로 소독한 HTML을
/// 돌려준다. 파서는 CommonMark 0.31.2 + GFM(표·취소선·작업 목록·autolink)에
/// Obsidian 위키 링크 호환을 더한 pulldown-cmark다(§6.1 기본 문법). GFM 작업
/// 목록 체크박스(`<input>`)는 렌더 정책이 금지하는 요소라 비활성 표기 문자로
/// 미리 바꾼다 — 소독 후에도 작업 상태가 읽힌다(§11.2).
pub fn markdown_preview(body: &str) -> Result<String, String> {
    let mut options = pulldown_cmark::Options::empty();
    options.insert(pulldown_cmark::Options::ENABLE_TABLES);
    options.insert(pulldown_cmark::Options::ENABLE_FOOTNOTES);
    options.insert(pulldown_cmark::Options::ENABLE_STRIKETHROUGH);
    options.insert(pulldown_cmark::Options::ENABLE_TASKLISTS);
    options.insert(pulldown_cmark::Options::ENABLE_GFM);
    options.insert(pulldown_cmark::Options::ENABLE_WIKILINKS);
    let parser = pulldown_cmark::Parser::new_ext(body, options);
    let mut generated = String::with_capacity(body.len() * 3 / 2);
    pulldown_cmark::html::push_html(&mut generated, parser);
    let generated = generated
        .replace(r#"<input disabled="" type="checkbox" checked=""/>"#, "☑ ")
        .replace(r#"<input disabled="" type="checkbox"/>"#, "☐ ");
    Ok(sanitize_djot_render(&generated))
}

/// v1 레거시 `pdc-djot/1` 본문의 읽기 전용 미리보기.
pub fn djot_preview(body: &str) -> Result<String, String> {
    let events = jotdown::Parser::new(body);
    let generated = jotdown::html::render_to_string(events)
        .replace(r#"<input disabled="" type="checkbox" checked=""/>"#, "☑ ")
        .replace(r#"<input disabled="" type="checkbox"/>"#, "☐ ");
    Ok(sanitize_djot_render(&generated))
}

fn sanitize_djot_render(html: &str) -> String {
    let allowed: HashSet<&str> = DJOT_ALLOWED_ELEMENTS.into_iter().collect();
    let mut tag_attributes: HashMap<&str, HashSet<&str>> = HashMap::new();
    tag_attributes.insert("a", HashSet::from(["href"]));
    tag_attributes.insert("img", HashSet::from(["alt", "src", "width", "height"]));
    tag_attributes.insert("ol", HashSet::from(["start", "type"]));
    tag_attributes.insert("td", HashSet::from(["colspan", "rowspan", "scope"]));
    tag_attributes.insert("th", HashSet::from(["colspan", "rowspan", "scope"]));
    let mut builder = ammonia::Builder::default();
    builder
        .tags(allowed)
        .generic_attributes(HashSet::from(["class", "id", "lang", "role", "title"]))
        .tag_attributes(tag_attributes)
        .generic_attribute_prefixes(HashSet::from(["data-pdc-", "data-x-", "aria-"]))
        .url_schemes(HashSet::from(ALLOWED_SCHEMES))
        .url_relative(ammonia::UrlRelative::PassThrough)
        .link_rel(None)
        .clean_content_tags(HashSet::from(DJOT_BLOCKED_SUBTREES));
    builder.clean(html).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdc::contract;

    #[test]
    fn renders_headings_paragraphs_and_task_markers() {
        let html = djot_preview("# 제목\n\n문단이다.\n\n- [ ] 할 일\n").unwrap();
        assert!(html.contains("<h1>제목</h1>"), "{html}");
        assert!(html.contains("문단이다."), "{html}");
        assert!(html.contains("☐"), "{html}");
        assert!(!html.contains("<input"), "{html}");
    }

    #[test]
    fn preserves_block_targets_and_pdc_links() {
        let html = djot_preview(
            "# 머리\n\n문단.{#b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32}\n\n[라벨](pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db)\n",
        )
        .unwrap();
        assert!(
            html.contains(r#"id="b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32""#),
            "{html}"
        );
        assert!(
            html.contains(r#"href="pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db""#),
            "{html}"
        );
    }

    #[test]
    fn raw_html_is_escaped_not_executed_or_dropped() {
        // jotdown은 raw HTML을 이스케이프해 내보낸다 — 실행 경로가 없고
        // 텍스트도 남는다. 소독은 그 위의 최종 방어선이다.
        let html = djot_preview("앞 <script>alert(1)</script> 뒤\n").unwrap();
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(html.contains("뒤"), "{html}");
    }

    #[test]
    fn block_level_raw_html_is_escaped_and_style_never_survives() {
        let html = djot_preview("<p style=\"x\">태그 문단</p>\n").unwrap();
        assert!(!html.contains("style=\"x\""), "{html}");
        assert!(html.contains("태그 문단"), "{html}");
    }

    #[test]
    fn strips_javascript_urls_but_keeps_https_images() {
        let html = djot_preview(
            "[나쁜](javascript:alert(1)) 링크\n\n![좋은](https://example.com/i.png)\n",
        )
        .unwrap();
        assert!(!html.contains("javascript:"), "{html}");
        assert!(
            html.contains(r#"src="https://example.com/i.png""#),
            "{html}"
        );
    }

    #[test]
    fn managed_asset_references_survive_sanitization() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let html = djot_preview(&format!(
            "![도표](pdc://asset/sha256/{digest}){{data-pdc-filename=\"diagram.png\"}}\n"
        ))
        .unwrap();
        assert!(
            html.contains(&contract::asset_uri(digest).unwrap()),
            "{html}"
        );
        assert!(html.contains("data-pdc-filename"), "{html}");
    }
}
