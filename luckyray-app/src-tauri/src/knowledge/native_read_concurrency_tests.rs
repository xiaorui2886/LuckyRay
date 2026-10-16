use super::*;
use std::sync::{mpsc,Arc,Mutex};
use std::time::Duration;

#[test]
fn closeout_full_replacement_preserves_requested_trailing_newlines_and_exact_ack() {
    let (service, root, _) = tests::registered_service("closeout-exact-replacement");
    let mut document = service.create_document(&KnowledgeCreateInput {
        title: "Exact".into(), parent_relative_path: None, content: "".into(),
    }).unwrap();
    let bulk = format!("# 中文与 emoji 🧭\n{}", (0..500).map(|n| format!("Line {n:04}: independent scroll and exact text.")).collect::<Vec<_>>().join("\n"));
    // A full editor replacement, unlike an append, must honor adding AND
    // removing final newlines. Its ACK must describe precisely what was saved.
    for content in ["正文\n".to_string(), "正文\n\n".to_string(), "正文".to_string(), format!("{bulk}\n"), bulk, String::new()] {
        let saved = service.replace_document(&KnowledgeWriteInput {
            document_ref: document.summary.document_ref.clone(),
            expected_revision: Some(document.revision.clone()), content: content.clone(),
        }).unwrap().document;
        assert_eq!(saved.content, content, "replace ACK changed requested full text");
        assert_eq!(saved.revision, sha256_hex(content.as_bytes()));
        assert_eq!(std::fs::read(root.join("Exact.md")).unwrap(), content.as_bytes());
        document = saved;
    }
}

#[test]
fn closeout_replacement_keeps_bom_and_crlf_but_not_old_eof_shape() {
    let (service, root, vault) = tests::registered_service("closeout-eof-encoding");
    std::fs::write(root.join("Windows.md"), b"\xef\xbb\xbfOld\r\n").unwrap();
    let reference = KnowledgeDocumentRef { vault_id: vault.id, relative_path: "Windows.md".into() };
    let mut document = service.read_document(&reference).unwrap();
    for (input, expected) in [("one\ntwo\n\n", "one\r\ntwo\r\n\r\n"), ("one\ntwo", "one\r\ntwo")] {
        let saved = service.replace_document(&KnowledgeWriteInput {
            document_ref: reference.clone(), expected_revision: Some(document.revision), content: input.into(),
        }).unwrap().document;
        let bytes = [b"\xef\xbb\xbf".as_slice(), expected.as_bytes()].concat();
        assert_eq!(saved.content, expected);
        assert_eq!(std::fs::read(root.join("Windows.md")).unwrap(), bytes);
        assert_eq!(saved.revision, sha256_hex(&bytes));
        document = saved;
    }
}

#[test]
fn r9_captured_read_waits_for_inflight_save_and_returns_complete_committed_document() {
    controlled_read(false);
}

#[test]
fn r9_target_read_waits_for_inflight_save_without_recursive_lock() {
    controlled_read(true);
}

fn controlled_read(targeted:bool) {
    let (service, _root, vault) = tests::registered_service("r9-controlled-save-read");
    let before = "# Synthetic\nCHILD-R9\n";
    let after = "# Synthetic\nCHILD-R9\nDIRTY-R9\n";
    let created = service.create_document(&KnowledgeCreateInput {
        title:"Concurrent".into(),parent_relative_path:None,content:before.into(),
    }).unwrap();
    let captured = service.capture_workspace_scope(&vault.id).unwrap();
    let identity=captured.current_target_identity().unwrap();
    let (entered_tx,entered_rx)=mpsc::channel();
    let (release_tx,release_rx)=mpsc::channel();
    let release_rx=Arc::new(Mutex::new(release_rx));
    service.set_after_final_validation_hook(move || {
        entered_tx.send(()).unwrap();
        release_rx.lock().unwrap().recv_timeout(Duration::from_secs(10)).unwrap();
    });
    let reference=created.summary.document_ref.clone();
    let writer=std::thread::spawn(move || service.replace_document(&KnowledgeWriteInput {
        document_ref:created.summary.document_ref,content:after.into(),expected_revision:Some(created.revision),
    }));
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let (read_tx,read_rx)=mpsc::channel();
    let reader=std::thread::spawn(move || read_tx.send(if targeted {captured.read_document_for_target(&identity,&reference)}else{captured.read_document(&reference)}).unwrap());
    let early=read_rx.recv_timeout(Duration::from_millis(150));
    // Always release and join, including the old-code RED. No abandoned writer.
    release_tx.send(()).unwrap();
    let saved=writer.join().unwrap().unwrap();
    let blocked=early.is_err();
    let observed=match early {Ok(value)=>value,Err(_)=>read_rx.recv_timeout(Duration::from_secs(10)).unwrap()};
    reader.join().unwrap();
    eprintln!("R9 caller=captured-read_document phase=save-final-validation observed={observed:?}");
    assert!(blocked,"A read escaped the in-flight service mutation: {observed:?}");
    let read=observed.unwrap();
    assert_eq!(read.content,after);assert_eq!(read.revision,saved.document.revision);
    assert_eq!(read.summary.document_ref,saved.document.summary.document_ref);
}

#[cfg(windows)]
#[test]
fn r9_external_share_denial_is_reported_not_retried_or_hidden() {
    let (service,root,vault)=tests::registered_service("r9-external-share-denial");
    std::fs::write(root.join("External.md"),"unmodified").unwrap();
    let reference=KnowledgeDocumentRef{vault_id:vault.id,relative_path:"External.md".into()};
    let exclusive=open_exclusive_document(&root.join("External.md")).unwrap();
    let failure=service.read_document(&reference).unwrap_err();
    assert_eq!(failure.code,"knowledge-read-failed");
    assert!(failure.message.contains("phase=content")&&failure.message.contains("Some(32)"));
    drop(exclusive);
    assert_eq!(service.read_document(&reference).unwrap().content,"unmodified");
}
