// Production result controls + navigation helper + real ReactFlow, synthetic local-only inputs.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'..');
const requireTool=process.env.LR_BROWSER_TOOLS?createRequire(path.join(process.env.LR_BROWSER_TOOLS,'package.json')):require;
const {chromium}=requireTool('playwright');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(root,'node_modules/vite'))]}));
const out=process.env.LR_RESULT_UI_OUT||path.join(root,'output/canvas-agent-result-r7d-ui');
(async()=>{
  fs.mkdirSync(out,{recursive:true});
  await esbuild.build({jsx:'automatic',entryPoints:[path.join(__dirname,'canvasAgentResultR7dUi.fixture.tsx')],bundle:true,outfile:path.join(out,'fixture.js'),loader:{'.css':'css'}});
  const html='<!doctype html><html data-theme="dark"><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root,.fixture-stage{margin:0;width:100%;height:100%;font-family:Arial,sans-serif;background:var(--theme-app-bg);color:var(--text-primary)}*{box-sizing:border-box}.fixture-stage{position:relative}.fixture-flow{position:absolute;inset:82px 0 26px}.react-flow__node{color:#18191f}.fixture-stage nav{position:absolute;top:8px;left:8px;right:8px;display:flex;gap:4px;flex-wrap:wrap}.fixture-stage nav button{font-size:11px;padding:4px}#evidence{position:absolute;left:8px;bottom:8px;font-size:10px}.canvas-r1-agent-panel{top:82px}</style><div id="root"></div><script src="/fixture.js"></script></html>';
  const server=http.createServer((req,res)=>{
    const name=path.basename(req.url||'');
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}
    else if(['fixture.js','fixture.css'].includes(name)){res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(out,name)));}
    else {res.statusCode=req.url==='/favicon.ico'?204:404;res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const errors=[],unexpectedRequests=[],checks=[],themeTransitions=[];let browser,context,page,failure;
  try {
    browser=await chromium.launch({headless:true,...(process.env.LR_CHROMIUM?{executablePath:process.env.LR_CHROMIUM}:{})});
    context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
    await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.hostname==='127.0.0.1'&&url.port===String(server.address().port))return route.continue();unexpectedRequests.push(url.origin);return route.abort();});
    await context.tracing.start({screenshots:true,snapshots:true,sources:false});
    page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const all=page.getByRole('button',{name:'Select and locate all results',exact:true});
    const heading=page.locator('.canvas-r1-agent-section-heading'),tooltip=heading.getByRole('tooltip');
    const evidence=async key=>JSON.parse(await page.locator('#evidence').getAttribute(`data-${key}`));
    const commitThemeStyles=require('./canvasThemeCommit.browser.cjs');
    const commitTheme=async theme=>{
      const observation=await commitThemeStyles(page,theme,['html','.canvas-r1-agent-panel','.canvas-agent-result-tooltip']);
      themeTransitions.push(observation);
      fs.writeFileSync(path.join(out,'theme-transition-diagnostics.json'),JSON.stringify(themeTransitions,null,2));
      assert.equal(observation.failure,undefined,'theme target styles must settle within 1000ms');
      const foreground=theme==='light'?'rgb(24, 25, 31)':'rgb(240, 240, 242)';
      const actual=await page.evaluate(()=>({panel:getComputedStyle(document.querySelector('.canvas-r1-agent-panel')).color,tooltip:getComputedStyle(document.querySelector('.canvas-r1-agent-section-heading .canvas-agent-result-tooltip')).color}));
      assert.deepEqual(actual,{panel:foreground,tooltip:foreground},'panel and result tooltip must match the committed theme before screenshot');
    };
    await page.waitForFunction(()=>document.querySelector('#evidence')?.getAttribute('data-ready')==='true');
    const transform=()=>page.locator('.react-flow__viewport').evaluate(el=>el.style.transform);
    const actualSelected=()=>page.locator('.react-flow__node.selected').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-id')).sort());
    const initialTransform=await transform();
    await all.scrollIntoViewIfNeeded();
    assert.equal(await all.innerText(),'');assert.equal(await all.isEnabled(),true);checks.push('select-all is an enabled icon-only control');
    await all.hover();await tooltip.waitFor({state:'visible'});assert.equal(await tooltip.innerText(),'Select and locate 2 result nodes');checks.push('hover tooltip reports deduplicated live result count');
    await page.mouse.move(1,1);await all.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');assert.equal(await all.evaluate(el=>el.matches(':focus-visible')),true);await tooltip.waitFor({state:'visible'});checks.push('real Tab keyboard focus exposes tooltip');
    await page.keyboard.press('Enter');await page.waitForFunction(()=>JSON.stringify([...document.querySelectorAll('.react-flow__node.selected')].map(node=>node.getAttribute('data-id')).sort())==='["draft","edited"]');assert.deepEqual(await evidence('selected'),['draft','edited']);assert.deepEqual(await evidence('events'),[{nodeIds:['draft','edited'],selectAll:true}]);checks.push('Enter selects only actual live results');
    assert.deepEqual(await actualSelected(),['draft','edited']);assert.notEqual(await transform(),initialTransform);assert.deepEqual(await evidence('bounds'),{x:2200,y:100,width:1020,height:520});checks.push('real ReactFlow selection and measured combined bounds change the actual viewport transform');
    const allTransform=await transform();
    await page.getByRole('button',{name:'Locate Edited text',exact:true}).click();assert.deepEqual((await evidence('events')).at(-1),{nodeIds:['edited'],selectAll:false});checks.push('per-node locate does not select all');
    await page.waitForFunction(before=>document.querySelector('.react-flow__viewport')?.style.transform!==before,allTransform);assert.notEqual(await transform(),allTransform);assert.deepEqual(await actualSelected(),['draft','edited']);checks.push('real per-node setCenter changes transform without replacing selection');
    await all.hover();assert.equal(await page.locator('.canvas-agent-result-tooltip:visible').count(),1,'mouse-clicked row does not retain a second tooltip while hovering another result');checks.push('pointer hover does not retain the previous mouse-click tooltip');
    assert.equal(await page.getByRole('button',{name:'Locate Removed result',exact:true}).isDisabled(),true);checks.push('deleted result is disabled');
    assert.equal(await page.getByRole('button',{name:'Locate Running existing result',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Locate Failed existing result',exact:true}).isDisabled(),true);checks.push('unfinished and failed existing nodes remain ineligible');
    for(const theme of ['dark','light'])for(const width of [1440,360]){
      await page.setViewportSize({width,height:900});
      await all.scrollIntoViewIfNeeded();await all.hover();await tooltip.waitFor({state:'visible'});
      await commitTheme(theme);
      const rect=await tooltip.boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=width+.5&&rect.y>=0,'tooltip stays in the viewport');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(out,`results-${theme}-${width}.png`)});checks.push(`${theme} ${width}px tooltip and panel fit`);
    }
    await page.getByRole('button',{name:'Delete first',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Locate Created image draft',exact:true}).isDisabled(),true);await all.click();await page.waitForFunction(()=>JSON.stringify([...document.querySelectorAll('.react-flow__node.selected')].map(node=>node.getAttribute('data-id'))) === '["edited"]');assert.deepEqual(await evidence('selected'),['edited']);assert.deepEqual(await actualSelected(),['edited']);assert.deepEqual(await evidence('bounds'),{x:3000,y:500,width:220,height:120});checks.push('partial deletion selects and frames only the real survivor');
    await page.getByRole('button',{name:'Delete all results',exact:true}).click();assert.equal(await all.isDisabled(),true);const before=await evidence('events'),beforeDeletedTransform=await transform(),beforeDeletedSelection=await actualSelected();await page.getByRole('button',{name:'Invoke old callback',exact:true}).click();assert.deepEqual(await evidence('events'),before);assert.equal(await transform(),beforeDeletedTransform);assert.deepEqual(await actualSelected(),beforeDeletedSelection);checks.push('all-deleted callback leaves actual viewport and selection untouched');
    for(const action of ['Switch canvas','Reload canvas']){
      await page.getByRole('button',{name:'Reset',exact:true}).click();await page.getByRole('button',{name:action,exact:true}).click();assert.equal(await all.isDisabled(),true);const beforeTransform=await transform(),beforeSelection=await actualSelected();await page.getByRole('button',{name:'Invoke old callback',exact:true}).click();assert.deepEqual(await evidence('events'),[]);assert.equal(await transform(),beforeTransform);assert.deepEqual(await actualSelected(),beforeSelection);assert.deepEqual(await evidence('viewport'),{x:34,y:56,zoom:.5});checks.push(`${action}: stale callback preserves the newer real viewport and selection`);
    }
    assert.deepEqual(errors,[]);assert.deepEqual(unexpectedRequests,[]);checks.push('no page errors or external runtime requests');
  }catch(error){failure=error;if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
  finally{
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,unexpectedRequests,failure:failure?.stack||null},null,2));
    if(context)await context.tracing.stop({path:path.join(out,'trace.zip')}).catch(()=>{});
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
  if(failure)throw failure;console.log(`${checks.length} result-navigation browser checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
