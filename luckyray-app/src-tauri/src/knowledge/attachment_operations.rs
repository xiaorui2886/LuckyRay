//! Hash-bound batch recovery evidence. The files remain the content authority.
//! A batch is intentionally partial/recoverable; it is not a multi-file atomic commit.
use super::attachments::{
    attachment_copy_name, legacy_hash_attachment_name, guard_existing_ancestors, hold_verified_attachment, read_external_attachment_bytes,
    read_scoped_attachment_bytes, resolve_attachment,
};
use super::markdown_links::{
    attachment_links, markdown_relative_target, patch_destinations, AttachmentLink,
    LinkSyntax,
};
use super::*;
use base64::Engine;

const MAX_OPERATION_BYTES: usize = 128 * 1024 * 1024;

fn rewritten_import_link(source:&str,link:&AttachmentLink,target:&str,external:bool,_local:Option<&str>)->String {
    let fragment=if external {link.destination.split_once('#').map(|(_,f)|format!("#{f}")).unwrap_or_default()} else {String::new()};
    let target=format!("{target}{fragment}");
    if external && link.syntax==LinkSyntax::Wiki {
        let size = link.alias.as_deref().filter(|_| link.embedded).and_then(|alias| {
            let values = alias.split('x').collect::<Vec<_>>();
            if values.is_empty() || values.len() > 2 { return None; }
            let numbers = values.iter().map(|value| value.parse::<u32>().ok().filter(|size| (1..=100_000).contains(size))).collect::<Option<Vec<_>>>()?;
            Some(if numbers.len() == 1 { format!("width={}", numbers[0]) } else { format!("width={} height={}", numbers[0], numbers[1]) })
        });
        let filename = link.destination.split('#').next().unwrap_or(&link.destination).rsplit('/').next().unwrap_or("attachment");
        let label = if size.is_some() { filename } else { link.alias.as_deref().unwrap_or(filename) };
        let title = size.map(|size| format!(" \"{size}\"")).unwrap_or_default();
        return format!("{}[{}]({target}{title})",if link.embedded {"!"} else {""},label.replace('\\',"\\\\").replace('[',"\\[").replace(']',"\\]"));
    }
    let mut raw=source[link.span.clone()].to_owned();
    if let Some(span)=&link.destination_span {raw.replace_range(span.start-link.span.start..span.end-link.span.start,&target);}
    raw
}

/// One maintenance attempt, distinct from the durable recovery operation ID.
/// The worker owns this guard, including while waiting for source/mutation locks.
pub(crate) struct AttachmentAttempt {
    slot: Arc<Mutex<Option<AttachmentAttemptState>>>,
    cancelled: Arc<AtomicBool>,
}
pub(super) struct AttachmentAttemptState {
    vault_id: String,
    request_id: String,
    cancelled: Arc<AtomicBool>,
}
impl Drop for AttachmentAttempt {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.slot.lock() {
            if slot.as_ref().is_some_and(|state| Arc::ptr_eq(&state.cancelled, &self.cancelled)) {
                *slot = None;
            }
        }
    }
}


