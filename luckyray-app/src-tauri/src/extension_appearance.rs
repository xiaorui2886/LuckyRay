//! A finite, read-only projection of the desktop's existing appearance settings.
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

const THEMES: &[&str] = &["dark", "light", "ivory-editorial", "rose-tea", "github-dark", "white-zero", "bangladesh-green", "lilac-milk", "blue-whisper"];

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AppearanceInput {
    theme: String,
    accent: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppearanceProjection {
    instance_id: String,
    revision: u64,
    #[serde(flatten)]
    appearance: AppearanceInput,
}

static PROJECTION: OnceLock<Mutex<Option<AppearanceProjection>>> = OnceLock::new();

fn normalize(mut input: AppearanceInput) -> Result<AppearanceInput, String> {
    if !THEMES.contains(&input.theme.as_str()) { return Err("unsupported-theme".into()); }
    if input.accent.len() != 7 || !input.accent.starts_with('#') || !input.accent[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("invalid-accent".into());
    }
    input.accent.make_ascii_lowercase();
    Ok(input)
}

// Only the desktop WebView publishes. There is deliberately no HTTP write route.
#[tauri::command]
pub(crate) fn publish_extension_appearance(appearance: AppearanceInput) -> Result<(), String> {
    let appearance = normalize(appearance)?;
    let mut value = PROJECTION.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "appearance-unavailable")?;
    if let Some(current) = value.as_mut() {
        if current.appearance != appearance {
            current.appearance = appearance;
            current.revision += 1;
        }
    } else {
        *value = Some(AppearanceProjection {
            instance_id: format!("{:032x}", rand::random::<u128>()),
            revision: 1,
            appearance,
        });
    }
    Ok(())
}

pub(crate) fn read_projection() -> Option<AppearanceProjection> {
    PROJECTION.get_or_init(|| Mutex::new(None)).lock().ok()?.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn finite_appearance_values_only() {
        for theme in THEMES {
            assert!(normalize(AppearanceInput { theme: theme.to_string(), accent: "#Ab1234".into() }).is_ok());
        }
        for accent in ["red", "#fff", "url(x)", "#gggggg", "#ffffff;", "😀abc"] {
            assert!(normalize(AppearanceInput { theme: "dark".into(), accent: accent.into() }).is_err());
        }
        assert!(normalize(AppearanceInput { theme: "custom-css".into(), accent: "#123456".into() }).is_err());
    }
    #[test]
    fn projection_deduplicates_and_exposes_no_settings_or_credentials() {
        publish_extension_appearance(AppearanceInput { theme: "dark".into(), accent: "#123456".into() }).unwrap();
        let first = read_projection().unwrap();
        publish_extension_appearance(first.appearance.clone()).unwrap();
        assert_eq!(read_projection().unwrap().revision, first.revision);
        publish_extension_appearance(AppearanceInput { theme: "light".into(), accent: "#123456".into() }).unwrap();
        let next = read_projection().unwrap();
        assert_eq!(next.instance_id, first.instance_id);
        assert_eq!(next.revision, first.revision + 1);
        let value = serde_json::to_value(next).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 4);
    }
}
