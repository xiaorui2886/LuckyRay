import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {EditorState,EditorSelection,Transaction} from '@codemirror/state';
import {history,historyField,undo,redo,undoDepth,redoDepth} from '@codemirror/commands';
import {codeFolding,foldEffect,foldedRanges} from '@codemirror/language';
import {search,SearchQuery,setSearchQuery,getSearchQuery} from '@codemirror/search';
import {capturePortableLiveEditor,restorePortableLiveEditor,validateNoteViewPresentation,captureNoteMedia,prepareNoteMediaRefresh,shouldReadNoteMetadata,restoreNoteMedia,restoreNotePresentationLayout,NOTE_PRESENTATION_MAX_BYTES,notePresentationReferences,inspectNotePresentationReferences,type NoteViewPresentationSnapshot} from '../src/features/notes/noteViewPresentation';
import {appendIncomingNotesPane,advanceNotesSavedReadProof,assertNotesNativeBaseline,freezeNotesNativeView,NotesNativeViewRegistry,type NotesNativeViewAdapter} from '../src/features/notes/notesNativeViewRegistry';
import {NotesPaneViews} from '../src/features/notes/notesPaneViews';
import type {NotesPaneState} from '../src/features/notes/notesPaneModel';
import {noteMediaFromGrants,type NoteRuntime} from '../src/features/notes/NoteRuntime';

// Git checkouts may materialize CRLF without changing the stored TSX blob.
// Normalize only the test input; execute each production closure in both forms.
const normalizeSourceLineEndings=(source:string)=>source.replaceAll('\r\n','\n');
const notesPageLF=normalizeSourceLineEndings(readFileSync(new URL('../src/features/notes/NotesPage.tsx',import.meta.url),'utf8'));
const notesPageFixtures=[['LF',notesPageLF],['CRLF',notesPageLF.replaceAll('\n','\r\n')]] as const;

const extensions=[history(),codeFolding(),search()];
const authority={vaultId:'vault-a',sourceId:'backend-generation-a',documentId:'kdoc-a'};
const baseline={authority,revision:'saved-revision',content:'# Heading\nbody\nmore\n'};
function snapshot():NoteViewPresentationSnapshot{return {version:1,...baseline,mode:'live',live:capturePortableLiveEditor(EditorState.create({doc:baseline.content,extensions}),{top:12,left:3}),sourceSelection:{start:0,end:3,direction:'forward'},sourceScroll:{top:2,left:0},contentScroll:{top:5,left:0},media:[]};}
function command(command:typeof undo,state:EditorState){let next=state;assert.equal(command({state,dispatch:transaction=>{next=transaction.state;}}),true);return next;}

test('installed CodeMirror serializers round trip independent undo, redo, backward selections, folds and search',()=>{
  let state=EditorState.create({doc:baseline.content,extensions});
  state=state.update({changes:{from:10,insert:'first '},annotations:Transaction.userEvent.of('input')}).state;
  state=state.update({changes:{from:16,insert:'second '},annotations:Transaction.userEvent.of('input')}).state;
  state=command(undo,state);
  state=state.update({selection:EditorSelection.create([EditorSelection.range(4,1),EditorSelection.cursor(6)],0),effects:[foldEffect.of({from:9,to:state.doc.length-1}),setSearchQuery.of(new SearchQuery({search:'body',replace:'text',regexp:true,caseSensitive:true,literal:true,wholeWord:true}))]}).state;
  const portable=capturePortableLiveEditor(state,{top:87,left:9});
  assert.doesNotThrow(()=>JSON.stringify(portable));
  // A prior local initializer must not override the portable history.
  const empty=EditorState.create({doc:'unrelated',extensions});
  let restored=restorePortableLiveEditor(JSON.parse(JSON.stringify(portable)),state.doc.toString(),[...extensions,historyField.init(()=>empty.field(historyField))]);
  assert.equal(undoDepth(restored),undoDepth(state));assert.equal(redoDepth(restored),redoDepth(state));
  assert.ok(restored.selection.eq(state.selection));assert.ok(getSearchQuery(restored).eq(getSearchQuery(state)));
  const folds:number[]=[];foldedRanges(restored).between(0,restored.doc.length,(from,to)=>folds.push(from,to));assert.deepEqual(folds,[9,state.doc.length-1]);
  restored=command(redo,restored);assert.match(restored.doc.toString(),/first second body/);
  restored=command(undo,restored);restored=command(undo,restored);assert.equal(restored.doc.toString(),baseline.content);
});

test('view snapshots reject changed document/source/revision, invalid selection and oversized payloads without truncation',()=>{
  const value=snapshot();assert.deepEqual(validateNoteViewPresentation(value,baseline),value);
  for(const expected of [{...baseline,revision:'new'}, {...baseline,content:'changed'}, {...baseline,authority:{...authority,sourceId:'other'}}, {...baseline,authority:{...authority,documentId:'other'}}])assert.throws(()=>validateNoteViewPresentation(value,expected));
  assert.throws(()=>validateNoteViewPresentation({...value,sourceSelection:{start:0,end:10000,direction:'forward'}},baseline));
  assert.throws(()=>validateNoteViewPresentation({...value,content:'x'.repeat(NOTE_PRESENTATION_MAX_BYTES+1)},baseline),/limit/);
  assert.throws(()=>validateNoteViewPresentation({...value,live:{...value.live,state:{...value.live!.state,folds:[-1,10]}}},baseline),/folded/);
  assert.throws(()=>validateNoteViewPresentation({...value,live:{...value.live,state:{...value.live!.state,history:{done:[{}],undone:[]}}}},baseline));
  assert.throws(()=>validateNoteViewPresentation({...value,oldToken:'do-not-transfer'},baseline),/unknown/);
  let other=EditorState.create({doc:'different document length',extensions});
  other=other.update({changes:{from:0,insert:'x'}}).state;
  const incompatible=capturePortableLiveEditor(other,{top:0,left:0});
  assert.throws(()=>validateNoteViewPresentation({...value,live:{...incompatible,state:{...incompatible.state,doc:baseline.content}}},baseline));
});

