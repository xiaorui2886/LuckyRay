import assert from 'node:assert/strict';
import test from 'node:test';
import {buildRealVaultGraphSeed, type RealVaultGraphEmbedResolution} from '../src/core/services/graph.ts';
import type {BridgeNotesVaultMarkdownIndexDocument, BridgeNotesVaultMarkdownIndex} from '../src/core/bridge/bridgeTypes.ts';

function document(title:string,targets:string[],tags:string[]=[]): BridgeNotesVaultMarkdownIndexDocument {
  return {relativePath:title+'.md',absolutePath:'/synthetic/'+title+'.md',fileName:title+'.md',title,revision:'fixture',headings:[],wikiLinks:targets.map(target=>({target,raw:target,alias:null,line:1})),embeds:[],tags,frontmatterTags:tags,inlineTags:[],plainText:'',excerpt:'',contentLength:0,mtime:null,size:0};
}
function index(documents:BridgeNotesVaultMarkdownIndexDocument[]):BridgeNotesVaultMarkdownIndex {
  return {vaultId:'synthetic-only',rootPath:'/synthetic',generatedAt:'2026-10-04T00:00:00Z',documents,errors:[],version:1,changedPaths:[],removedPaths:[]};
}
test('production seed merges repeated and reciprocal references into one physical spring',()=>{
  const seed=buildRealVaultGraphSeed(index([document('A',['B','B','A']),document('B',['A'])]));
  assert.equal(seed.nodes.length,2);assert.equal(seed.edges.length,1);
  assert.deepEqual(Object.values(seed.edgeDirections!),['bidirectional']);
});
test('tags and embeds add genuine shared hubs while preserving node types and input documents',()=>{
  const input=index([document('A',['B'],['shared','shared']),document('B',[],['shared'])]);
  const original=structuredClone(input);
  const embeds=new Map<string,RealVaultGraphEmbedResolution[]>([['A.md',[{kind:'document',relativePath:'B.md'},{kind:'library-asset',assetId:'asset-1',assetName:'asset'},{kind:'vault-asset',relativePath:'image.png',label:'image'}]]]);
  const seed=buildRealVaultGraphSeed(input,embeds);
  assert.deepEqual(input,original);
  assert.equal(seed.nodes.filter(n=>n.type==='note').length,2);
  assert.equal(seed.nodes.filter(n=>n.type==='tag').length,1);
  assert.equal(seed.nodes.filter(n=>n.type==='material').length,2);
  assert.equal(seed.nodes.filter(n=>n.type==='web').length,0);
  assert.equal(seed.edges.length,5);
  assert.equal(new Set(seed.edges.map(([a,b])=>[a,b].sort((x,y)=>x-y).join(':'))).size,seed.edges.length);
});
