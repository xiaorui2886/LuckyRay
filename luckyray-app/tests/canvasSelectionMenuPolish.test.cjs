const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const app=path.resolve(__dirname,'..'),req=createRequire(app+'/package.json');
const tools=process.env.LR_TEST_TOOLS?createRequire(path.resolve(process.env.LR_TEST_TOOLS,'package.json')):req;
const {JSDOM}=tools('jsdom'),dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://synthetic.invalid'});
for(const name of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator'])Object.defineProperty(global,name,{value:dom.window[name],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
global.ResizeObserver=class{observe(){}disconnect(){}};
HTMLElement.prototype.scrollIntoView=function(){};
Object.defineProperty(HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.classList.contains('is-context')?224:0;}});
Object.defineProperty(HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return this.classList.contains('is-context')?300:0;}});
const React=req('react'),{createRoot}=req('react-dom/client');
const esbuild=createRequire(req.resolve('vite'))('esbuild');
const bundle=esbuild.buildSync({entryPoints:[app+'/src/features/canvas/CanvasSelectionToolbar.tsx'],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',loader:{'.css':'empty'}});
const loaded={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(loaded,loaded.exports,req);
const {CanvasSelectionToolbar}=loaded.exports;
async function mount(context=null,extra={}){
 const root=createRoot(document.getElementById('root')),calls=[];
 let props={count:7,layoutCount:7,canGroup:true,canUngroup:false,canLayout:true,english:false,context,onGroup:()=>calls.push('group'),onUngroup:()=>calls.push('ungroup'),onArrange:()=>calls.push('arrange'),onLayout:kind=>calls.push(kind),onDuplicate:()=>calls.push('duplicate'),onDelete:()=>calls.push('delete'),onClear:()=>calls.push('clear'),onDismissContext:()=>calls.push('dismiss'),...extra};
 const render=()=>root.render(React.createElement(CanvasSelectionToolbar,props));await React.act(render);
 return{calls,async context(value){props={...props,context:value};await React.act(render);},async unmount(){await React.act(()=>root.unmount());}};
}
const button=text=>[...document.querySelectorAll('button')].find(item=>item.textContent===text);
const click=element=>React.act(()=>element.click());

test('ordinary selection remains a toolbar, with one wired organize action and unchanged other callbacks',async()=>{
 const h=await mount();try{
  assert.ok(document.querySelector('#root [role="toolbar"]'));assert.equal(document.querySelector('[role="menu"]'),null);
  assert.equal(document.querySelector('.canvas-selection-tools').classList.contains('is-context'),false);
  assert.ok(button('编组'));assert.ok(button('对齐排列'));assert.ok(button('复制'));
  await click(button('整理画布'));assert.deepEqual(h.calls,['arrange','dismiss']);
  const source=fs.readFileSync(app+'/src/CanvasSpike.tsx','utf8');assert.ok(source.includes('onArrange={arrangeCanvas}'));
 }finally{await h.unmount();}
});
test('right-click selection uses the shared bounded menu outside the canvas, with named actions and keyboard dismissal',async()=>{
 const h=await mount({x:1000,y:750});try{
  const menu=document.querySelector('[role="menu"]');assert.ok(menu);assert.equal(document.querySelector('#root [role="menu"]'),null);
  assert.equal(document.querySelector('[role="toolbar"]'),null);assert.equal(menu.querySelectorAll('[role="menuitem"]').length,6);
  assert.ok(Number.parseFloat(menu.style.left)+224<=window.innerWidth);assert.ok(Number.parseFloat(menu.style.top)+300<=window.innerHeight);
  assert.equal(document.activeElement.textContent,'编组');
  await React.act(()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
  assert.equal(document.activeElement.textContent,'整理画布');
  await React.act(()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.deepEqual(h.calls,['dismiss']);await h.context(null);
  assert.ok(document.querySelector('[role="toolbar"]'));assert.equal(document.querySelector('.canvas-selection-count').textContent,'7项已选');
 }finally{await h.unmount();}
});
test('context alignment submenu closes locally and never rearranges or clears the selection on dismissal',async()=>{
 const h=await mount({x:300,y:200});try{
  await click(button('对齐排列'));const dialog=document.querySelector('[aria-label="对齐与分布"]');assert.ok(dialog);
  await React.act(()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
  assert.equal(!!document.querySelector('[aria-label="对齐与分布"]'),false);assert.deepEqual(h.calls,[]);
  await click(button('对齐排列'));await click(button('左对齐'));assert.deepEqual(h.calls,['left','dismiss']);
 }finally{await h.unmount();}
});
test('outside click dismisses only the right-click menu, not the selected nodes',async()=>{
 const h=await mount({x:300,y:200});try{
  await React.act(()=>document.body.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true})));
  assert.deepEqual(h.calls,['dismiss']);
 }finally{await h.unmount();}
});
test('context-only column CSS is scoped; ordinary selection rule and arrange implementation stay unchanged',()=>{
 const css=fs.readFileSync(app+'/src/features/canvas/canvasEditingSurfaces.css','utf8');
 assert.match(css,/\.canvas-selection-tools\{position:absolute;left:50%;bottom:65px;transform:translateX\(-50%\);[^}]*display:flex;align-items:center;gap:4px;/);
 assert.match(css,/\.canvas-selection-tools\.is-context\{[^}]*flex-direction:column;[^}]*flex-wrap:nowrap/);
 assert.match(css,/\.canvas-selection-tools\.is-context \.canvas-selection-layout-menu\{position:static/);
 const orb=fs.readFileSync(app+'/src/features/canvas/canvasAgentOrb.css','utf8');assert.match(orb,/button\.canvas-agent-orb-reset\s*\{[^}]*font-size:10px/);assert.match(orb,/button\.canvas-agent-orb-reset\s*\{[^}]*border:1px solid/);
});