test('media snapshots carry exact note-relative references, never source URLs or old grants',async()=>{
  const content='![clip](media/clip.mp4)',oldUrl='workspace-attachment://localhost/old-token',newUrl='workspace-attachment://localhost/new-token';
  const element={tagName:'VIDEO',currentSrc:oldUrl,currentTime:23,volume:.4,playbackRate:1.5,paused:false,muted:true,getAttribute:()=>oldUrl};
  const root={ownerDocument:{baseURI:'https://local.invalid/'},querySelectorAll:()=>[element]} as unknown as HTMLElement;
  const media={assets:[{id:'old-opaque-grant',name:'clip',previewUrl:oldUrl}],embeds:[{targetName:'md:media/clip.mp4',assetId:'old-opaque-grant',isMissing:0}]};
  const captured=captureNoteMedia(root,media,content);assert.equal(captured[0].reference.target,'media/clip.mp4');
  assert.doesNotMatch(JSON.stringify(captured),/old-token|old-opaque-grant|workspace-attachment/);
  const fresh={...element,currentSrc:newUrl,currentTime:0,paused:true,readyState:2,duration:60,seeking:false,error:null,pause(){this.paused=true;},async play(){this.paused=false;}};
  const target={...root,ownerDocument:{baseURI:'https://local.invalid/'},querySelectorAll:()=>[fresh]} as unknown as HTMLElement;
  const freshMedia={assets:[{id:'new-grant',name:'clip',previewUrl:newUrl}],embeds:[{targetName:'md:media/clip.mp4',assetId:'new-grant',isMissing:0}]};
  let checks=0;await restoreNoteMedia(()=>target,()=>freshMedia,content,captured,()=>{checks++;});
  assert.equal(fresh.currentTime,23);assert.equal(fresh.paused,false);assert.ok(checks>=2);
  fresh.play=async()=>{throw new Error('autoplay denied');};await assert.rejects(restoreNoteMedia(()=>target,()=>freshMedia,content,captured,()=>{}),/autoplay denied/);
  assert.throws(()=>captureNoteMedia(root,{assets:[],embeds:[]},content),/unambiguous/);
  assert.deepEqual(notePresentationReferences('![[C:\\secret.mp4]]\n![x](file:///secret.mp4)'),[]);
  assert.deepEqual(notePresentationReferences('[clip](media/clip.mp4)'),[{target:'media/clip.mp4',wiki:false}]);
});

test('registry has exact view ownership, lease-safe unregistration and an explicit Main receiver',async()=>{
  const registry=new NotesNativeViewRegistry();let generation=1,frozen=false;
  const adapter={isDirty:()=>false,isFrozen:()=>frozen,binding:()=>({viewId:'view-a',vaultId:'vault-a',documentId:'doc-a',resourceId:'a.md',relativePath:'a.md',title:'A',generation})} as NotesNativeViewAdapter;
  const unregister=registry.register('view-a',adapter);assert.equal(registry.get('view-a'),adapter);
  assert.equal(registry.hasFrozenViews(),false);frozen=true;assert.equal(registry.isFrozen('view-a'),true);assert.equal(registry.hasFrozenViews(),true);frozen=false;
  assert.throws(()=>registry.get('other-view'),/Exact/);assert.throws(()=>registry.register('view-a',adapter),/already/);
  const incoming={vaultId:'vault-a',documentId:'doc-a',relativePath:'a.md',title:'A'};
  await assert.rejects(registry.prepareIncoming(incoming),/not mounted/);
  const removeReceiver=registry.registerReceiver(async value=>{assert.deepEqual(value,incoming);return adapter;});
  await assert.rejects(registry.prepareIncoming(incoming),/not admitted frozen/);generation=2;assert.equal(registry.list()[0].generation,2);
  assert.throws(()=>registry.management(),/not mounted/);
  const removeManagement=registry.registerManagement(()=>{const captured=generation;return {binding(){if(captured!==generation)throw new Error('source changed');return {vaultId:'vault-a',generation:captured};},async open(){this.binding();}};});
  const management=registry.management();await management.open('folders');generation++;await assert.rejects(management.open('settings'),/source changed/);removeManagement();
  unregister();assert.throws(()=>registry.get('view-a'));removeReceiver();await assert.rejects(registry.prepareIncoming(incoming));
});

