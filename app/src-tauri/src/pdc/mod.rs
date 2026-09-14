//! Portable Document Contract — 정본 계약의 Sawhorse 구현.
//!
//! Stage 0 고정물(`docs/architecture/pdc-migration.md`):
//! - [`contract`] — 계약 식별자(`pdc-document/2`, `pdc-document-conformance/2`
//!   revision 2, 이송 형식, 안전 YAML 상한)와 `x_sawhorse` 확장 어휘.
//! - [`classify`] — 저술 문서 대 운영 기록의 경로 분류 인벤토리(총성 보장).
//! - [`idmap`] — 레거시 ID → UUIDv7 매핑 저장소(할당 1회 원장).
//! - [`report`] — 기계 판독 이관 보고서 형식(손실·충돌·출력 다이제스트).
//!
//! Full Reader(§3.2·§12):
//! - [`transport`] — Markdown/Djot/HTML 이송 봉투 추출(§4).
//! - [`envelope`] — v1 동결 제약 문법 해석·검증 + v1·v2 의미 검사(§5).
//! - [`yamlfront`] — v2 안전 YAML 봉투 문법과 `pdc-query/1` 구조 검사(§5).
//! - [`reader`] — 발견·진단·안전성 검사. 원본 바이트 보존.
//!
//! Writer/Mutator + 미리보기(§10·§11):
//! - [`writer`] — 봉투 직렬화·생성(v2 전용)·패치 저장·이동.
//! - [`preview`] — Markdown/Djot 렌더 + 렌더 정책(`pdc-document-render-policy/3`)
//!   소독(§11).
//! - [`assets`] — 다이제스트 주소 관리형 자산(§8.2).
//! - [`commands`] — 프론트엔드 Tauri 명령.
//!
//! 외부 portable-document-contract 저장소가 권위이며 이 모듈은 새 계약 의미를
//! 정의하지 않는다.

pub mod assets;
pub mod classify;
pub mod commands;
pub mod contract;
pub mod envelope;
pub mod idmap;
pub mod preview;
pub mod reader;
pub mod transport;
pub mod writer;
pub mod yamlfront;
