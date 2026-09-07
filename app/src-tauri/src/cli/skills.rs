use super::{CliError, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const NAME: &str = "sawhorse-workflow-author";
pub const CONTENT: &str =
    include_str!("../../../../plugin/skills/sawhorse-workflow-author/SKILL.md");

pub fn install(agent: Option<&str>, directory: Option<&Path>, force: bool) -> Result<Value> {
    let base = if let Some(directory) = directory {
        directory.to_path_buf()
    } else {
        let home = dirs::home_dir().ok_or_else(|| {
            CliError::new(
                "home-unavailable",
                "Specify --dir for the agent's skills directory",
                1,
            )
        })?;
        match agent {
            Some("codex") => std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("skills"),
            Some("claude") => std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".claude"))
                .join("skills"),
            _ => {
                return Err(CliError::new(
                    "usage",
                    "Specify --agent codex, --agent claude, or --dir",
                    2,
                ))
            }
        }
    };
    let path = base.join(NAME).join("SKILL.md");
    let existing = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(CliError::new("skill-read-failed", e.to_string(), 1)),
    };
    if existing.as_deref() == Some(CONTENT.as_bytes()) {
        return Ok(json!({"path": path, "changed": false, "skill": NAME}));
    }
    if existing.is_some() && !force {
        return Err(CliError::new(
            "skill-conflict",
            "The installed skill differs. Review it before explicitly replacing it with --force.",
            4,
        ));
    }
    if path
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(CliError::new(
            "unsafe-path",
            "The skill file is a symbolic link",
            2,
        ));
    }
    crate::workspace_io::write_atomic(&path, CONTENT.as_bytes(), existing.is_some())
        .map_err(CliError::operation)?;
    Ok(json!({"path": path, "changed": true, "skill": NAME}))
}
