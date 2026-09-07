use std::collections::{BTreeMap, BTreeSet};

use semver::{Version, VersionReq};

use super::package::InstalledPackage;

const MAX_ATTEMPTS: usize = 10_000;
const MAX_DEPTH: usize = 128;

#[derive(Clone)]
struct Requirement {
    id: String,
    range: VersionReq,
    requested_by: String,
}

/// Resolve the whole constraint set, retrying earlier choices when a later
/// dependency narrows a shared version. Optional dependencies remain opt-in.
pub(super) fn resolve(
    installed: &[InstalledPackage],
    root_id: &str,
    version: &str,
) -> Result<Vec<InstalledPackage>, String> {
    Version::parse(version)
        .map_err(|error| format!("package semver가 유효하지 않습니다: {error}"))?;
    // VersionReq ignores build metadata, but the explicitly requested root must be exact.
    let available = installed
        .iter()
        .filter(|package| package.manifest.id != root_id || package.manifest.version == version)
        .collect::<Vec<_>>();
    search(
        &available,
        vec![Requirement {
            id: root_id.into(),
            range: VersionReq::parse(&format!("={version}")).map_err(|error| error.to_string())?,
            requested_by: "선택한 확장".into(),
        }],
        BTreeMap::new(),
        &mut 0,
    )
    .map(|packages| packages.into_iter().cloned().collect())
}

fn search<'a>(
    installed: &[&'a InstalledPackage],
    mut pending: Vec<Requirement>,
    selected: BTreeMap<String, &'a InstalledPackage>,
    attempts: &mut usize,
) -> Result<Vec<&'a InstalledPackage>, String> {
    while let Some(requirement) = pending.pop() {
        if let Some(package) = selected.get(&requirement.id) {
            let version =
                Version::parse(&package.manifest.version).map_err(|error| error.to_string())?;
            if !requirement.range.matches(&version) {
                return Err(format!(
                    "extension dependency 버전 요구가 충돌합니다: {} → {} {} ({} 선택)",
                    requirement.requested_by, requirement.id, requirement.range, version
                ));
            }
            continue;
        }
        if selected.len() >= MAX_DEPTH {
            return Err(format!(
                "extension dependency 해석 한도({MAX_DEPTH}개)를 초과했습니다"
            ));
        }
        let mut candidates = installed
            .iter()
            .copied()
            .filter_map(|package| {
                let version = Version::parse(&package.manifest.version).ok()?;
                (package.manifest.id == requirement.id
                    && requirement.range.matches(&version)
                    && pending
                        .iter()
                        .filter(|next| next.id == requirement.id)
                        .all(|next| next.range.matches(&version)))
                .then_some((version, package))
            })
            .collect::<Vec<_>>();
        candidates.sort_by(|(left_version, left), (right_version, right)| {
            right_version
                .cmp(left_version)
                .then(left.digest.cmp(&right.digest))
                .then(left.path.cmp(&right.path))
        });
        candidates.dedup_by(|(_, left), (_, right)| {
            left.manifest.version == right.manifest.version && left.digest == right.digest
        });
        let constraints = std::iter::once(&requirement)
            .chain(pending.iter().filter(|next| next.id == requirement.id))
            .map(|entry| format!("{} → {} {}", entry.requested_by, entry.id, entry.range))
            .collect::<Vec<_>>()
            .join("; ");
        let mut last_error =
            format!("extension dependency 요구 충돌 또는 설치 버전 누락: {constraints}");
        for (_, package) in &candidates {
            if candidates.iter().any(|(_, other)| {
                other.manifest.version == package.manifest.version && other.digest != package.digest
            }) {
                return Err(format!("같은 extension {}@{}에 서로 다른 digest가 설치되어 있습니다. 고유한 버전으로 다시 설치하세요",
                    package.manifest.id, package.manifest.version));
            }
            if *attempts >= MAX_ATTEMPTS {
                return Err(format!("extension dependency 탐색 한도({MAX_ATTEMPTS}회)를 초과했습니다. 버전 범위를 좁혀 주세요"));
            }
            *attempts += 1;
            let mut next_selected = selected.clone();
            next_selected.insert(requirement.id.clone(), *package);
            let mut next_pending = pending.clone();
            for dependency in package
                .manifest
                .dependencies
                .iter()
                .rev()
                .filter(|dependency| !dependency.optional)
            {
                next_pending.push(Requirement {
                    id: dependency.id.clone(),
                    range: VersionReq::parse(&dependency.requirement)
                        .map_err(|error| error.to_string())?,
                    requested_by: format!("{}@{}", package.manifest.id, package.manifest.version),
                });
            }
            match search(installed, next_pending, next_selected, attempts) {
                Ok(resolved) => return Ok(resolved),
                Err(error) => last_error = error,
            }
        }
        return Err(last_error);
    }
    dependency_order(&selected)
}

/// Deterministic child-first ordering also detects cycles through already selected nodes.
fn dependency_order<'a>(
    selected: &BTreeMap<String, &'a InstalledPackage>,
) -> Result<Vec<&'a InstalledPackage>, String> {
    let mut remaining = selected
        .iter()
        .map(|(id, package)| {
            (
                id.clone(),
                package
                    .manifest
                    .dependencies
                    .iter()
                    .filter(|dependency| !dependency.optional)
                    .map(|dependency| dependency.id.clone())
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut output = Vec::with_capacity(selected.len());
    while !remaining.is_empty() {
        let next = remaining
            .iter()
            .find(|(_, dependencies)| dependencies.is_empty())
            .map(|(id, _)| id.clone())
            .ok_or_else(|| {
                format!(
                    "extension dependency 순환입니다: {}",
                    remaining.keys().cloned().collect::<Vec<_>>().join(" → ")
                )
            })?;
        remaining.remove(&next);
        output.push(selected[&next]);
        for dependencies in remaining.values_mut() {
            dependencies.remove(&next);
        }
    }
    Ok(output)
}
