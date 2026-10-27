//! Additive read-only replica projection; legacy Content IDs and routes are unchanged.
//! A resource ID is a persistent scoped target alias, NOT an inferred filesystem UUID.
use super::*;
use std::io::{Read, Seek, SeekFrom};

const MAX_RESOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 128 * 1024 * 1024;

/// Hash only an already-authorized open handle. Recheck authority between bounded reads.
fn hash_handle(file: &mut fs::File, expected: u64, mut check: impl FnMut() -> ContentResult<()>) -> ContentResult<String> {
    if expected > MAX_RESOURCE_BYTES { return Err((413, "REPLICA_RESOURCE_TOO_LARGE")); }
    file.seek(SeekFrom::Start(0)).map_err(|_| (409, "RESOURCE_CHANGED"))?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        check()?;
        let n = file.read(&mut buffer).map_err(|_| (409, "RESOURCE_CHANGED"))?;
        if n == 0 { break; }
        count = count.checked_add(n as u64).ok_or((409, "RESOURCE_CHANGED"))?;
        if count > expected { return Err((409, "RESOURCE_CHANGED")); }
        digest.update(&buffer[..n]);
    }
    check()?;
    if count != expected { return Err((409, "RESOURCE_CHANGED")); }
    Ok(format!("{:x}", digest.finalize()))
}

/// Alias scoped by note and textual target. Content hashes never determine identity.
/// Unknown external moves create new aliases; old aliases are retained, never rebound.
fn resource_alias(db: &Connection, vault: &str, note: &str, target: &str) -> ContentResult<String> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS companion_replica_resource_alias (
        vault_key TEXT NOT NULL, note_id TEXT NOT NULL, target TEXT NOT NULL,
        resource_id TEXT NOT NULL UNIQUE, PRIMARY KEY(vault_key,note_id,target));").map_err(db_error)?;
    let proposed = format!("rr-{}", random_hex(16));
    db.execute("INSERT OR IGNORE INTO companion_replica_resource_alias(vault_key,note_id,target,resource_id) VALUES(?1,?2,?3,?4)",
        params![vault,note,target,proposed]).map_err(db_error)?;
    db.query_row("SELECT resource_id FROM companion_replica_resource_alias WHERE vault_key=?1 AND note_id=?2 AND target=?3",
        params![vault,note,target], |row| row.get(0)).map_err(db_error)
}

