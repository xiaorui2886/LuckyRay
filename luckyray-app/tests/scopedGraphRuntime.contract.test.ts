import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildScopedGraphSeed, createScopedGraphRuntime, type ScopedGraphSnapshot, type ScopedGraphTransport, type ScopedGraphRequest } from '../src/workspace/scopedGraphRuntime.ts';
import { buildRealVaultGraphSeed } from '../src/core/services/graph.ts';

function snapshot(vaultId = 'vault-a'): ScopedGraphSnapshot {
  return {
    snapshotId: 'opaque-snapshot', revision: 'graph-v1:fixture', vaultId, version: 1, generatedAt: '2026-10-06T00:00:00Z',
    documents: [
      { relativePath: 'A.md', fileName: 'A.md', title: 'A', revision: 'revision-a', wikiLinks: [{raw:'[[B]]',target:'B',alias:null,line:1},{raw:'[[Missing]]',target:'Missing',alias:null,line:2}], embeds: [], frontmatterTags: ['shared'], mtime: '2025-01-01T00:00:00Z' },
      { relativePath: 'B.md', fileName: 'B.md', title: 'B', revision: 'revision-b', wikiLinks: [{raw:'[[A]]',target:'A',alias:null,line:1}], embeds: [], frontmatterTags: [], mtime: '2025-02-01T00:00:00Z' },
    ],
    embeds: [{ sourceRelativePath: 'A.md', resolutions: [{kind:'document',relativePath:'B.md'},{kind:'library-asset',assetId:'asset-1',assetName:'Image'},{kind:'vault-asset',relativePath:'assets/a.png',label:'a.png'}] }],
    grants: [{kind:'document',token:'ticket-a',relativePath:'A.md'},{kind:'document',token:'ticket-b',relativePath:'B.md'},{kind:'tag',token:'ticket-tag',tag:'shared'},{kind:'library-asset',token:'ticket-image',assetId:'asset-1'},{kind:'vault-asset',token:'ticket-vault-image',relativePath:'assets/a.png'}],
    completeness: {complete:true,missing:[]},
  };
}
function fake(value = snapshot()) {
  const calls: ScopedGraphRequest[] = [];
  const transport: ScopedGraphTransport = {
    actions: {},
    // Explicit synthetic services for this contract fixture, not production routes.
    async mutateTag(request) { calls.push(request); return {changed:true,message:'saved'}; },
    async exportScreenshot() { return 'copied'; },
    async request<T>(request: ScopedGraphRequest): Promise<T> {
      calls.push(request);
      return (request.op === 'graphRead' ? structuredClone(value) : {changed:true,message:'saved'}) as T;
    },
  };
  return {calls,transport,runtime:createScopedGraphRuntime('graph-view','vault-a',transport)};
}

test('scoped seed matches production directions, types, missing nodes and timelines exactly', () => {
  const dto = snapshot();
  const expected = buildRealVaultGraphSeed({vaultId:dto.vaultId,rootPath:'/must-not-be-used',generatedAt:dto.generatedAt,version:1,errors:[],changedPaths:[],removedPaths:[],documents:dto.documents.map(doc => ({...doc,absolutePath:'/must-not-be-used/'+doc.relativePath,headings:[],tags:doc.frontmatterTags,inlineTags:[],plainText:'must-not-be-used',excerpt:'',contentLength:0,size:0}))},new Map(dto.embeds.map(entry=>[entry.sourceRelativePath,entry.resolutions])));
  const actual = buildScopedGraphSeed(dto);
  assert.deepEqual(actual,expected);
  assert.ok(Object.values(actual.edgeDirections!).includes('bidirectional'));
  assert.ok(actual.nodes.some(node=>node.status==='missing'));
  assert.ok(actual.nodes.every(node=>typeof node.timelineAt==='number'));
  assert.deepEqual([...new Set(Object.values(actual.edgeKinds!))].sort(),['embed-asset','embed-vault-asset','tag','wiki-link']);
});

test('scoped mutation transports opaque pair tickets, never node paths, names or renderer revisions',async()=>{
  const {runtime,calls}=fake(); const seed=await runtime.readSeed();
  const note=seed.nodes.find(node=>node.label==='B')!,tag=seed.nodes.find(node=>node.type==='tag')!;
  await runtime.mutateRelation('tag','connect',note,tag);
  assert.deepEqual(calls[1],{op:'graphMutateTag',viewId:'graph-view',snapshotId:'opaque-snapshot',sourceToken:'ticket-b',targetToken:'ticket-tag',mode:'connect'});
  assert.equal(runtime.renderedRevision(),null);
  assert.equal(runtime.dataProof(),null);
  await assert.rejects(runtime.mutateRelation('tag','connect',note,tag),/node-not-granted/);
});

