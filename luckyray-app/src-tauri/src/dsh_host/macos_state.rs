//! Fixed private Mac LSH state, isolated from stock bundle resources.
use super::*;
use crate::macos_fs::Directory;
pub(super) const PROBE_PATCH: &[u8] = b"- id: session-title-llm\n  disabled: true\n";

pub(super) fn prepare_probe_patch(root: &Path) -> Result<(), ()> {
    let managed = root.join("managed-probe");
    Directory::open(&managed, true, true).map_err(|_| ())?;
    publish(
        &managed.join("luckyray-native-probe.patch.yml"),
        PROBE_PATCH,
    )
}

pub(super) fn resource_anchor(selected: &Path) -> Result<Directory, ()> {
    use std::os::unix::fs::MetadataExt;
    let executable = std::env::current_exe().map_err(|_| ())?;
    let expected =
        crate::macos_lsh_resource_path::resource_directory(&executable).map_err(|_| ())?;
    // Tauri canonicalizes its resource path. Bind that spelling to the actual
    // no-follow Contents/Resources object, including system firmlink spellings.
    let anchor = Directory::open_trusted(&expected).map_err(|_| ())?;
    let selected = Directory::open_trusted(selected).map_err(|_| ())?;
    let a = anchor
        .identity_file()
        .map_err(|_| ())?
        .metadata()
        .map_err(|_| ())?;
    let b = selected
        .identity_file()
        .map_err(|_| ())?
        .metadata()
        .map_err(|_| ())?;
    if (a.dev(), a.ino()) != (b.dev(), b.ino()) {
        return Err(());
    }
    anchor.current().map_err(|_| ())?;
    selected.current().map_err(|_| ())?;
    Ok(anchor)
}

pub(super) fn refuse_foreign_update_selection(app_data: &Path) -> Result<(), ()> {
    let root = app_data.join("dsh-engine-updates");
    match std::fs::symlink_metadata(&root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(()),
        Ok(_) => {}
    }
    let directory = Directory::open_owned(&root, false).map_err(|_| ())?;
    // Windows envelopes cannot authorize Darwin. Preserve unknown active or
    // interrupted selections rather than falling back over them to the bundle.
    if directory
        .entries()
        .map_err(|_| ())?
        .iter()
        .any(|name| name == "active.json" || name == "transaction.json")
    {
        return Err(());
    }
    directory.current().map_err(|_| ())
}
pub(super) fn prepare(app_data: &Path) -> Result<(PathBuf, PathBuf), ()> {
    let native = app_data.join("deepseek-harness/native-state");
    // Old closed Mac builds could create empty 0755 rc8 namespaces. Keep
    // those and Windows state untouched; first admitted Darwin writers get
    // new private leaves without chmod or implicit profile/source adoption.
    let root = native.join("macos-v1");
    let surface = native.join("macos-native-surface-v1");
    Directory::open(app_data, true, true).map_err(|_| ())?;
    Directory::open_owned(&native, true).map_err(|_| ())?;
    for path in [&root, &surface] {
        Directory::open(path, true, true).map_err(|_| ())?;
    }
    Ok((root, surface))
}
pub(super) fn publish(path: &Path, bytes: &[u8]) -> Result<(), ()> {
    let directory = Directory::open(path.parent().ok_or(())?, true, true).map_err(|_| ())?;
    let name = path.file_name().ok_or(())?;
    let before = directory.read_owned(name).map_err(|_| ())?;
    if let Some((old, _)) = &before {
        // A later source migration needs an explicit predecessor policy.
        // Unknown user edits are never deleted or overwritten here.
        let held = crate::dsh_runtime_seal::acquire_stable_file(path)?;
        if old != bytes {
            return Err(());
        }
        held.revalidate()?;
        return directory.current().map_err(|_| ());
    }
    crate::knowledge::macos_transactions::write(path, bytes, false, false, None, || {
        directory
            .current()
            .map_err(|_| crate::knowledge::KnowledgeError {
                code: "dsh-state-conflict",
                message: "LSH state directory changed".into(),
            })
    })
    .map_err(|_| ())?;
    let actual = directory.read_owned(name).map_err(|_| ())?.ok_or(())?;
    if actual.0 != bytes {
        return Err(());
    }
    crate::dsh_runtime_seal::acquire_stable_file(path)?.revalidate()
}
pub(super) fn environment(
    runtime: &Path,
    state: &Path,
    surface: &Path,
    patch: &Path,
) -> Result<Vec<(OsString, OsString)>, ()> {
    for path in [runtime, state, surface, patch] {
        if !path.is_absolute() {
            return Err(());
        }
    }
    Directory::open(state, false, true).map_err(|_| ())?;
    Directory::open(surface, false, true).map_err(|_| ())?;
    let home = state.join("home");
    let mut homes = Vec::new();
    // The wrapper and official web carrier have separate HOME roots. Prepare
    // both with the same no-follow/owner/mode/ACL rules before spawning; the
    // Mac carrier must not rely on Windows AppData folders or follow a link
    // while recursively creating its TMPDIR/configuration directories.
    for root in [home.as_path(), surface] {
        for part in ["", ".config", ".local/share", ".cache", ".tmp"] {
            homes.push(Directory::open(&root.join(part), true, true).map_err(|_| ())?);
        }
    }
    for directory in &homes {
        directory.current().map_err(|_| ())?;
    }
    let path = std::env::join_paths([
        runtime.join("node"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ])
    .map_err(|_| ())?;
    let mut values = vec![
        ("PATH".into(), path),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("HOME".into(), home.as_os_str().to_owned()),
        (
            "XDG_CONFIG_HOME".into(),
            home.join(".config").into_os_string(),
        ),
        (
            "XDG_DATA_HOME".into(),
            home.join(".local/share").into_os_string(),
        ),
        (
            "XDG_CACHE_HOME".into(),
            home.join(".cache").into_os_string(),
        ),
        ("TMPDIR".into(), home.join(".tmp").into_os_string()),
        (
            "LUCKYRAY_DSH_RUNTIME_ROOT".into(),
            runtime.as_os_str().to_owned(),
        ),
        (
            "LUCKYRAY_DSH_STATE_ROOT".into(),
            state.as_os_str().to_owned(),
        ),
        (
            "LUCKYRAY_DSH_NATIVE_SURFACE_HOME".into(),
            surface.as_os_str().to_owned(),
        ),
        (
            "LUCKYRAY_DSH_NATIVE_SURFACE_PATCH".into(),
            patch.as_os_str().to_owned(),
        ),
    ];
    project_deepseek_search_credential(&mut values, std::env::var_os("DEEPSEEK_API_KEY"));
    Ok(values)
}
