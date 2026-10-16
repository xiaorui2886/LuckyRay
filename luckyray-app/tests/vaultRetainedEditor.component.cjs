const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const notesSource=fs.readFileSync(root+'/src/features/notes/NotesPage.tsx','utf8');
const mainKey=notesSource.match(/key=\{(`\$\{currentVault\?\.id\}:[^`]+:main[^`]*`)\}/)?.[1];
assert(mainKey,'production main editor key found');
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const entry = `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';import {EditorView} from '@codemirror/view';import {undo,redo,undoDepth} from '@codemirror/commands';window.view=()=>EditorView.findFromDOM(document.querySelector('#pane0 .cm-editor'));window.depth=()=>undoDepth(window.view().state);
 window.undoPane=()=>undo(EditorView.findFromDOM(document.querySelector('#pane0 .cm-editor')));window.redoPane=()=>redo(EditorView.findFromDOM(document.querySelector('#pane0 .cm-editor')));
 const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==';
 function Fixture(){const [active,setActive]=useState(['A','G']);const [version,setVersion]=useState(0);const [epoch,setEpoch]=useState(0);const [scope,setScope]=useState('vault-a');const currentVault={id:scope,rootPath:scope};const [docs,setDocs]=useState({A:'![[a.png]]',B:'B',C:'C',D:'D',E:'E',F:'F',G:'![[g.png]]'});
 window.syncDocument=value=>setDocs(old=>({...old,[active[0]]:value}));window.revalidate=()=>setEpoch(value=>value+1);window.switchNote=(id)=>setActive([id,'G']);window.refreshImage=()=>setVersion(value=>value+1);window.switchVault=()=>setScope('vault-b');window.handles=window.handles||{};window.docs=docs;
 return <div>{active.map((id,pane)=><div id={'pane'+pane} key={scope+pane}><LiveMarkdownEditor key={${mainKey}} ref={handle=>window.handles[pane]=handle} currentNoteId={id} value={docs[id]} assets={[{id:'image',name:'a.png',kind:'image',previewUrl:image+'#'+version},{id:'other',name:'g.png',kind:'image',previewUrl:image}]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={[{targetName:'a.png',assetId:'image',isMissing:0},{targetName:'g.png',assetId:'other',isMissing:0}]} onChange={value=>setDocs(old=>({...old,[id]:value}))}/></div>)}</div>}
 createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/fixture.js") {
      res.writeHead(200, { "Content-Type": "application/javascript" });
      res.end(built.outputFiles[0].text);
    } else if (req.url === "/style.css") {
      res.writeHead(200, { "Content-Type": "text/css" });
      res.end(
        fs.readFileSync(root + "/src/features/notes/editor/liveMarkdown.css")+'\n#pane0 .cm-scroller {height:220px;overflow:auto;}',
      );
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        '<link rel="stylesheet" href="/style.css"><div id="root"></div><script src="/fixture.js"></script>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext();
    const base = "http://127.0.0.1:" + server.address().port;
    await context.route("**/*", (route) =>
      route.request().url().startsWith(base) ||
      route.request().url().startsWith("data:")
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cm-editor").length === 2 &&
        document.querySelectorAll(".note-media img").length === 2,
    );
    await page.evaluate(() => {
      window.originalView = document.querySelector("#pane0 .cm-editor");
      window.originalImage = document.querySelector("#pane0 .note-media img");
      window.otherImage = document.querySelector("#pane1 .note-media img");
    });
    assert.equal(
      await page.evaluate(() => window.originalImage !== window.otherImage),
      true,
    );
    await page.evaluate(() => window.switchNote("B"));
    await page.waitForFunction(() => window.handles[0].getValue() === "B");
    await page.evaluate(() => window.switchNote("A"));
    await page.waitForFunction(
      () => window.handles[0].getValue() === "![[a.png]]",
    );
    const retained = await page.evaluate(() => ({
      sameView:
        window.originalView === document.querySelector("#pane0 .cm-editor"),
      sameImage: window.originalImage === document.querySelector("#pane0 .note-media img"),
      otherStable: window.otherImage === document.querySelector("#pane1 .note-media img"),
    }));
    assert.deepEqual(retained, {
      sameView: true,
      sameImage: true,
      otherStable: true,
    });
    await page.evaluate(() => window.switchNote('B'));
    await page.waitForFunction(() => window.handles[0].getValue() === 'B');
    await page.evaluate(() => window.refreshImage());
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await page.evaluate(() => window.switchNote('A'));
    await page.waitForFunction(() => window.handles[0].getValue() === '![[a.png]]');
    await page.waitForFunction(() => document.querySelector('#pane0 .note-media img')?.src.endsWith('#1'));
    assert.equal(await page.evaluate(() => window.otherImage === document.querySelector('#pane1 .note-media img')),true);
    assert.equal(await page.evaluate(() => window.originalView === document.querySelector('#pane0 .cm-editor')),true);
    await page.evaluate(() =>
      window.handles[0].replaceRange(" draft", { start: 10, end: 10 }),
    );
    await page.waitForFunction(() => window.docs.A.includes("draft"));
    await page.evaluate(() => window.switchNote("B"));
    await page.waitForFunction(() => window.handles[0].getValue() === "B");
    await page.evaluate(() =>
      window.handles[0].replaceRange(" other", { start: 1, end: 1 }),
    );
    await page.waitForFunction(() => window.docs.B === "B other");
    await page.evaluate(() => window.switchNote("A"));
    await page.waitForFunction(() =>
      window.handles[0].getValue().includes("draft"),
    );
    await page.evaluate(() => window.undoPane());
    await page.waitForFunction(() => window.docs.A === "![[a.png]]");
    assert.equal(await page.evaluate(() => window.docs.B), "B other");
    await page.evaluate(() => window.redoPane());
    await page.waitForFunction(() => window.docs.A.includes("draft"));
    for (const id of ["B", "C", "D", "E", "F", "A"]) {
      await page.evaluate((id) => window.switchNote(id), id);
      await page.waitForFunction(
        (id) => window.handles[0].getValue() === window.docs[id],
        id,
      );
    }
    const evicted = await page.evaluate(() => ({
      newView:
        window.originalView !== document.querySelector("#pane0 .cm-editor"),
      draft: window.handles[0].getValue().includes("draft"),
      independent:
        document.querySelector("#pane0 .cm-editor") !==
        document.querySelector("#pane1 .cm-editor"),
    }));
    assert.deepEqual(evicted, {
      newView: true,
      draft: true,
      independent: true,
    });
    await page.evaluate(()=>window.switchNote('D'));
    await page.waitForFunction(()=>window.handles[0].getValue()==='D');
    await page.evaluate(()=>window.syncDocument('D'+Array.from({length:60},(_,i)=>'\nline '+i).join('')));
    await page.waitForFunction(()=>window.handles[0].getValue().includes('line 59'));
    await page.evaluate(()=>{window.handles[0].replaceRange(' typed',{start:1,end:1});});
    await page.waitForFunction(()=>window.docs.D.startsWith('D typed'));
    await page.evaluate(()=>{const view=window.view();view.dispatch({selection:{anchor:7,head:2}});view.scrollDOM.scrollTop=300;window.stableView=view;window.stableDom=view.dom;window.beforeDepth=window.depth();window.beforeSelection=view.state.selection.toJSON();window.beforeScroll=view.scrollDOM.scrollTop;window.removedEditors=0;window.remountObserver=new MutationObserver(records=>{for(const record of records)for(const node of record.removedNodes)if(node===window.stableDom||node.contains?.(window.stableDom))window.removedEditors++;});window.remountObserver.observe(document.querySelector('#pane0'),{childList:true,subtree:true});});
    for(let i=0;i<3;i++){await page.evaluate(()=>window.revalidate());await page.evaluate(()=>new Promise(requestAnimationFrame));}
    assert.deepEqual(await page.evaluate(()=>({view:window.view()===window.stableView,dom:document.querySelector('#pane0 .cm-editor')===window.stableDom,selection:JSON.stringify(window.view().state.selection.toJSON())===JSON.stringify(window.beforeSelection),undo:window.depth()===window.beforeDepth,scroll:Math.abs(window.view().scrollDOM.scrollTop-window.beforeScroll)<2,removed:window.removedEditors})),{view:true,dom:true,selection:true,undo:true,scroll:true,removed:0});
    await page.evaluate(()=>window.syncDocument('external\n'+window.docs.D));
    await page.waitForFunction(()=>window.handles[0].getValue().startsWith('external\nD typed'));
    assert.deepEqual(await page.evaluate(()=>({same:window.view()===window.stableView,anchor:window.view().state.selection.main.anchor,head:window.view().state.selection.main.head,undo:window.depth()===window.beforeDepth,removed:window.removedEditors})),{same:true,anchor:16,head:11,undo:true,removed:0});
    await page.evaluate(()=>window.undoPane());
    await page.waitForFunction(()=>window.docs.D.startsWith('external\nD\n'));
    await page.evaluate(()=>window.redoPane());
    await page.waitForFunction(()=>window.docs.D.startsWith('external\nD typed'));
    await page.evaluate(()=>window.remountObserver.disconnect());
    await page.evaluate(()=>{window.view().scrollDOM.scrollTop=500;});
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    const beforeSwitchScroll=await page.evaluate(()=>window.view().scrollDOM.scrollTop);
    await page.evaluate(()=>window.switchNote('A'));
    await page.waitForFunction(()=>window.handles[0].getValue()===window.docs.A);
    await page.evaluate(()=>window.switchNote('D'));
    await page.waitForFunction(()=>window.handles[0].getValue()===window.docs.D);
    await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.ok(Math.abs(await page.evaluate(()=>window.view().scrollDOM.scrollTop)-beforeSwitchScroll)<2,'reattaching a retained editor restores its actual scrolled viewport');

    await page.evaluate(() => {
      window.beforeVault = document.querySelector("#pane0 .cm-editor");
      window.switchVault();
    });
    await page.waitForFunction(
      () => document.querySelector("#pane0 .cm-editor") !== window.beforeVault,
    );
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        saveEchoPreservesViewSelectionScrollUndo:true,
        externalUpdatePreservesViewAndMappedUndo:true,
        retained,
        evicted,
        independentUndoRedo: true,
        vaultOwnerReplaced: true,
        errors,
      }),
    );
    await context.close();
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
