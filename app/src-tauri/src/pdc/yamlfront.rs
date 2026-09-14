//! v2 안전 YAML 봉투 문법 — PDC-2.0 §5와 질의 문법(PDC-QUERY-1.0 §4).
//!
//! v2 봉투는 일반 YAML 1.2 Core지만 제한이 붙는다: 루트는 단일 맵, 키는 문자열,
//! 값은 JSON 호환(null·불리언·유한 수·문자열·시퀀스·맵), 주석 허용, 앵커·별칭·
//! 태그·복합 키·다중 문서·들여쓰기 탭 금지, 깊이 32·노드 10,000 상한. 일반 YAML
//! 라이브러리는 "모든 금지 기능을 거부하는 검증 뒤에서만" 쓸 수 있다(§5) —
//! 이 모듈이 그 검증의 단일 출처다. 이벤트 스캔(1차)에서 앵커·별칭·태그를
//! 잡고, [`YamlLoader`](yaml_rust2::YamlLoader)(2차)가 중복 키와 구조를
//! 처리한다. 중복 키는 로더 자체가 `ScanError`로 거부한다.
//!
//! 질의(`pdc-query/1`)는 같은 안전 YAML 제한을 공유하고, 알려진 키의 구조만
//! 엄격히 검사한다. 질의는 저장된 검색이지 프로그램이 아니며(§1), Sawhorse는
//! 질의를 실행하지 않는다 — 검증은 읽기 전용 인식을 위한 것이다. 알 수 없는
//! 뷰 타입·뷰 키는 `valid_unexecuted`로 보존된다.

use super::contract;
use super::envelope::{EnvValue, Envelope};
use super::transport::Outcome;
use yaml_rust2::parser::{Event, Parser};
use yaml_rust2::{ScanError, Yaml, YamlLoader};

fn invalid(reason: impl Into<String>) -> Outcome {
    Outcome::InvalidEnvelope(reason.into())
}

fn too_complex() -> Outcome {
    Outcome::DocumentTooComplex
}

/// 이벤트 스캔 — 앵커(`&`), 별칭(`*`), 태그(`!`)는 어떤 노드에서도 금지다.
fn scan_forbidden_events(text: &str) -> Result<(), Outcome> {
    let mut parser = Parser::new_from_str(text);
    loop {
        let (event, _marker) = parser
            .next_token()
            .map_err(|error| scan_error_outcome(&error))?;
        match event {
            Event::StreamEnd => return Ok(()),
            Event::Alias(_) => {
                return Err(invalid("앵커 별칭(`*`)은 봉투에서 금지다"));
            }
            Event::Scalar(_, _, anchor, tag) => {
                reject_anchor_tag(anchor, tag)?;
            }
            Event::SequenceStart(anchor, tag) | Event::MappingStart(anchor, tag) => {
                reject_anchor_tag(anchor, tag)?;
            }
            _ => {}
        }
    }
}

fn reject_anchor_tag(anchor: usize, tag: Option<yaml_rust2::parser::Tag>) -> Result<(), Outcome> {
    if anchor != 0 {
        return Err(invalid("앵커(`&`)는 봉투에서 금지다"));
    }
    if tag.is_some() {
        return Err(invalid("태그(`!`)는 봉투에서 금지다"));
    }
    Ok(())
}

fn scan_error_outcome(error: &ScanError) -> Outcome {
    invalid(format!("봉투 YAML 해석 실패: {error}"))
}

/// `.inf`·`.nan` 계열(부호·대소문자 변형 포함) 비유한 수 철자.
fn is_nonfinite_spelling(value: &str) -> bool {
    let trimmed = value.trim();
    let signed = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    matches!(signed.to_ascii_lowercase().as_str(), ".inf" | ".nan")
}

