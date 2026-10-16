const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<button id="before">before</button><div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent'])global[key]=dom.window[key];
const {mountWorkflow,builtinWorkflows,mountEmptyPack}=require(path.resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,20));let checks=0;
function eq(a,b){assert.deepEqual(a,b);checks++;}function ok(a){assert.ok(a);checks++;}
const button=text=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===text);
async function click(n){assert.ok(n);n.click();await delay();}
async function input(n,value){Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));await delay();}
async function file(value,size=20){const n=document.querySelector('input[type=file]');Object.defineProperty(n,'files',{configurable:true,value:[{size,text:async()=>value}]});n.dispatchEvent(new Event('change',{bubbles:true}));await delay();}
(async()=>{
 let f=mountWorkflow(document.getElementById('root'));await delay();await delay();
 ok(document.querySelector('[role=dialog]'));ok(document.querySelector('.canvas-workflow-preview'));eq(document.querySelectorAll('nav button[aria-pressed]').length,4);
 eq(f.events.length,0);ok(button('导出所选模板').disabled);await input(document.querySelector('[aria-label="模板名称"]'),'我的模板');ok(!button('导出所选模板').disabled);
 await click(button('导出所选模板'));eq(f.events.at(-1),['export','我的模板']);ok(document.querySelector('[role=status]').textContent.includes('模板已保存'));eq(document.querySelectorAll('[role=dialog]').length,1);
 f.setMode('cancel');await click(button('导出所选模板'));ok(document.querySelector('[role=status]').textContent.includes('取消'));
 f.setMode('export-error');await click(button('导出所选模板'));ok(document.querySelector('[role=status]').textContent.includes('未能完成'));
 await file('{');ok(document.querySelector('[role=status]').textContent.includes('invalid-file'));eq(document.querySelector('h3').textContent,'产品主图');
 await file('{}',512001);ok(document.querySelector('[role=status]').textContent.includes('超过上限'));
 const t=builtinWorkflows()[1];t.name='<script>not executed</script>';await file(JSON.stringify(t));eq(document.querySelector('h3').textContent,t.name);eq(document.querySelectorAll('script').length,0);ok(document.querySelector('[role=status]').textContent.includes('文件已校验'));
 f.setMode('insert-error');await click(button('添加到当前画布'));ok(document.querySelector('[role=dialog]'));ok(document.querySelector('[role=status]').textContent.includes('画布已变化'));
 f.setMode('success');await click(button('添加到当前画布'));eq(f.events.at(-2)[0],'insert');eq(f.events.at(-2)[1].name,t.name);eq(f.events.at(-1),['close']);eq(document.querySelectorAll('[role=dialog]').length,0);f.root.unmount();
 f=mountWorkflow(document.getElementById('root'),0);await delay();await input(document.querySelector('[aria-label="模板名称"]'),'x');ok(button('导出所选模板').disabled);
 const panel=document.querySelector('section'),overlay=document.querySelector('.canvas-creative-overlay');panel.dispatchEvent(new Event('pointerdown',{bubbles:true}));overlay.dispatchEvent(new Event('pointerup',{bubbles:true}));await delay();ok(document.querySelector('[role=dialog]'));
 panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true}));await delay();ok(document.querySelector('[role=dialog]'));
 panel.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay();eq(f.events.at(-1),['close']);f.root.unmount();
 f=mountWorkflow(document.getElementById('root'));await delay();let finishRead;const pendingInput=document.querySelector('input[type=file]');Object.defineProperty(pendingInput,'files',{configurable:true,value:[{size:20,text:()=>new Promise(resolve=>{finishRead=resolve;})}]});pendingInput.dispatchEvent(new Event('change',{bubbles:true}));await delay();ok(button('添加到当前画布').disabled);await click(document.querySelectorAll('nav button[aria-pressed]')[2]);finishRead(JSON.stringify(builtinWorkflows()[0]));await delay();eq(document.querySelector('h3').textContent,'角色双镜头');eq(f.events.length,0);f.root.unmount();
 f=mountWorkflow(document.getElementById('root'));await delay();const lateInput=document.querySelector('input[type=file]');Object.defineProperty(lateInput,'files',{configurable:true,value:[{size:20,text:()=>new Promise(resolve=>{finishRead=resolve;})}]});lateInput.dispatchEvent(new Event('change',{bubbles:true}));await delay();await click(document.querySelector('[data-dialog-close]'));finishRead(JSON.stringify(builtinWorkflows()[0]));await delay();eq(document.querySelectorAll('[role=dialog]').length,0);eq(f.events,[['close']]);f.root.unmount();
 const pack=mountEmptyPack(document.getElementById('root'));await delay();ok(document.querySelector('.canvas-creative-dialog.is-compact'));ok(document.querySelector('.canvas-pack-selection').textContent.includes('已选 0 项'));eq(document.querySelectorAll('[aria-label="目标生成卡"]').length,0);ok(button('将所选保存为参考包').disabled);ok(document.querySelector('.canvas-creative-empty').textContent.includes('两张以上'));await click(button('回画布选择'));eq(pack.events,['close']);pack.root.unmount();
 console.log(JSON.stringify({status:'passed',checks,scope:'actual React DOM events in jsdom, not pixel/Windows/provider acceptance'}));dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
