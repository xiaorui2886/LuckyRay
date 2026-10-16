//! Original media uses the same explicit Catalog boundary as captures. It does
//! not widen import-bytes or select a library from mutable Desktop UI state.
use super::*;

pub(crate) const MAX_ORIGINAL_IMAGE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaDestination {
    pub library_id: String,
    pub request_id: String,
    pub name: String,
    #[serde(default)]
    pub target_folder_id: Option<String>,
    #[serde(default)]
    pub new_folder_name: Option<String>,
    #[serde(default)]
    pub parent_folder_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn consumer() -> (MaterialConsumer, MediaDestination) {
        let catalog = MaterialCatalog::new_for_test();
        let id = catalog.library_state().unwrap().0;
        let authorization = ConsumerAuthorization {
            enumerate: true,
            legacy: ConsumerPermissions {
                read: true,
                import: true,
                organize: true,
                files: false,
            },
            ..Default::default()
        };
        let input = MediaDestination {
            library_id: id,
            request_id: "original-formats".into(),
            name: "test.jpg".into(),
            target_folder_id: None,
            new_folder_name: None,
            parent_folder_id: None,
            tag_ids: vec![],
            tag_names: vec![],
        };
        (MaterialConsumer::new(catalog, authorization), input)
    }

    #[test]
    fn ordinary_media_original_supported_formats_preserve_bytes_and_mismatch_refuses() {
        for (format, extension) in [
            (image::ImageFormat::Jpeg, "jpg"),
            (image::ImageFormat::Png, "png"),
            (image::ImageFormat::Gif, "gif"),
            (image::ImageFormat::WebP, "webp"),
        ] {
            let (consumer, mut destination) = consumer();
            destination.name = format!("原文件.{extension}");
            let mut bytes = std::io::Cursor::new(Vec::new());
            image::DynamicImage::new_rgb8(32, 32)
                .write_to(&mut bytes, format)
                .unwrap();
            let bytes = bytes.into_inner();
            let input = MaterialBytesInput {
                name: destination.name.clone(),
                mime_type: format.to_mime_type().into(),
                bytes: bytes.clone(),
                description: None,
                original_path: "https://example.test/media".into(),
            };
            let result = consumer
                .import_original_image_checked(&destination, input, None, || Ok(()))
                .unwrap();
            let asset = consumer
                .catalog
                .for_library(&destination.library_id)
                .unwrap()
                .get_assets(&[result["assetId"].as_str().unwrap().into()])
                .unwrap()
                .remove(0);
            assert_eq!(std::fs::read(asset.library_path.unwrap()).unwrap(), bytes);
            destination.name = "wrong.txt".into();
            let input = MaterialBytesInput {
                name: destination.name.clone(),
                mime_type: "image/jpeg".into(),
                bytes,
                description: None,
                original_path: "https://example.test/media".into(),
            };
            assert!(consumer
                .import_original_image_checked(&destination, input, None, || Ok(()))
                .is_err());
        }
    }

    #[test]
    fn ordinary_media_postcommit_organization_failure_keeps_asset_receipt_and_does_not_reimport() {
        let (consumer, mut destination) = consumer();
        let catalog = consumer
            .catalog
            .for_library(&destination.library_id)
            .unwrap();
        let imported = import_consumer_material_with_source(
            &catalog,
            MaterialBytesInput {
                name: "saved.jpg".into(),
                mime_type: "image/jpeg".into(),
                bytes: b"already committed fixture".to_vec(),
                description: None,
                original_path: "https://example.test/image".into(),
            },
            &Default::default(),
            None,
        )
        .unwrap();
        destination.target_folder_id = Some("folder-removed-after-commit".into());
        let receipt = consumer.finish_media(&catalog, &destination, &imported);
        assert_eq!(receipt["assetId"], imported.asset.id);
        assert_eq!(receipt["ok"], true);
        assert_eq!(receipt["organization"]["state"], "partial");
        assert_eq!(receipt["warning"]["code"], "consumer-organization-partial");
        assert_eq!(catalog.list_assets(&Default::default()).unwrap().len(), 1);
    }

    #[test]
    fn ordinary_media_organize_permission_and_offline_library_refuse_before_commit() {
        let (mut consumer, mut destination) = consumer();
        let path = consumer
            .catalog
            .app_data_dir()
            .join("ordinary-media-permission-library");
        std::fs::create_dir(&path).unwrap();
        destination.library_id = consumer
            .catalog
            .create_library("Permission", &path, "managed")
            .unwrap()
            .id;
        consumer.authorization.libraries.insert(
            destination.library_id.clone(),
            ConsumerPermissions {
                read: true,
                import: true,
                organize: false,
                files: false,
            },
        );
        destination.tag_names.push("tag".into());
        assert_eq!(
            consumer
                .validate_media_destination(&destination)
                .err()
                .unwrap()
                .code,
            "consumer-library-denied"
        );
        assert!(consumer
            .catalog
            .for_library(&destination.library_id)
            .unwrap()
            .list_assets(&Default::default())
            .unwrap()
            .is_empty());
        consumer
            .authorization
            .libraries
            .get_mut(&destination.library_id)
            .unwrap()
            .organize = true;
        consumer
            .catalog
            .set_library_visible(&destination.library_id, false)
            .unwrap();
        assert!(consumer.validate_media_destination(&destination).is_err());
        consumer
            .catalog
            .set_library_visible(&destination.library_id, true)
            .unwrap();
        let moved = consumer
            .catalog
            .app_data_dir()
            .join("ordinary-media-offline-library");
        assert_eq!(
            path.canonicalize().unwrap().parent(),
            Some(
                consumer
                    .catalog
                    .app_data_dir()
                    .canonicalize()
                    .unwrap()
                    .as_path()
            )
        );
        assert_eq!(moved.parent(), Some(consumer.catalog.app_data_dir()));
        std::fs::rename(&path, &moved).unwrap();
        assert!(consumer.validate_media_destination(&destination).is_err());
    }
}

