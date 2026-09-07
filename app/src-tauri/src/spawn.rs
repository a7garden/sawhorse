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
