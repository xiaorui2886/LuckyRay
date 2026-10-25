const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<div id="root"></div>', { url: 'https://orb.invalid', pretendToBeVisual: true });
for (const key of ['window','document','HTMLElement','HTMLImageElement','Element','Node','Event','MouseEvent','KeyboardEvent','CustomEvent','StorageEvent','navigator']) Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
dom.window.HTMLCanvasElement.prototype.getContext=()=>null;
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react');
const {createRoot}=require('react-dom/client');
const appRoot=path.resolve(__dirname,'../../..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(appRoot,'node_modules/vite'))]}));
const bundle=esbuild.buildSync({stdin:{contents:`export {CanvasAgentOrb} from './CanvasAgentOrb';export {CanvasAgentOrbPositionSetting} from './CanvasAgentOrbPositionSetting';export * from './canvasAgentOrbPlacement';`,resolveDir:__dirname,loader:'tsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'}});
const loaded={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(loaded,loaded.exports,require);
const {CanvasAgentOrb,CanvasAgentOrbPositionSetting,ORB_PLACEMENT_KEY,parseOrbPlacement,encodeOrbPosition,decodeOrbPosition,clampOrbPoint}=loaded.exports;
const rect=(left,top,width,height)=>({left,top,width,height,right:left+width,bottom:top+height,x:left,y:top,toJSON(){return this;}});
let width=1000,height=700,scale=1,nested=false;
const captures=new WeakMap();
HTMLElement.prototype.setPointerCapture=function(id){captures.set(this,id)};
HTMLElement.prototype.hasPointerCapture=function(id){return captures.get(this)===id};
HTMLElement.prototype.releasePointerCapture=function(){captures.delete(this)};
const oldRect=HTMLElement.prototype.getBoundingClientRect;
HTMLElement.prototype.getBoundingClientRect=function(){
  if(this.classList.contains('canvas-editor-body'))return rect(100,80,width*scale,height*scale);
  if(this.classList.contains('is-collapsed'))return rect(100+(width-110)*scale,80+(height-95)*scale,64*scale,64*scale);
  if(this.classList.contains('canvas-agent-orb')){
    const insetX=nested?width-110:0,insetY=nested?height-95:0;
    const left=this.style.left?parseFloat(this.style.left)+insetX:width-110;
    const top=this.style.top?parseFloat(this.style.top)+insetY:height-95;
    return rect(100+left*scale,80+top*scale,64*scale,64*scale);
  }
  return oldRect.call(this);
};
for(const key of ['clientWidth','offsetWidth'])Object.defineProperty(HTMLElement.prototype,key,{configurable:true,get(){return this.classList.contains('canvas-editor-body')?width:64;}});
for(const key of ['clientHeight','offsetHeight'])Object.defineProperty(HTMLElement.prototype,key,{configurable:true,get(){return this.classList.contains('canvas-editor-body')?height:64;}});
const orb=()=>document.querySelector('.canvas-agent-orb');
async function pointer(type,x,y,extra={}){
  const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:1,...extra});
  Object.defineProperty(event,'pointerId',{value:extra.pointerId??1});Object.defineProperty(event,'isPrimary',{value:extra.isPrimary??true});
  await React.act(()=>orb().dispatchEvent(event));return event;
}
async function click(element,detail=1){await React.act(()=>element.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail})));}
async function key(value,extra={}){const event=new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra});await React.act(()=>orb().dispatchEvent(event));return event;}
async function mount(saved=null,options={}){
  window.localStorage.clear();if(saved)window.localStorage.setItem(ORB_PLACEMENT_KEY,JSON.stringify(saved));
  width=1000;height=700;scale=options.scale||1;nested=!!options.nested;
  const root=createRoot(document.getElementById('root'));let opens=0;
  const launcher=React.createElement(CanvasAgentOrb,{busy:false,unavailable:false,english:true,onOpen:()=>opens++});
  await React.act(()=>root.render(React.createElement(React.StrictMode,null,React.createElement('div',{className:'canvas-editor-body'},nested?React.createElement('aside',{className:'canvas-r1-agent-panel is-collapsed'},launcher):launcher,React.createElement(CanvasAgentOrbPositionSetting,{english:true})))));
  return {get opens(){return opens},async unmount(){await React.act(()=>root.unmount())}};
}
const stored=()=>JSON.parse(window.localStorage.getItem(ORB_PLACEMENT_KEY));

