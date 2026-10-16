//! Content V1 adapter. No paths or credentials are accepted in its query surface.
use super::*;
use crate::materials::{MaterialAsset, MaterialFilter, MaterialQueryScope};
use std::io::{Seek, SeekFrom};
pub(crate) mod materials;
pub(crate) mod notes;

/// Shared result type for every Content V1 route (read and mutate).
pub(super) type ContentResult<T> = Result<T, (u16, &'static str)>;

pub(super) fn is_content_route(path: &str) -> bool {
    let path = path.split('?').next().unwrap_or("");
    matches!(
        path,
        "/v1/capabilities"
            | "/v1/assets"
            | "/v1/assets/navigation"
            | "/v1/vaults"
            | "/v1/notes"
            | "/v1/sync/changes"
    ) || path.starts_with("/v1/assets/")
        || path.starts_with("/v1/notes/")
}

/// Internal Services V1 bridge to the existing note index/reconciliation
/// authority. This does not add or alter a legacy Content V1 wire route.
pub(crate) fn read_notes_for_service(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> Result<Value, (u16, &'static str)> {
    notes::read_route(gateway, request)
}

/// Services ingestion reuses the Content V1 note/attachment intent journal;
/// deterministic internal op IDs make recovery after an interrupted publish
/// converge on the same Desktop-owned note and file.
pub(crate) fn mutate_notes_for_service(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> Result<Value, (u16, &'static str)> {
    notes::mutate_route(gateway, request)
}

pub(crate) fn remap_moved_note_for_service(
    gateway: &CompanionGateway, vault_id: &str, note_id: &str,
    relative_path: &str, file_revision: &str,
) -> Result<String, (u16, &'static str)> {
    notes::remap_moved_note_for_service(gateway, vault_id, note_id, relative_path, file_revision)
}

pub(crate) fn current_vault_for_service(
    gateway: &CompanionGateway,
) -> Result<(String, String), (u16, &'static str)> {
    notes::target(gateway).map(|(target, vault_id)| (vault_id, target.label))
}

fn decode(value: &str) -> ContentResult<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let mut input = value.bytes();
    while let Some(c) = input.next() {
        match c {
            b'%' => {
                let a = input
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or((400, "INVALID_QUERY"))?;
                let b = input
                    .next()
                    .and_then(|c| (c as char).to_digit(16))
                    .ok_or((400, "INVALID_QUERY"))?;
                bytes.push((a * 16 + b) as u8);
            }
            b'+' => bytes.push(b' '),
            c => bytes.push(c),
        }
    }
    let value = String::from_utf8(bytes).map_err(|_| (400, "INVALID_QUERY"))?;
    if value.chars().any(char::is_control) {
        return Err((400, "INVALID_QUERY"));
    }
    Ok(value)
}

fn query(path: &str, allowed: &[&str]) -> ContentResult<HashMap<String, String>> {
    let mut out = HashMap::new();
    if let Some((_, q)) = path.split_once('?') {
        if q.len() > 8192 {
            return Err((400, "INVALID_QUERY"));
        }
        for pair in q.split('&') {
            let (key, value) = pair.split_once('=').ok_or((400, "INVALID_QUERY"))?;
            let key = decode(key)?;
            if !allowed.contains(&key.as_str()) || out.insert(key, decode(value)?).is_some() {
                return Err((400, "INVALID_QUERY"));
            }
        }
    }
    Ok(out)
}

fn number(q: &HashMap<String, String>, key: &str, default: u64, max: u64) -> ContentResult<u64> {
    let n = q
        .get(key)
        .map(|s| s.parse::<u64>())
        .transpose()
        .map_err(|_| (400, "INVALID_QUERY"))?
        .unwrap_or(default);
    if n == 0 || n > max {
        Err((400, "INVALID_QUERY"))
    } else {
        Ok(n)
    }
}

fn asset_value(a: &MaterialAsset) -> Value {
    json!({"desktopAssetId": a.id, "name": a.name, "kind": a.kind, "mimeType": a.mime_type,
        "sizeBytes": a.size_bytes, "updatedAt": a.updated_at, "contentHash": a.content_hash,
        "thumbnailRevision": format!("{}:{}", a.updated_at, a.content_hash.as_deref().unwrap_or("")),
        "folderId": a.folder_id, "storageMode": a.storage_mode, "description": a.description})
}

/// Authoritative material favorites, read from the EXISTING favorite_item
/// authority (never a mirror). A failed read cannot be presented as false.
fn favorite_ids(gateway: &CompanionGateway) -> ContentResult<std::collections::HashSet<String>> {
    let connection = gateway
        .backend
        .open_read()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    let items = crate::favorites::list(&connection, crate::favorites::FavoriteItemType::Material)
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    Ok(items.into_iter().map(|item| item.item_id).collect())
}

/// Decorate an asset DTO with the authoritative favorite flag.
fn asset_value_with_favorite(a: &MaterialAsset, favorites: &std::collections::HashSet<String>) -> Value {
    let mut value = asset_value(a);
    value["favorite"] = json!(favorites.contains(&a.id));
    value
}

fn json_route(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    let path = request.path.split('?').next().unwrap_or("");
    if request.method != "GET" {
        if path == "/v1/notes" || path.starts_with("/v1/notes/") {
            return notes::mutate_route(gateway, request);
        }
        // Wave A: material organization mutations (favorite / tag / folder /
        // batch) are desired-state operations over the existing Desktop
        // authorities.
        if matches!(
            path,
            "/v1/assets/favorite-batch" | "/v1/assets/tags" | "/v1/assets/folders"
        ) || path.starts_with("/v1/assets/")
        {
            return materials::mutate_route(gateway, request);
        }
        return Err((405, "METHOD_NOT_ALLOWED"));
    }
    let catalog = gateway.backend.material_catalog();
    if matches!(path, "/v1/vaults" | "/v1/notes" | "/v1/sync/changes")
        || path.starts_with("/v1/notes/")
    {
        return notes::read_route(gateway, request);
    }
    match path {
        "/v1/capabilities" => {
            query(&request.path, &[])?;
            // Each capability is enabled only with its implemented domain.
            serde_json::from_str(include_str!(
                "../../../protocol/companion-v1/content-v1/capabilities.json"
            ))
            .map_err(|_| (503, "CONTENT_CONTRACT_INVALID"))
        }
        "/v1/assets/navigation" => {
            query(&request.path, &[])?;
            let folders = catalog
                .list_folders()
                .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
            let tags = catalog
                .list_tags()
                .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
            Ok(json!({"folders": folders, "tags": tags}))
        }
        "/v1/assets" => {
            let q = query(
                &request.path,
                &["page", "limit", "q", "kind", "folder", "tag"],
            )?;
            let page = number(&q, "page", 1, 1_000_000)?;
            let limit = number(&q, "limit", 50, 100)?;
            let filter = MaterialFilter {
                query: q.get("q").cloned(),
                kinds: q.get("kind").cloned().into_iter().collect(),
                folder_id: q.get("folder").cloned(),
                tag_ids: q.get("tag").cloned().into_iter().collect(),
                limit: Some(limit as u32 + 1),
                ..Default::default()
            };
            let mut assets = catalog
                .list_assets_page_scoped(
                    &filter,
                    &MaterialQueryScope::default(),
                    (page - 1) * limit,
                )
                .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
            let more = assets.len() > limit as usize;
            assets.truncate(limit as usize);
            let favorites = favorite_ids(gateway)?;
            Ok(
                json!({"items": assets.iter().map(|a| asset_value_with_favorite(a, &favorites)).collect::<Vec<_>>(),
                "page": page, "limit": limit, "hasMore": more, "nextPage": if more {Some(page + 1)} else {None}}),
            )
        }
        _ => {
            query(&request.path, &[])?;
            let id = path
                .strip_prefix("/v1/assets/")
                .filter(|s| valid_id(s))
                .ok_or((404, "NOT_FOUND"))?;
            let asset = catalog
                .get_assets(&[id.to_owned()])
                .map_err(|_| (404, "NOT_FOUND"))?
                .into_iter()
                .next()
                .ok_or((404, "NOT_FOUND"))?;
            let favorites = favorite_ids(gateway)?;
            let mut value = asset_value_with_favorite(&asset, &favorites);
            value["tags"] = json!(catalog
                .get_asset_tags(id)
                .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?);
            Ok(value)
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Inclusive single byte range, including suffix/open-ended forms.
fn byte_range(value: Option<&str>, size: u64) -> ContentResult<Option<(u64, u64)>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.strip_prefix("bytes=").ok_or((416, "INVALID_RANGE"))?;
    let (start, end) = value.split_once('-').ok_or((416, "INVALID_RANGE"))?;
    if size == 0 || value.contains(',') {
        return Err((416, "INVALID_RANGE"));
    }
    let parse = |s: &str| s.parse::<u64>().map_err(|_| (416, "INVALID_RANGE"));
    let (start, end) = if start.is_empty() {
        let suffix = parse(end)?;
        if suffix == 0 {
            return Err((416, "INVALID_RANGE"));
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        (
            parse(start)?,
            if end.is_empty() {
                size - 1
            } else {
                parse(end)?.min(size - 1)
            },
        )
    };
    if start >= size || end < start {
        Err((416, "INVALID_RANGE"))
    } else {
        Ok(Some((start, end)))
    }
}

fn mime(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Keep a Windows read handle stable while allowing the owner's atomic rename.
/// In-place writers are excluded until the short streaming read finishes.
pub(crate) fn open_resource(path: impl AsRef<Path>) -> io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1 | 4);
    }
    options.open(path)
}

fn resource(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> ContentResult<Option<(std::fs::File, String, String)>> {
    let path = request.path.split('?').next().unwrap_or("");
    if path.starts_with("/v1/notes/") && path.contains("/resources/") {
        return notes::resource(gateway, request).map(Some);
    }
    let Some(rest) = path.strip_prefix("/v1/assets/") else {
        return Ok(None);
    };
    let Some((id, suffix)) = rest.split_once('/') else {
        return Ok(None);
    };
    if !valid_id(id) {
        return Err((404, "NOT_FOUND"));
    }
    // JSON mutations share the asset prefix but are not downloadable resources.
    if matches!(suffix, "favorite" | "tags" | "folder") {
        return Ok(None);
    }
    if !matches!(suffix, "file" | "thumbnail") {
        return Err((404, "NOT_FOUND"));
    }
    if request.method != "GET" {
        return Err((405, "METHOD_NOT_ALLOWED"));
    }
    query(&request.path, &[])?;
    let thumbnail = suffix == "thumbnail";
    let (asset, mut file) = gateway
        .backend
        .material_catalog()
        .companion_resource(id, thumbnail)
        .map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    let metadata = file.metadata().map_err(|_| (404, "RESOURCE_UNAVAILABLE"))?;
    let version = format!(
        "\"{:x}\"",
        Sha256::digest(format!(
            "{}:{}:{}:{}",
            id,
            asset.updated_at,
            metadata.len(),
            metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|t| t.as_nanos())
                .unwrap_or(0)
        ))
    );
    if thumbnail {
        // Decode with allocation limits; emit a small PNG, never return the full original as a thumbnail.
        if !matches!(asset.kind.as_str(), "image" | "video") || metadata.len() > 64 * 1024 * 1024 {
            return Err((404, "PREVIEW_UNAVAILABLE"));
        }
        let root = gateway.backend.app_data_dir().join("companion-previews");
        fs::create_dir_all(&root).map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
        let key = format!("{:x}", Sha256::digest(version.as_bytes()));
        let path = root.join(format!("{key}.png"));
        if !path.exists() {
            let mut reader = image::ImageReader::new(std::io::BufReader::new(file))
                .with_guessed_format()
                .map_err(|_| (404, "PREVIEW_UNAVAILABLE"))?;
            let mut limits = image::Limits::default();
            limits.max_alloc = Some(128 * 1024 * 1024);
            reader.limits(limits);
            let image = reader
                .decode()
                .map_err(|_| (404, "PREVIEW_UNAVAILABLE"))?
                .thumbnail(384, 384);
            let temporary = root.join(format!("{key}-{}.png", random_hex(8)));
            let result = image
                .save_with_format(&temporary, image::ImageFormat::Png)
                .map_err(|_| (503, "CONTENT_UNAVAILABLE"))
                .and_then(|_| {
                    fs::rename(&temporary, &path)
                        .or_else(|e| if path.exists() { Ok(()) } else { Err(e) })
                        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))
                });
            if temporary.exists() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }
        file = std::fs::File::open(path).map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
        return Ok(Some((file, "image/png".into(), version)));
    }
    Ok(Some((file, mime(&asset.name).into(), version)))
}

pub(super) fn serve(
    gateway: &CompanionGateway,
    request: &HttpRequest,
    stream: &mut impl Write,
    stop: &AtomicBool,
) -> io::Result<()> {
    match resource(gateway, request) {
        Ok(Some((mut file, mime, version))) => {
            let size = file.metadata()?.len();
            if request.headers.get("if-none-match") == Some(&version) {
                return write!(
                    stream,
                    "HTTP/1.1 304 Not Modified\r\nETag: {version}\r\nConnection: close\r\n\r\n"
                );
            }
            let requested_range = if request
                .headers
                .get("if-range")
                .is_some_and(|v| v != &version)
            {
                None
            } else {
                request.headers.get("range").map(String::as_str)
            };
            let range = match byte_range(requested_range, size) {
                Ok(value) => value,
                Err(_) => return write!(stream, "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
            };
            let (start, length) = range.map(|(s, e)| (s, e - s + 1)).unwrap_or((0, size));
            write!(stream, "HTTP/1.1 {}\r\nContent-Type: {mime}\r\nContent-Length: {length}\r\nETag: {version}\r\nAccept-Ranges: bytes\r\nCache-Control: private, no-cache\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: sandbox\r\nConnection: close\r\n", if range.is_some() {"206 Partial Content"} else {"200 OK"})?;
            if let Some((s, e)) = range {
                write!(stream, "Content-Range: bytes {s}-{e}/{size}\r\n")?;
            }
            stream.write_all(b"\r\n")?;
            file.seek(SeekFrom::Start(start))?;
            let mut remaining = length;
            let mut buffer = [0u8; 64 * 1024];
            while remaining > 0 && !stop.load(Ordering::Acquire) {
                if request.path.starts_with("/v1/notes/")
                    && !notes::resource_source_current(gateway, request)
                {
                    return Err(io::Error::new(
                        ErrorKind::Interrupted,
                        "Knowledge source changed",
                    ));
                }
                let count = file.read(&mut buffer[..remaining.min(64 * 1024) as usize])?;
                if count == 0 {
                    return Err(io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "Resource changed during transfer",
                    ));
                }
                stream.write_all(&buffer[..count])?;
                remaining -= count as u64;
            }
            stream.flush()
        }
        Ok(None) => match json_route(gateway, request) {
            Ok(value) => write_json(stream, 200, &value),
            Err((status, code)) => write_json(stream, status, &json!({"code": code})),
        },
        Err((status, code)) => write_json(stream, status, &json!({"code": code})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_seek_suffix_and_invalid_inputs() {
        assert_eq!(
            byte_range(Some("bytes=10-19"), 100).unwrap(),
            Some((10, 19))
        );
        assert_eq!(byte_range(Some("bytes=10-"), 100).unwrap(), Some((10, 99)));
        assert_eq!(byte_range(Some("bytes=-20"), 100).unwrap(), Some((80, 99)));
        assert_eq!(byte_range(Some("bytes=-200"), 100).unwrap(), Some((0, 99)));
        for value in [
            "bytes=100-",
            "bytes=20-10",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=NaN-",
            "items=1-2",
        ] {
            assert!(byte_range(Some(value), 100).is_err(), "{value}");
        }
        assert!(byte_range(Some("bytes=0-"), 0).is_err());
    }

    #[test]
    fn query_allowlist_rejects_credentials_duplicates_and_bad_encoding() {
        for path in [
            "/v1/assets?token=secret",
            "/v1/assets?q=a&q=b",
            "/v1/assets?q=%ZZ",
            "/v1/assets?q=%00",
            "/v1/assets?q=%FF",
        ] {
            assert!(query(path, &["q"]).is_err());
        }
        assert_eq!(
            query("/v1/assets?q=%E4%B8%AD%E6%96%87+%28a%29", &["q"]).unwrap()["q"],
            "中文 (a)"
        );
        assert!(!is_content_route("/v1/session?token=secret"));
        assert!(!valid_id("../secret"));
    }
}