#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentOperationIssue {
    pub document: String,
    pub target: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentFileChange {
    pub relative_path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub before_revision: Option<String>,
    pub after_revision: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentOperationPlan {
    pub version: u32,
    pub vault_id: String,
    pub target_identity: String,
    pub attachment_dependencies: Vec<(String, String)>,
    #[serde(default)]
    pub external_paths: Vec<(String,String)>,
    #[serde(default)]
    pub external_dependencies: Vec<(String,String)>,
    #[serde(default)]
    pub material_relocation: Option<(String,String,String)>,
    #[serde(default)]
    pub material_revision: Option<String>,
    #[serde(default)]
    pub material_original_path: Option<String>,
    #[serde(default)]
    pub material_file_move: Option<crate::attachment_file_moves::MaterialFileMove>,
    #[serde(default)]
    pub source_epoch: u64,
    #[serde(default)]
    pub authorization: String,
    #[serde(default)]
    pub receipt_authorization: String,
    pub kind: String,
    pub files: Vec<AttachmentFileChange>,
    pub issues: Vec<AttachmentOperationIssue>,
    pub document_count: usize,
    pub attachment_count: usize,
    pub copy_bytes: u64,
    pub backup_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentOperationResult {
    pub operation_id: String,
    pub status: String,
    pub completed_files: usize,
    pub total_files: usize,
    pub issues: Vec<AttachmentOperationIssue>,
    pub recovery_path: String,
}

fn payload(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
fn bytes(payload: &Option<String>) -> Result<Option<Vec<u8>>, KnowledgeError> {
    payload
        .as_ref()
        .map(|value| {
            base64::engine::general_purpose::STANDARD
                .decode(value)
                .map_err(|_| error("knowledge-recovery-invalid", "Operation backup is invalid"))
        })
        .transpose()
}
fn change(path: String, before: Option<&[u8]>, after: Option<&[u8]>) -> AttachmentFileChange {
    AttachmentFileChange {
        relative_path: path,
        before: before.map(payload),
        after: after.map(payload),
        before_revision: before.map(sha256_hex),
        after_revision: after.map(sha256_hex),
    }
}
fn plan(
    vault: &TrustedVault,
    kind: &str,
    identity: &KnowledgeTargetIdentity,
) -> Result<AttachmentOperationPlan, KnowledgeError> {
    let target_identity = identity.identity_digest.clone();
    Ok(AttachmentOperationPlan {
        version: 1,
        vault_id: vault.registration.id.clone(),
        target_identity,
        attachment_dependencies: Vec::new(),
        external_paths: Vec::new(),
        external_dependencies: Vec::new(),
        material_relocation: None,
        material_revision: None,
        material_original_path: None,
        material_file_move: None,
        source_epoch: 0,
        authorization: String::new(),
        receipt_authorization: String::new(),
        kind: kind.into(),
        files: Vec::new(),
        issues: Vec::new(),
        document_count: 0,
        attachment_count: 0,
        copy_bytes: 0,
        backup_bytes: 0,
    })
}
fn issue(plan: &mut AttachmentOperationPlan, document: &str, link: &AttachmentLink, status: &str) {
    plan.issues.push(AttachmentOperationIssue {
        document: document.into(),
        target: link.destination.clone(),
        status: status.into(),
    });
}
fn append_change(
    plan: &mut AttachmentOperationPlan,
    file: AttachmentFileChange,
) -> Result<(), KnowledgeError> {
    if file.before_revision == file.after_revision {
        return Ok(());
    }
    let before = bytes(&file.before)?.map_or(0, |bytes| bytes.len());
    let after = bytes(&file.after)?.map_or(0, |bytes| bytes.len());
    plan.backup_bytes += before as u64;
    if file.before.is_none() {
        plan.copy_bytes += after as u64;
    }
    if plan.backup_bytes + plan.copy_bytes > MAX_OPERATION_BYTES as u64 || plan.files.len() >= 1024
    {
        return Err(error(
            "knowledge-operation-capacity",
            "Operation exceeds 128 MiB or 1024 files; select fewer documents",
        ));
    }
    if plan.files.iter().any(|existing| {
        existing
            .relative_path
            .eq_ignore_ascii_case(&file.relative_path)
    }) {
        return Err(error(
            "knowledge-operation-conflict",
            "Operation contains conflicting destinations",
        ));
    }
    if file.relative_path.to_ascii_lowercase().ends_with(".md") {
        plan.document_count += 1;
    } else {
        plan.attachment_count += 1;
    }
    plan.files.push(file);
    Ok(())
}

/// Determine the exact copied path during preview without creating anything.
fn plan_attachment_copy(
    plan: &mut AttachmentOperationPlan,
    root: &Path,
    inventory: &[String],
    name: &str,
    content: &[u8],
    source: &Path,
    source_copies: &mut HashMap<String, (String, String)>,
) -> Result<String, KnowledgeError> {
    // This map lives only for this preview. Equal bytes at different physical
    // paths do not establish that the files share a future editing identity.
    let canonical = source.canonicalize().map_err(|_| error("knowledge-attachment-source-unavailable", "Original attachment location is unavailable"))?;
    let source_key = super::external_attachments::file_path_key(&canonical);
    let digest = sha256_hex(content);
    if let Some((relative, previous_digest)) = source_copies.get(&source_key) {
        if previous_digest != &digest {
            return Err(error("knowledge-revision-conflict", "Attachment source changed during import preview"));
        }
        return Ok(relative.clone());
    }
    let relative = (1..=100_001).map(|ordinal| format!("attachments/{}", attachment_copy_name(name, ordinal)))
        .find(|candidate| !inventory.iter().any(|old| old.eq_ignore_ascii_case(candidate))
            && !plan.files.iter().any(|file| file.relative_path.eq_ignore_ascii_case(candidate))
            && !root.join(candidate).exists())
        .ok_or_else(|| error("knowledge-attachment-conflict", "No unused attachment name is available"))?;
    if !plan
        .attachment_dependencies
        .iter()
        .any(|(path, _)| path == &relative)
    {
        plan.attachment_dependencies
            .push((relative.clone(), digest.clone()));
    }
    if let Some(existing) = plan
        .files
        .iter()
        .find(|file| file.relative_path == relative)
    {
        if existing.after_revision.as_deref() == Some(&digest) {
            return Ok(relative);
        }
        return Err(error(
            "knowledge-attachment-conflict",
            "Attachment plan conflicts",
        ));
    }
    if root.join(&relative).exists() {
        return Err(error(
            "knowledge-attachment-conflict",
            "Attachment destination contains different bytes",
        ));
    }
    append_change(plan, change(relative.clone(), None, Some(content)))?;
    source_copies.insert(source_key, (relative.clone(), digest));
    Ok(relative)
}

fn copied_link_destination(link: &AttachmentLink, note: &str, attachment: &str) -> String {
    let fragment = link.destination.split_once('#')
        .map(|(_, value)| format!("#{value}")).unwrap_or_default();
    if link.syntax == LinkSyntax::Wiki {
        format!("{attachment}{fragment}")
    } else {
        format!("{}{fragment}", markdown_relative_target(note, attachment))
    }
}

impl KnowledgeService {
    pub(crate) fn begin_attachment_attempt(&self, vault_id: &str, request_id: &str) -> Result<AttachmentAttempt, KnowledgeError> {
        if request_id.len() != 36 || !request_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
            return Err(error("knowledge-operation-request-invalid", "Invalid attachment request ID"));
        }
        // No source/mutation lock here: registration precedes queueing, and stop
        // must remain reachable while those locks are held by the worker.
        let mut slot = self.attachment_attempt.lock().map_err(|_| error("knowledge-lock-poisoned", "Attachment request lock failed"))?;
        if slot.is_some() { return Err(error("knowledge-operation-busy", "An attachment maintenance request is already running")); }
        let cancelled = Arc::new(AtomicBool::new(false));
        *slot = Some(AttachmentAttemptState { vault_id: vault_id.into(), request_id: request_id.into(), cancelled: cancelled.clone() });
        Ok(AttachmentAttempt { slot: self.attachment_attempt.clone(), cancelled })
    }

    pub(crate) fn cancel_attachment_operation(&self, vault_id: &str, request_id: &str) -> Result<(), KnowledgeError> {
        let slot = self.attachment_attempt.lock().map_err(|_| error("knowledge-lock-poisoned", "Attachment request lock failed"))?;
        if let Some(state) = slot.as_ref().filter(|state| state.vault_id == vault_id && state.request_id == request_id) {
            state.cancelled.store(true, Ordering::Release);
        }
        Ok(())
    }

    pub(crate) fn execute_attachment_attempt(&self, source_epoch: u64, operation: &AttachmentOperationPlan, attempt: AttachmentAttempt) -> Result<AttachmentOperationResult, KnowledgeError> {
        // The operation mutates the attachment tree; the shared inventory
        // snapshot must not outlive it.
        let _inventory_mutation = self.attachment_inventory.mutation();
        self.execute_attachment_operation_with_cancel(source_epoch, operation, &attempt.cancelled)
    }

    pub(crate) fn recover_attachment_attempt(&self, source_epoch: u64, vault_id: &str, id: &str, rollback: bool, attempt: AttachmentAttempt) -> Result<AttachmentOperationResult, KnowledgeError> {
        let _inventory_mutation = self.attachment_inventory.mutation();
        self.recover_attachment_operation_with_cancel(source_epoch, vault_id, id, rollback, &attempt.cancelled)
    }

    pub(crate) fn read_attachment_operation_plan(&self,vault_id:&str,id:&str)->Result<AttachmentOperationPlan,KnowledgeError> {
        let (vault,guard,identity)=self.capture_current_target()?;
        if vault.registration.id!=vault_id {return Err(knowledge_target_not_current());}
        if id.len()!=32 || !id.bytes().all(|b|b.is_ascii_hexdigit()) {return Err(error("knowledge-recovery-invalid","Invalid operation identifier"));}
        let path=recovery_directory(&vault.root)?.join(format!("{id}.json"));
        if has_reparse_point(&path)? {return Err(error("knowledge-path-reparse-forbidden","Invalid recovery path"));}
        let mut bytes=Vec::new();
        File::open(&path).map_err(|_|error("knowledge-recovery-missing","Cannot read operation"))?.take((MAX_OPERATION_BYTES*3+1) as u64).read_to_end(&mut bytes).map_err(|_|error("knowledge-recovery-missing","Cannot read operation"))?;
        if bytes.len()>MAX_OPERATION_BYTES*3 {return Err(error("knowledge-recovery-invalid","Recovery record exceeds limit"));}
        let operation=serde_json::from_slice(&bytes).map_err(|_|error("knowledge-recovery-invalid","Invalid operation"))?;
        validate_plan(&vault,&operation)?;self.verify_attachment_receipt(&operation)?;self.verify_current_target(&identity,&guard)?;Ok(operation)
    }
    pub(crate) fn record_attachment_projection(&self,vault_id:&str,result:&AttachmentOperationResult)->Result<(),KnowledgeError> {
        let (vault,guard,identity)=self.capture_current_target()?;
        if vault.registration.id!=vault_id {return Err(knowledge_target_not_current());}
        if result.operation_id.len()!=32 || !result.operation_id.bytes().all(|b|b.is_ascii_hexdigit()) {return Err(error("knowledge-recovery-invalid","Invalid operation identifier"));}
        let directory=recovery_directory(&vault.root)?;
        self.verify_current_target(&identity,&guard)?;
        write_new_synced(&directory.join(format!("{}-{:032x}.result.json",result.operation_id,rand::random::<u128>())),&serde_json::to_vec(result).map_err(|_|error("knowledge-recovery-invalid","Cannot encode projection receipt"))?)
    }

    pub(crate) fn list_attachment_operations(
        &self,
        vault_id: &str,
    ) -> Result<Vec<String>, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        let relative = Path::new(".luckyray/attachment-operations");
        if !vault.root.join(relative).exists() {
            return Ok(Vec::new());
        }
        let directory = safe_existing_directory(&vault.root, relative)?;
        let entries = std::fs::read_dir(directory).map_err(|_| {
            error(
                "knowledge-recovery-read-failed",
                "Cannot enumerate recovery records",
            )
        })?;
        let mut ids = Vec::new();
        for entry in entries.take(4096) {
            let entry = entry.map_err(|_| {
                error(
                    "knowledge-recovery-read-failed",
                    "Cannot inspect recovery record",
                )
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(id) = name.strip_suffix(".json") {
                if id.len() == 32
                    && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    && !has_reparse_point(&entry.path())?
                {
                    ids.push(id.into());
                }
            }
        }
        ids.sort();
        self.verify_current_target(&identity, &guard)?;
        Ok(ids)
    }

    pub(super) fn move_note_with_attachments_unlocked(
        &self,
        vault: &TrustedVault,
        input: &KnowledgeMoveInput,
        destination: &str,
        original: &[u8],
        existing_guard: Option<&FilesystemDirectoryIdentityGuard>,
    ) -> Result<(), KnowledgeError> {
        let owned_guard = if existing_guard.is_none() {
            Some(
                filesystem_directory_identity_guard(&vault.root)
                    .map_err(map_filesystem_identity_error)?,
            )
        } else {
            None
        };
        let root_guard = existing_guard.or(owned_guard.as_ref()).expect("root guard");
        let identity = knowledge_target_identity(vault, root_guard.identity())?;
        let after = self.moved_note_bytes_unlocked(vault, input, destination, original)?;
        let mut operation = plan(vault, "note-move", &identity)?;
        append_change(
            &mut operation,
            change(destination.into(), None, Some(&after)),
        )?;
        append_change(
            &mut operation,
            change(
                input.document_ref.relative_path.clone(),
                Some(original),
                None,
            ),
        )?;
        for file in &operation.files {
            require_file_state(&vault.root, file, false)?;
        }
        let directory = recovery_directory(&vault.root)?;
        let id = format!("{:032x}", rand::random::<u128>());
        write_new_synced(
            &directory.join(format!("{id}.json")),
            &serde_json::to_vec(&operation).map_err(|_| {
                error(
                    "knowledge-recovery-invalid",
                    "Cannot encode note move backup",
                )
            })?,
        )?;
        let result = self.run_attachment_operation_unlocked(
            vault,
            &operation,
            &id,
            false,
            Some(root_guard),
            &AtomicBool::new(false),
        )?;
        if result.status == "partial" {
            return Err(error(
                "knowledge-operation-partial",
                format!(
                    "Note move is partial; recover operation {} in Vault attachments",
                    result.operation_id
                ),
            ));
        }
        Ok(())
    }

    pub(super) fn moved_note_bytes_unlocked(
        &self, vault: &TrustedVault, input: &KnowledgeMoveInput,
        destination: &str, original: &[u8],
    ) -> Result<Vec<u8>, KnowledgeError> {
        let decoded = decode_document(original)?;
        let mut patches = Vec::new();
        for link in attachment_links(&decoded.content) {
            if link.syntax == LinkSyntax::Wiki
                && !link.destination.starts_with("./")
                && !link.destination.starts_with("../")
            {
                continue;
            }
            // Moving authored text only re-expresses its existing path. This
            // does not open the external file or grant Catalog read authority.
            if let Some(absolute)=super::external_attachments::external_target_path(&vault.root,&input.document_ref.relative_path,&link.destination,link.syntax)?
                .filter(|path|!super::external_attachments::file_is_within(path,&vault.root)) {
                if link.destination.to_ascii_lowercase().starts_with("file:") || Path::new(link.destination.split('#').next().unwrap_or("")).is_absolute() {continue;}
                if link.destination_span.is_none() {return Err(error("knowledge-link-rewrite-unsupported","Note contains a shared reference-style link; rewrite its definition before moving"));}
                let target=super::external_attachments::portable_attachment_target(&vault.root,destination,&absolute)?;
                patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&target,true,None)));
                continue;
            }
            let target = match super::markdown_links::local_target(
                &link.destination,
                link.syntax,
                &input.document_ref.relative_path,
            ) {
                Ok(target) => target,
                Err("remote-or-absolute" | "self-reference") => continue,
                Err(reason) => {
                    return Err(error(
                        "knowledge-link-move-unresolved",
                        format!("Cannot safely move note containing attachment target: {reason}"),
                    ))
                }
            };
            let _range = link.destination_span.as_ref().ok_or_else(|| error("knowledge-link-rewrite-unsupported", "Note contains a shared reference-style link; rewrite its definition before moving"))?;
            let next = if link.syntax == LinkSyntax::Wiki {
                format!("{}{}", target.path, target.fragment)
            } else {
                format!(
                    "{}{}",
                    markdown_relative_target(destination, &target.path),
                    target.fragment
                )
            };
            patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&next,false,Some(&next))));
        }
        let next_content = super::markdown_links::patch_links(&decoded.content, &patches)
            .map_err(|message| error("knowledge-link-patch-invalid", message))?;
        let after = encode_document(&decoded, &next_content);
        Ok(after)
    }

    pub(crate) fn preview_attachment_relink(&self,vault_id:&str,references:&[(String,String)],new_path:&Path)->Result<AttachmentOperationPlan,KnowledgeError> {
        self.preview_attachment_retarget(vault_id,references,new_path,new_path,false)
    }
    pub(crate) fn preview_attachment_file_move(&self,vault_id:&str,references:&[(String,String)],old_path:&Path,new_path:&Path)->Result<AttachmentOperationPlan,KnowledgeError> {
        self.preview_attachment_retarget(vault_id,references,old_path,new_path,true)
    }
    fn preview_attachment_retarget(&self,vault_id:&str,references:&[(String,String)],read_path:&Path,new_path:&Path,moving:bool)->Result<AttachmentOperationPlan,KnowledgeError> {
        let (vault,guard,identity)=self.capture_current_target()?;
        if vault.registration.id!=vault_id {return Err(knowledge_target_not_current());}
        let original_path=super::external_attachments::verified_external_file(read_path)?;
        let content=read_external_attachment_bytes(&vault.root,&original_path)?;
        let new_path=if moving {
            if new_path.exists() {return Err(error("knowledge-attachment-conflict","Destination already exists"));}
            let parent=new_path.parent().ok_or_else(||error("knowledge-path-invalid","Destination has no parent"))?.canonicalize().map_err(|_|error("knowledge-path-invalid","Destination directory is unavailable"))?;
            let anchor=parent.ancestors().last().ok_or_else(||error("knowledge-path-invalid","Destination is not absolute"))?;
            let _parents=guard_existing_ancestors(anchor,&parent.join("attachment"))?;
            parent.join(new_path.file_name().ok_or_else(||error("knowledge-path-invalid","Destination has no name"))?)
        } else {super::external_attachments::verified_external_file(new_path)?};
        let mut result=plan(&vault,"attachment-relink",&identity)?;
        result.external_dependencies.push((original_path.to_string_lossy().into_owned(),sha256_hex(&content)));
        let mut notes=references.iter().map(|(note,_)|note.clone()).collect::<Vec<_>>(); notes.sort();notes.dedup();
        for note in notes {
            let original=read_scoped_attachment_bytes(&vault.root,&safe_markdown_relative_path(&note)?)?;
            let decoded=decode_document(&original)?;
            let target=super::external_attachments::portable_attachment_target(&vault.root,&note,&new_path)?;
            let mut patches=Vec::new();
            for link in attachment_links(&decoded.content) {
                if !references.iter().any(|(path,old)|path==&note&&old==&link.destination) {continue;}
                if link.destination_span.is_none() {issue(&mut result,&note,&link,"unsupported-reference-style-rewrite");continue;}
                patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&target,true,None)));
            }
            if !patches.is_empty() {
                let after=super::markdown_links::patch_links(&decoded.content,&patches).map_err(|message|error("knowledge-link-patch-invalid",message))?;
                append_change(&mut result,change(note.clone(),Some(&original),Some(&encode_document(&decoded,&after))))?;
                result.external_paths.push((note,new_path.to_string_lossy().into_owned()));
            }
        }
        self.verify_current_target(&identity,&guard)?; Ok(result)
    }

    pub(crate) fn preview_attachment_import(
        &self,
        vault_id: &str,
        source_root: &Path,
        source_notes: &[String],
        target_parent: &str,
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        self.preview_attachment_import_with_policy(vault_id,source_root,source_notes,target_parent,false)
    }

    pub(crate) fn preview_attachment_import_with_policy(&self,vault_id:&str,source_root:&Path,source_notes:&[String],target_parent:&str,reference:bool)->Result<AttachmentOperationPlan,KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        for ancestor in source_root
            .ancestors()
            .filter(|path| !path.as_os_str().is_empty())
        {
            if has_reparse_point(ancestor)? {
                return Err(error(
                    "knowledge-path-reparse-forbidden",
                    "Import source contains a linked path",
                ));
            }
        }
        let source_root = source_root.canonicalize().map_err(|_| {
            error(
                "knowledge-import-source-missing",
                "Import source root is unavailable",
            )
        })?;
        // Only basename references require evidence from the complete source tree.
        // A selected note or explicit relative target must not depend on unrelated
        // project folders being enumerable (for example node_modules junctions).
        let mut source_inventory = None;
        let _source_guard = filesystem_directory_identity_guard(&source_root)
            .map_err(map_filesystem_identity_error)?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let parent = safe_relative_path(target_parent, true)?;
        let mut result = plan(&vault, "import", &identity)?;
        let mut source_copies = HashMap::new();
        let mut used: std::collections::HashSet<String> = inventory
            .iter()
            .map(|path| path.to_ascii_lowercase())
            .collect();
        let mut mapping = std::collections::HashMap::new();
        for note in source_notes {
            let source = safe_markdown_relative_path(note)?;
            safe_existing_file(&source_root, &source)?;
            let target = parent.join(&source);
            let mut destination = relative_path_string(&target);
            let stem = target
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("note");
            let mut ordinal = 1;
            while used.contains(&destination.to_ascii_lowercase())
                || vault.root.join(&destination).exists()
            {
                destination =
                    relative_path_string(&target.with_file_name(format!("{stem} ({ordinal}).md")));
                ordinal += 1;
            }
            used.insert(destination.to_ascii_lowercase());
            if mapping.insert(note.clone(), destination).is_some() {
                return Err(error(
                    "knowledge-import-invalid",
                    "Import selection contains duplicate notes",
                ));
            }
        }
        let mut documents = Vec::new();
        for note in source_notes {
            let original = read_scoped_attachment_bytes(&source_root, Path::new(note))?;
            let decoded = decode_document(&original)?;
            let destination = &mapping[note];
            let mut patches = Vec::new();
            for link in attachment_links(&decoded.content) {
                // Resolve explicit outside-root targets in the source note context.
                // Ordinary local/basename targets retain the existing ambiguity checks.
                let source_candidate=super::external_attachments::external_target_path(&source_root,note,&link.destination,link.syntax)?;
                if let Some(candidate)=source_candidate.filter(|path|!path.starts_with(&source_root) || link.destination.to_ascii_lowercase().starts_with("file:") || Path::new(link.destination.split('#').next().unwrap_or("")).is_absolute()) {
                    if link.destination_span.is_none() {issue(&mut result,note,&link,"unsupported-reference-style-rewrite");continue;}
                    let path=match super::external_attachments::verified_external_file(&candidate) {Ok(path)=>path,Err(failure)=>{issue(&mut result,note,&link,&failure.code);continue;}};
                    let content=read_external_attachment_bytes(&vault.root,&path)?;
                    let target=if reference { super::external_attachments::portable_attachment_target(&vault.root,destination,&path)? }
                        else { let copied=plan_attachment_copy(&mut result,&vault.root,&inventory,path.file_name().and_then(OsStr::to_str).unwrap_or("attachment"),&content,&path,&mut source_copies)?; markdown_relative_target(destination,&copied) };
                    if reference {
                        result.external_paths.push((destination.clone(),path.to_string_lossy().into_owned()));
                        result.external_dependencies.push((path.to_string_lossy().into_owned(),sha256_hex(&content)));
                    }
                    patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&target,true,None)));
                    continue;
                }
                let target = match super::markdown_links::local_target(&link.destination, link.syntax, note) {
                    Ok(target) => target,
                    Err(status) => {
                        if !matches!(status, "remote-or-absolute" | "self-reference") {
                            issue(&mut result, note, &link, status);
                        }
                        continue;
                    }
                };
                let direct_inventory;
                let local = Path::new(note).parent().unwrap_or(Path::new("")).join(&target.path);
                let sibling = if target.basename_search {
                    match safe_existing_file(&source_root, &local) {
                        Ok(path) => Some(relative_path_string(path.strip_prefix(&source_root).map_err(|_| {
                            error("knowledge-path-outside-vault", "Import reference is outside the source root")
                        })?)),
                        Err(failure) if failure.code == "knowledge-not-found" => None,
                        Err(failure) => return Err(failure),
                    }
                } else { None };
                let candidates = if let Some(sibling) = sibling {
                    direct_inventory = vec![sibling];
                    direct_inventory.as_slice()
                } else if target.basename_search {
                    match source_inventory.get_or_insert_with(|| index::attachment_inventory(&source_root)) {
                        Ok(inventory) => inventory.as_slice(),
                        Err(_) => {
                            issue(&mut result, note, &link, "source-inventory-incomplete");
                            continue;
                        }
                    }
                } else {
                    direct_inventory = match safe_existing_file(&source_root, Path::new(&target.path)) {
                        Ok(path) => vec![relative_path_string(path.strip_prefix(&source_root).map_err(|_| {
                            error("knowledge-path-outside-vault", "Import reference is outside the source root")
                        })?)],
                        Err(failure) if failure.code == "knowledge-not-found" => Vec::new(),
                        Err(failure) => return Err(failure),
                    };
                    direct_inventory.as_slice()
                };
                let resolved = resolve_attachment(
                    &source_root,
                    candidates,
                    note,
                    &link.destination,
                    link.syntax,
                )?;
                let Some(relative) = resolved.relative_path else {
                    if !matches!(
                        resolved.status.as_str(),
                        "remote-or-absolute" | "self-reference"
                    ) {
                        issue(&mut result, note, &link, &resolved.status);
                    }
                    continue;
                };
                if link.destination_span.is_none() {
                    issue(
                        &mut result,
                        note,
                        &link,
                        "unsupported-reference-style-rewrite",
                    );
                    continue;
                }
                let target = if relative.to_ascii_lowercase().ends_with(".md") {
                    match mapping.get(&relative) {
                        Some(target) => target.clone(),
                        None => {
                            issue(&mut result, note, &link, "referenced-note-not-selected");
                            continue;
                        }
                    }
                } else {
                    let content = read_scoped_attachment_bytes(&source_root, Path::new(&relative))?;
                    if reference {
                        let path=safe_existing_file(&source_root,Path::new(&relative))?;
                        let target=super::external_attachments::portable_attachment_target(&vault.root,destination,&path)?;
                        result.external_paths.push((destination.clone(),path.to_string_lossy().into_owned()));
                        result.external_dependencies.push((path.to_string_lossy().into_owned(),sha256_hex(&content)));
                        patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&target,true,None)));
                        continue;
                    }
                    plan_attachment_copy(&mut result, &vault.root, &inventory, &relative, &content, &source_root.join(&relative), &mut source_copies)?
                };
                let replacement = if link.syntax == LinkSyntax::Wiki {
                    format!("{target}{}", resolved.fragment)
                } else {
                    format!("{}{}", markdown_relative_target(destination, &target), resolved.fragment)
                };
                patches.push((link.span.clone(),rewritten_import_link(&decoded.content,&link,&replacement,false,Some(&replacement))));
            }
            let content = super::markdown_links::patch_links(&decoded.content, &patches)
                .map_err(|message| error("knowledge-link-patch-invalid", message))?;
            let after = encode_document(&decoded, &content);
            documents.push(change(destination.clone(), None, Some(&after)));
        }
        for document in documents {
            append_change(&mut result, document)?;
        }
        self.verify_current_target(&identity, &guard)?;
        Ok(result)
    }

    pub(crate) fn execute_attachment_operation(
        &self,
        source_epoch: u64,
        operation: &AttachmentOperationPlan,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        self.execute_attachment_operation_with_cancel(source_epoch, operation, &AtomicBool::new(false))
    }

    fn execute_attachment_operation_with_cancel(&self, source_epoch: u64, operation: &AttachmentOperationPlan, cancelled: &AtomicBool) -> Result<AttachmentOperationResult, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, Some(&operation.vault_id))?;
        let _lock = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge mutation lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        validate_plan(&vault, operation)?;
        let _external_files = self.hold_external_plan(&vault, operation, source_epoch)?;
        let _external_locations = hold_external_dependencies(operation)?;
        // Validate every before-state before publishing the durable intent.
        for file in &operation.files {
            require_file_state(&vault.root, file, false)?;
        }
        let directory = recovery_directory(&vault.root)?;
        let id = format!("{:032x}", rand::random::<u128>());
        let record = directory.join(format!("{id}.json"));
        let receipt=self.seal_attachment_receipt(operation)?;
        let encoded = serde_json::to_vec(&receipt).map_err(|_| {
            error(
                "knowledge-recovery-invalid",
                "Cannot encode operation backup",
            )
        })?;
        write_new_synced(&record, &encoded)?;
        self.run_attachment_operation_unlocked(&vault, operation, &id, false, None, cancelled)
    }

    pub(crate) fn recover_attachment_operation(
        &self,
        source_epoch: u64,
        vault_id: &str,
        id: &str,
        rollback: bool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        self.recover_attachment_operation_with_cancel(source_epoch, vault_id, id, rollback, &AtomicBool::new(false))
    }

    fn recover_attachment_operation_with_cancel(&self, source_epoch: u64, vault_id: &str, id: &str, rollback: bool, cancelled: &AtomicBool) -> Result<AttachmentOperationResult, KnowledgeError> {
        let _source = self.lock_active_ui_source(source_epoch, Some(vault_id))?;
        let _lock = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge mutation lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(error(
                "knowledge-recovery-invalid",
                "Invalid operation identifier",
            ));
        }
        let directory = recovery_directory(&vault.root)?;
        let path = directory.join(format!("{id}.json"));
        if has_reparse_point(&path)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Recovery record is a linked path",
            ));
        }
        let metadata = path.metadata().map_err(|_| {
            error(
                "knowledge-recovery-missing",
                "Operation backup was not found",
            )
        })?;
        if metadata.len() > (MAX_OPERATION_BYTES * 3) as u64 {
            return Err(error(
                "knowledge-recovery-invalid",
                "Operation backup exceeds capacity",
            ));
        }
        let mut encoded=Vec::new();
        File::open(path).map_err(|_|error("knowledge-recovery-missing","Cannot read operation backup"))?.take((MAX_OPERATION_BYTES*3+1) as u64).read_to_end(&mut encoded).map_err(|_|error("knowledge-recovery-missing","Cannot read operation backup"))?;
        if encoded.len()>MAX_OPERATION_BYTES*3 {return Err(error("knowledge-recovery-invalid","Recovery record exceeds limit"));}
        let operation: AttachmentOperationPlan = serde_json::from_slice(&encoded)
            .map_err(|_| error("knowledge-recovery-invalid", "Operation backup is invalid"))?;
        validate_plan(&vault, &operation)?;
        self.verify_attachment_receipt(&operation)?;
        let _external_files = if rollback { Vec::new() } else { self.hold_external_plan(&vault, &operation, source_epoch)? };
        let _external_locations=if rollback {Vec::new()} else {hold_external_dependencies(&operation)?};
        self.run_attachment_operation_unlocked(&vault, &operation, id, rollback, None, cancelled)
    }

    fn run_attachment_operation_unlocked(
        &self,
        vault: &TrustedVault,
        operation: &AttachmentOperationPlan,
        id: &str,
        rollback: bool,
        existing_guard: Option<&FilesystemDirectoryIdentityGuard>,
        cancelled: &AtomicBool,
    ) -> Result<AttachmentOperationResult, KnowledgeError> {
        let owned_guard = if existing_guard.is_none() {
            Some(
                filesystem_directory_identity_guard(&vault.root)
                    .map_err(map_filesystem_identity_error)?,
            )
        } else {
            None
        };
        let root_guard = existing_guard.or(owned_guard.as_ref()).expect("root guard");
        let identity = knowledge_target_identity(vault, root_guard.identity())?;
        let mut result = AttachmentOperationResult {
            operation_id: id.into(),
            status: if rollback {
                "rolled-back"
            } else if operation.issues.is_empty() {
                "complete"
            } else {
                "complete-with-unresolved"
            }
            .into(),
            completed_files: 0,
            total_files: operation.files.len(),
            issues: operation.issues.clone(),
            recovery_path: format!(".luckyray/attachment-operations/{id}.json"),
        };
        let ordered: Vec<_> = if rollback {
            operation.files.iter().rev().collect()
        } else {
            operation.files.iter().collect()
        };
        for file in ordered {
            if cancelled.load(Ordering::Acquire) {
                result.status = "partial".into();
                result.issues.push(AttachmentOperationIssue {
                    document: file.relative_path.clone(),
                    target: String::new(),
                    status: "cancelled-between-files".into(),
                });
                break;
            }
            // Copied attachments are retained even during rollback: later notes may
            // already reference them. This operation never performs attachment GC.
            if rollback
                && file.before.is_none()
                && !file.relative_path.to_ascii_lowercase().ends_with(".md")
            {
                result.completed_files += 1;
                continue;
            }
            #[cfg(test)]
            if result.completed_files == self.attachment_fault_after_steps.load(Ordering::Acquire) {
                self.attachment_fault_after_steps
                    .store(usize::MAX, Ordering::Release);
                result.status = "partial".into();
                result.issues.push(AttachmentOperationIssue {
                    document: file.relative_path.clone(),
                    target: String::new(),
                    status: "injected-interruption".into(),
                });
                break;
            }
            let outcome = (|| {
                self.assert_expected_target_unlocked(vault, Some(&identity), Some(&root_guard))?;
                // Matching final bytes means this step completed before interruption.
                if require_file_state(&vault.root, file, !rollback).is_ok() {
                    return Ok(());
                }
                require_file_state(&vault.root, file, rollback)?;
                let before = if rollback { &file.after } else { &file.before };
                let after = if rollback { &file.before } else { &file.after };
                let expected = if rollback {
                    &file.after_revision
                } else {
                    &file.before_revision
                };
                let relative = safe_relative_path(&file.relative_path, false)?;
                let path = vault.root.join(&relative);
                let _parents = ensure_operation_parent(&vault.root, &relative)?;
                let _attachments = if !rollback
                    && file.relative_path.to_ascii_lowercase().ends_with(".md")
                    && after.is_some()
                {
                    operation
                        .attachment_dependencies
                        .iter()
                        .map(|(relative, digest)| {
                            hold_verified_attachment(&vault.root, relative, digest)
                        })
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    Vec::new()
                };
                match (before.is_some(), bytes(after)?) {
                    (false, Some(content)) => {
                        self.assert_expected_target_unlocked(
                            vault,
                            Some(&identity),
                            Some(&root_guard),
                        )?;
                        self.write_document(&path, &content, false)?;
                    }
                    (true, Some(content)) => {
                        safe_markdown_relative_path(&file.relative_path)?;
                        let decoded = decode_document(&content)?;
                        self.commit_existing_document(
                            vault,
                            &path,
                            expected.as_deref(),
                            Some(&identity),
                            Some(&root_guard),
                            |_| Ok(decoded.content),
                        )?;
                    }
                    (true, None) => {
                        // Preview is not a snapshot of all future incoming references. Recheck
                        // on execution AND resume, keeping every inspected note locked through
                        // deletion. Directory handles do not prevent external file creation.
                        let _references = if !rollback && operation.kind == "attachment-rename" {
                            hold_unreferenced_attachment(&vault.root, &file.relative_path)?
                        } else {
                            Vec::new()
                        };
                        let mut handle =
                            open_exclusive_document(&safe_existing_file(&vault.root, &relative)?)?;
                        if Some(sha256_hex(&read_exclusive_document(&mut handle)?)) != *expected {
                            return Err(error(
                                "knowledge-revision-conflict",
                                "File changed before operation deletion",
                            ));
                        }
                        self.assert_expected_target_unlocked(
                            vault,
                            Some(&identity),
                            Some(&root_guard),
                        )?;
                        delete_open_file(&handle)?;
                    }
                    (false, None) => {
                        return Err(error("knowledge-recovery-invalid", "Empty operation step"))
                    }
                }
                require_file_state(&vault.root, file, !rollback)?;
                if file.relative_path.to_ascii_lowercase().ends_with(".md") {
                    self.index.mark_document_dirty(&KnowledgeDocumentRef {
                        vault_id: vault.registration.id.clone(),
                        relative_path: file.relative_path.clone(),
                    })?;
                }
                Ok(())
            })();
            match outcome {
                Ok(()) => result.completed_files += 1,
                Err(failure) => {
                    result.status = "partial".into();
                    result.issues.push(AttachmentOperationIssue {
                        document: file.relative_path.clone(),
                        target: String::new(),
                        status: format!("{}: {}", failure.code, failure.message),
                    });
                    break;
                }
            }
        }
        let directory = recovery_directory(&vault.root)?;
        let mut durable_result=result.clone();
        if !operation.external_paths.is_empty() || operation.material_relocation.is_some() || operation.material_file_move.is_some() {
            durable_result.status="partial".into();
            durable_result.issues.push(AttachmentOperationIssue{document:String::new(),target:String::new(),status:"attachment-projection-pending".into()});
        }
        let receipt = serde_json::to_vec(&durable_result).map_err(|_| {
            error(
                "knowledge-recovery-invalid",
                "Cannot encode operation result",
            )
        })?;
        // Append-only receipts retain previous attempts, including partial/rollback results.
        write_new_synced(
            &directory.join(format!("{id}-{:032x}.result.json", rand::random::<u128>())),
            &receipt,
        )?;
        Ok(result)
    }

    pub(crate) fn preview_attachment_conversion(
        &self,
        document_refs: &[KnowledgeDocumentRef],
        materials: &[(String, String, Option<PathBuf>)],
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        self.preview_attachment_conversion_with_approved(document_refs, materials, &[])
    }

    pub(crate) fn preview_attachment_conversion_with_approved(
        &self,
        document_refs: &[KnowledgeDocumentRef],
        materials: &[(String, String, Option<PathBuf>)],
        approved: &[(String, Vec<String>)],
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let mut result = plan(&vault, "conversion", &identity)?;
        let mut source_copies = HashMap::new();
        let mut documents = Vec::new();
        for document_ref in document_refs {
            require_matching_vault(document_ref, &vault.registration)?;
            let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
            let original = read_scoped_attachment_bytes(&vault.root, &relative)?;
            let decoded = decode_document(&original)?;
            let mut patches = Vec::new();
            for link in attachment_links(&decoded.content) {
                let target = link.destination.split('#').next().unwrap_or(&link.destination);
                let catalog_target = materials.iter().any(|(id, name, _)| id == target || name.eq_ignore_ascii_case(target));
                let extension = Path::new(target).extension().and_then(OsStr::to_str).unwrap_or("").to_ascii_lowercase();
                if extension == "md" && !catalog_target { continue; }
                // Ordinary Wiki links name notes (including dotted titles and
                // not-yet-created notes). They are not failed attachment copies.
                if link.syntax == LinkSyntax::Wiki && !link.embedded && !catalog_target
                    && !matches!(extension.as_str(), "png"|"jpg"|"jpeg"|"gif"|"webp"|"svg"|"bmp"|"avif"|"ico"|"tif"|"tiff"|"mp4"|"webm"|"mov"|"mkv"|"mp3"|"wav"|"ogg"|"flac"|"m4a"|"pdf"|"zip"|"7z"|"bin"|"doc"|"docx"|"xls"|"xlsx"|"ppt"|"pptx") {
                    continue;
                }
                let resolved = resolve_attachment(
                    &vault.root,
                    &inventory,
                    &document_ref.relative_path,
                    &link.destination,
                    link.syntax,
                )?;
                // Explicit collection may copy registered external files into the
                // Vault, but authored Markdown alone never grants read authority.
                if resolved.status != "resolved" && resolved.status != "ambiguous" {
                    if let Some(path) = super::external_attachments::external_target_path(
                        &vault.root, &document_ref.relative_path, &link.destination, link.syntax,
                    )?.filter(|path| !super::external_attachments::file_is_within(path, &vault.root)) {
                        let allowed = approved.iter().filter(|(note, _)| note == &document_ref.relative_path)
                            .flat_map(|(_, paths)| paths).any(|candidate|
                                super::external_attachments::file_path_key(Path::new(candidate)) == super::external_attachments::file_path_key(&path));
                        if !allowed {
                            issue(&mut result, &document_ref.relative_path, &link, "external-unregistered");
                            continue;
                        }
                        let Some(span) = link.destination_span.clone() else {
                            issue(&mut result, &document_ref.relative_path, &link, "unsupported-reference-style-rewrite");
                            continue;
                        };
                        let content = super::external_attachments::verified_external_file(&path)
                            .and_then(|verified| read_external_attachment_bytes(&vault.root, &verified));
                        let content = match content {
                            Ok(content) => content,
                            Err(failure) => { issue(&mut result, &document_ref.relative_path, &link, failure.code); continue; }
                        };
                        let name = path.file_name().and_then(OsStr::to_str).unwrap_or("attachment");
                        let destination = plan_attachment_copy(&mut result, &vault.root, &inventory, name, &content, &path, &mut source_copies)?;
                        patches.push((span, copied_link_destination(&link, &document_ref.relative_path, &destination)));
                        continue;
                    }
                }
                if resolved.status != "missing" {
                    if !matches!(
                        resolved.status.as_str(),
                        "resolved" | "remote-or-absolute" | "self-reference"
                    ) {
                        issue(
                            &mut result,
                            &document_ref.relative_path,
                            &link,
                            &resolved.status,
                        );
                    }
                    continue;
                }
                if link.destination_span.is_none() {
                    issue(
                        &mut result,
                        &document_ref.relative_path,
                        &link,
                        "unsupported-reference-style-rewrite",
                    );
                    continue;
                }
                let target = link
                    .destination
                    .split('#')
                    .next()
                    .unwrap_or(&link.destination);
                let exact_ids: Vec<_> =
                    materials.iter().filter(|(id, _, _)| id == target).collect();
                let matches = if exact_ids.is_empty() {
                    materials
                        .iter()
                        .filter(|(_, name, _)| name == target)
                        .collect()
                } else {
                    exact_ids
                };
                let (material_name, path) = match matches.as_slice() {
                    [(_, name, Some(path))] => (name, path),
                    [] => {
                        issue(&mut result, &document_ref.relative_path, &link, "missing");
                        continue;
                    }
                    [(_, _, None)] => {
                        issue(&mut result, &document_ref.relative_path, &link, "material-source-unavailable");
                        continue;
                    }
                    _ => {
                        issue(&mut result, &document_ref.relative_path, &link, "ambiguous");
                        continue;
                    }
                };
                let content = match read_external_attachment_bytes(&vault.root, path) {
                    Ok(content) => content,
                    Err(error) => {
                        issue(&mut result, &document_ref.relative_path, &link, &error.code);
                        continue;
                    }
                };
                let copy_name = path.file_name().and_then(|value| value.to_str())
                    .filter(|name| Path::new(name).extension().is_some())
                    .unwrap_or(material_name);
                let destination =
                    plan_attachment_copy(&mut result, &vault.root, &inventory, copy_name, &content, path, &mut source_copies)?;
                patches.push((
                    link.destination_span.clone().expect("checked inline destination"),
                    copied_link_destination(&link, &document_ref.relative_path, &destination),
                ));
            }
            let content = patch_destinations(&decoded.content, &patches)
                .map_err(|message| error("knowledge-link-patch-invalid", message))?;
            let after = encode_document(&decoded, &content);
            documents.push(change(
                document_ref.relative_path.clone(),
                Some(&original),
                Some(&after),
            ));
        }
        for document in documents {
            append_change(&mut result, document)?;
        }
        self.verify_current_target(&identity, &guard)?;
        Ok(result)
    }

    /// External file moves are already complete. This plan only updates existing notes.
    pub(super) fn plan_external_attachment_references(
        &self, vault: &TrustedVault, identity: &KnowledgeTargetIdentity,
        moves: &[(String, String, String, bool, (u64, u64))],
    ) -> Result<(AttachmentOperationPlan, usize), KnowledgeError> {
        let inventory = index::attachment_inventory(&vault.root)?;
        let mut prior = inventory.iter().filter(|path| !moves.iter().any(|(_, new, _, _, _)| path.eq_ignore_ascii_case(new))).cloned().collect::<Vec<_>>();
        prior.extend(moves.iter().map(|(old, _, _, _, _)| old.clone()));
        let mut result = plan(vault, "external-reference-update", identity)?;
        result.attachment_dependencies = moves.iter().map(|(_, new, digest, _, _)| (new.clone(), digest.clone())).collect();
        let mut reference_count = 0;
        for note in inventory.iter().filter(|path| path.to_ascii_lowercase().ends_with(".md")) {
            let before = read_scoped_attachment_bytes(&vault.root, Path::new(note))?;
            let decoded = decode_document(&before)?;
            let mut patches = Vec::new();
            for link in attachment_links(&decoded.content) {
                let Ok(target) = super::markdown_links::local_target(&link.destination, link.syntax, note) else { continue; };
                let matches = prior.iter().filter(|path| {
                    if target.basename_search { path.rsplit('/').next().is_some_and(|name| name.eq_ignore_ascii_case(&target.path)) }
                    else { path.eq_ignore_ascii_case(&target.path) }
                }).collect::<Vec<_>>();
                let Some((_, new, _, unique_basename, _)) = moves.iter().find(|(old, _, _, _, _)| matches.iter().any(|path| path.eq_ignore_ascii_case(old))) else { continue; };
                if matches.len() != 1 || (target.basename_search && !unique_basename) {
                    issue(&mut result, note, &link, "ambiguous"); continue;
                }
                let Some(range) = link.destination_span else { issue(&mut result, note, &link, "unsupported-reference-style-rewrite"); continue; };
                let destination = if link.syntax == LinkSyntax::Wiki { new.clone() } else { markdown_relative_target(note, new) };
                patches.push((range, format!("{destination}{}", target.fragment)));
            }
            reference_count += patches.len();
            let content = patch_destinations(&decoded.content, &patches).map_err(|message| error("knowledge-link-patch-invalid", message))?;
            append_change(&mut result, change(note.clone(), Some(&before), Some(&encode_document(&decoded, &content))))?;
        }
        Ok((result, reference_count))
    }

    pub(crate) fn preview_attachment_rename(
        &self,
        vault_id: &str,
        old: &str,
        new: &str,
    ) -> Result<AttachmentOperationPlan, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        if vault.registration.id != vault_id {
            return Err(knowledge_target_not_current());
        }
        let old_relative = safe_relative_path(old, false)?;
        let new_relative = safe_relative_path(new, false)?;
        if old.to_ascii_lowercase().ends_with(".md") || new.to_ascii_lowercase().ends_with(".md") {
            return Err(error(
                "knowledge-attachment-invalid-path",
                "Use note move for Markdown documents",
            ));
        }
        if old.eq_ignore_ascii_case(new) || vault.root.join(&new_relative).exists() {
            return Err(error(
                "knowledge-name-conflict",
                "Choose a new, unused attachment path",
            ));
        }
        let original = read_scoped_attachment_bytes(&vault.root, &old_relative)?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let mut result = plan(&vault, "attachment-rename", &identity)?;
        result
            .attachment_dependencies
            .push((new.into(), sha256_hex(&original)));
        append_change(&mut result, change(new.into(), None, Some(&original)))?;
        for note in inventory
            .iter()
            .filter(|path| path.to_ascii_lowercase().ends_with(".md"))
        {
            let before = read_scoped_attachment_bytes(&vault.root, Path::new(note))?;
            let decoded = decode_document(&before)?;
            let mut patches = Vec::new();
            for link in attachment_links(&decoded.content) {
                let resolved = resolve_attachment(
                    &vault.root,
                    &inventory,
                    note,
                    &link.destination,
                    link.syntax,
                )?;
                if resolved.status == "ambiguous"
                    && resolved
                        .candidates
                        .iter()
                        .any(|path| path.eq_ignore_ascii_case(old))
                {
                    return Err(error("knowledge-attachment-ambiguous", "A referencing document has an ambiguous attachment; resolve it before renaming"));
                }
                if resolved
                    .relative_path
                    .as_deref()
                    .is_some_and(|path| path.eq_ignore_ascii_case(old))
                {
                    let range = link.destination_span.ok_or_else(|| error("knowledge-link-rewrite-unsupported", "Reference-style attachment rename requires resolving its shared definition first"))?;
                    let replacement = if link.syntax == LinkSyntax::Wiki {
                        format!("{new}{}", resolved.fragment)
                    } else {
                        format!(
                            "{}{}",
                            markdown_relative_target(note, new),
                            resolved.fragment
                        )
                    };
                    patches.push((range, replacement));
                }
            }
            let content = patch_destinations(&decoded.content, &patches)
                .map_err(|message| error("knowledge-link-patch-invalid", message))?;
            let after = encode_document(&decoded, &content);
            append_change(
                &mut result,
                change(note.clone(), Some(&before), Some(&after)),
            )?;
        }
        append_change(&mut result, change(old.into(), Some(&original), None))?;
        self.verify_current_target(&identity, &guard)?;
        Ok(result)
    }
}