impl MediaDestination {
    pub(crate) fn target(&self) -> ConsumerTarget {
        ConsumerTarget {
            library_id: self.library_id.clone(),
            request_id: self.request_id.clone(),
        }
    }
    fn needs_organization(&self) -> bool {
        self.target_folder_id.is_some()
            || self.new_folder_name.is_some()
            || !self.tag_ids.is_empty()
            || !self.tag_names.is_empty()
    }
}

pub(crate) fn validate_media_filename(name: &str) -> MaterialResult<()> {
    validate_name(name, 240)?;
    if name.len() > 240
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(invalid("文件名含路径或不支持的字符"));
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
    {
        return Err(invalid("文件名为系统保留名称"));
    }
    Ok(())
}

impl MaterialConsumer {
    /// No directory/tag/download side effects before these checks succeed.
    pub(crate) fn validate_media_destination(
        &self,
        input: &MediaDestination,
    ) -> MaterialResult<MaterialCatalog> {
        let target = input.target();
        self.authorize_import(&target)?;
        let catalog = self.bind(&target, "import")?;
        if !self
            .catalog
            .list_libraries(true)?
            .iter()
            .any(|l| l.id == input.library_id && l.visible)
        {
            return Err(MaterialError::new(
                "consumer-library-denied",
                "素材库已不可见",
            ));
        }
        validate_media_filename(&input.name)?;
        if input.parent_folder_id.is_some() && input.new_folder_name.is_none() {
            return Err(invalid("父分类仅用于新建分类"));
        }
        if input.tag_ids.len() + input.tag_names.len() > 32 {
            return Err(invalid("每次最多32个标签"));
        }
        if input.needs_organization() {
            self.bind(&target, "organize")?;
        }
        let mut folders = vec![];
        flatten(catalog.list_folders()?, &mut folders);
        for id in [&input.target_folder_id, &input.parent_folder_id]
            .into_iter()
            .flatten()
        {
            if !valid_consumer_id(id) || !folders.iter().any(|f| f["id"].as_str() == Some(id)) {
                return Err(MaterialError::new(
                    "consumer-folder-denied",
                    "分类不属于此素材库",
                ));
            }
        }
        let tags = catalog.list_tags()?;
        if input
            .tag_ids
            .iter()
            .any(|id| !valid_consumer_id(id) || !tags.iter().any(|tag| &tag.id == id))
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
        Ok(catalog)
    }

