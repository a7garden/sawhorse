// detect.rs — inspects what is installed on this PC.
//
// The wizard's first screen leans on two things here: (1) the list of terminal agents on this PC,
// (2) whether the baseline environment shared by all workflows is in place. Both must come back
// with "where to get it if missing" so the user never leaves the screen to search.
//
// Tools like Git, Node.js, and pandoc do not live here. Those dependencies are declared by the
// `requirements` of the workflow revision that actually uses them and are checked right before execution.
//
// Detection means the **existence of an executable**, not `--version` success. CLIs without a version
// flag or that demand a login first are common, so reading a failed version probe as "not installed"
// produces false positives. The version string is just extra info appended when available.
//
// Why not PATH alone: GUI-launched apps often fail to inherit the login shell's PATH
// (Dock launches on macOS are the classic case), so common install directories are scanned too.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

// ---------- Executable lookup ----------

/// Directories outside PATH where CLIs are commonly installed.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let h = home();
    #[allow(unused_mut)]
    let mut v = vec![
        h.join(".local").join("bin"),
        h.join("bin"),
        h.join(".bun").join("bin"),
        h.join(".cargo").join("bin"),
        h.join(".deno").join("bin"),
        h.join("go").join("bin"),
        h.join(".npm-global").join("bin"),
        h.join(".volta").join("bin"),
        h.join(".yarn").join("bin"),
    ];
    #[cfg(target_os = "macos")]
    v.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    #[cfg(target_os = "linux")]
    v.extend([
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ]);
    #[cfg(windows)]
    {
        if let Some(d) = dirs::data_local_dir() {
            v.push(d.join("Programs"));
            v.push(d.join("Microsoft").join("WindowsApps"));
        }
        if let Some(d) = dirs::data_dir() {
            v.push(d.join("npm"));
        }
        // herdr installs into a version-stamped release directory and self-updates change that
        // path. A long-running app's PATH ends up pointing at a deleted old version, so scan
        // the install folder directly. Most recently installed first.
        let releases = h
            .join(".herdr")
            .join("packages")
            .join("standalone")
            .join("releases");
        if let Ok(entries) = std::fs::read_dir(&releases) {
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_dir())
                .collect();
            dirs.sort_by_cached_key(|p| {
                std::cmp::Reverse(
                    std::fs::metadata(p)
                        .and_then(|m| m.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                )
            });
            v.extend(dirs);
        }
    }
    v
}

/// On Windows, `foo` may be `foo.exe` or `foo.cmd`. Some environments leave PATHEXT empty, so
/// fall back to defaults. Extension-bearing candidates are tried before the bare name — npm ships
/// an extension-less sh script alongside the .cmd, and CreateProcess cannot run it; if it were
/// found first we would miss the runnable sibling.
#[cfg(windows)]
fn candidate_names(name: &str) -> Vec<String> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut v: Vec<String> = exts
        .split(';')
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| format!("{name}{}", e.to_lowercase()))
        .collect();
    v.push(name.to_string());
    v
}

#[cfg(not(windows))]
fn candidate_names(name: &str) -> Vec<String> {
    vec![name.to_string()]
}

fn is_exec(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Resolves `~/…` and `$VAR/…`. Kept in one place so catalog path templates and user-typed
/// executable paths follow the same rules.
pub fn expand_path(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return Some(home().join(rest));
    }
    if let Some(rest) = raw.strip_prefix('$') {
        let (var, tail) = match rest.find(['/', '\\']) {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, ""),
        };
        let base = PathBuf::from(std::env::var_os(var)?);
        return Some(if tail.is_empty() {
            base
        } else {
            base.join(tail)
        });
    }
    Some(PathBuf::from(raw))
}

