//! Actual Linux npm/Node closure, authenticated by compiled byte pins.
//! Files are checked at use boundaries; this does not exclude same-user edits
//! during the running generation or contain escaped process descendants.
use super::*;
use crate::linux_fs::{Directory, Version};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::sync::OnceLock;

const AUTHORITY: &[u8] = include_bytes!("../../../dsh-host/linux-x64/runtime-authority.json");
const MANIFEST: &[u8] = include_bytes!("../../../dsh-host/linux-x64/runtime-manifest.json");
const AUDIT: &[u8] = include_bytes!("../../../dsh-host/linux-x64/dependency-audit.json");
const NOTICES: &[u8] = include_bytes!("../../../dsh-host/linux-x64/THIRD-PARTY-NOTICES.txt");
const AUTHORITY_HASH: &str = "061bb2e7f06419e9b67a53cbec90457e5e51222d1633e246cfa523eacced2db2";
const MANIFEST_HASH: &str = "3003363bf2f03a7c241dac8c15dc083b6a16f1fcb06662c176a19ce35bfc364e";
const AUDIT_HASH: &str = "6bdae5278832f87befaf343d2735c6d19118362933d16c4ee23b498ccde205f0";
const NOTICES_HASH: &str = "aaf953ce1bab3c5de84d3fc9363754d787093dfae26003390635852fae077880";
const NODE: &str = "node/node";
const ENTRY: &str = "host/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PACKAGE: &str = "host/node_modules/@deepseek-ai/dsh/package.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    name: String,
    version: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    bytes: u64,
    mode: u32,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    platform: String,
    architecture: String,
    libc: String,
    runtime_package: Package,
    executable: String,
    entry_point: String,
    file_count: usize,
    byte_count: u64,
    closure_sha256: String,
    files: Vec<Entry>,
}

pub(super) fn verify_embedded(control: &RuntimeSealControl<'_>) -> Result<(), ()> {
    if !cfg!(all(target_arch = "x86_64", target_env = "gnu")) { return Err(()); }
    for (bytes, expected) in [(AUTHORITY, AUTHORITY_HASH), (MANIFEST, MANIFEST_HASH),
        (AUDIT, AUDIT_HASH), (NOTICES, NOTICES_HASH)] {
        if hash_bytes(bytes, control)? != expected { return Err(()); }
    }
    Ok(())
}

fn relative_path(value: &str) -> Result<&Path, ()> {
    let path = Path::new(value);
    if value.is_empty() || value.len() > 1024 || value.contains('\\')
        || value.bytes().any(|byte| byte < 32 || byte == 127)
        || value.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || path.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        return Err(());
    }
    Ok(path)
}

fn manifest() -> Result<&'static Manifest, ()> {
    static VALUE: OnceLock<Result<Manifest, ()>> = OnceLock::new();
    VALUE.get_or_init(|| {
        let manifest: Manifest = serde_json::from_slice(MANIFEST).map_err(|_| ())?;
        if manifest.schema_version != 1 || manifest.platform != "linux" || manifest.architecture != "x64"
            || manifest.libc != "glibc" || manifest.runtime_package.name != "@deepseek-ai/dsh"
            || manifest.runtime_package.version != "0.2.1-rc.3" || manifest.executable != NODE
            || manifest.entry_point != ENTRY || manifest.file_count != manifest.files.len()
            || manifest.file_count == 0 || manifest.file_count > 40_000
            || manifest.byte_count > 2 * 1024 * 1024 * 1024 { return Err(()); }
        let mut digest = Sha256::new();
        let mut previous = "";
        let mut bytes = 0u64;
        for entry in &manifest.files {
            relative_path(&entry.path)?;
            if entry.path.as_str() <= previous || ![0o644, 0o755].contains(&entry.mode)
                || entry.bytes > 512 * 1024 * 1024 || !exact_hex64(&entry.sha256) { return Err(()); }
            digest.update(format!("{}\0{}\0{}\0{}\n", entry.path, entry.mode, entry.bytes, entry.sha256));
            previous = &entry.path;
            bytes = bytes.checked_add(entry.bytes).ok_or(())?;
        }
        if bytes != manifest.byte_count || format!("{:x}", digest.finalize()) != manifest.closure_sha256 {
            return Err(());
        }
        let authority: serde_json::Value = serde_json::from_slice(AUTHORITY).map_err(|_| ())?;
        if authority["platform"] != "linux" || authority["architecture"] != "x64" || authority["libc"] != "glibc"
            || authority["manifestSha256"] != MANIFEST_HASH || authority["packageAuditSha256"] != AUDIT_HASH
            || authority["noticesSha256"] != NOTICES_HASH
            || authority["closure"]["sha256"] != manifest.closure_sha256
            || authority["closure"]["fileCount"].as_u64() != Some(manifest.file_count as u64)
            || authority["closure"]["byteCount"].as_u64() != Some(manifest.byte_count) { return Err(()); }
        Ok(manifest)
    }).as_ref().map_err(|_| ())
}

