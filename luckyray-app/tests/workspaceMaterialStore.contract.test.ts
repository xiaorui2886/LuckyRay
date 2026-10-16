import test from 'node:test';
import assert from 'node:assert/strict';
import {MaterialStore,type MaterialStoreReads} from '../src/core/services/materialStore.ts';
function reads(library:string):MaterialStoreReads{
 const asset={id:'same-id',name:library} as Awaited<ReturnType<MaterialStoreReads['list']>>[number];
 return {list:async()=>[asset],filtered:async filter=>[{...asset,name:`${library}:${filter.query??''}`}],folders:async()=>[],byIds:async()=>[asset],change:async()=>null};
}
test('separate views retain independent filters for same or different libraries',async()=>{
 const a=new MaterialStore({libraryId:'A',reads:reads('A')}),b=new MaterialStore({libraryId:'B',reads:reads('B')}),c=new MaterialStore({libraryId:'A',reads:reads('A')});
 await Promise.all([a.ensureSnapshot({reason:'open',query:{key:'a',filters:{query:'first'}}}),b.ensureSnapshot({reason:'open'}),c.ensureSnapshot({reason:'open'})]);
 assert.equal(a.getSnapshot().assets[0].name,'A:first');assert.equal(b.getSnapshot().assets[0].name,'B');assert.equal(c.getSnapshot().assets[0].name,'A');
 await a.revalidate({reason:'filter',query:{key:'next',filters:{query:'second'}}});
 assert.equal(a.getSnapshot().assets[0].name,'A:second');assert.equal(c.getSnapshot().assets[0].name,'A');
 const previous=a.getSnapshot();await a.revalidate({reason:'foreign',query:{key:'wrong',libraryId:'B'}});assert.equal(a.getSnapshot(),previous);
});
test('closed/superseded query cannot overwrite the current filtered view',async()=>{
 let release:(v:any)=>void=()=>{};const source=reads('A');source.filtered=filter=>filter.query==='slow'?new Promise(resolve=>{release=resolve;}):Promise.resolve([{id:'new',name:'new'} as any]);
 const store=new MaterialStore({libraryId:'A',reads:source});
 const slow=store.revalidate({reason:'slow',query:{key:'slow',filters:{query:'slow'}}});
 await store.revalidate({reason:'new',query:{key:'new',filters:{query:'new'}}});release([{id:'old',name:'old'}]);await slow;
 assert.equal(store.getSnapshot().assets[0].id,'new');
});
