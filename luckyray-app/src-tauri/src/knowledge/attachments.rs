//! Vault-owned attachment bytes and resolution, under KnowledgeService authority.
use super::markdown_links::{local_target, markdown_relative_target, LinkSyntax};
use super::*;
use std::io::Read;
use std::fs;

const MAX_ATTACHMENT_BYTES: u64 = 64 * 1024 * 1024;

pub(super) struct AttachmentReadGuard {
    _file: File,
    _parents: Vec<File>,
}

pub(super) fn hold_verified_attachment(
    root: &Path,
    relative: &str,
    digest: &str,
) -> Result<AttachmentReadGuard, KnowledgeError> {
    let relative = safe_relative_path(relative, false)?;
    let parents = guard_existing_ancestors(root, &root.join(&relative))?;
    let path = safe_existing_file(root, &relative)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options.open(path).map_err(|_| {
        error(
            "knowledge-attachment-changing",
            "Referenced attachment is unavailable or being edited",
        )
    })?;
    if file
        .metadata()
        .map_err(|_| {
            error(
                "knowledge-attachment-read-failed",
                "Cannot inspect referenced attachment",
            )
        })?
        .len()
        > MAX_ATTACHMENT_BYTES
    {
        return Err(error(
            "knowledge-attachment-size-limit",
            "Referenced attachment exceeds 64 MiB",
        ));
    }
    let mut content = Vec::new();
    (&mut file)
        .take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|_| {
            error(
                "knowledge-attachment-read-failed",
                "Cannot verify referenced attachment",
            )
        })?;
    if sha256_hex(&content) != digest {
        return Err(error(
            "knowledge-attachment-changing",
            "Referenced attachment changed since preview",
        ));
    }
    Ok(AttachmentReadGuard {
        _file: file,
        _parents: parents,
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentResolution {
    pub status: String,
    pub candidates: Vec<String>,
    pub relative_path: Option<String>,
    pub absolute_path: Option<String>,
    pub fragment: String,
    pub version: Option<String>,
    #[serde(default)]
    pub material_asset_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentPublication {
    pub relative_path: String,
    pub markdown: String,
    pub sha256: String,
    pub bytes: u64,
    pub reused: bool,
}

pub(super) fn resolve_attachment(
    root: &Path,
    inventory: &[String],
    note: &str,
    destination: &str,
    syntax: LinkSyntax,
) -> Result<AttachmentResolution, KnowledgeError> {
    let mut result = AttachmentResolution {
        status: "missing".into(),
        candidates: Vec::new(),
        relative_path: None,
        absolute_path: None,
        fragment: String::new(),
        version: None,
        material_asset_id: None,
    };
    let target = match local_target(destination, syntax, note) {
        Ok(target) => target,
        Err(status) => {
            result.status = status.into();
            return Ok(result);
        }
    };
    result.fragment = target.fragment;
    for path in inventory {
        let matches = if target.basename_search {
            path.rsplit('/')
                .next()
                .is_some_and(|name| name.to_lowercase() == target.path.to_lowercase())
        } else {
            path.to_lowercase() == target.path.to_lowercase()
        };
        if matches {
            safe_existing_file(root, Path::new(path))?;
            result.candidates.push(path.clone());
        }
    }
    match result.candidates.as_slice() {
        [] => (),
        [path] => {
            let absolute = safe_existing_file(root, Path::new(path))?;
            let metadata = std::fs::metadata(&absolute).map_err(|_| error("knowledge-attachment-read-failed", "Attachment metadata unavailable"))?;
            let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos()).unwrap_or(0);
            result.version = Some(format!("{}-{modified}", metadata.len()));
            result.relative_path = Some(path.clone());
            result.absolute_path = Some(absolute.to_string_lossy().into_owned());
            result.status = "resolved".into();
        }
        _ => result.status = "ambiguous".into(),
    }
    Ok(result)
}

/// Deny concurrent Windows writes/deletes while reading a bounded source snapshot.
pub(super) fn read_attachment_bytes(path: &Path) -> Result<Vec<u8>, KnowledgeError> {
    if has_reparse_point(path)? {
        return Err(error(
            "knowledge-path-reparse-forbidden",
            "Attachment is a linked path",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let file = options.open(path).map_err(|_| {
        error(
            "knowledge-attachment-read-failed",
            "Attachment is unavailable or being edited",
        )
    })?;
    let metadata = file.metadata().map_err(|_| {
        error(
            "knowledge-attachment-read-failed",
            "Attachment metadata is unavailable",
        )
    })?;
    if !metadata.is_file() || metadata.len() > MAX_ATTACHMENT_BYTES {
        return Err(error(
            "knowledge-attachment-size-limit",
            "Attachment must be a regular file no larger than 64 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            error(
                "knowledge-attachment-read-failed",
                "Cannot read attachment bytes",
            )
        })?;
    if bytes.len() as u64 != metadata.len() {
        return Err(error(
            "knowledge-attachment-changing",
            "Attachment changed during read",
        ));
    }
    Ok(bytes)
}

pub(super) fn guard_existing_ancestors(
    root: &Path,
    path: &Path,
) -> Result<Vec<File>, KnowledgeError> {
    let mut ancestors: Vec<_> = path
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .filter(|path| *path != root && path.starts_with(root))
        .collect();
    ancestors.reverse();
    let mut guards = Vec::new();
    for ancestor in ancestors {
        if has_reparse_point(ancestor)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Attachment ancestor is a linked path",
            ));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(3).custom_flags(0x02000000 | 0x00200000);
        }
        let guard = options.open(ancestor).map_err(|_| {
            error(
                "knowledge-attachment-parent-unavailable",
                "Cannot hold attachment parent directory",
            )
        })?;
        if has_reparse_point(ancestor)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Attachment ancestor changed to a linked path",
            ));
        }
        guards.push(guard);
    }
    Ok(guards)
}

