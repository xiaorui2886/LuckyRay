// Real Chromium layout/interaction smoke using the production result component and canvas CSS.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),assert=require('node:assert/strict');
const tools=require('node:module').createRequire(process.env.LR_TEST_TOOLS+'/package.json');
const {build}=require('esbuild'),{chromium}=tools('playwright-core');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lr-image-stack-'));
 const fixture=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ReactFlowProvider} from '@xyflow/react';import {CanvasImageResults} from './features/canvas/CanvasImageResults';import {selectPrimaryResultImage} from './core/canvas/imageResults';import './canvas-spike-scroll.css';
 const svg=(color,w,h)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="'+color+'"/><text x="20" y="60" fill="white" font-size="30">'+color+'</text></svg>');
 function App(){const[data,setData]=useState({resultMediaItems:[{url:svg('slateblue',300,200)},{url:svg('teal',150,300)},{url:svg('coral',300,200)}]});window.setCount=count=>setData({resultMediaItems:Array.from({length:count},(_,i)=>({url:svg(['slateblue','teal','coral'][i%3],300,200)}))});return <ReactFlowProvider><div className="canvas-node-card canvas-node-generator selected" style={{'--generator-card-width':'300px','--generator-card-height':'200px'}}><div className="canvas-generator-output"><CanvasImageResults items={data.resultMediaItems} fallback="Missing" resolveUrl={s=>s||''} onDimensions={(w,h)=>window.aspect=w/h} onSelectPrimary={i=>{window.picks=(window.picks||0)+1;setData(d=>selectPrimaryResultImage(d,i));}}/></div></div></ReactFlowProvider>};createRoot(document.getElementById('root')).render(<App/>);`;
 await build({stdin:{contents:fixture,loader:'tsx',resolveDir:path.resolve('src')},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:path.join(dir,'app.js'),define:{'process.env.NODE_ENV':'"development"'}});
 fs.writeFileSync(path.join(dir,'index.html'),'<link rel="stylesheet" href="/app.css"><style>body{margin:80px;background:#151519;color:white}</style><div id="root"></div><button id="outside" style="margin-top:150px">Outside</button><script src="/app.js"></script>');
 const server=http.createServer((req,res)=>{const p=path.join(dir,req.url==='/'?'index.html':req.url.slice(1));if(!fs.existsSync(p)){res.writeHead(404).end();return;}res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(p));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{browser=await chromium.launch({headless:true,executablePath:process.env.LR_CHROMIUM||'/usr/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1200,height:700}});await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.aspect===1.5);
 const badge=page.locator('.canvas-image-results-count');assert.equal(await page.locator('img').count(),1);assert.equal(await badge.innerText(),'3 张');assert.equal(await page.locator('.canvas-image-results').getAttribute('data-stack-depth'),'2');await page.screenshot({path:'/tmp/canvas-image-stack-collapsed.png'});
 await badge.click();assert.equal(await page.locator('img').count(),3);const boxes=await page.locator('.canvas-image-result-choice').evaluateAll(els=>els.map(el=>({x:el.getBoundingClientRect().x,y:el.getBoundingClientRect().y,w:el.getBoundingClientRect().width,h:el.getBoundingClientRect().height})));assert.equal(boxes[0].y,boxes[1].y);assert.ok(boxes[1].x>boxes[0].x+boxes[0].w);assert.equal(boxes[1].w,298);assert.equal(boxes[1].h,198);await page.screenshot({path:'/tmp/canvas-image-stack-expanded.png'});
 await page.locator('.canvas-image-result-primary').nth(1).click();await page.waitForFunction(()=>window.aspect===.5);assert.equal(await page.locator('img').count(),1);assert.equal(await page.evaluate(()=>window.picks),1);
 await badge.click();await page.keyboard.press('Escape');assert.equal(await badge.getAttribute('aria-expanded'),'false');await badge.click();await page.locator('#outside').click();assert.equal(await badge.getAttribute('aria-expanded'),'false');// Narrow viewport forces overflow: wheel, arrow buttons and keyboard must work without a scrollbar.
 await page.setViewportSize({width:650,height:700});await badge.click();
 const strip=page.locator('.canvas-image-results-strip');
 assert.equal(await strip.evaluate(el=>getComputedStyle(el).scrollbarWidth),'none');
 await page.locator('.canvas-image-results-nav.is-next').click();await page.waitForFunction(()=>document.querySelector('.canvas-image-results-strip').scrollLeft>100);
 await page.locator('.canvas-image-results-nav.is-previous').click();await page.waitForFunction(()=>document.querySelector('.canvas-image-results-strip').scrollLeft<1);
 await strip.hover();await page.mouse.wheel(0,180);await page.waitForFunction(()=>document.querySelector('.canvas-image-results-strip').scrollLeft>100);
 await strip.focus();await page.keyboard.press('ArrowLeft');await page.waitForFunction(()=>document.querySelector('.canvas-image-results-strip').scrollLeft<1);
 await page.screenshot({path:'/tmp/canvas-image-stack-navigation.png'});
 await page.keyboard.press('Escape');await page.evaluate(()=>window.setCount(2));await page.waitForFunction(()=>document.querySelector('.canvas-image-results').dataset.stackDepth==='1');
 assert.equal(await badge.innerText(),'2 张');assert.equal(await page.locator('.canvas-image-results').evaluate(el=>getComputedStyle(el,'::after').content),'none');
 await page.evaluate(()=>window.setCount(12));await page.waitForFunction(()=>document.querySelector('.canvas-image-results-count').textContent.includes('12 张'));assert.equal(await page.locator('.canvas-image-results').getAttribute('data-stack-depth'),'2');
 console.log('PASS: real Chromium stack, horizontal full-size images, primary promotion, refreshed aspect, Escape/outside collapse. Screenshots in /tmp/canvas-image-stack-{collapsed,expanded}.png.');
 }finally{await browser?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
