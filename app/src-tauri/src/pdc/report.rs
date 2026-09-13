//! 기계 판독 이관 보고서 형식 — Stage 0 동결.
//!
//! Stage 3 dry-run과 Stage 4 ChangeSet이 문서 하나하나의 결정·손실·충돌·기대
//! 출력 다이제스트를 보고하는 단일 형식이다. v1은 부가 진화만 허용한다:
//! 알 수 없는 필드는 `extra`에 보존되어 재직렬화 때 살아남는다.

#![allow(dead_code)] // Stage 0 동결 형식 — Stage 3 dry-run·Stage 4 ChangeSet이 채운다.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::classify::Scope;
use super::contract;

/// 보고서 형식 버전. 부가 진화만 허용된다.
pub const REPORT_FORMAT_VERSION: u32 = 1;

/// 문서 하나의 이관 결정.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    /// 문서 plane 밖 — 건드리지 않는다.
    Keep,
    /// 이관 대상.
    Migrate,
    /// 모호성·충돌로 보류 — 사용자 결정이 필요하다.
    Conflict,
    /// 안전하지 않거나 지원되지 않는 구조 — 이관 불가.
    Unsupported,
}

/// 손실 기록 하나 — 기계 종류와 사람이 읽는 상세.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loss {
    /// 손실 종류(예: `frontmatter-key`, `block-id`, `comment`).
    pub kind: String,
    /// 사람이 읽는 상세.
    pub detail: String,
}

/// 문서 하나의 보고 항목.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportEntry {
    /// 볼트 상대 원본 경로.
    pub source: String,
    /// 경로 클래스 범위 — `classify()`의 어휘를 그대로 쓴다.
    pub scope: Scope,
    pub decision: Decision,
    /// 목표 이송 형식. `decision`이 `migrate`일 때만 의미를 가진다.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub losses: Vec<Loss>,
    /// 충돌·모호성 사유.
    #[serde(default)]
    pub conflicts: Vec<String>,
    /// 기대 출력 bytes의 SHA-256 hex — Stage 3 dry-run이 채운다.
    #[serde(default)]
    pub output_sha256: Option<String>,
    /// 미래 부가 필드 보존.
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// 이관 보고서. corpus revision은 계약 고정값으로 강제된다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    format_version: u32,
    corpus_revision: u32,
    /// 생성 시각(유닉스 밀리초).
    generated_at_ms: u64,
    #[serde(default)]
    entries: Vec<ReportEntry>,
    /// 미래 부가 필드 보존.
    #[serde(default, flatten)]
    extra: BTreeMap<String, serde_json::Value>,
}

impl MigrationReport {
    /// 고정된 계약 개정으로 새 보고서를 만든다.
    pub fn new(generated_at_ms: u64) -> Self {
        Self {
            format_version: REPORT_FORMAT_VERSION,
            corpus_revision: contract::CORPUS_REVISION,
            generated_at_ms,
            entries: Vec::new(),
            extra: BTreeMap::new(),
        }
    }

    pub fn entries(&self) -> &[ReportEntry] {
        &self.entries
    }

    pub fn push(&mut self, entry: ReportEntry) {
        self.entries.push(entry);
    }

    /// 직렬화. 보고서는 사람이 검토하는 문서이므로 예쁘게 출력한다.
    pub fn to_json_pretty(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|e| format!("보고서 직렬화 실패: {e}"))
    }

    /// 역직렬화. 형식 버전과 corpus revision이 고정값과 다르면 받지 않는다 —
    /// 다른 개정의 보고서를 이 개정의 근거로 쓰는 일을 막는다.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let report: Self = serde_json::from_str(json)
            .map_err(|e| format!("보고서 파싱 실패: {e}"))?;
        if report.format_version != REPORT_FORMAT_VERSION {
            return Err(format!(
                "보고서 형식 v{}은(는) 지원되지 않습니다(v{REPORT_FORMAT_VERSION} 필요)",
                report.format_version
            ));
        }
        if report.corpus_revision != contract::CORPUS_REVISION {
            return Err(format!(
                "보고서의 corpus revision {}은(는) 고정 개정 {}과(와) 다릅니다",
                report.corpus_revision,
                contract::CORPUS_REVISION
            ));
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_report_pins_the_frozen_corpus_revision() {
        let report = MigrationReport::new(1_000);
        let json = report.to_json_pretty().unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["formatVersion"], 1);
        assert_eq!(value["corpusRevision"], 3);
        assert_eq!(value["generatedAtMs"], 1_000);
    }

    #[test]
    fn round_trips_with_decisions_losses_and_digests() {
        let mut report = MigrationReport::new(5);
        report.push(ReportEntry {
            source: "work/w-1/spec.md".into(),
            scope: Scope::AuthoredDocument,
            decision: Decision::Migrate,
            target: Some(contract::TRANSPORT_DJOT.to_string()),
            losses: vec![Loss {
                kind: "frontmatter-key".into(),
                detail: "핀된 실행 모델 키는 운영 레코드로 옮겨간다".into(),
            }],
            conflicts: vec![],
            output_sha256: Some("ab".repeat(32)),
            extra: BTreeMap::new(),
        });
        report.push(ReportEntry {
            source: "work/w-2/legacy.html".into(),
            scope: Scope::AuthoredDocument,
            decision: Decision::Conflict,
            target: Some(contract::TRANSPORT_HTML.to_string()),
            losses: vec![],
            conflicts: vec!["data-sh-ref 대상이 두 개다".into()],
            output_sha256: None,
            extra: BTreeMap::new(),
        });

        let json = report.to_json_pretty().unwrap();
        let round = MigrationReport::from_json(&json).unwrap();
        assert_eq!(round, report);
        assert_eq!(round.entries().len(), 2);
        // kebab-case 결정 어휘가 그대로 보인다.
        assert!(json.contains("\"migrate\""));
        assert!(json.contains("\"conflict\""));
        assert!(json.contains("\"authored-document\""));
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let json = r#"{
  "formatVersion": 1,
  "corpusRevision": 3,
  "generatedAtMs": 9,
  "entries": [
    {
      "source": "notes.djot",
      "scope": "authored-document",
      "decision": "keep",
      "futureHint": "preserve me"
    }
  ],
  "futureSummary": { "ok": true }
}"#;
        let report = MigrationReport::from_json(json).unwrap();
        assert_eq!(report.entries().len(), 1);
        let again = report.to_json_pretty().unwrap();
        let value: serde_json::Value = serde_json::from_str(&again).unwrap();
        assert_eq!(value["futureSummary"]["ok"], true);
        assert_eq!(value["entries"][0]["futureHint"], "preserve me");
    }

    #[test]
    fn foreign_format_or_corpus_revisions_are_rejected() {
        let wrong_format = r#"{ "formatVersion": 2, "corpusRevision": 3, "generatedAtMs": 1, "entries": [] }"#;
        let wrong_corpus = r#"{ "formatVersion": 1, "corpusRevision": 2, "generatedAtMs": 1, "entries": [] }"#;
        assert!(MigrationReport::from_json(wrong_format)
            .unwrap_err()
            .contains("v2"));
        assert!(MigrationReport::from_json(wrong_corpus)
            .unwrap_err()
            .contains("corpus revision"));
        assert!(MigrationReport::from_json("not json").is_err());
    }
}