pub(super) fn read_scoped_attachment_bytes(
    root: &Path,
    relative: &Path,
) -> Result<Vec<u8>, KnowledgeError> {
    let _parents = guard_existing_ancestors(root, &root.join(relative))?;
    let path = safe_existing_file(root, relative)?;
    read_attachment_bytes(&path)
}

pub(super) fn read_external_attachment_bytes(
    vault_root: &Path,
    path: &Path,
) -> Result<Vec<u8>, KnowledgeError> {
    let anchor = if path.starts_with(vault_root) {
        vault_root
    } else {
        path.ancestors().last().ok_or_else(|| {
            error(
                "knowledge-attachment-invalid-source",
                "Attachment source is not absolute",
            )
        })?
    };
    let _parents = guard_existing_ancestors(anchor, path)?;
    read_attachment_bytes(path)
}

pub(super) fn publication(
    note: &str,
    relative: String,
    bytes: &[u8],
    reused: bool,
) -> AttachmentPublication {
    let image = Path::new(&relative)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif"
            )
        });
    let label = relative
        .rsplit('/')
        .next()
        .unwrap_or("attachment")
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]");
    let markdown = if image && !relative.contains(['#','|','[',']','\r','\n']) {
        format!("![[{relative}]]")
    } else {format!(
        "{}[{label}]({})",
        if image { "!" } else { "" },
        markdown_relative_target(note, &relative)
    )};
    AttachmentPublication {
        relative_path: relative,
        markdown,
        sha256: sha256_hex(bytes),
        bytes: bytes.len() as u64,
        reused,
    }
}

