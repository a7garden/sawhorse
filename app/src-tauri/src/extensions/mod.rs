// 확장 계층. 설계 577-679줄: pack(기존 선언형)과 connector(권한 기반 외부 어댑터)를
// 분리한다. 사용자에게는 둘 다 「확장」으로 보인다.
//
// 불변식 7: connector는 Git·볼트·DB를 직접 쓰지 않고 코어에 intent만 제출한다.

pub mod broker;
pub mod feeds;
pub mod github;
pub mod github_outbound;
pub mod manifest;
pub mod signing;
