//! Synthetic Windows collector race: no user files or application profile.
use super::*;
use std::cell::RefCell;
use std::path::Path;
use std::sync::Barrier;

thread_local! {
    static BEFORE_ENUMERATION: RefCell<Option<Box<dyn FnMut(&Path)>>> = RefCell::new(None);
    static BEFORE_GUARDS: RefCell<Option<Box<dyn FnMut(&Path)>>> = RefCell::new(None);
}

pub(super) fn before_guards(path: &Path) {
    BEFORE_GUARDS.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() { hook(path); }
    });
}

pub(super) fn before_enumeration(path: &Path) {
    BEFORE_ENUMERATION.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() { hook(path); }
    });
}

#[test]
fn collector_holds_intermediate_ancestors_until_enumeration_finishes() {
    let temp = std::env::temp_dir().join(format!("luckyray-import-chain-{:032x}", rand::random::<u128>()));
    let root = temp.join("source");
    let parent = root.join("a");
    let leaf = parent.join("b");
    std::fs::create_dir_all(&leaf).unwrap();
    std::fs::write(leaf.join("inside.md"), "inside").unwrap();
    let root = root.canonicalize().unwrap();
    let parent = root.join("a");
    let leaf = parent.join("b");
    let moved = root.join("a-moved");
    let ready = Arc::new(Barrier::new(2));
    let checked = Arc::new(Barrier::new(2));
    let worker_ready = ready.clone();
    let worker_checked = checked.clone();
    let worker_parent = parent.clone();
    let worker_moved = moved.clone();
    let worker = std::thread::spawn(move || {
        worker_ready.wait();
        let result = std::fs::rename(&worker_parent, &worker_moved);
        worker_checked.wait();
        result
    });
    BEFORE_ENUMERATION.with(|hook| *hook.borrow_mut() = Some(Box::new(move |directory| {
        if directory == leaf {
            ready.wait();
            checked.wait();
        }
    })));
    let mut files = Vec::new();
    let mut errors = Vec::new();
    collect_markdown_source_files(&root, &root, &mut files, &mut errors);
    BEFORE_ENUMERATION.with(|hook| *hook.borrow_mut() = None);
    let failure = worker.join().unwrap().unwrap_err();
    assert_eq!(failure.raw_os_error(), Some(32));
    assert!(errors.is_empty());
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].1, PathBuf::from("a/b/inside.md"));
    // The operation was rejected by the live guard, not by a permanent ACL.
    std::fs::rename(&parent, &moved).unwrap();
}

#[test]
fn directory_chain_rejects_an_existing_intermediate_junction() {
    use std::os::windows::process::CommandExt;
    let temp = std::env::temp_dir().join(format!("luckyray-import-chain-link-{:032x}", rand::random::<u128>()));
    let root = temp.join("source");
    let outside = temp.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(outside.join("b")).unwrap();
    std::fs::write(outside.join("b/outside.md"), "outside").unwrap();
    let output = std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"])
        .arg(root.join("a")).arg(&outside).creation_flags(0x08000000).output().unwrap();
    assert!(output.status.success());
    let root = root.canonicalize().unwrap();
    assert!(hold_notes_import_directory_chain(&root, &root.join("a/b")).is_err());
    assert_eq!(std::fs::read_to_string(outside.join("b/outside.md")).unwrap(), "outside");
}

#[test]
fn collector_rejects_ancestor_swapped_after_validation_before_open() {
    use std::os::windows::process::CommandExt;
    let temp = std::env::temp_dir().join(format!("luckyray-import-chain-race-{:032x}", rand::random::<u128>()));
    let root = temp.join("source");
    let outside = temp.join("outside");
    std::fs::create_dir_all(root.join("a/b")).unwrap();
    std::fs::create_dir_all(outside.join("b")).unwrap();
    std::fs::write(outside.join("b/outside.md"), "outside").unwrap();
    let root = root.canonicalize().unwrap();
    let leaf = root.join("a/b");
    let ready = Arc::new(Barrier::new(2));
    let replaced = Arc::new(Barrier::new(2));
    let worker_ready = ready.clone();
    let worker_replaced = replaced.clone();
    let worker_root = root.clone();
    let worker = std::thread::spawn(move || {
        worker_ready.wait();
        let result = (|| {
            std::fs::rename(worker_root.join("a"), worker_root.join("a-original"))?;
            std::process::Command::new("cmd.exe").args(["/c", "mklink", "/J"])
                .arg(worker_root.join("a")).arg(&outside).creation_flags(0x08000000).output()
        })();
        worker_replaced.wait();
        result
    });
    BEFORE_GUARDS.with(|hook| *hook.borrow_mut() = Some(Box::new(move |directory| {
        if directory == leaf { ready.wait(); replaced.wait(); }
    })));
    let mut files = Vec::new();
    let mut errors = Vec::new();
    collect_markdown_source_files(&root, &root, &mut files, &mut errors);
    BEFORE_GUARDS.with(|hook| *hook.borrow_mut() = None);
    assert!(worker.join().unwrap().unwrap().status.success());
    assert!(files.is_empty(), "outside notes must never enter the source inventory");
    assert!(!errors.is_empty());
}
