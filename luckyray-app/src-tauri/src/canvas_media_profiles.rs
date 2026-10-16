//! Canvas media connections. Metadata and backend-only credentials are updated
//! in one SQLite transaction; no credentials appear in public snapshots.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

const CATALOG_KEY: &str = "canvasMediaProfiles.v1";
const REVISION_KEY: &str = "canvasMediaProfiles.revision";
const SECRET_PREFIX: &str = "canvasMediaProfileKey.";
fn legacy_text_protocol() -> String { "legacy".into() }

const MAX_PROFILES: usize = 32;
const UNAVAILABLE: &str = "canvas-media-profiles-unavailable";
const INVALID: &str = "canvas-media-profile-invalid";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Profile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub image_model: String,
    pub video_model: String,
    pub image_protocol: String,
    pub video_protocol: String,
    pub revision: u64,
    /// Model IDs discovered from the provider (bounded, sanitized). Optional
    /// so older catalogs keep loading; never auto-filled from responses of
    /// other commands.
    #[serde(default)]
    pub image_models: Option<Vec<String>>,
    #[serde(default)]
    pub video_models: Option<Vec<String>>,
    #[serde(default)]
    pub text_model: String,
    #[serde(default = "legacy_text_protocol")]
    pub text_protocol: String,
    #[serde(default)]
    pub text_models: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProfileInput {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub image_model: String,
    pub video_model: String,
    pub image_protocol: String,
    pub video_protocol: String,
    pub expected_revision: Option<u64>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    #[serde(default)]
    pub image_models: Option<Vec<String>>,
    #[serde(default)]
    pub video_models: Option<Vec<String>>,
    #[serde(default)]
    pub text_model: String,
    #[serde(default = "legacy_text_protocol")]
    pub text_protocol: String,
    #[serde(default)]
    pub text_models: Option<Vec<String>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Catalog { version: u32, active_profile_id: String, profiles: Vec<Profile> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProfileView { #[serde(flatten)] profile: Profile, api_key_configured: bool }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot { version: u32, active_profile_id: String, profiles: Vec<ProfileView> }

// Deliberately not Debug/Serialize: the runtime key never leaves the backend.
pub(crate) struct RuntimeProfile { pub profile: Profile, pub api_key: String }

fn read(conn: &Connection, key: &str) -> Result<Option<String>, &'static str> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0))
        .optional().map_err(|_| UNAVAILABLE)
}
fn write(conn: &Connection, key: &str, value: &str) -> Result<(), &'static str> {
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value])
        .map(|_| ()).map_err(|_| UNAVAILABLE)
}
fn secret_key(id: &str) -> String { format!("{SECRET_PREFIX}{id}") }
fn text(value: &str, max: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty()) && value.len() <= max && !value.chars().any(char::is_control)
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c,b'-'|b'_'))
}
/// HTTPS remains the default. Plain HTTP is opt-in through an explicitly entered
/// loopback literal only; canonicalise localhost to avoid consulting DNS.
pub(crate) fn validated_base(value: &str) -> Result<String, &'static str> {
    if !text(value, 2048, false) { return Err(INVALID); }
    let value=value.trim();
    let mut url = reqwest::Url::parse(value).map_err(|_| INVALID)?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() { return Err(INVALID); }
    if url.scheme()=="http" {
        let authority=value.strip_prefix("http://").ok_or(INVALID)?.split('/').next().ok_or(INVALID)?;
        let literal=if authority.starts_with('[') {authority.split(']').next().map(|v|format!("{v}]"))}
            else {authority.split(':').next().map(str::to_owned)}.ok_or(INVALID)?;
        if !matches!(literal.to_ascii_lowercase().as_str(),"localhost"|"127.0.0.1"|"[::1]") {return Err(INVALID);}
        if url.host_str()==Some("localhost") {url.set_host(Some("127.0.0.1")).map_err(|_|INVALID)?;}
        if !matches!(url.host_str(),Some("127.0.0.1"|"[::1]")){return Err(INVALID);}
    } else if url.scheme()!="https" {return Err(INVALID);}
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn validate_profile(profile: &Profile) -> Result<(), &'static str> {
    if !valid_id(&profile.id) || !text(&profile.name,160,false)
        || !text(&profile.image_model,128,true) || !text(&profile.video_model,128,true)
        || !text(&profile.text_model,128,true)
        || !matches!(profile.text_protocol.as_str(),"legacy"|"openai-chat"|"disabled")
        || profile.revision == 0 || profile.revision > 9_007_199_254_740_991
        || !matches!(profile.image_protocol.as_str(),"agnes"|"openai-image"|"gemini-image"|"12ai-task"|"disabled")
        || !matches!(profile.video_protocol.as_str(),"agnes"|"openai-video"|"12ai-task"|"disabled") { return Err(INVALID); }
    for list in [&profile.image_models, &profile.video_models, &profile.text_models] {
        let Some(ids) = list else { continue };
        if ids.len() > 500 { return Err(INVALID); }
        if ids.iter().any(|id| id.is_empty() || id.len() > 128 || id.chars().any(char::is_control)) {
            return Err(INVALID);
        }
    }
    validated_base(&profile.base_url)?;
    Ok(())
}
fn save_catalog(conn: &Connection, catalog: &Catalog) -> Result<(), &'static str> {
    write(conn,CATALOG_KEY,&serde_json::to_string(catalog).map_err(|_| INVALID)?)
}
fn load(conn: &Connection) -> Result<Catalog, &'static str> {
    if let Some(raw) = read(conn,CATALOG_KEY)? {
        if raw.len() > 256 * 1024 { return Err(INVALID); }
        let catalog: Catalog = serde_json::from_str(&raw).map_err(|_| INVALID)?;
        if catalog.version != 1 || catalog.profiles.is_empty() || catalog.profiles.len() > MAX_PROFILES
            || !catalog.profiles.iter().any(|p| p.id == catalog.active_profile_id) { return Err(INVALID); }
        let mut ids = std::collections::HashSet::new();
        for profile in &catalog.profiles {
            validate_profile(profile)?;
            if !ids.insert(&profile.id) { return Err(INVALID); }
        }
        return Ok(catalog);
    }
    let base_url = read(conn,"aiImageBaseURL")?.filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://apihub.agnes-ai.com/v1".into());
    let agnes = reqwest::Url::parse(&base_url).ok().and_then(|u| u.host_str().map(str::to_owned))
        .is_some_and(|h| h == "agnes-ai.com" || h.ends_with(".agnes-ai.com"));
    let profile = Profile {
        id:"legacy-media".into(), name:"原有生成配置".into(), base_url:validated_base(&base_url)?,
        image_model:read(conn,"aiImageModel")?.unwrap_or_else(|| "agnes-image-2.1-flash".into()),
        video_model:read(conn,"aiVideoModel")?.unwrap_or_else(|| "agnes-video-v2.0".into()),
        image_protocol:if agnes { "agnes" } else { "openai-image" }.into(),
        // Preserve the old adapter semantics; do not infer a new video protocol.
        video_protocol:"agnes".into(), revision:1,
        image_models:None, video_models:None, text_model:String::new(), text_protocol:legacy_text_protocol(), text_models:None,
    };
    validate_profile(&profile)?;
    if let Some(key) = read(conn,"aiImageApiKey")? {
        if !text(&key,8192,true) { return Err(INVALID); }
        write(conn,&secret_key(&profile.id),&key)?;
    }
    let catalog = Catalog {version:1,active_profile_id:profile.id.clone(),profiles:vec![profile]};
    save_catalog(conn,&catalog)?;
    Ok(catalog)
}
fn snapshot(conn: &Connection, catalog: Catalog) -> Result<Snapshot, &'static str> {
    let mut profiles = Vec::new();
    for profile in catalog.profiles {
        let configured = read(conn,&secret_key(&profile.id))?.is_some_and(|key| !key.trim().is_empty());
        profiles.push(ProfileView { profile, api_key_configured:configured });
    }
    Ok(Snapshot {version:1,active_profile_id:catalog.active_profile_id,profiles})
}
fn transact<T>(path: &Path, f: impl FnOnce(&Connection) -> Result<T,&'static str>) -> Result<T,&'static str> {
    let mut conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|_| UNAVAILABLE)?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|_| UNAVAILABLE)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_| UNAVAILABLE)?;
    let result = f(&tx)?;
    tx.commit().map_err(|_| UNAVAILABLE)?;
    Ok(result)
}
pub(crate) fn list(path: &Path) -> Result<Snapshot,&'static str> {
    transact(path,|conn| snapshot(conn,load(conn)?))
}
fn next_revision(conn: &Connection, catalog: &Catalog) -> Result<u64,&'static str> {
    // This counter survives deletion, so recreating an ID cannot revive an old task.
    let stored = read(conn,REVISION_KEY)?.map(|value|value.parse::<u64>().map_err(|_|INVALID)).transpose()?.unwrap_or(0);
    let highest = catalog.profiles.iter().map(|p|p.revision).max().unwrap_or(0).max(stored);
    let next = highest.checked_add(1).filter(|v|*v <= 9_007_199_254_740_991).ok_or(INVALID)?;
    write(conn,REVISION_KEY,&next.to_string())?;
    Ok(next)
}
pub(crate) fn upsert(path: &Path,input: ProfileInput) -> Result<Snapshot,&'static str> {
    transact(path,|conn| {
        let mut catalog = load(conn)?;
        let existing = catalog.profiles.iter().position(|p| p.id == input.id);
        let expected = existing.map(|i| catalog.profiles[i].revision);
        if input.expected_revision != expected { return Err("canvas-media-profile-conflict"); }
        if existing.is_none() && catalog.profiles.len() >= MAX_PROFILES { return Err("canvas-media-profile-limit"); }
        if input.clear_api_key && input.api_key.as_ref().is_some_and(|s| !s.trim().is_empty()) { return Err(INVALID); }
        let key = input.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if key.is_some_and(|s| !text(s,8192,false)) { return Err(INVALID); }
        let profile = Profile {id:input.id.clone(),name:input.name.trim().into(),base_url:validated_base(&input.base_url)?,
            image_model:input.image_model.trim().into(),video_model:input.video_model.trim().into(),
            image_protocol:input.image_protocol.clone(),video_protocol:input.video_protocol.clone(),
            revision:next_revision(conn, &catalog)?,
            image_models:input.image_models.clone(),video_models:input.video_models.clone(),
            text_model:input.text_model.trim().into(),text_protocol:input.text_protocol.clone(),text_models:input.text_models.clone()};
        validate_profile(&profile)?;
        if let Some(i) = existing {
            let old = reqwest::Url::parse(&catalog.profiles[i].base_url).map_err(|_| INVALID)?;
            let new = reqwest::Url::parse(&profile.base_url).map_err(|_| INVALID)?;
            if old.origin() != new.origin() && key.is_none() && !input.clear_api_key
                && read(conn,&secret_key(&profile.id))?.is_some_and(|s| !s.trim().is_empty()) {
                return Err("canvas-media-profile-origin-key-required");
            }
            catalog.profiles[i] = profile.clone();
        } else { catalog.profiles.push(profile.clone()); }
        if input.clear_api_key {
            conn.execute("DELETE FROM settings WHERE key=?1",[secret_key(&profile.id)]).map_err(|_| UNAVAILABLE)?;
        } else if let Some(key) = key { write(conn,&secret_key(&profile.id),key)?; }
        save_catalog(conn,&catalog)?;
        snapshot(conn,catalog)
    })
}
pub(crate) fn activate(path: &Path,id: &str) -> Result<Snapshot,&'static str> {
    transact(path,|conn| {
        let mut catalog = load(conn)?;
        if !catalog.profiles.iter().any(|p|p.id == id) { return Err("canvas-media-profile-missing"); }
        catalog.active_profile_id = id.into();
        save_catalog(conn,&catalog)?;
        snapshot(conn,catalog)
    })
}
pub(crate) fn remove(path: &Path,id: &str,revision: u64) -> Result<Snapshot,&'static str> {
    transact(path,|conn| {
        let mut catalog = load(conn)?;
        if catalog.profiles.len() <= 1 { return Err("canvas-media-profile-keep-one"); }
        let i = catalog.profiles.iter().position(|p|p.id == id).ok_or("canvas-media-profile-missing")?;
        if catalog.profiles[i].revision != revision { return Err("canvas-media-profile-conflict"); }
        catalog.profiles.remove(i);
        if catalog.active_profile_id == id { catalog.active_profile_id = catalog.profiles[0].id.clone(); }
        conn.execute("DELETE FROM settings WHERE key=?1",[secret_key(id)]).map_err(|_| UNAVAILABLE)?;
        save_catalog(conn,&catalog)?;
        snapshot(conn,catalog)
    })
}
pub(crate) fn resolve(path: &Path,id: Option<&str>,revision: Option<u64>) -> Result<RuntimeProfile,&'static str> {
    transact(path,|conn| {
        let catalog = load(conn)?;
        if id.is_some() != revision.is_some() { return Err(INVALID); }
        let id = id.unwrap_or(&catalog.active_profile_id);
        let profile = catalog.profiles.into_iter().find(|p|p.id == id).ok_or("canvas-media-profile-missing")?;
        if revision.is_some_and(|r|r != profile.revision) { return Err("canvas-media-profile-changed"); }
        let api_key = read(conn,&secret_key(&profile.id))?.unwrap_or_default();
        if !text(&api_key,8192,true) { return Err(INVALID); }
        Ok(RuntimeProfile {profile,api_key})
    })
}

