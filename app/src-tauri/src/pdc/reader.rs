//! 문서 발견과 판독 진단 — PDC-2.0 §3.2·§6 (Full Reader).
//!
//! 등록된 문서 공간 루트 아래의 `.md`·`.html`·`.djot`을 재귀로 발견하고, 볼트
//! 표시가 질의 계약을 선언하면 `.base`도 발견한다. 각 파일은 이송 추출 →
//! 봉투 해석 → 의미 검증 → 안전성 검사 순으로 판독되며, 봉투 문법은 형식
//! 식별자가 고른다: `pdc-document/2`는 안전 YAML([`yamlfront`]),
//! `pdc-document/1`은 동결 문법([`envelope`]). 원본 바이트는 언제나 그대로
//! 보존되며 판독은 절대 쓰기를 하지 않는다.
//!
//! 가시성 규칙(§1·§13): v1 문서는 `legacy_valid`, PDC 봉투 없는 HTML은
//! `legacy_html`, 평범 Markdown은 `legacy_markdown`으로 각각 눈에 보이는
//! 항목이다 — 잘못됨이 아니라 레거시이며 절대 자동 변환되지 않는다. 미지
//! 주요 버전은 `unsupported_document_version`이다.
//!
//! 발견 규칙(§3.2): 점 접두 구성요소(`.pdc`, `.git`, `.sawhorse` …)는 건너뛰고,
//! 심볼릭 링크는 따라가지 않고, 파일 순서가 결과에 영향을 주지 않는다(경로
//! 정렬로 결정성 보장).

#![allow(dead_code)] // Full Reader — Stage 2 작성기·문서 화면이 소비한다.

use std::collections::BTreeMap;
use std::path::Path;

use super::contract;
use super::envelope::{self, Envelope};
use super::transport::{self, Outcome};
use super::yamlfront;

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

    /// 봉투 형식 식별자(v1·v2).
    pub fn format(&self) -> Option<&str> {
        self.envelope.as_ref().and_then(|env| env.text("format"))
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

/// 봉투 슬라이스의 col-0 `format:` 값을 엿본다. 문법 선택(v1 동결 vs v2 안전
/// YAML)은 형식 식별자가 결정한다(§2·§5). 최상위 키는 두 문법 모두 col-0이므로
/// 첫 일치가 곧 형식 선언이다.
fn peek_format(envelope: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(envelope).ok()?;
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix("format:") {
            return Some(rest.trim().to_string());
        }
    }
    None
}

