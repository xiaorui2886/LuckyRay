//! Desktop-install adoption is distinct from the signed online catalog. Its
//! target is exclusively the compiled bundle seal. Never accept a target path,
//! version, digest, or data-compatibility claim from a local pointer.
use super::*;
use crate::dsh_runtime_seal::BundledRuntimeIdentity;

const BUNDLED_ACTIVE_SCHEMA: u8 = 2;
const BUNDLED_KIND: &str = "sealed-desktop-bundle";
const QUALIFIED_FROM: &[&str] = &["0.2.0-rc.2", "0.2.1-rc.2"];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundledActive {
    schema: u8,
    kind: String,
    version: String,
    launch_manifest_sha256: String,
    runtime_manifest_sha256: String,
    data_compatibility: String,
    previous_active_sha256: Option<String>,
    previous_journal_sha256: Option<String>,
}

fn digest(bytes: &[u8]) -> String { format!("{:x}", sha2::Sha256::digest(bytes)) }

fn read_record(path: &Path) -> Result<Vec<u8>, StoreError> {
    let meta = safe_runtime_entry(path).map_err(|_| StoreError::RecoveryRequired)?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > (MAX_ENVELOPE_BYTES * 2) as u64 {
        return Err(StoreError::RecoveryRequired);
    }
    fs::read(path).map_err(|_| StoreError::Io)
}

impl UpdateStore {
    /// Called while holding the existing single-writer lock, before any host
    /// process can read or write this profile. Only the two reviewed rc.2 data
    /// contracts may advance to this rc.3 bundle. Unknown/newer state blocks.
    pub(crate) fn adopt_desktop_bundle(&self, bundle_root: &Path) -> Result<(), StoreError> {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity()
            .map_err(|_| StoreError::Invalid)?;
        self.adopt_bundle_with(&identity, verify_installed_for_this_build, || {
            super::super::verify_bundled_runtime_closure(&identity, bundle_root).map_err(StoreError::from)
        })
    }

