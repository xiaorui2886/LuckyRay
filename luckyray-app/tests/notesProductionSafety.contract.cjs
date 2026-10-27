const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),ts=require('typescript');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/features/notes/NotesPage.tsx'),'utf8');
const ast=ts.createSourceFile('NotesPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(found);return found;}
function runExpression(node,context,sourceFile=ast){const js=ts.transpileModule(`(${node.getText(sourceFile)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function('context',`with(context){return ${js}}`)(context);}
const preflight=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='writeRealVaultDocumentIfAllowed').initializer.arguments[0];
const checkpoint=find(node=>ts.isPropertyAssignment(node)&&node.name.getText(ast)==='checkpoint').initializer;
const flush=find(node=>ts.isCallExpression(node)&&node.expression.getText(ast)==='registerWorkspaceFlush').arguments[0];
const pendingSave=find(node=>ts.isCallExpression(node)&&node.expression.getText(ast)==='registerWorkspaceFlush').arguments[1];
test('quit status reads existing dirty/in-flight owners, including inactive notes, not the current route',()=>{
  const context={realVaultUserDirtyRef:{current:new Set()},realVaultSaveInFlightRef:{current:new Set()}};
  const pending=runExpression(pendingSave,context);
  assert.equal(pending(),false);
  context.realVaultUserDirtyRef.current.add('inactive-note');assert.equal(pending(),true);
  context.realVaultUserDirtyRef.current.clear();context.realVaultSaveInFlightRef.current.add('inactive-note');assert.equal(pending(),true);
  context.realVaultSaveInFlightRef.current.clear();assert.equal(pending(),false);
});
function preflightContext(){const authority={vaultId:'vault'},latest={id:'A.md',relativePath:'A.md',contentText:'baseline',revision:'revision-1'};let calls=[];const context={readActiveKnowledgeWriteSource:()=>authority,realVaultNoteId:id=>id,realVaultSavedContentRef:{current:new Map([['A.md','baseline']])},realVaultUserDirtyRef:{current:new Set()},selectedNoteIdRef:{current:'A.md'},realVaultKeepEditingAfterConflictRef:{current:new Set()},setRealVaultExternalConflict:value=>context.conflict=value,setStatus:value=>context.status=value,t:key=>key,console,realVaultDocumentSource:{openDocument:async()=>latest,saveDocument:async(...args)=>{calls.push(args);return {...latest,contentText:args[1]};}}};return {context,latest,calls};}
test('production preflight passes the exact checked revision to CAS without adopting a later cache baseline',async()=>{const {context,latest,calls}=preflightContext();const write=runExpression(preflight,context);await write('explicit-save',{id:'A.md'},'draft');assert.equal(calls.length,1);assert.equal(calls[0][0],latest);assert.equal(calls[0][1],'draft');});
test('production CAS conflict preserves dirty authority, reports conflict and never retries',async()=>{const {context}=preflightContext();let writes=0;context.realVaultDocumentSource.saveDocument=async()=>{writes++;throw Object.assign(Error('peer changed'),{code:'knowledge-revision-conflict'});};const write=runExpression(preflight,context);assert.equal(await write('user-edit-autosave',{id:'A.md'},'draft'),null);assert.equal(writes,1);assert.equal(context.realVaultUserDirtyRef.current.has('A.md'),true);assert.equal(context.conflict.noteId,'A.md');});
test('production quit flusher saves inactive document owners and refuses unresolved dirty state',async()=>{const authority={},saved=[];const context={notesNativeViews:{hasFrozenViews:()=>false},sourceComposingRef:{current:false},workspaceCompositionActive:()=>false,readActiveKnowledgeWriteSource:()=>authority,commitCurrentEditorDraft:()=>{},flushPendingSaveRef:{current:()=>{}},realVaultSaveCompletionRef:{current:new Map()},realVaultUserDirtyRef:{current:new Set(['A','B'])},realVaultLatestContentRef:{current:new Map([['A','draft A'],['B','draft B']])},realVaultSaveInFlightRef:{current:new Set()},savePatch:async(patch,id)=>{saved.push([id,patch.contentText]);context.realVaultUserDirtyRef.current.delete(id);}};assert.equal(await runExpression(flush,context)(),true);assert.deepEqual(saved,[['A','draft A'],['B','draft B']]);context.realVaultUserDirtyRef.current.add('A');context.savePatch=async()=>{};assert.equal(await runExpression(flush,context)(),false);});
test('exact production rollback restores inactive view modes and invalidates every pending read',async()=>{let owners='original';const refs=new Map([['view-A',{mode:'live'}],['view-B',{mode:'source'}]]);const values={};const context={restoreMutationStarted:false,restoreOwnedGeneration:-1,vaultSessionRef:{current:{latest:()=>1,isCurrent:value=>value===1}},commitCurrentEditorDraft:()=>'draft',captureNotesEditorSessions:()=>{},notesPaneEditorSessionsRef:{current:new Map()},notesPaneViewsRef:{current:{checkpoint:()=>{const old=owners;return()=>owners=old;}}},notesViewRefsRef:{current:refs},notesPaneScrollPositionsRef:{current:new Map([['root:A',23]])},state:{tabs:{root:[{id:'A'}]},activePaneId:'root',activeTabs:{root:'A'}},getNotesSplitDocument:()=>({title:'A',contentText:'draft',loaded:true}),selectedNoteId:'A',selectedNoteRef:{current:{id:'A'}},selectedNoteIdRef:{current:'A'},cancelNotesTabPointerDrag:()=>{},noteLoadRequestRef:{current:5},notesPaneLoadRequestRef:{current:new Map([['root',2],['other',3]])},notesPaneLayout:{kind:'pane',id:'root'},notesPaneTabs:{root:[{id:'A'}]},notesPaneActiveTabs:{root:'A'},notesPaneModes:{root:'live'},notesPaneDocuments:{},notesPaneAiStates:{},openTabs:[{id:'A'}],openTabsRef:{current:[]},activeNotesSplitPane:'root',editorMode:'live',panelOpen:true,visibleNotesIndexWidth:320,syncActiveNotesPaneDocument:()=>{}};for(const key of ['NotesPaneLayout','NotesPaneTabs','NotesPaneActiveTabs','NotesPaneModes','NotesPaneDocuments','NotesPaneAiStates','OpenTabs','ActiveNotesSplitPane','EditorMode','PanelOpen','NotesIndexWidth','NotesPaneActivationVersion'])context['set'+key]=value=>values[key]=value;context.selectedNoteRef.current={id:'prior'};assert.throws(()=>runExpression(checkpoint,context)(),/仍在加载/);context.selectedNoteRef.current={id:'A'};const restore=runExpression(checkpoint,context)();refs.get('view-A').mode='preview';refs.get('view-B').mode='preview';owners='preset';context.restoreMutationStarted=true;context.restoreOwnedGeneration=10;context.noteLoadRequestRef.current=10;context.notesPaneLoadRequestRef.current.set('restored-pane',7);await restore();assert.equal(refs.get('view-A').mode,'live');assert.equal(refs.get('view-B').mode,'source');assert.equal(owners,'original');assert.equal(context.noteLoadRequestRef.current,11);assert.equal(context.notesPaneLoadRequestRef.current.get('restored-pane'),8);assert.equal(values.PanelOpen,true);const preflightOnly=runExpression(checkpoint,context)();owners='new-navigation';context.noteLoadRequestRef.current=20;await preflightOnly();assert.equal(owners,'new-navigation');assert.equal(context.noteLoadRequestRef.current,20);const superseded=runExpression(checkpoint,context)();context.restoreMutationStarted=true;context.restoreOwnedGeneration=20;context.noteLoadRequestRef.current=21;owners='newer-navigation';await superseded();assert.equal(owners,'newer-navigation');assert.equal(context.noteLoadRequestRef.current,21);});

test('production quit flusher refuses frozen views before side effects and after an asynchronous save boundary',async()=>{
  let frozen=true,commits=0,flushes=0,saves=0,finish;
  const authority={},pending=new Promise(resolve=>finish=resolve);
  const context={notesNativeViews:{hasFrozenViews:()=>frozen},sourceComposingRef:{current:false},workspaceCompositionActive:()=>false,readActiveKnowledgeWriteSource:()=>authority,commitCurrentEditorDraft:()=>commits++,flushPendingSaveRef:{current:()=>flushes++},realVaultSaveCompletionRef:{current:new Map()},realVaultUserDirtyRef:{current:new Set(['A'])},realVaultLatestContentRef:{current:new Map([['A','draft']])},realVaultSaveInFlightRef:{current:new Set()},savePatch:async()=>saves++};
  const run=runExpression(flush,context);
  assert.equal(await run(),false);assert.equal(commits,0);assert.equal(flushes,0);assert.equal(saves,0);
  frozen=false;context.realVaultSaveCompletionRef.current.set('existing',pending);
  const quitting=run();assert.equal(commits,1);assert.equal(flushes,1);
  frozen=true;finish();assert.equal(await quitting,false);assert.equal(saves,0);assert.equal(context.realVaultUserDirtyRef.current.has('A'),true);
});
test('production inline AI commit advances the exact saved proof before an inactive-view return and rejects a changed source',async()=>{
  const inline=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='applyNotesInlinePreview').initializer.arguments[0];
  const authority={},proof={workspaceSourceId:'sticky-read-source',revision:'r1',content:'old'},events=[];
  let currentSource=authority;
  const context={aiWritePreview:{previewId:'preview'},aiWriteApplying:false,selectedNoteId:'A',selectedNoteIdRef:{current:'B'},bridge:{notesInlineApply:async(id,mode)=>{assert.equal(id,'preview');assert.equal(mode,'replace');events.push('commit');return {content:'new',revision:'r2',insertedText:'new',startUtf16:0,endUtf16:3};}},readActiveKnowledgeWriteSource:()=>currentSource,vaultSessionRef:{current:{latest:()=>7}},acknowledgeSavedReadProof:(id,content,revision,origin)=>{assert.equal(id,'A');assert.equal(origin.generation,7);assert.equal(origin.source,authority);if(currentSource!==origin.source)throw Error('changed source');Object.assign(proof,{content,revision});events.push('proof');},setAiWriteApplying:()=>{},setStatus:()=>{},t:key=>key,setAiWritePreview:()=>events.push('clear'),notesInlineCommittedContentRef:{current:null},editorMode:'live',liveEditorRef:{current:{replaceRange:()=>events.push('editor')}},replaceEditorRange:()=>events.push('source'),refreshRealVaultMarkdownIndex:()=>events.push('index')};
  await runExpression(inline,context)('replace');assert.deepEqual(events,['commit','proof','clear']);assert.deepEqual(proof,{workspaceSourceId:'sticky-read-source',revision:'r2',content:'new'});
  events.length=0;context.selectedNoteIdRef.current='A';context.bridge.notesInlineApply=async()=>{currentSource={};return {content:'wrong',revision:'r3'};};
  await runExpression(inline,context)('replace');assert.deepEqual(events,[]);assert.equal(proof.content,'new');assert.equal(context.notesInlineCommittedContentRef.current,null);
});

test('actual scoped metadata refresh stamps same-body invalidation and rejects an older late reply',async()=>{
  const scopedSource=fs.readFileSync(require('node:path').join(__dirname,'../src/features/notes/ScopedNoteDocumentSurface.tsx'),'utf8');
  const scopedAst=ts.createSourceFile('ScopedNoteDocumentSurface.tsx',scopedSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(scopedAst)==='refreshMetadata')callback=node.initializer.arguments[0];ts.forEachChild(node,visit);}visit(scopedAst);assert.ok(callback);
  const requests=[],values=[],readiness=[],runtime={};
  const context={bindingEpoch:{current:1},invalidationRef:{current:0},metadataSequence:{current:0},metadataCheckpoint:{current:{ready:null,value:null}},alive:{current:true},controller:{session:{getSnapshot:()=>({revision:'unchanged-body'})},metadata:()=>new Promise(resolve=>requests.push(resolve))},viewId:'view',runtime,onRevisionInvalidated:()=>{},setMetadata:value=>values.push(value),setMetadataProblem:()=>{},setMetadataReady:value=>readiness.push(value),NoteRuntimeError:class extends Error{}};
  const refresh=runExpression(callback,context,scopedAst),first=refresh();
  context.invalidationRef.current=1;const second=refresh();
  const current={backlinks:['new peer'],completeness:{complete:true}};requests[1](current);await second;
  assert.deepEqual(readiness.at(-1),{revision:'unchanged-body',runtime,invalidationRevision:1});
  requests[0]({backlinks:['old peer'],completeness:{complete:true}});await first;
  assert.deepEqual(values,[current]);assert.equal(readiness.length,3);
});

test('actual staged incoming pane cancellation stops after its token is replaced across a frame',async()=>{
  const callback=find(node=>ts.isBinaryExpression(node)&&node.left.getText(ast)==='cancelIncomingPaneRef.current').right;
  const oldToken=Symbol('old'),newToken=Symbol('new'),ids=new Set(['view']);let token=oldToken;const closed=[],finished=[];
  const notesNativeViews={incomingToken:()=>token,finishIncoming:(id,expected)=>{finished.push([id,expected]);if(expected===undefined||token===expected)token=undefined;}};
  const context={notesNativeViews,notesPaneViewsRef:{current:{ids:()=>ids}},realVaultUserDirtyRef:{current:new Set()},realVaultSaveInFlightRef:{current:new Set()},notesViewRefsRef:{current:new Map()},closeNotesSplitDocument:()=>{closed.push(token);ids.delete('view');},nextNotePresentationFrame:async()=>{token=newToken;ids.add('view');}};
  const cancel=runExpression(callback,context);await cancel('view','pane','note',oldToken);
  assert.deepEqual(closed,[oldToken]);assert.equal(token,newToken);assert.equal(ids.has('view'),true);assert.deepEqual(finished,[]);
  await cancel('view','pane','note',oldToken);assert.deepEqual(closed,[oldToken]);assert.equal(token,newToken);
  context.nextNotePresentationFrame=async()=>{};await cancel('view','pane','note',newToken);
  assert.deepEqual(closed,[oldToken,newToken]);assert.equal(token,undefined);assert.deepEqual(finished,[['view',newToken]]);
});
test('actual mounted incoming cancellation accepts old unmount but retains failure for its original token',async()=>{
  const callback=find(node=>ts.isMethodDeclaration(node)&&node.name.getText(ast)==='cancelIncoming');
  const js=ts.transpileModule(`({${callback.getText(ast)}}).cancelIncoming`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const oldToken=Symbol('old'),newToken=Symbol('new');let token=oldToken,released=0;
  const context={notesNativeViews:{incomingToken:()=>token},props:{viewId:'view'},binding:()=>{},locked:{current:true},latest:{current:{hasUnsavedInput:()=>false,viewRefs:{live:{current:null},sourceComposing:false},release:()=>released++}},freezeNotesNativeView:(_composition,release)=>release(),nextNotePresentationFrame:async()=>{token=newToken;}};
  const cancel=new Function('context',`with(context){return ${js}}`)(context);
  await cancel();assert.equal(released,1);assert.equal(token,newToken);
  context.nextNotePresentationFrame=async()=>{};await assert.rejects(cancel(),/did not unmount/);assert.equal(released,2);assert.equal(token,newToken);
});
