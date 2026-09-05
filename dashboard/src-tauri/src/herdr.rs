// Thin wrapper over the `herdr` CLI, which talks to the running herdr server over
// its local socket. We shell out instead of speaking the socket protocol directly
// so Windows named pipes stay herdr's problem — its own socket-api docs recommend
// the CLI wrappers for cross-platform callers.
//
// Every control command answers with `{"result": ...}` on stdout; failures print
// `{"error":{"code","message"}}` on stderr with exit status 1 (status 2 = syntax).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::config::HerdrCfg;

/// Control calls are server round-trips; they should never hang a job.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HerdrError {
    pub code: String,
    pub message: String,
}

impl HerdrError {
    fn local(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

impl std::fmt::Display for HerdrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

pub type HerdrResult<T> = Result<T, HerdrError>;

/// The slice of herdr's `AgentInfo` the dashboard acts on.
#[derive(Debug, Clone, Default)]
pub struct AgentInfo {
    /// agent kind label ("claude"), None when the pane holds no agent
    pub agent: Option<String>,
    /// idle | working | blocked | done | unknown
    pub status: String,
    /// session id or transcript path, reported only when herdr's claude
    /// integration is installed (`herdr integration install claude`)
    pub session_ref: Option<(String, String)>,
}

impl AgentInfo {
    fn from_value(v: &Value) -> Self {
        let session_ref = v.get("agent_session").and_then(|a| {
            let kind = a.get("kind").and_then(Value::as_str)?;
            let value = a.get("value").and_then(Value::as_str)?;
            Some((kind.to_string(), value.to_string()))
        });
        Self {
            agent: v.get("agent").and_then(Value::as_str).map(str::to_string),
            status: v.get("agent_status").and_then(Value::as_str).unwrap_or("unknown").to_string(),
            session_ref,
        }
    }

    /// True when this agent is demonstrably not the session we think it is.
    /// Only conclusive when herdr's claude integration reported a session ref.
    pub fn contradicts_session(&self, session_id: &str) -> bool {
        match &self.session_ref {
            Some((kind, value)) if kind == "id" => value != session_id,
            Some((kind, value)) if kind == "path" => !value.contains(session_id),
            _ => false,
        }
    }

    pub fn settled(&self) -> bool {
        matches!(self.status.as_str(), "idle" | "done")
    }

    pub fn blocked(&self) -> bool {
        self.status == "blocked"
    }
}

/// A freshly created tab and its root pane.
#[derive(Debug, Clone)]
pub struct NewTab {
    pub tab_id: String,
    pub pane_id: String,
}

#[derive(Clone)]
pub struct Herdr {
    cfg: HerdrCfg,
}

fn spawn_command(bin: &str, args: &[&str]) -> tokio::process::Command {
    let mut c;
    #[cfg(windows)]
    {
        c = tokio::process::Command::new("cmd");
        c.arg("/c").arg(bin);
    }
    #[cfg(not(windows))]
    {
        c = tokio::process::Command::new(bin);
    }
    c.args(args);
    c
}

impl Herdr {
    pub fn new(cfg: &HerdrCfg) -> Self {
        Self { cfg: cfg.sanitized() }
    }

    pub fn cfg(&self) -> &HerdrCfg {
        &self.cfg
    }

    /// Run one herdr command and return its `.result` payload.
    ///
    /// The named session is selected through `HERDR_SESSION` rather than a flag:
    /// herdr resolves the socket from that variable, and it is position-independent
    /// across subcommands.
    pub async fn call_with_timeout(&self, args: &[&str], timeout: Duration) -> HerdrResult<Value> {
        let mut cmd = spawn_command(&self.cfg.bin, args);
        if !self.cfg.session.trim().is_empty() {
            cmd.env("HERDR_SESSION", self.cfg.session.trim());
        }
        cmd.stdin(std::process::Stdio::null());
        let out = match tokio::time::timeout(timeout, cmd.output()).await {
            Err(_) => {
                return Err(HerdrError::local(
                    "timeout",
                    format!("herdr {} 응답이 없습니다", args.first().unwrap_or(&"")),
                ))
            }
            Ok(Err(e)) => {
                return Err(HerdrError::local("spawn_failed", format!("herdr 실행 실패: {e}")))
            }
            Ok(Ok(o)) => o,
        };
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            let parsed: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
            return Ok(parsed.get("result").cloned().unwrap_or(parsed));
        }
        let err_text = String::from_utf8_lossy(&out.stderr);
        let parsed: Value = serde_json::from_str(err_text.trim()).unwrap_or(Value::Null);
        let code = parsed.pointer("/error/code").and_then(Value::as_str).unwrap_or("herdr_failed");
        let message = parsed
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                let t = err_text.trim();
                if t.is_empty() { "herdr 명령이 실패했습니다".into() } else { t.to_string() }
            });
        Err(HerdrError { code: code.to_string(), message })
    }

    pub async fn call(&self, args: &[&str]) -> HerdrResult<Value> {
        self.call_with_timeout(args, CALL_TIMEOUT).await
    }

    /// `herdr --version` prints "herdr X.Y.Z" as plain text, not JSON.
    pub async fn version(&self) -> Option<String> {
        let mut cmd = spawn_command(&self.cfg.bin, &["--version"]);
        cmd.stdin(std::process::Stdio::null());
        let out = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await.ok()?.ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }

    /// True when a herdr server is reachable — the cheapest command that proves it.
    pub async fn reachable(&self) -> bool {
        self.call_with_timeout(&["workspace", "list"], Duration::from_secs(5)).await.is_ok()
    }

    // ---------- layout ----------

    pub async fn workspace_exists(&self, id: &str) -> bool {
        self.call(&["workspace", "get", id]).await.is_ok()
    }

    /// Existing workspace carrying `label`, if any. Lets a reinstalled dashboard
    /// adopt the workspace it used before instead of stacking up duplicates.
    pub async fn find_workspace_by_label(&self, label: &str) -> Option<String> {
        let v = self.call(&["workspace", "list"]).await.ok()?;
        let list = v.get("workspaces")?.as_array()?;
        list.iter()
            .find(|w| w.get("label").and_then(Value::as_str) == Some(label))
            .and_then(|w| w.get("workspace_id").and_then(Value::as_str))
            .map(str::to_string)
    }

    pub async fn create_workspace(&self, label: &str) -> HerdrResult<String> {
        let v = self
            .call(&["workspace", "create", "--label", label, "--no-focus"])
            .await?;
        v.pointer("/workspace/workspace_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| HerdrError::local("bad_response", "workspace create 응답에 id가 없습니다"))
    }

    /// A tab per job: label it with the job so herdr's tab strip doubles as the queue.
    ///
    /// The pane inherits the herdr server's environment. If that server was itself
    /// started from inside a Claude Code session, `CLAUDE_CODE_CHILD_SESSION` comes
    /// along and the agent writes no transcript at all — which is exactly what the
    /// runner reads progress from. Clear it for our panes.
    pub async fn create_tab(&self, workspace: &str, label: &str, cwd: &str) -> HerdrResult<NewTab> {
        let v = self
            .call(&[
                "tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label,
                "--env", "CLAUDE_CODE_CHILD_SESSION=", "--no-focus",
            ])
            .await?;
        let tab_id = v
            .pointer("/tab/tab_id")
            .and_then(Value::as_str)
            .ok_or_else(|| HerdrError::local("bad_response", "tab create 응답에 tab_id가 없습니다"))?;
        let pane_id = v
            .pointer("/root_pane/pane_id")
            .and_then(Value::as_str)
            .ok_or_else(|| HerdrError::local("bad_response", "tab create 응답에 pane_id가 없습니다"))?;
        Ok(NewTab { tab_id: tab_id.to_string(), pane_id: pane_id.to_string() })
    }

    pub async fn close_tab(&self, tab_id: &str) -> HerdrResult<Value> {
        self.call(&["tab", "close", tab_id]).await
    }

    pub async fn focus_tab(&self, tab_id: &str) -> HerdrResult<Value> {
        self.call(&["tab", "focus", tab_id]).await
    }

    // ---------- agents ----------

    /// Start a supported agent in an existing shell pane.
    ///
    /// `extra` is passed through after `--` as argv, so no shell quoting is involved.
    pub async fn agent_start(
        &self,
        name: &str,
        kind: &str,
        pane_id: &str,
        timeout_ms: u64,
        extra: &[String],
    ) -> HerdrResult<Value> {
        let ms = timeout_ms.to_string();
        let mut args: Vec<&str> =
            vec!["agent", "start", name, "--kind", kind, "--pane", pane_id, "--timeout", &ms];
        if !extra.is_empty() {
            args.push("--");
            args.extend(extra.iter().map(String::as_str));
        }
        // agent start blocks until herdr sees the agent; give it the caller's budget.
        self.call_with_timeout(&args, Duration::from_millis(timeout_ms + 15_000)).await
    }

    /// `target` is a live agent name or the pane id currently hosting it.
    pub async fn agent_get(&self, target: &str) -> HerdrResult<AgentInfo> {
        let v = self.call(&["agent", "get", target]).await?;
        let node = v.get("agent").unwrap_or(&v);
        Ok(AgentInfo::from_value(node))
    }

    pub async fn agent_send_keys(&self, target: &str, keys: &[&str]) -> HerdrResult<Value> {
        let mut args: Vec<&str> = vec!["agent", "send-keys", target];
        args.extend_from_slice(keys);
        self.call(&args).await
    }

    pub async fn agent_focus(&self, target: &str) -> HerdrResult<Value> {
        self.call(&["agent", "focus", target]).await
    }

    // ---------- 터미널 화면용 조회 ----------

    /// herdr 가 보는 세계 전체. 실패는 오류가 아니라 `available: false` 다 —
    /// herdr 없이도 앱은 돌아가야 하고, 화면은 설치 안내로 바뀐다.
    pub async fn snapshot(&self) -> HerdrSnapshot {
        let mut snap = HerdrSnapshot { session: self.cfg.session.clone(), ..Default::default() };
        match self.call(&["workspace", "list"]).await {
            Ok(v) => {
                snap.available = true;
                snap.workspaces = parse_list(&v, "workspaces");
            }
            Err(e) => {
                snap.error = Some(e.to_string());
                return snap;
            }
        }
        if let Ok(v) = self.call(&["tab", "list"]).await {
            snap.tabs = parse_list(&v, "tabs");
        }
        if let Ok(v) = self.call(&["agent", "list"]).await {
            snap.agents = parse_list(&v, "agents");
        }
        snap
    }

    pub async fn focus_workspace(&self, id: &str) -> HerdrResult<Value> {
        self.call(&["workspace", "focus", id]).await
    }

    pub async fn focus_pane(&self, pane_id: &str) -> HerdrResult<Value> {
        self.call(&["pane", "focus", pane_id]).await
    }

    /// 사람이 직접 쓸 빈 탭. 잡 탭과 달리 에이전트를 자동으로 띄우지 않는다.
    pub async fn open_shell_tab(&self, workspace: &str, label: &str, cwd: &str) -> HerdrResult<NewTab> {
        self.call(&[
            "tab", "create", "--workspace", workspace, "--cwd", cwd, "--label", label,
        ])
        .await
        .and_then(|v| {
            let tab_id = v
                .pointer("/tab/tab_id")
                .and_then(Value::as_str)
                .ok_or_else(|| HerdrError::local("bad_response", "tab create 응답에 tab_id가 없습니다"))?;
            let pane_id = v
                .pointer("/root_pane/pane_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(NewTab { tab_id: tab_id.to_string(), pane_id: pane_id.to_string() })
        })
    }

    // ---------- misc ----------

    pub async fn notify(&self, title: &str, body: &str) {
        if !self.cfg.notify {
            return;
        }
        let _ = self
            .call_with_timeout(
                &["notification", "show", title, "--body", body, "--sound", "request"],
                Duration::from_secs(5),
            )
            .await;
    }
}

// ---------- 조회 결과 타입 ----------
//
// herdr 의 소켓 응답은 snake_case 이고 프론트엔드 계약은 camelCase 라, 한쪽만 rename 한다.
// 모르는 필드는 무시하고 없는 필드는 기본값 — herdr 가 필드를 늘려도 화면이 깨지지 않는다.

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct HerdrWorkspace {
    #[serde(rename(serialize = "workspaceId"))]
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub focused: bool,
    #[serde(rename(serialize = "tabCount"))]
    pub tab_count: u32,
    #[serde(rename(serialize = "paneCount"))]
    pub pane_count: u32,
    #[serde(rename(serialize = "agentStatus"))]
    pub agent_status: String,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct HerdrTab {
    #[serde(rename(serialize = "tabId"))]
    pub tab_id: String,
    #[serde(rename(serialize = "workspaceId"))]
    pub workspace_id: String,
    pub label: String,
    pub number: u32,
    pub focused: bool,
    #[serde(rename(serialize = "paneCount"))]
    pub pane_count: u32,
    #[serde(rename(serialize = "agentStatus"))]
    pub agent_status: String,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct HerdrAgentRow {
    #[serde(rename(serialize = "paneId"))]
    pub pane_id: String,
    #[serde(rename(serialize = "tabId"))]
    pub tab_id: String,
    #[serde(rename(serialize = "workspaceId"))]
    pub workspace_id: String,
    pub name: String,
    pub agent: String,
    #[serde(rename(serialize = "agentStatus"))]
    pub agent_status: String,
    pub cwd: String,
    pub focused: bool,
    #[serde(rename(serialize = "terminalTitle"))]
    pub terminal_title: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HerdrSnapshot {
    pub available: bool,
    pub error: Option<String>,
    pub session: String,
    pub workspaces: Vec<HerdrWorkspace>,
    pub tabs: Vec<HerdrTab>,
    pub agents: Vec<HerdrAgentRow>,
}

fn parse_list<T: serde::de::DeserializeOwned>(v: &Value, key: &str) -> Vec<T> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| serde_json::from_value(x.clone()).ok()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_rows_parse_from_real_socket_shapes() {
        let ws: Vec<HerdrWorkspace> = parse_list(
            &serde_json::json!({"workspaces": [
                {"active_tab_id":"w1:t1","agent_status":"working","focused":true,
                 "label":"sawhorse","number":1,"pane_count":3,"tab_count":1,"workspace_id":"w1"}]}),
            "workspaces",
        );
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].workspace_id, "w1");
        assert_eq!(ws[0].label, "sawhorse");
        assert_eq!(ws[0].agent_status, "working");
        // 프론트엔드 계약은 camelCase
        let json = serde_json::to_string(&ws[0]).unwrap();
        assert!(json.contains("\"workspaceId\""), "{json}");

        let agents: Vec<HerdrAgentRow> = parse_list(
            &serde_json::json!({"agents": [
                {"pane_id":"w1:p1","tab_id":"w1:t1","workspace_id":"w1","agent":"claude",
                 "agent_status":"blocked","cwd":"/x","terminal_title":"작업 중","unknown_field":1}]}),
            "agents",
        );
        assert_eq!(agents[0].agent_status, "blocked");
        assert_eq!(agents[0].cwd, "/x");

        // 모양이 다르면 빈 목록 (오류 아님)
        let none: Vec<HerdrTab> = parse_list(&serde_json::json!({"tabs": "nope"}), "tabs");
        assert!(none.is_empty());
    }

    #[test]
    fn agent_info_reads_status_and_session() {
        let v = serde_json::json!({
            "pane_id": "w1:p2", "tab_id": "w1:t2", "workspace_id": "w1",
            "agent": "claude", "agent_status": "blocked", "name": "sw-abc123",
            "agent_session": {"source": "claude", "agent": "claude",
                               "kind": "path", "value": "/tmp/x.jsonl"}
        });
        let a = AgentInfo::from_value(&v);
        assert_eq!(a.agent.as_deref(), Some("claude"));
        assert!(a.blocked());
        assert!(!a.settled());
        assert_eq!(a.session_ref, Some(("path".into(), "/tmp/x.jsonl".into())));
        assert!(!a.contradicts_session("x"), "path /tmp/x.jsonl contains the id");
        assert!(a.contradicts_session("other-session"));
    }

    #[test]
    fn agent_info_defaults_to_unknown() {
        let a = AgentInfo::from_value(&serde_json::json!({"pane_id": "w1:p1"}));
        assert_eq!(a.status, "unknown");
        assert!(a.agent.is_none());
        assert!(!a.settled());
        // no session ref means "cannot tell", never "wrong session"
        assert!(!a.contradicts_session("anything"));
    }
}
