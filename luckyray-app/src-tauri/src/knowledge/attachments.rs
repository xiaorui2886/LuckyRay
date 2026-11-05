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

#[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "macos")]
pub(super) fn hold_verified_attachment(root: &Path, relative: &str, digest: &str) -> Result<AttachmentReadGuard, KnowledgeError> {
    let relative = safe_relative_path(relative, false)?;
    let root = crate::macos_fs::Directory::open(root, false, false).map_err(macos_attachment_read_error)?;
    let observed = super::macos_attachment_io::Observation::read_at(&root, &relative, true)
        .map_err(macos_attachment_read_error)?;
    if observed.revision() != digest {
        return Err(error("knowledge-attachment-changing", "Referenced attachment changed since preview"));
    }
    let (file, parents) = observed.into_guards().map_err(macos_attachment_read_error)?;
    Ok(AttachmentReadGuard { _file: file, _parents: parents })
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
#[cfg(not(target_os = "macos"))]
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

#[cfg(target_os = "macos")]
fn macos_attachment_read_error(failure: std::io::Error) -> KnowledgeError {
    if failure.kind() == std::io::ErrorKind::FileTooLarge {
        error("knowledge-attachment-size-limit", "Attachment exceeds 64 MiB")
    } else {
        error("knowledge-attachment-changing", "Attachment object is unavailable or changed during access")
    }
}

#[cfg(target_os = "macos")]
fn macos_verify_attachment_source(source: &Option<(super::macos_attachment_io::Observation, PathBuf)>) -> Result<(), KnowledgeError> {
    if let Some((observed, canonical)) = source {
        observed.verify_alias(canonical).map_err(macos_attachment_read_error)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) fn read_attachment_bytes(path: &Path) -> Result<Vec<u8>, KnowledgeError> {
    super::macos_attachment_io::Observation::read(path, true)
        .map(|observed| observed.bytes).map_err(macos_attachment_read_error)
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
    #[cfg(target_os="macos")]
    {
        let directory=crate::macos_fs::Directory::open(root,false,false).map_err(macos_attachment_read_error)?;
        let attachment=!relative.to_string_lossy().to_ascii_lowercase().ends_with(".md");
        let observed=super::macos_attachment_io::Observation::read_at(&directory,relative,attachment).map_err(macos_attachment_read_error)?;
        observed.verify().map_err(macos_attachment_read_error)?;return Ok(observed.bytes);
    }
    #[cfg(not(target_os="macos"))]
    {
    let _parents = guard_existing_ancestors(root, &root.join(relative))?;
    let path = safe_existing_file(root, relative)?;
    read_attachment_bytes(&path)
    }
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

#[cfg(target_os = "macos")]
fn publish_bytes_with_reuse(root: &Path, inventory: &[String], note: &str, name: &str, bytes: &[u8], reuse_content: bool) -> Result<AttachmentPublication, KnowledgeError> {
    let directory = crate::macos_fs::Directory::open(root, false, false).map_err(macos_attachment_read_error)?;
    macos_publish_bytes(&directory, inventory, note, name, bytes, reuse_content)
}

#[cfg(target_os = "macos")]
pub(super) fn macos_publish_bytes(root: &crate::macos_fs::Directory, inventory: &[String], note: &str, name: &str, bytes: &[u8], reuse_content: bool) -> Result<AttachmentPublication, KnowledgeError> {
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(error("knowledge-attachment-size-limit", "Attachment exceeds 64 MiB"));
    }
    if reuse_content {
        for relative in inventory {
            if relative.to_ascii_lowercase().ends_with(".md") || legacy_hash_attachment_name(relative) { continue; }
            let relative_path = safe_relative_path(relative, false)?;
            let Some(observed) = super::macos_attachment_io::Observation::read_matching_at(root, &relative_path, bytes.len() as u64)
                .map_err(macos_attachment_read_error)? else { continue; };
            if observed.bytes == bytes {
                observed.verify().map_err(macos_attachment_read_error)?;
                return Ok(publication(note, relative.clone(), bytes, true));
            }
        }
    }
    let names = (1..=100_001).map(|ordinal| attachment_copy_name(name, ordinal))
        .filter(|leaf| !inventory.iter().any(|old| old.eq_ignore_ascii_case(&format!("attachments/{leaf}"))))
        .map(std::ffi::OsString::from);
    let leaf = super::macos_attachment_io::publish(root, names, bytes)
        .map_err(|_| error("knowledge-attachment-conflict", "Attachment could not be published safely; existing files are preserved"))?;
    let leaf = leaf.to_str().ok_or_else(|| error("knowledge-path-invalid", "Attachment name cannot be represented"))?;
    Ok(publication(note, format!("attachments/{leaf}"), bytes, false))
}

#[cfg(not(target_os = "macos"))]
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
        #[cfg(target_os = "macos")]
        let macos_root = root_guard.macos_directory(&vault.root).map_err(map_filesystem_identity_error)?;
        require_matching_vault(document_ref, &vault.registration)?;
        let relative = safe_markdown_relative_path(&document_ref.relative_path)?;
        #[cfg(not(target_os = "macos"))]
        let target = safe_existing_file(&vault.root, &relative)?;
        #[cfg(target_os = "macos")]
        let note_guard = super::macos_attachment_io::Observation::read_at(&macos_root, &relative, false)
            .map_err(|_| error("knowledge-revision-conflict", "Note object is unavailable or changed before attachment insertion"))?;
        #[cfg(not(target_os = "macos"))]
        let mut note_guard = open_exclusive_document(&target)?;
        #[cfg(target_os = "macos")]
        if note_guard.revision() != expected_revision {
            return Err(error("knowledge-revision-conflict", "Note changed before attachment insertion"));
        }
        #[cfg(not(target_os = "macos"))]
        if sha256_hex(&read_exclusive_document(&mut note_guard)?) != expected_revision {
            return Err(error(
                "knowledge-revision-conflict",
                "Note changed before attachment insertion",
            ));
        }
        let owned;
        #[cfg(target_os = "macos")]
        let mut attachment_source = None;
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
            #[cfg(target_os = "macos")]
            {
                // The original no-follow object, not canonicalize's path text,
                // is the content authority. A racing link/rename cannot retarget
                // the read to an unobserved outside object.
                let mut observed = super::macos_attachment_io::Observation::read(path, true)
                    .map_err(macos_attachment_read_error)?;
                observed.verify_alias(&canonical).map_err(macos_attachment_read_error)?;
                if canonical.to_str().is_none() {
                    return Err(error("knowledge-path-invalid", "Attachment path cannot be represented"));
                }
                owned = std::mem::take(&mut observed.bytes);
                attachment_source = Some((observed, canonical.clone()));
            }
            #[cfg(not(target_os = "macos"))]
            { owned = read_external_attachment_bytes(&vault.root, &canonical)?; }
            if reference && !canonical.starts_with(&vault.root) {
                super::external_attachments::verified_external_file(&canonical)?;
                self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
                #[cfg(target_os = "macos")]
                note_guard.verify().map_err(|_| error("knowledge-revision-conflict", "Note changed during attachment insertion"))?;
                #[cfg(target_os = "macos")]
                {
                    let result = super::external_attachments::external_publication(&vault.root,&document_ref.relative_path,&canonical,&owned,name)?;
                    macos_verify_attachment_source(&attachment_source)?;
                    note_guard.verify().map_err(|_| error("knowledge-revision-conflict", "Note changed during attachment insertion"))?;
                    return Ok(result);
                }
                #[cfg(not(target_os = "macos"))]
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
                    #[cfg(target_os = "macos")]
                    macos_verify_attachment_source(&attachment_source)?;
                    #[cfg(target_os = "macos")]
                    note_guard.verify().map_err(|_| error("knowledge-revision-conflict", "Note changed during attachment insertion"))?;
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
        #[cfg(target_os = "macos")]
        note_guard.verify().map_err(|_| error("knowledge-revision-conflict", "Note changed during attachment insertion"))?;
        let inventory = index::attachment_inventory(&vault.root)?;
        #[cfg(target_os = "macos")]
        let result = macos_publish_bytes(&macos_root, &inventory, &document_ref.relative_path,
            name, bytes, source_path.is_none())?;
        #[cfg(not(target_os = "macos"))]
        let result = publish_bytes_with_reuse(
            &vault.root,
            &inventory,
            &document_ref.relative_path,
            name,
            bytes,
            source_path.is_none(),
        )?;
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&root_guard))?;
        #[cfg(target_os = "macos")]
        macos_verify_attachment_source(&attachment_source)?;
        #[cfg(target_os = "macos")]
        note_guard.verify().map_err(|_| error("knowledge-revision-conflict", "Note changed during attachment insertion; attachment copy is preserved"))?;
        Ok(result)
    }
}

