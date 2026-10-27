// Mount the production detail component with the repository's esbuild/Playwright
// fixture. No user profile, browser history or real material database is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const playwrightPath = process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
  'playwright';
const { chromium } = require(playwrightPath);
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(root, 'node_modules', 'vite'))] }));
const out = fs.mkdtempSync(path.join(root, 'node_modules', '.material-source-mount-'));
const entry = path.join(out, 'entry.tsx');
const bundle = path.join(out, 'app.js');

const workUrl = 'https://works.test/item/alpha?work=42#section-3';
const captureUrl = 'https://video.example/watch?v=fixture&t=9#player';
const asset = (id, kind, originalPath, libraryPath) => ({
  id, name: id + (kind === 'video' ? '.webm' : '.png'), kind,
  mimeType: kind === 'video' ? 'video/webm' : 'image/png', sizeBytes: 4,
  originalPath, libraryPath, storageMode: libraryPath ? 'managed' : 'linked',
  description: '', importedAt: '2026-09-23T08:00:00+08:00',
  updatedAt: '2026-09-23T08:00:00+08:00', thumbnailUrl: '',
  dominantColor: null, folderId: null, contentHash: 'synthetic',
});
const assets = [
  asset('webA', 'image', 'https://cdn.example.test/private/a.png?sig=SECRET', 'D:/synthetic/a.png'),
  asset('webB', 'image', 'https://site-b.test', 'D:/synthetic/b.png'),
  asset('recD', 'video', 'recording://20260922-120000', 'D:/synthetic/d.webm'),
  asset('badE', 'image', 'https://user:pass@bad.test/a.png', 'D:/synthetic/e.png'),
];
const pageRecords = {
  webA: { assetId: 'webA', pageUrl: workUrl, pageKind: 'work-page', title: null },
  recD: { assetId: 'recD', pageUrl: captureUrl, pageKind: 'capture-page', title: null },
};

const slash = (value) => value.replaceAll('\\', '/');
fs.writeFileSync(entry, [
  "import React from 'react';",
  "import { createRoot } from 'react-dom/client';",
  "import '" + slash(path.join(root, 'src/core/theme/themeTokens.css')) + "';",
  "import '" + slash(path.join(root, 'src/app/appShell.css')) + "';",
  "import { I18nProvider } from '" + slash(path.join(root, 'src/core/i18n/index')) + "';",
  "import { MaterialsDetailPanel } from '" + slash(path.join(root, 'src/features/materials/MaterialsPage.tsx')) + "';",
  'const assets = ' + JSON.stringify(assets) + ';',
  'function App() {',
  "  const [selected, setSelected] = React.useState('webA');",
  '  const [revision, setRevision] = React.useState(0);',
  '  const currentAsset = React.useMemo(() => ({...assets.find(item => item.id === selected)}), [selected, revision]);',
  '  window.__refreshAsset = () => setRevision(value => value + 1);',
  '  window.__selectAsset = setSelected;',
  "  return <I18nProvider locale=\"zh-CN\"><div className=\"material-viewer-react\" style={{width:'100%',height:'100%'}}><MaterialsDetailPanel",
  '    asset={currentAsset}',
  "    resolution={null} onClose={() => {}} onOpen={() => {}} onReveal={async () => false} onRelocate={async () => 'cancelled'}",
  '    relocating={false} onPreview={() => {}} onCompare={() => {}} onUpdated={() => {}} selectedCount={0} onBatchTags={() => {}}',
  '    onInsertToNote={() => {}} onAskAi={() => {}} favorite={false} onToggleFavorite={() => {}} />',
  '  </div></I18nProvider>;',
  '}',
  "createRoot(document.getElementById('root')).render(<App />);",
].join('\n'));