test('placement parsing rejects invalid values and clamps normalized coordinates',()=>{
  assert.deepEqual(parseOrbPlacement(null),{locked:false,position:null});
  assert.deepEqual(parseOrbPlacement({locked:'yes',position:{x:NaN,y:0}}),{locked:false,position:null});
  assert.deepEqual(parseOrbPlacement({locked:true,position:{x:-4,y:9}}),{locked:true,position:{x:0,y:1}});
});
test('position survives resize as normalized intent and tiny viewports stay finite',()=>{
  const saved=encodeOrbPosition({x:470,y:318},{width:1000,height:700});
  const restored=decodeOrbPosition(saved,{width:1000,height:700});assert.ok(Math.abs(restored.x-470)<1e-9);assert.equal(restored.y,318);
  assert.deepEqual(clampOrbPoint({x:-100,y:900},{width:1000,height:700}),{x:16,y:620});
  assert.deepEqual(decodeOrbPosition(saved,{width:32,height:20}),{x:0,y:0});
});
test('a click and sub-threshold jitter open without storing a position',async()=>{
  const app=await mount();await pointer('pointerdown',1000,690);await pointer('pointermove',1003,692);await pointer('pointerup',1003,692);await click(orb());
  assert.equal(app.opens,1);assert.equal(stored(),null);await app.unmount();
});
test('drag saves once on release, suppresses pointer click, next ordinary click works',async()=>{
  const app=await mount();await pointer('pointerdown',1000,690);await pointer('pointermove',700,400);
  assert.equal(stored(),null);assert.ok(orb().classList.contains('is-dragging'));
  await pointer('pointerup',700,400);await click(orb());assert.equal(app.opens,0);assert.ok(stored().position);
  assert.equal(orb().style.left,'590px');assert.equal(orb().style.top,'315px');
  await pointer('pointerdown',700,400);await pointer('pointerup',700,400);await click(orb());assert.equal(app.opens,1);await app.unmount();
});
test('cancel and lost capture restore original position and do not persist',async()=>{
  for(const terminal of ['pointercancel','lostpointercapture']){
    const app=await mount();await pointer('pointerdown',1000,690);await pointer('pointermove',700,400);await pointer(terminal,700,400);
    assert.equal(stored(),null);assert.equal(orb().style.left,'');assert.equal(orb().classList.contains('is-dragging'),false);await app.unmount();
  }
});
test('settings lock updates mounted launcher immediately, blocks movement but keeps opening',async()=>{
  const app=await mount();await click(document.querySelector('.canvas-settings-toggle'));
  assert.equal(stored().locked,true);assert.ok(orb().classList.contains('is-position-locked'));
  await pointer('pointerdown',1000,690);await pointer('pointermove',700,400);await pointer('pointerup',700,400);await click(orb());
  assert.equal(stored().position,null);assert.equal(app.opens,1);await key('ArrowLeft');assert.equal(stored().position,null);await app.unmount();
});
test('arrow keys move in viewport CSS pixels, Shift fine adjustment, Enter-style click opens',async()=>{
  const app=await mount();await key('ArrowLeft');assert.equal(orb().style.left,'880px');await key('ArrowUp',{shiftKey:true});assert.equal(orb().style.top,'604px');
  await click(orb(),0);assert.equal(app.opens,1);await app.unmount();
});
test('outer CSS scaling does not multiply movement and dragging clamps visible halo',async()=>{
  const app=await mount(null,{scale:2});await pointer('pointerdown',1900,1300);await pointer('pointermove',1700,1100);await pointer('pointerup',1700,1100);
  assert.equal(orb().style.left,'790px');assert.equal(orb().style.top,'505px');
  await pointer('pointerdown',1700,1100);await pointer('pointermove',-9999,-9999);await pointer('pointerup',-9999,-9999);
  assert.equal(orb().style.left,'16px');assert.equal(orb().style.top,'16px');await app.unmount();
});
test('restored position resizes without rewriting intent and reset returns default',async()=>{
  const initial={locked:true,position:{x:.25,y:.75}};const app=await mount(initial);const before=orb().style.left;
  width=500;height=400;await React.act(()=>window.dispatchEvent(new Event('resize')));assert.notEqual(orb().style.left,before);assert.deepEqual(stored(),initial);
  await click(document.querySelector('.canvas-agent-orb-reset'));assert.equal(orb().style.left,'');assert.equal(stored().position,null);assert.equal(stored().locked,true);await app.unmount();
});
test('collapsed panel entrance uses the same viewport placement, not panel-local coordinates',async()=>{
  const app=await mount({locked:false,position:{x:0,y:0}},{nested:true});
  assert.equal(orb().getBoundingClientRect().left,116);assert.equal(orb().getBoundingClientRect().top,96);
  await pointer('pointerdown',120,100);await pointer('pointermove',220,200);await pointer('pointerup',220,200);
  assert.equal(orb().getBoundingClientRect().left,216);assert.equal(orb().getBoundingClientRect().top,196);await app.unmount();
});
test('foreign pointer and secondary mouse button never reposition',async()=>{
  const app=await mount();await pointer('pointerdown',1000,690,{button:2});await pointer('pointermove',700,400);await pointer('pointerup',700,400);assert.equal(stored(),null);
  await pointer('pointerdown',1000,690);await pointer('pointermove',700,400,{pointerId:2});await pointer('pointerup',1000,690);assert.equal(stored(),null);await app.unmount();
});
test('storage notifications synchronize locked preference across windows',async()=>{
  const app=await mount();window.localStorage.setItem(ORB_PLACEMENT_KEY,JSON.stringify({locked:true,position:{x:0,y:0}}));
  await React.act(()=>window.dispatchEvent(new StorageEvent('storage',{key:ORB_PLACEMENT_KEY})));assert.equal(orb().style.left,'16px');assert.ok(orb().classList.contains('is-position-locked'));await app.unmount();
});
test('unlock resumes movement from the saved location rather than default corner',async()=>{
  const app=await mount({locked:true,position:{x:0,y:0}});await click(document.querySelector('.canvas-settings-toggle'));
  await pointer('pointerdown',120,100);await pointer('pointermove',220,200);await pointer('pointerup',220,200);
  assert.ok(Math.abs(parseFloat(orb().style.left)-116)<1e-9);assert.ok(Math.abs(parseFloat(orb().style.top)-116)<1e-9);assert.equal(stored().locked,false);await app.unmount();
});
test('Escape cancels active drag and does not trigger the parent panel shortcut',async()=>{
  const app=await mount();let bubbled=0;const handler=()=>bubbled++;document.body.addEventListener('keydown',handler);
  await pointer('pointerdown',1000,690);await pointer('pointermove',700,400);await key('Escape');
  assert.equal(stored(),null);assert.equal(orb().style.left,'');assert.equal(bubbled,0);document.body.removeEventListener('keydown',handler);await app.unmount();
});
test('storage failure is reported without losing the current in-memory position',async()=>{
  const app=await mount();const original=dom.window.Storage.prototype.setItem;
  dom.window.Storage.prototype.setItem=function(){throw new Error('quota');};
  try {await key('ArrowLeft');assert.equal(orb().style.left,'880px');assert.match(document.body.textContent,/could not be saved/);}finally{dom.window.Storage.prototype.setItem=original;}
  await key('ArrowLeft');assert.equal(orb().style.left,'870px');assert.ok(stored().position);assert.doesNotMatch(document.body.textContent,/could not be saved/);await app.unmount();
});
