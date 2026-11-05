//! macOS attachment upload: append only to process-owned segment descriptors.
//! SQLite holds metadata only. A restart creates a fresh segment for writes.
//! Completed, still-owned segments are reclaimed through verified descriptors;
//! uncertain objects and zero-byte directory entries are never unlinked.
use crate::macos_fs::{reclaim_owned_staging, require_empty_acl, Directory};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::File;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::Path;

type Result<T> = std::result::Result<T, (u16, &'static str)>;
const STORE: (u16, &str) = (503, "CONTENT_STORE_UNAVAILABLE");
const STORAGE: (u16, &str) = (503, "UPLOAD_STORAGE_UNAVAILABLE");
const LOST: (u16, &str) = (409, "UPLOAD_STAGING_LOST");
const BLOCK: usize = 256 * 1024;

const SESSION: &str = "CREATE TABLE IF NOT EXISTS macos_companion_upload_session(device_id TEXT NOT NULL,op_id TEXT NOT NULL,total INTEGER NOT NULL,plan TEXT,cancelled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,op_id))";
const SEGMENT: &str = "CREATE TABLE IF NOT EXISTS macos_companion_upload_segment(device_id TEXT NOT NULL,op_id TEXT NOT NULL,name TEXT NOT NULL,object TEXT,committed_len INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device_id,op_id,name))";
const CHUNK: &str = "CREATE TABLE IF NOT EXISTS macos_companion_upload_block(device_id TEXT NOT NULL,op_id TEXT NOT NULL,start INTEGER NOT NULL,len INTEGER NOT NULL,digest TEXT NOT NULL,segment TEXT NOT NULL,segment_offset INTEGER NOT NULL,PRIMARY KEY(device_id,op_id,start))";
const RETIRED: &str = "CREATE TABLE IF NOT EXISTS macos_companion_upload_retired(device_id TEXT NOT NULL,op_id TEXT NOT NULL,PRIMARY KEY(device_id,op_id))";
const GUARDED: &str = "CREATE TABLE IF NOT EXISTS macos_companion_upload_journaled(device_id TEXT NOT NULL,op_id TEXT NOT NULL,PRIMARY KEY(device_id,op_id))";
fn compact(s:&str)->String { s.chars().filter(|c| !c.is_ascii_whitespace()).flat_map(char::to_lowercase).collect() }
pub(super) fn schema(db:&Connection)->Result<()> {
    db.pragma_update(None,"synchronous","FULL").map_err(|_|STORE)?;
    for (name,ddl) in [("macos_companion_upload_session",SESSION),("macos_companion_upload_segment",SEGMENT),("macos_companion_upload_block",CHUNK),("macos_companion_upload_retired",RETIRED),("macos_companion_upload_journaled",GUARDED)] {
        db.execute_batch(ddl).map_err(|_|STORE)?;
        let stored:String=db.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name=?1",[name],|r|r.get(0)).map_err(|_|STORE)?;
        if compact(&stored)!=compact(&ddl.replace("IF NOT EXISTS ","")) {return Err(STORE);}
        let triggers:u64=db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?1",[name],|r|r.get(0)).map_err(|_|STORE)?;
        if triggers!=0 {return Err(STORE);}
    }
    Ok(())
}
pub(super) fn begin(db:&mut Connection, device:&str, op:&str, vault:&str, note:&str, manifest:&str,total:u64)->Result<()> {
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|STORE)?;
    if retired(&tx,device,op)? {return Err((409,"UPLOAD_CANCELLED"));}
    let count:u64=tx.query_row("SELECT COUNT(*) FROM companion_content_upload u LEFT JOIN macos_companion_upload_session s ON s.device_id=u.device_id AND s.op_id=u.op_id LEFT JOIN macos_companion_upload_retired r ON r.device_id=u.device_id AND r.op_id=u.op_id WHERE u.device_id=?1 AND u.receipt IS NULL AND COALESCE(s.cancelled,0)=0 AND r.device_id IS NULL",[device],|r|r.get(0)).map_err(|_|STORE)?;
    if count>=16 {return Err((429,"UPLOAD_LIMIT"));}
    tx.execute("INSERT INTO companion_content_upload(device_id,op_id,vault_key,note_id,manifest) VALUES(?1,?2,?3,?4,?5)",params![device,op,vault,note,manifest]).map_err(|_|STORE)?;
    tx.execute("INSERT INTO macos_companion_upload_session(device_id,op_id,total) VALUES(?1,?2,?3)",params![device,op,total]).map_err(|_|STORE)?;
    tx.execute("INSERT INTO macos_companion_upload_journaled(device_id,op_id) VALUES(?1,?2)",params![device,op]).map_err(|_|STORE)?;
    tx.commit().map_err(|_|STORE)
}
pub(super) fn retired(db:&Connection,device:&str,op:&str)->Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM macos_companion_upload_retired WHERE device_id=?1 AND op_id=?2)",params![device,op],|r|r.get(0)).map_err(|_|STORE)
}
pub(super) fn session(db:&Connection,device:&str,op:&str)->Result<Option<(u64,Option<String>,bool)>> {
    db.query_row("SELECT total,plan,cancelled FROM macos_companion_upload_session WHERE device_id=?1 AND op_id=?2",params![device,op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|STORE)
}
// A legacy partial direct Content upload cannot have published yet. Services
// bypasses Content staging, so even offset zero can follow a lost publication
// receipt. An unjournaled service-linked upload remains uncertain at any offset.
// Full legacy direct uploads are also intentionally left unmarked.
pub(super) fn mark_incomplete(db:&Connection,device:&str,op:&str,offset:u64)->Result<()> {
    db.execute("INSERT OR IGNORE INTO macos_companion_upload_journaled(device_id,op_id) SELECT u.device_id,u.op_id FROM companion_content_upload u JOIN macos_companion_upload_session s ON s.device_id=u.device_id AND s.op_id=u.op_id WHERE u.device_id=?1 AND u.op_id=?2 AND u.receipt IS NULL AND u.committed_bytes=?3 AND u.committed_bytes<s.total AND s.cancelled=0 AND s.plan IS NULL AND NOT EXISTS (SELECT 1 FROM companion_service_upload service WHERE service.device_id=u.device_id AND u.op_id='sv-'||service.job_id||'-file')",params![device,op,offset]).map_err(|_|STORE)?;
    Ok(())
}
pub(super) fn journaled(db:&Connection,device:&str,op:&str)->Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM macos_companion_upload_journaled WHERE device_id=?1 AND op_id=?2)",params![device,op],|r|r.get(0)).map_err(|_|STORE)
}
pub(super) fn cancel_all(db:&mut Connection,state:&mut UploadState)->Result<()> {
    schema(db)?;
    let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|STORE)?;
    // A tombstone also preserves any publication plan; a cancelled opId can
    // never be rebound to a new upload after its staging directory is cleared.
    tx.execute("UPDATE macos_companion_upload_session SET cancelled=1 WHERE EXISTS(SELECT 1 FROM companion_content_upload u WHERE u.device_id=macos_companion_upload_session.device_id AND u.op_id=macos_companion_upload_session.op_id AND u.receipt IS NULL)",[]).map_err(|_|STORE)?;
    // Old pending requests have no Mac session and must never be inferred to
    // own their .part file. Retire only their IDs; do not open or touch files.
    tx.execute("INSERT OR IGNORE INTO macos_companion_upload_retired(device_id,op_id) SELECT u.device_id,u.op_id FROM companion_content_upload u LEFT JOIN macos_companion_upload_session s ON s.device_id=u.device_id AND s.op_id=u.op_id WHERE u.receipt IS NULL AND s.device_id IS NULL",[]).map_err(|_|STORE)?;
    tx.commit().map_err(|_|STORE)?;
    state.live.clear();
    Ok(())
}
pub(super) fn plan(db:&Connection,device:&str,op:&str,old:Option<&str>,new:&str)->Result<()> {
    if db.execute("UPDATE macos_companion_upload_session SET plan=?4 WHERE device_id=?1 AND op_id=?2 AND plan IS ?3",params![device,op,old,new]).map_err(|_|STORE)?!=1 {return Err(STORE)} Ok(())
}
pub(super) fn finish(db:&Connection,device:&str,op:&str,expected_plan:Option<&str>,old_offset:u64,total:u64,receipt:&str)->Result<()> {
    if db.execute("UPDATE companion_content_upload SET receipt=?3,committed_bytes=?5 WHERE device_id=?1 AND op_id=?2 AND receipt IS NULL AND committed_bytes=?6 AND EXISTS(SELECT 1 FROM macos_companion_upload_session s WHERE s.device_id=?1 AND s.op_id=?2 AND s.plan IS ?4 AND s.total=?5 AND s.cancelled=0)",params![device,op,receipt,expected_plan,total,old_offset]).map_err(|_|STORE)?!=1 {return Err(STORE)} Ok(())
}
fn object(m:&std::fs::Metadata)->String {format!("{:x}:{:x}",m.dev(),m.ino())}
fn stamp(m:&std::fs::Metadata)->(u64,u64,u64,u64,u32,u32,i64,i64,i64,i64) {(m.dev(),m.ino(),m.len(),m.nlink(),m.uid(),m.mode(),m.mtime(),m.mtime_nsec(),m.ctime(),m.ctime_nsec())}
fn valid_file(file:&File)->Result<std::fs::Metadata> {
    let m=file.metadata().map_err(|_|STORAGE)?;
    if !m.is_file() || m.nlink()!=1 || m.uid()!=unsafe{libc::geteuid()} || m.mode()&0o7777!=0o600 {return Err(STORAGE)}
    require_empty_acl(file).map_err(|_|STORAGE)?; Ok(m)
}
fn name_ok(name:&str)->bool { name.strip_prefix(".lrsegment-").and_then(|s|s.strip_suffix(".bin")).is_some_and(|s|s.len()==32 && s.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())) }
fn dir(app:&Path)->Result<Directory> {
    let root=Directory::open_owned(app,false).map_err(|_|STORAGE)?;
    let transfer=root.child(OsStr::new("media-transfer-staging"),true).map_err(|_|STORAGE)?;
    let held=transfer.child(OsStr::new("macos-companion-content-v1"),true).map_err(|_|STORAGE)?;
    let private=Directory::open(&app.join("media-transfer-staging/macos-companion-content-v1"),false,true).map_err(|_|STORAGE)?;
    let a=held.identity_file().and_then(|f|f.metadata()).map_err(|_|STORAGE)?;
    let b=private.identity_file().and_then(|f|f.metadata()).map_err(|_|STORAGE)?;
    if (a.dev(),a.ino())!=(b.dev(),b.ino()) {return Err(STORAGE)}
    transfer.current().map_err(|_|STORAGE)?; private.current().map_err(|_|STORAGE)?; Ok(private)
}
fn marker(device:&str,op:&str)->String {
    let mut h=Sha256::new();h.update(b"luckyray-macos-publish-marker-v1\0");
    for v in [device,op] {h.update((v.len() as u64).to_be_bytes());h.update(v.as_bytes());}
    format!(".lrpublication-{:x}.pending",h.finalize())
}
pub(super) fn create_marker(app:&Path,device:&str,op:&str)->Result<()> {
    let d=dir(app)?;d.create(OsStr::new(&marker(device,op)),b"luckyray-publication-intent-v1\n").map_err(|_|(409,"UPLOAD_PUBLICATION_UNCERTAIN"))?;Ok(())
}
pub(super) fn check_marker(app:&Path,device:&str,op:&str)->Result<()> {
    let d=dir(app)?;let (bytes,_)=d.read_owned(OsStr::new(&marker(device,op))).map_err(|_|STORAGE)?.ok_or((409,"UPLOAD_PUBLICATION_UNCERTAIN"))?;
    if bytes!=b"luckyray-publication-intent-v1\n" {return Err((409,"UPLOAD_PUBLICATION_UNCERTAIN"))} Ok(())
}

