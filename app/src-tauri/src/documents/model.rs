//! shdoc/1 문서 모델 — HTML 원본에서 추출한 문서의 메모리 표현 (v2 설계 §5).
//!
//! [`ShdocDocument`]는 파싱 결과의 스냅샷이지 정본이 아니다. 정본은 항상 HTML 원문
//! bytes이고, 여기의 구조체는 읽기·검증·편집 후보 조립에 쓰인다. 블록 `html`은
//! 원문이 아니라 정규화 직렬화(속성 정렬·이스케이프 정규화) 결과다.

use serde::{Deserialize, Serialize};

/// shdoc/1 형식 식별자. `sawhorse:format` 메타의 기대값이다.
pub const SHDOC_FORMAT_VERSION: &str = "shdoc/1";

/// shdoc/1 문서 하나의 파싱 결과.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShdocDocument {
    /// 형식 버전. 파싱 성공 시 항상 `shdoc/1`로 정규화된다.
    pub format_version: String,
    /// `sawhorse:document-id` 메타 값. 없으면 빈 문자열(검증 단계에서 오류가 된다).
    pub document_id: String,
    /// `sawhorse:document-profile` 메타 값(선택).
    pub profile: Option<String>,
    /// `<html lang>` 값(선택).
    pub lang: Option<String>,
    /// `<title>` 텍스트. 없으면 빈 문자열.
    pub title: String,
    /// canonical `article#document`의 직계 자식 중 `id`를 가진 요소 목록.
    pub blocks: Vec<ShdocBlock>,
}

/// 문서를 구성하는 안정 블록. 제목·위치 변경에도 블록 ID는 유지된다.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShdocBlock {
    /// 블록 요소의 `id` 속성값.
    pub block_id: String,
    /// `data-sh-kind` 속성값(선택). 문서 profile이 요구하는 범위에서만 의미를 가진다.
    pub kind: Option<String>,
    /// 블록 요소의 정규화 직렬화 조각(속성 이름순 정렬, 텍스트 이스케이프 정규화).
    pub html: String,
}

/// 문서가 참조하는 자원의 lock. HTML bytes가 같아도 참조 자산이 변하면 입력이
/// 변경된 것으로 보기 위해 revision 기록에 남긴다 (v2 설계 §7).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // R3: candidate 저장의 resource_lock 필드로 사용된다.
pub struct ResourceLock {
    /// 블록 본문에서 수집한 `img src`·`data-sh-ref` href 목록(중복 제거, 등장 순서 유지).
    pub assets: Vec<String>,
}
