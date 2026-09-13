//! 문서 plane 경로 분류 인벤토리 — Stage 0 동결.
//!
//! `docs/architecture/pdc-migration.md`의 plane boundary를 경로 클래스 표로
//! 동결한다. 모든 볼트 상대 경로는 정확히 하나의 클래스로 분류되고, 각 클래스는
//! 소유자(owner)와 범위(scope)를 하나씩만 가진다 — Stage 0의 종료 조건.
//! 표 순서가 곧 우선순위다: 첫 일치가 승리하고 맨 뒤의 `**` 안전 기본값이
//! 총성(totality)을 닫는다. 미분류 경로는 문서 plane 밖으로 취급해 이관하지
//! 않는다(안전 기본값).

#![allow(dead_code)] // Stage 0 동결물 — Stage 1 판독기·Stage 3 importer가 소비한다.

use serde::{Deserialize, Serialize};

use super::contract;
/// 경로 클래스의 plane 범위.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Scope {
    /// 사용자가 저술한 문서 — PDC 이관 대상.
    AuthoredDocument,
    /// 문서가 참조하는 저술 자산 — 관리형 SHA-256 자산으로 원자 복사 후
    /// 참조 재기록 대상.
    ManagedAsset,
    /// 운영 기록 — 문서 plane 밖. 이관하지 않는다.
    OperationalRecord,
}

/// 볼트 상대 경로의 분류 단위.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathClass {
    /// 표시용 패턴. 판정은 `matches`가 하고 이 문자열은 보고서·사람용이다.
    pub pattern: &'static str,
    /// 이 경로 클래스를 소유하는 모듈·저장소.
    pub owner: &'static str,
    pub scope: Scope,
    /// 저술 문서의 목표 이송 형식. 자산·운영 기록은 `None`.
    pub transport: Option<&'static str>,
    /// 분류 근거 요약.
    pub note: &'static str,
    /// 판정기 — `/`로 나눈 세그먼트를 받는다. 표 순서가 우선순위라 단독으로
    /// 호출하지 않는다.
    #[serde(skip)]
    pub matches: fn(&[&str]) -> bool,
}

fn seg(segments: &[&str], index: usize, expected: &str) -> bool {
    segments.get(index) == Some(&expected)
}

fn last<'a>(segments: &[&'a str]) -> &'a str {
    segments[segments.len() - 1]
}

fn is_id_map_store(segments: &[&str]) -> bool {
    segments.len() == 3 && seg(segments, 0, ".sawhorse") && seg(segments, 1, "pdc") && segments[2] == "id-map.json"
}

fn in_dot_sawhorse(segments: &[&str]) -> bool {
    seg(segments, 0, ".sawhorse")
}

fn is_work_history(segments: &[&str]) -> bool {
    segments.len() >= 4 && seg(segments, 0, "work") && seg(segments, 2, "history")
}

fn is_work_assets(segments: &[&str]) -> bool {
    segments.len() >= 4 && seg(segments, 0, "work") && seg(segments, 2, "assets")
}

fn is_mockup_manifest(segments: &[&str]) -> bool {
    segments.len() >= 3 && seg(segments, 0, "work") && last(segments) == "mockup-manifest.json"
}

fn in_work(segments: &[&str]) -> bool {
    seg(segments, 0, "work")
}

fn is_work_html(segments: &[&str]) -> bool {
    segments.len() >= 3 && in_work(segments) && last(segments).ends_with(".html")
}

fn is_work_md(segments: &[&str]) -> bool {
    segments.len() >= 3 && in_work(segments) && last(segments).ends_with(".md")
}

fn is_project_note(segments: &[&str]) -> bool {
    segments.len() == 3 && seg(segments, 0, "projects") && segments[2] == "project.md"
}

fn is_project_design(segments: &[&str]) -> bool {
    segments.len() == 3 && seg(segments, 0, "projects") && segments[2] == "DESIGN.md"
}

fn is_project_resources(segments: &[&str]) -> bool {
    segments.len() == 3 && seg(segments, 0, "projects") && segments[2] == "resources.json"
}

fn is_calendar_md(segments: &[&str]) -> bool {
    segments.len() == 2 && seg(segments, 0, "calendar") && last(segments).ends_with(".md")
}

fn is_djot_suffix(segments: &[&str]) -> bool {
    last(segments).ends_with(".djot")
}

fn is_html_suffix(segments: &[&str]) -> bool {
    last(segments).ends_with(".html")
}

fn is_pdc_vault_manifest(segments: &[&str]) -> bool {
    segments.len() == 2 && seg(segments, 0, ".pdc") && segments[1] == "vault.json"
}

fn in_pdc_assets(segments: &[&str]) -> bool {
    segments.len() >= 3 && seg(segments, 0, ".pdc") && seg(segments, 1, "assets")
}

