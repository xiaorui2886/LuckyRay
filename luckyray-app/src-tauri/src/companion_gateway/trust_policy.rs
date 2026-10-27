//! Desktop-owned consent. Missing rows always mean Manual; migration never grants access.
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AuthorizationMode {
    #[default]
    Manual,
    Trusted,
}
impl AuthorizationMode {
    pub(crate) fn as_str(self) -> &'static str { match self { Self::Manual => "manual", Self::Trusted => "trusted" } }
}

pub(crate) fn mode(db: &Connection, device: &str) -> rusqlite::Result<AuthorizationMode> {
    Ok(match db.query_row("SELECT mode FROM companion_phone_policy WHERE device_id=?1", [device], |r| r.get::<_, String>(0)).optional()?.as_deref() {
        Some("trusted") => AuthorizationMode::Trusted,
        _ => AuthorizationMode::Manual,
    })
}

/// An explicit service off-switch applies to all saved libraries, including future ones.
pub(crate) fn explicitly_denied(db: &Connection, device: &str, class: &str, kind: &str) -> rusqlite::Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM companion_service_override WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3 AND enabled=0)", params![device,class,kind], |r| r.get(0))
}

pub(crate) fn granted(db: &Connection, device: &str, class: &str, kind: &str, scope: &str) -> rusqlite::Result<bool> {
    if !matches!(class, "content.read" | "content.write" | "ingest.write" | "desktop.open") || !matches!(kind, "catalog" | "vault") { return Ok(false); }
    let alive: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL)", [device], |r| r.get(0))?;
    if !alive { return Ok(false); }
    let trusted = mode(db,device)? == AuthorizationMode::Trusted;
    if explicitly_denied(db,device,class,kind)? {
        if trusted { return Ok(false); }
        let manual_exception: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM companion_manual_override WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3 AND scope_id=?4)", params![device,class,kind,scope], |r| r.get(0))?;
        if !manual_exception { return Ok(false); }
    }
    if trusted { return Ok(true); }
    db.query_row("SELECT EXISTS(SELECT 1 FROM companion_service_grant WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3 AND scope_id=?4)", params![device,class,kind,scope], |r| r.get(0))
}

pub(crate) fn lsh_granted(db: &Connection, device: &str) -> rusqlite::Result<bool> {
    let existing: Option<Option<String>> = db.query_row("SELECT lsh_remote_surface_granted_at FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL", [device], |r| r.get(0)).optional()?;
    let Some(existing) = existing else { return Ok(false); };
    if explicitly_denied(db,device,"lsh.remote","lsh")? { return Ok(false); }
    Ok(existing.is_some() || mode(db,device)? == AuthorizationMode::Trusted)
}

/// Only called within a local management or successful pairing transaction.
/// Never remove overrides here: changing modes must not resurrect denied services.
pub(crate) fn set_mode(db: &Connection, device: &str, mode: AuthorizationMode) -> rusqlite::Result<()> {
    db.execute("INSERT INTO companion_phone_policy(device_id,mode) VALUES(?1,?2) ON CONFLICT(device_id) DO UPDATE SET mode=excluded.mode", params![device,mode.as_str()])?;
    Ok(())
}

pub(crate) fn set_override(db: &Connection, device: &str, class: &str, kind: &str, enabled: bool) -> rusqlite::Result<usize> {
    if enabled {
        db.execute("DELETE FROM companion_service_override WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3", params![device,class,kind])
    } else {
        let cleared = db.execute("DELETE FROM companion_manual_override WHERE device_id=?1 AND grant_class=?2 AND scope_kind=?3", params![device,class,kind])?;
        db.execute("INSERT OR IGNORE INTO companion_service_override(device_id,grant_class,scope_kind,enabled) VALUES(?1,?2,?3,0)", params![device,class,kind]).map(|changed| changed + cleared)
    }
}

impl super::CompanionGateway {
    pub(crate) fn set_authorization_mode(&self, device: &str, mode: AuthorizationMode, expected_revision: u64) -> Result<(), super::GatewayError> {
        use super::*;
        let _transition = self.control_transition()?;
        let unavailable = || GatewayError::new("companion-database-unavailable", "Phone policy store unavailable");
        let mut db = open_connection(self.backend.db_path())?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| unavailable())?;
        let revision: u64 = tx.query_row("SELECT services_permission_revision FROM companion_device WHERE device_id=?1 AND revoked_at IS NULL", [device], |r| r.get(0))
            .map_err(|_| GatewayError::new("companion-device-unknown", "Paired device unavailable"))?;
        if revision != expected_revision { return Err(GatewayError::new("permission-state-changed", "Review current phone permissions")); }
        set_mode(&tx, device, mode).map_err(|_| unavailable())?;
        tx.execute("UPDATE companion_device SET services_permission_revision=services_permission_revision+1 WHERE device_id=?1", [device]).map_err(|_| unavailable())?;
        tx.execute("INSERT INTO companion_security_audit(action,device_id,occurred_at,result) VALUES('phone-authorization-mode',?1,?2,?3)", params![device,chrono::Utc::now().to_rfc3339(),mode.as_str()]).map_err(|_| unavailable())?;
        let lsh_allowed = lsh_granted(&tx, device).map_err(|_| unavailable())?;
        tx.commit().map_err(|_| unavailable())?;
        self.retire_presentation_offers(Some(device));
        if !lsh_allowed {
            self.connections.lock().expect("companion connections mutex").shutdown_remote_relays();
            let dropped = self.lsh_remote_host().map(|host| host.drop_remote_sessions(device));
            self.connections.lock().expect("companion connections mutex").shutdown_remote_relays();
            if let Some(result) = dropped { result.map_err(|_| GatewayError::new("lsh-remote-revoke-unconfirmed", "Remote session reclamation unconfirmed"))?; }
        }
        Ok(())
    }
}

