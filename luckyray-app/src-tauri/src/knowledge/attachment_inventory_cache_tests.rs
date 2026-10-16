// Behavior tests for the shared attachment-inventory snapshot (Issue 118).
//
// These drive the REAL service paths (resolve_vault_attachment, refresh_index,
// refresh_modified_documents, publish) — no second resolver. The counters are
// the same style of test-only instrumentation as index_document_read_count.

use super::attachment_tests::fixture;
use super::*;

fn note_with_embed(root: &Path, name: &str, target: &str) {
    std::fs::write(root.join(name), format!("# {name}\n\n![[{target}]]\n")).unwrap();
}

fn write_attachment(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, bytes).unwrap();
}

fn resolve(service: &KnowledgeService, vault_id: &str, note: &str, target: &str) -> AttachmentResolution {
    service
        .resolve_vault_attachment(
            &KnowledgeDocumentRef { vault_id: vault_id.to_string(), relative_path: note.to_string() },
            target,
            true,
        )
        .unwrap()
}

#[test]
fn resolving_many_embeds_shares_one_inventory_walk() {
    let (service, root, vault) = fixture("inventory-shared-walk");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"png");
    write_attachment(&root, "b.png", b"png");
    write_attachment(&root, "c.png", b"png");

    for target in ["a.png", "b.png", "c.png", "a.png"] {
        let result = resolve(&service, &vault.id, "Note.md", target);
        assert_eq!(result.status, "resolved", "{target} must resolve");
    }
    assert_eq!(
        service.attachment_inventory.build_count(),
        1,
        "four resolutions must share exactly one attachment-tree walk"
    );
    assert_eq!(service.attachment_inventory.hit_count(), 3);
}

#[test]
fn markdown_only_save_does_not_invalidate_the_snapshot() {
    let (service, root, vault) = fixture("inventory-md-save-keeps");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"png");
    assert_eq!(resolve(&service, &vault.id, "Note.md", "a.png").status, "resolved");
    assert_eq!(service.attachment_inventory.build_count(), 1);

    // An ordinary Markdown save flows through refresh_modified_documents.
    std::fs::write(root.join("Note.md"), "# Note\n\n![[a.png]] edited body\n").unwrap();
    service.refresh_modified_documents(&["Note.md".into()]).unwrap();
    assert_eq!(
        resolve(&service, &vault.id, "Note.md", "a.png").status,
        "resolved"
    );
    assert_eq!(
        service.attachment_inventory.build_count(),
        1,
        "a Markdown-only save is not an attachment-tree change"
    );
}

#[test]
fn watcher_and_full_reconciliation_invalidate_without_eager_scanning() {
    let (service, root, vault) = fixture("inventory-watcher-rebuild");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"png");
    resolve(&service, &vault.id, "Note.md", "a.png");
    assert_eq!(service.attachment_inventory.build_count(), 1);

    // The document index only reports Markdown deltas. Full reconciliation
    // drops the inventory without scanning it until the next resolver.
    write_attachment(&root, "new.png", b"png");
    std::fs::write(root.join("Other.md"), "# Other
").unwrap();
    service.refresh_index().unwrap();
    assert_eq!(
        service.attachment_inventory.build_count(),
        1,
        "invalidation does not eagerly walk the attachment tree"
    );

    // The real signal for non-Markdown file events is the watcher entry point.
    service.invalidate_attachment_inventory(&vault.id).unwrap();
    assert_eq!(
        resolve(&service, &vault.id, "Note.md", "new.png").status,
        "resolved",
        "the rebuilt snapshot must see the externally added file"
    );
    assert_eq!(
        service.attachment_inventory.build_count(),
        2,
        "watcher invalidation drops the shared snapshot"
    );

    // Vault mismatch is rejected rather than silently invalidating.
    assert!(service.invalidate_attachment_inventory("vault-other").is_err());
}

