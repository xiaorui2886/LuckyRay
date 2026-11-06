//! Windows user-bound protection for AI settings. Metadata stays in settings;
//! the four existing secret key families contain only versioned DPAPI blobs.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use zeroize::Zeroize;

const PREFIX: &str = "luckyray-dpapi-v1:";
const UNAVAILABLE: &str = "ai-secret-storage-unavailable";
const RECOVERY: &str = "ai-secret-storage-recovery-required";

pub(crate) fn is_secret(key: &str) -> bool {
    matches!(key, "aiApiKey" | "aiImageApiKey")
        || key.starts_with("aiProfileApiKey.") || key.starts_with("canvasMediaProfileKey.")
}
fn raw(conn: &Connection, key: &str) -> Result<Option<String>, &'static str> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| row.get(0))
        .optional().map_err(|_| UNAVAILABLE)
}
pub(crate) fn has(conn: &Connection, key: &str) -> Result<bool, &'static str> {
    Ok(raw(conn,key)?.is_some_and(|value| !value.trim().is_empty()))
}
fn decode(value: &str) -> Result<String, &'static str> {
    if value.is_empty() { return Ok(String::new()); }
    let bytes = STANDARD.decode(value.strip_prefix(PREFIX).ok_or(RECOVERY)?).map_err(|_| RECOVERY)?;
    let clear = unprotect(&bytes)?;
    String::from_utf8(clear).map_err(|_| RECOVERY)
}
fn encoded(value: &str) -> Result<String, &'static str> {
    if value.is_empty() { return Ok(String::new()); }
    let result = format!("{PREFIX}{}", STANDARD.encode(protect(value.as_bytes())?));
    let mut verified = decode(&result)?;
    let matches = verified == value;
    verified.zeroize();
    if !matches { return Err(RECOVERY); }
    Ok(result)
}
/// Runtime reads never expose a stored ciphertext or silently accept plaintext.
/// Migration belongs to the settings/runtime entry boundary below.
pub(crate) fn read(conn: &Connection, key: &str) -> Result<Option<String>, &'static str> {
    raw(conn,key)?.map(|value|decode(&value)).transpose()
}
pub(crate) fn write(conn: &Connection, key: &str, value: &str) -> Result<(), &'static str> {
    if value.len() > 8192 || value.chars().any(char::is_control) || value.starts_with(PREFIX) {
        return Err("ai-secret-invalid");
    }

    let protected = encoded(value)?;
    conn.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,protected])
        .map_err(|_| UNAVAILABLE)?;
    Ok(())
}
/// Called at the settings boundary, not at every internal layer. All migrations
/// commit together, so a failure cannot leave half the catalog migrated.
pub(crate) fn migrate(conn: &Connection) -> Result<(), &'static str> {
    conn.pragma_update(None, "secure_delete", "ON").map_err(|_| UNAVAILABLE)?;
    let tx = conn.unchecked_transaction().map_err(|_| UNAVAILABLE)?;
    let keys: Vec<String> = {
        let mut stmt = tx.prepare("SELECT key FROM settings WHERE key IN ('aiApiKey','aiImageApiKey') OR key LIKE 'aiProfileApiKey.%' OR key LIKE 'canvasMediaProfileKey.%'").map_err(|_| UNAVAILABLE)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(|_| UNAVAILABLE)?;
        rows.collect::<Result<_,_>>().map_err(|_| UNAVAILABLE)?
    };
    let pending_key = "aiSecrets.checkpointPending.v1";
    for key in keys {
        if let Some(mut value) = raw(&tx,&key)?.filter(|value| !value.is_empty() && !value.starts_with(PREFIX)) {
            let protected = encoded(&value)?;
            tx.execute("UPDATE settings SET value=?1 WHERE key=?2",params![protected,key]).map_err(|_|UNAVAILABLE)?;
            let mut verified = read(&tx,&key)?.ok_or(UNAVAILABLE)?;
            let matches = verified == value;
            value.zeroize(); verified.zeroize();
            if !matches { return Err(RECOVERY); }
            tx.execute("INSERT OR REPLACE INTO settings(key,value) VALUES(?1,'1')",[pending_key]).map_err(|_|UNAVAILABLE)?;
        }
    }
    let pending = raw(&tx,pending_key)?.is_some();
    tx.commit().map_err(|_| UNAVAILABLE)?;
    if pending {
        // Only old-secret migration requests this checkpoint. An open reader
        // can prevent truncation: retain the durable marker and report pending
        // instead of claiming the active WAL is clear. Retry at next boundary.
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)",[],|row|row.get(0))
            .map_err(|_| "ai-secret-migration-checkpoint-pending")?;
        if busy != 0 { return Err("ai-secret-migration-checkpoint-pending"); }
        conn.execute("DELETE FROM settings WHERE key=?1",[pending_key]).map_err(|_|UNAVAILABLE)?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct Configured { pub ai_api_key_configured: bool, pub ai_image_api_key_configured: bool }