test('Main A and incoming child A keep independent view IDs and editor history/search state',()=>{
  const views=new NotesPaneViews();
  const main:NotesPaneState={layout:{kind:'pane',id:'main'},tabs:{main:[{id:'A.md',kind:'note'}]},activeTabs:{main:'A.md'},activePaneId:'main'};
  const originalId=views.list(main.layout,main.tabs)[0].id;
  let original=EditorState.create({doc:baseline.content,extensions});
  original=original.update({changes:{from:0,insert:'Main edit\n'}}).state;
  original=original.update({effects:setSearchQuery.of(new SearchQuery({search:'Main edit'})),selection:EditorSelection.range(5,1)}).state;
  const before=capturePortableLiveEditor(original,{top:40,left:0});
  const next=appendIncomingNotesPane(main,{id:'A.md',kind:'note'},'incoming','incoming-split');
  const incomingId=views.adopt('incoming','A.md','backend-target-view');
  const entries=views.list(next.layout,next.tabs);
  assert.equal(entries.length,2);assert.equal(views.get('main','A.md'),originalId);assert.notEqual(incomingId,originalId);
  assert.strictEqual(next.tabs.main,main.tabs.main);assert.deepEqual(main.tabs,{main:[{id:'A.md',kind:'note'}]});
  const sessions=new Map([[originalId,original],[incomingId,EditorState.create({doc:original.doc.toString(),extensions})]]);
  const child={...before,search:{...before.search,search:'Child search'},state:{...before.state,selection:EditorSelection.create([EditorSelection.range(9,2)]).toJSON()}};
  sessions.set(incomingId,restorePortableLiveEditor(child,original.doc.toString(),extensions));
  assert.strictEqual(sessions.get(originalId),original);assert.deepEqual(capturePortableLiveEditor(sessions.get(originalId)!,{top:40,left:0}),before);
  assert.equal(getSearchQuery(sessions.get(incomingId)!).search,'Child search');
  assert.notDeepEqual(sessions.get(incomingId)!.selection.toJSON(),sessions.get(originalId)!.selection.toJSON());
  assert.throws(()=>views.adopt('another','A.md',incomingId),/already owned/);
  assert.throws(()=>appendIncomingNotesPane(main,{id:'A.md',kind:'note'},'main','another-split'),/new exact pane/);
});

