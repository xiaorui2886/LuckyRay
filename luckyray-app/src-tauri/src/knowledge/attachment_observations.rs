//! Bounded, process-local file-object witnesses. Events are hints, never rename authority.
use super::attachments::{
    guard_existing_ancestors, hold_verified_attachment, read_scoped_attachment_bytes,
    AttachmentReadGuard,
};
use super::*;
use std::time::{Duration, Instant};

const MAX_WITNESSES: usize = 256;
const MAX_BATCH_PATHS: usize = 256;
const TTL: Duration = Duration::from_secs(600);

struct Witness {
    file: File,
    object: (u64, u64),
    digest: String,
    version: String,
    unique_basename: bool,
    captured: Instant,
}

#[cfg(test)]
mod tests {
    use super::super::attachment_tests::fixture;
    use super::*;

    #[test]
    fn external_plan_rejects_expiry_epoch_and_target_replacement() {
        for scenario in ["expiry", "epoch", "replacement"] {
            let (service, root, vault) = fixture(scenario);
            std::fs::write(root.join("a.png"), b"media").unwrap();
            std::fs::write(root.join("n.md"), "![[a.png]]").unwrap();
            let active = service.activate_ui_source(&vault.id).unwrap();
            service
                .resolve_vault_attachment(
                    &KnowledgeDocumentRef {
                        vault_id: vault.id.clone(),
                        relative_path: "n.md".into(),
                    },
                    "a.png",
                    true,
                )
                .unwrap();
            std::fs::rename(root.join("a.png"), root.join("b.png")).unwrap();
            let plan = service
                .preview_external_attachment_changes(
                    &vault.id,
                    &["a.png".into(), "b.png".into()],
                    false,
                )
                .unwrap()
                .plan
                .unwrap();
            match scenario {
                "expiry" => {
                    for plan in service
                        .attachment_observations
                        .lock()
                        .unwrap()
                        .plans
                        .values_mut()
                    {
                        plan.captured = Instant::now() - TTL - Duration::from_secs(1);
                    }
                }
                "epoch" => {
                    service.activate_ui_source(&vault.id).unwrap();
                }
                _ => {
                    std::fs::remove_file(root.join("b.png")).unwrap();
                    std::fs::write(root.join("b.png"), b"media").unwrap();
                }
            }
            assert!(
                service
                    .execute_attachment_operation(active.source_epoch, &plan)
                    .is_err(),
                "{scenario}"
            );
            assert_eq!(
                std::fs::read_to_string(root.join("n.md")).unwrap(),
                "![[a.png]]"
            );
        }
    }

    #[test]
    fn external_unresolved_diagnostics_and_partial_resume_remain_reference_only() {
        let (service, root, vault) = fixture("external-resume");
        std::fs::write(root.join("a.png"), b"media").unwrap();
        std::fs::write(root.join("n.md"), "![label][image]\n\n[image]: a.png\n").unwrap();
        let active = service.activate_ui_source(&vault.id).unwrap();
        service
            .resolve_vault_attachment(
                &KnowledgeDocumentRef {
                    vault_id: vault.id.clone(),
                    relative_path: "n.md".into(),
                },
                "a.png",
                true,
            )
            .unwrap();
        std::fs::rename(root.join("a.png"), root.join("b.png")).unwrap();
        let update = service
            .preview_external_attachment_changes(
                &vault.id,
                &["a.png".into(), "b.png".into()],
                false,
            )
            .unwrap();
        let unresolved = update
            .plan
            .expect("unresolved diagnostics must reach caller");
        assert!(!unresolved.issues.is_empty());
        assert!(unresolved.files.is_empty());
        std::fs::write(root.join("n.md"), "![[a.png]]").unwrap();
        std::fs::write(root.join("two.md"), "![[a.png]]").unwrap();
        let plan = service
            .preview_external_attachment_changes(
                &vault.id,
                &["a.png".into(), "b.png".into()],
                false,
            )
            .unwrap()
            .plan
            .unwrap();
        service
            .attachment_fault_after_steps
            .store(1, std::sync::atomic::Ordering::SeqCst);
        let partial = service
            .execute_attachment_operation(active.source_epoch, &plan)
            .unwrap();
        assert_eq!(partial.status, "partial");
        assert_eq!(partial.completed_files, 1);
        service
            .attachment_fault_after_steps
            .store(usize::MAX, std::sync::atomic::Ordering::SeqCst);
        std::fs::write(root.join("b.png"), b"external change").unwrap();
        assert!(service
            .recover_attachment_operation(
                active.source_epoch,
                &vault.id,
                &partial.operation_id,
                false
            )
            .is_err());
        assert_eq!(
            std::fs::read(root.join("b.png")).unwrap(),
            b"external change"
        );
        assert!(!root.join("a.png").exists());
    }

