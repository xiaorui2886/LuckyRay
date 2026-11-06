const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');const{createRequire}=require('node:module');
const esbuild=createRequire(require.resolve('vite/package.json'))('esbuild');const{JSDOM}=require(process.env.LUCKYRAY_TEST_DOM_MODULE||'jsdom');
const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{pretendToBeVisual:true,url:'https://fixture.invalid/'});
for(const key of ['window','document','navigator','MutationObserver','HTMLElement','Element','Node','Event','KeyboardEvent','CustomEvent','DOMException','Range'])Object.defineProperty(globalThis,key,{value:dom.window[key],configurable:true});globalThis.location=dom.window.location;globalThis.getComputedStyle=dom.window.getComputedStyle.bind(dom.window);globalThis.IS_REACT_ACT_ENVIRONMENT=true;globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);
const ownedChannels=[];const NativeMessageChannel=globalThis.MessageChannel;globalThis.MessageChannel=class extends NativeMessageChannel{constructor(){super();ownedChannels.push(this);}};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-desktop-lifecycle-'));
const definitions={
 'tauri':`export const invoke=(command,args)=>globalThis.__desktopFixtureInvoke(command,args);export const listen=async()=>()=>{};export const confirm=async()=>false;`,
 'runtime':`export const desktopStatus=()=>({state:'active'});export const desktopNeedsRestart=()=>false;`,
 'pages':`export const pageVisibleInSidebar=()=>false;export const writeSidebarPref=()=>{};export const pageKey=(id,page)=>id+'/'+page;`,
};
const ready=(async()=>{
 const b=await esbuild.build({stdin:{contents:`export * from './src/features/community/DesktopExtensions';export * from './src/core/extensions/desktop/contributions';export * as React from 'react';export {createRoot} from 'react-dom/client';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'},plugins:[{name:'native-seams',setup(build){
 build.onResolve({filter:/^@tauri-apps\//},()=>({path:'tauri',namespace:'fixture'}));
 build.onResolve({filter:/desktop\/runtime$/},()=>({path:'runtime',namespace:'fixture'}));
 build.onResolve({filter:/\/pluginPages$/},()=>({path:'pages',namespace:'fixture'}));
 build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:definitions[args.path],loader:'js'}));
 }}]});const file=path.join(dir,'view.cjs');fs.writeFileSync(file,b.outputFiles[0].text);return require(file);
})();
test('late async mount cannot write into or clean up its replacement view',async()=>{
 const api=await ready;let finish;const hold=new Promise(resolve=>{finish=resolve;});let oldCleanup=0;
 api.desktopViews.set('test/a',{id:'test/a',title:'A',async mount(el){await hold;el.textContent='old';return()=>{oldCleanup++;el.replaceChildren();};}});
 api.desktopViews.set('test/b',{id:'test/b',title:'B',mount(el){el.textContent='new';return()=>el.replaceChildren();}});
 const host=document.querySelector('#root');const root=api.createRoot(host);
 await api.React.act(async()=>{root.render(api.React.createElement(api.DesktopViewHost,{viewKey:'test/a'}));});
 await api.React.act(async()=>{root.render(api.React.createElement(api.DesktopViewHost,{viewKey:'test/b'}));});
 assert.equal(host.textContent,'new');await api.React.act(async()=>{finish();await hold;});assert.equal(host.textContent,'new');assert.equal(oldCleanup,1);
 await api.React.act(async()=>root.unmount());api.desktopViews.clear();
});
test('code renderer failure restores actual ordinary code fallback',async()=>{
 const api=await ready;api.desktopRenderers.set('broken',()=>{throw Error('synthetic renderer');});
 const host=document.querySelector('#root');const root=api.createRoot(host);
 await api.React.act(async()=>root.render(api.React.createElement(api.DesktopCodeBlock,{language:'broken',source:'original',noteId:'note',fallback:api.React.createElement('pre',null,'original')})));
 assert.equal(host.textContent,'original');await api.React.act(async()=>root.unmount());api.desktopRenderers.clear();
});

test.after(()=>{dom.window.close();esbuild.stop();for(const channel of ownedChannels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=NativeMessageChannel;});
