// skills_market.rs — skill marketplace: skills.sh search + `npx skills` CLI integration.
//
// The skill marketplace is a public ecosystem, not a registry we own. skills.sh holds the
// directory listing, and the `npx skills` CLI handles each agent's folder conventions
// (symlinks, lockfiles) on install/update. The app does only two things: a search proxy and
// non-interactive runs (-y). Installed output state is re-read by the browse screen (list_agent_skills).

use serde::Serialize;

const SEARCH_URL: &str = "https://skills.sh/api/search";

/// One skills.sh search result row. The install command is built from `source` (owner/repo) and `skill_id`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MarketSkill {
    pub id: String,
    pub skill_id: String,
    pub name: String,
    pub source: String,
    pub installs: u64,
}

#[tauri::command]
pub async fn skills_market_search(query: String) -> Result<Vec<MarketSkill>, String> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Err("검색어는 2자 이상이어야 합니다".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let value: serde_json::Value = client
        .get(SEARCH_URL)
        .query(&[("q", q)])
        .send()
        .await
        .map_err(|e| format!("skills.sh 요청 실패: {e}"))?
        .error_for_status()
        .map_err(|e| format!("skills.sh 응답 오류: {e}"))?
        .json()
        .await
        .map_err(|e| format!("skills.sh 응답 해석 실패: {e}"))?;
    parse_search_results(&value)
}

fn parse_search_results(value: &serde_json::Value) -> Result<Vec<MarketSkill>, String> {
    let rows = value
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .ok_or("skills.sh 응답에 skills 목록이 없습니다")?;
    let mut seen = std::collections::HashSet::new();
    Ok(rows
        .iter()
        .filter_map(|row| {
            let id = row.get("id")?.as_str()?;
            let skill_id = text_of(row, "skillId");
            let source = text_of(row, "source");
            // A missing skill id must never turn a single-card install into a whole-repo install.
            if id.is_empty()
                || !valid_repo(&source)
                || !valid_skill_name(&skill_id)
                || !seen.insert(id)
            {
                return None;
            }
            let name = text_of(row, "name");
            Some(MarketSkill {
                id: id.to_string(),
                name: if name.is_empty() {
                    skill_id.clone()
                } else {
                    name
                },
                skill_id,
                source,
                installs: row
                    .get("installs")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            })
        })
        .collect())
}

