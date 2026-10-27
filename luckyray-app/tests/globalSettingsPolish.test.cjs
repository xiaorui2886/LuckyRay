// Production React/JSDOM regression with synthetic services. Not a browser pixel or native acceptance test.
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),req=createRequire(root+'/package.json');
const tools=process.env.LR_TEST_TOOLS?createRequire(path.resolve(process.env.LR_TEST_TOOLS,'package.json')):req;
const {JSDOM}=tools('jsdom');
// Presentation contracts: hidden state belongs to React, portal scope belongs to the active route.
const css=fs.readFileSync(path.join(root,'src/features/settings/settingsGlobalPolish.css'),'utf8');
assert(css.includes('.settings-panel:not(.settings-appearance-panel)'));
assert(css.includes('@container (max-width: 820px)'));
assert(css.includes('@container (max-width: 520px)'));
assert(!/\[hidden\][^{]*\{/.test(css),'polish never overrides disclosure/region hidden state');
assert(!css.includes('body:has(.luckyray-settings-page'),'shared layout portal must require active route');
assert(css.includes('body:has(.react-nav-shell[data-route="settings"] .luckyray-settings-page [data-navigation-entry])'));
assert(css.includes('*::after'),'motion policies cover switch pseudo-elements');
assert(!/var\(--theme-accent-on-solid\)/.test(css),'undefined optional solid token needs a fallback');
const writes=[];
// Fail closed for any service not explicitly provided by the synthetic fixture.
globalThis.fetch=async()=>{throw new Error("Synthetic settings fixture: network disabled");};
const dom=new JSDOM('<div id="root"></div>',{url:'https://audit.invalid',pretendToBeVisual:true});
for(const k of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','navigator','localStorage','sessionStorage','getComputedStyle','MutationObserver'])Object.defineProperty(globalThis,k,{value:dom.window[k],configurable:true});
window.__LUCKYRAY__={getSettings:async()=>({}),getAutoLaunchEnabled:async()=>false,getAppDataDir:async()=>'/synthetic/audit',listBackups:async()=>[],setSettings:async(...a)=>{writes.push(['setSettings',...a]);},clearAllData:async(...a)=>{writes.push(['clearAllData',...a]);},setAutoLaunchEnabled:async(...a)=>{writes.push(['autoLaunch',...a]);}};
window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
globalThis.ResizeObserver=class{observe(){}disconnect(){}};
const out=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'luckyray-global-settings-'));
process.on('exit',()=>fs.rmSync(out,{recursive:true,force:true}));
const {build,stop}=createRequire(req.resolve('vite'))('esbuild');
(async()=>{
await build({stdin:{contents:`export {default as SettingsPage} from './src/features/settings/SettingsPage';export {I18nProvider} from './src/core/i18n';export {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';export {CompanionPresentationTestProvider} from './src/features/settings/CompanionPresentation';export {createCompanionPresentationStore} from './src/core/services/companionPresentationStore';`,resolveDir:root,loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty','.png':'dataurl','.svg':'dataurl'},plugins:[{name:'react-runtime',setup(b){b.onResolve({filter:/^react(?:\/.*)?$/},a=>({path:req.resolve(a.path),external:true}));}}],outfile:out+'/settings-fixture.cjs'});
stop();
const React=req('react'),{createRoot}=req('react-dom/client'),{flushSync}=req('react-dom');
const {SettingsPage,I18nProvider,ApplicationModalIsolationProvider,createApplicationModalIsolationStore,CompanionPresentationTestProvider,createCompanionPresentationStore}=require(out+'/settings-fixture.cjs');
const companion=createCompanionPresentationStore({status:async()=>({state:'disabled',desktopInstanceId:'audit',certificateFingerprint:'synthetic'}),listDevices:async()=>[],listInterfaces:async()=>[],listAudit:async()=>[]});
const r=createRoot(document.getElementById('root'));flushSync(()=>r.render(React.createElement(I18nProvider,{locale:'zh-CN'},React.createElement(ApplicationModalIsolationProvider,{store:createApplicationModalIsolationStore()},React.createElement(CompanionPresentationTestProvider,{store:companion},React.createElement(SettingsPage))))));
const tabs=()=>Array.from(document.querySelectorAll('.settings-nav-item'));
assert.equal(tabs().length,8);
for(let i=0;i<8;i++){flushSync(()=>tabs()[i].click());await new Promise(r=>setTimeout(r,20));assert(tabs()[i].classList.contains('active'));console.log('MOUNT',tabs()[i].textContent,document.querySelectorAll('.setting-row').length,'rows');}
assert.deepEqual(writes,[],'mount/tab navigation never mutates fake bridge');
flushSync(()=>tabs()[0].click());const search=document.querySelector('.settings-nav-search input');const setInput=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
flushSync(()=>{setInput.call(search,'zzznomatch');search.dispatchEvent(new Event('input',{bubbles:true}));});assert(document.querySelector('.settings-no-results'));assert.equal(document.querySelectorAll('.setting-row').length,0);
flushSync(()=>{setInput.call(search,'语言');search.dispatchEvent(new Event('input',{bubbles:true}));});assert(!document.querySelector('.settings-no-results'));assert.equal(document.querySelectorAll('.setting-row').length,1);
flushSync(()=>{setInput.call(search,'');search.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(document.querySelectorAll('.setting-row').length,6);
flushSync(()=>tabs()[7].click());const update=document.querySelector('.settings-update-entry'),updatePanel=document.getElementById(update.getAttribute('aria-controls'));assert(updatePanel.hidden);flushSync(()=>update.click());assert(!updatePanel.hidden);flushSync(()=>updatePanel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert(updatePanel.hidden);assert.equal(document.activeElement,update);
flushSync(()=>tabs()[3].click());const scopes=()=>Array.from(document.querySelectorAll('.settings-shortcut-scope-tab'));scopes()[0].focus();flushSync(()=>scopes()[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));assert.equal(scopes()[1].getAttribute('aria-selected'),'true');assert.equal(document.activeElement,scopes()[1]);assert.equal(scopes().filter(x=>x.tabIndex===0).length,1);
flushSync(()=>tabs()[5].click());assert(document.querySelector('.companion-panel'));assert(document.querySelector('.companion-interface-select'));
flushSync(()=>tabs()[6].click());const danger=Array.from(document.querySelectorAll('.settings-btn-danger'));assert(danger.length>=2);for(const button of danger){flushSync(()=>button.click());const dialog=document.querySelector('.settings-confirm');assert(dialog,'confirm present');const cancel=dialog.querySelector('.settings-confirm-btn');flushSync(()=>cancel.click());assert(!document.querySelector('.settings-confirm'));}
flushSync(()=>tabs()[4].click());for(const toggle of document.querySelectorAll('.settings-ai-disclosure-toggle')){const body=document.getElementById(toggle.getAttribute('aria-controls'));assert(body.hidden);flushSync(()=>toggle.click());assert(!body.hidden);flushSync(()=>toggle.click());assert(body.hidden);}
assert.deepEqual(writes,[],'cancel and navigation never mutate fake bridge');
flushSync(()=>r.unmount());companion.dispose();dom.window.close();console.log('PASS: production mount and 8 tab switches; storage dangerous actions open confirmation and cancel; AI disclosures toggle hidden state; update Escape restores focus; shortcut arrow/roving focus; companion disabled state; search empty/match/clear; zero fake bridge writes. No browser/layout/native claim.');
})().catch(e=>{console.error(e);process.exitCode=1;});
