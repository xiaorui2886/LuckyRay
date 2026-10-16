// Controlled boundary promises exercise the actual production component.
// This hook harness is not a substitute for the actual Main layout sampling.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
function harness(command){
 let effect,index=0,flush;const states=[],intervals=new Map(),updates=[];
 const react={useEffect:f=>{effect=f;},useRef:v=>({current:v}),useState:v=>{const n=index++;if(!(n in states))states[n]=v;return [states[n],next=>{states[n]=typeof next==='function'?next(states[n]):next;updates.push({n,value:states[n]});}];}};
 const modules={react,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},'../app/applicationModalIsolation':{useApplicationModalSurface:()=>({})},'./windowLifecycle':{registerWorkspaceFlush:f=>{flush=f;return()=>{};}},'@tauri-apps/api/event':{listen:async()=>()=>{}},'./nativeClient':{workspaceCommand:command}};
 function compile(file){const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:name=>modules[name]||(name==='./nativeNoteMainProtocol'?compile(path.join(__dirname,'../src/workspace/nativeNoteMainProtocol.ts')):{}),console,TextEncoder,performance,setTimeout,clearTimeout,setInterval:(f,ms)=>{const id={};intervals.set(id,{f,ms});return id;},clearInterval:id=>intervals.delete(id)},{filename:file});return module.exports;}
 const Component=compile(path.join(__dirname,'../src/workspace/WorkspaceNoteMainActions.tsx')).WorkspaceNoteMainActions;
 const render=()=>{index=0;return Component();};
 return {updates,render,flush:()=>flush(),mount:()=>{render();return effect();},tick:async ms=>{for(const v of intervals.values())if(v.ms===ms)v.f();await settle();}};
}
const hasStatus=h=>JSON.stringify(h.render()).includes('workspace-note-main-status');
test('empty polls and renewals never publish user-visible work, including pending IPC',async()=>{
 let pending=deferred();const h=harness(async r=>r.op==='noteMainPending'?pending.promise:undefined),stop=h.mount();
 try{await settle();assert.equal(hasStatus(h),false,'background request discovery must remain silent');pending.resolve([]);await settle();
  for(const interval of [1500,5000,1500]){pending=deferred();await h.tick(interval);assert.equal(hasStatus(h),false);pending.resolve([]);await settle();assert.equal(hasStatus(h),false);}
  assert.equal(h.updates.some(x=>x.n===2&&x.value===true),false,'no transient busy state between renders');
 }finally{stop();}
});
test('only a validated real claim publishes work; review and close protection remain',async()=>{
 const claim=deferred(),validation=deferred();let offered=false;const h=harness(async r=>{if(r.op==='noteMainPending'){if(offered)return [];offered=true;return [{id:'a'.repeat(64)}];}if(r.op==='noteMainClaim')return claim.promise;if(r.op==='noteMainValidate')return validation.promise;}),stop=h.mount();
 try{await settle();assert.equal(hasStatus(h),false);claim.resolve({id:'a'.repeat(64),claimToken:'b'.repeat(64),remainingMs:10000,action:{kind:'exportDocument',format:'markdown',title:'Synthetic',content:'synthetic'}});await settle();assert.equal(hasStatus(h),false);validation.resolve();await settle();
 assert.ok(h.updates.some(x=>x.n===2&&x.value===true));assert.match(JSON.stringify(h.render()),/导出当前笔记/);assert.equal(hasStatus(h),false,'modal review replaces the progress notice');assert.equal(await h.flush(),false,'real pending review blocks close');
 }finally{stop();await settle();}
});
