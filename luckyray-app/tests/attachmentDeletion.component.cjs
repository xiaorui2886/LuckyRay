const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const esbuild=require(require.resolve('esbuild',{paths:[fs.realpathSync(root+'/node_modules/vite')]}));
const {chromium}=require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const visualDir=process.env.LUCKYRAY_ISSUE209_SCREENSHOT_DIR;
 const visualCss=visualDir?fs.readFileSync(root+'/src/features/notes/editor/liveMarkdown.css','utf8')+fs.readFileSync(root+'/src/features/notes/media/noteMedia.css','utf8'):'';
 const entry=String.raw`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {EditorView} from '@codemirror/view';import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';
 const url='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="red"/></svg>');
 const assets=[{id:'img',name:'image.svg',kind:'image',previewUrl:url},{id:'video',name:'video.mp4',kind:'video',previewUrl:'/video.mp4',thumbnailUrl:url}];
 const targets=['./image.svg','./图 片(1).svg','./%E5%9B%BE%20%E7%89%87%281%29.svg'];
 const embeds=[...targets.map(target=>({targetName:'md:'+target,assetId:'img',isMissing:0,resolutionStatus:'resolved'})),{targetName:'md:./video.mp4',assetId:'video',isMissing:0,resolutionStatus:'resolved'}];
 function Fixture({text}){const[value,setValue]=useState(text),[available,setAvailable]=useState(assets),[links,setLinks]=useState(embeds);window.clearProjection=()=>{setAvailable([]);setLinks([])};return <LiveMarkdownEditor value={value} currentNoteId='qa' assets={available} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={links} onChange={setValue}/>}
 const app=createRoot(document.getElementById('root'));let id=0;window.mount=text=>app.render(<Fixture key={++id} text={text}/>);window.view=()=>EditorView.findFromDOM(document.querySelector('.cm-editor'));window.mount('');`;
 const built=await esbuild.build({stdin:{contents:entry,resolveDir:root,loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',loader:{'.css':'empty'}});
 const server=http.createServer((req,res)=>{if(req.url==='/video.mp4'){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?built.outputFiles[0].text:`<style>.cm-scroller{height:600px}.lr-live-asset-card{display:block}.lr-live-asset-card img{width:160px}${visualCss}</style><div id="root"></div><button id="outside">Outside</button><script src="/fixture.js"></script>`)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;const checked=[];
 try{
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto('http://127.0.0.1:'+server.address().port);
  const mount=async text=>{await page.evaluate(text=>window.mount(text),text);await page.waitForFunction(text=>window.view()?.state.doc.toString()===text,text)};
  const caret=async pos=>page.evaluate(pos=>{const v=window.view();v.dispatch({selection:{anchor:pos},scrollIntoView:true});v.focus()},pos);
  const read=()=>page.evaluate(()=>({text:window.view().state.doc.toString(),selection:window.view().state.selection.main.toJSON(),source:!!document.querySelector('.lr-live-asset-source'),selected:!!document.querySelector('.lr-live-asset-card.selected')}));
  const clickSource=async()=>{await page.locator('.lr-live-asset-card').hover();await page.getByRole('button',{name:'编辑引用源码',exact:true}).click();};
  const image='![图片](./image.svg)',wiki='![[image.svg]]';
  for(const [name,token,prefix,suffix] of [
   ['markdown',image,'before\n\n','\n\nafter'],['wiki',wiki,'',''],
   ['unicode','![中文](<./图 片(1).svg>)','','\n'],['encoded','![中文](./%E5%9B%BE%20%E7%89%87%281%29.svg)','\n',''],
   ['video','[视频](./video.mp4)','',''],['continuous',wiki,image+'\n\n',''],['inline',image,'左','右'],
  ]){
   const text=prefix+token+suffix,from=prefix.length,to=from+token.length;await mount(text);await caret(to);
   await page.locator('.cm-content').press('Backspace');let result=await read();
   assert.equal(result.text,text,name+': first Backspace must preserve the complete reference');
   assert.deepEqual([Math.min(result.selection.anchor,result.selection.head),Math.max(result.selection.anchor,result.selection.head)],[from,to],name+': select exact token');
   assert.equal(result.source,false,name+': whole selection keeps preview');assert.equal(result.selected,true,name+': selected feedback');
   await page.locator('.cm-content').press('Backspace');assert.equal((await read()).text,prefix+suffix,name+': second Backspace deletes only the reference');
   await page.locator('.cm-content').press('Control+z');assert.equal((await read()).text,text,name+': undo restores complete reference');
   await page.locator('.cm-content').press('Control+y');assert.equal((await read()).text,prefix+suffix,name+': redo');
   await mount(text);await caret(from);await page.locator('.cm-content').press('Delete');assert.equal((await read()).text,text,name+': forward first press selects');
   await page.locator('.cm-content').press('Delete');assert.equal((await read()).text,prefix+suffix,name+': selected Delete removes exact token');checked.push(name);
  }
  await mount(image);await caret(image.length);await page.locator('.cm-content').press('Backspace');await page.locator('.cm-content').press('Backspace');await page.evaluate(()=>window.clearProjection());await page.evaluate(()=>new Promise(requestAnimationFrame));await page.locator('.cm-content').press('Control+z');assert.equal(await page.locator('.lr-live-asset-card.missing').count(),0,'undo after the saved index drops the reference must retain its known presentation');
  await mount(image+'\n\ntext');await caret(image.length+1);await page.locator('.cm-content').press('Backspace');assert.equal((await read()).text,image+'\ntext','an adjacent blank line retains normal newline deletion');
  await mount('ordinary正文');await caret(10);await page.locator('.cm-content').press('Backspace');assert.equal((await read()).text,'ordinary正','ordinary text is not intercepted');
  await mount('`'+image+'`');await caret(1+image.length);await page.locator('.cm-content').press('Backspace');assert.equal((await read()).text,'`'+image.slice(0,-1)+'`','code is not an attachment widget');
  await mount(image);await caret(image.length);await page.evaluate(()=>{window.mediaNode=document.querySelector('.lr-live-asset-card img')});await page.locator('.cm-content').press('ArrowLeft');assert.equal((await read()).source,false,'ordinary backward navigation keeps rendered attachment');assert.equal((await read()).selected,true,'first backward step selects the attachment');await page.locator('.cm-content').press('ArrowLeft');assert.equal((await read()).selection.anchor,0,'second backward step lands before the attachment');
  await page.locator('.cm-content').press('Shift+ArrowRight');assert.equal((await read()).source,false,'Shift across a rendered attachment keeps its preview');assert.equal((await read()).selected,true,'Shift across selects the whole attachment');
  await page.locator('.cm-content').press('Escape');assert.equal((await read()).selected,false,'Escape clears attachment selection without deleting it');assert.equal((await read()).text,image,'Escape preserves the reference');
  await page.locator('.lr-live-asset-card').click({position:{x:12,y:12}});assert.equal((await read()).selected,true,'ordinary click selects the rendered attachment');assert.equal((await read()).source,false,'ordinary click does not reveal raw source');
  assert.equal(await page.evaluate(()=>window.mediaNode===document.querySelector('.lr-live-asset-card img')),true,'selection reuses the decoded media DOM node');
  if(visualDir){fs.mkdirSync(visualDir,{recursive:true});for(const theme of ['dark','light']){await page.evaluate(theme=>{document.body.style.background=theme==='dark'?'#101116':'#f5f5f7';document.body.style.color=theme==='dark'?'#f8f8fa':'#191921';document.body.style.setProperty('--text-primary',theme==='dark'?'#f8f8fa':'#191921');document.body.style.setProperty('--text-secondary',theme==='dark'?'#a4a4af':'#686873');document.body.style.setProperty('--accent','#7884fa');},theme);await page.locator('.cm-editor').screenshot({path:path.join(visualDir,`attachment-${theme}.png`)});}}
  await page.locator('.cm-content').press('Escape');assert.equal((await read()).selected,false,'Escape leaves click selection');
  await mount(image);await caret(image.length);await clickSource();assert.equal((await read()).source,true,'source action remains explicit');
  await page.locator('#outside').click();assert.equal((await read()).source,false,'blur returns explicit source editing to preview');
  await clickSource();assert.equal((await read()).source,true,'source action may be entered again');
  await page.locator('.cm-content').press('Escape');assert.equal((await read()).source,false,'Escape returns explicit source editing to preview');
  await clickSource();assert.equal((await read()).source,true,'source action may be entered again');
  await page.locator('.cm-content').press('Backspace');assert.equal((await read()).text.length,image.length-1,'source editing uses ordinary text deletion');
  await mount(image);await caret(image.length);await page.evaluate(()=>{window.view().contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));window.view().contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',code:'Backspace',bubbles:true,isComposing:true}));});assert.equal((await read()).text,image,'IME owns Backspace');assert.equal((await read()).selection.anchor,image.length,'IME does not start attachment selection');
  console.log('PASS: two-step attachment deletion, '+checked.join(', ')+', blanks/prose/code, atomic arrows, click/escape/blur, media-node reuse, IME, undo/redo');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
