//! Dedicated materials grants live in the existing local-transport authority.
//! Never bootstrap them from a native/Collector credential or an HTTP request.
use super::*;

const GRANT_LIFETIME_SECS: u64 = 30 * 24 * 60 * 60;
const MAX_GRANTS: usize = 16;
const GRANTS_FILE: &str = "local-transport-materials-grants-v1.json";
const LIBRARY_GRANTS_FILE: &str = "local-transport-web-library-grants-v1.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRecord {
    version: u32,
    grants: Vec<MaterialsGrant>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialsGrant {
    pub id: String,
    pub client_name: String,
    pub library_id: String,
    pub created_at: u64,
    pub expires_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) knowledge: Option<KnowledgeGrant>,
}

/// Trusted native-only vault identity. Never return this record to the UI or MCP.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct KnowledgeGrant {
    vault_id: String,
    scope: crate::knowledge::WorkspaceScopeRecord,
}

fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| "materials-grant-clock-invalid".to_owned())
}

impl MaterialsGrant {
    pub(crate) fn public_metadata(&self) -> Value {
        json!({"id":self.id,"clientName":self.client_name,"libraryId":self.library_id,
            "createdAt":self.created_at,"expiresAt":self.expires_at,
            "vaultId":self.knowledge.as_ref().map(|k| &k.vault_id)})
    }
    fn valid(&self) -> bool {
        is_strict_secret(&self.id)
            && !self.client_name.trim().is_empty()
            && self.client_name.len() <= 120
            && !self.client_name.chars().any(char::is_control)
            && crate::materials::consumer::valid_consumer_id(&self.library_id)
            && self.knowledge.as_ref().is_none_or(|k| !k.vault_id.is_empty() && k.vault_id.len() <= 256)
            && self.created_at.checked_add(GRANT_LIFETIME_SECS) == Some(self.expires_at)
    }
}