function scrollFixture(ignore:'top'|'left'|'direction'|null=null){
  let top=0,left=0;
  const element={scrollHeight:1200,clientHeight:100,scrollWidth:600,clientWidth:100,
    get scrollTop(){return top;},set scrollTop(value:number){if(ignore!=='top')top=Math.min(Math.max(0,value),Math.max(0,this.scrollHeight-this.clientHeight));},
    get scrollLeft(){return left;},set scrollLeft(value:number){if(ignore!=='left')left=Math.min(Math.max(0,value),Math.max(0,this.scrollWidth-this.clientWidth));},
    value:baseline.content,selectionStart:0,selectionEnd:0,selectionDirection:'none',querySelector(){return null;},
    setSelectionRange(start:number,end:number,direction:string){this.selectionStart=start;this.selectionEnd=end;if(ignore!=='direction')this.selectionDirection=direction;},
  };
  return element;
}
test('ignored source or content scroll setters and ignored selection direction reject restore ACK',async()=>{
  const value={...snapshot(),mode:'source' as const,sourceSelection:{start:2,end:6,direction:'backward' as const},sourceScroll:{top:220,left:25},contentScroll:{top:30,left:15}};
  for(const ignored of ['top','left','direction'] as const){
    const source=scrollFixture(ignored),content=scrollFixture();
    await assert.rejects(restoreNotePresentationLayout(value,{source:()=>source as unknown as HTMLTextAreaElement,content:()=>content as unknown as HTMLElement,liveScroll:()=>null},()=>{},async()=>{}),/not acknowledged|selection changed/);
  }
  const source=scrollFixture(),content=scrollFixture('top');
  await assert.rejects(restoreNotePresentationLayout(value,{source:()=>source as unknown as HTMLTextAreaElement,content:()=>content as unknown as HTMLElement,liveScroll:()=>null},()=>{},async()=>{}),/not acknowledged/);
});
test('media-delayed geometry is reapplied and verified before ACK, with final bounds normalized',async()=>{
  const value={...snapshot(),mode:'source' as const,sourceSelection:{start:2,end:6,direction:'backward' as const},sourceScroll:{top:220,left:25},contentScroll:{top:200,left:15}};
  const source=scrollFixture(),content=scrollFixture();source.scrollHeight=140;source.scrollWidth=100;content.scrollHeight=160;content.scrollWidth=100;
  let frames=0,checks=0;
  await restoreNotePresentationLayout(value,{source:()=>source as unknown as HTMLTextAreaElement,content:()=>content as unknown as HTMLElement,liveScroll:()=>null},()=>{checks++;},async()=>{
    frames++;
    // Metadata-driven media geometry can arrive after the first scroll apply.
    if(frames===1){source.scrollHeight=800;content.scrollHeight=700;}
    if(frames===2){source.scrollWidth=200;content.scrollWidth=200;}
  });
  assert.ok(frames>=6);assert.ok(checks>=frames*2);assert.equal(source.scrollTop,220);assert.equal(source.scrollLeft,25);assert.equal(content.scrollTop,200);assert.equal(content.scrollLeft,15);assert.equal(source.selectionDirection,'backward');
  source.scrollHeight=150;source.scrollWidth=110;content.scrollHeight=170;content.scrollWidth=108;
  await restoreNotePresentationLayout(value,{source:()=>source as unknown as HTMLTextAreaElement,content:()=>content as unknown as HTMLElement,liveScroll:()=>null},()=>{},async()=>{});
  assert.equal(source.scrollTop,50);assert.equal(source.scrollLeft,10);assert.equal(content.scrollTop,70);assert.equal(content.scrollLeft,8);
});
test('pending media play cannot ACK early and its later layout is included in final scroll readback',async()=>{
  const content='![clip](media/clip.mp4)',url='workspace-attachment://localhost/new-target-grant';
  const scroll=scrollFixture();scroll.value=content;scroll.scrollHeight=140;
  let resume:()=>void=()=>{},acknowledged=false;
  const playing=new Promise<void>(resolve=>{resume=resolve;});
  const video={tagName:'VIDEO',currentSrc:url,currentTime:0,volume:1,playbackRate:1,paused:true,muted:false,readyState:2,duration:60,seeking:false,error:null,pause(){this.paused=true;},async play(){await playing;this.paused=false;scroll.scrollHeight=1000;}};
  const root=Object.assign(scroll,{ownerDocument:{baseURI:'https://local.invalid/'},querySelectorAll:()=>[video]}) as unknown as HTMLElement;
  const media={assets:[{id:'new-grant',name:'clip',previewUrl:url}],embeds:[{targetName:'md:media/clip.mp4',assetId:'new-grant',isMissing:0}]};
  const value={...snapshot(),content,mode:'preview' as const,contentScroll:{top:220,left:25},media:[{reference:{target:'media/clip.mp4',wiki:false},occurrence:0,kind:'video' as const,currentTime:5,volume:.5,playbackRate:1,paused:false,muted:false}]};
  const restore=(async()=>{await restoreNoteMedia(()=>root,()=>media,content,value.media,()=>{});await restoreNotePresentationLayout(value,{source:()=>null,content:()=>root,liveScroll:()=>null},()=>{},async()=>{});acknowledged=true;})();
  await Promise.resolve();assert.equal(acknowledged,false);assert.equal(scroll.scrollHeight,140);
  resume();await restore;assert.equal(acknowledged,true);assert.equal(scroll.scrollTop,220);assert.equal(scroll.scrollLeft,25);
});
test('source IME vetoes freeze before inert, lock, snapshot or parking can change',()=>{
  for(const composing of [{live:false,source:true},{live:true,source:false}]){
    const state={inert:false,locked:false,parked:false,snapshot:'retained'};
    assert.throws(()=>freezeNotesNativeView(composing,()=>{state.inert=true;state.locked=true;state.parked=true;state.snapshot='discarded';}),/Finish composition/);
    assert.deepEqual(state,{inert:false,locked:false,parked:false,snapshot:'retained'});
  }
  let applied=0;freezeNotesNativeView({live:false,source:false},()=>{applied++;});assert.equal(applied,1);
});
test('incoming registry admission freezes before exposure and reserves exact IDs during asynchronous mount',async()=>{
  const registry=new NotesNativeViewRegistry(),incoming={viewId:'backend-incoming',vaultId:'vault-a',documentId:'doc-a',relativePath:'a.md',title:'A'};
  let frozen=false,released=false;
  const adapter={binding:()=>({...incoming,resourceId:'a.md',generation:1}),isDirty:()=>false,isFrozen:()=>frozen,freeze(){assert.throws(()=>registry.get(incoming.viewId),/not mounted/);frozen=true;},async cancelIncoming(){assert.equal(registry.isIncoming(incoming.viewId),true);released=true;unregister();}} as NotesNativeViewAdapter;
  let unregister=()=>{};
  registry.registerReceiver(async value=>{
    assert.equal(registry.isIncoming(value.viewId!),true);assert.equal(registry.hasFrozenViews(),true);
    await Promise.resolve();unregister=registry.register(value.viewId!,adapter);return adapter;
  });
  assert.equal(await registry.prepareIncoming(incoming),adapter);assert.equal(frozen,true);
  await assert.rejects(registry.prepareIncoming(incoming),/reserved/);
  await adapter.cancelIncoming();assert.equal(released,true);assert.equal(registry.isIncoming(incoming.viewId),false);assert.equal(registry.hasFrozenViews(),false);
});
test('dirty subscriptions emit actual transitions and retain captured document ownership after tab unmount',()=>{
  const registry=new NotesNativeViewRegistry();let dirty=false;
  const adapter={binding:()=>({viewId:'dirty-view'}),isFrozen:()=>false,isDirty:()=>dirty} as NotesNativeViewAdapter;
  const unregister=registry.register('dirty-view',adapter),values:boolean[]=[];
  const unsubscribe=registry.subscribeDirty('dirty-view',value=>values.push(value));
  dirty=true;registry.notifyDirty();registry.notifyDirty();assert.deepEqual(values,[true]);
  unregister();dirty=false;registry.notifyDirty();assert.deepEqual(values,[true,false]);
  unsubscribe();dirty=true;registry.notifyDirty();assert.deepEqual(values,[true,false]);
});
test('one-character autosave and a fresh token preserve a 30-second video for unchanged attachment bytes',async()=>{
  const reference={target:'media/clip.mp4',wiki:false},beforeContent='Caption\n![clip](media/clip.mp4)',afterContent='Caption!\n![clip](media/clip.mp4)';
  const runtime={kind:'scoped',authority,attachments:{mediaUrl:(token:string)=>`workspace-attachment://localhost/${token}`}} as NoteRuntime;
  const issue=(token:string,version='same-file-bytes')=>noteMediaFromGrants(runtime,[{...reference,token,version,mediaKind:'video'}],[reference]);
  const oldToken='a'.repeat(64),newToken='b'.repeat(64),thirdToken='c'.repeat(64),oldMedia=issue(oldToken),newMedia=issue(newToken);
  assert.equal(oldMedia.assets[0].id,newMedia.assets[0].id);assert.notEqual(oldMedia.assets[0].previewUrl,newMedia.assets[0].previewUrl);
  const video=(url:string,time:number,paused:boolean)=>({tagName:'VIDEO',currentSrc:url,currentTime:time,volume:.3,playbackRate:1.25,paused,muted:false,readyState:2,duration:100,seeking:false,error:null,pause(){this.paused=true;},async play(){this.paused=false;}});
  const original=video(oldMedia.assets[0].previewUrl!,30,false),replacement=video(newMedia.assets[0].previewUrl!,0,true);
  const root=(element:ReturnType<typeof video>)=>({ownerDocument:{baseURI:'https://local.invalid/'},querySelectorAll:()=>[element]}) as unknown as HTMLElement;
  assert.equal(notePresentationReferences(beforeContent)[0].target,notePresentationReferences(afterContent)[0].target);
  const plan=prepareNoteMediaRefresh(root(original),oldMedia,newMedia,afterContent);
  assert.equal(original.paused,true);assert.equal(plan.playback[0].state.currentTime,30);assert.equal(plan.playback[0].state.paused,false);
  assert.doesNotMatch(JSON.stringify(plan),new RegExp(`${oldToken}|${newToken}|workspace-attachment`));
  let acknowledged=false;replacement.play=async()=>{throw new Error('play denied');};
  await assert.rejects((async()=>{await restoreNoteMedia(()=>root(replacement),()=>newMedia,afterContent,plan.playback.map(item=>item.state),()=>{});acknowledged=true;})(),/play denied/);
  assert.equal(acknowledged,false);
  const thirdMedia=issue(thirdToken),retry=prepareNoteMediaRefresh(root(replacement),newMedia,thirdMedia,afterContent,plan),third=video(thirdMedia.assets[0].previewUrl!,0,true);
  await restoreNoteMedia(()=>root(third),()=>thirdMedia,afterContent,retry.playback.map(item=>item.state),()=>{});acknowledged=true;
  assert.equal(acknowledged,true);assert.equal(third.currentTime,30);assert.equal(third.volume,.3);assert.equal(third.playbackRate,1.25);assert.equal(third.muted,false);assert.equal(third.paused,false);
  assert.equal(third.currentSrc,`workspace-attachment://localhost/${thirdToken}`);
  assert.deepEqual(prepareNoteMediaRefresh(root(third),thirdMedia,issue('d'.repeat(64),'changed-file-bytes'),afterContent,retry),{playback:[]});
});
test('metadata startup failure retries on recovered capability lease but successful renewals do not reread',()=>{
  const input={revision:'r1',dirty:false,actionsReady:false,readyRuntimeMatches:false};
  assert.equal(shouldReadNoteMetadata(input),false);
  assert.equal(shouldReadNoteMetadata({...input,actionsReady:true}),true);
  const ready={...input,actionsReady:true,readyRevision:'r1',readyRuntimeMatches:true};
  assert.equal(shouldReadNoteMetadata(ready),false);assert.equal(shouldReadNoteMetadata({...ready,revision:'r2'}),true);
  assert.equal(shouldReadNoteMetadata({...ready,readyRuntimeMatches:false}),true);assert.equal(shouldReadNoteMetadata({...ready,dirty:true,revision:'r2'}),false);
  assert.equal(shouldReadNoteMetadata({...ready,invalidationRevision:2,readyInvalidationRevision:1}),true);
  assert.equal(shouldReadNoteMetadata({...ready,invalidationRevision:2,readyInvalidationRevision:2}),false);
  assert.equal(shouldReadNoteMetadata({...ready,invalidationRevision:2,readyInvalidationRevision:1,actionsReady:false}),false);
});
test('code examples and frontmatter never request wiki media and real destinations are trimmed',()=>{
  const content='---\nexample: ![[ frontmatter.png ]]\n---\n`![[ inline.png ]]`\n```md\n![[ fenced.png ]]\n```\n    ![[ indented.png ]]\n\n![[ B |label]]\n![image](real.png)';
  assert.deepEqual(notePresentationReferences(content),[{target:'B',wiki:true},{target:'real.png',wiki:false}]);
});
test('matching metadata and bytes never authorize a newly minted backend source over the captured actual read proof',()=>{
  const workspaceSourceId=`note-source-v1:${'a'.repeat(64)}`;
  const vault={id:authority.vaultId,rootPath:'/same/path',name:'Same',mode:'real-vault',createdAt:'same-created-at',lastOpenedAt:'same-time',schemaVersion:1};
  const binding={viewId:'view-a',vaultId:vault.id,vault,workspaceSourceId,documentId:authority.documentId,resourceId:'A.md',relativePath:'A.md',title:'A',generation:1};
  const saved={revision:baseline.revision,content:baseline.content},expected={...baseline,authority:{...authority,sourceId:workspaceSourceId}};
  assert.doesNotThrow(()=>assertNotesNativeBaseline(binding,saved,saved.content,expected));
  assert.throws(()=>assertNotesNativeBaseline(binding,saved,saved.content,{...expected,authority:{...expected.authority,sourceId:`note-source-v1:${'b'.repeat(64)}`}}),/actual read source/);
  assert.throws(()=>assertNotesNativeBaseline({...binding,workspaceSourceId:undefined},saved,saved.content,expected),/actual read source/);
});
test('registry unregister events identify exact adapter cleanup and stale cleanup cannot retire a replacement',()=>{
  const registry=new NotesNativeViewRegistry(),events:NotesNativeViewAdapter[]=[];let revisions=0,valid=true;
  const first={binding(){if(!valid)throw new Error('source changed');return {viewId:'same'};},isDirty:()=>false,isFrozen:()=>false} as NotesNativeViewAdapter;
  const second={...first,binding:()=>({viewId:'same'})} as NotesNativeViewAdapter;
  const stopViews=registry.subscribeViews(()=>{revisions++;}),stopUnregister=registry.onUnregister((viewId,adapter)=>{assert.equal(viewId,'same');events.push(adapter);});
  const releaseFirst=registry.register('same',first);valid=false;assert.deepEqual(registry.list(),[]);assert.equal(events.length,0);
  releaseFirst();const releaseSecond=registry.register('same',second);releaseFirst();
  assert.deepEqual(events,[first]);assert.equal(registry.get('same'),second);assert.equal(revisions,3);
  releaseSecond();assert.deepEqual(events,[first,second]);assert.equal(revisions,4);stopViews();stopUnregister();
});
test('unsupported absolute and external embeds cannot disappear into an empty successful presentation',()=>{
  for(const content of ['![x](file:///outside/movie.mp4)','![x](/outside/image.png)','![x](C:/outside/image.png)','![[C:\\outside\\image.png]]','![x](https://external.invalid/image.png)']){
    const inspection=inspectNotePresentationReferences(content);
    assert.equal(inspection.references.length,0);assert.equal(inspection.unsupported.length,1,content);
    const expected={...baseline,content},value={...snapshot(),...expected,mode:'preview' as const,live:null,sourceSelection:{start:0,end:0,direction:'none' as const}};
    assert.throws(()=>validateNoteViewPresentation(value,expected),/unsupported attachment reference/);
    assert.throws(()=>captureNoteMedia({querySelectorAll:()=>[]} as unknown as HTMLElement,{assets:[],embeds:[]},content),/unsupported attachment reference/);
  }
  assert.deepEqual(inspectNotePresentationReferences('[external](https://external.invalid/movie.mp4)\n`![x](file:///outside.png)`'),{references:[],unsupported:[]});
});
test('coverage generation remains incomplete across read and committed-view mount gaps',async()=>{
  const registry=new NotesNativeViewRegistry();let committed=false;
  const unregisterCoverage=registry.registerCoverage(()=>committed),before=registry.coverageGeneration();
  const endRead=registry.beginRead();assert.equal(registry.coverageReady(),false);assert.ok(registry.coverageGeneration()>before);
  const adapter={binding:()=>({viewId:'loaded'}),isDirty:()=>false,isFrozen:()=>false} as NotesNativeViewAdapter;
  const unmount=registry.register('loaded',adapter);endRead();assert.equal(registry.coverageReady(),false);
  committed=true;registry.notifyViews();const readyGeneration=registry.coverageGeneration();assert.equal(registry.coverageReady(),true);
  const secondRead=registry.beginRead();assert.equal(registry.coverageReady(),false);assert.notEqual(registry.coverageGeneration(),readyGeneration);
  secondRead();assert.equal(registry.coverageReady(),true);unmount();unregisterCoverage();assert.equal(registry.coverageReady(),true);
});
for(const [lineEnding,rawPage] of notesPageFixtures) test(`actual NotesPage coverage closure stays ready after an exact CAS save clears the draft [${lineEnding}]`,()=>{
  const page=normalizeSourceLineEndings(rawPage),start=page.indexOf('  notesCoverageRef.current=()=>{');
  assert.ok(start>=0);const bodyStart=start+'  notesCoverageRef.current=()=>{'.length,bodyEnd=page.indexOf('\n  };\n  useEffect(()=>notesNativeViews.registerCoverage',bodyStart);
  assert.ok(bodyEnd>bodyStart);
  const source={vaultId:'vault-a'},sourceId=`note-source-v1:${'a'.repeat(64)}`,proof={generation:1,source,workspaceSourceId:sourceId,revision:'r1',content:'old'};
  const proofs=new Map([['A',proof]]),saved=new Map([['A','old']]),latest=new Map([['A','new']]),dirty=new Set(['A']);
  const refs=new Map([['view-a',{noteId:'A',committedPaneId:'notes-pane-1',committedContent:'new',committedMode:'live',mode:'live',provenance:{source,generation:1,workspaceSourceId:sourceId},live:{current:{getValue:()=> 'new'}}}]]);
  const inputs={readActiveKnowledgeWriteSource:()=>source,vaultSessionRef:{current:{latest:()=>1,isCurrent:()=>true}},vaultBootstrapReady:true,currentVault:{id:'vault-a'},selectedNoteIdRef:{current:'A'},notesViewRefsRef:{current:refs},notesPaneLayout:null,activeNotesSplitPaneRef:{current:'notes-pane-1'},realVaultSavedContentRef:{current:saved},realVaultReadProofRef:{current:proofs},notesNativeViews:{get:()=>({binding:()=>({workspaceSourceId:sourceId})})},realVaultUserDirtyRef:{current:dirty},realVaultSaveInFlightRef:{current:new Set()},realVaultLatestContentRef:{current:latest}};
  const coverage=new Function(...Object.keys(inputs),`return ()=>{${page.slice(bodyStart,bodyEnd)}}`)(...Object.values(inputs)) as ()=>boolean;
  assert.equal(coverage(),true);
  const committed=advanceNotesSavedReadProof(proofs.get('A'),{content:'new',revision:'r2'},{source,generation:1})!;
  proofs.set('A',committed);saved.set('A','new');dirty.delete('A');
  assert.equal(committed.workspaceSourceId,sourceId);assert.equal(coverage(),true);
  assert.throws(()=>advanceNotesSavedReadProof(committed,{content:'foreign',revision:'r3'},{source:{vaultId:'vault-a'},generation:1}),/changed source/);
  assert.equal(proofs.get('A')?.content,'new');
});
test('timed-out incoming preparation retains its reservation and late registration is frozen until exact cleanup',async()=>{
  const registry=new NotesNativeViewRegistry(),incoming={viewId:'late',vaultId:'v',documentId:'d',relativePath:'A.md',title:'A'};
  let paneRetained=false,frozen=false,unregister=()=>{};
  registry.registerReceiver(async()=>{paneRetained=true;registry.stageIncoming('late',async()=>{paneRetained=false;registry.finishIncoming('late');});throw new Error('The new independent Main note view did not mount');});
  await assert.rejects(registry.prepareIncoming(incoming),/did not mount/);
  assert.equal(registry.isIncoming('late'),true);assert.equal(paneRetained,true);assert.equal(registry.hasFrozenViews(),true);
  const adapter={binding(){if(!paneRetained)throw new Error('unmounted');return {viewId:'late'};},isFrozen:()=>frozen,isDirty:()=>false,freeze(){frozen=true;},async cancelIncoming(){paneRetained=false;unregister();}} as NotesNativeViewAdapter;
  unregister=registry.register('late',adapter);assert.equal(frozen,true);
  await registry.cancelIncoming('late');assert.equal(paneRetained,false);assert.equal(registry.isIncoming('late'),false);
  assert.throws(()=>registry.register('late',adapter),/unmounted/);
});
test('exact cancellation can remove an inserted pane whose adapter never mounted',async()=>{
  const registry=new NotesNativeViewRegistry();let paneRetained=false;
  registry.registerReceiver(async incoming=>{paneRetained=true;registry.stageIncoming(incoming.viewId!,async()=>{paneRetained=false;registry.finishIncoming(incoming.viewId!);});throw new Error('delayed mount');});
  await assert.rejects(registry.prepareIncoming({viewId:'never-mounted',vaultId:'v',documentId:'d',relativePath:'A.md',title:'A'}));
  await registry.cancelIncoming('never-mounted');assert.equal(paneRetained,false);assert.equal(registry.hasFrozenViews(),false);
});
test('cancelled receipt cleanup is bound to the exact incoming reservation incarnation',async()=>{
  const registry=new NotesNativeViewRegistry();let cancelled=0;
  registry.markIncoming('reused');const first=registry.incomingToken('reused');assert.equal(typeof first,'symbol');
  registry.finishIncoming('reused');assert.equal(registry.incomingToken('reused'),undefined);
  registry.markIncoming('reused');const second=registry.incomingToken('reused');assert.notEqual(first,second);
  registry.stageIncoming('reused',async()=>{cancelled++;registry.finishIncoming('reused');});
  await registry.cancelIncoming('reused',first);assert.equal(cancelled,0);assert.equal(registry.incomingToken('reused'),second);
  await registry.cancelIncoming('reused',second);assert.equal(cancelled,1);assert.equal(registry.incomingToken('reused'),undefined);
  let ordinaryCancelled=0;const ordinary={binding:()=>({viewId:'reused'}),cancelIncoming:async()=>{ordinaryCancelled++;}} as NotesNativeViewAdapter;
  const unregister=registry.register('reused',ordinary);await registry.cancelIncoming('reused',first);assert.equal(ordinaryCancelled,0);assert.equal(registry.get('reused'),ordinary);unregister();
});
test('a rejected duplicate preparation never clears the earlier admission reservation',async()=>{
  const registry=new NotesNativeViewRegistry(),incoming={viewId:'pending',vaultId:'v',documentId:'d',relativePath:'A.md',title:'A'};
  let rejectRead!:(reason:Error)=>void;
  registry.registerReceiver(()=>new Promise((_resolve,reject)=>{rejectRead=reject;}));
  const first=registry.prepareIncoming(incoming),token=registry.incomingToken('pending');
  await assert.rejects(registry.prepareIncoming(incoming),/already reserved/);
  assert.equal(registry.incomingToken('pending'),token);assert.equal(registry.hasFrozenViews(),true);
  rejectRead(new Error('read failed'));await assert.rejects(first,/read failed/);assert.equal(registry.incomingToken('pending'),undefined);
});
for(const [lineEnding,rawPage] of notesPageFixtures) test(`actual retained Notes global save handler ignores hidden or frozen page shortcuts [${lineEnding}]`,()=>{
  const page=normalizeSourceLineEndings(rawPage),marker='    const onKeyDown = (event: KeyboardEvent) => {\n      if(!pageVisibleRef.current||notesNativeViews.hasFrozenViews())return;';
  const start=page.indexOf(marker);assert.ok(start>=0);
  const bodyStart=page.indexOf('{',start)+1,bodyEnd=page.indexOf('\n    };\n    const onBeforeUnload',bodyStart);
  assert.ok(bodyEnd>bodyStart);
  const visible={current:false},drafts=new Set<string>();let frozen=false,prevented=0,saves=0,resolved=0;
  const inputs={pageVisibleRef:visible,notesNativeViews:{hasFrozenViews:()=>frozen},resolveScopedShortcut:()=>{resolved++;return 'knowledgeSave';},selectedNoteIdRef:{current:'real-vault:A.md'},isRealVaultNoteId:()=>true,readActiveEditorValue:()=> 'draft',realVaultUserDirtyRef:{current:drafts},savePatch:()=>{saves++;},editTitle:'A',flushPendingSave:()=>{saves++;},setStatus:()=>{},t:(text:string)=>text};
  const handler=new Function(...Object.keys(inputs),`return event=>{${page.slice(bodyStart,bodyEnd)}}`)(...Object.values(inputs)) as (event:{preventDefault:()=>void})=>void;
  const event={preventDefault:()=>{prevented++;}};
  handler(event);visible.current=true;frozen=true;handler(event);
  assert.equal(prevented,0);assert.equal(saves,0);assert.equal(resolved,0);assert.equal(drafts.size,0);
  frozen=false;handler(event);assert.equal(prevented,1);assert.equal(saves,1);assert.equal(drafts.has('real-vault:A.md'),true);
});

