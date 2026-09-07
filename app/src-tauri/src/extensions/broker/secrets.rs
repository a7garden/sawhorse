//! Keep successfully unlocked secrets in the broker for this process only.
//! Navigation, pagination and concurrent requests must not reopen the keychain.
use std::{collections::HashMap, sync::OnceLock};

use parking_lot::Mutex;

const SERVICE: &str = "sawhorse";

#[derive(Default)]
struct SessionSecrets {
    values: Mutex<HashMap<String, String>>,
}

impl SessionSecrets {
    fn read(
        &self,
        name: &str,
        load: impl FnOnce() -> Result<Option<String>, String>,
    ) -> Result<Option<String>, String> {
        // Hold the lock across the OS call so concurrent first reads share one
        // unlock, and a pending read cannot restore a deleted/replaced value.
        let mut values = self.values.lock();
        if let Some(value) = values.get(name) {
            return Ok(Some(value.clone()));
        }
        let value = load()?;
        if let Some(value) = &value {
            values.insert(name.to_string(), value.clone());
        }
        // Missing entries and access failures can be retried after login/unlock.
        Ok(value)
    }

    fn write(
        &self,
        name: &str,
        value: &str,
        persist: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut values = self.values.lock();
        values.remove(name);
        persist()?;
        values.insert(name.to_string(), value.to_string());
        Ok(())
    }

    fn delete(
        &self,
        name: &str,
        remove: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut values = self.values.lock();
        values.remove(name);
        remove()
    }
}

fn session() -> &'static SessionSecrets {
    static SESSION: OnceLock<SessionSecrets> = OnceLock::new();
    SESSION.get_or_init(SessionSecrets::default)
}

fn entry(name: &str) -> Result<keyring::Entry, String> {
    if name.is_empty() {
        return Err("secret 이름은 비어 있을 수 없다".into());
    }
    keyring::Entry::new(SERVICE, name).map_err(|e| format!("보안 저장소 진입 실패: {e}"))
}

/// Persist before updating the session, including OAuth login and refresh.
pub fn write(name: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err("secret 값은 비어 있을 수 없다".into());
    }
    session().write(name, value, || {
        entry(name)?
            .set_password(value)
            .map_err(|e| format!("secret '{name}' 저장 실패: {e}"))
    })
}

/// Only a missing entry means disconnected; denied/locked access is an error.
pub fn read_optional(name: &str) -> Result<Option<String>, String> {
    session().read(name, || match entry(name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("secret '{name}' 보안 저장소 접근 실패: {e}")),
    })
}

/// Tokens remain inside the broker and are never returned to connectors/UI.
pub fn read(name: &str) -> Result<String, String> {
    read_optional(name)?.ok_or_else(|| format!("secret '{name}'이 보안 저장소에 없다"))
}

pub fn delete(name: &str) -> Result<(), String> {
    session().delete(name, || match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("secret '{name}' 삭제 실패: {e}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier,
    };

    #[test]
    fn concurrent_requests_and_later_navigation_unlock_only_once() {
        let session = SessionSecrets::default();
        let reads = AtomicUsize::new(0);
        let start = Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    start.wait();
                    assert_eq!(
                        session
                            .read("github.oauth", || {
                                reads.fetch_add(1, Ordering::SeqCst);
                                Ok(Some("token".into()))
                            })
                            .unwrap()
                            .as_deref(),
                        Some("token")
                    );
                });
            }
        });
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            session
                .read("github.oauth", || panic!("reopened keychain"))
                .unwrap()
                .as_deref(),
            Some("token")
        );
        assert_eq!(
            session
                .read("other", || Ok(Some("different".into())))
                .unwrap()
                .as_deref(),
            Some("different")
        );
    }

    #[test]
    fn login_and_refresh_replace_the_cached_token_after_persistence() {
        let session = SessionSecrets::default();
        session
            .read("github.oauth", || Ok(Some("old".into())))
            .unwrap();
        let writes = AtomicUsize::new(0);
        for token in ["login", "refreshed"] {
            session
                .write("github.oauth", token, || {
                    writes.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .unwrap();
            assert_eq!(
                session
                    .read("github.oauth", || panic!("reopened keychain"))
                    .unwrap()
                    .as_deref(),
                Some(token)
            );
        }
        assert_eq!(writes.load(Ordering::SeqCst), 2);
        assert!(session
            .write("github.oauth", "unsaved", || Err("locked".into()))
            .is_err());
        assert_eq!(
            session
                .read("github.oauth", || Ok(Some("persisted".into())))
                .unwrap()
                .as_deref(),
            Some("persisted")
        );
    }

    #[test]
    fn disconnect_clears_cached_tokens_and_reports_deletion_failures() {
        let session = SessionSecrets::default();
        session.write("github.oauth", "token", || Ok(())).unwrap();
        session.delete("github.oauth", || Ok(())).unwrap();
        assert_eq!(session.read("github.oauth", || Ok(None)).unwrap(), None);
        session.write("github.oauth", "new", || Ok(())).unwrap();
        assert!(session
            .delete("github.oauth", || Err("denied".into()))
            .is_err());
        assert_eq!(
            session.read("github.oauth", || Err("still locked".into())),
            Err("still locked".into())
        );
    }

    #[test]
    fn missing_or_denied_secrets_can_be_retried() {
        let session = SessionSecrets::default();
        assert_eq!(session.read("github.oauth", || Ok(None)).unwrap(), None);
        assert_eq!(
            session.read("github.oauth", || Err("denied".into())),
            Err("denied".into())
        );
        assert_eq!(
            session
                .read("github.oauth", || Ok(Some("unlocked".into())))
                .unwrap()
                .as_deref(),
            Some("unlocked")
        );
    }
}