impl AuthState {
    pub(super) fn initialize_materials_grants(&mut self) {
        if let Err(error) = self.load_materials_grants() {
            // Quarantine only the additive scope. Do not rewrite damaged metadata
            // or prevent the existing native/Collector authority from starting.
            self.materials_grants.clear();
            self.materials_grants_error = Some(error);
        }
    }
    fn materials_grants_available(&self) -> Result<(), String> {
        match &self.materials_grants_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    // Add only grant metadata; the existing native/Collector credential file
    // remains byte/schema compatible with older installed native sidecars.
    pub(super) fn load_materials_grants(&mut self) -> Result<(), String> {
        let mut grants = Vec::new();
        for (file, unified) in [(GRANTS_FILE, false), (LIBRARY_GRANTS_FILE, true)] {
            match fs::read(self.path.with_file_name(file)) {
                Ok(bytes) => {
                    let record: GrantRecord = serde_json::from_slice(&bytes)
                        .map_err(|_| "materials-grants-invalid")?;
                    if record.version != 1 || record.grants.iter().any(|g| g.knowledge.is_some() != unified) {
                        return Err("materials-grants-version-invalid".into());
                    }
                    grants.extend(record.grants);
                }
                Err(e) if e.kind() == ErrorKind::NotFound => {},
                Err(_) => return Err("materials-grants-unreadable".into()),
            }
        }
        self.materials_grants = grants;
        if !self.validate_materials_grants() { return Err("materials-grants-invalid".into()); }
        Ok(())
    }
    fn persist_materials_grants(&self) -> Result<(), String> {
        self.persist_grant_family(false)
    }
    fn persist_grant_family(&self, unified: bool) -> Result<(), String> {
        // Existing desktop versions keep reading their original, unchanged schema.
        // Each operation changes one family in one atomic file replacement.
        persist_auth_record(&self.path.with_file_name(if unified { LIBRARY_GRANTS_FILE } else { GRANTS_FILE }),
            &GrantRecord {version: 1, grants: self.materials_grants.iter()
                .filter(|g| g.knowledge.is_some() == unified).cloned().collect()})
    }
    pub(super) fn validate_materials_grants(&self) -> bool {
        let grants = &self.materials_grants;
        grants.len() <= MAX_GRANTS
            && grants.iter().all(MaterialsGrant::valid)
            && grants.iter().map(|g| &g.id).collect::<BTreeSet<_>>().len() == grants.len()
    }

    fn grant(&self, id: &str) -> Result<&MaterialsGrant, String> {
        self.materials_grants_available()?;
        let timestamp = now()?;
        self.materials_grants
            .iter()
            .find(|g| g.id == id && g.created_at <= timestamp && timestamp < g.expires_at)
            .ok_or_else(|| "materials-grant-invalid-or-expired".to_owned())
    }

    pub(super) fn materials_credential(&self, id: &str) -> Result<String, String> {
        let grant = self.grant(id)?;
        if let Some(knowledge) = &grant.knowledge {
            let identity = serde_json::to_vec(knowledge).map_err(|_| "library-grant-invalid")?;
            return derive_credential(&self.persisted.master_secret, &format!(
                "library-mcp\0v1\0{}\0{}\0{}\0{:x}", grant.id, grant.library_id,
                grant.expires_at, Sha256::digest(identity)));
        }
        derive_credential(
            &self.persisted.master_secret,
            &format!(
                "materials-mcp\0v1\0{}\0{}\0{}",
                grant.id, grant.library_id, grant.expires_at
            ),
        )
    }

    pub(super) fn matching_materials_grant(&self, presented: &str) -> Option<String> {
        self.materials_grants.iter().find_map(|grant| {
            self.materials_credential(&grant.id)
                .ok()
                .filter(|expected| constant_time_eq(expected.as_bytes(), presented.as_bytes()))
                .map(|_| grant.id.clone())
        })
    }

    fn issue_materials_grant(
        &mut self,
        client_name: &str,
        library_id: &str,
    ) -> Result<MaterialsGrant, String> {
        self.materials_grants_available()?;
        let created_at = now()?;
        let grant = MaterialsGrant {
            id: random_hex(32),
            client_name: client_name.trim().to_owned(),
            library_id: library_id.to_owned(),
            created_at,
            knowledge: None,
            expires_at: created_at
                .checked_add(GRANT_LIFETIME_SECS)
                .ok_or("materials-grant-clock-invalid")?,
        };
        if !grant.valid() {
            return Err("materials-grant-input-invalid".into());
        }
        if self.materials_grants.len() >= MAX_GRANTS {
            return Err("materials-grant-limit-revoke-first".into());
        }
        self.materials_grants.push(grant.clone());
        if let Err(error) = self.persist_materials_grants() {
            self.materials_grants.pop();
            return Err(error);
        }
        Ok(grant)
    }

    fn revoke_materials_grant(&mut self, id: &str) -> Result<(), String> {
        self.materials_grants_available()?;
        let Some(index) = self.materials_grants.iter().position(|g| g.id == id) else {
            return Err("materials-grant-not-found".into());
        };
        let removed = self.materials_grants.remove(index);
        if let Err(error) = self.persist_grant_family(removed.knowledge.is_some()) {
            self.materials_grants.insert(index, removed);
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn materials_proof(
        &self,
        body: &str,
        port: u16,
        server_nonce: &str,
    ) -> Result<Value, TransportFailure> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Challenge {
            client_id: String,
            client_nonce: String,
            #[serde(default)]
            profile_proof_version: Option<u8>,
        }
        let denied = || {
            TransportFailure::new(
                401,
                "materials-proof-denied",
                "Materials pairing is invalid or expired",
            )
        };
        let challenge: Challenge = serde_json::from_str(body).map_err(|_| denied())?;
        if !is_strict_secret(&challenge.client_nonce) {
            return Err(denied());
        }
        let grant = self.grant(&challenge.client_id).map_err(|_| denied())?;
        let credential = self.materials_credential(&grant.id).map_err(|_| denied())?;
        // Unified grants require v3: older proofs must never strip the knowledge binding.
        if grant.knowledge.is_some() != (challenge.profile_proof_version == Some(3)) { return Err(denied()); }
        // A packaged MCP client may have a different filesystem namespace (MSIX).
        // Verify the original profile in the database-owning desktop, then bind its
        // physical identity into the nonce proof. No client needs to open a database.
        if let Some(version) = challenge.profile_proof_version {
            if version != 2 && version != 3 { return Err(denied()); }
            let root = self.path.parent().ok_or_else(denied)?;
            let normalize = |p: &Path| p.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").trim_end_matches('\\').to_lowercase();
            for anchor in [root.to_path_buf(), root.join("luckyray.db")] {
                let physical = fs::canonicalize(&anchor).map_err(|_| denied())?;
                if normalize(&anchor) != normalize(&physical) { return Err(denied()); }
            }
            let profile = root.to_string_lossy().into_owned();
            let executable = std::env::current_exe().map_err(|_| denied())?.to_string_lossy().into_owned();
            if let Some(knowledge) = &grant.knowledge {
                let proof = derive_credential(&credential, &format!(
                    "library-mcp-proof\0v3\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
                    grant.id,grant.library_id,knowledge.vault_id,grant.expires_at,port,
                    challenge.client_nonce,server_nonce,profile,executable)).map_err(|_| denied())?;
                return Ok(json!({"protocolVersion":3,"clientId":grant.id,"libraryId":grant.library_id,
                    "vaultId":knowledge.vault_id,"expiresAt":grant.expires_at,"port":port,
                    "clientNonce":challenge.client_nonce,"serverNonce":server_nonce,
                    "profileRoot":profile,"desktopExe":executable,"proof":proof}));
            }
            let proof = derive_credential(&credential, &format!(
                "materials-mcp-proof\0v2\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
                grant.id,grant.library_id,grant.expires_at,port,challenge.client_nonce,server_nonce,profile,executable
            )).map_err(|_| denied())?;
            return Ok(json!({"protocolVersion":2,"clientId":grant.id,"libraryId":grant.library_id,
                "expiresAt":grant.expires_at,"port":port,"clientNonce":challenge.client_nonce,
                "serverNonce":server_nonce,"profileRoot":profile,"desktopExe":executable,"proof":proof}));
        }
        let proof = derive_credential(
            &credential,
            &format!(
                "materials-mcp-proof\0v1\0{}\0{}\0{}\0{}\0{}\0{}",
                grant.id,
                grant.library_id,
                grant.expires_at,
                port,
                challenge.client_nonce,
                server_nonce
            ),
        )
        .map_err(|_| denied())?;
        Ok(
            json!({"protocolVersion":1,"clientId":grant.id,"libraryId":grant.library_id,
            "expiresAt":grant.expires_at,"port":port,"clientNonce":challenge.client_nonce,
            "serverNonce":server_nonce,"proof":proof}),
        )
    }
}

impl LocalTransportHandle {
    pub(crate) fn materials_profile_root(&self) -> Result<String, String> {
        let state = self.auth.lock().map_err(|_| "auth-state-unavailable")?;
        Ok(state
            .path
            .parent()
            .ok_or("auth-path-unavailable")?
            .to_string_lossy()
            .into_owned())
    }
    pub(crate) fn list_materials_grants(&self) -> Result<Vec<MaterialsGrant>, String> {
        let state = self.auth.lock().map_err(|_| "auth-state-unavailable")?;
        state.materials_grants_available()?;
        Ok(state.materials_grants.clone())
    }
    // Only the trusted Main command may call this after formal UI confirmation.
    pub(crate) fn pair_materials(
        &self,
        client_name: &str,
        library_id: &str,
    ) -> Result<Value, String> {
        let mut state = self.auth.lock().map_err(|_| "auth-state-unavailable")?;
        let grant = state.issue_materials_grant(client_name, library_id)?;
        let credential = state.materials_credential(&grant.id)?;
        Ok(
            json!({"version":1,"authKind":"materials-mcp-scoped-v1","baseUrl":self.base_url(),
            "clientId":grant.id,"clientName":grant.client_name,"libraryId":grant.library_id,
            "expiresAt":grant.expires_at,"credential":credential,
            "scope":["materials.search","materials.inspect","folders.read","materials.import"]}),
        )
    }
    /// One persisted grant, one derived credential, one revocation for both libraries.
    /// Called only after trusted UI consent and native vault/library validation.
    pub(crate) fn pair_libraries(&self, library_id: &str, vault_id: &str,
        scope: crate::knowledge::WorkspaceScopeRecord) -> Result<Value, String> {
        let mut state = self.auth.lock().map_err(|_| "auth-state-unavailable")?;
        state.materials_grants_available()?;
        let created_at = now()?;
        let grant = MaterialsGrant {id:random_hex(32),client_name:"LuckyRay Web MCP".into(),
            library_id:library_id.into(),created_at,expires_at:created_at.checked_add(GRANT_LIFETIME_SECS)
                .ok_or("materials-grant-clock-invalid")?,
            knowledge:Some(KnowledgeGrant{vault_id:vault_id.into(),scope})};
        if !grant.valid() {return Err("library-grant-input-invalid".into());}
        if state.materials_grants.len() >= MAX_GRANTS {return Err("materials-grant-limit-revoke-first".into());}
        state.materials_grants.push(grant.clone());
        let credential = match state.materials_credential(&grant.id) {
            Ok(v)=>v,Err(e)=>{state.materials_grants.pop();return Err(e);}
        };
        if let Err(e)=state.persist_grant_family(true){state.materials_grants.pop();return Err(e);}
        Ok(json!({"version":1,"authKind":"library-mcp-scoped-v1","profileProofVersion":3,
            "baseUrl":self.base_url(),"clientId":grant.id,"clientName":grant.client_name,
            "libraryId":grant.library_id,"vaultId":vault_id,"expiresAt":grant.expires_at,"credential":credential,
            "scope":["materials.search","materials.inspect","folders.read","materials.import",
                     "knowledge.search","knowledge.read","knowledge.import-markdown"]}))
    }
    pub(crate) fn revoke_materials(&self, id: &str) -> Result<(), String> {
        self.auth
            .lock()
            .map_err(|_| "auth-state-unavailable")?
            .revoke_materials_grant(id)
    }
}

impl VerifiedTransportPrincipal {
    pub(crate) fn is_materials_mcp(&self) -> bool {
        self.material_binding
            .as_ref()
            .is_some_and(|b| b.materials_grant_id.is_some())
    }
    pub(crate) fn materials_library_id(&self) -> crate::materials::MaterialResult<String> {
        let admission = self.material_admission()?;
        let id = self
            .material_binding
            .as_ref()
            .and_then(|b| b.materials_grant_id.as_deref())
            .ok_or_else(|| {
                crate::materials::MaterialError::new("materials-grant-required", "需要素材专用授权")
            })?;
        admission
            ._auth
            .grant(id)
            .map(|g| g.library_id.clone())
            .map_err(|_| {
                crate::materials::MaterialError::new("materials-grant-invalid", "素材授权已失效")
            })
    }
    pub(crate) fn with_knowledge_mcp<T>(&self,
        action: impl FnOnce(&crate::knowledge::WorkspaceScopeRecord, &str, &Path) -> Result<T, String>
    ) -> Result<T, String> {
        // Keep the authority lease through the formal knowledge operation. Revocation
        // waits for admitted work; after it returns no new mutation can pass this gate.
        let admission=self.material_admission().map_err(|_| "library-grant-invalid")?;
        let id=self.material_binding.as_ref().and_then(|b|b.materials_grant_id.as_deref())
            .ok_or("library-grant-required")?;
        let grant=admission._auth.grant(id)?;
        let knowledge=grant.knowledge.as_ref().ok_or("knowledge-scope-denied")?;
        let root=admission._auth.path.parent().ok_or("auth-path-unavailable")?;
        action(&knowledge.scope,id,root)
    }
    pub(super) fn check_materials_route(
        &self,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> Result<(), TransportFailure> {
        if !self.is_materials_mcp() {
            return Ok(());
        }
        let knowledge_allowed = matches!((method,path),
            ("POST", "/api/v1/library-mcp/knowledge/search" | "/api/v1/library-mcp/knowledge/read" | "/api/v1/library-mcp/knowledge/import-markdown"))
            && self.with_knowledge_mcp(|_,_,_|Ok(())).is_ok();
        let allowed = knowledge_allowed || match (method, path) {
            ("GET", "/api/v1/folders") => true,
            ("POST", "/api/v1/assets/import-file") => true,
            ("POST", "/api/v1/tools/run") => serde_json::from_str::<Value>(body.unwrap_or(""))
                .ok()
                .is_some_and(|v| {
                    matches!(
                        v.get("toolId").and_then(Value::as_str),
                        Some("materials.search" | "materials.inspect")
                    )
                }),
            _ => false,
        };
        if allowed {
            Ok(())
        } else {
            Err(TransportFailure::new(
                403,
                "materials-scope-denied",
                "This pairing grants materials access only",
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn materials_grant_corruption_blocks_only_scoped_access_without_overwriting_file() {
        let root = std::env::temp_dir().join(format!("lr-material-grant-{}", random_hex(8)));
        let state = AuthState::load_or_create(&root).unwrap();
        let native = state.native_credential().unwrap();
        fs::write(root.join(GRANTS_FILE), b"invalid synthetic record").unwrap();
        let mut state = AuthState::load_or_create(&root).unwrap();
        assert_eq!(state.native_credential().unwrap(), native);
        assert!(state.issue_materials_grant("Fixture", "fixture-library").is_err());
        assert_eq!(fs::read(root.join(GRANTS_FILE)).unwrap(), b"invalid synthetic record");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn materials_grants_are_scoped_revocable_persistent_and_not_native_credentials() {
        let root = std::env::temp_dir().join(format!("lr-material-grant-{}", random_hex(8)));
        let mut state = AuthState::load_or_create(&root).unwrap();
        let native = state.native_credential().unwrap();
        let original_auth = fs::read(root.join(AUTH_FILE_NAME)).unwrap();
        let grant = state
            .issue_materials_grant("Synthetic MCP", "fixture-library")
            .unwrap();
        let credential = state.materials_credential(&grant.id).unwrap();
        assert_eq!(
            fs::read(root.join(AUTH_FILE_NAME)).unwrap(),
            original_auth,
            "pairing must not alter the native/Collector credential schema or bytes"
        );
        assert_ne!(credential, native);
        assert!(state.matching_materials_grant(&native).is_none());
        let mut reloaded = AuthState::load_or_create(&root).unwrap();
        assert_eq!(
            reloaded.materials_credential(&grant.id).unwrap(),
            credential
        );
        reloaded.revoke_materials_grant(&grant.id).unwrap();
        assert!(reloaded.matching_materials_grant(&credential).is_none());
        assert_eq!(reloaded.native_credential().unwrap(), native);
        assert!(AuthState::load_or_create(&root)
            .unwrap()
            .materials_grants
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn materials_grant_expiry_rotation_and_failed_persist_fail_closed() {
        let root = std::env::temp_dir().join(format!("lr-material-grant-{}", random_hex(8)));
        let mut state = AuthState::load_or_create(&root).unwrap();
        let grant = state
            .issue_materials_grant("Fixture", "fixture-library")
            .unwrap();
        let token = state.materials_credential(&grant.id).unwrap();
        state.rotate_master().unwrap();
        assert!(state.matching_materials_grant(&token).is_none());
        let rotated = state.materials_credential(&grant.id).unwrap();
        state.materials_grants[0].created_at = now().unwrap() - GRANT_LIFETIME_SECS - 1;
        state.materials_grants[0].expires_at = now().unwrap() - 1;
        assert!(state.matching_materials_grant(&rotated).is_none());
        state.revoke_materials_grant(&grant.id).unwrap();
        fs::remove_file(root.join(GRANTS_FILE)).unwrap();
        fs::create_dir(root.join(GRANTS_FILE)).unwrap();
        assert!(state
            .issue_materials_grant("Fixture", "fixture-library")
            .is_err());
        assert!(
            state.materials_grants.is_empty(),
            "failed issue is rolled back in memory"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
