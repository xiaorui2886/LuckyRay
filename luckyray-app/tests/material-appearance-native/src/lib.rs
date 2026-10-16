#![allow(dead_code, unused_imports)]
// Actual Catalog/library/appearance/command modules; transport and Tauri are excluded.
#[path = "../../../src-tauri/src/favorites.rs"] mod favorites;
#[path = "../../../src-tauri/src/smart_folders.rs"] mod smart_folders;
mod materials;
mod companion_gateway {
    pub(crate) mod content {
        // File handle adapter only; membership and physical-file ownership are actual Catalog code.
        pub(crate) fn open_resource(path:impl AsRef<std::path::Path>)->std::io::Result<std::fs::File> {
            let mut options=std::fs::OpenOptions::new();options.read(true);
            #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1|4);}
            options.open(path)
        }
    }
}
