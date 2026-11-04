//! T43: the production Secret Service backend against a *real* provider.
//!
//! These tests are `#[ignore]`d so a plain `cargo test` (and any machine with a
//! real desktop keyring) never touches a store. CI runs them only through
//! `tests/linux-secret-service-session.sh`, which sets
//! `LUCKYRAY_LIVE_SECRET_SERVICE` and gives them either a throwaway headless
//! gnome-keyring on a private session bus (`present`) or no reachable bus at
//! all (`absent`). Each test refuses to run under the other mode, so a success
//! can never be produced by a missing provider and a refusal can never be
//! produced by a real keyring.
//!
//! Every identity is random synthetic bytes. Assertions never format a secret:
//! only fixed messages and `KeyringFailure` kinds reach the log.

use crate::companion_keyring::{
    decode_identity, encode_identity, KeyringFailure, SecretBackend, SecretServiceBackend,
};
use crate::community_mcp_secret::{self, CREDENTIAL, STORAGE_FAILED, TUNNEL_KEY};

const MODE: &str = "LUCKYRAY_LIVE_SECRET_SERVICE";

fn require_mode(expected: &str) {
    let mode = std::env::var(MODE).unwrap_or_default();
    assert!(
        mode == expected,
        "run through tests/linux-secret-service-session.sh {expected}; {MODE} does not match"
    );
}

/// Random synthetic bytes shaped like the identity document. Never printed.
fn synthetic_identity() -> Vec<u8> {
    use std::io::Read as _;
    let mut random = [0u8; 48];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut random))
        .expect("synthetic randomness");
    let hex: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(r#"{{"instanceId":"synthetic-ci","privateKey":"{hex}"}}"#).into_bytes()
}

/// Reads the raw stored credential, failing with a fixed message only.
fn read_raw(backend: &dyn SecretBackend) -> Option<Vec<u8>> {
    match backend.read() {
        Ok(value) => value.map(|bytes| bytes.to_vec()),
        Err(failure) => panic!("live read refused: {failure:?}"),
    }
}

#[test]
#[ignore = "needs tests/linux-secret-service-session.sh present"]
fn live_present_companion_identity_is_stored_loaded_replaced_and_deleted() {
    require_mode("present");
    // The production entry (fixed service/account) in a throwaway keyring.
    let backend = SecretServiceBackend::new();

    // Start clean; removing a missing credential is not an error.
    assert!(backend.remove().is_ok(), "initial remove must be idempotent");
    assert!(read_raw(&backend).is_none(), "a fresh keyring has no identity");

    let first = synthetic_identity();
    let encoded = encode_identity(&first);
    assert!(backend.write(encoded.as_bytes()).is_ok(), "store refused");
    let stored = read_raw(&backend).expect("stored identity must be readable");
    assert!(stored.as_slice() == encoded.as_bytes(), "stored credential differs from what was written");
    assert!(stored.as_slice() != first.as_slice(), "identity must not be stored as plaintext");
    let loaded = decode_identity(&stored).map_err(|failure| format!("{failure:?}"));
    assert!(
        matches!(&loaded, Ok(bytes) if bytes.as_slice() == first.as_slice()),
        "loaded identity differs from the stored one"
    );

    // A second store replaces the single entry instead of adding an ambiguous one.
    let second = synthetic_identity();
    assert!(second != first, "synthetic identities must differ");
    assert!(backend.write(encode_identity(&second).as_bytes()).is_ok(), "replace refused");
    let replaced = read_raw(&backend).expect("replaced identity must be readable");
    assert!(
        matches!(decode_identity(&replaced), Ok(bytes) if bytes.as_slice() == second.as_slice()),
        "replace did not take effect"
    );

    // Deleting brings back the existing "identity missing" path, twice.
    assert!(backend.remove().is_ok(), "delete refused");
    assert!(read_raw(&backend).is_none(), "identity survived delete");
    assert!(backend.remove().is_ok(), "second delete must be idempotent");
}

