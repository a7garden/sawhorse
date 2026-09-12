//! 기본 파일 앱 어댑터 — 앱 미설치 시의 폴백.

use super::obsidian::VaultCandidate;
use super::registry::DocumentAppAdapter;

/// OS 기본 파일 탐색기 어댑터. 탐지할 앱 레지스트리가 없어 볼트 후보는 항상 비어 있다.
/// 문서 앱이 하나도 설치되지 않은 환경에서 코어가 동작하기 위한 기본 등록분이다.
pub struct BuiltinFileAppAdapter;

impl DocumentAppAdapter for BuiltinFileAppAdapter {
    fn id(&self) -> &'static str {
        "builtin"
    }

    fn label(&self) -> &'static str {
        "기본 파일 탐색기"
    }

    fn detect_vaults(&self) -> Vec<VaultCandidate> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 폴백 어댑터의 계약: id·라벨 고정, 탐지 결과는 항상 빈 목록.
    #[test]
    fn builtin_adapter_contract() {
        let adapter = BuiltinFileAppAdapter;
        assert_eq!(adapter.id(), "builtin");
        assert_eq!(adapter.label(), "기본 파일 탐색기");
        assert!(adapter.detect_vaults().is_empty());
    }
}
