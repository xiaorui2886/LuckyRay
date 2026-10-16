// EXT-Z1 native evidence: the template-create path writes a real note file
// through the production Knowledge service and refuses a stale/mismatched
// target. This exercises the same native service the Tauri command wraps; it
// does not touch any user vault (isolated fixture roots only).
use super::attachment_tests::fixture;
use super::*;

#[test]
fn extension_template_create_writes_a_real_note_file_and_refuses_stale_target() {
    let (service, root, registration) = fixture("ext-z1-template");
    service.register_current_vault(&registration).unwrap();

    // A template create issues a KnowledgeCreateInput through the same
    // expected-vault path the extension template adapter uses.
    let input = KnowledgeCreateInput {
        title: "Research note".to_owned(),
        parent_relative_path: None,
        content: "# Research note\n\n## Research question\n\nWhat do we need to learn?\n".to_owned(),
    };
    let created = service
        .create_document_for_expected_vault(&registration.id, &input)
        .expect("template create must succeed on a fresh vault");
    assert_eq!(created.summary.document_ref.vault_id, registration.id);

    // The note is a real file on disk with the exact rendered content.
    let real_path = root.join(&created.summary.relative_path);
    assert!(real_path.is_file(), "the created note file must exist on disk");
    let on_disk = std::fs::read_to_string(&real_path).unwrap();
    assert_eq!(on_disk, input.content, "the on-disk note matches the rendered template");

    // Reading it back through the service returns the same content/revision.
    let snapshot = service.read_document(&created.summary.document_ref).unwrap();
    assert_eq!(snapshot.summary.document_ref.relative_path, created.summary.relative_path);
    assert_eq!(snapshot.content, input.content);

    // A stale/mismatched expected vault must be refused and must not create a
    // second file: the target-vault guard is the native authority.
    let before = std::fs::read_dir(&root).unwrap().count();
    let stale = service.create_document_for_expected_vault(
        "vault-does-not-exist",
        &KnowledgeCreateInput {
            title: "Should not land".to_owned(),
            parent_relative_path: None,
            content: "nope".to_owned(),
        },
    );
    assert!(stale.is_err(), "an unknown expected vault must be refused");
    let after = std::fs::read_dir(&root).unwrap().count();
    assert_eq!(before, after, "a refused create must not write a file");
}