/// Distinguishes old paired devices from an explicit Manual choice. Legacy Content
/// semantics survive only until a local user chooses a policy; Services never inherit them.
pub(crate) fn has_policy(db: &Connection, device: &str) -> rusqlite::Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM companion_phone_policy WHERE device_id=?1)", [device], |r| r.get(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE backend_schema_migration(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT);
            CREATE TABLE companion_device(device_id TEXT PRIMARY KEY,revoked_at TEXT,lsh_remote_surface_granted_at TEXT);
            CREATE TABLE companion_service_grant(device_id TEXT NOT NULL,grant_class TEXT NOT NULL,scope_kind TEXT NOT NULL,scope_id TEXT NOT NULL,granted_at TEXT NOT NULL,PRIMARY KEY(device_id,grant_class,scope_kind,scope_id));
            INSERT INTO companion_device VALUES('phone',NULL,NULL);
            INSERT INTO companion_service_grant VALUES('phone','content.read','vault','vault-old','before');").unwrap();
        db.execute_batch(include_str!("trust_schema.sql")).unwrap();
        db
    }
    #[test]
    fn migration_does_not_upgrade_or_destroy_existing_manual_grants() {
        let db = database();
        assert!(!has_policy(&db,"phone").unwrap());
        assert_eq!(mode(&db,"phone").unwrap(),AuthorizationMode::Manual);
        assert!(granted(&db,"phone","content.read","vault","vault-old").unwrap());
        assert!(!granted(&db,"phone","content.write","vault","vault-old").unwrap());
        assert!(!granted(&db,"phone","content.read","vault","vault-new").unwrap());
        assert!(!lsh_granted(&db,"phone").unwrap());
    }
    #[test]
    fn explicit_trust_covers_saved_scope_policy_without_cloning_manual_grants() {
        let db = database();
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        for kind in ["catalog","vault"] { for class in ["content.read","content.write","ingest.write","desktop.open"] {
            assert!(granted(&db,"phone",class,kind,"future-saved-scope").unwrap());
        }}
        assert!(lsh_granted(&db,"phone").unwrap());
        set_mode(&db,"phone",AuthorizationMode::Manual).unwrap();
        assert!(!granted(&db,"phone","content.read","vault","future-saved-scope").unwrap());
        assert!(granted(&db,"phone","content.read","vault","vault-old").unwrap());
        assert!(!lsh_granted(&db,"phone").unwrap());
    }
    #[test]
    fn global_off_survives_mode_roundtrip_and_manual_exception_is_exact() {
        let db = database();
        db.execute("INSERT INTO companion_service_grant VALUES('phone','content.read','vault','vault-two','before')", []).unwrap();
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        set_override(&db,"phone","content.read","vault",false).unwrap();
        set_mode(&db,"phone",AuthorizationMode::Manual).unwrap();
        db.execute("INSERT INTO companion_manual_override VALUES('phone','content.read','vault','vault-old')", []).unwrap();
        assert!(granted(&db,"phone","content.read","vault","vault-old").unwrap());
        assert!(!granted(&db,"phone","content.read","vault","vault-two").unwrap());
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        for id in ["vault-old","vault-two","future-saved-scope"] { assert!(!granted(&db,"phone","content.read","vault",id).unwrap()); }
        assert!(granted(&db,"phone","content.write","vault","vault-two").unwrap());
        set_override(&db,"phone","content.read","vault",false).unwrap();
        set_mode(&db,"phone",AuthorizationMode::Manual).unwrap();
        assert!(!granted(&db,"phone","content.read","vault","vault-old").unwrap(), "a newer global off also retires older manual exceptions");
    }
    #[test]
    fn lsh_off_and_device_revocation_win_over_trust() {
        let db = database();
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        set_override(&db,"phone","lsh.remote","lsh",false).unwrap();
        assert!(!lsh_granted(&db,"phone").unwrap());
        set_mode(&db,"phone",AuthorizationMode::Manual).unwrap();
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        assert!(!lsh_granted(&db,"phone").unwrap());
        set_override(&db,"phone","lsh.remote","lsh",true).unwrap();
        assert!(lsh_granted(&db,"phone").unwrap());
        db.execute("UPDATE companion_device SET revoked_at='now' WHERE device_id='phone'", []).unwrap();
        assert!(!lsh_granted(&db,"phone").unwrap());
        assert!(!granted(&db,"phone","content.read","catalog","").unwrap());
        assert!(!granted(&db,"unknown","content.read","catalog","").unwrap());
    }
    #[test]
    fn unknown_services_are_never_authorized_by_trust() {
        let db = database();
        set_mode(&db,"phone",AuthorizationMode::Trusted).unwrap();
        assert!(!granted(&db,"phone","agent.execute","vault","vault-old").unwrap());
        assert!(!granted(&db,"phone","content.read","arbitrary","vault-old").unwrap());
    }
}
