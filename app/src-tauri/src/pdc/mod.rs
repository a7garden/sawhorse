//! Portable Document Contract — 정본 계약의 Sawhorse 구현.
//!
//! Stage 0 고정물(`docs/architecture/pdc-migration.md`):
//! - [`contract`] — 계약 식별자(`pdc-document/1`, corpus revision 3, 이송
//!   형식)와 `x_sawhorse` 확장 어휘.
//! - [`classify`] — 저술 문서 대 운영 기록의 경로 분류 인벤토리(총성 보장).
//! - [`idmap`] — 레거시 ID → UUIDv7 매핑 저장소(할당 1회 원장).
//! - [`report`] — 기계 판독 이관 보고서 형식(손실·충돌·출력 다이제스트).
//!
//! Stage 1 Full Reader(읽기 전용):
//! - [`transport`] — Djot/HTML 이송 봉투 추출(§4).
//! - [`envelope`] — 동결된 제약 봉투 문법 해석·검증(§5).
//! - [`reader`] — 발견·진단·안전성 검사(§3.2·§6). 원본 바이트 보존.
//!
//! 외부 portable-document-contract 저장소가 권위이며 이 모듈은 새 계약 의미를
//! 정의하지 않는다.

pub mod classify;
pub mod contract;
pub mod envelope;
pub mod idmap;
pub mod reader;
pub mod report;
pub mod transport;
