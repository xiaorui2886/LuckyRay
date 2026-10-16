//! Catalog-owned files cross the system shell boundary by identity, never by a
//! caller-supplied path. Native resolution also follows filesystem redirection.
use crate::materials::MaterialCatalog;
use std::path::Path;

#[cfg(windows)]
mod windows_reveal;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum MaterialShellAction {
    Open,
    Reveal,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MaterialShellRequest {
    pub asset_id: String,
    pub action: MaterialShellAction,
}

pub(crate) fn perform(
    catalog: &MaterialCatalog,
    request: &MaterialShellRequest,
) -> Result<(), String> {
    perform_with_launcher(catalog, request, |path, action| match action {
        MaterialShellAction::Open => tauri_plugin_opener::open_path(path, None::<&str>)
            .map_err(|error| format!("material-shell-launch-failed: {error}")),
        MaterialShellAction::Reveal => reveal(path),
    })
}

fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    return windows_reveal::reveal(path);
    #[cfg(not(windows))]
    tauri_plugin_opener::reveal_item_in_dir(path)
        .map_err(|error| format!("material-shell-launch-failed: {error}"))
}

fn perform_with_launcher(
    catalog: &MaterialCatalog,
    request: &MaterialShellRequest,
    launch: impl FnOnce(&Path, MaterialShellAction) -> Result<(), String>,
) -> Result<(), String> {
    // This existing catalog boundary validates the ID, current storage mode,
    // registered managed roots, file existence and reparse components.
    let paths = catalog
        .resolve_external_drag_files(std::slice::from_ref(&request.asset_id))
        .map_err(crate::encode_material_catalog_command_error)?;
    let [path] = paths.as_slice() else {
        return Err("material-shell-file-unavailable".into());
    };
    launch(path, request.action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materials::MaterialImportOptions;

    #[test]
    fn shell_launch_uses_current_native_file_for_every_storage_mode_and_action() {
        for mode in ["managed", "source", "linked"] {
            let catalog = MaterialCatalog::new_for_test();
            let original = catalog.app_data_dir().join("original #1.png");
            std::fs::write(&original, b"fixture").unwrap();
            let asset = catalog
                .import_paths(
                    &[original.clone()],
                    &MaterialImportOptions {
                        storage_mode: mode.into(),
                        ..Default::default()
                    },
                )
                .unwrap()
                .value
                .assets
                .remove(0);
            let expected = if mode == "linked" {
                original.clone()
            } else {
                asset.library_path.as_ref().unwrap().into()
            }
            .canonicalize()
            .unwrap();
            if mode == "managed" {
                assert_ne!(expected, original.canonicalize().unwrap());
            }
            for action in [MaterialShellAction::Open, MaterialShellAction::Reveal] {
                let request = MaterialShellRequest {
                    asset_id: asset.id.clone(),
                    action,
                };
                let mut launched = Vec::new();
                perform_with_launcher(&catalog, &request, |path, action| {
                    launched.push((path.to_path_buf(), action));
                    Ok(())
                })
                .unwrap();
                assert_eq!(launched, vec![(expected.clone(), action)]);
            }
        }
    }

    #[test]
    fn shell_missing_or_unregistered_files_never_launch_and_launcher_failure_is_returned() {
        let catalog = MaterialCatalog::new_for_test();
        let path = catalog.app_data_dir().join("unregistered.png");
        std::fs::write(&path, b"fixture").unwrap();
        for id in [
            "unknown-asset".to_string(),
            path.to_string_lossy().into_owned(),
        ] {
            let request = MaterialShellRequest {
                asset_id: id,
                action: MaterialShellAction::Reveal,
            };
            assert!(perform_with_launcher(&catalog, &request, |_, _| panic!(
                "unregistered input launched"
            ))
            .is_err());
        }
        assert!(
            serde_json::from_value::<MaterialShellRequest>(serde_json::json!({
                "assetId": "known", "action": "reveal", "path": path
            }))
            .is_err(),
            "the command never accepts a caller-provided path"
        );
        assert!(
            serde_json::from_value::<MaterialShellRequest>(serde_json::json!({
                "assetId": "known", "action": "execute"
            }))
            .is_err()
        );
        let asset = catalog
            .import_paths(
                &[path.clone()],
                &MaterialImportOptions {
                    storage_mode: "linked".into(),
                    ..Default::default()
                },
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let request = MaterialShellRequest {
            asset_id: asset.id,
            action: MaterialShellAction::Open,
        };
        assert_eq!(
            perform_with_launcher(&catalog, &request, |_, _| Err(
                "synthetic launch failure".into()
            ))
            .unwrap_err(),
            "synthetic launch failure"
        );
        std::fs::remove_file(&path).unwrap();
        assert!(
            perform_with_launcher(&catalog, &request, |_, _| panic!("missing file launched"))
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn shell_launch_receives_physical_roaming_path_after_native_redirection() {
        for mode in ["linked", "managed"] {
            let roaming = std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap());
            let fixture = roaming.join(format!(
                "luckyray-shell-fixture-{}-{}",
                std::process::id(),
                rand::random::<u64>()
            ));
            std::fs::create_dir(&fixture).unwrap();
            let logical = fixture.join("file #1.png");
            std::fs::write(&logical, b"isolated shell fixture").unwrap();
            let library = fixture.join("library");
            std::fs::create_dir(&library).unwrap();
            let catalog = MaterialCatalog::new_for_test();
            let asset = catalog
                .import_paths(
                    &[logical.clone()],
                    &MaterialImportOptions {
                        storage_mode: mode.into(),
                        managed_library_dir: Some(library.to_string_lossy().into_owned()),
                        ..Default::default()
                    },
                )
                .unwrap()
                .value
                .assets
                .remove(0);
            let logical_current = if mode == "linked" {
                logical.clone()
            } else {
                library.join(
                    Path::new(asset.library_path.as_ref().unwrap())
                        .file_name()
                        .unwrap(),
                )
            };
            let canonical = logical_current.canonicalize().unwrap();
            rusqlite::Connection::open(catalog.db_path())
                .unwrap()
                .execute(
                    "UPDATE asset SET original_path=?2,library_path=?3 WHERE id=?1",
                    rusqlite::params![
                        asset.id,
                        logical.to_string_lossy(),
                        logical_current.to_string_lossy()
                    ],
                )
                .unwrap();
            let mut launched = Vec::new();
            for action in [MaterialShellAction::Open, MaterialShellAction::Reveal] {
                perform_with_launcher(
                    &catalog,
                    &MaterialShellRequest {
                        asset_id: asset.id.clone(),
                        action,
                    },
                    |path, action| {
                        launched.push((path.to_path_buf(), action));
                        Ok(())
                    },
                )
                .unwrap();
            }
            if mode == "managed" {
                std::fs::remove_file(&logical_current).unwrap();
            }
            std::fs::remove_file(&logical).unwrap();
            std::fs::remove_dir(&library).unwrap();
            std::fs::remove_dir(&fixture).unwrap();
            eprintln!(
                "Native shell roaming redirected ({mode}): {}",
                canonical.to_string_lossy().trim_start_matches(r"\\?\")
                    != logical_current.to_string_lossy()
            );
            assert_eq!(
                launched,
                vec![
                    (canonical.clone(), MaterialShellAction::Open),
                    (canonical, MaterialShellAction::Reveal)
                ]
            );
        }
    }
}
