const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.SOURCE_ROOT || process.cwd();
const ts = require(process.env.TYPESCRIPT_PATH || require.resolve('typescript', { paths: [root] }));
const source = fs.readFileSync(path.join(root, 'src/CanvasSpike.tsx'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('  const recognizeCanvasFocusPoint = useCallback(');
const end = source.indexOf('\n  useEffect(() => {\n    if (!focusSession)', start);
const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const stopStart = source.indexOf('  const stopCanvasFocus = useCallback(');
const stopEnd = source.indexOf('\n  useEffect(', stopStart);
const stopCode = ts.transpileModule(source.slice(stopStart, stopEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(profile) {
  let callOptions, finish, timer, writes = 0, revoked = 0;
  const status = [];
  const session = { targetId: 'target', canvasId: 'canvas', epoch: 1, bindingKey: 'binding', model: 'synthetic', ...(profile ? { profileId: 'profile', profileRevision: 1 } : {}) };
  const complete = async (_messages, options) => { callOptions = options; return new Promise(resolve => finish = resolve); };
  const env = {
    useCallback: fn => fn, AbortController, Blob,
    focusSessionRef: { current: session }, focusBusyRef: { current: false }, focusRequestRef: { current: 0 }, focusAbortRef: { current: null }, focusPointerRef: {current:null}, setFocusSession() {},
    nodesRef: { current: [{id:'target',data:{}},{id:'image',data:{url:'synthetic.png'}}] }, edgesRef: { current: [] },
    currentCanvasIdRef: { current:'canvas' }, canvasLoadEpochRef: { current:1 }, focusTextBindingRef: { current:'binding' },
    splitImageSource: data => data.url, setFocusStatus: s => status.push(s), setFocusBusy() {},
    window: { getComputedStyle: () => ({objectPosition:'50% 50%', objectFit:'contain'}), setTimeout: fn => {timer=fn; return 1;}, clearTimeout() {} },
    normalizeCanvasFocusPoint: () => ({x:0.5,y:0.5}), getCanvasNodeCapabilities: () => ({composerMode:'contextual'}),
    readMediaBytes: async () => new Uint8Array([1]), resolveCanvasMediaUrl: s => s,
    URL: { createObjectURL: () => 'blob:synthetic', revokeObjectURL: () => revoked++ },
    Image: class { naturalWidth=100; naturalHeight=100; async decode() {} },
    prepareCanvasFocusImage: () => ({dataUrl:'data:image/png;base64,AQ=='}), buildCanvasFocusMessages: () => [],
    completeCanvasProfileText: (_id,_revision,m,o) => complete(m,o), bridge: {aiChatComplete:complete},
    locale:'zh-CN', activeMediaProfile:null, commitHistory() {writes++;}, markDirty() {writes++;},
    setNodes() {writes++;}, setEdges() {writes++;}, sanitizeCanvasFocusPhrase: s => s,
    genEdgeId:()=> 'edge', applyFocusReference: ({nodes,edges,phrase}) => ({nodes:nodes.map(n=>n.id==='target'?{...n,data:{...n.data,prompt:phrase}}:n),edges,edgeId:'edge'}),
    createCanvasReferencePlan:()=>[], inferGenerationKind:()=> 'image', resolveStoredCanvasReferences:()=>[],
  };
  const run = Function(...Object.keys(env), code+';return recognizeCanvasFocusPoint;')(...Object.values(env));
  const stop = Function(...Object.keys(env), stopCode+';return stopCanvasFocus;')(...Object.values(env));
  return { env, run, stop, options:()=>callOptions, finish:v=>finish(v), timeout:()=>timer(), writes:()=>writes, revoked:()=>revoked, status };
}
for (const profile of [false,true]) for (const mode of ['exit','timeout']) test(`${profile?'profile':'legacy'} focus ${mode} passes abort signal and never writes late results`,async()=>{
  const h=harness(profile);
  const promise=h.run({clientX:1,clientY:1},'image',{complete:true,naturalWidth:100,naturalHeight:100,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})});
  for(let i=0;i<6;i++) await Promise.resolve();
  const signal=h.options()?.signal;
  assert.ok(signal instanceof AbortSignal, 'actual completion options must carry focus abort signal');
  assert.equal(signal.aborted,false);
  if(mode==='exit') h.stop();
  else h.timeout();
  assert.equal(signal.aborted,true);
  h.finish({success:true,content:'late synthetic object'});
  await promise;
  assert.equal(h.writes(),0); assert.equal(h.revoked(),1);
  if(mode==='timeout')assert.ok(h.status.some(s=>s.includes('超时')));
});
test('focus handler remains connected to actual image interaction and toolbar',()=>{
  assert.ok(source.includes('void recognizeCanvasFocusPoint(event, nodeId, image,'));
  assert.ok(source.includes('onToggleFocus={() => toggleCanvasFocus(selectedNode.id)}'));
});
for (const profile of [false,true]) test(`${profile?'profile':'legacy'} focus success still commits returned object`,async()=>{
  const h=harness(profile);
  const promise=h.run({clientX:1,clientY:1},'image',{complete:true,naturalWidth:100,naturalHeight:100,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})});
  for(let i=0;i<6;i++)await Promise.resolve();
  assert.equal(h.options().model,'synthetic');
  h.finish({success:true,content:'synthetic object'});
  await promise;
  assert.equal(h.env.nodesRef.current.find(n=>n.id==='target').data.prompt,'synthetic object');
  assert.equal(h.writes(),4);assert.equal(h.revoked(),1);
  assert.equal(h.env.focusAbortRef.current,null);assert.equal(h.env.focusBusyRef.current,false);
  assert.ok(h.status.includes('已加入：synthetic object'));
});
for (const profile of [false,true]) test(`${profile?'profile':'legacy'} native timeout keeps its existing timeout feedback without writes`,async()=>{
  const h=harness(profile);
  const promise=h.run({clientX:1,clientY:1},'image',{complete:true,naturalWidth:100,naturalHeight:100,getBoundingClientRect:()=>({left:0,top:0,width:100,height:100})});
  for(let i=0;i<6;i++)await Promise.resolve();
  h.finish({success:false,error_kind:'timeout'});
  await promise;
  assert.equal(h.writes(),0);assert.equal(h.revoked(),1);
  assert.ok(h.status.includes('识别超时，请重新点击。'));
  assert.equal(h.status.some(s=>s.includes('模型支持图片')),false);
  assert.equal(h.env.focusBusyRef.current,false);
});