#[test]
#[ignore = "needs tests/linux-secret-service-session.sh present"]
fn live_present_corrupt_entry_takes_the_recovery_path_and_is_removable() {
    require_mode("present");
    let backend = SecretServiceBackend::new();
    assert!(backend.write(b"not base64 %%").is_ok(), "store refused");
    let stored = read_raw(&backend).expect("entry must be readable");
    assert!(
        decode_identity(&stored).err() == Some(KeyringFailure::Corrupt),
        "a foreign value must be reported as corrupt"
    );
    assert!(backend.remove().is_ok(), "corrupt entry must be removable");
    assert!(read_raw(&backend).is_none(), "corrupt entry survived delete");
}

#[test]
#[ignore = "needs tests/linux-secret-service-session.sh present"]
fn live_present_community_mcp_secrets_round_trip_through_their_own_accounts() {
    require_mode("present");
    let identity = SecretServiceBackend::new();
    let identity_value = synthetic_identity();
    assert!(identity.write(encode_identity(&identity_value).as_bytes()).is_ok(), "identity store refused");

    for name in [TUNNEL_KEY, CREDENTIAL] {
        let backend = SecretServiceBackend::for_account(community_mcp_secret::SERVICE, name);
        let _ = community_mcp_secret::secret(&backend, "remove", name, None);
        assert!(!community_mcp_secret::has_key(&backend, name), "fresh account must be empty");
        assert!(
            community_mcp_secret::secret(&backend, "read", name, None).err().as_deref() == Some(STORAGE_FAILED),
            "reading a missing plugin secret must fail like the Windows helper"
        );
        let value = String::from_utf8(synthetic_identity()).expect("ascii");
        assert!(
            community_mcp_secret::secret(&backend, "write", name, Some(value.as_bytes())).is_ok(),
            "plugin secret write refused"
        );
        assert!(community_mcp_secret::has_key(&backend, name), "written plugin secret not found");
        assert!(
            matches!(community_mcp_secret::secret(&backend, "read", name, None), Ok(read) if read == value),
            "plugin secret read back differs"
        );
        assert!(community_mcp_secret::secret(&backend, "remove", name, None).is_ok(), "plugin remove refused");
        assert!(!community_mcp_secret::has_key(&backend, name), "plugin secret survived remove");
    }

    // The plugin accounts never touched the Companion identity entry.
    let kept = read_raw(&identity).expect("identity entry must survive plugin operations");
    assert!(
        matches!(decode_identity(&kept), Ok(bytes) if bytes.as_slice() == identity_value.as_slice()),
        "plugin operations changed the Companion identity"
    );
    assert!(identity.remove().is_ok(), "identity cleanup refused");
}

#[test]
#[ignore = "needs tests/linux-secret-service-session.sh absent"]
fn live_absent_without_a_secret_service_every_operation_refuses_unavailable() {
    require_mode("absent");
    let identity = SecretServiceBackend::new();
    assert!(identity.read().err() == Some(KeyringFailure::Unavailable), "read must refuse");
    assert!(
        identity.write(encode_identity(&synthetic_identity()).as_bytes()).err() == Some(KeyringFailure::Unavailable),
        "write must refuse"
    );
    assert!(identity.remove().err() == Some(KeyringFailure::Unavailable), "remove must refuse");

    let plugin = SecretServiceBackend::for_account(community_mcp_secret::SERVICE, TUNNEL_KEY);
    let refusal = community_mcp_secret::secret(&plugin, "write", TUNNEL_KEY, Some(b"synthetic"))
        .err()
        .unwrap_or_default();
    assert!(refusal.contains("\"companion-keyring-unavailable\""), "plugin write must refuse with the unavailable code");
    assert!(refusal.contains("未做任何修改"), "refusal must say nothing was modified");
    assert!(!community_mcp_secret::has_key(&plugin, TUNNEL_KEY), "has_key must answer false");
}