async function run() {
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile: bundle, format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.webp': 'dataurl', '.png': 'dataurl' },
    plugins: [{name:'vite-raw-svg', setup(build) {
      build.onResolve({filter:/\.svg\?raw$/}, args=>({path:path.resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-svg'}));
      build.onLoad({filter:/.*/,namespace:'raw-svg'}, args=>({contents:fs.readFileSync(args.path,'utf8'),loader:'text'}));
    }}],
    define: { 'process.env.NODE_ENV': '"test"' }, logLevel: 'error',
  });
  const server = http.createServer((request, response) => {
    if (request.url === '/app.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(fs.readFileSync(bundle));
    } else if (request.url === '/app.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end(fs.readFileSync(path.join(out, 'app.css')));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><link rel="stylesheet" href="/app.css"><div id="root"></div><script src="/app.js"></script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript((records) => {
      window.__calls = [];
      window.__opened = [];
      window.__copies = [];
      window.__failOpen = false;
      window.__failCopy = false;
      window.__delaySource = false;
      window.__pendingSource = [];
      window.__tags = [{ id: 'existing', name: '已有标签' }];
      window.__assetTags = {};
      window.__created = [];
      window.__tagWrites = [];
      window.__failTagAttach = false;
      window.__delayCreate = false;
      window.__finishCreate = null;
      window.__delayTagRead = false;
      window.__tagReadResolvers = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => {
          if (window.__failCopy) throw new Error('clipboard denied');
          window.__copies.push(text);
        } },
      });
      window.__LUCKYRAY__ = {
        listTags: async () => window.__tags,
        getAssetTags: async id => {
          if (window.__delayTagRead) await new Promise(resolve=>window.__tagReadResolvers.push(resolve));
          return window.__assetTags[id] || [];
        },
        createTag: async ({name}) => {
          window.__created.push(name);
          const tag = {id:'new-'+window.__created.length,name};
          window.__tags.push(tag);
          if (window.__delayCreate) await new Promise(resolve => window.__finishCreate = resolve);
          return tag;
        },
        setAssetTags: async (id, ids) => {
          if (window.__failTagAttach) throw Error('synthetic attachment failure');
          window.__tagWrites.push({id,ids});
          window.__assetTags[id] = ids;
          return ids;
        },
        getAssetAiSuggestion: async () => null,
        openExternalUrl: async url => {
          if (window.__failOpen) throw new Error('opener denied');
          window.__opened.push(url);
        },
      };
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
        window.__calls.push({ command, args });
        if (command === 'material_catalog_get_source_page') {
          if (window.__delaySource && args.assetId === 'webA') {
            return new Promise(resolve => window.__pendingSource.push(() => resolve(records[args.assetId] || null)));
          }
          return records[args.assetId] || null;
        }
        return null;
      } };
    }, pageRecords);
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'load' });
    const section = page.locator('.material-source-section');
    await section.waitFor({ timeout: 10_000 });
    await section.locator('.material-source-link').waitFor();
    // Real inspector inside the viewer portal, where global button resets used to win.
    const description = page.locator('.detail-textarea-react');
    for (const selector of ['.detail-input-react', '.detail-textarea-react']) {
      assert.equal(await page.locator(selector).evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)','original transparent field background');
    }
    assert.equal(await description.getAttribute('rows'), '1');
    const emptyHeight = (await description.boundingBox()).height;
    assert.ok(emptyHeight <= 36, 'empty description occupies a single line');
    await description.fill('第一行\n第二行\n第三行\n第四行');
    assert.ok((await description.boundingBox()).height > emptyHeight, 'content expands the field');
    await description.fill('');
    assert.equal((await description.boundingBox()).height, emptyHeight, 'clearing shrinks it again');
    assert.equal(await page.getByRole('button', {name:/导出素材清单/}).count(), 0);
    for (const selector of ['.ai-suggest-btn-react', '.detail-add-tag-wrap-react .detail-add-tag-react', '.detail-new-tag-react']) {
      const style = await page.locator(selector).evaluate(el => ({border:getComputedStyle(el).borderTopWidth,bg:getComputedStyle(el).backgroundColor,height:el.getBoundingClientRect().height}));
      assert.equal(style.border,'1px',selector+' keeps a visible border in the viewer');
      assert.notEqual(style.bg,'rgba(0, 0, 0, 0)');
      assert.equal(style.height,28);
    }
    assert.equal(await page.locator('.ai-suggest-btn-react svg').count(),0,'AI generate stays text-only');
    const buttonStyles = await page.locator('.ai-suggest-btn-react,.detail-add-tag-wrap-react .detail-add-tag-react').evaluateAll(elements=>elements.map(el=>{
      const style=getComputedStyle(el);return [style.backgroundColor,style.color,style.border,style.fontWeight,style.fontSize];
    }));
    assert.deepEqual(buttonStyles[0],buttonStyles[1],'AI and Add share the same neutral button style');
    const copy = section.getByRole('button', {name:'复制'}).first();
    assert.equal(await copy.textContent(),'','copy is icon-only with an accessible name');
    assert.equal(await copy.locator('svg').count(),1);
    assert.equal((await copy.boundingBox()).width,28);
    const linkBox = await section.locator('.material-source-link').boundingBox();
    assert.ok(Math.abs(linkBox.y + linkBox.height/2 - ((await copy.boundingBox()).y + 14)) < 2,'copy stays on the URL row');
    const beforeTagY = (await page.locator('.detail-ai-inline-react').boundingBox()).y;
    await page.getByRole('button',{name:'添加',exact:true}).click();
    await page.getByRole('button',{name:'已有标签',exact:true}).click();
    await page.waitForFunction(()=>window.__assetTags.webA?.includes('existing'));
    await page.waitForFunction(()=>!document.querySelector('.detail-add-tag-wrap-react .detail-add-tag-react').disabled);
    assert.equal((await page.locator('.detail-ai-inline-react').boundingBox()).y,beforeTagY,'tag success must not expand the metadata status row');
    await description.fill('未保存的描述');
    await page.evaluate(()=>{window.__delayTagRead=true; window.__refreshAsset();});
    await page.waitForFunction(()=>window.__tagReadResolvers.length>0);
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await description.inputValue(),'未保存的描述','same-asset background refresh preserves editing');
    assert.equal(await page.getByRole('button',{name:/^已有标签\s*×$/}).count(),1,'old tags remain visible during background read');
    await page.evaluate(()=>{window.__delayTagRead=false;window.__tagReadResolvers.splice(0).forEach(resolve=>resolve());});
    await page.waitForFunction(()=>!document.querySelector('.detail-add-tag-wrap-react .detail-add-tag-react').disabled);
    await description.fill('');
    await page.getByRole('button',{name:'新建标签',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'新建',exact:true}).isDisabled(),true,'blank names cannot submit');
    await page.getByRole('textbox',{name:'新建标签',exact:true}).press('Escape');
    assert.equal(await page.getByRole('textbox',{name:'新建标签',exact:true}).count(),0,'Escape cancels the new-tag form');
    assert.equal(await page.locator('.material-viewer-detail').count(),1,'cancelling creation keeps the inspector');
    await page.getByRole('button',{name:'新建标签',exact:true}).click();
    await page.getByRole('textbox',{name:'新建标签',exact:true}).fill('新标签');
    await page.getByRole('textbox',{name:'新建标签',exact:true}).press('Enter');
    await page.waitForFunction(()=>window.__assetTags.webA?.includes('new-1'));
    assert.deepEqual(await page.evaluate(()=>window.__assetTags.webA),['existing','new-1'],'new tag attaches without losing existing tags');
    const newTag=page.getByRole('button',{name:/^新标签\s*×$/});
    const tagStyle=await newTag.evaluate(el=>({height:el.getBoundingClientRect().height,radius:getComputedStyle(el).borderRadius,border:getComputedStyle(el).borderTopWidth,color:getComputedStyle(el).color}));
    assert.equal(tagStyle.height,28);assert.equal(tagStyle.radius,'6px');assert.equal(tagStyle.border,'1px');
    assert.equal(await newTag.locator('span').evaluate(el=>getComputedStyle(el).fontSize),'14px');
    const stableY=(await page.locator('.detail-ai-inline-react').boundingBox()).y;
    await page.getByRole('button',{name:/^已有标签\s*×$/}).click();
    await page.waitForFunction(()=>!window.__assetTags.webA.includes('existing'));
    await page.waitForFunction(()=>!document.querySelector('.detail-add-tag-wrap-react .detail-add-tag-react').disabled);
    assert.equal((await page.locator('.detail-ai-inline-react').boundingBox()).y,stableY,'removing a tag does not shift the upper panel');
    assert.equal(await newTag.evaluate(el=>getComputedStyle(el).color),tagStyle.color,'remaining tag retains its color');
    await page.getByRole('tab',{name:'分类详情',exact:true}).click();
    await page.evaluate(()=>window.__refreshAsset());
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.getByRole('tab',{name:'分类详情',exact:true}).getAttribute('aria-selected'),'true','background refresh keeps the active detail tab');
    await page.getByRole('tab',{name:'检查器',exact:true}).click();
    // Failure keeps the created tag and name; retry attaches it without creating another.
    await page.getByRole('button',{name:'新建标签',exact:true}).click();
    await page.getByRole('textbox',{name:'新建标签',exact:true}).fill('待关联标签');
    await page.evaluate(()=>window.__failTagAttach=true);
    await page.getByRole('button',{name:'新建',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.detail-tag-status-react')?.textContent.includes('标签保存失败'));
    assert.equal(await page.getByRole('textbox',{name:'新建标签',exact:true}).inputValue(),'待关联标签');
    await page.evaluate(()=>window.__failTagAttach=false);
    await page.getByRole('button',{name:'新建',exact:true}).click();
    await page.waitForFunction(()=>window.__assetTags.webA?.includes('new-2'));
    assert.deepEqual(await page.evaluate(()=>window.__created),['新标签','待关联标签']);
    // Changing selection while creation is pending must never attach to the new asset.
    await page.getByRole('button',{name:'新建标签',exact:true}).click();
    await page.getByRole('textbox',{name:'新建标签',exact:true}).fill('慢创建');
    await page.evaluate(()=>window.__delayCreate=true);
    await page.getByRole('button',{name:'新建',exact:true}).click();
    await page.waitForFunction(()=>!!window.__finishCreate);
    assert.equal(await page.getByRole('button',{name:'新建',exact:true}).isDisabled(),true);
    await page.evaluate(()=>window.__selectAsset('webB'));
    await page.waitForFunction(()=>document.querySelector('.detail-input-react')?.value==='webB.png');
    await page.evaluate(()=>{window.__delayCreate=false;window.__finishCreate();});
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(()=>window.__tagWrites.some(w=>w.ids.includes('new-3'))),false);
    await page.evaluate(()=>window.__selectAsset('webA'));
    await section.locator('.material-source-link').waitFor();
    assert.equal(await section.locator('.material-source-link').innerText(), workUrl);
    assert.match(await section.innerText(), /作品页面/);
    assert.doesNotMatch(await section.innerText(), /SECRET|private\/a\.png/);
    await section.locator('.material-source-link').click();
    await section.getByRole('button', { name: '复制' }).first().click();
    await page.waitForFunction(() => window.__opened.length === 1 && window.__copies.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__opened), [workUrl]);
    assert.deepEqual(await page.evaluate(() => window.__copies), [workUrl]);
    assert.equal(await section.getByRole('link', { name: workUrl }).getAttribute('href'), workUrl);
    await section.locator('.material-source-link').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__opened.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__opened), [workUrl, workUrl]);
    assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);

    await page.evaluate(() => window.__selectAsset('recD'));
    await page.waitForFunction((expected) => document.querySelector('.material-source-link')?.textContent === expected, captureUrl);
    assert.match(await section.innerText(), /采集页面/);
    await section.locator('.material-source-link').click();
    assert.deepEqual(await page.evaluate(() => window.__opened), [workUrl, workUrl, captureUrl]);

    await page.evaluate(() => window.__selectAsset('webB'));
    await page.waitForFunction(() => document.querySelector('.material-source-section')?.textContent.includes('site-b.test'));
    assert.equal(await section.locator('.material-source-link').count(), 0);
    assert.match(await section.innerText(), /仅网站/);
    await page.setViewportSize({ width: 390, height: 820 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.evaluate(() => { window.__delaySource = true; window.__selectAsset('webA'); });
    await page.waitForFunction(() => window.__pendingSource.length === 1);
    await page.evaluate(() => window.__selectAsset('webB'));
    await page.waitForFunction(() => document.querySelector('.material-source-section')?.textContent.includes('site-b.test'));
    await page.evaluate(() => { window.__delaySource = false; window.__pendingSource.splice(0).forEach(release => release()); });
    assert.equal(await section.locator('.material-source-link').count(), 0, 'late A read must not appear on B');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => window.__selectAsset('webA'));
    await section.locator('.material-source-link').waitFor();
    assert.equal(await section.locator('.material-source-link').getAttribute('href'), workUrl);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));

    await page.evaluate(() => window.__selectAsset('badE'));
    await page.waitForFunction(() => document.querySelector('.material-source-section')?.textContent.includes('未记录来源'));
    assert.doesNotMatch(await section.innerText(), /user:pass/);
    await page.evaluate(() => window.__selectAsset('webA'));
    await section.locator('.material-source-link').waitFor();
    await page.evaluate(() => { window.__failOpen = true; window.__failCopy = true; });
    await section.locator('.material-source-link').click();
    await page.waitForFunction(() => document.querySelector('.detail-status-react')?.textContent.includes('打开链接失败'));
    await section.getByRole('button', { name: '复制' }).first().click();
    await page.waitForFunction(() => document.querySelector('.detail-status-react')?.textContent.includes('复制失败'));
    assert.equal(await section.locator('.material-source-note-toggle,.material-source-export,.material-source-export-row').count(), 0);
    const calls = await page.evaluate(() => window.__calls);
    assert.ok(calls.some(call => call.command === 'material_catalog_get_source_page' && call.args.assetId === 'webA'));
    assert.ok(!calls.some(call => /source_note|export_material_asset_file/.test(call.command)));
    assert.deepEqual(pageErrors, []);
    if (process.env.LUCKYRAY_DETAIL_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.LUCKYRAY_DETAIL_SCREENSHOT_DIR,{recursive:true});
      for (const theme of ['dark','light']) {
        await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
        await page.locator('.detail-body').evaluate(el=>el.scrollTop=0);
        await page.screenshot({path:path.join(process.env.LUCKYRAY_DETAIL_SCREENSHOT_DIR,`detail-${theme}.png`)});
      }
    }
    console.log('MATERIAL-SOURCE-DETAIL-MOUNT-OK');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

const timeout = setTimeout(() => { console.error('MATERIAL-SOURCE-DETAIL-MOUNT-TIMEOUT'); process.exit(124); }, 45_000);
run().then(() => clearTimeout(timeout)).catch(error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
