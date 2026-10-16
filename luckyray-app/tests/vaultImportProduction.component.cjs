// Invoked by the synthetic native HTTP fixture with LUCKYRAY_IMPORT_COMBINATION=1.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  target = process.env.LUCKYRAY_NATIVE_FIXTURE_ROOT?.replace(/^\\\\\?\\/, ""),
  native = process.env.LUCKYRAY_NATIVE_FIXTURE_URL;
if (!target?.includes("vault-attachments-native-browser-") || !native)
  throw Error("Rust-owned synthetic fixture required");
const baseDir = path.dirname(target),
  source = path.join(baseDir, "来源库");
const vault = {
  id: process.env.LUCKYRAY_NATIVE_FIXTURE_ID,
  rootPath: target,
  name: "test",
  mode: "vault-bound",
  createdAt: "now",
  lastOpenedAt: "now",
  schemaVersion: 1,
};
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
let browser, server;
const commands = [];
(async () => {
  for (const dir of [".obsidian", "笔记", "附件"])
    fs.mkdirSync(path.join(source, dir), { recursive: true });
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(source, "附件", "图 片.png"), image);
  fs.writeFileSync(
    path.join(source, "笔记", "有图.md"),
    "![图](../附件/图%20片.png)",
  );
  fs.writeFileSync(path.join(source, "一.md"), "one");
  fs.writeFileSync(path.join(source, "二.md"), "two");
  fs.mkdirSync(path.join(baseDir, "unrelated"));
  fs.symlinkSync(
    path.join(baseDir, "unrelated"),
    path.join(source, "linked-project"),
    "junction",
  );
  const folder = path.join(baseDir, "导入目录");
  fs.mkdirSync(path.join(folder, "nested"), { recursive: true });
  fs.mkdirSync(path.join(folder, "attachments"));
  fs.writeFileSync(path.join(folder, "attachments", "x.png"), image);
  fs.writeFileSync(
    path.join(folder, "nested", "n.md"),
    "![x](../attachments/x.png)",
  );
  fs.writeFileSync(path.join(folder, "plain.md"), "plain");
  fs.symlinkSync(
    path.join(baseDir, "unrelated"),
    path.join(folder, "linked-subtree"),
    "junction",
  );
  const fiveNames = [
    "Pasted image 20260831003749.png",
    "Pasted image 20260831004005.png",
    "Pasted image 20260831004745.png",
    "Pasted image 20260831004936.png",
    "Pasted image 20260831005039.png",
  ];
  for (const [index, name] of fiveNames.entries())
    fs.writeFileSync(
      path.join(source, name),
      Buffer.concat([image, Buffer.from(String(index))]),
    );
  fs.writeFileSync(
    path.join(source, "主题问题总结.md"),
    fiveNames.map((name) => "![[" + name + "]]").join("\n"),
  );
  const entry = `import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {invoke} from '@tauri-apps/api/core';
 import {parseNoteInline} from './src/core/services/noteRenderer'; import {resolveAttachmentBatch} from './src/core/services/vaultAttachmentResolution'; import {activateKnowledgeWritesForVault} from './src/core/services/knowledgeSource';
 import {useVaultFileDrop} from './src/features/notes/useVaultFileDrop';import {ImportResultNotice} from './src/features/notes/ImportResultNotice';import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';
 const vault=${JSON.stringify(vault)};const owner={};activateKnowledgeWritesForVault({mode:"real-vault",vaultId:vault.id,rootPath:vault.rootPath});
 function Fixture(){const [matches,setMatches]=useState({}),[receipt,setReceipt]=useState(null),[docs,setDocs]=useState({}),[message,setMessage]=useState('');window.receipt=receipt;window.docs=docs;window.inserted=window.inserted||[];window.runs=window.runs||0;
 const classify=paths=>fetch('/classify',{method:'POST',body:JSON.stringify(paths)}).then(r=>r.json());
 const importPaths=async(parent,paths)=>{const items=await classify(paths);let results=[];const files=items.filter(i=>i.isFile).map(i=>i.path);if(files.length)results.push(await invoke('fixture_import_files',{vault,paths:files,parent:parent||''}));for(const item of items.filter(i=>i.isDir))results.push(await invoke('fixture_import_folder',{vault,source:item.path,parent:parent||''}));const result=results.reduce((sum,r)=>({copiedCount:sum.copiedCount+r.copiedCount,failedCount:sum.failedCount+r.failedCount,skippedCount:sum.skippedCount+r.skippedCount,conflictRenamedCount:sum.conflictRenamedCount+r.conflictRenamedCount,errors:[...sum.errors,...r.errors],files:[...sum.files,...r.files]}),{copiedCount:0,failedCount:0,skippedCount:0,conflictRenamedCount:0,errors:[],files:[]});await invoke('fixture_refresh',{});const updated=await Promise.all(result.files.map(async f=>[f.relativePath,(await invoke('fixture_read',{documentRef:{vaultId:vault.id,relativePath:f.relativePath}})).content]));setDocs(old=>({...old,...Object.fromEntries(updated)}));setReceipt(result);window.runs++;};
 window.importPaths=importPaths;
 const lookup=Object.entries(docs).flatMap(([note,content])=>content.split('\\n').flatMap(parseNoteInline).filter(token=>token.type==='asset').map(token=>({key:note+'|'+token.target,noteRelativePath:note,target:token.target,wiki:!token.markdown})));
 useEffect(()=>{if(lookup.length)resolveAttachmentBatch(vault.id,lookup).then(result=>setMatches(Object.fromEntries(result.entries)));},[JSON.stringify(lookup)]);

 const drop=useVaultFileDrop({enabled:true,owner,defaultParent:null,classify,importPaths,insertFiles:files=>window.inserted.push(...files.map(file=>file.name)),rejected:setMessage});
 return <div id="page-notes" {...drop}><div id="tree" data-folder-drop-id="__root__" style={{height:80}}>知识库列表</div><div id="editor"><LiveMarkdownEditor currentNoteId="display" value={Object.values(docs).join('\\n\\n')} assets={[]} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={[]} onChange={()=>{}}/></div>{Object.entries(docs).map(([note,content])=>{const items=lookup.filter(item=>item.noteRelativePath===note);const assets=items.flatMap(item=>{const match=matches[item.key]?.[0];return match?.absolutePath?[{id:item.key,name:item.target,kind:'image',previewUrl:'/media/'+encodeURIComponent(match.absolutePath)}]:[];});return <section data-note={note} key={note}><LiveMarkdownEditor currentNoteId={note} value={content} assets={assets} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={items.map(item=>({targetName:item.wiki?item.target:"md:"+item.target,assetId:item.key,isMissing:assets.some(asset=>asset.id===item.key)?0:1}))} onChange={()=>{}}/></section>})}{receipt&&<ImportResultNotice receipt={receipt} onClose={()=>setReceipt(null)}/>}<output>{message}</output></div>}
 createRoot(document.getElementById('root')).render(<Fixture/>);`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "css" },
    outfile: "fixture.js",
    define: { "import.meta.env.DEV": "false" },
  });
  const safe = (file) =>
    path
      .toNamespacedPath(path.resolve(file))
      .toLowerCase()
      .startsWith(
        path.toNamespacedPath(path.resolve(baseDir)).toLowerCase() + path.sep,
      );
  server = http.createServer(async (req, res) => {
    if (req.url === "/rpc") {
      let body = "";
      for await (const chunk of req) body += chunk;
      commands.push(JSON.parse(body).command);
      res.end(await (await fetch(native, { method: "POST", body })).text());
      return;
    }
    if (req.url === "/classify") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const paths = JSON.parse(body);
      assert.ok(paths.every(safe));
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          paths.map((file) => {
            const stat = fs.statSync(file);
            return {
              path: file,
              isFile: stat.isFile(),
              isDir: stat.isDirectory(),
            };
          }),
        ),
      );
      return;
    }
    if (req.url === "/fixture.css") {
      res.setHeader("Content-Type", "text/css");
      res.end(
        built.outputFiles.find((file) => file.path.endsWith(".css")).text,
      );
      return;
    }
    if (req.url.startsWith("/media/")) {
      const file = decodeURIComponent(req.url.slice(7));
      assert.ok(safe(file));
      res.setHeader("Content-Type", "image/png");
      res.end(fs.readFileSync(file));
      return;
    }
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(built.outputFiles.find((file) => file.path.endsWith(".js")).text);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.request().url().startsWith(url) ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const callbacks = new Map(),
      listeners = [];
    let id = 0;
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      transformCallback: (callback) => {
        callbacks.set(++id, callback);
        return id;
      },
      convertFileSrc: (file) => "/media/" + encodeURIComponent(file),
      invoke: async (command, args) => {
        if (command === "plugin:event|listen") {
          listeners.push(args);
          return args.handler;
        }
        if (command === "plugin:event|unlisten") return;
        const result = await fetch("/rpc", {
          method: "POST",
          body: JSON.stringify({ command, args }),
        }).then((r) => r.json());
        if (result.error) throw Error(JSON.stringify(result.error));
        return result.value;
      },
    };
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    window.nativeDrop = (event) => {
      const type = event.payload.type;
      for (const listener of listeners) {
        if (
          listener.target.kind === "Webview" &&
          listener.target.label === "main" &&
          listener.event === "tauri://drag-" + type
        )
          callbacks.get(listener.handler)({
            event: listener.event,
            payload: event.payload,
            id: listener.handler,
          });
      }
    };
    window.dropListeners = listeners;
  });
  await page.goto(url);
  await page.waitForFunction(() => window.dropListeners.length === 4);
  assert.ok(
    await page.evaluate(() =>
      window.dropListeners.every((item) => item.target.kind === "Webview"),
    ),
    "real Tauri SDK subscribes to current Webview scope",
  );
  const drop = async (paths, selector, duplicateDom = false) => {
    const runs = await page.evaluate(() => window.runs);
    await page.evaluate(
      ({ paths, selector, duplicateDom }) => {
        const element = document.querySelector(selector),
          box = element.getBoundingClientRect();
        const position = {
          x: (box.x + 10) * devicePixelRatio,
          y: (box.y + 10) * devicePixelRatio,
        };
        window.nativeDrop({ payload: { type: "enter", paths, position } });
        window.nativeDrop({ payload: { type: "drop", paths, position } });
        if (duplicateDom) {
          const transfer = new DataTransfer();
          for (const p of paths)
            transfer.items.add(
              Object.assign(new File([], p.split(/[\\/]/).pop()), { path: p }),
            );
          element.dispatchEvent(
            new DragEvent("drop", {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
            }),
          );
        }
      },
      { paths, selector, duplicateDom },
    );
    await page.waitForFunction((runs) => window.runs === runs + 1, runs);
  };
  await drop([path.join(source, "笔记", "有图.md")], "#editor", true);
  assert.equal(await page.evaluate(() => window.receipt.copiedCount), 1);
  assert.equal(await page.evaluate(() => window.receipt.failedCount), 0);
  assert.equal(await page.evaluate(() => window.receipt.errors.length), 0);
  assert.equal(await page.evaluate(() => window.inserted.length), 0);
  const imported = await page.evaluate(() => Object.values(window.docs)[0]);
  const firstNote = await page.evaluate(() => Object.keys(window.docs)[0]);
  const firstDestination = /\]\(([^)]+)\)/.exec(imported)[1];
  const firstRawPath = path.resolve(
    path.dirname(path.join(target, firstNote)),
    decodeURIComponent(firstDestination),
  );
  assert.equal(
    fs.realpathSync.native(firstRawPath),
    fs.realpathSync.native(path.join(source, "附件", "图 片.png")),
    "source-context import rewrites an independently valid target",
  );
  assert.deepEqual(fs.readFileSync(firstRawPath), image);
  assert.equal(
    fs.existsSync(path.join(target, "attachments"))
      ? fs.readdirSync(path.join(target, "attachments")).length
      : 0,
    0,
    "reference import creates no image copies",
  );
  assert.equal(
    commands.filter((c) => c === "fixture_import_files").length,
    1,
    "one native gesture plus DOM counterpart imports once",
  );
  await drop([path.join(source, "笔记", "有图.md")], "#editor", true);
  assert.equal(
    await page.evaluate(() => window.receipt.conflictRenamedCount),
    1,
    "a new gesture importing the same path is not swallowed",
  );
  await drop([path.join(source, "一.md"), path.join(source, "二.md")], "#tree");
  assert.equal(await page.evaluate(() => window.receipt.copiedCount), 2);
  await drop([folder], "#tree");
  assert.equal(await page.evaluate(() => window.receipt.copiedCount), 2);
  assert.equal(await page.evaluate(() => window.receipt.failedCount), 0);
  assert.ok(fs.existsSync(path.join(target, "导入目录", "nested", "n.md")));
  assert.equal(
    await page.evaluate(() => window.receipt.errors.length),
    1,
    "linked subtree warning does not abort ordinary notes",
  );
  await page.evaluate(
    async (imagePath) => {
      const element = document.querySelector("#editor"),
        box = element.getBoundingClientRect();
      const position = { x: box.x + 10, y: box.y + 10 };
      window.nativeDrop({
        payload: { type: "enter", paths: [imagePath], position },
      });
      window.nativeDrop({
        payload: { type: "drop", paths: [imagePath], position },
      });
    },
    path.join(source, "附件", "图 片.png"),
  );
  await page.waitForFunction(() => window.inserted.includes("图 片.png"));
  // A native-only gesture must not swallow the next independent DOM gesture.
  const beforeDom = await page.evaluate(() => ({
    runs: window.runs,
    media: window.inserted.length,
  }));
  await page.evaluate(
    (paths) => {
      const element = document.querySelector("#editor");
      const transfer = new DataTransfer();
      for (const p of paths)
        transfer.items.add(
          Object.assign(new File(["original bytes"], p.split(/[\\/]/).pop()), {
            path: p,
          }),
        );
      element.dispatchEvent(
        new DragEvent("dragenter", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    [path.join(source, "一.md"), path.join(source, "附件", "图 片.png")],
  );
  await page.waitForFunction(
    (before) =>
      window.runs === before.runs + 1 &&
      window.inserted.length === before.media + 1,
    beforeDom,
  );
  assert.equal(
    await page.evaluate(() => window.receipt.copiedCount),
    1,
    "DOM mixed drop imports Markdown and retains its media",
  );
  await drop([path.join(source, "主题问题总结.md")], "#tree");
  assert.equal(
    await page.evaluate(() => window.receipt.errors.length),
    0,
    "five exact sibling Wiki images ignore unrelated junction",
  );
  const fiveContent = await page.evaluate(() => window.docs["主题问题总结.md"]);
  for (const name of fiveNames) {
    assert.ok(fiveContent.includes(name), "actual filename remains visible");
    assert.ok(
      !fs.existsSync(path.join(target, "attachments", name)),
      "reference import does not copy original",
    );
    assert.ok(fs.existsSync(path.join(source, name)));
  }
  await page.waitForFunction(() => {
    const images = [
      ...document.querySelectorAll('[data-note="主题问题总结.md"] img'),
    ];
    return (
      images.length === 5 &&
      images.every((image) => image.complete && image.naturalWidth > 0)
    );
  });
  const noticeStyle = await page
    .locator(".notes-import-toast")
    .evaluate((element) => ({
      position: getComputedStyle(element).position,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }));
  assert.equal(noticeStyle.position, "fixed");
  assert.ok(noticeStyle.width <= 360 && noticeStyle.height < 100);
  await page.waitForFunction(
    () => !document.querySelector(".notes-import-toast"),
  );
  const failed = await page.evaluate(
    async ({ vault, source }) => {
      const result = await fetch("/rpc", {
        method: "POST",
        body: JSON.stringify({
          command: "fixture_import_files",
          args: { vault, paths: [source + "/not-found.md"], parent: "" },
        }),
      }).then((r) => r.json());
      return result.value;
    },
    { vault, source },
  );
  assert.equal(failed.copiedCount, 0);
  assert.equal(failed.failedCount, 1);
  assert.equal(failed.skippedCount, 0);
  const fixtureRpc = async (command, args) => {
    const response = await fetch(native, {
      method: "POST",
      body: JSON.stringify({ command, args }),
    }).then((r) => r.json());
    if (response.error) throw Error(JSON.stringify(response.error));
    return response.value;
  };
  await fixtureRpc("knowledge_set_attachment_handling_policy", {
    vaultId: vault.id,
    sourceEpoch: Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH),
    policy: "copy",
  });
  await drop([path.join(source, "笔记", "有图.md")], "#tree");
  // UI merged receipt intentionally omits files; inspect newly imported document by native result below.
  const copyResult = await fixtureRpc("fixture_import_files", {
    vault,
    paths: [path.join(source, "笔记", "有图.md")],
    parent: "",
  });
  assert.equal(copyResult.copiedCount, 1);
  const copyNote = copyResult.files[0].relativePath;
  const copyText = fs.readFileSync(path.join(target, copyNote), "utf8");
  const copyTarget = /\]\(([^)]+)\)/.exec(copyText)[1];
  const copyResolved = path.resolve(
    path.dirname(path.join(target, copyNote)),
    decodeURIComponent(copyTarget),
  );
  assert.ok(
    copyResolved.startsWith(path.join(target, "attachments")),
    "copy preference used by production single import",
  );
  assert.deepEqual(fs.readFileSync(copyResolved), image);
  const copyFolderResult = await fixtureRpc("fixture_import_folder", {
    vault,
    source: folder,
    parent: "",
  });
  assert.equal(copyFolderResult.copiedCount, 2);
  const withImage = copyFolderResult.files.find((file) =>
    file.relativePath.endsWith("/nested/n.md"),
  );
  const folderText = fs.readFileSync(
    path.join(target, withImage.relativePath),
    "utf8",
  );
  const folderTarget = /\]\(([^)]+)\)/.exec(folderText)[1];
  const folderResolved = path.resolve(
    path.dirname(path.join(target, withImage.relativePath)),
    decodeURIComponent(folderTarget),
  );
  assert.ok(folderResolved.startsWith(path.join(target, "attachments")));
  assert.deepEqual(fs.readFileSync(folderResolved), image);
  await fixtureRpc("knowledge_set_attachment_handling_policy", {
    vaultId: vault.id,
    sourceEpoch: Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH),
    policy: "reference",
  });
  const materialTests = require("node:child_process").spawnSync(
    process.execPath,
    [
      "--test",
      path.join(__dirname, "vaultMaterialInsertion.contract.test.cjs"),
    ],
    { env: process.env, encoding: "utf8", windowsHide: true },
  );
  if (materialTests.status !== 0)
    throw Error(materialTests.stdout + materialTests.stderr);
  console.log(materialTests.stdout);
  assert.deepEqual(errors, []);
  assert.equal(
    fs.readFileSync(path.join(source, "笔记", "有图.md"), "utf8"),
    "![图](../附件/图%20片.png)",
  );
  console.log(
    JSON.stringify({
      singleNestedMarkdown: true,
      multipleMarkdown: true,
      folder: true,
      conflict: true,
      unrelatedJunction: true,
      nativeDomOnce: true,
      repeatedDrop: true,
      mediaRoutedSeparately: true,
      domMixedDrop: true,
      fiveSiblingWikiImagesRendered: true,
      realTauriWebviewEventScope: true,
      successToastAutoCloses: true,
      nativeThenIndependentDom: true,
      actualNativeImportAndReadback: true,
      referenceImportsUseOriginalDiskPathsWithoutCopies: true,
      copyPreferenceUsedBySingleAndFolderImport: true,
      materialThreeModesPasteFileAndCurrentDetails: true,
      errors,
    }),
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
