// workspace.rs — 작업공간(볼트) 프로비저닝.
//
// `init-vault` 스킬이 하던 일 중 **에이전트 판단이 필요 없는 부분**을 앱으로 가져온 것이다.
// 이게 있어야 "앱을 먼저 깔고 앱만으로 시작한다"가 성립한다 — 폴더와 템플릿은 결정적인
// 파일 복사이므로 LLM 을 부를 이유가 없다.
//
// `.obsidian/*` 설정(templates.json·app.json·types.json·homepage)은 스킬에 남긴다:
// Obsidian 설치 여부와 기존 설정 병합은 판단이 필요하고, 그건 에이전트가 잘하는 일이다.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::packs::Pack;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionReport {
    pub created: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<String>,
}

impl ProvisionReport {
    pub fn merge(&mut self, other: ProvisionReport) {
        self.created.extend(other.created);
        self.skipped.extend(other.skipped);
        self.failed.extend(other.failed);
    }
}

/// 작업공간 밖으로 나가는 상대 경로를 막는다. 팩 매니페스트는 사람이 쓰는 파일이라
/// `../` 오타 하나가 홈 디렉터리에 파일을 흘릴 수 있다.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() {
        return None;
    }
    let candidate = Path::new(&rel);
    if candidate.is_absolute() {
        return None;
    }
    if candidate.components().any(|c| {
        matches!(
            c,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    }) {
        return None;
    }
    Some(root.join(candidate))
}

/// 작업공간 루트 자체를 확보한다 (없으면 만든다).
pub fn ensure_root(vault: &Path) -> Result<(), String> {
    if vault.as_os_str().is_empty() {
        return Err("작업공간 경로가 비어 있습니다".into());
    }
    if vault.is_dir() {
        return Ok(());
    }
    if vault.exists() {
        return Err(format!(
            "작업공간 경로가 폴더가 아닙니다: {}",
            vault.display()
        ));
    }
    std::fs::create_dir_all(vault).map_err(|e| format!("작업공간 생성 실패: {e}"))
}

/// 팩 하나의 `workspace` 블록을 작업공간에 반영한다.
/// **기존 파일은 절대 덮지 않는다** — 사용자의 노트가 팩 업그레이드로 사라지면 안 된다.
pub fn provision_pack(vault: &Path, pack: &Pack) -> ProvisionReport {
    let mut r = ProvisionReport::default();
    for folder in &pack.manifest.workspace.folders {
        let Some(target) = safe_join(vault, folder) else {
            r.failed
                .push(format!("{folder}: 작업공간 밖을 가리키는 경로"));
            continue;
        };
        if target.is_dir() {
            r.skipped.push(format!("{folder}/ (이미 있음)"));
            continue;
        }
        match std::fs::create_dir_all(&target) {
            Ok(()) => r.created.push(format!("{folder}/")),
            Err(e) => r.failed.push(format!("{folder}/: {e}")),
        }
    }
    for seed in &pack.manifest.workspace.files {
        let Some(target) = safe_join(vault, &seed.dest) else {
            r.failed
                .push(format!("{}: 작업공간 밖을 가리키는 경로", seed.dest));
            continue;
        };
        let Some(source) = safe_join(&pack.dir, &seed.src) else {
            r.failed
                .push(format!("{}: 팩 밖을 가리키는 원본 경로", seed.src));
            continue;
        };
        if target.exists() {
            r.skipped.push(format!("{} (이미 있음)", seed.dest));
            continue;
        }
        if !source.is_file() {
            r.failed.push(format!("{}: 팩에 원본이 없습니다", seed.src));
            continue;
        }
        if let Some(parent) = target.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                r.failed
                    .push(format!("{}: 폴더 생성 실패 ({e})", seed.dest));
                continue;
            }
        }
        match std::fs::copy(&source, &target) {
            Ok(_) => r.created.push(seed.dest.clone()),
            Err(e) => r.failed.push(format!("{}: 복사 실패 ({e})", seed.dest)),
        }
    }
    r
}