/// Legacy storage hashes remain valid for existing links, but are not new display names.
pub(super) fn legacy_hash_attachment_name(name: &str) -> bool {
    Path::new(name).file_stem().and_then(|value| value.to_str())
        .is_some_and(|stem| stem.len() == 64 && stem.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Human-readable names are presentation; byte verification remains the authority.
pub(super) fn attachment_copy_name(name: &str, ordinal: usize) -> String {
    let leaf = name.rsplit(['/', '\\']).next().unwrap_or("attachment");
    let extension = Path::new(leaf).extension().and_then(|v| v.to_str())
        .filter(|v| v.len() <= 16 && v.bytes().all(|b| b.is_ascii_alphanumeric()))
        .unwrap_or("bin").to_ascii_lowercase();
    let stem: String = Path::new(leaf).file_stem().and_then(|v| v.to_str()).unwrap_or("attachment")
        .chars().take(100).map(|c| if c.is_control() || "<>:\"/\\|?*#[]".contains(c) { '_' } else { c }).collect();
    let stem = stem.trim_matches(['.', ' ']);
    let upper = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| upper.strip_prefix(prefix)
            .is_some_and(|suffix| suffix.len() == 1 && "123456789".contains(suffix)));
    let stem = if legacy_hash_attachment_name(leaf) { "attachment".into() } else if stem.is_empty() { "attachment".into() } else if reserved { format!("attachment-{stem}") } else { stem.to_owned() };
    if ordinal == 1 { format!("{stem}.{extension}") } else { format!("{stem} ({ordinal}).{extension}") }
}

pub(super) fn publish_bytes(
    root: &Path,
    inventory: &[String],
    note: &str,
    name: &str,
    bytes: &[u8],
) -> Result<AttachmentPublication, KnowledgeError> {
    publish_bytes_with_reuse(root, inventory, note, name, bytes, true)
}

fn publish_bytes_with_reuse(root: &Path, inventory: &[String], note: &str, name: &str, bytes: &[u8], reuse_content: bool) -> Result<AttachmentPublication, KnowledgeError> {
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(error(
            "knowledge-attachment-size-limit",
            "Attachment exceeds 64 MiB",
        ));
    }
    let digest = sha256_hex(bytes);
    for relative in inventory.iter().filter(|_| reuse_content) {
        if relative.to_ascii_lowercase().ends_with(".md") || legacy_hash_attachment_name(relative) {
            continue;
        }
        let path = safe_existing_file(root, Path::new(relative))?;
        if path
            .metadata()
            .map_err(|_| {
                error(
                    "knowledge-attachment-read-failed",
                    "Attachment metadata is unavailable",
                )
            })?
            .len()
            != bytes.len() as u64
        {
            continue;
        }
        let existing = read_scoped_attachment_bytes(root, Path::new(relative))?;
        if sha256_hex(&existing) == digest && existing == bytes {
            return Ok(publication(note, relative.clone(), bytes, true));
        }
    }
    let directory_relative = Path::new("attachments");
    assert_safe_components(root, directory_relative)?;
    if !root.join(directory_relative).exists() {
        std::fs::create_dir(root.join(directory_relative)).map_err(|_| {
            error(
                "knowledge-attachment-write-failed",
                "Cannot create Vault attachments folder",
            )
        })?;
    }
    let directory = safe_existing_directory(root, directory_relative)?;
    let _parents = guard_existing_ancestors(root, &directory.join("attachment"))?;
    safe_existing_directory(root, directory_relative)?;
    let relative = (1..=100_001).map(|ordinal| format!("attachments/{}", attachment_copy_name(name, ordinal)))
        .find(|candidate| !inventory.iter().any(|old| old.eq_ignore_ascii_case(candidate)) && !root.join(candidate).exists())
        .ok_or_else(|| error("knowledge-attachment-conflict", "No unused attachment name is available"))?;
    let target = root.join(&relative);
    let temp = directory.join(format!(
        ".lrk-attachment-{:032x}.tmp",
        rand::random::<u128>()
    ));
    if let Err(failure) = write_new_synced(&temp, bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(failure);
    }
    let outcome = (|| {
        if read_attachment_bytes(&temp)? != bytes {
            return Err(error(
                "knowledge-attachment-verification-failed",
                "Attachment staging verification failed",
            ));
        }
        safe_existing_directory(root, directory_relative)?;
        move_file_no_replace(&temp, &target)?;
        if read_attachment_bytes(&safe_existing_file(root, Path::new(&relative))?)? != bytes {
            return Err(error(
                "knowledge-attachment-verification-failed",
                "Published attachment verification failed",
            ));
        }
        Ok(publication(note, relative, bytes, false))
    })();
    if temp.exists() {
        let _ = std::fs::remove_file(&temp);
    }
    outcome
}

