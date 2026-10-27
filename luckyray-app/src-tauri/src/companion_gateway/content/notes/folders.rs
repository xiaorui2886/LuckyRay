//! Additive create-only folder endpoint. Reuses the global operation namespace.
use super::*;
use serde::{Serialize, Deserialize};
#[derive(Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Create {
    op_id: String, vault_id: String, name: String,
    #[serde(default)] parent_relative_path: Option<String>,
}
pub(super) fn create(gateway: &CompanionGateway, request: &HttpRequest) -> ContentResult<Value> {
    if request.method != "POST" { return Err((405,"METHOD_NOT_ALLOWED")); }
    query(&request.path, &[])?;
    super::super::access(gateway,request)?;
    let input: Create = serde_json::from_slice(&request.body).map_err(|_|(400,"FOLDER_INPUT_INVALID"))?;
    if !valid_id(&input.op_id) { return Err((400,"OP_ID_INVALID")); }
    let device=presented_device_id(request).ok_or((401,"PAIRING_REQUIRED"))?;
    let (target,vault)=target(gateway)?;
    if input.vault_id != vault { return Err((409,"VAULT_CHANGED")); }
    let payload=format!("folder-create:{}",serde_json::to_string(&input).map_err(|_|(400,"FOLDER_INPUT_INVALID"))?);
    let mut state=gateway.content_state.lock().map_err(|_|(503,"CONTENT_UNAVAILABLE"))?;
    let db=database(gateway)?;
    let stored:Option<(String,Option<String>)>=db.query_row(
        "SELECT payload,result FROM companion_content_operation WHERE device_id=?1 AND op_id=?2",
        params![device,input.op_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(db_error)?;
    let retry=stored.is_some();
    if let Some((old,result))=stored {
        if old != payload { return Err((409,"OP_ID_REUSED")); }
        if let Some(result)=result {
            let value:Value=serde_json::from_str(&result).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?;
            return gateway.knowledge().with_current_target_response_lease(&target,||value).map_err(|_|(409,"VAULT_CHANGED"));
        }
    } else {
        db.execute("INSERT INTO companion_content_operation(device_id,op_id,vault_key,note_id,payload,before_document,stage,created_at) VALUES(?1,?2,?3,'',?4,'{}','intent',?5)",
            params![device,input.op_id,vault,payload,chrono::Utc::now().to_rfc3339()]).map_err(db_error)?;
    }
    let knowledge=gateway.knowledge();
    let path=knowledge.companion_create_folder_for_target(&target,input.parent_relative_path.as_deref(),&input.name)
        .map_err(|e|match e.code {
            "knowledge-name-conflict" if retry => (409,"FOLDER_CREATE_UNCERTAIN"),
            "knowledge-name-conflict" => (409,"FOLDER_EXISTS"),
            "knowledge-parent-missing" => (409,"FOLDER_PARENT_MISSING"),
            "knowledge-path-invalid"|"knowledge-invalid-document-ref"|"knowledge-path-outside-vault" => (400,"FOLDER_INPUT_INVALID"),
            _ => (409,"FOLDER_CREATE_UNCERTAIN"),
        })?;
    let result=json!({"opId":input.op_id,"vaultId":vault,"relativePath":path,"created":true});
    db.execute("UPDATE companion_content_operation SET stage='completed',result=?3 WHERE device_id=?1 AND op_id=?2",
        params![device,input.op_id,result.to_string()]).map_err(db_error)?;
    state.reconciled.remove(&vault);
    knowledge.with_current_target_response_lease(&target,||result).map_err(|_|(409,"VAULT_CHANGED"))
}
