use std::path::PathBuf;

#[cfg(windows)]
use std::io::Cursor;

#[cfg(windows)]
use tauri::Emitter;

#[cfg(windows)]
fn drag_preview(paths: &[PathBuf]) -> drag::Image {
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
pub(crate) fn begin_file_drag(window: tauri::Window, paths: Vec<PathBuf>) -> Result<(), String> {
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
            let icon = drag_preview(&paths);
            let item = drag::DragItem::Files(paths);
            let _ = drag::start_drag(
                &drag_window,
                item,
                icon,
                |_result, _cursor_position| {},
                drag::Options::default(),
            );
            let _ = drag_window.emit("material-external-drag-ended", ());
        })
        .map_err(|_| "material-external-drag-unavailable".to_owned())
}

#[cfg(not(windows))]
pub(crate) fn begin_file_drag(_window: tauri::Window, _paths: Vec<PathBuf>) -> Result<(), String> {
    Err("material-external-drag-unsupported".to_owned())
}

#[cfg(all(test, windows))]
mod tests {
    use super::drag_preview;
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

        let drag::Image::Raw(bytes) = drag_preview(&[source]) else {
            panic!("expected encoded preview")
        };
        let preview = image::load_from_memory(&bytes).unwrap();
        assert!(preview.dimensions().0 <= 192);
        assert!(preview.dimensions().1 <= 144);
        let _ = std::fs::remove_dir_all(root);
    }
}
