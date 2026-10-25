const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(__dirname, '../../../node_modules/vite'))] }));
const built = esbuild.buildSync({ entryPoints: [path.join(__dirname, 'canvasTextToolbarGeometry.ts')], bundle:true, write:false, platform:'node', format:'cjs' });
const loaded = {exports:{}}; new Function('module','exports',built.outputFiles[0].text)(loaded,loaded.exports);
const geometry = loaded.exports.canvasTextToolbarGeometry;
test('idle and full toolbar center on the same node, above its name with 12 screen pixels clearance', () => {
 for (const zoom of [.2,.38,1,2,4]) for (const width of [66,394]) {
  const g=geometry(600,400,zoom,1200,800,width,42);
  assert.equal(g.shiftX,0); assert.equal(g.visible,true); assert.ok(Math.abs(g.offset-23*zoom-12)<1e-9);
 }
});
test('pan and resize follow the node center instead of old document padding', () => {
 assert.equal(geometry(400,400,1,1200,800,394,42).shiftX,0);
 assert.equal(geometry(550,430,1,1200,800,394,42).shiftX,0);
});
test('horizontal viewport edges clamp toolbar without changing its above-name offset', () => {
 const left=geometry(20,300,.38,800,600,394,42), right=geometry(790,300,.38,800,600,394,42);
 assert.equal(20+left.shiftX-197,8); assert.equal(790+right.shiftX+197,792); assert.equal(left.offset,right.offset);
});
test('small viewport width wraps rather than clipping controls', () => {
 const g=geometry(120,300,1,240,600,394,80); assert.equal(g.maxWidth,224); assert.equal(g.shiftX,0); assert.equal(g.visible,true);
});
test('offscreen and no-room-above cases hide instead of running away or covering title', () => {
 for(const [x,y] of [[-1,300],[801,300],[400,20],[400,900]]) assert.equal(geometry(x,y,1,800,600,394,42).visible,false);
 assert.equal(geometry(400,160,1,800,600,394,42).visible,true);
});

test('stage top and bottom chrome remain clear without pinning toolbar onto its title', () => {
 assert.equal(geometry(400,152,1,800,600,394,42).visible,false);
 assert.equal(geometry(400,153,1,800,600,394,42).visible,true);
 assert.equal(geometry(400,580,1,800,600,394,42).visible,false);
 assert.equal(geometry(400,579,1,800,600,394,42).visible,true);
});
