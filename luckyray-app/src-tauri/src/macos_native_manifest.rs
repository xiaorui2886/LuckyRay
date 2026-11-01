//! User-level Chrome/Edge registration. Publication uses the same journaled
//! no-follow transaction as notes, retaining a displaced manifest for recovery.
use crate::knowledge::macos_transactions;
use crate::macos_fs::{require_empty_acl, Directory};
use serde_json::{json, Value};
use std::fs::Metadata;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

const UNSAFE: &str = "native-manifest-unsafe-or-conflicted";

fn executable_identity(meta: &Metadata) -> (u64, u64, u64, u32, u32, u32, i64, i64, i64, i64) {
    (meta.dev(), meta.ino(), meta.len(), meta.uid(), meta.gid(), meta.mode(),
     meta.mtime(), meta.mtime_nsec(), meta.ctime(), meta.ctime_nsec())
}

pub(super) fn install(path: &Path, binary: &Path, origins: &[String]) -> Result<(), String> {
    let parent = path.parent().ok_or(UNSAFE)?;
    let name = path.file_name().ok_or(UNSAFE)?;
    if name != "com.luckyray.desktop.json" || origins.is_empty() || !binary.is_absolute() {
        return Err(UNSAFE.into());
    }
    let executable_parent = Directory::open_trusted(binary.parent().ok_or(UNSAFE)?)
        .map_err(|_| UNSAFE)?;
    let executable_name = binary.file_name().ok_or(UNSAFE)?;
    let executable = executable_parent.open_regular(executable_name).map_err(|_| UNSAFE)?;
    let meta = executable.metadata().map_err(|_| UNSAFE)?;
    require_empty_acl(&executable).map_err(|_| UNSAFE)?;
    if (meta.uid() != unsafe { libc::geteuid() } && meta.uid() != 0)
        || meta.mode() & 0o022 != 0 || meta.mode() & 0o111 == 0 || meta.nlink() != 1 || meta.len() == 0
    {
        return Err(UNSAFE.into());
    }
    let dir = Directory::open_owned(parent, true).map_err(|_| UNSAFE)?;
    let before = dir.read_config(name).map_err(|_| UNSAFE)?;
    let manifest = json!({
        "name": "com.luckyray.desktop", "description": "LuckyRay browser bridge",
        "path": binary, "type": "stdio", "allowed_origins": origins,
    });
    if let Some((bytes, _)) = &before {
        let previous: Value = serde_json::from_slice(bytes).map_err(|_| UNSAFE)?;
        // An upgrade may move the application. A foreign or externally edited
        // manifest is preserved rather than accepted as a registration to replace.
        if previous.as_object().map(|v| v.len()) != Some(5)
            || ["name", "description", "type", "allowed_origins"].iter()
                .any(|key| previous.get(*key) != manifest.get(*key))
            || !previous.get("path").and_then(Value::as_str)
                .is_some_and(|value| Path::new(value).is_absolute())
        {
            return Err(UNSAFE.into());
        }
    }
    let unchanged = || -> Result<(), String> {
        dir.current().map_err(|_| UNSAFE)?;
        let file = executable_parent.open_regular(executable_name).map_err(|_| UNSAFE)?;
        require_empty_acl(&file).map_err(|_| UNSAFE)?;
        if executable_identity(&file.metadata().map_err(|_| UNSAFE)?) != executable_identity(&meta)
            || executable_identity(&executable.metadata().map_err(|_| UNSAFE)?) != executable_identity(&meta)
        {
            return Err(UNSAFE.into());
        }
        Ok(())
    };
    let bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| UNSAFE)?;
    macos_transactions::write(path, &bytes, before.is_some(), false,
        before.as_ref().map(|(_, version)| version), || {
            unchanged().map_err(|_| crate::knowledge::KnowledgeError {
                code: UNSAFE, message: "Native host or registration directory changed".into(),
            })
        }).map_err(|_| UNSAFE)?;
    unchanged()?;
    let installed = dir.read_config(name).map_err(|_| UNSAFE)?.ok_or(UNSAFE)?;
    if installed.0 != bytes { return Err(UNSAFE.into()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn macos_manifest_registration_is_private_and_preserves_conflicts() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let binary = root.join("native host");
        std::fs::write(&binary, b"synthetic executable; never launched").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("NativeMessagingHosts/com.luckyray.desktop.json");
        std::fs::create_dir(path.parent().unwrap()).unwrap();
        std::fs::set_permissions(path.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let origins = ["chrome-extension://aapepfngfopbfpkockmoibimjoffdlgl/".into()];
        install(&path, &binary, &origins).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["path"], json!(binary));
        assert_eq!(value["allowed_origins"], json!(origins));
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o755);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        install(&path, &binary, &origins).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o755);
        assert!(std::fs::read_dir(path.parent().unwrap()).unwrap()
            .any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".backup")));

        std::fs::write(&path, b"external manifest").unwrap();
        assert!(install(&path, &binary, &origins).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"external manifest");
        std::fs::remove_file(&path).unwrap();
        let outside = root.join("outside.json");
        std::fs::write(&outside, b"unrelated").unwrap();
        symlink(&outside, &path).unwrap();
        assert!(install(&path, &binary, &origins).is_err());
        assert_eq!(std::fs::read(&outside).unwrap(), b"unrelated");
        std::fs::remove_file(&path).unwrap();
        std::fs::set_permissions(path.parent().unwrap(), std::fs::Permissions::from_mode(0o775)).unwrap();
        assert!(install(&path, &binary, &origins).is_err());
        assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o775);
        assert!(!path.exists());
        std::fs::set_permissions(path.parent().unwrap(), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o720)).unwrap();
        assert!(install(&path, &binary, &origins).is_err());
        assert!(!path.exists());
    }
}
