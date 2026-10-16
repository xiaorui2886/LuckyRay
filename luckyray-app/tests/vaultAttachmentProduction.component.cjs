// Run from the ignored Rust attachment_native_frontend_combination test.
// Real native operations; only IPC transport and OS watcher delivery are adapted.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  fixture = process.env.LUCKYRAY_NATIVE_FIXTURE_ROOT;
const native = process.env.LUCKYRAY_NATIVE_FIXTURE_URL;
if (
  !fixture ||
  !native ||
  !path.basename(fixture).includes("vault") ||
  !fixture.includes("vault-attachments-native-browser-")
)
  throw Error("Synthetic Rust fixture required");
const config = {
  id: process.env.LUCKYRAY_NATIVE_FIXTURE_ID,
  rootPath: fixture,
  epoch: Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH),
};
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
const calls = [],
  faults = new Map(),
  events = [];
let watcher, browser, server;
const externalDirectory = fs.mkdtempSync(path.join(path.parse(fixture.replace(/^\\\\\?\\/, '')).root.toLowerCase().startsWith('c:') ? 'D:/codex/luckyray' : 'C:/Cursor', 'attachment-video-fixture-'));
const externalVideo = path.join(externalDirectory, '生成武士刀挥砍视频 (1).mp4');
(async () => {
  fs.writeFileSync(
    path.join(fixture, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x90:d=2:r=30",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    path.join(fixture, "video.mp4"),
  ]);
  for (const note of ["one.md", "two.md"])
    fs.writeFileSync(
      path.join(fixture, note),
      "![[image.png]]\n\n![[video.mp4]]",
    );
  const entry = `import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {EditorView} from '@codemirror/view';window.editorTexts=()=>[...document.querySelectorAll('.cm-editor')].map(element=>EditorView.findFromDOM(element).state.doc.toString());
 import {invoke,convertFileSrc} from '@tauri-apps/api/core';
 import {activateKnowledgeWritesForVault} from './src/core/services/knowledgeSource';
 import {parseNoteInline} from './src/core/services/noteRenderer';
 import {VaultFileChangeQueue} from './src/core/services/vaultFileChanges';
 import {useVaultAttachmentResolution} from './src/features/notes/useVaultAttachmentResolution';
 import {AttachmentProblem} from './src/features/notes/AttachmentProblem';
 import {useVaultAttachmentChanges,VaultLinkUpdateDialog} from './src/features/notes/VaultLinkUpdateDialog';
 import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
 import {LiveMarkdownEditor} from './src/features/notes/editor/LiveMarkdownEditor';
 import {NoteMedia} from './src/features/notes/media/NoteMedia';
 const vault=${JSON.stringify(config)};activateKnowledgeWritesForVault({mode:'real-vault',vaultId:vault.id,rootPath:vault.rootPath});
 const queue=new VaultFileChangeQueue();let generation=0;
 const read=path=>invoke('fixture_read',{documentRef:{vaultId:vault.id,relativePath:path}});
 function Fixture(){const [docs,setDocs]=useState({}),[matches,setMatches]=useState({}),[batch,setBatch]=useState(null),[recheck,setRecheck]=useState(0),[error,setError]=useState('');
 window.docs=docs;window.matches=matches;window.resolveError=error;
 const refresh=async paths=>{window.index=await invoke('fixture_refresh',{});const result=await Promise.all(paths.map(async path=>[path,(await read(path)).content]));setDocs(old=>({...old,...Object.fromEntries(result)}));};
 window.refresh=refresh;
 useEffect(()=>{refresh(['one.md','two.md']).catch(e=>window.fatal=String(e));},[]);
 window.deliver=observations=>{for(const observation of observations)queue.add(observation,Date.now());setBatch({vaultId:vault.id,rootPath:vault.rootPath,session:1,generation:++generation,...queue.drain()});};
 const lookup=Object.entries(docs).flatMap(([note,content])=>content.split('\\n').flatMap(line=>parseNoteInline(line)).filter(token=>token.type==='asset').map(token=>({key:note+'|'+token.target,noteRelativePath:note,target:token.target,wiki:!token.markdown})));
 const key=JSON.stringify(lookup);
 useVaultAttachmentResolution({vault,lookups:lookup,batch,recheck,setMatches,setError});
 const flow=useVaultAttachmentChanges({vault,batch,saveAffected:async()=>{},isDirty:()=>false,refreshAffected:refresh,recheckAttachments:()=>setRecheck(n=>n+1)});window.flow=flow;
 return <><VaultLinkUpdateDialog flow={flow}/><aside>{!flow.update?.plan&&<AttachmentProblem error={flow.error} onRetry={()=>void flow.retry()}/>}</aside><button onClick={()=>{setRecheck(n=>n+1);void flow.retry();}}>页面重新检查</button><output>{error}</output>{Object.entries(docs).map(([note,content])=>{const items=lookup.filter(item=>item.noteRelativePath===note);const assets=items.flatMap(item=>{const match=matches[item.key]?.[0];return match?.absolutePath?[{id:item.key,name:item.target,kind:item.target.endsWith('.mp4')?'video':'image',previewUrl:convertFileSrc(match.absolutePath)+'?v='+encodeURIComponent(match.version||'')}]:[];});return <section key={note} data-note={note}><LiveMarkdownEditor currentNoteId={note} value={content} assets={assets} notes={[]} tags={[]} noteLinks={[]} noteEmbeds={items.map(item=>({targetName:item.wiki?item.target:'md:'+item.target,assetId:item.key,isMissing:assets.some(a=>a.id===item.key)?0:1}))} onChange={()=>{}}/><div className="reading">{assets.map(asset=><NoteMedia key={asset.id} asset={asset} alt={asset.name}/>)}</div></section>})}</>;
 }
 createRoot(document.getElementById('root')).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><Fixture/></ApplicationModalIsolationProvider>);`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    loader: { ".css": "empty" },
    plugins: [
      {
        name: "native-http-transport",
        setup(build) {
          build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({
            path: "core",
            namespace: "fixture-ipc",
          }));
          build.onLoad({ filter: /.*/, namespace: "fixture-ipc" }, () => ({
            contents: `export async function invoke(command,args={}){const result=await fetch('/rpc',{method:'POST',body:JSON.stringify({command,args})}).then(r=>r.json());if(result.error)throw JSON.stringify(result.error);return result.value;}export function convertFileSrc(path){return '/media/'+encodeURIComponent(path);}export function isTauri(){return false;}`,
            loader: "js",
          }));
        },
      },
    ],
  });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/rpc") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      calls.push(request.command);
      if (faults.get(request.command)) {
        faults.set(request.command, faults.get(request.command) - 1);
        res.end(
          JSON.stringify({
            error: {
              code: "knowledge-vault-unavailable",
              message: "Knowledge Vault root identity is unavailable",
            },
          }),
        );
        return;
      }
      try {
        res.end(await (await fetch(native, { method: "POST", body })).text());
      } catch (error) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: { code: "fixture-network", message: String(error) },
          }),
        );
      }
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const file = path.resolve(
        decodeURIComponent(url.pathname.slice("/media/".length)).replace(/^\\\\\?\\/, ""),
      );
      const relative = path.relative(fixture.replace(/^\\\\\?\\/, ""), file);
      if (
        ((relative.startsWith("..") || path.isAbsolute(relative)) && path.resolve(file) !== path.resolve(externalVideo)) ||
        ![".png", ".mp4"].includes(path.extname(file)) ||
        !fs.existsSync(file)
      ) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const data = fs.readFileSync(file),
        range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ""),
        start = range ? Number(range[1]) : 0,
        end =
          range && range[2]
            ? Math.min(Number(range[2]), data.length - 1)
            : data.length - 1;
      res.writeHead(range ? 206 : 200, {
        "Content-Type": file.endsWith(".mp4") ? "video/mp4" : "image/png",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(range
          ? { "Content-Range": `bytes ${start}-${end}/${data.length}` }
          : {}),
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
    if (url.pathname === "/fixture.js") {
      res.setHeader("Content-Type", "application/javascript");
      res.end(built.outputFiles[0].text);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end('<div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  watcher = fs.watch(fixture, { recursive: true }, (type, name) => {
    if (name && !name.startsWith(".luckyray"))
      events.push({ type, paths: [path.join(fixture, name)] });
  });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext();
  await context.route("**/*", (route) =>
    route.request().url().startsWith(base) ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForFunction(
    () => Object.keys(window.matches || {}).length === 4,
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll("video").length === 4 &&
      [...document.querySelectorAll("video")].every((v) => v.readyState >= 2),
  );
  const original = await page.evaluate(() =>
    [...document.querySelectorAll("video")].map((v) => v.currentSrc),
  );
  const imageBytes = fs.readFileSync(path.join(fixture, "image.png"));
  fs.unlinkSync(path.join(fixture, "image.png"));
  await page.getByRole("button", { name: "页面重新检查" }).click();
  await page.waitForFunction(() => Object.entries(window.matches).filter(([key])=>key.endsWith('|image.png')).every(([,matches])=>matches.length===0 || matches.every(match=>!match.exists && match.matchKind==='external-unavailable')));
  assert.equal(await page.locator('.lr-live-asset-card.missing').count(),2,'confirmed native missing stays visible at its two references');
  assert.equal(await page.getByRole('dialog').count(),0,'missing media must not cover the editor');
  fs.writeFileSync(path.join(fixture, "image.png"), imageBytes);
  await page.getByRole("button", { name: "页面重新检查" }).click();
  await page.waitForFunction(() => Object.entries(window.matches).filter(([key])=>key.endsWith('|image.png')).every(([,matches])=>matches[0]?.exists));
  await page.waitForFunction(() => document.querySelectorAll('.lr-live-asset-card.missing').length===0);
  const rename = async (from, to) => {
    events.length = 0;
    fs.renameSync(path.join(fixture, from), path.join(fixture, to));
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(events.length, "real Windows watcher must deliver");
    await page.evaluate(
      (observations) => window.deliver(observations),
      events.splice(0),
    );
  };
  await rename("video.mp4", "renamed.mp4");
  await page.getByRole("button", { name: "仅更新这次" }).waitFor();
  assert.match(
    await page.getByRole("dialog").innerText(),
    /2 篇笔记中的 2 处引用/,
  );
  await page.getByRole("button", { name: "仅更新这次" }).click();
  await page.waitForFunction(
    () =>
      Object.values(window.docs).every((text) =>
        text.includes("renamed.mp4"),
      ) && !window.flow.running,
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("video")].length === 4 &&
      [...document.querySelectorAll("video")].every(
        (v) =>
          v.readyState >= 2 &&
          decodeURIComponent(v.currentSrc).includes("renamed.mp4"),
      ),
  );
  assert.notDeepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll("video")].map((v) => v.currentSrc),
    ),
    original,
  );
  faults.set("knowledge_resolve_attachment", 1);
  await page.getByRole("button", { name: "页面重新检查" }).click();
  await page.waitForFunction(() => !!window.resolveError);
  assert.equal(
    (await page.evaluate(
      () =>
        Object.values(window.matches).filter((m) => m[0]?.absolutePath).length,
    )) >= 4,
    true,
  );
  await page.getByRole("button", { name: "页面重新检查" }).click();
  await page.waitForFunction(() => !window.resolveError);
  faults.set("knowledge_preview_external_attachment_changes", 1);
  await rename("image.png", "renamed.png");
  await page.getByRole("alert").waitFor();
  assert.doesNotMatch(
    await page.getByRole("alert").innerText(),
    /knowledge-vault-unavailable/,
  );
  await page.evaluate(() => window.flow.decline());
  assert.equal(await page.evaluate(() => window.flow.pending), true);
  await page.getByRole("button", { name: "页面重新检查" }).click();
  await page.getByRole("button", { name: "本库始终更新" }).waitFor();
  faults.set("fixture_refresh", 1);
  await page.getByRole("button", { name: "本库始终更新" }).click();
  await page.getByRole("alert").waitFor();
  const executions = calls.filter(
    (c) => c === "knowledge_execute_attachment_operation",
  ).length;
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await page.waitForFunction(
    () =>
      Object.values(window.docs).every((text) =>
        text.includes("renamed.png"),
      ) &&
      !window.flow.running &&
      !window.flow.error,
  );
  assert.equal(
    calls.filter((c) => c === "knowledge_execute_attachment_operation").length,
    executions,
  );
  await rename("renamed.mp4", "automatic.mp4");
  await page.waitForFunction(
    () =>
      Object.values(window.docs).every((text) =>
        text.includes("automatic.mp4"),
      ) && !window.flow.running,
  );
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(await page.evaluate(()=>window.editorTexts().every(text=>text.includes('automatic.mp4'))),true);
  await page.evaluate(observations=>window.deliver(observations),events.splice(0));
  await page.waitForFunction(()=>!window.flow.pending&&!window.flow.running);
  await page.evaluate(async config=>{
    const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({command:'knowledge_set_attachment_link_update_policy',args:{vaultId:config.id,sourceEpoch:config.epoch,policy:'ask'}})}).then(response=>response.json());
    if(response.error)throw Error(JSON.stringify(response.error));
  },config);
  await rename('renamed.png','declined.png');
  await page.getByRole('button',{name:'不做更新'}).click();
  assert.equal(await page.evaluate(()=>Object.values(window.docs).every(text=>text.includes('renamed.png'))),true);
  assert.equal(
    calls.filter((c) => c === "knowledge_execute_attachment_operation").length,
    3,
  );
  // Published standalone non-image file URI must survive native indexing,
  // approved resolution, saved reference projection and both real media views.
  fs.copyFileSync(path.join(fixture, 'automatic.mp4'), externalVideo);
  const rpc=async(command,args)=>{const result=await fetch(native,{method:'POST',body:JSON.stringify({command,args})}).then(r=>r.json());if(result.error)throw Error(JSON.stringify(result.error));return result.value;};
  const material=(await rpc('fixture_material',{path:externalVideo,options:{storageMode:'source'}})).assets[0];
  const doc=await rpc('fixture_create',{title:'external-video',content:''});
  const publication=await rpc('knowledge_publish_attachment',{input:{documentRef:doc.documentRef,sourceEpoch:config.epoch,expectedRevision:doc.revision,handlingPolicy:'reference',materialId:material.id,name:material.name}});
  assert.match(publication.markdown,/^\[[^\n]+\]\(file:\/\//);
  await rpc('fixture_save',{documentRef:doc.documentRef,expectedRevision:doc.revision,content:publication.markdown});
  const saved=fs.readFileSync(path.join(fixture,doc.documentRef.relativePath),'utf8');
  assert.equal(saved.trim(),publication.markdown.trim());
  const snapshot=await rpc('fixture_refresh',{});
  const indexed=snapshot.documents.find(item=>item.relativePath===doc.documentRef.relativePath);
  assert.equal(indexed.embeds.length,1,'native index must deliver the file URI to NotesPage resolution');
  assert.equal(indexed.embeds[0].kind,'mp4');
  const resolution=await rpc('knowledge_resolve_attachment',{documentRef:doc.documentRef,destination:indexed.embeds[0].target,wiki:false});
  assert.equal(resolution.status,'resolved');
  assert.equal(fs.realpathSync.native(resolution.absolutePath),fs.realpathSync.native(externalVideo));
  const details=await rpc('fixture_attachment_details',{assetId:material.id});
  assert.equal(details.referenceCount,1,'production save projection counts the video link');
  await page.evaluate(note=>window.refresh([note]),doc.documentRef.relativePath);
  const section=page.locator('section[data-note="'+doc.documentRef.relativePath+'"]');
  await section.locator('video').first().waitFor();
  try {await page.waitForFunction(note=>{const section=document.querySelector('section[data-note="'+note+'"]');return section?.querySelectorAll('video').length===2&&[...section.querySelectorAll('video')].every(video=>video.readyState>=2&&video.videoWidth===160);},doc.documentRef.relativePath);}
  catch(error){console.error(await section.evaluate(element=>({html:element.innerHTML,videos:[...element.querySelectorAll('video')].map(video=>({src:video.currentSrc,readyState:video.readyState,width:video.videoWidth,error:video.error?.message}))})));throw error;}
  assert.equal(await section.locator('.lr-live-asset-card.missing').count(),0);
  console.log(JSON.stringify({externalPublishedVideoNativeIndex:true,externalVideoEditorAndReadingDecoded:true,externalVideoProjectedReferenceCount:details.referenceCount}));
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      nativeConcurrentRoot: true,
      realMissingAndRecovery: true,
      realWindowsWatcher: true,
      documents: 2,
      liveAndReadingVideos: 4,
      exactReferenceCount: true,
      once: true,
      always: true,
      previewRetryWithoutNavigation: true,
      resolutionRetryWithoutNavigation: true,
      readbackRetryWithoutDuplicateWrite: true,
      executions: 3,
      decline:true,
      selfWriteNoRepeat:true,
      errors,
    }),
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    watcher?.close();
    if(fs.existsSync(externalVideo))fs.unlinkSync(externalVideo);
    fs.rmdirSync(externalDirectory);
    if (browser) await browser.close();
    if (server) await new Promise((resolve) => server.close(resolve));
  });
