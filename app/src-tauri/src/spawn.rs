// spawn.rs — 자식 프로세스가 Windows에서 콘솔 창을 새로 열지 않게 막는다.
//
// 앱 자체는 windows_subsystem="windows"(main.rs)로 콘솔 없이 뜨지만, cmd·git·gh
// 같은 콘솔 프로그램을 자식으로 스폰하면 OS가 자식용 콘솔 창을 새로 연다. 백그라운드
// 틱(collab 3초, SDLC 하니스 5초, 스케줄러 20초)이 프로세스를 계속 띄우는 이 제품에선
// 까만 창이 깜빡거리는 증상으로 보인다. CREATE_NO_WINDOW(0x0800_0000)를 걸면 창 없이
// 파이프로만 붙는다. 다른 플랫폼에서는 하는 일이 없다.

use std::process::Command as StdCommand;

/// std 자식 프로세스. 빌더 체인 시작을 감싸 쓴다: `no_window(Command::new(..)).arg(..)`
pub fn no_window(mut command: StdCommand) -> StdCommand {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = &mut command;
    }
    command
}

/// tokio 자식 프로세스. `no_window_async(tokio::process::Command::new(..))`
pub fn no_window_async(mut command: tokio::process::Command) -> tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = &mut command;
    }
    command
}

/// CreateProcess가 직접 실행할 수 있는 확장자인가.
#[cfg(windows)]
fn is_native_executable(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
}

/// `claude` 같은 맨 이름을 실제 실행 파일로 바꿔 둔다. 해석은 PATH 전체를 훑는
/// 파일 조회라, 3~5초 틱마다 도는 스폰이 매번 다시 하지 않게 성공한 결과만 캐시한다.
/// 캐시된 경로가 사라졌으면(CLI 업데이트로 버전 디렉토리가 바뀌는 herdr가 대표적)
/// 버리고 다시 찾는다.
#[cfg(windows)]
fn resolve_native(bin: &std::ffi::OsStr) -> Option<std::path::PathBuf> {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;
    static CACHE: parking_lot::Mutex<Option<HashMap<OsString, PathBuf>>> =
        parking_lot::Mutex::new(None);
    let mut cache = CACHE.lock();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some(hit) = cache.get(bin) {
        if hit.is_file() {
            return Some(hit.clone());
        }
        cache.remove(bin);
    }
    let resolved = crate::detect::resolve_bin(&bin.to_string_lossy())
        .filter(|path| is_native_executable(path))?;
    cache.insert(bin.to_os_string(), resolved.clone());
    Some(resolved)
}

/// 외부 CLI 스폰의 단일 문. Windows에서는 네이티브 실행 파일(.exe/.com)을 직접
/// 실행하고, npm 셈 같은 스크립트만 `cmd /c`로 감싼다. 모든 명령을 cmd로 보내면
/// 긴 에이전트 프롬프트가 cmd의 8,191자 제한에 걸린다. `claude`처럼 확장자 없는
/// 이름도 PATH·설치 폴더에서 .exe 로 해석되면 직접 실행한다 — GUI로 뜬 앱은 셸보다
/// 짧거나 낡은 PATH를 물려받아 cmd 폴백이 곧 "명령줄이 너무 깁니다"로 이어진다.
/// CreateProcess가 직접 실행할 수 없는 스크립트에는 기존 셸 호환성을 유지한다.
/// 다른 플랫폼에서는 창 억제만 적용한다. cwd·env·stdio는 반환값 빌더 체인으로
/// 잇는다. 새 스폰 지점은 이 함수만 쓴다.
pub fn platform_command(bin: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> StdCommand {
    #[cfg(windows)]
    {
        let bin = bin.as_ref();
        let mut c = if is_native_executable(std::path::Path::new(bin)) {
            no_window(StdCommand::new(bin))
        } else if let Some(resolved) = resolve_native(bin) {
            no_window(StdCommand::new(resolved))
        } else {
            let mut c = no_window(StdCommand::new("cmd"));
            c.arg("/c").arg(bin);
            c
        };
        c.args(args);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = no_window(StdCommand::new(bin));
        c.args(args);
        c
    }
}

/// 자식 프로세스의 콘솔 출력 한 덩어리를 사람 글로 옮긴다. UTF-8이 아니면(한국어
/// Windows에서 cmd·시스템 메시지는 CP949) ANSI 코드페이지로 다시 읽고, 그래도
/// 안 되면 손실 변환으로 떨어진다. 줄마다 인코딩이 다를 수 있는 로그는
/// `decode_console_lines`를 쓴다.
pub fn decode_console(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            #[cfg(windows)]
            if let Some(text) = ansi_to_string(bytes) {
                return text;
            }
            String::from_utf8_lossy(bytes).into_owned()
        }
    }
}

/// 에이전트 stdout(UTF-8 JSON)과 cmd·도구 stderr(CP949)가 한 파일에 섞인다.
/// 전체를 한 인코딩으로 읽으면 한쪽이 반드시 깨지므로 줄 단위로 판별한다.
pub fn decode_console_lines(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        out.push_str(&decode_console(line));
    }
    out
}

