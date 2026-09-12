// Extension broker. Permission rules from design lines 661-675 and SSRF defenses from 778-786.
//
// - Built-in handlers also receive only a narrow ExtensionContext, not raw DB, Git,
//   HTTP client, or token. The credential broker attaches Authorization only to approved
//   account/repository requests and never returns the token itself to the connector (design 666-668).
// - Since this fetches user-supplied URLs with host-level authority, SSRF defenses are mandatory (778-786).

use std::net::{IpAddr, Ipv4Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

/// Domain grant check. Only exact domains or `*.example.com` wildcards are allowed.
pub fn domain_allowed(granted: &[String], host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    granted.iter().any(|g| {
        let g = g.trim().to_ascii_lowercase();
        if let Some(suffix) = g.strip_prefix("*.") {
            // 와일드카드는 점 경계에서만 일치한다: suffix가 문자 중간에
            // 붙는 "attackerexample.com" 같은 우회를 거부한다.
            !suffix.is_empty()
                && host.len() > suffix.len() + 1
                && host.ends_with(suffix)
                && host.as_bytes()[host.len() - suffix.len() - 1] == b'.'
        } else {
            g == host
        }
    })
}

/// URL pre-check (design 780-781): only http/https schemes; reject URLs with credentials/userinfo.
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

/// Blocks DNS resolution results that fall in private, loopback, link-local, multicast,
/// or cloud metadata ranges (design 781-782). Every resolved address is checked —
/// never treat as safe because one address is safe; reject if any one is dangerous.
pub fn resolved_ips_blocked(ips: &[IpAddr]) -> bool {
    ips.iter().any(|ip| is_blocked_ip(ip))
}

pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // loopback 127/8, private 10/8, 172.16/12, 192.168/16, link-local 169.254/16,
            // reserved ranges 0.0.0.0/8, 100.64/10, 192.0.0/24, 198.18/15, 240/4,
            // multicast 224/4; cloud metadata 169.254.169.254 is covered by link-local.
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
            let s = v6.segments();
            v6.is_loopback()
                || v6.is_multicast()
                || v6.is_unspecified()
                // ULA fc00::/7, link-local fe80::/10.
                || (s[0] & 0xfe00) == 0xfc00
                || (s[0] & 0xffc0) == 0xfe80
                // NAT64 64:ff9b::/96 — 내장 IPv4를 같은 규칙으로 재검사한다.
                || (s[0] == 0x0064
                    && s[1] == 0xff9b
                    && s[2..6].iter().all(|&seg| seg == 0)
                    && is_blocked_ip(&IpAddr::V4(Ipv4Addr::new(
                        (s[6] >> 8) as u8,
                        (s[6] & 0xff) as u8,
                        (s[7] >> 8) as u8,
                        (s[7] & 0xff) as u8,
                    ))))
                || v6
                    .to_ipv4_mapped()
                    .map_or(false, |v4| is_blocked_ip(&IpAddr::V4(v4)))
        }
    }
}

/// Validates a URL through host resolution and decides whether the request may proceed.
pub fn ssrf_guard(url: &str, granted_domains: &[String]) -> Result<Vec<IpAddr>, String> {
    let (_scheme, host) = validate_url_scheme(url)?;
    if !domain_allowed(granted_domains, &host) {
        return Err(format!("도메인이 grant에 없다: {host}"));
    }
    // Hostname literals (direct IPs) are blocked the same way.
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

/// DNS rebinding 방지: ssrf_guard가 검증한 addrs를 URL의 host와 유효 port로
/// 고정한 (host, SocketAddr 목록) 쌍으로 바꿔준다. 반환값은
/// `reqwest::Client::builder().resolve_to_addrs()`와 짝으로 쓴다.
pub fn dns_override(url: &str, addrs: &[IpAddr]) -> Result<(String, Vec<SocketAddr>), String> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("scheme이 없는 URL: {url}"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => {
            let port: u16 = p.parse().map_err(|_| format!("잘못된 port: {p}"))?;
            (h, port)
        }
        // "host:" 형태는 URL 규격상 기본 port다.
        Some((h, "")) => (h, default_port),
        _ => (authority, default_port),
    };
    if host.is_empty() {
        return Err("host가 없다".into());
    }
    Ok((
        host.to_string(),
        addrs.iter().map(|ip| SocketAddr::new(*ip, port)).collect(),
    ))
}