fn in_pdc(segments: &[&str]) -> bool {
    seg(segments, 0, ".pdc")
}

/// 동결된 분류 표. 순서 = 우선순위.
static TABLE: &[PathClass] = &[
    PathClass {
        pattern: ".pdc/vault.json",
        owner: "pdc 볼트 정검 표시",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "pdc-vault/1 정검 표시(계약 §3.1) — 계약 인프라이지 문서가 아니다.",
        matches: is_pdc_vault_manifest,
    },
    PathClass {
        pattern: ".pdc/assets/**",
        owner: "관리형 자산 저장소",
        scope: Scope::ManagedAsset,
        transport: None,
        note: ".pdc/assets/sha256/<xx>/<digest> — 다이제스트 주소 자산(계약 §8.2).",
        matches: in_pdc_assets,
    },
    PathClass {
        pattern: ".pdc/**",
        owner: "pdc 인프라",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "계약이 재귀 발견에서 제외하는 점 접두 디렉터리(§3.2) — 문서 plane 밖.",
        matches: in_pdc,
    },
    PathClass {
        pattern: ".sawhorse/pdc/id-map.json",
        owner: "pdc::idmap",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "레거시 ID → UUIDv7 매핑 원장. 문서가 아니므로 이관 대상에서 제외한다.",
        matches: is_id_map_store,
    },
    PathClass {
        pattern: ".sawhorse/**",
        owner: "볼트 운영 저장소",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "schema.json·workspace.json·schemas/·workflows/·drafts/·locks/·changes/·\
               spaces.json·extensions.lock.json·runtime.sqlite·evidence/·ingestion/·journal/ — \
               문서 plane 밖(계약상 명시적 제외).",
        matches: in_dot_sawhorse,
    },
    PathClass {
        pattern: "work/*/history/**",
        owner: "sdlc::intent_history",
        scope: Scope::AuthoredDocument,
        transport: None,
        note: "편집 이전 원본 스냅샷 — 원본의 이송 형식을 그대로 유지하며 별도 변환하지 않는다.",
        matches: is_work_history,
    },
    PathClass {
        pattern: "work/*/assets/**",
        owner: "work 자산",
        scope: Scope::ManagedAsset,
        transport: None,
        note: "상대 참조 자산 — 관리형 SHA-256 자산으로 원자 복사 후 참조를 재기록한다.",
        matches: is_work_assets,
    },
    PathClass {
        pattern: "work/**/mockup-manifest.json",
        owner: "mockups",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "목업 버전 원장 — 기계 상태이지 문서가 아니다.",
        matches: is_mockup_manifest,
    },
    PathClass {
        pattern: "work/**/*.html",
        owner: "documents::service",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_HTML),
        note: "authored HTML(shdoc/1 포함) — shdoc/1을 Djot으로 강등하지 않고 \
               pdc-html/1로 우선 이관한다.",
        matches: is_work_html,
    },
    PathClass {
        pattern: "work/**/*.md",
        owner: "sdlc",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "work.md와 stage 산출 문서(intent·spec·plan·verification·release·learning 등).",
        matches: is_work_md,
    },
    PathClass {
        pattern: "work/**",
        owner: "work(안전 기본값)",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "알려지지 않은 work 하위 항목 — 이관 금지. Stage 3 dry-run이 보고해야 한다.",
        matches: in_work,
    },
    PathClass {
        pattern: "projects/*/project.md",
        owner: "sdlc",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "프로젝트 정문서. frontmatter의 워크플로 선택 같은 운영 바인딩은 소속 운영 레코드에 남는다.",
        matches: is_project_note,
    },
    PathClass {
        pattern: "projects/*/DESIGN.md",
        owner: "project_resources",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "프로젝트 시각 지침 정문서(표현 계층 바인딩의 원본).",
        matches: is_project_design,
    },
    PathClass {
        pattern: "projects/*/resources.json",
        owner: "project_resources",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "프로젝트 자원 기록 — 기계 상태.",
        matches: is_project_resources,
    },
    PathClass {
        pattern: "projects/**",
        owner: "projects(안전 기본값)",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "알려지지 않은 projects 하위 항목 — 이관 금지. Stage 3 dry-run이 보고해야 한다.",
        matches: |segments: &[&str]| seg(segments, 0, "projects"),
    },
    PathClass {
        pattern: "calendar/*.md",
        owner: "sdlc calendar",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "일정 문서(마일스톤·리뷰·배포·회의). 일정 자체는 운영 판단에 쓰이더라도 문서 본문은 저술물이다.",
        matches: is_calendar_md,
    },
    PathClass {
        pattern: "runs/**",
        owner: "실행 기록",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "run 레코드·context·worktrees — 실행 원장과 스크래치 영역.",
        matches: |segments: &[&str]| seg(segments, 0, "runs"),
    },
    PathClass {
        pattern: "프로젝트/**",
        owner: "vault 이슈 노트",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "이슈 노트. 승인·상태 키는 장부 사실이며 문서 필드가 승인을 부여하지 않는다.",
        matches: |segments: &[&str]| seg(segments, 0, "프로젝트"),
    },
    PathClass {
        pattern: "사업/**",
        owner: "vault 이슈 노트(레거시)",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "SI 전용 시대 루트 — 호환 읽기 전용, 새로 만들지 않는다.",
        matches: |segments: &[&str]| seg(segments, 0, "사업"),
    },
    PathClass {
        pattern: "이슈/**",
        owner: "vault 수함",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "이슈 수함 목록.",
        matches: |segments: &[&str]| seg(segments, 0, "이슈"),
    },
    PathClass {
        pattern: "개선/**",
        owner: "vault 수함(레거시)",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "레거시 문제 수함 목록.",
        matches: |segments: &[&str]| seg(segments, 0, "개선"),
    },
    PathClass {
        pattern: "일지/**",
        owner: "journal pack",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "일지·할 일 — 체크박스 [PRESERVE] 계약이 유지된다.",
        matches: |segments: &[&str]| seg(segments, 0, "일지"),
    },
    PathClass {
        pattern: "개념/**",
        owner: "concepts pack",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "개념 노트.",
        matches: |segments: &[&str]| seg(segments, 0, "개념"),
    },
    PathClass {
        pattern: "첨부/**",
        owner: "note 자산",
        scope: Scope::ManagedAsset,
        transport: None,
        note: "노트 삽입 자산 — 관리형 자산 대상.",
        matches: |segments: &[&str]| seg(segments, 0, "첨부"),
    },
    PathClass {
        pattern: "**/*.djot",
        owner: "문서 공간(Stage 1)",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_DJOT),
        note: "등록된 문서 공간의 PDC Djot 정문서 — Stage 1 판독기가 발견한다.",
        matches: is_djot_suffix,
    },
    PathClass {
        pattern: "**/*.html",
        owner: "문서 공간(Stage 1)",
        scope: Scope::AuthoredDocument,
        transport: Some(contract::TRANSPORT_HTML),
        note: "문서 공간의 PDC/레거시 HTML 정문서.",
        matches: is_html_suffix,
    },
    PathClass {
        pattern: "**",
        owner: "미분류(안전 기본값)",
        scope: Scope::OperationalRecord,
        transport: None,
        note: "분류되지 않은 경로 — 문서 plane 밖으로 취급해 이관하지 않는다.",
        matches: |_segments: &[&str]| true,
    },
];