/// 활성 팩 전부를 반영한다. 팩 하나가 실패해도 나머지는 계속 간다.
pub fn provision(vault: &Path, packs: &[&Pack]) -> Result<ProvisionReport, String> {
    ensure_root(vault)?;
    let mut out = ProvisionReport::default();
    for p in packs {
        out.merge(provision_pack(vault, p));
    }
    Ok(out)
}

/// 실제로 쓰기 전에 무엇이 생길지 보여준다 (마법사 미리보기).
pub fn plan(vault: &Path, packs: &[&Pack]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in packs {
        for f in &p.manifest.workspace.folders {
            let display = format!("{f}/");
            if safe_join(vault, f).is_some_and(|t| !t.is_dir()) && seen.insert(display.clone()) {
                out.push(display);
            }
        }
        for s in &p.manifest.workspace.files {
            if safe_join(vault, &s.dest).is_some_and(|t| !t.exists()) && seen.insert(s.dest.clone())
            {
                out.push(s.dest.clone());
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::{FileSeed, PackManifest, PackSource, WorkspaceSpec};
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sw-ws-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn pack_at(dir: &Path, folders: &[&str], files: &[(&str, &str)]) -> Pack {
        for (src, _) in files {
            let p = dir.join(src);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "템플릿 본문").unwrap();
        }
        Pack {
            manifest: PackManifest {
                id: "demo".into(),
                name: "데모".into(),
                workspace: WorkspaceSpec {
                    folders: folders.iter().map(|s| s.to_string()).collect(),
                    files: files
                        .iter()
                        .map(|(s, d)| FileSeed {
                            src: s.to_string(),
                            dest: d.to_string(),
                        })
                        .collect(),
                },
                ..Default::default()
            },
            dir: dir.to_path_buf(),
            skills_dir: dir.join("skills"),
            source: PackSource::Builtin,
            enabled: true,
        }
    }

    #[test]
    fn creates_folders_and_seeds_files_once() {
        let vault = tempdir("vault");
        let packdir = tempdir("pack");
        let pack = pack_at(
            &packdir,
            &["일지", "개념"],
            &[("templates/일지.md", "템플릿/일지.md")],
        );

        let first = provision(&vault, &[&pack]).unwrap();
        assert_eq!(first.created.len(), 3);
        assert!(first.failed.is_empty());
        assert!(vault.join("일지").is_dir());
        assert_eq!(
            fs::read_to_string(vault.join("템플릿/일지.md")).unwrap(),
            "템플릿 본문"
        );

        // 사용자가 템플릿을 고친 뒤 재실행 — 덮지 않는다
        fs::write(vault.join("템플릿/일지.md"), "내가 고친 템플릿").unwrap();
        let second = provision(&vault, &[&pack]).unwrap();
        assert!(second.created.is_empty());
        assert_eq!(second.skipped.len(), 3);
        assert_eq!(
            fs::read_to_string(vault.join("템플릿/일지.md")).unwrap(),
            "내가 고친 템플릿"
        );

        fs::remove_dir_all(&vault).unwrap();
        fs::remove_dir_all(&packdir).unwrap();
    }

    #[test]
    fn escaping_paths_are_refused_not_written() {
        let vault = tempdir("escape");
        let packdir = tempdir("escapepack");
        let pack = pack_at(&packdir, &["../밖"], &[("templates/x.md", "../../밖.md")]);
        let r = provision(&vault, &[&pack]).unwrap();
        assert_eq!(r.failed.len(), 2, "{r:?}");
        assert!(r.failed.iter().all(|f| f.contains("밖")));
        assert!(!vault.parent().unwrap().join("밖").exists());
        fs::remove_dir_all(&vault).unwrap();
        fs::remove_dir_all(&packdir).unwrap();
    }

    #[test]
    fn missing_source_is_reported_not_silent() {
        let vault = tempdir("miss");
        let packdir = tempdir("misspack");
        let mut pack = pack_at(&packdir, &[], &[]);
        pack.manifest.workspace.files.push(FileSeed {
            src: "templates/없음.md".into(),
            dest: "템플릿/없음.md".into(),
        });
        let r = provision(&vault, &[&pack]).unwrap();
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].contains("원본이 없습니다"));
        fs::remove_dir_all(&vault).unwrap();
        fs::remove_dir_all(&packdir).unwrap();
    }

    #[test]
    fn plan_lists_only_what_is_missing() {
        let vault = tempdir("plan");
        let packdir = tempdir("planpack");
        let pack = pack_at(
            &packdir,
            &["일지", "개념"],
            &[("templates/a.md", "템플릿/a.md")],
        );
        assert_eq!(plan(&vault, &[&pack]).len(), 3);
        fs::create_dir_all(vault.join("일지")).unwrap();
        assert_eq!(plan(&vault, &[&pack]).len(), 2);
        fs::remove_dir_all(&vault).unwrap();
        fs::remove_dir_all(&packdir).unwrap();
    }

    /// 동봉한 팩으로 빈 폴더 하나를 실제 작업공간으로 만든다 — 마법사 2·3단계가 하는 일
    /// 전체를 에이전트 없이 통과시키는 것이 이 아키텍처의 핵심 주장이다.
    #[test]
    fn shipped_packs_provision_a_usable_workspace() {
        let vault = tempdir("shipped");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugin");
        let reg = crate::packs::load_registry_from(Some(&root), Path::new("/nonexistent"), &[]);
        let enabled: Vec<&Pack> = reg.enabled().collect();
        assert!(enabled.len() >= 4, "기능 확장 네 개가 있어야 한다");

        let planned = plan(&vault, &enabled).len();
        let report = provision(&vault, &enabled).unwrap();
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(report.created.len(), planned, "계획과 결과가 같아야 한다");

        // 일지·개념·프로젝트 문서화 확장
        assert!(vault.join("일지").is_dir());
        assert!(vault.join("프로젝트").is_dir());
        assert!(vault.join("개념").is_dir());
        assert!(vault.join("템플릿/일지.md").is_file());
        assert!(!vault.join("템플릿/이슈.md").exists());
        assert!(!vault.join("템플릿/개선.md").exists());
        assert!(vault.join("프로젝트/프로젝트.base").is_file());
        assert!(!vault.join("프로젝트/이슈.base").exists());
        assert!(vault.join("문서").is_dir());
        assert!(vault.join("템플릿/journal/문서.md").is_file());
        assert!(vault.join("템플릿/journal/일지.md").is_file());

        // 선언형 뷰가 갓 만든 작업공간에서 오류 없이 빈 결과를 낸다
        for pack in &enabled {
            for view in pack.manifest.views.iter().filter(|v| v.kind == "notes") {
                let r = crate::notes::query(&vault, &view.query);
                assert!(r.rows.is_empty(), "{}: 새 작업공간인데 행이 있다", view.id);
            }
        }

        // 두 번째 실행은 아무것도 만들지 않는다 (멱등)
        let again = provision(&vault, &enabled).unwrap();
        assert!(again.created.is_empty());
        assert!(plan(&vault, &enabled).is_empty());

        fs::remove_dir_all(&vault).unwrap();
    }

    #[test]
    fn ensure_root_creates_and_rejects_files() {
        let base = tempdir("root");
        let nested = base.join("새 볼트");
        ensure_root(&nested).unwrap();
        assert!(nested.is_dir());
        let file = base.join("파일");
        fs::write(&file, "x").unwrap();
        assert!(ensure_root(&file).is_err());
        assert!(ensure_root(Path::new("")).is_err());
        fs::remove_dir_all(&base).unwrap();
    }
}
