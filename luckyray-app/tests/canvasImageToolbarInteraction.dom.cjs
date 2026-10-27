const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const rootDir = path.resolve(__dirname, '..');
const tool = process.env.LR_TEST_TOOLS ? createRequire(process.env.LR_TEST_TOOLS + '/package.json') : require;
const { JSDOM } = tool('jsdom');
const esbuild = require(require.resolve('esbuild', { paths: [fs.realpathSync(path.join(rootDir, 'node_modules/vite'))] }));
const dom = new JSDOM('<div id="stage"><div class="react-flow__node" data-id="a"><div class="canvas-node-kind">Image title</div></div></div><div id="root"></div>', { url: 'https://qa.invalid' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'KeyboardEvent', 'navigator']) Object.defineProperty(global, key, { value: dom.window[key], configurable: true });
global.Image = class { naturalWidth = 640; decode = () => Promise.resolve(); };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.camera = { x: 0, y: 0, zoom: 1 };
function rect(x, y, width, height) { return { x, y, left:x, top:y, width, height, right:x+width, bottom:y+height }; }
HTMLElement.prototype.getBoundingClientRect = function() {
 if (this.id === 'stage') return rect(0,0,1200,900);
 if (this.classList.contains('react-flow__node')) return rect(300,300,300*camera.zoom,200*camera.zoom);
 if (this.classList.contains('canvas-node-kind')) return rect(304,300-23*camera.zoom,120*camera.zoom,14*camera.zoom);
 return rect(0,0,350,40);
};
const React = require('react');
const { createRoot } = require('react-dom/client');
(async () => {
 const build = await esbuild.build({ entryPoints:[path.join(rootDir,'src/features/canvas/CanvasGridSplit.tsx')], bundle:true, write:false, platform:'node', format:'cjs', packages:'external', loader:{'.css':'empty'}, plugins:[{name:'fixture', setup(b) {
  b.onResolve({filter:/^@xyflow\/react$/},()=>({path:'flow',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useViewport=()=>globalThis.camera;export const useStore=f=>f({nodeLookup:new Map([['a',{internals:{positionAbsolute:{x:300/globalThis.camera.zoom,y:300/globalThis.camera.zoom}},measured:{width:300,height:200}}]])});`}));
  b.onLoad({filter:/CanvasComposerPopover\.tsx$/},()=>({contents:'export function CanvasComposerPopover({children}){return children}',loader:'jsx'}));
 }}] });
 const loaded = {exports:{}};new Function('module','exports','require',build.outputFiles[0].text)(loaded,loaded.exports,require);
 const { CanvasImageToolbar } = loaded.exports;
 const root = createRoot(document.querySelector('#root'));
 const calls = [];
 const props = { nodeId:'a', stage:{current:document.querySelector('#stage')}, source:'image.png', english:true, onInteract:()=>calls.push('interact'), onSplit:()=>calls.push('split'), onCompare:()=>calls.push('compare'), onCreativeRecipe:()=>calls.push('recipe') };
 const wait = () => new Promise(resolve=>setTimeout(resolve,35));
 const render = async()=>{root.render(React.createElement(CanvasImageToolbar,props));await wait();await wait();};
 await render();
 for (const zoom of [.25,.5,1,2,3]) {
  camera = {...camera,zoom};await render();
  const surface=document.querySelector('.canvas-image-tools-surface');
  assert.equal(surface.style.visibility,'visible');
  const header=document.querySelector('.canvas-node-kind').getBoundingClientRect();
  assert.equal(header.top-parseFloat(surface.style.top)-40,12,`measured DOM title clearance at ${zoom}x`);
 }
 const buttons=()=>document.querySelectorAll('[role="toolbar"] button');
 buttons()[1].click();assert.deepEqual(calls.splice(0),['interact','split']);
 buttons()[2].click();assert.deepEqual(calls.splice(0),['interact','compare']);
 buttons()[0].click();await wait();assert.deepEqual(calls.splice(0),['interact']);
 const recipe=document.querySelector('.canvas-image-creative-menu button');assert(recipe,'creative recipe menu opened');recipe.click();await wait();assert.deepEqual(calls.splice(0),['interact','recipe']);
 root.unmount();console.log('PASS scaled DOM header measurement and all toolbar interaction callbacks');
})().catch(error=>{console.error(error);process.exitCode=1;});
