import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { discoverBrowser, launchChromium, stopChromium } from './lib/browser-launcher.mjs';
import { startFixturePageServer } from './lib/fixture-page.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const themes=['dark','light','ivory-editorial','rose-tea','github-dark','white-zero','bangladesh-green','lilac-milk','blue-whisper'];

test('real isolated extension: Trusted Types, nine live surfaces, cache and recovery', {timeout:90000}, async()=>{
  let launched,browser,pageServer;
  const artifacts=process.env.LUCKYRAY_QA_ARTIFACTS;
  try {
    pageServer=await startFixturePageServer();
    launched=await launchChromium({browser:discoverBrowser(),extensionPath:path.join(root,'browser-extension-prototype'),headless:process.env.LUCKYRAY_QA_VISIBLE!=='1'});
    browser=await chromium.connectOverCDP(launched.wsUrl.replace(/^http:/,'ws:'));
    const context=browser.contexts()[0];
    const isCollector=async worker=>{try{return await worker.evaluate(()=>chrome.runtime.getManifest().name)==='LuckyRay Collector'}catch{return false}};
    let worker;
    for(let attempt=0;!worker&&attempt<120;attempt++) {
      for(const candidate of context.serviceWorkers())if(await isCollector(candidate))worker=candidate;
      if(!worker)await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert(worker,'LuckyRay Collector service worker starts');
    await worker.evaluate(()=>{
      globalThis.qaAppearance={instanceId:'a'.repeat(32),revision:1,theme:'dark',accent:'#7c8aff'};
      globalThis.qaRequests=[];globalThis.qaOffline=false;
      // Test-only transport seam installed before surfaces are opened. No
      // discovery, native messaging, production port or material write occurs.
      globalThis.LuckyRayLocalTransport={fetch:async(_port,path,options)=>{
        qaRequests.push({path,method:options?.method||'GET',time:Date.now()});
        if(qaOffline)throw Error('isolated-offline');
        return {ok:true,status:200,json:async()=>({ok:true,data:path.includes('appearance')?qaAppearance:[]})};
      }};
    });
    const extensionId=new URL(worker.url()).host;
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
    const response=await page.goto(`http://127.0.0.1:${pageServer.port}/trusted-types-overlay.html`);
    assert.match(response.headers()['content-security-policy'],/require-trusted-types-for/);
    const mainSinkBlocked=await page.evaluate(()=>{try{document.createElement('div').innerHTML='<b>x</b>';return false}catch{return true}});
    assert(mainSinkBlocked,'TT must actually enforce the MAIN world sink');
    await page.locator('#ov-direct').hover();
    const videoHost=page.locator('[data-luckyray-video-capture]').first();
    await videoHost.waitFor({state:'visible'});
    const session=await context.newCDPSession(page);await session.send('DOM.enable');
    const {root:dom}=await session.send('DOM.getDocument',{depth:1,pierce:true});
    const {nodeId}=await session.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'[data-luckyray-video-capture]'});
    const {node:tree}=await session.send('DOM.describeNode',{nodeId,pierce:true,depth:50});
    const nodes=[];const visit=n=>{nodes.push(n);for(const c of [...(n.children||[]),...(n.shadowRoots||[])])visit(c)};visit(tree);
    assert(nodes.some(n=>n.localName==='svg')&&nodes.some(n=>n.localName==='path'),'real TT-page closed-shadow icons have geometry');
    const chip=nodes.find(n=>(n.attributes||[]).includes('lr-chip'));assert(chip);
    const {object}=await session.send('DOM.resolveNode',{backendNodeId:chip.backendNodeId});
    await session.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){this.click()}',awaitPromise:true});
    const dragHost=page.locator('[data-luckyray-drag-collector]');
    const showDrag=async()=>{const box=await page.locator('#tt-drag-image').boundingBox();await page.mouse.move(box.x+20,box.y+20);await page.mouse.down();await page.mouse.move(box.x+150,box.y+80,{steps:16});await dragHost.waitFor({state:'visible'});};
    await showDrag();await page.mouse.up();
    const popup=await context.newPage();
    await popup.addInitScript(()=>{
      const unavailable=async()=>{throw Error('isolated-popup-transport')};
      Object.defineProperty(globalThis,'LuckyRayLocalTransport',{configurable:false,get:()=>({discover:unavailable,fetch:unavailable,verify:async()=>false}),set:()=>{}});
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // Keep both documents visible for this simultaneous runtime test.
    await page.bringToFront();
    const durations=[];
    for(const [i,theme] of themes.entries()) {
      await worker.evaluate(({theme,i})=>{qaAppearance={...qaAppearance,theme,revision:i+2};},{theme,i});
      const began=Date.now();
      await showDrag();
      await page.waitForFunction(theme=>[...document.querySelectorAll('[data-luckyray-video-capture],[data-luckyray-drag-collector]')].every(e=>e.getAttribute('data-lr-theme')===theme),theme);
      if(artifacts&&['light','rose-tea','dark'].includes(theme))await page.screenshot({path:path.join(artifacts,`B-isolated-overlays-${theme}.png`)});
      await page.mouse.up();
      await popup.bringToFront();await popup.waitForFunction(theme=>document.documentElement.getAttribute('data-lr-theme')===theme,theme);
      durations.push({theme,ms:Date.now()-began});
      if(artifacts&&['light','rose-tea','dark'].includes(theme)) await popup.screenshot({path:path.join(artifacts,`B-isolated-popup-${theme}.png`)});
      await page.bringToFront();
    }
    await worker.evaluate(()=>{qaOffline=true});await popup.reload();await popup.bringToFront();await popup.waitForFunction(()=>document.documentElement.getAttribute('data-lr-theme')==='blue-whisper');
    await worker.evaluate(()=>{qaOffline=false;qaAppearance={instanceId:'b'.repeat(32),revision:1,theme:'rose-tea',accent:'#c97991'}});
    await popup.waitForFunction(()=>document.documentElement.getAttribute('data-lr-theme')==='rose-tea');
    const cache=await worker.evaluate(async()=>await chrome.storage.local.get('luckyrayAppearanceV1'));
    assert.equal(cache.luckyrayAppearanceV1.lastInstanceId,'b'.repeat(32));
    assert.equal(cache.luckyrayAppearanceV1.byInstance['a'.repeat(32)].theme,'blue-whisper');
    const requests=await worker.evaluate(()=>qaRequests);
    // Browser drag gestures may dispatch capture intents into the fake bridge;
    // record them separately. The seam never forwards a request or writes data.
    assert(!errors.some(e=>/TrustedHTML|Trusted Types|innerHTML/.test(e)),errors.join('\n'));
    const result={isolated:true,extensionId,mainSinkBlocked,isolatedIconWorks:true,durations,cacheRecovery:true,errors,appearanceRequests:requests.filter(r=>r.path.includes('appearance')).length,fakeBridgeCaptureIntents:requests.filter(r=>r.method!=='GET').map(r=>r.path)};
    console.log(JSON.stringify(result));if(artifacts)await fs.writeFile(path.join(artifacts,'B-isolated-runtime.json'),JSON.stringify(result,null,2));
  } finally {
    await browser?.close().catch(()=>{});
    if(launched)await stopChromium(launched);
    await pageServer?.close();
  }
});
