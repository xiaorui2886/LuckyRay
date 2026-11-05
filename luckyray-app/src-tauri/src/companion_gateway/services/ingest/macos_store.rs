//! Descriptor-relative, immutable staging for Mac knowledge ingest.
//! Bytes never enter the backed-up main database. Completed owned chunks are
//! emptied through verified descriptors; unknown objects are never adopted.
use crate::macos_fs::{reclaim_owned_staging, Directory};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;

type Result<T> = std::result::Result<T, (u16, &'static str)>;
const UNAVAILABLE: (u16, &str) = (503, "SERVICE_UNAVAILABLE");
const OFFSET: (u16, &str) = (409, "UPLOAD_OFFSET_MISMATCH");
pub(super) const BLOCK: usize = 256 * 1024;
// A request may legally contain one byte. Refuse an unbounded number of files,
// rather than filling a user's disk; normal 64 MiB clients need 256 chunks.
const MAX_CHUNKS: u64 = 8192;
const MAX_UNCONFIRMED: u64 = 16;

fn db(_: rusqlite::Error) -> (u16, &'static str) { UNAVAILABLE }
fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn fresh_name() -> String {
    let mut bytes = [0u8; 16]; OsRng.fill_bytes(&mut bytes);
    format!(".lrservice-{}.chunk", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
}
fn valid_name(name: &str) -> bool {
    name.strip_prefix(".lrservice-").and_then(|s| s.strip_suffix(".chunk"))
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}
fn manifest_hash(manifest: &Value) -> Result<String> {
    serde_json::to_vec(manifest).map(|bytes| digest(&bytes)).map_err(|_| UNAVAILABLE)
}
const SESSION_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS companion_macos_service_session (
        job_id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL, device_id TEXT NOT NULL,
        manifest_hash TEXT NOT NULL, clear_uncertain INTEGER NOT NULL DEFAULT 0)";
const CHUNK_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS companion_macos_service_chunk (
        job_id TEXT NOT NULL, start INTEGER NOT NULL, size INTEGER NOT NULL, hash TEXT NOT NULL,
        name TEXT NOT NULL, object TEXT, PRIMARY KEY(job_id,start))";
const ABANDONED_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS companion_macos_service_abandoned (
        job_id TEXT NOT NULL, start INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY(job_id,start,name))";
const RETIRED_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS companion_macos_service_retired (
        job_id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL, device_id TEXT NOT NULL,
        op_id TEXT NOT NULL, prior_stage TEXT NOT NULL)";
fn compact(value: &str) -> String { value.chars().filter(|c| !c.is_ascii_whitespace()).flat_map(char::to_lowercase).collect() }
fn setup(c: &Connection) -> Result<()> {
    c.pragma_update(None, "synchronous", "FULL").map_err(db)?;
    for (name, schema) in [("companion_macos_service_session",SESSION_SCHEMA),
        ("companion_macos_service_chunk",CHUNK_SCHEMA),("companion_macos_service_abandoned",ABANDONED_SCHEMA),
        ("companion_macos_service_retired",RETIRED_SCHEMA)] {
        c.execute_batch(schema).map_err(db)?;
        let recorded: String = c.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1", [name], |r|r.get(0)).map_err(db)?;
        if compact(&recorded) != compact(&schema.replace("IF NOT EXISTS ", "")) { return Err(UNAVAILABLE); }
    }
    // Do not accept an unrelated table with a compatible name but different
    // columns, primary key or application triggers as our authority.
    for (table, expected) in [
        ("companion_macos_service_session", vec![("job_id","TEXT",1,1),("instance_id","TEXT",1,0),
            ("device_id","TEXT",1,0),("manifest_hash","TEXT",1,0),("clear_uncertain","INTEGER",1,0)]),
        ("companion_macos_service_chunk", vec![("job_id","TEXT",1,1),("start","INTEGER",1,2),
            ("size","INTEGER",1,0),("hash","TEXT",1,0),("name","TEXT",1,0),("object","TEXT",0,0)]),
        ("companion_macos_service_abandoned", vec![("job_id","TEXT",1,1),("start","INTEGER",1,2),("name","TEXT",1,3)]),
        ("companion_macos_service_retired", vec![("job_id","TEXT",1,1),("instance_id","TEXT",1,0),
            ("device_id","TEXT",1,0),("op_id","TEXT",1,0),("prior_stage","TEXT",1,0)]),
    ] {
        let mut statement = c.prepare("SELECT name, upper(type), \"notnull\", pk FROM pragma_table_info(?1) ORDER BY cid").map_err(db)?;
        let rows = statement.query_map([table], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?,row.get::<_,i64>(3)?)))
            .map_err(db)?.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?;
        if rows.len() != expected.len() || rows.iter().zip(expected).any(|(a,b)| a.0 != b.0 || a.1 != b.1 || a.2 != b.2 || a.3 != b.3) {
            return Err(UNAVAILABLE);
        }
        let triggers: u64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1", [table], |row| row.get(0)).map_err(db)?;
        if triggers != 0 { return Err(UNAVAILABLE); }
    }
    Ok(())
}

/// The held directory creates or reads only names relative to its descriptor.
/// A moved parent is detected where possible; same-user interference is not a lock.
fn staging(app_path: &Path) -> Result<Directory> {
    let app = Directory::open_owned(app_path, false).map_err(|_| UNAVAILABLE)?;
    let media = app.child(OsStr::new("media-transfer-staging"), true).map_err(|_| UNAVAILABLE)?;
    let private = media.child(OsStr::new("macos-service-knowledge"), true).map_err(|_| UNAVAILABLE)?;
    let named = Directory::open(&app_path.join("media-transfer-staging").join("macos-service-knowledge"), false, true).map_err(|_| UNAVAILABLE)?;
    private.current().map_err(|_| UNAVAILABLE)?;
    let metadata = private.identity_file().map_err(|_| UNAVAILABLE)?.metadata().map_err(|_| UNAVAILABLE)?;
    let named_meta = named.identity_file().map_err(|_| UNAVAILABLE)?.metadata().map_err(|_| UNAVAILABLE)?;
    if (metadata.dev(), metadata.ino()) != (named_meta.dev(), named_meta.ino()) { return Err(UNAVAILABLE); }
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 { return Err(UNAVAILABLE); }
    crate::macos_fs::require_empty_acl(&private.identity_file().map_err(|_| UNAVAILABLE)?).map_err(|_| UNAVAILABLE)?;
    Ok(named)
}

/// Main DB retains only manifest fingerprint, small metadata and offsets.
/// An old unfinished job has no marker and is never inferred to be ours.
pub(super) fn owned(c: &Connection, job: &str, instance: &str, device: &str, manifest: &Value) -> Result<bool> {
    setup(c)?;
    let actual: Option<(String,String,String,i64)> = c.query_row(
        "SELECT instance_id,device_id,manifest_hash,clear_uncertain FROM companion_macos_service_session WHERE job_id=?1",
        [job], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(db)?;
    Ok(actual.is_some_and(|(i,d,h,u)| i == instance && d == device && u == 0 && Some(h) == manifest_hash(manifest).ok()))
}

pub(super) fn prepare(c: &Connection) -> Result<()> { setup(c) }

/// The caller must hold the app's exclusive clear gate. A staging job has no
/// published effect; a committing job may already have published, so it is
/// retained as uncertain and never silently repeated. Bytes are not unlinked.
pub(super) fn retire_for_clear(c: &mut Connection, updated: &str) -> Result<()> {
    setup(c)?;
    let tx = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
    // Existing legacy Knowledge jobs have no Mac session; a matching .part is
    // not proof of ownership. Preserve their job IDs and prior stage without
    // opening, claiming, changing, or deleting the corresponding paths.
    {
        let mut statement = tx.prepare("SELECT u.job_id,u.instance_id,u.device_id,u.op_id,u.stage,u.manifest FROM companion_service_upload u LEFT JOIN companion_macos_service_session s ON s.job_id=u.job_id WHERE s.job_id IS NULL AND u.stage IN ('staging','committing')").map_err(db)?;
        let mut rows = statement.query([]).map_err(db)?;
        while let Some(row)=rows.next().map_err(db)? {
            let manifest:String=row.get(5).map_err(db)?;
            let parsed=serde_json::from_str::<Value>(&manifest);
            if parsed.as_ref().ok().and_then(|m|m["target"]["domain"].as_str()) != Some("knowledge") {continue;}
            let job:String=row.get(0).map_err(db)?;
            let instance:String=row.get(1).map_err(db)?;
            let device:String=row.get(2).map_err(db)?;
            let op:String=row.get(3).map_err(db)?;
            let stage:String=row.get(4).map_err(db)?;
            tx.execute("INSERT OR IGNORE INTO companion_macos_service_retired(job_id,instance_id,device_id,op_id,prior_stage) VALUES(?1,?2,?3,?4,?5)",params![job,instance,device,op,stage]).map_err(db)?;
        }
    }
    tx.execute("UPDATE companion_service_upload SET stage='cancelled',committed_bytes=0,updated_at=?1
       WHERE stage='staging' AND EXISTS (SELECT 1 FROM companion_macos_service_session s WHERE s.job_id=companion_service_upload.job_id AND s.instance_id=companion_service_upload.instance_id AND s.device_id=companion_service_upload.device_id AND s.clear_uncertain=0)", [updated]).map_err(db)?;
    tx.execute("UPDATE companion_macos_service_session SET clear_uncertain=1 WHERE EXISTS
       (SELECT 1 FROM companion_service_upload u WHERE u.job_id=companion_macos_service_session.job_id AND u.instance_id=companion_macos_service_session.instance_id AND u.device_id=companion_macos_service_session.device_id AND u.stage='committing')", []).map_err(db)?;
    // Clearing a logical job does not release its recorded file descriptors.
    // Preserve ownership evidence until data has actually been reclaimed.
    tx.commit().map_err(db)
}

pub(super) fn begin(c: &mut Connection, job: &str, instance: &str, device: &str,
    op: &str, manifest: &Value, updated: &str) -> Result<u64> {
    setup(c)?;
    let committed = manifest["text"].as_str().map_or(0, |text| text.len() as u64);
    let serialized = serde_json::to_string(manifest).map_err(|_| UNAVAILABLE)?;
    let hash = manifest_hash(manifest)?;
    let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
    transaction.execute("INSERT INTO companion_service_upload(job_id,instance_id,device_id,op_id,manifest,
      committed_bytes,stage,updated_at) VALUES(?1,?2,?3,?4,?5,?6,'staging',?7)",
      params![job,instance,device,op,serialized,committed,updated]).map_err(db)?;
    transaction.execute("INSERT INTO companion_macos_service_session(job_id,instance_id,device_id,manifest_hash)
      VALUES(?1,?2,?3,?4)", params![job,instance,device,hash]).map_err(db)?;
    transaction.commit().map_err(db)?;
    Ok(committed)
}

struct Chunk { start: u64, size: u64, hash: String, name: String, object: Option<String> }
fn read_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Chunk> {
    Ok(Chunk { start: r.get(0)?, size: r.get(1)?, hash: r.get(2)?, name: r.get(3)?, object: r.get(4)? })
}
fn chunk(c: &Connection, job: &str, at: u64) -> Result<Option<Chunk>> {
    c.query_row("SELECT start,size,hash,name,object FROM companion_macos_service_chunk WHERE job_id=?1 AND start=?2",
        params![job,at], read_row).optional().map_err(db)
}
fn read_file(directory: &Directory, row: &Chunk) -> Result<Vec<u8>> {
    if !valid_name(&row.name) || row.size == 0 || row.size > BLOCK as u64 { return Err(UNAVAILABLE); }
    let object = row.object.as_ref().ok_or(UNAVAILABLE)?;
    let (bytes, version) = directory.read_owned(OsStr::new(&row.name)).map_err(|_| UNAVAILABLE)?.ok_or(UNAVAILABLE)?;
    if format!("{:x}:{:x}", version.device, version.inode) != *object
        || bytes.len() as u64 != row.size || version.hash != row.hash { return Err(UNAVAILABLE); }
    Ok(bytes)
}

/// Reads a bounded slice and checks every object, including a replay spanning
/// several originally submitted chunks. This can never follow a symlink.
pub(super) fn range(c: &Connection, app: &Path, job: &str, committed: u64, start: u64, len: usize) -> Result<Vec<u8>> {
    if len > BLOCK || start.checked_add(len as u64).is_none_or(|end| end > committed) { return Err(OFFSET); }
    let directory = staging(app)?;
    let mut result = Vec::with_capacity(len);
    let mut at = start;
    while result.len() < len {
        let row = c.query_row("SELECT start,size,hash,name,object FROM companion_macos_service_chunk
          WHERE job_id=?1 AND start<=?2 ORDER BY start DESC LIMIT 1", params![job,at], read_row)
          .optional().map_err(db)?.ok_or(UNAVAILABLE)?;
        let end = row.start.checked_add(row.size).ok_or(UNAVAILABLE)?;
        if end > committed || at < row.start || at >= end { return Err(UNAVAILABLE); }
        let bytes = read_file(&directory, &row)?;
        let within = (at - row.start) as usize;
        let take = (len - result.len()).min(bytes.len() - within);
        result.extend_from_slice(&bytes[within..within+take]);
        at += take as u64;
    }
    directory.current().map_err(|_| UNAVAILABLE)?;
    Ok(result)
}

pub(super) fn append(c: &mut Connection, app: &Path, job: &str, instance: &str, device: &str,
    manifest: &Value, start: u64, bytes: &[u8], updated: &str) -> Result<u64> {
    if !owned(c, job, instance, device, manifest)? || manifest["text"].is_string() { return Err(UNAVAILABLE); }
    if bytes.is_empty() || bytes.len() > BLOCK { return Err(OFFSET); }
    let end = start.checked_add(bytes.len() as u64).ok_or(OFFSET)?;
    if end > manifest["sizeBytes"].as_u64().ok_or(UNAVAILABLE)? { return Err(OFFSET); }
    let directory = staging(app)?;
    let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
    let (committed, stage): (u64,String) = transaction.query_row(
      "SELECT committed_bytes,stage FROM companion_service_upload WHERE job_id=?1 AND instance_id=?2 AND device_id=?3",
      params![job,instance,device], |r| Ok((r.get(0)?,r.get(1)?))).map_err(db)?;
    if stage != "staging" { return Err((409, "OP_ID_REUSED")); }
    if start < committed {
        if end > committed || range(&transaction, app, job, committed, start, bytes.len())? != bytes { return Err(OFFSET); }
        transaction.commit().map_err(db)?;
        return Ok(committed);
    }
    if start != committed { return Err(OFFSET); }
    let hash = digest(bytes);
    let name = fresh_name();
    match chunk(&transaction, job, start)? {
        Some(old) => {
            // An intent never authenticates an already-created path. Rotate it
            // and make stale writers fail their exact-name compare-and-swap.
            if old.object.is_some() || !valid_name(&old.name) { return Err(UNAVAILABLE); }
            let attempts: u64 = transaction.query_row("SELECT COUNT(*) FROM companion_macos_service_abandoned WHERE job_id=?1 AND start=?2",
                params![job,start], |r| r.get(0)).map_err(db)?;
            if attempts >= MAX_UNCONFIRMED { return Err(UNAVAILABLE); }
            transaction.execute("INSERT INTO companion_macos_service_abandoned(job_id,start,name) VALUES(?1,?2,?3)",
                params![job,start,old.name]).map_err(db)?;
            let n = transaction.execute("UPDATE companion_macos_service_chunk SET size=?3,hash=?4,name=?5 WHERE job_id=?1 AND start=?2 AND name=?6 AND object IS NULL",
                params![job,start,bytes.len() as u64,hash,name,old.name]).map_err(db)?;
            if n != 1 { return Err(UNAVAILABLE); }
        }
        None => {
            let count: u64 = transaction.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id=?1", [job], |r| r.get(0)).map_err(db)?;
            if count >= MAX_CHUNKS { return Err((429, "RATE_LIMITED")); }
            transaction.execute("INSERT INTO companion_macos_service_chunk(job_id,start,size,hash,name,object) VALUES(?1,?2,?3,?4,?5,NULL)",
                params![job,start,bytes.len() as u64,hash,name]).map_err(db)?;
        }
    }
    transaction.commit().map_err(db)?;
    let file = directory.create(OsStr::new(&name), bytes).map_err(|_| UNAVAILABLE)?;
    let metadata = file.metadata().map_err(|_| UNAVAILABLE)?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o600 || metadata.len() != bytes.len() as u64 { return Err(UNAVAILABLE); }
    let object = format!("{:x}:{:x}", metadata.dev(), metadata.ino());
    let verified = Chunk { start, size: bytes.len() as u64, hash: hash.clone(), name: name.clone(), object: Some(object.clone()) };
    if read_file(&directory, &verified)? != bytes { return Err(UNAVAILABLE); }
    directory.current().map_err(|_| UNAVAILABLE)?;
    let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
    let n = transaction.execute("UPDATE companion_macos_service_chunk SET object=?6 WHERE job_id=?1 AND start=?2 AND size=?3 AND hash=?4 AND name=?5 AND object IS NULL",
        params![job,start,bytes.len() as u64,hash,name,object]).map_err(db)?;
    let advanced = transaction.execute("UPDATE companion_service_upload SET committed_bytes=?1,updated_at=?2
       WHERE job_id=?3 AND instance_id=?4 AND device_id=?5 AND committed_bytes=?6 AND stage='staging'",
       params![end,updated,job,instance,device,committed]).map_err(db)?;
    if n != 1 || advanced != 1 { return Err(UNAVAILABLE); }
    transaction.commit().map_err(db)?;
    Ok(end)
}

pub(super) fn verify(c: &Connection, app: &Path, job: &str, instance: &str, device: &str,
    manifest: &Value, committed: u64) -> Result<()> {
    if !owned(c, job, instance, device, manifest)? { return Err(UNAVAILABLE); }
    let size = manifest["sizeBytes"].as_u64().ok_or(UNAVAILABLE)?;
    if size != committed { return Err((409, "UPLOAD_INCOMPLETE")); }
    let mut hasher = Sha256::new();
    if let Some(text) = manifest["text"].as_str() {
        if text.len() as u64 != size { return Err(UNAVAILABLE); }
        hasher.update(text.as_bytes());
    } else {
        let directory = staging(app)?;
        let mut statement = c.prepare("SELECT start,size,hash,name,object FROM companion_macos_service_chunk WHERE job_id=?1 ORDER BY start").map_err(db)?;
        let mut rows = statement.query([job]).map_err(db)?;
        let mut offset = 0u64;
        let mut count = 0u64;
        while let Some(row) = rows.next().map_err(db)? {
            let row = read_row(row).map_err(db)?;
            if row.start != offset { return Err(UNAVAILABLE); }
            let bytes = read_file(&directory, &row)?;
            offset = offset.checked_add(bytes.len() as u64).ok_or(UNAVAILABLE)?;
            if offset > size { return Err(UNAVAILABLE); }
            hasher.update(bytes); count += 1;
            if count > MAX_CHUNKS { return Err(UNAVAILABLE); }
        }
        if offset != size { return Err(UNAVAILABLE); }
        directory.current().map_err(|_| UNAVAILABLE)?;
    }
    if format!("{:x}", hasher.finalize()) != manifest["sha256"].as_str().unwrap_or("") {
        return Err((409, "UPLOAD_HASH_MISMATCH"));
    }
    Ok(())
}

pub(super) fn terminal(c: &mut Connection, job: &str, instance: &str, device: &str,
    manifest: &Value, state: &str, receipt: Option<&str>, updated: &str) -> Result<()> {
    if !owned(c, job, instance, device, manifest)? { return Err(UNAVAILABLE); }
    let old = match state { "completed" => "committing", "cancelled" => "staging", _ => return Err(UNAVAILABLE) };
    let transaction = c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
    let n = transaction.execute("UPDATE companion_service_upload SET stage=?1,receipt=?2,
       committed_bytes=CASE WHEN ?1='cancelled' THEN 0 ELSE committed_bytes END,updated_at=?3
       WHERE job_id=?4 AND instance_id=?5 AND device_id=?6 AND stage=?7",
       params![state,receipt,updated,job,instance,device,old]).map_err(db)?;
    if n != 1 { return Err(UNAVAILABLE); }
    // Persist success first. Its chunks remain attributable after a crash and
    // are retired only after descriptor-bound reclamation has been synced.
    transaction.commit().map_err(db)?;
    Ok(())
}

pub(super) fn reclaim_upload(c: &mut Connection, app: &Path, job: &str) -> Result<()> {
    setup(c)?;
    let completed: Option<(String,String,String)> = c.query_row(
        "SELECT u.instance_id,u.device_id,u.manifest FROM companion_service_upload u
         JOIN companion_macos_service_session s ON s.job_id=u.job_id AND s.instance_id=u.instance_id AND s.device_id=u.device_id
         WHERE u.job_id=?1 AND u.stage='completed' AND u.receipt IS NOT NULL AND s.clear_uncertain=0",
        [job], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).optional().map_err(db)?;
    let Some((instance,device,encoded))=completed else { return Ok(()); };
    let manifest:Value=serde_json::from_str(&encoded).map_err(|_|UNAVAILABLE)?;
    if !owned(c,job,&instance,&device,&manifest)? { return Err(UNAVAILABLE); }
    let starts={
        let mut statement=c.prepare("SELECT start FROM companion_macos_service_chunk WHERE job_id=?1 ORDER BY start").map_err(db)?;
        let rows=statement.query_map([job],|row|row.get::<_,u64>(0)).map_err(db)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?
    };
    if starts.is_empty() { return Ok(()); }
    let directory=staging(app)?;
    let mut failure=None;
    for start in starts {
        let result=(|| {
            let transaction=c.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
            let recorded=transaction.query_row(
                "SELECT chunk.start,chunk.size,chunk.hash,chunk.name,chunk.object FROM companion_macos_service_chunk chunk
                 JOIN companion_service_upload u ON u.job_id=chunk.job_id
                 JOIN companion_macos_service_session s ON s.job_id=u.job_id AND s.instance_id=u.instance_id AND s.device_id=u.device_id
                 WHERE chunk.job_id=?1 AND chunk.start=?2 AND u.instance_id=?3 AND u.device_id=?4 AND u.manifest=?5
                   AND u.stage='completed' AND u.receipt IS NOT NULL AND s.clear_uncertain=0",
                params![job,start,instance,device,encoded],read_row).optional().map_err(db)?;
            let Some(row)=recorded else { return Ok(()); };
            if !valid_name(&row.name) || row.size==0 || row.size>BLOCK as u64 { return Err(UNAVAILABLE); }
            let object=row.object.as_ref().ok_or(UNAVAILABLE)?;
            let file=directory.open_writable(OsStr::new(&row.name)).map_err(|_|UNAVAILABLE)?;
            let before=file.metadata().map_err(|_|UNAVAILABLE)?;
            if format!("{:x}:{:x}",before.dev(),before.ino())!=*object { return Err(UNAVAILABLE); }
            if before.len()!=0 {
                if before.len()!=row.size { return Err(UNAVAILABLE); }
                let mut bytes=vec![0u8;row.size as usize];
                file.read_exact_at(&mut bytes,0).map_err(|_|UNAVAILABLE)?;
                if digest(&bytes)!=row.hash { return Err(UNAVAILABLE); }
            }
            directory.current().map_err(|_|UNAVAILABLE)?;
            // Zero length plus the original recorded inode is the crash state
            // after data release, before the ownership-row transaction commits.
            reclaim_owned_staging(&file,&before).map_err(|_|UNAVAILABLE)?;
            let removed=transaction.execute("DELETE FROM companion_macos_service_chunk WHERE job_id=?1 AND start=?2 AND name=?3 AND object=?4",
                params![job,start,row.name,object]).map_err(db)?;
            if removed!=1 { return Err(UNAVAILABLE); }
            transaction.commit().map_err(db)
        })();
        if let Err(error)=result { failure.get_or_insert(error); }
    }
    failure.map_or(Ok(()),Err)
}

pub(super) fn reclaim_completed(c: &mut Connection, app: &Path) -> Result<()> {
    setup(c)?;
    let jobs={
        let mut statement=c.prepare("SELECT DISTINCT chunk.job_id FROM companion_macos_service_chunk chunk
            JOIN companion_service_upload u ON u.job_id=chunk.job_id
            JOIN companion_macos_service_session s ON s.job_id=u.job_id AND s.instance_id=u.instance_id AND s.device_id=u.device_id
            WHERE u.stage='completed' AND u.receipt IS NOT NULL AND s.clear_uncertain=0").map_err(db)?;
        let rows=statement.query_map([],|row|row.get::<_,String>(0)).map_err(db)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db)?
    };
    let mut failure=None;
    for job in jobs {
        if let Err(error)=reclaim_upload(c,app,&job) { failure.get_or_insert(error); }
    }
    failure.map_or(Ok(()),Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn fixture() -> (tempfile::TempDir, std::path::PathBuf, Connection, Value) {
        let temp = tempfile::tempdir().unwrap();
        let path = fs::canonicalize(temp.path()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let mut db = Connection::open(path.join("uploads.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE companion_service_upload(job_id TEXT PRIMARY KEY NOT NULL, instance_id TEXT NOT NULL,
          device_id TEXT NOT NULL,op_id TEXT NOT NULL,manifest TEXT NOT NULL,committed_bytes INTEGER NOT NULL,
          stage TEXT NOT NULL,receipt TEXT,updated_at TEXT NOT NULL);").unwrap();
        let manifest = json!({"target":{"domain":"knowledge","vaultId":"v","parentRelativePath":""},
            "sizeBytes":11,"sha256":digest(b"hello world"),"name":"file.bin"});
        begin(&mut db,"job","instance","device","op",&manifest,"now").unwrap();
        (temp,path,db,manifest)
    }
    #[test]
    fn immutable_chunks_replay_across_boundaries_and_reclaim_only_after_success() {
        let (_temp,app,mut db,manifest) = fixture();
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now"),Ok(5));
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,5,b" world","now"),Ok(11));
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,3,b"lo wo","now"),Ok(11));
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,3,b"wrong","now"),Err(OFFSET));
        assert_eq!(range(&db,&app,"job",11,2,8).unwrap(),b"llo worl");
        assert_eq!(verify(&db,&app,"job","instance","device",&manifest,11),Ok(()));
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='job'",[]).unwrap();
        terminal(&mut db,"job","instance","device",&manifest,"completed",Some("{}"),"now").unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk",[],|r|r.get::<_,u64>(0)).unwrap(),2);
        reclaim_upload(&mut db,&app,"job").unwrap();
        assert_eq!(fs::read_dir(app.join("media-transfer-staging/macos-service-knowledge")).unwrap().count(),2);
        for entry in fs::read_dir(app.join("media-transfer-staging/macos-service-knowledge")).unwrap() {
            assert_eq!(entry.unwrap().metadata().unwrap().len(),0);
        }
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk",[],|r|r.get::<_,u64>(0)).unwrap(),0);
        assert!(owned(&db,"job","instance","device",&manifest).unwrap());
    }
    #[test]
    fn abandoned_intent_is_rotated_without_adopting_or_deleting_unknown_file() {
        let (_temp,app,mut db,manifest) = fixture();
        let directory=staging(&app).unwrap(); let name=fresh_name();
        directory.create(OsStr::new(&name),b"unknown").unwrap();
        db.execute("INSERT INTO companion_macos_service_chunk(job_id,start,size,hash,name,object) VALUES('job',0,5,?1,?2,NULL)",params![digest(b"hello"),name]).unwrap();
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now"),Ok(5));
        assert_eq!(directory.read_owned(OsStr::new(&name)).unwrap().unwrap().0,b"unknown");
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_abandoned",[],|r|r.get::<_,u64>(0)).unwrap(),1);
        append(&mut db,&app,"job","instance","device",&manifest,5,b" world","now").unwrap();
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='job'",[]).unwrap();
        terminal(&mut db,"job","instance","device",&manifest,"completed",Some("{}"),"now").unwrap();
        reclaim_completed(&mut db,&app).unwrap();
        assert_eq!(directory.read_owned(OsStr::new(&name)).unwrap().unwrap().0,b"unknown");
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_abandoned",[],|r|r.get::<_,u64>(0)).unwrap(),1);
    }
    #[test]
    fn replaced_chunk_symlink_or_other_object_is_rejected_without_cleanup() {
        let (_temp,app,mut db,manifest) = fixture();
        append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now").unwrap();
        let name=chunk(&db,"job",0).unwrap().unwrap().name;
        let root=app.join("media-transfer-staging/macos-service-knowledge");
        fs::rename(root.join(&name),root.join("saved")).unwrap();
        fs::write(root.join("unrelated"),b"hello").unwrap();
        symlink(root.join("unrelated"),root.join(&name)).unwrap();
        assert_eq!(range(&db,&app,"job",5,0,5),Err(UNAVAILABLE));
        assert_eq!(fs::read(root.join("unrelated")).unwrap(),b"hello");
        assert_eq!(fs::read(root.join("saved")).unwrap(),b"hello");
    }
    #[test]
    fn one_byte_chunks_are_accepted_but_file_count_is_bounded() {
        let (_temp,app,mut db,manifest) = fixture();
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,0,b"h","now"),Ok(1));
        assert_eq!(append(&mut db,&app,"job","instance","device",&manifest,1,b"e","now"),Ok(2));
        let transaction=db.transaction().unwrap();
        for i in 2..MAX_CHUNKS {
            transaction.execute("INSERT INTO companion_macos_service_chunk VALUES('job',?1,1,'hash','name','object')",[i]).unwrap();
        }
        transaction.execute("UPDATE companion_service_upload SET committed_bytes=?1 WHERE job_id='job'",[MAX_CHUNKS]).unwrap();
        transaction.commit().unwrap();
        let bigger=json!({"sizeBytes":MAX_CHUNKS+1,"sha256":digest(b"x")});
        let h=manifest_hash(&bigger).unwrap();
        db.execute("UPDATE companion_macos_service_session SET manifest_hash=?1 WHERE job_id='job'",[h]).unwrap();
        assert_eq!(append(&mut db,&app,"job","instance","device",&bigger,MAX_CHUNKS,b"x","now"),Err((429,"RATE_LIMITED")));
    }
    #[test]
    fn old_jobs_and_invalid_schema_are_not_adopted() {
        let (_temp,_app,db,manifest) = fixture();
        assert!(!owned(&db,"missing","instance","device",&manifest).unwrap());
        assert!(!owned(&db,"job","instance","other",&manifest).unwrap());
        let bad=Connection::open_in_memory().unwrap();
        bad.execute_batch("CREATE TABLE companion_macos_service_session(job_id TEXT);").unwrap();
        assert_eq!(setup(&bad),Err(UNAVAILABLE));
    }

    #[test]
    fn completed_service_chunks_release_64mib_after_receipt_commit() {
        let (_temp,app,mut db,_manifest)=fixture();
        let bytes=vec![0x5a;BLOCK];
        let total=64*1024*1024u64;
        let mut hash=Sha256::new();
        for _ in (0..total).step_by(BLOCK) { hash.update(&bytes); }
        let manifest=json!({"target":{"domain":"knowledge","vaultId":"v","parentRelativePath":""},
            "sizeBytes":total,"sha256":format!("{:x}",hash.finalize()),"name":"maximum.bin"});
        begin(&mut db,"maximum","instance","device","maximum-op",&manifest,"now").unwrap();
        for start in (0..total).step_by(BLOCK) {
            append(&mut db,&app,"maximum","instance","device",&manifest,start,&bytes,"now").unwrap();
        }
        let root=app.join("media-transfer-staging/macos-service-knowledge");
        let before:u64=fs::read_dir(&root).unwrap().map(|entry|entry.unwrap().metadata().unwrap().len()).sum();
        assert_eq!(before,total);
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='maximum'",[]).unwrap();
        terminal(&mut db,"maximum","instance","device",&manifest,"completed",Some("{}"),"now").unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id='maximum'",[],|r|r.get::<_,u64>(0)).unwrap(),256);
        reclaim_completed(&mut db,&app).unwrap();
        for entry in fs::read_dir(&root).unwrap() {
            let metadata=entry.unwrap().metadata().unwrap();
            assert_eq!(metadata.len(),0);
            assert_eq!(metadata.blocks(),0);
        }
        assert_eq!(db.query_row("SELECT COUNT(*) FROM companion_macos_service_chunk WHERE job_id='maximum'",[],|r|r.get::<_,u64>(0)).unwrap(),0);
        let durable:(String,u64,String)=db.query_row("SELECT stage,committed_bytes,receipt FROM companion_service_upload WHERE job_id='maximum'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(durable,("completed".into(),total,"{}".into()));
    }

    #[test]
    fn completed_service_chunks_restart_after_truncate_before_sqlite_retirement() {
        let (_temp,app,mut db,manifest)=fixture();
        append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now").unwrap();
        append(&mut db,&app,"job","instance","device",&manifest,5,b" world","now").unwrap();
        let name=chunk(&db,"job",0).unwrap().unwrap().name;
        let path=app.join("media-transfer-staging/macos-service-knowledge").join(name);
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='job'",[]).unwrap();
        terminal(&mut db,"job","instance","device",&manifest,"completed",Some("{}"),"now").unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE cleanup_hold(job TEXT,start INTEGER,
              FOREIGN KEY(job,start) REFERENCES companion_macos_service_chunk(job_id,start));
            INSERT INTO cleanup_hold VALUES('job',0);").unwrap();
        assert_eq!(reclaim_upload(&mut db,&app,"job"),Err(UNAVAILABLE));
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        assert!(chunk(&db,"job",0).unwrap().is_some(),"failed retirement retains the original ownership");
        assert!(chunk(&db,"job",5).unwrap().is_none(),"other durable releases continue");
        drop(db);
        let mut recovered=Connection::open(app.join("uploads.sqlite")).unwrap();
        recovered.execute_batch("DROP TABLE cleanup_hold").unwrap();
        reclaim_completed(&mut recovered,&app).unwrap();
        assert!(chunk(&recovered,"job",0).unwrap().is_none());
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        reclaim_completed(&mut recovered,&app).unwrap();
    }

    #[test]
    fn completed_service_reclaim_preserves_replacements_and_legacy_unknown_files() {
        let (_temp,app,mut db,manifest)=fixture();
        append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now").unwrap();
        append(&mut db,&app,"job","instance","device",&manifest,5,b" world","now").unwrap();
        let name=chunk(&db,"job",0).unwrap().unwrap().name;
        let root=app.join("media-transfer-staging/macos-service-knowledge");
        let path=root.join(name);
        let retained=app.join("recorded-original");
        fs::rename(&path,&retained).unwrap();
        fs::write(&path,b"hello").unwrap();
        fs::set_permissions(&path,fs::Permissions::from_mode(0o600)).unwrap();
        let legacy=root.join(fresh_name());
        fs::write(&legacy,b"legacy-without-ownership").unwrap();
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='job'",[]).unwrap();
        terminal(&mut db,"job","instance","device",&manifest,"completed",Some("{}"),"now").unwrap();
        assert_eq!(reclaim_completed(&mut db,&app),Err(UNAVAILABLE));
        assert_eq!(fs::read(&path).unwrap(),b"hello");
        assert_eq!(fs::read(&retained).unwrap(),b"hello");
        assert_eq!(fs::read(&legacy).unwrap(),b"legacy-without-ownership");
        assert!(chunk(&db,"job",0).unwrap().is_some());
        assert!(chunk(&db,"job",5).unwrap().is_none());
        fs::remove_file(&path).unwrap();
        fs::rename(&retained,&path).unwrap();
        reclaim_completed(&mut db,&app).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        assert_eq!(fs::read(&legacy).unwrap(),b"legacy-without-ownership");
    }
    #[test]
    fn cancel_preserves_existing_chunk_and_replayable_terminal_marker() {
        let (_temp,app,mut db,manifest) = fixture();
        append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now").unwrap();
        terminal(&mut db,"job","instance","device",&manifest,"cancelled",None,"now").unwrap();
        reclaim_completed(&mut db,&app).unwrap();
        assert_eq!(fs::read_dir(app.join("media-transfer-staging/macos-service-knowledge")).unwrap().count(),1);
        assert_eq!(chunk(&db,"job",0).unwrap().unwrap().object.is_some(),true);
        assert!(owned(&db,"job","instance","device",&manifest).unwrap());
        assert_eq!(db.query_row("SELECT committed_bytes FROM companion_service_upload WHERE job_id='job'",[],|r|r.get::<_,u64>(0)).unwrap(),0);
    }
    #[test]
    fn clear_cancels_staging_but_retains_committing_as_uncertain() {
        let (_temp,app,mut db,manifest) = fixture();
        append(&mut db,&app,"job","instance","device",&manifest,0,b"hello","now").unwrap();
        begin(&mut db,"other","instance","device","other-op",&manifest,"now").unwrap();
        append(&mut db,&app,"other","instance","device",&manifest,0,b"hello","now").unwrap();
        db.execute("UPDATE companion_service_upload SET stage='committing' WHERE job_id='other'",[]).unwrap();
        retire_for_clear(&mut db,"cleared").unwrap();
        reclaim_completed(&mut db,&app).unwrap();
        let staging:(String,u64,String)=db.query_row("SELECT stage,committed_bytes,op_id FROM companion_service_upload WHERE job_id='job'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(staging,("cancelled".into(),0,"op".into()));
        let committing:(String,String)=db.query_row("SELECT stage,op_id FROM companion_service_upload WHERE job_id='other'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(committing,("committing".into(),"other-op".into()));
        assert!(!owned(&db,"other","instance","device",&manifest).unwrap());
        assert!(owned(&db,"job","instance","device",&manifest).unwrap());
        let active:u64=db.query_row("SELECT COUNT(*) FROM companion_service_upload u WHERE u.stage IN ('staging','committing')
            AND NOT EXISTS (SELECT 1 FROM companion_macos_service_session s WHERE s.job_id=u.job_id AND s.clear_uncertain=1)",[],|r|r.get(0)).unwrap();
        assert_eq!(active,0);
        assert_eq!(fs::read_dir(app.join("media-transfer-staging/macos-service-knowledge")).unwrap().count(),2);
        assert!(chunk(&db,"job",0).unwrap().is_some());
        assert!(chunk(&db,"other",0).unwrap().is_some());
    }
}
