// Shared attachment-inventory snapshot for one active vault.
//
// Every `resolve_attachment_with_approved_paths` used to walk the whole
// attachment tree (`index::attachment_inventory`), so resolving one note with
// N embeds performed N full recursive scans. This cache keeps one bounded,
// process-local snapshot per (root, target identity); concurrent resolvers
// share the in-flight build (single flight under the cache lock), and the
// snapshot is invalidated by real attachment-tree mutations — never by
// ordinary Markdown saves.
//
// The cache is a projection of the filesystem, not a second matching
// authority: resolution semantics stay in `resolve_attachment`, per-file
// existence/version checks still run per resolution, and a build whose root
// identity changed underneath is never published for the new identity.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::agent_workspace::FilesystemDirectoryIdentityGuard;

use super::index;
use super::{error, map_filesystem_identity_error, KnowledgeError, KnowledgeTargetIdentity, TrustedVault};

struct Entry {
    root: PathBuf,
    identity: KnowledgeTargetIdentity,
    files: Arc<Vec<String>>,
}

pub(crate) struct AttachmentInventoryCache {
    entry: Mutex<Option<Entry>>,
    #[cfg(test)]
    builds: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    hits: std::sync::atomic::AtomicUsize,
}

pub(crate) struct InventoryMutation<'a>(&'a AttachmentInventoryCache);
impl Drop for InventoryMutation<'_> {
    fn drop(&mut self) { self.0.invalidate(); }
}

impl AttachmentInventoryCache {
    /// Also invalidate after every exit, including partial failures. A resolver
    /// can rebuild the old directory while the writer is still running.
    pub(crate) fn mutation(&self) -> InventoryMutation<'_> {
        self.invalidate();
        InventoryMutation(self)
    }
    pub(crate) fn new() -> Self {
        Self {
            entry: Mutex::new(None),
            #[cfg(test)]
            builds: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            hits: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// The shared snapshot for `root`/`identity`. A cache hit returns the
    /// retained files directly; otherwise the tree is walked once while
    /// holding the cache lock, so parallel first resolvers share one build
    /// instead of each scanning. The caller's `root_guard` is re-verified
    /// after the walk so a build that raced a root change is not stored.
    pub(crate) fn get_or_build(
        &self,
        vault: &TrustedVault,
        root_guard: &FilesystemDirectoryIdentityGuard,
        identity: &KnowledgeTargetIdentity,
    ) -> Result<(Arc<Vec<String>>, bool), KnowledgeError> {
        let mut guard = self
            .entry
            .lock()
            .map_err(|_| error("knowledge-lock-poisoned", "Attachment inventory cache lock failed"))?;
        if let Some(entry) = guard.as_ref() {
            if entry.root == vault.root && &entry.identity == identity {
                #[cfg(test)]
                self.hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                return Ok((Arc::clone(&entry.files), true));
            }
        }
        let files = index::attachment_inventory(&vault.root)?;
        // Publishing requires the root to still be the one the caller
        // captured: a build that raced a switch/recreate is discarded rather
        // than cached (and the caller's own verify still runs afterwards).
        root_guard
            .verify_current_path(&vault.root)
            .map_err(map_filesystem_identity_error)?;
        *guard = Some(Entry {
            root: vault.root.clone(),
            identity: identity.clone(),
            files: Arc::new(files),
        });
        #[cfg(test)]
        self.builds.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let files = Arc::clone(&guard.as_ref().expect("just stored").files);
        Ok((files, false))
    }

    /// Drop the snapshot. Called for real attachment-tree mutations, vault
    /// switches, and full reconciliations that observed non-Markdown changes.
    /// A failed build never leaves an entry behind, so a read error is never
    /// cached as an empty inventory.
    pub(crate) fn invalidate(&self) {
        let _ = self.entry.lock().map(|mut guard| *guard = None);
    }

    #[cfg(test)]
    pub(crate) fn is_cached(&self) -> bool {
        self.entry.lock().unwrap().is_some()
    }

    #[cfg(test)]
    pub(crate) fn build_count(&self) -> usize {
        self.builds.load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(crate) fn hit_count(&self) -> usize {
        self.hits.load(std::sync::atomic::Ordering::SeqCst)
    }
}
