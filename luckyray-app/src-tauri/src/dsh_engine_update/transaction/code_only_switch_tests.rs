//! Synthetic filesystem behavior, not a substitute for the real Windows DSH
//! continuity gate. No signing key, production profile or network is used.
use super::*;
use std::sync::atomic::AtomicBool;

fn fixture(store: &UpdateStore) -> PreparedRuntime {
    let root = store.version_path(&"a".repeat(64)).unwrap();
    let entries = std::collections::BTreeMap::from([
        ("host/node_modules/@deepseek-ai/dsh/lib/bin.js", b"synthetic entry".as_slice()),
        ("host/node_modules/@deepseek-ai/dsh/package.json",
            br#"{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}"#.as_slice()),
        ("host/node_modules/example/index.js", b"synthetic dependency".as_slice()),
        ("node/node.exe", b"synthetic node".as_slice()),
    ]);
    let mut closure = sha2::Sha256::new();
    for (name, bytes) in &entries {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        closure.update(name.as_bytes()); closure.update([0]);
        closure.update(bytes.len().to_string().as_bytes()); closure.update([0]);
        closure.update(format!("{:x}", sha2::Sha256::digest(bytes)).as_bytes()); closure.update(b"\n");
    }
    let candidate: Candidate = serde_json::from_value(serde_json::json!({
        "schema": 1, "channel": "preview", "runtimePackage": "@deepseek-ai/dsh",
        "issuedAt": 1, "expiresAt": 2, "hostVersion": "1.9.5",
        "adapterFingerprint": "b".repeat(64), "platform": "windows-x86_64",
        "fromVersions": ["0.1.5-rc.2"], "version": "0.1.7-rc.2",
        "nodeSha256": format!("{:x}", sha2::Sha256::digest(b"synthetic node")),
        "entrySha256": format!("{:x}", sha2::Sha256::digest(b"synthetic entry")),
        "artifactUrl": "https://updates.example.test/fixture.zip", "artifactSha256": "a".repeat(64),
        "artifactBytes": 1, "closureSha256": format!("{:x}", closure.finalize()),
        "closureFileCount": entries.len(), "dataCompatibility": "no-migration",
        "resourceGateSha256": "c".repeat(64)
    })).unwrap();
    PreparedRuntime { root, admitted: AdmittedCandidate { candidate, signed_envelope: b"synthetic-verifier-input".to_vec() } }
}

fn user_files(app_data: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    [
        "deepseek-harness/native-state/rc8-v1/sessions/session-1/session.v3.jsonl.zstd",
        "deepseek-harness/native-state/rc8-native-surface-v1/sessions/session-2/session.v4.jsonl.zstd",
        "deepseek-harness/native-state/rc8-native-surface-v1/storages/workspace.json",
        "deepseek-harness/native-state/rc8-native-surface-v1/settings.yaml.imported",
        "deepseek-harness/native-state/rc8-native-surface-v1/.credentials.yaml",
        "deepseek-harness/native-state/rc8-native-surface-v1/profiles/web.yaml",
        "deepseek-harness/native-state/rc8-native-surface-v1/profiles/web/node_modules/user-plugin/index.js",
        "deepseek-harness/native-state/rc8-native-surface-v1/AppData/Roaming/user-plugin/state.json",
        "deepseek-harness/native-state/rc8-native-surface-v1/custom-user-file.txt",
        "ai/models.json",
        "ai/conversation-draft.json",
        "dsh-engine-updates/backups/legacy/receipt.json",
        "dsh-engine-updates/backups/legacy/native-state/session.json",
    ].into_iter().enumerate().map(|(index, name)| {
        let path = app_data.join(name);
        let bytes = format!("synthetic preserved user bytes {index}").into_bytes();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();
        (path, bytes)
    }).collect()
}

#[test]
fn code_only_activation_preserves_original_paths_config_plugins_ai_and_legacy_backups() {
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let original = user_files(app_data.path());
    store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").unwrap();
    for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
    assert_eq!(fs::read_dir(store.root.join("backups")).unwrap().count(), 1);
    let receipt_path = store.root.join("receipts").join(format!("{}.json", prepared.admitted.candidate.artifact_sha256));
    let receipt: CodeOnlyReceipt = serde_json::from_slice(&fs::read(&receipt_path).unwrap()).unwrap();
    assert!(!receipt.snapshot_created);
    assert_eq!(receipt.mode, "code-only-existing-profile");
    assert_eq!(store.read_journal().unwrap().unwrap().backup_receipt_sha256,
        super::super::digest_file(&receipt_path).unwrap());
    let installed = store.load_active_with_verifier(|_| Ok(prepared.admitted.candidate.clone())).unwrap().unwrap();
    assert!(installed.pending_health);
    store.mark_healthy(&installed).unwrap();
    drop(store);
    let reopened = UpdateStore::open(app_data.path()).unwrap();
    assert!(!reopened.load_active_with_verifier(|_| Ok(prepared.admitted.candidate.clone())).unwrap().unwrap().pending_health);
    for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
}

#[test]
fn code_only_receipt_is_not_a_migration_or_backup_permission() {
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let mut prepared = fixture(&store);
    prepared.admitted.candidate.data_compatibility = "rewrite-profile".into();
    assert_eq!(store.write_code_only_receipt(&prepared.admitted.candidate, "0.1.5-rc.2"), Err(StoreError::Invalid));
    assert_eq!(store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2"), Err(StoreError::Invalid));
    assert!(!store.root.join(ACTIVE_FILE).exists());
    assert!(!store.root.join("receipts").exists());
}

#[test]
fn interrupted_receipt_before_pointer_can_retry_without_touching_user_state() {
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let original = user_files(app_data.path());
    let first = store.write_code_only_receipt(&prepared.admitted.candidate, "0.1.5-rc.2").unwrap();
    assert!(store.load_active().unwrap().is_none());
    drop(store);
    let store = UpdateStore::open(app_data.path()).unwrap();
    assert_eq!(store.write_code_only_receipt(&prepared.admitted.candidate, "0.1.5-rc.2").unwrap(), first);
    store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").unwrap();
    for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
    // A torn journal after activation must not fall back or create a profile.
    fs::write(store.root.join(JOURNAL_FILE), b"torn").unwrap();
    assert!(matches!(store.load_active_with_verifier(|_| Ok(prepared.admitted.candidate.clone())), Err(StoreError::RecoveryRequired)));
    assert!(!store.can_abandon_pre_activation());
}

#[test]
fn missing_modified_or_extra_runtime_is_rejected_at_activation_without_profile_changes() {
    for mutation in ["missing", "critical", "secondary", "extra"] {
        let app_data = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(app_data.path()).unwrap();
        let prepared = fixture(&store);
        let original = user_files(app_data.path());
        match mutation {
            "missing" => fs::remove_file(prepared.root.join("node/node.exe")).unwrap(),
            "critical" => fs::write(prepared.root.join("node/node.exe"), b"tampered").unwrap(),
            "secondary" => fs::write(prepared.root.join("host/node_modules/example/index.js"), b"tampered").unwrap(),
            _ => fs::write(prepared.root.join("extra.js"), b"tampered").unwrap(),
        }
        assert!(store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").is_err());
        assert!(!store.root.join(ACTIVE_FILE).exists());
        assert!(!store.root.join(JOURNAL_FILE).exists());
        for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
    }
}

#[test]
fn ordinary_selection_intentionally_does_not_hash_or_inventory_dependencies() {
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").unwrap();
    fs::write(prepared.root.join("host/node_modules/example/index.js"), b"post-install modification").unwrap();
    fs::write(prepared.root.join("extra.js"), b"post-install addition").unwrap();
    assert!(verify_runtime_closure(&prepared.admitted.candidate, &prepared.root).is_err());
    assert!(store.load_active_with_verifier(|_| Ok(prepared.admitted.candidate.clone())).unwrap().is_some());
    // Signature verification is never skipped by this cheap path.
    assert!(matches!(store.load_active_with_verifier(|_| Err(super::super::AdmissionError::InvalidManifest)), Err(StoreError::RecoveryRequired)));
    fs::remove_file(prepared.root.join("node/node.exe")).unwrap();
    assert!(matches!(store.load_active_with_verifier(|_| Ok(prepared.admitted.candidate.clone())), Err(StoreError::RecoveryRequired)));
}

#[cfg(windows)]
#[test]
fn critical_identity_pins_paths_checks_bytes_and_releases_on_cancel_and_drop() {
    use crate::dsh_runtime_seal::{RuntimeIdentityLease, RuntimeSealControl, RuntimeSealError};
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let identity = super::super::runtime_launch_identity(&prepared.admitted.candidate);
    let cancelled = AtomicBool::new(false);
    let control = RuntimeSealControl::new(&cancelled);
    let lease = RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).unwrap();
    let node = prepared.root.join("node/node.exe");
    assert!(fs::write(&node, b"blocked").is_err());
    assert!(fs::rename(prepared.root.join("host/node_modules/@deepseek-ai/dsh/lib"), prepared.root.join("moved-lib")).is_err());
    // Explicitly accepted residual risk: secondary modules are not pinned.
    fs::write(prepared.root.join("host/node_modules/example/index.js"), b"changed secondary").unwrap();
    lease.revalidate(&control).unwrap();
    cancelled.store(true, std::sync::atomic::Ordering::Release);
    assert_eq!(lease.revalidate(&control), Err(RuntimeSealError::Cancelled));
    drop(lease);
    cancelled.store(false, std::sync::atomic::Ordering::Release);
    fs::write(&node, b"tampered node").unwrap();
    assert!(RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).is_err());
    fs::write(&node, b"synthetic node").unwrap();
    let package = prepared.root.join("host/node_modules/@deepseek-ai/dsh/package.json");
    fs::write(&package, br#"{"name":"@deepseek-ai/dsh","version":"0.0.0"}"#).unwrap();
    assert!(RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).is_err());
    // Failed acquisition leaves no stale file handle blocking retry.
    fs::write(package, br#"{"name":"@deepseek-ai/dsh","version":"0.1.7-rc.2"}"#).unwrap();
    assert!(RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).is_ok());
}

#[test]
fn receipt_failure_is_pre_activation_and_legacy_journal_schema_still_round_trips() {
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let original = user_files(app_data.path());
    fs::write(store.root.join("receipts"), b"not a directory").unwrap();
    assert!(store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").is_err());
    assert!(!store.root.join(ACTIVE_FILE).exists());
    assert!(!store.root.join(JOURNAL_FILE).exists());
    for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
    let legacy = serde_json::json!({
        "schema": 1, "fromVersion": "0.1.5-rc.2", "toVersion": "0.1.7-rc.2",
        "artifactSha256": "a".repeat(64), "previousArtifactSha256": null,
        "backupReceiptSha256": "d".repeat(64), "phase": "healthy"
    });
    let journal: Journal = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(journal).unwrap(), legacy);
}

#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    // cmd re-parses arguments passed through std::process::Command and rejects
    // this mklink spelling on some Windows setups; PowerShell junctions work
    // everywhere without privileges. Test-infrastructure adaptation only.
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "New-Item", "-ItemType", "Junction"])
        .arg("-Path").arg(link)
        .arg("-Target").arg(target)
        .status().unwrap();
    assert!(status.success(), "isolated fixture junction creation");
}