/// 동결된 인벤토리. 순서가 곧 우선순위다.
pub fn inventory() -> &'static [PathClass] {
    TABLE
}

/// 볼트 상대 경로를 분류한다. `\`와 양끝 `/`는 정규화하고 첫 일치가 이긴다.
/// `**` 기본값이 뒤를 닫으므로 비어 있지 않은 경로는 항상 분류된다(빈 경로만
/// `None`).
pub fn classify(vault_relative: &str) -> Option<&'static PathClass> {
    let trimmed = vault_relative.replace('\\', "/");
    let trimmed = trimmed.trim_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let segments: Vec<&str> = trimmed.split('/').collect();
    TABLE.iter().find(|class| (class.matches)(&segments))
}

/// 인벤토리의 기계 판독 형태. 계약 고정값을 머리에 붙여 단일 문서로 동결한다.
pub fn inventory_manifest_json() -> String {
    let manifest = serde_json::json!({
        "documentFormat": contract::DOCUMENT_FORMAT,
        "corpusRevision": contract::CORPUS_REVISION,
        "transports": [contract::TRANSPORT_DJOT, contract::TRANSPORT_HTML],
        "classes": TABLE,
    });
    serde_json::to_string_pretty(&manifest).expect("인벤토리 직렬화는 실패하지 않는다")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_class_has_exactly_one_pattern_and_owner() {
        let mut patterns = HashSet::new();
        for class in inventory() {
            assert!(
                patterns.insert(class.pattern),
                "패턴 중복: {}",
                class.pattern
            );
            assert!(!class.owner.is_empty());
        }
        assert_eq!(patterns.len(), inventory().len());
    }

    #[test]
    fn catch_all_closes_the_table_so_every_path_is_classified() {
        let last = inventory().last().expect("표는 비어 있지 않다");
        assert_eq!(last.pattern, "**");
        assert_eq!(last.scope, Scope::OperationalRecord);
        for sample in ["a", "a/b/c.bin", "x/y/z"] {
            assert!(classify(sample).is_some());
        }
        assert!(classify("").is_none());
        assert!(classify("/").is_none());
    }

    #[test]
    fn operational_stores_stay_out_of_the_document_plane() {
        let cases = [
            ".sawhorse/schema.json",
            ".sawhorse/runtime.sqlite",
            ".sawhorse/evidence/ingestion/k/ab.md",
            ".sawhorse/workflows/intent-flow/1.json",
            ".pdc/vault.json",
            ".sawhorse/pdc/id-map.json",
            "runs/r-1.md",
            "runs/worktrees/t1/spec.md",
            "work/w-1/mockup-manifest.json",
            "projects/p/resources.json",
            "work/w-1/data.bin",
        ];
        for path in cases {
            let class = classify(path).expect("총성");
            assert_eq!(
                class.scope,
                Scope::OperationalRecord,
                "{path}는 운영 기록이어야 한다"
            );
            assert_eq!(class.transport, None, "{path}는 이송 형식이 없어야 한다");
        }
    }

    #[test]
    fn authored_documents_target_the_documented_transports() {
        let cases = [
            ("work/w-1/spec.md", contract::TRANSPORT_DJOT),
            ("work/w-1/intent.html", contract::TRANSPORT_HTML),
            ("projects/p/project.md", contract::TRANSPORT_DJOT),
            ("projects/p/DESIGN.md", contract::TRANSPORT_DJOT),
            ("calendar/c-1.md", contract::TRANSPORT_DJOT),
            ("프로젝트/FDR/이슈/12 이슈목록.md", contract::TRANSPORT_DJOT),
            ("사업/FDR/개선/3 문제목록.md", contract::TRANSPORT_DJOT),
            ("일지/2026-09-13.md", contract::TRANSPORT_DJOT),
            ("개념/pdc.md", contract::TRANSPORT_DJOT),
            ("notes/board.djot", contract::TRANSPORT_DJOT),
            ("pages/board.html", contract::TRANSPORT_HTML),
        ];
        for (path, transport) in cases {
            let class = classify(path).expect("총성");
            assert_eq!(class.scope, Scope::AuthoredDocument, "{path}");
            assert_eq!(class.transport, Some(transport), "{path}");
        }
    }

    #[test]
    fn history_and_assets_take_precedence_over_work_rules() {
        let history = classify("work/w-1/history/spec.md").unwrap();
        assert_eq!(history.owner, "sdlc::intent_history");
        assert_eq!(history.transport, None, "스냅샷은 원본 형식을 유지한다");

        let asset = classify("work/w-1/assets/logo.png").unwrap();
        assert_eq!(asset.scope, Scope::ManagedAsset);

        let attachment = classify("첨부/img.png").unwrap();
        assert_eq!(attachment.scope, Scope::ManagedAsset);

        let pdc_asset = classify(
            ".pdc/assets/sha256/01/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        assert_eq!(pdc_asset.scope, Scope::ManagedAsset);
    }

    #[test]
    fn prefix_classes_beat_suffix_classes() {
        // .sawhorse와 runs 안의 html은 접두 클래스가 이긴다.
        for path in [".sawhorse/evidence/a.html", "runs/worktrees/t/page.html"] {
            assert_eq!(classify(path).unwrap().scope, Scope::OperationalRecord);
        }
        // work 안의 html은 work 규칙이 이긴다(글로브 접미 클래스 이전).
        assert_eq!(
            classify("work/w-1/mockups/screen.html").unwrap().transport,
            Some(contract::TRANSPORT_HTML)
        );
    }

    #[test]
    fn classification_normalizes_separators_and_edges() {
        assert_eq!(
            classify("work\\w-1\\spec.md").map(|class| class.pattern),
            classify("work/w-1/spec.md").map(|class| class.pattern)
        );
        // 정규화는 구분자만 — `..` 판정은 호출자가 금지한다.
        assert_eq!(
            classify("a/b/../c").map(|class| class.pattern),
            classify("a/b/../c").map(|class| class.pattern)
        );
        assert_eq!(classify("work/w-1/spec.md").map(|c| c.pattern), Some("work/**/*.md"));
    }

    #[test]
    fn manifest_embeds_the_pinned_contract() {
        let manifest: serde_json::Value =
            serde_json::from_str(&inventory_manifest_json()).unwrap();
        assert_eq!(manifest["corpusRevision"], 3);
        assert_eq!(manifest["documentFormat"], "pdc-document/1");
        assert_eq!(manifest["transports"][0], "pdc-djot/1");
        assert_eq!(manifest["transports"][1], "pdc-html/1");
        let classes = manifest["classes"].as_array().unwrap();
        assert_eq!(classes.len(), inventory().len());
        assert!(classes[0]["matches"].is_null(), "판정기는 직렬화에서 뺀다");
    }
}