/// 파싱된 [`Yaml`] 트리를 봉투 값으로 변환하며 상한을 집행한다.
fn convert(value: &Yaml, depth: usize, nodes: &mut usize) -> Result<EnvValue, Outcome> {
    if depth > contract::YAML_MAX_DEPTH {
        return Err(too_complex());
    }
    *nodes += 1;
    if *nodes > contract::YAML_MAX_NODES {
        return Err(too_complex());
    }
    match value {
        Yaml::String(text) => Ok(EnvValue::Text(text.clone())),
        Yaml::Boolean(flag) => Ok(EnvValue::Flag(*flag)),
        Yaml::Integer(number) => Ok(EnvValue::Number(number.to_string())),
        Yaml::Real(spelling) => {
            if is_nonfinite_spelling(spelling) {
                return Err(invalid("비유한 수(`.inf`·`.nan`)는 금지다"));
            }
            Ok(EnvValue::Number(spelling.clone()))
        }
        Yaml::Null => Ok(EnvValue::Null),
        Yaml::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                out.push(convert(item, depth + 1, nodes)?);
            }
            Ok(EnvValue::Seq(out))
        }
        Yaml::Hash(pairs) => {
            let mut out = Vec::with_capacity(pairs.len());
            for (key, value) in pairs.iter() {
                let Yaml::String(key) = key else {
                    return Err(invalid("봉투 키는 문자열이어야 한다"));
                };
                out.push((key.clone(), convert(value, depth + 1, nodes)?));
            }
            Ok(EnvValue::Map(out))
        }
        Yaml::Alias(_) | Yaml::BadValue => Err(invalid("봉투 값이 지원되지 않는 YAML 노드다")),
    }
}

/// v2 봉투 바이트(경계선 제외)를 안전 YAML로 해석한다.
pub fn parse(envelope: &[u8]) -> Result<Envelope, Outcome> {
    let text =
        String::from_utf8(envelope.to_vec()).map_err(|_| invalid("봉투는 UTF-8이어야 한다"))?;
    if text.trim().is_empty() {
        return Err(invalid("봉투가 비어 있다"));
    }
    scan_forbidden_events(&text)?;
    let documents = YamlLoader::load_from_str(&text).map_err(|error| scan_error_outcome(&error))?;
    if documents.is_empty() {
        return Err(invalid("봉투가 비어 있다"));
    }
    if documents.len() > 1 {
        return Err(invalid("다중 문서 스트림은 봉투에서 금지다"));
    }
    let Yaml::Hash(root) = &documents[0] else {
        return Err(invalid("봉투 최상위는 맵이어야 한다"));
    };
    if root.is_empty() {
        return Err(invalid("봉투가 비어 있다"));
    }
    let mut nodes = 0usize;
    let mut entries = Vec::with_capacity(root.len());
    for (key, value) in root.iter() {
        let Yaml::String(key) = key else {
            return Err(invalid("봉투 키는 문자열이어야 한다"));
        };
        entries.push((key.clone(), convert(value, 1, &mut nodes)?));
    }
    Ok(Envelope { entries })
}

// ---------- pdc-query/1 ----------

/// 질의 검사 판정. `Unexecuted`는 구조가 안전하지만 이식 하위집합 밖의
/// 구성(알 수 없는 뷰 타입·뷰 키)을 담는다 — 보존되고 실행되지 않는다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryStatus {
    /// 이식 가능 하위집합 전부 — (여기서 실행하지 않는다) 실행 가능한 질의.
    Executable,
    /// 알 수 없는 뷰 등 — 소스로 보존되고 실행되지 않는다(§4.6).
    Unexecuted,
}

fn invalid_query(reason: impl Into<String>) -> Outcome {
    Outcome::InvalidQuery(reason.into())
}

/// `.base` 파일 본문(전체)을 질의 문법으로 검사한다. 실행은 하지 않는다.
pub fn validate_query(bytes: &[u8]) -> Result<QueryStatus, Outcome> {
    let envelope = parse(bytes).map_err(|outcome| match outcome {
        Outcome::InvalidEnvelope(reason) => invalid_query(reason),
        Outcome::DocumentTooComplex => invalid_query("질의 노드·깊이 상한을 넘는다"),
        other => other,
    })?;
    // `parse`는 이미 루트 맵임을 보장한다(비맵 루트는 invalid_envelope).
    let root = &envelope.entries;
    let mut status = QueryStatus::Executable;
    for (key, value) in root {
        match key.as_str() {
            "filters" => validate_expression_value(value)?,
            "formulas" | "summaries" => {
                let EnvValue::Map(formulas) = value else {
                    return Err(invalid_query(format!("{key}는 맵이어야 한다")));
                };
                for (name, expression) in formulas {
                    let Some(expression) = expression.as_text() else {
                        return Err(invalid_query(format!("{key}.{name}은 문자열식이어야 한다")));
                    };
                    validate_expression(expression)?;
                }
            }
            "properties" => {
                let EnvValue::Map(properties) = value else {
                    return Err(invalid_query("properties는 맵이어야 한다"));
                };
                for (reference, display) in properties {
                    if reference.is_empty() {
                        return Err(invalid_query("빈 속성 참조가 있다"));
                    }
                    if !matches!(display, EnvValue::Map(_)) {
                        return Err(invalid_query(format!(
                            "properties.{reference}는 표시 메타데이터 맵이어야 한다"
                        )));
                    }
                }
            }
            "views" => {
                let EnvValue::Seq(views) = value else {
                    return Err(invalid_query("views는 시퀀스여야 한다"));
                };
                for view in views {
                    if validate_view(view)? == QueryStatus::Unexecuted {
                        status = QueryStatus::Unexecuted;
                    }
                }
            }
            // 알 수 없는 최상위 키는 보존 대상이며 실행을 막지 않는다(§4).
            _ => {}
        }
    }
    Ok(status)
}

