// Production CSS in a synthetic browser fixture only. No app/profile/provider access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {createRequire}=require('node:module');
const tools=process.env.LR_TEST_TOOLS?createRequire(path.join(process.env.LR_TEST_TOOLS,'package.json')):require;
const {chromium}=tools('playwright');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const css=[read('src/core/theme/themeTokens.css'),read('src/canvas-spike-scroll.css'),read('src/features/canvas/canvas-history-grid.css'),read('src/features/canvas/CanvasCinematography.css')].join('\n');
const themes=['dark','light','ivory-editorial','rose-tea','github-dark','white-zero','bangladesh-green','lilac-milk','blue-whisper'];
const html=`<!doctype html><html data-theme="dark"><head><style>${css}</style><style>
body{margin:0;background:var(--theme-app-bg);color:var(--text-primary)}
.fixture-settings{padding:10px;display:flex;gap:5px;flex-wrap:wrap}.fixture-settings select{width:125px}
.fixture-history{padding:10px;width:calc(100% - 20px);box-sizing:border-box}.fixture-history article{height:260px}
</style></head><body><div class="canvas-settings-panel fixture-settings"><section class="canvas-media-profiles">
${['connection','preset','text-protocol','image-protocol','video-protocol'].map(id=>`<select aria-label="${id}"><option value="one">Synthetic choice one</option><option value="two">Synthetic choice two</option></select>`).join('')}
</section><div class="canvas-cinema-field"><select aria-label="camera"><option value="one">Camera one</option><option value="two">Camera two</option></select></div></div>
<section class="canvas-history-compact fixture-history"><div class="canvas-generation-history-list is-grid">${Array.from({length:12},(_,i)=>`<article>Synthetic result ${i+1}</article>`).join('')}</div></section>
</body></html>`;
(async()=>{
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;let cases=0;
  try{
    browser=await chromium.launch({headless:true,channel:process.env.LUCKYRAY_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined)});
    // Light OS preference deliberately differs from dark app themes.
    const context=await browser.newContext({colorScheme:'light'});const page=await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
    for(const viewport of [{width:1360,height:900},{width:480,height:520}]){
      await page.setViewportSize(viewport);
      for(const theme of themes){
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        const colors=await page.evaluate(()=>{
          const swatch=document.createElement('div');swatch.style.background='var(--theme-surface-raised)';swatch.style.color='var(--text-primary)';document.body.append(swatch);
          const expected={background:getComputedStyle(swatch).backgroundColor,color:getComputedStyle(swatch).color};swatch.remove();
          return {expected,scheme:getComputedStyle(document.documentElement).colorScheme,selects:[...document.querySelectorAll('select')].map(select=>({scheme:getComputedStyle(select).colorScheme,options:[...select.options].map(option=>({background:getComputedStyle(option).backgroundColor,color:getComputedStyle(option).color}))}))};
        });
        for(const select of colors.selects){assert.equal(select.scheme,colors.scheme,theme+' native scheme');for(const option of select.options)assert.deepEqual(option,colors.expected,theme+' opaque option colors');}
        const select=page.getByRole('combobox',{name:'connection',exact:true});
        await select.focus();await page.keyboard.press('ArrowDown');assert.equal(await select.inputValue(),'two');await page.keyboard.press('ArrowUp');assert.equal(await select.inputValue(),'one');
        for(const view of ['is-grid','is-list']){
          const list=page.locator('.canvas-generation-history-list');
          await list.evaluate((el,view)=>{el.className='canvas-generation-history-list '+view;el.scrollTop=0;},view);
          const style=await list.evaluate(el=>({overflow:getComputedStyle(el).overflowY,width:getComputedStyle(el).scrollbarWidth,webkit:getComputedStyle(el,'::-webkit-scrollbar').display,scrollHeight:el.scrollHeight,height:el.clientHeight}));
          assert.equal(style.overflow,'auto');assert.equal(style.width,'none',theme+' hidden history scrollbar');assert.equal(style.webkit,'none');assert.ok(style.scrollHeight>style.height);
          await list.hover();await page.mouse.wheel(0,300);await page.waitForFunction(()=>document.querySelector('.canvas-generation-history-list').scrollTop>0);
          assert.ok(await list.evaluate(el=>el.scrollTop)>0,theme+' wheel scrolling preserved');
        }
        cases++;
      }
    }
    console.log(`PASS ${cases} theme/viewport cases: six native selectors follow opaque theme colors and app scheme; keyboard selection + grid/list wheel scrolling preserved, scrollbar hidden. Synthetic CSS fixture only, not a native Windows popup claim.`);
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
