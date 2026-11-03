//! Linux secret storage for the community MCP plugin (T20).
//!
//! Windows keeps the plugin's `tunnel-key` and `credential` as DPAPI-protected
//! `*.dpapi` files written by a PowerShell helper (`secret-store.ps1`). On Linux
//! the same two secrets live in the freedesktop Secret Service, reusing the
//! Companion keyring seam from T19: one service, one account per secret name,
//! never a plaintext or weakly protected file.
//!
//! The action semantics mirror the PowerShell helper so callers keep behaving
//! the same way: `initialize` touches no secret, `write` refuses empty or
//! oversized input, `read` fails when nothing is stored, `remove` is idempotent.

use crate::companion_keyring::{decode_identity, encode_identity, KeyringFailure, SecretBackend};
use zeroize::Zeroizing;

/// The plugin's own service entry, next to the Companion Gateway's.
pub(crate) const SERVICE: &str = "app.luckyray.community-mcp";
pub(crate) const TUNNEL_KEY: &str = "tunnel-key";
pub(crate) const CREDENTIAL: &str = "credential";
/// The helper script refuses anything above 16384 bytes; the same bound applies.
const MAX_SECRET_BYTES: usize = 16_384;
/// The helper script's single failure code, kept for every content problem so
/// the UI and the caller see exactly what Windows reports.
pub(crate) const STORAGE_FAILED: &str = "private-secret-storage-failed";

/// Both keyring refusals carry a code and a message, in the `{code, message}`
/// envelope the rest of the port uses. They always say nothing was modified.
fn keyring_unavailable() -> String {
    serde_json::json!({
        "code": "companion-keyring-unavailable",
        "message": "未找到系统钥匙环，未做任何修改",
    })
    .to_string()
}

fn keyring_locked() -> String {
    serde_json::json!({
        "code": "companion-keyring-locked",
        "message": "系统钥匙环已锁定，未做任何修改",
    })
    .to_string()
}

fn keyring_error(failure: KeyringFailure) -> String {
    match failure {
        KeyringFailure::Unavailable => keyring_unavailable(),
        KeyringFailure::Locked => keyring_locked(),
        // A corrupt entry takes the same path Windows takes when the .dpapi
        // file cannot be decrypted.
        KeyringFailure::Corrupt => STORAGE_FAILED.to_owned(),
    }
}

/// The account name for a secret. The helper only accepts these two names.
pub(crate) fn account(name: &str) -> Result<&'static str, String> {
    match name {
        TUNNEL_KEY => Ok(TUNNEL_KEY),
        CREDENTIAL => Ok(CREDENTIAL),
        _ => Err(STORAGE_FAILED.to_owned()),
    }
}

/// Runs one `secret-store.ps1` action against the keyring.
///
/// `initialize` deliberately touches no secret: the Windows helper only prepares
/// the directory at that point, so Linux has nothing to do and must not create
/// anything either. `read` fails when the entry is missing, exactly like the
/// helper's `ReadAllText` on an absent file.
pub(crate) fn secret(
    backend: &dyn SecretBackend,
    action: &str,
    name: &str,
    input: Option<&[u8]>,
) -> Result<String, String> {
    let account = account(name)?;
    match action {
        "initialize" => Ok(String::new()),
        "write" => {
            let Some(value) = input else {
                return Err(STORAGE_FAILED.to_owned());
            };
            if value.is_empty() || value.len() > MAX_SECRET_BYTES {
                return Err(STORAGE_FAILED.to_owned());
            }
            let encoded = encode_identity(value);
            backend
                .write(encoded.as_bytes())
                .map_err(keyring_error)?;
            Ok(String::new())
        }
        "read" => {
            let Some(encoded) = backend.read().map_err(keyring_error)? else {
                return Err(STORAGE_FAILED.to_owned());
            };
            let decoded = decode_identity(encoded.as_slice()).map_err(keyring_error)?;
            let text = Zeroizing::new(
                std::str::from_utf8(decoded.as_slice())
                    .map_err(|_| STORAGE_FAILED.to_owned())?
                    .to_owned(),
            );
            Ok(text.to_string())
        }
        "remove" => {
            backend.remove().map_err(keyring_error)?;
            Ok(String::new())
        }
        _ => Err(STORAGE_FAILED.to_owned()),
    }
}