/// 뷰 하나의 구조 검사. 알 수 없는 타입·키는 `Unexecuted`다(§4.5).
fn validate_view(view: &EnvValue) -> Result<QueryStatus, Outcome> {
    let EnvValue::Map(entries) = view else {
        return Err(invalid_query("view는 맵이어야 한다"));
    };
    const KNOWN: [&str; 7] = [
        "type",
        "name",
        "limit",
        "groupBy",
        "filters",
        "order",
        "summaries",
    ];
    let mut status = QueryStatus::Executable;
    for (key, _) in entries {
        if !KNOWN.contains(&key.as_str()) {
            status = QueryStatus::Unexecuted;
        }
    }
    let view_type = entries
        .iter()
        .find(|(key, _)| key == "type")
        .and_then(|(_, value)| value.as_text());
    match view_type {
        Some("table") | Some("list") => {}
        Some(_) => status = QueryStatus::Unexecuted,
        None => return Err(invalid_query("view에 type이 없다")),
    }
    for (key, value) in entries {
        match key.as_str() {
            "type" => {}
            "name" => {
                if value.as_text().is_none() {
                    return Err(invalid_query("view name은 문자열이어야 한다"));
                }
            }
            "limit" => match value {
                EnvValue::Number(spelling) => {
                    if spelling.trim().starts_with('-') {
                        return Err(invalid_query("view limit은 음수일 수 없다"));
                    }
                }
                _ => return Err(invalid_query("view limit은 정수여야 한다")),
            },
            "groupBy" => {
                let EnvValue::Map(group) = value else {
                    return Err(invalid_query("groupBy는 맵이어야 한다"));
                };
                let direction = group
                    .iter()
                    .find(|(key, _)| key == "direction")
                    .and_then(|(_, value)| value.as_text());
                if !matches!(direction, Some("ASC") | Some("DESC")) {
                    return Err(invalid_query("groupBy.direction은 ASC·DESC다"));
                }
                if !group.iter().any(|(key, _)| key == "property") {
                    return Err(invalid_query("groupBy에 property가 없다"));
                }
            }
            "filters" => validate_expression_value(value)?,
            "order" => {
                let EnvValue::Seq(order) = value else {
                    // 매핑 형태의 order는 폐기된 초안 구문이다 — 호환 해석하지
                    // 않는다(§4.5: order는 속성 참조 시퀀스다).
                    return Err(invalid_query(
                        "order는 속성 참조 시퀀스여야 한다(매핑 형태는 폐기됐다)",
                    ));
                };
                for reference in order {
                    validate_property_reference(reference)?;
                }
            }
            "summaries" => {
                let EnvValue::Map(summaries) = value else {
                    // 시퀀스 형태의 view summaries는 폐기된 초안 구문이다.
                    return Err(invalid_query(
                        "view summaries는 참조→요약 맵이어야 한다(시퀀스 형태는 폐기됐다)",
                    ));
                };
                for (reference, summary) in summaries {
                    validate_property_reference(&EnvValue::Text(reference.clone()))?;
                    if summary.as_text().is_none() {
                        return Err(invalid_query("요약 이름은 문자열이어야 한다"));
                    }
                }
            }
            // 알 수 없는 뷰 키 — 이미 Unexecuted다.
            _ => {}
        }
    }
    Ok(status)
}

