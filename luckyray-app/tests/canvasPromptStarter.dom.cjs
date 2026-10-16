const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid'});
for(const key of ['window','document','HTMLElement','Element','Node','Event'])global[key]=dom.window[key];
const {mountStarterFixture}=require(path.resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,30));
async function select(value){const node=document.querySelector('select');node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));await delay();}
(async()=>{let root=mountStarterFixture(document.getElementById('root'),'我的原文');await delay();
 assert.equal(document.querySelectorAll('option').length,4);
 await select('product');const prompt=document.querySelector('textarea').value;assert.ok(prompt.startsWith('我的原文\n\n'));assert.ok(prompt.includes('柔和棚拍光'));
 await select('product');assert.equal(document.querySelector('textarea').value,prompt);assert.match(document.querySelector('[role=status]').textContent,/已包含/);
 root.unmount();root=mountStarterFixture(document.getElementById('root'),'中'.repeat(22000));await delay();await select('product');
 assert.equal(document.querySelector('textarea').value,'中'.repeat(22000));assert.match(document.querySelector('[role=status]').textContent,/过长/);
 root.unmount();root=mountStarterFixture(document.getElementById('root'),'','video',true);await delay();assert.equal(document.querySelectorAll('option').length,3);await select('steady');assert.ok(document.querySelector('textarea').value.startsWith('Use a steady'));
 root.unmount();dom.window.close();console.log(JSON.stringify({status:'passed',checks:8,kind:'DOM interaction only'}));})().catch(error=>{console.error(error);dom.window.close();process.exitCode=1});