#[cfg(windows)]
#[test]
fn code_only_switch_does_not_traverse_or_change_unknown_user_junctions() {
    let app_data = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("owned.txt"), b"preserved external user bytes").unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let original = user_files(app_data.path());
    let link = app_data.path().join("deepseek-harness/native-state/rc8-native-surface-v1/custom-user-junction");
    junction(&link, outside.path());
    store.activate_after_quiescence_with_bundled(&prepared, "0.1.5-rc.2", "0.1.5-rc.2").unwrap();
    assert_eq!(fs::read(link.join("owned.txt")).unwrap(), b"preserved external user bytes");
    for (path, bytes) in &original { assert_eq!(fs::read(path).unwrap(), *bytes); }
    // Remove only the fixture junction itself before tempfile cleanup.
    fs::remove_dir(link).unwrap();
    assert!(outside.path().join("owned.txt").exists());
}

#[cfg(windows)]
#[test]
fn critical_launch_rejects_root_and_internal_ancestor_junctions() {
    use crate::dsh_runtime_seal::{RuntimeIdentityLease, RuntimeSealControl};
    let app_data = tempfile::tempdir().unwrap();
    let store = UpdateStore::open(app_data.path()).unwrap();
    let prepared = fixture(&store);
    let identity = super::super::runtime_launch_identity(&prepared.admitted.candidate);
    let cancelled = AtomicBool::new(false);
    let control = RuntimeSealControl::new(&cancelled);
    let alias = app_data.path().join("runtime-alias");
    junction(&alias, &prepared.root);
    assert!(RuntimeIdentityLease::acquire_identity(&alias, &identity, &control).is_err());
    fs::remove_dir(alias).unwrap();
    let lib = prepared.root.join("host/node_modules/@deepseek-ai/dsh/lib");
    let moved = app_data.path().join("moved-lib");
    fs::rename(&lib, &moved).unwrap();
    junction(&lib, &moved);
    assert!(RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).is_err());
    fs::remove_dir(&lib).unwrap();
    fs::rename(moved, lib).unwrap();
    assert!(RuntimeIdentityLease::acquire_identity(&prepared.root, &identity, &control).is_ok());
}
