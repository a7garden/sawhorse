//! 동결된 봉투 문법 — PDC-1.0 §5 (Stage 1 판독기).
//!
//! 봉투는 일반 YAML이 아니라 동결된 제약 문법이다(§5): 키는 인덴트 0의 비어
//! 있지 않은 문자열, 값은 불리언·단일 줄 문자열·평평한 문자열 시퀀스·리터럴
//! 블록 문자열·하나의 중첩 맵뿐. 중복 키·탭·주석·앵커·별칭·태그·복합 키·다중
//! 문서·빈 값은 금지고, 금지 항목은 본문 텍스트가 아니라 **하드 오류**다.
//!
//! 일반 YAML 라이브러리는 쓰지 않는다 — 모든 금지 기능을 거부하는 검증을
//! 앞세워야 한다는 §5의 요구를 파서 자체로 만족시키는 편이 안전하다.

#![allow(dead_code)] // Stage 1 판독기 — Stage 2 작성기가 소비한다.

use super::contract;
use super::transport::Outcome;

/// 봉투 값. 중첩 맵은 정확히 한 단계(§5)이고 그 안은 스칼라뿐이다.
#[derive(Clone, Debug, PartialEq)]
pub enum EnvValue {
    /// 문자열(따옴표는 벗겨진 해석 값).
    Text(String),
    /// 불리언 — `true`/`false`만 해당한다.
    Flag(bool),
    /// 수 — v2 안전 YAML의 유한 수. 철자 보존을 위해 원문 스펠링을 담는다.
    Number(String),
    /// null — v2 안전 YAML에서 값 생략과 같다.
    Null,
    /// 시퀀스. v1은 평평한 문자열 시퀀스, v2는 중첩 가능한 일반 시퀀스다.
    Seq(Vec<EnvValue>),
    /// 맵. 키는 언제나 문자열이다.
    Map(Vec<(String, EnvValue)>),
}

impl EnvValue {
    /// 문자열 뷰. 다른 변형이면 `None`.
    pub fn as_text(&self) -> Option<&str> {
        match self {
            EnvValue::Text(text) => Some(text),
            _ => None,
        }
    }

    /// 불리언 뷰.
    pub fn as_flag(&self) -> Option<bool> {
        match self {
            EnvValue::Flag(flag) => Some(*flag),
            _ => None,
        }
    }
    /// 시퀀스 뷰.
    pub fn as_seq(&self) -> Option<&[EnvValue]> {
        match self {
            EnvValue::Seq(items) => Some(items),
            _ => None,
        }
    }

    /// 평평한 문자열 시퀀스 뷰 — 시퀀스의 모든 항목이 문자열일 때만 `Some`.
    pub fn as_text_seq(&self) -> Option<Vec<&str>> {
        match self {
            EnvValue::Seq(items) => items
                .iter()
                .map(|item| item.as_text())
                .collect::<Option<Vec<_>>>(),
            _ => None,
        }
    }
}

/// 관찰 순서를 보존하는 봉투(§5.4 — 알 수 없는 필드는 관찰 순서를 유지한다).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Envelope {
    pub entries: Vec<(String, EnvValue)>,
}

impl Envelope {
    pub fn get(&self, key: &str) -> Option<&EnvValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// 문자열 필드 편의 접근.
    pub fn text(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(EnvValue::as_text)
    }
}

fn invalid(reason: impl Into<String>) -> Outcome {
    Outcome::InvalidEnvelope(reason.into())
}

fn reject_tabs(line: &[u8]) -> Result<(), Outcome> {
    if line.contains(&b'\t') {
        Err(invalid("봉투에 탭이 있다"))
    } else {
        Ok(())
    }
}

/// 키 문자 검사: `[A-Za-z0-9_][A-Za-z0-9_-]*` — 사례 키(format·x_sawhorse·
/// deleted_at)와 미래 키를 모두 담는 최소 제약이다.
fn valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    let head = bytes
        .first()
        .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_');
    head && bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// 인용 스칼라를 벗긴다. 여는 문자와 같은 문자로 한 줄에서 닫혀야 한다.