test('a forged node, wrong vault, unsupported body write and missing target fail closed',async()=>{
  const {runtime,calls}=fake();const seed=await runtime.readSeed();
  const note=seed.nodes.find(node=>node.label==='A')!,tag=seed.nodes.find(node=>node.type==='tag')!;
  await assert.rejects(runtime.mutateRelation('tag','connect',{...note,entityId:'real-vault:other:private.md'},tag),/node-not-granted/);
  await assert.rejects(runtime.mutateRelation('tag','connect',{...note,key:'note:forged'},tag),/node-not-granted/);
  await assert.rejects(runtime.mutateRelation('body','connect',note,tag),/body-edit-in-document/);
  await assert.rejects(runtime.act('createMissing',seed.nodes.find(node=>node.status==='missing')!),/separate validated target ticket/);
  assert.equal(calls.length,1);
  await assert.rejects(fake(snapshot('vault-b')).runtime.readSeed(),/scope-mismatch/);
});

test('incomplete data is an explicit error; incomplete action routes never claim parity',async()=>{
  const dto=snapshot();dto.completeness={complete:false,missing:['library-embed-scope-required']};
  const {runtime}=fake(dto);
  await assert.rejects(runtime.readSeed(),/graph-incomplete:library-embed-scope-required/);
  assert.equal(runtime.renderedRevision(),null);
  assert.equal(runtime.completeness().complete,false);
  assert.ok(runtime.completeness().missing.includes('library-embed-scope-required'));
  const completeData=fake();await completeData.runtime.readSeed();
  assert.equal(completeData.runtime.completeness().complete,false);
  assert.ok(completeData.runtime.completeness().missing.includes('parent-route:open'));
});

test('independent runtime instances retain separate scope, context and read caches',async()=>{
  const a=fake(),b=fake(); await Promise.all([a.runtime.readSeed(),b.runtime.readSeed()]);
  a.runtime.publishContext({nodeId:'selected-a',nodeType:'note',label:'A'});
  assert.equal(b.runtime.contextNodeKey(),null);
  await a.runtime.readSeed();assert.equal(a.calls.length,1);assert.equal(b.calls.length,1);
  assert.equal(a.runtime.contextNodeKey(),'note:selected-a');
});

test('unadvertised parent actions cannot call transport or fall through global services',async()=>{
  const {runtime,calls}=fake();const seed=await runtime.readSeed();
  for(const action of ['open','openDefault','reveal','askAi'] as const){
    assert.equal(runtime.capability(action,seed.nodes[0]).available,false);
    await assert.rejects(runtime.act(action,seed.nodes[0]),/verified parent route/);
  }
  assert.equal(calls.length,1);
  const source=readFileSync(new URL('../src/workspace/scopedGraphRuntime.ts',import.meta.url),'utf8');
  for(const forbidden of ['getLuckyRayBridgeSync','knowledgeStore','materialStore','openInLightSeek','window.location','readFile','plugin-sql'])assert.ok(!source.includes(forbidden),forbidden);
});

test('overlapping refresh cannot publish an earlier snapshot or authorize its tickets',async()=>{
  const resolvers:Array<(value:ScopedGraphSnapshot)=>void>=[];
  const runtime=createScopedGraphRuntime('view','vault-a',{actions:{},request:<T>()=>new Promise<T>(resolve=>resolvers.push(value=>resolve(value as T)))});
  const earlier=runtime.readSeed();const later=runtime.readSeed({refresh:true});
  const fresh=snapshot();fresh.snapshotId='fresh';fresh.revision='fresh-revision';resolvers[1](fresh);
  await later;resolvers[0](snapshot());await assert.rejects(earlier,/superseded/);
  assert.equal(runtime.renderedRevision(),'fresh-revision');
  assert.deepEqual(runtime.dataProof(),{kind:'graph',snapshotId:'fresh',revision:'fresh-revision'});
});

test('backend source keeps opaque selected snapshot grants and mandatory CAS',()=>{
  const source=readFileSync(new URL('../src-tauri/src/workspace_graph.rs',import.meta.url),'utf8');
  assert.match(source,/held\.nodes\.get\(source_token\)/);
  assert.match(source,/held\.nodes\.get\(target_token\)/);
  assert.match(source,/expected_revision: revision\.clone\(\)/);
  assert.match(source,/with_companion_draft_guard/);
  assert.match(source,/authorize_write.ok_or\("workspace-graph-host-write-guard-required"\)\?\(document_ref\)\?/);
  assert.match(source,/current_target_identity/);
  assert.match(source,/held\.id == snapshot_id && held\.complete/);
  for(const forbidden of ['activate_ui_source','register_current_vault','replace_document','std::fs','get_current','knowledge_service()']) assert.ok(!source.includes(forbidden),forbidden);
});

