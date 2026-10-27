//! Code-only runtime switches keep the existing native-state and AI namespaces
//! in place. Only signed no-migration candidates are admitted. Official DSH
//! owns its lazy persistence migration; we neither copy nor restore user data.
//! Legacy backup receipts remain readable and existing backups stay untouched.
use super::{
    artifact_path, extract_verified_artifact_with_progress,
    safe_runtime_entry, verify_installed_for_this_build, verify_runtime_closure, verify_runtime_layout,
    verify_runtime_closure_with_progress, AdmittedCandidate, ArtifactError, Candidate, MAX_ENVELOPE_BYTES,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

mod bundled;

const STORE_DIRECTORY: &str = "dsh-engine-updates";
const ACTIVE_FILE: &str = "active.json";
const JOURNAL_FILE: &str = "transaction.json";
const PREVIOUS_HEALTHY_FILE: &str = "previous-healthy.json";
const PENDING_FILE: &str = "pending-switch.json";
const QUIESCENT_SWITCH_FILE: &str = "quiescent-switch.json";

#[cfg(windows)]
fn open_writer_lock(path: &Path) -> Result<File, StoreError> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .share_mode(0)
        .open(path)
        .map_err(|_| StoreError::RecoveryRequired)
}

#[cfg(not(windows))]
fn open_writer_lock(path: &Path) -> Result<File, StoreError> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)
        .map_err(|_| StoreError::Io)
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Prepared,
    ActivatedPendingHealth,
    Healthy,
    RecoveryRequired,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema: u8,
    from_version: String,
    to_version: String,
    artifact_sha256: String,
    previous_artifact_sha256: Option<String>,
    // Keep the old serialized key for journal recovery compatibility. New
    // transactions bind a CodeOnlyReceipt here, not a profile backup claim.
    backup_receipt_sha256: String,
    phase: Phase,
}