pub(super) fn route(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    if request.method != "GET" { return Err((405, "METHOD_NOT_ALLOWED")); }
    let path = request.path.split('?').next().unwrap_or("");
    let id = path.strip_prefix("/v1/notes/").and_then(|p| p.strip_suffix("/replica-manifest"))
        .filter(|id| valid_id(id)).ok_or((404, "NOT_FOUND"))?;
    let q = query(&request.path, &["vault"])?;
    let (target, vault) = target(gateway)?;
    if q.get("vault") != Some(&vault) { return Err((409, "VAULT_CHANGED")); }
    {
        let mut state = gateway.content_state.lock().map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
        reconcile(gateway, &target, &vault, &mut state)?;
    } // No global Content/transition lock is held while hashing resource bytes.
    let doc = current_document(gateway, &target, &vault, id)?;
    let revision_before = revision(&doc.summary.relative_path, &doc.revision);
    let projection = document_value(gateway, &vault, id, &doc)?;
    let links = companion_attachment_links(&doc.content);
    // Never silently truncate a dependency set and call it complete.
    if links.len() > 1000 { return Err((413, "REPLICA_MANIFEST_TOO_LARGE")); }
    let db = database(gateway)?;
    let mut resources = Vec::new();
    let mut total = 0u64;
    let mut seen = HashSet::new();
    let mut complete = true;
    let mut verify_resources = Vec::new();
    for entry in projection["resources"].as_array().ok_or((503, "CONTENT_UNAVAILABLE"))? {
        let download_id = entry["resourceId"].as_str().ok_or((503, "CONTENT_UNAVAILABLE"))?;
        if !seen.insert(download_id.to_owned()) { continue; }
        let destination = entry["target"].as_str().ok_or((503, "CONTENT_UNAVAILABLE"))?;
        let alias = resource_alias(&db, &vault, id, destination)?;
        // Ordinary web/mail/anchor hyperlinks are not offline file dependencies.
        // Embedded external media remains required and unavailable; never fetch it here.
        let embedded = links.iter().any(|link| link.destination == destination && link.embedded);
        let lower = destination.to_ascii_lowercase();
        let required = embedded || !(lower.starts_with("https://") || lower.starts_with("http://")
            || lower.starts_with("mailto:") || destination.starts_with('#'));
        // Target text is a Markdown reference, never a filesystem grant or local path.
        let mut item = json!({"resourceId":alias,"downloadResourceId":download_id,"target":destination,
            "mimeType":entry["mimeType"],"status":entry["status"],"required":required});
        if !required || entry["status"] != "resolved" {
            if required { complete = false; }
            resources.push(item);
            continue;
        }
        let resource_request = HttpRequest { method:"GET".into(),
            path:format!("/v1/notes/{id}/resources/{download_id}?vault={vault}"),
            headers:request.headers.clone(),body:Vec::new() };
        let (mut file, mime_type, version) = match resource(gateway, &resource_request) {
            Ok(value) => value,
            Err((404, _)) => { item["status"] = json!("unavailable"); complete = false; resources.push(item); continue; }
            Err(error) => return Err(error),
        };
        let before = file.metadata().map_err(|_| (409,"RESOURCE_CHANGED"))?;
        let size = before.len();
        if size > MAX_RESOURCE_BYTES || total.saturating_add(size) > MAX_MANIFEST_BYTES {
            item["status"] = json!("sizeLimit"); complete = false; resources.push(item); continue;
        }
        total += size;
        let hash = hash_handle(&mut file, size, || {
            super::super::access(gateway, request)?;
            gateway.knowledge().with_current_target_response_lease(&target, || ())
                .map_err(|_| (409,"VAULT_CHANGED"))
        })?;
        let after = file.metadata().map_err(|_| (409,"RESOURCE_CHANGED"))?;
        if after.len() != before.len() || after.modified().ok() != before.modified().ok() {
            return Err((409,"RESOURCE_CHANGED"));
        }
        verify_resources.push((resource_request, size, version.clone(), hash.clone()));
        item["sha256"] = json!(hash); item["sizeBytes"] = json!(size);
        item["version"] = json!(version); item["mimeType"] = json!(mime_type);
        item["status"] = json!("verified");
        resources.push(item);
    }
    // Verify after collecting the entire set, not only immediately after each first read.
    // A later download still MUST match this hash; no atomic cross-file snapshot is claimed.
    for (resource_request, size, version, hash) in verify_resources {
        let (mut verified, _, current_version) = resource(gateway, &resource_request)?;
        if current_version != version { return Err((409,"RESOURCE_CHANGED")); }
        let verified_hash = hash_handle(&mut verified, size, || {
            super::super::access(gateway, request)?;
            gateway.knowledge().with_current_target_response_lease(&target, || ())
                .map_err(|_| (409,"VAULT_CHANGED"))
        })?;
        if verified_hash != hash { return Err((409,"RESOURCE_CHANGED")); }
    }
    let current = current_document(gateway, &target, &vault, id)?;
    if revision(&current.summary.relative_path, &current.revision) != revision_before {
        return Err((409,"REVISION_CONFLICT"));
    }
    super::super::access(gateway, request)?;
    let value = json!({"schemaVersion":1,"vaultId":vault,"noteId":id,"revision":revision_before,
        "relativePath":doc.summary.relative_path,"body":{"sha256":format!("{:x}",Sha256::digest(doc.content.as_bytes())),
            "sizeBytes":doc.content.len(),"encoding":"utf-8"},
        "resourceIdentity":"scoped-target-alias","resources":resources,"complete":complete});
    gateway.knowledge().with_current_target_response_lease(&target, || value)
        .map_err(|_| (409,"VAULT_CHANGED"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(bytes: &[u8]) -> (std::path::PathBuf, fs::File) {
        let path = std::env::temp_dir().join(format!("replica-hash-{}-{}",std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::write(&path,bytes).unwrap();
        let file = fs::File::open(&path).unwrap();
        (path,file)
    }
    #[test]
    fn actual_handle_hash_and_size_are_verified() {
        let (path,mut file)=fixture(b"abc");
        assert_eq!(hash_handle(&mut file,3,||Ok(())).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(hash_handle(&mut file,2,||Ok(())).unwrap_err(),(409,"RESOURCE_CHANGED"));
        assert_eq!(hash_handle(&mut file,4,||Ok(())).unwrap_err(),(409,"RESOURCE_CHANGED"));
        drop(file);fs::remove_file(path).unwrap();
    }
    #[test]
    fn authority_revocation_and_scope_change_interrupt_hashing() {
        let (path,mut file)=fixture(&vec![7;131072]);
        let mut calls=0;
        assert_eq!(hash_handle(&mut file,131072,||{calls+=1;if calls==2 {Err((403,"SCOPE_DENIED"))}else{Ok(())}}).unwrap_err(),(403,"SCOPE_DENIED"));
        assert_eq!(hash_handle(&mut file,131072,||Err((409,"VAULT_CHANGED"))).unwrap_err(),(409,"VAULT_CHANGED"));
        drop(file);fs::remove_file(path).unwrap();
    }
    #[test]
    fn changed_same_size_bytes_produce_different_hash() {
        let (path,mut file)=fixture(b"first");
        let first=hash_handle(&mut file,5,||Ok(())).unwrap();drop(file);
        fs::write(&path,b"other").unwrap();let mut file=fs::File::open(&path).unwrap();
        assert_ne!(first,hash_handle(&mut file,5,||Ok(())).unwrap());
        drop(file);fs::remove_file(path).unwrap();
    }
    #[test]
    fn oversized_resource_is_rejected_before_reading() {
        let (path,mut file)=fixture(b"");
        assert_eq!(hash_handle(&mut file,MAX_RESOURCE_BYTES+1,||panic!("must not read")).unwrap_err(),(413,"REPLICA_RESOURCE_TOO_LARGE"));
        drop(file);fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    #[test]
    fn aliases_persist_and_never_cross_vault_note_or_target_scope() {
        let db=Connection::open_in_memory().unwrap();
        let first=resource_alias(&db,"vault-a","note-a","assets/a.png").unwrap();
        assert_eq!(first,resource_alias(&db,"vault-a","note-a","assets/a.png").unwrap());
        assert_ne!(first,resource_alias(&db,"vault-b","note-a","assets/a.png").unwrap());
        assert_ne!(first,resource_alias(&db,"vault-a","note-b","assets/a.png").unwrap());
        assert_ne!(first,resource_alias(&db,"vault-a","note-a","assets/renamed.png").unwrap());
        assert!(first.starts_with("rr-"));
    }
    #[test]
    fn target_text_is_never_used_as_a_local_path_or_casefolded_identity() {
        let db=Connection::open_in_memory().unwrap();
        let mut ids=HashSet::new();
        for target in ["A.png","a.png","../escape","CON","file:///secret","trailing. ","中文.png"] {
            let id=resource_alias(&db,"vault-a","note-a",target).unwrap();
            assert!(id.starts_with("rr-") && id.len()==35);
            assert!(ids.insert(id));
        }
        // This registry stores aliases only; all resource reads still use Knowledge's resolver.
    }
}
