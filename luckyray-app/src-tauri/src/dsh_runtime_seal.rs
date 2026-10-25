use sha2::{Digest, Sha256};
use std::cell::Cell;
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const AUTHORITY_BYTES: &[u8] = include_bytes!("../../dsh-host/runtime-authority.json");
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const AUDIT_BYTES: &[u8] = include_bytes!("../../dsh-host/records/dependency-audit.json");
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const LAUNCH_BYTES: &[u8] = include_bytes!("../../dsh-host/records/launch-manifest.json");
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const RUNTIME_BYTES: &[u8] = include_bytes!("../../dsh-host/records/runtime-manifest.json");

// Only the isolated debug fixture may compile the actual #182 old authority.
// A missing input fails compilation; changing its bytes fails the hashes below.
#[cfg(feature = "issue189-frozen-old-fixture")]
const AUTHORITY_BYTES: &[u8] = include_bytes!(concat!(env!("LUCKYRAY_ISSUE189_OLD_DSH_HOST"), "/runtime-authority.json"));
#[cfg(feature = "issue189-frozen-old-fixture")]
const AUDIT_BYTES: &[u8] = include_bytes!(concat!(env!("LUCKYRAY_ISSUE189_OLD_DSH_HOST"), "/records/dependency-audit.json"));
#[cfg(feature = "issue189-frozen-old-fixture")]
const LAUNCH_BYTES: &[u8] = include_bytes!(concat!(env!("LUCKYRAY_ISSUE189_OLD_DSH_HOST"), "/records/launch-manifest.json"));
#[cfg(feature = "issue189-frozen-old-fixture")]
const RUNTIME_BYTES: &[u8] = include_bytes!(concat!(env!("LUCKYRAY_ISSUE189_OLD_DSH_HOST"), "/records/runtime-manifest.json"));

#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const AUTHORITY_SHA256: &str = "cbbbf0816f2aba1c4688093d9d396f8c195115272aac31967e7a07a9fd5ef631";
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const AUDIT_SHA256: &str = "5666b72894239bff65f04987c83329116c75483880b5fe0eab1de7e1780d52e9";
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const LAUNCH_SHA256: &str = "59c6d8a84ae723e8eab7ff68b40459b5f7443aecd3d734395852087991472ff0";
#[cfg(not(feature = "issue189-frozen-old-fixture"))]
const RUNTIME_SHA256: &str = "caf9f28acedaefe2797d3c75c5954ff2fb53465f0a39685495b77c65b063927d";
#[cfg(feature = "issue189-frozen-old-fixture")]
const AUTHORITY_SHA256: &str = "c0c4b4bec0ce5b86f759b970c722f7fc82073cdbd678593ec03eaf61a4d49c04";
#[cfg(feature = "issue189-frozen-old-fixture")]
const AUDIT_SHA256: &str = "bdaeb7c2772128c41886ba1a530e577203e5762427a1376f0d682ac8838f689f";
#[cfg(feature = "issue189-frozen-old-fixture")]
const LAUNCH_SHA256: &str = "dc6ca459f37fa52f7182b2648af68c7c210c2b5cb536f3bbd4ae691dfb9d88d7";
#[cfg(feature = "issue189-frozen-old-fixture")]
const RUNTIME_SHA256: &str = "33837de4104030095abba18b6c86c4ddd3c52cf562b8a992689b826f00e70fba";

// Ordinary launch verifies signed critical identity only. Full dependency
// closure admission belongs to package preparation and activation.
const MAX_UNCHECKED_HASH_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeSealError {
    Cancelled,
    Invalid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RuntimeSealProgress {
    HashChunk,
    RevalidateObject,
}

pub(crate) struct RuntimeSealControl<'a> {
    cancelled: &'a AtomicBool,
    cancellation_observed: Cell<bool>,
    #[cfg(test)]
    observer: Option<&'a dyn Fn(RuntimeSealProgress)>,
}

