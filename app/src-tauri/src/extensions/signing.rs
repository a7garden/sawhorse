// 확장 서명. 설계 879줄: 서명·업데이트·권한 증가 재승인.
//
// - bundle의 extension.json 바이트에 ed25519 서명을 붙인다(`<bundle>/extension.json.sig`,
//   hex 64바이트). 서명 검증에 쓸 신뢰 공개키는 `~/.claude/sawhorse/extensions/trusted-keys.json`
//   (hex 공개키 배열)에서 관리한다.
// - 검증 실패한 사용자 bundle은 설치·업데이트를 거부한다. 내장 bundle은 앱 서명으로 본다.
// - 권한 증가가 있는 업데이트는 재승인 전까지 instance를 paused로 둔다(설계 664줄) —
//   이 판정은 manifest::permission_increased가, 정지는 commands 쪽이 담당한다.

use crate::extensions::manifest::{DiscoveredBundle, ExtensionManifest};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use std::path::Path;

pub const SIG_FILE: &str = "extension.json.sig";

fn trusted_keys_path() -> std::path::PathBuf {
    crate::extensions::manifest::user_extensions_dir().join("trusted-keys.json")
}

/// 신뢰 공개키 목록 조회(hex 32바이트).
pub fn trusted_keys() -> Vec<String> {
    std::fs::read_to_string(trusted_keys_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub fn add_trusted_key(pubkey_hex: &str) -> Result<(), String> {
    decode_pubkey(pubkey_hex)?;
    let mut keys = trusted_keys();
    if !keys.iter().any(|k| k == pubkey_hex) {
        keys.push(pubkey_hex.to_string());
    }
    let path = trusted_keys_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("extensions 디렉터리 생성 실패: {e}"))?;
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&keys).unwrap_or_default(),
    )
    .map_err(|e| format!("trusted keys 저장 실패: {e}"))
}