fn unquote(raw: &str) -> Result<String, Outcome> {
    let bytes = raw.as_bytes();
    let Some(&open) = bytes.first() else {
        return Err(invalid("빈 값은 금지다"));
    };
    if open != b'"' && open != b'\'' {
        return Err(invalid("인용 스칼라가 아니다"));
    }
    let Some(&close) = bytes.last() else {
        return Err(invalid("인용이 닫히지 않았다"));
    };
    if open != close || raw.len() < 2 {
        return Err(invalid("인용이 한 줄에서 닫히지 않았다"));
    }
    Ok(raw[1..raw.len() - 1].to_string())
}

/// 플로우 시퀀스 `[a, b]` 해석 — 평평한 문자열 시퀀스만 허용된다(§5).
fn parse_flow_seq(raw: &str) -> Result<EnvValue, Outcome> {
    let inner = raw
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .ok_or_else(|| invalid("플로우 시퀀스가 닫히지 않았다"))?;
    if inner.trim().is_empty() {
        return Err(invalid("빈 시퀀스는 빈 값과 같다"));
    }
    if inner.contains('[') || inner.contains(']') {
        return Err(invalid("시퀀스는 평평해야 한다 — 중첩 괄호는 금지다"));
    }
    let mut items = Vec::new();
    for part in inner.split(',') {
        let item = part.trim();
        if item.is_empty() {
            return Err(invalid("빈 시퀀스 항목이 있다"));
        }
        let value = if (item.starts_with('"') && item.ends_with('"') && item.len() >= 2)
            || (item.starts_with('\'') && item.ends_with('\'') && item.len() >= 2)
        {
            unquote(item)?
        } else {
            reject_forbidden_scalar_markers(item)?;
            item.to_string()
        };
        items.push(EnvValue::Text(value));
    }
    Ok(EnvValue::Seq(items))
}

/// 벗겨지지 않은 스칼라의 금지 문법 표지(주석·앵커·별칭·태그·복합 키).
fn reject_forbidden_scalar_markers(raw: &str) -> Result<(), Outcome> {
    let first = raw.chars().next();
    if matches!(
        first,
        Some('&') | Some('*') | Some('!') | Some('?') | Some('>') | Some('|') | Some('#')
    ) {
        return Err(invalid(format!(
            "봉투 값이 금지된 문법 표지 `{}`로 시작한다",
            first.unwrap()
        )));
    }
    // ` #`(공백 뒤 주석 시작)은 일반 YAML 문법이지 봉투 문법이 아니다.
    if raw.contains(" #") {
        return Err(invalid("봉투 값에 주석(`#`)이 있다"));
    }
    Ok(())
}

fn parse_scalar(raw: &str) -> Result<EnvValue, Outcome> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(invalid("빈 값은 금지다"));
    }
    match value {
        "true" => return Ok(EnvValue::Flag(true)),
        "false" => return Ok(EnvValue::Flag(false)),
        _ => {}
    }
    if value.starts_with('[') {
        return parse_flow_seq(value);
    }
    if value.starts_with('"') || value.starts_with('\'') {
        return Ok(EnvValue::Text(unquote(value)?));
    }
    reject_forbidden_scalar_markers(value)?;
    Ok(EnvValue::Text(value.to_string()))
}

/// 정확히 두 칸 들여쓰기인가 — 더 깊은 중첩은 금지다(§5).
fn two_space_indent(line: &[u8]) -> bool {
    line.starts_with(b"  ") && !line.starts_with(b"   ")
}

