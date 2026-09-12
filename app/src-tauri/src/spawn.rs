// spawn.rs — keeps child processes from opening a new console window on Windows.
//
// The app itself launches without a console via windows_subsystem="windows" (main.rs), but when
// it spawns console programs like cmd, git, or gh as children, the OS opens a new console window
// for the child. In a product where background ticks (collab 3s, SDLC harness 5s, scheduler 20s)
// keep spawning processes, that shows up as flickering black windows. CREATE_NO_WINDOW(0x0800_0000)
// attaches via pipes only, with no window. No-op on other platforms.

use std::process::Command as StdCommand;

/// std child process. Wraps the start of a builder chain: `no_window(Command::new(..)).arg(..)`
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

/// tokio child process. `no_window_async(tokio::process::Command::new(..))`
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

/// Whether the extension is one CreateProcess can execute directly.
#[cfg(windows)]
fn is_native_executable(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|ext| ext.eq_ignore_ascii_case("exe") || ext.eq_ignore_ascii_case("com"))
}

/// Resolves a bare name like `claude` to a real executable. Resolution is a file lookup scanning
/// the whole PATH, so spawns running on every 3-5s tick cache only successful results instead of
/// redoing it each time. If a cached path disappears (herdr, whose version directory changes on
/// CLI update, is the classic case), drop it and look again.
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

/// The single gate for spawning external CLIs. On Windows, native executables (.exe/.com) run
/// directly and only scripts such as npm shims get wrapped in `cmd /c`. Sending every command
/// through cmd would trip the 8,191-char cmd limit on long agent prompts. Extension-less names
/// like `claude` also run directly when they resolve to a .exe on PATH or install folders —
/// GUI-launched apps inherit a shorter or stale PATH, so the cmd fallback leads straight to
/// "명령줄이 너무 깁니다" (the command line is too long). Scripts CreateProcess cannot run
/// directly keep the existing shell compatibility. Other platforms only get window suppression.
/// cwd, env, and stdio are chained onto the returned builder. New spawn sites must use this function.
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

/// Translates a chunk of a child process's console output into human-readable text. If it is not
/// UTF-8 (on Korean Windows, cmd and system messages are CP949), re-read it as the ANSI code page,
/// falling back to lossy conversion. Logs whose lines may differ in encoding use `decode_console_lines`.
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

/// Agent stdout (UTF-8 JSON) and cmd/tool stderr (CP949) get mixed in one file.
/// Reading the whole thing in one encoding corrupts one side or the other, so judge line by line.
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

/// tokio variant. std options (including window suppression) are carried over by the `From` impl.
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
        // CP949 "명령줄이" as emitted by cmd on Korean Windows. On a code page 949 PC the original
        // text is restored; on other code pages a string must still come out without panicking.
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

    /// Even when an agent's UTF-8 JSON and cmd's CP949 error mix in one log, a UTF-8 line
    /// must not be misread as ANSI wholesale and get corrupted.
    #[test]
    fn decode_console_lines_judges_each_line_separately() {
        let mut bytes = "{\"result\":\"완료\"}\n".as_bytes().to_vec();
        bytes.extend([0xb8, 0xed, 0xb7, 0xc9]);
        let decoded = decode_console_lines(&bytes);
        assert!(decoded.contains("완료"), "{decoded}");
    }

    /// Regression: a bare name like `claude` that resolves to a .exe on PATH must run directly
    /// without cmd /c — cmd dies at 8,191 chars with "명령줄이 너무 깁니다" (command line too long).
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

    /// Spawn-contract smoke test: launch a platform-appropriate sh/cmd script and check stdout
    /// arrives via pipe. Windows CI exercises .cmd sh interpretation + the CREATE_NO_WINDOW path;
    /// elsewhere the direct spawn path is verified on every push.
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

    /// Regression: the design prompt sent to Herdr can exceed cmd.exe's 8,191 chars.
    /// Launching a native executable directly delivers it within the Windows CreateProcess limit.
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
