// detect.rs — 이 PC에 무엇이 깔려 있는지 본다.
//
// 마법사 첫 화면이 여기에 기대는 것은 두 가지다. (1) 이 PC의 터미널 에이전트 목록,
// (2) 제품이 실제로 쓰는 외부 프로그램이 갖춰졌는지. 둘 다 "없으면 어디서 받는지"까지
// 함께 돌려줘야 사용자가 화면을 떠나 검색하지 않는다.
//
// 감지 판정은 `--version` 성공이 아니라 **실행 파일의 존재**다. 버전 플래그가 없거나
// 로그인을 먼저 요구하는 CLI 가 흔해서, 버전 조회 실패를 미설치로 읽으면 오탐이 난다.
// 버전 문자열은 있으면 덧붙이는 부가 정보일 뿐이다.
//
// PATH 만 보지 않는 이유: GUI 로 띄운 앱은 로그인 셸의 PATH 를 물려받지 못하는 일이
// 잦다(맥에서 Dock 실행이 대표적). 그래서 흔한 설치 디렉토리를 함께 훑는다.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

// ---------- 실행 파일 찾기 ----------

/// PATH 밖에 CLI 가 흔히 깔리는 곳들.
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
    }
    v
}

/// 윈도우에서 `foo` 는 `foo.exe`·`foo.cmd` 일 수 있다. PATHEXT 가 비어 있는 환경도 있어
/// 기본값을 둔다.
#[cfg(windows)]
fn candidate_names(name: &str) -> Vec<String> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut v = vec![name.to_string()];
    v.extend(
        exts.split(';')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(|e| format!("{name}{}", e.to_lowercase())),
    );
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

/// `~/…` 와 `$VAR/…` 를 푼다. 카탈로그의 경로 템플릿과 사용자가 적은 실행 파일 경로가
/// 같은 규칙을 쓰도록 한 곳에 둔다.
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

/// 이름 하나를 실제 실행 파일 경로로 바꾼다. 경로 구분자가 있으면 그 경로를 그대로 본다
/// (사용자 정의 에이전트가 절대경로를 적는 경우).
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

/// 후보 이름들 중 처음 찾히는 실행 파일.
pub fn resolve_any(names: &[&str]) -> Option<PathBuf> {
    names.iter().find_map(|n| resolve_bin(n))
}

// ---------- 버전 조회 ----------

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

fn build_command(path: &Path, args: &[&str]) -> tokio::process::Command {
    // 윈도우의 .cmd/.bat 은 CreateProcess 가 직접 실행하지 못한다 — cmd 를 통해 부른다.
    #[cfg(windows)]
    {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        if ext == "cmd" || ext == "bat" {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/c").arg(path).args(args);
            return c;
        }
    }
    let mut c = tokio::process::Command::new(path);
    c.args(args);
    c
}

/// 있으면 좋고 없어도 그만인 한 줄. 타임아웃을 짧게 잡아 마법사가 멈추지 않게 한다.
pub async fn version_of(path: &Path, args: &[&str]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let mut c = build_command(path, args);
    c.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // `--version` 을 모르고 대화형으로 뜨는 CLI 가 있다. 타임아웃으로 기다리기를
        // 그만두는 것만으로는 그 프로세스가 남는다 — 검사할 때마다 좀비가 쌓이지 않게 죽인다.
        .kill_on_drop(true);
    let out = tokio::time::timeout(PROBE_TIMEOUT, c.output())
        .await
        .ok()?
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // 버전을 stderr 로 내는 도구가 있다 (java 가 유명하다).
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

/// 여러 대상의 버전을 동시에 조회한다. 결과 순서는 입력 순서를 지킨다 — 호출한 쪽이
/// 카탈로그 순서와 짝지어 읽기 때문이다.
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

/// "v24.18.0", "git version 2.39.5" 처럼 섞여 오는 문자열에서 메이저 숫자만 뽑는다.
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

// ---------- 필요한 프로그램 카탈로그 ----------

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Need {
    /// 없으면 제품의 핵심 흐름이 막힌다
    Required,
    /// 없어도 돌지만 기능이 줄거나 폴백으로 떨어진다
    Recommended,
    /// 특정 작업에서만 쓴다
    Optional,
}

pub struct RequirementSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub need: Need,
    /// 왜 필요한가 — 사용자가 설치 여부를 스스로 판단할 수 있게 한 줄로 적는다.
    pub why: &'static str,
    pub bins: &'static [&'static str],
    pub version_args: &'static [&'static str],
    /// CLI 가 아닌 GUI 앱을 잡기 위한 경로 템플릿 (`~`, `$VAR` 지원)
    pub paths: &'static [&'static str],
    /// 빈 문자열이면 "설치 위치를 모른다" — 화면에 설치 버튼을 내지 않는다. 모르는 곳을
    /// 아는 척 가리키느니 아무것도 가리키지 않는 편이 낫다.
    pub install_url: &'static str,
    pub install_hint: &'static str,
    /// 이 메이저 버전 이상이어야 한다. 0 이면 확인하지 않는다.
    pub min_major: u32,
}

