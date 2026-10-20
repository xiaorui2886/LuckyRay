const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const out=path.resolve(process.argv[2]);
const ready=JSON.parse(fs.readFileSync(path.join(out,'ready.json'),'utf8'));
const guard=JSON.parse(fs.readFileSync(path.join(out,'listener-verified.json'),'utf8'));
assert.equal(guard.port,ready.debugPort);assert.equal(guard.browserProcessId,ready.browserProcessId);
const checks=[],errors=[],requests=[];
let browser,context;
const command=value=>{const tmp=path.join(out,'command.tmp');fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,path.join(out,'command.json'));};
(async()=>{
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${ready.debugPort}`);
 assert.equal(browser.contexts().length,1,'dedicated host must own exactly one context');context=browser.contexts()[0];
 assert.equal(context.pages().length,1,'dedicated host must own exactly one page');const page=context.pages()[0];
 assert.equal(page.url(),'about:blank','host must stay blank until verified');
 page.on('pageerror',e=>errors.push({type:'pageerror',message:e.message}));page.on('console',m=>{if(m.type()==='error')errors.push({type:'consoleerror',message:m.text()});});page.on('crash',()=>errors.push({type:'crash'}));
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===new URL(ready.url).origin||['data:','blob:'].includes(u.protocol))return route.continue();requests.push(u.origin);return route.abort();});
 await context.tracing.start({screenshots:true,snapshots:true,sources:false});
 await page.goto(ready.url);await page.locator('.canvas-agent-turn').waitFor();
 assert.equal(page.url(),ready.url);checks.push('existing WebView2 page attached via dedicated CDP');
 const settings=page.locator('.canvas-agent-run-settings');
 await settings.locator(':scope > summary').click();
 const checkbox=page.locator('.canvas-agent-generation-permission input');
 await checkbox.evaluate(el=>{window.__qaCheckbox=el;});
 for(let i=0;i<100;i++){const old=await checkbox.isChecked();await checkbox.click();assert.equal(await checkbox.isChecked(),!old);assert.ok(await checkbox.evaluate(el=>el===window.__qaCheckbox),'checkbox must retain DOM identity');}
 assert.equal(await page.locator('.canvas-agent-recovery').count(),0);assert.equal(await page.locator('.canvas-agent-turn').count(),1);
 checks.push('100 real native WebView2 checkbox toggles without recovery/unmount');
 await page.keyboard.press('Escape');assert.equal(await settings.getAttribute('open'),null);
 for(const theme of ['light','dark','light','dark']){
  await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
  await page.waitForFunction(t=>{const el=document.querySelector('.canvas-r1-agent-panel');return el&&getComputedStyle(el).color===(t==='light'?'rgb(24, 25, 31)':'rgb(240, 240, 242)');},theme);
  const beforeExpanded=await page.locator('.canvas-agent-model-trigger').getAttribute('aria-expanded');
  await page.locator('.canvas-agent-model-trigger').click();
  assert.notEqual(await page.locator('.canvas-agent-model-trigger').getAttribute('aria-expanded'),beforeExpanded);
  await page.screenshot({path:path.join(out,`model-${theme}.png`)});
  await page.keyboard.press('Escape');
 }
 checks.push('four theme switches and model menu interactions');
 for(const width of [780,1440]){
  command({action:'resize',width,height:900});
  await page.waitForFunction(w=>innerWidth===w,width);
  const panel=await page.locator('.canvas-r1-agent-panel').boundingBox();assert.ok(panel&&panel.width>0&&panel.x>=0&&panel.x+panel.width<=width+1);
  await page.screenshot({path:path.join(out,`native-window-${width}.png`)});
 }
 checks.push('native WinForms client resize 780/1440 preserves visible panel');
 await page.getByRole('button',{name:'流式推理',exact:true}).click();
 await page.locator('.canvas-agent-turn-process > summary').click();
 await page.locator('.canvas-agent-model-reasoning > summary').click();
 const reasoning=page.locator('.canvas-agent-model-reasoning p');const before=await reasoning.innerText();
 const disk=page.locator('.canvas-agent-turn-mark .canvas-agent-orb-black-hole').first();
 const frame=await disk.screenshot();const wordmark=page.locator('.canvas-agent-live-wordmark');const light=await wordmark.evaluate(e=>getComputedStyle(e).backgroundPosition);
 await page.waitForTimeout(1300);
 assert.ok((await reasoning.innerText()).length>before.length);assert.ok(!frame.equals(await disk.screenshot()));assert.notEqual(await wordmark.evaluate(e=>getComputedStyle(e).backgroundPosition),light);
 fs.writeFileSync(path.join(out,'blackhole-before.png'),frame);await disk.screenshot({path:path.join(out,'blackhole-after.png')});
 checks.push('synthetic stream grows and blackhole pixels/wordmark animate');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
 fs.writeFileSync(path.join(out,'browser-result.json'),JSON.stringify({status:'PASS',checks,errors,requests,browserVersion:ready.browserVersion,playwright:require('playwright/package.json').version},null,2));
})().catch(error=>{fs.writeFileSync(path.join(out,'browser-result.json'),JSON.stringify({status:'FAIL',checks,errors,requests,error:error.stack},null,2));process.exitCode=1;}).finally(async()=>{if(context)await context.tracing.stop({path:path.join(out,'trace.zip')}).catch(()=>{});if(browser)await browser.close().catch(()=>{});});
