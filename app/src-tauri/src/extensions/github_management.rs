//! Management UI for the installed GitHub extension. Credentials stay in the broker/keychain.
use super::broker::{secrets, ExtensionContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const ACCESS_TOKEN_SECRET: &str = "github.oauth";
const OAUTH_CLIENT_ID_ENV: &str = "SAWHORSE_GITHUB_CLIENT_ID";
// Public identifier for the SawHorse OAuth App; no client secret is bundled.
const DEFAULT_OAUTH_CLIENT_ID: &str = "Ov23liM5WPQSOkUOrOmd";
const OAUTH_SCOPE: &str = "read:user repo";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const VERIFICATION_URL: &str = "https://github.com/login/device";

#[derive(Clone)]
struct PendingOAuth {
    device_code: String,
    expires_at: Instant,
    next_poll_at: Instant,
    interval: Duration,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
    error: String,
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    refresh_token: String,
    expires_in: Option<u64>,
    #[serde(default)]
    error: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOAuthCredential {
    access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<u64>,
}

fn pending_oauth() -> &'static Mutex<HashMap<String, PendingOAuth>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingOAuth>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn now_epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn oauth_client_id() -> Result<String, String> {
    let value = std::env::var(OAUTH_CLIENT_ID_ENV)
        .ok()
        .or_else(|| option_env!("SAWHORSE_GITHUB_CLIENT_ID").map(str::to_string))
        .unwrap_or_else(|| DEFAULT_OAUTH_CLIENT_ID.to_string());
    let value = value.trim();
    if value.is_empty() {
        return Err(format!(
            "GitHub OAuth Client ID가 설정되지 않았습니다. {OAUTH_CLIENT_ID_ENV}를 설정하고 앱을 다시 빌드하거나 실행하세요."
        ));
    }
    if value.len() > 128
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("GitHub OAuth Client ID 형식이 올바르지 않습니다.".into());
    }
    Ok(value.to_string())
}

fn oauth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

fn parse_stored_credential(raw: &str) -> Result<StoredOAuthCredential, String> {
    if !raw.trim_start().starts_with('{') {
        // PAT로 연결했던 이전 버전의 자격 증명도 연결 해제 전까지 계속 읽는다.
        return Ok(StoredOAuthCredential {
            access_token: raw.to_string(),
            refresh_token: None,
            expires_at: None,
        });
    }
    serde_json::from_str(raw).map_err(|_| "저장된 GitHub OAuth 자격 증명이 손상되었습니다.".into())
}

fn store_credential(token: &TokenResponse) -> Result<(), String> {
    if token.access_token.is_empty() || token.access_token.chars().any(char::is_whitespace) {
        return Err("GitHub가 유효한 OAuth 액세스 토큰을 반환하지 않았습니다.".into());
    }
    let credential = StoredOAuthCredential {
        access_token: token.access_token.clone(),
        refresh_token: (!token.refresh_token.is_empty()).then(|| token.refresh_token.clone()),
        expires_at: token
            .expires_in
            .map(|seconds| now_epoch_seconds().saturating_add(seconds)),
    };
    let serialized = serde_json::to_string(&credential).map_err(|e| e.to_string())?;
    secrets::write(ACCESS_TOKEN_SECRET, &serialized)
}

fn oauth_error_message(error: &str) -> &'static str {
    match error {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        "expired_token" | "token_expired" => {
            "GitHub 로그인 코드가 만료되었습니다. 다시 시도하세요."
        }
        "access_denied" => "GitHub 로그인이 취소되었습니다.",
        "device_flow_disabled" => "GitHub OAuth 앱에서 Device Flow를 활성화하세요.",
        "incorrect_client_credentials" => "GitHub OAuth Client ID를 확인하세요.",
        "incorrect_device_code" => "GitHub 로그인 코드가 올바르지 않습니다. 다시 시도하세요.",
        _ => "GitHub OAuth 로그인을 완료하지 못했습니다.",
    }
}

