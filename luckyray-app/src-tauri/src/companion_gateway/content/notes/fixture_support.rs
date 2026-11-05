// Synthetic gateway tests may be rooted under a macOS system symlink. Resolve
// only their owned temporary directory; keep product path validation unchanged.
use crate::backend::BackendServices;
use std::path::{Path, PathBuf};

pub(crate) fn root(path: &Path) -> PathBuf {
    path.canonicalize()
        .unwrap_or_else(|_| panic!("macos-fixture-root-canonicalize"))
}

pub(crate) fn backend(path: &Path) -> BackendServices {
    BackendServices::initialize(path).unwrap_or_else(|error| {
        let code = match error.code {
            "backend-app-data-unavailable" => "macos-fixture-backend-app-data",
            "backend-media-transfer-unavailable" => "macos-fixture-backend-media-transfer",
            code if code.starts_with("knowledge-") => "macos-fixture-backend-knowledge",
            code if code.starts_with("tool-") => "macos-fixture-backend-tool",
            code if code.starts_with("backend-") => "macos-fixture-backend-storage",
            _ => "macos-fixture-backend-other",
        };
        // Do not print the error message, which may contain private paths.
        panic!("{code}")
    })
}

#[test]
fn canonical_fixture_root_does_not_weaken_link_rejection() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let base = root(temp.path());
    let real = base.join("real");
    std::fs::create_dir(&real).unwrap();
    let alias = base.join("alias");
    symlink(&real, &alias).unwrap();
    let rejected = match BackendServices::initialize(&alias.join("untrusted-app")) {
        Err(error) => error,
        Ok(_) => panic!("macos-fixture-linked-path-accepted"),
    };
    assert_eq!(rejected.code, "backend-media-transfer-unavailable");
    assert_eq!(root(&alias), real);
    let _backend = backend(&root(&alias).join("trusted-app"));
}
