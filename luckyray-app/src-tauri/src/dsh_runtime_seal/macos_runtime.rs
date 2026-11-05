//! Source-reviewed Darwin arm64 closure and separately compiled native receipt.
//! Full byte checks run at admission/use boundaries; they are optimistic checks.
use super::macos_file::{check_file, hash, identity, Identity};
use super::*;
use crate::macos_fs::{require_empty_acl, Directory};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::sync::OnceLock;

const AUTHORITY: &[u8] = include_bytes!("../../macos-lsh-authority.json");
const AUTHORITY_SHA: &str = "eccb7ffb1abbd45d9cf0c7b9c9002970fb8914af41a469770f0c3572b33948a6";
const RECEIPT: &str = "macos-build.json";
const NODE: &str = "node/node";
const ENTRY: &str = "host/node_modules/@deepseek-ai/dsh/lib/bin.js";
const PACKAGE: &str = "host/node_modules/@deepseek-ai/dsh/package.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Closure {
    format: String,
    sha256: String,
    file_count: u64,
    directory_count: u64,
    byte_count: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Critical {
    kind: String,
    path: String,
    size: u64,
    executable: bool,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Package {
    name: String,
    version: String,
    tarball: String,
    registry_integrity: String,
    registry_sha1: String,
    sha256: String,
    size: u64,
    license: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NodeInput {
    version: String,
    archive: String,
    url: String,
    sha256: String,
    license_sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frozen {
    package_count: u64,
    tree_file_count: u64,
    tree_content_sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    path: String,
    authority: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authority {
    schema_version: u32,
    platform: String,
    architecture: String,
    runtime_package: Package,
    executable: String,
    entry_point: String,
    node_input: NodeInput,
    lockfile_sha256: String,
    frozen_package_closure: Frozen,
    closure: Closure,
    critical_files: Vec<Critical>,
    build_receipt: Receipt,
    source_material_index_sha256: String,
    provenance: String,
    node_code_directory_hashes: Vec<String>,
}
fn relative(value: &str) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > 1024
        || value.contains('\\')
        || value.bytes().any(|b| b < 32 || b == 127)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        Err(())
    } else {
        Ok(())
    }
}
fn authority() -> Result<&'static Authority, ()> {
    static DATA: OnceLock<Result<Authority, ()>> = OnceLock::new();
    DATA.get_or_init(|| {
        let a: Authority = serde_json::from_slice(AUTHORITY).map_err(|_| ())?;
        if a.schema_version != 1
            || a.platform != "darwin"
            || a.architecture != "arm64"
            || a.runtime_package.name != "@deepseek-ai/dsh"
            || a.runtime_package.version != "0.2.1-rc.3"
            || a.runtime_package.tarball
                != "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.3.tgz"
            || !a.runtime_package.registry_integrity.starts_with("sha512-")
            || a.runtime_package.registry_sha1.len() != 40
            || !exact_hex64(&a.runtime_package.sha256)
            || a.runtime_package.size == 0
            || a.runtime_package.license != "MIT"
            || a.executable != NODE
            || a.entry_point != ENTRY
            || a.build_receipt.path != RECEIPT
            || a.closure.format != "luckyray-macos-lsh-tree-v1"
            || !exact_hex64(&a.closure.sha256)
            || a.closure.file_count == 0
            || a.closure.file_count > 40000
            || a.closure.directory_count == 0
            || a.closure.directory_count > 40000
            || a.closure.byte_count > 8 * 1024 * 1024 * 1024
            || a.frozen_package_closure.package_count != 564
            || a.frozen_package_closure.tree_file_count != 35170
            || !exact_hex64(&a.frozen_package_closure.tree_content_sha256)
            || !exact_hex64(&a.lockfile_sha256)
            || !exact_hex64(&a.source_material_index_sha256)
            || a.node_input.version != "22.19.0"
            || a.node_input.archive != "node-v22.19.0-darwin-arm64.tar.gz"
            || a.node_input.url
                != "https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.gz"
            || a.node_input.sha256
                != "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d"
            || a.node_input.license_sha256
                != "e991d81497a85bb24fc6bffae0a3637a6accd6c6bc5ce1f2c5698bd555cf9d49"
            || a.node_code_directory_hashes.is_empty()
            || a.node_code_directory_hashes.len() > 4
            || a.node_code_directory_hashes.iter().any(|v| {
                v.len() != 40
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            || a.critical_files.len() != 4
            || a.provenance.is_empty()
            || a.build_receipt.authority.is_empty()
        {
            return Err(());
        }
        for (entry, path) in a
            .critical_files
            .iter()
            .zip([NODE, "node/LICENSE", ENTRY, PACKAGE])
        {
            if entry.kind != "file"
                || entry.path != path
                || !exact_hex64(&entry.sha256)
                || entry.size == 0
                || entry.size > 512 * 1024 * 1024
                || entry.executable != matches!(path, NODE | ENTRY)
            {
                return Err(());
            }
        }
        Ok(a)
    })
    .as_ref()
    .map_err(|_| ())
}
fn receipt_hash() -> Result<&'static str, ()> {
    let value = option_env!("LUCKYRAY_MACOS_BUILD_RECORD_SHA256").ok_or(())?;
    if exact_hex64(value) {
        Ok(value)
    } else {
        Err(())
    }
}
pub(super) fn verify_embedded(control: &RuntimeSealControl<'_>) -> Result<(), ()> {
    control.check()?;
    if !cfg!(target_arch = "aarch64") || hash_bytes(AUTHORITY, control)? != AUTHORITY_SHA {
        return Err(());
    }
    authority()?;
    receipt_hash()?;
    control.check()
}
pub(super) fn launch_identity() -> Result<RuntimeIdentity, ()> {
    let a = authority()?;
    Ok(RuntimeIdentity {
        executable: NODE.into(),
        entry_point: ENTRY.into(),
        node_exe_sha256: a.critical_files[0].sha256.clone(),
        entry_sha256: a.critical_files[2].sha256.clone(),
        package_version: a.runtime_package.version.clone(),
    })
}
pub(super) struct DirectoryLease {
    directory: Directory,
    object: Identity,
}
impl DirectoryLease {
    fn acquire(path: &Path) -> Result<Self, ()> {
        let directory = Directory::open_trusted(path).map_err(|_| ())?;
        let file = directory.identity_file().map_err(|_| ())?;
        let meta = file.metadata().map_err(|_| ())?;
        require_empty_acl(&file).map_err(|_| ())?;
        if meta.mode() & 0o7022 != 0
            || meta.mode() & 0o500 != 0o500
            || ![0, unsafe { libc::geteuid() }].contains(&meta.uid())
        {
            return Err(());
        }
        Ok(Self {
            directory,
            object: identity(&meta),
        })
    }
    fn revalidate(&self) -> Result<(), ()> {
        self.directory.current().map_err(|_| ())?;
        let file = self.directory.identity_file().map_err(|_| ())?;
        require_empty_acl(&file).map_err(|_| ())?;
        if identity(&file.metadata().map_err(|_| ())?) == self.object {
            Ok(())
        } else {
            Err(())
        }
    }
}
pub(crate) fn verify_closure(
    root: &Path,
    control: &RuntimeSealControl<'_>,
) -> Result<(), RuntimeSealError> {
    control.finish(scan(root, control, None).map(|_| ()))
}
pub(super) type Snapshot = BTreeMap<String, Identity>;
fn scan(
    root: &Path,
    control: &RuntimeSealControl<'_>,
    expected_snapshot: Option<&Snapshot>,
) -> Result<Snapshot, ()> {
    let mut snapshot = BTreeMap::new();
    let check_object = |path: &str, object: Identity| -> Result<(), ()> {
        if expected_snapshot.is_some_and(|old| old.get(path) != Some(&object)) {
            Err(())
        } else {
            Ok(())
        }
    };
    verify_embedded(control)?;
    let expected = &authority()?.closure;
    let root_lease = DirectoryLease::acquire(root)?;
    let mut rows = BTreeMap::new();
    let mut pending = vec![String::new()];
    let (mut files, mut directories, mut bytes, mut receipt) = (0u64, 0u64, 0u64, false);
    while let Some(path) = pending.pop() {
        control.progress(RuntimeSealProgress::RevalidateObject)?;
        let held = DirectoryLease::acquire(&root.join(&path))?;
        check_object(&path, held.object)?;
        if snapshot.insert(path.clone(), held.object).is_some() {
            return Err(());
        }
        if rows.insert(path.clone(), format!("D\0{path}\n")).is_some() {
            return Err(());
        }
        directories += 1;
        for name in held.directory.entries().map_err(|_| ())? {
            control.check()?;
            let text = name.to_str().ok_or(())?;
            let key = if path.is_empty() {
                text.into()
            } else {
                format!("{path}/{text}")
            };
            relative(&key)?;
            let named_path = root.join(&key);
            let observed = fs::symlink_metadata(&named_path).map_err(|_| ())?;
            if observed.file_type().is_symlink() {
                return Err(());
            }
            if observed.is_dir() {
                pending.push(key);
            } else {
                let file = held.directory.open_regular(&name).map_err(|_| ())?;
                let before = check_file(&file)?;
                if identity(&before) != identity(&observed) {
                    return Err(());
                }
                check_object(&key, identity(&before))?;
                if snapshot.insert(key.clone(), identity(&before)).is_some() {
                    return Err(());
                }
                let digest = hash(&file, control)?;
                let named = held.directory.open_regular(&name).map_err(|_| ())?;
                if identity(&check_file(&named)?) != identity(&before)
                    || identity(&check_file(&file)?) != identity(&before)
                {
                    return Err(());
                }
                if key == RECEIPT {
                    if receipt || digest != receipt_hash()? {
                        return Err(());
                    }
                    receipt = true;
                } else {
                    let row = format!(
                        "F\0{key}\0{}\0{}\0{digest}\n",
                        before.len(),
                        u8::from(before.mode() & 0o111 != 0)
                    );
                    if rows.insert(key, row).is_some() {
                        return Err(());
                    }
                    files += 1;
                    bytes = bytes.checked_add(before.len()).ok_or(())?;
                }
            }
        }
        held.revalidate()?;
        root_lease.revalidate()?;
        if files > expected.file_count
            || directories > expected.directory_count
            || bytes > expected.byte_count
            || pending.len() > 40000
            || rows.len() > 80000
        {
            return Err(());
        }
    }
    let mut digest = Sha256::new();
    digest.update(b"luckyray-macos-lsh-tree-v1\0");
    for row in rows.values() {
        control.check()?;
        digest.update(row.as_bytes());
    }
    if !receipt
        || files != expected.file_count
        || directories != expected.directory_count
        || bytes != expected.byte_count
        || format!("{:x}", digest.finalize()) != expected.sha256
    {
        return Err(());
    }
    root_lease.revalidate()?;
    control.check()?;
    if expected_snapshot.is_some_and(|old| old.len() != snapshot.len()) {
        return Err(());
    }
    Ok(snapshot)
}
pub(super) fn acquire(
    root: &Path,
    wanted: &RuntimeIdentity,
    control: &RuntimeSealControl<'_>,
) -> Result<RuntimeIdentityLease, RuntimeSealError> {
    let snapshot = control.finish(scan(root, control, None))?;
    control.finish((|| {
        let expected = launch_identity()?;
        if wanted.executable != expected.executable
            || wanted.entry_point != expected.entry_point
            || wanted.node_exe_sha256 != expected.node_exe_sha256
            || wanted.entry_sha256 != expected.entry_sha256
            || wanted.package_version != expected.package_version
        {
            return Err(());
        }
        let directories = [
            "",
            "node",
            "host",
            "host/node_modules",
            "host/node_modules/@deepseek-ai",
            "host/node_modules/@deepseek-ai/dsh",
            "host/node_modules/@deepseek-ai/dsh/lib",
        ]
        .iter()
        .map(|part| DirectoryLease::acquire(&root.join(part)))
        .collect::<Result<Vec<_>, _>>()?;
        let get = |path: &str, expected: &str| -> Result<StableFileLease, ()> {
            let file = macos_file::Lease::acquire_controlled(&root.join(path), control)?;
            if !file.matches_sha256(expected) {
                return Err(());
            }
            Ok(StableFileLease { macos: file })
        };
        let node = get(NODE, &expected.node_exe_sha256)?;
        let entry = get(ENTRY, &expected.entry_sha256)?;
        let package = get(PACKAGE, &authority()?.critical_files[3].sha256)?;
        let record = get(RECEIPT, receipt_hash()?)?;
        for (path, file) in [
            (NODE, &node),
            (ENTRY, &entry),
            (PACKAGE, &package),
            (RECEIPT, &record),
        ] {
            if snapshot.get(path) != Some(&file.macos.object_identity()) {
                return Err(());
            }
        }
        for (part, directory) in [
            "",
            "node",
            "host",
            "host/node_modules",
            "host/node_modules/@deepseek-ai",
            "host/node_modules/@deepseek-ai/dsh",
            "host/node_modules/@deepseek-ai/dsh/lib",
        ]
        .iter()
        .zip(&directories)
        {
            directory.revalidate()?;
            if snapshot.get(*part) != Some(&directory.object) {
                return Err(());
            }
        }
        Ok(RuntimeIdentityLease {
            directories: Vec::new(),
            node,
            entry,
            package,
            macos_directories: directories,
            macos_root: root.to_owned(),
            macos_record: record,
            macos_snapshot: snapshot,
        })
    })())
}
pub(super) fn revalidate(
    lease: &RuntimeIdentityLease,
    control: &RuntimeSealControl<'_>,
) -> Result<(), ()> {
    for directory in &lease.macos_directories {
        directory.revalidate()?;
    }
    for file in [
        &lease.node,
        &lease.entry,
        &lease.package,
        &lease.macos_record,
    ] {
        file.macos.revalidate_controlled(control)?;
    }
    scan(&lease.macos_root, control, Some(&lease.macos_snapshot))?;
    for directory in &lease.macos_directories {
        directory.revalidate()?;
    }
    for file in [
        &lease.node,
        &lease.entry,
        &lease.package,
        &lease.macos_record,
    ] {
        file.macos.revalidate_controlled(control)?;
    }
    control.check()
}

// The kernel's main-executable CodeDirectory hash closes the path-spawn
// replacement race before the parent challenge is given to the process.
pub(crate) fn verify_node_process(process: &crate::owned_process::OwnedProcess) -> Result<(), ()> {
    if process.matches_code_directory_hash(&authority()?.node_code_directory_hashes) {
        Ok(())
    } else {
        Err(())
    }
}
