// Real production React components in a headless browser. Transport is synthetic;
// native IPC is covered separately by extension-v1-community/multiwebview.mjs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');
const out = process.env.LUCKYRAY_EVIDENCE_DIR || path.join(root, '.tmp-community156');
const pack = JSON.parse(fs.readFileSync(root + '/plugin-sdk/examples/page-desk/example.page-desk.lrpack.json'));
(async () => {
  fs.mkdirSync(out, { recursive: true });
  await esbuild.build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/App.css';
    import './src/app/appShell.css';
    import './src/core/theme/themeTokens.css';
    import CommunityPage from './src/features/community/CommunityPage';
    import LightSeekToolsMenu from './src/features/ai/LightSeekToolsMenu';
    import { I18nProvider } from './src/core/i18n/index';
    import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from './src/app/applicationModalIsolation';
    import { extensionPackages } from './src/core/extensions/packages';
    const pack = ${JSON.stringify(pack)};
    const state = { revision: 1, hostVersion: '1.9.3', packages: [{ package: pack, enabled: true, digest: 'fixture', grants: [], epoch: 1 }] };
    window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
      if (command === 'manage_extension_packages') { if (window.failList) throw Error('fixture-list-failed'); return structuredClone(state); }
      if (command === 'dsh_plugin_compat_status') return { runtimeVersion: window.noVersion ? null : '0.1.5-rc.2', manifestValid: true, plugins: [], inactiveDependencies: [{packageName: 'fixture.disabled', version: '1.0.0', installed: true}], patchLayers: [{layer:'profile',state:'read'}], historicalQuarantine: [], bundles: [], quarantineSet: [] };
      if (command === 'dsh_plugin_compat_check') { window.checks++; return { checked: true }; }
      if (command === 'get_collection_server_base_url') return 'http://127.0.0.1:1';
      if (command === 'get_local_transport_client_config') return { baseUrl:'http://127.0.0.1:1', credential:'' };
      return null;
    } };
    window.fetch = async () => new Response(JSON.stringify({capabilities:[]}), {headers:{'Content-Type':'application/json'}});
    window.checks = 0; window.restarts = 0;
    document.getElementById('root').className = 'react-nav-shell';
    document.getElementById('root').style.display = 'block';
    window.refreshPackages = () => extensionPackages.refresh();
    createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><div className="test-titlebar"><LightSeekToolsMenu restarting={false} onRestart={() => window.restarts++} onOpenChange={value => document.body.dataset.toolsOpen = String(value)} /></div><CommunityPage /></ApplicationModalIsolationProvider></I18nProvider>);
  ` }, bundle: true, format: 'iife', outfile: path.join(out, 'app.js') });
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--theme-app-bg);color:var(--text-primary);font-family:Inter,"Microsoft YaHei",sans-serif}#root{height:100vh;overflow:auto}.test-titlebar{height:44px;display:flex;justify-content:flex-end;padding:8px 24px;box-sizing:border-box}#page-community{display:block;min-height:calc(100vh - 44px);overflow:visible}.titlebar-ai-browser{width:32px;height:28px;color:var(--text-primary);background:var(--bg-elevated);border:0;border-radius:7px}</style><div id="root"></div><script src="/app.js"></script></html>';
  const server = http.createServer((req, res) => {
    if (['/app.js','/app.css'].includes(req.url)) { res.setHeader('Content-Type', req.url.endsWith('css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(out, req.url.slice(1)))); }
    else { res.setHeader('Content-Type','text/html'); res.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({viewport:{width:1120,height:780}});
    const errors=[]; page.on('pageerror',error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.getByText('页面示例台',{exact:true}).waitFor();
    assert.equal(await page.locator('.plugin-permissions').count(),0);
    assert.equal(await page.getByText('卸载',{exact:true}).count(),0);
    await page.getByRole('searchbox').fill('missing-fixture');
    await page.getByText('没有匹配的扩展包。',{exact:true}).waitFor();
    await page.getByRole('searchbox').fill('');
    for (const theme of ['dark','light','rose-tea']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.waitForTimeout(350); // Let the production theme transitions settle.
      await page.screenshot({path:path.join(out, 'community-'+theme+'.png'),fullPage:true});
    }
    const trigger=page.getByRole('button',{name:'LSH 工具',exact:true});
    await trigger.focus(); await page.keyboard.press('ArrowDown');
    await page.getByRole('menu').waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'检查扩展');
    assert.equal(await page.evaluate(()=>document.body.dataset.toolsOpen),'true');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await page.getByRole('dialog').getByText('0.1.5-rc.2',{exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'lsh-about.png')});
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='LSH 工具');
    assert.equal(await page.evaluate(()=>document.body.dataset.toolsOpen),'false');
    await trigger.click(); await page.getByRole('menuitem',{name:'检查扩展',exact:true}).click();
    await page.getByText('fixture.disabled@1.0.0',{exact:true}).waitFor();
    await page.getByRole('button',{name:'重新检查扩展',exact:true}).click();
    await page.waitForFunction(()=>window.checks===1);
    await page.getByRole('button',{name:'重新检查扩展',exact:true}).waitFor();
    await page.screenshot({path:path.join(out,'lsh-check.png')});
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.noVersion=true);
    await trigger.click(); await page.getByRole('menuitem',{name:'关于 LSH',exact:true}).click();
    await page.getByText('暂时无法读取运行时版本',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await trigger.click(); await page.getByRole('heading',{name:'社区',exact:true}).click();
    assert.equal(await page.getByRole('menu').count(),0);
    assert.equal(await page.evaluate(()=>window.restarts),0);
    await page.setViewportSize({width:420,height:740});
    await page.screenshot({path:path.join(out,'community-narrow.png'),fullPage:true});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal document overflow');
    await trigger.click();
    const menu=await page.getByRole('menu').boundingBox();
    assert.ok(menu.x>=0 && menu.x+menu.width<=420);
    await page.keyboard.press('Escape');
    await page.evaluate(()=>window.failList=true);
    await page.getByRole('tab',{name:'主题',exact:true}).click();
    await page.getByRole('tab',{name:'插件',exact:true}).click();
    await page.getByText(/下方保留上次读取的列表/).waitFor();
    await page.screenshot({path:path.join(out,'community-error.png'),fullPage:true});
    await page.evaluate(()=>window.failList=false);
    await page.getByRole('button',{name:'重试',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.ext-packages-load-error'));
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'browser-result.json'),JSON.stringify({ok:true,checks:['search','compact permissions','3 themes','420px','keyboard menu','outside close','focus return','about actual projection/unavailable','compat recheck','stale list/retry'],transport:'synthetic'},null,2));
    console.log('PASS #156 production React render, menu interaction, narrow layout, themes and error recovery');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
