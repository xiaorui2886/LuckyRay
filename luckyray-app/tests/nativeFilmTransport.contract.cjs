const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
(async()=>{
 const built=await esbuild.build({entryPoints:[root+'/src/features/materials/nativeFilmTransport.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{name:'invoke-fixture',setup(b){b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'host',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export const invoke=(name,args)=>globalThis.host(name,args);'}));}}]});
 const calls=[];let unblock;const first=new Promise(r=>unblock=r);let hold=true;
 const sandbox={module:{exports:{}},crypto:globalThis.crypto,atob,host:async(_,args)=>{calls.push(args.request);if(hold){hold=false;await first;}return args.request.op==='capture'?{time:5,png:''}:{time:5,paused:true};}};
 vm.runInNewContext(built.outputFiles[0].text,sandbox);
 const errors=[],p=new sandbox.module.exports.NativeFilmTransport(e=>errors.push(e));
 const opening=p.open('library-a','asset-a','revision-a',{x:0,y:0,width:640,height:360});
 await new Promise(r=>setImmediate(r));
 for(let i=0;i<200;i++)p.currentTime=i/10;
 p.pause(); // a barrier: the first final seek must stay before this pause
 for(let i=200;i<400;i++)p.currentTime=i/10;
 const play=p.play();unblock();await opening;await play;
 assert.deepEqual(calls.filter(c=>c.action?.op==='seek').map(c=>c.action.seconds),[19.9,39.9]);
 assert.deepEqual(calls.filter(c=>c.op==='control').map(c=>c.action.op),['seek','pause','seek','play']);
 assert.equal(errors.length,0);
 // Real scrubbing interleaves layout updates with locator movement. Continuous
 // controls must coalesce across each other, not only when strictly adjacent.
 const mixed=[];
 for(let i=0;i<300;i++){
  p.currentTime=i/100;
  mixed.push(p.bounds({x:i,y:0,width:640,height:360}).catch(e=>errors.push(e)));
 }
 await Promise.all(mixed);await p.snapshot();
 assert.equal(errors.length,0,'mixed seek/bounds must not exhaust the queue');
 assert.equal(calls.filter(c=>c.action?.op==='seek').at(-1).action.seconds,2.99);
 // A snapshot already in flight must not revert a newer local seek/pause/play.
 let releaseSnapshot;const captured=new Promise(r=>releaseSnapshot=r);
 const normalHost=sandbox.host;
 sandbox.host=async(name,args)=>{if(args.request.op==='snapshot'){await captured;return{time:0,paused:true};}return normalHost(name,args)};
 const stale=p.snapshot();await new Promise(r=>setImmediate(r));
 p.currentTime=8;const newerPlay=p.play();
 assert.equal(p.paused,false,'play intent must change before acknowledgement');
 releaseSnapshot();const observed=await stale;await newerPlay;
 assert.equal(observed.time,8,'old snapshot cannot rewind pending seek');
 assert.equal(observed.paused,false,'old snapshot cannot undo pending play');
 sandbox.host=normalHost;
 const pending=p.bounds({x:3,y:4,width:640,height:360});
 const final=p.bounds({x:8,y:9,width:800,height:450});await pending;await final;
 assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).bounds)),{x:8,y:9,width:800,height:450});
 await p.play();const capture=p.capture();assert.equal(p.paused,true,'capture immediately conveys native pause intent');await capture;
 p.close();await new Promise(r=>setImmediate(r));assert.equal(calls.at(-1).op,'close');
 await assert.rejects(p.snapshot(),/session-closed/);
 assert.ok(calls.every(c=>c.session===calls[0].session));
 console.log('NATIVE TRANSPORT PASS: 400 seeks / 2 ordering segments; 300 mixed seek+bounds updates without overflow; stale snapshot cannot undo seek/play intent; final resize, same-token close, closed-session rejection. IPC fixture only.');
})().catch(e=>{console.error(e);process.exitCode=1;});
