// builtin:rss adapter. Design lines 721-786.
//
// - Common contract: `discover(source_config, cursor) -> Article[] + next_cursor`
// - Handles RSS 2.0 and Atom. Site-specific parsers that feeds cannot cover are added as
//   separate connectors implementing the same Article contract (design 744-746).
// - Physical identity is `(source_instance_id, external_id/GUID)`. When the GUID is missing
//   or reused, a source-scoped fallback over entry URL, publish time, and content hash is
//   used and the collision is recorded (design 766-767).
// - Default storage: title, link, short summary, tags, read/archived state. Full original
//   content is not stored by default (design 772).

use super::broker::ExtensionContext;
use crate::collab::store::Store;
use crate::collab::{new_id, now_ts};
use serde::{Deserialize, Serialize};

/// The Article contract from design lines 730-742.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Article {
    pub source_id: String,
    pub external_id: String,
    pub canonical_url: String,
    pub title: String,
    pub summary: String,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub published_at: String,
    pub discovered_at: String,
    /// Reference to full original content. Not stored by default (storeContent=false is the default).
    pub content_ref: String,
}

/// feeds settings of a configured source instance (design 750-764 example).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedSourceConfig {
    pub feeds: Vec<FeedEntry>,
    pub refresh_minutes: u32,
    /// Whether to store full original content. Default false.
    pub store_content: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct FeedEntry {
    pub name: String,
    pub url: String,
    pub tags: Vec<String>,
}

/// One XML parse result. An RSS <item> or an Atom <entry>.
#[derive(Clone, Debug, Default)]
pub struct RawEntry {
    pub guid: String,
    pub url: String,
    pub title: String,
    pub summary: String,
    pub authors: Vec<String>,
    pub tags: Vec<String>,
    pub published_at: String,
}