pub(super) fn launch_identity() -> Result<RuntimeIdentity, ()> {
    let manifest = manifest()?;
    let get = |name: &str| manifest.files.iter().find(|entry| entry.path == name).ok_or(());
    Ok(RuntimeIdentity { executable: NODE.to_owned(), entry_point: ENTRY.to_owned(),
        node_exe_sha256: get(NODE)?.sha256.clone(), entry_sha256: get(ENTRY)?.sha256.clone(),
        package_version: manifest.runtime_package.version.clone() })
}

pub(super) struct DirectoryLease {
    directory: Directory,
    mode: u32,
    owner: u32,
}

impl DirectoryLease {
    fn acquire(path: &Path) -> Result<Self, ()> {
        let directory = Directory::open(path).map_err(|_| ())?;
        let metadata = directory.file.metadata().map_err(|_| ())?;
        crate::linux_fs::no_attributes(&directory.file).map_err(|_| ())?;
        if metadata.mode() & 0o7022 != 0 || metadata.mode() & 0o500 != 0o500
            || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid()) { return Err(()); }
        Ok(Self { directory, mode: metadata.mode(), owner: metadata.uid() })
    }

    fn revalidate(&self) -> Result<(), ()> {
        self.directory.verify().map_err(|_| ())?;
        let metadata = self.directory.file.metadata().map_err(|_| ())?;
        crate::linux_fs::no_attributes(&self.directory.file).map_err(|_| ())?;
        if metadata.mode() != self.mode || metadata.uid() != self.owner { return Err(()); }
        Ok(())
    }
}

fn verify_file(directory: &Directory, name: &std::ffi::OsStr, expected: &Entry,
    control: &RuntimeSealControl<'_>) -> Result<(), ()> {
    let mut file = directory.open_file(name, false).map_err(|_| ())?;
    let version = Version::of(&file).map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if metadata.len() != expected.bytes || metadata.mode() & 0o7777 != expected.mode
        || ![0, unsafe { libc::geteuid() }].contains(&metadata.uid()) { return Err(()); }
    crate::linux_fs::no_attributes(&file).map_err(|_| ())?;
    let mut digest = Sha256::new();
    let mut count = 0u64;
    let mut chunk = [0; 64 * 1024];
    loop {
        control.progress(RuntimeSealProgress::HashChunk)?;
        let length = file.read(&mut chunk).map_err(|_| ())?;
        if length == 0 { break; }
        count = count.checked_add(length as u64).ok_or(())?;
        if count > expected.bytes { return Err(()); }
        digest.update(&chunk[..length]);
    }
    if count != expected.bytes || format!("{:x}", digest.finalize()) != expected.sha256
        || Version::of(&file).map_err(|_| ())? != version { return Err(()); }
    crate::linux_fs::no_attributes(&file).map_err(|_| ())?;
    directory.verify_named(name, &file).map_err(|_| ())
}

pub(crate) fn verify_closure(root: &Path, control: &RuntimeSealControl<'_>) -> Result<(), RuntimeSealError> {
    let started = std::time::Instant::now();
    let result = control.finish((|| {
        verify_embedded(control)?;
        let manifest = manifest()?;
        let mut expected: BTreeMap<_, _> = manifest.files.iter().map(|entry| (entry.path.as_str(), entry)).collect();
        let mut directories = BTreeSet::from([String::new()]);
        for entry in &manifest.files {
            let mut path = relative_path(&entry.path)?.parent();
            while let Some(parent) = path {
                directories.insert(parent.to_str().ok_or(())?.to_owned());
                path = parent.parent();
            }
        }
        let mut pending = vec![String::new()];
        while let Some(relative) = pending.pop() {
            control.progress(RuntimeSealProgress::RevalidateObject)?;
            if !directories.remove(&relative) { return Err(()); }
            let held = DirectoryLease::acquire(&root.join(&relative))?;
            let entries = fs::read_dir(format!("/proc/self/fd/{}", held.directory.file.as_raw_fd())).map_err(|_| ())?;
            for item in entries {
                control.check()?;
                let item = item.map_err(|_| ())?;
                let name = item.file_name();
                let text = name.to_str().ok_or(())?;
                let path = if relative.is_empty() { text.to_owned() } else { format!("{relative}/{text}") };
                relative_path(&path)?;
                let kind = item.file_type().map_err(|_| ())?;
                if kind.is_dir() { pending.push(path); }
                else if kind.is_file() {
                    let expected = expected.remove(path.as_str()).ok_or(())?;
                    verify_file(&held.directory, &name, expected, control)?;
                } else { return Err(()); }
            }
            held.revalidate()?;
        }
        if !expected.is_empty() || !directories.is_empty() { return Err(()); }
        Ok(())
    })());
    eprintln!("dsh-stage linux-closure-check duration_ms={} ok={}", started.elapsed().as_millis(), result.is_ok());
    result
}

