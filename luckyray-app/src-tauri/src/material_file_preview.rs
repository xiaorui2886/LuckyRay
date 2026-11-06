//! Local material cards/viewer reuse the same real preview renderer as Companion.
use serde::Serialize;
use crate::materials::MaterialCatalog;
use crate::companion_gateway::content::preview;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialFilePreview {
    kind: &'static str,
    preview_uri: Option<String>,
    text: Option<String>,
    truncated: bool,
}

#[tauri::command]
pub(crate) async fn material_file_preview(
    caller: tauri::Webview,
    app: tauri::AppHandle,
    library_id: Option<String>,
    vault_id: Option<String>,
    asset_id: String,
    detail: bool,
) -> Result<Option<MaterialFilePreview>, String> {
    crate::require_main_caller(&caller)?;
    let catalog = crate::material_catalog_in_context(&app, &caller,
        library_id.as_deref(), vault_id.as_deref(), &[asset_id.clone()])?;
    let resources = app.path().resource_dir().map_err(|_| "material-preview-resources-unavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let assets = catalog.get_assets(&[asset_id.clone()]).map_err(|error| error.message)?;
        let asset = assets.first().ok_or("material-preview-asset-unavailable")?;
        if asset.kind == "audio" || asset.mime_type.starts_with("audio/") {
            #[cfg(all(windows, feature = "browser-host-runtime"))]
            {
                let (_, file) = catalog.companion_resource(&asset_id, false).map_err(|error| error.message)?;
                let bytes = crate::material_native_video::audio_waveform(&resources, &file)?;
                use base64::Engine;
                let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
                return Ok(Some(MaterialFilePreview { kind: "waveform", preview_uri: Some(format!("data:image/png;base64,{encoded}")), text: None, truncated: false }));
            }
            #[cfg(not(all(windows, feature = "browser-host-runtime")))]
            { let _ = resources; return Ok(None); }
        }
        read_preview(&catalog, &asset_id, detail)
    })
        .await.map_err(|error| format!("material-preview-worker-failed: {error}"))?
}

fn read_preview(catalog: &MaterialCatalog, asset_id: &str, detail: bool) -> Result<Option<MaterialFilePreview>, String> {
    if let Some((text, truncated)) = catalog.read_agent_text_preview(asset_id, if detail { 64 * 1024 } else { 4096 })
        .map_err(|error| error.message)? {
        let (text, truncated) = if detail { (text, truncated) } else { preview::text_excerpt(&text, truncated) };
        return Ok(Some(MaterialFilePreview { kind: "text", text: Some(text), preview_uri: None, truncated }));
    }
    let (asset, mut file) = catalog.companion_resource(asset_id, false).map_err(|error| error.message)?;
    if matches!(asset.kind.as_str(), "image" | "video") { return Ok(None); }
    let Some(image) = preview::file_thumbnail(&mut file, &asset.name) else { return Ok(None); };
    let mut bytes = std::io::Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).map_err(|error| error.to_string())?;
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    Ok(Some(MaterialFilePreview { kind: "image", preview_uri: Some(format!("data:image/png;base64,{encoded}")), text: None, truncated: false }))
}