    fn adopt_bundle_with(
        &self,
        identity: &BundledRuntimeIdentity,
        verify: impl Fn(&[u8]) -> Result<Candidate, super::super::AdmissionError>,
        verify_bundle: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<(), StoreError> {
        // This qualification must be explicitly renewed for a later bundle.
        if identity.launch.package_version != "0.2.1-rc.3" {
            return Err(StoreError::RecoveryRequired);
        }
        if self.bundled_active_with(identity, &verify)?.is_some() { return Ok(()); }
        if self.pending_switch() || self.root.join(QUIESCENT_SWITCH_FILE).exists() {
            return Err(StoreError::RecoveryRequired);
        }
        let previous = self.load_active_with_verifier(&verify)?;
        if let Some(installed) = &previous {
            // A separately admitted equal/newer engine remains selected. A
            // desktop reinstall must never downgrade it to its older bundle.
            // Signature and data compatibility were checked by load_active.
            if semver::Version::parse(&installed.candidate.version).map_err(|_| StoreError::RecoveryRequired)?
                >= semver::Version::parse(&identity.launch.package_version).map_err(|_| StoreError::RecoveryRequired)? {
                return Ok(());
            }
            if installed.pending_health || !QUALIFIED_FROM.contains(&installed.candidate.version.as_str())
                || installed.candidate.data_compatibility != "no-migration" {
                return Err(StoreError::RecoveryRequired);
            }
        }
        // No current marker + no journal is the pre-update bundled/clean-install
        // path. A missing pointer after an activation is rejected by load_active.
        let previous_active = previous.as_ref().map(|_| read_record(&self.root.join(ACTIVE_FILE))).transpose()?;
        let previous_journal = previous.as_ref().map(|_| read_record(&self.root.join(JOURNAL_FILE))).transpose()?;
        verify_bundle()?;
        // Immutable copies precede the single atomic commit. An interruption
        // here leaves the old selection untouched. After the commit only this
        // exact bundle may open the profile; there is no old-engine fallback.
        let active_sha = previous_active.as_deref().map(|bytes| self.archive_bundle_record(bytes)).transpose()?;
        let journal_sha = previous_journal.as_deref().map(|bytes| self.archive_bundle_record(bytes)).transpose()?;
        atomic_write_json(&self.root.join(ACTIVE_FILE), &BundledActive {
            schema: BUNDLED_ACTIVE_SCHEMA, kind: BUNDLED_KIND.into(),
            version: identity.launch.package_version.clone(),
            launch_manifest_sha256: identity.launch_manifest_sha256.clone(),
            runtime_manifest_sha256: identity.runtime_manifest_sha256.clone(),
            data_compatibility: "no-migration".into(),
            previous_active_sha256: active_sha, previous_journal_sha256: journal_sha,
        })
        // Keep transaction.json and all versions/data intact. The archive binds
        // its exact previous bytes; the schema-2 active marker also makes older
        // desktop executables fail closed rather than silently downgrade.
    }

    fn archive_bundle_record(&self, bytes: &[u8]) -> Result<String, StoreError> {
        let sha = digest(bytes);
        let dir = self.root.join("desktop-install-history");
        if !dir.exists() { fs::create_dir(&dir).map_err(|_| StoreError::Io)?; }
        if !safe_runtime_entry(&dir)?.is_dir() { return Err(StoreError::RecoveryRequired); }
        let path = dir.join(format!("{sha}.json"));
        if !path.exists() {
            // Publish only the synced complete record. A crash before rename
            // leaves an unrelated temp file and the old active pointer intact;
            // the next boot can repeat this step without losing evidence.
            atomic_write_bytes(&path, bytes)?;
        }
        if read_record(&path)? != bytes { return Err(StoreError::RecoveryRequired); }
        Ok(sha)
    }

    fn archived_bundle_record(&self, sha: &str) -> Result<Vec<u8>, StoreError> {
        if !super::super::hex64(sha) { return Err(StoreError::RecoveryRequired); }
        let dir = self.root.join("desktop-install-history");
        if !safe_runtime_entry(&dir)?.is_dir() { return Err(StoreError::RecoveryRequired); }
        let bytes = read_record(&dir.join(format!("{sha}.json")))?;
        if digest(&bytes) != sha { return Err(StoreError::RecoveryRequired); }
        Ok(bytes)
    }

    fn bundled_active_with(
        &self,
        identity: &BundledRuntimeIdentity,
        verify: impl Fn(&[u8]) -> Result<Candidate, super::super::AdmissionError>,
    ) -> Result<Option<BundledActive>, StoreError> {
        let path = self.root.join(ACTIVE_FILE);
        if !path.exists() { return Ok(None); }
        let raw = read_record(&path)?;
        let header: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| StoreError::RecoveryRequired)?;
        if header["schema"] == 1 { return Ok(None); }
        let active: BundledActive = serde_json::from_slice(&raw).map_err(|_| StoreError::RecoveryRequired)?;
        if active.schema != BUNDLED_ACTIVE_SCHEMA || active.kind != BUNDLED_KIND
            || active.version != identity.launch.package_version
            || active.launch_manifest_sha256 != identity.launch_manifest_sha256
            || active.runtime_manifest_sha256 != identity.runtime_manifest_sha256
            || active.data_compatibility != "no-migration" {
            return Err(StoreError::RecoveryRequired);
        }
        match (&active.previous_active_sha256, &active.previous_journal_sha256) {
            (Some(active_sha), Some(journal_sha)) => {
                let old: ActiveRecord = serde_json::from_slice(&self.archived_bundle_record(active_sha)?)
                    .map_err(|_| StoreError::RecoveryRequired)?;
                let journal: Journal = serde_json::from_slice(&self.archived_bundle_record(journal_sha)?)
                    .map_err(|_| StoreError::RecoveryRequired)?;
                let envelope = URL_SAFE_NO_PAD.decode(old.signed_envelope).map_err(|_| StoreError::RecoveryRequired)?;
                let candidate = verify(&envelope).map_err(|_| StoreError::RecoveryRequired)?;
                if old.schema != 1 || journal.schema != 1 || journal.phase != Phase::Healthy
                    || old.artifact_sha256 != candidate.artifact_sha256
                    || journal.artifact_sha256 != old.artifact_sha256 || journal.to_version != candidate.version
                    || !QUALIFIED_FROM.contains(&candidate.version.as_str()) || candidate.data_compatibility != "no-migration" {
                    return Err(StoreError::RecoveryRequired);
                }
            }
            (None, None) => {},
            _ => return Err(StoreError::RecoveryRequired),
        }
        let journal_path = self.root.join(JOURNAL_FILE);
        let journal_matches = match &active.previous_journal_sha256 {
            Some(sha) => journal_path.exists() && digest(&read_record(&journal_path)?) == *sha,
            None => !journal_path.exists(),
        };
        // Preserve the existing signed online updater's pre-pointer replay.
        // It may replace the predecessor journal only after a pending target
        // was admitted from this exact bundled version.
        if !journal_matches {
            let journal = self.read_journal()?.ok_or(StoreError::RecoveryRequired)?;
            let pending: PendingRecord = serde_json::from_slice(&read_record(&self.root.join(PENDING_FILE))?)
                .map_err(|_| StoreError::RecoveryRequired)?;
            if journal.phase != Phase::Prepared || journal.from_version != active.version
                || journal.previous_artifact_sha256.is_some() || pending.schema != 1
                || pending.from_version != active.version || pending.artifact_sha256 != journal.artifact_sha256 {
                return Err(StoreError::RecoveryRequired);
            }
        }
        Ok(Some(active))
    }