    pub(crate) fn import_original_image_checked<G>(
        &self,
        destination: &MediaDestination,
        mut input: MaterialBytesInput,
        source: Option<&MaterialSourcePageInput>,
        before_write: impl FnOnce() -> MaterialResult<G>,
    ) -> MaterialResult<Value> {
        self.validate_media_destination(destination)?;
        if input.bytes.is_empty() || input.bytes.len() > MAX_ORIGINAL_IMAGE_BYTES {
            return Err(MaterialError::new(
                "consumer-media-too-large",
                "原图大小超出限制",
            ));
        }
        let format = image::guess_format(&input.bytes).map_err(|_| invalid("原图格式无效"))?;
        let extension = destination
            .name
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .ok_or_else(|| invalid("文件名需保留原图扩展名"))?;
        if !format.extensions_str().contains(&extension.as_str()) {
            return Err(invalid("文件名与原图格式不符"));
        }
        let mut reader =
            image::ImageReader::with_format(std::io::Cursor::new(&input.bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(32767);
        limits.max_image_height = Some(32767);
        limits.max_alloc = Some(192 * 1024 * 1024);
        reader.limits(limits);
        reader
            .decode()
            .map_err(|_| invalid("图片内容损坏或尺寸超限"))?;
        input.name = destination.name.clone();
        input.mime_type = format.to_mime_type().to_owned();
        let _guard = before_write()?;
        let catalog = self.validate_media_destination(destination)?;
        // The Catalog's fixed keep-existing policy also covers concurrent dedupe.
        let imported =
            import_consumer_material_with_source(&catalog, input, &Default::default(), source)?;
        crate::publish_catalog_change_global(&imported.change);
        Ok(self.finish_media(&catalog, destination, &imported))
    }

    pub(crate) fn import_original_video_checked<G>(
        &self,
        destination: &MediaDestination,
        input: MaterialStagedFileInput,
        source: Option<&MaterialSourcePageInput>,
        before_write: impl FnOnce() -> MaterialResult<G>,
    ) -> MaterialResult<(ResolvedMaterialImport, Value)> {
        self.validate_media_destination(destination)?;
        let _guard = before_write()?;
        let catalog = self.validate_media_destination(destination)?;
        let expected_hash = input.expected_sha256.clone();
        let CatalogOutcome { value, change } =
            catalog.import_consumer_staged_file_with_source(input, &Default::default(), source)?;
        let duplicate = value.skipped_duplicate_count > 0;
        let asset = value
            .assets
            .into_iter()
            .next()
            .or(catalog.find_managed_asset_by_hash(&expected_hash)?)
            .ok_or_else(|| MaterialError::new("missing-import-result", "导入结果缺少对应素材"))?;
        let imported = ResolvedMaterialImport {
            asset,
            skipped_duplicate: duplicate,
            change,
        };
        let receipt = self.finish_media(&catalog, destination, &imported);
        Ok((imported, receipt))
    }

    fn finish_media(
        &self,
        catalog: &MaterialCatalog,
        destination: &MediaDestination,
        imported: &ResolvedMaterialImport,
    ) -> Value {
        // Only a new committed asset may cause organization writes. Duplicates
        // preserve name/folder/tags/source even when two imports race.
        let mut partial = false;
        if !imported.skipped_duplicate {
            let organization = (|| -> MaterialResult<()> {
                self.validate_media_destination(destination)?;
                let folder = if let Some(name) = &destination.new_folder_name {
                    let created = catalog.create_folder(MaterialFolderInput {
                        name: name.clone(),
                        parent_id: destination
                            .parent_folder_id
                            .clone()
                            .or(destination.target_folder_id.clone()),
                    })?;
                    crate::publish_catalog_change_global(&created.change);
                    Some(created.value.id)
                } else {
                    destination.target_folder_id.clone()
                };
                if let Some(folder_id) = folder {
                    let updated = catalog.update_asset(
                        &imported.asset.id,
                        MaterialAssetPatch {
                            folder_id: PatchValue::Value(Some(folder_id)),
                            ..Default::default()
                        },
                        "consumer-media-organize",
                    )?;
                    crate::publish_catalog_change_global(&updated.change);
                }
                let mut ids = destination.tag_ids.clone();
                for name in &destination.tag_names {
                    let created = catalog.create_tag(name, None)?;
                    crate::publish_catalog_change_global(&created.change);
                    ids.push(created.value.id);
                }
                if !ids.is_empty() {
                    let updated = catalog.set_asset_tags(&imported.asset.id, ids)?;
                    crate::publish_catalog_change_global(&updated.change);
                }
                Ok(())
            })();
            partial = organization.is_err();
        }
        let asset = catalog
            .get_assets(&[imported.asset.id.clone()])
            .ok()
            .and_then(|a| a.into_iter().next())
            .unwrap_or_else(|| {
                partial = true;
                imported.asset.clone()
            });
        let projected = asset_value(catalog, &asset).unwrap_or_else(|_| {
            partial = true;
            json!({"id":asset.id,"name":asset.name,"kind":asset.kind,"mimeType":asset.mime_type,"folderId":asset.folder_id})
        });
        let mut result = json!({"ok":true,"consumerVersion":CONSUMER_VERSION,"libraryId":destination.library_id,
            "requestId":destination.request_id,"assetId":asset.id,"assetName":asset.name,"asset":projected,
            "disposition":if imported.skipped_duplicate {"duplicate"} else {"imported"},"changed":!imported.skipped_duplicate,
            "organization":{"state":if partial {"partial"} else if imported.skipped_duplicate {"preserved"} else {"applied"}},
            "atomic":false,"view":{"available":false,"reason":"explicit-library-view-not-connected"}});
        if partial {
            result["warning"] = json!({"code":"consumer-organization-partial","message":"素材已保存，分类标签未全部完成，请在目标库核对"});
        }
        result
    }
}