/// Maps a single name to a real executable path. If it contains path separators, use it as given
/// (custom agents may specify an absolute path).
pub fn resolve_bin(name: &str) -> Option<PathBuf> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('~') {
        let p = expand_path(name)?;
        return is_exec(&p).then_some(p);
    }
    let names = candidate_names(name);
    let path_dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for dir in path_dirs.into_iter().chain(extra_bin_dirs()) {
        for cand in &names {
            let p = dir.join(cand);
            if is_exec(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// The first executable found among candidate names.
pub fn resolve_any(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|n| resolve_bin(n))
}

// ---------- Version probes ----------

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

fn build_command(path: &Path, args: &[&str]) -> tokio::process::Command {
    crate::spawn::platform_command_async(path, args)
}

/// A nice-to-have one-liner: taken when present, fine when absent. The timeout is kept short so the wizard never stalls.
pub async fn version_of(path: &Path, args: &[&str]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let mut c = build_command(path, args);
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // Some CLIs do not know `--version` and open interactively. Merely giving up on the
        // wait via timeout leaves the process behind — kill it so zombies do not pile up per check.
        .kill_on_drop(true);
    let out = tokio::time::timeout(PROBE_TIMEOUT, c.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // Some tools print their version to stderr (java is famous for it).
    let raw = if out.stdout.iter().any(|b| !b.is_ascii_whitespace()) {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        String::from_utf8_lossy(&out.stderr).into_owned()
    };
    raw.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| truncate_chars(l, 80))
}

/// Synchronous launch-gate probe for workflow-owned program requirements. The
/// accepted arguments are validated by the workflow schema; the timeout keeps a
/// broken executable from holding the launch mutex indefinitely.
pub fn version_of_sync(path: &Path, args: &[String]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let mut command = crate::spawn::platform_command(path, &refs);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                let text = if output.stdout.is_empty() {
                    String::from_utf8_lossy(&output.stderr).into_owned()
                } else {
                    String::from_utf8_lossy(&output.stdout).into_owned()
                };
                return Some(truncate_chars(text.trim(), 160));
            }
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Probes versions of several targets concurrently. Result order preserves input order — the
/// caller reads results paired with the catalog order.
pub async fn versions_of(targets: Vec<(PathBuf, &'static [&'static str])>) -> Vec<Option<String>> {
    let mut out = vec![None; targets.len()];
    let mut set = tokio::task::JoinSet::new();
    for (i, (path, args)) in targets.into_iter().enumerate() {
        set.spawn(async move { (i, version_of(&path, args).await) });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok((i, v)) = joined {
            out[i] = v;
        }
    }
    out
}

/// Extracts just the major number from strings that arrive mixed like "v24.18.0" or "git version 2.39.5".
pub fn major_of(version: &str) -> Option<u32> {
    let mut digits = String::new();
    for ch in version.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else if !digits.is_empty() {
            break;
        }
    }
    digits.parse().ok()
}

// ---------- App shared baseline-environment catalog ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Need {
    /// Without it, every product workflow is blocked
    Required,
    /// Runs without it, but features shrink or fall back
    Recommended,
    /// Used only for specific jobs
    Optional,
}

pub struct RequirementSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub need: Need,
    /// Why it is needed — one line, so users can judge whether to install it themselves.
    pub why: &'static str,
    pub bins: &'static [&'static str],
    pub version_args: &'static [&'static str],
    /// Path templates for catching GUI apps rather than CLIs (`~` and `$VAR` supported)
    pub paths: &'static [&'static str],
    /// An empty string means "install location unknown" — the UI shows no install button. Pointing
    /// at nothing beats pretending to know an unknown location.
    pub install_url: &'static str,
    pub install_hint: &'static str,
    /// Must be at least this major version. 0 skips the check.
    pub min_major: u32,
}