#[test]
fn publishing_an_attachment_drops_the_snapshot() {
    let (service, root, vault) = fixture("inventory-publish-invalidates");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"existing-bytes");
    resolve(&service, &vault.id, "Note.md", "a.png");
    assert_eq!(service.attachment_inventory.build_count(), 1);

    let document_ref = KnowledgeDocumentRef { vault_id: vault.id.clone(), relative_path: "Note.md".to_string() };
    let activation = service.activate_current_ui_source().unwrap();
    std::fs::write(root.join("Note.md"), "# Note

body
").unwrap();
    // Distinct bytes: publishing identical content dedupes to the existing
    // attachment and never writes a new file, which must not be misread as a
    // cache failure.
    let bytes = b"unique-published-bytes";
    let revision = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&std::fs::read(root.join("Note.md")).unwrap());
        format!("{:x}", hasher.finalize())
    };
    service
        .publish_attachment_from_ui(activation.source_epoch, &document_ref, &revision, "published.png", bytes, None, false)
        .unwrap();
    assert_eq!(
        resolve(&service, &vault.id, "Note.md", "published.png").status,
        "resolved"
    );
    assert_eq!(
        service.attachment_inventory.build_count(),
        2,
        "publish invalidates so the new file is visible immediately"
    );
}

#[test]
fn vanished_cached_entry_rebuilds_instead_of_erroring() {
    let (service, root, vault) = fixture("inventory-stale-retry");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"png");
    assert_eq!(resolve(&service, &vault.id, "Note.md", "a.png").status, "resolved");
    assert_eq!(service.attachment_inventory.build_count(), 1);

    // Delete outside the service (no watcher in this test): the cached entry
    // is now stale. Resolution must report missing, not knowledge-not-found.
    std::fs::remove_file(root.join("a.png")).unwrap();
    let result = resolve(&service, &vault.id, "Note.md", "a.png");
    assert_eq!(
        result.status,
        "external-unavailable",
        "a stale entry degrades exactly like a fresh-walk missing target (missing -> external fallback), never a hard error"
    );
    assert_eq!(
        service.attachment_inventory.build_count(),
        2,
        "the not-found retry rebuilt the snapshot once"
    );
}

#[test]
fn vault_switch_drops_the_snapshot_for_the_next_vault() {
    let (service, root, vault) = fixture("inventory-vault-switch-a");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"png");
    resolve(&service, &vault.id, "Note.md", "a.png");
    assert_eq!(service.attachment_inventory.build_count(), 1);

    let (other_service, other_root, other) = fixture("inventory-vault-switch-b");
    note_with_embed(&other_root, "Other.md", "b.png");
    write_attachment(&other_root, "b.png", b"png");
    // A fresh service instance for the second vault mirrors a cold switch;
    // the cache must not carry anything over.
    assert_eq!(resolve(&other_service, &other.id, "Other.md", "b.png").status, "resolved");
    assert_eq!(other_service.attachment_inventory.build_count(), 1);
}

#[test]
fn resolver_rebuilding_during_publication_cannot_leave_a_prewrite_inventory() {
    let (service, root, vault) = fixture("inventory-publish-overlap");
    note_with_embed(&root, "Note.md", "a.png");
    write_attachment(&root, "a.png", b"old");
    resolve(&service, &vault.id, "Note.md", "a.png");
    let reference = KnowledgeDocumentRef { vault_id: vault.id.clone(), relative_path: "Note.md".into() };
    let active = service.activate_current_ui_source().unwrap();
    let revision = sha256_hex(&std::fs::read(root.join("Note.md")).unwrap());
    let (trusted, guard, identity) = service.capture_current_target().unwrap();
    let locked = service.mutation_lock.lock().unwrap();
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| service.publish_attachment_from_ui(active.source_epoch, &reference, &revision, "published.png", b"new contents", None, false));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while service.attachment_inventory.is_cached() && std::time::Instant::now() < deadline { std::thread::yield_now(); }
        assert!(!service.attachment_inventory.is_cached(), "writer must reach pre-write invalidation");
        service.attachment_inventory.get_or_build(&trusted, &guard, &identity).unwrap();
        drop(locked);
        writer.join().unwrap().unwrap();
    });
    assert_eq!(resolve(&service, &vault.id, "Note.md", "published.png").status, "resolved",
        "a concurrent pre-write cache rebuild must not hide the published basename");
}

#[test]
fn full_reconciliation_observes_non_markdown_additions_without_a_watcher() {
    let (service, root, vault) = fixture("inventory-full-reconcile");
    note_with_embed(&root, "Note.md", "same.png");
    write_attachment(&root, "one/same.png", b"one");
    assert_eq!(resolve(&service, &vault.id, "Note.md", "same.png").status, "resolved");
    write_attachment(&root, "two/same.png", b"two");
    service.refresh_index().unwrap();
    assert_eq!(resolve(&service, &vault.id, "Note.md", "same.png").status, "ambiguous");
}
