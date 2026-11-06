//! Small, real file previews for the authenticated Companion resource route.
//! Input is the catalog-owned open file, never a client-supplied path.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

pub(crate) fn file_thumbnail(file: &mut File, name: &str) -> Option<image::DynamicImage> {
    let extension = std::path::Path::new(name).extension()?.to_str()?.to_ascii_lowercase();
    if matches!(extension.as_str(), "docx" | "xlsx" | "pptx") {
        file.seek(SeekFrom::Start(0)).ok()?;
        if let Some(image) = office_thumbnail(file) { return Some(image); }
    }
    if !matches!(extension.as_str(), "pdf" | "doc" | "docx" | "xls" | "xlsx" | "ppt" | "pptx"
        | "odt" | "ods" | "odp" | "mp3" | "m4a" | "flac" | "ogg" | "wav") { return None; }
    #[cfg(all(windows, feature = "browser-host-runtime"))]
    { shell_thumbnail(file) }
    #[cfg(not(all(windows, feature = "browser-host-runtime")))]
    { None }
}

fn office_thumbnail(file: &mut File) -> Option<image::DynamicImage> {
    let mut archive = zip::ZipArchive::new(file).ok()?;
    // Only the document's embedded cover. No extraction, relationships or URLs.
    for name in ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png"] {
        let Ok(mut entry) = archive.by_name(name) else { continue; };
        if entry.size() > 8 * 1024 * 1024 { continue; }
        let mut bytes = Vec::new();
        entry.by_ref().take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 8 * 1024 * 1024 { continue; }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format().ok()?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(128 * 1024 * 1024);
        reader.limits(limits);
        if let Ok(image) = reader.decode() { return Some(image.thumbnail(384, 384)); }
    }
    None
}

// Shell parsing names use DOS/UNC syntax rather than the verbatim path returned
// by GetFinalPathNameByHandleW. Convert only that already-authorized handle path;
// never accept a client path or reinterpret other device namespaces.
pub(crate) fn shell_parsing_path(final_path: &[u16]) -> Option<Vec<u16>> {
    let mut path = if final_path.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
        let mut unc = vec![92, 92];
        unc.extend_from_slice(&final_path[8..]);
        unc
    } else if final_path.starts_with(&[92, 92, 63, 92]) {
        if final_path.len() < 7 || !matches!(final_path[4], 65..=90 | 97..=122)
            || final_path[5] != 58 || final_path[6] != 92 { return None; }
        final_path[4..].to_vec()
    } else {
        final_path.to_vec()
    };
    path.push(0);
    Some(path)
}

#[cfg(all(windows, feature = "browser-host-runtime"))]
fn shell_thumbnail(file: &File) -> Option<image::DynamicImage> {
    use std::os::windows::io::AsRawHandle;
    use windows::core::PCWSTR;
    use windows::Win32::{Foundation::{HANDLE, SIZE}, Graphics::Gdi::*,
        Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED},
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        UI::Shell::{SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_THUMBNAILONLY}};
    // The HTTP worker is not the UI thread. Shell may invoke the installed OS
    // thumbnail handler; THUMBNAILONLY forbids treating an application icon as a preview.
    unsafe {
        let mut path = vec![0u16; 32768];
        let length = GetFinalPathNameByHandleW(HANDLE(file.as_raw_handle()), &mut path,
            FILE_NAME_NORMALIZED) as usize;
        if length == 0 || length >= path.len() { return None; }
        let path = shell_parsing_path(&path[..length])?;
        CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
        let result = (|| {
            let item: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None).ok()?;
            let bitmap = item.GetImage(SIZE { cx: 384, cy: 384 }, SIIGBF_THUMBNAILONLY).ok()?;
            let result = (|| {
                let mut object = BITMAP::default();
                if GetObjectW(HGDIOBJ(bitmap.0), std::mem::size_of::<BITMAP>() as i32,
                    Some((&mut object as *mut BITMAP).cast())) == 0 { return None; }
                let (width, height) = (object.bmWidth, object.bmHeight);
                if width <= 0 || height <= 0 || width > 1024 || height > 1024 { return None; }
                let dc = CreateCompatibleDC(None);
                if dc.is_invalid() { return None; }
                let mut info = BITMAPINFO::default();
                info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                info.bmiHeader.biWidth = width;
                info.bmiHeader.biHeight = -height;
                info.bmiHeader.biPlanes = 1;
                info.bmiHeader.biBitCount = 32;
                info.bmiHeader.biCompression = BI_RGB.0;
                let mut bytes = vec![0u8; width as usize * height as usize * 4];
                let rows = GetDIBits(dc, bitmap, 0, height as u32, Some(bytes.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
                let _ = DeleteDC(dc);
                if rows != height { return None; }
                let has_alpha = bytes.chunks_exact(4).any(|pixel| pixel[3] != 0);
                for pixel in bytes.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                    if !has_alpha { pixel[3] = 255; }
                }
                Some(image::DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width as u32, height as u32, bytes)?).thumbnail(384, 384))
            })();
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            result
        })();
        CoUninitialize();
        result
    }
}