struct Segment { dir:Directory, file:File, name:String, identity:String, first_start:u64, len:u64, block_start:u64, block_len:usize, block_hash:Sha256 }
#[derive(Default)]
pub(crate) struct UploadState { live:HashMap<(String,String),Segment> }
fn verify_segment(s:&Segment)->Result<()> {
    s.dir.current().map_err(|_|STORAGE)?;
    let held=valid_file(&s.file)?;
    let named=s.dir.open_regular(OsStr::new(&s.name)).and_then(|f|f.metadata()).map_err(|_|STORAGE)?;
    if object(&held)!=s.identity || object(&named)!=s.identity || held.len()!=s.len || stamp(&named)!=stamp(&held) {return Err(STORAGE)} Ok(())
}
fn new_segment(db:&Connection,app:&Path,device:&str,op:&str,start:u64)->Result<Segment> {
    let d=dir(app)?;let name=format!(".lrsegment-{:032x}.bin",rand::random::<u128>());
    db.execute("INSERT INTO macos_companion_upload_segment(device_id,op_id,name) VALUES(?1,?2,?3)",params![device,op,name]).map_err(|_|STORE)?;
    let file=d.create(OsStr::new(&name),&[]).map_err(|_|STORAGE)?;
    let m=valid_file(&file)?;let identity=object(&m);
    let named=d.open_regular(OsStr::new(&name)).and_then(|f|f.metadata()).map_err(|_|STORAGE)?;
    if object(&named)!=identity || stamp(&named)!=stamp(&m) {return Err(STORAGE)}
    if db.execute("UPDATE macos_companion_upload_segment SET object=?4 WHERE device_id=?1 AND op_id=?2 AND name=?3 AND object IS NULL",params![device,op,name,identity]).map_err(|_|STORE)?!=1 {return Err(STORE)}
    Ok(Segment{dir:d,file,name,identity,first_start:start,len:0,block_start:start,block_len:0,block_hash:Sha256::new()})
}
struct Block {start:u64,len:u64,digest:String,name:String,offset:u64,identity:String,segment_len:u64}
fn block(row:&rusqlite::Row<'_>)->rusqlite::Result<Block> {Ok(Block{start:row.get(0)?,len:row.get(1)?,digest:row.get(2)?,name:row.get(3)?,offset:row.get(4)?,identity:row.get(5)?,segment_len:row.get(6)?})}
fn read_block(d:&Directory,b:&Block)->Result<Vec<u8>> {
    if !name_ok(&b.name)||b.len==0||b.len>BLOCK as u64||b.offset.checked_add(b.len).is_none_or(|v|v>b.segment_len) {return Err(LOST)}
    d.current().map_err(|_|LOST)?;let f=d.open_regular(OsStr::new(&b.name)).map_err(|_|LOST)?;let before=valid_file(&f).map_err(|_|LOST)?;
    if object(&before)!=b.identity||before.len()<b.segment_len {return Err(LOST)}
    let mut data=vec![0;b.len as usize];f.read_exact_at(&mut data,b.offset).map_err(|_|LOST)?;
    let after=valid_file(&f).map_err(|_|LOST)?;
    let named=d.open_regular(OsStr::new(&b.name)).and_then(|f|f.metadata()).map_err(|_|LOST)?;
    if stamp(&before)!=stamp(&after)||stamp(&after)!=stamp(&named)||format!("{:x}",Sha256::digest(&data))!=b.digest {return Err(LOST)}
    d.current().map_err(|_|LOST)?;Ok(data)
}
const ROWS:&str="SELECT b.start,b.len,b.digest,b.segment,b.segment_offset,s.object,s.committed_len FROM macos_companion_upload_block b JOIN macos_companion_upload_segment s ON s.device_id=b.device_id AND s.op_id=b.op_id AND s.name=b.segment WHERE b.device_id=?1 AND b.op_id=?2 ORDER BY b.start";
fn visit(db:&Connection,device:&str,op:&str,mut f:impl FnMut(Block)->Result<bool>)->Result<()> {
    let mut s=db.prepare(ROWS).map_err(|_|STORE)?;let mut rows=s.query(params![device,op]).map_err(|_|STORE)?;
    while let Some(row)=rows.next().map_err(|_|STORE)? {if !f(block(row).map_err(|_|STORE)?)? {break}} Ok(())
}
pub(super) fn compare(db:&Connection,app:&Path,device:&str,op:&str,start:u64,data:&[u8],committed:u64)->Result<()> {
    if start.checked_add(data.len() as u64).is_none_or(|v|v>committed) {return Err((409,"UPLOAD_OFFSET_MISMATCH"))}
    let d=dir(app)?;let mut cursor=start;let mut compared=0usize;
    visit(db,device,op,|b|{let end=b.start.checked_add(b.len).ok_or(LOST)?;if end<=cursor{return Ok(true)} if b.start>cursor||end>committed{return Err(LOST)}
        let bytes=read_block(&d,&b)?;let from=(cursor-b.start) as usize;let n=(bytes.len()-from).min(data.len()-compared);
        if bytes[from..from+n]!=data[compared..compared+n] {return Err((409,"OP_ID_REUSED"))}cursor+=n as u64;compared+=n;Ok(compared<data.len())})?;
    if compared!=data.len(){return Err(LOST)}Ok(())
}
pub(super) fn append(db:&mut Connection,state:&mut UploadState,app:&Path,device:&str,op:&str,start:u64,bytes:&[u8])->Result<u64> {
    let key=(device.to_owned(),op.to_owned());
    // A database restore can move the durable offset backwards while this
    // process still has a descriptor. Never append using that stale segment.
    if state.live.get(&key).is_some_and(|s|s.first_start.checked_add(s.len)!=Some(start)) {state.live.remove(&key);}
    if !state.live.contains_key(&key) {state.live.insert(key.clone(),new_segment(db,app,device,op,start)?);}
    let result=(||{
        let s=state.live.get_mut(&key).ok_or(STORAGE)?;verify_segment(s)?;
        s.file.write_all_at(bytes,s.len).and_then(|_|s.file.sync_all()).map_err(|_|STORAGE)?;
        // Retain the descriptor; name substitution cannot redirect this write.
        let after=valid_file(&s.file)?;let named=s.dir.open_regular(OsStr::new(&s.name)).and_then(|f|f.metadata()).map_err(|_|STORAGE)?;
        if object(&after)!=s.identity || stamp(&after)!=stamp(&named)||after.len()!=s.len+bytes.len() as u64{return Err(STORAGE)}
        s.dir.current().map_err(|_|STORAGE)?;
        let mut block_start=s.block_start;let mut block_len=s.block_len;let mut hasher=s.block_hash.clone();
        let mut pos=0usize;let mut updates=Vec::new();
        while pos<bytes.len() {let n=(BLOCK-block_len).min(bytes.len()-pos);hasher.update(&bytes[pos..pos+n]);block_len+=n;
            let segment_offset=(s.len+pos as u64+n as u64)-block_len as u64;
            updates.push((block_start,block_len as u64,format!("{:x}",hasher.clone().finalize()),segment_offset));
            // Verify the actual just-written block, not only the input hash.
            let mut observed=vec![0u8;block_len];s.file.read_exact_at(&mut observed,segment_offset).map_err(|_|STORAGE)?;
            if format!("{:x}",Sha256::digest(&observed))!=updates.last().unwrap().2 {return Err(STORAGE)}
            pos+=n;if block_len==BLOCK {block_start=start+pos as u64;block_len=0;hasher=Sha256::new();}
        }
        let final_meta=valid_file(&s.file)?;if stamp(&after)!=stamp(&final_meta){return Err(STORAGE)}
        let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|STORE)?;
        for (at,len,digest,segment_offset) in updates {
            let existing:Option<(String,u64,u64)>=tx.query_row("SELECT segment,segment_offset,len FROM macos_companion_upload_block WHERE device_id=?1 AND op_id=?2 AND start=?3",params![device,op,at],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|STORE)?;
            match existing {
                Some((name,offset,old_len)) if name==s.name && offset==segment_offset && old_len<len=>{
                    if tx.execute("UPDATE macos_companion_upload_block SET len=?4,digest=?5 WHERE device_id=?1 AND op_id=?2 AND start=?3 AND len=?6",params![device,op,at,len,digest,old_len]).map_err(|_|STORE)?!=1{return Err(STORE)}
                },
                None=>{tx.execute("INSERT INTO macos_companion_upload_block(device_id,op_id,start,len,digest,segment,segment_offset) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![device,op,at,len,digest,s.name,segment_offset]).map_err(|_|STORE)?;},
                _=>return Err(STORE),
            }
        }
        if tx.execute("UPDATE macos_companion_upload_segment SET committed_len=?4 WHERE device_id=?1 AND op_id=?2 AND name=?3 AND object=?5 AND committed_len=?6",params![device,op,s.name,s.len+bytes.len() as u64,s.identity,s.len]).map_err(|_|STORE)?!=1{return Err(STORE)}
        if tx.execute("UPDATE companion_content_upload SET committed_bytes=?3 WHERE device_id=?1 AND op_id=?2 AND committed_bytes=?4 AND receipt IS NULL",params![device,op,start+bytes.len() as u64,start]).map_err(|_|STORE)?!=1{return Err(STORE)}
        tx.commit().map_err(|_|STORE)?;
        s.len+=bytes.len() as u64;s.block_start=block_start;s.block_len=block_len;s.block_hash=hasher;Ok(start+bytes.len() as u64)
    })();
    // An uncommitted tail is never truncated or reused; the next request makes a fresh segment.
    if result.is_err(){state.live.remove(&key);} result
}
pub(super) fn collect(db:&Connection,app:&Path,device:&str,op:&str,total:u64,digest:&str)->Result<Vec<u8>> {
    if total==0||total>64*1024*1024 {return Err(LOST)}let d=dir(app)?;let mut out=Vec::new();out.try_reserve_exact(total as usize).map_err(|_|STORE)?;
    visit(db,device,op,|b|{if b.start!=out.len() as u64||b.start.checked_add(b.len).is_none_or(|v|v>total){return Err(LOST)}out.extend_from_slice(&read_block(&d,&b)?);Ok(true)})?;
    if out.len() as u64!=total||format!("{:x}",Sha256::digest(&out))!=digest{return Err(LOST)}Ok(out)
}
pub(super) fn release(state:&mut UploadState,device:&str,op:&str){state.live.remove(&(device.to_owned(),op.to_owned()));}

/// A durable receipt authorizes releasing only that upload's recorded staging
/// objects. Keep their ownership rows until the descriptor is durably empty.
/// In particular, a same-name replacement never grants cleanup authority.
pub(super) fn reclaim_upload(db:&mut Connection,app:&Path,device:&str,op:&str)->Result<()> {
    schema(db)?;
    let names = {
        let mut statement=db.prepare("SELECT s.name FROM macos_companion_upload_segment s JOIN companion_content_upload u ON u.device_id=s.device_id AND u.op_id=s.op_id JOIN macos_companion_upload_session owned ON owned.device_id=s.device_id AND owned.op_id=s.op_id WHERE s.device_id=?1 AND s.op_id=?2 AND u.receipt IS NOT NULL AND owned.cancelled=0 ORDER BY s.name").map_err(|_|STORE)?;
        let rows=statement.query_map(params![device,op],|row|row.get::<_,String>(0)).map_err(|_|STORE)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|STORE)?
    };
    if names.is_empty() {return Ok(())}
    let directory=dir(app)?;
    let mut failure=None;
    for name in names {
        let result=(|| {
            if !name_ok(&name) {return Err(LOST)}
            let tx=db.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|_|STORE)?;
            let recorded:Option<(Option<String>,u64)>=tx.query_row("SELECT s.object,s.committed_len FROM macos_companion_upload_segment s JOIN companion_content_upload u ON u.device_id=s.device_id AND u.op_id=s.op_id JOIN macos_companion_upload_session owned ON owned.device_id=s.device_id AND owned.op_id=s.op_id WHERE s.device_id=?1 AND s.op_id=?2 AND s.name=?3 AND u.receipt IS NOT NULL AND owned.cancelled=0",params![device,op,name],|row|Ok((row.get(0)?,row.get(1)?))).optional().map_err(|_|STORE)?;
            let Some((identity,len))=recorded else {return Ok(())};
            let identity=identity.ok_or(LOST)?;
            let file=directory.open_writable(OsStr::new(&name)).map_err(|_|LOST)?;
            let before=valid_file(&file).map_err(|_|LOST)?;
            if object(&before)!=identity {return Err(LOST)}
            if before.len()!=0 {
                // An uncommitted tail has no persisted digest. Do not guess
                // whether it belongs to a failed writer or a replacement.
                if before.len()!=len {return Err(LOST)}
                let mut statement=tx.prepare("SELECT len,digest,segment_offset FROM macos_companion_upload_block WHERE device_id=?1 AND op_id=?2 AND segment=?3 ORDER BY segment_offset").map_err(|_|STORE)?;
                let mut rows=statement.query(params![device,op,name]).map_err(|_|STORE)?;
                let mut offset=0u64;
                while let Some(row)=rows.next().map_err(|_|STORE)? {
                    let size:u64=row.get(0).map_err(|_|STORE)?;
                    let hash:String=row.get(1).map_err(|_|STORE)?;
                    let at:u64=row.get(2).map_err(|_|STORE)?;
                    if at!=offset || size==0 || size>BLOCK as u64 || at.checked_add(size).is_none_or(|end|end>len) {return Err(LOST)}
                    let mut bytes=vec![0u8;size as usize];
                    file.read_exact_at(&mut bytes,at).map_err(|_|LOST)?;
                    if format!("{:x}",Sha256::digest(&bytes))!=hash {return Err(LOST)}
                    offset+=size;
                }
                if offset!=len {return Err(LOST)}
            }
            directory.current().map_err(|_|LOST)?;
            // A zero-length recorded inode is the recoverable state after a
            // previous truncate+sync whose SQLite retirement did not commit.
            // The primitive only validates and syncs in that case.
            reclaim_owned_staging(&file,&before).map_err(|_|STORAGE)?;
            tx.execute("DELETE FROM macos_companion_upload_block WHERE device_id=?1 AND op_id=?2 AND segment=?3",params![device,op,name]).map_err(|_|STORE)?;
            if tx.execute("DELETE FROM macos_companion_upload_segment WHERE device_id=?1 AND op_id=?2 AND name=?3 AND object=?4 AND committed_len=?5",params![device,op,name,identity,len]).map_err(|_|STORE)?!=1 {return Err(STORE)}
            tx.commit().map_err(|_|STORE)
        })();
        if let Err(error)=result {failure.get_or_insert(error);}
    }
    failure.map_or(Ok(()),Err)
}

