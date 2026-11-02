use super::*;
use std::io::{Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;

fn fixture() -> (tempfile::TempDir, PathBuf, Directory, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let dir = Directory::open(&root, false, false).unwrap();
    let path = root.join("Synthetic note.md");
    (temp, root, dir, path)
}

fn journal(
    dir: &Directory,
    nonce: &str,
    before: &[u8],
    after: &[u8],
    source: &File,
    next: Option<&File>,
) -> Journal {
    let original = source.metadata().unwrap();
    let record = Journal {
        version: 1,
        nonce: nonce.into(),
        target: "Synthetic note.md".into(),
        before: Some(digest(before)),
        after: digest(after),
        before_object: Some((original.dev(), original.ino())),
        next_object: next.map(|file| {
            let meta = file.metadata().unwrap();
            (meta.dev(), meta.ino())
        }),
    };
    dir.create(
        OsStr::new(&format!(".lrm-{nonce}.journal")),
        &serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    record
}

#[test]
fn macos_platform_note_write_conflict_and_recovery() {
    let (_temp, root, dir, path) = fixture();
    write(&path, b"first", false, false, None, || Ok(())).unwrap();
    let version = dir
        .read(OsStr::new("Synthetic note.md"))
        .unwrap()
        .unwrap()
        .1;
    assert!(write(&path, b"second", true, true, Some(&version), || Ok(())).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"first");
    std::fs::write(&path, b"external").unwrap();
    assert!(write(&path, b"second", true, false, Some(&version), || Ok(())).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"external");

    // An editor keeps the old descriptor across the production exchange and
    // writes only after the save has returned. The old inode remains named.
    let mut held = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let old_inode = held.metadata().unwrap().ino();
    write(&path, b"committed", true, false, None, || Ok(())).unwrap();
    held.seek(SeekFrom::Start(0)).unwrap();
    held.write_all(b"late external update").unwrap();
    held.set_len(20).unwrap();
    held.sync_all().unwrap();
    let histories: Vec<_> = dir
        .entries()
        .unwrap()
        .into_iter()
        .filter(|n| n.to_string_lossy().ends_with(".history"))
        .collect();
    assert_eq!(histories.len(), 1);
    let trace: Journal =
        serde_json::from_slice(&dir.read_owned(&histories[0]).unwrap().unwrap().0).unwrap();
    let retained = root.join(format!(".lrm-{}.backup", trace.nonce));
    assert_eq!(trace.before_object.unwrap().1, old_inode);
    assert_eq!(std::fs::metadata(&retained).unwrap().ino(), old_inode);
    assert_eq!(std::fs::read(&retained).unwrap(), b"late external update");
    assert_eq!(std::fs::read(&path).unwrap(), b"committed");
    write(&path, b"follow-up", true, false, None, || Ok(())).unwrap();
    assert_eq!(std::fs::read(&retained).unwrap(), b"late external update");

    // The final source check binds the path to the original opened object.
    let saved = root.join("original-saved.md");
    let result = write(&path, b"not-published", true, false, None, || {
        std::fs::rename(&path, &saved).unwrap();
        std::fs::write(&path, b"replacement source").unwrap();
        Ok(())
    });
    assert_eq!(result.unwrap_err().code, "knowledge-revision-conflict");
    assert_eq!(std::fs::read(&path).unwrap(), b"replacement source");
    assert_eq!(std::fs::read(&saved).unwrap(), b"follow-up");

    // Recovery after an exchange must also retain the old descriptor's inode.
    // Simulate a crash after the verified mode has been installed but before
    // the active journal was archived.
    let (_temp2, root2, dir2, path2) = fixture();
    std::fs::write(&path2, b"original").unwrap();
    let mut old = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path2)
        .unwrap();
    let nonce = "a".repeat(32);
    let backup = format!(".lrm-{nonce}.backup");
    let staged = dir2.create(OsStr::new(&backup), b"new").unwrap();
    staged
        .set_permissions(std::fs::Permissions::from_mode(
            old.metadata().unwrap().mode() & 0o777,
        ))
        .unwrap();
    journal(&dir2, &nonce, b"original", b"new", &old, Some(&staged));
    dir2.rename(OsStr::new(&backup), OsStr::new("Synthetic note.md"), true)
        .unwrap();
    recover_tree(&root2).unwrap();
    assert_eq!(std::fs::read(&path2).unwrap(), b"new");
    old.seek(SeekFrom::Start(0)).unwrap();
    old.write_all(b"late after recovery").unwrap();
    old.set_len(19).unwrap();
    old.sync_all().unwrap();
    assert_eq!(
        std::fs::read(root2.join(&backup)).unwrap(),
        b"late after recovery"
    );
    assert!(root2.join(format!(".lrm-{nonce}.history")).exists());

    // Recovery does not guess whether mode 000 is our interrupted publication
    // or an external restriction. Both versions stay reachable for review.
    let (_closed_temp, closed_root, closed_dir, closed_path) = fixture();
    std::fs::write(&closed_path, b"closed-original").unwrap();
    let closed_source = closed_dir
        .open_regular(OsStr::new("Synthetic note.md"))
        .unwrap();
    let closed_nonce = "e".repeat(32);
    let closed_backup = format!(".lrm-{closed_nonce}.backup");
    let closed_stage = closed_dir
        .create(OsStr::new(&closed_backup), b"closed-next")
        .unwrap();
    journal(
        &closed_dir,
        &closed_nonce,
        b"closed-original",
        b"closed-next",
        &closed_source,
        Some(&closed_stage),
    );
    closed_stage
        .set_permissions(std::fs::Permissions::from_mode(0))
        .unwrap();
    closed_dir
        .rename(
            OsStr::new(&closed_backup),
            OsStr::new("Synthetic note.md"),
            true,
        )
        .unwrap();
    assert!(recover_tree(&closed_root).is_err());
    assert_eq!(std::fs::metadata(&closed_path).unwrap().mode() & 0o777, 0);
    assert_eq!(
        std::fs::read(closed_root.join(&closed_backup)).unwrap(),
        b"closed-original"
    );
    assert!(closed_root
        .join(format!(".lrm-{closed_nonce}.journal"))
        .exists());

    // A merely prepared journal retains its backup as well; matching hashes
    // alone never authorize recovery to unlink a potentially held inode.
    let (_temp3, root3, dir3, path3) = fixture();
    std::fs::write(&path3, b"original").unwrap();
    let source = dir3.open_regular(OsStr::new("Synthetic note.md")).unwrap();
    let nonce3 = "b".repeat(32);
    let backup3 = format!(".lrm-{nonce3}.backup");
    let staged3 = dir3.create(OsStr::new(&backup3), b"new").unwrap();
    journal(&dir3, &nonce3, b"original", b"new", &source, Some(&staged3));
    recover_tree(&root3).unwrap();
    assert_eq!(std::fs::read(&path3).unwrap(), b"original");
    assert_eq!(std::fs::read(root3.join(&backup3)).unwrap(), b"new");
    assert!(root3.join(format!(".lrm-{nonce3}.history")).exists());

    let restore_nonce = "c".repeat(32);
    let restore_backup = format!(".lrm-{restore_nonce}.backup");
    dir3.rename(
        OsStr::new("Synthetic note.md"),
        OsStr::new(&restore_backup),
        false,
    )
    .unwrap();
    journal(&dir3, &restore_nonce, b"original", b"new", &source, None);
    recover_tree(&root3).unwrap();
    assert_eq!(std::fs::read(&path3).unwrap(), b"original");
    assert_eq!(
        std::fs::metadata(&path3).unwrap().ino(),
        source.metadata().unwrap().ino()
    );
    assert!(root3.join(format!(".lrm-{restore_nonce}.history")).exists());

    // Unknown external content remains untouched with the active journal.
    let nonce4 = "d".repeat(32);
    let backup4 = format!(".lrm-{nonce4}.backup");
    let staged4 = dir3.create(OsStr::new(&backup4), b"new").unwrap();
    journal(&dir3, &nonce4, b"original", b"new", &source, Some(&staged4));
    std::fs::write(&path3, b"different external version").unwrap();
    assert!(recover_tree(&root3).is_err());
    assert_eq!(
        std::fs::read(&path3).unwrap(),
        b"different external version"
    );
    assert!(root3.join(&backup4).exists());
    assert!(root3.join(format!(".lrm-{nonce4}.journal")).exists());

    // Equal bytes at another inode cannot satisfy an automatic restore.
    let (_replaced_temp,replaced_root,replaced_dir,replaced_path)=fixture();
    std::fs::write(&replaced_path,b"original").unwrap();
    let original_file=replaced_dir.open_regular(OsStr::new("Synthetic note.md")).unwrap();
    std::fs::rename(&replaced_path,replaced_root.join("external-original-held")).unwrap();
    let replaced_nonce="f".repeat(32);
    let replaced_backup=format!(".lrm-{replaced_nonce}.backup");
    replaced_dir.create(OsStr::new(&replaced_backup),b"original").unwrap();
    journal(&replaced_dir,&replaced_nonce,b"original",b"next",&original_file,None);
    assert!(recover_tree(&replaced_root).is_err());
    assert!(!replaced_path.exists());
    assert_eq!(std::fs::read(replaced_root.join(&replaced_backup)).unwrap(),b"original");
    assert!(replaced_root.join("external-original-held").is_file());
    assert!(replaced_root.join(format!(".lrm-{replaced_nonce}.journal")).is_file());
}
