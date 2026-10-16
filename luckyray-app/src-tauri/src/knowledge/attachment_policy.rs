use super::*;

impl KnowledgeService {
    pub(crate) fn attachment_handling_policy(&self,vault_id:&str)->Result<String,KnowledgeError> {
        let (vault,guard,identity)=self.capture_current_target()?;
        if vault.registration.id != vault_id {return Err(knowledge_target_not_current());}
        let value:Value=serde_json::from_slice(&std::fs::read(vault.root.join(".luckyray/vault.json")).map_err(|_|error("knowledge-vault-registry-unavailable","Vault settings unavailable"))?).map_err(|_|error("knowledge-vault-registry-invalid","Vault settings invalid"))?;
        self.verify_current_target(&identity,&guard)?;
        Ok(if value["attachmentHandlingPolicy"]=="copy" {"copy"} else {"reference"}.into())
    }
    pub(crate) fn set_attachment_handling_policy(&self,vault_id:&str,source_epoch:u64,policy:&str)->Result<String,KnowledgeError> {
        if !matches!(policy,"reference"|"copy") {return Err(error("knowledge-policy-invalid","Unknown attachment handling choice"));}
        let _source=self.lock_active_ui_source(source_epoch,Some(vault_id))?;
        let _mutation=self.mutation_lock.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge lock failed"))?;
        let vault=self.current_vault_unlocked()?;
        if vault.registration.id!=vault_id {return Err(knowledge_target_not_current());}
        let root_guard=filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
        let identity=knowledge_target_identity(&vault,root_guard.identity())?;
        let path=vault.root.join(".luckyray/vault.json");
        let _parents=super::attachments::guard_existing_ancestors(&vault.root,&path)?;
        assert_safe_components(&vault.root,Path::new(".luckyray/vault.json"))?;
        let original=std::fs::read(&path).map_err(|_|error("knowledge-vault-registry-unavailable","Vault settings unavailable"))?;
        let mut value:Value=serde_json::from_slice(&original).map_err(|_|error("knowledge-vault-registry-invalid","Vault settings invalid"))?;
        value["attachmentHandlingPolicy"]=json!(policy);
        if std::fs::read(&path).ok().as_deref()!=Some(original.as_slice()) {return Err(error("knowledge-revision-conflict","Vault settings changed"));}
        self.assert_expected_target_unlocked(&vault,Some(&identity),Some(&root_guard))?;
        atomic_write(&path,&serde_json::to_vec_pretty(&value).map_err(|_|error("knowledge-vault-registry-invalid","Vault settings invalid"))?,true)?;
        Ok(policy.into())
    }
    /// Native create/open use this same lock as the explicit preference setter.
    /// Their earlier metadata snapshot must never undo a concurrently saved preference.
    pub(crate) fn write_vault_registration_metadata(&self, path: &Path, registration: &KnowledgeVaultRegistration) -> Result<(), KnowledgeError> {
        let _mutation = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let root = PathBuf::from(&registration.root_path);
        if path != root.join(".luckyray").join("vault.json") {
            return Err(error("knowledge-vault-registry-invalid", "Vault metadata path is invalid"));
        }
        let mut value = serde_json::to_value(registration).map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?;
        if path.exists() {
            let existing: Value = serde_json::from_slice(&std::fs::read(path).map_err(|_| error("knowledge-vault-registry-unavailable", "Vault metadata is unavailable"))?)
                .map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?;
            value["linkUpdatePolicy"] = existing.get("linkUpdatePolicy").cloned().unwrap_or(json!("ask"));
            value["attachmentHandlingPolicy"] = existing.get("attachmentHandlingPolicy").cloned().unwrap_or(json!("reference"));
        }
        atomic_write(path, &serde_json::to_vec_pretty(&value).map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?, true)
    }

    pub(crate) fn attachment_link_update_policy(&self, vault_id: &str) -> Result<LinkUpdatePolicy, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id { return Err(knowledge_target_not_current()); }
        self.verify_current_target(&identity, &guard)?;
        Ok(vault.registration.link_update_policy)
    }

    /// Only an explicit UI choice invokes this; observing a file event never changes preferences.
    pub(crate) fn set_attachment_link_update_policy(&self, vault_id: &str, source_epoch: u64, policy: LinkUpdatePolicy) -> Result<LinkUpdatePolicy, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, Some(vault_id))?;
        let _mutation = self.mutation_lock.lock().map_err(|_| error("knowledge-lock-poisoned", "Knowledge service lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        if vault.registration.id != vault_id { return Err(knowledge_target_not_current()); }
        let guard = filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&vault, guard.identity())?;
        let metadata_path = vault.root.join(".luckyray").join("vault.json");
        let original = std::fs::read(&metadata_path).map_err(|_| error("knowledge-vault-registry-unavailable", "Vault metadata is unavailable"))?;
        // Preserve future metadata fields. Reading an old registration does not migrate it.
        let mut metadata: Value = serde_json::from_slice(&original).map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?;
        metadata.as_object_mut().ok_or_else(|| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?
            .insert("linkUpdatePolicy".into(), serde_json::to_value(policy).unwrap());
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&guard))?;
        if std::fs::read(&metadata_path).ok().as_deref() != Some(original.as_slice()) {
            return Err(error("knowledge-revision-conflict", "Vault settings changed; read them again"));
        }
        atomic_write(&metadata_path, &serde_json::to_vec_pretty(&metadata).map_err(|_| error("knowledge-vault-registry-invalid", "Vault metadata is invalid"))?, true)?;
        // This is the single commit point. The app registration caches the location, not this policy.
        // Do not register again or make success depend on a second cache write/epoch change.
        Ok(policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_policy_is_ask_without_migrating_reads() {
        for value in ["null", "17", "{}", "\"future-policy\"", "\"ask\""] {
            assert_eq!(serde_json::from_str::<LinkUpdatePolicy>(value).unwrap(), LinkUpdatePolicy::Ask);
        }
        assert_eq!(serde_json::from_str::<LinkUpdatePolicy>("\"always\"").unwrap(), LinkUpdatePolicy::Always);
        let mut registration = serde_json::json!({"id":"v","name":"V","rootPath":"/fixture","mode":"vault-bound","createdAt":"now","lastOpenedAt":"now","schemaVersion":1});
        assert_eq!(serde_json::from_value::<KnowledgeVaultRegistration>(registration.clone()).unwrap().link_update_policy, LinkUpdatePolicy::Ask);
        registration["linkUpdatePolicy"] = json!("always");
        let decoded: KnowledgeVaultRegistration = serde_json::from_value(registration).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap()["linkUpdatePolicy"], "always");
    }
}
