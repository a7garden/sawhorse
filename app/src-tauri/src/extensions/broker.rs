// 확장 브로커. 설계 661-675줄의 권한 규칙과 778-786줄의 SSRF 방어.
//
// - built-in handler도 raw DB·Git·HTTP client·token을 받지 않고 좁은 ExtensionContext만
//   받는다. credential broker가 승인된 account/repository 요청에만 Authorization을
//   붙이며 token 자체는 connector에 반환하지 않는다(설계 666-668줄).
// - 사용자 URL을 host 권한으로 가져오는 기능이므로 SSRF 방어를 필수로 한다(778-786줄).

use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

/// 도메인 grant 검사. 정확한 도메인 또는 `*.example.com` 와일드카드만 허용.
pub fn domain_allowed(granted: &[String], host: &str) -> bool {
    granted.iter().any(|g| {
        let g = g.trim();
        if let Some(suffix) = g.strip_prefix("*.") {
            host.ends_with(suffix) && host.len() > suffix.len()
        } else {
            g.eq_ignore_ascii_case(host)
        }
    })
}

/// URL 사전 검사(설계 780-781줄): scheme은 http/https만, credential/userinfo 포함 URL 거부.
pub fn validate_url_scheme(url: &str) -> Result<(String, String), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("scheme이 없는 URL: {url}"))?;
    if scheme != "http" && scheme != "https" {
        return Err(format!("허용하지 않는 scheme: {scheme}"));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("userinfo가 든 URL은 거부한다".into());
    }
    let host = authority.split(':').next().unwrap_or("");
    if host.is_empty() {
        return Err("host가 없다".into());
    }
    Ok((scheme.to_string(), host.to_string()))
}

/// DNS 해석 결과가 사설·루프백·링크로컬·멀티캐스트·클라우드 metadata 대역인지 차단
/// (설계 781-782줄). 해석된 모든 주소를 검사한다 — 하나라도 안전하면 안전으로 보지 않고
/// 하나라도 위험하면 거부한다.
pub fn resolved_ips_blocked(ips: &[IpAddr]) -> bool {
    ips.iter().any(|ip| is_blocked_ip(ip))
}

pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // loopback 127/8, 사설 10/8·172.16/12·192.168/16, link-local 169.254/16,
            // 이렇듯 예약 대역 0.0.0.0/8·100.64/10·192.0.0/24·198.18/15·240/4,
            // multicast 224/4, cloud metadata 169.254.169.254는 link-local에 포함.
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_multicast()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || o[0] == 0
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 192 && o[1] == 0 && o[2] == 0)
                || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
                || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                || v6
                    .to_ipv4_mapped()
                    .map_or(false, |v4| is_blocked_ip(&IpAddr::V4(v4)))
        }
    }
}

/// URL을 host 해석까지 검사한 뒤 요청 가능한 상태인지 판정한다.
pub fn ssrf_guard(url: &str, granted_domains: &[String]) -> Result<Vec<IpAddr>, String> {
    let (_scheme, host) = validate_url_scheme(url)?;
    if !domain_allowed(granted_domains, &host) {
        return Err(format!("도메인이 grant에 없다: {host}"));
    }
    // hostname literal(직접 IP)도 동일하게 차단한다.
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(&ip) {
            return Err(format!("차단 대상 주소: {ip}"));
        }
        return Ok(vec![ip]);
    }
    let addrs: Vec<IpAddr> = (host.as_str(), 0u16)
        .to_socket_addrs()
        .map_err(|e| format!("DNS 해석 실패: {e}"))?
        .map(|a| a.ip())
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS 해석 결과가 없다: {host}"));
    }
    if resolved_ips_blocked(&addrs) {
        return Err(format!("DNS 해석 결과에 차단 대상이 있다: {host}"));
    }
    Ok(addrs)
}

/// extension이 받는 좁은 문맥. HTTP client·토큰·DB 핸들은 노출하지 않는다(설계 666줄).
#[derive(Clone, Debug)]
pub struct ExtensionContext {
    pub instance_id: String,
    pub granted_domains: Vec<String>,
    pub capabilities: Vec<String>,
}

