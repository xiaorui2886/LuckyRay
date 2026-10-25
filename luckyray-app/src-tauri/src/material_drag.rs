use std::path::PathBuf;

#[cfg(windows)]
use std::io::Cursor;

#[cfg(windows)]
use tauri::Emitter;

#[cfg(windows)]
fn validated_cover(value: Option<&str>) -> Option<Vec<u8>> {
    use base64::Engine;
    let encoded = value?.strip_prefix("data:image/png;base64,")?;
    if encoded.len() > 350_000 { return None; }
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).ok()?;
    if bytes.len() > 256 * 1024 { return None; }
    let reader = image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format().ok()?;
    let (width, height) = reader.into_dimensions().ok()?;
    if width == 0 || height == 0 || width > 192 || height > 144 { return None; }
    // Decode only the bounded bitmap. Never trust a caller-supplied path or URL.
    let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()?;
    let mut clean = Cursor::new(Vec::new());
    decoded.write_to(&mut clean, image::ImageFormat::Png).ok()?;
    Some(clean.into_inner())
}

#[cfg(windows)]
fn drag_preview(paths: &[PathBuf], preview_png: Option<&str>) -> drag::Image {
    if let Some(bytes) = validated_cover(preview_png) { return drag::Image::Raw(bytes); }
    const MAX_PREVIEW_FILE_BYTES: u64 = 32 * 1024 * 1024;
    const MAX_PREVIEW_PIXELS: u64 = 50_000_000;
    const PREVIEW_WIDTH: u32 = 192;
    const PREVIEW_HEIGHT: u32 = 144;

    let preview = paths.iter().find_map(|path| {
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let supported = matches!(
            extension.to_ascii_lowercase().as_str(),
            "png" | "jpg" | "jpeg" | "bmp" | "gif" | "webp"
        );
        if !supported
            || !std::fs::metadata(path)
                .is_ok_and(|metadata| metadata.len() <= MAX_PREVIEW_FILE_BYTES)
        {
            return None;
        }
        let dimensions = image::ImageReader::open(path)
            .and_then(|reader| reader.with_guessed_format())
            .ok()
            .and_then(|reader| reader.into_dimensions().ok())?;
        if u64::from(dimensions.0)
            .checked_mul(u64::from(dimensions.1))
            .is_none_or(|pixels| pixels > MAX_PREVIEW_PIXELS)
        {
            return None;
        }
        let decoded = image::open(path).ok()?;
        let thumbnail = decoded.thumbnail(PREVIEW_WIDTH, PREVIEW_HEIGHT);
        let mut encoded = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut encoded, image::ImageFormat::Png)
            .ok()?;
        Some(encoded.into_inner())
    });
    preview
        .map(drag::Image::Raw)
        .unwrap_or_else(|| drag::Image::Raw(include_bytes!("../icons/128x128.png").to_vec()))
}

#[cfg(windows)]
pub(crate) fn begin_file_drag(window: tauri::Window, paths: Vec<PathBuf>, preview_png: Option<String>) -> Result<(), String> {
    if paths.is_empty() || paths.len() > 64 {
        return Err("material-external-drag-invalid-selection".to_owned());
    }
    if paths
        .iter()
        .any(|path| !path.is_absolute() || !path.is_file())
    {
        return Err("material-external-drag-file-unavailable".to_owned());
    }

    let drag_window = window.clone();
    window
        .run_on_main_thread(move || {
            let icon = drag_preview(&paths, preview_png.as_deref());
            let item = drag::DragItem::Files(paths);
            let result = drag::start_drag(
                &drag_window,
                item,
                icon,
                |_result, _cursor_position| {},
                drag::Options::default(),
            );
            if result.is_err() { let _ = drag_window.emit("material-external-drag-failed", "material-external-drag-unavailable"); }
            let _ = drag_window.emit("material-external-drag-ended", ());
        })
        .map_err(|_| "material-external-drag-unavailable".to_owned())
}

#[cfg(not(windows))]
pub(crate) fn begin_file_drag(_window: tauri::Window, _paths: Vec<PathBuf>, _preview_png: Option<String>) -> Result<(), String> {
    Err("material-external-drag-unsupported".to_owned())
}

#[cfg(all(test, windows))]
mod tests {
    use super::{drag_preview, validated_cover};
    use base64::Engine;
    #[test]
    fn cover_rejects_paths_malformed_and_oversized_inputs() {
        for value in [None, Some("file:///private.png"), Some("data:image/jpeg;base64,eA=="), Some("data:image/png;base64,%%%"), Some("data:image/png;base64,eA==")] {
            assert!(validated_cover(value).is_none());
        }
        let excessive = format!("data:image/png;base64,{}", "A".repeat(350_001));
        assert!(validated_cover(Some(&excessive)).is_none());
        for (width, height, accepted) in [(192, 144, true), (193, 144, false), (192, 145, false)] {
            let mut png = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgba8(width, height).write_to(&mut png, image::ImageFormat::Png).unwrap();
            let value = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png.into_inner()));
            assert_eq!(validated_cover(Some(&value)).is_some(), accepted);
        }
    }
    use image::GenericImageView;

    #[test]
    fn drag_preview_is_bounded_to_a_card_sized_image() {
        let root = std::env::temp_dir().join(format!(
            "luckyray-material-drag-preview-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("large.png");
        image::DynamicImage::new_rgb8(1_920, 1_080)
            .save(&source)
            .unwrap();

        let drag::Image::Raw(bytes) = drag_preview(&[source], None) else {
            panic!("expected encoded preview")
        };
        let preview = image::load_from_memory(&bytes).unwrap();
        assert!(preview.dimensions().0 <= 192);
        assert!(preview.dimensions().1 <= 144);
        let _ = std::fs::remove_dir_all(root);
    }
}