pub(crate) fn configured(conn: &Connection) -> Result<Configured,&'static str> {
    Ok(Configured { ai_api_key_configured: raw(conn,"aiApiKey")?.is_some_and(|v| !v.is_empty()),
        ai_image_api_key_configured: raw(conn,"aiImageApiKey")?.is_some_and(|v| !v.is_empty()) })
}

#[cfg(windows)]
fn protect(plaintext: &[u8]) -> Result<Vec<u8>, &'static str> {
    use windows::{core::w,Win32::{Foundation::{LocalFree,HLOCAL},Security::Cryptography::{CryptProtectData,CRYPTPROTECT_UI_FORBIDDEN,CRYPT_INTEGER_BLOB}}};
    let input=CRYPT_INTEGER_BLOB { cbData: plaintext.len().try_into().map_err(|_| UNAVAILABLE)?, pbData:plaintext.as_ptr() as *mut u8 };
    let mut output=CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input,w!("LuckyRay AI settings"),None,None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output).map_err(|_|UNAVAILABLE)?;
        let bytes=std::slice::from_raw_parts_mut(output.pbData,output.cbData as usize);
        let result=bytes.to_vec();bytes.zeroize();let _=LocalFree(Some(HLOCAL(output.pbData.cast())));Ok(result)
    }
}
#[cfg(windows)]
fn unprotect(protected: &[u8]) -> Result<Vec<u8>, &'static str> {
    use windows::Win32::{Foundation::{LocalFree,HLOCAL},Security::Cryptography::{CryptUnprotectData,CRYPTPROTECT_UI_FORBIDDEN,CRYPT_INTEGER_BLOB}};
    let input=CRYPT_INTEGER_BLOB { cbData:protected.len().try_into().map_err(|_| RECOVERY)?,pbData:protected.as_ptr() as *mut u8 };
    let mut output=CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input,None,None,None,None,CRYPTPROTECT_UI_FORBIDDEN,&mut output).map_err(|_|RECOVERY)?;
        let bytes=std::slice::from_raw_parts_mut(output.pbData,output.cbData as usize);
        let result=bytes.to_vec();bytes.zeroize();let _=LocalFree(Some(HLOCAL(output.pbData.cast())));Ok(result)
    }
}
#[cfg(all(not(windows),not(test)))]
fn protect(_: &[u8]) -> Result<Vec<u8>, &'static str> { Err("ai-secret-platform-unsupported") }
#[cfg(all(not(windows),not(test)))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>, &'static str> { Err("ai-secret-platform-unsupported") }
// Linux unit tests use an explicitly synthetic codec, never shipped in a
// non-test binary. Windows tests exercise real DPAPI instead.
#[cfg(all(not(windows),test))]
fn protect(v:&[u8])->Result<Vec<u8>,&'static str>{ if v==b"__test_protection_failure__" {return Err(UNAVAILABLE);} Ok(v.iter().map(|b|b^0x5a).collect()) }
#[cfg(all(not(windows),test))]
fn unprotect(v:&[u8])->Result<Vec<u8>,&'static str>{ Ok(v.iter().map(|b|b^0x5a).collect()) }

