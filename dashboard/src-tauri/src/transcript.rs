// Claude Code session transcripts.
//
// A herdr-hosted job runs `claude` interactively, so there is no
// `--output-format stream-json` to read. Instead the dashboard mints the session
// UUID itself and passes it as `--session-id`, which makes the transcript path
// deterministic: <claude config dir>/projects/<encoded cwd>/<session-id>.jsonl.
// The cwd encoding is an implementation detail of Claude Code, so we locate the
// file by globbing the project directories for the (unique) session id instead.
//
// Transcript lines carry the same `{"type":"assistant","message":{"content":[…]}}`
// shape as stream-json, so the progress mapping is shared with jobs.rs.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

pub fn claude_home() -> PathBuf {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claude")
}

pub fn projects_dir() -> PathBuf {
    claude_home().join("projects")
}

/// Find `<session_id>.jsonl` under any project directory. Session ids are UUIDs,
/// so the first hit is the right one.
pub fn find_session_file(root: &Path, session_id: &str) -> Option<PathBuf> {
    let name = format!("{session_id}.jsonl");
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Append-only reader that hands back whole lines as the agent writes them.
pub struct Tailer {
    path: PathBuf,
    pos: u64,
    partial: String,
}

impl Tailer {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            pos: 0,
            partial: String::new(),
        }
    }

    /// Read every complete line written since the last call. A trailing fragment
    /// is buffered until its newline arrives, so half-written JSON is never parsed.
    pub fn read_new_lines(&mut self) -> Vec<String> {
        let Ok(mut f) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.pos {
            // truncated/replaced under us — start over rather than emit garbage
            self.pos = 0;
            self.partial.clear();
        }
        if len == self.pos {
            return Vec::new();
        }
        if f.seek(SeekFrom::Start(self.pos)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::new();
        if f.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.pos += buf.len() as u64;
        self.partial.push_str(&String::from_utf8_lossy(&buf));

        let ends_clean = self.partial.ends_with('\n');
        let mut parts: Vec<String> = self.partial.split('\n').map(str::to_string).collect();
        let tail = if ends_clean {
            String::new()
        } else {
            parts.pop().unwrap_or_default()
        };
        self.partial = tail;
        parts.into_iter().filter(|l| !l.trim().is_empty()).collect()
    }
}

/// Map one transcript line to progress entries, mirroring `jobs::map_stream_line`.
///
/// Transcripts hold no `result` record — the runner synthesizes one from the last
/// assistant text when the turn settles.
pub fn map_transcript_line(line: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let content = v.pointer("/message/content")?.as_array()?;
    let entries = crate::jobs::map_assistant_content(content);
    if entries.is_empty() {
        None
    } else {
        Some(Value::Array(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("swdash-tr-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_session_file_in_any_project_dir() {
        let root = temp_dir("find");
        let proj = root.join("-Users-me-work");
        std::fs::create_dir_all(&proj).unwrap();
        let id = "11111111-2222-3333-4444-555555555555";
        std::fs::write(proj.join(format!("{id}.jsonl")), "").unwrap();
        std::fs::write(proj.join("other.jsonl"), "").unwrap();

        assert_eq!(
            find_session_file(&root, id).unwrap(),
            proj.join(format!("{id}.jsonl"))
        );
        assert!(find_session_file(&root, "nope").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tailer_buffers_partial_lines() {
        let dir = temp_dir("tail");
        let path = dir.join("s.jsonl");
        std::fs::write(&path, "one\ntw").unwrap();
        let mut t = Tailer::new(path.clone());
        assert_eq!(t.read_new_lines(), vec!["one".to_string()]);
        assert!(t.read_new_lines().is_empty());

        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(f, "o\nthree").unwrap();
        assert_eq!(
            t.read_new_lines(),
            vec!["two".to_string(), "three".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn maps_assistant_lines_only() {
        let text =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"확인했습니다"}]}}"#;
        let mapped = map_transcript_line(text).unwrap();
        let arr = mapped.as_array().unwrap();
        assert_eq!(arr[0]["kind"], "text");
        assert_eq!(arr[0]["text"], "확인했습니다");

        let tool = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}"#;
        let arr = map_transcript_line(tool).unwrap();
        assert_eq!(arr[0]["kind"], "tool");
        assert_eq!(arr[0]["summary"], "git status");

        // thinking-only turns and user/tool-result lines produce nothing
        let thinking =
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"음"}]}}"#;
        assert!(map_transcript_line(thinking).is_none());
        assert!(map_transcript_line(r#"{"type":"user","message":{"content":[]}}"#).is_none());
        assert!(map_transcript_line("not json").is_none());
    }
}
