// skills_market.rs — 스킬 마켓플레이스: skills.sh 검색 + `npx skills` CLI 연동.
//
// 스킬 마켓플레이스는 우리가 소유한 레지스트리가 아니라 공개 생태계다. 목록은
// skills.sh 디렉터리가 들고 있고, 설치·업데이트는 `npx skills` CLI 가 에이전트별
// 폴더 규약(심링크·잠금)을 알아서 처리한다. 앱은 두 가지만 한다: 검색 프록시와
// 비대화형 실행(-y). 설치 산출물의 상태는 열람 화면(list_agent_skills)이 다시 읽는다.

use serde::Serialize;

const SEARCH_URL: &str = "https://skills.sh/api/search";

/// skills.sh 검색 결과 한 줄. 설치 명령의 재료는 `source`(owner/repo)와 `skill_id`다.
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
    let rows = value
        .get("skills")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(rows
        .iter()
        .filter_map(|s| {
            Some(MarketSkill {
                id: s.get("id")?.as_str()?.to_string(),
                skill_id: text_of(s, "skillId"),
                name: text_of(s, "name"),
                source: text_of(s, "source"),
                installs: s.get("installs").and_then(serde_json::Value::as_u64).unwrap_or(0),
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

/// 설치 소스는 GitHub `owner/repo` 만 받는다 — CLI 인자로 들어가는 값이므로
/// 형식을 좁혀 임의 플래그·경로 주입을 막는다.
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

/// 앱 내부 에이전트 id → skills CLI 의 에이전트 키.
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
        // ESC [ … 종료문자(@-~) 시퀀스를 통째로 삼킨다.
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

/// `npx skills add <owner/repo> -g -y [-s skill] -a <agents>` — 전역 설치.
/// 스킬을 지정하지 않으면 저장소의 스킬 전부가 설치된다.
#[tauri::command]
pub async fn skills_market_install(
    source: String,
    skill: Option<String>,
    agents: Vec<String>,
) -> Result<String, String> {
    let source = source.trim().to_string();
    if !valid_repo(&source) {
        return Err("설치 소스는 owner/repo 형식이어야 합니다".into());
    }
    let mut keys: Vec<&'static str> = Vec::new();
    for agent in &agents {
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
    let mut args: Vec<String> = vec![source, "-g".into(), "-y".into()];
    if let Some(name) = skill.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if !valid_skill_name(name) {
            return Err(format!("잘못된 스킬 이름입니다: {name}"));
        }
        args.push("--skill".into());
        args.push(name.into());
    }
    for key in keys {
        args.push("--agent".into());
        args.push(key.into());
    }
    let mut refs: Vec<&str> = vec!["add"];
    refs.extend(args.iter().map(String::as_str));
    run_npx_skills(&refs).await
}

/// `npx skills update -g -y` — 전역으로 설치된 마켓플레이스 스킬 전부 업데이트.
#[tauri::command]
pub async fn skills_market_update() -> Result<String, String> {
    run_npx_skills(&["update", "-g", "-y"]).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
