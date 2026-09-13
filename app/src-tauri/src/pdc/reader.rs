//! 문서 발견과 판독 진단 — PDC-1.0 §3.2·§6 (Stage 1 Full Reader).
//!
//! 등록된 문서 공간 루트 아래의 `.djot`과 `.html`을 재귀로 발견하고, 각 파일을
//! 이송 추출 → 봉투 해석 → 의미 검증 → 안전성 검사 순으로 판독한다. 원본
//! 바이트는 언제나 그대로 보존되며 판독은 절대 쓰기를 하지 않는다(Stage 1은
//! 읽기 전용이다). 레거시 HTML과 미지원 문서는 사라지지 않고 눈에 보이는
//! 진단으로 돌아온다(§1 호환성 약속).
//!
//! 발견 규칙(§3.2): 점 접두 구성요소(`.pdc`, `.git`, `.sawhorse` …)는
//! 건너뛰고, 심볼릭 링크는 따라가지 않고, 파일 순서가 결과에 영향을 주지
//! 않는다(경로 정렬로 결정성 보장).

#![allow(dead_code)] // Stage 1 판독기 — Stage 2 작성기·문서 화면이 소비한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::contract;
use super::envelope::{self, Envelope};
use super::transport::{self, Outcome};

/// 판독한 파일 하나. `source`는 디스크의 원본 바이트와 항상 동일하다.
#[derive(Clone, Debug)]
pub struct ReadDocument {
    /// 공간 루트 기준 상대 경로(`/` 구분).
    pub path: String,
    /// 원본 바이트 — 판독 후에도 디스크 내용과 바이트 동일이다.
    pub source: Vec<u8>,
    /// 본문 바이트 범위(원본 기준).
    pub body_range: (usize, usize),
    /// 검증을 통과한 봉투. 진단 실패 시 `None`.
    pub envelope: Option<Envelope>,
    pub outcome: Outcome,
}

impl ReadDocument {
    /// 원본의 본문 바이트.
    pub fn body(&self) -> &[u8] {
        &self.source[self.body_range.0..self.body_range.1]
    }

    /// 정칙 문서 ID — 봉투 검증을 통과한 문서에만 있다.
    pub fn id(&self) -> Option<&str> {
        self.envelope.as_ref().and_then(|env| env.text("id"))
    }
}

/// 공간 하나의 판독 결과.
#[derive(Clone, Debug, Default)]
pub struct VaultScan {
    /// 경로순으로 정렬된 판독물.
    pub documents: Vec<ReadDocument>,
    /// 정칙 ID가 여러 경로에서 나타나는 군(§3.2 — 승자를 골라선 안 된다).
    pub duplicate_ids: Vec<(String, Vec<String>)>,
}

/// 파일 하나를 판독한다. 발견·코퍼스 시험 모두 이 입구를 쓴다.
pub fn read_document(extension: &str, bytes: Vec<u8>) -> ReadDocument {
    let make = |body_range: (usize, usize),
                envelope: Option<Envelope>,
                outcome: Outcome| ReadDocument {
        path: String::new(),
        source: bytes.clone(),
        body_range,
        envelope,
        outcome,
    };
    let nowhere = (bytes.len(), bytes.len());
    if !transport::size_ok(bytes.len()) {
        return make(nowhere, None, Outcome::DocumentTooLarge);
    }
    let transport = match transport::extract(extension, &bytes) {
        Ok(transport) => transport,
        Err(outcome) => return make(nowhere, None, outcome),
    };
    let envelope_slice = &bytes[transport.envelope_range.0..transport.envelope_range.1];
    let envelope = match envelope::parse(envelope_slice) {
        Ok(envelope) => envelope,
        Err(outcome) => return make(transport.body_range, None, outcome),
    };
    if let Err(outcome) = envelope::validate(&envelope) {
        return make(transport.body_range, None, outcome);
    }
    // 바디 프로필과 확장자가 같은 이송이어야 한다(§4.2/§4.3).
    let expected_profile = match extension {
        "djot" => contract::TRANSPORT_DJOT,
        _ => contract::TRANSPORT_HTML,
    };
    if envelope.text("body") != Some(expected_profile) {
        return make(
            transport.body_range,
            Some(envelope),
            Outcome::InvalidTransport("body 프로필이 이송과 일치하지 않는다".into()),
        );
    }
    let body = &bytes[transport.body_range.0..transport.body_range.1];
    match extension {
        "djot" => {
            if let Some(constructs) = scan_djot_unsafe(body) {
                return make(transport.body_range, Some(envelope), Outcome::UnsafeContent(constructs));
            }
            if duplicate_block_id_djot(body) {
                return make(transport.body_range, Some(envelope), Outcome::DuplicateBlockId);
            }
            if djot_container_depth(body) > 256 {
                return make(transport.body_range, Some(envelope), Outcome::DocumentTooComplex);
            }
        }
        "html" => {
            let report = scan_html(body);
            if !report.unsafe_constructs.is_empty() {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::UnsafeContent(report.unsafe_constructs),
                );
            }
            if duplicate_block_id_html(body) {
                return make(transport.body_range, Some(envelope), Outcome::DuplicateBlockId);
            }
            if report.max_depth > 256 {
                return make(transport.body_range, Some(envelope), Outcome::DocumentTooComplex);
            }
        }
        _ => {}
    }
    make(transport.body_range, Some(envelope), Outcome::Valid)
}

