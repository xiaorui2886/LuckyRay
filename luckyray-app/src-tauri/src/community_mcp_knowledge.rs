//! Narrow web-MCP knowledge seam. Uses the formal KnowledgeService, never SQLite
//! or filesystem note writes. Receipt metadata is separate from vault content.
use crate::{
    assets_import_file::{download_with_limits, validate_file_name, DownloadLimits},
    knowledge::{KnowledgeCreateInput, KnowledgeService},
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
#[derive(Serialize, Deserialize)]
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
fn import(
    principal: &VerifiedTransportPrincipal,
    service: &KnowledgeService,
    input: ImportInput,
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
    let fingerprint = digest(
        serde_json::to_string(&json!([input.url, filename, input.folder]))
            .unwrap()
            .as_bytes(),
    );
    // Read the confirmed receipt BEFORE fetching a potentially expired temporary URL.
    let existing = principal.with_knowledge_mcp(|scope, grant, root| {
        let scoped = service
            .restore_workspace_scope(scope)
            .map_err(|e| e.code.to_owned())?;
        let directory = root.join("community-mcp-receipts").join(grant);
        let key = digest(input.request_id.as_bytes());
        let finished = directory.join(format!("{key}.complete.json"));
        if let Some(bytes) = bounded_read(&finished)? {
            let r: Receipt = serde_json::from_slice(&bytes).map_err(|_| "receipt-invalid")?;
            if r.request_digest != fingerprint {
                return Err("request-id-conflict".into());
            }
            let document_ref =
                KnowledgeService::parse_document_id(&r.note_id).map_err(|e| e.code.to_owned())?;
            let target = scoped
                .current_target_identity()
                .map_err(|e| e.code.to_owned())?;
            let doc = scoped
                .read_document_for_target(&target, &document_ref)
                .map_err(|e| e.code.to_owned())?;
            // KnowledgeService's revision hashes original bytes, including BOM.
            // Its content projection intentionally omits the leading UTF-8 BOM.
            if doc.revision != r.content_sha256 {
                return Err("imported-note-changed".into());
            }
            return Ok(Some(
                json!({"noteId":r.note_id,"vaultId":r.vault_id,"fileName":r.file_name,
                "disposition":"duplicate","contentSha256":r.content_sha256,"warnings":r.warnings}),
            ));
        }
        if bounded_read(&directory.join(format!("{key}.pending.json")))?.is_some() {
            return Err("import-outcome-unknown".into());
        }
        Ok(None)
    })?;
    if let Some(result) = existing {
        return Ok(result);
    }
    let bytes = download_with_limits(
        &input.url,
        &DownloadLimits {
            max_bytes: MAX_MARKDOWN,
            total_timeout: Duration::from_secs(60),
            max_redirects: 3,
        },
    )
    .map_err(|_| "markdown-download-failed")?;
    let content = text(bytes)?;
    principal.with_knowledge_mcp(|scope,grant,root|{
        let scoped=service.restore_workspace_scope(scope).map_err(|e|e.code.to_owned())?;
        let target=scoped.current_target_identity().map_err(|e|e.code.to_owned())?;
        let vault_id=scoped.current_vault_id().map_err(|e|e.code.to_owned())?;
        let directory=root.join("community-mcp-receipts").join(grant);
        safe_metadata_path(&directory)?;
        fs::create_dir_all(&directory).map_err(|_|"receipt-directory-failed")?;
        // A durable, exclusive intent prevents duplicate writes after crashes and
        // concurrent retries. An interrupted intent is explicitly indeterminate.
        let key=digest(input.request_id.as_bytes());
        let pending=directory.join(format!("{key}.pending.json"));
        if pending.exists(){return Err("import-outcome-unknown".into());}
        if fs::read_dir(&directory).map_err(|_|"receipt-read-failed")?.take(8193).count()>8192{return Err("receipt-capacity-reached".into());}
        write_new(&pending,serde_json::to_string(&json!({"requestDigest":fingerprint})).unwrap().as_bytes())?;
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
        if doc.revision!=digest(content.as_bytes())
            || doc.content!=content.strip_prefix('\u{feff}').unwrap_or(&content){return Err("import-outcome-unknown".into());}
        let mut warnings=Vec::new();
        if content.contains("](")||content.contains("![["){warnings.push("referenced-files-not-imported".into());}
        if result.index_stale{warnings.push("knowledge-index-pending".into());}
        let receipt=Receipt{request_digest:fingerprint.clone(),note_id:KnowledgeService::document_id(&doc.summary.document_ref),
            vault_id,file_name:filename.clone(),content_sha256:digest(content.as_bytes()),warnings};
        write_new(&directory.join(format!("{key}.complete.json")),&serde_json::to_vec(&receipt).map_err(|_|"receipt-save-failed")?)
            .map_err(|_|"import-outcome-unknown")?;
        Ok(json!({"noteId":receipt.note_id,"vaultId":receipt.vault_id,"fileName":receipt.file_name,
            "disposition":"imported","contentSha256":receipt.content_sha256,"warnings":receipt.warnings}))
    })
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