fn require_enabled() -> Result<(), String> {
    let list = crate::commands::extensions_list()?;
    if list["bundles"].as_array().is_some_and(|items| {
        items
            .iter()
            .any(|b| b["manifest"]["id"] == "github" && b["enabled"] == true)
    }) {
        Ok(())
    } else {
        Err("GitHub 확장을 설치하고 사용 설정을 켜세요.".into())
    }
}
fn context() -> ExtensionContext {
    ExtensionContext {
        instance_id: "github-management".into(),
        granted_domains: vec!["api.github.com".into()],
        capabilities: vec!["secret_use".into()],
    }
}
async fn get(path: &str) -> Result<Value, String> {
    require_enabled()?;
    let response = context()
        .guarded_get_authorized(
            &format!("https://api.github.com{path}"),
            ACCESS_TOKEN_SECRET,
            "application/vnd.github+json",
        )
        .await?;
    if response.status != 200 {
        return Err(format!(
            "GitHub 응답 {}. 계정 연결과 저장소 접근 권한을 확인하세요.",
            response.status
        ));
    }
    serde_json::from_slice(&response.body).map_err(|e| e.to_string())
}
fn account(value: &Value) -> Value {
    json!({ "login": value["login"], "name": value["name"] })
}

#[tauri::command]
pub async fn github_account() -> Result<Value, String> {
    require_enabled()?;
    if secrets::read(ACCESS_TOKEN_SECRET).is_err() {
        return Ok(Value::Null);
    }
    Ok(account(&get("/user").await?))
}

#[tauri::command]
pub async fn github_oauth_start() -> Result<Value, String> {
    require_enabled()?;
    let client_id = oauth_client_id()?;
    let response = oauth_client()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "sawhorse-dashboard")
        .form(&[("client_id", client_id.as_str()), ("scope", OAUTH_SCOPE)])
        .send()
        .await
        .map_err(|_| "GitHub OAuth에 연결할 수 없습니다.")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub OAuth 시작 요청이 실패했습니다({}).",
            response.status()
        ));
    }
    let device: DeviceCodeResponse = response
        .json()
        .await
        .map_err(|_| "GitHub OAuth 시작 응답을 읽지 못했습니다.")?;
    if !device.error.is_empty() {
        return Err(oauth_error_message(&device.error).into());
    }
    if device.device_code.is_empty()
        || device.user_code.is_empty()
        || device.verification_uri != VERIFICATION_URL
        || !(1..=3600).contains(&device.expires_in)
        || !(1..=60).contains(&device.interval)
    {
        return Err("GitHub OAuth 시작 응답이 올바르지 않습니다.".into());
    }
    let flow_id = uuid::Uuid::new_v4().to_string();
    let now = Instant::now();
    let interval = Duration::from_secs(device.interval);
    let mut pending = pending_oauth()
        .lock()
        .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?;
    pending.retain(|_, flow| flow.expires_at > now);
    if pending.len() >= 4 {
        return Err("진행 중인 GitHub 로그인이 너무 많습니다. 잠시 후 다시 시도하세요.".into());
    }
    pending.insert(
        flow_id.clone(),
        PendingOAuth {
            device_code: device.device_code,
            expires_at: now + Duration::from_secs(device.expires_in),
            next_poll_at: now + interval,
            interval,
        },
    );
    Ok(json!({
        "flowId": flow_id,
        "userCode": device.user_code,
        "verificationUri": device.verification_uri,
        "expiresIn": device.expires_in,
        "interval": device.interval,
    }))
}

#[tauri::command]
pub async fn github_oauth_poll(flow_id: String) -> Result<Value, String> {
    require_enabled()?;
    let client_id = oauth_client_id()?;
    let now = Instant::now();
    let flow = {
        let mut pending = pending_oauth()
            .lock()
            .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?;
        pending.retain(|_, flow| flow.expires_at > now);
        let flow = pending
            .get_mut(&flow_id)
            .ok_or("GitHub 로그인 요청이 없거나 만료되었습니다. 다시 시도하세요.")?;
        if now < flow.next_poll_at {
            let retry_after = flow.next_poll_at.duration_since(now).as_secs().max(1);
            return Ok(json!({ "status": "pending", "retryAfter": retry_after }));
        }
        flow.next_poll_at = now + flow.interval;
        flow.clone()
    };
    let response = oauth_client()?
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "sawhorse-dashboard")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", flow.device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|_| "GitHub OAuth 승인 상태를 확인할 수 없습니다.")?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub OAuth 승인 확인이 실패했습니다({}).",
            response.status()
        ));
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "GitHub OAuth 승인 응답을 읽지 못했습니다.")?;
    if token.error == "authorization_pending" {
        return Ok(json!({
            "status": "pending",
            "retryAfter": flow.interval.as_secs(),
        }));
    }
    if token.error == "slow_down" {
        let retry_after = {
            let mut pending = pending_oauth()
                .lock()
                .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?;
            let flow = pending
                .get_mut(&flow_id)
                .ok_or("GitHub 로그인 요청이 만료되었습니다. 다시 시도하세요.")?;
            flow.interval += Duration::from_secs(5);
            flow.next_poll_at = Instant::now() + flow.interval;
            flow.interval.as_secs()
        };
        return Ok(json!({ "status": "pending", "retryAfter": retry_after }));
    }
    if !token.error.is_empty() {
        pending_oauth()
            .lock()
            .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?
            .remove(&flow_id);
        return Err(oauth_error_message(&token.error).into());
    }
    // 새 토큰으로 계정을 다시 확인한 뒤에만 기존 자격 증명을 교체한다.
    let account_response = oauth_client()?
        .get("https://api.github.com/user")
        .bearer_auth(&token.access_token)
        .header("User-Agent", "sawhorse-dashboard")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "GitHub에 연결할 수 없습니다.")?;
    if account_response.status() != 200 {
        return Err("OAuth 토큰으로 GitHub 계정을 확인하지 못했습니다.".into());
    }
    let value: Value = account_response
        .json()
        .await
        .map_err(|_| "계정 응답을 읽지 못했습니다.")?;
    if value["login"].as_str().is_none_or(str::is_empty) {
        return Err("GitHub 계정 응답에 로그인 정보가 없습니다.".into());
    }
    store_credential(&token)?;
    pending_oauth()
        .lock()
        .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?
        .remove(&flow_id);
    Ok(json!({ "status": "complete", "account": account(&value) }))
}