fn decode_pubkey(hex_str: &str) -> Result<VerifyingKey, String> {
    let bytes = hex::decode(hex_str).map_err(|e| format!("공개키 hex 해석 실패: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "공개키는 32바이트여야 한다".to_string())?;
    VerifyingKey::from_bytes(&arr).map_err(|e| format!("공개키 검증 실패: {e}"))
}

/// bundle 서명 검증. 서명 파일이 있고 신뢰 키 중 하나로 통과하면 Ok(true).
/// 서명 파일이 아예 없으면 Ok(false) — 정책에 따라 거부할지 결정한다.
pub fn verify_bundle(dir: &Path, keys: &[String]) -> Result<bool, String> {
    let manifest_bytes = std::fs::read(dir.join("extension.json"))
        .map_err(|e| format!("extension.json 읽기 실패: {e}"))?;
    let sig_bytes = match std::fs::read(dir.join(SIG_FILE)) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    let sig_hex = String::from_utf8_lossy(&sig_bytes).trim().to_string();
    let sig_raw = hex::decode(&sig_hex).map_err(|e| format!("서명 hex 해석 실패: {e}"))?;
    let sig_arr: [u8; 64] = sig_raw
        .try_into()
        .map_err(|_| "서명은 64바이트여야 한다".to_string())?;
    let signature = Signature::from_bytes(&sig_arr);
    for key_hex in keys {
        if let Ok(vk) = decode_pubkey(key_hex) {
            if vk.verify(&manifest_bytes, &signature).is_ok() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// 설치 가능 여부 판정. 사용자 bundle은 서명이 필요하고(설계 879줄), 내장 bundle은
/// 앱이 배포하므로 그대로 신뢰한다.
pub fn install_allowed(bundle: &DiscoveredBundle, keys: &[String]) -> Result<(), String> {
    if bundle.source == "builtin" {
        return Ok(());
    }
    match verify_bundle(Path::new(&bundle.dir), keys)? {
        true => Ok(()),
        false => Err(format!(
            "bundle '{}'의 서명이 없거나 신뢰 키로 검증되지 않았다",
            bundle.manifest.id
        )),
    }
}

/// 업데이트 후 manifest를 다시 검증한다. 권한이 늘었는지는 호출자가 permission_increased로 판정해
/// instance를 paused로 둔다(설계 664줄).
pub fn validate_update(old: &ExtensionManifest, new: &ExtensionManifest) -> Result<(), String> {
    new.validate()?;
    if new.id != old.id {
        return Err("업데이트가 bundle id를 바꿀 수 없다".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn bundle_dir(json: &str) -> (TempDir, SigningKey) {
        let dir = std::env::temp_dir().join(format!("sawhorse-sign-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).expect("엔트로피 생성 실패");
        let signing = SigningKey::from_bytes(&seed);
        std::fs::write(dir.join("extension.json"), json).unwrap();
        (TempDir(dir), signing)
    }

    #[test]
    fn signature_verifies_and_rejects_tampering() {
        let json = r#"{"schemaVersion":1,"id":"x","name":"X","version":"0.1.0","components":[{"id":"c","type":"connector","adapter":"builtin:rss"}]}"#;
        let (dir, signing) = bundle_dir(json);
        let sig = signing.sign(json.as_bytes());
        std::fs::write(dir.path().join(SIG_FILE), hex::encode(sig.to_bytes())).unwrap();
        let good = hex::encode(signing.verifying_key().to_bytes());
        assert!(verify_bundle(dir.path(), &[good.clone()]).unwrap());
        // 변조된 manifest는 거부.
        std::fs::write(
            dir.path().join("extension.json"),
            json.replace("0.1.0", "0.2.0"),
        )
        .unwrap();
        assert!(!verify_bundle(dir.path(), &[good]).unwrap());
        // 서명 파일이 없으면 false(정책 판단은 install_allowed가 한다).
        let (dir2, _signing2) = bundle_dir(json);
        assert!(!verify_bundle(dir2.path(), &[]).unwrap());
    }

    #[test]
    fn install_requires_signature_for_user_bundles() {
        let json = r#"{"schemaVersion":1,"id":"x","name":"X","version":"0.1.0","components":[{"id":"c","type":"connector","adapter":"builtin:rss"}]}"#;
        let (dir, signing) = bundle_dir(json);
        let mk = |source: &str, d: String| DiscoveredBundle {
            manifest: ExtensionManifest::parse(json).unwrap(),
            source: source.into(),
            dir: d,
        };
        // 내장은 무서명 허용.
        assert!(install_allowed(&mk("builtin", String::new()), &[]).is_ok());
        // 사용자는 서명 필요.
        assert!(
            install_allowed(&mk("user", dir.path().to_string_lossy().to_string()), &[]).is_err()
        );
        let sig = signing.sign(json.as_bytes());
        std::fs::write(dir.path().join(SIG_FILE), hex::encode(sig.to_bytes())).unwrap();
        let key = hex::encode(signing.verifying_key().to_bytes());
        assert!(install_allowed(
            &mk("user", dir.path().to_string_lossy().to_string()),
            &[key]
        )
        .is_ok());
    }

    #[test]
    fn update_cannot_change_bundle_identity() {
        let old = ExtensionManifest::parse(
            r#"{"schemaVersion":1,"id":"x","name":"X","version":"0.1.0","components":[{"id":"c","type":"connector","adapter":"builtin:rss"}]}"#,
        )
        .unwrap();
        let new_same = ExtensionManifest::parse(
            r#"{"schemaVersion":1,"id":"x","name":"X","version":"0.2.0","components":[{"id":"c","type":"connector","adapter":"builtin:rss"}]}"#,
        )
        .unwrap();
        let new_diff = ExtensionManifest::parse(
            r#"{"schemaVersion":1,"id":"y","name":"X","version":"0.2.0","components":[{"id":"c","type":"connector","adapter":"builtin:rss"}]}"#,
        )
        .unwrap();
        assert!(validate_update(&old, &new_same).is_ok());
        assert!(validate_update(&old, &new_diff).is_err());
    }
}