    pub(super) fn has_verified_bundled_active(&self) -> Result<bool, StoreError> {
        let path = self.root.join(ACTIVE_FILE);
        if !path.exists() { return Ok(false); }
        let header: serde_json::Value = serde_json::from_slice(&read_record(&path)?)
            .map_err(|_| StoreError::RecoveryRequired)?;
        if header["schema"] == 1 { return Ok(false); }
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().map_err(|_| StoreError::Invalid)?;
        Ok(self.bundled_active_with(&identity, verify_installed_for_this_build)?.is_some())
    }

    pub(super) fn restore_bundled_journal_after_abandon(&self) -> Result<(), StoreError> {
        let bytes = read_record(&self.root.join(ACTIVE_FILE))?;
        let active: BundledActive = serde_json::from_slice(&bytes).map_err(|_| StoreError::RecoveryRequired)?;
        if let Some(sha) = &active.previous_journal_sha256 {
            // Restore the exact archived bytes, including their serialization:
            // the bundle marker binds this digest, not merely equivalent JSON.
            atomic_write_bytes(&self.root.join(JOURNAL_FILE), &self.archived_bundle_record(sha)?)?;
        } else if self.root.join(JOURNAL_FILE).exists() {
            // A fresh bundle had no predecessor journal. Preserve the newly
            // abandoned Prepared record while restoring that original state.
            fs::rename(self.root.join(JOURNAL_FILE), self.root.join(format!(
                "bundled-abandoned-{:032x}-journal.json", rand::random::<u128>()
            ))).map_err(|_| StoreError::Io)?;
        }
        Ok(())
    }
}

#[cfg(all(test, windows, feature = "browser-host-runtime"))]
mod tests {
    use super::*;
    use super::super::code_only_switch_tests::{semantic_reopen_fixture, user_files};

