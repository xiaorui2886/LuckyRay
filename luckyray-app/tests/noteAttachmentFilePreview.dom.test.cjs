const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const {createRequire} = require('node:module');
const tools = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const {JSDOM} = tools('jsdom');
const dom = new JSDOM('<div id="root"></div>', {url:'https://synthetic.invalid/#notes'});
for (const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','MutationObserver','navigator','getComputedStyle'])
  Object.defineProperty(global, key, {value:dom.window[key], configurable:true});
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react'), {createRoot} = require('react-dom/client');
const repo = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', {paths:[fs.realpathSync(path.join(repo,'node_modules/vite'))]}));

test('real Notes attachment file card and modal keep vault authority and never navigate to the ordinary library', async () => {
  const asset = {id:'attachment-text', name:'synthetic.txt', kind:'document', updatedAt:'rev1', sizeBytes:48};
  const ordinary = {id:'ordinary-text', name:'ordinary.txt', kind:'document'};
  const snapshot = {allAssets:[ordinary], loaded:true, error:null};
  const calls = [], external = [], navigated = [];
  global.__attachmentPorts = {
    materialStore:{subscribe:()=>()=>{}, getSnapshot:()=>snapshot, ensureSnapshot:async()=>{}},
    list:async()=>[asset],
    details:async()=>({references:[{vaultId:global.__testVault, notePath:'Preview-QA.md'}]}),
    external:async(...args)=>{external.push(args); return true;},
  };
  global.__testVault = 'synthetic-vault-1';
  global.__previewNative = async (command,args) => {
    calls.push({command,args});
    return {kind:'text',text:'SYNTHETIC BODY '+args.vaultId,truncated:false};
  };
  const built = await esbuild.build({stdin:{contents:'export {NoteAttachmentSidebar} from "./src/features/notes/NoteAttachmentSidebar"; export {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from "./src/app/applicationModalIsolation";',resolveDir:repo,loader:'tsx'}, bundle:true, write:false, platform:'node', format:'cjs', packages:'external', jsx:'automatic', plugins:[{
    name:'synthetic-boundaries', setup(build) {
      build.onResolve({filter:/core\/services\/materialStore$/},()=>({path:'store',namespace:'ports'}));
      build.onResolve({filter:/core\/services\/materials$/},()=>({path:'materials',namespace:'ports'}));
      build.onResolve({filter:/core\/services\/materialCatalog$/},()=>({path:'catalog',namespace:'ports'}));
      build.onResolve({filter:/MaterialViewContext$/},()=>({path:'scope',namespace:'ports'}));
      build.onResolve({filter:/noteMediaReadyCache$/},()=>({path:'geometry',namespace:'ports'}));
      build.onResolve({filter:/AttachmentProblem$/},()=>({path:'problem',namespace:'ports'}));
      build.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'invoke',namespace:'ports'}));
      build.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));
      build.onLoad({filter:/.*/,namespace:'ports'},({path:p})=>({contents:({
        store:'export const materialStore=globalThis.__attachmentPorts.materialStore;',
        materials:'export const MATERIAL_CHANGE_EVENT="test:materials";export const MATERIAL_CHANGE_LOCAL_EVENT="test:local";export const listFilteredMaterialAssets=globalThis.__attachmentPorts.list;export const getMaterialAttachmentDetails=globalThis.__attachmentPorts.details;export const performMaterialExternalAction=globalThis.__attachmentPorts.external;',
        catalog:'export const resolveMaterialPreviewTarget=()=>null;',
        scope:'export const useMaterialViewScope=()=>null;',
        geometry:'export const readDecodedMediaGeometry=()=>null;export const rememberDecodedMediaGeometry=()=>{};',
        problem:'export const AttachmentProblem=()=>null;',
        invoke:'export const invoke=globalThis.__previewNative;',
      })[p],loader:'js'}));
    }
  }]});
  const loaded = {exports:{}};
  new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,require);
  const {NoteAttachmentSidebar,ApplicationModalIsolationProvider,createApplicationModalIsolationStore} = loaded.exports;
  const modalStore = createApplicationModalIsolationStore();
  const root = createRoot(document.getElementById('root'));
  const render = () => root.render(React.createElement(ApplicationModalIsolationProvider,{store:modalStore},React.createElement(NoteAttachmentSidebar,{key:global.__testVault,vaultId:global.__testVault,currentPath:'Preview-QA.md',editable:false,onClose:()=>{},onInsert:async()=>{},onOpenAsset:id=>navigated.push(id)})));
  const flush = async () => React.act(async()=>{for(let i=0;i<8;i++)await Promise.resolve();});
  try {
    await React.act(async()=>render()); await flush();
    assert.match(document.querySelector('.note-attachment-thumb').textContent,/SYNTHETIC BODY synthetic-vault-1/);
    await React.act(async()=>document.querySelector('.note-attachment-thumb').click()); await flush();
    const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
    assert.match(dialog.querySelector('pre').textContent,/synthetic-vault-1/);
    assert.deepEqual(navigated,[]); assert.equal(window.location.hash,'#notes');
    assert.ok(calls.some(c=>c.args.detail===true));
    assert.ok(calls.every(c=>c.command==='material_file_preview' && c.args.libraryId===null && c.args.vaultId==='synthetic-vault-1'));
    await React.act(async()=>[...dialog.querySelectorAll('button')].find(b=>b.textContent==='打开原文件').click());
    assert.deepEqual(external,[['attachment-text','open',null,'synthetic-vault-1']]);
    await React.act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    assert.equal(document.querySelector('[role="dialog"]'),null); assert.deepEqual(navigated,[]);
    global.__testVault='synthetic-vault-2'; await React.act(async()=>render()); await flush();
    assert.match(document.querySelector('.note-attachment-thumb').textContent,/synthetic-vault-2/);
    assert.doesNotMatch(document.querySelector('.note-attachment-thumb').textContent,/synthetic-vault-1/);
    await React.act(async()=>[...document.querySelectorAll('[role="tab"]')].find(b=>b.textContent.trim()==='素材库').click()); await flush();
    await React.act(async()=>document.querySelector('.note-attachment-thumb').click());
    assert.deepEqual(navigated,['ordinary-text'],'ordinary material tab keeps its original action');
  } finally { await React.act(async()=>root.unmount()); delete global.__attachmentPorts; delete global.__previewNative; delete global.__testVault; }
});
