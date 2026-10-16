//! Explicit local file targets; Markdown remains sufficient without the Catalog.
use super::markdown_links::{decode_uri_path, LinkSyntax};
use super::*;

pub(crate) fn attachment_target_rewrites(before: &str, after: &str) -> Vec<(String, String)> {
    let old = super::markdown_links::attachment_links(before);
    let new = super::markdown_links::attachment_links(after);
    if old.len() != new.len() {
        return Vec::new();
    }
    old.into_iter()
        .zip(new)
        .map(|(old, new)| (old.destination, new.destination))
        .collect()
}

fn normalized_path(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::CurDir => (),
            std::path::Component::ParentDir => {
                result.pop();
            }
            _ => result.push(part.as_os_str()),
        }
    }
    result
}

pub(super) fn file_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        return value.strip_prefix("//?/").unwrap_or(&value).to_lowercase();
    }
    #[cfg(not(windows))]
    value
}

pub(super) fn file_is_within(path: &Path, root: &Path) -> bool {
    Path::new(&file_path_key(path)).starts_with(Path::new(&file_path_key(root)))
}

impl KnowledgeService {
    pub(crate) fn document_attachment_paths(
        &self,
        document_ref: &KnowledgeDocumentRef,
        approved: &[String],
    ) -> Result<Vec<(String, String)>, KnowledgeError> {
        self.with_attachment_index_snapshot(document_ref, approved, |_, paths| Ok(paths))
    }
    pub(crate) fn with_attachment_index_snapshot<T>(
        &self,
        document_ref: &KnowledgeDocumentRef,
        approved: &[String],
        apply: impl FnOnce(Vec<String>, Vec<(String, String)>) -> Result<T, String>,
    ) -> Result<T, KnowledgeError> {
        let _mutation = self
            .mutation_lock
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Knowledge mutation lock failed"))?;
        let vault = self.current_vault_unlocked()?;
        require_matching_vault(document_ref, &vault.registration)?;
        let guard = filesystem_directory_identity_guard(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        let identity = knowledge_target_identity(&vault, guard.identity())?;
        let path = safe_existing_file(
            &vault.root,
            &safe_markdown_relative_path(&document_ref.relative_path)?,
        )?;
        let _parents = super::attachments::guard_existing_ancestors(&vault.root, &path)?;
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1);
        }
        let mut file = options.open(&path).map_err(|_| {
            error(
                "knowledge-attachment-index-pending",
                "Note is being edited; attachment indexing will retry",
            )
        })?;
        let mut bytes = Vec::new();
        std::io::Read::by_ref(&mut file)
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("knowledge-read-failed", "Cannot read note"))?;
        let content = decode_document(&bytes)?.content;
        let targets = super::markdown_links::attachment_links(&content)
            .into_iter()
            .map(|link| link.destination)
            .collect();
        let inventory = index::attachment_inventory(&vault.root)?;
        let mut paths = Vec::new();
        for link in super::markdown_links::attachment_links(&content) {
            let resolved = super::attachments::resolve_attachment(
                &vault.root,
                &inventory,
                &document_ref.relative_path,
                &link.destination,
                link.syntax,
            )?;
            let path = if let Some(path) = resolved.absolute_path {
                Some(PathBuf::from(path))
            } else if resolved.status != "ambiguous" {
                external_target_path(
                    &vault.root,
                    &document_ref.relative_path,
                    &link.destination,
                    link.syntax,
                )?
            } else {
                None
            };
            let Some(path) = path else { continue };
            if !file_is_within(&path, &vault.root)
                && !approved
                    .iter()
                    .any(|allowed| file_path_key(Path::new(allowed)) == file_path_key(&path))
            {
                continue;
            }
            if !path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "png"
                        | "jpg"
                        | "jpeg"
                        | "gif"
                        | "webp"
                        | "svg"
                        | "bmp"
                        | "avif"
                        | "mp4"
                        | "webm"
                        | "mov"
                        | "mkv"
                        | "mp3"
                        | "wav"
                        | "ogg"
                        | "pdf"
                        | "txt"
                        | "zip"
                )
            }) {
                continue;
            }
            if let Ok(path) = verified_external_file(&path) {
                paths.push((link.destination, path.to_string_lossy().into_owned()));
            }
        }
        self.assert_expected_target_unlocked(&vault, Some(&identity), Some(&guard))?;
        apply(targets, paths)
            .map_err(|message| error("knowledge-attachment-index-pending", message))
    }
    pub(crate) fn attachment_absolute_path(
        &self,
        relative: &str,
    ) -> Result<PathBuf, KnowledgeError> {
        let (vault, guard, identity) = self.capture_current_target()?;
        let path = Path::new(relative);
        let result = if path.is_absolute() {
            verified_external_file(path)?
        } else {
            safe_existing_file(&vault.root, &safe_relative_path(relative, false)?)?
        };
        self.verify_current_target(&identity, &guard)?;
        Ok(result)
    }
    pub(crate) fn document_attachment_targets(
        &self,
        document_ref: &KnowledgeDocumentRef,
    ) -> Result<Vec<String>, KnowledgeError> {
        Ok(
            super::markdown_links::attachment_links(&self.read_document(document_ref)?.content)
                .into_iter()
                .map(|link| link.destination)
                .collect(),
        )
    }
}