#[cfg(test)]
mod tests {
 use super::*;
 fn db()->Connection { let c=Connection::open_in_memory().unwrap();c.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();c }
 #[test] fn migrates_all_families_without_plaintext_projection(){let c=db();for k in ["aiApiKey","aiImageApiKey","aiProfileApiKey.a","canvasMediaProfileKey.a"] {c.execute("INSERT INTO settings VALUES(?1,'synthetic-secret')",[k]).unwrap();}migrate(&c).unwrap();for k in ["aiApiKey","aiImageApiKey","aiProfileApiKey.a","canvasMediaProfileKey.a"]{assert!(raw(&c,k).unwrap().unwrap().starts_with(PREFIX));assert_eq!(read(&c,k).unwrap().as_deref(),Some("synthetic-secret"));}let json=serde_json::to_string(&configured(&c).unwrap()).unwrap();assert!(!json.contains("synthetic-secret"));assert!(!json.contains(PREFIX));}
 #[test] fn bad_cipher_stays_recoverable_and_never_becomes_api_key(){let c=db();c.execute("INSERT INTO settings VALUES('aiApiKey','old-key')",[]).unwrap();c.execute("INSERT INTO settings VALUES('aiImageApiKey',?1)",[format!("{PREFIX}invalid!")]).unwrap();migrate(&c).unwrap();assert_eq!(read(&c,"aiApiKey").unwrap().as_deref(),Some("old-key"));assert_eq!(read(&c,"aiImageApiKey"),Err(RECOVERY));}
 #[cfg(not(windows))]
 #[test] fn failed_migration_rolls_back_all_legacy_values(){let c=db();c.execute("INSERT INTO settings VALUES('aiApiKey','old-key')",[]).unwrap();c.execute("INSERT INTO settings VALUES('aiImageApiKey','__test_protection_failure__')",[]).unwrap();assert_eq!(migrate(&c),Err(UNAVAILABLE));assert_eq!(raw(&c,"aiApiKey").unwrap().as_deref(),Some("old-key"));}
 #[test] fn historical_whitespace_and_long_values_can_be_migrated_and_replaced(){let c=db();let old=format!("  {}\n", "x".repeat(8200));c.execute("INSERT INTO settings VALUES('aiApiKey',?1)",[&old]).unwrap();migrate(&c).unwrap();assert_eq!(read(&c,"aiApiKey").unwrap(),Some(old));write(&c,"aiApiKey","replacement").unwrap();assert_eq!(read(&c,"aiApiKey").unwrap().as_deref(),Some("replacement"));}
 #[test] fn missing_and_corrupt_are_distinct_and_corrupt_can_be_replaced(){let c=db();assert_eq!(read(&c,"aiApiKey"),Ok(None));c.execute("INSERT INTO settings VALUES('aiApiKey',?1)",[format!("{PREFIX}!bad")]).unwrap();assert_eq!(read(&c,"aiApiKey"),Err(RECOVERY));assert!(configured(&c).unwrap().ai_api_key_configured);write(&c,"aiApiKey","replacement").unwrap();assert_eq!(read(&c,"aiApiKey").unwrap().as_deref(),Some("replacement"));}
 #[test] fn updates_and_clear_remain_protected(){let c=db();write(&c,"aiApiKey","one").unwrap();write(&c,"aiApiKey","two").unwrap();assert_eq!(read(&c,"aiApiKey").unwrap().as_deref(),Some("two"));write(&c,"aiApiKey","").unwrap();assert!(!configured(&c).unwrap().ai_api_key_configured);assert_eq!(write(&c,"aiApiKey",&format!("{PREFIX}abc")),Err("ai-secret-invalid"));}
 fn file_contains(path:&std::path::Path, key:&str)->bool {std::fs::read(path).unwrap_or_default().windows(key.len()).any(|b|b==key.as_bytes())}
 #[test] fn migration_removes_old_secret_from_active_db_and_wal(){
 let temp=tempfile::tempdir().unwrap();let path=temp.path().join("synthetic.sqlite");let c=Connection::open(&path).unwrap();c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();
 let key="SYNTHETIC-UNIQUE-LEGACY-WAL-20261030";c.execute("INSERT INTO settings VALUES('aiApiKey',?1)",[key]).unwrap();let other=Connection::open(&path).unwrap();assert!(file_contains(&path.with_extension("sqlite-wal"),key));migrate(&c).unwrap();assert!(!file_contains(&path,key));assert!(!file_contains(&path.with_extension("sqlite-wal"),key));assert_eq!(read(&other,"aiApiKey").unwrap().as_deref(),Some(key));
 }
 #[test] fn busy_checkpoint_is_reported_and_retried_after_reader_releases(){
 let temp=tempfile::tempdir().unwrap();let path=temp.path().join("synthetic.sqlite");let c=Connection::open(&path).unwrap();c.busy_timeout(std::time::Duration::ZERO).unwrap();c.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)").unwrap();let key="SYNTHETIC-BUSY-WAL-20261030";c.execute("INSERT INTO settings VALUES('aiApiKey',?1)",[key]).unwrap();let reader=Connection::open(&path).unwrap();reader.execute_batch("BEGIN; SELECT * FROM settings").unwrap();assert_eq!(migrate(&c),Err("ai-secret-migration-checkpoint-pending"));assert!(raw(&c,"aiApiKey").unwrap().unwrap().starts_with(PREFIX));assert!(raw(&c,"aiSecrets.checkpointPending.v1").unwrap().is_some());assert!(file_contains(&path.with_extension("sqlite-wal"),key));drop(c);let c=Connection::open(&path).unwrap();c.busy_timeout(std::time::Duration::ZERO).unwrap();assert_eq!(migrate(&c),Err("ai-secret-migration-checkpoint-pending"));reader.execute_batch("ROLLBACK").unwrap();migrate(&c).unwrap();assert!(raw(&c,"aiSecrets.checkpointPending.v1").unwrap().is_none());assert!(!file_contains(&path,key));assert!(!file_contains(&path.with_extension("sqlite-wal"),key));
 reader.execute_batch("BEGIN; SELECT * FROM settings").unwrap();c.execute("INSERT INTO settings VALUES('theme','preserved')",[]).unwrap();assert!(migrate(&c).is_ok());assert_eq!(raw(&c,"theme").unwrap().as_deref(),Some("preserved"));reader.execute_batch("ROLLBACK").unwrap();
 }

}
