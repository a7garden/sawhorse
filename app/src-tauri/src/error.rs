// error.rs — 코어 경계의 오류 코드 계약.
//
// 지금까지 오류가 `Result<_, String>` 문자열로만 다녔다 — UI는 "미설치"와
// "크래시"를 구분할 수 없었다. 코어는 코드를 붙여 오고, IPC 경계에서는
// `"<code>: <message>"` 문자열로 직렬화해 기존 소비자를 깨지 않는다.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCode {
    /// 실행 파일을 찾을 수 없다 — 미설치 또는 PATH 누락.
    SpawnNotFound,
    /// 찾았지만 기동에 실패했다.
    SpawnFailed,
    /// 시간 안에 응답이 없었다.
    Timeout,
}

impl CoreCode {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreCode::SpawnNotFound => "spawn_not_found",
            CoreCode::SpawnFailed => "spawn_failed",
            CoreCode::Timeout => "timeout",
        }
    }
}

impl fmt::Display for CoreCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 타입화된 코어 오류.
#[derive(Debug, Clone, thiserror::Error)]
#[error("{code}: {message}")]
pub struct CoreError {
    code: CoreCode,
    message: String,
}

impl CoreError {
    pub fn new(code: CoreCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> CoreCode {
        self.code
    }

    /// 스폰 io 오류 분류. NotFound는 거의 항상 "PATH에 없다"다.
    pub fn from_io(bin: &str, error: &std::io::Error) -> Self {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            CoreCode::SpawnNotFound
        } else {
            CoreCode::SpawnFailed
        };
        Self::new(code, format!("{bin} 기동 실패: {error}"))
    }

    /// IPC 문자열 표현 — 프론트는 접두어 코드로 분기할 수 있다.
    pub fn to_ipc(&self) -> String {
        format!("{}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_string_carries_code_prefix() {
        let e = CoreError::new(CoreCode::SpawnNotFound, "claude 기동 실패");
        let s = e.to_ipc();
        assert!(s.starts_with("spawn_not_found: "), "{s}");
        assert!(s.contains("claude"), "{s}");
    }

    #[test]
    fn io_not_found_classifies_as_spawn_not_found() {
        let e = CoreError::from_io("claude", &std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(e.code(), CoreCode::SpawnNotFound);
    }
}