/// 봉투 바이트(경계선 `---` 제외)를 문법에 따라 해석한다.
pub fn parse(envelope: &[u8]) -> Result<Envelope, Outcome> {
    let text =
        String::from_utf8(envelope.to_vec()).map_err(|_| invalid("봉투는 UTF-8이어야 한다"))?;
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();
    let mut entries: Vec<(String, EnvValue)> = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        if line.is_empty() {
            // 닫는 경계 바로 앞의 마지막 줄바꿈 하나는 정상이다.
            if index + 1 == lines.len() {
                break;
            }
            return Err(invalid("봉투에 빈 줄이 있다"));
        }
        reject_tabs(line.as_bytes())?;
        if line.starts_with('#') || line.starts_with("- ") || line == "-" {
            return Err(invalid("봉투 최상위에는 키-값 항목만 온다"));
        }
        let Some(colon) = line.find(':') else {
            return Err(invalid(format!("봉투 줄에 `:`이 없다: {line}")));
        };
        let key = line[..colon].trim_end();
        if !valid_key(key) {
            return Err(invalid(format!("봉투 키가 부적절하다: {key}")));
        }
        if entries.iter().any(|(existing, _)| existing == key) {
            return Err(invalid(format!("중복 봉투 키: {key}")));
        }
        let raw_value = line[colon + 1..].trim();
        if raw_value.is_empty() {
            // 들여쓴 자식(중첩 맵 또는 블록 시퀀스)을 한 패스로 모은다.
            // 리터럴 블록 값(`key: |`)의 내용 줄은 네 칸 들여쓰기라서
            // 수집을 끊지 않도록 여기서 함께 소비한다(§5.3).
            let mut children: Vec<(String, EnvValue)> = Vec::new();
            let mut seq_items: Option<Vec<EnvValue>> = None;
            let mut cursor = index + 1;
            while cursor < lines.len() && !lines[cursor].is_empty() {
                let child = lines[cursor];
                reject_tabs(child.as_bytes())?;
                if !two_space_indent(child.as_bytes()) {
                    break;
                }
                let is_seq_item = child.trim_start().starts_with("- ");
                match &mut seq_items {
                    Some(items) => {
                        let Some(item) = child.trim_start().strip_prefix("- ") else {
                            return Err(invalid(format!("{key}의 시퀀스가 어긋난다")));
                        };
                        reject_forbidden_scalar_markers(item)?;
                        items.push(EnvValue::Text(item.to_string()));
                    }
                    None if is_seq_item => {
                        let item = child.trim_start().strip_prefix("- ").unwrap_or("");
                        reject_forbidden_scalar_markers(item)?;
                        seq_items = Some(vec![EnvValue::Text(item.to_string())]);
                    }
                    None => {
                        let Some(colon) = child.find(':') else {
                            return Err(invalid("중첩 맵 항목에 `:`이 없다"));
                        };
                        let child_key = child[..colon].trim_start().trim_end();
                        if !valid_key(child_key) {
                            return Err(invalid(format!("중첩 맵 키가 부적절하다: {child_key}")));
                        }
                        if children.iter().any(|(existing, _)| existing == child_key) {
                            return Err(invalid(format!("중복 봉투 키: {child_key}")));
                        }
                        let raw = child[colon + 1..].trim();
                        if raw == "|" || raw == "|-" || raw == "|+" {
                            // §5.3: 복잡한 확장 데이터는 소유 네임스페이스의
                            // 불투명 리터럴 블록 문자열로 운반된다.
                            cursor += 1;
                            let mut content_lines: Vec<&str> = Vec::new();
                            while cursor < lines.len() {
                                let content = lines[cursor];
                                if content.is_empty() {
                                    content_lines.push("");
                                    cursor += 1;
                                    continue;
                                }
                                let Some(rest) = content.strip_prefix("    ") else {
                                    break;
                                };
                                content_lines.push(rest);
                                cursor += 1;
                            }
                            while content_lines.last().is_some_and(|line| line.is_empty()) {
                                content_lines.pop();
                            }
                            let mut content = content_lines.join("\n");
                            if !content.is_empty() {
                                content.push('\n');
                            }
                            children.push((child_key.to_string(), EnvValue::Text(content)));
                            continue;
                        }
                        children.push((child_key.to_string(), parse_scalar(raw)?));
                    }
                }
                cursor += 1;
            }
            if children.is_empty() && seq_items.is_none() {
                return Err(invalid(format!("빈 값은 금지다: {key}")));
            }
            let value = match seq_items {
                Some(items) => EnvValue::Seq(items),
                None => EnvValue::Map(children),
            };
            entries.push((key.to_string(), value));
            index = cursor;
        } else if raw_value == "|" || raw_value == "|-" || raw_value == "|+" {
            // 리터럴 블록 문자열 — 두 칸 들여쓰기 줄을 내용으로 모은다.
            let mut content_lines: Vec<&str> = Vec::new();
            let mut cursor = index + 1;
            while cursor < lines.len() {
                let content = lines[cursor];
                if content.is_empty() {
                    content_lines.push("");
                    cursor += 1;
                    continue;
                }
                if !two_space_indent(content.as_bytes()) {
                    break;
                }
                content_lines.push(&content[2..]);
                cursor += 1;
            }
            while content_lines.last().is_some_and(|line| line.is_empty()) {
                content_lines.pop();
            }
            let mut content = content_lines.join("\n");
            if !content.is_empty() {
                content.push('\n');
            }
            entries.push((key.to_string(), EnvValue::Text(content)));
            index = cursor;
        } else {
            entries.push((key.to_string(), parse_scalar(raw_value)?));
            index += 1;
        }
    }
    if entries.is_empty() {
        return Err(invalid("봉투가 비어 있다"));
    }
    Ok(Envelope { entries })
}

