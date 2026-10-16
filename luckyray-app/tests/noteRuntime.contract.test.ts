import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createScopedNoteRuntime, noteMediaFromGrants, noteMediaWithEmbeddedNotes, validateNoteMetadata, noteRuntimeMissingActions, NOTE_PRODUCTION_PARENT_ACTIONS, type NoteActionReply, type NoteActionRequest, type NoteAuthority, type NoteMetadata, type NoteRuntime} from '../src/features/notes/NoteRuntime';
import {NoteDocumentController,NoteDocumentControllers} from '../src/features/notes/NoteDocumentController';
const authority:NoteAuthority={vaultId:'vault-A',sourceId:'vault-A-incarnation-1',documentId:'real-vault:Note.md'};
const completeness={complete:true,missing:[],truncated:false,scope:'linked-and-backlinked' as const,noteSuggestions:'linked-and-backlinked' as const};
const deliveredMetadata=()=>({...metadata,completeness});
const metadata:NoteMetadata={notes:[],tags:[],backlinks:[],links:[],documentTags:[],favorite:false};
function fixture(options:Partial<NoteRuntime>={}){
 let disk={authority,content:'baseline',revision:'r1',title:'Note'},writes:unknown[][]=[];
 const runtime=createScopedNoteRuntime(options.authority||authority,{
  documents:{read:async()=>disk,write:async(content,revision)=>{writes.push([content,revision]);if(revision!==disk.revision)throw Error('knowledge-revision-conflict');return disk={...disk,content,revision:`r${Number(disk.revision.slice(1))+1}`};}},
  attachments:{resolve:async()=>({ok:true,value:[]}),mediaUrl:token=>`workspace-attachment://localhost/${token}`},
  ...options,
 });
 return {runtime,writes,setDisk:(next:Partial<typeof disk>)=>{disk={...disk,...next};},getDisk:()=>disk};
}
const waitForReply=()=>{let resolve!:(reply:NoteActionReply)=>void;let request!:NoteActionRequest;let start!:()=>void;const started=new Promise<void>(done=>{start=done;});return {started,service:{request:(value:NoteActionRequest)=>{request=value;start();return new Promise<NoteActionReply>(done=>{resolve=done;});}},reply:(changes:Partial<NoteActionReply>={})=>resolve({...request,result:{ok:true,value:{kind:'replace-range',selection:{start:0,end:8},text:'changed'}},...changes}),getRequest:()=>request};};
test('scoped runtime fails closed for omitted parent services, with no global fallback',async()=>{
 const {runtime}=fixture();const owner=new NoteDocumentController(runtime);owner.attachView('view');await owner.load();
 await assert.rejects(()=>owner.request('view',{kind:'ask-ai'}),{code:'unsupported'});
 await assert.rejects(()=>owner.metadata(),{code:'unsupported'});
 for(const name of ['NoteRuntime.ts','NoteDocumentController.ts','ScopedNoteDocumentSurface.tsx','NoteDocumentSurface.tsx','NotePreview.tsx']){
  const source=readFileSync(new URL(`../src/features/notes/${name}`,import.meta.url),'utf8');
  assert.doesNotMatch(source,/getLuckyRayBridge|knowledgeStore|activateKnowledgeWrites|readActiveKnowledge|@tauri-apps\/plugin-sql|window\.api|convertFileSrc/);
 }
});
test('scoped snapshots require exact vault, source incarnation and document',async()=>{
 for(const wrong of [{vaultId:'vault-B'},{sourceId:'vault-A-incarnation-2'},{documentId:'real-vault:Other.md'}]){
  const f=fixture();f.setDisk({authority:{...authority,...wrong}});const owner=new NoteDocumentController(f.runtime);await owner.load();
  assert.equal(owner.session.getSnapshot().revision,'');assert.equal(owner.session.getSnapshot().status,'error');owner.edit('must not become draft');assert.equal(await owner.flush(),false);assert.equal(f.writes.length,0);
 }
});
test('one controller per actual document authority, independent of view id',async()=>{
 const registry=new NoteDocumentControllers(),f=fixture(),a=registry.get(f.runtime),b=registry.get(f.runtime);
 assert.equal(a,b);const closeA=a.attachView('view-A'),closeB=b.attachView('view-B');await a.load();a.edit('same draft');assert.equal(b.session.getSnapshot().content,'same draft');
 assert.throws(()=>a.attachView('view-A'),{code:'scope-mismatch'});closeA();closeB();
 const different=fixture({authority:{...authority,sourceId:'other incarnation'}});assert.notEqual(registry.get(different.runtime),a);
});
test('CAS uses exact read revision and conflict retains dirty input without retry overwrite',async()=>{
 const f=fixture(),owner=new NoteDocumentController(f.runtime);await owner.load();owner.edit('my input');f.setDisk({content:'peer input',revision:'r2'});
 assert.equal(await owner.flush(),false);assert.deepEqual(f.writes,[['my input','r1']]);assert.equal(owner.session.getSnapshot().content,'my input');assert.equal(owner.session.getSnapshot().dirty,true);assert.equal(owner.session.getSnapshot().status,'conflict');assert.equal(owner.session.getSnapshot().remote?.content,'peer input');assert.equal(await owner.flush(),false);assert.equal(f.writes.length,1);
 owner.session.resolveConflict('keep-local');assert.equal(await owner.flush(),true);assert.deepEqual(f.writes[1],['my input','r2']);
});
test('registry close flush covers inactive owners and keeps unresolvable drafts',async()=>{
 const registry=new NoteDocumentControllers(),first=fixture(),second=fixture({authority:{...authority,documentId:'real-vault:Other.md'}});
 second.setDisk({authority:second.runtime.authority});const a=registry.get(first.runtime),b=registry.get(second.runtime);await Promise.all([a.load(),b.load()]);a.edit('draft A');b.edit('draft B');assert.equal(registry.hasDirty(),true);assert.equal(await registry.flushAll(),true);assert.equal(first.writes.length,1);assert.equal(second.writes.length,1);
 b.edit('new B');second.setDisk({content:'remote B',revision:'r9'});assert.equal(await registry.flushAll(),false);assert.equal(b.session.getSnapshot().content,'new B');
});
test('missing document cannot be edited or overwritten and does not trap application quit',async()=>{
 let writes=0;const f=fixture({documents:{read:async()=>{throw Error('missing');},write:async()=>{writes++;throw Error('no authority');}}});const registry=new NoteDocumentControllers(),owner=registry.get(f.runtime);await owner.load();owner.edit('');assert.equal(await owner.flush(),false);assert.equal(await registry.flushAll(),true);assert.equal(writes,0);assert.equal(owner.session.getSnapshot().status,'error');
});
test('parent action envelopes carry exact scope, draft revision and generation',async()=>{
 const replies=waitForReply(),f=fixture({actions:replies.service}),owner=new NoteDocumentController(f.runtime);owner.attachView('view-A');await owner.load();owner.edit('my draft');const pending=owner.request('view-A',{kind:'write-ai',action:'rewrite',selection:{start:0,end:8}});
 await replies.started;assert.equal(replies.getRequest().content,'my draft');assert.deepEqual(replies.getRequest().authority,authority);assert.equal(replies.getRequest().revision,'r2');assert.ok(replies.getRequest().generation>0);replies.reply();assert.equal((await pending).kind,'replace-range');
});
test('typing while an action is pending rejects the stale replacement',async()=>{
 const replies=waitForReply(),owner=new NoteDocumentController(fixture({actions:replies.service}).runtime);owner.attachView('view');await owner.load();const pending=owner.request('view',{kind:'suggest-ai'});owner.edit('new typing');replies.reply();await assert.rejects(()=>pending,{code:'stale-result'});assert.equal(owner.session.getSnapshot().content,'new typing');
});
test('closing and reopening the same view id rejects the old action reply',async()=>{
 const replies=waitForReply(),owner=new NoteDocumentController(fixture({actions:replies.service}).runtime);const close=owner.attachView('view');await owner.load();const pending=owner.request('view',{kind:'ask-ai'});close();owner.attachView('view');replies.reply();await assert.rejects(()=>pending,{code:'stale-result'});
});
test('action replies cannot substitute a document, view, request or revision',async()=>{
 for(const changes of [{authority:{...authority,documentId:'Other'}},{viewId:'other'},{requestId:100},{revision:'r99'},{generation:100}]){
  const replies=waitForReply(),owner=new NoteDocumentController(fixture({actions:replies.service}).runtime);owner.attachView('view');await owner.load();const pending=owner.request('view',{kind:'ask-ai'});replies.reply(changes);await assert.rejects(()=>pending,{code:'scope-mismatch'});
 }
});
test('bounded metadata strips body/path fields and requires verified target tickets',()=>{
 const target={ticket:'opaque-ticket',documentId:'peer',title:'Peer'};
 const value=validateNoteMetadata({...metadata,notes:[{id:'peer',title:'Peer',snippet:'s'.repeat(1000),target,contentText:'private body',absolutePath:'/outside'} as never]});
 assert.equal(value.notes[0].snippet?.length,240);assert.equal('contentText' in value.notes[0],false);assert.equal('absolutePath' in value.notes[0],false);
 assert.throws(()=>validateNoteMetadata({...metadata,notes:[{id:'peer',title:'Peer',target:{...target,documentId:'wrong'}}]}),{code:'invalid-result'});
 assert.throws(()=>validateNoteMetadata({...metadata,notes:Array.from({length:257},()=>({id:'peer',title:'Peer',target}))}),{code:'invalid-result'});
});
test('opaque attachment grants are baseline scoped and cannot smuggle filesystem URLs',()=>{
 const {runtime}=fixture(),token='a'.repeat(64),references=[{target:'image.png',wiki:true}],grant={target:'image.png',wiki:true,token,version:'v1',mediaKind:'image' as const};
 const media=noteMediaFromGrants(runtime,[grant],references);assert.equal(media.assets[0].previewUrl,`workspace-attachment://localhost/${token}`);assert.equal('originalPath' in media.assets[0],false);assert.equal('libraryPath' in media.assets[0],false);
 for(const bad of [{...grant,token:'/etc/passwd'},{...grant,target:'unrequested.png'},{...grant,wiki:false}])assert.throws(()=>noteMediaFromGrants(runtime,[bad],references),{code:'invalid-result'});
 assert.throws(()=>noteMediaFromGrants({...runtime,attachments:{...runtime.attachments,mediaUrl:()=> 'asset://localhost/private'}},[grant],references),{code:'invalid-result'});
});
test('identical wiki and Markdown attachment names keep distinct renderer identities',()=>{
 const {runtime}=fixture(),references=[{target:'clip.mp4',wiki:true},{target:'clip.mp4',wiki:false}];
 const media=noteMediaFromGrants(runtime,references.map((reference,index)=>({...reference,token:String(index+1).repeat(64),version:'v1',mediaKind:'video' as const})),references);
 assert.deepEqual(media.embeds.map(embed=>embed.targetName),['clip.mp4','md:clip.mp4']);assert.notEqual(media.embeds[0].assetId,media.embeds[1].assetId);
});
test('generic attachment grants enable explicit opening without creating a preview URL',()=>{
 let conversions=0;const {runtime}=fixture({attachments:{resolve:async()=>({ok:true,value:[]}),mediaUrl:()=>{conversions++;throw Error('nonmedia must never convert');}}});
 const grant={target:'report.pdf',wiki:true,token:'f'.repeat(64),version:'v1',mediaKind:'file' as const};const media=noteMediaFromGrants(runtime,[grant],[{target:grant.target,wiki:true}]);
 assert.equal(conversions,0);assert.equal(media.assets[0].kind,'document');assert.equal(media.assets[0].previewUrl,undefined);
 assert.throws(()=>noteMediaFromGrants(runtime,[{...grant,target:'Other.md'}],[{target:'Other.md',wiki:true}]),{code:'unsupported'});
});
test('wiki note embeds match production document chips with ticketed navigation and no body or file URL',()=>{
 const note={ticket:'e'.repeat(64),documentId:'peer',title:'Peer'};
 const result=noteMediaWithEmbeddedNotes({assets:[],embeds:[]},validateNoteMetadata({...metadata,noteEmbeds:[{target:'Peer.md',wiki:true,note}]}));
 assert.deepEqual(result.assets,[{id:`note-embed:${note.documentId}`,name:'Peer',kind:'document'}]);assert.equal(result.embeds[0].targetName,'Peer.md');assert.equal(result.embeds[0].isMissing,0);assert.ok(!JSON.stringify(result).includes('workspace-attachment'));
});
test('fresh revision tokens retain reference identity and explicit immutable byte-version bindings',()=>{
 const {runtime}=fixture(),reference={target:'clip.mp4',wiki:true};
 const render=(token:string)=>noteMediaFromGrants(runtime,[{...reference,token,version:'exact-file-hash',mediaKind:'video'}],[reference]);
 const before=render('a'.repeat(64)),after=render('b'.repeat(64));assert.equal(before.assets[0].id,after.assets[0].id);assert.notEqual(before.assets[0].previewUrl,after.assets[0].previewUrl);assert.deepEqual(before.bindings?.[0].reference,after.bindings?.[0].reference);assert.equal(before.bindings?.[0].version,after.bindings?.[0].version);assert.notEqual(before.bindings?.[0].token,after.bindings?.[0].token);
});
test('media resolution is rejected when the committed revision changes in flight',async()=>{
 let resolve!:(value:never)=>void;const f=fixture({attachments:{resolve:()=>new Promise(done=>{resolve=done;}),mediaUrl:token=>`workspace-attachment://localhost/${token}`}}),owner=new NoteDocumentController(f.runtime);await owner.load();const pending=owner.media([],'r1');owner.session.receive({content:'new baseline',revision:'r2'});resolve({ok:true,value:[]} as never);await assert.rejects(()=>pending,{code:'stale-result'});
});
test('old-grant action replies are rejected after same-document runtime replacement',async()=>{
 const replies=waitForReply(),first=fixture({actions:replies.service}),owner=new NoteDocumentController(first.runtime);owner.attachView('view');await owner.load();
 const pending=owner.request('view',{kind:'ask-ai'});owner.replaceRuntime(fixture().runtime);replies.reply();await assert.rejects(()=>pending,{code:'stale-result'});
});
test('metadata reads are latest-request and exact-revision bound',async()=>{
 const pending:Array<{revision:string;resolve:(value:unknown)=>void}>=[];
 const f=fixture({metadata:{read:revision=>new Promise(resolve=>pending.push({revision,resolve:resolve as (value:unknown)=>void}))}}),owner=new NoteDocumentController(f.runtime);await owner.load();
 const a=owner.metadata(),b=owner.metadata();
 const reply=(index:number,revision='r1')=>pending[index].resolve({ok:true,value:{authority,revision,metadata,completeness}});
 reply(1);assert.deepEqual(await b,deliveredMetadata());reply(0);await assert.rejects(()=>a,{code:'stale-result'});
 const c=owner.metadata();owner.session.receive({content:'peer',revision:'r2'});reply(2);await assert.rejects(()=>c,{code:'stale-result'});
 const d=owner.metadata();reply(3,'r1');await assert.rejects(()=>d,{code:'scope-mismatch'});
});
test('metadata from another authority and from retired grant never publishes',async()=>{
 let resolve!:(value:unknown)=>void;
 const f=fixture({metadata:{read:()=>new Promise(done=>{resolve=done as (value:unknown)=>void;})}}),owner=new NoteDocumentController(f.runtime);await owner.load();
 const a=owner.metadata();resolve({ok:true,value:{authority:{...authority,vaultId:'other'},revision:'r1',metadata,completeness}});await assert.rejects(()=>a,{code:'scope-mismatch'});
 const b=owner.metadata();owner.replaceRuntime(fixture().runtime);resolve({ok:true,value:{authority,revision:'r1',metadata,completeness}});await assert.rejects(()=>b,{code:'stale-result'});
});
test('malformed target and non-http links do not reach parent mediator',async()=>{
 let requests=0;const f=fixture({actions:{request:async request=>{requests++;return {...request,result:{ok:true,value:{kind:'acknowledged'}}};}}}),owner=new NoteDocumentController(f.runtime);owner.attachView('view');await owner.load();
 for(const action of [{kind:'open-external',url:'file:///private'},{kind:'open-external',url:'javascript:alert(1)'},{kind:'open-attachment',token:'path'},{kind:'open-note',target:{ticket:'',documentId:'A',title:'A'}}] as const)await assert.rejects(()=>owner.request('view',action),{code:'invalid-result'});
 assert.equal(requests,0);
});
test('independent same-document views each receive metadata without invalidating one another',async()=>{
 const pending:Array<(value:unknown)=>void>=[];
 const f=fixture({metadata:{read:()=>new Promise(resolve=>pending.push(resolve as (value:unknown)=>void))}}),owner=new NoteDocumentController(f.runtime);owner.attachView('one');owner.attachView('two');await owner.load();
 const a=owner.metadata('one'),b=owner.metadata('two');for(const resolve of pending)resolve({ok:true,value:{authority,revision:'r1',metadata,completeness}});
 assert.deepEqual(await a,deliveredMetadata());assert.deepEqual(await b,deliveredMetadata());
});
test('shared document writes use a remaining live grant after either duplicate view closes',async()=>{
 for(const closed of ['A','B']){
  let disk={authority,content:'baseline',revision:'r1'},revoked=new Set<string>();const written:string[]=[];
  const runtime=(id:string)=>fixture({documents:{read:async()=>{if(revoked.has(id))throw Error('revoked');return disk;},write:async(content,revision)=>{if(revoked.has(id))throw Error('revoked');assert.equal(revision,disk.revision);written.push(id);return disk={...disk,content,revision:'r2'};}}}).runtime;
  const a=runtime('A'),b=runtime('B'),registry=new NoteDocumentControllers(),owner=registry.get(a);assert.equal(registry.get(b),owner);
  const closeA=owner.attachView('A',a),closeB=owner.attachView('B',b);await owner.load();
  if(closed==='A')closeA();else closeB();revoked.add(closed);owner.edit('remaining view input');assert.equal(await owner.flush(),true);assert.deepEqual(written,[closed==='A'?'B':'A']);
 }
});
test('per-view actions retain originating grant instead of last duplicate runtime supplied',async()=>{
 const calls:string[]=[];const runtime=(id:string)=>fixture({actions:{request:async request=>{calls.push(id);return {...request,result:{ok:true,value:{kind:'acknowledged'}}};}}}).runtime;
 const a=runtime('A'),b=runtime('B'),registry=new NoteDocumentControllers(),owner=registry.get(a);registry.get(b);owner.attachView('A',a);owner.attachView('B',b);await owner.load();await owner.request('A',{kind:'ask-ai'});await owner.request('B',{kind:'ask-ai'});assert.deepEqual(calls,['A','B']);
});
test('metadata without explicit completeness cannot silently mark a child ready',async()=>{
 const f=fixture({metadata:{read:async()=>({ok:true,value:{authority,revision:'r1',metadata} as never})}}),owner=new NoteDocumentController(f.runtime);await owner.load();await assert.rejects(()=>owner.metadata(),{code:'invalid-result'});
});
test('composition in any duplicate view blocks autosave and host close flush until committed',async()=>{
 const registry=new NoteDocumentControllers(),f=fixture(),owner=registry.get(f.runtime);owner.attachView('A');owner.attachView('B');await owner.load();owner.setComposing('A',true);owner.edit('in-progress composition');assert.equal(await owner.flush(),false);assert.equal(await registry.flushAll(),false);assert.equal(f.writes.length,0);owner.edit('committed text');owner.setComposing('A',false);assert.equal(await registry.flushAll(),true);assert.deepEqual(f.writes,[['committed text','r1']]);
});
test('partial or duplicate media results cannot mark missing referenced attachments ready',()=>{
 const {runtime}=fixture(),references=[{target:'one.png',wiki:true},{target:'two.png',wiki:true}],grant={target:'one.png',wiki:true,token:'a'.repeat(64),version:'v1',mediaKind:'image' as const};
 assert.throws(()=>noteMediaFromGrants(runtime,[],references),{code:'invalid-result'});
 assert.throws(()=>noteMediaFromGrants(runtime,[grant],references),{code:'invalid-result'});
 assert.throws(()=>noteMediaFromGrants(runtime,[grant,grant],references),{code:'invalid-result'});
});
test('full-native readiness requires explicit installed capabilities for every production action',()=>{
 const f=fixture();assert.deepEqual(noteRuntimeMissingActions(f.runtime),NOTE_PRODUCTION_PARENT_ACTIONS);
 const ready=fixture({actions:{capabilities:NOTE_PRODUCTION_PARENT_ACTIONS,request:async request=>({...request,result:{ok:true,value:{kind:'acknowledged'}}})}}).runtime;
 assert.deepEqual(noteRuntimeMissingActions(ready),[]);
 assert.ok(noteRuntimeMissingActions({...ready,actions:{...ready.actions,capabilities:['ask-ai']}}).includes('rename-document'));
});
test('parent actions flush unchanged drafts first and never stage later edits during a save',async()=>{
 let finish!:(value:unknown)=>void;let requests=0;
 const f=fixture({documents:{read:async()=>({authority,content:'baseline',revision:'r1'}),write:()=>new Promise(resolve=>{finish=resolve as (value:unknown)=>void;})},actions:{request:async request=>{requests++;return {...request,result:{ok:true,value:{kind:'acknowledged'}}};}}}),owner=new NoteDocumentController(f.runtime);owner.attachView('view');await owner.load();owner.edit('intended');const pending=owner.request('view',{kind:'ask-ai'});owner.edit('later edit');finish({authority,content:'intended',revision:'r2'});
 // The owner's save queue drains the newer draft too; only then can the action
 // detect that its original generation no longer owns the request.
 await new Promise(resolve=>setImmediate(resolve));finish({authority,content:'later edit',revision:'r3'});
 await assert.rejects(()=>pending,{code:'stale-result'});assert.equal(requests,0);assert.equal(owner.session.getSnapshot().content,'later edit');
});
