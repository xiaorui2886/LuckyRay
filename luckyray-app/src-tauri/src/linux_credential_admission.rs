//! Prepare the app-owned private Linux data directory before desktop startup.
//! Actual credential reads/writes use the descriptor-relative credential store.

pub(crate) const UNAVAILABLE: &str = "linux-credential-storage-unavailable";

pub(crate) fn prepare(identifier: &str) -> Result<(), &'static str> {
    let path = crate::linux_app_data::app_data_dir(identifier).ok_or(UNAVAILABLE)?;
    crate::linux_fs::Directory::private(&path, true).map(|_| ()).map_err(|_| UNAVAILABLE)
}