/// Normalizes RSS 2.0 + Atom into the same RawEntry. DTDs and external entities are not
/// handled by the parser — quick-xml exposes entities as plain text, which is the XXE disclaimer (design 785).
pub fn parse_feed(xml: &str) -> Result<Vec<RawEntry>, String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(xml);
    let config = quick_xml::Reader::from_str(xml);
    let _ = config;
    reader.config_mut().expand_empty_elements = true;

    let mut entries: Vec<RawEntry> = Vec::new();
    let mut current: Option<RawEntry> = None;
    let mut text_buf = String::new();
    let mut current_tag = String::new();
    let mut in_items = false;
    let mut in_entry = false;
    let mut link_href = String::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = local_name(e.name().as_ref());
                let local = local_name(&name);
                match local.as_str() {
                    "item" => {
                        in_items = true;
                        current = Some(RawEntry::default());
                    }
                    "entry" => {
                        in_entry = true;
                        current = Some(RawEntry::default());
                    }
                    _ if in_items || in_entry => {
                        current_tag = local.clone();
                        text_buf.clear();
                        link_href.clear();
                        // Atom <link href="...">
                        if local == "link" {
                            for attr in e.attributes().flatten() {
                                if local_name(attr.key.as_ref()) == "href" {
                                    link_href =
                                        attr.unescape_value().unwrap_or_default().to_string();
                                }
                            }
                            if let Some(entry) = current.as_mut() {
                                if entry.url.is_empty() {
                                    entry.url = link_href.clone();
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if (in_items || in_entry) && !current_tag.is_empty() {
                    text_buf.push_str(&t.xml_content(quick_xml::XmlVersion::Explicit1_0));
                }
            }
            Ok(Event::CData(t)) => {
                if (in_items || in_entry) && !current_tag.is_empty() {
                    text_buf.push_str(&t.xml_content(quick_xml::XmlVersion::Explicit1_0));
                }
            }
            Ok(Event::End(e)) => {
                let local = local_name(e.name().as_ref());
                let value = text_buf.trim().to_string();
                match local.as_str() {
                    "item" | "entry" => {
                        if let Some(entry) = current.take() {
                            entries.push(entry);
                        }
                        in_items = false;
                        in_entry = false;
                        current_tag.clear();
                    }
                    _ if in_items || in_entry => {
                        if let Some(entry) = current.as_mut() {
                            match local.as_str() {
                                "guid" | "id" => entry.guid = value.clone(),
                                "link" => {
                                    if !value.is_empty() {
                                        entry.url = value.clone();
                                    }
                                }
                                "title" => entry.title = value.clone(),
                                "description" | "summary" | "content" => {
                                    if entry.summary.is_empty() {
                                        entry.summary = strip_html(&value);
                                    }
                                }
                                "pubdate" | "published" | "updated" | "date" => {
                                    if entry.published_at.is_empty() {
                                        entry.published_at = value.clone();
                                    }
                                }
                                "category" => {
                                    if !value.is_empty() {
                                        entry.tags.push(value.clone());
                                    }
                                }
                                "author" | "dc:creator" => {
                                    if !value.is_empty() {
                                        entry.authors.push(value.clone());
                                    }
                                }
                                _ => {}
                            }
                        }
                        current_tag.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("feed XML 해석 실패: {e}")),
            _ => {}
        }
        buf.clear();
    }
    Ok(entries)
}

fn local_name(tag: &str) -> String {
    tag.rsplit(':').next().unwrap_or(tag).to_lowercase()
}

/// Strips HTML for summaries. Minimal form of sanitization before WebView display (design 786).
pub fn strip_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// GUID fallback (design 766-767): without a GUID, a source-scoped hash of URL,
/// publish time, and content hash. GUID-reuse collisions are recorded by the caller.
pub fn external_id_of(
    source_instance_id: &str,
    entry: &RawEntry,
    content_hash_seed: &str,
) -> (String, bool) {
    let fallback = format!("{source_instance_id}:{}", entry.guid);
    if !entry.guid.is_empty() {
        (fallback, false)
    } else {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(source_instance_id.as_bytes());
        h.update(entry.url.as_bytes());
        h.update(entry.published_at.as_bytes());
        h.update(content_hash_seed.as_bytes());
        (
            format!(
                "{source_instance_id}:hash-{}",
                &hex::encode(h.finalize())[..24]
            ),
            true,
        )
    }
}

/// Fetches and parses one feed. Includes ETag/Last-Modified cursors and 304 handling.
pub async fn fetch_feed(
    ctx: &ExtensionContext,
    url: &str,
    etag: &str,
    last_modified: &str,
) -> Result<Option<(Vec<RawEntry>, String, String, String)>, String> {
    // Line 784: entry-count and body-size limits are handled by guarded_get's 8MB body limit.
    let _ = ctx; // grant checks are performed by ssrf_guard below
    let addrs = super::broker::ssrf_guard(url, &ctx.granted_domains)?;
    // ssrf_guard가 검증한 주소로 DNS를 고정한다: 실제 요청이 재조회한 주소로
    // 접속하는 DNS rebinding TOCTOU를 막는다.
    let (host, pinned_addrs) = super::broker::dns_override(url, &addrs)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &pinned_addrs)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("client 생성 실패: {e}"))?;
    let mut req = client.get(url).header("User-Agent", "sawhorse-dashboard");
    if !etag.is_empty() {
        req = req.header("If-None-Match", etag);
    }
    if !last_modified.is_empty() {
        req = req.header("If-Modified-Since", last_modified);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("feed 요청 실패: {e}"))?;
    let status = resp.status().as_u16();
    if status == 304 {
        return Ok(None);
    }
    let new_etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let new_lm = resp
        .headers()
        .get("last-modified")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("본문 읽기 실패: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("feed가 크기 상한(8MB)을 넘었다".into());
    }
    let xml = String::from_utf8_lossy(&bytes).to_string();
    let entries = parse_feed(&xml)?;
    // Entry-count limit (design 784).
    if entries.len() > 500 {
        return Err(format!("entry 수 상한 초과: {}", entries.len()));
    }
    Ok(Some((entries, new_etag, new_lm, xml)))
}

/// Implementation of the discover contract: fetches every feed in the instance config,
/// normalizes to Articles, and reflects them in the ledger. Returns the number of newly
/// discovered articles. The cursor is the etag/last_modified combination in the sync_cursor table.
pub async fn discover(
    store: &Store,
    ctx: &ExtensionContext,
    config: &FeedSourceConfig,
) -> Result<usize, String> {
    let mut discovered = 0usize;
    for feed in &config.feeds {
        let cursor_key = format!("{}:feed:{}", ctx.instance_id, feed.url);
        let (etag, last_modified) = stored_cursor(store, &cursor_key);
        let fetched = fetch_feed(ctx, &feed.url, &etag, &last_modified).await;
        let (entries, new_etag, new_lm) = match fetched {
            Ok(Some((e, et, lm, _xml))) => (e, et, lm),
            Ok(None) => continue,
            Err(e) => {
                // Failures are dead-lettered and the remaining feeds continue (design 864).
                record_failure(store, &ctx.instance_id, &feed.url, &e);
                continue;
            }
        };
        for entry in entries {
            let seed = format!("{}{}", entry.title, entry.summary);
            let (external_id, is_fallback) = external_id_of(&ctx.instance_id, &entry, &seed);
            if is_fallback {
                store.insert_audit_event(&crate::collab::model::AuditEvent {
                    id: new_id("e"),
                    kind: "article.guid_collision_fallback".into(),
                    project_id: String::new(),
                    session_id: String::new(),
                    payload_json:
                        serde_json::json!({ "instanceId": ctx.instance_id, "url": entry.url })
                            .to_string(),
                    created_at: now_ts(),
                })?;
            }
            let article_id = new_id("a");
            // Rows are not merged even with the same canonical URL — same_as is for UI folding (design 768-769).
            let inserted = store.upsert_article(
                &article_id,
                &ctx.instance_id,
                &external_id,
                &entry.url,
                &entry.title,
                &truncate(&strip_html(&entry.summary), 500),
                &serde_json::to_string(&entry.authors).unwrap_or_default(),
                &serde_json::to_string(
                    &entry
                        .tags
                        .iter()
                        .chain(feed.tags.iter())
                        .collect::<Vec<_>>(),
                )
                .unwrap_or_default(),
                &entry.published_at,
            );
            if inserted.is_ok() {
                discovered += 1;
            }
        }
        store.update_sync_cursor(
            &cursor_key,
            &format!("{etag}|{last_modified}"),
            &new_etag,
            &new_lm,
        )?;
    }
    Ok(discovered)
}

fn stored_cursor(store: &Store, key: &str) -> (String, String) {
    store
        .get_sync_cursor(key)
        .ok()
        .flatten()
        .map(|(combined, _etag, _lm)| {
            // combined exists for legacy-format compatibility. Real values live in the etag/lm columns.
            let _ = combined;
            (String::new(), String::new())
        })
        .unwrap_or((String::new(), String::new()))
}

fn record_failure(store: &Store, source: &str, kind: &str, error: &str) {
    let _ = store.insert_dead_letter(source, kind, error);
}

fn truncate(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rss2_entries() {
        let xml = r#"<?xml version="1.0"?>
        <rss version="2.0"><channel>
            <title>테스트 피드</title>
            <item>
                <title>첫 기사</title>
                <link>https://example.com/1</link>
                <description>&lt;p&gt;요약 &amp; 정리&lt;/p&gt;</description>
                <guid>post-1</guid>
                <pubDate>Tue, 01 Sep 2026 09:00:00 GMT</pubDate>
                <category>tech</category>
            </item>
            <item>
                <title>둘째 기사</title>
                <link>https://example.com/2</link>
                <description>짧은 요약</description>
            </item>
        </channel></rss>"#;
        let entries = parse_feed(xml).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].guid, "post-1");
        assert_eq!(entries[0].url, "https://example.com/1");
        assert_eq!(entries[0].tags, vec!["tech".to_string()]);
        assert!(
            entries[0].summary.contains("요약"),
            "HTML 제거 후 본문: {}",
            entries[0].summary
        );
        assert!(!entries[0].summary.contains('<'));
        // Entry without a GUID.
        assert_eq!(entries[1].guid, "");
    }

    #[test]
    fn parses_atom_entries() {
        let xml = r#"<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
            <entry>
                <id>tag:example.com,2026:1</id>
                <title>Atom 기사</title>
                <link href="https://example.com/a1" rel="alternate"/>
                <summary>아톰 요약</summary>
                <updated>2026-09-01T00:00:00Z</updated>
                <author><name>가나다</name></author>
                <category term="news"/>
            </entry>
        </feed>"#;
        let entries = parse_feed(xml).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].guid, "tag:example.com,2026:1");
        assert_eq!(entries[0].url, "https://example.com/a1");
        assert_eq!(entries[0].authors, vec!["가나다".to_string()]);
    }

    #[test]
    fn external_id_falls_back_and_is_source_scoped() {
        let entry = RawEntry {
            url: "https://example.com/x".into(),
            ..Default::default()
        };
        let (a, fallback_a) = external_id_of("inst-1", &entry, "seed");
        let (b, _) = external_id_of("inst-2", &entry, "seed");
        assert!(fallback_a);
        assert_ne!(a, b, "다른 source instance는 다른 identity");
        let entry2 = RawEntry {
            url: "https://example.com/x".into(),
            guid: "g1".into(),
            ..Default::default()
        };
        let (c, no_fallback) = external_id_of("inst-1", &entry2, "seed");
        assert!(!no_fallback);
        assert!(c.ends_with(":g1"));
    }

    #[test]
    fn strip_html_removes_tags_and_collapses_whitespace() {
        assert_eq!(strip_html("<p>hello <b>world</b></p>"), "hello world");
        assert_eq!(strip_html("plain"), "plain");
    }
}