/// 파일 하나를 판독한다. 발견·코퍼스 시험 모두 이 입구를 쓴다.
pub fn read_document(extension: &str, bytes: Vec<u8>) -> ReadDocument {
    let whole = (0usize, bytes.len());
    let nowhere = (bytes.len(), bytes.len());
    let make =
        |body_range: (usize, usize), envelope: Option<Envelope>, outcome: Outcome| ReadDocument {
            path: String::new(),
            source: bytes.clone(),
            body_range,
            envelope,
            outcome,
        };

    // 질의 계층(.base) — 문서 이송이 없다. 실행하지 않고 판정만 한다
    // (PDC-QUERY-1.0 §3.1·§5).
    if extension == contract::QUERY_BASE_EXTENSION {
        if bytes.len() > contract::QUERY_MAX_BYTES as usize {
            return make(whole, None, Outcome::DocumentTooLarge);
        }
        if transport::has_bom(&bytes) {
            return make(
                whole,
                None,
                Outcome::InvalidQuery("UTF-8 BOM이 있다".into()),
            );
        }
        return match yamlfront::validate_query(&bytes) {
            Ok(status) => make(
                whole,
                None,
                match status {
                    yamlfront::QueryStatus::Executable => Outcome::Valid,
                    yamlfront::QueryStatus::Unexecuted => Outcome::ValidUnexecuted,
                },
            ),
            Err(outcome) => make(whole, None, outcome),
        };
    }

    if !transport::size_ok(bytes.len()) {
        return make(nowhere, None, Outcome::DocumentTooLarge);
    }
    let transport = match transport::extract(extension, &bytes) {
        Ok(transport) => transport,
        Err(Outcome::LegacyHtml) => return make(whole, None, Outcome::LegacyHtml),
        Err(Outcome::LegacyMarkdown) => return make(whole, None, Outcome::LegacyMarkdown),
        Err(outcome) => return make(nowhere, None, outcome),
    };
    let envelope_slice = &bytes[transport.envelope_range.0..transport.envelope_range.1];
    match (extension, peek_format(envelope_slice).as_deref()) {
        (_, Some(contract::DOCUMENT_FORMAT_V2)) => read_v2(extension, &bytes, &transport),
        ("md", Some(contract::DOCUMENT_FORMAT)) => make(
            transport.body_range,
            None,
            Outcome::InvalidTransport(
                "Markdown 이송은 pdc-document/2 아래에서만 유효하다(§2)".into(),
            ),
        ),
        (_, Some(contract::DOCUMENT_FORMAT)) => read_v1(extension, &bytes, &transport),
        (_, Some(other)) if other.starts_with("pdc-document/") => make(
            transport.body_range,
            None,
            Outcome::UnsupportedDocumentVersion(other.to_string()),
        ),
        // PDC 표기가 아닌(또는 없는) 프런트매터를 가진 .md는 평범 Markdown이다.
        ("md", _) => make(whole, None, Outcome::LegacyMarkdown),
        // djot/html은 v1 동결 문법으로 해석한다 — 기존 진단 어휘를 유지한다.
        (_, _) => read_v1(extension, &bytes, &transport),
    }
}

/// v1(`pdc-document/1`) 봉투 — 동결 문법. 통과하면 `legacy_valid`다.
fn read_v1(extension: &str, bytes: &[u8], transport: &transport::Transport) -> ReadDocument {
    let make =
        |body_range: (usize, usize), envelope: Option<Envelope>, outcome: Outcome| ReadDocument {
            path: String::new(),
            source: bytes.to_vec(),
            body_range,
            envelope,
            outcome,
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
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::UnsafeContent(constructs),
                );
            }
            if duplicate_block_id_djot(body) {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DuplicateBlockId,
                );
            }
            if djot_container_depth(body) > 256 {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DocumentTooComplex,
                );
            }
        }
        _ => {
            let report = scan_html(body);
            if !report.unsafe_constructs.is_empty() {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::UnsafeContent(report.unsafe_constructs),
                );
            }
            if duplicate_block_id_html(body) {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DuplicateBlockId,
                );
            }
            if report.max_depth > 256 {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DocumentTooComplex,
                );
            }
        }
    }
    make(transport.body_range, Some(envelope), Outcome::LegacyValid)
}

/// v2(`pdc-document/2`) 봉투 — 안전 YAML 문법. 통과하면 `valid`고 편집
/// 가능한 정문서다.
fn read_v2(extension: &str, bytes: &[u8], transport: &transport::Transport) -> ReadDocument {
    let make =
        |body_range: (usize, usize), envelope: Option<Envelope>, outcome: Outcome| ReadDocument {
            path: String::new(),
            source: bytes.to_vec(),
            body_range,
            envelope,
            outcome,
        };
    let envelope_slice = &bytes[transport.envelope_range.0..transport.envelope_range.1];
    let envelope = match yamlfront::parse(envelope_slice) {
        Ok(envelope) => envelope,
        Err(outcome) => return make(transport.body_range, None, outcome),
    };
    if let Err(outcome) = envelope::validate_v2(&envelope) {
        return make(transport.body_range, None, outcome);
    }
    // 바디 프로필과 확장자가 같은 이송이어야 한다(§4.2/§4.3).
    let expected_profile = match extension {
        "md" => contract::TRANSPORT_MARKDOWN,
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
        "md" => {
            if let Some(constructs) = scan_markdown_unsafe(body) {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::UnsafeContent(constructs),
                );
            }
            if duplicate_block_id_markdown(body) {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DuplicateBlockId,
                );
            }
            if markdown_container_depth(body) > 256 {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DocumentTooComplex,
                );
            }
        }
        _ => {
            let report = scan_html(body);
            if !report.unsafe_constructs.is_empty() {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::UnsafeContent(report.unsafe_constructs),
                );
            }
            if duplicate_block_id_html(body) {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DuplicateBlockId,
                );
            }
            if report.max_depth > 256 {
                return make(
                    transport.body_range,
                    Some(envelope),
                    Outcome::DocumentTooComplex,
                );
            }
        }
    }
    make(transport.body_range, Some(envelope), Outcome::Valid)
}

