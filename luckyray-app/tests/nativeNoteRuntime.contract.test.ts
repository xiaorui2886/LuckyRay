import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createNativeNoteRuntime,loadNativeNoteRuntime,nativeNoteDocumentId,REQUIRED_NATIVE_NOTE_ACTIONS,type NativeNoteCommand,type NativeNoteRuntimeServices} from '../src/workspace/nativeNoteRuntime';
import type {NoteAuthority,NoteActionRequest} from '../src/features/notes/NoteRuntime';
const reference={vaultId:'vault-a',relativePath:'folder/A.md'};
const authority:NoteAuthority={vaultId:reference.vaultId,sourceId:`note-source-v1:${'a'.repeat(64)}`,documentId:nativeNoteDocumentId(reference)};
const completeness={complete:true,missing:[],truncated:false,scope:'linked-and-backlinked',noteSuggestions:'linked-and-backlinked'};
const metadata=()=>({authority,revision:'r1',metadata:{notes:[],tags:[],links:[],backlinks:[],documentTags:[],favorite:false},completeness});
function fixture(overrides:Partial<NativeNoteRuntimeServices>={}){
 const calls:NativeNoteCommand[]=[];let disk={authority,documentRef:reference,content:'baseline',revision:'r1',title:'A'};
 const services:NativeNoteRuntimeServices={
  command:async request=>{calls.push(request);switch(request.op){
   case 'noteAuthority':return authority;
   case 'readNote':return disk;
   case 'writeNote':if(request.revision!==disk.revision)throw Error('knowledge-revision-conflict');disk={...disk,content:request.content,revision:'r2'};return disk;
   case 'noteMetadata':return {...metadata(),revision:request.revision};
   case 'resolveAttachment':return {status:'resolved',token:'b'.repeat(64),version:'bytes-v1',mediaKind:'image'};
   default:throw Error('unexpected');
  }},mediaUrl:token=>`workspace-attachment://localhost/${token}`,
  actionCapabilities:REQUIRED_NATIVE_NOTE_ACTIONS,
  actions:{request:async request=>({...request,result:{ok:true,value:{kind:'acknowledged'}}})},...overrides,
 };
 return {runtime:createNativeNoteRuntime('view-a',authority,services),services,calls,setDisk:(next:Partial<typeof disk>)=>{disk={...disk,...next};}};
}
function action():NoteActionRequest{return {requestId:1,viewId:'view-a',authority,revision:'r1',generation:0,content:'baseline',action:{kind:'ask-ai'}};}
test('authority bootstrap is backend issued and document codec matches production identity',async()=>{
 const f=fixture();const runtime=await loadNativeNoteRuntime('view-a',f.services);
 assert.deepEqual(runtime.authority,authority);assert.deepEqual(f.calls,[{op:'noteAuthority',viewId:'view-a'}]);
 assert.equal(Buffer.from(authority.documentId.slice(5),'hex').toString(),JSON.stringify(reference));
 for(const relativePath of ['/outside.md','../secret.md','C:\\secret.md','.luckyray/private.md'])assert.throws(()=>nativeNoteDocumentId({...reference,relativePath}));
 assert.throws(()=>createNativeNoteRuntime('view-a',{...authority,sourceId:'Main-sourceEpoch-4'},f.services));
});
test('existing readNote/writeNote are the only body/CAS transport and preserve exact expected revision',async()=>{
 const f=fixture();assert.equal((await f.runtime.documents.read()).content,'baseline');await f.runtime.documents.write('draft','r1');
 assert.deepEqual(f.calls,[{op:'readNote',viewId:'view-a'},{op:'writeNote',viewId:'view-a',content:'draft',revision:'r1'}]);
 await assert.rejects(()=>f.runtime.documents.write('overwrite','r1'),/knowledge-revision-conflict/);
 await assert.rejects(()=>f.runtime.documents.write('overwrite',''),{code:'invalid-result'});
 assert.equal(f.calls.length,3);
});
test('body responses cannot spoof same-id recreated source, foreign document, or absent backend authority',async()=>{
 for(const changed of [{authority:{...authority,sourceId:`note-source-v1:${'c'.repeat(64)}`}},{documentRef:{...reference,relativePath:'Other.md'}},{authority:undefined}]){
  const f=fixture();f.setDisk(changed as never);await assert.rejects(()=>f.runtime.documents.read(),{code:'scope-mismatch'});
 }
});
test('metadata missing provider, incomplete index, truncation or absent scope never signals ready',async()=>{
 for(const change of [{complete:false,missing:['favorite-provider-required']},{complete:false,truncated:true},{scope:'whole-vault'},{noteSuggestions:undefined}]){
  const f=fixture({command:async()=>({...metadata(),completeness:{...completeness,...change}})});
  assert.equal((await f.runtime.metadata.read('r1')).ok,false);
 }
 const unavailable=fixture({command:async()=>{throw Error('workspace-note-favorite-provider-required');}});
 assert.deepEqual((await unavailable.runtime.metadata.read('r1')).ok,false);
});
test('metadata requires every installed action route and does not silently mount a reduced runtime',async()=>{
 const f=fixture({actions:undefined,actionCapabilities:[]});
 assert.equal(f.runtime.readiness().complete,false);assert.ok(f.runtime.readiness().missing.includes('parent-action:ask-ai'));
 assert.equal((await f.runtime.metadata.read('r1')).ok,false);assert.equal(f.calls.length,0);
 const partial=fixture({actionCapabilities:['ask-ai']});assert.equal(partial.runtime.readiness().complete,false);
 const complete=fixture();assert.equal(complete.runtime.readiness().complete,true);assert.equal((await complete.runtime.metadata.read('r1')).ok,true);
});
test('metadata revision/authority is immutable and unrelated response bodies are projected out',async()=>{
 const bad=fixture({command:async()=>({...metadata(),revision:'other'})});assert.equal((await bad.runtime.metadata.read('r1')).ok,false);
 const f=fixture({command:async()=>({...metadata(),absolutePath:'/private',metadata:{...metadata().metadata,plainText:'private'}})});
 const result=await f.runtime.metadata.read('r1');assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes('private'));
});
test('attachment issuance is per saved reference and revision, duplicates rejected, token-only',async()=>{
 const f=fixture();const references=[{target:'pic.png',wiki:true},{target:'pic2.png',wiki:false}];
 const result=await f.runtime.attachments.resolve(references,'r1');assert.equal(result.ok,true);
 assert.deepEqual(f.calls,[{op:'resolveAttachment',viewId:'view-a',revision:'r1',destination:'pic.png',wiki:true},{op:'resolveAttachment',viewId:'view-a',revision:'r1',destination:'pic2.png',wiki:false}]);
 if(result.ok){assert.equal(result.value.length,2);assert.equal(f.runtime.attachments.mediaUrl(result.value[0].token),`workspace-attachment://localhost/${'b'.repeat(64)}`);}
 assert.equal((await f.runtime.attachments.resolve(references,'')).ok,false);
 assert.equal((await f.runtime.attachments.resolve([references[0],references[0]],'r1')).ok,false);
 assert.equal((await f.runtime.attachments.resolve(Array(257).fill(references[0]),'r1')).ok,false);
});
test('attachments reject path results, wrong protocol, unsupported media and forged tokens',async()=>{
 for(const result of [{status:'resolved',path:'/private.png'},{status:'resolved',token:'path.png',mediaKind:'image',version:'x'},{status:'resolved',token:'b'.repeat(64),mediaKind:'html-preview',version:'x'}]){
  const f=fixture({command:async()=>result});assert.equal((await f.runtime.attachments.resolve([{target:'pic.png',wiki:true}],'r1')).ok,false);
 }
 for(const url of ['file:///private.png','asset://localhost/private.png',`workspace-attachment://localhost/${'c'.repeat(64)}`]){
  const f=fixture({mediaUrl:()=>url});assert.throws(()=>f.runtime.attachments.mediaUrl('b'.repeat(64)),{code:'invalid-result'});
 }
});
test('parent action bridge rejects forged view/source and correlated reply mismatches',async()=>{
 const f=fixture();assert.equal((await f.runtime.actions.request(action())).result.ok,true);
 assert.equal((await f.runtime.actions.request({...action(),viewId:'foreign'})).result.ok,false);
 assert.equal((await f.runtime.actions.request({...action(),authority:{...authority,documentId:'forged'}})).result.ok,false);
 const bad=fixture({actions:{request:async request=>({...request,revision:'new',result:{ok:true,value:{kind:'acknowledged'}}})}});
 assert.equal((await bad.runtime.actions.request(action())).result.ok,false);
});
test('close/rebind invalidates pending read, attachment, query and broker responses',async()=>{
 let resolve!:(value:unknown)=>void;const f=fixture({command:()=>new Promise(done=>{resolve=done;})});
 const read=f.runtime.documents.read();f.runtime.dispose();resolve({authority,documentRef:reference,content:'old',revision:'r1'});
 await assert.rejects(()=>read,{code:'stale-result'});assert.equal(f.runtime.readiness().complete,false);
 await assert.rejects(()=>f.runtime.documents.read(),{code:'stale-result'});
 let finish!:(value:unknown)=>void;const a=fixture({command:()=>new Promise(done=>{finish=done;})});const pending=a.runtime.attachments.resolve([{target:'pic.png',wiki:true}],'r1');a.runtime.dispose();finish({status:'resolved',token:'b'.repeat(64),version:'v1',mediaKind:'image'});assert.equal((await pending).ok,false);
});
test('explicit title query is bounded, ticketed, and reports truncation instead of full autocomplete',async()=>{
 const queryResult={authority,revision:'r1',query:'Alpha',notes:[{id:authority.documentId,title:'Alpha',snippet:'short',target:{ticket:'c'.repeat(64),documentId:authority.documentId,title:'Alpha'}}],completeness:{complete:false,missing:[],truncated:true,scope:'title-query',noteSuggestions:'title-query'}};
 const f=fixture({command:async()=>queryResult});const result=await f.runtime.queryNotes('Alpha','r1',1);assert.equal(result.ok,true);if(result.ok)assert.equal(result.value.completeness.truncated,true);
 for(const [query,limit] of [['',32],['Alpha',65],['x'.repeat(121),1]] as const)assert.equal((await f.runtime.queryNotes(query,'r1',limit)).ok,false);
 const bad=fixture({command:async()=>({...queryResult,notes:[{...queryResult.notes[0],target:{...queryResult.notes[0].target,ticket:'forged'}}]})});assert.equal((await bad.runtime.queryNotes('Alpha','r1')).ok,false);
});
test('native adapter and backend have no global bridge/current library or unrestricted write escape hatch',()=>{
 const adapter=readFileSync(new URL('../src/workspace/nativeNoteRuntime.ts',import.meta.url),'utf8');
 assert.doesNotMatch(adapter,/getLuckyRayBridge|knowledgeStore|activateKnowledgeWrites|readActiveKnowledge|@tauri-apps\/plugin-sql|window\.api|convertFileSrc|noteTransport/);
 const backend=readFileSync(new URL('../src-tauri/src/workspace_notes_metadata.rs',import.meta.url),'utf8');
 const production=backend.split('#[cfg(test)]')[0];
 assert.doesNotMatch(production,/replace_document|set_document_tags|backend_services|Connection|root_path|std::fs::/);
 assert.match(production,/workspace_recovery_record/);assert.match(production,/current_target_identity/);assert.match(production,/require_revision\(scope, source_ref|validate_held/);
});

test('metadata cannot smuggle forged tickets or foreign-vault references',async()=>{
 for(const target of [{ticket:'forged',documentId:authority.documentId,title:'A'},{ticket:'c'.repeat(64),documentId:nativeNoteDocumentId({...reference,vaultId:'foreign'}),title:'A'}]){
  const f=fixture({command:async()=>({...metadata(),metadata:{...metadata().metadata,notes:[{id:target.documentId,title:'A',snippet:'short',target}]}})});
  assert.equal((await f.runtime.metadata.read('r1')).ok,false);
 }
});
test('ticketed index pages project bounded safe metadata and reject guessed cursors',async()=>{
 const page={authority,revision:'r1',notes:[{id:authority.documentId,title:'A',snippet:'short',target:{ticket:'d'.repeat(64),documentId:authority.documentId,title:'A'}}],total:2,nextCursor:'e'.repeat(64),rootPath:'/private',completeness:{complete:true,missing:[],truncated:false,scope:'vault-index-page',noteSuggestions:'vault-index-page'}};
 const f=fixture({command:async()=>page});const result=await f.runtime.listNotes('r1');assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes('/private'));
 assert.equal((await f.runtime.listNotes('r1','folder/A.md')).ok,false);
 const stale=fixture({command:async()=>({...page,revision:'r2'})});assert.equal((await stale.runtime.listNotes('r1')).ok,false);
});
test('current attachment list exposes only declared rows and exact opaque tokens',async()=>{
 const row={target:'pic.png',wiki:true,label:'pic.png',status:'resolved',token:'b'.repeat(64),mediaKind:'image',absolutePath:'/private/pic.png'};
 const f=fixture({command:async()=>({authority,revision:'r1',references:[row],complete:true,missing:[],rootPath:'/private'})});const result=await f.runtime.listAttachments('r1');assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes('/private'));
 const forged=fixture({command:async()=>({authority,revision:'r1',references:[{...row,token:'pic.png'}],complete:true,missing:[]})});assert.equal((await forged.runtime.listAttachments('r1')).ok,false);
});
