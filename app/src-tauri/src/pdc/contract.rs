//! PDC 계약 고정 — `docs/architecture/pdc-migration.md` Stage 0.
//!
//! 권위는 외부 portable-document-contract 저장소다:
//! `github.com/a7garden/portable-document-contract`, 규범 문서
//! `references/PDC-2.0.md` (public draft 2, 2026-09-14, 태그
//! `v2.0.0-draft.2`, 커밋 0ee51ea에 고정), 동작 개정 `conformance/corpus.json`
//! (`pdc-document-conformance/2`, revision 2). 이 모듈은 그 계약이 명시한
//! 식별자·상한·규칙만 Sawhorse에 고정하고 새 계약 의미를 정의하지 않는다.
//! 계약 변경은 외부 저장소에 먼저 반영되고 이 고정물은 그 결과를 따라간다.

#![allow(dead_code)] // Stage 0 동결물 — Stage 1~4가 소비한다.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// PDC 문서 계약 형식 식별자(§2). 정확히 대소문자를 구비해 비교한다.
pub const DOCUMENT_FORMAT: &str = "pdc-document/1";

/// v2 문서 계약 형식 식별자 — Markdown 우선 정본. v1 문서는 가시 읽기 전용
/// 레거시로 남고 절대 자동 변환되지 않는다(§1·§14).
pub const DOCUMENT_FORMAT_V2: &str = "pdc-document/2";

/// 적합성 말뭉치 형식 식별자(v2). v1 개정(revision 3)은 더 이상 핀 대상이
/// 아니며, v1 판독기는 v2 말뭉치의 legacy 사례로 시험한다.
pub const CORPUS_FORMAT: &str = "pdc-document-conformance/2";

/// 고정된 적합성 말뭉치 개정(§2: "구현은 명명된 corpus revision으로 시험해야
/// 한다"). 정본 `conformance/corpus.json`의 revision과 일치한다.
pub const CORPUS_REVISION: u32 = 2;

/// 규범 문서가 고정된 업스트림 커밋(태그 `v2.0.0-draft.2`).
pub const SPEC_COMMIT: &str = "0ee51ea";

/// 규범 문서 태그.
pub const SPEC_TAG: &str = "v2.0.0-draft.2";

/// 일반 정문서 바디 프로필 — 동결된 Djot 방언(§6.1).
pub const TRANSPORT_DJOT: &str = "pdc-djot/1";

/// v2 일반 정문서 바디 프로필 — Obsidian 호환 Markdown(소문자 `.md`).
pub const TRANSPORT_MARKDOWN: &str = "pdc-markdown/1";

/// HTML 이송 미디어 타입(§4.3) — v2 봉투. v1 봉투는 [`MEDIA_TYPE_HTML_V1`]이다.
pub const MEDIA_TYPE_HTML: &str = "application/vnd.pdc.document+html;version=2";

/// HTML 이송 미디어 타입(§4.3) — v1 레거시 봉투.
pub const MEDIA_TYPE_HTML_V1: &str = "application/vnd.pdc.document+html;version=1";

/// Djot 이송 미디어 타입(§4.2) — v1 레거시 전용.
pub const MEDIA_TYPE_DJOT: &str = "application/vnd.pdc.document+djot;version=1";

/// 서식 있는 정문서 바디 프로필 — 원본 보존 HTML(§6.2).
pub const TRANSPORT_HTML: &str = "pdc-html/1";

/// Markdown 본문의 안정 블록 표적 문자 집합(§7.2): `[A-Za-z0-9-]+` — 밑줄은
/// 포함되지 않는다.
pub fn is_caret_target_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub const MEDIA_TYPE_MARKDOWN: &str = "application/vnd.pdc.document+markdown;version=2";

/// Markdown 정문서 확장자 — 소문자 `.md`만 정칙이다.
pub const MARKDOWN_EXTENSION: &str = "md";

