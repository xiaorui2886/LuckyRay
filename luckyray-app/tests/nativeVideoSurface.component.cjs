// Production background/lifecycle and geometry, own headless browser only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:`import{videoSurfaceBounds,observeVideoSurface}from'./src/features/materials/nativeVideoSurface';window.bounds=videoSurfaceBounds;window.calls=[];window.start=()=>window.stop=observeVideoSurface(document.querySelector('.test-surface'),{bounds:async b=>window.calls.push(b)},e=>{throw e});`,loader:'ts',resolveDir:root},bundle:true,write:false});
 const css=fs.readFileSync(root+'/src/features/materials/materialFilmViewer.css','utf8');
 const html=`<style>${css}html,body,#root,.shell,.main,#page-materials{margin:0;width:100%;height:100%;background:#171719}.sidebar{position:fixed;left:0;top:0;width:100px;height:100%;background:#303040}.material-film{left:100px;right:0;top:60px;bottom:0}.test-surface{position:absolute;inset:0}.material-film-info .detail-panel{height:100%}</style>
 <div id="root"><div class="shell"><nav class="sidebar">navigation</nav><main class="main"><div id="page-materials"><div class="materials-layout" inert><div class="masonry-item"><img alt="old poster"/><div class="card-name">old retained card</div></div></div></div></main></div></div>
 <section class="material-film" role="dialog"><div class="test-surface"></div><header class="material-film-topbar"><button>back</button><div class="material-film-top-actions"><button>marks</button><button id="info">info</button></div></header><aside class="material-film-info"><div class="detail-panel">details</div></aside></section>
 <script>${bundle.outputFiles[0].text}</script>`;
 const server=http.createServer((_,r)=>{r.setHeader('Content-Type','text/html');r.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const scale of [1,1.25,1.5,2]){
   const context=await browser.newContext({viewport:{width:1200,height:850},deviceScaleFactor:scale});const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
   const originals=await page.evaluate(()=>[...document.querySelectorAll('*')].map(e=>e.getAttribute('style')));
   await page.evaluate(()=>window.start());await page.waitForFunction(()=>window.calls.length>0);
   const b=await page.evaluate(()=>window.calls.at(-1));assert.equal(b.exclude,undefined);assert.equal(b.x,100*scale);assert.equal(b.y,60*scale);
   assert.equal(await page.locator('#root').evaluate(e=>e.style.clipPath),'');
   assert.equal(await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(48, 48, 64)');
   assert.equal(await page.locator('.materials-layout').evaluate(e=>getComputedStyle(e).opacity),'0','retained library must not bleed through');
   assert.equal(await page.locator('.material-film-topbar button').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(0, 0, 0, 0)');
   const panel=await page.locator('.material-film-info').boundingBox(),button=await page.locator('#info').boundingBox();assert.equal(panel.y-button.y-button.height,4);assert.equal(await page.locator('.material-film-info').evaluate(e=>getComputedStyle(e).borderRadius),'12px');
   assert.equal(await page.locator('.material-film-info').evaluate(e=>e.style.backgroundImage),'','inspector never participates in background cutout');
   await page.evaluate(()=>{const d=document.createElement('div');d.id='modal';d.role='dialog';d.style.cssText='position:fixed;inset:100px;background:rgba(255,0,0,.5)';document.body.append(d)});
   const before=await page.evaluate(()=>window.calls.length);await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>window.calls.length),before,'overlay paints never queue native bounds');
   for(let i=0;i<8;i++){await page.setViewportSize({width:1200-i*10,height:850-i*5});await page.waitForTimeout(25)}
   assert.equal(await page.locator('#modal').evaluate(e=>getComputedStyle(e).backgroundColor),'rgba(255, 0, 0, 0.5)');
   await page.evaluate(()=>document.querySelector('.test-surface').style.top='-100px');await page.waitForTimeout(80);
   const scrolled=await page.evaluate(()=>window.calls.at(-1));assert.equal(scrolled.y,-40*scale,'partly offscreen cards retain geometry, not rescaled at client edge');
   await page.evaluate(()=>document.querySelector('.test-surface').style.removeProperty('top'));await page.waitForTimeout(50);
   await page.evaluate(()=>{window.stop();document.getElementById('modal').remove()});
   assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('*')].map(e=>e.getAttribute('style')||null)),originals,'restore exact existing backgrounds and retained page');
   await context.close();
  }
  console.log('NATIVE_SURFACE_ALPHA_PASS four DPI; real translucent controls; no root clip/control masks; retained page hidden; sidebar untouched; observer bounded; complete style restoration');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