/// Journaled Companion publication for macOS. A successful publication is
/// recoverable by its bound directory, staging name, target name and object
/// identity; no temporary or existing object is removed on conflict.
#[cfg(target_os = "macos")]
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MacosCompanionAttachmentPlan {
    directory: String,
    stage: String,
    target: String,
    object: Option<String>,
}

#[cfg(target_os = "macos")]
fn macos_companion_object(metadata: &std::fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    format!("{:x}:{:x}", metadata.dev(), metadata.ino())
}

#[cfg(target_os = "macos")]
fn macos_companion_plan_invalid() -> KnowledgeError {
    error("knowledge-attachment-conflict", "Attachment publication is uncertain; existing files are preserved")
}

#[cfg(target_os = "macos")]
fn macos_companion_stage_name(name: &str) -> bool {
    name.strip_prefix(".lrk-companion-").and_then(|s| s.strip_suffix(".pending"))
        .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
}

#[cfg(target_os = "macos")]
fn macos_companion_observe(
    directory: &crate::macos_fs::Directory, name: &str, object: &str,
    size: u64, digest: &str,
) -> Result<Option<std::fs::File>, KnowledgeError> {
    use std::os::unix::fs::MetadataExt;
    let Some((bytes, version)) = directory.read_attachment(std::ffi::OsStr::new(name))
        .map_err(|_| macos_companion_plan_invalid())? else { return Ok(None) };
    if bytes.len() as u64 != size || version.hash != digest
        || format!("{:x}:{:x}", version.device, version.inode) != object {
        return Err(macos_companion_plan_invalid());
    }
    let file = directory.open_regular(std::ffi::OsStr::new(name)).map_err(|_| macos_companion_plan_invalid())?;
    let metadata = file.metadata().map_err(|_| macos_companion_plan_invalid())?;
    if metadata.nlink() != 1 || macos_companion_object(&metadata) != object || !version.matches_metadata(&metadata) {
        return Err(macos_companion_plan_invalid());
    }
    Ok(Some(file))
}