/// Durable evidence of what the wrapper changed, explicitly not a backup.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeOnlyReceipt {
    schema: u8,
    mode: String,
    from_version: String,
    to_version: String,
    artifact_sha256: String,
    data_compatibility: String,
    profile_namespace: String,
    snapshot_created: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviousHealthyRecord {
    schema: u8,
    pending_artifact_sha256: String,
    journal: Journal,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActiveRecord {
    schema: u8,
    artifact_sha256: String,
    signed_envelope: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRecord {
    schema: u8,
    from_version: String,
    artifact_sha256: String,
    signed_envelope: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QuiescentSwitchRecord {
    schema: u8,
    artifact_sha256: String,
}

fn pending_health_for(
    journal: &Journal,
    active_sha: &str,
    active_version: &str,
) -> Result<bool, StoreError> {
    if journal.artifact_sha256 == active_sha && journal.to_version == active_version {
        return match journal.phase {
            Phase::Healthy => Ok(false),
            Phase::Prepared | Phase::ActivatedPendingHealth => Ok(true),
            Phase::RecoveryRequired => Err(StoreError::RecoveryRequired),
        };
    }
    if journal.phase == Phase::Prepared
        && journal.previous_artifact_sha256.as_deref() == Some(active_sha)
    {
        return Ok(false);
    }
    Err(StoreError::RecoveryRequired)
}

pub(crate) struct PreparedRuntime {
    pub(super) root: PathBuf,
    pub(super) admitted: AdmittedCandidate,
}

pub(crate) struct InstalledRuntime {
    pub(crate) root: PathBuf,
    pub(crate) candidate: Candidate,
    pub(crate) pending_health: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StoreError {
    Invalid,
    Io,
    RecoveryRequired,
}

impl From<ArtifactError> for StoreError {
    fn from(value: ArtifactError) -> Self {
        match value {
            ArtifactError::Invalid => Self::Invalid,
            ArtifactError::Io => Self::Io,
            ArtifactError::WorkerPending => Self::RecoveryRequired,
        }
    }
}

#[derive(Debug)]
pub(crate) struct UpdateStore {
    root: PathBuf,
    // One instance owns this AppData DSH writer namespace at a time. A stale
    // lock file after a crash is harmless; the OS releases the handle.
    #[allow(dead_code)]
    writer_lock: File,
}

impl UpdateStore {
    pub(crate) fn open(app_data: &Path) -> Result<Self, StoreError> {
        if !app_data.is_absolute()
            || !safe_runtime_entry(app_data)
                .map_err(StoreError::from)?
                .is_dir()
        {
            return Err(StoreError::Invalid);
        }
        let root = app_data.join(STORE_DIRECTORY);
        if !root.exists() {
            fs::create_dir(&root).map_err(|_| StoreError::Io)?;
        }
        if !safe_runtime_entry(&root)
            .map_err(StoreError::from)?
            .is_dir()
        {
            return Err(StoreError::Invalid);
        }
        let versions = root.join("versions");
        if !versions.exists() {
            fs::create_dir(&versions).map_err(|_| StoreError::Io)?;
        }
        if !safe_runtime_entry(&versions)
            .map_err(StoreError::from)?
            .is_dir()
        {
            return Err(StoreError::Invalid);
        }
        let writer_lock = open_writer_lock(&root.join("writer.lock"))?;
        Ok(Self { root, writer_lock })
    }

    fn version_path(&self, artifact_sha256: &str) -> Result<PathBuf, StoreError> {
        if artifact_sha256.len() != 64 || !artifact_sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(StoreError::Invalid);
        }
        artifact_path(&self.root.join("versions"), artifact_sha256).map_err(StoreError::from)
    }

    pub(crate) fn new_download_path(&self) -> Result<PathBuf, StoreError> {
        let downloads = self.root.join("downloads");
        if !downloads.exists() {
            fs::create_dir(&downloads).map_err(|_| StoreError::Io)?;
        }
        if !safe_runtime_entry(&downloads)?.is_dir() {
            return Err(StoreError::Invalid);
        }
        // A process interruption may leave a partial download. This locked
        // namespace contains only our exact generated archive names; refuse
        // unfamiliar entries rather than deleting anything user-owned.
        for item in fs::read_dir(&downloads).map_err(|_| StoreError::Io)? {
            let item = item.map_err(|_| StoreError::Io)?;
            let name = item.file_name();
            let name = name.to_str().ok_or(StoreError::Invalid)?;
            let generated = name
                .strip_prefix("artifact-")
                .and_then(|value| value.strip_suffix(".zip"))
                .is_some_and(|hex| hex.len() == 32 && hex.bytes().all(|b| b.is_ascii_hexdigit()));
            if !generated || !safe_runtime_entry(&item.path())?.is_file() {
                return Err(StoreError::RecoveryRequired);
            }
            fs::remove_file(item.path()).map_err(|_| StoreError::Io)?;
        }
        Ok(downloads.join(format!("artifact-{:032x}.zip", rand::random::<u128>())))
    }

    pub(crate) fn pending_switch(&self) -> bool {
        self.root.join(PENDING_FILE).is_file()
    }

    pub(crate) fn preflight_pending_for_this_build(&self, from_version: &str) -> Result<(), StoreError> {
        if self.root.join(QUIESCENT_SWITCH_FILE).exists() { return Err(StoreError::RecoveryRequired); }
        let bytes = fs::read(self.root.join(PENDING_FILE)).map_err(|_| StoreError::RecoveryRequired)?;
        if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES * 2 { return Err(StoreError::RecoveryRequired); }
        let pending: PendingRecord = serde_json::from_slice(&bytes).map_err(|_| StoreError::RecoveryRequired)?;
        if pending.schema != 1 || pending.from_version != from_version { return Err(StoreError::RecoveryRequired); }
        let envelope = URL_SAFE_NO_PAD.decode(pending.signed_envelope).map_err(|_| StoreError::RecoveryRequired)?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| StoreError::Invalid)?.as_secs() as i64;
        let admitted = super::admit_for_this_build(&envelope, from_version, now)
            .map_err(|_| StoreError::RecoveryRequired)?;
        if admitted.candidate.artifact_sha256 != pending.artifact_sha256 { return Err(StoreError::RecoveryRequired); }
        let root = self.version_path(&pending.artifact_sha256)?;
        // Preparation already admitted the full closure; activation checks it
        // again. A quit preflight only checks bounded signed layout metadata.
        verify_runtime_layout(&admitted.candidate, &root).map_err(StoreError::from)?;
        Ok(())
    }

    /// Bind the user's prepared quit to the exact pending record. This is a
    /// small, bounded read; the full closure was checked at preparation and
    /// is checked again before activation on the next process startup.
    pub(crate) fn pending_record_digest(&self) -> Result<String, StoreError> {
        let path = self.root.join(PENDING_FILE);
        if !safe_runtime_entry(&path).map_err(StoreError::from)?.is_file() {
            return Err(StoreError::RecoveryRequired);
        }
        let bytes = fs::read(path).map_err(|_| StoreError::Io)?;
        if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES * 2 {
            return Err(StoreError::RecoveryRequired);
        }
        Ok(format!("{:x}", sha2::Sha256::digest(bytes)))
    }

    /// Cheap status projection for the runtime already seal-verified at this
    /// process startup. Full signed-closure verification remains mandatory
    /// before a health commit; polling status must not rehash 25k files.
    pub(crate) fn selected_pending_health(&self, candidate: Option<&Candidate>) -> Option<bool> {
        let active_path = self.root.join(ACTIVE_FILE);
        match candidate {
            Some(selected) => {
                let bytes = fs::read(&active_path).ok()?;
                if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES * 2 { return None; }
                let active: ActiveRecord = serde_json::from_slice(&bytes).ok()?;
                if active.schema != 1 || active.artifact_sha256 != selected.artifact_sha256 {
                    return None;
                }
                let journal = self.read_journal().ok()??;
                pending_health_for(&journal, &active.artifact_sha256, &selected.version).ok()
            }
            None => {
                if self.has_verified_bundled_active().ok()? { return Some(false); }
                if active_path.exists() { return None; }
                match self.read_journal().ok()? {
                    None => Some(false),
                    Some(journal) if journal.phase == Phase::Prepared && self.pending_switch() => Some(false),
                    _ => None,
                }
            }
        }
    }

    /// Written only by the app's exit path after its owned DSH tree was
    /// confirmed drained. A manual close, crash, or unconfirmed teardown
    /// leaves the candidate staged but cannot activate it on the next boot.
    pub(crate) fn arm_after_confirmed_shutdown(&self) -> Result<(), StoreError> {
        self.arm_after_confirmed_shutdown_if_digest(None)
    }

    pub(crate) fn arm_after_confirmed_shutdown_if_digest(
        &self,
        expected_digest: Option<&str>,
    ) -> Result<(), StoreError> {
        let bytes = fs::read(self.root.join(PENDING_FILE)).map_err(|_| StoreError::RecoveryRequired)?;
        if bytes.is_empty() || bytes.len() > MAX_ENVELOPE_BYTES * 2 {
            return Err(StoreError::RecoveryRequired);
        }
        if expected_digest.is_some_and(|expected| format!("{:x}", sha2::Sha256::digest(&bytes)) != expected) {
            return Err(StoreError::RecoveryRequired);
        }
        let pending: PendingRecord = serde_json::from_slice(&bytes).map_err(|_| StoreError::RecoveryRequired)?;
        if pending.schema != 1 || pending.artifact_sha256.len() != 64
            || !pending.artifact_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StoreError::RecoveryRequired);
        }
        atomic_write_json(&self.root.join(QUIESCENT_SWITCH_FILE), &QuiescentSwitchRecord {
            schema: 1, artifact_sha256: pending.artifact_sha256,
        })
    }

    /// Only the *pending* target may be abandoned. An existing healthy active
    /// engine and its journal stay in place during a second update; a torn
    /// pointer to the pending target never passes this structural gate.
    pub(crate) fn can_abandon_pre_activation(&self) -> bool {
        let pending = self.root.join(PENDING_FILE);
        if !safe_runtime_entry(&pending).is_ok_and(|metadata| metadata.is_file()) {
            return false;
        }
        if self.has_verified_bundled_active().unwrap_or(false) { return true; }
        let journal = match self.read_journal() {
            Ok(journal) => journal,
            Err(_) => return false,
        };
        let active_path = self.root.join(ACTIVE_FILE);
        if !active_path.exists() {
            return matches!(journal, None | Some(Journal { phase: Phase::Prepared, previous_artifact_sha256: None, .. }));
        }
        if !safe_runtime_entry(&active_path).is_ok_and(|metadata| metadata.is_file()) {
            return false;
        }
        let active = fs::read(&active_path).ok()
            .filter(|bytes| !bytes.is_empty() && bytes.len() <= MAX_ENVELOPE_BYTES * 2)
            .and_then(|bytes| serde_json::from_slice::<ActiveRecord>(&bytes).ok());
        let Some(active) = active else { return false; };
        if active.schema != 1 || active.artifact_sha256.len() != 64
            || !active.artifact_sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
        if matches!(journal.as_ref(),
            Some(Journal { phase: Phase::Healthy, artifact_sha256, .. })
                if artifact_sha256 == &active.artifact_sha256
        ) { return true; }
        let pending_record = fs::read(&pending).ok()
            .and_then(|bytes| serde_json::from_slice::<PendingRecord>(&bytes).ok());
        let Some(pending_record) = pending_record else { return false; };
        let Some(previous) = self.read_previous_healthy().ok().flatten() else { return false; };
        if previous.schema != 1 || previous.pending_artifact_sha256 != pending_record.artifact_sha256
            || previous.journal.phase != Phase::Healthy
            || previous.journal.artifact_sha256 != active.artifact_sha256
            || previous.journal.to_version != pending_record.from_version {
            return false;
        }
        match journal.as_ref() {
            Some(current) => current.phase == Phase::Prepared
                && current.artifact_sha256 == pending_record.artifact_sha256
                && current.previous_artifact_sha256.as_deref() == Some(&active.artifact_sha256),
            // A crash after archiving Prepared but before restoring the old
            // journal leaves the exact signed active pointer and backup.
            None => true,
        }
    }

    pub(crate) fn abandon_pre_activation(&self) -> Result<(), StoreError> {
        if !self.can_abandon_pre_activation() {
            return Err(StoreError::RecoveryRequired);
        }
        let bundled = self.has_verified_bundled_active()?;
        // Preserve transaction evidence. A healthy active journal is never
        // moved: doing so would strand an already installed engine.
        let suffix = format!("{:032x}", rand::random::<u128>());
        let journal = self.root.join(JOURNAL_FILE);
        let current = self.read_journal()?;
        if matches!(current, Some(Journal { phase: Phase::Prepared, .. })) {
            let archived = self.root.join(format!("abandoned-{suffix}-journal.json"));
            if bundled {
                // Keep Prepared valid until its atomic replacement with the
                // archived predecessor; interruption must not leave a hole.
                atomic_write_bytes(&archived, &fs::read(&journal).map_err(|_| StoreError::Io)?)?;
            } else {
                fs::rename(&journal, archived).map_err(|_| StoreError::Io)?;
            }
        }
        if bundled {
            self.restore_bundled_journal_after_abandon()?;
        } else if self.root.join(ACTIVE_FILE).exists()
            && !matches!(current, Some(Journal { phase: Phase::Healthy, .. })) {
            let previous = self.read_previous_healthy()?.ok_or(StoreError::RecoveryRequired)?;
            self.write_journal(&previous.journal)?;
        }
        fs::rename(
            self.root.join(PENDING_FILE),
            self.root.join(format!("abandoned-{suffix}-pending.json")),
        )
        .map_err(|_| StoreError::Io)?;
        let marker = self.root.join(QUIESCENT_SWITCH_FILE);
        if marker.exists() { fs::remove_file(marker).map_err(|_| StoreError::Io)?; }
        self.clear_switch_error_marker();
        Ok(())
    }

    /// A verified archive is unpacked into a fresh sibling, then atomically
    /// named by its signed digest. This stage does not touch the active marker
    /// or the existing DSH profile and may be discarded before switch.
    pub(crate) fn prepare_from_archive(
        &self,
        admitted: AdmittedCandidate,
        archive: &Path,
    ) -> Result<PreparedRuntime, StoreError> {
        self.prepare_from_archive_with_progress(admitted, archive, &std::sync::atomic::AtomicBool::new(false),
            &mut |_, _, _| {})
    }

    pub(crate) fn prepare_from_archive_with_progress(
        &self,
        admitted: AdmittedCandidate,
        archive: &Path,
        cancel: &std::sync::atomic::AtomicBool,
        progress: &mut dyn FnMut(&'static str, u64, u64),
    ) -> Result<PreparedRuntime, StoreError> {
        let target = self.version_path(&admitted.candidate.artifact_sha256)?;
        if target.exists() {
            verify_runtime_closure_with_progress(&admitted.candidate, &target, cancel,
                &mut |done, total| progress("verify", done, total))?;
            return Ok(PreparedRuntime {
                root: target,
                admitted,
            });
        }
        let staged = self
            .root
            .join("versions")
            .join(format!(".stage-{:032x}", rand::random::<u128>()));
        let prepared = (|| {
            if admitted.candidate.assembly.is_some() {
                super::assembly::prepare(&admitted, archive, &staged, cancel, progress)?;
            } else {
                extract_verified_artifact_with_progress(&admitted.candidate, archive, &staged, cancel,
                    &mut |done, total| progress("extract", done, total))?;
            }
            verify_runtime_closure_with_progress(&admitted.candidate, &staged, cancel,
                &mut |done, total| progress("verify", done, total))?;
            if cancel.load(std::sync::atomic::Ordering::Acquire) { return Err(StoreError::Io); }
            fs::rename(&staged, &target).map_err(|_| StoreError::Io)?;
            // Same-directory atomic rename does not change admitted bytes.
            // The next full pass is immediately before activation.
            verify_runtime_layout(&admitted.candidate, &target)?;
            Ok::<(), StoreError>(())
        })();
        if prepared.is_err() && !matches!(prepared, Err(StoreError::RecoveryRequired)) && staged.exists() {
            // Only the fresh generated sibling may be removed. No existing
            // version, active profile, or backup is a cleanup target.
            let versions = self.root.join("versions");
            if staged.parent() == Some(versions.as_path())
                && staged.file_name().and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".stage-") && name.len() == 39)
                && safe_runtime_entry(&staged).is_ok_and(|meta| meta.is_dir())
                && staged.canonicalize().ok().is_some_and(|path|
                    versions.canonicalize().ok().is_some_and(|root| path.parent() == Some(root.as_path())))
            {
                let _ = fs::remove_dir_all(&staged);
            }
        }
        prepared?;
        Ok(PreparedRuntime {
            root: target,
            admitted,
        })
    }

    /// Scheduling is safe while the old engine is running: no active pointer
    /// or profile byte changes. The actual switch occurs at the next startup
    /// after the previous process has released this writer lock.
    pub(crate) fn schedule_restart_switch(
        &self,
        prepared: &PreparedRuntime,
        from_version: &str,
    ) -> Result<(), StoreError> {
        self.schedule_restart_switch_with_progress(prepared, from_version, &mut |_, _| {})
    }

    pub(crate) fn schedule_restart_switch_with_progress(
        &self,
        prepared: &PreparedRuntime,
        from_version: &str,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), StoreError> {
        self.schedule_restart_switch_with_bundled_progress(prepared, from_version,
            crate::dsh_runtime_seal::bundled_runtime_version().as_deref(), progress)
    }

    fn schedule_restart_switch_with_bundled(
        &self,
        prepared: &PreparedRuntime,
        from_version: &str,
        bundled_version: Option<&str>,
    ) -> Result<(), StoreError> {
        self.schedule_restart_switch_with_bundled_progress(prepared, from_version,
            bundled_version, &mut |_, _| {})
    }

    fn schedule_restart_switch_with_bundled_progress(
        &self,
        prepared: &PreparedRuntime,
        from_version: &str,
        bundled_version: Option<&str>,
        progress: &mut dyn FnMut(u64, u64),
    ) -> Result<(), StoreError> {
        if self.root.join(PENDING_FILE).exists() {
            let raw = fs::read(self.root.join(PENDING_FILE)).map_err(|_| StoreError::Io)?;
            let existing: PendingRecord =
                serde_json::from_slice(&raw).map_err(|_| StoreError::RecoveryRequired)?;
            return if existing.schema == 1
                && existing.from_version == from_version
                && existing.artifact_sha256 == prepared.admitted.candidate.artifact_sha256
                && URL_SAFE_NO_PAD
                    .decode(existing.signed_envelope)
                    .map_err(|_| StoreError::RecoveryRequired)?
                    == prepared.admitted.signed_envelope
            {
                Ok(())
            } else {
                Err(StoreError::RecoveryRequired)
            };
        }
        verify_runtime_layout(&prepared.admitted.candidate, &prepared.root)?;
        progress(1, 1);
        let active = self.load_active()?;
        if active
            .as_ref()
            .is_some_and(|installed| installed.pending_health)
        {
            return Err(StoreError::RecoveryRequired);
        }
        let current = active
            .as_ref()
            .map(|installed| installed.candidate.version.clone())
            .or_else(|| bundled_version.map(str::to_owned))
            .ok_or(StoreError::Invalid)?;
        if current != from_version
            || !prepared
                .admitted
                .candidate
                .from_versions
                .iter()
                .any(|version| version == from_version)
        {
            return Err(StoreError::Invalid);
        }
        let pending = PendingRecord {
            schema: 1,
            from_version: from_version.to_owned(),
            artifact_sha256: prepared.admitted.candidate.artifact_sha256.clone(),
            signed_envelope: URL_SAFE_NO_PAD.encode(&prepared.admitted.signed_envelope),
        };
        atomic_write_json(&self.root.join(PENDING_FILE), &pending)
    }

    /// Called only at startup, before any DSH host or other profile writer is
    /// admitted. A crash on either side of the atomic pointer write can be
    /// replayed without restoring old user data or launching two engines.
    pub(crate) fn complete_pending_switch(&self, app_data: &Path) -> Result<bool, StoreError> {
        let bundled = crate::dsh_runtime_seal::bundled_runtime_version().ok_or(StoreError::Invalid)?;
        self.complete_pending_switch_with(app_data, &bundled, super::admit_for_this_build)
    }

    /// A successful completion or an explicit abandon clears the redacted
    /// startup failure record; only a fresh failure writes it again.
    fn clear_switch_error_marker(&self) {
        let _ = fs::remove_file(self.root.join(super::SWITCH_ERROR_FILE));
    }

    fn complete_pending_switch_with(
        &self,
        _app_data: &Path,
        bundled_version: &str,
        admit: impl Fn(&[u8], &str, i64) -> Result<AdmittedCandidate, super::AdmissionError>,
    ) -> Result<bool, StoreError> {
        let pending_path = self.root.join(PENDING_FILE);
        if !pending_path.exists() {
            self.clear_switch_error_marker();
            return Ok(false);
        }
        let raw = fs::read(&pending_path).map_err(|_| StoreError::Io)?;
        if raw.is_empty() || raw.len() > MAX_ENVELOPE_BYTES * 2 {
            return Err(StoreError::RecoveryRequired);
        }
        let pending: PendingRecord =
            serde_json::from_slice(&raw).map_err(|_| StoreError::RecoveryRequired)?;
        if pending.schema != 1 {
            return Err(StoreError::RecoveryRequired);
        }
        if let Some(active) = self.load_active()? {
            if active.candidate.artifact_sha256 == pending.artifact_sha256
                && active.candidate.version != pending.from_version
            {
                fs::remove_file(&pending_path).map_err(|_| StoreError::Io)?;
                let marker = self.root.join(QUIESCENT_SWITCH_FILE);
                if marker.exists() { fs::remove_file(marker).map_err(|_| StoreError::Io)?; }
                self.clear_switch_error_marker();
                return Ok(true);
            }
        }
        let envelope = URL_SAFE_NO_PAD
            .decode(&pending.signed_envelope)
            .map_err(|_| StoreError::RecoveryRequired)?;
        let admitted = admit(
            &envelope,
            &pending.from_version,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| StoreError::Invalid)?
                .as_secs() as i64,
        )
        .map_err(|_| StoreError::RecoveryRequired)?;
        if admitted.candidate.artifact_sha256 != pending.artifact_sha256 {
            return Err(StoreError::RecoveryRequired);
        }
        let marker_path = self.root.join(QUIESCENT_SWITCH_FILE);
        if !marker_path.exists() { self.clear_switch_error_marker(); return Ok(false); }
        let marker: QuiescentSwitchRecord = serde_json::from_slice(
            &fs::read(&marker_path).map_err(|_| StoreError::RecoveryRequired)?
        ).map_err(|_| StoreError::RecoveryRequired)?;
        if marker.schema != 1 || marker.artifact_sha256 != pending.artifact_sha256 {
            return Err(StoreError::RecoveryRequired);
        }
        let root = self.version_path(&pending.artifact_sha256)?;
        verify_runtime_layout(&admitted.candidate, &root)?;
        let prepared = PreparedRuntime { root, admitted };
        self.activate_after_quiescence_with_bundled(&prepared, &pending.from_version,
            bundled_version)?;
        fs::remove_file(&pending_path).map_err(|_| StoreError::Io)?;
        fs::remove_file(marker_path).map_err(|_| StoreError::Io)?;
        self.clear_switch_error_marker();
        Ok(true)
    }

    /// The caller must already have settled the exact owned host generation,
    /// confirmed no run/draft writer. It never rewrites the profile or AI state.
    /// There is deliberately no implicit fallback to the old runtime after
    /// this marker changes; newer profile writes must never be replayed over.
    fn activate_after_quiescence_with_bundled(
        &self,
        prepared: &PreparedRuntime,
        from_version: &str,
        bundled_version: &str,
    ) -> Result<(), StoreError> {
        let _timing = super::StageTiming::new("activate-runtime");
        if prepared.admitted.candidate.data_compatibility != "no-migration" {
            return Err(StoreError::Invalid);
        }
        // The only full pass at activation. Nothing may launch the staged
        // engine before this admission and the durable active-pointer write.
        verify_runtime_closure(&prepared.admitted.candidate, &prepared.root)?;
        let previous = self.load_active()?;
        if previous
            .as_ref()
            .is_some_and(|installed| installed.pending_health)
        {
            return Err(StoreError::RecoveryRequired);
        }
        let actual_version = previous
            .as_ref()
            .map(|installed| installed.candidate.version.clone())
            .or_else(|| Some(bundled_version.to_owned()))
            .ok_or(StoreError::Invalid)?;
        if actual_version != from_version
            || !prepared
                .admitted
                .candidate
                .from_versions
                .iter()
                .any(|version| version == from_version)
            || semver::Version::parse(&prepared.admitted.candidate.version)
                .map_err(|_| StoreError::Invalid)?
                <= semver::Version::parse(from_version).map_err(|_| StoreError::Invalid)?
        {
            return Err(StoreError::Invalid);
        }
        let previous_artifact_sha256 =
            previous.map(|installed| installed.candidate.artifact_sha256);
        let receipt_sha256 = self.write_code_only_receipt(&prepared.admitted.candidate, from_version)?;
        let journal = Journal {
            schema: 1,
            from_version: from_version.to_owned(),
            to_version: prepared.admitted.candidate.version.clone(),
            artifact_sha256: prepared.admitted.candidate.artifact_sha256.clone(),
            previous_artifact_sha256,
            backup_receipt_sha256: receipt_sha256,
            phase: Phase::Prepared,
        };
        self.write_prepared_journal(&journal)?;
        let active = ActiveRecord {
            schema: 1,
            artifact_sha256: prepared.admitted.candidate.artifact_sha256.clone(),
            signed_envelope: URL_SAFE_NO_PAD.encode(&prepared.admitted.signed_envelope),
        };
        atomic_write_json(&self.root.join(ACTIVE_FILE), &active)?;
        self.write_journal(&Journal {
            phase: Phase::ActivatedPendingHealth,
            ..journal
        })?;
        Ok(())
    }

    fn write_journal(&self, journal: &Journal) -> Result<(), StoreError> {
        atomic_write_json(&self.root.join(JOURNAL_FILE), journal)
    }

    fn write_prepared_journal(&self, journal: &Journal) -> Result<(), StoreError> {
        if journal.phase != Phase::Prepared { return Err(StoreError::Invalid); }
        if let Some(previous_sha) = journal.previous_artifact_sha256.as_deref() {
            let previous = self.read_journal()?.ok_or(StoreError::RecoveryRequired)?;
            if previous.phase != Phase::Healthy || previous.artifact_sha256 != previous_sha
                || previous.to_version != journal.from_version {
                return Err(StoreError::RecoveryRequired);
            }
            atomic_write_json(&self.root.join(PREVIOUS_HEALTHY_FILE), &PreviousHealthyRecord {
                schema: 1,
                pending_artifact_sha256: journal.artifact_sha256.clone(),
                journal: previous,
            })?;
        }
        self.write_journal(journal)
    }

    fn read_previous_healthy(&self) -> Result<Option<PreviousHealthyRecord>, StoreError> {
        let path = self.root.join(PREVIOUS_HEALTHY_FILE);
        if !path.exists() { return Ok(None); }
        if !safe_runtime_entry(&path)?.is_file() { return Err(StoreError::RecoveryRequired); }
        let bytes = fs::read(path).map_err(|_| StoreError::Io)?;
        if bytes.is_empty() || bytes.len() > 8192 { return Err(StoreError::RecoveryRequired); }
        serde_json::from_slice(&bytes).map(Some).map_err(|_| StoreError::RecoveryRequired)
    }

    fn write_code_only_receipt(&self, candidate: &Candidate, from_version: &str) -> Result<String, StoreError> {
        if candidate.data_compatibility != "no-migration" { return Err(StoreError::Invalid); }
        let receipts = self.root.join("receipts");
        if !receipts.exists() { fs::create_dir(&receipts).map_err(|_| StoreError::Io)?; }
        if !safe_runtime_entry(&receipts)?.is_dir() { return Err(StoreError::Invalid); }
        let receipt = CodeOnlyReceipt {
            schema: 1,
            mode: "code-only-existing-profile".into(),
            from_version: from_version.to_owned(),
            to_version: candidate.version.clone(),
            artifact_sha256: candidate.artifact_sha256.clone(),
            data_compatibility: candidate.data_compatibility.clone(),
            profile_namespace: "existing-native-state-and-ai".into(),
            snapshot_created: false,
        };
        let path = artifact_path(&receipts, &format!("{}.json", candidate.artifact_sha256))?;
        atomic_write_json(&path, &receipt)?;
        let bytes = fs::read(&path).map_err(|_| StoreError::Io)?;
        if serde_json::from_slice::<CodeOnlyReceipt>(&bytes).map_err(|_| StoreError::Invalid)? != receipt {
            return Err(StoreError::Invalid);
        }
        Ok(format!("{:x}", sha2::Sha256::digest(&bytes)))
    }

    /// Startup recovery checks signed metadata, compatibility and fixed layout.
    /// Critical launch bytes are checked by RuntimeIdentityLease; full closure
    /// admission is an install/activation operation, never a daily tree scan.
    /// A torn journal is conservatively pending-health, never old-engine
    /// rollback. Invalid active bytes are an explicit recovery state.
    pub(crate) fn load_active(&self) -> Result<Option<InstalledRuntime>, StoreError> {
        self.load_active_with_verifier(verify_installed_for_this_build)
    }

    fn load_active_with_verifier(&self, verify: impl Fn(&[u8]) -> Result<Candidate, super::AdmissionError>) -> Result<Option<InstalledRuntime>, StoreError> {
        let _timing = super::StageTiming::new("select-installed-runtime");
        if self.has_verified_bundled_active()? { return Ok(None); }
        let active_path = self.root.join(ACTIVE_FILE);
        if !active_path.exists() {
            // Once a switch journal exists, absence of the active pointer is
            // not proof that the old engine may read this profile. The only
            // safe replay is a still-pending pre-pointer transaction.
            return match self.read_journal()? {
                None => Ok(None),
                Some(journal)
                    if journal.phase == Phase::Prepared
                        && self.root.join(PENDING_FILE).is_file() =>
                {
                    Ok(None)
                }
                Some(_) => Err(StoreError::RecoveryRequired),
            };
        }
        let metadata = safe_runtime_entry(&active_path).map_err(|_| StoreError::RecoveryRequired)?;
        if !metadata.is_file() || metadata.len() > (MAX_ENVELOPE_BYTES * 2) as u64 {
            return Err(StoreError::RecoveryRequired);
        }
        let raw = fs::read(&active_path).map_err(|_| StoreError::Io)?;
        if raw.is_empty() || raw.len() > MAX_ENVELOPE_BYTES * 2 {
            return Err(StoreError::RecoveryRequired);
        }
        let active: ActiveRecord =
            serde_json::from_slice(&raw).map_err(|_| StoreError::RecoveryRequired)?;
        if active.schema != 1 {
            return Err(StoreError::RecoveryRequired);
        }
        let envelope = URL_SAFE_NO_PAD
            .decode(active.signed_envelope)
            .map_err(|_| StoreError::RecoveryRequired)?;
        let candidate =
            verify(&envelope).map_err(|_| StoreError::RecoveryRequired)?;
        if active.artifact_sha256 != candidate.artifact_sha256 {
            return Err(StoreError::RecoveryRequired);
        }
        let root = self.version_path(&active.artifact_sha256)?;
        verify_runtime_layout(&candidate, &root).map_err(|_| StoreError::RecoveryRequired)?;
        let pending_health = pending_health_for(
            &self.read_journal()?.ok_or(StoreError::RecoveryRequired)?,
            &active.artifact_sha256,
            &candidate.version,
        )?;
        Ok(Some(InstalledRuntime {
            root,
            candidate,
            pending_health,
        }))
    }

    fn read_journal(&self) -> Result<Option<Journal>, StoreError> {
        let path = self.root.join(JOURNAL_FILE);
        if !path.exists() {
            return Ok(None);
        }
        let bytes = fs::read(path).map_err(|_| StoreError::Io)?;
        if bytes.is_empty() || bytes.len() > 4096 {
            return Err(StoreError::RecoveryRequired);
        }
        let journal: Journal =
            serde_json::from_slice(&bytes).map_err(|_| StoreError::RecoveryRequired)?;
        if journal.schema != 1 || journal.artifact_sha256.len() != 64 {
            return Err(StoreError::RecoveryRequired);
        }
        Ok(Some(journal))
    }

    pub(super) fn mark_healthy(&self, installed: &InstalledRuntime) -> Result<(), StoreError> {
        let mut journal = self.read_journal()?.ok_or(StoreError::RecoveryRequired)?;
        if journal.artifact_sha256 != installed.candidate.artifact_sha256
            || journal.to_version != installed.candidate.version
            || !matches!(
                journal.phase,
                Phase::Prepared | Phase::ActivatedPendingHealth
            )
        {
            return Err(StoreError::RecoveryRequired);
        }
        journal.phase = Phase::Healthy;
        self.write_journal(&journal)
    }
}

