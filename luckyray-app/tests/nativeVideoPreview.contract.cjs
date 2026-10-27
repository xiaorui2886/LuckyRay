// Queue priority is tested with held IPC jobs, no decoder/profile/user media.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
(async()=>{
 const built=await esbuild.build({entryPoints:[root+'/src/features/materials/nativeVideoPreview.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'host',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(n,a)=>globalThis.host(n,a);'}));}}]});
 const calls=[],pending=[];const sandbox={module:{exports:{}},crypto:globalThis.crypto,setTimeout,clearTimeout,AbortController,host:async(_,a)=>new Promise(resolve=>{calls.push(a.request);pending.push(resolve)})};
 vm.runInNewContext(built.outputFiles[0].text,sandbox);const api=sandbox.module.exports,signal=new AbortController().signal;
 const a=api.nativeVideoMetadata('L','active-a',signal),b=api.nativeVideoMetadata('L','active-b',signal);
 const background=api.nativeVideoMetadata('L','background',signal);
 const foreground=api.nativeVideoMetadata('L','viewer',signal,true);
 assert.deepEqual(calls.map(x=>x.assetId),['active-a','active-b']);
 pending.shift()({sourceRevision:'r'});await a;await new Promise(r=>setImmediate(r));
 assert.equal(calls.at(-1).assetId,'viewer','viewer metadata overtakes queued covers');
 pending.shift()({});await b;await new Promise(r=>setImmediate(r));
 assert.equal(calls.at(-1).assetId,'background');
 pending.shift()({});pending.shift()({});await Promise.all([foreground,background]);
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(api.nativeVideoMetadata('L','cancelled',cancelled.signal,true),/cancelled/);
 assert.equal(calls.length,4);assert.ok(calls.every(x=>x.libraryId==='L'));
 console.log('NATIVE PREVIEW QUEUE PASS foreground priority, two active jobs, no starvation after viewer, cancellation and library scope retained. IPC fixture only.');
})().catch(e=>{console.error(e);process.exitCode=1});