/// 공간 루트를 재귀 발견해 전체를 판독한다(§3.2).
pub fn scan(root: &Path) -> Result<VaultScan, String> {
    let include_base = query_enabled(root);
    let mut paths = Vec::new();
    collect_documents(root, root, include_base, &mut paths)?;
    paths.sort();
    let mut scan = VaultScan::default();
    let mut ids: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for relative in paths {
        let absolute = root.join(&relative);
        let metadata = std::fs::metadata(&absolute)
            .map_err(|e| format!("파일 정보 실패({}): {e}", absolute.display()))?;
        let extension = relative
            .rsplit('.')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        let limit = if extension == contract::QUERY_BASE_EXTENSION {
            contract::QUERY_MAX_BYTES as usize
        } else {
            contract::DOCUMENT_MAX_BYTES as usize
        };
        if metadata.len() as usize > limit {
            // 내용을 읽지 않고도 판정되는 상한 위반(§4.1·QUERY §3.1)이다.
            scan.documents.push(ReadDocument {
                path: relative,
                source: Vec::new(),
                body_range: (0, 0),
                envelope: None,
                outcome: Outcome::DocumentTooLarge,
            });
            continue;
        }
        let bytes = std::fs::read(&absolute)
            .map_err(|e| format!("파일 읽기 실패({}): {e}", absolute.display()))?;
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

/// 볼트 표시가 질의 계약(`query: pdc-query/1`)을 선언했는가
/// (§3.1·PDC-QUERY-1.0 §2). 표시가 없으면 `.base`는 발견 대상이 아니다.
fn query_enabled(root: &Path) -> bool {
    let manifest = root.join(".pdc").join("vault.json");
    let Ok(text) = std::fs::read_to_string(&manifest) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|value| {
            value
                .get("query")
                .and_then(|query| query.as_str())
                .map(str::to_string)
        })
        .as_deref()
        == Some(contract::QUERY_FORMAT)
}

fn collect_documents(
    root: &Path,
    dir: &Path,
    include_base: bool,
    out: &mut Vec<String>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| format!("디렉터리 읽기 실패({}): {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("항목 읽기 실패: {e}"))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("항목 유형 실패: {e}"))?;
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
            collect_documents(root, &path, include_base, out)?;
        } else {
            let lower = name.to_ascii_lowercase();
            let wanted = lower.ends_with(".md")
                || lower.ends_with(".djot")
                || lower.ends_with(".html")
                || (include_base && lower.ends_with(".base"));
            if wanted {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| "볼트 밖 경로다".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push(relative);
            }
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
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

/// HTML 본문의 안전 구조 검사(§6.2·§11.3)와 DOM 깊이 측정.
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
        let Some(mut close) = lower[index..].find('>') else {
            break;
        };
        close += index;
        let tag = &lower[index + 1..close];
        index = close + 1;
        let trimmed = tag.trim_start_matches('/');
        let element: String = trimmed
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric())
            .collect();
        if element.is_empty() {
            continue;
        }
        if !trimmed.starts_with('/') {
            if matches!(
                element.as_str(),
                "script" | "base" | "embed" | "object" | "applet"
            ) {
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
    HtmlReport {
        unsafe_constructs,
        max_depth,
    }
}

/// Markdown 본문의 안전 검사(§6.1·§11.1). CommonMark가 허용하는 일반 raw
/// HTML은 부적합이 아니라 소스 보존 대상이다 — 실행 가능 구문(`<script>`,
/// 이벤트 처리기, 위험 스킴)과 볼트 밖 상대 참조만 진단으로 돌린다. 코드
/// 펜스·인라인 코드·수식 안의 문양은 내용이므로 검사하지 않는다.
fn scan_markdown_unsafe(body: &[u8]) -> Option<Vec<String>> {
    let text = String::from_utf8_lossy(body);
    let stripped = strip_djot_verbatim(&text);
    let mut constructs = Vec::new();
    // 1) raw HTML의 실행 가능 구문 — HTML 판정 어휘를 재사용한다.
    let report = scan_html(stripped.as_bytes());
    for construct in report.unsafe_constructs {
        if !constructs.contains(&construct) {
            constructs.push(construct);
        }
    }
    // 2) 위키 링크·임베드의 볼트 한정.
    for target in wiki_link_targets(&stripped) {
        if escapes_vault(&target) {
            let flagged = format!("wiki 참조가 볼트를 벗어난다: {target}");
            if !constructs.contains(&flagged) {
                constructs.push(flagged);
            }
        }
    }
    // 3) 상대 링크·이미지의 볼트 한정과 위험 스킴.
    for target in inline_link_targets(&stripped) {
        if let Some(scheme) = uri_scheme(&target) {
            if !matches!(scheme.as_str(), "http" | "https" | "mailto" | "pdc") {
                let flagged = format!("허용되지 않은 URL 스킴: {scheme}:");
                if !constructs.contains(&flagged) {
                    constructs.push(flagged);
                }
            }
        } else if escapes_vault(&target) {
            let flagged = format!("상대 참조가 볼트를 벗어난다: {target}");
            if !constructs.contains(&flagged) {
                constructs.push(flagged);
            }
        }
    }
    (!constructs.is_empty()).then_some(constructs)
}

/// 상대 참조가 볼트 밖을 노리는가 — 절대 경로, `..` 세그먼트, 백슬래시.
fn escapes_vault(target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    if target.starts_with('/') || target.starts_with('\\') {
        return true;
    }
    target.split(['/', '\\']).any(|segment| segment == "..")
}

/// `scheme:` 문양이 있는 URI의 스킴. `a/b:1` 같은 상대 경로는 `None`이다.
fn uri_scheme(target: &str) -> Option<String> {
    let (candidate, rest) = target.split_once(':')?;
    if rest.starts_with('/') && !rest.starts_with("//") {
        // `pdc://`와 달리 단일 슬래시 뒤는 경로다 — 스킴이 아니다.
        if !candidate.contains('/') {
            return Some(candidate.to_ascii_lowercase());
        }
        return None;
    }
    let mut chars = candidate.chars();
    let head = chars.next()?;
    if !head.is_ascii_alphabetic() {
        return None;
    }
    if !chars
        .clone()
        .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    {
        return None;
    }
    Some(candidate.to_ascii_lowercase())
}

/// 위키 링크·임베드(`[[…]]`·`![[…]]`)의 표적 — `|` 표지와 `#` 앵커 앞부분.
fn wiki_link_targets(text: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let raw = &after[..end];
        let target = raw.split(['|', '#']).next().unwrap_or("").trim();
        if !target.is_empty() {
            targets.push(target.to_string());
        }
        rest = &after[end + 2..];
    }
    targets
}

/// 인라인 링크·이미지 `](` … `)`의 표적. `](<target>)` 형태도 받는다.
fn inline_link_targets(text: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("](") {
        let after = &rest[start + 2..];
        if let Some(angle) = after.strip_prefix('<') {
            let Some(end) = angle.find('>') else { break };
            push_link_target(&angle[..end], &mut targets);
            rest = &angle[end + 1..];
        } else {
            let end = after.find(')').unwrap_or(after.len());
            push_link_target(&after[..end], &mut targets);
            rest = &after[end..];
        }
    }
    targets
}

fn push_link_target(raw: &str, targets: &mut Vec<String>) {
    let target = raw.trim();
    if !target.is_empty() && !target.starts_with('#') {
        targets.push(target.to_string());
    }
}

/// `<` 뒤가 태그 이름(`p`, `/p`) 문양인가.
fn looks_like_html_tag(after: &str) -> bool {
    let mut chars = after.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => true,
        Some('/') => chars.next().is_some_and(|c| c.is_ascii_alphabetic()),
        _ => false,
    }
}

/// 줄 중간의 raw 인라인 태그 문양 `<tag>` 위치.
fn find_raw_inline_tag(line: &str) -> Option<usize> {
    let bytes = line.as_bytes();
    (1..bytes.len()).find(|&index| bytes[index] == b'<' && looks_like_html_tag(&line[index + 1..]))
}

/// 코드 펜스(```·~~~), 인라인 코드, 수식 스팬을 빈 줄·공백으로 걷어낸
/// 검사 전용 뷰. 홀수 개의 펜스·기호 같은 미완성 마크업은 과감히 오탐 쪽으로
/// 둔다(보수 게이트).
fn strip_djot_verbatim(text: &str) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    let mut fence: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(active) = &fence {
            if trimmed.starts_with(active.as_str()) {
                fence = None;
            }
            out_lines.push(String::new());
            continue;
        }
        let opening = ["```", "~~~"]
            .into_iter()
            .find(|marker| trimmed.starts_with(marker));
        if let Some(marker) = opening {
            fence = Some(marker.to_string());
            out_lines.push(String::new());
            continue;
        }
        out_lines.push(strip_inline_verbatim(line));
    }
    out_lines.join("\n")
}

