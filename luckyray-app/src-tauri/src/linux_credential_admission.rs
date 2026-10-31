//! Linux credential-backed startup is unavailable until the required storage
//! and use-window guarantees have been implemented and reviewed.

pub(crate) const UNAVAILABLE: &str = "linux-credential-storage-unavailable";

pub(crate) fn require() -> Result<(), &'static str> {
    Err(UNAVAILABLE)
}
