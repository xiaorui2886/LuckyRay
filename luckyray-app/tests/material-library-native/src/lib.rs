#![allow(dead_code, unused_imports)]
// Compiles the actual domain sources without starting Tauri or opening a profile.
#[path = "../../../src-tauri/src/favorites.rs"]
mod favorites;
#[path = "../../../src-tauri/src/materials/mod.rs"]
mod materials;
#[path = "../../../src-tauri/src/smart_folders.rs"]
mod smart_folders;
mod companion_gateway {
    pub(crate) mod content {
        // Only the transport's file-opening adapter is stubbed in this domain harness.
        // Catalog membership, all SQL, filesystem ownership, import/export are production code.
        pub(crate) fn open_resource(
            path: impl AsRef<std::path::Path>,
        ) -> std::io::Result<std::fs::File> {
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                options.share_mode(1 | 4);
            }
            options.open(path)
        }
    }
}
