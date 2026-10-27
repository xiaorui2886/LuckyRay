// Isolated production-component geometry regression; never connects to Main.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const { build, stop } = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules/vite'))] }));
const requireTool = process.env.LR_TEST_TOOLS ? createRequire(path.join(process.env.LR_TEST_TOOLS, 'package.json')) : require;
const { chromium } = requireTool('playwright');
const referenceOnly = process.env.LR_AGENT_UI_FOCUS === 'reference-preview';
const dir = process.env.LR_AGENT_UI_OUT || path.join(root, `output/playwright/${referenceOnly?'canvas-agent-reference-preview-20261020':'canvas-agent-ui-20261020'}`);
const checks = [], errors = [];
function record(name, detail) { checks.push({name, status:'PASS', ...detail}); }
async function contained(page, menuSelector) {
  const panel = await page.locator('.canvas-r1-agent-panel').boundingBox(), menu = await page.locator(menuSelector).boundingBox();
  assert.ok(panel && menu && menu.height > 0);
  assert.ok(menu.x >= panel.x && menu.y >= panel.y, `menu starts inside panel: ${JSON.stringify({panel,menu})}`);
  assert.ok(menu.x + menu.width <= panel.x + panel.width + 1 && menu.y + menu.height <= panel.y + panel.height + 1, 'menu ends inside panel');
  return {panel,menu};
}
async function checkReference(page, kind, hover = true) {
  const item=page.locator(`.canvas-r1-agent-context-list li:has(.canvas-r1-agent-reference-preview.is-${kind})`);
  if(hover)await item.hover();
  const preview=item.locator('.canvas-r1-agent-reference-preview'), caption=preview.locator('.canvas-r1-agent-reference-kind');
  await preview.waitFor({state:'visible'});
  const bounds=await contained(page,`.canvas-r1-agent-reference-preview.is-${kind}`);
  const labels={image:'图片',video:'视频',text:'文本',note:'笔记'};
  assert.equal(await caption.innerText(),labels[kind]);
  assert.ok(Number.parseFloat(await caption.evaluate(el=>getComputedStyle(el).fontSize))<=10,'quiet type caption');
  const tag=await caption.boundingBox();
  assert.ok(tag.x+tag.width>=bounds.menu.x+bounds.menu.width-18 && tag.y+tag.height<=bounds.menu.y+bounds.menu.height,'caption in bottom-right');
  assert.equal(await preview.locator('strong').count(),0,'never repeat the reference title');
  assert.doesNotMatch(await preview.innerText(),/SHOULD-NOT-RENDER|不应显示的笔记标题/);
  let image;
  if(kind==='image'||kind==='video') {
    const picture=preview.locator('img');await picture.evaluate(el=>el.decode());
    image=await picture.evaluate(el=>{const rect=el.getBoundingClientRect(),frame=el.parentElement.getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,frame:{x:frame.x,y:frame.y,width:frame.width,height:frame.height},naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,fit:getComputedStyle(el).objectFit,source:el.src};});
    assert.equal(image.fit,'contain');
    assert.ok(Math.abs(image.width/image.height-image.naturalWidth/image.naturalHeight)<.01,'image preserves full intrinsic aspect ratio');
    assert.ok(image.x>=image.frame.x-.5 && image.y>=image.frame.y-.5 && image.x+image.width<=image.frame.x+image.frame.width+.5 && image.y+image.height<=image.frame.y+image.frame.height+.5,'image itself is fully inside the media frame');
    assert.ok(tag.y>=image.frame.y+image.frame.height,'caption below content, not on top of it');
    if(kind==='image')assert.notEqual(image.source,await item.locator('.canvas-r1-agent-context-locate img').getAttribute('src'),'original hover is not the small/cropped thumbnail');
    assert.equal(await preview.innerText(),labels[kind]);
    delete image.source;
  } else {
    const body=kind==='text'?'实际文字参考内容，应当只显示一次。':'实际笔记正文，应当只显示一次。';
    assert.equal(await preview.locator('p').innerText(),body);
    assert.equal((await preview.innerText()).split(body).length-1,1);
    const text=await preview.locator('p').boundingBox();assert.ok(tag.y>=text.y+text.height,'type footer does not obscure the text');
  }
  return {...bounds,image};
}
async function checkReferencePreviews(page) {
  for(const size of [{width:1440,height:900},{width:1000,height:720},{width:780,height:540},{width:680,height:430}]) {
    await page.setViewportSize(size);
    for(const [shape,label] of [['square','方图'],['landscape','横图'],['portrait','竖图']]) {
      await page.getByRole('button',{name:label,exact:true}).click();
      const detail=await checkReference(page,'image');record(`complete ${shape} image ${size.width}x${size.height}`,detail);
      if(size.width===1440||size.width===680)await page.screenshot({path:path.join(dir,`${shape}-${size.width}.png`)});
    }
    for(const kind of ['video','text','note']) {
      record(`${kind} content and type ${size.width}x${size.height}`,await checkReference(page,kind));
      if(size.width===1440)await page.screenshot({path:path.join(dir,`${kind}-1440.png`)});
    }
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('button',{name:'切换主题',exact:true}).click();
  await checkReference(page,'image');await checkReference(page,'note');record('preview and captions follow light theme');
  const textButton=page.getByRole('button',{name:'定位参考 实际文字参考内容，应当只显示一次。',exact:true});
  await page.locator('.fixture-toolbar').hover();await page.keyboard.press('Tab');await textButton.focus();await checkReference(page,'text',false);record('keyboard focus alone shows reference content preview');
  assert.equal(await page.locator('textarea').inputValue(),'UI-ONLY-20261020 · 不发送的合成草稿');
  assert.deepEqual(await page.evaluate(()=>window.fixtureEvents),[]);assert.deepEqual(errors,[]);record('draft/references preserved; no model or other callbacks; no page errors');
}
(async () => {
  fs.mkdirSync(dir, {recursive:true});
  await build({entryPoints:[path.join(__dirname,'canvasAgentUi.fixture.tsx')],bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(dir,'app.js')});
  fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="app.css"><style>html,body,#root{margin:0;width:100%;height:100%;background:var(--theme-app-bg);color:var(--text-primary);font-family:Arial,'Microsoft YaHei',sans-serif}button,input,textarea{font:inherit}.canvas-host{position:absolute;left:180px;right:0;top:54px;bottom:0;overflow:hidden;background:var(--theme-canvas-workspace)}.canvas-host:fullscreen{left:0;top:0;width:100%;height:100%;background:var(--theme-canvas-workspace)}.fixture-toolbar{position:absolute;top:12px;left:16px;display:flex;gap:8px}.fixture-toolbar button{background:var(--theme-surface-raised);color:var(--text-primary);border:1px solid var(--theme-border-strong);border-radius:7px;padding:6px}.synthetic-art{position:absolute;right:160px;top:170px;width:400px;font-size:18px;font-weight:bold}.synthetic-art img{width:100%;margin-top:24px}</style><div id="root"></div><script type="module" src="app.js"></script></html>`);
  const server = http.createServer((req,res) => {
    const name = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['index.html','app.js','app.css'].includes(name)) {res.writeHead(404).end();return;}
    res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(dir,name)));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true,executablePath:process.env.LR_BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForLoadState('networkidle');
    await page.locator('textarea').fill('UI-ONLY-20261020 · 不发送的合成草稿');
    if(referenceOnly) {
      await checkReferencePreviews(page);
    } else {
    for (const size of [{width:1440,height:900},{width:1000,height:720},{width:780,height:540},{width:680,height:430}]) {
      await page.setViewportSize(size);
      const model = await page.locator('.canvas-agent-model-trigger').boundingBox(), strength = await page.locator('.canvas-agent-strength').boundingBox(), send = await page.locator('.canvas-r1-agent-send').boundingBox(), create = await page.locator('.canvas-r1-agent-creation-menu').boundingBox();
      assert.ok(model.x >= create.x+create.width && strength.x >= model.x+model.width-1 && strength.x-model.x-model.width <= 8 && send.x >= strength.x+strength.width);
      record(`adjacent model/strength controls ${size.width}x${size.height}`);
      await page.getByRole('button',{name:'思考强度',exact:true}).click();
      record(`strength contained ${size.width}x${size.height}`,await contained(page,'.canvas-agent-strength-popover'));
      await page.getByRole('option',{name:'最高',exact:true}).click();
      assert.equal(await page.locator('.canvas-agent-strength').innerText(),'最高');
      assert.equal(await page.locator('textarea').inputValue(),'UI-ONLY-20261020 · 不发送的合成草稿');
      await page.locator('.canvas-agent-model-trigger').click();
      record(`model menu contained ${size.width}x${size.height}`,await contained(page,'.canvas-agent-model-popover'));
      const options = page.locator('.canvas-agent-model-options');
      assert.equal(await options.evaluate(el => getComputedStyle(el).scrollbarWidth),'none');
      assert.ok(await options.evaluate(el => el.scrollHeight > el.clientHeight));
      await options.hover();await page.mouse.wheel(0,500);await page.waitForFunction(() => document.querySelector('.canvas-agent-model-options')?.scrollTop > 0);
      record(`hidden scrollbar still scrolls ${size.width}x${size.height}`);
      await page.keyboard.press('Escape');assert.equal(await page.locator('.canvas-agent-model-popover').count(),0);
    }
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('button',{name:'展开创作工具'}).click();
    assert.equal(await page.getByRole('button',{name:'展开创作工具'}).getAttribute('aria-expanded'),'true');
    const canvas = await page.locator('.canvas-host').boundingBox();await page.mouse.click(canvas.x+canvas.width-14,canvas.y+24);
    assert.equal(await page.getByRole('button',{name:'展开创作工具'}).getAttribute('aria-expanded'),'false');
    record('creation rail dismisses on canvas outside pointer');
    for (const label of ['素材库弹窗','知识库弹窗']) {
      await page.getByRole('button',{name:label,exact:true}).click();assert.equal(await page.locator('.clp-header button').count(),0);
      await page.keyboard.press('Escape');assert.equal(await page.locator('.clp-dialog').count(),0);
      await page.getByRole('button',{name:label,exact:true}).click();await page.mouse.click(canvas.x+canvas.width-14,canvas.y+24);
      assert.equal(await page.locator('.clp-dialog').count(),0);record(`${label}: no header close, Escape/outside dismissal preserved`);
    }
    await page.locator('.canvas-r1-agent-context-list li').first().hover();
    const preview = page.locator('.canvas-r1-agent-reference-preview.is-image');assert.equal(await preview.innerText(),'图片');assert.equal(await preview.locator('img').count(),1);
    await page.screenshot({path:path.join(dir,'media-preview.png')});record('media hover is content only');
    await page.locator('.fixture-toolbar').hover();
    const surface = await page.locator('.canvas-r1-agent-panel').evaluate(el => ({background:getComputedStyle(el).backgroundColor,blur:getComputedStyle(el).backdropFilter}));
    assert.match(surface.blur,/blur\(/);assert.match(surface.background,/0\.94/);record('theme-aware 94% opaque frosted Agent surface',surface);
    await page.getByRole('button',{name:'思考强度',exact:true}).click();await page.screenshot({path:path.join(dir,'strength-menu.png')});await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'全屏检查',exact:true}).click();await page.waitForFunction(()=>!!document.fullscreenElement);
    await page.locator('.canvas-agent-strength').click();record('document fullscreen strength contained',await contained(page,'.canvas-agent-strength-popover'));await page.keyboard.press('Escape');
    await page.locator('.canvas-agent-model-trigger').click();record('document fullscreen model contained',await contained(page,'.canvas-agent-model-popover'));await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'全屏检查',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement);
    await page.getByRole('button',{name:'切换主题',exact:true}).click();await page.locator('.canvas-agent-strength').click();await contained(page,'.canvas-agent-strength-popover');
    await page.screenshot({path:path.join(dir,'light-strength-menu.png')});record('light theme menu and surface');
    assert.deepEqual(await page.evaluate(()=>window.fixtureEvents),[]);assert.deepEqual(errors,[]);record('no model/send/apply/remove calls, no page errors');
    }
  } finally {
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({checks,errors},null,2)+'\n');
    await browser?.close();await new Promise(resolve=>server.close(resolve));stop();
  }
  console.log(JSON.stringify({status:'PASS',checks:checks.length,output:dir}));
})().catch(error=>{console.error(error);process.exitCode=1;stop();});