pub(crate) fn text_runtime_config(runtime: RuntimeProfile, requested: Option<&str>) -> Result<crate::AiModelConfig, &'static str> {
    if runtime.profile.text_protocol != "openai-chat" { return Err("canvas-text-disabled"); }
    let model = requested.filter(|m| !m.trim().is_empty()).unwrap_or(&runtime.profile.text_model).trim();
    if !text(model,128,false) { return Err(INVALID); }
    let base = validated_base(&runtime.profile.base_url)?;
    Ok(crate::AiModelConfig {provider:"custom".into(),protocol:"openai-compatible".into(),api_key:runtime.api_key,model:model.into(),custom_url:Some(base)})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        Connection::open(file.path()).unwrap().execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);").unwrap();
        file
    }
    fn input(id: &str) -> ProfileInput { ProfileInput { id:id.into(),name:id.into(),base_url:"https://example.test/v1".into(),image_model:"image".into(),video_model:"video".into(),image_protocol:"openai-image".into(),video_protocol:"disabled".into(),expected_revision:None,api_key:Some("synthetic-key".into()),clear_api_key:false,image_models:None,video_models:None,text_model:String::new(),text_protocol:legacy_text_protocol(),text_models:None } }
    #[test]
    fn local_http_requires_explicit_loopback_and_never_uses_dns() {
        assert_eq!(validated_base("http://localhost:8317/v1").unwrap(),"http://127.0.0.1:8317/v1");
        assert_eq!(validated_base("http://127.0.0.1:8317/openai/v1").unwrap(),"http://127.0.0.1:8317/openai/v1");
        assert_eq!(validated_base("http://[::1]:8317/v1").unwrap(),"http://[::1]:8317/v1");
        for raw in ["http://192.168.1.2/v1","http://0.0.0.0:8317","http://example.test/v1","http://127.0.0.1.attacker.test/v1","http://localhost./v1","http://127.1/v1","http://2130706433/v1","http://127.0.0.1@evil.test/v1","http://u:p@127.0.0.1/v1","http://127.0.0.1/v1?key=x","http://[::ffff:127.0.0.1]/v1","file:///tmp/api"] { assert!(validated_base(raw).is_err(),"{raw}"); }
        assert_eq!(validated_base("https://example.test/v1").unwrap(),"https://example.test/v1");
    }
    #[test]
    fn migration_is_idempotent_and_never_projects_secrets() {
        let db = db();let conn = Connection::open(db.path()).unwrap();
        write(&conn,"aiImageApiKey","legacy-secret").unwrap();
        let a=list(db.path()).unwrap();let b=list(db.path()).unwrap();
        assert_eq!(a.profiles.len(),1);assert_eq!(b.profiles.len(),1);
        assert!(!serde_json::to_string(&a).unwrap().contains("legacy-secret"));
        assert_eq!(resolve(db.path(),Some("legacy-media"),Some(1)).unwrap().api_key,"legacy-secret");
    }
    #[test]
    fn switching_does_not_retarget_pinned_work_and_edits_fail_closed() {
        let db=db();upsert(db.path(),input("a")).unwrap();upsert(db.path(),input("b")).unwrap();
        activate(db.path(),"a").unwrap();activate(db.path(),"b").unwrap();
        assert_eq!(resolve(db.path(),Some("a"),Some(2)).unwrap().profile.id,"a");
        let mut next=input("a");next.expected_revision=Some(2);next.api_key=None;upsert(db.path(),next).unwrap();
        assert!(matches!(resolve(db.path(),Some("a"),Some(2)),Err("canvas-media-profile-changed")));
        assert_eq!(resolve(db.path(),Some("a"),Some(4)).unwrap().api_key,"synthetic-key");
    }
    #[test]
    fn origin_change_requires_explicit_new_key_and_clear_is_scoped() {
        let db=db();upsert(db.path(),input("a")).unwrap();upsert(db.path(),input("b")).unwrap();
        let mut next=input("a");next.expected_revision=Some(2);next.api_key=None;next.base_url="https://other.test/v1".into();
        assert!(matches!(upsert(db.path(),next),Err("canvas-media-profile-origin-key-required")));
        let mut clear=input("a");clear.expected_revision=Some(2);clear.api_key=None;clear.clear_api_key=true;upsert(db.path(),clear).unwrap();
        assert!(resolve(db.path(),Some("a"),Some(4)).unwrap().api_key.is_empty());
        assert_eq!(resolve(db.path(),Some("b"),Some(3)).unwrap().api_key,"synthetic-key");
    }
    #[test]
    fn recreated_id_cannot_retarget_a_retired_task() {
        let db=db();upsert(db.path(),input("a")).unwrap();
        remove(db.path(),"a",2).unwrap();upsert(db.path(),input("a")).unwrap();
        assert!(matches!(resolve(db.path(),Some("a"),Some(2)),Err("canvas-media-profile-changed")));
        assert_eq!(resolve(db.path(),Some("a"),Some(3)).unwrap().profile.id,"a");
    }
    #[test]
    fn corrupt_catalog_does_not_overwrite_itself_or_remigrate() {
        let db=db();let conn=Connection::open(db.path()).unwrap();write(&conn,CATALOG_KEY,"broken").unwrap();
        assert!(list(db.path()).is_err());assert_eq!(read(&conn,CATALOG_KEY).unwrap().as_deref(),Some("broken"));
    }
    #[test]
    fn text_profile_is_independent_secret_safe_and_revision_pinned() {
        let db=db();let mut a=input("text");a.text_model="synthetic-chat".into();a.text_protocol="openai-chat".into();
        let view=upsert(db.path(),a).unwrap();
        assert!(!serde_json::to_string(&view).unwrap().contains("synthetic-key"));
        let runtime=resolve(db.path(),Some("text"),Some(2)).unwrap();
        let config=text_runtime_config(runtime,None).unwrap();
        assert_eq!(config.model,"synthetic-chat");assert_eq!(config.provider,"custom");
        assert_eq!(config.custom_url.as_deref(),Some("https://example.test/v1"));
        let mut changed=input("text");changed.expected_revision=Some(2);upsert(db.path(),changed).unwrap();
        assert!(resolve(db.path(),Some("text"),Some(2)).is_err());
    }
    #[test]
    fn old_text_metadata_defaults_to_legacy_without_secret_copy() {
        let db=db();list(db.path()).unwrap();
        let conn=Connection::open(db.path()).unwrap();
        let mut catalog:serde_json::Value=serde_json::from_str(&read(&conn,CATALOG_KEY).unwrap().unwrap()).unwrap();
        for profile in catalog["profiles"].as_array_mut().unwrap(){
            for field in ["textModel","textProtocol","textModels"] {profile.as_object_mut().unwrap().remove(field);}
        }
        write(&conn,CATALOG_KEY,&catalog.to_string()).unwrap();
        let runtime=resolve(db.path(),None,None).unwrap();
        assert_eq!(runtime.profile.text_protocol,"legacy");
        assert!(text_runtime_config(runtime,None).is_err());
    }

}