pub const REQUIREMENTS: &[RequirementSpec] = &[
    RequirementSpec {
        id: "git",
        name: "Git",
        need: Need::Required,
        why: "코드 이슈 실행과 진단이 저장소 상태를 읽습니다.",
        bins: &["git"],
        version_args: &["--version"],
        paths: &[],
        install_url: "https://git-scm.com/downloads",
        install_hint: "macOS: xcode-select --install · Windows: winget install Git.Git",
        min_major: 0,
    },
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
        install_url: "",
        install_hint: "깔려 있는데 잡히지 않으면 설정 → 실행에서 herdr 실행 파일 경로를 지정하세요.",
        min_major: 0,
    },
    RequirementSpec {
        id: "node",
        name: "Node.js",
        need: Need::Recommended,
        why: "엑셀 내보내기 스크립트와 일부 스킬이 node 로 돕니다. 18 이상이 필요합니다.",
        bins: &["node"],
        version_args: &["--version"],
        paths: &[],
        install_url: "https://nodejs.org/en/download",
        install_hint: "macOS: brew install node · Windows: winget install OpenJS.NodeJS.LTS",
        min_major: 18,
    },
    RequirementSpec {
        id: "pandoc",
        name: "pandoc",
        need: Need::Optional,
        why: "docx 를 읽을 때 씁니다. 없으면 Word 자동화로 폴백합니다.",
        bins: &["pandoc"],
        version_args: &["--version"],
        paths: &[],
        install_url: "https://pandoc.org/installing.html",
        install_hint: "macOS: brew install pandoc · Windows: winget install JohnMacFarlane.Pandoc",
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
    /// 찾은 실행 파일 또는 앱 번들 경로 (없으면 빈 문자열)
    pub path: String,
    /// 깔려는 있는데 최소 버전에 못 미친다
    pub outdated: bool,
    pub min_major: u32,
    pub install_url: String,
    pub install_hint: String,
}

/// 두 번째 값은 "실행 파일로 찾았는가" — GUI 앱 번들은 버전을 물어볼 수 없다.
///
/// 설치 경로를 PATH 보다 **먼저** 본다. 같은 이름의 CLI 패키지가 PATH 에 있으면
/// (`obsidian-cli` 가 대표적) 앱이 없는데도 있다고 답하게 되기 때문이다.
fn locate(spec: &RequirementSpec) -> Option<(PathBuf, bool)> {
    for t in spec.paths {
        if let Some(p) = expand_path(t) {
            // GUI 앱은 실행 가능 여부가 아니라 존재 여부로 본다 (맥의 .app 은 디렉토리다).
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
            // `versions` 는 조회한 것들만 순서대로 들어 있으므로, 조회한 항목에서만 당긴다.
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
    fn install_paths_win_over_a_same_named_cli_on_path() {
        // `obsidian` 이라는 npm CLI 가 PATH 에 있는 PC 가 실제로 있다. 앱 번들이 있으면
        // 그쪽을 답으로 삼아야 "앱이 깔려 있나" 라는 질문에 바르게 답한다.
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

        // 경로가 없으면 실행 파일로 떨어진다
        let only_bin = RequirementSpec { paths: &[], ..spec };
        let (p, is_bin) = locate(&only_bin).expect("sh 를 찾지 못했습니다");
        assert!(is_bin && p.ends_with("sh"));
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
        // git 은 이 저장소를 빌드하는 환경이면 반드시 있다
        let git = rows.iter().find(|r| r.id == "git").unwrap();
        assert!(git.detected, "git 을 찾지 못했습니다");
        assert!(git.version.is_some(), "git 버전 조회 실패");
        assert!(!git.outdated);
        // 감지되지 않은 항목은 경로도 버전도 비어 있어야 한다
        for r in rows.iter().filter(|r| !r.detected) {
            assert!(r.path.is_empty() && r.version.is_none(), "{}", r.id);
        }
    }
}