fn hold_unreferenced_attachment(
    root: &Path,
    old: &str,
) -> Result<Vec<super::attachments::AttachmentReadGuard>, KnowledgeError> {
    let inventory = index::attachment_inventory(root)?;
    let mut guards = Vec::new();
    for note in inventory.iter().filter(|path| path.to_ascii_lowercase().ends_with(".md")) {
        let original = read_scoped_attachment_bytes(root, Path::new(note))?;
        guards.push(hold_verified_attachment(root, note, &sha256_hex(&original))?);
        let decoded = decode_document(&original)?;
        for link in attachment_links(&decoded.content) {
            let resolved = resolve_attachment(root, &inventory, note, &link.destination, link.syntax)?;
            if resolved.relative_path.as_deref().is_some_and(|path| path.to_lowercase() == old.to_lowercase())
                || resolved.candidates.iter().any(|path| path.to_lowercase() == old.to_lowercase())
            {
                return Err(error("knowledge-attachment-new-reference",
                    format!("{note} still references the old attachment; old bytes are retained. Update this reference before resuming.")));
            }
        }
    }
    if index::attachment_inventory(root)? != inventory {
        return Err(error("knowledge-attachment-inventory-changed",
            "Vault inventory changed during reference validation; old attachment is retained"));
    }
    Ok(guards)
}