impl<'a> RuntimeSealControl<'a> {
    pub(crate) fn new(cancelled: &'a AtomicBool) -> Self {
        Self {
            cancelled,
            cancellation_observed: Cell::new(false),
            #[cfg(test)]
            observer: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_observer(
        cancelled: &'a AtomicBool,
        observer: &'a dyn Fn(RuntimeSealProgress),
    ) -> Self {
        Self {
            cancelled,
            cancellation_observed: Cell::new(false),
            observer: Some(observer),
        }
    }

    fn progress(&self, progress: RuntimeSealProgress) -> Result<(), ()> {
        #[cfg(test)]
        if let Some(observer) = self.observer {
            observer(progress);
        }
        #[cfg(not(test))]
        let _ = progress;
        self.check()
    }

    fn finish<T>(&self, result: Result<T, ()>) -> Result<T, RuntimeSealError> {
        result.map_err(|_| {
            if self.cancellation_observed.get() || self.cancelled.load(Ordering::Acquire) {
                RuntimeSealError::Cancelled
            } else {
                RuntimeSealError::Invalid
            }
        })
    }

    fn check(&self) -> Result<(), ()> {
        if self.cancelled.load(Ordering::Acquire) {
            self.cancellation_observed.set(true);
            Err(())
        } else {
            Ok(())
        }
    }
}

struct WindowsObjectIdentity {
    volume_serial: u32,
    file_index: u64,
    links: u32,
    attributes: u32,
}

#[cfg(windows)]
struct LockedRuntimeObject {
    path: PathBuf,
    handle: File,
    identity: WindowsObjectIdentity,
    regular_file: bool,
}

/// Backend-only proof that the accepted DSH-0 tree is still the exact set of
/// filesystem objects opened by Node/DSH. Handles are non-inheritable and deny
/// write/delete sharing for the entire outer-host + native-probe use window.
fn lock_runtime_object(
    path: &Path,
    regular_file: bool,
    backup_semantics: bool,
    require_single_link: bool,
) -> Result<LockedRuntimeObject, ()> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;

    const FILE_SHARE_READ: u32 = 0x0000_0001;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const HANDLE_FLAG_INHERIT: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetHandleInformation(handle: *mut std::ffi::c_void, flags: *mut u32) -> i32;
    }

    let mut flags = FILE_FLAG_OPEN_REPARSE_POINT;
    if backup_semantics {
        flags |= FILE_FLAG_BACKUP_SEMANTICS;
    }
    let handle = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(flags)
        .open(path)
        .map_err(|_| ())?;
    let mut handle_flags = 0u32;
    if unsafe { GetHandleInformation(handle.as_raw_handle(), &mut handle_flags) } == 0
        || handle_flags & HANDLE_FLAG_INHERIT != 0
    {
        return Err(());
    }
    let identity = windows_object_identity(&handle)?;
    if require_single_link && regular_file && identity.links != 1 {
        return Err(());
    }
    Ok(LockedRuntimeObject {
        path: path.to_path_buf(),
        handle,
        identity,
        regular_file,
    })
}

#[cfg(windows)]
fn windows_object_identity(file: &File) -> Result<WindowsObjectIdentity, ()> {
    use std::os::windows::io::AsRawHandle;

    #[repr(C)]
    struct FileTime {
        low_date_time: u32,
        high_date_time: u32,
    }
    #[repr(C)]
    struct ByHandleFileInformation {
        file_attributes: u32,
        creation_time: FileTime,
        last_access_time: FileTime,
        last_write_time: FileTime,
        volume_serial_number: u32,
        file_size_high: u32,
        file_size_low: u32,
        number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            file: *mut std::ffi::c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
    }

    let mut information = std::mem::MaybeUninit::<ByHandleFileInformation>::zeroed();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), information.as_mut_ptr()) } == 0 {
        return Err(());
    }
    let information = unsafe { information.assume_init() };
    Ok(WindowsObjectIdentity {
        volume_serial: information.volume_serial_number,
        file_index: ((information.file_index_high as u64) << 32)
            | information.file_index_low as u64,
        links: information.number_of_links,
        attributes: information.file_attributes,
    })
}

#[cfg(windows)]
fn revalidate_locked_object(
    object: &LockedRuntimeObject,
    control: &RuntimeSealControl<'_>,
) -> Result<(), ()> {
    control.check()?;
    let held = windows_object_identity(&object.handle)?;
    control.check()?;
    if held.volume_serial != object.identity.volume_serial
        || held.file_index != object.identity.file_index
        || held.attributes != object.identity.attributes
        || (object.regular_file && held.links != 1)
    {
        return Err(());
    }
    control.check()?;
    let reopened =
        lock_runtime_object(&object.path, object.regular_file, !object.regular_file, true)?;
    control.progress(RuntimeSealProgress::RevalidateObject)?;
    if reopened.identity.volume_serial != object.identity.volume_serial
        || reopened.identity.file_index != object.identity.file_index
        || reopened.identity.attributes != object.identity.attributes
    {
        return Err(());
    }
    Ok(())
}