    #[test]
    fn external_hardlink_capture_and_unrelated_events_do_not_authorize_updates() {
        let (service, root, vault) = fixture("external-hardlink");
        std::fs::write(root.join("a.png"), b"media").unwrap();
        std::fs::hard_link(root.join("a.png"), root.join("alias.png")).unwrap();
        std::fs::write(root.join("n.md"), "![[a.png]]").unwrap();
        service.activate_ui_source(&vault.id).unwrap();
        service
            .resolve_vault_attachment(
                &KnowledgeDocumentRef {
                    vault_id: vault.id.clone(),
                    relative_path: "n.md".into(),
                },
                "a.png",
                true,
            )
            .unwrap();
        assert!(service
            .attachment_observations
            .lock()
            .unwrap()
            .files
            .is_empty());
        std::fs::remove_file(root.join("a.png")).unwrap();
        assert!(service
            .preview_external_attachment_changes(
                &vault.id,
                &["a.png".into(), "alias.png".into()],
                false
            )
            .unwrap()
            .plan
            .is_none());
        let outside = format!("{}-other/alias.png", root.display());
        let next = service
            .preview_external_attachment_changes(&vault.id, &[outside, "n.md".into()], false)
            .unwrap();
        assert!(next.changed_paths.is_empty());
        assert_eq!(next.uncertain_count, 0);
    }
}
#[derive(Default)]
pub(super) struct AttachmentObservations {
    identity: String,
    epoch: u64,
    files: HashMap<String, Witness>,
    plans: HashMap<String, ObservedPlan>,
}
struct ObservedPlan {
    captured: Instant,
    moves: Vec<(String, String, (u64, u64))>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAttachmentUpdate {
    pub source_epoch: u64,
    pub plan: Option<AttachmentOperationPlan>,
    pub reference_count: usize,
    pub changed_paths: Vec<String>,
    pub uncertain_count: usize,
}
fn unavailable() -> KnowledgeError {
    error(
        "knowledge-attachment-witness-expired",
        "Attachment identity must be observed again before updating links",
    )
}
fn definitely_missing(path: &Path) -> bool {
    matches!(std::fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
fn open_witness(root: &Path, relative: &str) -> Result<File, KnowledgeError> {
    let relative = safe_relative_path(relative, false)?;
    let _parents = guard_existing_ancestors(root, &root.join(&relative))?;
    let path = safe_existing_file(root, &relative)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1 | 2 | 4).custom_flags(0x00200000);
    }
    options.open(path).map_err(|_| unavailable())
}
fn version(file: &File) -> Result<String, KnowledgeError> {
    let metadata = file.metadata().map_err(|_| unavailable())?;
    Ok(format!("{}-{:?}", metadata.len(), metadata.modified().ok()))
}
impl AttachmentObservations {
    fn bind(&mut self, identity: &str, epoch: u64) {
        if self.identity != identity || self.epoch != epoch {
            self.files.clear();
            self.plans.clear();
            self.identity = identity.into();
            self.epoch = epoch;
        }
        self.files
            .retain(|_, witness| witness.captured.elapsed() < TTL);
        self.plans.retain(|_, plan| plan.captured.elapsed() < TTL);
    }
}
impl KnowledgeService {
    pub(super) fn remember_attachment(
        &self,
        vault: &TrustedVault,
        identity: &KnowledgeTargetIdentity,
        relative: &str,
        inventory: &[String],
    ) -> Result<(), KnowledgeError> {
        if relative.to_ascii_lowercase().ends_with(".md") {
            return Ok(());
        }
        let source = self.ui_source.lock().map_err(|_| unavailable())?;
        if source.active_vault_id.as_deref() != Some(&vault.registration.id) {
            return Ok(());
        }
        let mut state = self
            .attachment_observations
            .lock()
            .map_err(|_| unavailable())?;
        state.bind(&identity.identity_digest, source.epoch);
        let file = open_witness(&vault.root, relative)?;
        let object = index::attachment_object_identity(&file, &vault.root.join(relative))
            .ok_or_else(unavailable)?;
        let current_version = version(&file)?;
        if let Some(old) = state.files.get_mut(relative) {
            if old.object == object && old.version == current_version {
                old.captured = Instant::now();
                return Ok(());
            }
        }
        let content = read_scoped_attachment_bytes(&vault.root, Path::new(relative))?;
        let digest = sha256_hex(&content);
        let _stable = hold_verified_attachment(&vault.root, relative, &digest)?;
        let current_file = open_witness(&vault.root, relative)?;
        if version(&file)? != current_version
            || index::attachment_object_identity(&current_file, &vault.root.join(relative))
                != Some(object)
        {
            return Err(unavailable());
        }
        if state.files.len() >= MAX_WITNESSES && !state.files.contains_key(relative) {
            if let Some(oldest) = state
                .files
                .iter()
                .min_by_key(|(_, value)| value.captured)
                .map(|(key, _)| key.clone())
            {
                state.files.remove(&oldest);
            }
        }
        let basename = relative.rsplit('/').next().unwrap_or(relative);
        let unique_basename = inventory
            .iter()
            .filter(|path| {
                path.rsplit('/')
                    .next()
                    .is_some_and(|name| name.eq_ignore_ascii_case(basename))
            })
            .count()
            == 1;
        state.files.insert(
            relative.into(),
            Witness {
                file,
                object,
                digest,
                version: current_version,
                unique_basename,
                captured: Instant::now(),
            },
        );
        Ok(())
    }

