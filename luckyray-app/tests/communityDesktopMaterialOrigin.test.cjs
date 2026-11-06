const test = require('node:test'), assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const path = require('node:path'), os = require('node:os'), fs = require('node:fs');

test('a bound import keeps its library and origin across the file dialog and a switch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'lr-origin-test-'));
  const bundled = await esbuild.build({entryPoints:['src/core/services/materialLibraryAdapter.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'synthetic',setup(build){
    build.onResolve({filter:/materialLibraryContext$/},()=>({path:'context',namespace:'fixture'}));
    build.onResolve({filter:/materialAssetAdapter$/},()=>({path:'asset',namespace:'fixture'}));
    build.onResolve({filter:/materialCatalog$/},()=>({path:'catalog',namespace:'fixture'}));
    build.onResolve({filter:/^@tauri-apps\//},args=>({path:args.path,namespace:'fixture'}));
    build.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:
      args.path==='context'?`export const materialLibrarySession=globalThis.__originSession;`:
      args.path==='asset'?`export const adaptMaterialAssetMedia=x=>x;`:
      args.path==='catalog'?`export const toMaterialCatalogError=x=>x;`:
      args.path.endsWith('/core')?`export class Channel {}`:`export const open=()=>globalThis.__originDialog;`}));
  }}]});
  const file=path.join(root,'adapter.cjs');fs.writeFileSync(file,bundled.outputFiles[0].text);
  const calls=[];let resolveDialog,origin=['test.extension'],activeLibrary='A';
  globalThis.__originDialog=new Promise(resolve=>{resolveDialog=resolve;});
  globalThis.__originSession={getSnapshot:()=>({registry:{libraries:[{id:'A',storageMode:'managed'}]},libraryId:activeLibrary}),request:async(action,id,origins)=>{calls.push({action,id,origins});return {assets:[],failedItems:[],skippedDuplicateCount:0};}};
  try {
    const {createMaterialLibraryAdapter}=require(file);
    const adapter=createMaterialLibraryAdapter({},'A',()=>origin);
    const pending=adapter.importAssets();
    origin=undefined;activeLibrary='B';resolveDialog(['synthetic.txt']);
    await pending;
    assert.equal(calls.length,1);
    assert.equal(calls[0].id,'A');
    assert.deepEqual(calls[0].origins,['test.extension']);
    assert.equal(calls[0].action.op,'importPaths');
  } finally {
    delete globalThis.__originDialog;delete globalThis.__originSession;
    fs.unlinkSync(file);fs.rmdirSync(root);
    esbuild.stop();
  }
});