pub(super) fn acquire(root: &Path, identity: &RuntimeIdentity, control: &RuntimeSealControl<'_>)
    -> Result<RuntimeIdentityLease, RuntimeSealError> {
    verify_closure(root, control)?;
    control.finish((|| {
        if identity != &launch_identity()? { return Err(()); }
        let directories = ["", "node", "host", "host/node_modules", "host/node_modules/@deepseek-ai",
            "host/node_modules/@deepseek-ai/dsh", "host/node_modules/@deepseek-ai/dsh/lib"]
            .iter().map(|relative| DirectoryLease::acquire(&root.join(relative))).collect::<Result<Vec<_>, _>>()?;
        let node = acquire_stable_file(&root.join(NODE))?;
        let entry = acquire_stable_file(&root.join(ENTRY))?;
        let package = acquire_stable_file(&root.join(PACKAGE))?;
        let package_hash = &manifest()?.files.iter().find(|file| file.path == PACKAGE).ok_or(())?.sha256;
        if !node.linux.matches_sha256(&identity.node_exe_sha256)
            || !entry.linux.matches_sha256(&identity.entry_sha256)
            || !package.linux.matches_sha256(package_hash) { return Err(()); }
        for directory in &directories { directory.revalidate()?; }
        node.revalidate()?; entry.revalidate()?; package.revalidate()?;
        Ok(RuntimeIdentityLease { directories: Vec::new(), node, entry, package,
            linux_directories: directories, linux_root: root.to_owned() })
    })())
}

pub(super) fn revalidate(lease: &RuntimeIdentityLease, control: &RuntimeSealControl<'_>) -> Result<(), ()> {
    for directory in &lease.linux_directories { directory.revalidate()?; }
    lease.node.revalidate()?; lease.entry.revalidate()?; lease.package.revalidate()?;
    verify_closure(&lease.linux_root, control).map_err(|_| ())?;
    for directory in &lease.linux_directories { directory.revalidate()?; }
    lease.node.revalidate()?; lease.entry.revalidate()?; lease.package.revalidate()?;
    control.check()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_records_authenticate_the_actual_elf_and_complete_closure() {
        let cancelled = AtomicBool::new(false);
        verify_embedded(&RuntimeSealControl::new(&cancelled)).unwrap();
        let identity = launch_identity().unwrap();
        assert_eq!(identity.executable, "node/node");
        assert_eq!(identity.node_exe_sha256, "596b5144ff242737f1c1be6a5f0ccb3907dbba2482344143cb1a6898633402a9");
        let manifest = manifest().unwrap();
        assert_eq!(manifest.file_count, 34_491);
        assert_eq!(manifest.closure_sha256, "b5fe4c01567d650a1b2e21b36310b8127dd0df55afabe3041b8f5d529a9a27b5");
        for hostile in ["/escape", "../escape", "a/../b", "a//b", "a\\b", "a/./b", "a\0b"] {
            assert!(relative_path(hostile).is_err());
        }
        assert!(relative_path(ENTRY).is_ok());
    }

    #[test]
    fn linux_closure_checks_cancel_and_refuse_missing_resources() {
        let cancelled = AtomicBool::new(true);
        let root = tempfile::tempdir().unwrap();
        assert_eq!(verify_closure(root.path(), &RuntimeSealControl::new(&cancelled)), Err(RuntimeSealError::Cancelled));
        cancelled.store(false, Ordering::Release);
        assert_eq!(verify_closure(root.path(), &RuntimeSealControl::new(&cancelled)), Err(RuntimeSealError::Invalid));
    }

    #[test]
    fn linux_directory_lease_refuses_replacement_links_and_shared_writes() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("runtime");
        std::fs::create_dir(&target).unwrap();
        let held = DirectoryLease::acquire(&target).unwrap();
        std::fs::rename(&target, root.path().join("old")).unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(held.revalidate().is_err());
        std::fs::remove_dir(&target).unwrap();
        symlink(root.path().join("old"), &target).unwrap();
        assert!(DirectoryLease::acquire(&target).is_err());
        std::fs::remove_file(&target).unwrap();
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(DirectoryLease::acquire(&target).is_err());
    }
}