impl ExtensionContext {
    /// 권한 검사. capability는 기본 거부다(설계 663줄).
    pub fn require_capability(&self, capability: &str) -> Result<(), String> {
        if self.capabilities.iter().any(|c| c == capability) {
            Ok(())
        } else {
            Err(format!("capability '{capability}'가 grant되지 않았다"))
        }
    }

    /// SSRF 방어가 적용된 GET. 리다이렉트는 reqwest가 자동 따라가지 않게 하고,
    /// 각 hop에서 scheme·도메인 grant·해석 IP를 다시 검사한다(설계 782줄).
    pub async fn guarded_get(
        &self,
        url: &str,
        max_redirects: usize,
    ) -> Result<GuardedResponse, String> {
        let mut current = url.to_string();
        let client = reqwest::Client::builder()
            // 리다이렉트 자동 추적 금지 — 수동으로 재검사한다.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client 생성 실패: {e}"))?;
        for _hop in 0..=max_redirects {
            ssrf_guard(&current, &self.granted_domains)?;
            let resp = client
                .get(&current)
                .send()
                .await
                .map_err(|e| format!("요청 실패: {e}"))?;
            let status = resp.status();
            if status.is_redirection() {
                let location = resp
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                if location.is_empty() {
                    return Err("redirect에 Location이 없다".into());
                }
                current = resolve_redirect(&current, &location)?;
                continue;
            }
            // wire 상한(설계 784줄): 본문은 최대 8MB까지만 읽는다.
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("본문 읽기 실패: {e}"))?;
            if bytes.len() > 8 * 1024 * 1024 {
                return Err("응답이 크기 상한(8MB)을 넘었다".into());
            }
            return Ok(GuardedResponse {
                status: status.as_u16(),
                headers,
                body: bytes.to_vec(),
                final_url: current,
            });
        }
        Err(format!("redirect 상한({max_redirects})을 넘었다"))
    }

    /// Authorization을 붙여 GET한다. 토큰은 이 경로에서만 사용되고 반환되지 않는다(설계 667-668줄).
    pub async fn guarded_get_authorized(
        &self,
        url: &str,
        secret_name: &str,
        accept: &str,
    ) -> Result<GuardedResponse, String> {
        self.require_capability(super::manifest::CAPABILITY_SECRET_USE)?;
        let token = if secret_name == "github.oauth" {
            crate::extensions::github_management::oauth_access_token().await?
        } else {
            crate::extensions::broker::secrets::read(secret_name)?
        };
        let mut current = url.to_string();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("http client 생성 실패: {e}"))?;
        for _hop in 0..=3 {
            ssrf_guard(&current, &self.granted_domains)?;
            let resp = client
                .get(&current)
                .header("Authorization", format!("Bearer {token}"))
                .header("Accept", accept)
                .header("User-Agent", "sawhorse-dashboard")
                .send()
                .await
                .map_err(|e| format!("요청 실패: {e}"))?;
            let status = resp.status();
            if status.is_redirection() {
                let location = resp
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                current = resolve_redirect(&current, &location)?;
                continue;
            }
            let headers: Vec<(String, String)> = resp
                .headers()
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                .collect();
            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("본문 읽기 실패: {e}"))?;
            if bytes.len() > 16 * 1024 * 1024 {
                return Err("응답이 크기 상한을 넘었다".into());
            }
            return Ok(GuardedResponse {
                status: status.as_u16(),
                headers,
                body: bytes.to_vec(),
                final_url: current,
            });
        }
        Err("redirect 상한을 넘었다".into())
    }
}

#[derive(Clone, Debug)]
pub struct GuardedResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub final_url: String,
}

