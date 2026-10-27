//! Desktop-owned saved registrations. No discovery scan and no active-root mutation.
use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedRegistration {
    registration: KnowledgeVaultRegistration,
    scope: Option<WorkspaceScopeRecord>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedKnowledgeScope {
    pub vault_key: String,
    pub vault_id: String,
    pub name: String,
    pub available: bool,
}

fn scope_key(scope: &WorkspaceScopeRecord) -> String {
    format!("vault-{:x}", Sha256::digest(format!("{}:{}", scope.target_id, scope.identity_digest).as_bytes()))
}

impl KnowledgeService {
    fn saved_scopes_path(&self) -> PathBuf { self.app_data_dir.join("notes-vaults-saved.json") }

    fn read_saved_registrations(&self) -> Result<Vec<SavedRegistration>, KnowledgeError> {
        match std::fs::read(self.saved_scopes_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error("knowledge-vault-registry-invalid", "Saved Vault registrations are invalid")),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(_) => Err(error("knowledge-vault-registry-unavailable", "Saved Vault registrations are unavailable")),
        }
    }

    fn write_saved_registrations(&self, records: &[SavedRegistration]) -> Result<(), KnowledgeError> {
        let bytes = serde_json::to_vec_pretty(records).map_err(|_| error("knowledge-vault-registry-invalid", "Saved Vault registrations are invalid"))?;
        atomic_write(&self.saved_scopes_path(), &bytes, true)
    }

    fn saved_registration(vault: &KnowledgeVaultRegistration) -> Result<SavedRegistration, KnowledgeError> {
        let trusted = trusted_vault(vault)?;
        // A renderer location cache may not invent creation identity for an existing Vault.
        let metadata: KnowledgeVaultRegistration = serde_json::from_slice(&std::fs::read(trusted.root.join(".luckyray/vault.json")).map_err(|_| error("knowledge-vault-unavailable", "Vault metadata is unavailable"))?)
            .map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?;
        if metadata.created_at != vault.created_at || metadata.mode != vault.mode || metadata.schema_version != vault.schema_version {
            return Err(error("knowledge-vault-registry-invalid", "Saved Vault identity does not match metadata"));
        }
        let guard = filesystem_directory_identity_guard(&trusted.root).map_err(map_filesystem_identity_error)?;
        guard.verify_current_path(&trusted.root).map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&trusted, guard.identity())?;
        let mut registration = trusted.registration;
        registration.root_path = trusted.root.to_string_lossy().into_owned();
        let scope = WorkspaceScopeRecord { registration: registration.clone(), target_id: identity.target_id, identity_digest: identity.identity_digest, label: identity.label };
        Ok(SavedRegistration { registration, scope: Some(scope) })
    }

    // Called while holding the shared mutation lock; explicitly opening a Vault is
    // the only action allowed to replace a previously captured root identity.
    pub(super) fn remember_current_saved_unlocked(&self, vault: &KnowledgeVaultRegistration) -> Result<(), KnowledgeError> {
        #[cfg(windows)]
        let next = Self::saved_registration(vault)?;
        // Existing non-Windows Knowledge operations remain available, but these
        // platforms cannot prove the stronger replacement fence for mobile scopes.
        #[cfg(not(windows))]
        let next = Self::saved_registration(vault).unwrap_or_else(|_| SavedRegistration { registration: vault.clone(), scope: None });
        let mut saved = self.read_saved_registrations()?;
        saved.retain(|item| item.registration.id != vault.id && item.registration.root_path != next.registration.root_path);
        saved.push(next);
        self.write_saved_registrations(&saved)
    }

    pub(crate) fn migrate_saved_vaults(&self, vaults: &[KnowledgeVaultRegistration]) -> Result<(), KnowledgeError> {
        if self.workspace_scope.is_some() || vaults.len() > 10000 { return Err(error("knowledge-vault-registry-invalid", "Saved Vault migration is invalid")); }
        let _guard = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let mut saved = self.read_saved_registrations()?;
        for vault in vaults {
            if vault.id.trim().is_empty() || vault.name.trim().is_empty() || vault.name.len() > 120 || vault.name.chars().any(char::is_control) || !Path::new(&vault.root_path).is_absolute() || vault.mode != "vault-bound" || vault.schema_version != VAULT_SCHEMA_VERSION { continue; }
            // Idempotent import never upgrades or replaces a captured identity.
            if saved.iter().any(|item| item.registration.id == vault.id || item.registration.root_path == vault.root_path) { continue; }
            saved.push(Self::saved_registration(vault).unwrap_or_else(|_| SavedRegistration { registration: vault.clone(), scope: None }));
        }
        self.write_saved_registrations(&saved)
    }

    pub(crate) fn list_saved_scopes(&self) -> Result<Vec<SavedKnowledgeScope>, KnowledgeError> {
        let _guard = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        Ok(self.read_saved_registrations()?.into_iter().map(|entry| {
            let available = entry.scope.as_ref().map(|scope| self.restore_workspace_scope(scope).is_ok()).unwrap_or(false);
            let vault_key = entry.scope.as_ref().map(scope_key).unwrap_or_else(|| format!("unavailable-{:x}", Sha256::digest(format!("{}:{}", entry.registration.id, entry.registration.root_path).as_bytes())));
            SavedKnowledgeScope { vault_key, vault_id: entry.registration.id, name: entry.registration.name, available }
        }).collect())
    }

    pub(crate) fn for_saved_scope(&self, vault_key: &str) -> Result<Self, KnowledgeError> {
        let _guard = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let scope = self.read_saved_registrations()?.into_iter().filter_map(|entry| entry.scope).find(|scope| scope_key(scope) == vault_key).ok_or_else(knowledge_target_not_current)?;
        self.restore_workspace_scope(&scope)
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use super::super::tests::registered_service;

    #[test]
    fn saved_scope_survives_desktop_switch_without_changing_current() {
        let (service, _, first) = registered_service("saved-first");
        let (_, _, second) = registered_service("saved-second");
        let first_key = service.list_saved_scopes().unwrap()[0].vault_key.clone();
        service.register_current_vault(&second).unwrap();
        let activation = service.activate_ui_source(&second.id).unwrap();
        let scope = service.for_saved_scope(&first_key).unwrap();
        assert_eq!(service.ui_source.lock().unwrap().epoch, activation.source_epoch);
        assert_eq!(service.ui_source.lock().unwrap().active_vault_id.as_deref(), Some(second.id.as_str()));
        assert_eq!(scope.current_vault_unlocked().unwrap().registration.id, first.id);
        assert_eq!(service.current_vault_unlocked().unwrap().registration.id, second.id);
        assert_eq!(service.list_saved_scopes().unwrap().len(), 2);
        assert!(Arc::ptr_eq(&scope.ui_source, &service.ui_source));
        assert!(Arc::ptr_eq(&scope.committed_listener, &service.committed_listener));
    }

    #[test]
    fn nonactive_saved_write_preserves_desktop_drafts_epochs_and_callback_vault() {
        let (service, first_root, first) = registered_service("saved-draft-first");
        let (_, second_root, second) = registered_service("saved-draft-second");
        std::fs::write(first_root.join("same.md"), "first").unwrap();
        std::fs::write(second_root.join("same.md"), "second").unwrap();
        let key = service.list_saved_scopes().unwrap()[0].vault_key.clone();
        let retired = service.activate_ui_source(&first.id).unwrap();
        service.register_current_vault(&second).unwrap();
        let active = service.activate_ui_source(&second.id).unwrap();
        service.companion_set_desktop_drafts(active.source_epoch, 1, vec!["same.md".into()]).unwrap();
        let scope = service.for_saved_scope(&key).unwrap();
        let first_doc = KnowledgeDocumentRef { vault_id: first.id.clone(), relative_path: "same.md".into() };
        let second_doc = KnowledgeDocumentRef { vault_id: second.id.clone(), relative_path: "same.md".into() };
        assert!(!scope.companion_has_unsaved_draft().unwrap());
        assert!(service.companion_has_unsaved_draft().unwrap());
        assert_eq!(service.with_companion_draft_guard(&second_doc, || Ok(())).unwrap_err().code, "knowledge-desktop-draft-busy");
        let target = scope.current_target_identity().unwrap();
        let before = scope.read_document_for_target(&target, &first_doc).unwrap();
        scope.with_companion_draft_guard(&first_doc, || scope.replace_document_for_target(&target, &KnowledgeWriteInput {
            document_ref: first_doc.clone(),
            content: "phone wrote first".into(),
            expected_revision: Some(before.revision),
        })).unwrap();
        assert_eq!(std::fs::read_to_string(first_root.join("same.md")).unwrap(), "phone wrote first");
        assert_eq!(std::fs::read_to_string(second_root.join("same.md")).unwrap(), "second");
        assert!(scope.companion_set_desktop_drafts(retired.source_epoch, 99, vec![]).is_err());
        assert!(service.companion_has_unsaved_draft().unwrap());
        assert_eq!(service.ui_source.lock().unwrap().epoch, active.source_epoch);
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = changes.clone();
        service.set_companion_committed_listener(move |change| observed.lock().unwrap().push(change)).unwrap();
        scope.notify_companion_committed(&first.id, vec!["same.md".into()]);
        assert_eq!(changes.lock().unwrap()[0].vault_id, first.id);
    }

    #[test]
    fn migration_is_exact_idempotent_and_preserves_offline_entries() {
        let (service, _, current) = registered_service("saved-migration");
        let (_, root, mut offline) = registered_service("saved-offline");
        std::fs::remove_dir_all(root).unwrap();
        offline.name = "Offline library".into();
        service.migrate_saved_vaults(&[offline.clone()]).unwrap();
        service.migrate_saved_vaults(&[offline]).unwrap();
        let entries = service.list_saved_scopes().unwrap();
        assert_eq!(entries.len(), 2);
        assert!(!entries.iter().find(|entry| entry.name == "Offline library").unwrap().available);
        assert_eq!(service.current_vault_unlocked().unwrap().registration.id, current.id);
    }

    #[test]
    fn saved_registrations_survive_restart_and_import_cannot_forge_creation_identity() {
        let (service, _, first) = registered_service("saved-restart");
        let (_, _, second) = registered_service("saved-restart-second");
        service.register_current_vault(&second).unwrap();
        let restarted = KnowledgeService::initialize(&service.app_data_dir).unwrap();
        assert_eq!(restarted.list_saved_scopes().unwrap().len(), 2);
        assert_eq!(restarted.current_vault_unlocked().unwrap().registration.id, second.id);
        let first_saved = restarted.list_saved_scopes().unwrap().into_iter().find(|item| item.vault_id == first.id).unwrap();
        assert!(restarted.for_saved_scope(&first_saved.vault_key).is_ok());
        let (_, _, mut forged) = registered_service("saved-forged");
        forged.created_at = "not-the-metadata-identity".into();
        restarted.migrate_saved_vaults(&[forged.clone()]).unwrap();
        assert!(!restarted.list_saved_scopes().unwrap().into_iter().find(|item| item.vault_id == forged.id).unwrap().available);
    }

    #[test]
    fn saved_scope_rejects_replaced_root_and_migration_cannot_rebind_it() {
        let (service, root, vault) = registered_service("saved-replaced");
        let key = service.list_saved_scopes().unwrap()[0].vault_key.clone();
        let scope = service.for_saved_scope(&key).unwrap();
        let old = root.with_extension("original");
        std::fs::rename(&root, &old).unwrap();
        std::fs::create_dir_all(root.join(".luckyray")).unwrap();
        std::fs::write(root.join(".luckyray/vault.json"), serde_json::to_vec(&vault).unwrap()).unwrap();
        service.migrate_saved_vaults(&[vault]).unwrap();
        assert!(!service.list_saved_scopes().unwrap()[0].available);
        assert!(service.for_saved_scope(&key).is_err());
        assert!(scope.current_vault_unlocked().is_err());
    }
}