for(const [lineEnding,rawPage] of notesPageFixtures) test(`actual staged NotesPage cleanup with the real registry preserves a replacement reservation across frames [${lineEnding}]`,async()=>{
  const page=normalizeSourceLineEndings(rawPage);
  const marker='  cancelIncomingPaneRef.current=async(viewId,paneId,noteId,expectedToken)=>{',start=page.indexOf(marker)+marker.length,end=page.indexOf('\n  };\n  const receiveNativeNoteBusyRef',start);
  assert.ok(start>=marker.length&&end>start);
  const registry=new NotesNativeViewRegistry(),ids=new Set(['view']),closed:symbol[]=[];
  registry.markIncoming('view');const original=registry.incomingToken('view')!;let replacement:symbol|undefined;
  const inputs={notesNativeViews:registry,notesPaneViewsRef:{current:{ids:()=>ids}},realVaultUserDirtyRef:{current:new Set()},realVaultSaveInFlightRef:{current:new Set()},notesViewRefsRef:{current:new Map()},closeNotesSplitDocument:()=>{closed.push(registry.incomingToken('view')!);ids.delete('view');},nextNotePresentationFrame:async()=>{if(!replacement){registry.finishIncoming('view',original);registry.markIncoming('view');replacement=registry.incomingToken('view');ids.add('view');}}};
  const cancel=new Function(...Object.keys(inputs),`return async(viewId,paneId,noteId,expectedToken)=>{${page.slice(start,end)}}`)(...Object.values(inputs));
  registry.stageIncoming('view',()=>cancel('view','pane','note',original));
  await registry.cancelIncoming('view',original);
  assert.deepEqual(closed,[original]);assert.equal(registry.incomingToken('view'),replacement);assert.equal(ids.has('view'),true);
});
for(const [lineEnding,rawPage] of notesPageFixtures) test(`actual mounted NotesPage cleanup with the real registry acknowledges only its own reservation removal [${lineEnding}]`,async()=>{
  const page=normalizeSourceLineEndings(rawPage);
  const marker='      async cancelIncoming(){',start=page.indexOf(marker)+marker.length,end=page.indexOf('\n      },\n      async activate()',start);
  assert.ok(start>=marker.length&&end>start);
  const registry=new NotesNativeViewRegistry();registry.markIncoming('view');const original=registry.incomingToken('view')!;
  let unmount=()=>{},replacement:symbol|undefined;
  const inputs={notesNativeViews:registry,props:{viewId:'view'},binding:()=>{},locked:{current:true},latest:{current:{hasUnsavedInput:()=>false,viewRefs:{live:{current:null},sourceComposing:false},release:()=>unmount()}},freezeNotesNativeView:(_input:unknown,release:()=>void)=>release(),nextNotePresentationFrame:async()=>{registry.markIncoming('view');replacement=registry.incomingToken('view');}};
  const cancel=new Function(...Object.keys(inputs),`return async()=>{${page.slice(start,end)}}`)(...Object.values(inputs));
  const adapter={binding:()=>({viewId:'view'}),freeze:()=>{},cancelIncoming:cancel} as NotesNativeViewAdapter;unmount=registry.register('view',adapter);
  await registry.cancelIncoming('view',original);assert.notEqual(original,replacement);assert.equal(registry.incomingToken('view'),replacement);
});