#[cfg(target_os = "macos")]
impl KnowledgeService {
    pub(crate) fn publish_macos_companion_attachment(
        &self, expected: &KnowledgeTargetIdentity, document_ref: &KnowledgeDocumentRef,
        expected_revision: &str, name: &str, bytes: &[u8], digest: &str,
        previous: Option<&str>, mut journal: impl FnMut(Option<&str>, &str) -> Result<(), KnowledgeError>,
    ) -> Result<AttachmentPublication, KnowledgeError> {
        use std::os::unix::fs::MetadataExt;
        if bytes.is_empty() || bytes.len() as u64 > MAX_ATTACHMENT_BYTES || sha256_hex(bytes) != digest {
            return Err(error("knowledge-attachment-verification-failed", "Attachment checksum changed"));
        }
        let _inventory_mutation=self.attachment_inventory.mutation();
        let _mutation=self.mutation_lock.lock().map_err(|_|error("knowledge-lock-poisoned","Knowledge mutation lock failed"))?;
        let vault=self.current_vault_unlocked()?;
        let root_guard=self.capture_expected_target_unlocked(&vault,Some(expected))?;
        require_matching_vault(document_ref,&vault.registration)?;
        let root=root_guard.as_ref().ok_or_else(knowledge_target_not_current)?
            .macos_directory(&vault.root).map_err(map_filesystem_identity_error)?;
        let relative=safe_markdown_relative_path(&document_ref.relative_path)?;
        let note=super::macos_attachment_io::Observation::read_at(&root,&relative,false)
            .map_err(|_|error("knowledge-revision-conflict","Note changed before attachment insertion"))?;
        if note.revision()!=expected_revision {return Err(error("knowledge-revision-conflict","Note changed before attachment insertion"));}
        self.assert_expected_target_unlocked(&vault,Some(expected),root_guard.as_ref())?;
        let inventory=index::attachment_inventory(&vault.root)?;
        // Companion completion may be retried after a lost receipt. Reusing an
        // unjournaled equal-content object here would leave no identity-bound
        // publication plan, so Companion always journals its own object.
        let directory=root.child(std::ffi::OsStr::new("attachments"),true).map_err(|_|macos_companion_plan_invalid())?;
        let dir_meta=directory.identity_file().and_then(|f|f.metadata()).map_err(|_|macos_companion_plan_invalid())?;
        let directory_object=macos_companion_object(&dir_meta);
        let mut prior_text=previous.map(str::to_owned);
        let mut plan=if let Some(prior)=previous {
            serde_json::from_str::<MacosCompanionAttachmentPlan>(prior).map_err(|_|macos_companion_plan_invalid())?
        } else {
            let target=(1..=100_001).map(|n|attachment_copy_name(name,n))
                .find(|leaf|!inventory.iter().any(|old|old.eq_ignore_ascii_case(&format!("attachments/{leaf}"))))
                .ok_or_else(macos_companion_plan_invalid)?;
            let p=MacosCompanionAttachmentPlan{directory:directory_object.clone(),stage:format!(".lrk-companion-{:032x}.pending",rand::random::<u128>()),target,object:None};
            let serialized=serde_json::to_string(&p).map_err(|_|macos_companion_plan_invalid())?;
            journal(None,&serialized)?;prior_text=Some(serialized);p
        };
        if plan.directory!=directory_object || !macos_companion_stage_name(&plan.stage)
            || plan.target.is_empty() || plan.target.contains(['/', '\\', '\0'])
            || plan.target == "." || plan.target == ".." || plan.target.starts_with(".lrk-companion-") {
            return Err(macos_companion_plan_invalid());
        }
        if plan.object.is_none() {
            // An existing unbound stage is never adopted. Rotate its name in
            // the durable plan, leaving the unknown object untouched.
            let mut attempts=0;
            let file=loop {
                match directory.create_attachment(std::ffi::OsStr::new(&plan.stage),bytes) {
                    Ok(file)=>break file,
                    Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists && attempts<16=>{
                        attempts+=1;plan.stage=format!(".lrk-companion-{:032x}.pending",rand::random::<u128>());
                        let next=serde_json::to_string(&plan).map_err(|_|macos_companion_plan_invalid())?;
                        journal(prior_text.as_deref(),&next)?;prior_text=Some(next);
                    },
                    Err(_)=>return Err(macos_companion_plan_invalid()),
                }
            };
            crate::macos_fs::require_empty_acl(&file).map_err(|_|macos_companion_plan_invalid())?;
            let metadata=file.metadata().map_err(|_|macos_companion_plan_invalid())?;
            if !metadata.is_file() || metadata.nlink()!=1 || metadata.uid()!=unsafe{libc::geteuid()} || metadata.mode()&0o7777!=0o600 {return Err(macos_companion_plan_invalid());}
            let object=macos_companion_object(&metadata);
            let observed=macos_companion_observe(&directory,&plan.stage,&object,bytes.len() as u64,digest)?.ok_or_else(macos_companion_plan_invalid)?;
            if macos_companion_object(&observed.metadata().map_err(|_|macos_companion_plan_invalid())?)!=object {return Err(macos_companion_plan_invalid());}
            plan.object=Some(object);
            let next=serde_json::to_string(&plan).map_err(|_|macos_companion_plan_invalid())?;
            journal(prior_text.as_deref(),&next)?;prior_text=Some(next);
        }
        let object=plan.object.clone().ok_or_else(macos_companion_plan_invalid)?;
        if let Some(held)=macos_companion_observe(&directory,&plan.stage,&object,bytes.len() as u64,digest)? {
            let mut ordinal=(1..=100_001).find(|n|attachment_copy_name(name,*n)==plan.target).ok_or_else(macos_companion_plan_invalid)?;
            loop {
                note.verify().map_err(|_|error("knowledge-revision-conflict","Note changed during attachment insertion"))?;
                self.assert_expected_target_unlocked(&vault,Some(expected),root_guard.as_ref())?;
                let moved=directory.rename_exclusive_checked(std::ffi::OsStr::new(&plan.stage),std::ffi::OsStr::new(&plan.target))
                    .map_err(|_|macos_companion_plan_invalid())?;
                if moved {break;}
                // Only an EEXIST returned by the rename syscall itself means
                // that no publication occurred. Recheck the retained stage
                // before recording a new target and trying the next suffix.
                macos_companion_observe(&directory,&plan.stage,&object,bytes.len() as u64,digest)?.ok_or_else(macos_companion_plan_invalid)?;
                if macos_companion_object(&held.metadata().map_err(|_|macos_companion_plan_invalid())?)!=object {return Err(macos_companion_plan_invalid());}
                ordinal+=1;
                let (next_ordinal,next_target)=(ordinal..=100_001).map(|n|(n,attachment_copy_name(name,n)))
                    .find(|(_,leaf)|!inventory.iter().any(|old|old.eq_ignore_ascii_case(&format!("attachments/{leaf}"))))
                    .ok_or_else(macos_companion_plan_invalid)?;
                ordinal=next_ordinal;plan.target=next_target;
                let next=serde_json::to_string(&plan).map_err(|_|macos_companion_plan_invalid())?;
                journal(prior_text.as_deref(),&next)?;prior_text=Some(next);
            }
            let published=macos_companion_observe(&directory,&plan.target,&object,bytes.len() as u64,digest)?.ok_or_else(macos_companion_plan_invalid)?;
            if macos_companion_object(&held.metadata().map_err(|_|macos_companion_plan_invalid())?)!=object
                || macos_companion_object(&published.metadata().map_err(|_|macos_companion_plan_invalid())?)!=object {return Err(macos_companion_plan_invalid());}
        } else {
            // A crash after rename and before receipt may only resume the exact
            // recorded object at the recorded target, never equal bytes alone.
            macos_companion_observe(&directory,&plan.target,&object,bytes.len() as u64,digest)?.ok_or_else(macos_companion_plan_invalid)?;
        }
        directory.current().map_err(|_|macos_companion_plan_invalid())?;
        note.verify().map_err(|_|error("knowledge-revision-conflict","Note changed during attachment insertion"))?;
        self.assert_expected_target_unlocked(&vault,Some(expected),root_guard.as_ref())?;
        Ok(publication(&document_ref.relative_path,format!("attachments/{}",plan.target),bytes,false))
    }
}