/// Markdown 본문의 안정 블록 표적 문양 — caret 표기 `^b-<uuid>`(v2 §7.2).
pub const MARKDOWN_BLOCK_TARGET_PREFIX: &str = "^b-";

/// v2 봉투 안전 YAML 상한: 중첩 깊이(§5-v2).
pub const YAML_MAX_DEPTH: usize = 32;

/// v2 봉투 안전 YAML 상한: 노드 수(§5-v2).
pub const YAML_MAX_NODES: usize = 10_000;

/// 별도 질의 계층 식별자 — Obsidian Bases 호환 `.base`/```base 블록.
/// 읽기 전용이며 승인 근거가 되지 않는다. Sawhorse는 질의를 실행하지 않는다.
pub const QUERY_FORMAT: &str = "pdc-query/1";

/// 질의 이송 상한(PDC-QUERY-1.0 §3.1) — 1 MiB.
pub const QUERY_MAX_BYTES: u64 = 1024 * 1024;
/// 질의 파일 확장자 — 소문자 `.base`(PDC-QUERY-1.0 §3.1).
pub const QUERY_BASE_EXTENSION: &str = "base";

/// 볼트 정검 표시(vault manifest) 파일 경로(§3.1).
pub const VAULT_MANIFEST_RELATIVE: &str = ".pdc/vault.json";

/// 볼트 정검 표시 형식 식별자(§3.1).
pub const VAULT_MANIFEST_FORMAT: &str = "pdc-vault/1";

/// 문서 참조 링크 접두사(§8.1). `<scheme><uuid>`와
/// `<scheme><uuid>#b-<block-uuid>` 형태만 유효하다.
pub const DOCUMENT_LINK_SCHEME: &str = "pdc://document/";

/// 관리형 자산 링크 접두사(§8.2). `<scheme><64-hex>`가 정칙 URI다.
pub const ASSET_LINK_PREFIX: &str = "pdc://asset/sha256/";

/// 관리형 자산의 볼트 상대 저장 경로 접두사(§8.2):
/// `.pdc/assets/sha256/<앞 두 글자>/<64-hex>`.
pub const ASSET_STORE_PREFIX: &str = ".pdc/assets/sha256/";

/// 정문서 이송 상한(§4.1) — 봉투와 본문을 합해 4 MiB.
pub const DOCUMENT_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 관리형 자산 상한(§8.2) — 64 MiB. 더 큰 자원은 외부로 둔다.
pub const ASSET_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 안정 블록·인라인 표적 접두사(§7.2): Djot `#b-<uuid>`, HTML `id="b-<uuid>"`.
pub const BLOCK_TARGET_PREFIX: &str = "b-";

/// `pdc-djot/1`이 고정한 업스트림 Djot 구문 기준 커밋(§2).
pub const DJOT_DIALECT_BASELINE: &str = "d77f8a0cbea6785c42b3e2b03463195b5ca6f7c7";

/// Sawhorse 확장 객체 이름(§5.3 등록명록에 등록된 네임스페이스).
pub const EXTENSION_OBJECT: &str = "x_sawhorse";

/// `x_sawhorse`의 Sawhorse 쓰기 어휘 동결(v1) JSON Schema. 계약은 확장 맵의
/// 모든 스칼라를 보존하라고 요구하지만, Sawhorse가 **새로 쓰는** 필드는 이
/// 범위로 제한한다: `legacy_id`(비-UUID 레거시 ID 보존)와 `<name>_json`
/// 불투명 JSON 문자열뿐. 그 밖의 키는 읽을 땐 보존하고 쓸 땐 만들지 않는다.
pub const X_SAWHORSE_WRITER_SCHEMA_V1: &str = r#"{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:pdc:x-sawhorse:writer-v1",
  "title": "x_sawhorse writer vocabulary (Sawhorse-frozen v1)",
  "type": "object",
  "properties": {
    "legacy_id": { "type": "string", "minLength": 1 }
  },
  "patternProperties": {
    "^[a-z][a-z0-9_]*_json$": { "type": "string" }
  },
  "additionalProperties": false
}"#;

