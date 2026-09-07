//! Shared filesystem operations for the desktop and the CLI.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Component, Path},
};

/// Apply Windows filename restrictions on every host so definitions stay portable.
pub fn portable_component(value: &str) -> bool {
    if value.is_empty()
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
    {
        return false;
    }
    let stem = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !(stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// Reject aliases inside managed storage, including dangling links and Windows
/// junctions which resolve outside the workspace. The root itself may be an alias.
pub fn check_path(root: &Path, path: &Path) -> Result<(), String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("workspace-path: {e}"))?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "unsafe-path: outside workspace")?;
    let mut probe = root.to_path_buf();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            return Err("unsafe-path: invalid component".into());
        };
        probe.push(name);
        match fs::symlink_metadata(&probe) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!("unsafe-path: symbolic link: {}", probe.display()));
                }
                if !probe
                    .canonicalize()
                    .map_err(|e| format!("unsafe-path: {e}"))?
                    .starts_with(&canonical)
                {
                    return Err("unsafe-path: outside workspace".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("workspace-path: {e}")),
        }
    }
    Ok(())
}

/// OS advisory locks are released on process exit, including crashes. The lock
/// file is deliberately retained: deleting it would allow locking two inodes.
pub fn lock(root: &Path, name: &str) -> Result<File, String> {
    let path = root
        .join(".sawhorse")
        .join("locks")
        .join(format!("{name}.lock"));
    check_path(root, &path)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| format!("workspace-lock: {e}"))?;
    check_path(root, &path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("workspace-lock: {e}"))?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::WouldBlock
            || e.raw_os_error() == fs2::lock_contended_error().raw_os_error()
        {
            "workspace-busy: another Sawhorse process is writing; retry after it finishes".into()
        } else {
            format!("workspace-lock: {e}")
        }
    })?;
    Ok(file)
}

pub fn write_atomic(path: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("write-failed: {e}"))?;
    let mut temp =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("write-failed: {e}"))?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|e| format!("write-failed: {e}"))?;
    let result = if replace {
        temp.persist(path)
    } else {
        temp.persist_noclobber(path)
    };
    result
        .map(|_| ())
        .map_err(|e| format!("write-failed: {}: {}", path.display(), e.error))
}