fn hold_external_dependencies(operation:&AttachmentOperationPlan)->Result<Vec<super::attachments::AttachmentReadGuard>,KnowledgeError> {
    operation.external_dependencies.iter().map(|(path,digest)| {
        let mut source=Path::new(path);
        if !source.exists() {if let Some(movement)=&operation.material_file_move {if path==&movement.original_path {source=Path::new(&movement.destination_path);}}}
        let path=super::external_attachments::verified_external_file(source)?;
        let root=path.ancestors().last().ok_or_else(||error("knowledge-recovery-invalid","External source must be absolute"))?;
        let relative=relative_path_string(path.strip_prefix(root).map_err(|_|error("knowledge-recovery-invalid","Invalid external source"))?);
        hold_verified_attachment(root,&relative,digest)
    }).collect()
}

fn validate_plan(
    vault: &TrustedVault,
    operation: &AttachmentOperationPlan,
) -> Result<(), KnowledgeError> {
    if !matches!(
        operation.kind.as_str(),
        "conversion" | "import" | "attachment-rename" | "note-move" | "external-reference-update" | "attachment-relink"
    ) || operation.attachment_dependencies.len() > 1024 || operation.external_paths.len()>1024 || operation.external_dependencies.len()>1024
    {
        return Err(error(
            "knowledge-recovery-invalid",
            "Invalid attachment operation kind or dependency count",
        ));
    }
    for (note,path) in &operation.external_paths {
        safe_markdown_relative_path(note)?;
        let bound=operation.external_dependencies.iter().any(|(dependency,_)|dependency==path)
            || operation.material_file_move.as_ref().is_some_and(|movement|path==&movement.destination_path && operation.external_dependencies.iter().any(|(dependency,hash)|dependency==&movement.original_path&&hash==&movement.expected_hash));
        if !Path::new(path).is_absolute() || !bound {
            return Err(error("knowledge-recovery-invalid","External attachment has no verified source dependency"));
        }
    }
    if let Some((id,path,snapshot))=&operation.material_relocation {
        if operation.kind!="attachment-relink" || operation.material_file_move.is_some() || id.is_empty() || snapshot.len()>1024*1024
            || !operation.external_paths.iter().any(|(_,target)|super::external_attachments::file_path_key(Path::new(target))==super::external_attachments::file_path_key(Path::new(path))) {
            return Err(error("knowledge-recovery-invalid","Invalid material relocation binding"));
        }
        let refs:Vec<crate::materials::NoteAttachmentReference>=serde_json::from_str(snapshot).map_err(|_|error("knowledge-recovery-invalid","Invalid reference snapshot"))?;
        if refs.len()>1024 {return Err(error("knowledge-recovery-invalid","Too many reference bindings"));}
    }
    if let Some(movement)=&operation.material_file_move {
        if operation.kind!="attachment-relink" || !matches!(movement.storage_mode.as_str(),"source"|"managed") || movement.asset_id.is_empty() || movement.expected_references.len()>1024
            || !operation.external_dependencies.iter().any(|(path,hash)|path==&movement.original_path&&hash==&movement.expected_hash)
            || !operation.external_paths.iter().any(|(_,path)|path==&movement.destination_path) {
            return Err(error("knowledge-recovery-invalid","Invalid material file move binding"));
        }
    }
    for (path,digest) in &operation.external_dependencies {
        if !Path::new(path).is_absolute() || digest.len()!=64 || !digest.bytes().all(|b|b.is_ascii_hexdigit()) {
            return Err(error("knowledge-recovery-invalid","Invalid external attachment dependency"));
        }
    }
    for (path, digest) in &operation.attachment_dependencies {
        safe_relative_path(path, false)?;
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(error(
                "knowledge-recovery-invalid",
                "Invalid attachment dependency digest",
            ));
        }
    }
    let guard =
        filesystem_directory_identity_guard(&vault.root).map_err(map_filesystem_identity_error)?;
    if operation.target_identity
        != knowledge_target_identity(vault, guard.identity())?.identity_digest
    {
        return Err(knowledge_target_not_current());
    }
    if operation.version != 1
        || operation.vault_id != vault.registration.id
        || operation.files.len() > 1024
    {
        return Err(error(
            "knowledge-recovery-invalid",
            "Operation does not belong to this Vault",
        ));
    }
    let mut paths = std::collections::HashSet::new();
    let mut total = 0usize;
    for file in &operation.files {
        if operation.kind == "external-reference-update" && (!file.relative_path.to_ascii_lowercase().ends_with(".md") || file.before.is_none() || file.after.is_none()) {
            return Err(error("knowledge-recovery-invalid", "External reference updates may only edit existing Markdown notes"));
        }
        safe_relative_path(&file.relative_path, false)?;
        if file.relative_path.split('/').any(|part| {
            [".obsidian", ".git"]
                .iter()
                .any(|name| part.eq_ignore_ascii_case(name))
                || part.starts_with(".lrk-")
        }) {
            return Err(error(
                "knowledge-path-outside-vault",
                "Operation cannot modify Vault configuration or journal files",
            ));
        }
        if !paths.insert(file.relative_path.to_ascii_lowercase()) {
            return Err(error(
                "knowledge-recovery-invalid",
                "Duplicate operation destination",
            ));
        }
        for (data, revision) in [
            (&file.before, &file.before_revision),
            (&file.after, &file.after_revision),
        ] {
            let decoded = bytes(data)?;
            total += decoded.as_ref().map_or(0, Vec::len);
            if decoded.as_deref().map(sha256_hex) != *revision || total > MAX_OPERATION_BYTES * 2 {
                return Err(error(
                    "knowledge-recovery-invalid",
                    "Operation payload digest or capacity mismatch",
                ));
            }
        }
        if file.before.is_some() && file.after.is_some() {
            safe_markdown_relative_path(&file.relative_path)?;
        }
    }
    Ok(())
}

