// Exercise the real GraphPage handlers with synthetic graph data and no native bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createServer, transformWithEsbuild } from 'vite';

test('mouse graph panning follows the pointer and coasts only after a deliberate moving release', async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = await import(pathToFileURL(process.env.LUCKYRAY_QA_PLAYWRIGHT || require.resolve('playwright')).href);
  const root = process.cwd();
  let source = readFileSync(path.join(root, 'src/features/graph/GraphPage.tsx'), 'utf8').replaceAll('\r\n', '\n');
  const seam = '    reportGraphPaint();\n  }, [drawArrow, invalidatePaintReadiness, reportGraphPaint]);';
  assert.ok(source.includes(seam), 'instrument the current production renderer');
  source = source.replace(seam, `    const q = (window as any).__panTest;
    q.camera = {scale: params.scale, panX: params.panX, panY: params.panY};
    q.alpha = params.alpha;
    q.gesture = panningRef.current ? {...panningRef.current} : null;
    q.readPan = () => ({gesture: panningRef.current ? {...panningRef.current} : null, pointerId: activePointerIdRef.current});
    q.flushInput = () => applyPendingInputs();
    if (q.record) q.frames.push({t: performance.now(), ...q.camera});
    q.nodes = scene.visibleNodes.map(n => ({id: n.id, x: n.x * params.scale + params.panX, y: n.y * params.scale + params.panY}));
    q.reset = () => {setCameraImmediately({scale: 1, panX: 400, panY: 300}); markGraphDirty('viewport');};
` + seam);
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import GraphPage from '/src/features/graph/GraphPage.tsx'; import {I18nProvider} from '/src/core/i18n/index.ts';
    import {graphDataProvider} from '/src/core/services/graph.ts'; import '/src/core/theme/themeTokens.css';
    const nodes = Array.from({length: 30}, (_, id) => ({id, key: 'pan-'+id, entityId: 'synthetic-'+id, label: 'Synthetic '+id, type: 'note'}));
    graphDataProvider.buildSeed = async () => ({nodes, edges: nodes.slice(1).map(n => [n.id, 0]), source: 'real'});
    createRoot(document.getElementById('root')).render(<I18nProvider locale="zh-CN"><GraphPage/></I18nProvider>);`;
  const server = await createServer({root, configFile: false, cacheDir: path.join(root, 'output/playwright/graph-pan-response/vite-interaction-cache'),
    logLevel: 'error', esbuild: {jsx: 'automatic'}, server: {host: '127.0.0.1', port: 0},
    plugins: [{name: 'graph-pan-interaction', enforce: 'pre',
      resolveId(id) {if (id === '/pan-entry.js') return '\0pan-entry';},
      async load(id) {if (id === '\0pan-entry') return (await transformWithEsbuild(entry, 'entry.tsx', {loader: 'tsx', jsx: 'transform'})).code;},
      transform(code, id) {if (id.replaceAll('\\', '/').split('?')[0].endsWith('/src/features/graph/GraphPage.tsx')) return source;},
      configureServer(s) {s.middlewares.use((req, res, next) => {
        if (req.url !== '/pan-test') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<style>html,body,#root{margin:0;width:100%;height:100%;display:flex}#root{flex-direction:column}</style><div id="root"></div><script type="module" src="/pan-entry.js"></script>');
      });},
    }],
  });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__panTest = {frames: [], record: false};
      localStorage.setItem('luckyray-graph-view-v1', JSON.stringify({spatialVersion: 3, scale: 1, panX: 400, panY: 300, filters: {note: true, material: true, tag: true, web: true}}));
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/pan-test`);
    await page.waitForFunction(() => window.__panTest.alpha < .001, null, {timeout: 45000});
    const canvas = page.locator('.graph-canvas');
    const box = await canvas.boundingBox();
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
    const camera = () => page.evaluate(() => ({...window.__panTest.camera}));
    const reset = async () => {await page.evaluate(() => window.__panTest.reset()); await page.waitForTimeout(50);};
    const sweep = async (button = 'middle', from = {x, y}) => {
      await page.mouse.move(from.x, from.y); await page.mouse.down({button});
      for (let i = 1; i <= 8; i++) {await page.mouse.move(from.x + i * 12, from.y + i * 4); await page.waitForTimeout(10);}
      await page.waitForTimeout(20);
    };

    // Replay two real mouse bursts: down, one move and up arrived within
    // 2.6/1.6ms. Placement must use the final coordinates, but that packet
    // alone cannot establish a release speed and launch an off-screen coast.
    for (const burst of [{dx: -87.3333, dy: 14.6667, moveAt: 1.9, upAt: 2.6},
      {dx: 5.3333, dy: -223.3333, moveAt: 1.2, upAt: 1.6}]) {
      await reset(); const before = await camera();
      await page.mouse.move(x,y); await page.mouse.down({button:'middle'});
      const identity = await page.evaluate(() => window.__panTest.readPan());
      await page.evaluate(({x,y,identity,burst}) => {
        const q=window.__panTest,canvas=document.querySelector('.graph-canvas');
        const send=(type,at)=>{const event=new PointerEvent(type,{bubbles:true,pointerType:'mouse',pointerId:identity.pointerId,
          button:type==='pointerup'?1:-1,buttons:type==='pointerup'?0:4,clientX:x+burst.dx,clientY:y+burst.dy});
          Object.defineProperty(event,'timeStamp',{value:identity.gesture.lastAt+at});canvas.dispatchEvent(event);};
        send('pointermove',burst.moveAt);q.flushInput();send('pointerup',burst.upAt);
      },{x,y,identity,burst});
      await page.mouse.up({button:'middle'}); await page.waitForTimeout(600);
      const after = await camera(); const extra = Math.hypot(after.panX-before.panX-burst.dx,after.panY-before.panY-burst.dy);
      console.log(JSON.stringify({case:'compressed-real-mouse-burst',...burst,unwantedCoast:extra}));
      assert.ok(extra < .01, 'an isolated compressed mouse packet must place the view without inventing a flick');
      assert.equal(after.scale,before.scale);
    }

    // Replay input packets that spent 300ms behind a busy renderer. Their
    // physical timestamps include a pause before release, even though delivery
    // and application now happen close together. This must not become a flick.
    const delayedReleases=[];
    for(const flushMoves of [true,false]){
      await reset();const before=await camera();
      await page.mouse.move(x,y);await page.mouse.down({button:'middle'});
      const identity=await page.evaluate(()=>window.__panTest.readPan());
      await page.waitForTimeout(300);
      const replay=await page.evaluate(({x,y,identity,flushMoves})=>{
        const q=window.__panTest,canvas=document.querySelector('.graph-canvas');
        const send=(type,dx,at)=>{const event=new PointerEvent(type,{bubbles:true,pointerType:'mouse',pointerId:identity.pointerId,button:type==='pointerup'?1:-1,buttons:type==='pointerup'?0:4,clientX:x+dx,clientY:y});Object.defineProperty(event,'timeStamp',{value:identity.gesture.lastAt+at});canvas.dispatchEvent(event);};
        send('pointermove',6,50);if(flushMoves)q.flushInput();
        send('pointermove',12,100);if(flushMoves)q.flushInput();
        const sampled=q.readPan().gesture;
        send('pointerup',12,270);
        return {sampledVelocity:sampled.velocityX};
      },{x,y,identity,flushMoves});
      await page.mouse.up({button:'middle'});await page.waitForTimeout(600);
      const after=await camera();const extra=after.panX-before.panX-12;
      console.log(JSON.stringify({case:'delayed-small-drag',flushMoves,totalTravel:12,physicalReleasePauseMs:170,sampledVelocity:replay.sampledVelocity,unwantedCoast:extra}));
      delayedReleases.push({flushMoves,extra});
      assert.ok(Math.abs(extra)<.01,'queued input after a stall must not launch a paused 12px drag');
      assert.equal(after.scale,before.scale);
    }
    await reset();
    const start = await camera();
    await sweep();
    const held = await camera();
    assert.deepEqual(held, {...start, panX: start.panX + 96, panY: start.panY + 32}, 'held drag is direct screen-space movement without easing or zoom changes');
    await page.mouse.up({button: 'middle'}); await page.waitForTimeout(120);
    const coast = await camera();
    assert.ok(coast.panX > held.panX + 2, 'moving mouse release must coast instead of abruptly stopping');
    await page.waitForTimeout(1200);
    const stopped = await camera();
    assert.ok(stopped.panX > coast.panX, 'coast decelerates without reversing');
    assert.equal(stopped.scale, start.scale);
    await page.waitForTimeout(100);
    assert.deepEqual(await camera(), stopped, 'idle camera stops scheduling motion');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('luckyray-graph-view-v1')));
    assert.ok(Math.abs(saved.panX - stopped.panX) <= .005, 'persist the final resting camera at the existing two-decimal precision');
    assert.ok(Math.abs(saved.panY - stopped.panY) <= .005);

    const strength = [];
    for (const stride of [4, 12, 36]) {
      await reset(); await page.mouse.move(x - 150, y); await page.mouse.down({button: 'middle'});
      for (let i = 1; i <= 10; i++) {await page.mouse.move(x - 150 + i * stride, y); await page.waitForTimeout(12);}
      await page.waitForTimeout(20);
      const release = await page.evaluate(() => {const q = window.__panTest; q.frames=[]; q.record=true; return {camera: {...q.camera}, velocity: q.gesture.velocityX};});
      await page.mouse.up({button: 'middle'}); await page.waitForTimeout(1500);
      const result = await page.evaluate(() => {window.__panTest.record=false; return {camera: {...window.__panTest.camera}, frames: window.__panTest.frames};});
      const distance = result.camera.panX - release.camera.panX;
      // A 90%-per-60Hz-frame decay is ~158ms. Fast flicks must retain their
      // measured velocity rather than all hitting the old 1.35px/ms ceiling.
      const expected = release.velocity / (-Math.log(.9) / (1000 / 60));
      assert.ok(Math.abs(distance-expected) < 3, 'mouse travel must preserve release strength across slow, medium and fast flicks');
      assert.equal(result.camera.scale, start.scale);
      for (let i=1;i<result.frames.length;i++) assert.ok(result.frames[i].panX >= result.frames[i-1].panX, 'released motion never reverses');
      strength.push({stride, velocity: release.velocity, distance});
    }
    console.log(JSON.stringify({case:'continuous-flick-strength',strength}));
    assert.ok(strength[2].distance > strength[1].distance * 2.2, 'a fast flick stays distinct from a medium flick');

    await reset(); await sweep(); await page.waitForTimeout(150);
    const paused = await camera();
    await page.mouse.up({button: 'middle'}); await page.waitForTimeout(300);
    assert.deepEqual(await camera(), paused, 'holding still before release does not replay old velocity');

    await reset(); await sweep(); const canceled = await camera();
    await canvas.dispatchEvent('pointercancel', {pointerId: 1, pointerType: 'mouse'});
    await page.mouse.up({button: 'middle'}); await page.waitForTimeout(300);
    assert.deepEqual(await camera(), canceled, 'canceled capture never starts inertia');

    await reset(); await sweep(); await page.mouse.up({button: 'middle'}); await page.waitForTimeout(30);
    await page.mouse.move(x, y); await page.mouse.down({button: 'middle'});
    const caught = await camera(); await page.waitForTimeout(200);
    assert.deepEqual(await camera(), caught, 'a new grab immediately stops the previous coast');
    await page.mouse.move(x - 48, y); await page.waitForTimeout(30);
    assert.equal((await camera()).panX, caught.panX - 48, 'reverse grab follows the new direction directly');
    await page.waitForTimeout(150); await page.mouse.up({button: 'middle'});

    await reset();
    const blank = {x: box.x + 30, y: box.y + box.height - 90};
    const nearBlank = await page.evaluate(p => window.__panTest.nodes.some(n => Math.hypot(n.x - p.x, n.y - p.y) < 20), {x: blank.x-box.x, y: blank.y-box.y});
    assert.equal(nearBlank, false, 'left-button case starts on empty graph space');
    await sweep('left', blank); const leftHeld = await camera();
    await page.mouse.up({button: 'left'}); await page.waitForTimeout(120);
    assert.ok((await camera()).panX > leftHeld.panX + 2, 'left-button background panning uses the same release behavior');

    await reset(); await page.mouse.move(x, y); await page.mouse.click(x, y, {button: 'middle'});
    const clicked = await camera(); await page.waitForTimeout(150);
    assert.deepEqual(await camera(), clicked, 'a click without movement does not coast');

    await page.emulateMedia({reducedMotion: 'reduce'});
    await reset(); await sweep(); const reduced = await camera();
    await page.mouse.up({button: 'middle'}); await page.waitForTimeout(300);
    assert.deepEqual(await camera(), reduced, 'reduced motion retains direct panning without coast');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({heldDelta: [96,32], coastDistance: stopped.panX-held.panX, strength, delayedReleases, finalPositionSaved: true, pause: true, cancel: true, regrab: true, leftDrag: true, click: true, reducedMotion: true, scaleUnchanged: true}));
  } finally {await browser?.close(); await server.close();}
});
