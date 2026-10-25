const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),{createRequire}=require('module');
const base=path.resolve(__dirname,'../../..');const req=createRequire(base+'/package.json'),tool=process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')) : req;
const {JSDOM}=tool('jsdom'),dom=new JSDOM('<div id="root"></div>',{url:'https://test.invalid',pretendToBeVisual:true});for(const k of ['window','document','HTMLElement','HTMLDetailsElement','HTMLInputElement','Node','Event','MouseEvent','KeyboardEvent','navigator','localStorage'])Object.defineProperty(global,k,{value:dom.window[k],configurable:true});global.IS_REACT_ACT_ENVIRONMENT=true;
const React=req('react'),{createRoot}=req('react-dom/client'),esbuild=req('esbuild');
function load(name){const b=esbuild.buildSync({entryPoints:[base+'/src/features/canvas/'+name+'.tsx'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external',loader:{'.css':'empty'}}),m={exports:{}};new Function('module','exports','require',b.outputFiles[0].text)(m,m.exports,req);return m.exports[name];}
const C=load('CanvasImageTools');let encode,encodeCalls=0,created=[],revoked=[];
URL.createObjectURL=()=>{let u='blob:fake-'+created.length;created.push(u);return u};URL.revokeObjectURL=u=>revoked.push(u);
global.Image=class{naturalWidth=100;naturalHeight=100;decode(){return Promise.resolve()}};
global.fetch=async()=>({ok:true,headers:new Headers(),body:null,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});
window.HTMLCanvasElement.prototype.getContext=()=>({translate(){},scale(){},rotate(){},drawImage(){}});
window.HTMLCanvasElement.prototype.toBlob=function(cb){encodeCalls++;encode=cb};

const test=require('node:test');
const item=(id='a',source='https://test.invalid/'+id)=>({id,kind:'image',label:id,source});
const button=text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text);
const tick=()=>new Promise(r=>setTimeout(r,0));
async function render(root,props){await React.act(async()=>{root.render(React.createElement(React.StrictMode,null,React.createElement(C,{english:true,onClose(){},onSave:async()=>'',...props})));await tick()});}
const successFetch=async()=>({ok:true,headers:new Headers(),body:null,arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer});
const successImage=class{naturalWidth=100;naturalHeight=100;decode(){return Promise.resolve()}};
function reset(){global.fetch=successFetch;global.Image=successImage;created=[];revoked=[];encode=undefined;encodeCalls=0;}

test('R7B: unmount during PNG encoding cancels before external save',async()=>{
 reset();let calls=0;const root=createRoot(document.querySelector('#root'));
 await render(root,{item:item(),onSave:async()=>{calls++;return 'saved'}});
 assert.equal(document.querySelector('fieldset').disabled,false);
 await React.act(()=>{const save=button('Save copy to canvas');save.click();save.click();});assert.ok(encode);assert.equal(encodeCalls,1,'same-tick double click encodes once');
 await React.act(()=>root.unmount());await React.act(async()=>{encode(new Blob(['png']));await tick()});
 assert.equal(calls,0);assert.deepEqual([...revoked].sort(),[...created].sort());
});
test('R7B: selection change during encoding cannot save old or new node by mistake',async()=>{
 reset();const saved=[];const root=createRoot(document.querySelector('#root'));const onSave=async i=>{saved.push(i.id);return 'saved'};
 await render(root,{item:item('a'),onSave});await React.act(()=>button('Save copy to canvas').click());const oldEncode=encode;
 await render(root,{item:item('b'),onSave});await React.act(async()=>{oldEncode(new Blob(['old']));await tick()});assert.deepEqual(saved,[]);
 await React.act(()=>{button('Save copy to canvas').click();button('Saving…')?.click()});await React.act(async()=>{encode(new Blob(['new']));await tick()});assert.deepEqual(saved,['b']);
 await React.act(()=>root.unmount());
});
test('R7B: failed reading stops loading and explicit retry recovers',async()=>{
 reset();global.fetch=async()=>{throw Error('unavailable')};const root=createRoot(document.querySelector('#root'));await render(root,{item:item()});
 assert.equal(document.querySelector('.canvas-image-tools-preview').textContent.includes('Reading original'),false);assert.ok(button('Retry reading original'));assert.equal(document.querySelector('fieldset').disabled,true);
 global.fetch=successFetch;await React.act(async()=>{button('Retry reading original').click();await tick()});assert.equal(document.querySelector('fieldset').disabled,false);assert.ok(document.querySelector('canvas'));assert.equal(button('Retry reading original'),undefined);
 await React.act(()=>root.unmount());
});
test('R7B: late original reads and image decode cannot replace the new selection',async()=>{
 reset();const waits=[];global.fetch=()=>new Promise(resolve=>waits.push(resolve));const root=createRoot(document.querySelector('#root'));await render(root,{item:item('a')});await render(root,{item:item('b')});
 // Resolve only B first, then all obsolete StrictMode/A reads.
 await React.act(async()=>{waits.at(-1)(await successFetch());await tick()});assert.equal(document.querySelector('legend').textContent,'b');assert.equal(created.length,1);
 await React.act(async()=>{for(const resolve of waits.slice(0,-1))resolve(await successFetch());await tick()});assert.equal(created.length,1);assert.equal(document.querySelector('legend').textContent,'b');
 await React.act(()=>root.unmount());assert.deepEqual(revoked,created);
 reset();const decodes=[];global.Image=class{naturalWidth=200;naturalHeight=100;decode(){return new Promise(resolve=>decodes.push(resolve))}};
 const root2=createRoot(document.querySelector('#root'));await render(root2,{item:item('a')});await render(root2,{item:item('b')});await React.act(async()=>{decodes.at(-1)();await tick()});await React.act(async()=>{for(const resolve of decodes.slice(0,-1))resolve();await tick()});assert.equal(document.querySelector('legend').textContent,'b');assert.equal(document.querySelector('fieldset').disabled,false);await React.act(()=>root2.unmount());assert.deepEqual([...revoked].sort(),[...created].sort());
});
test('R7B: close is blocked during save; failure releases it and reports failure',async()=>{
 reset();let close=0;const root=createRoot(document.querySelector('#root'));await render(root,{item:item(),onClose(){close++},onSave:async()=>{throw Error('write-failed')}});
 await React.act(()=>button('Save copy to canvas').click());await React.act(()=>document.querySelector('[data-dialog-close]').click());assert.equal(close,0);
 await React.act(async()=>{encode(new Blob(['png']));await tick()});assert.match(document.querySelector('.canvas-creative-notice').textContent,/could not be completed/);await React.act(()=>document.querySelector('[data-dialog-close]').click());assert.equal(close,1);await React.act(()=>root.unmount());
});

const inputByLabel = label => document.querySelector(`input[aria-label="${label}"]`);
async function changeInput(label, value, blur = false) {
 const input = inputByLabel(label);
 await React.act(() => { input.focus(); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, String(value)); input.dispatchEvent(new Event('input', { bubbles: true })); });
 if (blur) await React.act(() => input.blur());
}
async function chooseAspect(value) { await React.act(() => { const select = document.querySelector('select[aria-label="Crop aspect ratio"]'); select.value = String(value); select.dispatchEvent(new Event('change', { bubbles: true })); }); }
const outputSize = () => [Number(inputByLabel('output-width').value), Number(inputByLabel('output-height').value)];
const boxCrop = () => { const s = document.querySelector('.canvas-image-crop-selection').style; return { x: parseFloat(s.left) / 100, y: parseFloat(s.top) / 100, width: parseFloat(s.width) / 100, height: parseFloat(s.height) / 100 }; };

test('R7C: crop percentages and fixed ratio stay bidirectional and preserve user output scale', async () => {
 reset(); global.Image = class { naturalWidth=2000; naturalHeight=1000; decode(){return Promise.resolve()} };
 const root = createRoot(document.querySelector('#root')); await render(root, { item: item() });
 await changeInput('output-width', 400, true); assert.deepEqual(outputSize(), [400, 200]);
 await chooseAspect(1); assert.deepEqual(outputSize(), [200, 200]);
 assert.equal(Number(inputByLabel('width-crop').value), 50);
 await changeInput('width-crop', 25); assert.deepEqual(outputSize(), [100, 100]);
 assert.equal(boxCrop().width, .25); assert.equal(boxCrop().height, .5);
 assert.equal(Number(inputByLabel('height-crop').value), 50);
 await changeInput('output-width', 400, true); assert.deepEqual(outputSize(), [400, 400]);
 await changeInput('x-crop', 10); assert.deepEqual(outputSize(), [400, 400], 'moving does not reset manual scale');
 await changeInput('width-crop', 20); assert.deepEqual(outputSize(), [320, 320]);
 for (let i=0; i<12; i++) { await changeInput('width-crop', 20.17); await changeInput('width-crop', 20); }
 assert.deepEqual(outputSize(), [320, 320], 'rounding never feeds back into output scale');
 await React.act(() => root.unmount());
});

test('R7C: output proportion lock is independent of crop ratio and unlocked exact dimensions survive', async () => {
 reset(); global.Image = class { naturalWidth=2000; naturalHeight=1000; decode(){return Promise.resolve()} };
 const root = createRoot(document.querySelector('#root')); await render(root, { item: item() });
 await React.act(() => document.querySelector('.canvas-image-lock input').click());
 await changeInput('output-width', 123, true); await changeInput('output-height', 234, true);
 await chooseAspect(4/3); assert.deepEqual(outputSize(), [123, 234]);
 await changeInput('width-crop', 20); assert.deepEqual(outputSize(), [123, 234]);
 const crop = boxCrop(); assert.ok(Math.abs(crop.width * 2000 / (crop.height * 1000) - 4/3) < 1e-10);
 await React.act(() => button('Reset crop').click()); assert.deepEqual(outputSize(), [123, 234]);
 assert.equal(document.querySelector('select[aria-label="Crop aspect ratio"]').value, 'free');
 assert.equal(document.querySelector('.canvas-image-lock input').checked, false);
 await React.act(() => root.unmount());
});

test('R7C: reset crop preserves orientation and saving uses full output, not preview dimensions', async () => {
 reset(); global.Image = class { naturalWidth=4000; naturalHeight=2000; decode(){return Promise.resolve()} };
 let saved; const root = createRoot(document.querySelector('#root')); await render(root, { item: item(), onSave: async (item, blob, edit) => { saved=edit; return 'saved'; } });
 assert.equal(document.querySelector('canvas').width, 1000); assert.equal(document.querySelector('canvas').height, 500);
 await chooseAspect(1); await React.act(() => button('Flip horizontally').click()); await React.act(() => button('Rotate 90°').click());
 await React.act(() => button('Reset crop').click());
 assert.equal(button('Flip vertically').getAttribute('aria-pressed'), 'true');
 assert.equal(document.querySelector('.canvas-image-crop-stage').style.aspectRatio, '2000 / 4000');
 assert.deepEqual(outputSize(), [2000, 4000]); assert.deepEqual(boxCrop(), { x:0, y:0, width:1, height:1 });
 await React.act(() => button('Save copy to canvas').click());
 assert.equal(document.querySelector('[data-crop-handle="move"]').disabled, true);
 await React.act(async () => { encode(new Blob(['png'])); await tick(); });
 assert.equal(saved.turns, 1); assert.equal(saved.flipY, true); assert.deepEqual([saved.width,saved.height], [2000,4000]);
 await React.act(() => root.unmount());
});

test('R7C: impossible ratios are disabled and defensively rejected without changing crop', async () => {
 reset(); global.Image = class { naturalWidth=1; naturalHeight=1000; decode(){return Promise.resolve()} };
 const root = createRoot(document.querySelector('#root')); await render(root, { item: item() });
 const select = document.querySelector('select[aria-label="Crop aspect ratio"]');
 assert.equal([...select.options].find(option => option.textContent === '16:9').disabled, true);
 assert.equal([...select.options].find(option => option.textContent === '1:1').disabled, false);
 await chooseAspect(16/9);
 assert.equal(select.value, 'free'); assert.deepEqual(boxCrop(), {x:0,y:0,width:1,height:1});
 assert.match(document.querySelector('.canvas-creative-notice').textContent, /at least one source pixel/);
 await chooseAspect(1); assert.equal(select.value, '1'); assert.equal(boxCrop().height, .001); assert.deepEqual(outputSize(),[1,1]);
 await React.act(() => root.unmount());
});

test('R7C: one-pixel percentages remain nonzero even at the 64MP source limit', async () => {
 reset(); global.Image = class { naturalWidth=64000000; naturalHeight=1; decode(){return Promise.resolve()} };
 const root = createRoot(document.querySelector('#root')); await render(root, { item: item() });
 assert.deepEqual(outputSize(), [4096,1]);
 await chooseAspect(1);
 const percent = Number(inputByLabel('width-crop').value);
 assert.ok(percent > 0 && percent < .000002); assert.ok(boxCrop().width > 0);
 await changeInput('width-crop', percent); assert.ok(boxCrop().width >= 1/64000000);
 await React.act(() => root.unmount());
});
test('R11: Agent edit prepares exact preview, never writes until explicit save',async()=>{
 reset();let saves=0;const root=createRoot(document.querySelector('#root'));
 const edit={turns:1,flipX:true,flipY:false,crop:{x:.1,y:.2,width:.5,height:.5},width:320,height:240};
 await render(root,{item:item(),initialEdit:edit,onSave:async(_i,_b,actual)=>{saves++;assert.deepEqual(actual,edit);return 'saved'}});
 assert.equal(saves,0);assert.equal(encodeCalls,0);
 assert.match(document.querySelector('.canvas-creative-notice').textContent,/Nothing has been saved/);
 assert.equal(document.querySelector('input[aria-label="output-width"]').value,'320');
 await React.act(()=>button('Save copy to canvas').click());
 await React.act(async()=>{encode(new Blob(['png']));await tick()});assert.equal(saves,1);
 await React.act(()=>root.unmount());
});
test('R11: invalid prepared crop disables saving rather than silently applying defaults',async()=>{
 reset();let saves=0;const root=createRoot(document.querySelector('#root'));
 await render(root,{item:item(),initialEdit:{turns:0,flipX:false,flipY:false,crop:{x:.8,y:0,width:.8,height:1},width:100,height:100},onSave:async()=>{saves++;return 'saved'}});
 assert.equal(document.querySelector('fieldset').disabled,true);assert.equal(saves,0);
 await React.act(()=>root.unmount());
});

test('overnight: color sliders preview, compare, reset and save remain non-destructive', async () => {
 reset(); const saved=[]; const root=createRoot(document.querySelector('#root'));
 await render(root,{item:item(),onSave:async (_item,_blob,edit)=>{saved.push(edit);return 'saved'}});
 await changeInput('brightness',25); await changeInput('contrast',-15); await changeInput('saturation',-100);
 assert.equal(inputByLabel('brightness').value,'25');
 await React.act(()=>button('Compare original color').click());
 assert.equal(button('Compare original color').getAttribute('aria-pressed'),'true');
 await React.act(()=>button('Save copy to canvas').click());
 await React.act(async()=>{encode(new Blob(['png']));await tick()});
 assert.deepEqual(saved[0].adjustments,{brightness:25,contrast:-15,saturation:-100},'comparison must not silently save the original colors');
 await React.act(()=>button('Reset color').click());
 assert.equal(inputByLabel('brightness').value,'0'); assert.equal(inputByLabel('contrast').value,'0'); assert.equal(inputByLabel('saturation').value,'0');
 assert.equal(button('Compare original color').getAttribute('aria-pressed'),'false');
 await changeInput('brightness',40); await render(root,{item:item('other')});
 assert.equal(inputByLabel('brightness').value,'0','new image must not inherit previous adjustments');
 await React.act(()=>root.unmount());
});