fn text_of(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Install sources accept only GitHub `owner/repo` — the value goes into CLI arguments, so the
/// narrow format blocks arbitrary flag/path injection.
fn valid_repo(source: &str) -> bool {
    let parts: Vec<&str> = source.split('/').collect();
    parts.len() == 2
        && parts.iter().all(|p| {
            !p.is_empty()
                && !p.starts_with('-')
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// App-internal agent id → skills CLI agent key.
fn cli_agent_key(agent: &str) -> Option<&'static str> {
    match agent {
        crate::agents::CLAUDE => Some("claude-code"),
        crate::agents::CODEX => Some("codex"),
        _ => None,
    }
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        // Swallow whole ESC [ … final-byte (@-~) sequences.
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

async fn run_npx_skills(args: &[&str]) -> Result<String, String> {
    let Some(npx) = crate::detect::resolve_any(&["npx"]) else {
        return Err(
            "npx 를 찾지 못했습니다 — Node.js 를 설치하면 스킬 마켓플레이스를 쓸 수 있습니다."
                .into(),
        );
    };
    let npx = npx.display().to_string();
    let mut all: Vec<&str> = vec!["-y", "skills"];
    all.extend_from_slice(args);
    let mut cmd = crate::spawn::platform_command_async(&npx, &all);
    cmd.stdin(std::process::Stdio::null());
    cmd.kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(300), cmd.output())
        .await
        .map_err(|_| "npx skills 실행이 5분을 넘겨 중단했습니다".to_string())?
        .map_err(|e| format!("npx skills 실행 실패: {e}"))?;
    let text = strip_ansi(
        format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim(),
    );
    if out.status.success() {
        Ok(text)
    } else if text.is_empty() {
        Err("npx skills 가 실패했습니다".into())
    } else {
        Err(text)
    }
}

/// `npx skills add <owner/repo> -g -y --skill <skill> --agent <agents>` — exact global install.
#[tauri::command]
pub async fn skills_market_install(
    source: String,
    skill: Option<String>,
    agents: Vec<String>,
) -> Result<String, String> {
    let args = install_args(&source, skill.as_deref(), &agents)?;
    run_npx_skills(&args.iter().map(String::as_str).collect::<Vec<_>>()).await
}

fn install_args(
    source: &str,
    skill: Option<&str>,
    agents: &[String],
) -> Result<Vec<String>, String> {
    let source = source.trim().to_string();
    if !valid_repo(&source) {
        return Err("설치 소스는 owner/repo 형식이어야 합니다".into());
    }
    let mut keys: Vec<&'static str> = Vec::new();
    for agent in agents {
        let Some(key) = cli_agent_key(agent) else {
            return Err(format!("{agent} 는 마켓플레이스 설치 대상이 아닙니다"));
        };
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    if keys.is_empty() {
        return Err("설치할 에이전트를 하나 이상 고르세요".into());
    }
    let mut args: Vec<String> = vec!["add".into(), source, "-g".into(), "-y".into()];
    let name = skill
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or("설치할 스킬을 선택하세요")?;
    if !valid_skill_name(name) {
        return Err(format!("잘못된 스킬 이름입니다: {name}"));
    }
    args.push("--skill".into());
    args.push(name.into());
    for key in keys {
        args.push("--agent".into());
        args.push(key.into());
    }
    Ok(args)
}

/// `npx skills update -g -y` — updates globally installed marketplace skills.
#[tauri::command]
pub async fn skills_market_update() -> Result<String, String> {
    run_npx_skills(&["update", "-g", "-y"]).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_requires_an_explicit_installable_skill_and_deduplicates() {
        let row = serde_json::json!({"id":"owner/repo/react", "skillId":"react", "source":"owner/repo", "name":"React", "installs":42});
        let parsed = parse_search_results(&serde_json::json!({"skills":[row.clone(), row,
            {"id":"missing", "source":"owner/repo"},
            {"id":"flag", "skillId":"--all", "source":"owner/repo"}
        ]}))
        .unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].skill_id, "react");
        assert_eq!(parsed[0].installs, 42);
        assert!(parse_search_results(&serde_json::json!({"error":"unavailable"})).is_err());
    }

    #[test]
    fn install_targets_exact_skill_and_selected_agents_globally() {
        assert_eq!(
            install_args(
                "owner/repo",
                Some("react"),
                &["claude".into(), "codex".into(), "claude".into()]
            )
            .unwrap(),
            vec![
                "add",
                "owner/repo",
                "-g",
                "-y",
                "--skill",
                "react",
                "--agent",
                "claude-code",
                "--agent",
                "codex"
            ]
        );
        assert!(install_args("owner/repo", None, &["codex".into()]).is_err());
        assert!(install_args("owner/repo", Some(""), &["codex".into()]).is_err());
        assert!(install_args("owner/repo", Some("--all"), &["codex".into()]).is_err());
        assert!(install_args("owner/repo", Some("react"), &[]).is_err());
        assert!(install_args("owner/repo", Some("react"), &["unsupported".into()]).is_err());
    }

    #[test]
    fn repo_validation_rejects_flag_injection() {
        assert!(valid_repo("vercel-labs/skills"));
        assert!(valid_repo("anthropics/skills"));
        assert!(!valid_repo("-g/skills"));
        assert!(!valid_repo("a/b/c"));
        assert!(!valid_repo("owner"));
        assert!(!valid_repo("owner/repo name"));
        assert!(!valid_repo("owner/--yes"));
    }

    #[test]
    fn skill_name_validation() {
        assert!(valid_skill_name("pdf"));
        assert!(valid_skill_name("react-pdf"));
        assert!(!valid_skill_name("--all"));
        assert!(!valid_skill_name(""));
        assert!(!valid_skill_name("a b"));
    }

    #[test]
    fn ansi_sequences_are_stripped() {
        assert_eq!(
            strip_ansi("\u{1b}[33mInvalid\u{1b}[0m agents"),
            "Invalid agents"
        );
    }
}