/// `status.hasKey` asks the keyring instead of looking for a `*.dpapi` file.
/// Any keyring failure answers `false`, which is the same conservative answer
/// Windows gives when the file is absent; the connect/read path still surfaces
/// the real error.
pub(crate) fn has_key(backend: &dyn SecretBackend, name: &str) -> bool {
    if account(name).is_err() {
        return false;
    }
    matches!(backend.read(), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeBackend {
        value: Mutex<Option<Vec<u8>>>,
        failure: Option<KeyringFailure>,
        writes: Mutex<usize>,
    }

    impl FakeBackend {
        fn empty() -> Self {
            Self { value: Mutex::new(None), failure: None, writes: Mutex::new(0) }
        }
        fn failing(failure: KeyringFailure) -> Self {
            Self { value: Mutex::new(None), failure: Some(failure), writes: Mutex::new(0) }
        }
        fn holding(bytes: &[u8]) -> Self {
            Self {
                value: Mutex::new(Some(bytes.to_vec())),
                failure: None,
                writes: Mutex::new(0),
            }
        }
        fn value(&self) -> Option<Vec<u8>> {
            self.value.lock().expect("fake").clone()
        }
    }

    impl SecretBackend for FakeBackend {
        fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeyringFailure> {
            if let Some(failure) = self.failure {
                return Err(failure);
            }
            Ok(self.value.lock().expect("fake").clone().map(Zeroizing::new))
        }
        fn write(&self, bytes: &[u8]) -> Result<(), KeyringFailure> {
            if let Some(failure) = self.failure {
                return Err(failure);
            }
            *self.writes.lock().expect("fake") += 1;
            *self.value.lock().expect("fake") = Some(bytes.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), KeyringFailure> {
            if let Some(failure) = self.failure {
                return Err(failure);
            }
            *self.value.lock().expect("fake") = None;
            Ok(())
        }
    }

    #[test]
    fn write_read_remove_round_trip_like_the_windows_helper() {
        let backend = FakeBackend::empty();
        // initialize prepares nothing and writes nothing.
        assert_eq!(secret(&backend, "initialize", TUNNEL_KEY, None).unwrap(), "");
        assert!(backend.value().is_none());
        // read on a missing entry fails, exactly like ReadAllText on no file.
        assert_eq!(secret(&backend, "read", TUNNEL_KEY, None), Err(STORAGE_FAILED.into()));
        // write stores an encoded value, never the plaintext bytes.
        secret(&backend, "write", TUNNEL_KEY, Some(b"synthetic-tunnel-key")).unwrap();
        let stored = backend.value().expect("stored");
        assert_ne!(stored.as_slice(), b"synthetic-tunnel-key");
        assert_eq!(secret(&backend, "read", TUNNEL_KEY, None).unwrap(), "synthetic-tunnel-key");
        // remove is idempotent.
        secret(&backend, "remove", TUNNEL_KEY, None).unwrap();
        secret(&backend, "remove", TUNNEL_KEY, None).unwrap();
        assert!(backend.value().is_none());
        assert_eq!(*backend.writes.lock().unwrap(), 1);
    }

    #[test]
    fn input_and_names_are_bounded_like_the_helper() {
        let backend = FakeBackend::empty();
        assert_eq!(secret(&backend, "write", TUNNEL_KEY, None), Err(STORAGE_FAILED.into()));
        assert_eq!(secret(&backend, "write", TUNNEL_KEY, Some(b"")), Err(STORAGE_FAILED.into()));
        let oversized = vec![b'x'; MAX_SECRET_BYTES + 1];
        assert_eq!(secret(&backend, "write", TUNNEL_KEY, Some(&oversized)), Err(STORAGE_FAILED.into()));
        assert_eq!(secret(&backend, "write", "other", Some(b"x")), Err(STORAGE_FAILED.into()));
        assert_eq!(secret(&backend, "delete", TUNNEL_KEY, None), Err(STORAGE_FAILED.into()));
        // The exact bound is accepted.
        let exact = vec![b'x'; MAX_SECRET_BYTES];
        secret(&backend, "write", CREDENTIAL, Some(&exact)).unwrap();
        assert_eq!(backend.value().map(|v| v.len() > 0), Some(true));
    }

    #[test]
    fn keyring_refusals_carry_their_code_and_message() {
        for (failure, code, message) in [
            (KeyringFailure::Unavailable, "companion-keyring-unavailable", "未找到系统钥匙环，未做任何修改"),
            (KeyringFailure::Locked, "companion-keyring-locked", "系统钥匙环已锁定，未做任何修改"),
        ] {
            let backend = FakeBackend::failing(failure);
            for action in ["read", "write", "remove"] {
                let error = secret(&backend, action, TUNNEL_KEY, Some(b"synthetic")).unwrap_err();
                let parsed: serde_json::Value = serde_json::from_str(&error).expect("envelope");
                assert_eq!(parsed["code"], code, "{action}");
                assert_eq!(parsed["message"], message, "{action}");
                assert!(parsed["message"].as_str().unwrap().ends_with("未做任何修改"));
            }
            assert!(!has_key(&backend, TUNNEL_KEY));
        }
    }

    #[test]
    fn a_corrupt_entry_and_bad_utf8_use_the_windows_storage_code() {
        let corrupt = FakeBackend::holding(b"not base64 %%");
        assert_eq!(secret(&corrupt, "read", TUNNEL_KEY, None), Err(STORAGE_FAILED.into()));
        // Valid base64 but not UTF-8 text (0xff is not a text secret).
        let binary = FakeBackend::holding(b"/w==");
        assert_eq!(secret(&binary, "read", TUNNEL_KEY, None), Err(STORAGE_FAILED.into()));
    }

    #[test]
    fn has_key_asks_the_store_and_never_the_filesystem() {
        assert!(!has_key(&FakeBackend::empty(), TUNNEL_KEY));
        assert!(has_key(&FakeBackend::holding(b"c3ludGhldGlj"), TUNNEL_KEY));
        assert!(!has_key(&FakeBackend::failing(KeyringFailure::Unavailable), TUNNEL_KEY));
        assert!(!has_key(&FakeBackend::empty(), "other"));
    }

    #[test]
    fn the_service_and_accounts_are_fixed_product_constants() {
        assert_eq!(SERVICE, "app.luckyray.community-mcp");
        assert_eq!(account(TUNNEL_KEY).unwrap(), "tunnel-key");
        assert_eq!(account(CREDENTIAL).unwrap(), "credential");
    }
}
