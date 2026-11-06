// Production background/lifecycle and geometry, own headless browser only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require('C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:`import{videoSurfaceBounds,observeVideoSurface,observeCanvasVideoSurface}from'./src/features/materials/nativeVideoSurface';window.bounds=videoSurfaceBounds;window.calls=[];window.start=()=>window.stop=observeVideoSurface(document.querySelector('.test-surface'),{bounds:async b=>window.calls.push(b)},e=>{throw e});window.startCanvas=()=>{window.acks=[];window.calls=[];window.stop=observeCanvasVideoSurface(document.querySelector('.test-surface'),{bounds:b=>{window.calls.push(b);return new Promise(r=>window.acks.push(r))}},e=>{throw e},()=>{})};`,loader:'ts',resolveDir:root},bundle:true,write:false});
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
   // Canvas composition: transformed node, sibling grid/edges, viewport clipping
   // and a foreground dialog. Only paint beneath the video may become a hole.
   await page.setContent(`<style>html,body,#root{margin:0;width:100%;height:100%;background:#171719}.sidebar{position:absolute;inset:0 auto 0 0;width:100px;background:#303040}.react-flow{position:absolute;left:100px;right:0;top:60px;bottom:0;overflow:hidden;background:#101012}.react-flow__viewport{transform-origin:0 0;transform:translate(80px,40px) scale(.75)}.card{position:absolute;width:400px;height:260px;background:#222;border-radius:16px}.test-surface{width:400px;height:220px;border-radius:16px}.controls{position:absolute;bottom:0;background:#333}.react-flow__background,.react-flow__edges{position:absolute;inset:0;width:100%;height:100%}</style><div id="root"><nav class="sidebar">navigation</nav><div class="react-flow"><svg class="react-flow__background"></svg><svg class="react-flow__edges"></svg><div class="react-flow__viewport"><div class="card"><div class="test-surface" data-native-canvas-picture="true"></div><button class="controls">play</button></div></div></div></div><script>${bundle.outputFiles[0].text}</script>`);
   const canvasOriginals=await page.evaluate(()=>[...document.querySelectorAll('*')].map(e=>e.getAttribute('style')||null));
   await page.evaluate(()=>window.start());await page.waitForFunction(()=>window.calls.length>0);
   const canvasBounds=await page.evaluate(()=>window.calls.at(-1));assert.equal(canvasBounds.x,180*scale);assert.equal(canvasBounds.y,100*scale);assert.equal(canvasBounds.width,300*scale);
   assert.equal(await page.locator('.controls').evaluate(e=>e.style.backgroundImage),'');
   assert.equal(await page.locator('.react-flow__viewport').evaluate(e=>e.style.maskImage),'');
   assert.match(await page.locator('.react-flow__background').evaluate(e=>e.style.maskImage),/data:image\/svg/);
   const unobscured=await page.locator('#root').evaluate(e=>e.style.backgroundImage);
   await page.evaluate(()=>{const panel=document.createElement('div');panel.className='canvas-generation-history-panel';panel.style.cssText='position:fixed;left:210px;top:130px;width:160px;height:100px;background:rgba(20,20,20,.8)';document.body.append(panel);});
   await page.waitForTimeout(80);
   const coveredPaint=await page.locator('#root').evaluate(e=>decodeURIComponent(e.style.backgroundImage));
   assert.match(coveredPaint,/<rect x="210" y="130" width="160" height="100" fill="white"\/>/,'floating history panel closes the native picture hole');
   assert.equal(await page.locator('.controls').evaluate(e=>e.style.backgroundImage),'','inline controls remain translucent');
   await page.evaluate(()=>document.querySelector('.canvas-generation-history-panel').remove());await page.waitForTimeout(80);
   assert.equal(await page.locator('#root').evaluate(e=>e.style.backgroundImage),unobscured,'closing history restores the original picture hole');
   await page.evaluate(()=>document.querySelector('.react-flow__viewport').style.transform='translate(-60px,20px) scale(.5)');await page.waitForTimeout(100);
   assert.equal(await page.evaluate(()=>window.calls.at(-1).x),40*scale);
   const paint=await page.locator('#root').evaluate(e=>decodeURIComponent(e.style.backgroundImage));assert.match(paint,/<clipPath id="viewport"><rect x="100"/);
   assert.equal(await page.locator('.sidebar').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(48, 48, 64)');
   const stable=await page.evaluate(()=>window.calls.length);await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>window.calls.length),stable);
   await page.evaluate(()=>{window.stop();document.querySelector('.react-flow__viewport').style.removeProperty('transform')});
   assert.deepEqual(await page.evaluate(()=>[...document.querySelectorAll('*')].map(e=>e.getAttribute('style')||null)),canvasOriginals);
   // Delay the native ACK to reproduce the old layer chasing the DOM. During
   // a continuous node drag, the opaque decoded frame follows the node and no
   // intermediate native bounds queue is allowed to accumulate.
   await page.evaluate(()=>{document.querySelector('.card').classList.add('react-flow__node');window.startCanvas()});
   await page.waitForFunction(()=>window.acks.length===1);
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),'false','initial native geometry must be acknowledged first');
   await page.evaluate(()=>window.acks.shift()());
   await page.waitForFunction(()=>document.querySelector('.test-surface').dataset.nativeVideoLive==='true');
   // A native child under the WebView cannot honour React Flow node z-order.
   // Overlapping cards must use the existing decoded DOM frame, in either
   // stacking order, rather than opening an alpha hole across another card.
   await page.evaluate(()=>{const other=document.createElement('div');other.id='overlap-card';other.className='react-flow__node';other.style.cssText='position:absolute;left:140px;top:60px;width:260px;height:180px;z-index:1000;background:royalblue';document.querySelector('.react-flow__viewport').append(other);});
   await page.waitForTimeout(80);
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),'false','overlap must use normal DOM stacking for the whole picture and its timeline');
   assert.equal(await page.locator('#root').evaluate(e=>e.style.backgroundImage),'','overlapping card cannot leave an open native picture hole');
   await page.evaluate(()=>document.querySelector('#overlap-card').style.zIndex='-1');await page.waitForTimeout(60);
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),'false','both overlap orders must use one compositor');
   await page.evaluate(()=>document.querySelector('#overlap-card').remove());
   await page.waitForFunction(()=>document.querySelector('.test-surface').dataset.nativeVideoLive==='true');
   assert.equal(await page.evaluate(()=>window.calls.length),1,'uncovering unchanged geometry does not queue redundant native moves');
   await page.evaluate(()=>{document.querySelector('.card').classList.add('dragging');document.querySelector('.card').style.transform='translate(120px,55px)'});
   await page.waitForFunction(()=>document.querySelector('.test-surface').dataset.nativeVideoLive==='false');
   assert.equal(await page.locator('#root').evaluate(e=>e.style.backgroundImage),'','moving native layer is fully covered');
   for(let i=0;i<8;i++)await page.evaluate(i=>document.querySelector('.card').style.transform=`translate(${120+i*20}px,${55+i*5}px)`,i);
   await page.evaluate(()=>new Promise(requestAnimationFrame));
   assert.equal(await page.evaluate(()=>window.calls.length),1,'no per-node-drag HWND backlog');
   await page.evaluate(()=>document.querySelector('.card').classList.remove('dragging'));
   await page.waitForFunction(()=>window.acks.length===1);
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),'false','drop does not reveal old native position before ACK');
   const final=await page.evaluate(()=>window.calls.at(-1));
   assert.deepEqual(final,await page.locator('.test-surface').evaluate(e=>window.bounds(e)));
   // Move again while the first ACK is pending. The stale ACK must not expose
   // the decoder at the old position; one new bounds request follows instead.
   await page.evaluate(()=>{document.querySelector('.card').style.transform='translate(330px,110px)';window.acks.shift()()});
   await page.waitForFunction(()=>window.calls.length===3);
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),'false');
   await page.evaluate(()=>window.acks.shift()());
   await page.waitForFunction(()=>document.querySelector('.test-surface').dataset.nativeVideoLive==='true');
   await page.evaluate(()=>{window.stop();document.querySelector('.card').style.removeProperty('transform')});
   assert.equal(await page.locator('.test-surface').getAttribute('data-native-video-live'),null);
   await context.close();
  }
  console.log('NATIVE_SURFACE_ALPHA_PASS four DPI; both card-overlap orders close the native hole and restore it after uncover; translucent controls, delayed/stale native ACK, no drag bounds backlog, sidebar untouched; complete cleanup.');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