/// 정칙 소문자 하이픈 UUID(§7.1) — 판독기는 어떤 버전이든 받는다.
pub fn canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        match index {
            8 | 13 | 18 | 23 => {
                if *byte != b'-' {
                    return false;
                }
            }
            14 => {
                if !(b'1'..=b'8').contains(byte) {
                    return false;
                }
            }
            19 => {
                if !matches!(byte, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !(byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)) {
                    return false;
                }
            }
        }
    }
    true
}

/// 정칙 밀리초 UTC 타임스탬프 `YYYY-MM-DDTHH:MM:SS.sssZ`의 형태(§5.1).
/// 실제 달력 날짜 여부는 [`validate`]가 chrono로 검사한다.
pub fn canonical_timestamp_shape(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24 {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(|b| b.is_ascii_digit());
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
        && digits(0..4)
        && digits(5..7)
        && digits(8..10)
        && digits(11..13)
        && digits(14..16)
        && digits(17..19)
        && digits(20..23)
        && bytes[5..7] != *b"00"
        && bytes[8..10] != *b"00"
}

/// 문법만 통과한 봉투에 §5.1·§5.2 의미 규칙을 적용한다(v1 동결 문법).
pub fn validate(envelope: &Envelope) -> Result<(), Outcome> {
    validate_semantics(
        envelope,
        contract::DOCUMENT_FORMAT,
        &[contract::TRANSPORT_DJOT, contract::TRANSPORT_HTML],
    )
}

/// v2 봉투 의미 검사 — Markdown/HTML 바디 프로필만 허용된다. `pdc-djot/1`은
/// v2 아래에서 이송 위반이다(§2: Markdown 프로필은 PDC 1에 존재하지 않았고
/// Djot은 v1 전용이다).
pub fn validate_v2(envelope: &Envelope) -> Result<(), Outcome> {
    validate_semantics(
        envelope,
        contract::DOCUMENT_FORMAT_V2,
        &[contract::TRANSPORT_MARKDOWN, contract::TRANSPORT_HTML],
    )
}

fn validate_semantics(envelope: &Envelope, format: &str, bodies: &[&str]) -> Result<(), Outcome> {
    for required in ["format", "body", "id", "created", "updated", "title"] {
        if envelope.get(required).is_none() {
            return Err(invalid(format!("필수 필드가 없다: {required}")));
        }
    }
    if envelope.text("format") != Some(format) {
        return Err(invalid(format!("형식 식별자는 {format}이어야 한다")));
    }
    match envelope.text("body") {
        Some(body) if bodies.contains(&body) => {}
        // §2: `pdc-djot/1`은 v2 봉투 아래에서 미지원이 아니라 이송 위반이다.
        Some(other) if format == contract::DOCUMENT_FORMAT_V2 && other.starts_with("pdc-djot/") => {
            return Err(Outcome::InvalidTransport(
                "pdc-djot/1은 v1 전용이다 — v2 봉투는 pdc-markdown/1·pdc-html/1만 담는다".into(),
            ));
        }
        Some(other)
            if other.starts_with("pdc-djot/")
                || other.starts_with("pdc-html/")
                || other.starts_with("pdc-markdown/") =>
        {
            return Err(Outcome::UnsupportedBodyVersion(other.to_string()));
        }
        _ => {
            return Err(Outcome::InvalidTransport(
                "body 필드가 알려진 바디 프로필이 아니다".into(),
            ));
        }
    }
    let Some(id) = envelope.text("id") else {
        return Err(Outcome::InvalidDocumentId);
    };
    if !canonical_uuid(id) {
        return Err(Outcome::InvalidDocumentId);
    }
    let parse_stamp = |key: &str| -> Result<chrono::DateTime<chrono::Utc>, Outcome> {
        let value = envelope
            .text(key)
            .ok_or_else(|| invalid(format!("필수 필드가 없다: {key}")))?;
        if !canonical_timestamp_shape(value) {
            return Err(invalid(format!("{key}가 정칙 타임스탬프가 아니다")));
        }
        chrono::DateTime::parse_from_rfc3339(value)
            .map(|parsed| parsed.with_timezone(&chrono::Utc))
            .map_err(|_| invalid(format!("{key}는 실제 달력 날짜가 아니다")))
    };
    let created = parse_stamp("created")?;
    let updated = parse_stamp("updated")?;
    if updated < created {
        return Err(invalid("updated는 created보다 이를 수 없다"));
    }
    if envelope.text("title").is_none() {
        return Err(invalid("title은 빈 문자열이라도 문자열이어야 한다"));
    }
    for list_key in ["tags", "aliases", "cssclasses"] {
        if let Some(items) = envelope.get(list_key) {
            let items = items
                .as_text_seq()
                .ok_or_else(|| invalid(format!("{list_key}는 문자열 시퀀스여야 한다")))?;
            let mut seen = std::collections::HashSet::new();
            for item in items {
                if !seen.insert(item.to_string()) {
                    return Err(invalid(format!("{list_key}에 중복 항목이 있다: {item}")));
                }
            }
        }
    }
    for flag_key in ["favorite", "deleted"] {
        if let Some(value) = envelope.get(flag_key) {
            if value.as_flag().is_none() {
                return Err(invalid(format!("{flag_key}는 불리언이어야 한다")));
            }
        }
    }
    let deleted = envelope
        .get("deleted")
        .and_then(EnvValue::as_flag)
        .unwrap_or(false);
    let deleted_at = envelope.get("deleted_at");
    if deleted != deleted_at.is_some() {
        return Err(invalid("deleted가 참일 때만 deleted_at이 있어야 한다"));
    }
    if let Some(value) = deleted_at {
        let stamp = value
            .as_text()
            .ok_or_else(|| invalid("deleted_at는 문자열이다"))?;
        if !canonical_timestamp_shape(stamp) {
            return Err(invalid("deleted_at가 정칙 타임스탬프가 아니다"));
        }
    }
    if let Some(profile) = envelope.get("profile") {
        let text = profile
            .as_text()
            .ok_or_else(|| invalid("profile은 문자열이다"))?;
        let ok = !text.is_empty()
            && text.len() <= 64
            && text.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
            && text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !ok {
            return Err(invalid("profile은 소문자 kebab-case 토큰이다"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_str(text: &str) -> Result<Envelope, Outcome> {
        parse(text.as_bytes())
    }

    #[test]
    fn parses_scalars_flags_and_flow_sequences() {
        let envelope = parse_str("format: pdc-document/1\nfavorite: true\ntags: [a, b]\n").unwrap();
        assert_eq!(envelope.text("format"), Some("pdc-document/1"));
        assert_eq!(
            envelope.get("favorite").and_then(EnvValue::as_flag),
            Some(true)
        );
        assert_eq!(
            envelope.get("tags").and_then(EnvValue::as_text_seq),
            Some(vec!["a", "b"])
        );
    }

    #[test]
    fn parses_nested_extension_map_and_block_sequence() {
        let envelope = parse_str(
            "x_sawhorse:\n  legacy_id: FDR-001\n  flag: false\ntags:\n  - alpha\n  - beta\n",
        )
        .unwrap();
        let Some(EnvValue::Map(map)) = envelope.get("x_sawhorse") else {
            panic!("확장 맵이어야 한다");
        };
        assert_eq!(
            map[0],
            ("legacy_id".to_string(), EnvValue::Text("FDR-001".into()))
        );
        assert_eq!(
            envelope.get("tags").and_then(EnvValue::as_text_seq),
            Some(vec!["alpha", "beta"])
        );
    }

    #[test]
    fn preserves_unknown_fields_in_observed_order() {
        let envelope =
            parse_str("title: t\nfuture_custom: keep\nformat: pdc-document/1\nbody: pdc-djot/1\n")
                .unwrap();
        let keys: Vec<&str> = envelope.entries.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["title", "future_custom", "format", "body"]);
    }

    #[test]
    fn rejects_forbidden_grammar_features() {
        for (reason, text) in [
            ("중복 키", "a: 1\na: 2\n"),
            ("주석", "title: hello # world\n"),
            ("빈 값", "note:\n"),
            ("탭", "title:\thello\n"),
            ("앵커", "title: &anchor hello\n"),
            ("별칭", "title: *anchor\n"),
            ("태그", "title: !!str hello\n"),
            ("복합 키", "? complex\n"),
            ("깊은 중첩", "x:\n    too: deep\n"),
            ("최상위 시퀀스", "- alpha\n"),
            ("콜론 없는 줄", "just text\n"),
        ] {
            let outcome = parse_str(text).unwrap_err();
            assert_eq!(outcome.code(), "invalid_envelope", "{reason}: {text:?}");
        }
    }

    #[test]
    fn quoted_scalars_may_contain_hash() {
        let envelope = parse_str("title: \"C# guide #1\"\n").unwrap();
        assert_eq!(envelope.text("title"), Some("C# guide #1"));
    }

    #[test]
    fn validates_required_fields_and_semantics() {
        let base = "format: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\n";
        assert!(validate(&parse_str(base).unwrap()).is_ok());

        let no_title = base.replace("title: t\n", "");
        assert_eq!(
            validate(&parse_str(&no_title).unwrap()).unwrap_err().code(),
            "invalid_envelope"
        );
    }

    #[test]
    fn rejects_noncanonical_uuid_and_timestamps() {
        let base = "format: pdc-document/1\nbody: pdc-djot/1\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\n";
        let outcome = validate(
            &parse_str(&format!("{base}id: 018F47C6-8AEA-7F30-A70F-1ED00DF4CC25\n")).unwrap(),
        )
        .unwrap_err();
        assert_eq!(outcome.code(), "invalid_document_id");

        let impossible = "format: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ntitle: t\ncreated: 2026-02-30T12:34:56.789Z\nupdated: 2026-02-30T12:34:56.789Z\n";
        assert_eq!(
            validate(&parse_str(impossible).unwrap())
                .unwrap_err()
                .code(),
            "invalid_envelope"
        );

        let ordering = "format: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ntitle: t\ncreated: 2026-09-13T13:00:00.000Z\nupdated: 2026-09-13T12:00:00.000Z\n";
        assert_eq!(
            validate(&parse_str(ordering).unwrap()).unwrap_err().code(),
            "invalid_envelope"
        );
    }

    #[test]
    fn future_body_profile_is_unsupported_not_malformed() {
        let base = "format: pdc-document/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\nbody: pdc-djot/2\n";
        assert_eq!(
            validate(&parse_str(base).unwrap()).unwrap_err().code(),
            "unsupported_body_version"
        );
    }

    #[test]
    fn deleted_requires_deleted_at() {
        let base = "format: pdc-document/1\nbody: pdc-djot/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-13T12:34:56.789Z\nupdated: 2026-09-13T12:34:56.789Z\ntitle: t\ndeleted: true\n";
        assert_eq!(
            validate(&parse_str(base).unwrap()).unwrap_err().code(),
            "invalid_envelope"
        );
        let tombstone = base.replace(
            "deleted: true\n",
            "deleted: true\ndeleted_at: 2026-09-13T12:34:56.789Z\n",
        );
        assert!(validate(&parse_str(&tombstone).unwrap()).is_ok());
    }

    #[test]
    fn uuid_validator_matches_the_contract_pattern() {
        assert!(canonical_uuid("018f47c6-4a77-7c52-9db8-0e5f9bcb17db"));
        assert!(canonical_uuid("018f47c6-4a77-8c52-9db8-0e5f9bcb17db"));
        assert!(!canonical_uuid("018F47C6-8AEA-7F30-A70F-1ED00DF4CC25"));
        assert!(
            !canonical_uuid("018f47c6-4a77-0c52-9db8-0e5f9bcb17db"),
            "버전 0은 없다"
        );
        assert!(
            !canonical_uuid("018f47c6-4a77-7c52-cdb8-0e5f9bcb17db"),
            "variant 비트"
        );
    }

    #[test]
    fn timestamp_shape_requires_canonical_millis_utc() {
        assert!(canonical_timestamp_shape("2026-09-13T12:34:56.789Z"));
        assert!(
            !canonical_timestamp_shape("2026-09-13T12:34:56Z"),
            "밀리초 필요"
        );
        assert!(!canonical_timestamp_shape("2026-09-13T12:34:56.789+09:00"));
        assert!(!canonical_timestamp_shape("2026-00-13T12:34:56.789Z"));
        // 실제 달력(예: 2026-02-30)은 validate의 chrono 검사가 잡는다.
    }
    #[test]
    fn literal_blocks_work_inside_nested_extension_maps() {
        // §5.3: 복잡한 확장 데이터는 소유 네임스페이스의 불투명 리터럴
        // 블록 문자열로 운반된다 — 블록 뒤의 항목도 살아 있어야 한다.
        let envelope = parse_str(
            "x_sawhorse:\n  legacy_id: FDR-001\n  big_json: |\n    {\"a\":1}\n  after: 1\n",
        )
        .unwrap();
        let Some(EnvValue::Map(map)) = envelope.get("x_sawhorse") else {
            panic!("확장 맵이어야 한다");
        };
        assert_eq!(map.len(), 3, "블록 뒤 항목이 유실되지 않는다: {map:?}");
        assert_eq!(map[1].0, "big_json");
        assert_eq!(map[1].1, EnvValue::Text("{\"a\":1}\n".into()));
        assert_eq!(map[2], ("after".to_string(), EnvValue::Text("1".into())));
    }

    #[test]
    fn comment_hash_at_value_start_is_forbidden() {
        // `key: #comment`는 일반 YAML에서 빈 값+주석이다 — 봉투에서는 금지.
        let outcome = parse_str("title: #not a title\n").unwrap_err();
        assert_eq!(outcome.code(), "invalid_envelope");
    }

    #[test]
    fn nested_brackets_in_flow_sequences_are_rejected() {
        let outcome = parse_str("tags: [[a], b]\n").unwrap_err();
        assert_eq!(outcome.code(), "invalid_envelope");
    }
}
