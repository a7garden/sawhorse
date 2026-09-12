//! 문서 앱 레지스트리 — 앱 탐지·열기 어댑터의 등록처.

use std::sync::LazyLock;

use super::builtin::BuiltinFileAppAdapter;
use super::obsidian::{ObsidianDocumentAppAdapter, VaultCandidate};

/// 문서 앱 어댑터 — 특정 문서 앱의 볼트 탐지·열기를 담는다.
/// 소유권 표(v2 설계 §4)상 정본이 아니며, 코어는 이 트레이트 뒤로 앱 의존을 숨긴다.
pub trait DocumentAppAdapter: Send + Sync {
    /// 어댑터 식별자(설정 저장·조회에 쓰이는 안정 문자열).
    fn id(&self) -> &'static str;

    /// 사람에게 보여주는 앱 이름. 기본 여는 앱 선택 UI(R1A 후속)가 소비한다.
    #[allow(dead_code)]
    fn label(&self) -> &'static str;

    /// 해당 앱에서 알려진 볼트 후보 목록.
    fn detect_vaults(&self) -> Vec<VaultCandidate>;
}

/// 등록된 문서 앱 어댑터 목록. 코어는 이 레지스트리를 통해서만 문서 앱을 안다.
pub struct DocumentAppRegistry {
    adapters: Vec<std::boxed::Box<dyn DocumentAppAdapter>>,
}

impl DocumentAppRegistry {
    /// 기본 어댑터 구성 — Obsidian 먼저, 기본 파일 앱이 폴백으로 뒤따른다.
    pub fn with_default_adapters() -> Self {
        Self {
            adapters: vec![
                Box::new(ObsidianDocumentAppAdapter),
                Box::new(BuiltinFileAppAdapter),
            ],
        }
    }

    /// 등록된 어댑터 id 목록(등록 순서). 기본 여는 앱 선택 UI(R1A 후속)가 소비한다.
    #[allow(dead_code)]
    pub fn adapter_ids(&self) -> Vec<&'static str> {
        self.adapters.iter().map(|a| a.id()).collect()
    }

    /// id 로 등록된 어댑터를 찾는다.
    pub fn find(&self, id: &str) -> Option<&dyn DocumentAppAdapter> {
        self.adapters
            .iter()
            .find(|a| a.id() == id)
            .map(|a| a.as_ref())
    }

    /// 해당 앱의 볼트 후보. 등록되지 않은 id 면 빈 목록.
    pub fn detect_vaults_for(&self, app_id: &str) -> Vec<VaultCandidate> {
        self.find(app_id)
            .map(|a| a.detect_vaults())
            .unwrap_or_default()
    }

    /// 모든 어댑터의 볼트 후보를 (앱 id, 후보 목록) 쌍으로 모은다.
    /// 여러 문서 공간 등록 UI(R1A 후속)가 소개할 때까지 호출부가 없다.
    #[allow(dead_code)]
    pub fn detect_all(&self) -> Vec<(String, Vec<VaultCandidate>)> {
        self.adapters
            .iter()
            .map(|a| (a.id().to_string(), a.detect_vaults()))
            .collect()
    }
}

/// 프로세스 전역 기본 레지스트리. 두 번 호출해도 같은 인스턴스다.
/// 초기화식이 선언 시점에 고정되므로 LazyLock 으로 함께 둔다.
pub fn default_registry() -> &'static DocumentAppRegistry {
    static REGISTRY: LazyLock<DocumentAppRegistry> =
        LazyLock::new(DocumentAppRegistry::with_default_adapters);
    &REGISTRY
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 기본 구성은 Obsidian → builtin 순서다(폴백이 항상 마지막).
    #[test]
    fn with_default_adapters_registers_obsidian_then_builtin() {
        let registry = DocumentAppRegistry::with_default_adapters();
        assert_eq!(registry.adapter_ids(), vec!["obsidian", "builtin"]);
    }

    /// detect_vaults_for("obsidian") 은 obsidian 모듈의 detect_vaults() 에 그대로 위임한다.
    /// 실제 사용자 설정을 읽으므로 결과 내용이 아니라 위임 사실을 비교한다(VaultCandidate 에
    /// PartialEq 가 없어 Debug 표현으로 비교).
    #[test]
    fn detect_vaults_for_delegates_to_obsidian_adapter() {
        let registry = DocumentAppRegistry::with_default_adapters();
        assert_eq!(
            format!("{:?}", registry.detect_vaults_for("obsidian")),
            format!("{:?}", crate::document_apps::obsidian::detect_vaults())
        );
    }

    /// find 는 등록된 id 를 돌려주고, 없는 id 늴 None 이다.
    #[test]
    fn find_returns_registered_adapter_and_none_for_unknown() {
        let registry = DocumentAppRegistry::with_default_adapters();
        assert_eq!(registry.find("builtin").map(|a| a.id()), Some("builtin"));
        assert_eq!(registry.find("obsidian").map(|a| a.id()), Some("obsidian"));
        assert!(registry.find("없는id").is_none());
    }

    /// 등록되지 않은 앱의 탐지는 빈 목록으로 끝난다(에러가 아님).
    #[test]
    fn detect_vaults_for_unknown_app_returns_empty() {
        let registry = DocumentAppRegistry::with_default_adapters();
        assert!(registry.detect_vaults_for("없는id").is_empty());
    }

    /// detect_all 은 등록 순서대로 모든 앱의 결과를 모은다.
    #[test]
    fn detect_all_covers_every_adapter() {
        let registry = DocumentAppRegistry::with_default_adapters();
        let all = registry.detect_all();
        assert_eq!(
            all.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["obsidian", "builtin"]
        );
        assert!(all[1].1.is_empty(), "builtin 폴백은 항상 빈 목록");
    }

    /// default_registry 는 정적 인스턴스를 공유한다.
    #[test]
    fn default_registry_returns_same_instance() {
        let a = default_registry();
        let b = default_registry();
        assert!(std::ptr::eq(a, b));
    }
}
