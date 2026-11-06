const assert=require('node:assert/strict');const test=require('node:test');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {createRequire}=require('node:module');
const requireVite=createRequire(require.resolve('vite/package.json'));const esbuild=requireVite('esbuild');
const {JSDOM}=require(process.env.LUCKYRAY_TEST_DOM_MODULE||'jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="editor"></div></body></html>',{pretendToBeVisual:true,url:'https://fixture.invalid/'});
for(const key of ['window','document','navigator','MutationObserver','HTMLElement','Element','Node','Event','KeyboardEvent','CustomEvent','DOMException','getComputedStyle','Range'])Object.defineProperty(globalThis,key,{value:key==='getComputedStyle'?dom.window.getComputedStyle.bind(dom.window):dom.window[key],configurable:true});
globalThis.location=dom.window.location;
globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.Range.prototype.getClientRects=()=>[];dom.window.Range.prototype.getBoundingClientRect=()=>({left:0,top:0,right:0,bottom:0,width:0,height:0});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'luckyray-desktop-test-'));
fs.writeFileSync(path.join(dir,'tauri.cjs'),'exports.invoke=()=>Promise.reject(Error("not used"));');
function bundle(name,source){const file=path.join(dir,name+'.cjs');esbuild.buildSync({stdin:{contents:source,resolveDir:process.cwd(),loader:'ts'},outfile:file,bundle:true,platform:'node',format:'cjs',alias:{'@tauri-apps/api/core':path.join(dir,'tauri.cjs')}});return require(file);}
const editor=bundle('editor',`export * from './src/core/extensions/desktop/editorRegistry'; export {capturePortableLiveEditor,restorePortableLiveEditor} from './src/features/notes/noteViewPresentation'; export {search as searchExtension} from '@codemirror/search';`);
const contributions=bundle('contributions',`export * from './src/core/extensions/desktop/contributions';`);
const packages=bundle('packages',`export * from './src/core/extensions/packages';`);
const {EditorState,StateEffect}=editor.editorModules.state;const {EditorView}=editor.editorModules.view;
test('real host CM6 extensions attach, survive edits, detach and remove without replacing document',()=>{
 const view=new EditorView({parent:document.querySelector('#editor'),state:EditorState.create({doc:'hello'})});
 const events=[];const offEvent=editor.onDesktopEditorEvent(e=>events.push(e.type));const detach=editor.attachDesktopEditor(view,'note-1');let updates=0;
 const unregister=editor.registerDesktopEditorExtension(({modules})=>modules.view.EditorView.updateListener.of(u=>{if(u.docChanged)updates++;}));
 view.dispatch({changes:{from:5,insert:'!'}});assert.equal(view.state.doc.toString(),'hello!');assert.equal(updates,1);assert.ok(events.includes('changed'));
 unregister();view.dispatch({changes:{from:6,insert:'?'}});assert.equal(updates,1);assert.equal(view.state.doc.toString(),'hello!?');
 detach();assert.equal(editor.listDesktopEditors().length,0);const again=editor.attachDesktopEditor(view,'note-1');const before=events.filter(e=>e==='changed').length;view.dispatch({changes:{from:7,insert:'.'}});assert.equal(events.filter(e=>e==='changed').length,before+1);again();offEvent();view.destroy();
});
test('commands have real handlers and input/default-prevented safeguards',async()=>{
 let count=0;contributions.desktopCommands.set('example.test/run',{id:'example.test/run',name:'test',shortcut:'Ctrl+Shift+Y',run:()=>count++});
 const event=new KeyboardEvent('keydown',{key:'Y',ctrlKey:true,shiftKey:true,cancelable:true});assert.equal(contributions.dispatchDesktopShortcut(event),true);await Promise.resolve();assert.equal(count,1);assert.equal(event.defaultPrevented,true);
 const prevented=new KeyboardEvent('keydown',{key:'Y',ctrlKey:true,shiftKey:true,cancelable:true});prevented.preventDefault();assert.equal(contributions.dispatchDesktopShortcut(prevented),false);
 const input=document.createElement('input');document.body.append(input);let handled;input.addEventListener('keydown',e=>{handled=contributions.dispatchDesktopShortcut(e);});input.dispatchEvent(new KeyboardEvent('keydown',{key:'Y',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));assert.equal(handled,false);contributions.desktopCommands.clear();input.remove();
});
test('custom views use actual host route and panel state, unknown views rejected',()=>{
 contributions.desktopViews.set('example.test/board',{id:'example.test/board',title:'Board',mount:()=>{}});contributions.openDesktopView('example.test/board','right');assert.equal(contributions.panels[0].placement,'right');contributions.closeDesktopView('example.test/board');assert.equal(contributions.panels.length,0);assert.throws(()=>contributions.openDesktopView('missing/x'));contributions.desktopViews.clear();
});
test('desktop module compatibility does not advertise capabilities to legacy scripts',()=>{
 const p={manifest:{type:'script',apiVersion:1,minHostVersion:'1.9.8',requiredModules:['filesystem'],optionalModules:[]}};assert.equal(packages.packageCompatibility(p,'1.9.8').compatible,false);p.manifest.type='desktop';p.manifest.apiVersion=2;assert.equal(packages.packageCompatibility(p,'1.9.8').compatible,true);
});

test('rename and real portable-state restore retain editor extension and correct cleanup',()=>{
 const base=[editor.editorModules.commands.history(),editor.editorModules.language.codeFolding(),editor.searchExtension()];
 const view=new EditorView({parent:document.querySelector('#editor'),state:EditorState.create({doc:'kept',extensions:base})});let changedId='';
 const events=editor.onDesktopEditorEvent(e=>{if(e.type==='changed')changedId=e.editor.id;});
 editor.attachDesktopEditor(view,'old');
 let count=0;const off=editor.registerDesktopEditorExtension(({modules})=>modules.view.EditorView.updateListener.of(u=>{if(u.docChanged)count++;}));
 view.dispatch({changes:{from:4,insert:'!'},selection:{anchor:5}});
 const snapshot=editor.capturePortableLiveEditor(view.state,{top:0,left:0});
 const detach=editor.attachDesktopEditor(view,'renamed');
 view.setState(editor.restorePortableLiveEditor(snapshot,'kept!',base));editor.refreshDesktopEditor(view);
 assert.equal(view.state.doc.toString(),'kept!');assert.equal(view.state.selection.main.head,5);
 view.dispatch({changes:{from:5,insert:'?'}});
 assert.equal(changedId,'renamed');assert.equal(count,2);detach();assert.equal(editor.listDesktopEditors().length,0);off();events();view.destroy();
});
test('modal gate blocks extension shortcuts and host command dispatcher uses bound context',async()=>{
 let calls=0;contributions.desktopCommands.set('test/modal',{id:'test/modal',name:'blocked',shortcut:'Ctrl+Y',run:()=>calls++});
 assert.equal(contributions.dispatchDesktopShortcut(new KeyboardEvent('keydown',{key:'y',ctrlKey:true,cancelable:true}),true),false);assert.equal(calls,0);
 await assert.rejects(contributions.executeDesktopHostCommand('note.closeTab'));
 const off=contributions.bindDesktopHostCommands(async id=>{assert.equal(id,'note.closeTab');calls++;});await contributions.executeDesktopHostCommand('note.closeTab');assert.equal(calls,1);off();contributions.desktopCommands.clear();
});

test.after(()=>dom.window.close());