pub(crate) struct StableFileLease {
    #[cfg(windows)]
    object: LockedRuntimeObject,
}

impl StableFileLease {
    pub(crate) fn revalidate(&self) -> Result<(), ()> {
        #[cfg(windows)]
        {
            let cancelled = AtomicBool::new(false);
            let control = RuntimeSealControl::new(&cancelled);
            revalidate_locked_object(&self.object, &control)
        }
        #[cfg(not(windows))]
        {
            Err(())
        }
    }
}

pub(crate) fn acquire_stable_file(path: &Path) -> Result<StableFileLease, ()> {
    #[cfg(windows)]
    {
        Ok(StableFileLease {
            object: lock_runtime_object(path, true, false, true)?,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(())
    }
}

#[cfg(windows)]
fn verify_record_seal(control: &RuntimeSealControl<'_>) -> Result<(), ()> {
    for (bytes, expected) in [
        (AUTHORITY_BYTES, AUTHORITY_SHA256),
        (AUDIT_BYTES, AUDIT_SHA256),
        (LAUNCH_BYTES, LAUNCH_SHA256),
        (RUNTIME_BYTES, RUNTIME_SHA256),
    ] {
        control.check()?;
        let normalized = normalize_tracked_record(bytes)?;
        if hash_bytes(&normalized, control)? != expected {
            return Err(());
        }
    }
    Ok(())
}

fn normalize_tracked_record(bytes: &[u8]) -> Result<Vec<u8>, ()> {
    let source = std::str::from_utf8(bytes).map_err(|_| ())?;
    if source.starts_with('\u{feff}') {
        return Err(());
    }
    let normalized = source.replace("\r\n", "\n");
    if normalized.contains('\r') {
        return Err(());
    }
    Ok(normalized.into_bytes())
}

/// Runtime identity projected from the compile-time DSH-0 records. Ordinary
/// launches verify only the two critical entries (node.exe and the dsh
/// entrypoint); the full staged-closure verification stays on the
/// prepare/install path (scripts/dsh-supply-chain.mjs behind
/// prepare-dsh-runtime.ps1's double gate).
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub(crate) struct RuntimeIdentity {
    pub(crate) executable: String,
    pub(crate) entry_point: String,
    pub(crate) node_exe_sha256: String,
    pub(crate) entry_sha256: String,
    pub(crate) package_version: String,
}

fn exact_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn runtime_identity_from_records() -> Result<RuntimeIdentity, ()> {
    let launch: serde_json::Value = serde_json::from_slice(LAUNCH_BYTES).map_err(|_| ())?;
    let runtime: serde_json::Value = serde_json::from_slice(RUNTIME_BYTES).map_err(|_| ())?;
    let executable = launch["executable"].as_str().ok_or(())?;
    let entry_point = launch["entryPoint"].as_str().ok_or(())?;
    let entry_sha256 = launch["entryPointAuthority"]["fileSha256"]
        .as_str()
        .ok_or(())?;
    let expected_version = launch["capabilityProbe"]["expectedStdout"]
        .as_str()
        .ok_or(())?;
    let package_version = runtime["runtimePackage"]["version"].as_str().ok_or(())?;
    let node_exe_sha256 = runtime["nodeRuntime"]["nodeExeSha256"].as_str().ok_or(())?;
    if executable != "node/node.exe"
        || entry_point != "host/node_modules/@deepseek-ai/dsh/lib/bin.js"
        || expected_version != package_version
        || !exact_hex64(entry_sha256)
        || !exact_hex64(node_exe_sha256)
    {
        return Err(());
    }
    Ok(RuntimeIdentity {
        executable: executable.to_owned(),
        entry_point: entry_point.to_owned(),
        node_exe_sha256: node_exe_sha256.to_owned(),
        entry_sha256: entry_sha256.to_owned(),
        package_version: package_version.to_owned(),
    })
}

#[cfg(windows)]
pub(crate) fn bundled_runtime_version() -> Option<String> {
    let cancelled = AtomicBool::new(false);
    let control = RuntimeSealControl::new(&cancelled);
    verify_record_seal(&control).ok()?;
    runtime_identity_from_records().ok().map(|identity| identity.package_version)
}

#[cfg(not(windows))]
pub(crate) fn bundled_runtime_version() -> Option<String> { None }

fn identity_path(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(());
        }
        path.push(component);
    }
    Ok(path)
}