#[tauri::command]
pub fn github_oauth_cancel(flow_id: String) -> Result<(), String> {
    pending_oauth()
        .lock()
        .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?
        .remove(&flow_id);
    Ok(())
}

#[tauri::command]
pub fn github_disconnect() -> Result<(), String> {
    pending_oauth()
        .lock()
        .map_err(|_| "GitHub OAuth 상태 잠금에 실패했습니다.")?
        .clear();
    secrets::delete(ACCESS_TOKEN_SECRET)
}

/// Broker와 Git clone이 쓰는 현재 액세스 토큰. OAuth App이 만료형 토큰을
/// 발급한 경우 Device Flow의 refresh token으로 사용자 개입 없이 갱신한다.
pub(crate) async fn oauth_access_token() -> Result<String, String> {
    let raw = secrets::read(ACCESS_TOKEN_SECRET)?;
    let credential = parse_stored_credential(&raw)?;
    let needs_refresh = credential
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_epoch_seconds().saturating_add(60));
    if !needs_refresh {
        return Ok(credential.access_token);
    }
    let _guard = refresh_lock().lock().await;
    // 다른 요청이 기다리는 동안 이미 갱신했을 수 있으므로 키체인을 다시 읽는다.
    let current = parse_stored_credential(&secrets::read(ACCESS_TOKEN_SECRET)?)?;
    if !current
        .expires_at
        .is_some_and(|expires_at| expires_at <= now_epoch_seconds().saturating_add(60))
    {
        return Ok(current.access_token);
    }
    let refresh_token = current
        .refresh_token
        .ok_or("GitHub OAuth 로그인이 만료되었습니다. 다시 로그인하세요.")?;
    let client_id = oauth_client_id()?;
    let response = oauth_client()?
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "sawhorse-dashboard")
        .form(&[
            ("client_id", client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "GitHub OAuth 토큰을 갱신할 수 없습니다.")?;
    if !response.status().is_success() {
        return Err("GitHub OAuth 로그인이 만료되었습니다. 다시 로그인하세요.".into());
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "GitHub OAuth 갱신 응답을 읽지 못했습니다.")?;
    if !token.error.is_empty() {
        return Err("GitHub OAuth 로그인이 만료되었습니다. 다시 로그인하세요.".into());
    }
    store_credential(&token)?;
    Ok(token.access_token)
}

#[tauri::command]
pub async fn github_repositories(page: u32) -> Result<Value, String> {
    if !(1..=10000).contains(&page) {
        return Err("잘못된 페이지입니다.".into());
    }
    let rows = get(&format!(
        "/user/repos?per_page=50&page={page}&sort=updated&direction=desc"
    ))
    .await?;
    let rows = rows
        .as_array()
        .ok_or("저장소 목록 응답을 읽지 못했습니다.")?;
    let repositories: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r["id"].to_string(), "name": r["name"], "fullName": r["full_name"],
                "description": r["description"], "private": r["private"], "archived": r["archived"],
                "language": r["language"], "updatedAt": r["updated_at"]
            })
        })
        .collect();
    Ok(json!({ "repositories": repositories, "hasMore": rows.len() == 50 }))
}
fn repository_name(value: &str) -> Result<(), String> {
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || *p == "."
                || *p == ".."
                || p.starts_with('-')
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("저장소 이름은 소유자/저장소 형식이어야 합니다.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn github_clone_project(
    repository: String,
    parent_path: String,
) -> Result<crate::sdlc::Project, String> {
    require_enabled()?;
    repository_name(&repository)?;
    let snapshot = crate::sdlc::sdd_snapshot()?;
    if !snapshot.initialized {
        return Err("프로젝트를 가져오기 전에 작업공간을 초기화하세요.".into());
    }
    let parent = Path::new(&parent_path)
        .canonicalize()
        .map_err(|_| "저장할 폴더를 선택하세요.")?;
    if !parent.is_dir() {
        return Err("저장 위치는 폴더여야 합니다.".into());
    }
    let metadata = get(&format!("/repos/{repository}")).await?;
    let target = parent.join(repository.split('/').nth(1).unwrap());
    if target.exists() {
        return Err("같은 이름의 폴더가 있습니다. 다른 저장 위치를 선택하거나 기존 폴더를 프로젝트에 연결하세요.".into());
    }
    let stage = parent.join(format!(".sawhorse-import-{}", uuid::Uuid::new_v4()));
    use base64::Engine;
    let token = oauth_access_token().await?;
    std::fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let authorization =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    // Environment-only credentials: never written to .git/config, command arguments or logs.
    let mut command = crate::spawn::no_window_async(tokio::process::Command::new("git"));
    command
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "http.followRedirects=false",
            "clone",
            "--",
            &format!("https://github.com/{repository}.git"),
        ])
        .arg(&stage)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("Authorization: Basic {authorization}"),
        )
        .kill_on_drop(true);
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&stage);
            return Err("Git을 실행하지 못했습니다. Git 설치를 확인하세요.".into());
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(180), child.wait()).await;
    match result {
        Ok(Ok(status)) if status.success() => {}
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = std::fs::remove_dir_all(&stage);
            return Err(
                "저장소를 가져오지 못했습니다. 네트워크와 Contents 읽기 권한을 확인하세요.".into(),
            );
        }
    }
    // Reserve destination, preventing a race from replacing a folder created during clone.
    if let Err(e) = std::fs::create_dir(&target) {
        let _ = std::fs::remove_dir_all(&stage);
        return Err(format!("저장 폴더 생성 실패: {e}"));
    }
    if let Err(e) = std::fs::rename(&stage, &target) {
        return Err(format!(
            "가져온 폴더 이동 실패: {e}. 임시 위치: {}",
            stage.display()
        ));
    }
    let project = crate::sdlc::Project {
        id: format!(
            "github-{}-{}",
            metadata["id"],
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ),
        name: repository.split('/').nth(1).unwrap().into(),
        description: metadata["description"].as_str().unwrap_or("").into(),
        repo_path: target.to_string_lossy().into(),
        ..Default::default()
    };
    crate::sdlc::sdd_save_project(project).map_err(|e| {
        format!(
            "저장소는 {}에 가져왔지만 프로젝트 등록에 실패했습니다: {e}",
            target.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_credentials_keep_legacy_pat_compatibility() {
        let credential = parse_stored_credential("ghp_legacy").unwrap();
        assert_eq!(credential.access_token, "ghp_legacy");
        assert!(credential.refresh_token.is_none());
        assert!(credential.expires_at.is_none());
    }

    #[test]
    fn stored_oauth_credentials_round_trip() {
        let credential = StoredOAuthCredential {
            access_token: "gho_access".into(),
            refresh_token: Some("ghr_refresh".into()),
            expires_at: Some(1234),
        };
        let raw = serde_json::to_string(&credential).unwrap();
        let parsed = parse_stored_credential(&raw).unwrap();
        assert_eq!(parsed.access_token, "gho_access");
        assert_eq!(parsed.refresh_token.as_deref(), Some("ghr_refresh"));
        assert_eq!(parsed.expires_at, Some(1234));
    }

    #[test]
    fn oauth_errors_are_actionable() {
        assert_eq!(oauth_error_message("authorization_pending"), "pending");
        assert!(oauth_error_message("expired_token").contains("만료"));
        assert!(oauth_error_message("device_flow_disabled").contains("Device Flow"));
    }

    #[test]
    fn repository_names_cannot_inject_paths_or_git_options() {
        assert!(repository_name("octocat/Hello-World").is_ok());
        for bad in [
            "../repo",
            "owner/..",
            "--help",
            "owner/repo/extra",
            "owner/repo?token=x",
            "owner/repo\n",
        ] {
            assert!(repository_name(bad).is_err(), "{bad}");
        }
    }
}