pub(super) fn external_target_path(
    root: &Path,
    note: &str,
    destination: &str,
    syntax: LinkSyntax,
) -> Result<Option<PathBuf>, KnowledgeError> {
    let raw = destination.split('#').next().unwrap_or(destination);
    if raw.is_empty() {
        return Ok(None);
    }
    let path = if raw.to_ascii_lowercase().starts_with("file:") {
        let url = url::Url::parse(raw).map_err(|_| {
            error(
                "knowledge-attachment-invalid-uri",
                "Invalid local file link",
            )
        })?;
        if url.host_str().is_some_and(|host| host != "localhost") {
            return Err(error(
                "knowledge-attachment-network-denied",
                "Network attachments require a local file selection",
            ));
        }
        url.to_file_path().map_err(|_| {
            error(
                "knowledge-attachment-invalid-uri",
                "Invalid local file link",
            )
        })?
    } else {
        let windows_drive = raw.as_bytes().get(1) == Some(&b':')
            && raw.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
        if raw.contains(':') && !windows_drive {
            return Ok(None);
        }
        let decoded = if syntax == LinkSyntax::Markdown {
            decode_uri_path(raw).map_err(|code| error(code, "Invalid encoded attachment path"))?
        } else {
            raw.into()
        };
        let value = PathBuf::from(decoded);
        if value.is_absolute() {
            value
        } else {
            let base = if syntax == LinkSyntax::Markdown
                || raw.starts_with("./")
                || raw.starts_with("../")
            {
                root.join(note).parent().unwrap_or(root).to_path_buf()
            } else {
                root.to_path_buf()
            };
            base.join(value)
        }
    };
    Ok(Some(normalized_path(&path)))
}

pub(super) fn verified_external_file(path: &Path) -> Result<PathBuf, KnowledgeError> {
    if !path.is_absolute() {
        return Err(error(
            "knowledge-attachment-invalid-source",
            "Attachment source must be absolute",
        ));
    }
    let text = path.to_string_lossy().replace('\\', "/");
    if (text.starts_with("//") && !text.starts_with("//?/"))
        || text.to_ascii_lowercase().starts_with("//?/unc/")
    {
        return Err(error(
            "knowledge-attachment-network-denied",
            "Network attachment access is not enabled",
        ));
    }
    for ancestor in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        if has_reparse_point(ancestor)? {
            return Err(error(
                "knowledge-path-reparse-forbidden",
                "Attachment contains a linked path",
            ));
        }
    }
    let path = path.canonicalize().map_err(|_| {
        error(
            "knowledge-attachment-source-unavailable",
            "Original attachment location is unavailable",
        )
    })?;
    let metadata = path.metadata().map_err(|_| {
        error(
            "knowledge-attachment-source-unavailable",
            "Original attachment location is unavailable",
        )
    })?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
        return Err(error(
            "knowledge-attachment-size-limit",
            "Attachment must be a regular file no larger than 64 MiB",
        ));
    }
    Ok(path)
}