impl GuardedResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// redirect Location 해석. 새 위치도 scheme·grant 재검사 대상이 된다.
fn resolve_redirect(base: &str, location: &str) -> Result<String, String> {
    if location.starts_with("http://") || location.starts_with("https://") {
        Ok(location.to_string())
    } else if let Some(rest) = base.split_once("://") {
        let (scheme, authority_and_path) = rest;
        let (authority, _path) = authority_and_path
            .split_once('/')
            .unwrap_or((authority_and_path, ""));
        if location.starts_with('/') {
            Ok(format!("{scheme}://{authority}{location}"))
        } else {
            Err("상대 redirect 경로는 지원하지 않는다".into())
        }
    } else {
        Err("base URL 해석 실패".into())
    }
}

/// OS 보안 저장소(keyring 크레이트): macOS Keychain · Windows Credential Manager ·
/// Linux Secret Service. DB에는 secret_ref 이름만 남긴다(설계 512줄).
pub mod secrets;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_grant_matches_exact_and_wildcard() {
        let grants = vec!["api.github.com".to_string(), "*.example.com".to_string()];
        assert!(domain_allowed(&grants, "api.github.com"));
        assert!(domain_allowed(&grants, "feed.example.com"));
        assert!(domain_allowed(&grants, "a.b.example.com"));
        assert!(!domain_allowed(&grants, "evil.github.com.evil.io"));
        assert!(!domain_allowed(&grants, "github.com"));
        assert!(!domain_allowed(&grants, "example.com"));
    }

    #[test]
    fn url_validation_rejects_schemes_and_userinfo() {
        assert!(validate_url_scheme("https://example.com/feed").is_ok());
        assert!(validate_url_scheme("http://example.com/feed").is_ok());
        assert!(validate_url_scheme("file:///etc/passwd").is_err());
        assert!(validate_url_scheme("ftp://example.com").is_err());
        assert!(validate_url_scheme("https://user:pass@example.com/feed").is_err());
        assert!(validate_url_scheme("example.com/feed").is_err());
    }

    #[test]
    fn blocked_ips_cover_metadata_and_private_ranges() {
        let parse = |s: &str| s.parse::<IpAddr>().unwrap();
        assert!(is_blocked_ip(&parse("127.0.0.1")));
        assert!(is_blocked_ip(&parse("10.0.0.5")));
        assert!(is_blocked_ip(&parse("172.16.0.1")));
        assert!(is_blocked_ip(&parse("192.168.1.1")));
        assert!(is_blocked_ip(&parse("169.254.169.254"))); // cloud metadata
        assert!(is_blocked_ip(&parse("0.0.0.0")));
        assert!(is_blocked_ip(&parse("224.0.0.1")));
        assert!(is_blocked_ip(&parse("::1")));
        assert!(!is_blocked_ip(&parse("93.184.216.34")));
        assert!(!is_blocked_ip(&parse("140.82.112.3"))); // github
    }

    #[test]
    fn ssrf_guard_blocks_private_target_even_if_granted() {
        // grant가 있어도 사설 대역은 차단된다.
        let err = ssrf_guard("http://127.0.0.1:1420/", &["127.0.0.1".to_string()]).unwrap_err();
        assert!(err.contains("차단"));
        let err2 = ssrf_guard("file:///etc/passwd", &["example.com".to_string()]).unwrap_err();
        assert!(err2.contains("scheme"));
    }

    #[test]
    fn capability_is_default_deny() {
        let ctx = ExtensionContext {
            instance_id: "i".into(),
            granted_domains: vec![],
            capabilities: vec![],
        };
        assert!(ctx.require_capability("issue_write").is_err());
        let ctx2 = ExtensionContext {
            capabilities: vec!["issue_write".into()],
            ..ctx
        };
        assert!(ctx2.require_capability("issue_write").is_ok());
        assert!(ctx2.require_capability("remote_branch_push").is_err());
    }

    #[test]
    fn redirect_resolution_keeps_authority() {
        let next =
            resolve_redirect("https://example.com/a/b", "https://cdn.example.com/x").unwrap();
        assert_eq!(next, "https://cdn.example.com/x");
        let rel = resolve_redirect("https://example.com/a/b", "/c").unwrap();
        assert_eq!(rel, "https://example.com/c");
        assert!(resolve_redirect("https://example.com", "no-scheme-path").is_err());
    }
}