/// 공간 루트를 재귀 발견해 전체를 판독한다(§3.2).
pub fn scan(root: &Path) -> Result<VaultScan, String> {
    let mut paths = Vec::new();
    collect_documents(root, root, &mut paths)?;
    paths.sort();
    let mut scan = VaultScan::default();
    let mut ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for relative in paths {
        let absolute = root.join(&relative);
        let metadata = std::fs::metadata(&absolute)
            .map_err(|e| format!("파일 정보 실패({}): {e}", absolute.display()))?;
        let extension = relative.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if !transport::size_ok(metadata.len() as usize) {
            // 내용을 읽지 않고도 판정되는 상한 위반(§4.1)이다.
            scan.documents.push(ReadDocument {
                path: relative,
                source: Vec::new(),
                body_range: (0, 0),
                envelope: None,
                outcome: Outcome::DocumentTooLarge,
            });
            continue;
        }
        let bytes =
            std::fs::read(&absolute).map_err(|e| format!("파일 읽기 실패({}): {e}", absolute.display()))?;
        let mut document = read_document(&extension, bytes);
        document.path = relative.clone();
        if let Some(id) = document.id() {
            ids.entry(id.to_string()).or_default().push(relative);
        }
        scan.documents.push(document);
    }
    scan.duplicate_ids = ids
        .into_iter()
        .filter(|(_, paths)| paths.len() > 1)
        .collect();
    Ok(scan)
}

/// 볼트 루트에서 등록된 문서 공간을 골라 판독한다.
pub fn scan_registered(vault_root: &Path, space_id: Option<&str>) -> Result<VaultScan, String> {
    let root = crate::document_spaces::resolve_root(vault_root, space_id)?;
    scan(&root)
}

fn collect_documents(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("디렉터리 읽기 실패({}): {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("항목 읽기 실패: {e}"))?;
        let file_type = entry.file_type().map_err(|e| format!("항목 유형 실패: {e}"))?;
        // 심볼릭 링크는 따라가지 않는다(§3.2).
        if file_type.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy().to_string();
        // 점 접두 구성요소는 발견에서 제외다(§3.2).
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_documents(root, &path, out)?;
        } else if name.ends_with(".djot") || name.ends_with(".html") {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "볼트 밖 경로다".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            out.push(relative);
        }
    }
    Ok(())
}

// ---------- 안전성·구조 검사 ----------

struct HtmlReport {
    unsafe_constructs: Vec<String>,
    max_depth: usize,
}

const VOID_ELEMENTS: [&str; 14] = [
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param",
    "source", "track", "wbr",
];

