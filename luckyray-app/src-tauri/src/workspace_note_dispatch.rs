//! Native Note action plumbing. Tauri supplies caller identity; all document
//! targets come from the registered view or a verified opaque metadata ticket.
use super::*;
use crate::knowledge::KnowledgeService;
use crate::workspace_actions::ActionCorrelation;
use crate::workspace_note_actions::{self as note, NoteActionOutcome, NoteMainAction, NoteMainCompletion, NoteMainRequest, NoteSelection};
use crate::workspace_notes_metadata::{self as metadata, GrantedNoteTarget, NoteAuthority};
use base64::Engine;
use serde_json::{json, Value};
use std::{io::Read, time::{Duration, Instant}};
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct NoteFile { name:String, #[serde(default)] mime_type:String, bytes:Vec<u8> }
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct NoteOpenOptions { block_id:Option<String>, heading_path:Option<String> }
#[derive(Clone, Deserialize)]
#[serde(tag="kind",rename_all="kebab-case",deny_unknown_fields)]
pub(super) enum ClipboardSource { DataUrl {value:String}, RemoteUrl {value:String} }
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(super) struct TargetTicket { ticket:String, document_id:String, title:String }
#[derive(Clone, Deserialize)]
#[serde(tag="kind",rename_all="kebab-case",rename_all_fields="camelCase",deny_unknown_fields)]
pub(super) enum NoteAction {
 RenameDocument {title:String}, OpenNote {target:TargetTicket,options:Option<NoteOpenOptions>,#[serde(default)]new_tab:bool},
 CreateNote {title:String,options:Option<NoteOpenOptions>}, BrowseDocuments {section:Option<String>}, BrowseAttachments {},
 SetFavorite {favorite:bool}, EditDocumentTags {}, RemoveDocumentTag {tag_id:String}, ApplyDocumentTags {names:Vec<String>,mode:Option<String>},
 OpenTag {tag_id:String,ticket:String}, CreateTag {name:String}, RenameTag {tag_id:String,ticket:String,name:String},
 OpenAttachment {token:String}, OpenExternal {url:String}, AskAi {}, SuggestAi {}, WriteAi {action:String,selection:NoteSelection},
 InsertAttachment {selection:NoteSelection}, InsertFiles {files:Vec<NoteFile>,selection:NoteSelection},
 InsertClipboardImage {source:ClipboardSource,selection:NoteSelection}, InsertExistingAttachment {asset_id:String,selection:NoteSelection},
 ExportDocument {format:String}, ImportDocument {}, CloseView {},
}
#[derive(Deserialize)]
#[serde(tag="kind",rename_all="camelCase",rename_all_fields="camelCase",deny_unknown_fields)]
pub(super) enum ExecuteInput {
 Files {files:Vec<NoteFile>}, Documents {files:Vec<NoteFile>}, Catalog {library_id:String,asset_id:String},
 TagRename {review_id:String,document_ids:Vec<String>}, Export {format:String},
}
#[derive(Deserialize)]
#[serde(tag="op",rename_all="camelCase",rename_all_fields="camelCase",deny_unknown_fields)]
pub(super) enum NoteRequest {
 NoteAction {view_id:String,authority:NoteAuthority,request_id:u64,revision:String,generation:u64,content:String,action:NoteAction},
 NoteActionStatus {view_id:String,authority:NoteAuthority,request_id:u64,revision:String,generation:u64,id:String},
 NoteActionCapabilities {view_id:String},
 NoteIndex {view_id:String,revision:String,cursor:Option<String>,limit:usize},
 NoteAttachmentReferences {view_id:String,revision:String},
 NoteMainRegister {kinds:Vec<String>}, NoteMainPending {}, NoteMainClaim {id:String},
 NoteMainValidate {id:String,claim_token:String}, NoteMainComplete {id:String,claim_token:String,result:NoteMainCompletion},
 NoteMainExecute {id:String,claim_token:String,input:ExecuteInput},
}
fn encoded<T:Serialize>(value:T)->Result<Value,String>{serde_json::to_value(value).map_err(|_|"workspace-note-serialize".into())}
fn completed(value:Value)->Value{json!({"state":"completed","result":{"ok":true,"value":value}})}
fn acknowledged(message:&str)->Value{json!({"kind":"acknowledged","message":message})}
fn main_only(label:&str)->Result<(),String>{if label=="main"{Ok(())}else{Err("workspace-note-main-required".into())}}
fn bound(registry:&WorkspaceWindows,label:&str,view_id:&str,authority:Option<&NoteAuthority>)->Result<(ViewGrant,KnowledgeService),String>{
 let (view,scope)=scoped_view(registry,label,Some(view_id))?;require_live_view(registry,label,&view)?;
 let actual=metadata::authority_for(&scope,&note_ref(&view)?)?;
 if authority.is_some_and(|expected|expected!=&actual){return Err("workspace-note-scope-mismatch".into());}Ok((view,scope))
}
fn validate_options(options:&Option<NoteOpenOptions>)->Result<(),String>{
 if options.as_ref().is_some_and(|options|[&options.block_id,&options.heading_path].into_iter().flatten().any(|value|value.len()>512||value.chars().any(char::is_control))){return Err("workspace-note-navigation-invalid".into());}Ok(())
}
fn selection(content:&str,range:NoteSelection)->Result<(),String>{
 let units=content.encode_utf16().collect::<Vec<_>>();if range.start>range.end||range.end>units.len()||String::from_utf16(&units[..range.start]).is_err()||String::from_utf16(&units[range.start..range.end]).is_err(){return Err("workspace-note-selection-invalid".into());}Ok(())
}
fn check_files(files:&[NoteFile],markdown:bool)->Result<(),String>{
 if files.is_empty()||files.len()>16{return Err("workspace-note-file-count-invalid".into());}let mut bytes=0usize;
 for file in files{bytes=bytes.checked_add(file.bytes.len()).ok_or("workspace-note-file-limit")?;if file.name.is_empty()||file.name.len()>255||file.name.contains(['/', '\\'])||file.name.chars().any(char::is_control)||file.mime_type.len()>128||file.bytes.is_empty()||file.bytes.len()>16*1024*1024||(markdown&&!file.name.to_ascii_lowercase().ends_with(".md")){return Err("workspace-note-file-invalid".into());}}
 if bytes>32*1024*1024{return Err("workspace-note-file-limit".into());}Ok(())
}
fn notify_peers(app:&tauri::AppHandle,registry:&WorkspaceWindows,label:&str,view:&ViewGrant){
 let peers=registry.entries.lock().ok().map(|entries|entries.values().filter(|session|session.label!=label&&session.views.iter().any(|entry|entry.view.library_id==view.library_id&&entry.view.resource_id==view.resource_id)).map(|session|session.label.clone()).collect::<Vec<_>>()).unwrap_or_default();
 for peer in peers{let _=app.emit_to(&peer,"luckyray:workspace-note-changed",());}if label!="main"{let _=app.emit_to("main","luckyray:workspace-note-changed",());}
 let _=app.emit("luckyray:workspace-graph-changed",());
}
fn saved(app:&tauri::AppHandle,registry:&WorkspaceWindows,label:&str,view:&ViewGrant,scope:&KnowledgeService,document:crate::knowledge::KnowledgeDocumentSnapshot)->Result<Value,String>{
 let snapshot=metadata::snapshot_for(scope,document)?;notify_peers(app,registry,label,view);Ok(completed(json!({"kind":"saved","snapshot":snapshot})))
}
fn enqueue(app:&tauri::AppHandle,registry:&WorkspaceWindows,label:&str,scope:&KnowledgeService,view:&ViewGrant,correlation:&ActionCorrelation,content:&str,request:NoteMainRequest)->Result<Value,String>{
 let receipt=registry.note_queue.enqueue(label,scope,view,correlation,content,request)?;
 let _=app.emit_to("main","luckyray:workspace-note-action-available",());crate::show_main_window(app);
 let mut result=encoded(receipt)?;result.as_object_mut().ok_or("workspace-note-serialize")?.insert("state".into(),json!("pending"));Ok(result)
}
fn current_main_source(context:&note::NoteExecutionContext)->Result<(),String>{
 if matches!(context.action,NoteMainAction::ManageKnowledge{..}|NoteMainAction::OpenTag{..})&&crate::knowledge_service()?.current_target_identity().map_err(crate::knowledge_error)?!=context.scope.current_target_identity().map_err(crate::knowledge_error)?{return Err("workspace-note-main-source-mismatch".into());}Ok(())
}
fn import_files(registry:&WorkspaceWindows,label:&str,scope:&KnowledgeService,view:&ViewGrant,correlation:&ActionCorrelation,content:&str,files:&[NoteFile],range:NoteSelection)->Result<NoteActionOutcome,String>{
 check_files(files,false)?;selection(content,range)?;let _writes=guard_document_writes(registry,scope,&[note_ref(view)?])?;let mut markdown=Vec::new();
 for file in files{live_action(registry,label,view,correlation)?;let imported=note::import_attachment(scope,view,correlation,content,&file.name,&file.bytes)?;registry.attachments.add_publication(label,view,scope,correlation,content,&imported)?;markdown.push(imported.publication.markdown);}
 Ok(NoteActionOutcome::ReplaceRange{selection:range,text:format!("\n\n{}\n",markdown.join("\n\n"))})
}
fn clipboard_file(source:ClipboardSource)->Result<NoteFile,String>{
 let bytes=match source{
  ClipboardSource::DataUrl{value}=>{if value.len()>24*1024*1024{return Err("workspace-note-image-limit".into());}let(header,body)=value.split_once(',').ok_or("workspace-note-image-invalid")?;if !header.starts_with("data:image/")||!header.ends_with(";base64"){return Err("workspace-note-image-invalid".into());}base64::engine::general_purpose::STANDARD.decode(body).map_err(|_|"workspace-note-image-invalid")?},
  ClipboardSource::RemoteUrl{value}=>{let response=crate::web_tools::SafeHttpClient::production(Duration::from_secs(15)).get(&value,Instant::now()+Duration::from_secs(45),4,"image/*").map_err(|failure|failure.code.to_owned())?;if !response.response.status().is_success(){return Err("workspace-note-image-download-failed".into());}let mut bytes=Vec::new();response.response.take(16*1024*1024+1).read_to_end(&mut bytes).map_err(|_|"workspace-note-image-download-failed")?;bytes},
 };
 if bytes.is_empty()||bytes.len()>16*1024*1024{return Err("workspace-note-image-limit".into());}
 let extension=match image::guess_format(&bytes).map_err(|_|"workspace-note-image-type-unsupported")?{image::ImageFormat::Png=>"png",image::ImageFormat::Jpeg=>"jpg",image::ImageFormat::Gif=>"gif",image::ImageFormat::WebP=>"webp",image::ImageFormat::Bmp=>"bmp",_=>return Err("workspace-note-image-type-unsupported".into())};
 Ok(NoteFile{name:format!("pasted-image.{extension}"),mime_type:format!("image/{extension}"),bytes})
}
fn import_markdown_bytes(context:&note::NoteExecutionContext,file:&NoteFile)->Result<(crate::knowledge::KnowledgeDocumentSnapshot,bool),String>{
 let title=file.name.get(..file.name.len()-3).ok_or("workspace-note-markdown-required")?;
 let content=KnowledgeService::workspace_decode_markdown(&file.bytes).map_err(crate::knowledge_error)?;
 for suffix in 1..=128{
  let title=if suffix==1{title.to_owned()}else{format!("{title} ({suffix})")};
  match note::create_note(&context.scope,&context.view,&context.correlation,&context.content,&title,&content){Ok(document)=>return Ok((document,suffix>1)),Err(error) if error.contains("knowledge-name-conflict")=>{},Err(error)=>return Err(error)}
 }
 Err("workspace-note-import-name-capacity".into())
}

fn installed_note_capabilities(registry:&WorkspaceWindows)->Result<Value,String>{
 let lease=registry.note_queue.capabilities()?;
 let mut actions=vec!["rename-document","open-note","create-note","browse-documents","browse-attachments","set-favorite","edit-document-tags","remove-document-tag","apply-document-tags","create-tag","open-attachment","open-external","insert-files","insert-clipboard-image","close-view"];
 // Installed native routes are not withdrawn while Main checks a document.
 // Rename execution still requires guard_note_rename: write gate, complete
 // current coverage, exact live authority, and absence of conflicting views.
 // Reporting that transient busy guard as an uninstalled route invalidates
 // otherwise current child render proofs on each background read.
 for(kind,route)in[("composeAi","ask-ai"),("openTag","open-tag"),("suggestAi","suggest-ai"),("writeAi","write-ai"),("pickAttachment","insert-attachment"),("pickCatalog","insert-existing-attachment"),("importDocument","import-document"),("exportDocument","export-document"),("renameTag","rename-tag")]{if lease.kinds.iter().any(|value|value==kind){actions.push(route);}}
 if !lease.kinds.iter().any(|value|value=="manageKnowledge"){actions.retain(|action|*action!="browse-documents");}
 Ok(json!({"actions":actions,"expiresInMs":lease.expires_in_ms}))
}

pub(super) async fn dispatch(app:&tauri::AppHandle,caller:&tauri::Webview,registry:&WorkspaceWindows,request:NoteRequest)->Result<Value,String>{
 let label=caller.label();
 match request{
  NoteRequest::NoteActionCapabilities{view_id}=>{
   bound(registry,label,&view_id,None)?;installed_note_capabilities(registry)
  },
  NoteRequest::NoteIndex{view_id,revision,cursor,limit}=>{let(view,scope)=bound(registry,label,&view_id,None)?;let result=registry.notes_metadata.list_index(label,&view_id,&scope,&note_ref(&view)?,&revision,cursor.as_deref(),limit)?;require_live_view(registry,label,&view)?;encoded(result)},
  NoteRequest::NoteAttachmentReferences{view_id,revision}=>{
   let(view,scope)=bound(registry,label,&view_id,None)?;let document=scope.read_document(&note_ref(&view)?).map_err(crate::knowledge_error)?;
   let refs=note::list_current_references(&scope,&view,&ActionCorrelation{request_id:1,revision:revision.clone(),generation:0},&document.content)?;let mut rows=Vec::new();
   for reference in refs{let issued=crate::workspace_attachments::issue(registry,label,&view_id,&revision,&reference.destination,reference.wiki);match issued{
    Ok(token)=>{let dto=encoded(token)?;rows.push(json!({"target":reference.destination,"wiki":reference.wiki,"label":reference.label,"status":"resolved","token":dto["token"],"mediaKind":dto["mediaKind"],"version":dto["version"]}));},
    Err(error)=>{let status=if error.contains("main-grant"){"ungranted"}else if error.contains("unsupported"){"unsupported"}else{"missing"};rows.push(json!({"target":reference.destination,"wiki":reference.wiki,"label":reference.label,"status":status}));}
   }}require_live_view(registry,label,&view)?;Ok(json!({"authority":metadata::authority_for(&scope,&note_ref(&view)?)?,"revision":revision,"references":rows,"complete":true,"missing":[]}))
  },
  NoteRequest::NoteMainRegister{kinds}=>encoded(registry.note_queue.register_main(label,&kinds)?),
  NoteRequest::NoteMainPending {}=>encoded(registry.note_queue.pending(label)?),
  NoteRequest::NoteMainClaim{id}=>encoded(registry.note_queue.claim(label,&id,|owner,view,correlation|live_action(registry,owner,view,correlation))?),
  NoteRequest::NoteMainValidate{id,claim_token}=>{let context=registry.note_queue.validate(label,&id,&claim_token,|owner,view,correlation|live_action(registry,owner,view,correlation))?;current_main_source(&context)?;Ok(json!({"valid":true}))},
  NoteRequest::NoteMainComplete{id,claim_token,result}=>{
   let context=registry.note_queue.validate(label,&id,&claim_token,|owner,view,correlation|live_action(registry,owner,view,correlation))?;
   if !matches!(&result,NoteMainCompletion::Failed{..}|NoteMainCompletion::Cancelled {}){current_main_source(&context)?;}
   registry.note_queue.complete(label,&id,&claim_token,result,|owner,view,correlation|live_action(registry,owner,view,correlation))?;Ok(Value::Null)
  },
  NoteRequest::NoteMainExecute{id,claim_token,input}=>{
   main_only(label)?;let context=registry.note_queue.validate(label,&id,&claim_token,|owner,view,correlation|live_action(registry,owner,view,correlation))?;
   let export_directory=if matches!(input,ExecuteInput::Export{..}){
    let NoteMainAction::ExportDocument{format,..}=&context.action else{return Err("workspace-note-action-kind-mismatch".into());};if format!="markdown"{return Err("workspace-note-pdf-unsupported".into());}
    let window=caller.clone();tauri::async_runtime::spawn_blocking(move||window.dialog().file().set_title("导出 Markdown 到文件夹").blocking_pick_folder()).await.map_err(|_|"workspace-note-picker-failed")?.map(|path|path.into_path().map_err(|_|"workspace-note-picker-failed".to_owned())).transpose()?
   }else{None};
   if matches!(input,ExecuteInput::Export{..})&&export_directory.is_none(){registry.note_queue.complete(label,&id,&claim_token,NoteMainCompletion::Cancelled {},|owner,view,correlation|live_action(registry,owner,view,correlation))?;return Ok(Value::Null);}
   let outcome=registry.note_queue.execute_result(label,&id,&claim_token,|owner,view,correlation|live_action(registry,owner,view,correlation),|context|{
    match(input,&context.action){
     (ExecuteInput::Files{files},NoteMainAction::PickAttachment{selection})=>import_files(registry,&context.caller,&context.scope,&context.view,&context.correlation,&context.content,&files,*selection),
     (ExecuteInput::Catalog{library_id,asset_id},NoteMainAction::PickCatalog{selection,..})=>{
      let _writes=guard_document_writes(registry,&context.scope,&[note_ref(&context.view)?])?;
      let catalog=crate::backend_services()?.material_catalog().for_library(&library_id).map_err(crate::encode_material_catalog_command_error)?;
      let approved=catalog.get_ordinary_export_asset(&asset_id).map_err(crate::encode_material_catalog_command_error)?;
      let(asset,mut file)=catalog.companion_resource(&asset_id,false).map_err(crate::encode_material_catalog_command_error)?;
      if approved!=asset{return Err("workspace-note-catalog-changed".into());}
      let imported=note::import_attachment_reader(&context.scope,&context.view,&context.correlation,&context.content,&asset.name,&mut file)?;
      registry.attachments.add_publication(&context.caller,&context.view,&context.scope,&context.correlation,&context.content,&imported)?;
      Ok(NoteActionOutcome::ReplaceRange{selection:*selection,text:format!("\n\n{}\n",imported.publication.markdown)})
     },
     (ExecuteInput::Documents{files},NoteMainAction::ImportDocument)=>{
      let _writes=guard_document_writes(registry,&context.scope,&[note_ref(&context.view)?])?;
      check_files(&files,true)?;let mut success=0;let mut renamed=0;let mut open_failures=0;let mut failures=Vec::new();
      for file in files{match import_markdown_bytes(context,&file){Ok((document,renamed_file))=>{success+=1;if renamed_file{renamed+=1;}if attach_scoped_note_without_attachments(app,registry,&context.caller,&context.scope,&document.summary.document_ref,&document.summary.title).is_err(){open_failures+=1;}},Err(_)=>failures.push(file.name)}}
      if success==0{return Err(format!("workspace-note-import-failed: {}",failures.join("、")));}
      let failed_names=if failures.is_empty(){String::new()}else{format!(" 未导入：{}",failures.join("、"))};
      Ok(NoteActionOutcome::Acknowledged{message:Some(format!("已导入 {success} 篇笔记，{renamed} 项同名文件已另存；{} 项未导入，{open_failures} 项未能自动打开。{failed_names}",failures.len()))})
     },
     (ExecuteInput::TagRename{review_id,document_ids},NoteMainAction::RenameTag{review})=>{
      if review_id!=review.id{return Err("workspace-note-tag-review-mismatch".into());}
      if document_ids.is_empty()||document_ids.len()>64||document_ids.iter().any(|id|!review.notes.iter().any(|note|note.document_id==*id)){return Err("workspace-note-tag-selection-invalid".into());}
      let references=document_ids.iter().map(|id|KnowledgeService::parse_document_id(id).map_err(crate::knowledge_error)).collect::<Result<Vec<_>,_>>()?;
      let _writes=guard_document_writes(registry,&context.scope,&references)?;
      let result=registry.note_actions.commit_tag_rename("main",&review_id,&document_ids,|owner,view,correlation|live_action(registry,owner,view,correlation))?;
      let message=if result.failures.is_empty(){"已更新所选笔记的文档属性标签。".to_owned()}else{format!("部分完成：已更新 {} 篇笔记，{} 项未更新。请重新检查失败项目。",result.updated.len(),result.failures.len())};
      if let Some(document)=result.updated.into_iter().find(|document|note_ref(&context.view).ok().as_ref()==Some(&document.summary.document_ref)){Ok(NoteActionOutcome::Saved{snapshot:metadata::snapshot_for(&context.scope,document)?,message:Some(message)})}else{Ok(NoteActionOutcome::Acknowledged{message:Some(message)})}
     },
     (ExecuteInput::Export{format},NoteMainAction::ExportDocument{format:expected,..})=>{
      if format!="markdown"||expected!=&format{return Err("workspace-note-pdf-unsupported".into());}let directory=export_directory.as_ref().ok_or("workspace-note-picker-cancelled")?;
      let(reference,identity,_)=note::validate_note(&context.scope,&context.view,&context.correlation,&context.content)?;
      context.scope.with_workspace_action_document_path(&identity,&reference,&context.correlation.revision,|source|{
       let name=source.file_name().and_then(|name|name.to_str()).ok_or("workspace-note-export-invalid")?;
       let(target,_)=crate::unique_local_markdown_export_target(directory,name,"Exported Markdown");crate::copy_file_without_overwrite(source,&target)?;Ok(())
      })?;Ok(NoteActionOutcome::Acknowledged{message:Some("Markdown 已导出。".into())})
     },
     _=>Err("workspace-note-action-kind-mismatch".into()),
    }
   })?;encoded(outcome)
  },
  NoteRequest::NoteActionStatus{view_id,authority,request_id,revision,generation,id}=>{
   bound(registry,label,&view_id,Some(&authority))?;
   if id.len()!=64{return Err("workspace-note-status-invalid".into());}
   let result=registry.note_queue.status(label,&id,|owner,view,correlation|live_action(registry,owner,view,correlation))?;
   if result.receipt.view_id!=view_id||result.receipt.request_id!=request_id||result.receipt.revision!=revision||result.receipt.generation!=generation{return Err("workspace-note-status-mismatch".into());}
   encoded(result)
  },
  NoteRequest::NoteAction{view_id,authority,request_id,revision,generation,content,action}=>{
   let(view,scope)=bound(registry,label,&view_id,Some(&authority))?;let correlation=ActionCorrelation{request_id,revision,generation};live_action(registry,label,&view,&correlation)?;let(reference,identity,_)=note::validate_note(&scope,&view,&correlation,&content)?;
   match action{
    NoteAction::SuggestAi {}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::SuggestAi),
    NoteAction::WriteAi{action,selection}=>{if !matches!(action.as_str(),"rewrite"|"shorten"|"expand"|"continue"){return Err("workspace-note-ai-action-unsupported".into());}enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::WriteAi{action,selection})},
    NoteAction::InsertAttachment{selection}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::PickAttachment{selection}),
    NoteAction::InsertExistingAttachment{asset_id,selection}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::PickCatalog{selection,suggested_asset_id:(!asset_id.is_empty()).then_some(asset_id)}),
    NoteAction::ImportDocument {}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::ImportDocument),
    NoteAction::ExportDocument{format}=>{if format!="markdown"{return Err("workspace-note-pdf-unsupported".into());}enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::ExportDocument{format})},
    NoteAction::BrowseDocuments{section:Some(section)}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::ManageKnowledge{section}),
    NoteAction::RenameTag{tag_id,ticket,name}=>{let GrantedNoteTarget::Tag{name:old_name}=registry.notes_metadata.target_for_scope(label,&view_id,&ticket,&scope,&reference,&correlation.revision)? else{return Err("workspace-note-tag-not-granted".into());};if registry.notes_metadata.tag_name_for_id(label,&view_id,&tag_id,&scope,&reference,&correlation.revision)?!=old_name{return Err("workspace-note-tag-not-granted".into());}let review=registry.note_actions.prepare_tag_rename(label,&scope,&view,&correlation,&content,&old_name,&name)?;enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::RenameTag{review})},
    NoteAction::AskAi {}=>enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::AskAi),
    NoteAction::OpenTag{tag_id,ticket}=>{let GrantedNoteTarget::Tag{name}=registry.notes_metadata.target_for_scope(label,&view_id,&ticket,&scope,&reference,&correlation.revision)? else{return Err("workspace-note-tag-not-granted".into());};if registry.notes_metadata.tag_name_for_id(label,&view_id,&tag_id,&scope,&reference,&correlation.revision)?!=name{return Err("workspace-note-tag-not-granted".into());}enqueue(app,registry,label,&scope,&view,&correlation,&content,NoteMainRequest::OpenTag{name})},
    direct=>{
     registry.note_queue.reserve_direct(label,&view,&correlation)?;
     match direct{
      NoteAction::RenameDocument{title}=>{let _writes=guard_note_rename(registry,label,&view,&scope)?;let document=note::rename_note(&scope,&view,&correlation,&content,&title)?;let grant=rebind_scoped_note(registry,label,&view,&document)?;let snapshot=metadata::snapshot_for(&scope,document)?;Ok(completed(json!({"kind":"renamed","title":grant.title,"documentId":snapshot.authority.document_id,"authority":snapshot.authority,"snapshot":snapshot,"viewGrant":grant})))},
      NoteAction::CreateNote{title,options}=>{validate_options(&options)?;let _writes=guard_document_writes(registry,&scope,&[reference.clone()])?;live_action(registry,label,&view,&correlation)?;let document=note::create_note(&scope,&view,&correlation,&content,&title,"")?;let grant=attach_scoped_note(app,registry,label,&scope,&document.summary.document_ref,&document.summary.title)?;if options.is_some(){let _=app.emit_to(label,"luckyray:workspace-note-navigation",json!({"viewId":grant.id,"options":options}));}Ok(completed(acknowledged("已创建笔记。")))},
      NoteAction::OpenNote{target,options,new_tab}=>{validate_options(&options)?;let _gate=registry.write_gate.lock().map_err(|_|"workspace-lock")?;live_action(registry,label,&view,&correlation)?;let _=new_tab;if target.title.len()>1024{return Err("workspace-note-target-invalid".into());}let GrantedNoteTarget::Document{document_ref,revision:target_revision,title}=registry.notes_metadata.target_for_scope(label,&view_id,&target.ticket,&scope,&reference,&correlation.revision)? else{return Err("workspace-note-target-not-granted".into());};if metadata::document_id(&document_ref)?!=target.document_id||scope.read_document(&document_ref).map_err(crate::knowledge_error)?.revision!=target_revision{return Err("workspace-note-target-changed".into());}let grant=attach_scoped_note(app,registry,label,&scope,&document_ref,&title)?;if options.is_some(){let _=app.emit_to(label,"luckyray:workspace-note-navigation",json!({"viewId":grant.id,"options":options}));}Ok(completed(acknowledged("已打开笔记。")))},
      NoteAction::SetFavorite{favorite}=>{let _writes=guard_document_writes(registry,&scope,&[reference.clone()])?;live_action(registry,label,&view,&correlation)?;scope.with_workspace_action_document_path(&identity,&reference,&correlation.revision,|_|{live_action(registry,label,&view,&correlation)?;let mut connection=crate::backend_services()?.open_write().map_err(|_|"workspace-note-favorite-unavailable")?;if favorite{crate::favorites::add(&mut connection,crate::favorites::FavoriteItemType::Note,&authority.document_id)?;}else{crate::favorites::remove(&mut connection,crate::favorites::FavoriteItemType::Note,&authority.document_id)?;}Ok(())})?;notify_peers(app,registry,label,&view);Ok(completed(acknowledged(if favorite{"已收藏此笔记。"}else{"已取消收藏。"})))},
      NoteAction::ApplyDocumentTags{names,mode}=>{let _writes=guard_document_writes(registry,&scope,&[reference.clone()])?;live_action(registry,label,&view,&correlation)?;let document=match mode.as_deref(){None|Some("replace")=>note::apply_tags(&scope,&view,&correlation,&content,&names)?,Some("merge")=>note::merge_tags(&scope,&view,&correlation,&content,&names)?,_=>return Err("workspace-note-tag-mode-invalid".into())};saved(app,registry,label,&view,&scope,document)},
      NoteAction::RemoveDocumentTag{tag_id}=>{let _writes=guard_document_writes(registry,&scope,&[reference.clone()])?;live_action(registry,label,&view,&correlation)?;let name=registry.notes_metadata.tag_name_for_id(label,&view_id,&tag_id,&scope,&reference,&correlation.revision)?;saved(app,registry,label,&view,&scope,note::remove_tag(&scope,&view,&correlation,&content,&name)?)},
      NoteAction::CreateTag{name}=>{let _writes=guard_document_writes(registry,&scope,&[reference.clone()])?;live_action(registry,label,&view,&correlation)?;saved(app,registry,label,&view,&scope,note::create_tag(&scope,&view,&correlation,&content,&name)?)},
      NoteAction::OpenAttachment{token}=>{let _gate=registry.write_gate.lock().map_err(|_|"workspace-lock")?;live_action(registry,label,&view,&correlation)?;crate::workspace_attachments::open_token(registry,label,&view_id,&correlation.revision,&token)?;Ok(completed(acknowledged("已打开附件。")))},
      NoteAction::OpenExternal{url}=>{let _gate=registry.write_gate.lock().map_err(|_|"workspace-lock")?;live_action(registry,label,&view,&correlation)?;let parsed=tauri::Url::parse(&url).map_err(|_|"workspace-note-url-invalid")?;if url.len()>8192||!matches!(parsed.scheme(),"http"|"https")||parsed.host_str().is_none()||!parsed.username().is_empty()||parsed.password().is_some(){return Err("workspace-note-url-invalid".into());}if !crate::knowledge::companion_attachment_links(&content).iter().any(|link|link.syntax==crate::knowledge::CompanionLinkSyntax::Markdown&&link.destination==url){return Err("workspace-note-url-not-referenced".into());}live_action(registry,label,&view,&correlation)?;tauri_plugin_opener::open_url(url,None::<&str>).map_err(|_|"workspace-note-open-failed")?;Ok(completed(acknowledged("已打开链接。")))},
      NoteAction::InsertFiles{files,selection}=>Ok(completed(encoded(import_files(registry,label,&scope,&view,&correlation,&content,&files,selection)?)?)),
      NoteAction::InsertClipboardImage{source,selection:range}=>{selection(&content,range)?;let file=tauri::async_runtime::spawn_blocking(move||clipboard_file(source)).await.map_err(|_|"workspace-note-image-download-failed")??;live_action(registry,label,&view,&correlation)?;Ok(completed(encoded(import_files(registry,label,&scope,&view,&correlation,&content,&[file],range)?)?))},
      NoteAction::BrowseDocuments{section:None}|NoteAction::BrowseAttachments {}|NoteAction::EditDocumentTags {}|NoteAction::CloseView {}=>Err("workspace-note-local-host-handler-required".into()),
      _=>Err("workspace-note-action-unsupported".into()),
     }
    }
   }
  }
 }
}

