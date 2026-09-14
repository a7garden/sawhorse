//! 관리형 자산 — PDC-1.0 §8.2.
//!
//! 자산 바이트는 소문자 SHA-256 다이제스트로 주소화되고 정칙 URI는
//! `pdc://asset/sha256/<64-hex>`, 볼트 상대 경로는
//! `.pdc/assets/sha256/<앞 두 글자>/<64-hex>`다. 쓰기는 create-if-absent이고
//! 이미 있는 다이제스트 경로의 다른 바이트는 절대 덮어쓰지 않는다. 읽기는
//! 저장된 바이트가 다이제스트로 정확히 흘러드는지 검증한다 — 불일치는 눈에
//! 보이는 무결성 오류다. 미참조 자산의 자동 청소는 하지 않는다(§8.2).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use super::contract;
use super::writer::ensure_vault_manifest;

/// 자산 저장 결과. `media_type`은 참조 쪽 힌트일 뿐 정체가 아니다(§8.2).
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetStored {
    pub uri: String,
    pub digest: String,
    pub filename: Option<String>,
    pub media_type: Option<String>,
}

/// 자산 바이트를 저장하고 정칙 URI를 돌려준다. 같은 바이트의 재저장은 기존
/// 경로를 그대로 두고 같은 URI를 돌려준다(멱등).
pub fn add_asset(
    space_root: &Path,
    bytes: Vec<u8>,
    filename: Option<String>,
    media_type: Option<String>,
) -> Result<AssetStored, String> {
    if bytes.len() as u64 > contract::ASSET_MAX_BYTES {
        return Err("asset_too_large: 자산은 64 MiB를 넘을 수 없다".into());
    }
    ensure_vault_manifest(space_root)?;
    let digest = sha256_hex(&bytes);
    let path = asset_path(space_root, &digest)?;
    if path.exists() {
        let existing = std::fs::read(&path).map_err(|e| format!("read-failed: {e}"))?;
        if sha256_hex(&existing) != digest {
            return Err(format!(
                "asset_digest_mismatch: 다이제스트 경로에 다른 바이트가 있다: {}",
                path.display()
            ));
        }
    } else {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("write-failed: {e}"))?;
        }
        crate::workspace_io::write_atomic(&path, &bytes, false)?;
    }
    Ok(AssetStored {
        uri: contract::asset_uri(&digest)?,
        digest,
        filename,
        media_type,
    })
}

/// 자산 바이트를 다이제스트로 검증해 읽는다. 불일치는 Err(`asset_digest_mismatch`).
pub fn load_asset(space_root: &Path, digest: &str) -> Result<(Vec<u8>, &'static str), String> {
    if !contract::is_sha256_digest(digest) {
        return Err("invalid_digest: 자산 다이제스트는 소문자 64-hex다".into());
    }
    let path = asset_path(space_root, digest)?;
    let bytes =
        std::fs::read(&path).map_err(|_| format!("missing_asset: 자산이 없다: {digest}"))?;
    if sha256_hex(&bytes) != digest {
        return Err(format!(
            "asset_digest_mismatch: 저장된 바이트가 다이제스트와 다르다: {digest}"
        ));
    }
    let media = sniff_media(&bytes);
    Ok((bytes, media))
}

fn asset_path(space_root: &Path, digest: &str) -> Result<PathBuf, String> {
    Ok(space_root.join(contract::asset_relative_path(digest)?))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// 마법 바이트로 매체 유형을 추정한다. 알 수 없으면 octet-stream이다 —
/// 렌더 정책상 위험한 유형은 어차피 격리 프레임에서 실행되지 않는다.
fn sniff_media(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        [b'%', b'P', b'D', b'F', ..] => "application/pdf",
        _ => {
            let head = String::from_utf8_lossy(bytes.get(..64).unwrap_or(bytes));
            let starts_markup =
                head.trim_start().starts_with("<svg") || head.trim_start().starts_with("<?xml");
            if starts_markup {
                "image/svg+xml"
            } else {
                "application/octet-stream"
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_space(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "swdash-pdc-assets-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn add_is_idempotent_and_verifies_integrity() {
        let space = temp_space("add");
        let png = vec![0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3];
        let first = add_asset(
            &space,
            png.clone(),
            Some("도표.png".into()),
            Some("image/png".into()),
        )
        .unwrap();
        assert!(first.uri.starts_with("pdc://asset/sha256/"));
        let second = add_asset(&space, png.clone(), None, None).unwrap();
        assert_eq!(first.uri, second.uri);
        let (loaded, media) = load_asset(&space, &first.digest).unwrap();
        assert_eq!(loaded, png);
        assert_eq!(media, "image/png");
        // 다른 바이트를 같은 다이제스트 경로에 억지로 써 넣으면 읽기가 거부된다.
        let relative = contract::asset_relative_path(&first.digest).unwrap();
        std::fs::write(space.join(relative), b"corrupted").unwrap();
        let error = load_asset(&space, &first.digest).unwrap_err();
        assert!(error.contains("asset_digest_mismatch"), "{error}");
    }

    #[test]
    fn rejects_oversized_and_malformed_digests() {
        let space = temp_space("guard");
        let big = vec![0u8; (contract::ASSET_MAX_BYTES + 1) as usize];
        assert!(add_asset(&space, big, None, None).is_err());
        assert!(load_asset(&space, "zz").is_err());
    }
}