/// Startup recovery visits the durable completed set, never a directory scan
/// or unfinished/cancelled uploads. A blocked object does not stop other jobs.
pub(super) fn reclaim_completed(db:&mut Connection,app:&Path)->Result<()> {
    schema(db)?;
    let jobs={
        let mut statement=db.prepare("SELECT DISTINCT s.device_id,s.op_id FROM macos_companion_upload_segment s JOIN companion_content_upload u ON u.device_id=s.device_id AND u.op_id=s.op_id JOIN macos_companion_upload_session owned ON owned.device_id=s.device_id AND owned.op_id=s.op_id WHERE u.receipt IS NOT NULL AND owned.cancelled=0").map_err(|_|STORE)?;
        let rows=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?))).map_err(|_|STORE)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|_|STORE)?
    };
    let mut failure=None;
    for (device,op) in jobs {
        if let Err(error)=reclaim_upload(db,app,&device,&op) {failure.get_or_insert(error);}
    }
    failure.map_or(Ok(()),Err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn fixture(total:u64)->(tempfile::TempDir,PathBuf,Connection,UploadState) {
        let temp=tempfile::tempdir().unwrap();
        let app=fs::canonicalize(temp.path()).unwrap();
        fs::set_permissions(&app,fs::Permissions::from_mode(0o700)).unwrap();
        let mut db=Connection::open(app.join("uploads.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE companion_content_upload(device_id TEXT NOT NULL,op_id TEXT NOT NULL,
            vault_key TEXT NOT NULL,note_id TEXT NOT NULL,manifest TEXT NOT NULL,
            committed_bytes INTEGER NOT NULL DEFAULT 0,receipt TEXT,PRIMARY KEY(device_id,op_id));").unwrap();
        schema(&db).unwrap();
        begin(&mut db,"device","op","vault","note","{}",total).unwrap();
        (temp,app,db,UploadState::default())
    }
    fn segment_path(db:&Connection,app:&Path)->PathBuf {
        let name:String=db.query_row("SELECT name FROM macos_companion_upload_segment WHERE device_id='device' AND op_id='op'",[],|r|r.get(0)).unwrap();
        app.join("media-transfer-staging/macos-companion-content-v1").join(name)
    }
    fn finish_fixture(db:&Connection,total:u64) {
        finish(db,"device","op",None,total,total,"{\"complete\":true}").unwrap();
    }
    fn segment_count(db:&Connection)->u64 {
        db.query_row("SELECT COUNT(*) FROM macos_companion_upload_segment",[],|r|r.get(0)).unwrap()
    }

    #[test]
    fn completed_content_reclaims_64mib_without_unlinking_names_or_receipts() {
        let total=64*1024*1024;
        let (_temp,app,mut db,mut state)=fixture(total);
        let bytes=vec![0x5a;BLOCK];
        for start in (0..total).step_by(BLOCK) {
            append(&mut db,&mut state,&app,"device","op",start,&bytes).unwrap();
        }
        let path=segment_path(&db,&app);
        assert_eq!(fs::metadata(&path).unwrap().len(),total);
        finish_fixture(&db,total);
        assert_eq!(segment_count(&db),1,"receipt commit must retain cleanup authority");
        release(&mut state,"device","op");
        reclaim_upload(&mut db,&app,"device","op").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        assert_eq!(fs::metadata(&path).unwrap().blocks(),0);
        assert_eq!(segment_count(&db),0);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM macos_companion_upload_block",[],|r|r.get::<_,u64>(0)).unwrap(),0);
        let durable:(u64,String)=db.query_row("SELECT committed_bytes,receipt FROM companion_content_upload",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(durable,(total,"{\"complete\":true}".into()));
        reclaim_completed(&mut db,&app).unwrap();
    }

    #[test]
    fn completed_content_restarts_after_durable_truncate_before_sqlite_retirement() {
        let (_temp,app,mut db,mut state)=fixture(5);
        append(&mut db,&mut state,&app,"device","op",0,b"hello").unwrap();
        let path=segment_path(&db,&app);
        finish_fixture(&db,5);
        // A real SQLite delete failure after file sync rolls back both ownership
        // tables. Reopening the DB exercises the zero-length recovery state.
        db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE cleanup_hold(device TEXT,op TEXT,name TEXT,
              FOREIGN KEY(device,op,name) REFERENCES macos_companion_upload_segment(device_id,op_id,name));
            INSERT INTO cleanup_hold SELECT device_id,op_id,name FROM macos_companion_upload_segment;").unwrap();
        assert_eq!(reclaim_upload(&mut db,&app,"device","op"),Err(STORE));
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        assert_eq!(segment_count(&db),1);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM macos_companion_upload_block",[],|r|r.get::<_,u64>(0)).unwrap(),1);
        drop(state);
        drop(db);
        let mut recovered=Connection::open(app.join("uploads.sqlite")).unwrap();
        recovered.execute_batch("DROP TABLE cleanup_hold").unwrap();
        reclaim_completed(&mut recovered,&app).unwrap();
        assert_eq!(segment_count(&recovered),0);
        assert_eq!(fs::metadata(&path).unwrap().len(),0);
        reclaim_completed(&mut recovered,&app).unwrap();
    }

    #[test]
    fn completed_content_reclaim_preserves_replacements_and_unconfirmed_tails() {
        let (_temp,app,mut db,mut state)=fixture(10);
        append(&mut db,&mut state,&app,"device","op",0,b"hello").unwrap();
        let first=segment_path(&db,&app);
        state=UploadState::default();
        append(&mut db,&mut state,&app,"device","op",5,b"world").unwrap();
        let second_name:String=db.query_row("SELECT name FROM macos_companion_upload_segment WHERE name<>?1",[first.file_name().unwrap().to_str().unwrap()],|r|r.get(0)).unwrap();
        let second=first.parent().unwrap().join(second_name);
        fs::OpenOptions::new().write(true).open(&first).unwrap().write_all_at(b"!",5).unwrap();
        finish_fixture(&db,10);
        release(&mut state,"device","op");
        assert_eq!(reclaim_upload(&mut db,&app,"device","op"),Err(LOST));
        assert_eq!(fs::read(&first).unwrap(),b"hello!");
        assert_eq!(fs::metadata(&second).unwrap().len(),0,"one uncertain segment must not block another owned segment");
        assert_eq!(segment_count(&db),1);
        let retained=app.join("retained-original");
        fs::rename(&first,&retained).unwrap();
        fs::write(&first,b"hello").unwrap();
        fs::set_permissions(&first,fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(reclaim_completed(&mut db,&app),Err(LOST));
        assert_eq!(fs::read(&first).unwrap(),b"hello");
        assert_eq!(fs::read(&retained).unwrap(),b"hello!");
        assert_eq!(segment_count(&db),1);
    }

    #[test]
    fn completed_content_reclaim_uses_the_verified_descriptor_across_name_swap() {
        let (_temp,app,mut db,mut state)=fixture(5);
        append(&mut db,&mut state,&app,"device","op",0,b"hello").unwrap();
        let path=segment_path(&db,&app);
        let retained=app.join("verified-original");
        finish_fixture(&db,5);
        release(&mut state,"device","op");
        let hook_path=path.clone();let hook_retained=retained.clone();
        crate::macos_fs::set_before_staging_reclaim_hook(Some(Box::new(move || {
            fs::rename(&hook_path,&hook_retained).unwrap();
            fs::write(&hook_path,b"replacement").unwrap();
        })));
        reclaim_upload(&mut db,&app,"device","op").unwrap();
        assert_eq!(fs::read(&path).unwrap(),b"replacement");
        assert_eq!(fs::metadata(&retained).unwrap().len(),0);
        assert_eq!(segment_count(&db),0);
    }
}
