const assert=require('node:assert/strict'),fs=require('node:fs');
const {createRequire}=require('node:module');const requireTool=process.env.LR_TEST_TOOLS?createRequire(process.env.LR_TEST_TOOLS+'/package.json'):require;
const {JSDOM}=requireTool('jsdom');const dom=new JSDOM('<div id="root"></div>',{url:'https://canvas-test.invalid'});
for(const key of ['window','document','HTMLElement','Node','Event','MouseEvent','KeyboardEvent','navigator'])Object.defineProperty(global,key,{value:dom.window[key],configurable:true});
require(process.argv[2]);const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
const edit=value=>{const el=document.querySelector('input');Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));};
const key=(value,extra={})=>document.querySelector('input').dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true,...extra}));
const rename=async()=>{document.querySelector('[role="button"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await tick();assert.equal(document.activeElement,document.querySelector('input'));};
(async()=>{
 await tick();await rename();edit('  Renamed node  ');await tick();key('Enter');await tick();assert.equal(document.querySelector('#commits').textContent,'Renamed node;');assert.equal(document.querySelector('[role="button"]').textContent,'Renamed node');
 await rename();edit('Blur commit');await tick();document.querySelector('#outside').focus();await tick();assert.equal(document.querySelector('#commits').textContent,'Renamed node;Blur commit;');
 await rename();edit('Cancelled');await tick();key('Escape');await tick();assert.equal(document.querySelector('[role="button"]').textContent,'Blur commit');assert.equal(document.querySelector('#commits').textContent,'Renamed node;Blur commit;');
 await rename();edit('输入法');await tick();key('Enter',{isComposing:true});await tick();assert.ok(document.querySelector('input'));assert.equal(document.querySelector('#commits').textContent,'Renamed node;Blur commit;');key('Enter');await tick();assert.equal(document.querySelector('#commits').textContent,'Renamed node;Blur commit;输入法;');
 await rename();edit(' ');await tick();key('Enter');await tick();assert.equal(document.querySelector('[role="button"]').textContent,'输入法');
 const label=document.querySelector('[role="button"]');label.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));label.click();await rename();const input=document.querySelector('input');input.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true}));input.click();input.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));key('a');await tick();assert.equal(document.querySelector('#propagated').textContent,'');key('Escape');await tick();
 const long='Very long node name '.repeat(9);await rename();edit(long);await tick();key('Enter');await tick();assert.equal(document.querySelector('[role="button"]').textContent.length,120);assert.equal(document.querySelector('[role="button"]').title.length,120);
 const css=fs.readFileSync('src/canvas-spike-scroll.css','utf8');assert.match(css,/\.canvas-node-name\s*\{[^}]*min-width:0[^}]*overflow:hidden[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);assert.match(css,/\.canvas-node-kind\s*\{[^}]*max-width:calc\(100% - 8px\)/);assert.match(css,/\.canvas-node-name-input\s*\{[^}]*max-width:100%/);
 console.log('CanvasNodeName DOM PASS: doubleclick, Enter/blur, Escape, IME, event isolation, long name bounds');
})().catch(error=>{console.error(error);process.exitCode=1;});
