//! Mac-only Companion upload path. Existing Windows and legacy staging remain
//! untouched. All uncertain objects are retained for inspection.
use super::*;
#[path = "macos_store.rs"]
mod macos_store;
pub(crate) use macos_store::UploadState;

pub(super) fn route(gateway:&CompanionGateway,request:&HttpRequest)->ContentResult<Value> {
    route_inner(gateway,request,None)
}

/// Bytes on this path are supplied only by the authenticated Services handler
/// after checking its durable job and grant; ordinary HTTP requests cannot
/// call it. Reuse the Content journal and publication/replay authority.
pub(super) fn complete_from_service(gateway:&CompanionGateway,request:&HttpRequest,job_id:&str,bytes:&[u8])->ContentResult<Value> {
    if !valid_id(job_id) || request.method!="POST" {return Err((400,"ATTACHMENT_INPUT_INVALID"))}
    let path=request.path.split('?').next().unwrap_or("");
    let expected=format!("sv-{job_id}-file");
    let (note,rest)=path.strip_prefix("/v1/notes/").and_then(|s|s.split_once("/attachments/"))
        .ok_or((404,"NOT_FOUND"))?;
    if rest.strip_suffix("/complete")!=Some(expected.as_str()) {return Err((409,"OP_ID_REUSED"))}
    let device=presented_device_id(request).ok_or((401,"PAIRING_REQUIRED"))?;
    let input:Value=serde_json::from_slice(&request.body).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?;
    let vault=input["vaultId"].as_str().ok_or((400,"ATTACHMENT_INPUT_INVALID"))?;
    let instance=gateway.identity().map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?.instance_id.clone();
    let db=database(gateway)?;
    let job:Option<(String,u64,String)>=db.query_row("SELECT u.manifest,u.committed_bytes,s.manifest_hash FROM companion_service_upload u JOIN companion_macos_service_session s ON s.job_id=u.job_id AND s.instance_id=u.instance_id AND s.device_id=u.device_id WHERE u.job_id=?1 AND u.instance_id=?2 AND u.device_id=?3 AND u.stage='committing' AND s.clear_uncertain=0",params![job_id,instance,device],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(db_error)?;
    let (serialized,committed,manifest_hash)=job.ok_or((503,"CONTENT_STORE_UNAVAILABLE"))?;
    let service:Value=serde_json::from_str(&serialized).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?;
    let canonical=serde_json::to_vec(&service).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?;
    if manifest_hash!=format!("{:x}",Sha256::digest(&canonical)) || service["target"]["domain"]!="knowledge"
        || service["target"]["vaultId"]!=vault || committed!=bytes.len() as u64
        || service["sizeBytes"]!=committed || service["sha256"]!=format!("{:x}",Sha256::digest(bytes)) {
        return Err((409,"UPLOAD_STAGING_LOST"));
    }
    let bound:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM companion_content_operation WHERE device_id=?1 AND op_id=?2 AND vault_key=?3 AND note_id=?4 AND stage='completed')",params![device,format!("sv-{job_id}-create"),vault,note],|r|r.get(0)).map_err(db_error)?;
    if !bound {return Err((409,"OP_ID_REUSED"));}
    route_inner(gateway,request,Some(bytes))
}

