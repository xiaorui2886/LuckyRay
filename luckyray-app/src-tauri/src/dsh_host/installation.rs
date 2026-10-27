//! Installed resources are selected only from the compiled, installer-owned
//! slot. Legacy flat directories and retained backups are never fallback code.
use super::*;

pub(crate) const BUNDLE_SLOT: &str = "lr-lsh/199-1";

pub(super) fn resource_roots(resource_dir: &Path) -> Result<(PathBuf, PathBuf), ()> {
    let slot = resource_dir.join(BUNDLE_SLOT);
    let runtime = slot.join("deepseek-harness");
    let host = slot.join("dsh-host");
    if !safe_directory(&resource_dir.join("lr-lsh")) || !safe_directory(&slot) || !safe_directory(&runtime) || !safe_directory(&host) { return Err(()); }
    Ok((runtime, host))
}

pub(super) fn surface_assets(host: &Path) -> [PathBuf; 16] {
    [
        host.join("luckyray-dsh-authenticated-webserver/index.mjs"),
        host.join("luckyray-dsh-resource-tools/index.mjs"),
        host.join("luckyray-dsh-resource-tools/luckyray-dsh-resource-tools.json"),
        host.join("luckyray-dsh-native-surface.patch.yml"),
        host.join("luckyray-dsh-native-surface-state/package.json"),
        host.join("luckyray-dsh-native-surface-state/client.js"),
        host.join("luckyray-dsh-lightseek-ui/package.json"),
        host.join("luckyray-dsh-lightseek-ui/client.js"),
        host.join("luckyray-dsh-lightseek-ui/lightseek-cosmic-home.webp"),
        host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-provider-export.mjs"),
        host.join("luckyray-dsh-authenticated-webserver/package.json"),
        host.join("luckyray-dsh-resource-tools/package.json"),
        host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-agent.mjs"),
        host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-projection.mjs"),
        host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-task-state.mjs"),
        host.join("luckyray-dsh-authenticated-webserver/luckyray-dsh-canvas-creation-schema.mjs"),
    ]
}

pub(crate) fn verify_installation(resource_dir: &Path) -> Result<(), &'static str> {
    let (runtime, host) = resource_roots(resource_dir).map_err(|_| "dsh-installation-layout-invalid")?;
    let wrapper = host.join("luckyray-dsh-host.mjs");
    if !safe_regular_file(&wrapper) || hash_normalized_host_script(&wrapper).ok().as_deref() != Some(HOST_SCRIPT_SHA256) {
        return Err("dsh-installation-wrapper-invalid");
    }
    verify_host_compat_script(&wrapper).map_err(|_| "dsh-installation-compat-invalid")?;
    verify_surface_assets(&surface_assets(&host)).map_err(|_| "dsh-installation-surface-invalid")?;
    verify_host_tree(&host).map_err(|_| "dsh-installation-host-tree-invalid")?;
    let identity = crate::dsh_runtime_seal::bundled_runtime_identity().map_err(|_| "dsh-installation-authority-invalid")?;
    crate::dsh_engine_update::verify_bundled_runtime_closure(&identity, &runtime)
        .map_err(|_| "dsh-installation-closure-invalid")
}

pub(super) fn verify_host_tree(host: &Path) -> Result<(), ()> {
    let mut expected: std::collections::BTreeSet<_> = surface_assets(host).into_iter().collect();
    expected.insert(host.join("luckyray-dsh-host.mjs"));
    expected.insert(host.join(HOST_COMPAT_SCRIPT));
    let mut directories: std::collections::BTreeSet<_> = expected.iter().filter_map(|path| path.parent().map(Path::to_path_buf)).collect();
    directories.insert(host.to_path_buf());
    let mut pending = vec![host.to_path_buf()];
    while let Some(directory) = pending.pop() {
        if !safe_directory(&directory) { return Err(()); }
        for item in std::fs::read_dir(directory).map_err(|_| ())? {
            let path = item.map_err(|_| ())?.path();
            if safe_directory(&path) {
                if !directories.contains(&path) { return Err(()); }
                pending.push(path);
            } else if !safe_regular_file(&path) || !expected.remove(&path) { return Err(()); }
        }
    }
    if expected.is_empty() { Ok(()) } else { Err(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_and_backup_trees_never_become_an_installed_resource_fallback() {
        let root = tempfile::tempdir().unwrap();
        for name in ["deepseek-harness", "dsh-host", "lr-lsh/199-1.saved-1/deepseek-harness", "lr-lsh/199-1.saved-1/dsh-host"] {
            std::fs::create_dir_all(root.path().join(name)).unwrap();
        }
        assert!(resource_roots(root.path()).is_err());
        std::fs::create_dir_all(root.path().join(BUNDLE_SLOT).join("deepseek-harness")).unwrap();
        std::fs::create_dir_all(root.path().join(BUNDLE_SLOT).join("dsh-host")).unwrap();
        let (runtime, host) = resource_roots(root.path()).unwrap();
        assert_eq!(runtime, root.path().join(BUNDLE_SLOT).join("deepseek-harness"));
        assert_eq!(host, root.path().join(BUNDLE_SLOT).join("dsh-host"));
        assert_eq!(verify_installation(root.path()), Err("dsh-installation-wrapper-invalid"));
    }

    #[test]
    fn the_selected_host_rejects_missing_extra_and_unlisted_empty_directories() {
        let root = tempfile::tempdir().unwrap();
        let host = root.path();
        let mut files = surface_assets(host).to_vec();
        files.extend([host.join("luckyray-dsh-host.mjs"), host.join(HOST_COMPAT_SCRIPT)]);
        for file in &files { std::fs::create_dir_all(file.parent().unwrap()).unwrap(); std::fs::write(file, b"synthetic-structure-only").unwrap(); }
        assert!(verify_host_tree(host).is_ok());
        std::fs::write(host.join("legacy.mjs"), b"synthetic").unwrap();
        assert!(verify_host_tree(host).is_err());
        std::fs::remove_file(host.join("legacy.mjs")).unwrap();
        std::fs::create_dir(host.join("node_modules")).unwrap();
        assert!(verify_host_tree(host).is_err());
        std::fs::remove_dir(host.join("node_modules")).unwrap();
        std::fs::remove_file(&files[0]).unwrap();
        assert!(verify_host_tree(host).is_err());
    }

    #[test]
    fn installed_layout_failure_keeps_the_actual_admission_phase() {
        let resources = tempfile::tempdir().unwrap();
        let profile = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(resources.path().join("deepseek-harness")).unwrap();
        std::fs::create_dir_all(resources.path().join("dsh-host")).unwrap();
        assert!(RuntimeDescriptor::resolve(resources.path(), profile.path()).is_err());
        let error_path = profile.path().join("dsh-engine-updates").join(crate::dsh_engine_update::SWITCH_ERROR_FILE);
        let error: serde_json::Value = serde_json::from_slice(&std::fs::read(error_path).unwrap()).unwrap();
        assert_eq!(error["stage"], "bundled-resource-layout");
        assert_eq!(error["errorCategory"], "invalid");
        assert!(!profile.path().join("dsh-engine-updates/active.json").exists());
    }
}
