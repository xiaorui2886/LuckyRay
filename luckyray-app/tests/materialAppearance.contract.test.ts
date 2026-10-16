import test from "node:test";
import assert from "node:assert/strict";
import { MaterialLibrarySession, type MaterialLibraryRegistry, type MaterialLibraryRequest } from "../src/core/services/materialLibraryContext";
import { AppearanceCancelled, MaterialAppearanceSession, appearanceCandidates, localAppearancePreview } from "../src/core/services/materialAppearance";
import { materialSmartQueryMatchesKind, sortMaterialMetadata } from "../src/features/materials/materialSearch";
import { filterMaterialSmartFolder } from "../src/features/smartFolders/smartFolderModel";
import type { MaterialSmartFolderCriteria } from "../src/core/services/smartFolders";
import type { MaterialAsset } from "../src/core/services/materialCatalog";
const asset=(id:string,name=id):MaterialAsset=>({id,name,originalPath:"D:/fixture/image.png",libraryPath:null,storageMode:"linked",kind:"image",mimeType:"image/png",sizeBytes:12,thumbnailUrl:"",description:"",rating:null,dominantColor:null,folderId:null,importedAt:"",updatedAt:"",contentHash:null});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function fixture(run:(request:MaterialLibraryRequest)=>Promise<unknown>,read=(ids:string[])=>ids.map(id=>asset(id))){
  const registry:MaterialLibraryRegistry={legacyId:"A",activeId:"A",libraries:["A","B"].map(id=>({id,name:id,rootPath:null,storageMode:"managed",state:"ready",visible:true,preferences:{},version:0}))};
  const calls:MaterialLibraryRequest[]=[];
  const session=new MaterialLibrarySession(async<T>(request)=>{calls.push(structuredClone(request));const op=request.action.op;
    if(op==="registry")return structuredClone(registry) as T;
    if(op==="select"){registry.activeId=request.libraryId!;return null as T;}
    if(op==="get")return read(request.action.ids as string[]) as T;
    return await run(request) as T;
  });await session.initialize();return {session,calls,service:new MaterialAppearanceSession(session)};
}
const prepared=(id:string,cached=false)=>({libraryId:"A",assetId:id,algorithm:"pixel-appearance-v1",cached,token:cached?null:`token-${id}`});
const result=(id:string)=>({libraryId:"A",algorithm:"pixel-appearance-v1",requested:1,indexed:1,unindexed:0,excludedAnchor:0,failures:[],hits:[{assetId:id,distance:{total:0.1,spatial:0.1,color:0.1,structure:0.1,proportion:0.1}}]});
test("finite candidates preserve explicit scope and reject excessive selected images",()=>{
  const assets=Array.from({length:110},(_,i)=>asset(`id-${i}`));
  assert.equal(appearanceCandidates(assets,new Set()).length,96);
  assert.throws(()=>appearanceCandidates(assets,new Set(assets.map(a=>a.id))),/96/);
  assert.deepEqual(appearanceCandidates(assets,new Set(["id-100"])).map(a=>a.id),["id-100"]);
});
test("bound workspace search remains in its own library when Main switches",async()=>{
  const f=await fixture(async r=>r.action.op==='appearanceQuery'?result('one'):null);
  const bound=new MaterialAppearanceSession(f.session,'A');
  await f.session.select('B');assert.equal(bound.isCurrent(),true);
  await bound.query(['one'],{kind:'asset',id:'anchor'});
  assert.ok(f.calls.filter(r=>r.action.op==='appearanceQuery'||r.action.op==='get').every(r=>r.libraryId==='A'));
  bound.dispose();assert.equal(bound.isCurrent(),false);
});
test("cancelled prepare is discarded, never committed, and restart reuses completed entries",async()=>{
  const held=deferred<unknown>();let hold=true;
  const f=await fixture(async r=>r.action.op==="appearancePrepare"?(hold?held.promise:prepared(String(r.action.id),true)):null);
  const work=f.service.index(["one"],()=>{});f.service.cancelIndex();held.resolve(prepared("one"));
  assert.equal((await work).phase,"cancelled");assert.equal(f.calls.filter(r=>r.action.op==="appearanceCommit").length,0);
  assert.equal(f.calls.filter(r=>r.action.op==="appearanceDiscard").length,1);
  hold=false;const resumed=await f.service.index(["one"],()=>{});assert.equal(resumed.completed,1);assert.equal(resumed.reused,1);
});
test("same-scope registry/preferences publish leaves index current; A-B-A cancels before commit",async()=>{
  const held=deferred<unknown>();const f=await fixture(async r=>r.action.op==="appearancePrepare"?held.promise:null);
  const work=f.service.index(["one"],()=>{});await f.session.refresh();assert.equal(f.service.isCurrent(),true);
  await f.session.select("B");await f.session.select("A");assert.equal(f.service.isCurrent(),false);
  held.resolve(prepared("one"));assert.equal((await work).phase,"cancelled");
  assert.equal(f.calls.some(r=>r.action.op==="appearanceCommit"),false);
  assert.equal(f.calls.find(r=>r.action.op==="appearanceDiscard")?.libraryId,"A");
});
test("per-item failures continue and all native cache commits keep the captured library",async()=>{
  const f=await fixture(async r=>{if(r.action.op==="appearancePrepare"){if(r.action.id==="broken")throw Error("损坏图片");return prepared(String(r.action.id));}return null;});
  const done=await f.service.index(["one","broken","two"],()=>{});
  assert.equal(done.completed,2);assert.equal(done.failures.length,1);assert.equal(done.phase,"completed");
  assert.ok(f.calls.filter(r=>r.action.op==="appearanceCommit").every(r=>r.libraryId==="A"));
});
test("fast queries reject stale successes and stale failures while membership is rechecked",async()=>{
  const held=[deferred<unknown>(),deferred<unknown>(),deferred<unknown>()];let next=0;
  const f=await fixture(async()=>held[next++].promise);
  const first=f.service.query(["one"],{kind:"asset",id:"anchor"});const firstCheck=assert.rejects(first,AppearanceCancelled);
  const second=f.service.query(["one"],{kind:"asset",id:"anchor"});held[1].resolve(result("one"));
  assert.equal((await second).hits[0].assetId,"one");held[0].resolve(result("one"));await firstCheck;
  const third=f.service.query(["one"],{kind:"asset",id:"anchor"});const thirdCheck=assert.rejects(third,AppearanceCancelled);
  f.service.cancelQuery();held[2].reject(Error("late native failure"));await thirdCheck;
  assert.equal(f.calls.filter(r=>r.action.op==="get").length,1);
});
test("remote previews, blob provenance and SVG are refused; local/data images may render",()=>{
  const a=asset("one");a.thumbnailUrl="https://tracker.example/image.png";assert.equal(localAppearancePreview(a),null);
  a.thumbnailUrl="blob:https://remote.example/image";assert.equal(localAppearancePreview(a),null);
  a.thumbnailUrl="data:image/svg+xml,<svg/>";assert.equal(localAppearancePreview(a),null);
  a.thumbnailUrl="http://asset.localhost/D%3A/image.png";assert.equal(localAppearancePreview(a),a.thumbnailUrl);
  a.thumbnailUrl="data:image/png;base64,AAAA";assert.equal(localAppearancePreview(a),a.thumbnailUrl);
});
test("membership deletion/type change after native ranking removes the hit and fixes coverage",async()=>{
  for(const read of [()=>[],()=>[{...asset("one"),kind:"video"}]]){
    const f=await fixture(async()=>result("one"),read);
    const response=await f.service.query(["one"],{kind:"asset",id:"anchor"});
    assert.equal(response.indexed,0);assert.equal(response.hits.length,0);assert.equal(response.failures.length,1);
    assert.equal(response.indexed+response.unindexed+response.failures.length+response.excludedAnchor,response.requested);
    assert.match(response.failures[0].message,/移除或类型/);
  }
});
test("name sorting uses smart-rule locale semantics; unknown file sizes stay last",()=>{
  const a=asset("a","图2");const b=asset("b","图10");const c=asset("c","图1");c.sizeBytes=null;
  assert.deepEqual(sortMaterialMetadata([a,b,c],"name-asc").map(a=>a.name),[a,b,c].map(a=>a.name).sort((a,b)=>a.localeCompare(b,"zh-CN")));
  b.sizeBytes=20;assert.deepEqual(sortMaterialMetadata([a,c,b],"size-desc").map(a=>a.id),["b","a","c"]);
});