pub(crate) fn text_excerpt(text: &str, truncated: bool) -> (String, bool) {
    let mut chars = text.chars();
    let excerpt: String = chars.by_ref().take(600).collect();
    (excerpt, truncated || chars.next().is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test] fn shell_path_keeps_unicode_dos_and_unc_identity() {
        let check = |before: &str, after: &str| {
            let before: Vec<u16> = before.encode_utf16().collect();
            let expected: Vec<u16> = after.encode_utf16().chain(std::iter::once(0)).collect();
            assert_eq!(shell_parsing_path(&before), Some(expected));
        };
        check(r"\\?\D:\合成 资料\audio.mp3", r"D:\合成 资料\audio.mp3");
        check(r"\\?\UNC\server\share\合成.mp3", r"\\server\share\合成.mp3");
        check(r"D:\合成.mp3", r"D:\合成.mp3");
    }
    #[test] fn shell_path_does_not_reinterpret_device_namespaces() {
        for path in [r"\\?\GLOBALROOT\Device\HarddiskVolume1\x", r"\\?\Volume{synthetic}\x"] {
            assert!(shell_parsing_path(&path.encode_utf16().collect::<Vec<_>>()).is_none());
        }
    }
    fn office(entries: &[(&str, &[u8])]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        {
            let mut archive = zip::ZipWriter::new(file.as_file_mut());
            for (name, bytes) in entries {
                archive.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                archive.write_all(bytes).unwrap();
            }
            archive.finish().unwrap();
        }
        file
    }
    fn png() -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(768, 384).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    #[test] fn office_embedded_cover_is_real_and_scaled() {
        let bytes = png(); let mut f = office(&[("docProps/thumbnail.png", &bytes)]);
        let image = file_thumbnail(f.as_file_mut(), "deck.PPTX").unwrap();
        assert_eq!((image.width(), image.height()), (384, 192));
    }
    #[test] fn office_does_not_extract_arbitrary_entries_or_follow_urls() {
        let bytes = png(); let mut f = office(&[("../thumbnail.png", &bytes), ("word/media/image1.png", &bytes)]);
        assert!(office_thumbnail(f.as_file_mut()).is_none());
    }
    #[test] fn corrupt_cover_falls_through_to_other_embedded_cover() {
        let bytes = png(); let mut f = office(&[("docProps/thumbnail.jpeg", b"not an image"), ("docProps/thumbnail.png", &bytes)]);
        assert!(office_thumbnail(f.as_file_mut()).is_some());
    }
    #[test] fn corrupt_container_is_not_a_preview() {
        let mut f = tempfile::NamedTempFile::new().unwrap();f.write_all(b"not a zip").unwrap();
        assert!(office_thumbnail(f.as_file_mut()).is_none());
    }
    #[test] fn oversized_embedded_cover_is_rejected() {
        let mut f = office(&[("docProps/thumbnail.png", &vec![0u8; 8 * 1024 * 1024 + 1])]);
        assert!(office_thumbnail(f.as_file_mut()).is_none());
    }
    #[test] fn unsupported_file_is_not_passed_to_system_provider() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        assert!(file_thumbnail(f.as_file_mut(), "script.exe").is_none());
        assert!(file_thumbnail(f.as_file_mut(), "web.html").is_none());
    }
    #[test] fn text_excerpt_preserves_unicode_and_never_marks_html_safe() {
        let text = "你".repeat(601);let (preview, clipped) = text_excerpt(&text, false);
        assert_eq!(preview.chars().count(), 600);assert!(clipped);
        assert_eq!(text_excerpt("<script>alert(1)</script>", false), ("<script>alert(1)</script>".into(), false));
        assert!(text_excerpt("short", true).1);
    }
}
