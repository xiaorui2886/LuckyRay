// Real production dialog + modal isolation + CSS. Only native transport is
// synthetic; responses are released out of order through actual DOM controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
  'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
const entry = String.raw`
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { MaterialLibraryTransferUI } from './src/features/materials/MaterialLibraryTransferUI';
  import { materialLibrarySession } from './src/core/services/materialLibraryContext';
  import { requestMaterialLibraryNavigation } from './src/features/materials/materialLibraryNavigationProtocol';
  import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
  import './src/features/materials/materialLibraries.css';
  import './src/core/theme/themeTokens.css';
  const ids = ['library-A-000001','library-B-000002','library-C-000003'];
  const registry = { legacyId: ids[2], activeId: ids[0], libraries: ids.map((id,index)=>({id,name:['设计素材','项目参考','灵感收藏'][index],rootPath:'D:/fixture/'+index,storageMode:'managed',state:'ready',visible:true,version:0,preferences:{}})) };
  const tasks = new Map();
  const harness = { ids, commands: [], roots: [], pending: [], busy: [], picker: null,
    queueRoot: (root)=>harness.roots.push(root),
    open: (kind, owner=ids[0])=>requestMaterialLibraryNavigation({action:kind==='move'?'moveLibrary':'mergeLibrary',libraryId:owner,name:registry.libraries.find(l=>l.id===owner).name}),
    select: (owner)=>materialLibrarySession.select(owner),
    resolve: (index,extra={})=>{const pending=harness.pending[index]; pending.resolve({...pending.plan,...extra});},
    reject: (index,message)=>harness.pending[index].reject(Error(message)),
    holdPicker: ()=>harness.roots.push('__hold'),
    resolvePicker: (value)=>{harness.picker(value); harness.picker=null;},
  };
  window.__libraryPreviewHarness=harness;
  window.addEventListener('luckyray:material-library-navigation-busy',e=>harness.busy.push(e.detail));
  window.__TAURI_INTERNALS__={invoke:async(command,args)=>{
    if(command==='plugin:dialog|open') { const selected=harness.roots.shift(); if(selected==='__hold')return new Promise(resolve=>{harness.picker=resolve;}); return selected??null; }
    if(command!=='material_library_command')throw Error('Unexpected fixture command: '+command);
    const {libraryId,action}=args.request; harness.commands.push(structuredClone(args.request));
    if(action.op==='registry')return structuredClone(registry);
    if(action.op==='select'){registry.activeId=libraryId;return null;}
    if(action.op==='transferList')return [...tasks.values()].filter(t=>t.sourceLibraryId===libraryId);
    if(action.op==='moveLibraryPreview'||action.op==='mergeLibraryPreview') {
      const plan=action.op==='moveLibraryPreview'?{libraryId,libraryName:registry.libraries.find(l=>l.id===libraryId).name,oldRoot:'D:/fixture/original',newRoot:action.root,managedAssets:action.root.endsWith('A')?1:2,managedBytes:1024,linkedAssets:1,excluded:['外部引用与 Vault 附件不搬运']}:
        {sourceId:action.sourceId,targetId:libraryId,sourceName:registry.libraries.find(l=>l.id===action.sourceId).name,targetName:registry.libraries.find(l=>l.id===libraryId).name,assets:{total:3,newCopies:2,identicalContent:1},folders:{total:4,mapped:1,new:1,omitted:2},tags:{total:3,mapped:1,new:1,omitted:1},identical:[{sourceName:'源人工名.png',targetName:'目标人工名.png',metadataDiffers:true,metadataDifferences:['名称','描述','分类','标签']}],nameConflicts:[{name:'同名.png'}],notes:['空分类和未用标签不复制；人工信息不同保留目标版本，源库仍保留']};
      return new Promise((resolve,reject)=>harness.pending.push({resolve,reject,plan,request:structuredClone(args.request)}));
    }
    if(action.op==='moveLibrary'||action.op==='transferCopy'){
      const task={taskId:action.requestId,kind:action.op==='moveLibrary'?'move':'copy',phase:'completed',sourceLibraryId:libraryId,targetLibraryId:action.targetLibraryId??libraryId,sourceName:'冻结源库',targetName:action.root??'冻结目标',currentFile:null,currentBytes:0,currentTotalBytes:0,total:2,completed:2,copied:2,skipped:0,failed:0,items:[],error:null,outputPath:action.root??null,retryable:false};
      tasks.set(task.taskId,task);return structuredClone(task);
    }
    if(action.op==='transferStatus')return structuredClone(tasks.get(action.taskId));
    throw Error('Unexpected fixture operation: '+action.op);
  }};
  materialLibrarySession.initialize().then(()=>createRoot(document.getElementById('root')).render(
    <ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><main><MaterialLibraryTransferUI showControls={false}/><p>已填充的素材库预览测试：设计素材 / 项目参考 / 灵感收藏</p></main></ApplicationModalIsolationProvider>));
`;

