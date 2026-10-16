const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const entry = String.raw`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';import {EditorView} from '@codemirror/view';import {undo,redo} from '@codemirror/commands';import {preparedAttachments} from './src/features/notes/editor/preparedAttachment';import {warmRecentImage} from './src/features/notes/media/noteImageResources';import {attachNoteImage} from './src/features/notes/media/attachNoteImage';window.attachNoteImage=attachNoteImage;
window.prepare=async()=>{const url='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>');await warmRecentImage(url);return {markdown:'![same.png](./exact/a.png)',asset:{id:'exact-a',name:'same.png',kind:'image',previewUrl:url,thumbnailUrl:url},embed:{targetName:'md:./exact/a.png',assetId:'exact-a',isMissing:0,resolutionStatus:'resolved'}};};
function Fixture(){const[value,setValue]=useState('before\n\nafter'),[embeds,setEmbeds]=useState([]);window.authority=setEmbeds;
return <LiveMarkdownEditor ref={h=>window.handle=h} value={value} currentNoteId='A' assets={[]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={embeds} onChange={setValue}/>;}
window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));window.undo=()=>undo(window.view());window.redo=()=>redo(window.view());window.bindings=()=>window.view().state.field(preparedAttachments).length;window.batchBindings=()=>window.view().state.field(preparedAttachments).filter(item=>item.markdown.includes('batch.png')).length;createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  let slowRequests = 0; const pendingImages=[];
  const server = http.createServer((req, res) => {
    if(req.url.startsWith('/slow.svg')){slowRequests++;pendingImages.push(res);return;}
    if(req.url.startsWith('/bad.svg')){res.writeHead(404);res.end();return;}
    res.setHeader(
      "Content-Type",
      req.url === "/fixture.js" ? "text/javascript" : "text/html",
    );
    res.end(
      req.url === "/fixture.js"
        ? built.outputFiles[0].text
        : '<style>body{--text-primary:#ddd;--accent:#8785ff;background:#111}.cm-scroller{height:600px}</style><div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page.waitForFunction(() => window.handle);
    const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
    await page.evaluate(async()=>{window.receipt=await window.prepare();window.handle.replaceRange('\n\n'+window.receipt.markdown+'\n\n',{start:6,end:6},window.receipt);});
    await page.waitForFunction(()=>document.querySelector('.lr-live-asset-preview')?.dataset.imageState==='ready');
    assert.equal(await page.evaluate(()=>window.bindings()),1);
    assert.equal(await page.locator('.lr-live-asset-card.missing').count(),0,'unsaved reference uses publication identity before any index response');
    await page.evaluate(()=>window.undo());
    assert.equal(await page.evaluate(()=>window.bindings()),0,'undo removes active receipt');
    assert.equal(await page.locator('.lr-live-asset-card').count(),0);
    await page.evaluate(()=>window.redo());
    await page.waitForFunction(()=>document.querySelector('.lr-live-asset-preview')?.dataset.imageState==='ready');
    assert.equal(await page.evaluate(()=>window.bindings()),1,'redo restores receipt with the reference');
    await page.evaluate(()=>{window.savedImage=document.querySelector('.lr-live-asset-preview img')});
    await page.evaluate(()=>window.handle.replaceRange('中文快速输入',{start:0,end:0}));
    assert.equal(await page.evaluate(()=>document.querySelector('.lr-live-asset-preview img')===window.savedImage),true,'moving a reference keeps its decoded DOM lease');
    assert.equal(await page.evaluate(()=>window.bindings()),1,'typing maps the exact reference without index reads');
    await page.evaluate(async()=>{
      window.handle.replaceRange('\n\n'+window.receipt.markdown.replace('a.png','b.png')+'\n\n',undefined,{...window.receipt,markdown:window.receipt.markdown.replace('a.png','b.png'),asset:{...window.receipt.asset,id:'b',previewUrl:location.origin+'/slow.svg?vault=A&v=1'},embed:{...window.receipt.embed,targetName:'md:./exact/b.png',assetId:'b'}});
    });
    await page.waitForFunction(()=>document.querySelector('[data-asset-target="./exact/b.png"] [data-image-state="preview"]'));
    assert.equal(slowRequests,1,'mounted image uses the shared original load');
    assert.equal(await page.locator('[data-asset-target="./exact/b.png"] img').evaluate(img=>img.naturalWidth),160);
    for(const res of pendingImages){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="blue"/></svg>');}
    await page.waitForFunction(()=>document.querySelector('[data-asset-target="./exact/b.png"] [data-image-state="ready"]'));
    assert.equal(await page.locator('[data-asset-target="./exact/b.png"] img').evaluate(img=>img.naturalWidth),160,'same aspect survives preview/original transition');
    await page.evaluate(async()=>{
      const r={...window.receipt,markdown:window.receipt.markdown.replace('a.png','error.png'),asset:{...window.receipt.asset,id:'error',previewUrl:location.origin+'/bad.svg?vault=A&v=1'},embed:{...window.receipt.embed,targetName:'md:./exact/error.png',assetId:'error'}};
      await window.prepare();window.handle.replaceRange('\n\n'+r.markdown+'\n\n',undefined,r);
    });
    await page.waitForFunction(()=>document.querySelector('[data-asset-target="./exact/error.png"] [data-image-state="preview-error"]'));
    assert.equal(await page.locator('[data-asset-target="./exact/error.png"] img').evaluate(img=>img.naturalWidth),160,'original failure retains the valid preview with an error');
    await page.evaluate(()=>window.authority([{targetName:'md:./exact/a.png',assetId:null,isMissing:1,resolutionStatus:'missing'}]));
    await page.waitForFunction(()=>document.querySelector('[data-asset-target="./exact/a.png"]')?.classList.contains('missing'));
    await page.evaluate(()=>{
      const source='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="45"><rect width="80" height="45" fill="green"/></svg>');
      const decode=HTMLImageElement.prototype.decode;let count=0;
      window.restoreDecode=()=>{HTMLImageElement.prototype.decode=decode};
      HTMLImageElement.prototype.decode=function(){
        if(++count===2){window.heldImage=this;return new Promise(resolve=>{window.finishDecode=()=>decode.call(this).then(resolve)});}
        return decode.call(this);
      };
      window.newLease=()=>{const root=document.createElement('div');document.body.append(root);return {root,dispose:window.attachNoteImage({root,viewport:root,source,alt:'lease',onState:()=>{}})}};
      window.leaseA=window.newLease();window.leaseB=window.newLease();
    });
    await page.waitForFunction(()=>window.finishDecode);
    await page.evaluate(async()=>{window.leaseB.dispose();window.leaseC=window.newLease();await window.finishDecode();await new Promise(requestAnimationFrame);});
    assert.equal(await page.evaluate(()=>window.leaseC.root.contains(window.heldImage)),true,'a disposed decode callback must not steal a node acquired by another pane');
    await page.evaluate(()=>{window.restoreDecode();window.leaseA.dispose();window.leaseC.dispose();});
    await page.evaluate(()=>{const r={...window.receipt,markdown:'![batch](./exact/batch.png)',asset:{...window.receipt.asset,id:'batch'},embed:{...window.receipt.embed,targetName:'md:./exact/batch.png',assetId:'batch'}};window.handle.replaceRange('\n\n'+r.markdown+'\n'+r.markdown+'\n\n',undefined,[r,r]);});
    assert.equal(await page.evaluate(()=>window.batchBindings()),2,'one batch maps both identical published references to distinct positions');
    await page.evaluate(()=>window.undo());
    assert.equal(await page.evaluate(()=>window.batchBindings()),0,'undo removes all batch receipts together');
    await page.evaluate(()=>window.redo());
    assert.equal(await page.evaluate(()=>window.batchBindings()),2,'redo restores both batch receipts');
    assert.deepEqual(errors,[]);
    console.log('PASS: real editor transaction, delayed index, exact identity, decoded preview, undo/redo, batch receipts, position mapping, authoritative missing takeover');
  } finally {
    for (const res of pendingImages) res.end();
    await browser?.close();
    await new Promise((r) => server.close(r));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