fn validate_property_reference(value: &EnvValue) -> Result<(), Outcome> {
    let Some(reference) = value.as_text() else {
        return Err(invalid_query("order 항목은 속성 참조 문자열이어야 한다"));
    };
    if reference.is_empty() || reference.contains(char::is_whitespace) {
        return Err(invalid_query(format!("부적절한 속성 참조: {reference:?}")));
    }
    Ok(())
}

/// 필터 식 — 문자열 하나이거나 `and`/`or`/`not` 중 정확히 하나를 가진 맵이며,
/// 그 값은 식 문자열·재귀 맵의 시퀀스다(§4.1). 스칼라 `not:` 형태는 폐기된
/// 초안 구문이라 받지 않는다.
fn validate_expression_value(value: &EnvValue) -> Result<(), Outcome> {
    match value {
        EnvValue::Text(expression) => validate_expression(expression),
        EnvValue::Map(branches) => {
            let combinators = ["and", "or", "not"];
            let present: Vec<&&str> = combinators
                .iter()
                .filter(|name| branches.iter().any(|(key, _)| key == *name))
                .collect();
            if present.len() != 1 || branches.len() != 1 {
                return Err(invalid_query(
                    "필터 맵은 and·or·not 중 정확히 하나를 가져야 한다",
                ));
            }
            let Some((_, items)) = branches.iter().next() else {
                return Err(invalid_query("빈 필터 맵이다"));
            };
            let EnvValue::Seq(items) = items else {
                return Err(invalid_query("and·or·not의 값은 시퀀스여야 한다"));
            };
            for item in items {
                match item {
                    EnvValue::Text(expression) => validate_expression(expression)?,
                    EnvValue::Map(_) => validate_expression_value(item)?,
                    _ => return Err(invalid_query("필터 항목은 식 문자열이거나 맵이다")),
                }
            }
            Ok(())
        }
        _ => Err(invalid_query("필터는 문자열식이거나 조합 맵이어야 한다")),
    }
}

