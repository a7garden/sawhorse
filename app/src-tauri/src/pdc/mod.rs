//! Portable Document Contract 고정물 — `docs/architecture/pdc-migration.md` Stage 0.
//!
//! Stage 0(경계와 고정물)의 네 산출물을 담는다:
//! - [`contract`] — 계약 식별자(`pdc-document/1`, corpus revision 3, 이송 형식)와
//!   `x_sawhorse` 동결 스키마.
//! - [`classify`] — 저술 문서 대 운영 기록의 경로 분류 인벤토리(총성 보장).
//! - [`idmap`] — 레거시 ID → UUIDv7 매핑 저장소(할당 1회 원장).
//! - [`report`] — 기계 판독 이관 보고서 형식(손실·충돌·출력 다이제스트).
//!
//! Stage 1+(판독기·작성기· importer)는 이 고정물 위에서 만든다. 외부
//! portable-document-contract 저장소가 권위이며 이 모듈은 새 계약 의미를
//! 정의하지 않는다.

pub mod classify;
pub mod contract;
pub mod idmap;
pub mod report;