    pub(crate) fn preview_external_attachment_changes(
        &self,
        vault_id: &str,
        paths: &[String],
        incomplete: bool,
    ) -> Result<ExternalAttachmentUpdate, KnowledgeError> {
        if paths.len() > MAX_BATCH_PATHS
            || paths.iter().map(String::len).sum::<usize>() > 128 * 1024
        {
            return Err(unavailable());
        }
        let source = self.ui_source.lock().map_err(|_| unavailable())?;
        if source.active_vault_id.as_deref() != Some(vault_id) {
            return Err(knowledge_target_not_current());
        }
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        let mut state = self
            .attachment_observations
            .lock()
            .map_err(|_| unavailable())?;
        state.bind(&identity.identity_digest, source.epoch);
        let mut changed = Vec::new();
        for value in paths {
            let path = Path::new(value);
            let normalized = value.replace('\\', "/");
            let normalized = normalized.strip_prefix("//?/").unwrap_or(&normalized);
            let root_text = vault.root.to_string_lossy().replace('\\', "/");
            let root_text = root_text
                .strip_prefix("//?/")
                .unwrap_or(&root_text)
                .trim_end_matches('/');
            let relative = if path.is_absolute() {
                normalized
                    .get(..root_text.len())
                    .filter(|prefix| prefix.eq_ignore_ascii_case(root_text))
                    .and_then(|_| normalized.get(root_text.len()..))
                    .and_then(|tail| tail.strip_prefix('/'))
                    .map(str::to_owned)
            } else {
                Some(normalized.to_owned())
            };
            if let Some(relative) = relative {
                if safe_relative_path(&relative, false).is_ok()
                    && !relative.to_ascii_lowercase().ends_with(".md")
                    && !changed.contains(&relative)
                {
                    changed.push(relative);
                }
            }
        }
        let mut result = ExternalAttachmentUpdate {
            source_epoch: source.epoch,
            plan: None,
            reference_count: 0,
            changed_paths: changed.clone(),
            uncertain_count: usize::from(incomplete),
        };
        if incomplete {
            return Ok(result);
        }
        let candidates = changed
            .iter()
            .filter_map(|relative| {
                let file = open_witness(&vault.root, relative).ok()?;
                let object = index::attachment_object_identity(&file, &vault.root.join(relative))?;
                Some((relative.clone(), file, object))
            })
            .collect::<Vec<_>>();
        let mut moves = Vec::new();
        for (old, witness) in &state.files {
            if !definitely_missing(&vault.root.join(old)) {
                continue;
            }
            if !changed.contains(old)
                && !candidates
                    .iter()
                    .any(|(_, _, object)| *object == witness.object)
            {
                continue;
            }
            // A retained old handle prevents file-id reuse after deletion.
            if index::attachment_object_identity(&witness.file, &vault.root) != Some(witness.object)
            {
                continue;
            }
            let matches = candidates
                .iter()
                .filter(|(_, _, object)| *object == witness.object)
                .collect::<Vec<_>>();
            if matches.len() != 1 {
                result.uncertain_count += 1;
                continue;
            }
            let (new, file, _) = matches[0];
            let bytes = read_scoped_attachment_bytes(&vault.root, Path::new(new))?;
            if sha256_hex(&bytes) != witness.digest
                || index::attachment_object_identity(file, &vault.root.join(new))
                    != Some(witness.object)
            {
                result.uncertain_count += 1;
                continue;
            }
            moves.push((
                old.clone(),
                new.clone(),
                witness.digest.clone(),
                witness.unique_basename,
                witness.object,
            ));
        }
        if moves.is_empty() {
            return Ok(result);
        }
        let (plan, count) = self.plan_external_attachment_references(&vault, &identity, &moves)?;
        self.verify_current_target(&identity, &guard)?;
        if !plan.files.is_empty() || !plan.issues.is_empty() {
            let key = sha256_hex(&serde_json::to_vec(&plan).map_err(|_| unavailable())?);
            if state.plans.len() >= 8 {
                state.plans.clear();
            }
            state.plans.insert(
                key,
                ObservedPlan {
                    captured: Instant::now(),
                    moves: moves
                        .iter()
                        .map(|(old, new, _, _, object)| (old.clone(), new.clone(), *object))
                        .collect(),
                },
            );
            result.plan = Some(plan);
            result.reference_count = count;
        }
        Ok(result)
    }

