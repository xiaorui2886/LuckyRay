// Exact production source guards and modal effect execution. This controlled
// lifecycle test does not claim React Activity or Windows browser execution.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('retained Notes isolates every route-local dialog without disconnecting editor owners',()=>{
 const source=read('src/features/notes/NotesPage.tsx');
 const start=source.indexOf('<Activity mode={visible ? "visible" : "hidden"}>'),end=source.indexOf('</Activity>',start);
 assert.ok(start>source.indexOf('<NotesPaneTree'));assert.ok(end>start);
 const overlays=source.slice(start,end);
 for(const name of ['AttachmentRelinkDialog','AttachmentImportDialog','NotesIndexPopover','VaultLinkUpdateDialog','NoteMoveModal','TagDialog'])assert.ok(overlays.includes('<'+name),name);
 assert.match(source,/<NotesPaneTabStrip visible=\{visible\}/);
 assert.match(source,/visible&&nativeMenu&&onNativeWindow&&createPortal/);
 assert.match(source,/publishedTabsRef.current = ""/);
 assert.match(source,/event.shiftKey&&event.key==='F10'/);
});
test('titlebar portals match the current route and preserve accepted layout/index defaults',()=>{
 const source=read('src/app/AppSidebar.tsx');
 assert.match(source,/nativeTabMenu&&\(\(nativeTabMenu.kind==='note'&&isNotes\)\|\|\(nativeTabMenu.kind==='graph'&&isGraph\)\)&&createPortal/);
 assert.match(source,/setNativeTabMenu\(null\);setNativeTabError\(''\);\},\[route\]/);
 assert.match(source,/\[notesIndexOpen, setNotesIndexOpen\] = useState\(true\)/);
 assert.match(source,/title="管理布局" aria-label="管理布局"/);
});
test('normal menu admission is wired but physical tearout and preload opt-in stay closed',()=>{
 const main=read('src/main.tsx'),shell=read('src/app/AppShell.tsx'),cargo=read('src-tauri/Cargo.toml');
 assert.match(main,/installWorkspaceProductionMain\(\)/);assert.match(shell,/bridgeReady&&isTauri\(\)&&<WorkspaceProductionMain/);
 assert.match(shell,/newlyHiddenNavigationFallback/);assert.match(shell,/applicationModalActive/);
 assert.match(read('src/workspace/nativeTabDrag.ts'),/PRODUCTION_PHYSICAL_TEAROUT_VERIFIED = false/);
 assert.match(read('src-tauri/src/workspace_tearout.rs'),/PRODUCTION_PHYSICAL_TEAROUT_VERIFIED: bool = false/);
 assert.match(cargo,/default = \["sidecar-binaries"\]/);assert.match(cargo,/lsh-background-surface-preload = \["browser-host-runtime"\]/);
 assert.match(read('src/features/graph/GraphPage.tsx'),/requestGraphNativeDetach\(sessionId, false\)/);
 assert.match(read('src/features/graph/GraphPage.tsx'),/requestGraphNativeDetach\(sessionId, true\)/);
});
function modalHarness(){
 let store,effects=[],refs=[],observers=0;const listeners=new Map();
 class Element{
  constructor(name){this.name=name;this.isConnected=true;this.hiddenRoute=false;this.children=[];}
  querySelectorAll(){return this.children;}querySelector(){return null;}
  contains(target){return target===this||this.children.includes(target);}
  closest(){return this.hiddenRoute?this:null;}
  focus(){document.activeElement=this;}
 }
 const document={activeElement:null,addEventListener:(name,fn)=>listeners.set(fn,name),removeEventListener:(_name,fn)=>listeners.delete(fn)};
 const react={createContext:()=>({}),createElement:()=>({}),useContext:()=>store,useLayoutEffect:fn=>effects.push(fn),useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useCallback:fn=>fn,useSyncExternalStore:()=>{}};
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(read('src/app/applicationModalIsolation.ts'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>{assert.equal(name,'react');return react;},document,HTMLElement:Element,requestAnimationFrame:fn=>fn(),MutationObserver:class{observe(){observers++;}disconnect(){observers--;}}});
 store=module.exports.createApplicationModalIsolationStore();
 function mount(name){
  effects=[];refs=[];const surface=new Element(name),opener=new Element(name+'-opener');document.activeElement=opener;
  const controls=module.exports.useApplicationModalSurface(true,()=>{});controls.surfaceRef.current=surface;
  const setups=effects.slice();let cleanups=setups.map(fn=>fn());
  return {surface,opener,hide(){opener.hiddenRoute=true;for(const fn of cleanups)fn?.();cleanups=[];},show(){opener.hiddenRoute=false;cleanups=setups.map(fn=>fn());}};
 }
 return {mount,store,listeners,document,Element,observers:()=>observers};
}
test('actual modal effects release global isolation and focus traps during hidden Notes / Graph admission',()=>{
 const h=modalHarness(),notes=h.mount('notes-vault-dialog'),draft={text:'unsaved dialog draft',editorOwner:{}};
 const owner=draft.editorOwner;
 assert.equal(h.store.getSnapshot(),true);assert.equal(h.listeners.size,1);assert.equal(h.observers(),1);
 notes.hide();
 const graph=new h.Element('admitted-graph');graph.focus();
 assert.equal(h.store.getSnapshot(),false);assert.equal(h.listeners.size,0);assert.equal(h.observers(),0);assert.equal(h.document.activeElement,graph);
 notes.show();assert.equal(h.store.getSnapshot(),true);assert.equal(h.listeners.size,1);assert.equal(h.observers(),1);
 assert.equal(draft.text,'unsaved dialog draft');assert.equal(draft.editorOwner,owner);
 notes.hide();assert.equal(h.store.getSnapshot(),false);
});
test('hiding one retained route never releases another live modal lease',()=>{
 const h=modalHarness(),notes=h.mount('notes'),graph=h.mount('graph-action');
 assert.equal(h.listeners.size,2);notes.hide();assert.equal(h.store.getSnapshot(),true);assert.equal(h.listeners.size,1);
 graph.hide();assert.equal(h.store.getSnapshot(),false);assert.equal(h.listeners.size,0);
});
test('retained source and preview display-menu hooks synchronously hide portals and reject hidden reopening',()=>{
 const source=read('src/features/notes/editor/noteDisplay.tsx');
 const ast=ts.createSourceFile('noteDisplay.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='useNoteDisplayMenu');
 assert.ok(fn);
 for(const visible of [true,false]){
  let portals=0,prevented=0;const state=[],effects=[];
  const context={exports:{},NoteRouteVisibilityContext:{},useContext:()=>visible,useNoteDisplay:()=>({limitWidth:false,lineNumbers:false,inlineTitle:false}),
   useState:()=>[{x:10,y:20,restore:null},next=>state.push(next)],useRef:()=>({current:null}),useLayoutEffect:f=>effects.push(f),useEffect:f=>effects.push(f),
   createPortal:node=>{portals++;return node;},React:{createElement:()=>({})},document:{body:{},activeElement:null,addEventListener:()=>{},removeEventListener:()=>{}},window:{addEventListener:()=>{},removeEventListener:()=>{}},HTMLElement:class{},toggle:()=>{}};
  vm.createContext(context);vm.runInContext(ts.transpileModule(fn.getText(ast)+'\nthis.result=useNoteDisplayMenu();',{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  assert.equal(portals,visible?1:0);if(!visible)assert.equal(context.result.menu,null);
  context.result.open({clientX:1,clientY:2,preventDefault:()=>prevented++,stopPropagation:()=>{}});
  assert.equal(prevented,visible?1:0);effects.forEach(f=>f());
  if(!visible)assert.deepEqual(state,[null]);
 }
 assert.match(read('src/features/notes/NotesPage.tsx'),/<NoteRouteVisibilityContext.Provider value=\{visible\}>/);
 for(const file of ['src/features/notes/editor/LiveMarkdownEditor.tsx','src/features/notes/NotePreview.tsx'])assert.match(read(file),/useNoteDisplayMenu\(\)/);
});
