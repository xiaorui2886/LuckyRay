import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentSession,DocumentSessions} from '../src/workspace/documentSession.ts';
test('missing resources can close without pretending they are transferable/saved',async()=>{
 const session=new DocumentSession({read:async()=>{throw Error('missing');},write:async()=>{throw Error('must not write');}});
 await session.load();assert.equal(await session.flush(),false);assert.equal(await session.flushForClose(),true);
});
test('shared document identity includes library and does not share selections',()=>{
 const pool=new DocumentSessions();const transport=()=>({read:async()=>({content:'a',revision:'1'}),write:async(content:string)=>({content,revision:'2'})});
 const a=pool.get({libraryId:'A',resourceId:'note.md'},transport);assert.equal(a,pool.get({libraryId:'A',resourceId:'note.md'},transport));assert.notEqual(a,pool.get({libraryId:'B',resourceId:'note.md'},transport));
});
test('typing during save serializes the latest draft against acknowledged revision',async()=>{
 let release:(value:any)=>void=()=>{};const writes:any[]=[];
 const session=new DocumentSession({read:async()=>({content:'a',revision:'1'}),write:async(content,revision)=>{writes.push({content,revision});return writes.length===1?new Promise(resolve=>{release=resolve;}):{content,revision:'3'};}});
 await session.load();session.edit('中文一');const saved=session.flush();session.edit('中文二');release({content:'中文一',revision:'2'});assert.equal(await saved,true);assert.deepEqual(writes,[{content:'中文一',revision:'1'},{content:'中文二',revision:'2'}]);assert.equal(session.getSnapshot().dirty,false);
});
test('stale write retains local draft and needs explicit conflict choice',async()=>{
 let current={content:'a',revision:'1'};const session=new DocumentSession({read:async()=>current,write:async(content,revision)=>{if(revision!==current.revision)throw Error('conflict');return current={content,revision:'3'};}});
 await session.load();session.edit('local');current={content:'remote',revision:'2'};assert.equal(await session.flush(),false);assert.equal(session.getSnapshot().content,'local');assert.equal(session.getSnapshot().remote?.content,'remote');assert.equal(await session.flush(),false);
 session.resolveConflict('keep-local');assert.equal(await session.flush(),true);assert.equal(current.content,'local');
});
test('clean remote changes update content while dirty changes retain both versions',async()=>{
 const session=new DocumentSession({read:async()=>({content:'a',revision:'1'}),write:async()=>{throw Error('offline');}});await session.load();session.receive({content:'b',revision:'2'});assert.equal(session.getSnapshot().content,'b');session.edit('mine');session.receive({content:'c',revision:'3'});assert.equal(session.getSnapshot().content,'mine');session.resolveConflict('remote');assert.equal(session.getSnapshot().content,'c');assert.equal(session.getSnapshot().dirty,false);
});
test('peer invalidation arriving during write is reconciled after the acknowledgement',async()=>{
 let current={content:'a',revision:'1'};let acknowledge:(value:any)=>void=()=>{};
 const session=new DocumentSession({read:async()=>current,write:async(content)=>new Promise(resolve=>{acknowledge=resolve;current={content,revision:'2'};})});
 await session.load();session.edit('mine');const saving=session.flush();
 current={content:'newer peer',revision:'3'};const refreshing=session.refresh();
 acknowledge({content:'mine',revision:'2'});await saving;await refreshing;
 assert.equal(session.getSnapshot().revision,'3');assert.equal(session.getSnapshot().content,'newer peer');
});
test('peer change during pending write cannot replace subsequent local input',async()=>{
 let current={content:'a',revision:'1'};let acknowledge:(value:any)=>void=()=>{};
 const session=new DocumentSession({read:async()=>current,write:async()=>new Promise(resolve=>{acknowledge=resolve;})});
 await session.load();session.edit('mine');const saving=session.flush();session.edit('mine plus');
 current={content:'peer',revision:'3'};session.receive(current);acknowledge({content:'mine',revision:'2'});
 assert.equal(await saving,false);assert.equal(session.getSnapshot().content,'mine plus');assert.equal(session.getSnapshot().remote?.content,'peer');
});
