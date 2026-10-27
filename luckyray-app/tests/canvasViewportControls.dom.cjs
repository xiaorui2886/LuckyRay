const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(process.env.LR_TEST_TOOLS + '/package.json') : require;
const {JSDOM}=requireTool('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://canvas-qa.invalid',pretendToBeVisual:true});
for(const k of ['window','document','HTMLElement','SVGElement','Element','Node','Event','MouseEvent','WheelEvent','KeyboardEvent','localStorage','navigator','getComputedStyle'])Object.defineProperty(global,k,{value:dom.window[k],configurable:true});
// Real Window frame APIs reject a foreign receiver. Do not bind this away in tests.
const nativeFrame=dom.window.requestAnimationFrame.bind(dom.window),nativeCancel=dom.window.cancelAnimationFrame.bind(dom.window);
function windowFrame(fn){if(this && this!==window && this!==globalThis)throw new TypeError('Illegal invocation: requestAnimationFrame receiver');return nativeFrame(fn);}
function windowCancel(id){if(this && this!==window && this!==globalThis)throw new TypeError('Illegal invocation: cancelAnimationFrame receiver');return nativeCancel(id);}
global.requestAnimationFrame=dom.window.requestAnimationFrame=windowFrame;global.cancelAnimationFrame=dom.window.cancelAnimationFrame=windowCancel;
const mediaListeners=new Set();const motionQuery={matches:false,addEventListener:(_,fn)=>mediaListeners.add(fn),removeEventListener:(_,fn)=>mediaListeners.delete(fn)};global.matchMedia=()=>motionQuery;
global.ResizeObserver=class{constructor(cb){this.cb=cb;}observe(el){this.cb([{target:el,contentRect:el.getBoundingClientRect(),borderBoxSize:[{inlineSize:1000,blockSize:700}]}]);}unobserve(){}disconnect(){}};
global.DOMMatrixReadOnly=dom.window.DOMMatrixReadOnly=class{constructor(){this.m22=1;}};
Object.defineProperty(dom.window.HTMLElement.prototype,'clientWidth',{get(){return this.classList.contains('react-flow')?1000:240;}});
Object.defineProperty(dom.window.HTMLElement.prototype,'clientHeight',{get(){return this.classList.contains('react-flow')?700:170;}});
Object.defineProperty(dom.window.HTMLElement.prototype,'offsetParent',{get(){return this.parentElement;}});
dom.window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,left:0,top:0,right:1000,bottom:700,width:1000,height:700,toJSON(){}};};
require.extensions['.css']=()=>{};
require(process.argv[2]);
const delay=(ms=80)=>new Promise(r=>setTimeout(r,ms));
const camera=()=>JSON.parse(document.querySelector('[data-testid="camera"]').textContent);
const button=name=>[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name||b.textContent===name||b.querySelector('span')?.textContent===name);
const wheel=(el,dy,x=400,y=200,ctrl=false)=>el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:dy,deltaMode:0,clientX:x,clientY:y,ctrlKey:ctrl}));
let checks=0;const check=(v,msg)=>{assert.ok(v,msg);checks++;};
(async()=>{
 await delay(180);const pane=()=>document.querySelector('.react-flow__pane');
 let before=camera();wheel(pane(),-120);await delay(30);check(camera().zoom>before.zoom,'wheel updates real ReactFlow');await delay(400);
 let after=camera();check(Math.abs((400-after.x)/after.zoom-(400-before.x)/before.zoom)<.01,'world cursor anchor');check(after.saved-before.saved===1,'one persisted end, not per-frame autosave');
 before=camera();wheel(document.querySelector('textarea'),120);await delay(120);check(camera().zoom===before.zoom,'textarea wheel excluded');
 button('缩放选项').click();await delay();check(!!document.querySelector('[role="dialog"]'),'menu opens');button('回到 100%').click();await delay(450);check(Math.abs(camera().zoom-1)<.001,'100% reset');
 button('放大').click();button('放大').click();await delay(450);check(Math.abs(camera().zoom-2)<.001,'two rapid steps');
 button('缩放选项').click();await delay();button('显示全部内容').click();await delay(35);document.querySelector('.react-flow__node').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));await delay(30);before=camera();await delay(260);check(camera().zoom===before.zoom&&camera().x===before.x&&camera().y===before.y,'node interaction interrupts native fit');
 button('缩放选项').click();await delay();button('800%').click();await delay(450);check(Math.abs(camera().zoom-8)<.001,'800%');check(button('放大').disabled,'upper boundary disabled');before=camera();wheel(pane(),-120);await delay(450);check(camera().saved===before.saved,'limit no-op does not persist');
 button('缩放选项').click();await delay();document.querySelector('header').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));await delay();check(!document.querySelector('[role="dialog"]'),'outside dismiss');
 button('缩放选项').click();await delay();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay();check(!document.querySelector('[role="dialog"]'),'escape dismiss');
 const reduce=document.querySelectorAll('header input')[0];reduce.click();await delay();before=camera();wheel(pane(),120);await delay(20);after=camera();check(after.zoom<before.zoom,'reduce-motion applies immediate wheel');const fixed=after.zoom;await delay(200);check(camera().zoom===fixed,'no reduced-motion drift');
 const pan=document.querySelectorAll('header input')[1];pan.click();await delay();before=camera();wheel(pane(),120);await delay(220);after=camera();check(after.zoom===before.zoom&&after.y!==before.y,'pan mode preserves zoom');
 before=camera();wheel(document.querySelector('textarea'),120);await delay(80);check(JSON.stringify(camera())===JSON.stringify(before),'editor wheel cannot pan');wheel(document.querySelector('textarea'),120,400,200,true);await delay(80);check(JSON.stringify(camera())===JSON.stringify(before),'editor ctrl-wheel cannot zoom');
 before=camera();wheel(pane(),-60,400,200,true);await delay(60);check(camera().zoom>before.zoom,'ctrl zoom in pan mode');
 before=camera();wheel(document.querySelector('.react-flow__minimap svg'),120);await delay(200);check(camera().zoom!==before.zoom,'minimap keeps its own zoom handler');
 button('放大').focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true,bubbles:true,cancelable:true}));await delay(80);check(Math.abs(camera().zoom-1)<.001,'scoped Ctrl 1 resets viewport');
 const textArea=document.querySelector('textarea');textArea.focus();before=camera();textArea.dispatchEvent(new KeyboardEvent('keydown',{key:'+',ctrlKey:true,bubbles:true,cancelable:true}));await delay(80);check(camera().zoom===before.zoom,'typing focus keeps shortcuts');
 reduce.click();await delay();motionQuery.matches=true;mediaListeners.forEach(fn=>fn());await delay();wheel(pane(),-20,400,200,true);await delay(30);before=camera();await delay(200);check(camera().zoom===before.zoom,'OS reduced motion disables drift');
 motionQuery.matches=false;mediaListeners.forEach(fn=>fn());await delay();wheel(pane(),-80,400,200,true);await delay(20);button('切换画布').click();await delay();check(camera().canvas===2,'canvas switch completes');before=camera();await delay(400);check(JSON.stringify(camera())===JSON.stringify(before),'old motion cannot drift/write after switch');
 console.log(`Production ReactFlow viewport DOM: ${checks} assertions PASS`);process.exit(0);
})().catch(e=>{console.error(e);process.exit(1);});