fn atomic_write_json<T: Serialize>(target: &Path, value: &T) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(value).map_err(|_| StoreError::Invalid)?;
    atomic_write_bytes(target, &bytes)
}

fn atomic_write_bytes(target: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = target.parent().ok_or(StoreError::Invalid)?;
    let temp = parent.join(format!(".update-{:032x}.tmp", rand::random::<u128>()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| StoreError::Io)?;
    let result = (|| {
        file.write_all(bytes).map_err(|_| StoreError::Io)?;
        file.sync_all().map_err(|_| StoreError::Io)?;
        drop(file);
        replace_file(&temp, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), StoreError> {
    use std::os::windows::ffi::OsStrExt;
    const REPLACE: u32 = 0x1;
    const WRITE_THROUGH: u32 = 0x8;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), REPLACE | WRITE_THROUGH) } == 0 {
        return Err(StoreError::Io);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), StoreError> {
    fs::rename(source, target).map_err(|_| StoreError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires isolated signed frozen rc.2 archive; run with DSH_DEV_FEED_DIR"]
    fn frozen_old_to_new_switch_requires_exit_marker_and_preserves_new_profile_bytes() {
        let directory = PathBuf::from(std::env::var("DSH_DEV_FEED_DIR").unwrap());
        let signed_envelope = fs::read(directory.join("feed.json")).unwrap();
        let public = URL_SAFE_NO_PAD.decode(
            fs::read_to_string(directory.join("dev-public-key.txt")).unwrap().trim()
        ).unwrap();
        let admit = |envelope: &[u8], from: &str, now: i64| {
            super::super::admit_with_contract(
                envelope, Some(&public), Some("https://127.0.0.1:38491/feed.json"),
                from, env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"),
                env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"), now,
            ).map(|candidate| AdmittedCandidate { candidate, signed_envelope: envelope.to_vec() })
        };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let admitted = admit(&signed_envelope, "0.1.5-rc.2", now).unwrap();
        assert_eq!(admitted.version(), "0.1.7-rc.2");
        let scratch = tempfile::tempdir().unwrap();
        let app_data = scratch.path().join("isolated-app-data");
        let sessions = app_data.join("deepseek-harness/native-state/rc8-v1/sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(sessions.join("old.json"), b"old synthetic session").unwrap();
        let store = UpdateStore::open(&app_data).unwrap();
        let prepared = store.prepare_from_archive(admitted,
            &directory.join("dsh-0.1.7-rc.2-win-x64.zip")).unwrap();
        store.schedule_restart_switch_with_bundled(&prepared, "0.1.5-rc.2", Some("0.1.5-rc.2")).unwrap();
        assert!(!store.complete_pending_switch_with(&app_data, "0.1.5-rc.2", &admit).unwrap(),
            "a normal close or crash cannot silently activate a pending engine");
        let entry = prepared.root.join("host/node_modules/@deepseek-ai/dsh/lib/bin.js");
        let original_entry = fs::read(&entry).unwrap();
        fs::write(&entry, b"interrupted unarmed stage").unwrap();
        assert!(!store.complete_pending_switch_with(&app_data, "0.1.5-rc.2", &admit).unwrap(),
            "without a normal-exit marker, startup must not scan or activate the staged tree");
        fs::write(&entry, original_entry).unwrap();
        assert!(!store.root.join(ACTIVE_FILE).exists());
        assert!(!store.root.join("backups").exists());
        store.arm_after_confirmed_shutdown().unwrap();
        assert!(store.complete_pending_switch_with(&app_data, "0.1.5-rc.2", &admit).unwrap());
        assert!(!store.pending_switch());
        assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
        let active: ActiveRecord = serde_json::from_slice(&fs::read(store.root.join(ACTIVE_FILE)).unwrap()).unwrap();
        let installed_envelope = URL_SAFE_NO_PAD.decode(active.signed_envelope).unwrap();
        assert_eq!(super::super::verify_installed_with_contract(
            &installed_envelope, &public, "https://127.0.0.1:38491/feed.json",
            "1.9.3", "0.1.7-rc.2", env!("LUCKYRAY_DSH_ADAPTER_FINGERPRINT"),
            env!("LUCKYRAY_DSH_RESOURCE_GATE_SHA256"),
        ).unwrap().version, "0.1.7-rc.2");
        let installed = InstalledRuntime {
            root: prepared.root, candidate: prepared.admitted.candidate, pending_health: true,
        };
        store.mark_healthy(&installed).unwrap();
        assert_eq!(store.read_journal().unwrap().unwrap().phase, Phase::Healthy);
        fs::write(sessions.join("new.json"), b"new synthetic session").unwrap();
        assert_eq!(fs::read(sessions.join("old.json")).unwrap(), b"old synthetic session");
        assert_eq!(fs::read(sessions.join("new.json")).unwrap(), b"new synthetic session");
        assert!(!store.can_abandon_pre_activation(), "an activated engine must not roll back new data");
        assert!(!store.root.join("backups").exists(), "a code-only switch never snapshots the profile");
        let receipt: CodeOnlyReceipt = serde_json::from_slice(&fs::read(store.root.join("receipts")
            .join(format!("{}.json", installed.candidate.artifact_sha256))).unwrap()).unwrap();
        assert!(!receipt.snapshot_created);
        assert_eq!(receipt.mode, "code-only-existing-profile");

        // A later update may be interrupted after Prepared but before its
        // active pointer changes. Cancellation must reopen the actual signed
        // and closure-verified installed engine, including newer profile data.
        assert!(!store.load_active().unwrap().unwrap().pending_health);
        let next_sha = "c".repeat(64);
        atomic_write_json(&store.root.join(PENDING_FILE), &PendingRecord {
            schema: 1, from_version: "0.1.7-rc.2".into(),
            artifact_sha256: next_sha.clone(), signed_envelope: "synthetic pending only".into(),
        }).unwrap();
        store.write_prepared_journal(&Journal {
            schema: 1, from_version: "0.1.7-rc.2".into(), to_version: "0.1.7-rc.3".into(),
            artifact_sha256: next_sha,
            previous_artifact_sha256: Some(installed.candidate.artifact_sha256.clone()),
            backup_receipt_sha256: "d".repeat(64), phase: Phase::Prepared,
        }).unwrap();
        store.abandon_pre_activation().unwrap();
        assert!(!store.load_active().unwrap().unwrap().pending_health);
        drop(store);
        let reopened = UpdateStore::open(&app_data).unwrap();
        assert_eq!(reopened.load_active().unwrap().unwrap().candidate.version, "0.1.7-rc.2");
        assert_eq!(fs::read(sessions.join("new.json")).unwrap(), b"new synthetic session");
    }
    #[test]
    fn no_active_marker_never_claims_a_new_runtime() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        assert!(store.load_active().unwrap().is_none());
        #[cfg(windows)]
        assert!(matches!(
            UpdateStore::open(temp.path()),
            Err(StoreError::RecoveryRequired)
        ));
    }

    #[test]
    fn prepared_exit_identity_changes_if_pending_record_is_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let pending = store.root.join(PENDING_FILE);
        fs::write(&pending, b"synthetic pending A").unwrap();
        let prepared = store.pending_record_digest().unwrap();
        fs::write(&pending, b"synthetic pending B").unwrap();
        assert_ne!(prepared, store.pending_record_digest().unwrap());
        assert!(matches!(store.arm_after_confirmed_shutdown_if_digest(Some(&prepared)),
            Err(StoreError::RecoveryRequired)));
        assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
    }

    #[test]
    fn interrupted_download_cleanup_touches_only_generated_archive() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let orphan = store.new_download_path().unwrap();
        fs::write(&orphan, b"partial synthetic archive").unwrap();
        let next = store.new_download_path().unwrap();
        assert!(!orphan.exists());
        assert_ne!(next, orphan);
        let unrelated = store.root.join("downloads/keep.txt");
        fs::write(&unrelated, b"not an updater archive").unwrap();
        assert!(matches!(
            store.new_download_path(),
            Err(StoreError::RecoveryRequired)
        ));
        assert_eq!(fs::read(unrelated).unwrap(), b"not an updater archive");
    }

    #[test]
    fn torn_or_untrusted_marker_fails_closed() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        atomic_write_json(
            &store.root.join(ACTIVE_FILE),
            &ActiveRecord {
                schema: 1,
                artifact_sha256: "a".repeat(64),
                signed_envelope: "not-signed".into(),
            },
        )
        .unwrap();
        assert!(matches!(
            store.load_active(),
            Err(StoreError::RecoveryRequired)
        ));
    }

    #[test]
    fn missing_active_pointer_after_activation_never_reopens_bundled_engine() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let journal = Journal {
            schema: 1,
            from_version: "0.1.7-rc.1".into(),
            to_version: "0.1.7-rc.2".into(),
            artifact_sha256: "a".repeat(64),
            previous_artifact_sha256: None,
            backup_receipt_sha256: "b".repeat(64),
            phase: Phase::ActivatedPendingHealth,
        };
        store.write_journal(&journal).unwrap();
        assert!(matches!(
            store.load_active(),
            Err(StoreError::RecoveryRequired)
        ));
    }

    #[test]
    fn untrusted_pending_switch_never_changes_the_active_engine() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        atomic_write_json(
            &store.root.join(PENDING_FILE),
            &PendingRecord {
                schema: 1,
                from_version: "0.1.7-rc.1".into(),
                artifact_sha256: "a".repeat(64),
                signed_envelope: "not-signed".into(),
            },
        )
        .unwrap();
        assert!(matches!(
            store.complete_pending_switch(temp.path()),
            Err(StoreError::RecoveryRequired)
        ));
        assert!(!store.root.join(ACTIVE_FILE).exists());
    }

    #[test]
    fn pre_activation_pending_can_be_abandoned_without_touching_profile() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let profile = temp
            .path()
            .join("deepseek-harness/native-state/rc8-v1/sessions");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("one.json"), b"new synthetic data").unwrap();
        fs::write(store.root.join(PENDING_FILE), b"expired synthetic envelope").unwrap();
        assert!(store.can_abandon_pre_activation());
        store.abandon_pre_activation().unwrap();
        assert!(!store.pending_switch());
        assert!(store.load_active().unwrap().is_none());
        assert_eq!(
            fs::read(profile.join("one.json")).unwrap(),
            b"new synthetic data"
        );
        assert_eq!(
            fs::read_dir(&store.root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("abandoned-"))
                .count(),
            1
        );
    }

    #[test]
    fn only_a_confirmed_exit_can_arm_the_exact_staged_target() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        assert!(store.arm_after_confirmed_shutdown().is_err());
        assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
        atomic_write_json(&store.root.join(PENDING_FILE), &PendingRecord {
            schema: 1, from_version: "0.1.5-rc.2".into(),
            artifact_sha256: "a".repeat(64), signed_envelope: "synthetic".into(),
        }).unwrap();
        store.arm_after_confirmed_shutdown().unwrap();
        let armed: QuiescentSwitchRecord = serde_json::from_slice(
            &fs::read(store.root.join(QUIESCENT_SWITCH_FILE)).unwrap()
        ).unwrap();
        assert_eq!(armed.artifact_sha256, "a".repeat(64));
        store.abandon_pre_activation().unwrap();
        assert!(!store.root.join(QUIESCENT_SWITCH_FILE).exists());
        assert!(!store.pending_switch());
    }

    #[test]
    fn selected_runtime_health_projection_tracks_journal_without_rehashing_profile() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        assert_eq!(store.selected_pending_health(None), Some(false));
        let candidate = Candidate {
            schema: 1, channel: "preview".into(), runtime_package: "@deepseek-ai/dsh".into(),
            issued_at: 1, expires_at: 2, host_version: "1.9.3".into(),
            adapter_fingerprint: "c".repeat(64), platform: "windows-x86_64".into(),
            from_versions: vec!["0.1.5-rc.2".into()], version: "0.1.7-rc.2".into(),
            node_sha256: "d".repeat(64), entry_sha256: "e".repeat(64),
            artifact_url: "https://example.test/rc2.zip".into(),
            artifact_sha256: "a".repeat(64), artifact_bytes: 1,
            closure_sha256: "f".repeat(64), closure_file_count: 1,
            data_compatibility: "no-migration".into(), resource_gate_sha256: "0".repeat(64), compatibility: None, upstream: None, assembly: None,
        };
        atomic_write_json(&store.root.join(ACTIVE_FILE), &ActiveRecord {
            schema: 1, artifact_sha256: candidate.artifact_sha256.clone(),
            signed_envelope: "synthetic".into(),
        }).unwrap();
        let mut journal = Journal {
            schema: 1, from_version: "0.1.5-rc.2".into(),
            to_version: candidate.version.clone(),
            artifact_sha256: candidate.artifact_sha256.clone(),
            previous_artifact_sha256: None,
            backup_receipt_sha256: "b".repeat(64),
            phase: Phase::ActivatedPendingHealth,
        };
        store.write_journal(&journal).unwrap();
        assert_eq!(store.selected_pending_health(Some(&candidate)), Some(true));
        journal.phase = Phase::Healthy;
        store.write_journal(&journal).unwrap();
        assert_eq!(store.selected_pending_health(Some(&candidate)), Some(false));
        assert_eq!(store.selected_pending_health(None), None);
    }

    #[test]
    fn healthy_active_can_abandon_a_second_unactivated_pending_without_profile_restore() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let profile = temp.path().join("deepseek-harness/native-state/rc8-v1/sessions");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("newer.json"), b"new data from the installed engine").unwrap();
        let active_sha = "a".repeat(64);
        atomic_write_json(&store.root.join(ACTIVE_FILE), &ActiveRecord {
            schema: 1, artifact_sha256: active_sha.clone(), signed_envelope: "synthetic".into(),
        }).unwrap();
        store.write_journal(&Journal {
            schema: 1, from_version: "0.1.7-rc.1".into(), to_version: "0.1.7-rc.2".into(),
            artifact_sha256: active_sha, previous_artifact_sha256: None,
            backup_receipt_sha256: "b".repeat(64), phase: Phase::Healthy,
        }).unwrap();
        fs::write(store.root.join(PENDING_FILE), b"second synthetic pending").unwrap();
        assert!(store.can_abandon_pre_activation());
        store.abandon_pre_activation().unwrap();
        assert!(store.root.join(ACTIVE_FILE).is_file());
        assert_eq!(store.read_journal().unwrap().unwrap().phase, Phase::Healthy);
        assert_eq!(fs::read(profile.join("newer.json")).unwrap(), b"new data from the installed engine");
    }

    #[test]
    fn second_prepared_cancellation_restores_the_prior_healthy_journal() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let old_sha = "a".repeat(64);
        let next_sha = "c".repeat(64);
        atomic_write_json(&store.root.join(ACTIVE_FILE), &ActiveRecord {
            schema: 1, artifact_sha256: old_sha.clone(), signed_envelope: "synthetic".into(),
        }).unwrap();
        let old_journal = Journal {
            schema: 1, from_version: "0.1.7-rc.1".into(), to_version: "0.1.7-rc.2".into(),
            artifact_sha256: old_sha.clone(), previous_artifact_sha256: None,
            backup_receipt_sha256: "b".repeat(64), phase: Phase::Healthy,
        };
        store.write_journal(&old_journal).unwrap();
        atomic_write_json(&store.root.join(PENDING_FILE), &PendingRecord {
            schema: 1, from_version: "0.1.7-rc.2".into(),
            artifact_sha256: next_sha.clone(), signed_envelope: "synthetic".into(),
        }).unwrap();
        store.write_prepared_journal(&Journal {
            schema: 1, from_version: "0.1.7-rc.2".into(), to_version: "0.1.7-rc.3".into(),
            artifact_sha256: next_sha, previous_artifact_sha256: Some(old_sha.clone()),
            backup_receipt_sha256: "d".repeat(64), phase: Phase::Prepared,
        }).unwrap();
        assert!(store.can_abandon_pre_activation());
        store.abandon_pre_activation().unwrap();
        let restored = store.read_journal().unwrap().unwrap();
        assert_eq!(restored.phase, Phase::Healthy);
        assert_eq!(restored.artifact_sha256, old_sha);
        assert!(store.root.join(ACTIVE_FILE).is_file());
    }

    #[test]
    fn interrupted_second_cancellation_replays_exact_prior_journal() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let old_sha = "a".repeat(64);
        let next_sha = "c".repeat(64);
        atomic_write_json(&store.root.join(ACTIVE_FILE), &ActiveRecord {
            schema: 1, artifact_sha256: old_sha.clone(), signed_envelope: "synthetic".into(),
        }).unwrap();
        store.write_journal(&Journal {
            schema: 1, from_version: "0.1.7-rc.1".into(), to_version: "0.1.7-rc.2".into(),
            artifact_sha256: old_sha.clone(), previous_artifact_sha256: None,
            backup_receipt_sha256: "b".repeat(64), phase: Phase::Healthy,
        }).unwrap();
        atomic_write_json(&store.root.join(PENDING_FILE), &PendingRecord {
            schema: 1, from_version: "0.1.7-rc.2".into(),
            artifact_sha256: next_sha.clone(), signed_envelope: "synthetic".into(),
        }).unwrap();
        store.write_prepared_journal(&Journal {
            schema: 1, from_version: "0.1.7-rc.2".into(), to_version: "0.1.7-rc.3".into(),
            artifact_sha256: next_sha, previous_artifact_sha256: Some(old_sha.clone()),
            backup_receipt_sha256: "d".repeat(64), phase: Phase::Prepared,
        }).unwrap();
        fs::rename(store.root.join(JOURNAL_FILE), store.root.join("abandoned-crash-journal.json")).unwrap();
        assert!(store.can_abandon_pre_activation());
        store.abandon_pre_activation().unwrap();
        assert_eq!(store.read_journal().unwrap().unwrap().artifact_sha256, old_sha);
        assert!(!store.pending_switch());
    }

    #[test]
    fn activated_journal_cannot_abandon_pending_or_reopen_old_engine() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        fs::write(store.root.join(PENDING_FILE), b"expired synthetic envelope").unwrap();
        store
            .write_journal(&Journal {
                schema: 1,
                from_version: "0.1.7-rc.1".into(),
                to_version: "0.1.7-rc.2".into(),
                artifact_sha256: "a".repeat(64),
                previous_artifact_sha256: None,
                backup_receipt_sha256: "b".repeat(64),
                phase: Phase::ActivatedPendingHealth,
            })
            .unwrap();
        assert!(!store.can_abandon_pre_activation());
        assert!(matches!(
            store.abandon_pre_activation(),
            Err(StoreError::RecoveryRequired)
        ));
        assert!(store.pending_switch());
        assert!(matches!(
            store.load_active(),
            Err(StoreError::RecoveryRequired)
        ));
    }

    #[test]
    fn interrupted_pre_pointer_journal_can_be_archived_without_rollback() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        fs::write(store.root.join(PENDING_FILE), b"synthetic pending").unwrap();
        store
            .write_journal(&Journal {
                schema: 1,
                from_version: "0.1.7-rc.1".into(),
                to_version: "0.1.7-rc.2".into(),
                artifact_sha256: "a".repeat(64),
                previous_artifact_sha256: None,
                backup_receipt_sha256: "b".repeat(64),
                phase: Phase::Prepared,
            })
            .unwrap();
        assert!(store.can_abandon_pre_activation());
        store.abandon_pre_activation().unwrap();
        assert!(store.load_active().unwrap().is_none());
        assert!(!store.root.join(JOURNAL_FILE).exists());
        assert!(!store.root.join(PENDING_FILE).exists());
        assert_eq!(
            fs::read_dir(&store.root)
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("abandoned-"))
                .count(),
            2
        );
    }

    #[test]
    fn journal_replacement_preserves_one_exact_record() {
        let temp = tempfile::tempdir().unwrap();
        let store = UpdateStore::open(temp.path()).unwrap();
        let mut journal = Journal {
            schema: 1,
            from_version: "0.1.7-rc.1".into(),
            to_version: "0.1.7-rc.2".into(),
            artifact_sha256: "b".repeat(64),
            previous_artifact_sha256: None,
            backup_receipt_sha256: "c".repeat(64),
            phase: Phase::Prepared,
        };
        store.write_journal(&journal).unwrap();
        journal.phase = Phase::ActivatedPendingHealth;
        store.write_journal(&journal).unwrap();
        assert_eq!(
            store.read_journal().unwrap().unwrap().phase,
            Phase::ActivatedPendingHealth
        );
    }

    #[test]
    fn interrupted_switch_never_guesses_a_rollback() {
        let mut journal = Journal {
            schema: 1,
            from_version: "0.1.7-rc.1".into(),
            to_version: "0.1.7-rc.2".into(),
            artifact_sha256: "b".repeat(64),
            previous_artifact_sha256: Some("a".repeat(64)),
            backup_receipt_sha256: "c".repeat(64),
            phase: Phase::Prepared,
        };
        assert_eq!(
            pending_health_for(&journal, &"a".repeat(64), "0.1.7-rc.1"),
            Ok(false)
        );
        assert_eq!(
            pending_health_for(&journal, &"b".repeat(64), "0.1.7-rc.2"),
            Ok(true)
        );
        journal.phase = Phase::ActivatedPendingHealth;
        assert_eq!(
            pending_health_for(&journal, &"a".repeat(64), "0.1.7-rc.1"),
            Err(StoreError::RecoveryRequired)
        );
        assert_eq!(
            pending_health_for(&journal, &"b".repeat(64), "0.1.7-rc.2"),
            Ok(true)
        );
    }
}

#[cfg(all(test, windows, feature = "browser-host-runtime"))]
mod qualified_version_proof;

#[cfg(test)]
mod code_only_switch_tests;