/// HTML 본문의 안전 구조 검사(§6.2)와 DOM 깊이 측정.
/// 판독기 수준의 근사 검사다 — 렌더 정책(§11)은 표시 계층이 별도로 적용한다.
fn scan_html(body: &[u8]) -> HtmlReport {
    let text = String::from_utf8_lossy(body);
    let lower = text.to_ascii_lowercase();
    let mut unsafe_constructs = Vec::new();
    let mut depth = 0usize;
    let mut max_depth = 0usize;
    let bytes = lower.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        // 주석은 '-->'까지 건너뛴다.
        if lower[index..].starts_with("<!--") {
            match lower[index + 4..].find("-->") {
                Some(close) => index += 4 + close + 3,
                None => break,
            }
            continue;
        }
        let Some(mut close) = lower[index..].find('>') else { break };
        close += index;
        let tag = &lower[index + 1..close];
        index = close + 1;
        let trimmed = tag.trim_start_matches('/');
        let element: String = trimmed.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        if element.is_empty() {
            continue;
        }
        if !trimmed.starts_with('/') {
            if matches!(element.as_str(), "script" | "base" | "embed" | "object" | "applet") {
                unsafe_constructs.push(format!("<{element}>"));
            }
            if element == "iframe" && !tag.contains("sandbox") {
                unsafe_constructs.push("<iframe>(sandbox 없음)".into());
            }
            if element == "meta" && tag.contains("http-equiv") && tag.contains("refresh") {
                unsafe_constructs.push("<meta refresh>".into());
            }
            for needle in ["javascript:", "vbscript:"] {
                if tag.contains(needle) {
                    unsafe_constructs.push(format!("{needle} URL"));
                }
            }
            // 인라인 이벤트 처리기: ` on<알파벳>=`
            let tag_bytes = tag.as_bytes();
            for window in 0..tag.len() {
                if tag_bytes[window..].starts_with(b" on") {
                    let rest = &tag[window + 3..];
                    let letters = rest.chars().take_while(|c| c.is_ascii_alphabetic()).count();
                    if letters > 0 && rest[letters..].starts_with('=') {
                        unsafe_constructs.push(format!("on{} 처리기", &rest[..letters]));
                        break;
                    }
                }
            }
            if !VOID_ELEMENTS.contains(&element.as_str()) && !tag.ends_with('/') {
                depth += 1;
                max_depth = max_depth.max(depth);
            }
        } else {
            depth = depth.saturating_sub(1);
        }
    }
    HtmlReport { unsafe_constructs, max_depth }
}

/// Djot 본문의 원문(raw) 구조 검사(§6.1 — raw 블록·인라인은 부적합이다).
fn scan_djot_unsafe(body: &[u8]) -> Option<Vec<String>> {
    let text = String::from_utf8_lossy(body);
    let mut constructs = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(info) = trimmed.strip_prefix("```") {
            if info.trim_start().starts_with("=html") {
                constructs.push("raw block (=html)".into());
            }
        }
    }
    if text.contains("{=html}") {
        constructs.push("raw inline ({=html})".into());
    }
    (!constructs.is_empty()).then_some(constructs)
}

/// Djot 블록 표적 `{#b-<uuid>}`의 중복 검사(§7.2). 표적 뒤에 클래스 등
/// 속성이 붙는 경우(`{#b-<uuid> .pdc-task}`, §9.1)에도 같은 ID로 비교해야
/// 하므로 토큰을 `}` 앞의 공백에서 끊는다.
fn duplicate_block_id_djot(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    let mut seen = std::collections::HashSet::new();
    let mut rest = &*text;
    while let Some(start) = rest.find("{#b-") {
        let after = &rest[start + 4..];
        let end = after.find(['}', ' ']).unwrap_or(after.len());
        if !seen.insert(after[..end].to_string()) {
            return true;
        }
        rest = &after[end..];
    }
    false
}

/// 블록 표적 ID의 중복 검사 — 같은 표적이 두 번 나오면 참이다(§7.2).
fn duplicate_block_ids_in(text: &str, open: &str, close: &str) -> bool {
    let mut seen = std::collections::HashSet::new();
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(close) else {
            break;
        };
        if !seen.insert(after[..end].to_string()) {
            return true;
        }
        rest = &after[end + close.len()..];
    }
    false
}

/// HTML 블록 표적 `id="b-<uuid>"`의 중복 검사.
fn duplicate_block_id_html(body: &[u8]) -> bool {
    let lower = String::from_utf8_lossy(body).to_ascii_lowercase();
    duplicate_block_ids_in(&lower, "id=\"b-", "\"") || duplicate_block_ids_in(&lower, "id='b-", "'")
}

