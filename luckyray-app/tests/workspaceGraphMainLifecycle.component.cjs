// Runs the actual transpiled production component with controlled hooks and promises.
// Effect replay below is a lifecycle simulation, not a React StrictMode browser test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const settle = async () => { for(let i=0;i<40;i++) await Promise.resolve(); };
const lease = {leaseToken:'a'.repeat(64),expiresInMs:30000};
function harness(command) {
  let effect, states=[], index=0; const intervals=new Map(), calls=[], opened=[];
  const react={useEffect:f=>{effect=f;},useRef:v=>({current:v}),useState:v=>{const n=index++;if(!(n in states))states[n]=v;return [states[n],next=>{states[n]=typeof next==='function'?next(states[n]):next;}];}};
  const modules={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'../app/applicationModalIsolation':{useApplicationModalSurface:()=>({})},'./windowLifecycle':{registerWorkspaceFlush:()=>()=>{}},'@tauri-apps/api/event':{listen:async()=>()=>{}},'./nativeClient':{workspaceCommand:r=>{calls.push(r);return command(r);}},'../core/services/knowledgeSource':{readActiveKnowledgeSource:()=>null}};
  const cache={};const load=name=>{if(modules[name])return modules[name];if(name==='./nativeGraphMainProtocol'){if(cache[name])return cache[name]; const filename=path.join(__dirname,'../src/workspace',name+'.ts');return cache[name]=compile(filename);}return {};};
  const context={console,TextEncoder,Uint8Array,Blob,performance,setTimeout,clearTimeout,setInterval:(f,ms)=>{const id={};intervals.set(id,{f,ms});return id;},clearInterval:id=>intervals.delete(id)};
  function compile(filename){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{...context,module,exports:module.exports,require:load},{filename});return module.exports;}
  const Component=compile(path.join(__dirname,'../src/workspace/WorkspaceGraphMainActions.tsx')).WorkspaceGraphMainActions;
  const render=()=>{index=0;return Component({openDocument:async v=>opened.push(v)});};
  return {calls,opened,states,render,mount:()=>{render();return effect();},tick:async ms=>{for(const x of [...intervals.values()])if(x.ms===ms)x.f();await settle();}};
}
test('unmount waits for in-flight registration before clearing the advertised services',async()=>{
 const first=deferred();let backend=[];const h=harness(async r=>{if(r.op==='graphMainRegister'){if(r.kinds.length)await first.promise;backend=r.kinds;return lease;}return [];});const stop=h.mount();await settle();stop();await settle();first.resolve();await settle();assert.equal(backend.length,0);
});
test('old cleanup cannot overtake a replacement mount registration',async()=>{
 const cleanup=deferred();let backend=[];const h=harness(async r=>{if(r.op==='graphMainRegister'){if(!r.kinds.length&&backend.length)await cleanup.promise;backend=r.kinds;return lease;}return [];});const stop=h.mount();await settle();stop();const stopNew=h.mount();await settle();cleanup.resolve();await settle();assert.equal(backend.length,7);stopNew();await settle();
});
test('execute resolving after unmount cannot open a native document or send completion',async()=>{
 const execution=deferred();let offers=true;const h=harness(async r=>{if(r.op==='graphMainRegister')return lease;if(r.op==='graphMainPending'){const next=offers?[{id:'b'.repeat(64)}]:[];offers=false;return next;}if(r.op==='graphMainClaim')return {id:r.id,claimToken:'c'.repeat(64),remainingMs:10000,action:{kind:'openDocument',vaultId:'v',title:'n'}};if(r.op==='graphMainExecute')return execution.promise;return undefined;});const stop=h.mount();await settle();assert.ok(h.calls.some(r=>r.op==='graphMainExecute'));stop();execution.resolve({kind:'openView',view:{id:'document'}});await settle();assert.equal(h.opened.length,0);assert.equal(h.calls.filter(r=>r.op==='graphMainComplete').length,0);
});
test('confirmed registration recovery clears its service alert',async()=>{
 let attempt=0;const h=harness(async r=>{if(r.op==='graphMainRegister'){if(r.kinds.length&&++attempt===1)throw Error('registration-offline');return lease;}return [];});const stop=h.mount();await settle();assert.match(JSON.stringify(h.render()),/registration-offline/);await h.tick(10000);assert.doesNotMatch(JSON.stringify(h.render()),/registration-offline/);stop();await settle();
});
test('a rejected registration does not poison cleanup and next generation',async()=>{
 const first=deferred();let attempts=0,backend=[];const h=harness(async r=>{if(r.op==='graphMainRegister'){if(r.kinds.length&&++attempts===1)await first.promise;backend=r.kinds;return lease;}return [];});const stop=h.mount();await settle();stop();const stopNew=h.mount();first.reject(Error('offline'));await settle();assert.equal(backend.length,7);assert.doesNotMatch(JSON.stringify(h.render()),/offline/);stopNew();await settle();
});
test('late renewal is ordered before cleanup and next generation',async()=>{
 const renewal=deferred();let attempts=0,backend=[],inFlight=0,maxInFlight=0;const h=harness(async r=>{if(r.op==='graphMainRegister'){inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);if(r.kinds.length&&++attempts===2)await renewal.promise;backend=r.kinds;inFlight--;return lease;}return [];});const stop=h.mount();await settle();await h.tick(10000);stop();const stopNew=h.mount();await settle();assert.equal(maxInFlight,1);renewal.resolve();await settle();assert.equal(maxInFlight,1);assert.equal(backend.length,7);stopNew();await settle();
});
test('pending response after unmount is fenced and polling cannot overlap',async()=>{
 const pending=deferred();const h=harness(async r=>r.op==='graphMainRegister'?lease:r.op==='graphMainPending'?pending.promise:undefined);const stop=h.mount();await settle();await h.tick(1500);await h.tick(1500);assert.equal(h.calls.filter(r=>r.op==='graphMainPending').length,1);stop();pending.resolve([{id:'b'.repeat(64)}]);await settle();assert.equal(h.calls.filter(r=>r.op==='graphMainClaim').length,0);
});
test('pending recovery clears only pending error, preserving failed operations',async()=>{
 let polls=0;const h=harness(async r=>{if(r.op==='graphMainRegister')return lease;if(r.op==='graphMainPending'){if(++polls===1)throw Error('poll-offline');return polls===2?[{id:'b'.repeat(64)}]:[];}if(r.op==='graphMainClaim')throw Error('operation-failed');return undefined;});const stop=h.mount();await settle();assert.match(JSON.stringify(h.render()),/poll-offline/);await h.tick(1500);assert.doesNotMatch(JSON.stringify(h.render()),/poll-offline/);assert.match(JSON.stringify(h.render()),/operation-failed/);await h.tick(10000);await h.tick(1500);assert.match(JSON.stringify(h.render()),/operation-failed/);stop();await settle();
});
test('effect setup-cleanup-setup replay leaves one live registered generation',async()=>{
 let backend=[];const h=harness(async r=>{if(r.op==='graphMainRegister'){backend=r.kinds;return lease;}return [];});const stop=h.mount();stop();const stopNew=h.mount();await settle();assert.equal(backend.length,7);assert.equal(h.calls.filter(r=>r.op==='graphMainPending').length,1);stopNew();await settle();assert.equal(backend.length,0);
});
test('claim resolving after unmount cannot validate or execute',async()=>{
 const claim=deferred();const h=harness(async r=>{if(r.op==='graphMainRegister')return lease;if(r.op==='graphMainPending')return [{id:'b'.repeat(64)}];if(r.op==='graphMainClaim')return claim.promise;});const stop=h.mount();await settle();stop();claim.resolve({id:'b'.repeat(64),claimToken:'c'.repeat(64),remainingMs:10000,action:{kind:'openDocument',vaultId:'v',title:'n'}});await settle();assert.equal(h.calls.filter(r=>['graphMainValidate','graphMainExecute','graphMainComplete'].includes(r.op)).length,0);
});
test('validation resolving after unmount cannot execute',async()=>{
 const validation=deferred();const h=harness(async r=>{if(r.op==='graphMainRegister')return lease;if(r.op==='graphMainPending')return [{id:'b'.repeat(64)}];if(r.op==='graphMainClaim')return {id:r.id,claimToken:'c'.repeat(64),remainingMs:10000,action:{kind:'openDocument',vaultId:'v',title:'n'}};if(r.op==='graphMainValidate')return validation.promise;});const stop=h.mount();await settle();stop();validation.resolve();await settle();assert.equal(h.calls.filter(r=>['graphMainExecute','graphMainComplete'].includes(r.op)).length,0);
});
test('failed cleanup cannot poison the next owner registration',async()=>{
 let backend=[],cleanups=0;const h=harness(async r=>{if(r.op==='graphMainRegister'){if(!r.kinds.length&&++cleanups===2)throw Error('cleanup-offline');backend=r.kinds;return lease;}return [];});const stop=h.mount();await settle();stop();const stopNew=h.mount();await settle();assert.equal(backend.length,7);assert.equal(h.calls.filter(r=>r.op==='graphMainPending').length,2);stopNew();await settle();
});
test('successful empty pending response recovers the polling service alert',async()=>{
 let polls=0;const h=harness(async r=>{if(r.op==='graphMainRegister')return lease;if(r.op==='graphMainPending'&&++polls===1)throw Error('poll-offline');return [];});const stop=h.mount();await settle();assert.match(JSON.stringify(h.render()),/poll-offline/);await h.tick(1500);assert.doesNotMatch(JSON.stringify(h.render()),/poll-offline/);stop();await settle();
});
test('failed retirement is retried before successor may reuse the handler set',async()=>{
 let token=0,registered=[],held=null,cleanups=0;const h=harness(async r=>{
  if(r.op==='graphMainRegister'){
   if(!r.kinds.length&&++cleanups===2)throw Error('cleanup-offline');
   if(JSON.stringify(registered)!==JSON.stringify(r.kinds)){if(held&&held.result===null)held.result='retired';token++;}registered=r.kinds;return {leaseToken:token.toString(16).padStart(64,'0'),expiresInMs:30000};
  }
  if(r.op==='graphMainPending')return held?[]:[{id:'b'.repeat(64)}];
  if(r.op==='graphMainClaim'){held={result:null};return new Promise(()=>{});}
 });const stop=h.mount();await settle();assert.ok(held);stop();const stopNew=h.mount();await settle();assert.equal(held.result,'retired');assert.equal(registered.length,7);assert.equal(cleanups,3);stopNew();await settle();
});
test('persistent cleanup failure fails closed until confirmed retirement recovers',async()=>{
 let deny=false,registrations=0;const h=harness(async r=>{if(r.op==='graphMainRegister'){if(!r.kinds.length&&deny)throw Error('retirement-offline');if(r.kinds.length)registrations++;return lease;}return [];});const stop=h.mount();await settle();deny=true;stop();const stopNew=h.mount();await settle();assert.equal(registrations,1);assert.match(JSON.stringify(h.render()),/retirement-offline/);deny=false;await h.tick(10000);assert.equal(registrations,2);assert.doesNotMatch(JSON.stringify(h.render()),/retirement-offline/);stopNew();await settle();
});
test('fresh Main realm retires an inherited broker lease before advertising services',async()=>{
 let retired=false;const h=harness(async r=>{if(r.op==='graphMainRegister'){if(!r.kinds.length)retired=true;else assert.equal(retired,true);return lease;}return [];});const stop=h.mount();await settle();assert.equal(h.calls[0].op,'graphMainRegister');assert.equal(h.calls[0].kinds.length,0);assert.ok(h.calls.some(r=>r.op==='graphMainPending'));stop();await settle();
});
