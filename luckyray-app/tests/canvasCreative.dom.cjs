const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<button id="before">before</button><div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent'])global[key]=dom.window[key];
const {mountReview,mountPacks}=require(path.resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,20));
const button=text=>[...document.querySelectorAll('button')].find(n=>n.textContent.trim()===text);
async function click(node){assert.ok(node);node.click();await delay();}
async function change(node,value){assert.ok(node);const proto=node.tagName==='SELECT'?window.HTMLSelectElement.prototype:window.HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(node,value);node.dispatchEvent(new Event(node.tagName==='SELECT'?'change':'input',{bubbles:true}));await delay();}
let checks=0;function ok(value){assert.ok(value);checks++;}function eq(a,b){assert.deepEqual(a,b);checks++;}
(async()=>{
 document.getElementById('before').focus();let fixture=mountReview(document.getElementById('root'));await delay();for(let i=0;i<30&&!document.activeElement.hasAttribute("data-dialog-close");i++)await delay();
 ok(document.querySelector('[role=dialog]'));ok(document.activeElement.hasAttribute('data-dialog-close'));
 eq(document.querySelectorAll('.canvas-review-viewport').length,2);eq(document.querySelectorAll('.canvas-review-select select option').length,6);
 eq(document.querySelectorAll('.canvas-review-viewport img')[0].src,'https://qa.invalid/a.png');eq(document.querySelectorAll('.canvas-review-viewport img')[1].src,'https://qa.invalid/b.png');
 await click(button('滑杆'));eq(document.querySelectorAll('.canvas-review-viewport').length,1);
 await change(document.querySelector('[aria-label="对比分隔位置"]'),'25');ok(document.querySelector('.canvas-review-wipe').style.clipPath.includes('75%'));
 await change(document.querySelector('[aria-label="同步缩放"]'),'2');ok([...document.querySelectorAll('.canvas-review-viewport img')].every(n=>n.style.transform.includes('scale(2)')));
 await click(button('适应画面'));eq(document.querySelector('[aria-label="对比分隔位置"]').value,'50');eq(document.querySelector('[aria-label="同步缩放"]').value,'1');
 await click(button('优选'));eq(fixture.events[0],['pick','a',0]);eq(button('优选').getAttribute('aria-pressed'),'true');
 await click(button('这张放回画布'));eq(fixture.events[1],['restore',[{url:'https://qa.invalid/a.png'}]]);
 await change(document.querySelector('[aria-label="版本 A"]'),JSON.stringify(['a',1]));eq(document.querySelectorAll('.canvas-review-viewport img')[0].src,'https://qa.invalid/a2.png');
 ok(document.querySelector('[data-changed=true]'));ok(!document.querySelector('.canvas-review-parameters').textContent.includes('qa.invalid'));
 document.querySelector('.canvas-review-viewport img').dispatchEvent(new Event('error'));await delay();ok(document.querySelector('.canvas-review-media-error'));ok(document.querySelector('[role=dialog]'));
 const overlay=document.querySelector('.canvas-creative-overlay'),section=document.querySelector('section');
 section.dispatchEvent(new Event('pointerdown',{bubbles:true}));overlay.dispatchEvent(new Event('pointerup',{bubbles:true}));await delay();eq(fixture.events.filter(e=>e[0]==='close').length,0);
 section.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape',isComposing:true}));await delay();ok(document.querySelector('[role=dialog]'));
 section.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await delay();eq(fixture.events.at(-1),['close']);eq(document.activeElement.id,'before');
 fixture.root.unmount();fixture=mountReview(document.getElementById('root'));await delay();
 document.querySelector('input[type=checkbox]').click();await delay();ok(document.querySelector('.canvas-creative-empty'));
 fixture.root.unmount();fixture=mountReview(document.getElementById('root'));await delay();fixture.control.clear();await delay();ok(document.querySelector('.canvas-creative-empty'));eq(document.querySelectorAll('.canvas-review-viewport img').length,0);fixture.root.unmount();
 fixture=mountPacks(document.getElementById('root'));await delay();eq(document.querySelectorAll('.canvas-pack-card').length,1);eq(document.querySelectorAll('.canvas-pack-card li').length,2);
 ok(button('应用参考包').disabled);await change(document.querySelector('[aria-label="目标生成卡"]'),'t');ok(!button('应用参考包').disabled);await click(button('应用参考包'));eq(fixture.events.at(-1),['apply','g','t']);ok(document.querySelector('[role=status]').textContent.includes('自行生成'));
 await click(button('改名'));await change(document.querySelector('[aria-label="重命名参考包"]'),'新名字');await click(button('保存'));eq(document.querySelector('.canvas-pack-card h3').textContent,'新名字');
 await change(document.querySelector('[aria-label="参考包名称"]'),'另一套');await change(document.querySelector('[aria-label="参考包类别"]'),'product');await click(button('将所选保存为参考包'));eq(fixture.events.at(-1),['create','另一套','product']);
 await click(button('取消参考包'));eq(document.querySelectorAll('.canvas-pack-card').length,1);await click(button('取消'));ok(button('取消参考包'));await click(button('取消参考包'));await click(button('确认取消标记'));eq(fixture.events.at(-1),['unmark','g']);eq(document.querySelectorAll('.canvas-pack-card').length,0);
 fixture.root.unmount();fixture=mountReview(document.getElementById('root'),true);await delay();ok(document.querySelector('.canvas-creative-empty'));const o=document.querySelector('.canvas-creative-overlay');o.dispatchEvent(new Event('pointerdown',{bubbles:true}));o.dispatchEvent(new Event('pointerup',{bubbles:true}));await delay();eq(fixture.events.at(-1),['close']);fixture.root.unmount();
 console.log(JSON.stringify({status:'passed',checks,scope:'real React events in jsdom; no pixel/Windows or provider claim'}));dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