/// 확장 맵의 스칼라 값(§5.3 + envelope.schema.json `extensionMap`):
/// 문자열, 불리언, 단일 줄 문자열 시퀀스. 중첩 맵·객체 배열은 봉투 문법이
/// 금지하므로 역직렬화 오류이다. 복잡 데이터는 소유 네임스페이스 안에
/// 불투명 리터럴 블록 문자열로 운반하며, `_json`으로 끝나는 자식 키가
/// UTF-8 JSON을 담는 것이 관례다(소유 앱만 해석).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum XValue {
    /// 문자열 값.
    Text(String),
    /// 불리언 값.
    Flag(bool),
    /// 평평한 문자열 시퀀스.
    TextList(Vec<String>),
}

/// `x_sawhorse` 확장 맵의 해석 뷰.
///
/// 읽기는 보존이 원칙이다(§5.3: 알 수 없는 필드는 잘못됨이 아니라 보존
/// 대상). 어떤 스칼라 키든 담을 수 있고, Sawhorse가 쓰는 어휘는
/// [`XSawhorse::set_legacy_id`]·[`XSawhorse::set_json_field`]로 동결한다.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct XSawhorse {
    /// 확장 스칼라 필드. 비공개 — 쓰기는 검증된 헬퍼로만 허용해 동결된
    /// 쓰기 어휘가 타입 수준에서 강제된다. serde `flatten`은 비공개여도
    /// 채워 준다.
    #[serde(flatten)]
    fields: BTreeMap<String, XValue>,
}

impl XSawhorse {
    /// 보존된 스칼라를 읽는다.
    pub fn get(&self, key: &str) -> Option<&XValue> {
        self.fields.get(key)
    }

    /// 보존된 모든 스칼라를 관찰 순서 없이(사전순 맵) 순회한다.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &XValue)> {
        self.fields.iter()
    }
}

impl XSawhorse {
    /// `legacy_id`(이관 전 원래 식별자)를 쓴다. 원래 ID가 UUID였다면 문서
    /// `id`가 그 값을 가지므로 이 필드는 비어 있어야 한다 — 빈 값 쓰기는
    /// 거부한다.
    pub fn set_legacy_id(&mut self, legacy_id: impl Into<String>) -> Result<(), String> {
        let value = legacy_id.into();
        if value.is_empty() {
            return Err("x_sawhorse.legacy_id는 빈 문자열일 수 없습니다".into());
        }
        self.fields.insert("legacy_id".into(), XValue::Text(value));
        Ok(())
    }

    /// `legacy_id` 읽기.
    pub fn legacy_id(&self) -> Option<&str> {
        match self.fields.get("legacy_id") {
            Some(XValue::Text(text)) => Some(text.as_str()),
            _ => None,
        }
    }

    /// 불투명 JSON 확장을 쓴다. `name`은 `_json` 접미를 뺀 이름이고 리터럴은
    /// 문자열 그대로 보존된다(재정렬·정규화 없음, 소유 앱만 해석).
    pub fn set_json_field(
        &mut self,
        name: &str,
        json_literal: impl Into<String>,
    ) -> Result<(), String> {
        validate_json_name(name)?;
        self.fields
            .insert(format!("{name}_json"), XValue::Text(json_literal.into()));
        Ok(())
    }

    /// `<name>_json` 불투명 문자열 읽기.
    pub fn json_field(&self, name: &str) -> Option<&str> {
        match self.fields.get(&format!("{name}_json")) {
            Some(XValue::Text(text)) => Some(text.as_str()),
            _ => None,
        }
    }

    /// 문서 참조 링크(§8.1).
    pub fn document_link(uuid: &str) -> String {
        format!("{}{uuid}", DOCUMENT_LINK_SCHEME)
    }
}

