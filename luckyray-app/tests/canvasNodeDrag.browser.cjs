// Automated local Chromium regression: real ReactFlow + production private node view.
// No desktop access, native persistence, paid model calls, or external HTTP requests.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { build } = createRequire(require.resolve('vite'))('esbuild');
const { chromium } = require(process.env.LR_PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const dir = process.env.LR_NODE_DRAG_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'lr-node-drag-'));
  fs.mkdirSync(dir,{recursive:true});
  const source = path.resolve('src/CanvasSpike.tsx');
  const fixture = fs.readFileSync('tests/canvasNodeDrag.fixture.tsx', 'utf8');  await build({stdin:{contents:fs.readFileSync(source,'utf8')+fixture,loader:'tsx',resolveDir:path.dirname(source),sourcefile:source},bundle:true,platform:'browser',format:'esm',jsx:'automatic',outfile:path.join(dir,'app.js'),define:{'process.env.NODE_ENV':'"development"'}});
  fs.writeFileSync(path.join(dir,'index.html'), '<!doctype html><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:#222;color:white}*{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/app.js"></script>');
  if (process.argv.includes('--bundle-only')) { console.log(dir); return; }
  const server=http.createServer((req,res)=>{const name = req.url==='/'?'index.html':req.url.slice(1);if(!['index.html','app.js','app.css'].includes(name)){res.writeHead(404).end();return;}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(path.join(dir,name)));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); let browser; const checks=[];
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.LR_BROWSER_EXECUTABLE || '/usr/bin/chromium',args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1100,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith('http://127.0.0.1:')||route.request().url().startsWith('data:')?route.continue():route.abort());
    await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.node?.());await page.waitForTimeout(100);
    const load = async (kind,stale=true,zoom=1) => {await page.evaluate(([k,s,z])=>window.load(k,s,z),[kind,stale,zoom]);await page.waitForTimeout(100);};
    const pos=()=>page.evaluate(()=>window.node().position);
    const drag=async (locator, dx=70,dy=45,button='left')=>{const b=await locator.boundingBox();assert.ok(b);await page.mouse.move(b.x+b.width*.45,b.y+Math.min(b.height*.4,80));await page.mouse.down({button});await page.mouse.move(b.x+b.width*.45+dx,b.y+Math.min(b.height*.4,80)+dy,{steps:12});await page.mouse.up({button});await page.waitForTimeout(50);};
    await page.evaluate(()=>window.load('text',true,1,false));await page.waitForTimeout(100);await drag(page.locator('.canvas-node-title'));assert.deepEqual(await pos(),{x:120,y:120});checks.push('negative control: old Agent selector blocks text dragging');
    for (const [kind,stale,zoom,selector] of [['text',true,1,'.canvas-node-title'],['text',true,.5,'.canvas-node-title'],['text',false,1,'.canvas-node-title'],['image',true,1,'.canvas-node-media'],['video',true,1,'.canvas-node-media'],['generator-image',true,1,'.canvas-generator-output'],['generator-video',true,1,'.canvas-generator-output']]) {
      await load(kind,stale,zoom);const before=await pos();await drag(page.locator(selector));const after=await pos();assert.ok((after.x-before.x)*zoom>50 && (after.x-before.x)*zoom<=71,JSON.stringify({kind,before,after,zoom}));assert.ok((after.y-before.y)*zoom>30 && (after.y-before.y)*zoom<=46);checks.push(kind+' body drag '+(stale?'persisted Agent':'ordinary')+' zoom '+zoom);
    }
    for(const kind of ['video','generator-video']) {await load(kind);await page.locator('.canvas-video-preview').hover();const before=await pos();await drag(page.locator('.canvas-video-controls'));assert.deepEqual(await pos(),before);checks.push(kind+' playback controls do not drag');}
    await load('text');await page.locator('.canvas-node-title').dblclick();const editor=page.locator('.canvas-node-inline-editor');await editor.waitFor();
    const before=await pos();await editor.fill('Editable text keeps its caret and selection.');await editor.press('Control+Home');await editor.press('ArrowRight');await editor.press('X');assert.equal(await editor.inputValue(),'EXditable text keeps its caret and selection.');
    const editorBox=await editor.boundingBox();await page.mouse.move(editorBox.x+3,editorBox.y+8);await page.mouse.down();await page.mouse.move(editorBox.x+140,editorBox.y+8,{steps:12});await page.mouse.up();assert.deepEqual(await pos(),before);assert.ok(await editor.evaluate(el=>el.selectionEnd>el.selectionStart));checks.push('double-click edit, typing/caret, mouse text selection without node movement');
    await editor.press('Escape');await editor.waitFor({state:'detached'});await drag(page.locator('.canvas-node-title'));assert.ok((await pos()).x>before.x);checks.push('Escape ends edit and body dragging resumes');
    await load('generator-image');const name=page.locator('.canvas-node-name');await name.dblclick();const input=page.locator('.canvas-node-name-input');await input.waitFor();const generatorBefore=await pos();await drag(input);assert.deepEqual(await pos(),generatorBefore);checks.push('generator name input does not drag');
    await page.mouse.click(950,700);const viewportBefore=await page.evaluate(()=>window.viewport());await page.mouse.move(900,650);await page.mouse.down({button:'middle'});await page.mouse.move(970,695,{steps:10});await page.mouse.up({button:'middle'});const viewportAfter=await page.evaluate(()=>window.viewport());assert.ok(viewportAfter.x>viewportBefore.x+60);checks.push('middle-button background pan preserved');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({scope:'Automated local Chromium; production SpikeNodeView, normalization, ReactFlow; synthetic data; no native WebView acceptance',checks,pageErrors:errors},null,2));
  } finally {await browser?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