/// Djot 열린 블록 컨테이너 최대 깊이 — 행 선두의 `>` 연속 수로 근사한다.
fn djot_container_depth(body: &[u8]) -> usize {
    String::from_utf8_lossy(body)
        .lines()
        .map(|line| line.bytes().take_while(|byte| *byte == b'>').count())
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corpus_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/pdc/conformance")
    }

    fn corpus() -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(corpus_dir().join("corpus.json")).unwrap())
            .unwrap()
    }

    fn read_case(relative: &str) -> ReadDocument {
        let path = corpus_dir().join(relative);
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let extension = relative.rsplit('.').next().unwrap();
        let mut document = read_document(extension, bytes);
        document.path = relative.to_string();
        document
    }

    #[test]
    fn corpus_revision_matches_the_pinned_contract() {
        let corpus = corpus();
        assert_eq!(corpus["revision"], serde_json::json!(contract::CORPUS_REVISION));
        assert_eq!(corpus["djotBaseline"], serde_json::json!(contract::DJOT_DIALECT_BASELINE));
        assert_eq!(corpus["bodyProfiles"][0], "pdc-djot/1");
    }

    #[test]
    fn corpus_file_cases_are_diagnosed_as_expected() {
        let mut covered = 0usize;
        for case in corpus()["cases"].as_array().unwrap() {
            if case["kind"] != "file" {
                continue;
            }
            let id = case["id"].as_str().unwrap();
            let path = case["path"].as_str().unwrap();
            let expected = case["expect"].as_str().unwrap();
            let outcome = read_case(path).outcome;
            assert_eq!(
                outcome.code(),
                expected,
                "{id}({path}): 기대 {expected}, 실제 {}({outcome:?})",
                outcome.code()
            );
            covered += 1;
        }
        assert_eq!(covered, 21, "파일 사례 전부를 소비해야 한다");
    }

    #[test]
    fn corpus_reader_operations_are_diagnosed_as_expected() {
        let minimal = std::fs::read(corpus_dir().join("fixtures/valid/minimal.djot")).unwrap();
        for case in corpus()["cases"].as_array().unwrap() {
            if case["kind"] != "operation" {
                continue;
            }
            let id = case["id"].as_str().unwrap();
            let operation = case["operation"].as_str().unwrap();
            let expected = case["expect"].as_str().unwrap();
            let outcome = match operation {
                "prefix-source-bytes" => {
                    let prefix = case["prefixHex"].as_str().unwrap();
                    let mut source: Vec<u8> = (0..prefix.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&prefix[i..i + 2], 16).unwrap())
                        .collect();
                    source.extend_from_slice(&minimal);
                    read_document("djot", source).outcome
                }
                "pad-body-to-total-bytes" => {
                    let total = case["totalBytes"].as_u64().unwrap() as usize;
                    let mut source = minimal.clone();
                    source.resize(total, b'\n');
                    read_document("djot", source).outcome
                }
                "replace-body-with-nested-block-quotes" => {
                    let depth = case["containerDepth"].as_u64().unwrap() as usize;
                    let mut source = minimal.clone();
                    for level in 1..=depth {
                        source.extend_from_slice(format!("{}\n", ">".repeat(level)).as_bytes());
                    }
                    read_document("djot", source).outcome
                }
                // 작성기(Stage 2) 사례 — Stage 1에서는 의도적으로 건너뛴다.
                "no-op-round-trip" | "metadata-patch" | "external-change-before-save" => continue,
                other => panic!(
                    "알 수 없는 코퍼스 동작: {other} — 코퍼스를 갱신했으면 시험도 갱신한다"
                ),
            };
            assert_eq!(outcome.code(), expected, "{id}: 기대 {expected}, 실제 {}", outcome.code());
        }
    }

    #[test]
    fn corpus_set_case_surfaces_every_duplicate_path() {
        for case in corpus()["cases"].as_array().unwrap() {
            if case["kind"] != "set" {
                continue;
            }
            assert_eq!(case["expect"], "duplicate_document_id");
            let root =
                std::env::temp_dir().join(format!("sawhorse-pdc-set-{}", uuid::Uuid::new_v4()));
            for relative in case["paths"].as_array().unwrap() {
                let source = corpus_dir().join(relative.as_str().unwrap());
                let target = root.join("vault").join(relative.as_str().unwrap());
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::copy(source, target).unwrap();
            }
            let scan = scan(&root.join("vault")).unwrap();
            assert_eq!(scan.duplicate_ids.len(), 1, "하나의 중복 ID 군이 나와야 한다");
            let (_, paths) = &scan.duplicate_ids[0];
            assert_eq!(paths.len(), 3, "충돌 경로 전부가 보고되어야 한다: {paths:?}");
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn valid_documents_preserve_source_bytes_exactly() {
        for relative in [
            "fixtures/valid/minimal.djot",
            "fixtures/valid/semantics.djot",
            "fixtures/valid/minimal.html",
            "fixtures/valid/semantics.html",
        ] {
            let document = read_case(relative);
            assert_eq!(document.outcome, Outcome::Valid, "{relative}");
            let on_disk = std::fs::read(corpus_dir().join(relative)).unwrap();
            assert_eq!(document.source, on_disk, "{relative}: 원본 바이트 보존");
            assert!(document.body_range.1 <= document.source.len());
        }
    }

    #[test]
    fn discovery_skips_dot_directories_and_reports_legacy_html() {
        let root =
            std::env::temp_dir().join(format!("sawhorse-pdc-discovery-{}", uuid::Uuid::new_v4()));
        let visible = root.join("docs");
        std::fs::create_dir_all(&visible).unwrap();
        std::fs::create_dir_all(root.join(".pdc/assets")).unwrap();
        std::fs::create_dir_all(root.join(".sawhorse")).unwrap();
        std::fs::write(
            visible.join("real.djot"),
            b"---\nformat: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: real\n---\n# real\n",
        )
        .unwrap();
        std::fs::write(root.join(".pdc/assets/stored.html"), b"<p>asset</p>\n").unwrap();
        std::fs::write(root.join(".sawhorse/hidden.djot"), b"---\n---\n").unwrap();
        std::fs::write(
            root.join("legacy.html"),
            b"<!doctype html><html><body>legacy</body></html>\n",
        )
        .unwrap();

        let scan = scan(&root).unwrap();
        let paths: Vec<&str> = scan.documents.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["docs/real.djot", "legacy.html"],
            "발견은 정렬되고 점 디렉터리를 건너뛴다"
        );
        assert_eq!(scan.documents[0].outcome, Outcome::Valid);
        assert_eq!(scan.documents[1].outcome, Outcome::LegacyHtml);
        assert!(scan.duplicate_ids.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unsafe_html_constructs_are_named_by_the_scan() {
        let envelope = "<!--\n---\nformat: pdc-document/1\nbody: pdc-html/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb1706\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\n---\n-->\n";
        let body = b"<html><body onclick=\"alert(1)\"><script>alert(1)</script><a href=\"javascript:alert(1)\">x</a><iframe src=\"x\"></iframe></body></html>\n";
        let mut source = envelope.as_bytes().to_vec();
        source.extend_from_slice(body);
        let document = read_document("html", source);
        let Outcome::UnsafeContent(constructs) = &document.outcome else {
            panic!("안전성 진단이어야 한다: {:?}", document.outcome);
        };
        assert!(constructs.iter().any(|c| c.contains("onclick")), "{constructs:?}");
        assert!(constructs.iter().any(|c| c.contains("script")), "{constructs:?}");
        assert!(constructs.iter().any(|c| c.contains("javascript:")), "{constructs:?}");
        assert!(constructs.iter().any(|c| c.contains("iframe")), "{constructs:?}");
    }

    #[test]
    fn html_dom_depth_over_256_is_too_complex() {
        let envelope = "<!--\n---\nformat: pdc-document/1\nbody: pdc-html/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb1708\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: deep\n---\n-->\n";
        let mut body = String::new();
        for _ in 0..257 {
            body.push_str("<div>");
        }
        for _ in 0..257 {
            body.push_str("</div>");
        }
        let mut source = envelope.as_bytes().to_vec();
        source.extend_from_slice(body.as_bytes());
        assert_eq!(
            read_document("html", source).outcome.code(),
            "document_too_complex"
        );
    }

    #[test]
    fn pdc_links_and_assets_are_preserved_in_the_body() {
        let document = read_case("fixtures/valid/semantics.djot");
        let body = String::from_utf8(document.body().to_vec()).unwrap();
        assert!(body.contains("pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db"));
        assert!(body.contains("{#b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32}"));

        let html = read_case("fixtures/valid/semantics.html");
        let html_body = String::from_utf8(html.body().to_vec()).unwrap();
        assert!(html_body.contains(
            "pdc://asset/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        ));
        assert!(html_body.contains("id=\"b-018f47c6-7dbe-7a14-9f67-6f89a5e3c170\""));
    }

    #[test]
    fn registered_space_resolution_flows_into_scan() {
        // 기본 공간 래핑을 통한 발견 — resolve_root가 공간 루트를 돌려주는 경로.
        let root = std::env::temp_dir().join(format!("sawhorse-pdc-space-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let scan = scan_registered(&root, None).unwrap();
        assert!(scan.documents.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn djot_duplicate_block_id_is_caught_even_with_trailing_attributes() {
        // §9.1 작업 구문처럼 표적 뒤에 클래스가 붙어도 같은 ID로 비교한다.
        let envelope = "---\nformat: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\n---\n";
        let body = "- [ ] [Open]{#b-018f47c6-c718-728c-9d91-b2bc700814bb .pdc-task}\n- [x] [Done]{#b-018f47c6-c718-728c-9d91-b2bc700814bb .pdc-task}\n";
        let mut source = envelope.as_bytes().to_vec();
        source.extend_from_slice(body.as_bytes());
        assert_eq!(read_document("djot", source).outcome.code(), "duplicate_block_id");
    }
}