pub const REQUIREMENTS: &[RequirementSpec] = &[
    RequirementSpec {
        id: "obsidian",
        name: "Obsidian",
        need: Need::Recommended,
        why: "작업공간 노트를 사람이 읽고 고치는 앱입니다. 없어도 앱은 돌지만 볼트 설정은 Obsidian 기준입니다.",
        bins: &["obsidian"],
        version_args: &[],
        paths: &[
            "/Applications/Obsidian.app",
            "~/Applications/Obsidian.app",
            "$LOCALAPPDATA/Obsidian/Obsidian.exe",
            "$PROGRAMFILES/Obsidian/Obsidian.exe",
            "/usr/share/applications/obsidian.desktop",
            "~/.local/share/applications/obsidian.desktop",
            "/var/lib/flatpak/exports/share/applications/md.obsidian.Obsidian.desktop",
            "~/.local/share/flatpak/exports/share/applications/md.obsidian.Obsidian.desktop",
        ],
        install_url: "https://obsidian.md/download",
        install_hint: "",
        min_major: 0,
    },
    RequirementSpec {
        id: "herdr",
        name: "herdr",
        need: Need::Recommended,
        why: "잡을 사람이 이어받을 수 있는 터미널 세션에서 돌립니다. 없으면 백그라운드 실행으로 자동 폴백합니다.",
        bins: &["herdr"],
        version_args: &["--version"],
        paths: &[],
        install_url: "https://herdr.dev",
        install_hint: "깔려 있는데 잡히지 않으면 설정 → 실행에서 herdr 실행 파일 경로를 지정하세요.",
        min_major: 0,
    },
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RequirementStatus {
    pub id: String,
    pub name: String,
    pub need: Need,
    pub why: String,
    pub detected: bool,
    pub version: Option<String>,
    /// Found executable or app bundle path (empty string when absent)
    pub path: String,
    /// Installed but below the minimum version
    pub outdated: bool,
    pub min_major: u32,
    pub install_url: String,
    pub install_hint: String,
}

/// The second value is "found as an executable" — GUI app bundles cannot be asked for a version.
///
/// Install paths are checked **before** PATH. If a CLI package with the same name exists on PATH
/// (`obsidian-cli` is the classic case), we would otherwise report present even without the app.
fn locate(spec: &RequirementSpec) -> Option<(PathBuf, bool)> {
    for t in spec.paths {
        if let Some(p) = expand_path(t) {
            // GUI apps are judged by existence, not executability (a macOS .app is a directory).
            if p.exists() {
                return Some((p, false));
            }
        }
    }
    resolve_any(spec.bins).map(|p| (p, true))
}

pub async fn check_requirements() -> Vec<RequirementStatus> {
    let found: Vec<Option<(PathBuf, bool)>> = REQUIREMENTS.iter().map(locate).collect();
    let probes: Vec<(PathBuf, &'static [&'static str])> = REQUIREMENTS
        .iter()
        .zip(&found)
        .filter_map(|(spec, f)| match f {
            Some((p, true)) if !spec.version_args.is_empty() => {
                Some((p.clone(), spec.version_args))
            }
            _ => None,
        })
        .collect();
    let mut versions = versions_of(probes).await.into_iter();

    REQUIREMENTS
        .iter()
        .zip(found)
        .map(|(spec, f)| {
            let (path, is_bin) = match &f {
                Some((p, b)) => (p.display().to_string(), *b),
                None => (String::new(), false),
            };
            // `versions` holds only the probed entries in order, so pull only for probed ones.
            let version = if is_bin && !spec.version_args.is_empty() {
                versions.next().flatten()
            } else {
                None
            };
            let outdated = spec.min_major > 0
                && version
                    .as_deref()
                    .and_then(major_of)
                    .is_some_and(|m| m < spec.min_major);
            RequirementStatus {
                id: spec.id.into(),
                name: spec.name.into(),
                need: spec.need,
                why: spec.why.into(),
                detected: f.is_some(),
                version,
                path,
                outdated,
                min_major: spec.min_major,
                install_url: spec.install_url.into(),
                install_hint: spec.install_hint.into(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sw-detect-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn major_reads_the_first_number_whatever_the_prefix() {
        assert_eq!(major_of("v24.18.0"), Some(24));
        assert_eq!(major_of("git version 2.39.5"), Some(2));
        assert_eq!(major_of("2.1.261 (Claude Code)"), Some(2));
        assert_eq!(major_of("no digits here"), None);
    }

    #[test]
    fn expand_resolves_tilde_and_env() {
        let h = home();
        assert_eq!(expand_path("~/x/y"), Some(h.join("x").join("y")));
        std::env::set_var("SW_DETECT_TEST_DIR", "/tmp/sw");
        assert_eq!(
            expand_path("$SW_DETECT_TEST_DIR/z"),
            Some(PathBuf::from("/tmp/sw/z"))
        );
        assert_eq!(expand_path("$SW_DETECT_NO_SUCH_VAR/z"), None);
        assert_eq!(expand_path("   "), None);
    }

    /// An extension-less npm sh script must not shadow a runnable .exe or .cmd.
    #[cfg(windows)]
    #[test]
    fn candidates_prefer_executable_extensions_over_bare_name() {
        let names = candidate_names("claude");
        assert_eq!(names.last().map(String::as_str), Some("claude"));
        assert!(names.iter().any(|n| n.eq_ignore_ascii_case("claude.exe")));
    }

    #[test]
    fn resolve_bin_accepts_an_explicit_path_and_rejects_a_directory() {
        let dir = tempdir("explicit");
        let exe = dir.join("thing");
        fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(resolve_bin(exe.to_str().unwrap()), Some(exe.clone()));
        assert_eq!(resolve_bin(dir.to_str().unwrap()), None);
        assert_eq!(resolve_bin(""), None);
        assert_eq!(resolve_bin("sawhorse-no-such-binary-xyz"), None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn workflow_version_probe_reads_a_bounded_program_version() {
        let dir = tempdir("workflow-version");
        let exe = dir.join(if cfg!(windows) {
            "version.cmd"
        } else {
            "version"
        });
        #[cfg(windows)]
        fs::write(&exe, "@echo off\r\necho v18.4.0\r\n").unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::write(&exe, "#!/bin/sh\necho v18.4.0\n").unwrap();
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let version = version_of_sync(&exe, &["--version".into()]).unwrap();
        assert_eq!(major_of(&version), Some(18));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn install_paths_win_over_a_same_named_cli_on_path() {
        // A PC with an npm CLI named `obsidian` on PATH really exists. When the app bundle is
        // present it must be the answer, so "is the app installed" gets the right reply.
        let dir = tempdir("order");
        let app = dir.join("Fake.app");
        fs::create_dir_all(&app).unwrap();
        let leaked: &'static str = Box::leak(app.display().to_string().into_boxed_str());
        let spec = RequirementSpec {
            id: "x",
            name: "X",
            need: Need::Optional,
            why: "테스트",
            bins: &["sh"],
            version_args: &[],
            paths: Box::leak(Box::new([leaked])),
            install_url: "",
            install_hint: "",
            min_major: 0,
        };
        assert_eq!(locate(&spec), Some((app, false)));

        // With no paths, fall back to the executable (interpreted as sh.exe on Windows)
        let only_bin = RequirementSpec { paths: &[], ..spec };
        let (p, is_bin) = locate(&only_bin).expect("sh 를 찾지 못했습니다");
        assert!(is_bin && p.file_stem().is_some_and(|s| s == "sh"), "{p:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn catalog_entries_are_well_formed() {
        for spec in REQUIREMENTS {
            assert!(!spec.id.is_empty() && !spec.name.is_empty(), "{}", spec.id);
            assert!(
                !spec.why.is_empty(),
                "{} 는 왜 필요한지 적혀 있어야 한다",
                spec.id
            );
            assert!(
                !spec.bins.is_empty() || !spec.paths.is_empty(),
                "{} 를 찾을 방법이 없다",
                spec.id
            );
            assert!(
                spec.install_url.is_empty() || spec.install_url.starts_with("https://"),
                "{} 의 설치 링크는 https 여야 한다 (open_external 이 https 만 연다)",
                spec.id
            );
        }
    }

    #[tokio::test]
    async fn check_requirements_reports_every_catalog_entry_in_order() {
        let rows = check_requirements().await;
        assert_eq!(rows.len(), REQUIREMENTS.len());
        for (row, spec) in rows.iter().zip(REQUIREMENTS) {
            assert_eq!(
                row.id, spec.id,
                "카탈로그 순서가 어긋나면 버전이 엉뚱한 줄에 붙는다"
            );
        }
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            vec!["obsidian", "herdr"],
            "기능별 도구는 workflow requirements로 이동해야 한다"
        );
        // Undetected entries must have an empty path and no version
        for r in rows.iter().filter(|r| !r.detected) {
            assert!(r.path.is_empty() && r.version.is_none(), "{}", r.id);
        }
    }
}