/// One descriptor's critical launch identity. Handles pin the fixed ancestor
/// chain and critical files until the descriptor is dropped. Reuse checks file
/// IDs and link counts, not timestamps. This does NOT authenticate secondary
/// dependencies or prevent their modification after install-time admission.
pub(crate) struct RuntimeIdentityLease {
    directories: Vec<StableFileLease>,
    node: StableFileLease,
    entry: StableFileLease,
    package: StableFileLease,
}

impl std::fmt::Debug for RuntimeIdentityLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Descriptor debug must not expose private handles or filesystem paths.
        formatter.debug_struct("RuntimeIdentityLease").finish_non_exhaustive()
    }
}

impl RuntimeIdentityLease {
    pub(crate) fn acquire(root: &Path, control: &RuntimeSealControl<'_>) -> Result<Self, RuntimeSealError> {
        control.finish(verify_record_seal(control))?;
        let identity = control.finish(runtime_identity_from_records())?;
        Self::acquire_identity(root, &identity, control)
    }

    /// The caller supplies an identity from embedded records or an already
    /// signature/compatibility-verified installed envelope, never local JSON.
    pub(crate) fn acquire_identity(
        root: &Path,
        identity: &RuntimeIdentity,
        control: &RuntimeSealControl<'_>,
    ) -> Result<Self, RuntimeSealError> {
        let started = std::time::Instant::now();
        let result = control.finish((|| -> Result<Self, ()> {
            if !root.is_absolute() || identity.executable != "node/node.exe"
                || identity.entry_point != "host/node_modules/@deepseek-ai/dsh/lib/bin.js"
                || !exact_hex64(&identity.node_exe_sha256) || !exact_hex64(&identity.entry_sha256) {
                return Err(());
            }
            // Fixed-size chain, never read_dir: reject and pin reparse/rename
            // pivots before opening a descendant. No broad dependency lease.
            let mut directories = Vec::new();
            for relative in ["", "node", "host", "host/node_modules",
                "host/node_modules/@deepseek-ai", "host/node_modules/@deepseek-ai/dsh",
                "host/node_modules/@deepseek-ai/dsh/lib"] {
                control.check()?;
                let path = if relative.is_empty() { root.to_path_buf() }
                    else { identity_path(root, relative)? };
                let metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
                if !metadata.is_dir() || is_link_or_reparse(&metadata) { return Err(()); }
                #[cfg(windows)]
                {
                    let object = lock_runtime_object(&path, false, true, false)?;
                    if object.identity.attributes & 0x400 != 0 { return Err(()); }
                    directories.push(StableFileLease { object });
                }
                #[cfg(not(windows))]
                { return Err(()); }
            }
            let node_path = identity_path(root, &identity.executable)?;
            let entry_path = identity_path(root, &identity.entry_point)?;
            let package_path = identity_path(root, "host/node_modules/@deepseek-ai/dsh/package.json")?;
            let node = acquire_stable_file(&node_path)?;
            let entry = acquire_stable_file(&entry_path)?;
            let package = acquire_stable_file(&package_path)?;
            let metadata = fs::symlink_metadata(&package_path).map_err(|_| ())?;
            if !safe_file(&node_path) || !safe_file(&entry_path) || !safe_file(&package_path)
                || metadata.len() > 64 * 1024 { return Err(()); }
            control.check()?;
            let value: serde_json::Value = serde_json::from_slice(
                &fs::read(&package_path).map_err(|_| ())?).map_err(|_| ())?;
            if value["name"].as_str() != Some("@deepseek-ai/dsh")
                || value["version"].as_str() != Some(identity.package_version.as_str())
                || hash_file(&node_path, control)? != identity.node_exe_sha256
                || hash_file(&entry_path, control)? != identity.entry_sha256 {
                return Err(());
            }
            let lease = Self { directories, node, entry, package };
            lease.revalidate_inner(control)?;
            Ok(lease)
        })());
        // Only stage/duration/outcome, never paths, credentials or user data.
        eprintln!("dsh-stage critical-launch-check duration_ms={} ok={}",
            started.elapsed().as_millis(), result.is_ok());
        result
    }

