//! Domain adapter for host-confirmed SDK/Agent object scopes. The parent broker
//! performs actor permission/lifecycle checks; ids here are host-frozen, not UI
//! active-library state or untrusted client-supplied grants.
use super::{consumer::*, MaterialCatalog, MaterialError, MaterialResult};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    library_id: String,
    request_id: String,
    #[serde(default)]
    id: Option<String>,
}
pub(crate) fn read(
    catalog: MaterialCatalog,
    selected_library_id: &str,
    selected_asset_ids: &[String],
    method: &str,
    params: &Value,
) -> MaterialResult<Value> {
    let request: ReadRequest = serde_json::from_value(params.clone())
        .map_err(|_| MaterialError::new("consumer-input-invalid", "读取字段无效"))?;
    if request.library_id != selected_library_id || selected_asset_ids.len() > 32 {
        return Err(MaterialError::new(
            "consumer-library-denied",
            "库身份不符合宿主已确认范围",
        ));
    }
    let service = MaterialConsumer::new(
        catalog,
        ConsumerAuthorization {
            libraries: BTreeMap::from([(
                selected_library_id.into(),
                ConsumerPermissions {
                    read: true,
                    ..Default::default()
                },
            )]),
            ..Default::default()
        },
    );
    let target = ConsumerTarget {
        library_id: request.library_id,
        request_id: request.request_id,
    };
    match method {
        "materials.library.read" => {
            let id = request
                .id
                .ok_or_else(|| MaterialError::new("consumer-input-invalid", "缺少素材身份"))?;
            if !selected_asset_ids.contains(&id) {
                return Err(MaterialError::new(
                    "consumer-library-denied",
                    "素材不在宿主已确认范围",
                ));
            }
            service.detail(&target, &id)
        }
        "materials.library.list" => {
            if request.id.is_some() {
                return Err(MaterialError::new(
                    "consumer-input-invalid",
                    "列表不接收素材身份",
                ));
            }
            let items = selected_asset_ids
                .iter()
                .map(|id| {
                    service
                        .detail(&target, id)
                        .map(|value| value["asset"].clone())
                })
                .collect::<MaterialResult<Vec<_>>>()?;
            // Empty scope still verifies library availability and operation id.
            if items.is_empty() {
                service.authorize_read(&target)?;
            }
            Ok(
                json!({"consumerVersion":CONSUMER_VERSION,"libraryId":target.library_id,"requestId":target.request_id,"items":items}),
            )
        }
        _ => Err(MaterialError::new(
            "consumer-method-unavailable",
            "素材消费者方法不可用",
        )),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consumer_broker_explicit_identity_and_selected_objects_do_not_expand_old_scope() {
        let base = MaterialCatalog::new_for_test();
        let root = base.app_data_dir().join("sdk-target");
        std::fs::create_dir(&root).unwrap();
        let id = base.create_library("SDK目标", &root, "managed").unwrap().id;
        let scoped = base.for_library(&id).unwrap();
        let asset = scoped
            .import_bytes(
                vec![crate::materials::MaterialBytesInput {
                    name: "sdk.md".into(),
                    mime_type: "text/markdown".into(),
                    original_path: "browser:sdk".into(),
                    bytes: b"# SDK".to_vec(),
                    description: None,
                }],
                &Default::default(),
            )
            .unwrap()
            .value
            .assets
            .remove(0);
        let params = json!({"libraryId":id,"requestId":"sdk:read","id":asset.id});
        assert!(base.get_assets(&[asset.id.clone()]).is_err());
        assert_eq!(
            read(base.clone(), &id, &[], "materials.library.read", &params)
                .unwrap_err()
                .code,
            "consumer-library-denied"
        );
        let out = read(
            base.clone(),
            &id,
            &[asset.id.clone()],
            "materials.library.read",
            &params,
        )
        .unwrap();
        assert_eq!(out["asset"]["id"], asset.id);
        assert!(!out.to_string().contains("libraryPath"));
        assert!(read(
            base.clone(),
            "foreign",
            &[asset.id.clone()],
            "materials.library.read",
            &params
        )
        .is_err());
        assert!(read(
            base.clone(),
            &id,
            &[asset.id.clone()],
            "materials.library.read",
            &json!({"libraryId":id,"requestId":"sdk:read","id":asset.id,"grants":["files"]})
        )
        .is_err());
        base.select_library(&id).unwrap();
        assert_eq!(
            read(
                base,
                &id,
                &[asset.id.clone()],
                "materials.library.list",
                &json!({"libraryId":id,"requestId":"sdk:list"})
            )
            .unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
