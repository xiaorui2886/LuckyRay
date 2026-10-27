import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
test('metadata atomic rename capability is confined to application-owned generation records',()=>{
 const capability=JSON.parse(readFileSync('src-tauri/capabilities/canvas-material-provenance.json','utf8'));
 assert.deepEqual(capability.windows,['main']);assert.equal(capability.remote,undefined);
 const commands=new Set(capability.permissions.map((p:any)=>p.identifier));
 assert.deepEqual(commands,new Set(['fs:allow-mkdir','fs:allow-exists','fs:allow-read-file','fs:allow-write-file','fs:allow-rename']));
 for(const permission of capability.permissions){assert.equal(permission.allow.length,1);assert.ok(permission.allow[0].path.startsWith('$APPDATA/canvas-material-provenance-v1'));assert.ok(!permission.allow[0].path.includes('**'));}
 assert.equal(capability.permissions.find((p:any)=>p.identifier==='fs:allow-rename').allow[0].path,'$APPDATA/canvas-material-provenance-v1/*');
});
test('provenance enrichment is canvas-only and writes stage a temporary file before rename',()=>{
 const app=readFileSync('src/App.tsx','utf8');
 const assetList=app.slice(app.indexOf('async function listAssets()'),app.indexOf('async function updateAsset('));
 assert.doesNotMatch(assetList,/enrichCanvasMaterialAssets|canvasMaterialProvenanceStore/);
 assert.match(app,/listCanvasAssets: async \(\) => enrichCanvasMaterialAssets\(await listAssets\(\)\)/);
 const sidecar=app.slice(app.indexOf('const canvasMaterialProvenanceStore'),app.indexOf('async function saveCanvasGenerationToLibrary('));
 assert.ok(sidecar.indexOf('await writeFile(temporary')<sidecar.indexOf('await rename(temporary, path)'));
 assert.doesNotMatch(sidecar.slice(sidecar.indexOf('async read(key)'),sidecar.indexOf('async write(key')),/mkdir/);
});
