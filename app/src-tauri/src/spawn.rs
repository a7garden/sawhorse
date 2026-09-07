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

/// 외부 CLI 스폰의 단일 문. Windows에서는 npm 셈(.cmd)까지 해석되도록 `cmd /c`로
/// 감싸고 — CreateProcess는 .cmd를 직접 실행하지 못한다 — 콘솔 창 억제 플래그를
/// 건다. 다른 플랫폼에서는 창 억제만 적용한다. cwd·env·stdio는 반환값 빌더 체인으로
/// 잇는다. 새 스폰 지점은 이 함수만 쓴다.
pub fn platform_command(bin: impl AsRef<std::ffi::OsStr>, args: &[&str]) -> StdCommand {
    #[cfg(windows)]
    {
        let mut c = no_window(StdCommand::new("cmd"));
        c.arg("/c").arg(bin).args(args);
        c
    }
    #[cfg(not(windows))]
    {
        let mut c = no_window(StdCommand::new(bin));
        c.args(args);
        c
    }
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
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "spawn-smoke-ok");
    }
}
