import test from 'node:test';
import assert from 'node:assert/strict';
import {createInstallSession, parseInstallStatus} from '../src/core/services/desktopUpdateInstall.ts';

function status(revision, phase='idle') {
  return {revision,phase,version: ['available','ready','downloading'].includes(phase)?'2.0.0':null,
    downloadedBytes:0,totalBytes:null,errorCode:null,canCheck:phase==='idle',
    canDownload:phase==='available',canCancel:phase==='downloading',canInstall:phase==='ready'};
}
function fixture(initial=status(1)) {
  let emit; const calls=[]; let responder=async()=>initial;
  const session=createInstallSession({request(op){calls.push(op);return responder(op);},
    async subscribe(fn){emit=fn;return()=>{emit=undefined;};}});
  return {session,calls,emit:value=>emit?.(value),respond:fn=>{responder=fn;}};
}
test('rejects malformed status and impossible install capability',()=>{
  for(const raw of [null,{}, {...status(1),revision:-1}, {...status(1),canInstall:true},
    {...status(1,'ready'),version:null}, {...status(1),downloadedBytes:4,totalBytes:3}])
    assert.throws(()=>parseInstallStatus(raw));
});
test('snapshot cannot overwrite a newer event',async()=>{
  const f=fixture(); let resolve; f.respond(()=>new Promise(r=>resolve=r));
  const connected=f.session.connect(); await Promise.resolve();
  f.emit(status(3,'ready'));resolve(status(2));await connected;
  assert.equal(f.session.snapshot().status.phase,'ready');
});
test('checking never automatically downloads or installs',async()=>{
  const f=fixture();await f.session.connect();f.respond(async()=>status(2,'available'));
  await f.session.action('check');assert.deepEqual(f.calls,['status','check']);
});
test('repeated clicks share operation and cancel can overtake download',async()=>{
  const f=fixture(status(1,'available'));await f.session.connect();let finish;
  f.respond(op=>op==='download'?new Promise(r=>finish=r):Promise.resolve(status(4,'cancelled')));
  const a=f.session.action('download'),b=f.session.action('download');assert.equal(a,b);
  f.emit(status(2,'downloading'));await f.session.action('cancel');
  finish(status(3,'ready'));await a;
  assert.equal(f.session.snapshot().status.phase,'cancelled');
  assert.equal(f.calls.filter(x=>x==='download').length,1);
});
test('cannot install while downloading or unverified',async()=>{
  const f=fixture(status(1,'downloading'));await f.session.connect();
  await assert.rejects(f.session.action('install'));assert.deepEqual(f.calls,['status']);
});
test('transport error cannot leave enabled install controls',async()=>{
  const f=fixture(status(1,'ready'));await f.session.connect();f.respond(async()=>{throw Error('offline');});
  await assert.rejects(f.session.action('install'));await assert.rejects(f.session.action('install'));
  assert.equal(f.calls.filter(x=>x==='install').length,1);
  assert.equal(f.session.snapshot().connectionError,'update-connection-failed');
});
test('remount subscription preserves snapshot without new operation',async()=>{
  const f=fixture(status(1,'ready'));await f.session.connect();const off=f.session.subscribe(()=>{});off();
  await f.session.connect();assert.equal(f.calls.length,1);assert.equal(f.session.snapshot().status.phase,'ready');
});
test('disposal prevents late network result and disconnects listener',async()=>{
  const f=fixture();let resolve;f.respond(()=>new Promise(r=>resolve=r));
  const p=f.session.connect();await Promise.resolve();f.session.dispose();resolve(status(4,'ready'));await p;
  assert.equal(f.session.snapshot().status,null);
});

test('reconnect restores subscription after an initial subscription failure',async()=>{
  let attempts=0, emit;
  const session=createInstallSession({request:async()=>status(1),subscribe:async(fn)=>{
    if(++attempts===1)throw Error('offline');emit=fn;return()=>{};
  }});
  await session.connect();assert.ok(session.snapshot().connectionError);
  await session.reconnect();assert.equal(attempts,2);
  emit(status(2,'downloading'));assert.equal(session.snapshot().status.phase,'downloading');
});
test('scheduled installation remains cancellable without starting another install',()=>{
  const value=parseInstallStatus({...status(5),phase:'scheduled',version:'2.0.0',canCheck:false,canCancel:true});
  assert.equal(value.canInstall,false);assert.equal(value.canCancel,true);
});

test('verified update can explicitly restart now and duplicate clicks share one request',async()=>{
  const f=fixture(status(1,'ready'));await f.session.connect();let finish;
  f.respond(()=>new Promise(resolve=>{finish=resolve;}));
  const first=f.session.action('restart'),second=f.session.action('restart');
  assert.equal(first,second);
  assert.deepEqual(f.calls,['status','restart']);
  finish({...status(2),phase:'preparing',version:'2.0.0',canCheck:false});
  await first;
  await assert.rejects(f.session.action('restart'));
});
