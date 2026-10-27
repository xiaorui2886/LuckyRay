const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'src/features/notes/NotesPage.tsx'),'utf8');
const ast=ts.createSourceFile('NotesPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;ts.forEachChild(node,visit);}visit(ast);assert.ok(found);return found;}
const pane=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='renderNotesDocumentPane');
function binding(name,handler){let attribute;function visit(node){if(ts.isJsxAttribute(node)&&node.name.getText(ast)===name)attribute=node;else ts.forEachChild(node,visit);}visit(pane);assert.ok(attribute);const entry=attribute.initializer.expression.properties.find(item=>item.name.text===handler);assert.ok(entry);const js=ts.transpileModule(`(${entry.initializer.getText(ast)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return context=>new Function('context',`with(context){return ${js}}`)(context);}
test('Main live edits retain exact active-pane and actual-document guard',()=>{
 const factory=binding('liveEditor','onChange');let changed=[];
 const context={activeNotesSplitPaneRef:{current:'left'},paneId:'right',selectedNote:{id:'actual-document'},selectedNoteIdRef:{current:'actual-document'},handleContentChange:value=>changed.push(value)};
 const change=factory(context);change('wrong pane');assert.deepEqual(changed,[]);
 context.activeNotesSplitPaneRef.current='right';context.selectedNoteIdRef.current='other';change('wrong document');assert.deepEqual(changed,[]);
 context.selectedNoteIdRef.current='actual-document';change('exact draft');assert.deepEqual(changed,['exact draft']);
});
test('Main source edits retain draft projection and guard before mutation',()=>{
 const factory=binding('sourceEditor','onChange');const changes=[];
 const context={activeNotesSplitPaneRef:{current:'left'},paneId:'left',selectedNote:{id:'doc'},selectedNoteIdRef:{current:'other'},setSourceContentDraft:text=>changes.push(['source',text]),handleContentChange:text=>changes.push(['document',text])};
 const change=factory(context);change({target:{value:'wrong'}});assert.deepEqual(changes,[]);context.selectedNoteIdRef.current='doc';change({target:{value:'draft'}});assert.deepEqual(changes,[['source','draft'],['document','draft']]);
});
test('Main drop handlers retain exact selection and original attachment dispatch',()=>{
 const factory=binding('sourceEditor','onDrop');const inserted=[];const area={selectionStart:3,selectionEnd:7,focus(){}};
 const context={getDraggedMaterialAsset:data=>data.asset,insertExistingAssetReference:(asset,range)=>inserted.push(['asset',asset,range]),insertDroppedFilesAsAssets:(files,range)=>inserted.push(['files',files,range])};
 const drop=factory(context);const files=['one'];drop({dataTransfer:{asset:null,files},currentTarget:area,preventDefault(){},stopPropagation(){}});assert.deepEqual(inserted,[['files',files,{start:3,end:7}]]);
});
test('full production surface keeps all editor modes and complete command/control bindings',()=>{
 const full=fs.readFileSync(path.join(root,'src/features/notes/NoteDocumentSurface.tsx'),'utf8');
 for(const control of ['<NotePreview {...preview}','<textarea ref={viewRefs.source} {...sourceEditor}','<LiveMarkdownEditor key={viewId} ref={viewRefs.live} {...liveEditor}','note-title-strip','note-favorite-action','note-attachments-action','note-tags-bar','ai-note-suggest-panel','editor-status-conflict','actions.toggleIndex','actions.togglePreview','actions.toggleSource'])assert.ok(full.includes(control),control);
 for(const handler of ['onInsertFiles','onInsertClipboardImage','onInsertAssetReference','onOpenNote','onCreateNote','onOpenAsset','onOpenTag','onCreateTag','onCommand','onContextMenu','onSessionCapture','restoreSession'])assert.ok(pane.getText(ast).includes(handler),handler);
 assert.match(full,/import \{NotePreview\} from '\.\/NotePreview'/);
 assert.doesNotMatch(full,/WorkspaceNoteView|knowledgeStore|luckyRayBridge|readActiveKnowledge/);
});
test('Main keeps default-open index and child starts collapsed without inheriting global vault state',()=>{
 const scoped=fs.readFileSync(path.join(root,'src/features/notes/ScopedNoteDocumentSurface.tsx'),'utf8');
 assert.match(source,/\[panelOpen, setPanelOpen\] = useState\(true\)/);
 assert.match(scoped,/\[panelOpen,setPanelOpen\]=useState\(false\)/);
 assert.match(scoped,/currentNoteId:documentId/);assert.doesNotMatch(scoped,/currentNoteId:viewId/);
 assert.match(scoped,/onSessionCapture:snapshot=>\{editorSession.current=snapshot/);
 assert.match(scoped,/controller\.attachView\(viewId,runtime\)/);
 const scopedAst=ts.createSourceFile('ScopedNoteDocumentSurface.tsx',scoped,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let readinessGuard;
 function visit(node){if(ts.isIfStatement(node)&&node.expression.getText(scopedAst).includes('!actionsReady')&&node.expression.getText(scopedAst).includes('!panelsReady'))readinessGuard=node;ts.forEachChild(node,visit);}
 visit(scopedAst);assert.ok(readinessGuard);
 const evaluate=new Function('context',`with(context){return ${ts.transpileModule(`(${readinessGuard.expression.getText(scopedAst)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText}}`);
 const runtime={},ready={revision:'r1',runtime,invalidationRevision:0};
 const context={restoring:false,actionsReady:true,panelsReady:true,visible:true,composing:{current:false},onRevisionReady(){},state:{revision:'r1',dirty:false,status:'ready'},metadataReady:ready,attachmentsReady:ready,runtime,invalidationRevision:0};
 assert.equal(evaluate(context),false);
 for(const [key,value] of [['restoring',true],['actionsReady',false],['panelsReady',false],['visible',false]])assert.equal(evaluate({...context,[key]:value}),true,key);
 assert.equal(evaluate({...context,composing:{current:true}}),true);
 assert.equal(evaluate({...context,attachmentsReady:null}),true);
 assert.equal(evaluate({...context,metadataReady:{...ready,runtime:{}}}),true);
 assert.match(scoped,/panels\?\.index&&panels\?\.attachments/);
});