#[cfg(windows)]
fn ansi_to_string(bytes: &[u8]) -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            bytes: *const u8,
            byte_len: i32,
            out: *mut u16,
            out_len: i32,
        ) -> i32;
    }
    const CP_ACP: u32 = 0;
    const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;
    if bytes.is_empty() {
        return Some(String::new());
    }
    let len = i32::try_from(bytes.len()).ok()?;
    let needed = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return None;
    }
    let mut wide = vec![0_u16; needed as usize];
    let written = unsafe {
        MultiByteToWideChar(
            CP_ACP,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            len,
            wide.as_mut_ptr(),
            needed,
        )
    };
    if written <= 0 {
        return None;
    }
    String::from_utf16(&wide[..written as usize]).ok()
}

/// tokio 변형. std 옵션(창 억제 포함)은 `From` 구현이 그대로 물려받는다.
pub fn platform_command_async(
    bin: impl AsRef<std::ffi::OsStr>,
    args: &[&str],
) -> tokio::process::Command {
    tokio::process::Command::from(platform_command(bin, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_console_keeps_utf8_and_survives_ansi_bytes() {
        assert_eq!(decode_console("진행 로그".as_bytes()), "진행 로그");
        // 한국어 Windows cmd 가 내는 CP949 "명령줄이". 코드페이지 949 PC 에서는 원문이
        // 복원되고, 다른 코드페이지에서도 패닉 없이 문자열이 나와야 한다.
        let cp949: &[u8] = &[0xb8, 0xed, 0xb7, 0xc9, 0xc1, 0xd9, 0xc0, 0xcc];
        let decoded = decode_console(cp949);
        assert!(!decoded.is_empty());
        #[cfg(windows)]
        {
            #[link(name = "kernel32")]
            extern "system" {
                fn GetACP() -> u32;
            }
            if unsafe { GetACP() } == 949 {
                assert_eq!(decoded, "명령줄이");
            }
        }
    }

    /// 에이전트의 UTF-8 JSON 과 cmd 의 CP949 오류가 한 로그에 섞여도, UTF-8 줄이
    /// 통째 ANSI 로 오독되어 깨지면 안 된다.
    #[test]
    fn decode_console_lines_judges_each_line_separately() {
        let mut bytes = "{\"result\":\"완료\"}\n".as_bytes().to_vec();
        bytes.extend([0xb8, 0xed, 0xb7, 0xc9]);
        let decoded = decode_console_lines(&bytes);
        assert!(decoded.contains("완료"), "{decoded}");
    }

    /// 회귀: `claude` 같은 맨 이름이 PATH 의 .exe 로 해석되면 cmd /c 없이 직접
    /// 실행해야 한다 — cmd 는 8,191자에서 "명령줄이 너무 깁니다"로 죽는다.
    #[cfg(windows)]
    #[test]
    fn bare_name_resolving_to_exe_skips_cmd_wrapper() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("sw-spawn-fake.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        let old = std::env::var_os("PATH");
        let mut paths: Vec<std::path::PathBuf> = vec![dir.path().to_path_buf()];
        if let Some(old) = &old {
            paths.extend(std::env::split_paths(old));
        }
        std::env::set_var("PATH", std::env::join_paths(paths).unwrap());
        let c = platform_command("sw-spawn-fake", &["--x"]);
        if let Some(old) = old {
            std::env::set_var("PATH", old);
        }
        assert!(
            c.get_program().to_string_lossy().ends_with("sw-spawn-fake.exe"),
            "{:?}",
            c.get_program()
        );
    }

    /// 스폰 계약 스모크: 플랫폼별 셈 스크립트를 띄워 stdout이 파이프로 오는지 본다.
    /// Windows CI에서는 .cmd 셈 해석 + CREATE_NO_WINDOW 경로가, 그 외에서는 직접
    /// 스폰 경로가 매 푸시 검증된다.
    #[tokio::test]
    async fn platform_command_captures_script_stdout() {
        let path = std::env::temp_dir().join(format!(
            "sawhorse-spawn-smoke-{}.{}",
            uuid::Uuid::new_v4(),
            if cfg!(windows) { "cmd" } else { "sh" }
        ));
        #[cfg(windows)]
        std::fs::write(&path, "@echo off\r\necho spawn-smoke-ok\r\n").unwrap();
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&path, "#!/bin/sh\necho spawn-smoke-ok\n").unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut c = platform_command_async(&path, &[]);
        let out = c.output().await.unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&out.stdout).trim(),
            "spawn-smoke-ok"
        );
    }

    /// 회귀: Herdr에 보내는 설계 프롬프트는 cmd.exe의 8,191자보다 길 수 있다.
    /// 네이티브 실행 파일을 직접 시작하면 Windows CreateProcess 한도 안에서 정상 전달된다.
    #[cfg(windows)]
    #[tokio::test]
    async fn native_executable_accepts_argument_longer_than_cmd_limit() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("measure-argument.ps1");
        std::fs::write(&script, "$args[0].Length\r\n").unwrap();
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        let payload = "x".repeat(8_300);
        let script = script.to_string_lossy();
        let mut c = platform_command_async(
            &powershell,
            &[
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-File",
                &script,
                &payload,
            ],
        );
        let out = c.output().await.unwrap();
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "8300");
    }
}