    fn revalidate_inner(&self, control: &RuntimeSealControl<'_>) -> Result<(), ()> {
        control.check()?;
        #[cfg(windows)]
        {
            for directory in &self.directories {
                revalidate_locked_object(&directory.object, control)?;
            }
            revalidate_locked_object(&self.package.object, control)?;
            revalidate_locked_object(&self.node.object, control)?;
            revalidate_locked_object(&self.entry.object, control)?;
            control.check()
        }
        #[cfg(not(windows))]
        { Err(()) }
    }

    pub(crate) fn revalidate(&self, control: &RuntimeSealControl<'_>) -> Result<(), RuntimeSealError> {
        control.finish(self.revalidate_inner(control))
    }
}

/// Fast launch-time check: embedded records are intact and the two critical
/// staged entries match the frozen DSH-0 identity. Any mismatch fails closed
/// so callers can surface an actionable runtime-verify/reinstall state; the
/// full closure re-verification belongs to prepare/install/upgrade only.
pub(crate) fn verify_runtime_identity(
    root: &Path,
    control: &RuntimeSealControl<'_>,
) -> Result<RuntimeIdentity, RuntimeSealError> {
    let run = || -> Result<RuntimeIdentity, ()> {
        verify_record_seal(control)?;
        let identity = runtime_identity_from_records()?;
        let node_path = identity_path(root, &identity.executable)?;
        let entry_path = identity_path(root, &identity.entry_point)?;
        if !safe_file(&node_path) || !safe_file(&entry_path) {
            return Err(());
        }
        if hash_file(&node_path, control)? != identity.node_exe_sha256
            || hash_file(&entry_path, control)? != identity.entry_sha256
        {
            return Err(());
        }
        Ok(identity)
    };
    control.finish(run())
}

fn safe_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| {
            metadata.is_file() && !is_link_or_reparse(&metadata) && regular_file_has_one_link(path)
        })
        .unwrap_or(false)
}

#[cfg(windows)]
fn regular_file_has_one_link(path: &Path) -> bool {
    lock_runtime_object(path, true, false, true)
        .map(|object| object.identity.links == 1)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn regular_file_has_one_link(_path: &Path) -> bool {
    false
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        true
    }
}

