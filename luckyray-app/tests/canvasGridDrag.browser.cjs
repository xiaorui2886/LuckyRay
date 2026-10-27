const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict');
const {chromium} = require(process.env.LR_PLAYWRIGHT_MODULE || 'playwright-core');
const dir = path.resolve(process.argv[2] || 'output/canvas-ux');
const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  const file = path.resolve(dir, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({headless: true, channel: 'msedge'});
    const page = await browser.newPage({viewport: {width: 1360, height: 950}});
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cases = [];
    for (const legacy of [false, true]) {
    await page.goto('http://127.0.0.1:' + server.address().port + (legacy ? '/?legacy=1' : '/'));
    const slice = page.locator('.react-flow__node').filter({has: page.locator('[data-grid-slice="true"]')}).first();
    await slice.waitFor();
    await page.waitForFunction(() => window.getGridNodes?.().some(node => node.data.gridSlice && node.measured?.width));
    const before = await page.evaluate(() => window.getGridNodes().find(node => node.data.gridSlice));
    const id = before.id, box = await slice.boundingBox();
    const edgeBefore = await page.locator('.react-flow__edge').first().locator('path').first().getAttribute('d');
    const start = {x: box.x + box.width / 2, y: box.y + box.height / 2};
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 150, start.y - 95, {steps: 15});
    await page.mouse.up();
    const after = await page.evaluate(id => window.getGridNodes().find(node => node.id === id), id);
    assert.ok(Math.abs(after.position.x - before.position.x) > 100, 'slice must move when dragged from its visible image');
    assert.ok(after.position.x < 0 && after.position.y < 0, 'slice must move outside the group boundary');
    assert.equal(after.parentId, before.parentId, 'moving does not discard group membership');
    assert.deepEqual(after.data.gridSlice, before.data.gridSlice, 'crop metadata stays intact');
    assert.equal(after.data.refMediaUrl, before.data.refMediaUrl, 'moving keeps the original slice file');
    assert.equal(await page.locator('.react-flow__edge').count(), 9);
    assert.notEqual(await page.locator('.react-flow__edge').first().locator('path').first().getAttribute('d'), edgeBefore);
    assert.deepEqual(errors, []);
    cases.push({legacy, before: before.position, after: after.position, groupRetained: true, cropAndFileRetained: true, provenanceEdges: 9});
    }
    const result = {scope: 'Windows Edge, production image card + ReactFlow, synthetic fixture; no user data or model requests', cases, errors};
    fs.writeFileSync(path.join(dir, 'grid-drag-result.json'), JSON.stringify(result, null, 2));
    await page.screenshot({path: path.join(dir, 'grid-drag.png')});
    console.log('PASS: image-body drag, outside-group movement, provenance and media preserved');
  } finally { await browser?.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
