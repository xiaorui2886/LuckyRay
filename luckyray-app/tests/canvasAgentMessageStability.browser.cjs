// Production React/CSS in an isolated Edge instance. Never attaches to Main/WebView/profile.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),tools=process.env.LR_BROWSER_TOOLS?createRequire(path.join(process.env.LR_BROWSER_TOOLS,'package.json')):require;
const{chromium}=tools('playwright'),esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(path.join(root,'node_modules/vite'))]}));
const out=process.env.LR_REPLAY_OUT||path.join(root,'output/playwright/agent-message-stability');
(async()=>{
 fs.mkdirSync(out,{recursive:true});
 await esbuild.build({entryPoints:[path.join(__dirname,'canvasAgentMessageStability.fixture.tsx')],bundle:true,outfile:path.join(out,'replay.js'),loader:{'.css':'css','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl'},jsx:'automatic'});
 const html=`<!doctype html><html data-theme="dark"><meta charset="UTF-8"><link rel="stylesheet" href="/replay.css"><style>html,body,#root{margin:0;width:100%;height:100%;font-family:Arial,'Noto Sans SC',sans-serif;background:#09090b;color:#ddd}*{box-sizing:border-box}.replay-stage{position:relative;width:100%;height:100%}.replay-title{padding:20px;width:45%;font-size:13px}.canvas-r1-agent-panel{top:20px;bottom:20px;--canvas-panel-surface:#131419;--theme-surface-raised:#202127;--theme-border-strong:#383941;--theme-hover:rgba(255,255,255,.06);--text-primary:#e6e7eb}</style><div id="root"></div><script src="/replay.js"></script></html>`;
 const server=http.createServer((req,res)=>{const name=path.basename(req.url.split('?')[0]);if(!name){res.setHeader('Content-Type','text/html');res.end(html);}else if(['replay.js','replay.css'].includes(name)){res.setHeader('Content-Type',name.endsWith('js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(out,name)));}else{res.statusCode=404;res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await chromium.launch({headless:true,...(process.env.LR_CHROMIUM?{executablePath:process.env.LR_CHROMIUM}:{channel:'msedge'})});
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1,recordVideo:{dir:path.join(out,'video'),size:{width:1440,height:900}}});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>!!window.agentReplay);
  const results=[];
  for(const config of [{name:'fast-short-late-card',length:900,card:'late'},{name:'long-completion',length:6500,card:'early'},{name:'late-tool-order',length:900,card:'late',lateTool:true},{name:'short-no-card',length:500,card:'none',noTools:true},{name:'failed-long',length:3500,card:'late',fail:true}]){
   const stages=await page.evaluate(c=>window.agentReplay.scenario({...c,conversationId:c.name}),config);
   await page.evaluate(s=>window.agentReplay.set(s),stages[0]);await page.waitForTimeout(100);assert.deepEqual(errors,[]);
   if(!await page.locator('.canvas-r1-agent-transcript').count()){await page.screenshot({path:path.join(out,'setup-error.png')});throw Error(JSON.stringify({name:config.name,errors,body:await page.locator('body').innerText()}));}
   await page.evaluate(()=>{
    window.replayFrames=[];window.replayMutations=[];window.replayStage='initial';window.replaySequence=0;
    const ids=new WeakMap();window.replayId=node=>{if(!node)return null;if(!ids.has(node))ids.set(node,++window.replaySequence);return ids.get(node);};
    window.replayActive=true;const token=window.replayToken=(window.replayToken||0)+1;
    function sample(){const host=document.querySelector('.canvas-r1-agent-transcript'),turns=[...document.querySelectorAll('.canvas-agent-turn')],turn=turns.at(-1),message=turn?.querySelector(':scope > .canvas-r1-agent-message'),p=message?.querySelector('.canvas-agent-message-content'),card=document.querySelector('.canvas-r1-agent-execution'),process=turn?.querySelector('.canvas-agent-turn-process');const box=el=>el?{top:el.getBoundingClientRect().top,height:el.getBoundingClientRect().height,id:window.replayId(el)}:null;
     if(!window.replayActive||token!==window.replayToken)return;if(!host||!turn){requestAnimationFrame(sample);return;}
     const bodies=[...turn.querySelectorAll('.canvas-agent-message-content')].map(el=>({...box(el),chars:el.querySelector('p')?.textContent.length,parent:el.closest('.canvas-agent-turn-phase')?'process':'response'}));
     window.replayFrames.push({t:performance.now(),stage:window.replayStage,top:host.scrollTop,height:host.scrollHeight,client:host.clientHeight,gap:host.scrollHeight-host.scrollTop-host.clientHeight,turn:box(turn),body:box(p),bodies,card:box(card),process:box(process),open:process?.open});if(window.replayActive)requestAnimationFrame(sample);
    }requestAnimationFrame(sample);
    window.replayObserver?.disconnect();window.replayObserver=new MutationObserver(records=>{for(const r of records)for(const n of r.removedNodes)if(n.nodeType===1){for(const el of [n,...n.querySelectorAll('.canvas-r1-agent-message,.canvas-agent-message-content')])if(el.matches?.('.canvas-agent-turn,.canvas-r1-agent-message,.canvas-agent-message-content'))window.replayMutations.push({t:performance.now(),stage:window.replayStage,removed:el.className,id:window.replayId(el)});}});window.replayObserver.observe(document.querySelector('.canvas-r1-agent-transcript'),{childList:true,subtree:true});
   });
   await page.screenshot({path:path.join(out,`${config.name}-initial.png`)});
   // Events advance in the browser without screenshot round-trips between chunks.
   await page.evaluate(async stages=>{for(const stage of stages){window.replayStage=stage.label;document.querySelector('.replay-title').textContent='Synthetic event: '+stage.label;window.agentReplay.set(stage);await new Promise(resolve=>setTimeout(resolve,stage.label==='stream-2'?65:18));}await new Promise(resolve=>setTimeout(resolve,180));},stages.slice(1));
   await page.screenshot({path:path.join(out,`${config.name}-final.png`)});
   const data=await page.evaluate(()=>{window.replayActive=false;window.replayObserver.disconnect();return{frames:window.replayFrames,mutations:window.replayMutations};});
   fs.writeFileSync(path.join(out,config.name+'.json'),JSON.stringify(data,null,2));
   const bodies=data.frames.filter(f=>f.body),ids=[...new Set(bodies.map(f=>f.body.id))],maxJump=Math.max(0,...bodies.slice(1).map((f,i)=>Math.abs(f.body.top-bodies[i].body.top)));
   results.push({...config,bodyIds:ids,bodyRebuilt:ids.length>1,maxAdjacentBodyJump:maxJump,frames:data.frames.length,mutations:data.mutations.length,finalGap:data.frames.at(-1)?.gap,finalBodyHeight:data.frames.at(-1)?.body?.height,nonBottomFrames:data.frames.filter(f=>f.gap>1).map(f=>({stage:f.stage,gap:f.gap})),allBodyIds:[...new Set(data.frames.flatMap(f=>f.bodies.map(b=>b.id)))]});
  }
  const checks=[];
  const set=async state=>{await page.evaluate(s=>window.agentReplay.set(s),state);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));};
  const scenario=async config=>page.evaluate(c=>window.agentReplay.scenario(c),config);
  const geometry=()=>page.evaluate(()=>{const h=document.querySelector('.canvas-r1-agent-transcript'),turn=[...h.querySelectorAll('.canvas-agent-turn')].at(-1),body=turn?.querySelector(':scope > .canvas-r1-agent-message .canvas-agent-message-content');return{top:h.scrollTop,gap:h.scrollHeight-h.scrollTop-h.clientHeight,bodyId:window.replayId(body),bodyTop:body?.getBoundingClientRect().top,chars:body?.querySelector('p')?.textContent.length,open:turn?.querySelector('.canvas-agent-turn-process')?.open};});
  const lastProcess=()=>page.locator('.canvas-agent-turn-process').last();
  let states=await scenario({length:6500,card:'early',conversationId:'manual-history'});
  for(const state of states.slice(0,4))await set(state);
  await page.locator('.canvas-r1-agent-transcript').hover();await page.mouse.wheel(0,-240);await page.waitForTimeout(80);
  const beforeHistory=await geometry();assert.ok(beforeHistory.gap>100);
  await set(states.find(s=>s.label==='stream-2'));const duringHistory=await geometry();
  assert.ok(Math.abs(duringHistory.top-beforeHistory.top)<1,'stream updates must not pull a reader to bottom');
  assert.ok(Math.abs(duringHistory.bodyTop-beforeHistory.bodyTop)<1,'the visible body anchor must remain stable');
  await page.screenshot({path:path.join(out,'history-paused.png')});checks.push({name:'manual-history-preserved',before:beforeHistory,after:duringHistory});
  await set(states.at(-1));const settledHistory=await geometry();assert.ok(settledHistory.gap>100);assert.equal(settledHistory.chars,6500);
  const pausedTop=settledHistory.bodyTop;await page.setViewportSize({width:1250,height:750});await page.waitForTimeout(50);
  assert.ok((await geometry()).gap>100,'resize while reading must not resume follow');checks.push({name:'resize-while-paused',bodyTopBefore:pausedTop,...await geometry()});
  await page.locator('.canvas-agent-back-bottom').click();await page.waitForTimeout(50);assert.ok((await geometry()).gap<2);
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(50);assert.ok((await geometry()).gap<2);checks.push({name:'resume-follow-and-resize',...await geometry()});
  await page.locator('.canvas-agent-turn').last().locator('.canvas-agent-expand-message').click();await page.waitForTimeout(50);
  assert.equal((await geometry()).chars,2401);assert.ok((await geometry()).gap<2);
  await page.locator('.canvas-agent-turn').last().locator('.canvas-agent-expand-message').click();await page.waitForTimeout(50);
  assert.equal((await geometry()).chars,6500);assert.ok((await geometry()).gap<2);checks.push({name:'manual-long-collapse-expand',...await geometry()});

  states=await scenario({length:420,card:'late',conversationId:'disclosure'});
  for(const state of states.slice(0,3))await set(state);
  await lastProcess().locator('summary').click();assert.equal(await lastProcess().getAttribute('open'),null);
  await set(states.find(s=>s.label==='stream-1'));assert.equal(await lastProcess().getAttribute('open'),null);
  await lastProcess().locator('summary').click();assert.equal(await lastProcess().getAttribute('open'),'');
  await set(states.find(s=>s.label==='stream-2'));assert.equal(await lastProcess().getAttribute('open'),'');
  const beforeComplete=await geometry();await set(states.at(-1));assert.equal(await lastProcess().getAttribute('open'),null);
  assert.equal((await geometry()).bodyId,beforeComplete.bodyId,'stream/final must keep the message DOM');
  await lastProcess().locator('summary').click();await set({...states.at(-1),snapshot:{...states.at(-1).snapshot}});
  assert.equal(await lastProcess().getAttribute('open'),'','completed turn auto-closes only once');checks.push({name:'manual-process-state-and-one-final-collapse',...await geometry()});

  const delayed=await scenario({length:700,card:'none',noTools:true,conversationId:'delayed-card'});
  for(const state of delayed)await set(state);
  const beforeCard=await geometry();await set({...delayed.at(-1),execution:states.at(-1).execution});const afterCard=await geometry();
  assert.equal(afterCard.bodyId,beforeCard.bodyId);assert.ok(afterCard.gap<2);
  assert.ok(await page.evaluate(()=>!!(document.querySelector('.canvas-agent-turn:last-child').compareDocumentPosition(document.querySelector('.canvas-r1-agent-execution'))&Node.DOCUMENT_POSITION_FOLLOWING)));
  checks.push({name:'result-card-after-final-reply',before:beforeCard,after:afterCard});

  const historical=await scenario({length:6500,card:'none',noTools:true,conversationId:'loaded-history'});
  await set(historical.at(-1));assert.equal((await geometry()).chars,2401,'loaded history keeps its existing preview');
  await page.locator('.canvas-agent-turn').last().locator('.canvas-agent-expand-message').click();await page.waitForTimeout(50);assert.equal((await geometry()).chars,6500);
  checks.push({name:'session-switch-and-historical-preview',...await geometry()});
  const reasoning=await scenario({length:500,card:'none',noTools:true,withReasoning:true,conversationId:'reasoning'});
  for(const state of reasoning.slice(0,2))await set(state);
  const reasoningRow=page.locator('.canvas-dsh-reasoning-row').last();await reasoningRow.click();
  const reasoningScroll=page.locator('.canvas-dsh-reasoning-scroll').last();await reasoningScroll.hover();await page.mouse.wheel(0,-180);await page.waitForTimeout(60);
  const reasoningBefore=await reasoningScroll.evaluate(el=>({top:el.scrollTop,chars:el.textContent.length}));
  await set(reasoning.find(s=>s.label==='stream-2'));
  const reasoningAfter=await reasoningScroll.evaluate(el=>({top:el.scrollTop,chars:el.textContent.length}));
  assert.ok(reasoningAfter.chars>reasoningBefore.chars);assert.ok(Math.abs(reasoningAfter.top-reasoningBefore.top)<1);
  await set(reasoning.at(-1));await lastProcess().locator('summary').click();
  assert.deepEqual(await reasoningScroll.locator('p').allTextContents(),reasoning.at(-1).snapshot.messages.at(-1).reasoningText.trim().split(/\n\n/),'every rendered reasoning paragraph survives settlement');
  checks.push({name:'reasoning-retained-with-independent-manual-scroll',before:reasoningBefore,after:reasoningAfter});
  const cancelled=await scenario({length:450,card:'none',conversationId:'cancelled'});for(const state of cancelled.slice(0,-1))await set(state);
  await set({...cancelled.at(-1),snapshot:{...cancelled.at(-1).snapshot,status:'cancelled'}});
  assert.equal((await geometry()).chars,450);assert.equal((await geometry()).open,true);assert.ok((await geometry()).gap<2);
  checks.push({name:'cancelled-turn-keeps-content-and-process',...await geometry()});
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await scenario({length:850,conversationId:'reduced-motion'});for(const state of reduced)await set(state);
  assert.ok((await geometry()).gap<2);assert.equal((await geometry()).chars,850);checks.push({name:'reduced-motion',...await geometry()});
  const beforeNarrow=await geometry();await page.setViewportSize({width:540,height:640});await page.waitForTimeout(60);const narrow=await geometry();
  assert.equal(narrow.bodyId,beforeNarrow.bodyId);assert.equal(narrow.chars,850);assert.ok(narrow.gap<2);checks.push({name:'narrow-window-keeps-dom-and-follow',...narrow});
  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(40);
  await page.screenshot({path:path.join(out,'matrix-final.png')});

  assert.deepEqual(errors,[]);const video=page.video();await context.close();const report={browser:browser.version(),video:await video.path(),scope:'isolated synthetic production-component replay, not actual Main/model',results,checks};fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,results:results.map(({nonBottomFrames,...r})=>({...r,nonBottomFrames:nonBottomFrames.length}))}));
  for(const result of results)assert.equal(result.nonBottomFrames.length,0,`${result.name}: content painted before bottom follow`);
  const long=JSON.parse(fs.readFileSync(path.join(out,'long-completion.json')));
  assert.equal(long.frames.findLast(f=>f.stage==='settle').bodies[0].chars,6500,'settlement must retain the full live answer');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