/// `<name>_json`의 이름부 검사: 비어 있지 않고 소문자로 시작하며
/// `[a-z0-9_]`만 담는다.
fn validate_json_name(name: &str) -> Result<(), String> {
    let Some(first) = name.bytes().next() else {
        return Err("x_sawhorse 확장 이름이 비어 있습니다".into());
    };
    let ok = first.is_ascii_lowercase()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "x_sawhorse 확장 이름 `{name}`은(는) [a-z][a-z0-9_]* 형태여야 합니다"
        ))
    }
}

/// 소문자 64-hex SHA-256 다이제스트인지(§8.2 다이제스트는 소문자다).
pub fn is_sha256_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 관리형 자산의 정칙 URI(§8.2).
pub fn asset_uri(digest: &str) -> Result<String, String> {
    if is_sha256_digest(digest) {
        Ok(format!("{}{digest}", ASSET_LINK_PREFIX))
    } else {
        Err(format!("SHA-256 다이제스트가 아닙니다: {digest}"))
    }
}

/// 관리형 자산의 볼트 상대 저장 경로(§8.2):
/// `.pdc/assets/sha256/<앞 두 글자>/<64-hex>`.
pub fn asset_relative_path(digest: &str) -> Result<String, String> {
    if is_sha256_digest(digest) {
        Ok(format!("{}{}/{}", ASSET_STORE_PREFIX, &digest[..2], digest))
    } else {
        Err(format!("SHA-256 다이제스트가 아닙니다: {digest}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contract_pins_match_the_authoritative_v2_draft() {
        assert_eq!(DOCUMENT_FORMAT, "pdc-document/1");
        assert_eq!(DOCUMENT_FORMAT_V2, "pdc-document/2");
        assert_eq!(TRANSPORT_DJOT, "pdc-djot/1");
        assert_eq!(TRANSPORT_MARKDOWN, "pdc-markdown/1");
        assert_eq!(TRANSPORT_HTML, "pdc-html/1");
        assert_eq!(VAULT_MANIFEST_FORMAT, "pdc-vault/1");
        assert_eq!(VAULT_MANIFEST_RELATIVE, ".pdc/vault.json");
        assert_eq!(CORPUS_FORMAT, "pdc-document-conformance/2");
        assert_eq!(CORPUS_REVISION, 2);
        assert_eq!(SPEC_TAG, "v2.0.0-draft.2");
        assert!(SPEC_COMMIT.starts_with("0ee51ea"));
        assert_eq!(QUERY_FORMAT, "pdc-query/1");
        assert_eq!(
            MEDIA_TYPE_DJOT,
            "application/vnd.pdc.document+djot;version=1"
        );
        assert_eq!(
            MEDIA_TYPE_HTML_V1,
            "application/vnd.pdc.document+html;version=1"
        );
        assert_eq!(
            MEDIA_TYPE_HTML,
            "application/vnd.pdc.document+html;version=2"
        );
        assert_eq!(
            MEDIA_TYPE_MARKDOWN,
            "application/vnd.pdc.document+markdown;version=2"
        );
        assert_eq!(BLOCK_TARGET_PREFIX, "b-");
        assert_eq!(MARKDOWN_BLOCK_TARGET_PREFIX, "^b-");
        assert!(is_caret_target_id("dup-block-id"));
        assert!(is_caret_target_id("018f47c6-c718-728c-9d91-b2bc700814bb"));
        assert!(!is_caret_target_id("under_score"));
        assert!(!is_caret_target_id(""));
        assert_eq!(
            DJOT_DIALECT_BASELINE,
            "d77f8a0cbea6785c42b3e2b03463195b5ca6f7c7"
        );
    }
    #[test]
    fn transport_limits_match_the_contract() {
        assert_eq!(DOCUMENT_MAX_BYTES, 4 * 1024 * 1024);
        assert_eq!(ASSET_MAX_BYTES, 64 * 1024 * 1024);
    }

    #[test]
    fn writer_schema_closes_the_sawhorse_vocabulary() {
        let schema: serde_json::Value = serde_json::from_str(X_SAWHORSE_WRITER_SCHEMA_V1)
            .expect("쓰기 어휘 스키마는 유효한 JSON이어야 한다");
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        assert_eq!(schema["properties"]["legacy_id"]["minLength"], 1);
    }

    #[test]
    fn x_sawhorse_round_trips_scalars_and_opaque_json() {
        let mut extension = XSawhorse::default();
        extension.set_legacy_id("proj-2024-골든").unwrap();
        extension
            .set_json_field("workflow", r#"{"b":2,"a":1}"#)
            .unwrap();

        let json = serde_json::to_string(&extension).unwrap();
        let round: XSawhorse = serde_json::from_str(&json).unwrap();
        assert_eq!(round, extension);
        assert_eq!(round.legacy_id(), Some("proj-2024-골든"));
        assert_eq!(round.json_field("workflow"), Some(r#"{"b":2,"a":1}"#));
    }

    #[test]
    fn x_sawhorse_preserves_scalars_it_does_not_write() {
        // §5.3: 읽는 앱은 알 수 없는 확장 스칼라도 보존해야 한다.
        let json = r#"{"legacy_id":"old","flag":true,"labels":["a","b"],"other_json":"{}"}"#;
        let extension: XSawhorse = serde_json::from_str(json).unwrap();
        assert_eq!(extension.legacy_id(), Some("old"));
        assert_eq!(extension.get("flag"), Some(&XValue::Flag(true)));
        assert_eq!(
            extension.get("labels"),
            Some(&XValue::TextList(vec!["a".into(), "b".into()]))
        );
        // 보존된 값은 재직렬화 때 그대로 남는다.
        let again = serde_json::to_string(&extension).unwrap();
        let re: XSawhorse = serde_json::from_str(&again).unwrap();
        assert_eq!(re, extension);
    }

    #[test]
    fn x_sawhorse_rejects_non_scalar_values() {
        // 봉투 문법이 금지하는 중첩 맵·객체 배열은 오류다.
        assert!(serde_json::from_str::<XSawhorse>(r#"{"nested":{"a":1}}"#).is_err());
        assert!(serde_json::from_str::<XSawhorse>(r#"{"rows":[{"a":1}]}"#).is_err());
        assert!(serde_json::from_str::<XSawhorse>(r#"{"mixed":[1,"a"]}"#).is_err());
    }

    #[test]
    fn writer_helpers_enforce_the_frozen_vocabulary() {
        let mut extension = XSawhorse::default();
        assert!(extension.set_legacy_id("").is_err());
        assert!(extension.set_json_field("1Bad", "{}").is_err());
        assert!(extension.set_json_field("a-b", "{}").is_err());
        assert!(extension.set_json_field("", "{}").is_err());
        assert!(extension.set_json_field("ok_name", "[1,  2]").is_ok());
        assert_eq!(extension.json_field("ok_name"), Some("[1,  2]"));
    }

    #[test]
    fn links_and_assets_follow_the_contract_uris() {
        let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            XSawhorse::document_link("018f47c6-4a77-7c52-9db8-0e5f9bcb17db"),
            "pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db"
        );
        assert_eq!(
            asset_uri(digest).unwrap(),
            format!("pdc://asset/sha256/{digest}")
        );
        assert_eq!(
            asset_relative_path(digest).unwrap(),
            format!(".pdc/assets/sha256/01/{digest}")
        );
        assert!(asset_uri("ABC").is_err());
        assert!(
            asset_uri(&digest.to_uppercase()).is_err(),
            "다이제스트는 소문자다"
        );
        assert!(!is_sha256_digest("0123"));
    }
}
