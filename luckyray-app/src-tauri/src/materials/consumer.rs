//! Explicit consumer boundary over the sole Catalog. Authorization is supplied
//! by the verified host adapter, never deserialized from a consumer body.
use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[path = "consumer_media.rs"]
pub(crate) mod media;

pub(crate) const CONSUMER_VERSION: u32 = 1;
pub(crate) const MAX_CAPTURE_BYTES: usize = 12 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsumerPermissions {
    pub read: bool,
    pub organize: bool,
    pub import: bool,
    pub files: bool,
}
#[derive(Clone, Default)]
pub(crate) struct ConsumerAuthorization {
    pub enumerate: bool,
    // Old catalog permissions map only to legacy_id, never to active_id.
    pub legacy: ConsumerPermissions,
    pub libraries: BTreeMap<String, ConsumerPermissions>,
}
impl ConsumerAuthorization {
    /// Companion adapter reuses the existing grant classes. The common owner
    /// publishes the additive material-library scope; catalog stays legacy-only.
    pub(crate) fn from_service_grants(
        catalog: &MaterialCatalog,
        enumerate: bool,
        mut granted: impl FnMut(&str, &str, &str) -> MaterialResult<bool>,
    ) -> MaterialResult<Self> {
        let legacy = ConsumerPermissions {
            read: granted("content.read", "catalog", "")?,
            organize: granted("content.write", "catalog", "")?,
            import: granted("ingest.write", "catalog", "")?,
            files: granted("content.read", "catalog", "")?,
        };
        let mut libraries = BTreeMap::new();
        for library in catalog.list_libraries(true)? {
            let read = granted("content.read", "material-library", &library.id)?;
            let organize = granted("content.write", "material-library", &library.id)?;
            let import = granted("ingest.write", "material-library", &library.id)?;
            libraries.insert(
                library.id,
                ConsumerPermissions {
                    read,
                    organize,
                    import,
                    files: read,
                },
            );
        }
        Ok(Self {
            enumerate,
            legacy,
            libraries,
        })
    }
}
pub(crate) struct MaterialConsumer {
    catalog: MaterialCatalog,
    authorization: ConsumerAuthorization,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerTarget {
    pub library_id: String,
    pub request_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConsumerBytesInput {
    pub library_id: String,
    pub request_id: String,
    pub name: String,
    pub mime_type: String,
    pub bytes_base64: String,
    #[serde(default, alias = "folderId")]
    pub target_folder_id: Option<String>,
    #[serde(default)]
    pub new_folder_name: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub source_page_url: Option<String>,
    #[serde(default)]
    pub source_page_title: Option<String>,
    #[serde(default)]
    pub source_page_kind: Option<String>,
}
fn invalid(message: &str) -> MaterialError {
    MaterialError::new("consumer-input-invalid", message)
}
pub(crate) fn valid_consumer_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.trim() == value
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}
fn flatten(folders: Vec<MaterialFolder>, out: &mut Vec<Value>) {
    for folder in folders {
        out.push(json!({"id":folder.id,"name":folder.name,"parentId":folder.parent_id,"sortOrder":folder.sort_order}));
        flatten(folder.children, out);
    }
}
impl MaterialConsumer {
    pub(crate) fn new(catalog: MaterialCatalog, authorization: ConsumerAuthorization) -> Self {
        Self {
            catalog,
            authorization,
        }
    }
    fn permissions(&self, library_id: &str) -> MaterialResult<ConsumerPermissions> {
        if !valid_consumer_id(library_id) {
            return Err(invalid("素材库身份无效"));
        }
        let legacy = self.catalog.library_state()?.0;
        let explicit = self
            .authorization
            .libraries
            .get(library_id)
            .copied()
            .unwrap_or_default();
        let old = if library_id == legacy {
            self.authorization.legacy
        } else {
            ConsumerPermissions::default()
        };
        Ok(ConsumerPermissions {
            read: explicit.read || old.read,
            organize: explicit.organize || old.organize,
            import: explicit.import || old.import,
            files: explicit.files || old.files,
        })
    }
    fn bind(&self, target: &ConsumerTarget, permission: &str) -> MaterialResult<MaterialCatalog> {
        if !valid_consumer_id(&target.request_id) || target.request_id.len() > 128 {
            return Err(invalid("操作标识无效"));
        }
        let rights = self.permissions(&target.library_id)?;
        let allowed = match permission {
            "read" => rights.read,
            "organize" => rights.organize,
            "import" => rights.import,
            "files" => rights.files,
            _ => false,
        };
        if !allowed {
            return Err(MaterialError::new(
                "consumer-library-denied",
                "此操作未获该素材库授权",
            ));
        }
        // Re-check availability for every operation, including a completed receipt read.
        self.catalog.for_library(&target.library_id)
    }
    pub(crate) fn authorize_read(&self, target: &ConsumerTarget) -> MaterialResult<()> {
        self.bind(target, "read").map(|_| ())
    }
    pub(crate) fn authorize_import(&self, target: &ConsumerTarget) -> MaterialResult<()> {
        self.bind(target, "import")?;
        // The full receipt contains existing metadata when content deduplicates.
        // An ingest-only grant cannot use that receipt as a read side channel.
        self.bind(target, "read").map(|_| ())
    }
    pub(crate) fn libraries(&self) -> MaterialResult<Value> {
        if !self.authorization.enumerate {
            return Err(MaterialError::new(
                "consumer-library-denied",
                "素材库枚举未获授权",
            ));
        }
        let legacy = self.catalog.library_state()?.0;
        let items = self.catalog.list_libraries(true)?.into_iter().map(|lib| {
            let rights = self.permissions(&lib.id)?;
            Ok(json!({"libraryId":lib.id,"name":lib.name,"state":lib.state,"visible":lib.visible,
                "version":lib.version,"capabilities":rights}))
        }).collect::<MaterialResult<Vec<_>>>()?;
        Ok(json!({"consumerVersion":CONSUMER_VERSION,"legacyLibraryId":legacy,"libraries":items}))
    }
    pub(crate) fn taxonomy(&self, target: &ConsumerTarget) -> MaterialResult<Value> {
        let catalog = self.bind(target, "read")?;
        let mut folders = vec![];
        flatten(catalog.list_folders()?, &mut folders);
        let tags = catalog
            .list_tags()?
            .into_iter()
            .map(|tag| json!({"id":tag.id,"name":tag.name,"color":tag.color}))
            .collect::<Vec<_>>();
        Ok(
            json!({"consumerVersion":CONSUMER_VERSION,"libraryId":target.library_id,"requestId":target.request_id,
            "version":catalog.read_library_change()?.version,"folders":folders,"tags":tags}),
        )
    }
    pub(crate) fn list(
        &self,
        target: &ConsumerTarget,
        filter: &MaterialFilter,
    ) -> MaterialResult<Value> {
        let catalog = self.bind(target, "read")?;
        let mut filter = filter.clone();
        if filter.limit.is_some_and(|n| n == 0 || n > 100) {
            return Err(invalid("查询数量需为1到100"));
        }
        filter.limit = Some(filter.limit.unwrap_or(50));
        let items = catalog
            .list_assets(&filter)?
            .iter()
            .map(|asset| asset_value(&catalog, asset))
            .collect::<MaterialResult<Vec<_>>>()?;
        Ok(
            json!({"consumerVersion":CONSUMER_VERSION,"libraryId":target.library_id,"requestId":target.request_id,"items":items}),
        )
    }
    pub(crate) fn detail(&self, target: &ConsumerTarget, asset_id: &str) -> MaterialResult<Value> {
        if !valid_consumer_id(asset_id) {
            return Err(invalid("素材身份无效"));
        }
        let catalog = self.bind(target, "read")?;
        let asset = catalog
            .get_assets(&[asset_id.to_owned()])?
            .into_iter()
            .next()
            .ok_or_else(|| {
                MaterialError::new("consumer-asset-not-found", "素材不属于此库或已不存在")
            })?;
        Ok(
            json!({"consumerVersion":CONSUMER_VERSION,"libraryId":target.library_id,"requestId":target.request_id,"asset":asset_value(&catalog,&asset)?}),
        )
    }
    pub(crate) fn original(
        &self,
        target: &ConsumerTarget,
        asset_id: &str,
    ) -> MaterialResult<std::path::PathBuf> {
        let catalog = self.bind(target, "files")?;
        if !valid_consumer_id(asset_id) {
            return Err(invalid("素材身份无效"));
        }
        catalog
            .resolve_open_in_lightseek_paths(&[asset_id.to_owned()])?
            .into_iter()
            .next()
            .ok_or_else(|| {
                MaterialError::new("consumer-asset-not-found", "素材不属于此库或已不存在")
            })
    }
    pub(crate) fn import_bytes(&self, input: &ConsumerBytesInput) -> MaterialResult<Value> {
        self.import_bytes_checked(input, || Ok(()))
    }
    pub(crate) fn import_bytes_checked<G>(
        &self,
        input: &ConsumerBytesInput,
        before_write: impl FnOnce() -> MaterialResult<G>,
    ) -> MaterialResult<Value> {
        let target = ConsumerTarget {
            library_id: input.library_id.clone(),
            request_id: input.request_id.clone(),
        };
        let catalog = self.bind(&target, "import")?;
        self.bind(&target, "read")?;
        let bytes = validate_capture(input)?;
        if input.tag_ids.len() + input.tag_names.len() > 32 {
            return Err(invalid("每次最多32个标签"));
        }
        if input.target_folder_id.is_some()
            || input.new_folder_name.is_some()
            || !input.tag_ids.is_empty()
            || !input.tag_names.is_empty()
        {
            self.bind(&target, "organize")?;
        }
        let source = match input.source_page_url.as_deref() {
            Some(url) => Some(
                MaterialSourcePageInput::from_parts(
                    url,
                    input.source_page_kind.as_deref().unwrap_or("capture-page"),
                    input.source_page_title.as_deref(),
                )
                .ok_or_else(|| invalid("网页来源无效"))?,
            ),
            None if input.source_page_title.is_some() || input.source_page_kind.is_some() => {
                return Err(invalid("网页来源字段不完整"))
            }
            None => None,
        };
        // Validate all organization BEFORE any write. Foreign ids cannot leave
        // an orphan folder/tag or a copied file behind.
        let mut folders = vec![];
        flatten(catalog.list_folders()?, &mut folders);
        if input
            .target_folder_id
            .as_ref()
            .is_some_and(|id| !folders.iter().any(|f| f["id"].as_str() == Some(id)))
        {
            return Err(MaterialError::new(
                "consumer-folder-denied",
                "分类不属于此素材库",
            ));
        }
        let tags = catalog.list_tags()?;
        if input
            .tag_ids
            .iter()
            .any(|id| !tags.iter().any(|t| &t.id == id))
        {
            return Err(MaterialError::new(
                "consumer-tag-denied",
                "标签不属于此素材库",
            ));
        }
        for name in &input.tag_names {
            validate_name(name, 80)?;
        }
        if let Some(name) = &input.new_folder_name {
            validate_name(name, 120)?;
        }
        // A duplicate keeps the existing record and its manual organization.
        // Do not create unused requested folders/tags or overwrite old metadata.
        use sha2::{Digest, Sha256};
        let hash = format!("{:x}", Sha256::digest(&bytes));
        // Host holds its current authorization/lifecycle admission through all
        // side effects and receipt creation; revocation wins before this gate.
        let _admission = before_write()?;
        self.bind(&target, "import")?;
        if let Some(asset) = catalog.find_managed_asset_by_hash(&hash)? {
            return receipt(&catalog, &target, &asset, true, false, None);
        }
        let mut organization_changed = false;
        let folder = if let Some(name) = &input.new_folder_name {
            let outcome = catalog.create_folder(MaterialFolderInput {
                name: name.clone(),
                parent_id: input.target_folder_id.clone(),
            })?;
            organization_changed = outcome.change.is_some();
            crate::publish_catalog_change_global(&outcome.change);
            Some(outcome.value.id)
        } else {
            input.target_folder_id.clone()
        };
        let imported = import_consumer_material_with_source(
            &catalog,
            MaterialBytesInput {
                name: input.name.clone(),
                mime_type: input.mime_type.clone(),
                description: input.description.clone(),
                bytes,
                original_path: source
                    .as_ref()
                    .map(|s| s.page_url.clone())
                    .unwrap_or_else(|| "browser:screenshot".into()),
            },
            &MaterialImportOptions {
                folder_id: folder,
                ..Default::default()
            },
            source.as_ref(),
        )?;
        crate::publish_catalog_change_global(&imported.change);
        if imported.skipped_duplicate {
            return receipt(
                &catalog,
                &target,
                &imported.asset,
                true,
                organization_changed,
                organization_changed.then_some("consumer-duplicate-folder-created"),
            );
        }
        // Catalog imports and tag writes retain their existing transactions.
        // Report a committed asset if post-import organization fails; never
        // return a bare failure that invites an unbound second import.
        let organize = (|| -> MaterialResult<()> {
            let mut ids = input.tag_ids.clone();
            for name in &input.tag_names {
                let tag = catalog.create_tag(name, None)?;
                crate::publish_catalog_change_global(&tag.change);
                ids.push(tag.value.id);
            }
            if !ids.is_empty() {
                let change = catalog.set_asset_tags(&imported.asset.id, ids)?;
                crate::publish_catalog_change_global(&change.change);
            }
            Ok(())
        })();
        receipt(
            &catalog,
            &target,
            &imported.asset,
            false,
            true,
            organize.err().map(|_| "consumer-organization-partial"),
        )
    }
}
fn validate_name(name: &str, max: usize) -> MaterialResult<()> {
    if name.trim().is_empty()
        || name.trim() != name
        || name.chars().count() > max
        || name.chars().any(char::is_control)
    {
        return Err(invalid("名称为空或过长"));
    }
    Ok(())
}
fn validate_capture(input: &ConsumerBytesInput) -> MaterialResult<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    validate_name(&input.name, 240)?;
    if input.name.contains('/') || input.name.contains('\\') {
        return Err(invalid("文件名不能含路径"));
    }
    if input
        .description
        .as_ref()
        .is_some_and(|v| v.len() > 256 * 1024)
    {
        return Err(invalid("描述过长"));
    }
    if input.bytes_base64.len() > MAX_CAPTURE_BYTES.div_ceil(3) * 4 {
        return Err(MaterialError::new(
            "consumer-capture-too-large",
            "素材超过12MiB",
        ));
    }
    let bytes = STANDARD
        .decode(&input.bytes_base64)
        .map_err(|_| invalid("字节编码无效"))?;
    if bytes.is_empty() || bytes.len() > MAX_CAPTURE_BYTES {
        return Err(invalid("素材为空或超过12MiB"));
    }
    match input.mime_type.as_str() {
        "image/png" if input.name.to_ascii_lowercase().ends_with(".png") => {
            use image::ImageDecoder;
            let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes))
                .map_err(|_| invalid("PNG格式无效"))?;
            let (width, height) = decoder.dimensions();
            if width == 0
                || height == 0
                || width > 32767
                || height > 32767
                || u64::from(width) * u64::from(height) > 40_000_000
            {
                return Err(invalid("截图尺寸超出限制"));
            }
            let mut reader = image::ImageReader::with_format(
                std::io::Cursor::new(&bytes),
                image::ImageFormat::Png,
            );
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(32767);
            limits.max_image_height = Some(32767);
            limits.max_alloc = Some(192 * 1024 * 1024);
            reader.limits(limits);
            reader.decode().map_err(|_| invalid("PNG内容损坏"))?;
        }
        "text/markdown" if input.name.to_ascii_lowercase().ends_with(".md") => {
            std::str::from_utf8(&bytes).map_err(|_| invalid("正文需为UTF-8"))?;
        }
        "text/plain" if input.name.to_ascii_lowercase().ends_with(".txt") => {
            std::str::from_utf8(&bytes).map_err(|_| invalid("正文需为UTF-8"))?;
        }
        _ => return Err(invalid("本入口仅接收PNG截图或UTF-8正文")),
    }
    Ok(bytes)
}
fn asset_value(catalog: &MaterialCatalog, asset: &MaterialAsset) -> MaterialResult<Value> {
    Ok(
        json!({"id":asset.id,"name":asset.name,"kind":asset.kind,"mimeType":asset.mime_type,
        "sizeBytes":asset.size_bytes,"storageMode":asset.storage_mode,"description":asset.description,"folderId":asset.folder_id,
        "tagIds":catalog.get_asset_tags(&asset.id)?,"revision":catalog.revision_for_asset(asset)?}),
    )
}
fn receipt(
    catalog: &MaterialCatalog,
    target: &ConsumerTarget,
    asset: &MaterialAsset,
    duplicate: bool,
    changed: bool,
    warning: Option<&str>,
) -> MaterialResult<Value> {
    let mut result = json!({"consumerVersion":CONSUMER_VERSION,"libraryId":target.library_id,"requestId":target.request_id,
        "disposition":if duplicate {"duplicate"} else {"imported"},"changed":changed,"assetId":asset.id,"assetName":asset.name,
        "asset":asset_value(catalog,asset)?,"atomic":false,"view":{"available":false,"reason":"explicit-library-view-not-connected"}});
    if let Some(code) = warning {
        result["warning"] = json!({"code":code,"message":if code=="consumer-duplicate-folder-created" {"内容重复，保留原素材组织；本次已新建分类，请在目标库核对"} else {"素材已保存，分类标签未全部完成，请在目标库核对"}});
    }
    Ok(result)
}

#[cfg(test)]
#[path = "consumer_tests.rs"]
mod tests;
