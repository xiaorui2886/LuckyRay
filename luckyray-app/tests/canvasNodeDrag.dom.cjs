// Actual ReactFlow + production node mouse events in jsdom (geometry mocked, no pixel QA).
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE || 'jsdom');
const {buildSync}=createRequire(require.resolve('vite'))('esbuild');
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator','localStorage','getComputedStyle','requestAnimationFrame','cancelAnimationFrame'])Object.defineProperty(global,key,{value:typeof dom.window[key]==='function'&&['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key)?dom.window[key].bind(dom.window):dom.window[key],configurable:true});
window.__TAURI_INTERNALS__={convertFileSrc:p=>p};
window.DOMMatrixReadOnly=class {constructor(){this.m22=1;this.m11=1;}};
Object.defineProperties(window.HTMLElement.prototype,{offsetWidth:{get(){return this.classList.contains('react-flow__node')?320:1100}},offsetHeight:{get(){return this.classList.contains('react-flow__node')?260:850}}});
window.HTMLElement.prototype.getBoundingClientRect=function(){return{x:0,y:0,left:0,top:0,right:1100,bottom:850,width:this.offsetWidth,height:this.offsetHeight,toJSON(){}};};
global.ResizeObserver=window.ResizeObserver=class {observe(target){setTimeout(()=>this.cb([{target,contentRect:target.getBoundingClientRect()}]),0)}unobserve(){}disconnect(){}constructor(cb){this.cb=cb}};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-node-dom-'));const source=path.resolve('src/CanvasSpike.tsx');
buildSync({stdin:{contents:fs.readFileSync(source,'utf8')+fs.readFileSync('tests/canvasNodeDrag.fixture.tsx','utf8'),loader:'tsx',resolveDir:path.dirname(source),sourcefile:source},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:path.join(dir,'app.cjs'),loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"development"'}});
require(path.join(dir,'app.cjs'));const tick=()=>new Promise(r=>setTimeout(r,50));
const mouse=(el,type,x,y,button=0)=>el.dispatchEvent(new MouseEvent(type,{view:window,bubbles:true,cancelable:true,clientX:x,clientY:y,button,buttons:type==='mouseup'?0:1}));
const drag=async(el)=>{mouse(el,'mousedown',160,160);mouse(window,'mousemove',170,170);mouse(window,'mousemove',230,205);mouse(window,'mouseup',230,205);await tick();};
(async()=>{await tick();await tick();await tick();const checks=[];
window.load('text',true,1,false);await tick();await tick();assert.equal(window.node().dragHandle,'.canvas-node-drag-handle');await drag(document.querySelector('.canvas-node-title'));assert.deepEqual(window.node().position,{x:120,y:120});checks.push('negative control: old Agent selector blocks text dragging');
for(const kind of ['text','image','video','generator-image','generator-video']){
 window.load(kind);await tick();await tick();const before={...window.node().position};const target=document.querySelector(kind.startsWith('generator')?'.canvas-generator-output':(kind==='image'||kind==='video')?'.canvas-node-media':'.canvas-node-title');assert.ok(target,kind);await drag(target);assert.deepEqual(window.node().position,{x:before.x+60,y:before.y+35},kind);checks.push(kind+' production mouse drag');
}
for(const kind of ['video','generator-video']){window.load(kind);await tick();await tick();const before={...window.node().position};await drag(document.querySelector('.canvas-video-controls'));assert.deepEqual(window.node().position,before);checks.push(kind+' playback controls do not drag');}
window.load('text',false);await tick();await drag(document.querySelector('.canvas-node-title'));assert.deepEqual(window.node().position,{x:180,y:155});checks.push('ordinary text unchanged');
window.load('text');await tick();mouse(document.querySelector('.canvas-node-title'),'dblclick',150,150);await tick();const editor=document.querySelector('textarea');assert.ok(editor);assert.equal(document.activeElement,editor);const before={...window.node().position};await drag(editor);assert.deepEqual(window.node().position,before);editor.setSelectionRange(2,12);assert.equal(editor.selectionEnd-editor.selectionStart,10);checks.push('doubleclick activates real editor; textarea mouse selection does not move node');
editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await tick();assert.equal(document.querySelector('textarea'),null);await drag(document.querySelector('.canvas-node-title'));assert.deepEqual(window.node().position,{x:180,y:155});checks.push('Escape exits editor and dragging resumes');
console.log(JSON.stringify({scope:'Actual production node and ReactFlow DOM mouse-event regression; jsdom geometry mocked; not browser/native acceptance',checks},null,2));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{dom.window.close();fs.rmSync(dir,{recursive:true,force:true});});
