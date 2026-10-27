//! Narrow web-MCP knowledge seam. Uses the formal KnowledgeService, never SQLite
//! or filesystem note writes. Receipt metadata is separate from vault content.
use crate::{
    assets_import_file::{download_with_limits, validate_file_name, DownloadLimits},
    knowledge::{KnowledgeCreateInput, KnowledgeDocumentRef, KnowledgeService},
    local_transport::{AdapterResponse, VerifiedTransportPrincipal},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::Duration,
};
const MAX_MARKDOWN: u64 = 2 * 1024 * 1024;
const PREFIX: &str = "/api/library-mcp/knowledge/";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportInput {
    request_id: String,
    url: String,
    file_name: String,
    #[serde(default)]
    folder: Option<String>,
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    request_digest: String,
    note_id: String,
    vault_id: String,
    file_name: String,
    content_sha256: String,
    warnings: Vec<String>,
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn failure(code: &str) -> AdapterResponse {
    let status = if code.contains("scope") || code.contains("grant") {
        403
    } else if code == "method-not-allowed" {
        405
    } else if code == "import-outcome-unknown" {
        409
    } else {
        400
    };
    AdapterResponse {
        status,
        // The shared versioned transport supplies the outer ok/error envelope.
        body: json!({"code":code}).to_string(),
    }
}
fn success(value: Value) -> AdapterResponse {
    AdapterResponse {
        status: 200,
        body: value.to_string(),
    }
}
fn text(bytes: Vec<u8>) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_MARKDOWN || bytes.contains(&0) {
        return Err("markdown-content-invalid".into());
    }
    // Keep BOM, line endings, frontmatter and code blocks byte-for-byte.
    String::from_utf8(bytes).map_err(|_| "markdown-utf8-required".into())
}
fn name(raw: &str) -> Result<String, String> {
    let n = validate_file_name(raw).map_err(|_| "markdown-filename-invalid")?;
    if !n.to_ascii_lowercase().ends_with(".md") || n.len() <= 3 || n.trim() != n {
        return Err("markdown-file-required".into());
    }
    Ok(n)
}
fn safe_metadata_path(path: &Path) -> Result<(), String> {
    for p in path.ancestors() {
        match fs::symlink_metadata(p) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return Err("receipt-path-invalid".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if m.file_attributes() & 0x400 != 0 {
                        return Err("receipt-path-invalid".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("receipt-path-invalid".into()),
        }
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    safe_metadata_path(path)?;
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "receipt-create-failed")?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| "receipt-save-failed".into())
}
fn bounded_read(path: &Path) -> Result<Option<Vec<u8>>, String> {
    safe_metadata_path(path)?;
    match fs::metadata(path) {
        Ok(m) if m.is_file() && m.len() <= 16384 => fs::read(path)
            .map(Some)
            .map_err(|_| "receipt-read-failed".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => Err("receipt-invalid".into()),
    }
}
// Reuse Knowledge's existing read-only create preview. Reject an invalid parent
// before downloading or persisting intent; the actual create still revalidates
// under its own mutation/identity gate. A later race remains indeterminate.
fn requested_reference(service: &KnowledgeService, input: &ImportInput, filename: &str) -> Result<KnowledgeDocumentRef, String> {
    let relative_path = match input.folder.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(folder) => format!("{folder}/{filename}"),
        None => filename.to_owned(),
    };
    Ok(KnowledgeDocumentRef {
        vault_id: service.current_vault_id().map_err(|e| e.code.to_owned())?,
        relative_path,
    })
}
fn validate_destination(service: &KnowledgeService, input: &ImportInput, filename: &str) -> Result<(), String> {
    let reference = requested_reference(service, input, filename)?;
    service.preview_agent_create_revision(&reference, "").map(|_| ()).map_err(|e| {
        if e.code == "knowledge-name-conflict" { "note-name-exists".to_owned() } else { e.code.to_owned() }
    })
}

fn completed_receipt(service: &KnowledgeService, input: &ImportInput, filename: &str, directory: &Path) -> Result<Option<Receipt>, String> {
    let finished = directory.join(format!("{}.complete.json", digest(input.request_id.as_bytes())));
    let Some(bytes) = bounded_read(&finished)? else { return Ok(None); };
    let receipt: Receipt = serde_json::from_slice(&bytes).map_err(|_| "receipt-invalid")?;
    if [&receipt.request_digest, &receipt.content_sha256].iter().any(|value| value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit())) {
        return Err("receipt-invalid".into());
    }
    let reference = KnowledgeService::parse_document_id(&receipt.note_id).map_err(|e| e.code.to_owned())?;
    let expected = requested_reference(service, input, filename)?;
    // The receipt is already namespaced by the authenticated grant. Restoring
    // that grant's frozen scope binds the physical Vault identity; the note ID
    // pins its relative destination. An attachment ID or URL cannot retarget it.
    if reference != expected || receipt.vault_id != expected.vault_id || receipt.file_name != filename {
        return Err("request-id-conflict".into());
    }
    Ok(Some(receipt))
}
fn import(
    principal: &VerifiedTransportPrincipal,
    service: &KnowledgeService,
    input: ImportInput,
) -> Result<Value, String> {
    import_with_download(principal, service, input, |url| {
        download_with_limits(url, &DownloadLimits {
            max_bytes: MAX_MARKDOWN,
            total_timeout: Duration::from_secs(60),
            max_redirects: 3,
        }).map_err(|_| "markdown-download-failed".to_owned())
    })
}

