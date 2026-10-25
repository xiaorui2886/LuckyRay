const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { JSDOM } = requireTool('jsdom');
const dom = new JSDOM('<button id="origin">Open tools</button><div id="root"></div>', {url:'https://canvas-tools.invalid',pretendToBeVisual:true});
for(const key of ['window','document','HTMLElement','HTMLDetailsElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','navigator','localStorage']) Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
global.IS_REACT_ACT_ENVIRONMENT=true;
const React=require('react'),{createRoot}=require('react-dom/client');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.resolve(__dirname,'../../../node_modules/vite'))]}));
function load(name){const built=esbuild.buildSync({entryPoints:[path.join(__dirname,name+'.tsx')],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'}}),mod={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(mod,mod.exports,require);return mod.exports[name];}
const Workflow=load('CanvasWorkflowLibrary'),Packs=load('CanvasReferencePacks'),Dialog=load('CanvasCreativeDialog');
const q=s=>document.querySelector(s),all=s=>[...document.querySelectorAll(s)];
const click=async node=>React.act(()=>node.click());
const button=text=>all('button').find(b=>b.textContent===text||b.getAttribute('aria-label')===text);
async function edit(node,value){await React.act(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
async function mount(Component,props){const root=createRoot(q('#root'));await React.act(()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Component,props))));return async()=>{await React.act(()=>root.unmount());};}
const workflowProps=()=>({english:true,selectionCount:2,onClose(){},onInsert(){},onExport:async()=>({cancelled:false,placeholders:0,omittedEdges:0})});

test('template search, favorites and recent usage are deliberate and persistent without model calls',async()=>{
 localStorage.clear();let inserted=0,closed=0;let unmount=await mount(Workflow,{...workflowProps(),onInsert(){inserted++;},onClose(){closed++;}});
 try{
  assert.equal(all('.canvas-workflow-list-item').length,4);
  await click(button('Save Product hero image'));await click(button('Saved'));assert.equal(all('.canvas-workflow-list-item').length,1);assert.equal(inserted,0);
  await click(button('All'));await edit(q('input[type=search]'),'VIDEO');assert.equal(all('.canvas-workflow-list-item').length,1);
  await click(q('.canvas-workflow-list-item>button'));await click(button('Add to canvas'));assert.equal(inserted,1);assert.equal(closed,1);
  const saved=JSON.parse(localStorage.getItem('luckyray.canvas.workflow-browser.v1'));assert.deepEqual(saved,{favorites:['builtin-0'],recent:['builtin-3']});assert.equal(JSON.stringify(saved).includes('prompt'),false);
 }finally{await unmount();}
 unmount=await mount(Workflow,workflowProps());try{await click(button('Recent'));assert.equal(all('.canvas-workflow-list-item').length,1);assert.match(q('.canvas-workflow-results').textContent,/Image to short video/);await click(button('Saved'));assert.match(q('.canvas-workflow-results').textContent,/Product hero/);}finally{await unmount();}
});

test('failed insertion does not record successful use; corrupt preferences do not crash',async()=>{
 localStorage.setItem('luckyray.canvas.workflow-browser.v1','{broken');const unmount=await mount(Workflow,{...workflowProps(),onInsert(){throw Error('failed');}});
 try{await click(button('Add to canvas'));assert.match(q('[role=status]').textContent,/failed/);await click(button('Recent'));assert.equal(all('.canvas-workflow-list-item').length,0);}finally{await unmount();}
});

test('reference browser filters categories and member names without changing the graph',async()=>{
 let mutations=0;const nodes=[{id:'pack-a',data:{kind:'group',label:'Hero',referencePack:{version:1,kind:'character'}}},{id:'a',parentId:'pack-a',data:{kind:'text',label:'Blue coat'}},{id:'pack-b',data:{kind:'group',label:'Product',referencePack:{version:1,kind:'product'}}},{id:'b',parentId:'pack-b',data:{kind:'text',label:'Silver watch'}}];
 const unmount=await mount(Packs,{nodes,edges:[],selectedIds:[],resolveUrl:x=>x,english:true,onCreate(){mutations++;return null},onRename(){mutations++},onUnmark(){mutations++},onApply(){mutations++;return null},onLocate(){},onClose(){}});
 try{assert.equal(all('.canvas-pack-card').length,2);await click(button('Character'));assert.equal(all('.canvas-pack-card').length,1);await click(button('All'));await edit(q('input[type=search]'),'WATCH');assert.equal(all('.canvas-pack-card').length,1);assert.match(q('.canvas-pack-card h3').textContent,/Product/);assert.equal(mutations,0);assert.equal(q('.canvas-pack-members').open,false);await click(q('.canvas-pack-members summary'));assert.equal(q('.canvas-pack-members').open,true);}finally{await unmount();}
});

test('dialog traps focus around closed details, restores origin and dismisses only genuine backdrop clicks',async()=>{
 const origin=q('#origin');origin.focus();let closed=0;const unmount=await mount(Dialog,{title:'Tools',onClose(){closed++},children:React.createElement('details',null,React.createElement('summary',null,'Options'),React.createElement('button',null,'Hidden action'))});
 try{const close=q('[data-dialog-close]'),summary=q('summary');assert.equal(document.activeElement,close);await React.act(()=>close.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})));assert.equal(document.activeElement,summary);
  const overlay=q('.canvas-creative-overlay'),panel=q('[role=dialog]');await React.act(()=>{panel.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));overlay.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));});assert.equal(closed,0);
  await React.act(()=>{overlay.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));overlay.dispatchEvent(new MouseEvent('pointerup',{bubbles:true}));});assert.equal(closed,1);
  await React.act(()=>summary.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true})));assert.equal(closed,1);
 }finally{await unmount();}assert.equal(document.activeElement,origin);
});

test('rapid add clicks insert once while the parent is closing',async()=>{
 let inserted=0;const unmount=await mount(Workflow,{...workflowProps(),onInsert(){inserted++;}});
 try{const add=button('Add to canvas');await React.act(()=>{add.click();add.click();add.click();});assert.equal(inserted,1);}finally{await unmount();}
});
