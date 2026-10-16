// Production viewer + real decoded synthetic PCM. Native file URL resolution is
// the only replaced boundary; no synthetic loaded/play/error events are emitted.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sourceRoot = process.env.LUCKYRAY_MATERIAL_TEST_SOURCE_ROOT || root;
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Roaming/npm/node_modules/@playwright/mcp/node_modules/playwright');

function pcmWav(seconds = 4) {
  const rate = 22050, samples = rate * seconds, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(1200 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  return wav;
}

(async () => {
  const source = fs.readFileSync(sourceRoot + '/src/features/materials/MaterialsPage.tsx', 'utf8');
  const viewer = source.slice(source.indexOf('function MaterialViewer('), source.indexOf('\nfunction ImportProgressOverlay('));
  const script = await esbuild.build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useState,useEffect,useLayoutEffect,useRef} from 'react';
    import{createRoot}from'react-dom/client';import{createPortal}from'react-dom';
    import {matchesShortcut,isTextEntry} from './src/app/shortcuts';
    import {useMaterialViewerHost} from './src/features/materials/useMaterialViewerHost';
    import {MaterialViewProvider,useMaterialViewScope} from './src/features/materials/MaterialViewContext';
    import {resolveMaterialViewerBounds} from './src/features/materials/materialViewerGeometry';
    import {resolveContainedMaterialMediaRect,resolveMaterialMediaDimensions,resolveMaterialVideoPlaybackPath,resolveMaterialVideoSource,shouldDismissMaterialViewerFromBlank} from './src/features/materials/materialViewerInteraction';
    const useI18n=()=>({t:key=>key}), FileIcon=()=> <span>file</span>, ImagePreview=()=>null, NativeVideoInline=()=>null;
    const cachedNativeVideoCover=()=>null, isVideoAsset=asset=>asset.kind==='video', isImageAsset=asset=>asset.kind==='image', getAdjacentAsset=()=>null;
    const resolveVideoPreviewUrl=async()=>'', getMaterialAssetPreviewUrl=async path=>path;
    ${viewer}
    function Fixture(){
      const[id,setId]=useState('one'),[visible,setVisible]=useState(true),[open,setOpen]=useState(true);
      window.fixture={change:setId,hide:()=>setVisible(false),show:()=>setVisible(true),close:()=>setOpen(false)};
      const asset={id,name:id+'.wav',kind:'audio',mimeType:'audio/wav',libraryPath:'/media-'+id+'.wav'};
      return <MaterialViewProvider identity={{viewId:'audio-test',libraryId:'synthetic',visible,focused:true}}>
        {open&&<MaterialViewer asset={asset} assets={[asset]} mode="preview" onChange={()=>{}} onClose={()=>setOpen(false)} onOpenOriginal={()=>{window.shellOpened=true}}/>}
      </MaterialViewProvider>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` }, bundle: true, write: false, outfile: 'app.js', format: 'iife', jsx: 'automatic' });
  const css = fs.readFileSync(sourceRoot + '/src/features/materials/materials.css', 'utf8'), wav = pcmWav();
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/media-')) {
      if (req.url.includes('bad')) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length }); res.end(wav); return;
    }
    res.setHeader('Content-Type', req.url === '/app.js' ? 'text/javascript' : 'text/html;charset=utf-8');
    res.end(req.url === '/app.js' ? script.outputFiles[0].text : `<meta charset="utf-8"><style>${css}body{background:#111;color:#ddd}</style><div id="root"></div><script src="/app.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('[role="dialog"]').waitFor();
    assert.equal(await page.locator('audio[controls]').count(), 1, 'stored audio has a usable playback control, not a generic file placeholder');
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 2);
    assert.equal(await page.locator('audio').evaluate(a => a.paused), true, 'opening does not unexpectedly autoplay');
    await page.locator('audio').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1 && !document.querySelector('audio').paused);
    await page.evaluate(() => { window.oldAudio = document.querySelector('audio'); window.fixture.hide(); });
    // Retained view portals detach on hide. Assert the actual old media is
    // paused, not that a hidden pane must leave an audio element in body.
    await page.waitForFunction(() => window.oldAudio.paused);
    await page.evaluate(() => { window.fixture.change('two'); window.fixture.show(); });
    await page.waitForFunction(() => document.querySelector('audio') !== window.oldAudio && document.querySelector('audio').currentSrc.endsWith('/media-two.wav'));
    assert.equal(await page.evaluate(() => window.oldAudio.paused), true);
    await page.locator('audio').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
    assert.equal(await page.evaluate(() => window.shellOpened), undefined, 'playback does not invoke the external shell');
    await page.evaluate(() => window.fixture.change('bad'));
    await page.locator('.material-audio-unavailable').waitFor();
    assert.equal(await page.locator('[role="dialog"]').count(), 1, 'decode failure is reported without losing the original asset');
    await page.evaluate(() => window.fixture.change('one'));
    await page.waitForFunction(() => document.querySelector('audio').readyState >= 2);
    await page.locator('audio').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
    await page.evaluate(() => { window.closingAudio = document.querySelector('audio'); window.fixture.close(); });
    await page.locator('[role="dialog"]').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.closingAudio.paused);
    assert.deepEqual(errors, []);
    console.log('PASS: production audio controls decode/play, no autoplay, hidden pause, source isolation and explicit failure feedback');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