// The only injected seam is external network I/O. Tests still exercise the
// actual authorization, receipt and formal KnowledgeService save/read chain.
fn import_with_download(
    principal: &VerifiedTransportPrincipal,
    service: &KnowledgeService,
    input: ImportInput,
    download: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Result<Value, String> {
    if !(8..=128).contains(&input.request_id.len())
        || !input
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("request-id-invalid".into());
    }
    if input.url.len() > 8192 || !input.url.starts_with("https://") {
        return Err("download-url-invalid".into());
    }
    let filename = name(&input.file_name)?;
    // Keep the original on-disk field/encoding for old readers and sealed
    // pending intents. It is historical data, NOT the stable identity check:
    // a temporary download URL can change while the verified bytes do not.
    let legacy_request_digest = digest(
        serde_json::to_string(&json!([input.url, filename, input.folder]))
            .unwrap()
            .as_bytes(),
    );
    // Check scope/destination and old unknown outcomes before any network I/O.
    let (initial_target, prior_receipt) = principal.with_knowledge_mcp(|scope, grant, root| {
        let scoped = service
            .restore_workspace_scope(scope)
            .map_err(|e| e.code.to_owned())?;
        let target = scoped.current_target_identity().map_err(|e| e.code.to_owned())?;
        let directory = root.join("community-mcp-receipts").join(grant);
        let key = digest(input.request_id.as_bytes());
        if let Some(receipt) = completed_receipt(&scoped, &input, &filename, &directory)? {
            return Ok((target, Some(receipt)));
        }
        if bounded_read(&directory.join(format!("{key}.pending.json")))?.is_some() {
            return Err("import-outcome-unknown".into());
        }
        validate_destination(&scoped, &input, &filename)?;
        Ok((target, None))
    })?;
    // Even an unchanged URL/file_id is not evidence of identical bytes. Use the
    // existing HTTPS/SSRF/redirect/size guarded downloader on EVERY retry.
    let bytes = download(&input.url)?;
    let content = text(bytes)?;
    let content_sha256 = digest(content.as_bytes());
    principal.with_knowledge_mcp(|scope,grant,root|{
        let scoped=service.restore_workspace_scope(scope).map_err(|e|e.code.to_owned())?;
        let target=scoped.current_target_identity().map_err(|e|e.code.to_owned())?;
        if target != initial_target { return Err("knowledge-target-changed".into()); }
        let vault_id=scoped.current_vault_id().map_err(|e|e.code.to_owned())?;
        let directory=root.join("community-mcp-receipts").join(grant);
        safe_metadata_path(&directory)?;
        // A concurrent successful request may have finished during download.
        // Re-read completion BEFORE pending; never replay a pending-only intent.
        if let Some(receipt) = completed_receipt(&scoped, &input, &filename, &directory)? {
            if prior_receipt.as_ref().is_some_and(|prior| prior != &receipt) {
                return Err("receipt-invalid".into());
            }
            if receipt.content_sha256 != content_sha256 {
                return Err("request-id-conflict".into());
            }
            let reference = KnowledgeService::parse_document_id(&receipt.note_id).map_err(|e| e.code.to_owned())?;
            let doc = scoped.read_document_for_target(&target, &reference).map_err(|e| e.code.to_owned())?;
            if doc.revision != receipt.content_sha256 { return Err("imported-note-changed".into()); }
            return Ok(json!({"noteId":receipt.note_id,"vaultId":receipt.vault_id,"fileName":receipt.file_name,
                "disposition":"duplicate","contentSha256":receipt.content_sha256,"warnings":receipt.warnings}));
        }
        if prior_receipt.is_some() { return Err("import-outcome-unknown".into()); }
        // A durable, exclusive intent prevents duplicate writes after crashes and
        // concurrent retries. An interrupted intent is explicitly indeterminate.
        let key=digest(input.request_id.as_bytes());
        let pending=directory.join(format!("{key}.pending.json"));
        if pending.exists(){return Err("import-outcome-unknown".into());}
        // Recheck after the network wait, still before intent. A concurrently
        // created intent must win over preflight and remains indeterminate.
        validate_destination(&scoped,&input,&filename)?;
        fs::create_dir_all(&directory).map_err(|_|"receipt-directory-failed")?;
        if fs::read_dir(&directory).map_err(|_|"receipt-read-failed")?.take(8193).count()>8192{return Err("receipt-capacity-reached".into());}
        write_new(&pending,serde_json::to_string(&json!({"requestDigest":legacy_request_digest})).unwrap().as_bytes())?;
        // The formal API accepts a complete .md name; retain case and repeated extensions.
        let title=filename.clone();
        let created=scoped.create_document_for_target(&target,&KnowledgeCreateInput{title,parent_relative_path:input.folder.clone(),content:content.clone()});
        let result=match created{
            Ok(result)=>result,
            Err(e)=>{
                // Do not retry a mutation after an error: metadata may have failed
                // after commit. Keeping the intent is safer than creating a duplicate.
                return Err(if e.code=="knowledge-name-conflict"{"note-name-exists".into()}else{"import-outcome-unknown".into()});
            }
        };
        let doc=scoped.read_document_for_target(&target,&result.document.summary.document_ref).map_err(|_|"import-outcome-unknown")?;
        if doc.revision!=content_sha256
            || doc.content!=content.strip_prefix('\u{feff}').unwrap_or(&content){return Err("import-outcome-unknown".into());}
        let mut warnings=Vec::new();
        if content.contains("](")||content.contains("![["){warnings.push("referenced-files-not-imported".into());}
        if result.index_stale{warnings.push("knowledge-index-pending".into());}
        let receipt=Receipt{request_digest:legacy_request_digest.clone(),note_id:KnowledgeService::document_id(&doc.summary.document_ref),
            vault_id,file_name:filename.clone(),content_sha256,warnings};
        write_new(&directory.join(format!("{key}.complete.json")),&serde_json::to_vec(&receipt).map_err(|_|"receipt-save-failed")?)
            .map_err(|_|"import-outcome-unknown")?;
        Ok(json!({"noteId":receipt.note_id,"vaultId":receipt.vault_id,"fileName":receipt.file_name,
            "disposition":"imported","contentSha256":receipt.content_sha256,"warnings":receipt.warnings}))
    })
}

