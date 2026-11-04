//! Read-only attachment inventory and bounded export of an independent Vault.
//! Export writes only to a user-selected empty destination. It never rewrites the source.
use super::attachments::{
    attachment_copy_name, guard_existing_ancestors, read_external_attachment_bytes,
    read_scoped_attachment_bytes, resolve_attachment,
};
use super::external_attachments::{external_target_path, verified_external_file};
use super::markdown_links::{
    attachment_links, markdown_relative_target, patch_destinations, AttachmentLink, LinkSyntax,
};
use super::*;
use std::collections::{HashMap, HashSet};

const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;
const MAX_EXPORT_FILES: usize = 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentAuditEntry {
    pub document: String,
    pub target: String,
    pub line: usize,
    /// vault / external / legacy-material / unresolved / remote
    pub scope: String,
    pub status: String,
    pub absolute_path: Option<String>,
    pub candidates: Vec<String>,
    pub bytes: u64,
    pub migration_available: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentAudit {
    pub vault_id: String,
    pub document_count: usize,
    pub entries: Vec<AttachmentAuditEntry>,
    pub migration_file_count: usize,
    pub migration_copy_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentExportIssue {
    pub document: String,
    pub target: String,
    pub status: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentExportResult {
    pub vault_id: String,
    pub destination: String,
    pub status: String,
    pub document_count: usize,
    pub attachment_count: usize,
    pub written_bytes: u64,
    pub issues: Vec<AttachmentExportIssue>,
}

fn is_attachment(link: &AttachmentLink) -> bool {
    let target = link
        .destination
        .split('#')
        .next()
        .unwrap_or(&link.destination);
    let extension = Path::new(target)
        .extension()
        .and_then(OsStr::to_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension == "md" {
        return false;
    }
    link.embedded || link.syntax == LinkSyntax::Markdown || !extension.is_empty()
}

fn resolve_for_portability(
    root: &Path,
    inventory: &[String],
    note: &str,
    link: &AttachmentLink,
    approved: &[(String, Vec<String>)],
) -> Result<AttachmentAuditEntry, KnowledgeError> {
    let mut entry = AttachmentAuditEntry {
        document: note.into(),
        target: link.destination.clone(),
        line: link.line,
        scope: "unresolved".into(),
        status: "missing".into(),
        absolute_path: None,
        candidates: Vec::new(),
        bytes: 0,
        migration_available: false,
    };
    let local = resolve_attachment(root, inventory, note, &link.destination, link.syntax)?;
    let external = external_target_path(root, note, &link.destination, link.syntax)?
        .filter(|path| !path.starts_with(root) || local.status == "remote-or-absolute");
    if local.status != "resolved" && external.is_some() {
        let path = external.expect("external path checked");
        entry.scope = "external".into();
        let path = match verified_external_file(&path) {
            Ok(path) => path,
            Err(problem) => {
                entry.status = problem.code.into();
                return Ok(entry);
            }
        };
        let inside = path.starts_with(root);
        let allowed = inside
            || approved
                .iter()
                .filter(|(document, _)| document == note)
                .flat_map(|(_, paths)| paths)
                .any(|allowed| {
                    verified_external_file(Path::new(allowed)).is_ok_and(|allowed| allowed == path)
                });
        if !allowed {
            entry.status = "external-attachment-not-approved".into();
            return Ok(entry);
        }
        entry.absolute_path = Some(path.to_string_lossy().into_owned());
        entry.status = "resolved".into();
        entry.scope = if inside { "vault" } else { "external" }.into();
        entry.migration_available = !inside && link.destination_span.is_some();
    } else {
        entry.status = local.status;
        entry.candidates = local.candidates;
        entry.absolute_path = local.absolute_path;
        if entry.status == "resolved" {
            entry.scope = "vault".into();
        } else if entry.status == "remote-or-absolute" {
            entry.scope = "remote".into();
        }
    }
    if let Some(path) = entry.absolute_path.as_deref() {
        match read_external_attachment_bytes(root, Path::new(path)) {
            Ok(bytes) => entry.bytes = bytes.len() as u64,
            Err(problem) => {
                entry.status = problem.code.into();
                entry.migration_available = false;
            }
        }
    }
    Ok(entry)
}

impl KnowledgeService {
    /// A disk-derived report, with no index mutation, receipt, copy, or note rewrite.
    /// Empty document_refs means all current Vault notes. Catalog candidates are only
    /// reported as migration opportunities; they never silently repair a reference.
    pub(crate) fn audit_attachment_portability(
        &self,
        document_refs: &[KnowledgeDocumentRef],
        approved: &[(String, Vec<String>)],
        materials: &[(String, String, Option<PathBuf>)],
    ) -> Result<AttachmentAudit, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let notes = portability_notes(&vault, &inventory, document_refs)?;
        let mut result = AttachmentAudit {
            vault_id: vault.registration.id.clone(),
            document_count: notes.len(),
            entries: Vec::new(),
            migration_file_count: 0,
            migration_copy_bytes: 0,
        };
        let mut migration_paths = HashSet::new();
        for note in notes {
            let original = read_scoped_attachment_bytes(&vault.root, Path::new(&note))?;
            let decoded = decode_document(&original)?;
            for link in attachment_links(&decoded.content)
                .into_iter()
                .filter(is_attachment)
            {
                let mut entry = match resolve_for_portability(
                    &vault.root,
                    &inventory,
                    &note,
                    &link,
                    approved,
                ) {
                    Ok(entry) => entry,
                    Err(problem) => AttachmentAuditEntry {
                        document: note.clone(),
                        target: link.destination.clone(),
                        line: link.line,
                        scope: "unresolved".into(),
                        status: problem.code.into(),
                        absolute_path: None,
                        candidates: vec![],
                        bytes: 0,
                        migration_available: false,
                    },
                };
                if entry.status == "missing" {
                    let target = link
                        .destination
                        .split('#')
                        .next()
                        .unwrap_or(&link.destination);
                    let exact: Vec<_> =
                        materials.iter().filter(|(id, _, _)| id == target).collect();
                    let candidates = if exact.is_empty() {
                        materials
                            .iter()
                            .filter(|(_, name, _)| name == target)
                            .collect()
                    } else {
                        exact
                    };
                    if candidates.len() > 1 {
                        entry.status = "ambiguous".into();
                        entry.candidates = candidates.iter().map(|(id, _, _)| id.clone()).collect();
                    } else if let Some((_, _, Some(path))) = candidates.first() {
                        match verified_external_file(path).and_then(|path| {
                            read_external_attachment_bytes(&vault.root, &path)
                                .map(|bytes| (path, bytes.len()))
                        }) {
                            Ok((path, size)) => {
                                entry.scope = "legacy-material".into();
                                entry.status = "material-resolvable".into();
                                entry.absolute_path = Some(path.to_string_lossy().into_owned());
                                entry.bytes = size as u64;
                                entry.migration_available = link.destination_span.is_some();
                            }
                            Err(problem) => entry.status = problem.code.into(),
                        }
                    }
                }
                if entry.migration_available
                    && entry
                        .absolute_path
                        .as_ref()
                        .is_some_and(|path| migration_paths.insert(path.clone()))
                {
                    result.migration_file_count += 1;
                    result.migration_copy_bytes += entry.bytes;
                }
                result.entries.push(entry);
            }
            if sha256_hex(&read_scoped_attachment_bytes(
                &vault.root,
                Path::new(&note),
            )?) != sha256_hex(&original)
            {
                return Err(error(
                    "knowledge-revision-conflict",
                    "Note changed during attachment audit; retry the report",
                ));
            }
        }
        self.verify_current_target(&identity, &guard)?;
        Ok(result)
    }

    /// Build a bounded snapshot before touching the destination. Preserve incomplete
    /// references verbatim and return a partial report; never claim they are portable.
    pub(crate) fn export_independent_vault(
        &self,
        source_epoch: u64,
        destination: &Path,
        approved: &[(String, Vec<String>)],
    ) -> Result<AttachmentExportResult, KnowledgeError> {
        self.export_portable_notes(source_epoch, destination, approved, &[], false)
    }

    pub(crate) fn export_note_archive(
        &self, source_epoch: u64, destination: &Path,
        approved: &[(String, Vec<String>)], document: &KnowledgeDocumentRef,
    ) -> Result<AttachmentExportResult, KnowledgeError> {
        self.export_portable_notes(source_epoch, destination, approved, &[document.clone()], true)
    }

    fn export_portable_notes(
        &self, source_epoch: u64, destination: &Path,
        approved: &[(String, Vec<String>)], documents: &[KnowledgeDocumentRef], archive: bool,
    ) -> Result<AttachmentExportResult, KnowledgeError> {
        let vault_id = self.current_vault_id()?;
        let _source = self.lock_active_ui_source(source_epoch, Some(&vault_id))?;
        let (vault, source_guard, identity) = self.capture_current_target()?;
        let inventory = index::attachment_inventory(&vault.root)?;
        let notes = portability_notes(&vault, &inventory, documents)?;
        let mut result = AttachmentExportResult {
            vault_id: vault.registration.id.clone(),
            destination: destination.to_string_lossy().into_owned(),
            status: "complete".into(),
            document_count: 0,
            attachment_count: 0,
            written_bytes: 0,
            issues: vec![],
        };
        let mut sources: Vec<(String, Vec<u8>)> = Vec::new();
        let mut files: Vec<(String, Vec<u8>, bool)> = Vec::new();
        let mut copies = HashMap::<PathBuf, String>::new();
        let mut occupied = HashSet::new();
        for note in &notes {
            for component in Path::new(note)
                .ancestors()
                .filter(|path| !path.as_os_str().is_empty())
            {
                occupied.insert(relative_path_string(component).to_lowercase());
            }
        }
        let mut total_bytes = 0usize;
        for note in notes {
            let original = read_scoped_attachment_bytes(&vault.root, Path::new(&note))?;
            let decoded = decode_document(&original)?;
            let mut patches = Vec::new();
            for link in attachment_links(&decoded.content)
                .into_iter()
                .filter(is_attachment)
            {
                let entry = match resolve_for_portability(
                    &vault.root,
                    &inventory,
                    &note,
                    &link,
                    approved,
                ) {
                    Ok(entry) => entry,
                    Err(problem) => {
                        export_issue(&mut result, &note, &link.destination, &problem.code);
                        continue;
                    }
                };
                if matches!(
                    entry.status.as_str(),
                    "remote-or-absolute" | "self-reference"
                ) {
                    continue;
                }
                if entry.status != "resolved" {
                    export_issue(&mut result, &note, &link.destination, &entry.status);
                    continue;
                }
                let Some(span) = link.destination_span.clone() else {
                    export_issue(
                        &mut result,
                        &note,
                        &link.destination,
                        "unsupported-reference-style-rewrite",
                    );
                    continue;
                };
                let path = PathBuf::from(entry.absolute_path.expect("resolved path"));
                let relative = if let Some(existing) = copies.get(&path) {
                    existing.clone()
                } else {
                    let bytes = match read_external_attachment_bytes(&vault.root, &path) {
                        Ok(bytes) => bytes,
                        Err(problem) => {
                            export_issue(&mut result, &note, &link.destination, &problem.code);
                            continue;
                        }
                    };
                    let name = path
                        .file_name()
                        .and_then(OsStr::to_str)
                        .unwrap_or("attachment.bin");
                    let target = (1..=100_001)
                        .map(|ordinal| {
                            format!("attachments/{}", attachment_copy_name(name, ordinal))
                        })
                        .find(|target| !occupied.contains(&target.to_lowercase()))
                        .ok_or_else(|| {
                            error(
                                "knowledge-export-conflict",
                                "No unused export attachment name",
                            )
                        })?;
                    occupied.insert(target.to_lowercase());
                    total_bytes += bytes.len();
                    check_export_capacity(total_bytes, files.len() + 1)?;
                    files.push((target.clone(), bytes, false));
                    copies.insert(path, target.clone());
                    target
                };
                let fragment = link
                    .destination
                    .find('#')
                    .map(|start| &link.destination[start..])
                    .unwrap_or("");
                let target = match link.syntax {
                    LinkSyntax::Wiki => format!("{relative}{fragment}"),
                    LinkSyntax::Markdown => {
                        format!("{}{fragment}", markdown_relative_target(&note, &relative))
                    }
                };
                patches.push((span, target));
            }
            let rewritten = patch_destinations(&decoded.content, &patches)
                .map_err(|message| error("knowledge-link-patch-invalid", message))?;
            let bytes = encode_document(&decoded, &rewritten);
            total_bytes += bytes.len();
            check_export_capacity(total_bytes, files.len() + 1)?;
            sources.push((note.clone(), original));
            files.push((note, bytes, true));
        }
        // Retain source note handles across destination writes. This also prevents a
        // concurrent Windows editor from replacing a note after the revision check.
        let mut note_guards = Vec::new();
        for (note, original) in &sources {
            note_guards.push(super::attachments::hold_verified_attachment(
                &vault.root,
                note,
                &sha256_hex(original),
            )?);
        }
        self.verify_current_target(&identity, &source_guard)?;
        if archive {
            return write_note_archive(&vault.root, destination, files, result);
        }
        let (destination, _ancestors, destination_guard) =
            prepare_export_destination(&vault.root, destination)?;
        result.destination = destination.to_string_lossy().into_owned();
        // Attachments precede all notes, so a successfully written note never points
        // at an attachment scheduled after it when a later disk write fails.
        files.sort_by_key(|(_, _, note)| *note);
        for (relative, bytes, is_note) in files {
            let write: Result<(), KnowledgeError> = (|| {
                destination_guard
                    .verify_current_path(&destination)
                    .map_err(map_filesystem_identity_error)?;
                let relative_path = safe_relative_path(&relative, false)?;
                let _parents = create_export_parents(&destination, &relative_path)?;
                write_new_synced(&destination.join(&relative_path), &bytes)?;
                if read_scoped_attachment_bytes(&destination, &relative_path)? != bytes {
                    return Err(error(
                        "knowledge-export-verification-failed",
                        "Exported file failed byte verification",
                    ));
                }
                Ok(())
            })();
            if let Err(problem) = write {
                export_issue(&mut result, &relative, &relative, &problem.code);
                break; // Leave successful files for review; never remove user-visible output.
            }
            if is_note {
                result.document_count += 1;
            } else {
                result.attachment_count += 1;
            }
            result.written_bytes += bytes.len() as u64;
        }
        Ok(result)
    }
}

fn portability_notes(
    vault: &TrustedVault,
    inventory: &[String],
    refs: &[KnowledgeDocumentRef],
) -> Result<Vec<String>, KnowledgeError> {
    let mut notes = if refs.is_empty() {
        inventory
            .iter()
            .filter(|path| path.to_ascii_lowercase().ends_with(".md"))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        refs.iter()
            .map(|reference| {
                require_matching_vault(reference, &vault.registration)?;
                safe_markdown_relative_path(&reference.relative_path)
                    .map(|path| relative_path_string(&path))
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    notes.sort();
    notes.dedup();
    Ok(notes)
}

fn export_issue(result: &mut AttachmentExportResult, document: &str, target: &str, status: &str) {
    result.status = "partial".into();
    result.issues.push(AttachmentExportIssue {
        document: document.into(),
        target: target.into(),
        status: status.into(),
    });
}

fn check_export_capacity(bytes: usize, files: usize) -> Result<(), KnowledgeError> {
    if bytes > MAX_EXPORT_BYTES || files > MAX_EXPORT_FILES {
        return Err(error(
            "knowledge-export-capacity",
            "Export exceeds 128 MiB or 1024 files; export a smaller knowledge base",
        ));
    }
    Ok(())
}

fn prepare_export_destination(
    source: &Path,
    destination: &Path,
) -> Result<(PathBuf, Vec<File>, FilesystemDirectoryIdentityGuard), KnowledgeError> {
    if !destination.is_absolute() {
        return Err(error(
            "knowledge-export-invalid-destination",
            "Choose an absolute export folder",
        ));
    }
    let anchor = destination.ancestors().last().ok_or_else(|| {
        error(
            "knowledge-export-invalid-destination",
            "Export folder has no root",
        )
    })?;
    let ancestors = guard_existing_ancestors(anchor, destination)?;
    let parent = destination
        .parent()
        .ok_or_else(|| {
            error(
                "knowledge-export-invalid-destination",
                "Cannot export into a drive root",
            )
        })?
        .canonicalize()
        .map_err(|_| {
            error(
                "knowledge-export-invalid-destination",
                "Export parent folder is unavailable",
            )
        })?;
    let name = destination.file_name().ok_or_else(|| {
        error(
            "knowledge-export-invalid-destination",
            "Export folder name is unavailable",
        )
    })?;
    let target = parent.join(name);
    if target.starts_with(source) || source.starts_with(&target) {
        return Err(error(
            "knowledge-export-source-overlap",
            "Export folder must be separate from the source knowledge base",
        ));
    }
    if !target.exists() {
        std::fs::create_dir(&target).map_err(|_| {
            error(
                "knowledge-export-write-failed",
                "Cannot create export folder",
            )
        })?;
    }
    let guard =
        filesystem_directory_identity_guard(&target).map_err(map_filesystem_identity_error)?;
    let target = target.canonicalize().map_err(|_| {
        error(
            "knowledge-export-invalid-destination",
            "Export folder is unavailable",
        )
    })?;
    let mut contents = std::fs::read_dir(&target).map_err(|_| {
        error(
            "knowledge-export-invalid-destination",
            "Cannot inspect export folder",
        )
    })?;
    if contents.next().is_some() {
        return Err(error(
            "knowledge-export-destination-not-empty",
            "Choose an empty folder; existing files will not be overwritten",
        ));
    }
    guard
        .verify_current_path(&target)
        .map_err(map_filesystem_identity_error)?;
    Ok((target, ancestors, guard))
}

fn create_export_parents(root: &Path, relative: &Path) -> Result<Vec<File>, KnowledgeError> {
    let mut held = Vec::new();
    let mut current = PathBuf::new();
    for component in relative.parent().unwrap_or(Path::new("")).components() {
        current.push(component);
        assert_safe_components(root, &current)?;
        if !root.join(&current).exists() {
            std::fs::create_dir(root.join(&current)).map_err(|_| {
                error(
                    "knowledge-export-write-failed",
                    "Cannot create export subfolder",
                )
            })?;
        }
        safe_existing_directory(root, &current)?;
        held.extend(guard_existing_ancestors(
            root,
            &root.join(&current).join("file"),
        )?);
    }
    Ok(held)
}

/// Archive paths come from safe Markdown paths and generated attachment names.
/// Never overwrite an existing file, traverse symlinks, or write inside the source Vault.
fn write_note_archive(
    source: &Path, destination: &Path, files: Vec<(String, Vec<u8>, bool)>,
    mut result: AttachmentExportResult,
) -> Result<AttachmentExportResult, KnowledgeError> {
    if !destination.is_absolute() || destination.extension().and_then(OsStr::to_str).map(|x| !x.eq_ignore_ascii_case("zip")).unwrap_or(true) {
        return Err(error("knowledge-export-invalid-destination", "Choose an absolute ZIP filename"));
    }
    let parent = destination.parent().ok_or_else(|| error("knowledge-export-invalid-destination", "Missing export directory"))?;
    let anchor = parent.ancestors().last().ok_or_else(|| error("knowledge-export-invalid-destination", "Missing export root"))?;
    let _ancestors = guard_existing_ancestors(anchor, parent)?;
    let guard = filesystem_directory_identity_guard(parent).map_err(map_filesystem_identity_error)?;
    let parent = parent.canonicalize().map_err(|_| error("knowledge-export-invalid-destination", "Export directory is unavailable"))?;
    let target = parent.join(destination.file_name().ok_or_else(|| error("knowledge-export-invalid-destination", "Missing export filename"))?);
    if target.starts_with(source) { return Err(error("knowledge-export-source-overlap", "Save the ZIP outside the source knowledge base")); }
    guard.verify_current_path(&parent).map_err(map_filesystem_identity_error)?;
    let output = OpenOptions::new().write(true).create_new(true).open(&target)
        .map_err(|_| error("knowledge-export-write-failed", "Choose a new ZIP filename; existing files are never overwritten"))?;
    let mut archive = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (relative, bytes, is_note) in files {
        let safe = safe_relative_path(&relative, false)?;
        archive.start_file(relative_path_string(&safe), options)
            .map_err(|_| error("knowledge-export-write-failed", "Cannot write ZIP entry"))?;
        archive.write_all(&bytes).map_err(|_| error("knowledge-export-write-failed", "Cannot write ZIP contents"))?;
        result.written_bytes += bytes.len() as u64;
        if is_note { result.document_count += 1; } else { result.attachment_count += 1; }
    }
    // A receipt travels with partial exports, so missing references are never silently hidden.
    let receipt = serde_json::to_vec_pretty(&result).map_err(|_| error("knowledge-export-write-failed", "Cannot encode export receipt"))?;
    archive.start_file("LuckyRay-export-receipt.json", options).map_err(|_| error("knowledge-export-write-failed", "Cannot write receipt"))?;
    archive.write_all(&receipt).map_err(|_| error("knowledge-export-write-failed", "Cannot write receipt"))?;
    let output = archive.finish().map_err(|_| error("knowledge-export-write-failed", "Cannot finish ZIP"))?;
    output.sync_all().map_err(|_| error("knowledge-export-write-failed", "Cannot flush ZIP"))?;
    guard.verify_current_path(&parent).map_err(map_filesystem_identity_error)?;
    result.destination = target.to_string_lossy().into_owned();
    Ok(result)
}