async function run() {
  const built = await esbuild.build({ stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', outfile:'app.js',
    loader: { '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"test"' }, logLevel:'error' });
  const server=http.createServer((request,response)=>{
    if(request.url==='/app.js'||request.url==='/app.css'){
      response.setHeader('Content-Type',request.url.endsWith('css')?'text/css':'text/javascript');
      response.end(built.outputFiles.find(f=>f.path.endsWith(request.url.slice(1))).text);
    }else{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html data-theme="light"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><body style="margin:0;background:var(--bg-primary);color:var(--text-primary);font-family:Segoe UI,sans-serif"><div id="root"></div><script src="/app.js"></script></body></html>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const evidence = process.env.LUCKYRAY_R3_EVIDENCE_DIR || path.join(root,'output','playwright','material-r3-repair');
  fs.mkdirSync(evidence,{recursive:true});
  const results=[];
  try {
    browser=await chromium.launch({channel:'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1060,height:800}});
    page.setDefaultTimeout(10_000);
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.text());});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>document.querySelector('main'));
    const open=async(kind,owner='library-A-000001')=>{await page.evaluate(({kind,owner})=>window.__libraryPreviewHarness.open(kind,owner),{kind,owner});try { await page.locator('dialog[open]').waitFor(); } catch(error) { console.error('OPEN_STATE',await page.evaluate(()=>({dialog:document.querySelector('dialog').outerHTML,busy:window.__libraryPreviewHarness.busy.slice(-8),commands:window.__libraryPreviewHarness.commands.slice(-4)})));throw error; }};
    const close=async()=>{await page.getByRole('button',{name:'关闭素材库任务',exact:true}).click();await page.locator('dialog[open]').waitFor({state:'hidden'});};
    const pendingCount=()=>page.evaluate(()=>window.__libraryPreviewHarness.pending.length);
    const choose=async(root)=>{const index=await pendingCount();await page.evaluate(root=>window.__libraryPreviewHarness.queueRoot(root),root);await page.getByRole('button',{name:'选择目录…',exact:true}).click();await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,index+1);return index;};
    const resolve=async(index,extra={})=>{await page.evaluate(({index,extra})=>window.__libraryPreviewHarness.resolve(index,extra),{index,extra});};
    const rootInput=()=>page.getByRole('textbox',{name:'整库移动目标目录',exact:true});
    const movePreview=()=>page.getByLabel('移动影响预览',{exact:true});
    const mergePreview=()=>page.getByLabel('合并影响预览',{exact:true});
    const starts=()=>page.evaluate(()=>window.__libraryPreviewHarness.commands.filter(c=>['moveLibrary','transferCopy'].includes(c.action.op)));

    await open('move');
    const a=await choose('D:/new-A');
    assert.equal(await page.getByRole('button',{name:'正在准备…',exact:true}).isDisabled(),true);
    assert.equal(await movePreview().count(),0);
    assert.equal(await page.evaluate(()=>window.__libraryPreviewHarness.busy.at(-1).busy),true,'busy spans preview RPC, not only directory picker');
    const b=await choose('D:/new-B'); await resolve(b); await movePreview().waitFor();
    await page.getByRole('checkbox').check();
    await resolve(a); await page.waitForFunction(()=>!document.querySelector('dialog footer button:last-child').disabled);
    assert.equal(await rootInput().inputValue(),'D:/new-B');
    assert.match(await movePreview().innerText(),/2 个托管文件/);
    assert.equal(await page.getByRole('checkbox').isChecked(),true);
    await page.getByRole('button',{name:'开始移动',exact:true}).click();await page.getByRole('heading',{name:'素材库任务',exact:true}).waitFor();
    assert.equal((await starts()).at(-1).action.root,'D:/new-B');assert.equal((await starts()).at(-1).libraryId,'library-A-000001');
    results.push('A/B out-of-order: busy lifetime, displayed B plan, confirmed B submission');await close();

    await open('move');const late=await choose('D:/late-closed');await close();
    await open('move','library-B-000002');const active=await choose('D:/active-owner-B');
    await page.evaluate(index=>window.__libraryPreviewHarness.reject(index,'stale closed preview failure'),late);
    assert.equal(await page.getByRole('alert').count(),0);await resolve(active);await movePreview().waitFor();
    assert.equal(await rootInput().inputValue(),'D:/active-owner-B');
    await page.evaluate(()=>{document.querySelector('dialog').close();window.__libraryPreviewHarness.open('move','library-B-000002');});
    await page.locator('dialog[open]').waitFor();assert.equal(await movePreview().count(),0,'queued native close must not close or resurrect the new dialog');
    results.push('close/reopen + owner change + queued native close: stale failure cannot replace active plan/error');
    const fail=await choose('D:/failure');await page.evaluate(index=>window.__libraryPreviewHarness.reject(index,'目标不可写（合成拒绝）'),fail);
    await page.getByRole('alert').waitFor();assert.equal(await movePreview().count(),0);assert.equal(await page.getByRole('button',{name:'开始移动',exact:true}).isDisabled(),true);
    const replacement=await choose('D:/after-failure');await resolve(replacement);await movePreview().waitFor();assert.equal(await page.getByRole('alert').count(),0);
    await page.getByRole('checkbox').check();
    const beforePicker=await pendingCount();await page.getByRole('button',{name:'选择目录…',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('dialog footer button:last-child').textContent.includes('准备'));
    assert.equal(await pendingCount(),beforePicker);assert.equal(await movePreview().count(),0);assert.equal(await page.getByRole('button',{name:'开始移动',exact:true}).isDisabled(),true);
    results.push('failure + cancelled picker clears previous plan and confirmation');
    await page.evaluate(()=>window.__libraryPreviewHarness.holdPicker());await page.getByRole('button',{name:'选择目录…',exact:true}).click();await close();
    await open('move');await page.evaluate(()=>window.__libraryPreviewHarness.resolvePicker('D:/late-picker'));
    assert.equal(await pendingCount(),beforePicker);assert.equal(await rootInput().inputValue(),'');
    const zero=await choose('D:/empty-owned-library');await resolve(zero,{managedAssets:0,managedBytes:0});await movePreview().waitFor();
    assert.equal(await page.getByRole('button',{name:'开始移动',exact:true}).isDisabled(),true);await page.getByRole('checkbox').check();
    assert.equal(await page.getByRole('button',{name:'开始移动',exact:true}).isDisabled(),false);await close();
    results.push('late directory picker is invalidated; zero-file move still needs confirmation');

    await open('move');const changed=await choose('D:/changed-library');
    await page.evaluate(()=>window.__libraryPreviewHarness.select('library-B-000002'));await page.locator('dialog[open]').waitFor({state:'hidden'});await resolve(changed);
    await open('move','library-B-000002');assert.equal(await movePreview().count(),0);
    const foreign=await choose('D:/foreign');await resolve(foreign,{libraryId:'library-C-000003'});await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(),/身份不一致/);assert.equal(await movePreview().count(),0);await close();
    results.push('UI library selection invalidates preview; foreign owner plan rejected');

    await open('merge');
    const source=page.getByRole('combobox',{name:'合并来源素材库',exact:true});
    const mb=await pendingCount();await source.selectOption('library-B-000002');await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,mb+1);
    const mc=await pendingCount();await source.selectOption('library-C-000003');await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,mc+1);
    await resolve(mc);await mergePreview().waitFor();await page.getByRole('checkbox').check();await resolve(mb);
    assert.match(await mergePreview().innerText(),/灵感收藏/);assert.equal(await page.getByRole('checkbox').isChecked(),true);
    await source.selectOption('');assert.equal(await mergePreview().count(),0);assert.equal(await page.getByRole('button',{name:'开始合并',exact:true}).isDisabled(),true);
    const emptied=await pendingCount();await source.selectOption('library-B-000002');await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,emptied+1);await source.selectOption('');await resolve(emptied);
    assert.equal(await mergePreview().count(),0);assert.equal(await page.getByRole('button',{name:'开始合并',exact:true}).isDisabled(),true);
    results.push('merge B/C out-of-order + empty source clears active and pending plan/confirmation');
    const mergeFinal=await pendingCount();await source.selectOption('library-B-000002');await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,mergeFinal+1);await resolve(mergeFinal);await mergePreview().waitFor();
    assert.match(await mergePreview().innerText(),/相同父级/);assert.match(await mergePreview().innerText(),/2 个不复制/);
    await page.getByText('内容相同、将跳过的素材',{exact:true}).click();assert.match(await mergePreview().innerText(),/人工信息不同/);
    await page.getByRole('checkbox').check();await page.getByRole('button',{name:'开始合并',exact:true}).click();await page.getByRole('heading',{name:'素材库任务',exact:true}).waitFor();
    const mergeStart=(await starts()).at(-1);assert.equal(mergeStart.libraryId,'library-B-000002');assert.deepEqual(mergeStart.action.selection,{});assert.equal(mergeStart.action.targetLibraryId,'library-A-000001');await close();
    results.push('merge omissions/metadata policy shown, confirmed source/target submitted');

    for(const theme of ['light','dark']){
      await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
      await open('move','library-B-000002');const mp=await choose('D:/真实预览/新位置');await resolve(mp);await movePreview().waitFor();await page.getByRole('checkbox').check();
      await page.screenshot({path:path.join(evidence,'move-preview-'+theme+'.png')});await close();
      await open('merge');const mi=await pendingCount();await page.getByRole('combobox',{name:'合并来源素材库',exact:true}).selectOption('library-B-000002');await page.waitForFunction(n=>window.__libraryPreviewHarness.pending.length===n,mi+1);await resolve(mi);await mergePreview().waitFor();
      await page.getByText('内容相同、将跳过的素材',{exact:true}).click();await page.getByRole('checkbox').check();await page.screenshot({path:path.join(evidence,'merge-preview-'+theme+'.png')});await close();
    }
    assert.deepEqual(errors,[],'no production component browser errors/warnings');
    console.log(JSON.stringify({result:'MATERIAL-LIBRARY-R3-PRODUCTION-COMPONENT-PASS',groups:results,consoleErrors:errors,starts:await starts(),screenshots:evidence},null,2));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
const timeout=setTimeout(()=>{console.error('MATERIAL-LIBRARY-R3-COMPONENT-TIMEOUT');process.exit(124);},120_000);
run().then(()=>clearTimeout(timeout)).catch(error=>{clearTimeout(timeout);console.error(error);process.exitCode=1;});