/// The narrow context handed to extensions. Exposes no HTTP client, token, or DB handles (design 666).
#[derive(Clone, Debug)]
pub struct ExtensionContext {
    pub instance_id: String,
    pub granted_domains: Vec<String>,
    pub capabilities: Vec<String>,
}

impl ExtensionContext {
    /// Capability check. Capabilities are default-deny (design 663).
    pub fn require_capability(&self, capability: &str) -> Result<(), String> {
        if self.capabilities.iter().any(|c| c == capability) {
            Ok(())
        } else {
            Err(format!("capability '{capability}'가 grant되지 않았다"))
        }
    }

    /// GET with SSRF defenses. Redirects are not followed automatically by reqwest;
    /// scheme, domain grant, and resolved IPs are re-checked at each hop (design 782).
    pub async fn guarded_get(
        &self,
        url: &str,
        max_redirects: usize,
    ) -> Result<GuardedResponse, String> {
        let mut current = url.to_string();
        for _hop in 0..=max_redirects {
            // hop마다 검증된 addrs로 DNS를 고정한다: 실제 요청이 재조회한 주소로
            // 접속하는 DNS rebinding TOCTOU를 막는다.
            let addrs = ssrf_guard(&current, &self.granted_domains)?;
            let (host, pinned_addrs) = dns_override(&current, &addrs)?;
            let client = reqwest::Client::builder()
                // No automatic redirect following — re-checked manually.
                .redirect(reqwest::redirect::Policy::none())
                // ssrf_guard가 검증한 주소로만 접속한다.
                .resolve_to_addrs(&host, &pinned_addrs)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| format!("http client 생성 실패: {e}"))?;
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
            // Wire limit (design 784): read at most 8MB of the body.
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

    /// GET with Authorization attached. The token is used only on this path and never returned (design 667-668).
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
        for _hop in 0..=3 {
            // hop마다 검증된 addrs로 DNS를 고정한다: 실제 요청이 재조회한 주소로
            // 접속하는 DNS rebinding TOCTOU를 막는다.
            let addrs = ssrf_guard(&current, &self.granted_domains)?;
            let (host, pinned_addrs) = dns_override(&current, &addrs)?;
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                // ssrf_guard가 검증한 주소로만 접속한다.
                .resolve_to_addrs(&host, &pinned_addrs)
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| format!("http client 생성 실패: {e}"))?;
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
                if location.is_empty() {
                    return Err("redirect에 Location이 없다".into());
                }
                current = resolve_redirect(&current, &location)?;
                // https가 아닌 redirect 타깃은 Bearer를 재전송하지 않도록 거부한다.
                if !current.starts_with("https://") {
                    return Err("인증 요청의 redirect는 https만 허용한다".into());
                }
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

/// Resolves a redirect Location. The new location is subject to scheme and grant re-checks.
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

/// OS secure storage (keyring crate): macOS Keychain, Windows Credential Manager,
/// Linux Secret Service. Only the secret_ref name is kept in the DB (design 512).
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
        assert!(!domain_allowed(&grants, "attackerexample.com")); // 점 경계 없는 와일드카드 우회
        assert!(!domain_allowed(&grants, "notgithub.com"));
        assert!(domain_allowed(&grants, "Feed.Example.COM")); // host 소문자 통일 후 일치
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
        assert!(is_blocked_ip(&parse("fd00::1"))); // ULA fc00::/7
        assert!(is_blocked_ip(&parse("fe80::1"))); // link-local fe80::/10
        assert!(is_blocked_ip(&parse("64:ff9b::169.254.169.254"))); // NAT64 내장 metadata
        assert!(!is_blocked_ip(&parse("64:ff9b::93.184.216.34"))); // NAT64 공개 v4
        assert!(!is_blocked_ip(&parse("2606:4700::1111"))); // 공개 v6
    }

    #[test]
    fn ssrf_guard_blocks_private_target_even_if_granted() {
        // Private ranges are blocked even when granted.
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
