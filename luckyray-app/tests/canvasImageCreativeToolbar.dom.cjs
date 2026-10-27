const assert=require('node:assert/strict'),{createRequire}=require('node:module');const tool=process.env.LR_TEST_TOOLS?createRequire(process.env.LR_TEST_TOOLS+'/package.json'):require;const {JSDOM}=tool('jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid',pretendToBeVisual:true});
for(const k of ['window','document','HTMLElement','SVGElement','Element','Node','Event','MouseEvent','KeyboardEvent','WheelEvent','localStorage','MutationObserver','navigator','getComputedStyle'])Object.defineProperty(global,k,{value:dom.window[k],configurable:true});
const nativeFrame=dom.window.requestAnimationFrame.bind(dom.window),nativeCancel=dom.window.cancelAnimationFrame.bind(dom.window);
function windowFrame(fn){if(this && this!==window && this!==globalThis)throw new TypeError('Illegal invocation: requestAnimationFrame receiver');return nativeFrame(fn);}
function windowCancel(id){if(this && this!==window && this!==globalThis)throw new TypeError('Illegal invocation: cancelAnimationFrame receiver');return nativeCancel(id);}
global.requestAnimationFrame=dom.window.requestAnimationFrame=windowFrame;global.cancelAnimationFrame=dom.window.cancelAnimationFrame=windowCancel;
global.DOMMatrixReadOnly=dom.window.DOMMatrixReadOnly=class{constructor(){this.m22=1;}};
global.Image=class{naturalWidth=640;naturalHeight=400;decode=()=>this.src==='bad'?Promise.reject(Error('bad')):Promise.resolve();};
global.ResizeObserver=class{constructor(cb){this.cb=cb;}observe(el){this.cb([{target:el,contentRect:el.getBoundingClientRect(),borderBoxSize:[{inlineSize:el.clientWidth,blockSize:el.clientHeight}]}]);}unobserve(){}disconnect(){}};
Object.defineProperty(HTMLElement.prototype,'clientWidth',{get(){return this.classList.contains('canvas-editor-stage')||this.classList.contains('react-flow')||this.classList.contains('react-flow__renderer')?1000:parseFloat(this.style.width)||260;}});
Object.defineProperty(HTMLElement.prototype,'clientHeight',{get(){return this.classList.contains('canvas-editor-stage')||this.classList.contains('react-flow')||this.classList.contains('react-flow__renderer')?700:parseFloat(this.style.height)||180;}});
Object.defineProperty(HTMLElement.prototype,'offsetWidth',{get(){return this.clientWidth;}});Object.defineProperty(HTMLElement.prototype,'offsetHeight',{get(){return this.clientHeight;}});Object.defineProperty(HTMLElement.prototype,'offsetParent',{get(){return this.parentElement;}});
HTMLElement.prototype.getBoundingClientRect=function(){let height=this.classList.contains('canvas-node-editor-surface')?240:this.classList.contains('canvas-image-tools-surface')?40:this.clientHeight;const width=this.clientWidth;return {x:0,y:0,left:0,top:0,width,height,right:width,bottom:height,toJSON(){}};};

const React=require('react'),{createRoot}=require('react-dom/client');
const {ToolbarFixture}=require(require('node:path').resolve(process.argv[2]));
const delay=(ms=90)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const root=createRoot(document.getElementById('root'));const events=[];
 const render=async(source='ok',creative=true)=>{root.render(React.createElement(ToolbarFixture,{source,creative,onRecipe:r=>events.push(r)}));await delay(150);};
 const open=async()=>{document.querySelector('[aria-label="创作工具"]').click();await delay();};
 await render();assert.ok(document.querySelector('[aria-label="创作工具"]'));
 await open();assert.equal(document.querySelectorAll('[data-creative-action]').length,9);assert.equal(document.querySelector('.canvas-composer-floating-layer').parentElement.className,'canvas-editor-stage');
 const action=document.querySelector('[data-creative-action="story-grid"]');action.click();action.click();await delay();assert.equal(events.length,1);assert.equal(events[0].options.grid,'2x2');assert.equal(document.querySelector('.canvas-composer-floating-layer'),null);
 await open();document.querySelector('[data-creative-action]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await delay();assert.equal(document.querySelector('.canvas-composer-floating-layer'),null);assert.equal(document.activeElement.getAttribute('aria-label'),'创作工具');
 await open();document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));await delay();assert.equal(document.querySelector('.canvas-composer-floating-layer'),null);
 await open();await render('bad');assert.equal(document.querySelector('.canvas-grid-toolbar'),null);assert.equal(document.querySelector('.canvas-composer-floating-layer'),null);
 await render('ok',false);assert.equal(document.querySelector('[aria-label="创作工具"]'),null);assert.equal(document.querySelectorAll('.canvas-grid-toolbar button').length,2);document.querySelector('.canvas-grid-toolbar button').click();await delay();assert.equal(events[1],'split');
 root.unmount();console.log('Creative toolbar production ReactFlow: 14 assertions PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