fn strip_inline_verbatim(line: &str) -> String {
    if !line.contains('`') && !line.contains('$') {
        return line.to_string();
    }
    let mut out = String::with_capacity(line.len());
    let mut span: Option<char> = None;
    for c in line.chars() {
        match span {
            Some(marker) if c == marker => span = None,
            Some(_) => {}
            None if c == '`' || c == '$' => span = Some(c),
            None => out.push(c),
        }
    }
    out
}

/// Djot 본문의 원문(raw) 구조 검사(v1 §6.1 — raw 블록·인라인은 부적합이다).
/// `=html` 표기와 직접 입력한 HTML 태그 문양을 모두 본다. 태그 검사는 코드
/// 펜스·인라인 코드·수식을 걷어낸 뒤의 근사 검사다 — 판독기 수준의 오탐은
/// 렌더 계층의 소독이 최종 방어선이다.
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
    let stripped = strip_djot_verbatim(&text);
    for line in stripped.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('<') && looks_like_html_tag(&trimmed[1..]) {
            if !constructs.contains(&"raw block (<tag>)".to_string()) {
                constructs.push("raw block (<tag>)".into());
            }
            continue;
        }
        if find_raw_inline_tag(trimmed).is_some()
            && !constructs.contains(&"raw inline (<tag>)".to_string())
        {
            constructs.push("raw inline (<tag>)".into());
        }
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

