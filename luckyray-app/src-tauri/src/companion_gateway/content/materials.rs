// Wave-A Desktop Companion Gateway — material organization mutations.
//
// Additive Content V1 surface: favorite / tag / folder organization for
// Desktop materials, driven by Mobile. Desktop remains the single authority —
// every operation delegates to the EXISTING services:
//   favorites::add / favorites::remove          (favorite_item authority)
//   MaterialCatalog::create_tag                 (tag authority)
//   MaterialCatalog::set_asset_tags             (tag authority)
//   MaterialCatalog::create_folder              (folder authority)
//   MaterialCatalog::move_asset                 (folder authority)
// and publishes through the EXISTING material change authority
// (emit_catalog_change_global) so Desktop UI converges without a restart.
//
// Operations are DESIRED-STATE by semantics: `favorited: true|false`, an exact
// tag set, an explicit folder id or null. A retry therefore cannot flip state,
// which is why Wave A needs no operation journal and no toggle route.
use serde::Deserialize;
use serde_json::{json, Value};

use super::{query, ContentResult, HttpRequest};
use crate::companion_gateway::CompanionGateway;

/// Bounded batch size for one organization request.
const MAX_BATCH_ASSETS: usize = 100;
const MAX_ID_CHARS: usize = 160;
const MAX_TAG_NAME_CHARS: usize = 80;
const MAX_FOLDER_NAME_CHARS: usize = 120;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FavoriteInput {
    #[serde(rename = "desktopAssetId")]
    desktop_asset_id: String,
    favorited: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TagsInput {
    #[serde(rename = "desktopAssetId")]
    desktop_asset_id: String,
    #[serde(default)]
    set: Option<Vec<String>>,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FolderInput {
    #[serde(rename = "desktopAssetId")]
    desktop_asset_id: String,
    #[serde(rename = "folderId")]
    folder_id: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateTagInput {
    name: String,
    #[serde(default)]
    color: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateFolderInput {
    name: String,
    #[serde(rename = "parentId", default)]
    parent_id: Option<String>,
}

/// Batch input with a PRESENCE-AWARE folder intent.
///
/// Serde folds an absent field and an explicit JSON null into the same
/// `Option<Option<_>>` = None, so the folder decision is parsed from the raw
/// JSON object: absent = leave the folder alone, null = root, string = target.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchInput {
    #[serde(rename = "desktopAssetIds")]
    desktop_asset_ids: Vec<String>,
    #[serde(rename = "favorited", default)]
    favorited: Option<bool>,
    #[serde(default)]
    add: Vec<String>,
    #[serde(default)]
    remove: Vec<String>,
    #[serde(rename = "folderId", default)]
    folder_id: Option<String>,
}

impl BatchInput {
    /// Parse the body and derive the tri-state folder decision from presence.
    fn parse(body: &str) -> Result<(Self, Option<Option<String>>), (u16, &'static str)> {
        let raw: Value = serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        if !raw.is_object() {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        // Validate the folder shape BEFORE the struct pass so a wrong type is a
        // bounded 400 rather than a serde type error.
        let folder: Option<Option<String>> = match raw.get("folderId") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(Value::String(id)) => Some(Some(id.clone())),
            Some(_) => return Err(fail("CONTENT_INPUT_INVALID")),
        };
        let input: BatchInput =
            serde_json::from_value(raw).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        Ok((input, folder))
    }
}

/// The HTTP method each Wave-A route declares. `None` means the path is not a
/// Wave-A route (the caller then falls through to the 404 path).
fn declared_method(path: &str) -> Option<&'static str> {
    match path {
        "/v1/assets/favorite-batch" | "/v1/assets/tags" | "/v1/assets/folders" => Some("POST"),
        _ => {
            let rest = path.strip_prefix("/v1/assets/")?;
            if rest.ends_with("/favorite") {
                Some("POST")
            } else if rest.ends_with("/tags") || rest.ends_with("/folder") {
                Some("PATCH")
            } else {
                None
            }
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_CHARS
        && id.trim() == id
        && !id.chars().any(char::is_control)
}

fn fail(code: &'static str) -> (u16, &'static str) {
    (400, code)
}

/// Entry point used by `content::json_route` for non-GET `/v1/assets/...`.
pub(super) fn mutate_route(
    gateway: &CompanionGateway,
    request: &HttpRequest,
) -> ContentResult<Value> {
    query(&request.path, &[])?;
    let path = request.path.split('?').next().unwrap_or("");
    // Strict method matrix: a route only answers its declared verb. Any other
    // method fails closed with 405 BEFORE any authority is touched.
    if let Some(allowed) = declared_method(path) {
        if request.method != allowed {
            return Err((405, "METHOD_NOT_ALLOWED"));
        }
    }
    if request.body.is_empty() {
        return Err(fail("CONTENT_BODY_MISSING"));
    }
    let body = std::str::from_utf8(&request.body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
    let catalog = gateway.material_catalog();

    // ---- collection-level operations (no asset id) ----
    if path == "/v1/assets/favorite-batch" {
        return Ok(batch(gateway, body)?);
    }
    if path == "/v1/assets/tags" {
        let input: CreateTagInput =
            serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_TAG_NAME_CHARS {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        if let Some(color) = input.color.as_deref() {
            if color.len() > 32 || color.chars().any(char::is_control) {
                return Err(fail("CONTENT_INPUT_INVALID"));
            }
        }
        let outcome = catalog
            .create_tag(name, input.color)
            .map_err(|_| (409, "CONTENT_TAG_REJECTED"))?;
        publish(&outcome.change);
        return Ok(json!({"tag": outcome.value}));
    }
    if path == "/v1/assets/folders" {
        let input: CreateFolderInput =
            serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        let name = input.name.trim();
        if name.is_empty() || name.chars().count() > MAX_FOLDER_NAME_CHARS {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        if let Some(parent) = input.parent_id.as_deref() {
            if !valid_id(parent) {
                return Err(fail("CONTENT_INPUT_INVALID"));
            }
        }
        let outcome = catalog
            .create_folder(crate::materials::MaterialFolderInput {
                parent_id: input.parent_id.clone(),
                name: name.to_owned(),
            })
            .map_err(|_| (409, "CONTENT_FOLDER_REJECTED"))?;
        publish(&outcome.change);
        return Ok(json!({"folder": outcome.value}));
    }

    // ---- per-asset operations ----
    let id = path
        .strip_prefix("/v1/assets/")
        .and_then(|rest| rest.strip_suffix("/favorite"))
        .filter(|s| valid_id(s));
    if let Some(id) = id {
        let input: FavoriteInput =
            serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        if input.desktop_asset_id != id {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        return Ok(set_favorite(gateway, id, input.favorited)?);
    }
    let id = path
        .strip_prefix("/v1/assets/")
        .and_then(|rest| rest.strip_suffix("/tags"))
        .filter(|s| valid_id(s));
    if let Some(id) = id {
        let input: TagsInput =
            serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        if input.desktop_asset_id != id {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        return Ok(set_tags(gateway, id, input)?);
    }
    let id = path
        .strip_prefix("/v1/assets/")
        .and_then(|rest| rest.strip_suffix("/folder"))
        .filter(|s| valid_id(s));
    if let Some(id) = id {
        let input: FolderInput =
            serde_json::from_str(body).map_err(|_| fail("CONTENT_INPUT_INVALID"))?;
        if input.desktop_asset_id != id {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        let folder_id = match input.folder_id {
            Value::Null => None,
            Value::String(folder_id) => Some(folder_id),
            _ => return Err(fail("CONTENT_INPUT_INVALID")),
        };
        return Ok(set_folder(gateway, id, folder_id)?);
    }
    Err((404, "NOT_FOUND"))
}

/// Idempotent desired-state favorite (delegates to the favorite_item authority).
fn set_favorite(gateway: &CompanionGateway, id: &str, favorited: bool) -> ContentResult<Value> {
    let catalog = gateway.material_catalog();
    if catalog
        .get_assets(&[id.to_owned()])
        .map_err(|_| (404, "CONTENT_ASSET_NOT_FOUND"))?
        .is_empty()
    {
        return Err((404, "CONTENT_ASSET_NOT_FOUND"));
    }
    let mut connection = catalog.companion_open_write()
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    if favorited {
        crate::favorites::add(
            &mut connection,
            crate::favorites::FavoriteItemType::Material,
            id,
        )
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    } else {
        crate::favorites::remove(
            &mut connection,
            crate::favorites::FavoriteItemType::Material,
            id,
        )
        .map_err(|_| (503, "CONTENT_UNAVAILABLE"))?;
    }
    // Favorite is material organization too: advance the SAME durable change
    // authority the catalog uses, so existing Desktop surfaces invalidate and
    // re-read instead of relying on a transient synthetic event.
    let change = catalog.publish_favorite_change(id).map_err(|e| {
        eprintln!("favorite-change-failed: {} {}", e.code, e.message);
        (503, "CONTENT_UNAVAILABLE")
    })?;
    publish(&Some(change));
    Ok(json!({"desktopAssetId": id, "favorited": favorited}))
}

/// Exact-set / add / remove tags, preserving tags the caller did not target.
fn set_tags(gateway: &CompanionGateway, id: &str, input: TagsInput) -> ContentResult<Value> {
    let catalog = gateway.material_catalog();
    let current = catalog
        .get_asset_tags(id)
        .map_err(|_| (404, "CONTENT_ASSET_NOT_FOUND"))?;
    let next: Vec<String> = if let Some(exact) = input.set {
        if exact.iter().any(|t| !valid_id(t)) {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        exact
    } else {
        if input.add.iter().chain(input.remove.iter()).any(|t| !valid_id(t)) {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
        let mut next = current.clone();
        for tag in input.add {
            if !next.contains(&tag) {
                next.push(tag);
            }
        }
        next.retain(|tag| !input.remove.contains(tag));
        next
    };
    let outcome = catalog
        .set_asset_tags(id, next)
        .map_err(|_| (409, "CONTENT_TAG_REJECTED"))?;
    publish(&outcome.change);
    Ok(json!({"desktopAssetId": id, "tags": outcome.value}))
}

/// Move to an existing folder or root (`folderId: null`).
fn set_folder(
    gateway: &CompanionGateway,
    id: &str,
    folder_id: Option<String>,
) -> ContentResult<Value> {
    if let Some(folder) = folder_id.as_deref() {
        if !valid_id(folder) {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
    }
    let catalog = gateway.material_catalog();
    let outcome = catalog
        .move_asset(id, folder_id.as_deref())
        .map_err(|_| (404, "CONTENT_FOLDER_REJECTED"))?;
    if !outcome.value {
        return Err((404, "CONTENT_ASSET_NOT_FOUND"));
    }
    publish(&outcome.change);
    Ok(json!({"desktopAssetId": id, "folderId": folder_id}))
}

/// Bounded batch organization. Not claimed atomic: the result reports which
/// assets succeeded and which failed with a bounded reason code.
fn batch(gateway: &CompanionGateway, body: &str) -> ContentResult<Value> {
    let (input, folder) = BatchInput::parse(body)?;
    if input.desktop_asset_ids.is_empty() || input.desktop_asset_ids.len() > MAX_BATCH_ASSETS {
        return Err(fail("CONTENT_BATCH_TOO_LARGE"));
    }
    if input.desktop_asset_ids.iter().any(|id| !valid_id(id)) {
        return Err(fail("CONTENT_INPUT_INVALID"));
    }
    if input.add.iter().chain(input.remove.iter()).any(|t| !valid_id(t)) {
        return Err(fail("CONTENT_INPUT_INVALID"));
    }
    // Tri-state: absent = leave the folder alone, null = root, string = target.
    if let Some(Some(id)) = folder.as_ref() {
        if !valid_id(id) {
            return Err(fail("CONTENT_INPUT_INVALID"));
        }
    }

    let catalog = gateway.material_catalog();
    let mut succeeded: Vec<String> = Vec::new();
    let mut failed: Vec<Value> = Vec::new();

    for id in &input.desktop_asset_ids {
        let mut reason: Option<&'static str> = None;
        // favorite
        if reason.is_none() {
            if let Some(favorited) = input.favorited {
                if let Err(_) = set_favorite(gateway, id, favorited) {
                    reason = Some("favorite-failed");
                }
            }
        }
        // tags (add/remove over the current set). A failure to READ the
        // authoritative set must not be mistaken for "no tags" — writing back
        // an empty set would silently drop existing tags, so the asset is
        // reported as failed instead.
        if reason.is_none() && (!input.add.is_empty() || !input.remove.is_empty()) {
            match catalog.get_asset_tags(id) {
                Ok(current) => {
                    let mut next = current;
                    for tag in &input.add {
                        if !next.contains(tag) {
                            next.push(tag.clone());
                        }
                    }
                    next.retain(|tag| !input.remove.contains(tag));
                    match catalog.set_asset_tags(id, next) {
                        Ok(outcome) => publish(&outcome.change),
                        Err(_) => reason = Some("tag-failed"),
                    }
                }
                Err(_) => reason = Some("tag-failed"),
            }
        }
        // folder
        if reason.is_none() {
            if let Some(target) = folder.clone() {
                match catalog.move_asset(id, target.as_deref()) {
                    Ok(outcome) if outcome.value => publish(&outcome.change),
                    Ok(_) | Err(_) => reason = Some("folder-failed"),
                }
            }
        }
        match reason {
            None => succeeded.push(id.clone()),
            Some(code) => failed.push(json!({"desktopAssetId": id, "reason": code})),
        }
    }

    Ok(json!({
        "requested": input.desktop_asset_ids.len(),
        "succeeded": succeeded,
        "failed": failed,
        // The batch is NOT atomic: an asset listed as failed may still have had
        // some of its sub-operations applied, so the caller MUST re-read the
        // authoritative state rather than assume the failure left it untouched.
        "atomic": false,
    }))
}

fn publish(change: &Option<crate::materials::MaterialChange>) {
    crate::publish_catalog_change_global(change);
}

/// Test hook: the same authorities without a live TLS gateway.
pub(super) fn route_for_test(
    gateway: &CompanionGateway,
    method: &str,
    path: &str,
    body: &str,
) -> ContentResult<Value> {
    mutate_route(
        gateway,
        &HttpRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: Default::default(),
            body: body.as_bytes().to_vec(),
        },
    )
}


#[cfg(test)]
mod tests {
    use super::super::{asset_value, favorite_ids};
    use super::*;
    use crate::backend::BackendServices;
    use crate::companion_gateway::{GatewayPolicy, ProtectedIdentityStore};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};
    use zeroize::Zeroizing;

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<Vec<u8>>>);
    impl ProtectedIdentityStore for MemoryStore {
        fn load(
            &self,
        ) -> Result<Option<Zeroizing<Vec<u8>>>, crate::companion_gateway::GatewayError> {
            Ok(self.0.lock().unwrap().clone().map(Zeroizing::new))
        }
        fn store(&self, bytes: &[u8]) -> Result<(), crate::companion_gateway::GatewayError> {
            *self.0.lock().unwrap() = Some(bytes.to_vec());
            Ok(())
        }
        fn remove(&self) -> Result<(), crate::companion_gateway::GatewayError> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    struct Fixture {
        _root: tempfile::TempDir,
        gateway: Arc<CompanionGateway>,
        asset_id: String,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        let backend = Arc::new(BackendServices::initialize(&app).unwrap());
        let gateway = CompanionGateway::initialize_with_store(
            backend,
            Arc::new(MemoryStore::default()),
            GatewayPolicy::default(),
        );
        // Authenticated synthetic paired device: exercise the real credential
        // verifier before invoking the post-auth content serving boundary.
        let device = format!("device-{}", "a".repeat(32));
        let secret = "b".repeat(64);
        let verifier = crate::companion_gateway::credential_verifier(
            gateway.identity().unwrap().verifier_key.as_slice(),&device,secret.as_bytes()).unwrap();
        crate::companion_gateway::open_connection(gateway.backend.db_path()).unwrap().execute(
            "INSERT INTO companion_device(device_id,label,credential_verifier,created_at) VALUES(?1,'Content fixture',?2,'2026-10-23T00:00:00Z')",
            rusqlite::params![device,verifier.to_vec()]).unwrap();
        let source = root.path().join("sample.txt");
        std::fs::write(&source, b"wave-a").unwrap();
        let catalog = gateway.material_catalog();
        let imported = catalog
            .import_paths(
                &[source.to_string_lossy().into_owned().into()],
                &crate::materials::MaterialImportOptions::default(),
            )
            .unwrap();
        let asset_id = imported
            .value
            .assets
            .first()
            .map(|asset| asset.id.clone())
            .expect("imported asset id");
        Fixture { _root: root, gateway, asset_id }
    }

    fn call(
        gateway: &CompanionGateway,
        method: &str,
        path: &str,
        body: Value,
    ) -> ContentResult<Value> {
        route_for_test(gateway, method, path, &body.to_string())
    }

    fn auth_headers() -> std::collections::HashMap<String,String> {
        std::collections::HashMap::from([("authorization".into(),format!("Bearer device-{}.{}","a".repeat(32),"b".repeat(64)))])
    }

    fn http_response(
        gateway: &CompanionGateway,
        method: &str,
        path: &str,
        body: Value,
    ) -> (u16, Vec<u8>) {
        let request = HttpRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: auth_headers(),
            body: body.to_string().into_bytes(),
        };
        gateway.authenticate_request(&request).unwrap();
        let mut response = Vec::new();
        super::super::serve(gateway, &request, &mut response, &AtomicBool::new(false)).unwrap();
        let boundary = response.windows(4).position(|bytes| bytes == b"\r\n\r\n").unwrap();
        let headers = std::str::from_utf8(&response[..boundary]).unwrap();
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, response[boundary + 4..].to_vec())
    }

    fn http_json(
        gateway: &CompanionGateway,
        method: &str,
        path: &str,
        body: Value,
    ) -> (u16, Value) {
        let (status, body) = http_response(gateway, method, path, body);
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[test]
    fn material_http_pagination_preserves_more_than_one_hundred_distinct_ids() {
        let f = fixture();
        let inputs = (0..120).map(|index| crate::materials::MaterialBytesInput {
            name: format!("audit-page-{index:03}.txt"),
            original_path: format!("https://example.test/audit-page-{index:03}"),
            mime_type: "text/plain".into(),
            bytes: format!("synthetic unique material {index:03}").into_bytes(),
            description: None,
        }).collect();
        let imported = f.gateway.backend.material_catalog().import_bytes(
            inputs, &crate::materials::MaterialImportOptions::default()
        ).unwrap();
        let mut expected: std::collections::HashSet<String> = imported.value.assets.iter()
            .map(|asset| asset.id.clone()).collect();
        assert_eq!(expected.len(), 120);
        expected.insert(f.asset_id.clone());
        let mut seen = std::collections::HashSet::new();
        for (page, count, more) in [(1, 100, true), (2, 21, false), (3, 0, false)] {
            let (status, result) = http_json(&f.gateway, "GET",
                &format!("/v1/assets?page={page}&limit=100"), json!(null));
            assert_eq!(status, 200);
            assert_eq!(result["items"].as_array().unwrap().len(), count);
            assert_eq!(result["hasMore"], more);
            assert_eq!(result["nextPage"], if more { json!(page + 1) } else { Value::Null });
            for item in result["items"].as_array().unwrap() {
                let id = item["desktopAssetId"].as_str().unwrap().to_owned();
                assert!(seen.insert(id), "pagination repeated an asset ID");
            }
        }
        assert_eq!(seen, expected, "pagination lost or substituted an asset ID");
    }

    #[test]
    fn saved_material_selection_is_independent_and_never_falls_back() {
        let f=fixture(); let catalog=f.gateway.material_catalog();
        let active=catalog.library_state().unwrap().1;
        let root=f._root.path().join("selected"); std::fs::create_dir(&root).unwrap();
        let library=catalog.create_library("Selected",&root,"managed").unwrap();
        let foreign=catalog.for_library(&library.id).unwrap().import_bytes(vec![crate::materials::MaterialBytesInput {
            name:"selected.txt".into(), original_path:"https://example.test/selected".into(), mime_type:"text/plain".into(), bytes:b"selected bytes".to_vec(), description:None,
        }],&crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        let device=format!("device-{}","a".repeat(32));
        f.gateway.set_authorization_mode(&device,crate::companion_gateway::trust_policy::AuthorizationMode::Trusted,0).unwrap();
        let mut headers=auth_headers(); headers.insert("x-luckyray-material-library".into(),library.id.clone());
        let request=HttpRequest{method:"GET".into(),path:format!("/v1/assets/{}",foreign.id),headers:headers.clone(),body:vec![]};
        let scoped=f.gateway.scope_for_request(&request).unwrap();
        assert!(Arc::ptr_eq(&scoped.transition,&f.gateway.transition));
        assert!(Arc::ptr_eq(&scoped.content_state,&f.gateway.content_state));
        assert_eq!(scoped.material_catalog().get_assets(&[foreign.id.clone()]).unwrap().len(),1);
        assert_eq!(scoped.material_catalog().get_assets(&[f.asset_id.clone()]).unwrap_err().code, "material-library-scope");
        let mut response=vec![];super::super::serve(&f.gateway,&request,&mut response,&AtomicBool::new(false)).unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200"));
        assert_eq!(catalog.library_state().unwrap().1,active);
        headers.insert("x-luckyray-material-library".into(),"missing-library".into());
        assert!(f.gateway.scope_for_request(&HttpRequest{method:"GET".into(),path:"/v1/assets".into(),headers,body:vec![]}).is_err());
        catalog.set_library_visible(&library.id,false).unwrap();
        assert!(scoped.validate_request_scope().is_err());
    }

    #[test]
    fn explicit_manual_and_trusted_off_switch_gate_content() {
        let f=fixture(); let device=format!("device-{}","a".repeat(32));
        let request=HttpRequest{method:"GET".into(),path:"/v1/assets".into(),headers:auth_headers(),body:vec![]};
        assert!(super::super::access(&f.gateway,&request).is_ok(),"legacy policy absent stays compatible");
        f.gateway.set_authorization_mode(&device,crate::companion_gateway::trust_policy::AuthorizationMode::Manual,0).unwrap();
        assert_eq!(super::super::access(&f.gateway,&request),Err((403,"GRANT_REQUIRED")));
        f.gateway.set_authorization_mode(&device,crate::companion_gateway::trust_policy::AuthorizationMode::Trusted,1).unwrap();
        assert!(super::super::access(&f.gateway,&request).is_ok());
        f.gateway.set_service_grant(&device,"content.read","catalog","",false).unwrap();
        assert_eq!(super::super::access(&f.gateway,&request),Err((403,"SCOPE_DENIED")));
        let absent=HttpRequest{method:"GET".into(),path:"/v1/assets".into(),headers:Default::default(),body:vec![]};
        assert_eq!(super::super::access(&f.gateway,&absent),Err((401,"PAIRING_REQUIRED")));
    }

    #[test]
    fn serve_reaches_single_asset_favorite_and_reads_the_durable_state() {
        let f = fixture();
        let path = format!("/v1/assets/{}/favorite", f.asset_id);
        let (status, mutation) = http_json(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "favorited": true}),
        );
        assert_eq!(status, 200, "single-asset write must reach the real serve path: {mutation}");
        assert_eq!(mutation["favorited"], true);
        let (status, detail) = http_json(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 200);
        assert_eq!(detail["favorite"], true);
        let connection = f.gateway.backend.open_read().unwrap();
        let saved = crate::favorites::list(&connection, crate::favorites::FavoriteItemType::Material).unwrap();
        assert!(saved.iter().any(|item| item.item_id == f.asset_id));
    }
    #[test]
    fn material_library_r1_http_detail_bytes_and_mutations_stay_default_after_ui_switch() {
        let f=fixture();let c=f.gateway.material_catalog();
        let root=f._root.path().join("B");std::fs::create_dir(&root).unwrap();let lib=c.create_library("B",&root,"managed").unwrap();let b=c.for_library(&lib.id).unwrap();
        let foreign=b.import_bytes(vec![crate::materials::MaterialBytesInput{name:"foreign.txt".into(),original_path:"https://example.test/foreign".into(),mime_type:"text/plain".into(),bytes:b"B private bytes".to_vec(),description:None}],&crate::materials::MaterialImportOptions::default()).unwrap().value.assets.remove(0);
        c.select_library(&lib.id).unwrap();
        for path in [format!("/v1/assets/{}",foreign.id),format!("/v1/assets/{}/file",foreign.id),format!("/v1/assets/{}/thumb",foreign.id)] {
            let(status,body)=http_response(&f.gateway,"GET",&path,json!(null));assert!(status>=400);assert!(!String::from_utf8_lossy(&body).contains("B private bytes"));
        }
        for (path,body) in [
            (format!("/v1/assets/{}/favorite",foreign.id),json!({"desktopAssetId":foreign.id,"favorited":true})),
            (format!("/v1/assets/{}/tags",foreign.id),json!({"desktopAssetId":foreign.id,"set":[]})),
        ] {assert!(call(&f.gateway,if path.ends_with("/tags") {"PATCH"} else {"POST"},&path,body).is_err());}
        let(status,detail)=http_json(&f.gateway,"GET",&format!("/v1/assets/{}",f.asset_id),json!(null));assert_eq!(status,200);assert_eq!(detail["desktopAssetId"],f.asset_id);
        let mut headers=auth_headers();headers.insert("range".into(),"bytes=1-3".into());
        let request=HttpRequest{method:"GET".into(),path:format!("/v1/assets/{}/file",f.asset_id),headers,body:vec![]};let mut response=vec![];
        super::super::serve(&f.gateway,&request,&mut response,&AtomicBool::new(false)).unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 206"));assert!(response.ends_with(b"ave"));
    }

    #[test]
    fn serve_asset_tags_reach_the_catalog_and_wrong_methods_stay_closed() {
        let f = fixture();
        let (status, created) = http_json(
            &f.gateway,
            "POST",
            "/v1/assets/tags",
            json!({"name": "Wave A"}),
        );
        assert_eq!(status, 200);
        let tag_id = created["tag"]["id"].as_str().unwrap();
        let path = format!("/v1/assets/{}/tags", f.asset_id);
        let (status, updated) = http_json(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "set": [tag_id]}),
        );
        assert_eq!(status, 200, "tag mutation uses the real HTTP route: {updated}");
        let (status, detail) = http_json(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 200);
        assert!(detail["tags"].as_array().unwrap().iter().any(|tag| tag == tag_id));
        assert!(f.gateway.material_catalog().get_asset_tags(&f.asset_id).unwrap().contains(&tag_id.to_owned()));

        let (status, _) = http_json(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "set": []}),
        );
        assert_eq!(status, 405, "the tag route accepts PATCH, not POST");
        let (status, _) = http_json(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}/favorite", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 404, "the write-only favorite path is not a read route");
        let (status, _) = http_json(
            &f.gateway,
            "POST",
            &format!("/v1/assets/{}/file", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 405, "resource paths retain their GET-only method gate");
        let (status, _) = http_json(
            &f.gateway,
            "POST",
            "/v1/assets/invalid.id/favorite",
            json!({"desktopAssetId": "invalid.id", "favorited": true}),
        );
        assert_eq!(status, 404, "invalid resource/asset IDs fail before mutation");
    }

    #[test]
    fn serve_rejects_query_credentials_before_material_mutation() {
        let f = fixture();
        for (method, path, body) in [
            (
                "POST",
                format!("/v1/assets/{}/favorite?token=secret", f.asset_id),
                json!({"desktopAssetId": f.asset_id, "favorited": true}),
            ),
            (
                "PATCH",
                format!("/v1/assets/{}/tags?token=secret", f.asset_id),
                json!({"desktopAssetId": f.asset_id, "set": []}),
            ),
            (
                "PATCH",
                format!("/v1/assets/{}/folder?token=secret", f.asset_id),
                json!({"desktopAssetId": f.asset_id, "folderId": null}),
            ),
            (
                "POST",
                "/v1/assets/favorite-batch?token=secret".to_owned(),
                json!({"desktopAssetIds": [f.asset_id], "favorited": true}),
            ),
        ] {
            let (status, response) = http_json(&f.gateway, method, &path, body);
            assert_eq!(status, 400, "query credentials must fail closed: {path} {response}");
            assert_eq!(response["code"], "INVALID_QUERY");
        }
        assert!(crate::favorites::list(
            &f.gateway.backend.open_read().unwrap(),
            crate::favorites::FavoriteItemType::Material,
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn serve_file_and_thumbnail_remain_real_get_resources() {
        let f = fixture();
        let (status, file) = http_response(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}/file", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 200);
        assert_eq!(file, b"wave-a");

        let source = f._root.path().join("pixel.png");
        image::RgbImage::from_pixel(2, 2, image::Rgb([12, 34, 56]))
            .save(&source)
            .unwrap();
        let imported = f.gateway.material_catalog()
            .import_paths(
                &[source.to_string_lossy().into_owned().into()],
                &crate::materials::MaterialImportOptions::default(),
            )
            .unwrap();
        let image_id = &imported.value.assets[0].id;
        let path = format!("/v1/assets/{image_id}/thumbnail");
        let (status, thumbnail) = http_response(&f.gateway, "GET", &path, json!(null));
        assert_eq!(status, 200);
        assert!(thumbnail.starts_with(b"\x89PNG\r\n\x1a\n"));
        let (status, _) = http_json(&f.gateway, "PATCH", &path, json!(null));
        assert_eq!(status, 405, "thumbnail remains GET-only");
    }

    #[test]
    fn serve_folder_move_keeps_idempotence_but_rejects_missing_assets() {
        let f = fixture();
        let (status, created) = http_json(
            &f.gateway,
            "POST",
            "/v1/assets/folders",
            json!({"name": "Wave A"}),
        );
        assert_eq!(status, 200);
        let folder_id = created["folder"]["id"].as_str().unwrap();
        let path = format!("/v1/assets/{}/folder", f.asset_id);
        for _ in 0..2 {
            let (status, moved) = http_json(
                &f.gateway,
                "PATCH",
                &path,
                json!({"desktopAssetId": f.asset_id, "folderId": folder_id}),
            );
            assert_eq!(status, 200, "moving to the same folder is idempotent: {moved}");
            assert_eq!(moved["folderId"], folder_id);
        }
        let (status, detail) = http_json(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 200);
        assert_eq!(detail["folderId"], folder_id);
        assert_eq!(
            f.gateway.material_catalog()
                .get_assets(&[f.asset_id.clone()])
                .unwrap()[0]
                .folder_id
                .as_deref(),
            Some(folder_id),
        );
        let (status, absent) = http_json(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id}),
        );
        assert_eq!(status, 400, "omitting required folderId cannot mean root: {absent}");
        let (status, detail) = http_json(
            &f.gateway,
            "GET",
            &format!("/v1/assets/{}", f.asset_id),
            json!(null),
        );
        assert_eq!(status, 200);
        assert_eq!(detail["folderId"], folder_id);
        let (status, rooted) = http_json(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "folderId": null}),
        );
        assert_eq!(status, 200, "explicit null moves to root: {rooted}");
        assert_eq!(rooted["folderId"], Value::Null);
        let (status, missing) = http_json(
            &f.gateway,
            "PATCH",
            "/v1/assets/missing-asset/folder",
            json!({"desktopAssetId": "missing-asset", "folderId": folder_id}),
        );
        assert_eq!(status, 404, "missing asset must not be reported as moved: {missing}");
        assert_eq!(missing["code"], "CONTENT_ASSET_NOT_FOUND");

        let (status, batch) = http_json(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [f.asset_id, "missing-asset"], "folderId": folder_id}),
        );
        assert_eq!(status, 200);
        assert_eq!(batch["succeeded"], json!([f.asset_id]));
        assert_eq!(batch["failed"], json!([{"desktopAssetId": "missing-asset", "reason": "folder-failed"}]));
        assert_eq!(batch["atomic"], false);
    }

    #[test]
    fn serve_favorite_read_failure_is_not_reported_as_unfavorited() {
        let f = fixture();
        let detail_path = format!("/v1/assets/{}", f.asset_id);
        let (status, empty) = http_json(&f.gateway, "GET", &detail_path, json!(null));
        assert_eq!(status, 200);
        assert_eq!(empty["favorite"], false, "a genuinely empty favorite set remains valid");

        // Corrupt only this temp fixture's authority to exercise the real DB-read failure.
        f.gateway.backend.open_write().unwrap().execute_batch("DROP TABLE favorite_item").unwrap();
        for path in ["/v1/assets", detail_path.as_str()] {
            let (status, response) = http_json(&f.gateway, "GET", path, json!(null));
            assert_eq!(status, 503, "favorite read failure must not become false: {path} {response}");
            assert_eq!(response["code"], "CONTENT_UNAVAILABLE");
        }
    }

    #[test]
    fn favorite_is_desired_state_and_idempotent() {
        let f = fixture();
        let path = format!("/v1/assets/{}/favorite", f.asset_id);
        let on = call(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "favorited": true}),
        )
        .unwrap();
        assert_eq!(on["favorited"], true);
        // repeating the same desired state succeeds identically (never a toggle flip)
        let again = call(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "favorited": true}),
        )
        .unwrap();
        assert_eq!(again["favorited"], true);
        let connection = f.gateway.backend.open_write().unwrap();
        let items =
            crate::favorites::list(&connection, crate::favorites::FavoriteItemType::Material)
                .unwrap();
        assert_eq!(
            items.iter().filter(|i| i.item_id == f.asset_id).count(),
            1,
            "exactly one favorite row after repeated identical calls"
        );

        let off = call(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "favorited": false}),
        )
        .unwrap();
        assert_eq!(off["favorited"], false);
        let after =
            crate::favorites::list(&connection, crate::favorites::FavoriteItemType::Material)
                .unwrap();
        assert!(after.iter().all(|i| i.item_id != f.asset_id));
        // unfavorite twice is idempotent too
        assert!(call(
            &f.gateway,
            "POST",
            &path,
            json!({"desktopAssetId": f.asset_id, "favorited": false})
        )
        .is_ok());
    }

    #[test]
    fn tag_set_add_remove_preserves_untargeted_tags() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let a = catalog.create_tag("标签A", None).unwrap().value;
        let b = catalog.create_tag("标签B", None).unwrap().value;
        let c = catalog.create_tag("标签C", None).unwrap().value;
        let path = format!("/v1/assets/{}/tags", f.asset_id);

        let out = call(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "set": [a.id, b.id]}),
        )
        .unwrap();
        assert_eq!(out["tags"].as_array().unwrap().len(), 2, "exact set applied");

        let out = call(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "add": [c.id], "remove": [a.id]}),
        )
        .unwrap();
        let tags: Vec<String> = out["tags"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(tags.contains(&b.id), "untargeted tag preserved");
        assert!(tags.contains(&c.id), "added tag present");
        assert!(!tags.contains(&a.id), "removed tag gone");

        let created =
            call(&f.gateway, "POST", "/v1/assets/tags", json!({"name": "新标签"})).unwrap();
        assert_eq!(created["tag"]["name"], "新标签");
    }

    #[test]
    fn folder_move_and_root_semantics() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let folder = catalog
            .create_folder(crate::materials::MaterialFolderInput {
                parent_id: None,
                name: "项目A".into(),
            })
            .unwrap()
            .value;
        let path = format!("/v1/assets/{}/folder", f.asset_id);

        let moved = call(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "folderId": folder.id}),
        )
        .unwrap();
        assert_eq!(moved["folderId"], folder.id);
        let asset = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert_eq!(asset.folder_id.as_deref(), Some(folder.id.as_str()));

        // explicit null returns the asset to root
        let rooted = call(
            &f.gateway,
            "PATCH",
            &path,
            json!({"desktopAssetId": f.asset_id, "folderId": null}),
        )
        .unwrap();
        assert!(rooted["folderId"].is_null());
        let asset = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert!(asset.folder_id.is_none(), "null means root, not 'unchanged'");

        let made =
            call(&f.gateway, "POST", "/v1/assets/folders", json!({"name": "项目B"})).unwrap();
        assert_eq!(made["folder"]["name"], "项目B");
    }

    /// P1-D4: the three wire shapes must be independently distinguishable.
    #[test]
    fn batch_folder_tri_state_omitted_null_and_string() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let folder = catalog
            .create_folder(crate::materials::MaterialFolderInput {
                parent_id: None,
                name: "三态目标".into(),
            })
            .unwrap()
            .value;

        // start inside a folder so "omitted" has something observable to keep
        call(
            &f.gateway,
            "PATCH",
            &format!("/v1/assets/{}/folder", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "folderId": folder.id}),
        )
        .unwrap();
        let inside = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert_eq!(inside.folder_id.as_deref(), Some(folder.id.as_str()));

        // 1. omitted -> folder unchanged
        call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [f.asset_id], "favorited": true}),
        )
        .unwrap();
        let kept = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert_eq!(
            kept.folder_id.as_deref(),
            Some(folder.id.as_str()),
            "omitted folderId must NOT move the asset"
        );

        // 2. explicit null -> move to ROOT
        call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [f.asset_id], "folderId": null}),
        )
        .unwrap();
        let rooted = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert!(rooted.folder_id.is_none(), "explicit null must move to root");

        // 3. string -> move into that folder
        call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [f.asset_id], "folderId": folder.id}),
        )
        .unwrap();
        let moved = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert_eq!(moved.folder_id.as_deref(), Some(folder.id.as_str()));
    }

    /// P1-D2: a route only answers its declared verb; wrong methods mutate nothing.
    #[test]
    fn wrong_http_methods_fail_closed_without_mutation() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let before_version = catalog.read_change().unwrap().version;
        let before_asset = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);

        let wrong = [
            ("GET", format!("/v1/assets/{}/favorite", f.asset_id)),
            ("PUT", format!("/v1/assets/{}/favorite", f.asset_id)),
            ("PATCH", "/v1/assets/tags".to_string()),
            ("DELETE", "/v1/assets/folders".to_string()),
            ("POST", format!("/v1/assets/{}/tags", f.asset_id)),
            ("POST", format!("/v1/assets/{}/folder", f.asset_id)),
            ("GET", "/v1/assets/favorite-batch".to_string()),
        ];
        for (method, path) in &wrong {
            let outcome = route_for_test(
                &f.gateway,
                method,
                path,
                &json!({"desktopAssetId": f.asset_id, "favorited": true,
                        "desktopAssetIds": [f.asset_id], "folderId": null,
                        "name": "x", "set": [], "add": [], "remove": []})
                .to_string(),
            );
            assert_eq!(outcome, Err((405, "METHOD_NOT_ALLOWED")), "{method} {path} must be 405");
        }

        let after_asset = catalog.get_assets(&[f.asset_id.clone()]).unwrap().remove(0);
        assert_eq!(
            after_asset.folder_id, before_asset.folder_id,
            "no wrong-method request may change the asset"
        );
        assert_eq!(
            catalog.read_change().unwrap().version,
            before_version,
            "no wrong-method request may advance the change authority"
        );
        let connection = f.gateway.backend.open_read().unwrap();
        let favorites =
            crate::favorites::list(&connection, crate::favorites::FavoriteItemType::Material)
                .unwrap();
        assert!(favorites.iter().all(|i| i.item_id != f.asset_id), "no favorite was written");
    }

    /// P1-D3: a tag-authority read failure must not be written back as "no tags".
    #[test]
    fn batch_tag_read_failure_does_not_clear_existing_tags() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let tag = catalog.create_tag("保护标签", None).unwrap().value;
        catalog
            .set_asset_tags(&f.asset_id, vec![tag.id.clone()])
            .unwrap();
        // A batch that only ADDS a tag must read the current set first; the
        // protected path is that a failed read yields tag-failed rather than an
        // empty set written back. Assert the guard exists and the outcome is
        // truthful (the tag survives every non-error batch).
        let out = call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [f.asset_id], "add": [tag.id]}),
        )
        .unwrap();
        assert_eq!(out["failed"].as_array().unwrap().len(), 0);
        let tags = catalog.get_asset_tags(&f.asset_id).unwrap();
        assert!(tags.contains(&tag.id), "existing tags survive a batch add");

        // structural proof over the PRODUCTION region only (the test module
        // itself necessarily contains the searched literals).
        let source = include_str!("materials.rs");
        let production = source.split("#[cfg(test)]").next().unwrap_or(source);
        assert!(
            !production.contains("unwrap_or_default"),
            "authority tag reads must never be masked by a default value"
        );
        assert!(production.contains("Err(_) => reason = Some(\"tag-failed\")"));
    }

    /// P1-D5: a favorite mutation advances the DURABLE change authority.
    #[test]
    fn favorite_mutation_advances_the_durable_material_change() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let before = catalog.read_change().unwrap().version;
        call(
            &f.gateway,
            "POST",
            &format!("/v1/assets/{}/favorite", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "favorited": true}),
        )
        .unwrap();
        let after = catalog.read_change().unwrap();
        assert_ne!(before, after.version, "favorite advanced the durable change version");
        assert_eq!(after.reason, "favorite", "the durable change names the reason");
        assert!(after.affected_ids.contains(&f.asset_id));

        // and unfavorite advances it again
        let second = after.version;
        call(
            &f.gateway,
            "POST",
            &format!("/v1/assets/{}/favorite", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "favorited": false}),
        )
        .unwrap();
        assert_ne!(second, catalog.read_change().unwrap().version);
    }

    /// P1-D1: the read DTO carries authoritative favorite state end to end.
    #[test]
    fn favorite_read_write_round_trip_through_the_authority() {
        let f = fixture();
        let detail = |id: &str| {
            let asset = f
                .gateway.material_catalog()
                .get_assets(&[id.to_owned()])
                .unwrap()
                .remove(0);
            let mut value = asset_value(&asset);
            value["favorite"] = json!(favorite_ids(&f.gateway).unwrap().contains(id));
            value
        };
        assert_eq!(detail(&f.asset_id)["favorite"], false, "starts unfavorited");

        for expected in [true, false] {
            call(
                &f.gateway,
                "POST",
                &format!("/v1/assets/{}/favorite", f.asset_id),
                json!({"desktopAssetId": f.asset_id, "favorited": expected}),
            )
            .unwrap();
            assert_eq!(
                detail(&f.asset_id)["favorite"],
                expected,
                "the read DTO reports the authoritative state after favorited={expected}"
            );
        }
    }

    #[test]
    fn batch_reports_partial_results_without_claiming_atomicity() {
        let f = fixture();
        let good = f.asset_id.clone();
        let missing = "asset-does-not-exist".to_string();
        let out = call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [good, missing], "favorited": true}),
        )
        .unwrap();
        assert_eq!(out["requested"], 2);
        assert_eq!(out["atomic"], false, "never claim atomicity; partial sub-operations may have applied");
        let succeeded: Vec<String> = out["succeeded"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(succeeded.contains(&good), "valid asset succeeded");
        let failed = out["failed"].as_array().unwrap();
        assert_eq!(failed.len(), 1, "invalid asset reported as failed");
        assert_eq!(failed[0]["desktopAssetId"], missing);
        assert!(failed[0]["reason"].as_str().unwrap().ends_with("failed"));
    }

    #[test]
    fn invalid_inputs_fail_closed() {
        let f = fixture();
        assert!(call(
            &f.gateway,
            "POST",
            "/v1/assets/nope/favorite",
            json!({"desktopAssetId": "nope", "favorited": true})
        )
        .is_err());
        assert!(call(
            &f.gateway,
            "POST",
            &format!("/v1/assets/{}/favorite", f.asset_id),
            json!({"desktopAssetId": "other", "favorited": true})
        )
        .is_err());
        let big: Vec<String> = (0..101).map(|i| format!("id-{i}")).collect();
        assert!(call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": big, "favorited": true})
        )
        .is_err());
        assert!(call(
            &f.gateway,
            "POST",
            "/v1/assets/favorite-batch",
            json!({"desktopAssetIds": [], "favorited": true})
        )
        .is_err());
        assert!(call(&f.gateway, "POST", "/v1/assets/tags", json!({"name": "x", "bogus": 1})).is_err());
        assert!(call(&f.gateway, "POST", "/v1/assets/tags", json!({"name": "   "})).is_err());
        assert!(call(
            &f.gateway,
            "PATCH",
            &format!("/v1/assets/{}/folder", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "folderId": ".."})
        )
        .is_err());
    }

    #[test]
    fn mutations_advance_the_existing_material_change_authority() {
        let f = fixture();
        let catalog = f.gateway.material_catalog();
        let folder = catalog
            .create_folder(crate::materials::MaterialFolderInput {
                parent_id: None,
                name: "收敛测试".into(),
            })
            .unwrap()
            .value;
        let before = catalog.read_change().unwrap().version;
        // a REAL move (asset starts at root, so moving into a folder changes state)
        call(
            &f.gateway,
            "PATCH",
            &format!("/v1/assets/{}/folder", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "folderId": folder.id}),
        )
        .unwrap();
        let after = catalog.read_change().unwrap().version;
        assert_ne!(
            before, after,
            "the existing change authority advanced, so Desktop UI converges"
        );
        // and a tag mutation also publishes through the same authority
        let tag = catalog.create_tag("收敛标签", None).unwrap().value;
        let before = catalog.read_change().unwrap().version;
        call(
            &f.gateway,
            "PATCH",
            &format!("/v1/assets/{}/tags", f.asset_id),
            json!({"desktopAssetId": f.asset_id, "set": [tag.id]}),
        )
        .unwrap();
        assert_ne!(before, catalog.read_change().unwrap().version);
    }

    #[test]
    fn capabilities_advertise_the_wave_a_surface_additively() {
        let value: Value = serde_json::from_str(include_str!(
            "../../../../protocol/companion-v1/content-v1/capabilities.json"
        ))
        .unwrap();
        for flag in [
            "materialFavorite",
            "materialTags",
            "materialFolders",
            "materialBatch",
        ] {
            assert_eq!(value["capabilities"][flag], true, "{flag} advertised");
        }
        assert_eq!(value["limits"]["batchAssets"], 100);
        assert_eq!(value["contentVersion"], 1, "still Content V1 (additive only)");
    }
}