fn hash_file(path: &Path, control: &RuntimeSealControl<'_>) -> Result<String, ()> {
    control.check()?;
    let mut file = File::open(path).map_err(|_| ())?;
    control.check()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; MAX_UNCHECKED_HASH_BYTES];
    loop {
        control.check()?;
        let read = file.read(&mut buffer).map_err(|_| ())?;
        control.progress(RuntimeSealProgress::HashChunk)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn hash_bytes(bytes: &[u8], control: &RuntimeSealControl<'_>) -> Result<String, ()> {
    let mut digest = Sha256::new();
    for chunk in bytes.chunks(MAX_UNCHECKED_HASH_BYTES) {
        control.check()?;
        digest.update(chunk);
        control.progress(RuntimeSealProgress::HashChunk)?;
    }
    control.check()?;
    Ok(format!("{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frozen_dsh0_record_seal_is_exact() {
        let cancelled = AtomicBool::new(false);
        let control = RuntimeSealControl::new(&cancelled);
        verify_record_seal(&control).unwrap();
    }

    #[test]
    fn runtime_identity_from_records_matches_the_frozen_dsh0_authority() {
        let identity = runtime_identity_from_records().unwrap();
        assert_eq!(identity.executable, "node/node.exe");
        assert_eq!(
            identity.entry_point,
            "host/node_modules/@deepseek-ai/dsh/lib/bin.js"
        );
        assert_eq!(identity.package_version, if cfg!(feature = "issue189-frozen-old-fixture") {
            "0.1.5-rc.2"
        } else { "0.2.1-rc.2" });
        assert_eq!(
            identity.node_exe_sha256,
            "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362"
        );
        assert_eq!(
            identity.entry_sha256,
            if cfg!(feature = "issue189-frozen-old-fixture") {
                "0ff7f1d72c4e0cbe14001709c81e20a04b70464118a7f78568952988e28f2ac5"
            } else {
                "80112efe368efb1a39720c7ada0af00442e5131fb2744edaaff8a3e8bb499e6f"
            }
        );
    }

    #[test]
    fn identity_check_fails_closed_for_missing_and_tampered_entries() {
        let cancelled = AtomicBool::new(false);
        let control = RuntimeSealControl::new(&cancelled);
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-identity-hostile-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(
            verify_runtime_identity(&root, &control),
            Err(RuntimeSealError::Invalid)
        );
        let entry_dir = root
            .join("host")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib");
        std::fs::create_dir_all(root.join("node")).unwrap();
        std::fs::create_dir_all(&entry_dir).unwrap();
        std::fs::write(root.join("node").join("node.exe"), b"tampered-node").unwrap();
        std::fs::write(entry_dir.join("bin.js"), b"tampered-entry").unwrap();
        assert_eq!(
            verify_runtime_identity(&root, &control),
            Err(RuntimeSealError::Invalid)
        );
        assert!(identity_path(&root, "../escape").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn identity_check_is_cancellable() {
        let cancelled = AtomicBool::new(true);
        let control = RuntimeSealControl::new(&cancelled);
        let root = std::env::temp_dir().join("luckyray-dsh-identity-cancelled");
        assert_eq!(
            verify_runtime_identity(&root, &control),
            Err(RuntimeSealError::Cancelled)
        );
    }

    #[test]
    #[ignore = "requires the exact verified DSH-0 runtime fixture"]
    fn exact_stage_passes_identity_check() {
        let root = PathBuf::from(std::env::var_os("DSH_TEST_RUNTIME_ROOT").unwrap());
        let cancelled = AtomicBool::new(false);
        let control = RuntimeSealControl::new(&cancelled);
        let started = std::time::Instant::now();
        let identity = verify_runtime_identity(&root, &control).unwrap();
        let elapsed = started.elapsed();
        assert_eq!(identity.package_version, if cfg!(feature = "issue189-frozen-old-fixture") {
            "0.1.5-rc.2"
        } else { "0.2.1-rc.2" });
        eprintln!(
            "runtime identity check took {:?} (two critical entries; full closure stays on prepare/install)",
            elapsed
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the exact frozen DSH_TEST_RUNTIME_ROOT; copies critical files into temporary state"]
    fn bundled_identity_lease_retains_verified_bytes_and_releases_on_drop() {
        let input = PathBuf::from(std::env::var_os("DSH_TEST_RUNTIME_ROOT").unwrap());
        let copy = tempfile::tempdir().unwrap();
        let identity = runtime_identity_from_records().unwrap();
        for relative in [identity.executable.as_str(), identity.entry_point.as_str(),
            "host/node_modules/@deepseek-ai/dsh/package.json"] {
            let output = identity_path(copy.path(), relative).unwrap();
            fs::create_dir_all(output.parent().unwrap()).unwrap();
            fs::copy(identity_path(&input, relative).unwrap(), output).unwrap();
        }
        let cancel = AtomicBool::new(false);
        let control = RuntimeSealControl::new(&cancel);
        let lease = RuntimeIdentityLease::acquire(copy.path(), &control).unwrap();
        let entry = identity_path(copy.path(), &identity.entry_point).unwrap();
        assert!(fs::write(&entry, b"replacement").is_err());
        assert!(fs::remove_file(&entry).is_err());
        lease.revalidate(&control).unwrap();
        cancel.store(true, Ordering::Release);
        assert_eq!(lease.revalidate(&control), Err(RuntimeSealError::Cancelled));
        cancel.store(false, Ordering::Release);
        drop(lease);
        fs::write(&entry, b"replacement").unwrap();
        assert!(RuntimeIdentityLease::acquire(copy.path(), &control).is_err(), "new descriptor hashes changed bytes again");
    }

    #[cfg(windows)]
    #[test]
    fn stable_file_lease_denies_alias_write_and_replacement_until_drop() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-dsh-stable-lease-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("tracked.mjs");
        fs::write(&file, b"tracked").unwrap();
        let lease = acquire_stable_file(&file).unwrap();
        assert!(fs::write(&file, b"hostile").is_err());
        assert!(fs::remove_file(&file).is_err());
        lease.revalidate().unwrap();
        drop(lease);
        let _ = fs::remove_dir_all(&root);
    }
}