test("smart conversion refuses real kind-only broadening and permits an ordinary name query",()=>{
  const rows=[asset("red","red.png"),asset("blue","blue.png")];
  const criteria:MaterialSmartFolderCriteria={source:"material",query:"  ImAgE  ",kinds:[],tagIds:[],favorite:null,added:{after:null,before:null},modified:{after:null,before:null}};
  const ordinary=(query:string)=>rows.filter(row=>[row.name,row.description].some(value=>(value||"").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const context={tagMap:{},favoriteIds:new Set<string>()};
  assert.equal(ordinary(criteria.query).length,0);
  assert.equal(filterMaterialSmartFolder(criteria,"name-asc",rows,context).length,2,"unchanged smart evaluator also matches kind");
  assert.equal(materialSmartQueryMatchesKind(criteria.query,["image","video","audio","document","other"],[]),true,"supported kind is protected even with no loaded results");
  assert.equal(materialSmartQueryMatchesKind("age",["image"],rows),true,"substring uses the same smart query normalization");
  assert.equal(materialSmartQueryMatchesKind("brush",[],[{kind:"custom-brush"}]),true,"loaded future kinds are protected without a scan");
  assert.equal(materialSmartQueryMatchesKind(" ",["image"],rows),false);
  criteria.query="red";
  assert.deepEqual(ordinary(criteria.query).map(row=>row.id),["red"]);
  assert.deepEqual(filterMaterialSmartFolder(criteria,"name-asc",rows,context).map(row=>row.id),["red"]);
  assert.equal(materialSmartQueryMatchesKind(criteria.query,["image","video","audio","document","other"],rows),false);
});