/// Markdown caret 블록 표적 `^id`의 중복 검사(§7.2). 표적은 줄 끝에 붙는
/// Obsidian 배치다. 문자 집합은 `[A-Za-z0-9-]+`(§7.2 — 밑줄 제외).
fn duplicate_block_id_markdown(body: &[u8]) -> bool {
    let text = String::from_utf8_lossy(body);
    let stripped = strip_djot_verbatim(&text);
    let mut seen = std::collections::HashSet::new();
    for line in stripped.lines() {
        let trimmed = line.trim_end();
        let bytes = trimmed.as_bytes();
        let mut index = 0usize;
        while index < bytes.len() {
            if bytes[index] != b'^' {
                index += 1;
                continue;
            }
            let head_ok = index == 0 || bytes[index - 1].is_ascii_whitespace();
            if !head_ok {
                index += 1;
                continue;
            }
            let mut end = index + 1;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                end += 1;
            }
            if end == trimmed.len() && end > index + 1 {
                let id = &trimmed[index + 1..end];
                if contract::is_caret_target_id(id) && !seen.insert(id.to_string()) {
                    return true;
                }
            }
            index = end;
        }
    }
    false
}

/// Djot 열린 블록 컨테이너 최대 깊이 — 행 선두의 `>` 연속 수로 근사한다.
fn djot_container_depth(body: &[u8]) -> usize {
    String::from_utf8_lossy(body)
        .lines()
        .map(|line| line.bytes().take_while(|byte| *byte == b'>').count())
        .max()
        .unwrap_or(0)
}

