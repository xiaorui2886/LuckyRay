//! Linux Secret Service access for the Companion identity (T19).
//!
//! Windows protects the desktop identity with DPAPI in a file next to the
//! database. On Linux the owner decision is the freedesktop Secret Service: the
//! same identity bytes live in one fixed service/account entry, and nothing is
//! ever written as a plaintext or weakly protected file.
//!
//! The keyring calls sit behind [`SecretBackend`] so the identity store can be
//! exercised offline with a fake backend, and so the failure kinds the gateway
//! reports are decided here, in one place.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use zeroize::Zeroizing;

/// Stable Secret Service service name. Changing it would orphan every stored
/// identity, so it is a fixed product constant, not a per-install value.
pub(crate) const SERVICE: &str = "app.luckyray.companion-gateway";
/// One credential per installation: the desktop identity document.
pub(crate) const ACCOUNT: &str = "desktop-identity-v1";

/// Why a keyring operation failed, in the terms the gateway reports to the UI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyringFailure {
    /// No session bus, no Secret Service provider, or the store refuses access.
    Unavailable,
    /// The store exists but is locked, or the unlock prompt was dismissed.
    Locked,
    /// The stored value is not the identity we wrote (undecodable, ambiguous).
    Corrupt,
}

/// Encodes the identity document for the keyring. A Secret Service credential is
/// a text secret, so the same bytes Windows protects with DPAPI are base64
/// encoded; nothing about the document itself changes.
pub(crate) fn encode_identity(plaintext: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(BASE64.encode(plaintext))
}

/// Decodes a stored credential back to the identity document. Anything that is
/// not the base64 we wrote is reported as corrupt, which the gateway maps onto
/// its existing "identity missing or corrupt" recovery path.
pub(crate) fn decode_identity(encoded: &[u8]) -> Result<Zeroizing<Vec<u8>>, KeyringFailure> {
    let decoded = BASE64
        .decode(encoded)
        .map_err(|_| KeyringFailure::Corrupt)?;
    if decoded.is_empty() {
        return Err(KeyringFailure::Corrupt);
    }
    Ok(Zeroizing::new(decoded))
}

/// The three operations the identity store needs, and nothing else.
pub(crate) trait SecretBackend: Send + Sync {
    /// `Ok(None)` means "no credential stored yet", exactly like a missing file.
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeyringFailure>;
    fn write(&self, bytes: &[u8]) -> Result<(), KeyringFailure>;
    /// Removing a credential that is not there is not an error, like `rm -f`.
    fn remove(&self) -> Result<(), KeyringFailure>;
}

/// Maps a `keyring` error onto the failure kinds the gateway distinguishes.
///
/// `NoStorageAccess` is the one the crate documents for "access rules, e.g. the
/// credential store is locked", which is exactly the locked/declined case.
/// Everything else (platform failure, no D-Bus, no provider) is "unavailable".
/// `NoEntry` never reaches this function: it is handled as "missing".
pub(crate) fn classify(error: keyring::Error) -> KeyringFailure {
    match error {
        keyring::Error::NoStorageAccess(_) => KeyringFailure::Locked,
        keyring::Error::BadEncoding(_) | keyring::Error::Ambiguous(_) => KeyringFailure::Corrupt,
        // `keyring::Error` is non-exhaustive, so every remaining variant
        // (platform failure, no entry, oversize, invalid) is treated as a
        // refusal to reach the store rather than guessed at.
        _ => KeyringFailure::Unavailable,
    }
}

/// The real backend: one entry in the freedesktop Secret Service, reached
/// through `keyring`'s pure-Rust secret-service backend (zbus, no libdbus).
pub(crate) struct SecretServiceBackend {
    service: &'static str,
    account: String,
}

impl SecretServiceBackend {
    /// The Companion Gateway's desktop identity entry.
    pub(crate) fn new() -> Self {
        Self::for_account(SERVICE, ACCOUNT)
    }

    /// A second product surface keeps its own service/account pair without a
    /// second keyring client: the community MCP plugin secrets use their own
    /// service and one account per secret name.
    pub(crate) fn for_account(service: &'static str, account: &str) -> Self {
        Self {
            service,
            account: account.to_owned(),
        }
    }

    fn entry(&self) -> Result<keyring::Entry, KeyringFailure> {
        keyring::Entry::new(self.service, &self.account).map_err(classify)
    }
}

impl SecretBackend for SecretServiceBackend {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, KeyringFailure> {
        match self.entry()?.get_secret() {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(classify(error)),
        }
    }

    fn write(&self, bytes: &[u8]) -> Result<(), KeyringFailure> {
        self.entry()?.set_secret(bytes).map_err(classify)
    }

    fn remove(&self) -> Result<(), KeyringFailure> {
        match self.entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(classify(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_and_corrupt_are_separated_from_unavailable() {
        // The crate documents NoStorageAccess for "the credential store is
        // locked"; a dismissed unlock prompt lands here too.
        assert_eq!(
            classify(keyring::Error::NoStorageAccess(Box::new(std::io::Error::other(
                "prompt dismissed"
            )))),
            KeyringFailure::Locked
        );
        assert_eq!(
            classify(keyring::Error::PlatformFailure(Box::new(std::io::Error::other(
                "no session bus"
            )))),
            KeyringFailure::Unavailable
        );
        assert_eq!(
            classify(keyring::Error::BadEncoding(vec![0xff, 0xfe])),
            KeyringFailure::Corrupt
        );
        assert_eq!(
            classify(keyring::Error::TooLong("password".into(), 1024)),
            KeyringFailure::Unavailable
        );
        assert_eq!(
            classify(keyring::Error::Invalid("service".into(), "empty".into())),
            KeyringFailure::Unavailable
        );
    }

    #[test]
    fn the_identity_document_round_trips_through_the_keyring_encoding() {
        let document = br#"{"instanceId":"synthetic","privateKey":"synthetic-bytes"}"#;
        let encoded = encode_identity(document);
        assert_ne!(encoded.as_bytes(), document);
        assert_eq!(decode_identity(encoded.as_bytes()).unwrap().as_slice(), document);
        // Empty or non-base64 values are corrupt, never "missing".
        assert_eq!(decode_identity(b"").unwrap_err(), KeyringFailure::Corrupt);
        assert_eq!(decode_identity(b"not base64 %%").unwrap_err(), KeyringFailure::Corrupt);
        // An encoded empty document is still corrupt: an identity is never empty.
        assert_eq!(decode_identity(b"").unwrap_err(), KeyringFailure::Corrupt);
    }

    #[test]
    fn the_service_and_account_are_fixed_product_constants() {
        // Changing these would orphan stored identities, so they are pinned.
        assert_eq!(SERVICE, "app.luckyray.companion-gateway");
        assert_eq!(ACCOUNT, "desktop-identity-v1");
    }
}
