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
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "playwright",
);
(async () => {
  const entry = `import React,{useState} from 'react';import{AttachmentProblem}from'./src/features/notes/AttachmentProblem';import {activateKnowledgeWritesForVault,readActiveKnowledgeWriteSource} from './src/core/services/knowledgeSource';import {createRoot} from 'react-dom/client';import {useVaultAttachmentChanges,VaultLinkUpdateDialog} from './src/features/notes/VaultLinkUpdateDialog';import {ApplicationModalIsolationProvider,createApplicationModalIsolationStore} from './src/app/applicationModalIsolation';
 activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'A',rootPath:'root-A'});window.source=readActiveKnowledgeWriteSource();window.calls=[];window.policy='ask';window.executed=false;window.previews=[];window.holdPreview=false;window.holdSave=false;
 window.makePlan=(paths)=>({sourceEpoch:1,referenceCount:2,changedPaths:paths,uncertainCount:0,plan:{version:1,vaultId:'A',targetIdentity:'A',kind:'external-reference-update',attachmentDependencies:[],files:[{relativePath:'n.md',before:'old',after:'new',beforeRevision:'r1',afterRevision:'r2'}],issues:[],documentCount:1,attachmentCount:0,copyBytes:0,backupBytes:3}});
 window.preview=async(vault,paths,incomplete)=>{window.calls.push(['preview',paths,incomplete]);if(window.failPreview){window.failPreview=false;throw JSON.stringify({code:'knowledge-vault-unavailable',message:'Knowledge Vault root identity is unavailable'});}if(window.holdPreview)return new Promise(resolve=>window.previews.push({resolve,paths}));return incomplete||window.executed?{...window.makePlan(paths),plan:null,uncertainCount:incomplete?1:0}:window.makePlan(paths);};
 function Fixture(){const [batch,setBatch]=useState(null);const [vault,setVault]=useState({id:'A',rootPath:'root-A'});
 window.emit=(generation,paths=['a.png','b.png'],reconcileRequired=false)=>setBatch({vaultId:vault.id,rootPath:vault.rootPath,session:1,generation,observations:[{type:'modify',paths}],reconcileRequired});
 window.emitContent=generation=>setBatch({vaultId:vault.id,rootPath:vault.rootPath,session:1,generation,observations:[{type:{modify:{kind:'any'}},paths:['n.md']}],reconcileRequired:false});
 window.changeVault=()=>{activateKnowledgeWritesForVault({mode:'real-vault',vaultId:'B',rootPath:'root-B'});window.source=readActiveKnowledgeWriteSource();setVault({id:'B',rootPath:'root-B'});};
 const flow=useVaultAttachmentChanges({vault,batch,saveAffected:async paths=>{window.calls.push(['save',paths]);if(window.failSave)throw new Error('save failed');if(window.holdSave)await new Promise(resolve=>window.finishSave=resolve);},isDirty:()=>!!window.dirty,refreshAffected:async paths=>{window.calls.push(['refresh',paths]);if(window.holdRefresh)await new Promise(resolve=>window.finishRefresh=resolve);if(window.failRefresh){window.failRefresh=false;throw new Error('readback failed');}} });window.flow=flow;
 return <><VaultLinkUpdateDialog flow={flow}/><aside>{!flow.update?.plan&&<AttachmentProblem error={flow.error} onRetry={()=>void flow.retry()}/>}</aside></>;}
 createRoot(document.getElementById('root')).render(<ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><Fixture/></ApplicationModalIsolationProvider>);`;
  const built = await esbuild.build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx" },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    plugins: [
      {
        name: "synthetic-native-ports",
        setup(build) {
          build.onLoad(
            { filter: /[\\/]services[\\/]vaultAttachments\.ts$/ },
            () => ({
              contents: `export const previewExternalAttachmentChanges=(...args)=>window.preview(...args);export const getAttachmentLinkUpdatePolicy=async()=>window.policy;export const setAttachmentLinkUpdatePolicy=async(v,e,p)=>{window.calls.push(['policy',p]);window.policy=p;};export const executeAttachmentOperation=async(...args)=>{window.calls.push(['execute',...args]);window.executed=true;return {status:window.resultStatus||'complete'};};`,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type":
        req.url === "/fixture.js" ? "application/javascript" : "text/html",
    });
    res.end(
      req.url === "/fixture.js"
        ? built.outputFiles[0].text
        : '<div id="root"></div><script src="/fixture.js"></script>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const context = await browser.newContext();
    const base = "http://127.0.0.1:" + server.address().port;
    await context.route("**/*", (route) =>
      route.request().url().startsWith(base) ? route.continue() : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const reset = async () => {
      await page.goto(base);
      await page.waitForFunction(() => !!window.flow);
    };
    await reset();
    for (let i=1;i<=8;i++) { await page.evaluate(i=>window.emitContent(i),i); await page.evaluate(()=>new Promise(requestAnimationFrame)); }
    assert.equal(await page.evaluate(()=>window.calls.length),0,'ordinary autosave echoes do not preview attachment changes');
    assert.equal(await page.getByRole('dialog').count(),0);
    await reset();
    await page.evaluate(() => window.emit(1));
    await page.getByRole("button", { name: "仅更新这次" }).waitFor();
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.waitForFunction(() =>
      window.calls.some((call) => call[0] === "refresh"),
    );
    assert.deepEqual(
      await page.evaluate(() =>
        window.calls
          .filter((call) => call[0] !== "preview")
          .map((call) => call[0]),
      ),
      ["save", "execute", "refresh"],
    );
    await page.evaluate(() => window.emit(2, ["n.md"]));
    await page.waitForFunction(
      () => window.calls.filter((call) => call[0] === "preview").length === 3,
    );
    assert.equal(await page.getByRole("dialog").count(), 0);
    await reset();
    await page.evaluate(() => {
      window.policy = "always";
      window.emit(1);
    });
    await page.waitForFunction(() => window.executed);
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((call) => call[0] === "execute").length,
      ),
      1,
    );
    await reset();
    await page.evaluate(() => window.emit(1));
    await page.getByRole("button", { name: "不做更新", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() =>
        document
          .querySelector("[role=dialog]")
          .contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(
      await page.evaluate(() =>
        window.calls.some((call) => call[0] === "execute"),
      ),
      false,
    );
    await reset();
    await page.evaluate(() => {
      window.failSave = true;
      window.emit(1);
    });
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.evaluate(() =>
        window.calls.some((call) => call[0] === "execute"),
      ),
      false,
    );
    await reset();
    await page.evaluate(() => {
      window.holdSave = true;
      window.emit(1);
    });
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.waitForFunction(() => !!window.finishSave);
    await page.evaluate(() => window.changeVault());
    await page.waitForFunction(() => window.source.vaultId === "B");
    await page.evaluate(() => window.finishSave());
    await page.waitForFunction(() => !window.flow.running);
    assert.equal(
      await page.evaluate(() =>
        window.calls.some((call) => call[0] === "execute"),
      ),
      false,
    );
    await reset();
    await page.evaluate(() => {
      window.holdPreview = true;
      window.emit(1, ["first.png"]);
    });
    await page.waitForFunction(() => window.previews.length === 1);
    assert.equal(await page.getByRole('dialog').count(),0,'background pending must not interrupt editing');
    assert.equal(await page.locator('.notes-attachment-notice').count(),0);
    await page.evaluate(() => window.emit(2, ["second.png"]));
    await page.waitForFunction(() => window.previews.length === 2);
    await page.evaluate(() =>
      window.previews[1].resolve({
        ...window.makePlan(["second.png"]),
        referenceCount: 9,
      }),
    );
    await page.waitForFunction(() => window.flow.update?.referenceCount === 9);
    await page.evaluate(() =>
      window.previews[0].resolve({
        ...window.makePlan(["first.png"]),
        referenceCount: 1,
      }),
    );
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(
      await page.evaluate(() => window.flow.update.referenceCount),
      9,
    );
    await reset();
    await page.evaluate(() => window.emit(1, ["a.png"], true));
    await page.getByRole("alert").waitFor();
    await page.evaluate(() => window.flow.decline());
    await page.evaluate(() => window.emit(2));
    await page.getByRole("button", { name: "仅更新这次" }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.at(-1)[2]), false);
    await reset();
    await page.evaluate(() => {
      window.failPreview = true;
      window.emit(1);
    });
    await page.getByRole("alert").waitFor();
    assert.doesNotMatch(
      await page.getByRole("alert").innerText(),
      /knowledge-vault-unavailable|\{"code"/,
    );
    assert.equal(await page.getByRole('dialog').count(),0,'background failure is discoverable in the attachment area');
    await page.evaluate(()=>window.emitContent(2));await page.evaluate(()=>new Promise(requestAnimationFrame));
    assert.equal(await page.evaluate(()=>window.calls.length),1,'typing after a real failure does not silently retry it');
    await page.evaluate(() => window.flow.decline());
    assert.equal(await page.evaluate(() => window.flow.pending), true);
    assert.equal(await page.evaluate(() => window.calls.length), 1);
    await page.evaluate(() => window.flow.retry());
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.waitForFunction(() => window.executed && !window.flow.running);
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((c) => c[0] === "execute").length,
      ),
      1,
    );
    await reset();
    await page.evaluate(() => {
      window.failRefresh = true;
      window.emit(1);
    });
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "重新检查" }).click();
    await page.waitForFunction(
      () => !window.flow.running && !window.flow.error,
    );
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((c) => c[0] === "execute").length,
      ),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((c) => c[0] === "refresh").length,
      ),
      2,
    );
    await reset();
    await page.evaluate(() => {
      window.resultStatus = "partial";
      window.failRefresh = true;
      window.emit(1);
    });
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "重新检查" }).click();
    await page.waitForFunction(
      () =>
        !window.flow.running && window.flow.error.includes("部分引用未更新"),
    );
    assert.equal(
      await page.evaluate(
        () => window.calls.filter((c) => c[0] === "execute").length,
      ),
      1,
    );
    await reset();
    await page.evaluate(() => {
      window.failRefresh = true;
      window.emit(1);
    });
    await page.getByRole("button", { name: "仅更新这次" }).click();
    await page.getByRole("alert").waitFor();
    await page.evaluate(() => {
      window.holdRefresh = true;
      void window.flow.retry();
    });
    await page.waitForFunction(() => !!window.finishRefresh);
    await page.evaluate(() => window.changeVault());
    await page.evaluate(() => {
      window.executed = false;
      window.emit(2, ["B.png"]);
    });
    await page.evaluate(() => {
      window.holdRefresh = false;
      window.finishRefresh();
    });
    await page.waitForFunction(() =>
      window.calls.some((c) => c[0] === "preview" && c[1].includes("B.png")),
    );
    await page.getByRole("button", { name: "仅更新这次" }).waitFor();
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        once: true,
        always: true,
        decline: true,
        saveFailure: true,
        sourceChange: true,
        stalePreviewDiscarded: true,
        overflowRecovers: true,
        selfWriteNoRepeat: true,
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