/// Markdown 인용 깊이 — 펜스를 걷어낸 뒤 행 선두 `>` 연속 수로 근사한다(§4.2).
fn markdown_container_depth(body: &[u8]) -> usize {
    let text = String::from_utf8_lossy(body);
    let stripped = strip_djot_verbatim(&text);
    stripped
        .lines()
        .map(|line| line.bytes().take_while(|byte| *byte == b'>').count())
        .max()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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
        assert_eq!(corpus["format"], contract::CORPUS_FORMAT);
        assert_eq!(
            corpus["revision"],
            serde_json::json!(contract::CORPUS_REVISION)
        );
        assert_eq!(corpus["bodyProfiles"][0], "pdc-markdown/1");
        assert_eq!(corpus["queryContract"], contract::QUERY_FORMAT);
        assert_eq!(corpus["legacyDocuments"]["formats"][0], "pdc-document/1");
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
        assert_eq!(covered, 44, "파일 사례 전부를 소비해야 한다");
    }

    #[test]
    fn corpus_reader_operations_are_diagnosed_as_expected() {
        let minimal = std::fs::read(corpus_dir().join("fixtures/valid/minimal.djot")).unwrap();
        for case in corpus()["cases"].as_array().unwrap() {
            if case["kind"] != "operation" {
                continue;
            }
            let operation = case["operation"].as_str().unwrap();
            let expected = case["expect"].as_str().unwrap();
            let outcome = match operation {
                "prefix-source-bytes" => {
                    let prefix = case["prefixHex"].as_str().unwrap();
                    let input = case["input"].as_str().unwrap();
                    let mut source: Vec<u8> = (0..prefix.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&prefix[i..i + 2], 16).unwrap())
                        .collect();
                    source.extend_from_slice(&std::fs::read(corpus_dir().join(input)).unwrap());
                    read_document(input.rsplit('.').next().unwrap(), source).outcome
                }
                "pad-body-to-total-bytes" => {
                    let total = case["totalBytes"].as_u64().unwrap() as usize;
                    let input = case["input"].as_str().unwrap();
                    let mut source = std::fs::read(corpus_dir().join(input)).unwrap();
                    source.resize(total, b'\n');
                    read_document(input.rsplit('.').next().unwrap(), source).outcome
                }
                "replace-envelope-with-yaml-mapping-depth" => {
                    let depth = case["depth"].as_u64().unwrap() as usize;
                    let input = case["input"].as_str().unwrap();
                    let source = std::fs::read(corpus_dir().join(input)).unwrap();
                    let text = String::from_utf8_lossy(&source);
                    let body_start = text[4..].find("\n---\n").map(|i| i + 5).unwrap();
                    let body = &source[body_start..];
                    let mut envelope = String::from("---\nformat: pdc-document/2\n");
                    for level in 1..=depth {
                        envelope.push_str(&"  ".repeat(level - 1));
                        envelope.push_str(format!("k{level}:\n").as_str());
                    }
                    envelope.push_str(&"  ".repeat(depth));
                    envelope.push_str("leaf: 1\n---\n");
                    let mut replaced = envelope.into_bytes();
                    replaced.extend_from_slice(body);
                    read_document(input.rsplit('.').next().unwrap(), replaced).outcome
                }
                "replace-body-with-nested-block-quotes" => {
                    let depth = case["containerDepth"].as_u64().unwrap() as usize;
                    let mut source = minimal.clone();
                    for level in 1..=depth {
                        source.extend_from_slice(format!("{}\n", ">".repeat(level)).as_bytes());
                    }
                    read_document("djot", source).outcome
                }
                // 작성기 사례 — writer.rs의 코퍼스 시험이 소비한다.
                "no-op-round-trip" | "metadata-patch" | "external-change-before-save" => continue,
                other => {
                    panic!("알 수 없는 코퍼스 동작: {other} — 코퍼스를 갱신했으면 시험도 갱신한다")
                }
            };
            let id = case["id"].as_str().unwrap();
            assert_eq!(
                outcome.code(),
                expected,
                "{id}: 기대 {expected}, 실제 {}",
                outcome.code()
            );
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
            assert_eq!(
                scan.duplicate_ids.len(),
                1,
                "하나의 중복 ID 군이 나와야 한다"
            );
            let (_, paths) = &scan.duplicate_ids[0];
            assert_eq!(
                paths.len(),
                3,
                "충돌 경로 전부가 보고되어야 한다: {paths:?}"
            );
            std::fs::remove_dir_all(&root).ok();
        }
    }

    #[test]
    fn valid_documents_preserve_source_bytes_exactly() {
        for relative in [
            "fixtures/valid/minimal.md",
            "fixtures/valid/semantics.md",
            "fixtures/valid/v2-minimal.html",
        ] {
            let document = read_case(relative);
            assert_eq!(document.outcome.code(), "valid", "{relative}");
            assert_eq!(document.format(), Some("pdc-document/2"), "{relative}");
            let on_disk = std::fs::read(corpus_dir().join(relative)).unwrap();
            assert_eq!(document.source, on_disk, "{relative}: 원본 바이트 보존");
            assert!(document.body_range.1 <= document.source.len());
        }
        for relative in [
            "fixtures/valid/minimal.djot",
            "fixtures/valid/semantics.djot",
        ] {
            let document = read_case(relative);
            assert_eq!(document.outcome.code(), "legacy_valid", "{relative}");
            let on_disk = std::fs::read(corpus_dir().join(relative)).unwrap();
            assert_eq!(document.source, on_disk, "{relative}: 원본 바이트 보존");
        }
    }

    #[test]
    fn legacy_v1_documents_read_as_legacy_valid_and_are_editable_only_in_v2() {
        for relative in ["fixtures/valid/minimal.djot", "fixtures/valid/minimal.html"] {
            let document = read_case(relative);
            assert_eq!(document.outcome, Outcome::LegacyValid, "{relative}");
            assert_eq!(document.format(), Some("pdc-document/1"));
        }
        for relative in [
            "fixtures/valid/minimal.md",
            "fixtures/valid/v2-minimal.html",
        ] {
            let document = read_case(relative);
            assert_eq!(document.outcome, Outcome::Valid, "{relative}");
            assert_eq!(document.format(), Some("pdc-document/2"));
        }
    }

    #[test]
    fn discovery_skips_dot_directories_and_reports_legacy_items() {
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
        assert_eq!(scan.documents[0].outcome, Outcome::LegacyValid);
        assert_eq!(scan.documents[1].outcome, Outcome::LegacyHtml);
        assert!(scan.duplicate_ids.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn discovery_surfaces_plain_markdown_and_gates_base_files_on_the_manifest() {
        let root = std::env::temp_dir().join(format!("sawhorse-pdc-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".pdc")).unwrap();
        std::fs::write(
            root.join("note.md"),
            b"# Plain markdown note\n\nNo PDC envelope here.\n",
        )
        .unwrap();
        std::fs::write(root.join("view.base"), b"filters: 'priority == 3'\n").unwrap();

        // 표시가 없으면 .base는 발견 대상이 아니다.
        let scan_before = scan(&root).unwrap();
        let paths: Vec<&str> = scan_before
            .documents
            .iter()
            .map(|d| d.path.as_str())
            .collect();
        assert_eq!(paths, vec!["note.md"]);
        assert_eq!(scan_before.documents[0].outcome, Outcome::LegacyMarkdown);

        // 질의 계약 선언 후에는 발견되고 실행 가능 판정을 받는다.
        std::fs::write(
            root.join(".pdc/vault.json"),
            format!(
                r#"{{"format": "pdc-vault/1", "id": "{}", "created": "2026-09-14T12:00:00.000Z", "query": "pdc-query/1"}}"#,
                uuid::Uuid::now_v7()
            ),
        )
        .unwrap();
        let scan_after = scan(&root).unwrap();
        let paths: Vec<&str> = scan_after
            .documents
            .iter()
            .map(|d| d.path.as_str())
            .collect();
        assert_eq!(paths, vec!["note.md", "view.base"]);
        assert_eq!(scan_after.documents[1].outcome, Outcome::Valid);
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
        assert!(
            constructs.iter().any(|c| c.contains("onclick")),
            "{constructs:?}"
        );
        assert!(
            constructs.iter().any(|c| c.contains("script")),
            "{constructs:?}"
        );
        assert!(
            constructs.iter().any(|c| c.contains("javascript:")),
            "{constructs:?}"
        );
        assert!(
            constructs.iter().any(|c| c.contains("iframe")),
            "{constructs:?}"
        );
    }

    #[test]
    fn markdown_links_stay_vault_confined() {
        let envelope = "---\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-14T12:34:56.789Z\nupdated: 2026-09-14T12:34:56.789Z\ntitle: t\n---\n";
        for body in [
            "[outside](../secret.md)\n".as_bytes(),
            "[abs](/etc/passwd)\n".as_bytes(),
            "![embed](..\\..\\x.png)\n".as_bytes(),
            "[[../escape]]\n".as_bytes(),
            "![[/absolute.png]]\n".as_bytes(),
            "[bad](javascript:alert(1))\n".as_bytes(),
            "[data](data:text/html,x)\n".as_bytes(),
        ] {
            let mut source = envelope.as_bytes().to_vec();
            source.extend_from_slice(body);
            let document = read_document("md", source);
            assert_eq!(
                document.outcome.code(),
                "unsafe_content",
                "{:?} → {:?}",
                String::from_utf8_lossy(body),
                document.outcome
            );
        }
        // 볼트 안 참조와 호환 구문은 유효하다.
        let safe = "[in](sub/note.md#heading)\n[[note|label]]\n![[image.png]]\n[doc](pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db)\n![asset](pdc://asset/sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)\n```base\nfilters: 'priority == 3'\n```\n";
        let mut source = envelope.as_bytes().to_vec();
        source.extend_from_slice(safe.as_bytes());
        assert_eq!(read_document("md", source).outcome, Outcome::Valid);
    }

    #[test]
    fn caret_ids_inside_code_fences_are_content_not_targets() {
        let envelope = "---\nformat: pdc-document/2\nbody: pdc-markdown/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-14T12:34:56.789Z\nupdated: 2026-09-14T12:34:56.789Z\ntitle: t\n---\n";
        let body = "```text\n# dup ^same-id-1\n# dup ^same-id-1\n```\n\n# real ^same-id-1\n";
        let mut source = envelope.as_bytes().to_vec();
        source.extend_from_slice(body.as_bytes());
        // 펜스 안의 표적은 내용이고, 펜스 밖의 하나만 표적이라 중복이 아니다.
        assert_eq!(read_document("md", source).outcome, Outcome::Valid);
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
    fn registered_space_resolution_flows_into_scan() {
        // 기본 공간 래핑을 통한 발견 — resolve_root가 공간 루트를 돌려주는 경로.
        let root =
            std::env::temp_dir().join(format!("sawhorse-pdc-space-{}", uuid::Uuid::new_v4()));
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
        assert_eq!(
            read_document("djot", source).outcome.code(),
            "duplicate_block_id"
        );
    }
}