    fn verify(bytes: &[u8], key: &[u8]) -> Result<Candidate, super::super::super::AdmissionError> {
        super::super::super::verify_installed_with_contract(bytes, key,
            "https://updates.example.test/feed.json", "1.9.9", "0.2.1-rc.3", &"0".repeat(64), &"9".repeat(64))
    }
    fn healthy(store: &UpdateStore, version: &str) -> Vec<u8> {
        let (prepared, key) = semantic_reopen_fixture(store, version);
        store.activate_after_quiescence_with_bundled(&prepared,"0.1.5-rc.2","0.1.5-rc.2").unwrap();
        let installed = store.load_active_with_verifier(|bytes| verify(bytes,&key)).unwrap().unwrap();
        store.mark_healthy(&installed).unwrap();
        key
    }
    #[test]
    fn qualified_rc2_adoption_preserves_signed_records_and_all_data_and_reopens() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        for version in ["0.2.0-rc.2","0.2.1-rc.2"] {
            let temp = tempfile::tempdir().unwrap();
            let original = user_files(temp.path());
            let store = UpdateStore::open(temp.path()).unwrap();
            let key = healthy(&store,version);
            let active = read_record(&store.root.join(ACTIVE_FILE)).unwrap();
            let journal = read_record(&store.root.join(JOURNAL_FILE)).unwrap();
            store.adopt_bundle_with(&identity,|b| verify(b,&key),|| Ok(())).unwrap();
            let record = store.bundled_active_with(&identity,|b| verify(b,&key)).unwrap().unwrap();
            assert_eq!(store.archived_bundle_record(record.previous_active_sha256.as_ref().unwrap()).unwrap(),active);
            assert_eq!(read_record(&store.root.join(JOURNAL_FILE)).unwrap(),journal);
            assert!(serde_json::from_slice::<ActiveRecord>(&read_record(&store.root.join(ACTIVE_FILE)).unwrap()).is_err(),"old EXE must fail closed");
            drop(store);
            let store = UpdateStore::open(temp.path()).unwrap();
            store.adopt_bundle_with(&identity,|b| verify(b,&key),|| panic!("reopen must not rehash installed closure")).unwrap();
            for (path,bytes) in &original { assert_eq!(fs::read(path).unwrap(),*bytes); }
        }
    }
    #[test]
    fn fresh_bundle_has_no_previous_data_or_online_candidate_and_reopens() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        let temp = tempfile::tempdir().unwrap(); let store = UpdateStore::open(temp.path()).unwrap();
        store.adopt_bundle_with(&identity, |_| panic!("no candidate"), || Ok(())).unwrap();
        assert!(store.load_active().unwrap().is_none());
        assert_eq!(store.selected_pending_health(None),Some(false));
        assert!(!store.root.join(JOURNAL_FILE).exists());
        assert!(store.bundled_active_with(&identity, |_| panic!("no candidate")).unwrap().is_some());
    }
    #[test]
    fn fresh_bundle_abandons_unactivated_update_without_stranding_reopen() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let originals = user_files(temp.path());
        let store = UpdateStore::open(temp.path()).unwrap();
        store.adopt_bundle_with(&identity, |_| panic!(), || Ok(())).unwrap();
        let active = read_record(&store.root.join(ACTIVE_FILE)).unwrap();
        atomic_write_json(&store.root.join(PENDING_FILE), &PendingRecord {
            schema: 1, from_version: identity.launch.package_version.clone(),
            artifact_sha256: "b".repeat(64), signed_envelope: "not-activated".into(),
        }).unwrap();
        store.write_journal(&Journal { schema: 1, from_version: identity.launch.package_version.clone(),
            to_version: "0.2.2-rc.1".into(), artifact_sha256: "b".repeat(64),
            previous_artifact_sha256: None, backup_receipt_sha256: "d".repeat(64), phase: Phase::Prepared,
        }).unwrap();
        let prepared = read_record(&store.root.join(JOURNAL_FILE)).unwrap();
        store.abandon_pre_activation().unwrap();
        assert_eq!(read_record(&store.root.join(ACTIVE_FILE)).unwrap(), active);
        assert!(!store.root.join(JOURNAL_FILE).exists());
        assert!(!store.pending_switch());
        assert!(fs::read_dir(&store.root).unwrap().filter_map(Result::ok).any(|entry|
            entry.file_name().to_string_lossy().starts_with("bundled-abandoned-")
                && fs::read(entry.path()).unwrap() == prepared));
        drop(store);
        let store = UpdateStore::open(temp.path()).unwrap();
        store.adopt_bundle_with(&identity, |_| panic!(), || panic!("already verified")).unwrap();
        assert!(store.load_active().unwrap().is_none());
        for (path, bytes) in originals { assert_eq!(fs::read(path).unwrap(), bytes); }
    }
    #[test]
    fn predecessor_journal_restoration_keeps_exact_archived_serialization() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        let temp = tempfile::tempdir().unwrap(); let store = UpdateStore::open(temp.path()).unwrap();
        let key = healthy(&store, "0.2.0-rc.2");
        let value: serde_json::Value = serde_json::from_slice(&read_record(&store.root.join(JOURNAL_FILE)).unwrap()).unwrap();
        let original = serde_json::to_vec_pretty(&value).unwrap();
        fs::write(store.root.join(JOURNAL_FILE), &original).unwrap();
        store.adopt_bundle_with(&identity, |b| verify(b, &key), || Ok(())).unwrap();
        fs::write(store.root.join(JOURNAL_FILE), b"interrupted later update").unwrap();
        store.restore_bundled_journal_after_abandon().unwrap();
        assert_eq!(read_record(&store.root.join(JOURNAL_FILE)).unwrap(), original);
        assert!(store.bundled_active_with(&identity, |b| verify(b, &key)).unwrap().is_some());
    }
    #[test]
    fn pre_commit_interruptions_replay_without_overwriting_old_selection() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        let temp = tempfile::tempdir().unwrap(); let store = UpdateStore::open(temp.path()).unwrap();
        let key = healthy(&store,"0.2.0-rc.2");
        let active = read_record(&store.root.join(ACTIVE_FILE)).unwrap();
        let journal = read_record(&store.root.join(JOURNAL_FILE)).unwrap();
        assert_eq!(store.adopt_bundle_with(&identity,|b|verify(b,&key),||Err(StoreError::Invalid)),Err(StoreError::Invalid));
        assert_eq!(read_record(&store.root.join(ACTIVE_FILE)).unwrap(),active);
        store.archive_bundle_record(&active).unwrap(); // interruption after first archive
        fs::write(store.root.join("desktop-install-history/.update-interrupted.tmp"), b"partial").unwrap();
        store.adopt_bundle_with(&identity,|b|verify(b,&key),||Ok(())).unwrap();
        assert_eq!(read_record(&store.root.join(JOURNAL_FILE)).unwrap(),journal);
        assert!(store.bundled_active_with(&identity,|b|verify(b,&key)).unwrap().is_some());
    }
    #[test]
    fn untrusted_incompatible_or_pending_state_cannot_adopt_and_newer_is_not_downgraded() {
        let identity = crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        for mode in ["signature","journal","pending","archive","unsupported","newer"] {
            let temp = tempfile::tempdir().unwrap(); let store = UpdateStore::open(temp.path()).unwrap();
            let version = match mode { "newer"=>"0.2.2-rc.2","unsupported"=>"0.1.7-rc.2",_=>"0.2.0-rc.2" };
            let key = healthy(&store,version);
            if mode=="journal" { let mut j=store.read_journal().unwrap().unwrap();j.phase=Phase::RecoveryRequired;store.write_journal(&j).unwrap(); }
            if mode=="pending" { fs::write(store.root.join(PENDING_FILE),b"pending preserved").unwrap(); }
            if mode=="archive" {
                let a=read_record(&store.root.join(ACTIVE_FILE)).unwrap(); let sha=store.archive_bundle_record(&a).unwrap();
                fs::write(store.root.join(format!("desktop-install-history/{sha}.json")),b"corrupted").unwrap();
            }
            let before=read_record(&store.root.join(ACTIVE_FILE)).unwrap();
            let selected_key=if mode=="signature" { vec![0;32] } else {key};
            let result=store.adopt_bundle_with(&identity,|b|verify(b,&selected_key),||Ok(()));
            if mode=="newer" { assert!(result.is_ok()); } else { assert!(result.is_err(),"{mode}"); }
            assert_eq!(read_record(&store.root.join(ACTIVE_FILE)).unwrap(),before,"{mode}");
        }
    }
    #[test]
    fn marker_tampering_and_foreign_bundle_do_not_reopen() {
        let identity=crate::dsh_runtime_seal::bundled_runtime_identity().unwrap();
        let temp=tempfile::tempdir().unwrap();let store=UpdateStore::open(temp.path()).unwrap();
        store.adopt_bundle_with(&identity, |_|panic!(),||Ok(())).unwrap();
        let mut other=identity.clone();other.runtime_manifest_sha256="a".repeat(64);
        assert!(store.bundled_active_with(&other, |_|panic!()).is_err());
        let mut record=store.bundled_active_with(&identity, |_|panic!()).unwrap().unwrap();
        record.data_compatibility="future-data-format".into();
        atomic_write_json(&store.root.join(ACTIVE_FILE),&record).unwrap();
        assert!(store.load_active().is_err());
    }
}
