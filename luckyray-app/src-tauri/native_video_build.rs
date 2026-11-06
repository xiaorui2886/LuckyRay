//! Native player resources stay separate from the media downloader runtime.
//! A release needs the exact DLL AND its complete, hash-bound source/notices.
use std::{collections::BTreeSet, path::{Component, Path, PathBuf}};

fn safe_relative(name: &str) -> bool {
    !name.is_empty() && !name.contains('\\') && !name.contains(':') &&
        Path::new(name).components().all(|part| matches!(part, Component::Normal(_)))
}

fn files_below(root: &Path, base: &Path, files: &mut BTreeSet<String>) {
    let root_metadata = std::fs::symlink_metadata(root).expect("native video resource root");
    assert!(!root_metadata.file_type().is_symlink(), "native video resource root link refused");
    #[cfg(windows)] {
        use std::os::windows::fs::MetadataExt;
        assert_eq!(root_metadata.file_attributes() & 0x400, 0, "native video resource root reparse point refused");
    }
    for entry in std::fs::read_dir(root).expect("native video resource directory") {
        let path = entry.expect("native video resource entry").path();
        let metadata = std::fs::symlink_metadata(&path).expect("native video resource metadata");
        assert!(!metadata.file_type().is_symlink(), "native video resource link refused");
        #[cfg(windows)] {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(metadata.file_attributes() & 0x400, 0, "native video resource reparse point refused");
        }
        if metadata.is_dir() { files_below(&path, base, files); }
        else {
            assert!(metadata.is_file(), "native video resource must be a regular file");
            let name = path.strip_prefix(base).unwrap().to_str().expect("native video UTF-8 resource name").replace('\\', "/");
            files.insert(name);
        }
    }
}

pub fn verify(manifest_dir: &Path, profile: &str) -> Option<(PathBuf, Vec<String>)> {
    let source = manifest_dir.join("native-video");
    println!("cargo:rerun-if-changed=native-video");
    if !source.exists() {
        assert_eq!(profile, "debug", "audited native player resources are required for release");
        return None;
    }
    let spec_path = manifest_dir.join("../third_party/native-video/manifest.json");
    println!("cargo:rerun-if-changed=../third_party/native-video/manifest.json");
    let expected = std::fs::read(spec_path).expect("native video source manifest");
    assert_eq!(std::fs::read(source.join("runtime-manifest.json")).expect("native video runtime manifest"), expected, "native video provenance mismatch");
    let spec: serde_json::Value = serde_json::from_slice(&expected).expect("native video manifest JSON");
    let mut names = vec!["runtime-manifest.json".to_string()];
    if spec["status"] == "local-development-only" {
        assert_eq!(profile, "debug", "unaudited development player cannot enter release");
        assert_eq!(spec["redistributionApproved"], false);
        names.extend(["libmpv-2.dll".into(), "README.md".into()]);
    } else {
        assert_eq!(spec["schemaVersion"], 2);
        assert_eq!(spec["status"], "audited-local-lgpl-build");
        assert_eq!(spec["redistributionApproved"], true);
        assert_eq!(spec["completeCorrespondingSource"], true);
        let inventory = spec["files"].as_object().expect("native video complete resource inventory");
        for name in ["libmpv-2.dll", "README.md", "LICENSES.md", "RELINK.zh-CN.md", "build-lgpl.sh", "sources.tar.xz", "SOURCE-INDEX.json", "BUILD-INFO.json", "licenses/mpv-LGPL-2.1.txt", "licenses/FFmpeg-LGPL-3.0.txt", "licenses/GPL-3.0.txt"] {
            assert!(inventory.contains_key(name), "native video required distribution material missing: {name}");
        }
        for (name, file) in inventory {
            assert!(safe_relative(name), "native video resource path invalid");
            let path = source.join(name);
            assert_eq!(std::fs::metadata(&path).expect("native video required material").len(), file["size"].as_u64().expect("native video material size"), "native video material size mismatch: {name}");
            assert_eq!(super::sha256_file(&path), file["sha256"].as_str().expect("native video material hash"), "native video material hash mismatch: {name}");
            names.push(name.clone());
        }
        let mut actual = BTreeSet::new();
        files_below(&source, &source, &mut actual);
        assert_eq!(actual, names.iter().cloned().collect(), "native video unlisted or missing resource");
    }
    let dll = source.join("libmpv-2.dll");
    assert_eq!(std::fs::metadata(&dll).expect("native video DLL").len(), spec["dll"]["size"].as_u64().unwrap());
    assert_eq!(super::sha256_file(&dll), spec["dll"]["sha256"].as_str().unwrap());
    Some((source, names))
}

pub fn stage(manifest_dir: &std::path::Path, profile: &str) {
    let Some((source, names)) = verify(manifest_dir, profile) else { return; };
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    let destination = output
        .ancestors()
        .nth(3)
        .expect("Cargo profile directory")
        .join("native-video");
    std::fs::create_dir_all(&destination).expect("native video dev resource directory");
    for name in names {
        let from = source.join(&name);
        let to = destination.join(&name);
        std::fs::create_dir_all(to.parent().expect("native video resource parent")).expect("native video resource subdirectory");
        if to.is_file() && super::sha256_file(&from) == super::sha256_file(&to) {
            continue;
        }
        assert!(
            !to.exists(),
            "native-video dev resource differs; preserve it and prepare explicitly while stopped"
        );
        std::fs::copy(from, to).expect("stage native video dev resource");
    }
}
