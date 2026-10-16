const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.LR_JSDOM_MODULE||'jsdom');
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'});
for(const k of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'])global[k]=dom.window[k];
const loads=[];class MockImage{constructor(){this.naturalWidth=2048;this.naturalHeight=1024;this.decode=()=>Promise.resolve();loads.push(this);}set src(v){this.url=v;}get src(){return this.url;}}
global.Image=MockImage;
const {mountImage}=require(path.resolve(process.argv[2]));
const delay=()=>new Promise(r=>setTimeout(r,25));let checks=0;const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
(async()=>{
 const f=mountImage(document.getElementById('root'));await delay();await delay();eq(loads.length,0);eq(document.querySelector('img').dataset.imageDetail,'preview');
 f.update({zoom:2});await delay();eq(loads.length,1);eq(document.querySelector('img').dataset.imageDetail,'preview');
 let decoded;loads[0].decode=()=>new Promise(r=>decoded=r);const pending=loads[0].onload();await delay();eq(document.querySelector('img').dataset.imageDetail,'preview');decoded();await pending;await delay();eq(document.querySelector('img').dataset.imageDetail,'original');
 f.update({zoom:.05});await delay();eq(document.querySelector('img').dataset.imageDetail,'original');eq(loads.length,1);f.root.unmount();
 const g=mountImage(document.getElementById('root'),{selected:true});await delay();await delay();eq(loads.length,2);loads[1].onerror();await delay();eq(document.querySelector('img').dataset.imageDetail,'preview');g.root.unmount();
 const h=mountImage(document.getElementById('root'),{selected:true});await delay();await delay();eq(loads.length,3);const late=loads[2].onload;h.root.unmount();await late();await delay();eq(document.querySelectorAll('img').length,0);eq(loads[2].url,'');
 console.log(JSON.stringify({status:'passed',checks,scope:'actual React component with controlled image decode in jsdom; no WebView pixel/performance claim'}));dom.window.close();
})().catch(e=>{console.error(e);dom.window.close();process.exitCode=1;});
