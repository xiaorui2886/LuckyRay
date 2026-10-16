// Isolated production SettingsPage. Browser storage and IPC are fixture-only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');
(async()=>{
 const bundle=await esbuild.build({stdin:{loader:'tsx',resolveDir:root,contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'./src/core/i18n/index';import SettingsPage from './src/features/settings/SettingsPage';import './src/app/appShell.css';
 window.__TAURI_INTERNALS__={invoke:async()=>null};
 createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><SettingsPage/></I18nProvider>);
 `},bundle:true,write:false,outfile:'fixture.js',jsx:'automatic',loader:{'.png':'dataurl','.svg':'dataurl'}});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/fixture.js'?js:`<style>${css}body{background:#111;color:#eee}.luckyray-settings-page{display:block!important;height:100vh}</style><div id="root"></div><script src="/fixture.js"></script>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  const toggle=page.getByRole('switch',{name:'启用搜索模式切换快捷键'});await toggle.waitFor({timeout:5000}).catch(async e=>{console.error({errors,body:(await page.locator('body').innerText()).slice(0,1500)});throw e});assert.equal(await toggle.getAttribute('aria-checked'),'true');
  await toggle.click();assert.equal(await toggle.getAttribute('aria-checked'),'false');
  await page.reload();await toggle.waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false','same persisted setting survives reload');
  await page.locator('.settings-nav-item').filter({hasText:'快捷键'}).click();
  assert.equal(await toggle.count(),0,'no enable toggle squeezed into shortcut table');
  assert.equal(await page.getByText('切换搜索模式',{exact:true}).count(),1,'binding still belongs in shortcuts');
  await page.getByRole('tab',{name:/素材库/}).click();await page.getByRole('region',{name:'影视工具快捷键'}).waitFor();
  assert.equal(await page.getByText('设置入点 / 出点',{exact:true}).count(),1);
  assert.equal(await page.getByText('I / O',{exact:true}).count(),1);
  assert.equal(await page.getByText('Space / K',{exact:true}).count(),1);
  assert.deepEqual(errors,[]);console.log('MATERIAL_SETTINGS_PASS General persistent search switch; binding retained; Materials fixed film reference; no runtime errors');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
