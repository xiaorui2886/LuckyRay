//! Open a user-selected local directory with the desktop's registered handler.
//! The application does not directly invoke an xdg-open command from PATH.

use std::path::Path;

fn validate_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("open-directory-path-not-absolute".to_owned());
    }
    let metadata = std::fs::metadata(path).map_err(|_| "open-directory-unavailable".to_owned())?;
    if !metadata.is_dir() {
        return Err("open-directory-target-is-not-directory".to_owned());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn directory_uri(path: &Path) -> Result<String, String> {
    validate_directory(path)?;
    gtk::glib::filename_to_uri(path, None)
        .map(|uri| uri.to_string())
        .map_err(|_| "open-directory-uri-invalid".to_owned())
}

#[cfg(target_os = "linux")]
pub(crate) fn open(path: &Path) -> Result<(), String> {
    let uri = directory_uri(path)?;
    gtk::gio::AppInfo::launch_default_for_uri(&uri, None::<&gtk::gio::AppLaunchContext>)
        .map_err(|error| format!("open-directory-failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(self.0.join("plain.txt"));
            let _ = std::fs::remove_dir(self.0.join("目录 #100%"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn directory_validation_rejects_non_directories_and_relative_paths() {
        let unique = format!(
            "luckyray-open-directory-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let file = fixture.0.join("plain.txt");
        std::fs::write(&file, b"synthetic").unwrap();

        assert!(validate_directory(&fixture.0).is_ok());
        assert_eq!(
            validate_directory(Path::new("relative")),
            Err("open-directory-path-not-absolute".into())
        );
        assert_eq!(
            validate_directory(&file),
            Err("open-directory-target-is-not-directory".into())
        );
        assert_eq!(
            validate_directory(&fixture.0.join("missing")),
            Err("open-directory-unavailable".into())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn local_directory_uri_round_trips_unicode_and_reserved_characters() {
        let unique = format!(
            "luckyray-open-directory-uri-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let root = std::env::temp_dir().join(unique);
        std::fs::create_dir(&root).unwrap();
        let fixture = Fixture(root);
        let directory = fixture.0.join("目录 #100%");
        std::fs::create_dir(&directory).unwrap();
        let uri = directory_uri(&directory).unwrap();
        assert!(uri.starts_with("file:///"));
        assert!(uri.contains("%20") && uri.contains("%23") && uri.contains("%25"));
        let (decoded, _) = gtk::glib::filename_from_uri(&uri).unwrap();
        assert_eq!(decoded, directory);
    }
}
