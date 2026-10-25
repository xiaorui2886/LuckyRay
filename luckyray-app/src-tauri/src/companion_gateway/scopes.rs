//! Request-local saved library selection. Never changes desktop active state.
use super::*;

impl CompanionGateway {
    pub(super) fn validate_request_scope(&self) -> Result<(), (u16, &'static str)> {
        if let Some(id) = self.material_scope_id() {
            self.backend.material_catalog().for_library(id).map_err(|_| (409,"SCOPE_UNAVAILABLE"))?;
        }
        if let Some(id) = self.request_vault_scope.as_deref() {
            self.backend.knowledge().for_saved_scope(id).map_err(|_| (409,"SCOPE_UNAVAILABLE"))?;
        }
        Ok(())
    }

    pub(super) fn scope_for_request(&self, request: &HttpRequest) -> Result<Self, (u16, &'static str)> {
        let mut scoped = self.clone();
        if let Some(id) = request.headers.get("x-luckyray-material-library") {
            if !valid_scope_id(id) { return Err((400, "SCOPE_INVALID")); }
            scoped.request_material_catalog = Some(self.backend.material_catalog().for_library(id)
                .map_err(|_| (409, "SCOPE_UNAVAILABLE"))?);
            scoped.request_material_scope = Some(id.clone());
        }
        if let Some(id) = request.headers.get("x-luckyray-knowledge-vault") {
            if !valid_scope_id(id) { return Err((400, "SCOPE_INVALID")); }
            scoped.request_knowledge = Some(self.backend.knowledge().for_saved_scope(id)
                .map_err(|_| (409, "SCOPE_UNAVAILABLE"))?);
            scoped.request_vault_scope = Some(id.clone());
            // A request cannot select one vault and name another in a query,
            // route, mutation body, or nested ingest/presentation target.
            let url = reqwest::Url::parse(&format!("https://scope.invalid{}", request.path))
                .map_err(|_| (400, "SCOPE_INVALID"))?;
            for (key, value) in url.query_pairs() {
                if key == "vault" && value != id.as_str() { return Err((409, "SCOPE_MISMATCH")); }
            }
            if let Some(rest) = url.path().strip_prefix("/v1/services/knowledge/vaults/") {
                if rest.split('/').next() != Some(id.as_str()) { return Err((409, "SCOPE_MISMATCH")); }
            }
            // Binary attachment/ingest chunks are not JSON and are checked
            // against their stored immutable manifest by their authority.
            if let Ok(body) = serde_json::from_slice::<Value>(&request.body) {
                for value in [body.get("vaultId"), body.get("target").and_then(|v| v.get("vaultId"))].into_iter().flatten() {
                    if value.as_str() != Some(id.as_str()) { return Err((409, "SCOPE_MISMATCH")); }
                }
            }
        }
        Ok(scoped)
    }

    /// Existing presentation sink is active-workspace-only. Do not silently
    /// switch Main or acknowledge navigation into the wrong library.
    pub(super) fn presentation_scope_active(&self, domain: &str) -> bool {
        if domain == "materials" {
            let Ok(material) = self.material_catalog().library_scope_key() else { return false; };
            if self.backend.material_catalog().library_state().ok().as_ref().map(|(_,active)|active.as_str()) != Some(material.as_str()) { return false; }
        }
        if domain == "knowledge" && self.request_vault_scope.is_some() {
            if self.knowledge().current_vault_id().ok() != self.backend.knowledge().current_vault_id().ok() { return false; }
        }
        true
    }

    pub(super) fn saved_libraries(&self, device: &PairedDevice) -> Result<Value, (u16, &'static str)> {
        let db = open_connection(self.backend.db_path()).map_err(|_| (503,"SERVICE_UNAVAILABLE"))?;
        if !trust_policy::has_policy(&db,&device.device_id).map_err(|_| (503,"SERVICE_UNAVAILABLE"))? {
            return Ok(json!({"scopeSelectionVersion":0,"mode":"legacyDefaultOnly","authorizationMode":"legacy","materials":[],"knowledge":[]}));
        }
        let catalog = self.backend.material_catalog();
        let (_, active_material) = catalog.library_state().map_err(|_| (503, "SERVICE_UNAVAILABLE"))?;
        let mut materials = Vec::new();
        for library in catalog.list_libraries(false).map_err(|_| (503, "SERVICE_UNAVAILABLE"))? {
            let mut scope = self.clone();
            scope.request_material_scope = Some(library.id.clone());
            if !services::granted(&scope,&device.device_id,"content.read","catalog","")? { continue; }
            materials.push(json!({"libraryId":library.id,"displayName":library.name,
                "activeInDesktop":library.id == active_material,"available":library.state == "ready" && catalog.for_library(&library.id).is_ok(),
                "readGranted": services::granted(&scope,&device.device_id,"content.read","catalog","")?,
                "writeGranted": services::granted(&scope,&device.device_id,"content.write","catalog","")?,
                "ingestGranted": services::granted(&scope,&device.device_id,"ingest.write","catalog","")?}));
        }
        let knowledge = self.backend.knowledge();
        let active = knowledge.current_vault_id().ok();
        let mut vaults = Vec::new();
        for vault in knowledge.list_saved_scopes().map_err(|_| (503, "SERVICE_UNAVAILABLE"))? {
            if !services::granted(self,&device.device_id,"content.read","vault",&vault.vault_key)? { continue; }
            vaults.push(json!({"vaultId":vault.vault_key,"displayName":vault.name,
                "activeInDesktop":active.as_deref()==Some(vault.vault_id.as_str()),"available":vault.available,
                "readGranted":services::granted(self,&device.device_id,"content.read","vault",&vault.vault_key)?,
                "writeGranted":services::granted(self,&device.device_id,"content.write","vault",&vault.vault_key)?,
                "ingestGranted":services::granted(self,&device.device_id,"ingest.write","vault",&vault.vault_key)?}));
        }
        Ok(json!({"scopeSelectionVersion":1,"authorizationMode":trust_policy::mode(&db,&device.device_id).map_err(|_| (503,"SERVICE_UNAVAILABLE"))?,"materials":materials,"knowledge":vaults}))
    }
}

fn valid_scope_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 160 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b,b'-'|b'_'))
}