#[cfg(test)]
mod tests{
 #[test] fn closeout_transient_binding_check_is_not_an_uninstalled_rename_route(){
  let registry=WorkspaceWindows::default();
  *registry.main_binding_coverage.lock().unwrap()=(1,true);
  let ready=installed_note_capabilities(&registry).unwrap();
  {let _read=registry.guard_main_document_read().unwrap();
   let checking=installed_note_capabilities(&registry).unwrap();
   assert_eq!(checking["actions"],ready["actions"]);
   assert!(checking["actions"].as_array().unwrap().iter().any(|action|action=="rename-document"));
  }
 }
 use super::*;
 #[test]fn payloads_reject_paths_commands_and_forged_main_fields(){
  assert!(serde_json::from_value::<ExecuteInput>(json!({"kind":"files","files":[],"path":"/private"})).is_err());
  assert!(serde_json::from_value::<NoteAction>(json!({"kind":"run-command","command":"sh"})).is_err());
  assert!(serde_json::from_value::<NoteRequest>(json!({"op":"noteMainPending","caller":"main"})).is_err());
 }
 #[test]fn filenames_bytes_and_utf16_ranges_are_bounded(){
  assert!(check_files(&[NoteFile{name:"../private.png".into(),mime_type:"image/png".into(),bytes:vec![1]}],false).is_err());
  assert!(check_files(&[NoteFile{name:"note.txt".into(),mime_type:"text/plain".into(),bytes:vec![1]}],true).is_err());
  assert!(selection("a😀b",NoteSelection{start:1,end:3}).is_ok());assert!(selection("a😀b",NoteSelection{start:1,end:2}).is_err());
 }
}