#[cfg(test)]
pub(crate) fn test_import_with_download(
    principal: &VerifiedTransportPrincipal,
    service: &KnowledgeService,
    body: Value,
    download: impl FnOnce(&str) -> Result<Vec<u8>, String>,
) -> Result<Value, String> {
    let input = serde_json::from_value(body).map_err(|_| "input-invalid".to_owned())?;
    import_with_download(principal, service, input, download)
}

pub(crate) fn route(
    service: &KnowledgeService,
    principal: &VerifiedTransportPrincipal,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Option<AdapterResponse> {
    if !path.starts_with(PREFIX) {
        return None;
    }
    if method != "POST" {
        return Some(failure("method-not-allowed"));
    }
    let result = (|| -> Result<Value, String> {
        if path == format!("{PREFIX}import-markdown") {
            let input: ImportInput =
                serde_json::from_str(body.unwrap_or("")).map_err(|_| "input-invalid")?;
            return import(principal, service, input);
        }
        principal.with_knowledge_mcp(|scope,_,_|{
            let scoped=service.restore_workspace_scope(scope).map_err(|e|e.code.to_owned())?;
            let target=scoped.current_target_identity().map_err(|e|e.code.to_owned())?;
            match path.strip_prefix(PREFIX).unwrap_or(""){
                "search"=>{
                    #[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Input{#[serde(default)]query:String,#[serde(default="default_limit")]limit:usize}
                    fn default_limit()->usize{20}
                    let input:Input=serde_json::from_str(body.unwrap_or("")).map_err(|_|"input-invalid")?;
                    if input.query.chars().count()>1000||input.limit==0||input.limit>50{return Err("input-invalid".into());}
                    let docs=scoped.search_documents(&input.query,input.limit).map_err(|e|e.code.to_owned())?;
                    // The restored native scope is pinned; UI vault selection cannot retarget it.
                    if scoped.current_target_identity().map_err(|e|e.code.to_owned())?!=target{return Err("knowledge-target-changed".into());}
                    Ok(json!({"vaultId":scoped.current_vault_id().map_err(|e|e.code.to_owned())?,"notes":docs.into_iter().map(|d|json!({"noteId":KnowledgeService::document_id(&d.document_ref),"title":d.title,"relativePath":d.relative_path})).collect::<Vec<_>>()}))
                },
                "read"=>{
                    #[derive(Deserialize)] #[serde(rename_all="camelCase",deny_unknown_fields)] struct Input{note_id:String}
                    let input:Input=serde_json::from_str(body.unwrap_or("")).map_err(|_|"input-invalid")?;
                    if input.note_id.len()>2048{return Err("input-invalid".into());}
                    let reference=KnowledgeService::parse_document_id(&input.note_id).map_err(|e|e.code.to_owned())?;
                    let doc=scoped.read_document_for_target(&target,&reference).map_err(|e|e.code.to_owned())?;
                    if doc.content.len()>512*1024{return Err("note-response-too-large".into());}
                    Ok(json!({"noteId":input.note_id,"vaultId":reference.vault_id,"title":doc.summary.title,"content":doc.content,"revision":doc.revision}))
                },_=>Err("operation-denied".into())
            }
        })
    })();
    Some(match result {
        Ok(v) => success(v),
        Err(code) => failure(&code),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn markdown_bytes_are_preserved() {
        let raw = "\u{feff}---\r\ntitle: 中文\r\n---\r\n```js\r\nlet x=1\r\n```\r\n";
        assert_eq!(text(raw.as_bytes().to_vec()).unwrap(), raw);
    }
    #[test]
    fn rejects_binary_and_wrong_extensions() {
        for b in [
            vec![],
            vec![0],
            vec![255, 254],
            vec![b'a'; MAX_MARKDOWN as usize + 1],
        ] {
            assert!(text(b).is_err());
        }
        for n in ["../x.md", "C:\\x.md", "x.txt", "x.md.exe", ".md"] {
            assert!(name(n).is_err());
        }
        assert_eq!(name("中文笔记.md").unwrap(), "中文笔记.md");
    }
    #[test]
    fn receipt_paths_are_opaque_and_fixed_length() {
        assert_eq!(digest(b"../../secret").len(), 64);
        assert_ne!(digest(b"id-a"), digest(b"id-b"));
    }
}
