// error.rs — error code contract at the core boundary.
//
// Until now errors travelled only as `Result<_, String>` strings — the UI could not tell
// "not installed" apart from a "crash". The core now attaches a code, and at the IPC boundary
// it is serialized as the `"<code>: <message>"` string so existing consumers keep working.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreCode {
    /// Executable not found — not installed or missing from PATH.
    SpawnNotFound,
    /// Found but failed to start.
    SpawnFailed,
    /// No response within the time limit.
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

/// Typed core error.
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

    /// Classifies a spawn io error. NotFound almost always means "not on PATH".
    pub fn from_io(bin: &str, error: &std::io::Error) -> Self {
        let code = if error.kind() == std::io::ErrorKind::NotFound {
            CoreCode::SpawnNotFound
        } else {
            CoreCode::SpawnFailed
        };
        Self::new(code, format!("{bin} 기동 실패: {error}"))
    }

    /// IPC string representation — the frontend can branch on the prefix code.
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
        let e = CoreError::from_io(
            "claude",
            &std::io::Error::from(std::io::ErrorKind::NotFound),
        );
        assert_eq!(e.code(), CoreCode::SpawnNotFound);
    }
}
