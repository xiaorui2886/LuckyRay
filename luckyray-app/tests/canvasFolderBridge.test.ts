import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { knowledgeFolderIdentity } from '../src/core/services/knowledgeLegacyBridge.ts';
import { knowledgeDocumentNoteId } from '../src/core/services/knowledge.ts';
const require = createRequire(import.meta.url);
const { transformSync } = createRequire(require.resolve('vite'))('esbuild');
const source = readFileSync('src/App.tsx', 'utf8');
function extract(start: string, end: string) {
  return transformSync(source.slice(source.indexOf(`async function ${start}(`), source.indexOf(`\nasync function ${end}(`)), { loader: 'ts', target: 'es2022' }).code;
}
function bind(code: string, name: string, env: Record<string, unknown>) {
  return Function('env', `const {${Object.keys(env).join(',')}}=env;${code};return ${name};`)(env);
}
function saveHarness(options: {duplicate?: boolean; stale?: boolean; placementFails?: boolean} = {}) {
  const calls: string[] = [];
  let checks = 0;
  let asset = {id:'a', name:'old', originalPath:'/a.png', folderId:null as string|null};
  const save = bind(extract('saveCanvasGenerationToLibrary', 'dismissAssetAiSuggestion'), 'saveCanvasGenerationToLibrary', {
    listCanvasMaterialFolders: async () => ({catalogId:'legacy-material-catalog',folders: options.stale && ++checks > 1 ? [] : [{id:'f',name:'Folder',parentId:null}]}),
    listAssets: async () => options.duplicate ? [asset] : [],
    importAssets: async () => {calls.push('import');return {assets:[asset],skippedDuplicates:options.duplicate?1:0};},
    moveAssetToFolder: async ({folderId}: {folderId:string|null}) => {calls.push('move');if(!options.placementFails) asset={...asset,folderId};},
    getAssetsByIds: async () => [asset],
    updateAsset: async (_id:string,patch:object) => {calls.push('rename');return asset={...asset,...patch};},
    normalizeMaterialGenerationProvenance: () => undefined,
  });
  return {save,calls};
}
const candidate={kind:'image',mediaUrl:'/a.png',name:'Node name'};
const destination={catalogId:'legacy-material-catalog',folderId:'f'};
test('chosen formal folder is verified and node name preserved', async () => {
  const h=saveHarness(); assert.equal((await h.save(candidate,destination)).success,true);
  assert.deepEqual(h.calls,['import','move','rename']);
});
test('wrong catalog or missing folder never imports or falls back', async () => {
  for (const target of [{...destination,catalogId:'other'}, {...destination,folderId:'missing'}]) {
    const h=saveHarness(); assert.equal((await h.save(candidate,target)).success,false); assert.deepEqual(h.calls,[]);
  }
});
test('folder removed during import never moves or reports success', async () => {
  const h=saveHarness({stale:true}); assert.equal((await h.save(candidate,destination)).success,false); assert.deepEqual(h.calls,['import']);
});
test('duplicate in another folder is never moved or renamed', async () => {
  const h=saveHarness({duplicate:true}); const result=await h.save(candidate,destination);
  assert.equal(result.success,false); assert.match(result.message,/其他文件夹/); assert.deepEqual(h.calls,['import']);
});
test('unconfirmed placement never reports success', async () => {
  const h=saveHarness({placementFails:true}); assert.equal((await h.save(candidate,destination)).success,false); assert.deepEqual(h.calls,['import','move']);
});
function knowledgeHarness(switched=false) {
  let reads=0;
  const file={kind:'file',name:'Note.md',relativePath:'Topic/Note.md',children:[]};
  return bind(extract('listCanvasKnowledgeFolders','saveCanvasGenerationToLibrary'),'listCanvasKnowledgeFolders',{
    isTauri:()=>false,
    getCurrentNotesVault:async()=>({id:switched && ++reads>1?'other':'v'}),
    listNotesVaultFiles:async()=>({kind:'folder',name:'Vault',relativePath:'',children:[{kind:'folder',name:'Topic',relativePath:'Topic',children:[file]}]}),
    knowledgeFolderIdentity,knowledgeDocumentNoteId,
  });
}
test('knowledge folder and note membership retain formal vault-qualified identity', async()=>{
  const result=await knowledgeHarness()();
  const folder=knowledgeFolderIdentity('v','Topic');
  assert.deepEqual(result.folders,[{id:folder,name:'Topic',parentId:null}]);
  assert.equal(result.noteFolderIds[knowledgeDocumentNoteId({vaultId:'v',relativePath:'Topic/Note.md'})],folder);
});
test('knowledge snapshot rejects vault switch during folder read',async()=>{
  await assert.rejects(knowledgeHarness(true)(),/knowledge-vault-not-current/);
});

test('material folder snapshot preserves catalog identity and nested parent IDs',async()=>{
  const read=bind(extract('listCanvasMaterialFolders','listCanvasKnowledgeFolders'),'listCanvasMaterialFolders',{
    listFolders:async(scope:string)=>{assert.equal(scope,'materials');return [{id:'parent',name:'Parent',parentId:null,children:[{id:'child',name:'Child',parentId:'parent',children:[]}]}];},
  });
  assert.deepEqual(await read(),{catalogId:'legacy-material-catalog',folders:[{id:'parent',name:'Parent',parentId:null},{id:'child',name:'Child',parentId:'parent'}]});
});

test('knowledge folders without an open vault cannot expose a stale library',async()=>{
  const read=bind(extract('listCanvasKnowledgeFolders','saveCanvasGenerationToLibrary'),'listCanvasKnowledgeFolders',{
    isTauri:()=>false,
    getCurrentNotesVault:async()=>null,
    listNotesVaultFiles:async()=>{throw Error('must not read stale vault');},
  });
  assert.deepEqual(await read(),{vaultId:null,folders:[],noteFolderIds:{}});
});

test('canvas enrichment preserves asset folder membership and exact original asset identity',async()=>{
  const read=bind(extract('enrichCanvasMaterialAssets','listCanvasMaterialFolders'),'enrichCanvasMaterialAssets',{
    canvasMaterialProvenanceStore:{read:async(asset:{id:string})=>({proof:asset.id})},
  });
  const assets=[{id:'a',folderId:'child',name:'One'},{id:'b',folderId:null,name:'Two'}];
  assert.deepEqual(await read(assets),assets.map(asset=>({...asset,materialGenerationProvenance:{proof:asset.id}})));
  assert.equal('materialGenerationProvenance' in assets[0],false);
});


test('native knowledge snapshot never falls back to cached Vault on authority failure',async()=>{
  const read=bind(extract('listCanvasKnowledgeFolders','saveCanvasGenerationToLibrary'),'listCanvasKnowledgeFolders',{
    isTauri:()=>true,
    invoke:async()=>{throw Error('native unavailable');},
    getCurrentNotesVault:async()=>{throw Error('must not use fallback');},
  });
  await assert.rejects(read(),/native unavailable/);
});