fn require_file_state(
    root: &Path,
    file: &AttachmentFileChange,
    after: bool,
) -> Result<(), KnowledgeError> {
    let relative = safe_relative_path(&file.relative_path, false)?;
    assert_safe_components(root, &relative)?;
    let revision = if after {
        &file.after_revision
    } else {
        &file.before_revision
    };
    let path = root.join(&relative);
    let actual = if path.exists() {
        Some(sha256_hex(&read_scoped_attachment_bytes(root, &relative)?))
    } else {
        None
    };
    if actual != *revision {
        return Err(error(
            "knowledge-revision-conflict",
            "File differs from both expected operation states; external edits are preserved",
        ));
    }
    Ok(())
}

fn ensure_operation_parent(root: &Path, relative: &Path) -> Result<Vec<File>, KnowledgeError> {
    let mut guards = Vec::new();
    let mut current = PathBuf::new();
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        current.push(component);
        assert_safe_components(root, &current)?;
        if !root.join(&current).exists() {
            std::fs::create_dir(root.join(&current)).map_err(|_| {
                error(
                    "knowledge-attachment-write-failed",
                    "Cannot create operation folder",
                )
            })?;
        }
        safe_existing_directory(root, &current)?;
        guards.extend(guard_existing_ancestors(
            root,
            &root.join(&current).join("attachment"),
        )?);
    }
    Ok(guards)
}

fn recovery_directory(root: &Path) -> Result<PathBuf, KnowledgeError> {
    let relative = Path::new(".luckyray/attachment-operations");
    assert_safe_components(root, relative)?;
    let metadata = safe_existing_directory(root, Path::new(".luckyray"))?;
    let directory = metadata.join("attachment-operations");
    if !directory.exists() {
        std::fs::create_dir(&directory).map_err(|_| {
            error(
                "knowledge-recovery-write-failed",
                "Cannot create operation backup folder",
            )
        })?;
    }
    safe_existing_directory(root, relative)
}
