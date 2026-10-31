//! Linux app-data lookup shared by the desktop and its native sidecars.
//! Relative XDG values are ignored as required by the XDG base-directory spec.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

fn app_data_from(
    xdg_data_home: Option<OsString>,
    home: Option<OsString>,
    identifier: &str,
) -> Option<PathBuf> {
    let mut components = Path::new(identifier).components();
    if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
        return None;
    }
    let root = xdg_data_home
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            home.map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .map(|path| path.join(".local").join("share"))
        })?;
    Some(root.join(identifier))
}

pub(crate) fn app_data_dir(identifier: &str) -> Option<PathBuf> {
    app_data_from(
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME"),
        identifier,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_xdg_data_home_takes_priority() {
        let base = std::env::temp_dir().join("中文 data");
        assert_eq!(
            app_data_from(Some(base.clone().into()), None, "com.luckyray.desktop"),
            Some(base.join("com.luckyray.desktop"))
        );
    }

    #[test]
    fn absent_or_relative_xdg_uses_absolute_home() {
        let home = std::env::temp_dir().join("user with spaces");
        let expected = home
            .join(".local")
            .join("share")
            .join("com.luckyray.desktop");
        assert_eq!(
            app_data_from(None, Some(home.clone().into()), "com.luckyray.desktop"),
            Some(expected.clone())
        );
        assert_eq!(
            app_data_from(
                Some("relative".into()),
                Some(home.into()),
                "com.luckyray.desktop"
            ),
            Some(expected)
        );
        assert_eq!(
            app_data_from(Some("relative".into()), None, "com.luckyray.desktop"),
            None
        );
    }

    #[test]
    fn app_identifier_cannot_escape_the_base() {
        let home = std::env::temp_dir();
        for identifier in ["", "..", ".", "a/b", "a/../b"] {
            assert_eq!(
                app_data_from(None, Some(home.clone().into()), identifier),
                None
            );
        }
    }
}