fn route_inner(gateway:&CompanionGateway,request:&HttpRequest,service_bytes:Option<&[u8]>)->ContentResult<Value> {
    let path=request.path.split('?').next().unwrap_or("");
    let (note,rest)=path.strip_prefix("/v1/notes/").and_then(|s|s.split_once("/attachments/")).ok_or((404,"NOT_FOUND"))?;
    let (op,complete)=rest.strip_suffix("/complete").map(|s|(s,true)).unwrap_or((rest,false));
    if !valid_id(note)||!valid_id(op){return Err((400,"OP_ID_INVALID"))}
    let device=presented_device_id(request).ok_or((401,"PAIRING_REQUIRED"))?;
    let (target,vault)=target(gateway)?;
    let q=query(&request.path,if request.method=="GET" {&["vault"]} else {&[]})?;
    let input:Value=if request.method=="GET" {json!({"vaultId":q.get("vault")})} else {serde_json::from_slice(&request.body).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?};
    if input["vaultId"]!=vault {return Err((409,"VAULT_CHANGED"))}
    let mut state=gateway.content_state.lock().map_err(|_|(503,"CONTENT_UNAVAILABLE"))?;
    let mut db=database(gateway)?;
    let stored:Option<(String,String,String,u64,Option<String>)>=db.query_row("SELECT vault_key,note_id,manifest,committed_bytes,receipt FROM companion_content_upload WHERE device_id=?1 AND op_id=?2",params![device,op],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(db_error)?;
    let (manifest,offset)=if let Some((old_vault,old_note,encoded,offset,receipt))=stored {
        if old_vault!=vault||old_note!=note{return Err((409,"OP_ID_REUSED"))}
        let manifest:Manifest=serde_json::from_str(&encoded).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?;
        if request.method=="POST"&&!complete {
            let proposed:Manifest=serde_json::from_value(input.clone()).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?;
            if serde_json::to_string(&proposed).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))? != serde_json::to_string(&manifest).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))? {return Err((409,"OP_ID_REUSED"))}
        }
        if let Some(receipt)=receipt {
            let receipt=serde_json::from_str(&receipt).map_err(|_|(503,"CONTENT_STORE_UNAVAILABLE"))?;
            macos_store::release(&mut state.uploads,device,op);
            // Publication already succeeded. A blocked cleanup keeps its
            // ownership rows for startup/replay without changing the receipt.
            let _=macos_store::reclaim_upload(&mut db,gateway.backend.app_data_dir(),device,op);
            return Ok(receipt);
        }
        macos_store::schema(&db)?;
        if macos_store::retired(&db,device,op)? {return Err((409,"UPLOAD_CANCELLED"));}
        let Some((total,_,cancelled))=macos_store::session(&db,device,op)? else {
            // Never infer ownership of an older `.part` or its intent.
            return Err((503,"SERVICE_UNAVAILABLE"));
        };
        if cancelled{return Err((409,"UPLOAD_CANCELLED"))}
        if total!=manifest.size_bytes||offset>total {return Err((503,"CONTENT_STORE_UNAVAILABLE"))}
        if offset<total {macos_store::mark_incomplete(&db,device,op,offset)?;}
        (manifest,offset)
    } else {
        if request.method!="POST"||complete{return Err((404,"UPLOAD_NOT_FOUND"))}
        let manifest:Manifest=serde_json::from_value(input.clone()).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?;
        if manifest.size_bytes==0||manifest.size_bytes>64*1024*1024||manifest.name.len()>512||manifest.sha256.len()!=64||!manifest.sha256.bytes().all(|b|b.is_ascii_hexdigit()) {return Err((400,"ATTACHMENT_INPUT_INVALID"))}
        let doc=current_document(gateway,&target,&vault,note)?;
        if revision(&doc.summary.relative_path,&doc.revision)!=manifest.expected_revision {return Err((409,"REVISION_CONFLICT"))}
        macos_store::schema(&db)?;
        let encoded=serde_json::to_string(&manifest).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?;
        macos_store::begin(&mut db,device,op,&vault,note,&encoded,manifest.size_bytes)?;
        (manifest,0)
    };
    if request.method=="PUT"&&!complete {
        if input.as_object().is_none_or(|o|o.keys().any(|key|!matches!(key.as_str(),"vaultId"|"offset"|"data"|"sha256"))) {return Err((400,"ATTACHMENT_INPUT_INVALID"))}
        let start=input["offset"].as_u64().ok_or((400,"ATTACHMENT_INPUT_INVALID"))?;
        let encoded=input["data"].as_str().filter(|s|s.len()<=350_000).ok_or((400,"CHUNK_TOO_LARGE"))?;
        let bytes=BASE64.decode(encoded).map_err(|_|(400,"ATTACHMENT_INPUT_INVALID"))?;
        if bytes.is_empty()||bytes.len()>256*1024||start.checked_add(bytes.len() as u64).is_none_or(|end|end>manifest.size_bytes){return Err((400,"CHUNK_TOO_LARGE"))}
        if input["sha256"]!=format!("{:x}",Sha256::digest(&bytes)){return Err((400,"CHUNK_CHECKSUM_MISMATCH"))}
        if start<offset {macos_store::compare(&db,gateway.backend.app_data_dir(),device,op,start,&bytes,offset)?;return Ok(json!({"opId":op,"offset":offset,"complete":false}));}
        if start!=offset{return Err((409,"UPLOAD_OFFSET_MISMATCH"))}
        let next=macos_store::append(&mut db,&mut state.uploads,gateway.backend.app_data_dir(),device,op,start,&bytes)?;
        return Ok(json!({"opId":op,"offset":next,"complete":false}));
    }
    if complete&&request.method=="POST" {
        if service_bytes.is_none()&&offset!=manifest.size_bytes{return Err((409,"UPLOAD_INCOMPLETE"))}
        let doc=current_document(gateway,&target,&vault,note)?;
        if revision(&doc.summary.relative_path,&doc.revision)!=manifest.expected_revision{return Err((409,"REVISION_CONFLICT"))}
        let collected;
        let bytes=if let Some(bytes)=service_bytes {
            if bytes.len() as u64!=manifest.size_bytes || format!("{:x}",Sha256::digest(bytes))!=manifest.sha256 {
                return Err((409,"UPLOAD_STAGING_LOST"));
            }
            bytes
        } else {
            collected=macos_store::collect(&db,gateway.backend.app_data_dir(),device,op,manifest.size_bytes,&manifest.sha256)?;
            collected.as_slice()
        };
        let mut plan=macos_store::session(&db,device,op)?.ok_or((503,"SERVICE_UNAVAILABLE"))?.1;
        // A full legacy upload without a plan may already have reused an
        // identical attachment before its receipt failed. Its identity was
        // never recorded, so do not guess or publish another.
        if plan.is_none() && !macos_store::journaled(&db,device,op)? {
            return Err((409,"UPLOAD_PUBLICATION_UNCERTAIN"));
        }
        if plan.is_some(){macos_store::check_marker(gateway.backend.app_data_dir(),device,op)?;}
        let prior=plan.clone();
        let publication=gateway.knowledge().publish_macos_companion_attachment(&target,&doc.summary.document_ref,&doc.revision,&manifest.name,bytes,&manifest.sha256,prior.as_deref(),|old,new|{
            if old.is_none(){macos_store::create_marker(gateway.backend.app_data_dir(),device,op).map_err(|_|KnowledgeError{code:"knowledge-attachment-conflict",message:"Cannot claim publication intent".into()})?;}
            macos_store::plan(&db,device,op,old,new).map_err(|_|KnowledgeError{code:"knowledge-attachment-conflict",message:"Cannot journal attachment publication".into()})?;
            plan=Some(new.to_owned());Ok(())
        }).map_err(knowledge_error)?;
        let receipt=json!({"opId":op,"offset":manifest.size_bytes,"complete":true,"publication":publication});
        macos_store::finish(&db,device,op,plan.as_deref(),offset,manifest.size_bytes,&receipt.to_string())?;
        macos_store::release(&mut state.uploads,device,op);
        let _=macos_store::reclaim_upload(&mut db,gateway.backend.app_data_dir(),device,op);
        gateway.knowledge().notify_companion_committed(&doc.summary.document_ref.vault_id,vec![doc.summary.relative_path.clone()]);
        return Ok(receipt);
    }
    if complete||!matches!(request.method.as_str(),"GET"|"POST"){return Err((405,"METHOD_NOT_ALLOWED"))}
    Ok(json!({"opId":op,"offset":offset,"complete":false,"maxChunkBytes":256*1024}))
}

pub(super) fn cancel_for_clear(gateway:&CompanionGateway)->Result<(), &'static str> {
    let mut state=gateway.content_state.lock().map_err(|_|"companion-upload-state-unavailable")?;
    let mut db=database(gateway).map_err(|_|"companion-upload-store-unavailable")?;
    macos_store::cancel_all(&mut db,&mut state.uploads).map_err(|_|"companion-upload-store-unavailable")
}

pub(super) fn recover_completed(gateway:&CompanionGateway)->Result<(), &'static str> {
    let _state=gateway.content_state.lock().map_err(|_|"companion-upload-state-unavailable")?;
    let mut db=database(gateway).map_err(|_|"companion-upload-store-unavailable")?;
    macos_store::reclaim_completed(&mut db,gateway.backend.app_data_dir())
        .map_err(|_|"companion-upload-reclaim-pending")
}
