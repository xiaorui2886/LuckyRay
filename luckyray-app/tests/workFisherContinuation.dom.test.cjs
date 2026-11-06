const {test}=require('node:test');
const assert=require('node:assert/strict'),path=require('node:path');
const {JSDOM}=require(process.env.TEST_JSDOM_PATH||'jsdom');
const {buildSync}=require('node:module').createRequire(require.resolve('vite'))('esbuild');

test('version comparison explains an unsupported continuation inside the open dialog',async()=>{
 const {historyResultContinuationMessage}=await import('../src/core/canvas/generationIteration.ts');
 const {buildWorkFisherImage}=await import('../src/core/canvas/workFisherPreset.ts');
 const dom=new JSDOM('<div id="root"></div>',{url:'https://qa.invalid',pretendToBeVisual:true});
 const saved=new Map();for(const key of ['window','document','HTMLElement','Element','Node','Event','MouseEvent','KeyboardEvent','navigator']){saved.set(key,Object.getOwnPropertyDescriptor(global,key));Object.defineProperty(global,key,{configurable:true,writable:true,value:dom.window[key]});}
 global.IS_REACT_ACT_ENVIRONMENT=true;
 const React=require('react'),{createRoot}=require('react-dom/client');
 const build=buildSync({entryPoints:[path.resolve('src/features/canvas/CanvasVersionReview.tsx')],bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},external:['react','react/*','react-dom','react-dom/*']});
 const loaded={exports:{}};new Function('module','exports','require',build.outputFiles[0].text)(loaded,loaded.exports,require);
 const {CanvasVersionReview}=loaded.exports;
 const graph=preset=>buildWorkFisherImage({preset,prompt:'synthetic',referenceCount:preset==='work-fisher-three-view'?1:0});
 const entry=preset=>({id:'h',taskId:'t',kind:'image',status:'succeeded',model:'local',createdAt:'2026-10-17',outputMediaUrl:'/result.png',request:{kind:'image',prompt:'synthetic',model:'local',references:[],comfyui:{baseUrl:'http://127.0.0.1:8188',workflowName:preset,workflow:graph(preset)}}});
 let created=0,restored=0;const props=item=>({history:[item],initialId:'h',resolveUrl:url=>url,onPick:()=>{},onRestore:()=>{restored++;},onClose:()=>{},onContinue:current=>{const reason=historyResultContinuationMessage(current);if(reason)return reason;created++;}});
 const root=createRoot(document.getElementById('root'));
 try {
  await React.act(async()=>root.render(React.createElement(CanvasVersionReview,props(entry('work-fisher-character')))));
  const button=text=>[...document.querySelectorAll('button')].find(node=>node.textContent===text);
  await React.act(async()=>button('新卡继续修改').click());
  assert.equal(created,0);assert.match(document.querySelector('[role="dialog"] [role="status"]').textContent,/不能直接以结果图继续修改/);
  await React.act(async()=>button('这张放回画布').click());assert.equal(restored,1);
  await React.act(async()=>root.render(React.createElement(CanvasVersionReview,props(entry('work-fisher-three-view')))));
  await React.act(async()=>button('新卡继续修改').click());assert.equal(created,1);assert.equal(document.querySelector('[role="dialog"] [role="status"]'),null);
 } finally {await React.act(async()=>root.unmount());dom.window.close();delete global.IS_REACT_ACT_ENVIRONMENT;for(const [key,value] of saved)value?Object.defineProperty(global,key,value):delete global[key];}
});
