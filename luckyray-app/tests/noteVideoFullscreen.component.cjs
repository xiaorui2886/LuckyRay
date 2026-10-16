const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'luckyray-fullscreen-'));
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(root + '/node_modules/vite')] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out + '/video.mp4']);
  const contents = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {I18nProvider} from './src/core/i18n/index';
    import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';
    import {NotePreview} from './src/features/notes/NotePreview';
    import './src/features/notes/notes.css';
    import './src/features/notes/media/noteContent.css';
    const asset = {id:'video',name:'video.mp4',kind:'video',previewUrl:'/video.mp4'};
    const embeds = [{targetName:'video.mp4',assetId:'video',isMissing:0}];
    const text = Array.from({length:12}, (_,i)=>'Paragraph '+i+'\\n\\n').join('')+'![[video.mp4]]';
    function App() {
      const [value,setValue] = useState(text);
      return <main>
        <section id="edit" className="note-content-area">
          <LiveMarkdownEditor currentNoteId="note" value={value} assets={[asset]} notes={[]}
            tags={[]} noteLinks={[]} noteEmbeds={embeds} onChange={setValue}/>
        </section>
        <section id="read" className="note-content-area">
          <NotePreview text={value} assets={[asset]} notes={[]} tags={[]} noteLinks={[]}
            noteEmbeds={embeds} onOpenNote={()=>{}} onCreateNote={()=>{}} onOpenAsset={()=>{}}/>
        </section>
      </main>;
    }
    createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><App/></I18nProvider>);
  `;
  const built = await esbuild.build({
    stdin: {contents, resolveDir:root, loader:'tsx'}, bundle:true, write:false, outdir:out,
    format:'iife', jsx:'automatic', define:{'import.meta.env.DEV':'false'},
    loader:{'.woff2':'dataurl','.svg':'dataurl','.png':'dataurl'},
    plugins:[{name:'production-preview', setup(build) {
      build.onLoad({filter:/NotesPage\.tsx$/}, file=>({
        contents:fs.readFileSync(file.path,'utf8')+'\nexport {NotePreview};', loader:'tsx',
      }));
    }}],
  });
  const js = built.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const css = built.outputFiles.find(file=>file.path.endsWith('.css')).text;
  const video = fs.readFileSync(out+'/video.mp4');
  const server = http.createServer((request,response)=>{
    if(request.url==='/app.js') return response.end(js);
    if(request.url==='/video.mp4') {
      response.setHeader('Content-Type','video/mp4');
      return response.end(video);
    }
    response.setHeader('Content-Type','text/html');
    response.end('<style>'+css+'\nbody{margin:0}main{display:flex;height:100vh}section{width:50%;min-width:0;height:100%}.note-content-area{overflow:hidden!important}.note-preview,.cm-scroller{height:100%;overflow:auto!important}</style><div id="root"></div><script src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true,channel:'msedge'});
  try {
    const page = await browser.newPage({viewport:{width:1100,height:650}});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForFunction(()=>[...document.querySelectorAll('video')].length===2 && [...document.querySelectorAll('video')].every(video=>video.readyState>=2));
    for(const pane of ['read','edit']) {
      for(const entry of ['button','native']) {
        const scroller = page.locator(pane==='read'?'#read .note-preview':'#edit .cm-scroller');
        await scroller.evaluate(element=>element.scrollTop=element.scrollHeight);
        const media = page.locator('#'+pane+' video');
        await media.hover();
        const before = await scroller.evaluate(element=>element.scrollTop);
        assert.ok(before>100, pane+' is scrolled before fullscreen');
        await media.evaluate(element=>{element.currentTime=1;});
        await page.waitForFunction(selector=>{const video=document.querySelector(selector);return !video.seeking&&video.currentTime>=.9;},'#'+pane+' video');
        const height = await media.evaluate(element=>element.parentElement.getBoundingClientRect().height);
        if(entry==='button') {
          await page.locator('#'+pane+' button[aria-label="全屏播放"]').click();
        } else {
          // Unrelated interaction must retain the normal-layout snapshot used
          // by native controls, which can swallow their own pointer events.
          await page.dispatchEvent('body', 'pointerdown');
          // Chromium's native fullscreen control lives in its UA shadow tree.
          const box = await media.boundingBox();
          await page.mouse.click(box.x+box.width-72, box.y+box.height-48);
        }
        await page.waitForFunction(()=>!!document.fullscreenElement);
        assert.ok(await media.evaluate(element=>element.currentTime)>=.9, 'fullscreen preserves playback position');
        assert.equal(await media.evaluate(element=>Math.round(element.parentElement.getBoundingClientRect().height)),Math.round(height),'fullscreen reserves its former layout height');
        await page.setViewportSize({width:1500,height:1000});
        await page.evaluate(async () => {
          const video = document.fullscreenElement;
          // WebView can deliver the exit key after fullscreenchange, before
          // the window has finished returning to its original bounds.
          document.addEventListener('fullscreenchange', () => {
            video.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          }, { once: true });
          await document.exitFullscreen();
        });
        await page.waitForFunction(()=>!document.fullscreenElement);
        await page.setViewportSize({width:1100,height:650});
        await page.waitForFunction(({selector,top})=>Math.abs(document.querySelector(selector).scrollTop-top)<2,{
          selector:pane==='read'?'#read .note-preview':'#edit .cm-scroller',top:before,
        });
        assert.equal(await media.evaluate(element=>element.parentElement.style.height),'');
        if (entry === 'native') {
          // Re-enter without scrolling or resizing: the completed session must
          // leave a fresh normal snapshot for native controls' next invocation.
          await media.hover();
          const box = await media.boundingBox();
          await page.mouse.click(box.x + box.width - 72, box.y + box.height - 48);
          await page.waitForFunction(() => !!document.fullscreenElement);
          assert.equal(
            await media.evaluate(element => Math.round(element.parentElement.getBoundingClientRect().height)),
            Math.round(height),
            'consecutive native fullscreen preserves normal layout',
          );
          await page.evaluate(() => document.exitFullscreen());
          await page.waitForFunction(() => !document.fullscreenElement);
          await page.waitForFunction(({ selector, top }) => Math.abs(document.querySelector(selector).scrollTop - top) < 2, {
            selector: pane === 'read' ? '#read .note-preview' : '#edit .cm-scroller', top: before,
          });
        }
        await scroller.hover();
        await page.mouse.wheel(0,-100);
        await page.evaluate(()=>new Promise(requestAnimationFrame));
        const userPosition = await scroller.evaluate(element=>element.scrollTop);
        await page.setViewportSize({width:1090,height:650});
        await page.evaluate(()=>new Promise(requestAnimationFrame));
        assert.ok((await scroller.evaluate(element=>element.scrollTop))<before-20,'later resize must not restore the expired session');
        await page.setViewportSize({width:1100,height:650});
        console.log(JSON.stringify({pane,entry,before,userPosition,fullscreenScrollRestored:true}));
      }
    }
  } finally {
    await browser.close();
    await new Promise(resolve=>server.close(resolve));
    fs.unlinkSync(out+'/video.mp4');
    fs.rmdirSync(out);
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
