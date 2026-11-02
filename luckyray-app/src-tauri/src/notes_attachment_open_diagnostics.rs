//! Development-only, bounded evidence for the Linux "open attachment" click.
//!
//! Only closed enum codes, a content hash of the file handed to the opener and
//! a bounded duration ever leave this module. Never a path, file name, user
//! directory, credential or file content: the renderer sends closed codes, and
//! a caller-supplied path is used solely to compute the digest.
//!
//! The opener itself is launched through `tauri_plugin_opener`, which discards
//! the child `ExitStatus`, so an exit code is not observable here. That field
//! is therefore reported as `NOT_EXPOSED` rather than fabricated.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(crate) const ROUTES: [&str; 3] = ["NOTE_JUMP", "SYSTEM_OPEN", "MATERIAL_DETAIL"];
pub(crate) const STATUSES: [&str; 4] = [
    "NONE",
    "MATERIAL_OPENED",
    "MATERIAL_PREVIEW_PENDING",
    "MATERIAL_NOT_FOUND",
];
pub(crate) const OPENERS: [&str; 3] = ["NOT_ATTEMPTED", "LAUNCHED", "FAILED"];
const EXIT_CODE: &str = "NOT_EXPOSED";
const MAX_LINES: usize = 40;
const MAX_HASH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ELAPSED_MS: u128 = 60_000;

static RECORDED: AtomicUsize = AtomicUsize::new(0);

/// Records one sanitized attachment-open decision. Unknown codes are dropped
/// before anything reaches the log; the line count is bounded per process.
///
/// Nothing is recorded outside a Linux development build, and a caller-supplied
/// path is only read to compute the digest of an already-known target file.
pub(crate) fn record(route: &str, status: &str, opener: &str, target: Option<&Path>, elapsed_ms: Option<u128>) {
    if !ROUTES.contains(&route) || !STATUSES.contains(&status) || !OPENERS.contains(&opener) {
        return;
    }
    if !cfg!(all(debug_assertions, target_os = "linux")) {
        return;
    }
    let elapsed = elapsed_ms.unwrap_or(0).min(MAX_ELAPSED_MS);
    if RECORDED.fetch_add(1, Ordering::Relaxed) >= MAX_LINES {
        return;
    }
    let digest = match (opener, target) {
        ("NOT_ATTEMPTED", _) | (_, None) => "none".to_owned(),
        (_, Some(path)) => content_digest(path).unwrap_or_else(|| "none".to_owned()),
    };
    eprintln!(
        "[notes-attachment-open] route={route} status={status} opener={opener} exit={EXIT_CODE} sha256={digest} elapsedMs={elapsed}"
    );
}

fn content_digest(path: &Path) -> Option<String> {
    use sha2::Digest;
    use std::io::Read;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_HASH_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut digest = sha2::Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Some(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_codes_are_dropped_before_the_log() {
        for route in ["", "SYSTEM_OPEN ", "system_open", "../../etc/passwd"] {
            assert!(!ROUTES.contains(&route));
        }
        for status in ["", "opened", "MATERIAL_OPENED "] {
            assert!(!STATUSES.contains(&status));
        }
        for opener in ["", "launched", "SUCCESS"] {
            assert!(!OPENERS.contains(&opener));
        }
        record("SYSTEM_OPEN", "opened", "LAUNCHED", None, None);
        record("hunter2", "NONE", "NOT_ATTEMPTED", None, Some(1));
    }

    #[test]
    fn the_digest_is_a_content_hash_and_never_the_file_body() {
        let unique = format!(
            "luckyray-attachment-open-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        std::fs::create_dir(&directory).unwrap();
        let file = directory.join("synthetic note #100%.png");
        std::fs::write(&file, b"synthetic attachment body").unwrap();
        let digest = content_digest(&file).unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|character| character.is_ascii_hexdigit()));
        assert_ne!(digest, "synthetic attachment body");
        assert_eq!(content_digest(&directory), None);
        let missing = directory.join("absent.png");
        assert_eq!(content_digest(&missing), None);
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
}