    pub(super) fn hold_external_plan(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        source_epoch: u64,
    ) -> Result<Vec<AttachmentReadGuard>, KnowledgeError> {
        if operation.kind != "external-reference-update" {
            return Ok(Vec::new());
        }
        let state = self
            .attachment_observations
            .lock()
            .map_err(|_| unavailable())?;
        if state.epoch != source_epoch || state.identity != operation.target_identity {
            return Err(unavailable());
        }
        let mut observed_operation=operation.clone();
        observed_operation.authorization.clear();observed_operation.receipt_authorization.clear();observed_operation.source_epoch=0;
        let key = sha256_hex(&serde_json::to_vec(&observed_operation).map_err(|_| unavailable())?);
        let observed = state
            .plans
            .get(&key)
            .filter(|plan| plan.captured.elapsed() < TTL)
            .ok_or_else(unavailable)?;
        let mut guards = Vec::new();
        for (old, new, object) in &observed.moves {
            if !definitely_missing(&vault.root.join(old)) {
                return Err(unavailable());
            }
            let witness = state
                .files
                .get(old)
                .filter(|w| w.object == *object && w.captured.elapsed() < TTL)
                .ok_or_else(unavailable)?;
            guards.push(hold_verified_attachment(&vault.root, new, &witness.digest)?);
            let file = open_witness(&vault.root, new)?;
            if index::attachment_object_identity(&file, &vault.root.join(new)) != Some(*object) {
                return Err(unavailable());
            }
        }
        Ok(guards)
    }
}