/// 식 문자열의 게이트 검사. 실행 계층이 아니라 계약 어휘의 최소 문양만 본다:
/// 비어 있지 않고, 비교는 `==`만 허용된다(단일 `=`는 폐기된 초안 구문).
fn validate_expression(expression: &str) -> Result<(), Outcome> {
    if expression.trim().is_empty() {
        return Err(invalid_query("빈 식이 있다"));
    }
    let bytes = expression.as_bytes();
    for (index, window) in bytes.iter().enumerate() {
        if *window != b'=' {
            continue;
        }
        let prev = if index == 0 { b' ' } else { bytes[index - 1] };
        let next = bytes.get(index + 1).copied().unwrap_or(b' ');
        let already = matches!(prev, b'!' | b'<' | b'>' | b'=') || next == b'=';
        if !already {
            return Err(invalid_query(
                "비교 연산자는 `==`만 허용된다(단일 `=`는 폐기된 초안 구문이다)",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUIRED: &str = "format: pdc-document/2\nbody: pdc-markdown/1\nid: 018f47c6-4a77-7c52-9db8-0e5f9bcb17db\ncreated: 2026-09-14T12:34:56.789Z\nupdated: 2026-09-14T12:34:56.789Z\ntitle: t\n";

    #[test]
    fn parses_required_keys_comments_and_user_properties() {
        let text = format!(
            "# editorial comment\n{REQUIRED}status: draft\npriority: 3\ndue: 2026-09-20\nowner: null\nreviewed: true\nx_sawhorse:\n  legacy_id: FDR-001\n  scores: [1, 2, 3]\n"
        );
        let envelope = parse(text.as_bytes()).unwrap();
        assert_eq!(envelope.text("format"), Some("pdc-document/2"));
        assert_eq!(
            envelope.get("priority"),
            Some(&EnvValue::Number("3".into()))
        );
        assert_eq!(
            envelope.get("due"),
            Some(&EnvValue::Text("2026-09-20".into()))
        );
        assert_eq!(envelope.get("owner"), Some(&EnvValue::Null));
        assert_eq!(
            envelope.get("status"),
            Some(&EnvValue::Text("draft".into()))
        );
        let Some(EnvValue::Map(x)) = envelope.get("x_sawhorse") else {
            panic!("확장 맵");
        };
        assert_eq!(
            x[1],
            (
                "scores".into(),
                EnvValue::Seq(vec![
                    EnvValue::Number("1".into()),
                    EnvValue::Number("2".into()),
                    EnvValue::Number("3".into())
                ])
            )
        );
    }

    #[test]
    fn rejects_anchors_aliases_tags_duplicates_and_multi_doc() {
        for (text, code) in [
            ("a: &x 1\nb: *x\n", "invalid_envelope"),
            ("a: !!str 1\n", "invalid_envelope"),
            ("a: !custom 1\n", "invalid_envelope"),
            (".inf: 1\n", "invalid_envelope"),
            ("42: answer\n", "invalid_envelope"),
            ("a: .nan\n", "invalid_envelope"),
            ("a: 1\n---\nb: 2\n", "invalid_envelope"),
            ("[1, 2, 3]\n", "invalid_envelope"),
            ("just a string\n", "invalid_envelope"),
        ] {
            let outcome = parse(text.as_bytes()).unwrap_err();
            assert_eq!(outcome.code(), code, "{text:?}");
        }
    }

    #[test]
    fn yaml_duplicate_key_is_invalid_envelope() {
        let outcome = parse(b"a: 1\nb: 2\na: 3\n").unwrap_err();
        assert_eq!(outcome.code(), "invalid_envelope");
    }

    #[test]
    fn depth_and_node_caps_are_document_too_complex() {
        let mut deep = String::new();
        for level in 1..=33 {
            deep.push_str(&"  ".repeat(level - 1));
            deep.push_str(format!("k{level}:\n").as_str());
        }
        deep.push_str(&"  ".repeat(33));
        deep.push_str("leaf: 1\n");
        assert_eq!(
            parse(deep.as_bytes()).unwrap_err().code(),
            "document_too_complex"
        );

        let mut wide = String::new();
        for index in 0..10_001 {
            wide.push_str(format!("k{index}: {index}\n").as_str());
        }
        assert_eq!(
            parse(wide.as_bytes()).unwrap_err().code(),
            "document_too_complex"
        );
    }

    #[test]
    fn required_envelope_passes_and_is_the_v2_grammar() {
        assert!(parse(REQUIRED.as_bytes()).is_ok());
    }

    #[test]
    fn query_grammar_accepts_the_portable_subset() {
        let status = validate_query(
            br#"filters:
  and:
    - tags.contains("standard")
    - not:
        - 'deleted == true'
formulas:
  score: "priority * 2"
properties:
  priority:
    displayName: Priority
views:
  - type: table
    name: Standard notes
    limit: 50
    order:
      - file.name
      - note.priority
    summaries:
      note.priority: Average
"#,
        )
        .unwrap();
        assert_eq!(status, QueryStatus::Executable);
    }

    #[test]
    fn unknown_view_type_is_valid_but_unexecuted() {
        let status = validate_query(
            br#"filters:
  or:
    - 'favorite == true'
icon: base-icon
views:
  - type: cards
    name: Card gallery
    order:
      - note.updated
"#,
        )
        .unwrap();
        assert_eq!(status, QueryStatus::Unexecuted);
    }

    #[test]
    fn deprecated_order_and_summary_shapes_are_rejected() {
        let mapping_order = b"views:\n  - type: table\n    name: n\n    order:\n      - property: priority\n        direction: ASC\n";
        assert_eq!(
            validate_query(mapping_order).unwrap_err().code(),
            "invalid_query"
        );
        let sequence_summaries = b"views:\n  - type: table\n    name: n\n    summaries:\n      - property: priority\n        functions: [count]\n";
        assert_eq!(
            validate_query(sequence_summaries).unwrap_err().code(),
            "invalid_query"
        );
        let scalar_not =
            b"filters:\n  and:\n    - tags.contains(\"x\")\n    - not: 'deleted == true'\n";
        assert_eq!(
            validate_query(scalar_not).unwrap_err().code(),
            "invalid_query"
        );
        let single_equals = b"filters: 'deleted = true'\n";
        assert_eq!(
            validate_query(single_equals).unwrap_err().code(),
            "invalid_query"
        );
    }

    #[test]
    fn malformed_query_yaml_is_invalid_query() {
        assert_eq!(
            validate_query(b"filters:\n  and: [unclosed\n")
                .unwrap_err()
                .code(),
            "invalid_query"
        );
        assert_eq!(
            validate_query(b"filters: 'a == b'\nextra:\n  a: 1\n  a: 2\n")
                .unwrap_err()
                .code(),
            "invalid_query"
        );
    }
}