impl KnowledgeService {
    /// Companion already owns and verifies the staged file. Keep publication in
    /// KnowledgeService's existing attachments directory/name/reuse policy, but
    /// copy and compare in bounded buffers instead of materializing a video.
    pub(crate) fn publish_companion_attachment(&self, expected: &KnowledgeTargetIdentity, document_ref: &KnowledgeDocumentRef,
        expected_revision: &str, name: &str, staged: &Path, size: u64, digest: &str) -> Result<AttachmentPublication, KnowledgeError> {
        if size > MAX_ATTACHMENT_BYTES { return Err(error("knowledge-attachment-size-limit", "Attachment exceeds 64 MiB")); }
        let _inventory_mutation=self.attachment_inventory.mutation();
        let _mutation=self.mutation_lock.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge mutation lock failed"))?;
        let vault=self.current_vault_unlocked()?;
        let root_guard=self.capture_expected_target_unlocked(&vault,Some(expected))?;
        require_matching_vault(document_ref,&vault.registration)?;
        let note=safe_existing_file(&vault.root,&safe_markdown_relative_path(&document_ref.relative_path)?)?;
        let mut note_guard=open_exclusive_document(&note)?;
        if sha256_hex(&read_exclusive_document(&mut note_guard)?) != expected_revision {return Err(error("knowledge-revision-conflict","Note changed before attachment insertion"));}
        let hash_file=|path:&Path|->Result<String,KnowledgeError>{
            let mut input=File::open(path).map_err(|_|error("knowledge-attachment-read-failed","Attachment unavailable"))?;
            if input.metadata().map_err(|_|error("knowledge-attachment-read-failed","Attachment unavailable"))?.len()!=size {return Err(error("knowledge-attachment-verification-failed","Attachment length changed"));}
            let mut hash=Sha256::new();let mut buffer=[0u8;64*1024];
            loop {let count=input.read(&mut buffer).map_err(|_|error("knowledge-attachment-read-failed","Attachment unavailable"))?;if count==0{break;}hash.update(&buffer[..count]);}
            Ok(format!("{:x}",hash.finalize()))
        };
        if hash_file(staged)? != digest {return Err(error("knowledge-attachment-verification-failed","Attachment checksum changed"));}
        let inventory=index::attachment_inventory(&vault.root)?;
        let mut reused=None;
        for relative in &inventory {
            if relative.to_ascii_lowercase().ends_with(".md") || legacy_hash_attachment_name(relative) {continue;}
            let file=safe_existing_file(&vault.root,Path::new(relative))?;
            if file.metadata().map(|m|m.len()==size).unwrap_or(false) && hash_file(&file)? == digest {reused=Some(relative.clone());break;}
        }
        let was_reused=reused.is_some();
        let relative=if let Some(relative)=reused {relative} else {
            let directory_relative=Path::new("attachments");
            assert_safe_components(&vault.root,directory_relative)?;
            if !vault.root.join(directory_relative).exists(){fs::create_dir(vault.root.join(directory_relative)).map_err(|_|error("knowledge-attachment-write-failed","Cannot create attachments folder"))?;}
            let directory=safe_existing_directory(&vault.root,directory_relative)?;
            let _parents=guard_existing_ancestors(&vault.root,&directory.join("attachment"))?;
            let relative=(1..=100_001).map(|ordinal|format!("attachments/{}",attachment_copy_name(name,ordinal)))
                .find(|candidate|!inventory.iter().any(|old|old.eq_ignore_ascii_case(candidate))&&!vault.root.join(candidate).exists())
                .ok_or_else(||error("knowledge-attachment-conflict","No unused attachment name"))?;
            let temporary=directory.join(format!(".lrk-attachment-{:032x}.tmp",rand::random::<u128>()));
            let result=(||{
                let mut input=File::open(staged).map_err(|_|error("knowledge-attachment-read-failed","Staged attachment unavailable"))?;
                let mut output=OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|_|error("knowledge-attachment-write-failed","Cannot stage attachment"))?;
                let copied=std::io::copy(&mut input,&mut output).map_err(|_|error("knowledge-attachment-write-failed","Attachment copy failed"))?;
                output.sync_all().map_err(|_|error("knowledge-attachment-write-failed","Attachment flush failed"))?;drop(output);
                if copied!=size || hash_file(&temporary)?!=digest {return Err(error("knowledge-attachment-verification-failed","Attachment copy mismatch"));}
                self.assert_expected_target_unlocked(&vault,Some(expected),root_guard.as_ref())?;
                move_file_no_replace(&temporary,&vault.root.join(&relative))
            })();
            if temporary.exists(){let _=fs::remove_file(&temporary);}
            result?;relative
        };
        self.assert_expected_target_unlocked(&vault,Some(expected),root_guard.as_ref())?;
        // Reuse the exact existing reference/filename formatting without bytes.
        let mut result=publication(&document_ref.relative_path,relative,&[],was_reused);
        result.sha256=digest.to_owned();result.bytes=size;
        Ok(result)
    }

    pub(crate) fn resolve_vault_attachment(
        &self,
        document_ref: &KnowledgeDocumentRef,
        destination: &str,
        wiki: bool,
    ) -> Result<AttachmentResolution, KnowledgeError> {
        self.resolve_attachment_with_approved_paths(document_ref, destination, wiki, &[])
    }

    pub(crate) fn resolve_attachment_with_approved_paths(&self, document_ref: &KnowledgeDocumentRef, destination: &str, wiki: bool, approved: &[String]) -> Result<AttachmentResolution, KnowledgeError> {
        let (vault, root_guard, identity) = self.capture_current_target()?;
        require_matching_vault(document_ref, &vault.registration)?;
        safe_markdown_relative_path(&document_ref.relative_path)?;
        // One shared, invalidated snapshot per vault replaces a full
        // attachment-tree walk per embed. A cached entry whose file vanished
        // underneath us surfaces as knowledge-not-found from the per-file
        // existence check; that single case rebuilds once and retries so a
        // stale projection can never masquerade as a hard error.
        let (inventory, inventory_hit) = self
            .attachment_inventory
            .get_or_build(&vault, &root_guard, &identity)?;
        let resolve_with_inventory = |files: &Vec<String>| {
            resolve_attachment(
                &vault.root,
                files,
                &document_ref.relative_path,
                destination,
                if wiki {
                    LinkSyntax::Wiki
                } else {
                    LinkSyntax::Markdown
                },
            )
        };
        let mut result = match resolve_with_inventory(&inventory) {
            Ok(result) => result,
            Err(failure) if inventory_hit && failure.code == "knowledge-not-found" => {
                self.attachment_inventory.invalidate();
                let (fresh, _) = self
                    .attachment_inventory
                    .get_or_build(&vault, &root_guard, &identity)?;
                resolve_with_inventory(&fresh)?
            }
            other => other?,
        };
        if result.status != "resolved" && result.status != "ambiguous" {
            if let Some(candidate) = super::external_attachments::external_target_path(&vault.root, &document_ref.relative_path, destination, if wiki {LinkSyntax::Wiki} else {LinkSyntax::Markdown})? {
                {
                    // Check the exact registered location before any file inspection.
                    let key = super::external_attachments::file_path_key;
                    if super::external_attachments::file_is_within(&candidate,&vault.root) || approved.iter().any(|path| key(Path::new(path)) == key(&candidate)) {
                        match super::external_attachments::verified_external_file(&candidate) {
                            Ok(path) => {
                                let metadata = path.metadata().map_err(|_| error("knowledge-attachment-read-failed", "Attachment metadata unavailable"))?;
                                let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time|time.as_nanos()).unwrap_or(0);
                                result.status="resolved".into(); result.absolute_path=Some(path.to_string_lossy().into_owned());
                                result.version=Some(format!("{}-{modified}",metadata.len()));
                            },
                            Err(_) => result.status="external-unavailable".into(),
                        }
                    } else { result.status="external-unregistered".into(); }
                }
            }
        }
        self.verify_current_target(&identity, &root_guard)?;
        if let Some(relative) = result.relative_path.as_deref() {
            // Observations are optional, bounded evidence; failure never changes resolution.
            let _ = self.remember_attachment(&vault, &identity, relative, &inventory);
        }
        Ok(result)
    }

    pub(crate) fn publish_attachment_from_ui(

        &self,
        source_epoch: u64,
        document_ref: &KnowledgeDocumentRef,
        expected_revision: &str,
        name: &str,
        bytes: &[u8],
        source_path: Option<&Path>,
        independent_copy: bool,
    ) -> Result<AttachmentPublication, KnowledgeError> {
        self.publish_attachment_with_policy(source_epoch,document_ref,expected_revision,name,bytes,source_path,independent_copy,false)
    }

    pub(crate) fn publish_attachment_with_policy(&self, source_epoch:u64, document_ref:&KnowledgeDocumentRef, expected_revision:&str, name:&str, bytes:&[u8], source_path:Option<&Path>, independent_copy:bool, reference:bool) -> Result<AttachmentPublication,KnowledgeError> {
        // The write may change the attachment tree; drop the shared snapshot
        // so subsequent resolutions rebuild against post-write reality.
        let _inventory_mutation = self.attachment_inventory.mutation();
        let _source = self.lock_active_ui_source(source_epoch, Some(&document_ref.vault_id))?;
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge mutation lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        let root_guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&vault, root_guard.identity())?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        let target = safe_existing_file(&vault.root, &relative)?;
        let mut note_guard = open_exclusive_document(&target)?;
        if sha256_hex(&read_exclusive_document(&mut note_guard)?) != expected_revision {
            return Err(error(
                "knowledge-revision-conflict",
                "Note changed before attachment insertion",
            ));
        }
        let owned;
        let bytes = if let Some(path) = source_path {
            let canonical = path.canonicalize().map_err(|_| {
                error(
                    "knowledge-attachment-read-failed",
                    "Attachment source is unavailable",
                )
            })?;
            // Reject every source reparse component, not merely its leaf.
            for ancestor in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
                if has_reparse_point(ancestor)? {
                    return Err(error(
                        "knowledge-path-reparse-forbidden",
                        "Attachment source contains a linked path",
                    ));
                }
            }
            owned = read_external_attachment_bytes(&vault.root, &canonical)?;
            if reference && !canonical.starts_with(&vault.root) {
                super::external_attachments::verified_external_file(&canonical)?;
                self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
                return super::external_attachments::external_publication(&vault.root,&document_ref.relative_path,&canonical,&owned,name);
            }
            if reference || (!independent_copy && !legacy_hash_attachment_name(&canonical.to_string_lossy())) {
                if let Ok(relative) = canonical.strip_prefix(&vault.root) {
                    let relative = relative_path_string(relative);
                    let safe = safe_relative_path(&relative, false)?;
                    safe_existing_file(&vault.root, &safe)?;
                    self.assert_expected_target_unlocked(
                        &vault,
                        Some(&identity),
                        Some(&root_guard),
                    )?;
                    return Ok(publication(
                        &document_ref.relative_path,
                        relative,
                        &owned,
                        true,
                    ));
                }
            }
            owned.as_slice()
        } else {
            bytes
        };
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let result = publish_bytes_with_reuse(
            &vault.root,
            &inventory,
            &document_ref.relative_path,
            name,
            bytes,
            source_path.is_none(),
        )?;
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
        Ok(result)
    }
}
