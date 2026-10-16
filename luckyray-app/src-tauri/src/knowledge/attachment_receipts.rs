//! Persistent local authority for receipts that can access files outside a Vault.
//! The key belongs to application data, never to the portable/user-authored Vault.
use super::attachments::guard_existing_ancestors;
use super::*;

const RECEIPT_KEY_FILE: &str = "attachment-receipt.key";

fn receipt_needs_authority(plan: &AttachmentOperationPlan) -> bool {
    !plan.external_paths.is_empty()
        || !plan.external_dependencies.is_empty()
        || plan.material_relocation.is_some()
        || plan.material_file_move.is_some()
        || plan.material_original_path.is_some()
        || plan.material_revision.is_some()
}

fn authorization(plan: &AttachmentOperationPlan, key: &[u8; 32]) -> Result<String, KnowledgeError> {
    let mut unsigned = plan.clone();
    unsigned.receipt_authorization.clear();
    let payload = serde_json::to_vec(&unsigned).map_err(|_| {
        error(
            "knowledge-recovery-invalid",
            "Cannot encode recovery authorization",
        )
    })?;
    let mut digest = Sha256::new();
    digest.update(key);
    digest.update(Sha256::digest(payload));
    Ok(format!("{:x}", digest.finalize()))
}

impl KnowledgeService {
    fn attachment_receipt_key(&self, create: bool) -> Result<[u8; 32], KnowledgeError> {
        // This is independent of the service mutation lock, which callers may
        // already hold while creating a native receipt. It serializes first use.
        static KEY_IO: OnceLock<Mutex<()>> = OnceLock::new();
        let _io = KEY_IO
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Recovery key lock unavailable"))?;
        let path = self.app_data_dir.join(RECEIPT_KEY_FILE);
        let anchor = self.app_data_dir.ancestors().last().ok_or_else(|| {
            error(
                "knowledge-recovery-key-unavailable",
                "Application data must be absolute",
            )
        })?;
        let _parents = guard_existing_ancestors(anchor, &path)?;
        let directory = filesystem_directory_identity_guard(&self.app_data_dir)
            .map_err(map_filesystem_identity_error)?;
        match std::fs::symlink_metadata(&path) {
            Ok(_) if has_reparse_point(&path)? => {
                return Err(error(
                    "knowledge-path-reparse-forbidden",
                    "Recovery key must not be a linked file",
                ))
            }
            Ok(_) => (),
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => {
                return Err(error(
                    "knowledge-recovery-key-unavailable",
                    "Cannot inspect recovery key path",
                ))
            }
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000);
        }
        let mut file = match options.open(&path) {
            Ok(file) => file,
            Err(failure) if failure.kind() == std::io::ErrorKind::NotFound && create => {
                let key: [u8; 32] = rand::random();
                let mut create_options = OpenOptions::new();
                create_options.read(true).write(true).create_new(true);
                #[cfg(windows)]
                {
                    use std::os::windows::fs::OpenOptionsExt;
                    create_options.share_mode(0).custom_flags(0x00200000);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    create_options.mode(0o600);
                }
                match create_options.open(&path) {
                    Ok(mut created) => {
                        created
                            .write_all(&key)
                            .and_then(|_| created.sync_all())
                            .map_err(|_| {
                                error(
                                    "knowledge-recovery-key-unavailable",
                                    "Cannot persist recovery authorization key",
                                )
                            })?;
                        directory
                            .verify_current_path(&self.app_data_dir)
                            .map_err(map_filesystem_identity_error)?;
                        return Ok(key);
                    }
                    Err(failure) if failure.kind() == std::io::ErrorKind::AlreadyExists => {
                        options.open(&path).map_err(|_| {
                            error(
                                "knowledge-recovery-key-unavailable",
                                "Recovery key is busy; retry the operation",
                            )
                        })?
                    }
                    Err(_) => {
                        return Err(error(
                            "knowledge-recovery-key-unavailable",
                            "Cannot create recovery authorization key",
                        ))
                    }
                }
            }
            Err(_) => {
                return Err(error(
                    "knowledge-recovery-key-unavailable",
                    "Recovery authorization key is unavailable",
                ))
            }
        };
        let metadata = file.metadata().map_err(|_| {
            error(
                "knowledge-recovery-key-unavailable",
                "Cannot inspect recovery key",
            )
        })?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(error(
                    "knowledge-path-reparse-forbidden",
                    "Recovery key must not be a linked file",
                ));
            }
        }
        if !metadata.is_file() || metadata.len() != 32 {
            return Err(error(
                "knowledge-recovery-key-invalid",
                "Recovery authorization key has invalid length",
            ));
        }
        let mut key = [0; 32];
        file.read_exact(&mut key).map_err(|_| {
            error(
                "knowledge-recovery-key-unavailable",
                "Cannot read recovery key",
            )
        })?;
        if has_reparse_point(&path)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Recovery key path changed",
            ));
        }
        directory
            .verify_current_path(&self.app_data_dir)
            .map_err(map_filesystem_identity_error)?;
        Ok(key)
    }

    pub(crate) fn seal_attachment_receipt(
        &self,
        plan: &AttachmentOperationPlan,
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        let key = self.attachment_receipt_key(true)?;
        let mut sealed = plan.clone();
        sealed.receipt_authorization = authorization(&sealed, &key)?;
        Ok(sealed)
    }

    pub(crate) fn verify_attachment_receipt(
        &self,
        plan: &AttachmentOperationPlan,
    ) -> Result<(), KnowledgeError> {
        if plan.receipt_authorization.is_empty() {
            if receipt_needs_authority(plan) {
                return Err(error(
                    "knowledge-recovery-untrusted",
                    "External attachment recovery requires trusted application evidence",
                ));
            }
            return Ok(()); // Compatibility is limited to pre-existing Vault-only operations.
        }
        let key = self.attachment_receipt_key(false)?;
        let expected = authorization(plan, &key)?;
        let supplied = plan.receipt_authorization.as_bytes();
        let valid = supplied.len() == expected.len()
            && supplied
                .iter()
                .zip(expected.as_bytes())
                .fold(0u8, |difference, (a, b)| difference | (a ^ b))
                == 0;
        if !valid {
            return Err(error(
                "knowledge-recovery-untrusted",
                "Recovery evidence changed or belongs to another application profile",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::knowledge::attachment_tests::fixture;

    fn external_plan(
        service: &KnowledgeService,
        root: &Path,
        vault_id: &str,
    ) -> AttachmentOperationPlan {
        let source = root.parent().unwrap().join("receipt-source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("n.md"), "![[image.png]]").unwrap();
        std::fs::write(source.join("image.png"), b"pixels").unwrap();
        service
            .preview_attachment_import_with_policy(vault_id, &source, &["n.md".into()], "", true)
            .unwrap()
    }

    #[test]
    fn receipt_unsigned_external_plan_is_rejected_without_creating_key() {
        let (service, root, vault) = fixture("receipt-unsigned");
        let plan = external_plan(&service, &root, &vault.id);
        assert_eq!(
            service.verify_attachment_receipt(&plan).unwrap_err().code,
            "knowledge-recovery-untrusted"
        );
        assert!(!service.app_data_dir.join(RECEIPT_KEY_FILE).exists());
    }

    #[test]
    fn receipt_key_survives_service_restart_and_rejects_changed_target() {
        let (service, root, vault) = fixture("receipt-restart");
        let plan = external_plan(&service, &root, &vault.id);
        let sealed = service.seal_attachment_receipt(&plan).unwrap();
        let key_path = service.app_data_dir.join(RECEIPT_KEY_FILE);
        let first_key = std::fs::read(&key_path).unwrap();
        assert_eq!(first_key.len(), 32);
        let restarted = KnowledgeService::initialize(&service.app_data_dir).unwrap();
        restarted.verify_attachment_receipt(&sealed).unwrap();
        let again = restarted.seal_attachment_receipt(&plan).unwrap();
        assert_eq!(again.receipt_authorization, sealed.receipt_authorization);
        assert_eq!(std::fs::read(key_path).unwrap(), first_key);
        let mut changed = sealed;
        changed.external_paths[0].1 = root
            .parent()
            .unwrap()
            .join("private.png")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            restarted
                .verify_attachment_receipt(&changed)
                .unwrap_err()
                .code,
            "knowledge-recovery-untrusted"
        );
    }

    #[test]
    fn receipt_invalid_existing_key_is_never_overwritten() {
        let (service, root, vault) = fixture("receipt-invalid-key");
        let plan = external_plan(&service, &root, &vault.id);
        let key_path = service.app_data_dir.join(RECEIPT_KEY_FILE);
        std::fs::write(&key_path, b"invalid").unwrap();
        assert_eq!(
            service.seal_attachment_receipt(&plan).unwrap_err().code,
            "knowledge-recovery-key-invalid"
        );
        assert_eq!(std::fs::read(key_path).unwrap(), b"invalid");
    }

    #[test]
    fn receipt_legacy_vault_only_plan_stays_compatible() {
        let (service, root, vault) = fixture("receipt-legacy");
        let mut plan = external_plan(&service, &root, &vault.id);
        plan.external_paths.clear();
        plan.external_dependencies.clear();
        service.verify_attachment_receipt(&plan).unwrap();
        assert!(!service.app_data_dir.join(RECEIPT_KEY_FILE).exists());
    }

    #[test]
    fn receipt_missing_key_is_not_regenerated_during_verification() {
        let (service, root, vault) = fixture("receipt-missing-key");
        let sealed = service
            .seal_attachment_receipt(&external_plan(&service, &root, &vault.id))
            .unwrap();
        let path = service.app_data_dir.join(RECEIPT_KEY_FILE);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            service.verify_attachment_receipt(&sealed).unwrap_err().code,
            "knowledge-recovery-key-unavailable"
        );
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn receipt_key_rejects_replaced_appdata_junction_without_touching_target() {
        use std::os::windows::process::CommandExt;
        let (service, root, vault) = fixture("receipt-linked-appdata");
        let plan = external_plan(&service, &root, &vault.id);
        let original = service.app_data_dir.with_file_name("app-original");
        let outside = root.parent().unwrap().join("other-app-data");
        assert!(
            original.starts_with(root.parent().unwrap())
                && outside.starts_with(root.parent().unwrap())
        );
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join(RECEIPT_KEY_FILE), [7u8; 32]).unwrap();
        std::fs::rename(&service.app_data_dir, &original).unwrap();
        let result = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&service.app_data_dir)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            service.seal_attachment_receipt(&plan).unwrap_err().code,
            "knowledge-path-reparse-forbidden"
        );
        assert_eq!(
            std::fs::read(outside.join(RECEIPT_KEY_FILE)).unwrap(),
            vec![7u8; 32]
        );
    }
}
