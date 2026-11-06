import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import {normalizeCanvasNodeCapabilityData, getCanvasNodeCapabilities, canConnectCanvasNodes} from '../src/core/canvas/nodeCapabilities.ts';
import {compileCanvasGenerationInputs} from '../src/core/canvas/generationInputCompiler.ts';
import {hydrateNotePreviews, noteBodyText, notePreviewText} from '../src/core/canvas/notePreview.ts';
const source = readFileSync(new URL('../src/CanvasSpike.tsx', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
const controls = readFileSync(new URL('../src/features/canvas/CanvasComfyUiControls.tsx', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
const popover = readFileSync(new URL('../src/features/canvas/CanvasComfyPopover.tsx', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
test('dedicated creation entries and locked source keep API composer separate (source contract)', () => {
  assert.match(source, /generationSource: "online" \| "comfyui" = "online"/);
  assert.match(source, /label: generationSource === "comfyui" \? "ComfyUI生成"/);
  assert.equal((source.match(/true, "generate", "comfyui"/g) || []).length, 3);
  assert.match(source, /connectMenuContentKind === "text" \|\| connectMenuContentKind === "note"/);
  assert.match(source, /<CanvasComfyUiControls\b[^>]*\bconfig=\{comfyConfig\}/);
  assert.match(source, /<CanvasComfyUiImageControls\b[^>]*\bconfig=\{comfyConfig\}/);
  assert.doesNotMatch(controls, /onChange\(\{source:/);
  assert.match(source, /const update=\(\{source: _source,\.\.\.parameters\}/);
  assert.match(source, /!task\.request\.comfyui && bridge\?\.aiImageGenerate/);
});
test('Comfy cards preserve text/note input and video output after JSON restore', () => {
  const node=normalizeCanvasNodeCapabilityData({kind:'generator', generationKind:'video', generationSource:'comfyui', generationComfy:{megapixels:.6,seed:42}});
  const restored=JSON.parse(JSON.stringify(node));
  assert.equal(restored.generationSource,'comfyui');
  assert.equal(restored.generationComfy.megapixels,.6,'saved MP must not be rewritten to test preset');
  const capabilities=getCanvasNodeCapabilities(restored);
  assert.equal(capabilities.contentKind,'video');
  assert.equal(capabilities.canOutput,true);
  assert.equal(canConnectCanvasNodes({kind:'text'},restored),true);
  assert.equal(canConnectCanvasNodes({kind:'noteRef'},restored),true);
  assert.equal(canConnectCanvasNodes(restored,{kind:'text'}),true);
});

test('the actual addNode initializer preserves local source, edited values and pinned history workflow',()=>{
  const factoryStart=source.indexOf('  const addNode = useCallback(');
  const start=source.indexOf('normalizeCanvasNodeCapabilityData({',factoryStart);
  const end=source.indexOf('\n    });\n    if (recoveredHistory)',start);
  assert.ok(factoryStart>=0&&start>factoryStart&&end>start,'production initializer is present');
  const require=createRequire(import.meta.url);
  const esbuild=require(path.join(process.env.TEST_DEPS_ROOT||path.join(process.cwd(),'node_modules'),'esbuild'));
  const code=esbuild.transformSync(source.slice(start,end)+'\n    })',{loader:'ts'}).code;
  const preset={generationKind:'video',generationSource:'comfyui',generationComfy:{megapixels:.2,seed:42,videoSteps:6,audioSteps:8},generationComfyWorkflow:{baseUrl:'http://127.0.0.1:8188',workflow:{'234':{class_type:'PrimitiveStringMultiline',inputs:{value:'Synthetic'}}}}};
  const before=JSON.stringify(preset);
  const initialize=value=>JSON.parse(JSON.stringify(vm.runInNewContext(code,{normalizeCanvasNodeCapabilityData,label:'ComfyUI生成',kind:'generator',preset:value,provenance:null,recoveredHistory:null,recoveredDraft:null})));
  const actual=initialize(preset);
  assert.equal(actual.generationSource,'comfyui');
  assert.deepEqual(actual.generationComfy,preset.generationComfy);
  assert.deepEqual(actual.generationComfyWorkflow,preset.generationComfyWorkflow);
  assert.equal(JSON.stringify(preset),before);
  assert.equal(initialize({generationKind:'video',generationSource:'online'}).generationSource,'online');
});
test('linked text/note body feeds compiled prompt without replacing explicit prompt', () => {
  const result=compileCanvasGenerationInputs({kind:'video',prompt:'一只小纸船漂浮。', references:[{id:'n',kind:'note',role:'promptContext',label:'Not a body',text:'水面平静，镜头缓慢跟随。'}]});
  assert.ok(result.prompt.startsWith('一只小纸船漂浮。'));
  assert.match(result.prompt,/水面平静，镜头缓慢跟随。/);
  assert.doesNotMatch(result.prompt,/Not a body/);
});
test('returning to a retained canvas refreshes linked note bodies without polling or applying hidden reads', async () => {
  const start=source.indexOf('  const noteReferenceKey=');
  const end=source.indexOf('\n  const updateNodeLabel',start);
  assert.ok(start>=0&&end>start,'production note hydration hooks are present');
  const require=createRequire(import.meta.url);
  const esbuild=require(path.join(process.env.TEST_DEPS_ROOT||path.join(process.cwd(),'node_modules'),'esbuild'));
  const code=esbuild.transformSync(source.slice(start,end),{loader:'ts'}).code;
  let document={title:'Synthetic note',contentText:'Before editing',updatedAt:'1'},reads=0,dirty=0,pending;
  const nodesRef={current:[{id:'note-node',data:{kind:'noteRef',payload:'note:synthetic'}}]};
  const effects=[];
  let effectIndex=0;
  const env={nodesRef,canvasVisibleRef:{current:true},canvasLoadEpochRef:{current:1},currentCanvasIdRef:{current:'canvas'},currentCanvasId:'canvas',loadingCanvas:false,
    bridge:{getNote:async()=>{reads++;return pending?await pending:document;}},hydrateNotePreviews,noteBodyText,notePreviewText,
    parseCanvasReference:payload=>({kind:'note',id:payload.slice(5)}),setNodes:nodes=>{nodesRef.current=nodes;},markDirty:()=>dirty++,
    window:{addEventListener(){},removeEventListener(){}},useMemo:fn=>fn(),useState:()=>[0,()=>{}],
    useEffect:(fn,deps)=>{const i=effectIndex++,previous=effects[i];if(previous&&deps.length===previous.deps.length&&deps.every((v,j)=>Object.is(v,previous.deps[j])))return;previous?.cleanup?.();effects[i]={deps,cleanup:fn()};}};
  const render=visible=>{effectIndex=0;env.canvasVisibleRef.current=visible;vm.runInNewContext(`(()=>{${code}})()`,{...env,nodes:nodesRef.current,visible});};
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  render(true);await settle();
  assert.equal(nodesRef.current[0].data.refContextText,'Before editing');
  render(false);document={...document,contentText:'After editing',updatedAt:'2'};await settle();
  assert.equal(reads,1,'hidden canvas does not reread documents');
  render(true);await settle();
  assert.equal(nodesRef.current[0].data.refContextText,'After editing');
  render(true);await settle();assert.equal(reads,2,'unchanged visible render does not poll');
  render(false);pending=new Promise(resolve=>{env.resolveRead=resolve;});render(true);render(false);
  env.resolveRead({...document,contentText:'Late hidden result'});await settle();
  assert.equal(nodesRef.current[0].data.refContextText,'After editing');
  assert.equal(dirty,2,'only actual body changes are saved');
});
test('compiled prompt remains used for requests without the removed diagnostic preview; template cannot overwrite text', () => {
  assert.doesNotMatch(source, /<pre>\{compiledRequest.prompt\}<\/pre>/);
  assert.match(source, /!!compiledRequest.prompt.trim\(\)/);
  assert.match(source, /if \(!node.data.generationPrompt\?\.trim\(\)\) commit\(\{generationPrompt:/);
  assert.match(source,/disabled=\{busy \|\| !!node.data.generationPrompt\?\.trim\(\)\}/);
  assert.match(source,/overall_soundscape:/);
  assert.match(source,/non_diegetic_music:/);
});
test('outside dismissal preserves pointer target until click and commits the focused draft first',()=>{
  // Controls now share the portalled popover; exercise its production close and
  // listener code rather than the retired in-flow expanded panel.
  const start=popover.indexOf('  const close = (focus = false) => {');
  const end=popover.indexOf('\n  return <div ref={root}',start);
  assert.ok(start>=0&&end>start,'production shared popover dismissal is present');
  const require=createRequire(import.meta.url);
  const esbuild=require(path.join(process.env.TEST_DEPS_ROOT||path.join(process.cwd(),'node_modules'),'esbuild'));
  const code=esbuild.transformSync(popover.slice(start,end),{loader:'ts'}).code;
  class Element{};
  const input=new Element(),button=new Element(),listeners=new Map();
  let open=true,saved=false;
  input.blur=()=>{saved=true;};
  const cleanup=vm.runInNewContext(`(()=>{const cleanups=[];const useEffect=fn=>{const c=fn();if(c)cleanups.push(c);};${code};return()=>cleanups.forEach(c=>c());})()`,{
    open:true,disabled:false,Node:Element,HTMLElement:Element,root:{current:{contains:target=>target===input}},portal:{current:null},panel:{current:{contains:target=>target===input}},anchor:{current:null},
    document:{activeElement:input,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)},group:{setActive:value=>{open=value!==null;}}
  });
  listeners.get('pointerdown')?.({target:button});
  assert.equal(open,true,'outside button keeps the same in-flow layout until its click');
  assert.equal(saved,false);
  listeners.get('click')?.({target:button});
  assert.equal(saved,true,'the final numeric draft commits before the outside click handler');
  assert.equal(open,false);
  cleanup();assert.equal(listeners.size,0);
});
test('template placeholders block request creation and Comfy footer does not repeat workflow (source contract)', () => {
  const snapshot=source.slice(source.indexOf('function createGenerationRequestSnapshot('));
  assert.match(snapshot,/generationSource === "comfyui" && \/<\(\?:填写主体/);
  assert.match(snapshot,/throw Error\("请先填写提示词模板中的占位内容/);
  assert.match(source,/: !isComfy \? <span className="canvas-composer-text-count">/);
  assert.doesNotMatch(source,/title=\{isComfy \? summary : undefined\}/);
});