fn encode_path(path: &str) -> String {
    let mut output = String::new();
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'-' | b'_' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

pub(super) fn portable_attachment_target(
    root: &Path,
    note: &str,
    absolute: &Path,
) -> Result<String, KnowledgeError> {
    // canonicalize() produces verbatim drive prefixes on Windows. Presentation
    // paths compare those with ordinary drive paths without changing file case.
    fn presentation_path(path: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            use std::path::{Component, Prefix};
            let windows_path = PathBuf::from(path.to_string_lossy().replace('/', "\\"));
            let mut parts = windows_path.components();
            if let Some(Component::Prefix(prefix)) = parts.next() {
                if let Prefix::VerbatimDisk(drive) = prefix.kind() {
                    let mut result = PathBuf::from(format!("{}:", drive as char));
                    for part in parts {
                        result.push(part.as_os_str());
                    }
                    return normalized_path(&result);
                }
            }
        }
        normalized_path(path)
    }
    fn same_component(left: &std::path::Component<'_>, right: &std::path::Component<'_>) -> bool {
        #[cfg(windows)]
        {
            left.as_os_str().to_string_lossy().to_lowercase()
                == right.as_os_str().to_string_lossy().to_lowercase()
        }
        #[cfg(not(windows))]
        {
            left == right
        }
    }
    let root = presentation_path(root);
    let absolute = presentation_path(absolute);
    if !root.is_absolute() || !absolute.is_absolute() {
        return Err(error(
            "knowledge-attachment-invalid-source",
            "Attachment and knowledge base paths must be absolute",
        ));
    }
    let parent = root.join(note).parent().unwrap_or(&root).to_path_buf();
    let from: Vec<_> = parent.components().collect();
    let to: Vec<_> = absolute.components().collect();
    if from
        .first()
        .zip(to.first())
        .is_some_and(|(a, b)| same_component(a, b))
    {
        let common = from
            .iter()
            .zip(&to)
            .take_while(|(a, b)| same_component(a, b))
            .count();
        let mut target = "../".repeat(from.len() - common);
        if target.is_empty() {
            target.push_str("./");
        }
        target.push_str(
            &to[common..]
                .iter()
                .map(|p| p.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
        );
        return Ok(encode_path(&target));
    }
    url::Url::from_file_path(&absolute)
        .map(|url| url.to_string())
        .map_err(|_| {
            error(
                "knowledge-attachment-invalid-uri",
                "Cannot express attachment as a file link",
            )
        })
}

pub(super) fn external_publication(
    root: &Path,
    note: &str,
    path: &Path,
    bytes: &[u8],
    name: &str,
) -> Result<AttachmentPublication, KnowledgeError> {
    let target = portable_attachment_target(root, note, path)?;
    let fallback = path.file_name().unwrap_or_default().to_string_lossy();
    let label = if name.trim().is_empty() {
        fallback.as_ref()
    } else {
        name
    }
    .replace('\\', "\\\\")
    .replace('[', "\\[")
    .replace(']', "\\]")
    .replace(['\r', '\n'], " ");
    let image = path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
        matches!(
            ext.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "avif"
        )
    });
    Ok(AttachmentPublication {
        relative_path: path.to_string_lossy().into_owned(),
        markdown: format!("{}[{label}]({target})", if image { "!" } else { "" }),
        sha256: sha256_hex(bytes),
        bytes: bytes.len() as u64,
        reused: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_target_roundtrips_encoded_names() {
        let root = std::env::temp_dir().join("target-vault");
        let target = std::env::temp_dir().join("original # % 中文 (2).png");
        let link = portable_attachment_target(&root, "notes/n.md", &target).unwrap();
        assert_eq!(
            external_target_path(&root, "notes/n.md", &link, LinkSyntax::Markdown)
                .unwrap()
                .unwrap(),
            target
        );
        assert!(link.contains("%23") && link.contains("%25"));
        assert!(external_target_path(
            &root,
            "n.md",
            "https://example.test/x.png",
            LinkSyntax::Markdown
        )
        .unwrap()
        .is_none());
    }
    #[cfg(windows)]
    #[test]
    fn cross_disk_file_uri_is_real_and_decodes_once() {
        let target = Path::new(r"C:\images\中文 # %20.png");
        let uri = portable_attachment_target(Path::new(r"D:\vault"), "n.md", target).unwrap();
        assert!(uri.starts_with("file:///C:/"));
        assert_eq!(
            external_target_path(Path::new(r"D:\vault"), "n.md", &uri, LinkSyntax::Markdown)
                .unwrap()
                .unwrap(),
            target
        );
    }
}
