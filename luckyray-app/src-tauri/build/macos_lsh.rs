//! Bind the actual non-code native preparation receipt into Apple builds.
//! Launch authority is separately source pinned; this receipt cannot bless code.
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::path::Path;

#[cfg(unix)]
fn read_checked(root: &Path, path: &Path) -> Vec<u8> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let owner = std::fs::symlink_metadata(root)
        .expect("macOS receipt root")
        .uid();
    let directory = path.parent().expect("macOS receipt parent");
    let before_dir =
        std::fs::symlink_metadata(directory).expect("macOS prepared receipt directory");
    assert!(
        before_dir.is_dir()
            && !before_dir.file_type().is_symlink()
            && before_dir.uid() == owner
            && before_dir.mode() & 0o022 == 0,
        "unsafe macOS receipt directory"
    );
    let nofollow = if cfg!(target_os = "macos") {
        0x100
    } else {
        0x20000
    };
    let mut file: File = OpenOptions::new()
        .read(true)
        .custom_flags(nofollow)
        .open(path)
        .expect("open macOS receipt no-follow");
    let object = |m: &std::fs::Metadata| {
        (
            m.dev(),
            m.ino(),
            m.len(),
            m.nlink(),
            m.uid(),
            m.gid(),
            m.mode(),
            m.mtime(),
            m.mtime_nsec(),
            m.ctime(),
            m.ctime_nsec(),
        )
    };
    let before = file.metadata().expect("macOS receipt metadata");
    assert!(
        before.is_file()
            && before.uid() == owner
            && before.nlink() == 1
            && before.mode() & 0o7022 == 0
            && before.len() > 0
            && before.len() <= 32 * 1024 * 1024,
        "unsafe macOS receipt file"
    );
    let mut bytes = Vec::new();
    (&mut file)
        .take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .expect("read macOS receipt");
    let after = file.metadata().expect("macOS receipt after read");
    let named = std::fs::symlink_metadata(path).expect("macOS receipt named object");
    let after_dir =
        std::fs::symlink_metadata(directory).expect("macOS receipt directory after read");
    assert!(
        bytes.len() as u64 == before.len()
            && object(&after) == object(&before)
            && !named.file_type().is_symlink()
            && object(&named) == object(&before)
            && object(&after_dir) == object(&before_dir),
        "macOS receipt changed while reading"
    );
    bytes
}

pub fn bind(root: &Path, target: &str, profile: &str) {
    if !target.ends_with("-apple-darwin") {
        return;
    }
    let path = root.join("dsh/macos-build.json");
    println!("cargo:rerun-if-changed={}", path.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("macos-lsh-authority.json").display()
    );
    if std::fs::symlink_metadata(&path).is_err() {
        assert_ne!(
            profile, "release",
            "prepare real macOS LSH resources before release compilation"
        );
        // An ordinary debug/type-check build can compile without resources,
        // but cannot acquire a launch authority or satisfy installed admission.
        println!("cargo:rustc-env=LUCKYRAY_MACOS_BUILD_RECORD_SHA256=");
        return;
    }
    #[cfg(not(unix))]
    panic!("macOS receipt requires a native Unix build host");
    #[cfg(unix)]
    {
        let bytes = read_checked(root, &path);
        let value: serde_json::Value = serde_json::from_slice(&bytes).expect("macOS receipt JSON");
        let authority: serde_json::Value = serde_json::from_slice(
            &std::fs::read(root.join("macos-lsh-authority.json")).expect("source macOS authority"),
        )
        .expect("source macOS authority JSON");
        assert!(
            value["schemaVersion"] == 1
                && value["platform"] == "darwin"
                && value["architecture"] == "arm64"
                && value["node"] == authority["nodeInput"]
                && value["runtimePackage"] == authority["runtimePackage"]
                && value["lockfileSha256"] == authority["lockfileSha256"]
                && value["nativeModuleLoadProbe"]["status"] == "passed"
                && value["nativeModuleLoadProbe"]["modules"]
                    == serde_json::json!([
                        "koffi",
                        "node-pty",
                        "sharp",
                        "node-addon-require-builtin"
                    ])
                && value["versionProbe"] == "0.2.1-rc.3"
                && value["audit"]["platform"] == "darwin"
                && value["audit"]["architecture"] == "arm64"
                && value["audit"]["packageCount"] == 564
                && value["audit"]["installScriptsExecuted"] == false
                && value["audit"]["treeContentSha256"]
                    == authority["frozenPackageClosure"]["treeContentSha256"]
                && value["distribution"]["sourceInputsSha256"]
                    == authority["sourceMaterialIndexSha256"]
                && value["files"].as_array().map(|a| a.len() as u64)
                    == authority["closure"]["fileCount"].as_u64(),
            "macOS receipt differs from qualified source inputs or native results"
        );
        println!(
            "cargo:rustc-env=LUCKYRAY_MACOS_BUILD_RECORD_SHA256={:x}",
            Sha256::digest(&bytes)
        );
    }
}