test('advertised node navigation contains only the currently issued opaque ticket',async()=>{
  const {transport,calls}=fake();transport.actions.open=true;
  const runtime=createScopedGraphRuntime('retained-view','vault-a',transport);
  const seed=await runtime.readSeed();await runtime.act('open',seed.nodes.find(node=>node.label==='A')!);
  assert.deepEqual(calls[1],{op:'graphNodeAction',viewId:'retained-view',snapshotId:'opaque-snapshot',nodeToken:'ticket-a',action:'open',requestId:1});
});

test('scoped renderer hooks bypass Main stores and preserve unsupported Main restrictions',()=>{
  const source=readFileSync(new URL('../src/features/graph/GraphPage.tsx',import.meta.url),'utf8');
  assert.match(source,/const seed = runtime \? await runtime.readSeed/);
  assert.match(source,/if \(runtime\) \{\s*const release = runtime.subscribe/);
  const ast=ts.createSourceFile('GraphPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let persist:ts.VariableDeclaration|undefined;
  function visit(node:ts.Node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='persistGraphView')persist=node;ts.forEachChild(node,visit);}
  visit(ast);assert.ok(persist&&persist.initializer&&ts.isCallExpression(persist.initializer));
  const callback=persist.initializer.arguments[0];assert.ok(ts.isArrowFunction(callback));
  const js=ts.transpileModule(`(${callback.getText(ast)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const writes:unknown[]=[],persistViewRef={current:true},currentRuntimeRef:{current:object|null}={current:null};
  const context={persistViewRef,currentRuntimeRef,currentGraphView:()=>({panX:5}),writeGraphViewState:(state:unknown)=>writes.push(state)};
  const persistNow=new Function('context',`with(context){return ${js}}`)(context) as ()=>void;
  currentRuntimeRef.current={};persistNow();assert.deepEqual(writes,[],'scoped views never persist into Main');
  currentRuntimeRef.current=null;persistViewRef.current=false;persistNow();assert.deepEqual(writes,[],'multi-view policy disables global persistence');
  persistViewRef.current=true;persistNow();assert.deepEqual(writes,[{panX:5}],'retained callback reads live persistence policy');
  assert.match(source,/if \(runtime\) return null;\s*if \(!node.entityId\)/);
  assert.match(source,/if \(!runtime && \(parseKnowledgeDocumentNoteId/);
  assert.match(source,/if \(runtime && !runtime.allowWorker\) \{[\s\S]*?physicsWorkerUnavailableRef.current = true;[\s\S]*?return;\s*\}\s*let worker: Worker/);
  assert.match(source,/runtime \? await runtime.mutateRelation\("tag"/);
});

 test('native graph runtime forbids worker creation under child CSP',()=>{assert.equal(fake().runtime.allowWorker,false);});

test('missing creation requires a backend target ticket and explicit advertised route',async()=>{
 const value=snapshot();value.grants.push({kind:'missing-document',token:'missing-ticket',sourceRelativePath:'A.md',relativePath:'Missing.md',title:'Missing'});
 const f=fake(value);f.transport.actions.createMissing=true;
 const seed=await f.runtime.readSeed();const node=seed.nodes.find(node=>node.status==='missing')!;
 assert.equal(f.runtime.capability('createMissing',node).available,true);
 await f.runtime.act('createMissing',node);
 assert.deepEqual(f.calls[1],{op:'graphNodeAction',viewId:'graph-view',snapshotId:'opaque-snapshot',nodeToken:'missing-ticket',action:'createMissing',requestId:1});
 assert.equal(f.runtime.capability('askAi',node).available,false);
});
test('asset routes remain unavailable until per-item parent adapter is installed',async()=>{
 const f=fake();Object.assign(f.transport.actions,{open:true,openDefault:true,reveal:true,askAi:true,createMissing:true});
 const seed=await f.runtime.readSeed();const asset=seed.nodes.find(node=>node.type==='material')!;
 for(const action of ['open','openDefault','reveal','askAi'] as const)assert.equal(f.runtime.capability(action,asset).available,false);
 assert.ok(f.runtime.completeness().missing.includes('asset-parent-item-adapter'));
});
