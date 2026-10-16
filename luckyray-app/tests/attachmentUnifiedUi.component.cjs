const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const evidenceDir = process.env.LUCKYRAY_EVIDENCE_DIR;
if (evidenceDir) fs.mkdirSync(evidenceDir, { recursive: true });
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const { chromium } = require(
  process.env.LUCKYRAY_PLAYWRIGHT_MODULE ||
    "C:/Users/Administrator/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright",
);
(async () => {
  const built = await esbuild.build({
    stdin: {
      contents: `import React from 'react';import{createRoot}from'react-dom/client';import{AttachmentHandlingSelect}from'./src/features/notes/AttachmentHandlingSelect';import{AttachmentPortabilitySection}from'./src/features/notes/AttachmentPortabilitySection';import{MaterialAttachmentSection}from'./src/features/materials/MaterialAttachmentSection';window.calls=[];window.source={vaultId:'v'};createRoot(document.getElementById('root')).render(<><section className="vault-attachment-settings"><AttachmentHandlingSelect vaultId="v"/><AttachmentPortabilitySection vaultId="v" notePaths={['a.md']} chooseDirectory={async()=>'/export'} saveAffected={async()=>{window.calls.push('save')}}/></section><MaterialAttachmentSection assetId="a" storageMode={new URLSearchParams(location.search).get("mode") || "managed"} onUpdated={()=>window.calls.push('promoted')}/></>);`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    plugins: [
      {
        name: "synthetic-ports",
        setup(b) {
          b.onResolve(
            { filter: /core\/services\/|notes\/knownVaults/ },
            (a) => ({ path: a.path, namespace: "ports" }),
          );
          b.onLoad({ filter: /.*/, namespace: "ports" }, () => ({
            contents: `export const attachmentErrorMessage=cause=>String(cause);export const discoverAttachmentMoves=async()=>Array.from({length:Number(new URLSearchParams(location.search).get("moves") || 0)},()=>({assetId:"a",previousPath:"C:/old.png",newPath:"C:/renamed.png"}));export const selectMaterialRelocationPath=async()=>null;export const requestAttachmentRelink=(request)=>{window.moveRequest=request};export const readActiveKnowledgeWriteSource=()=>window.source;export const ensureActiveKnowledgeUiSource=async()=>({vaultId:'v',sourceEpoch:1});export const getAttachmentHandlingPolicy=async()=> 'reference';export const setAttachmentHandlingPolicy=async(v,e,p)=>{window.calls.push(p);return p};export const auditAttachmentPortability=async()=>({documentCount:2,entries:[{document:'长笔记.md',target:'缺失图片.png',line:2,status:'missing'}],migrationFileCount:0,migrationCopyBytes:0});export const exportStandaloneVault=async()=>{window.calls.push('export');return{status:'partial',documentCount:2,attachmentCount:1,destination:'/export',issues:[{document:'a.md',target:'missing.png',status:'missing'}]}};export const attachmentIssueLabel=()=> '原附件位置不可用';export const getMaterialAttachmentDetails=async()=>({ordinary:new URLSearchParams(location.search).has('ordinary'),absolutePath:new URLSearchParams(location.search).has('noPath')?null:'C:/old.png',referenceCount:0,references:[]});export const promoteMaterialAttachment=async()=>({id:'a'});export const readKnownNotesVaults=()=>[];export const knowledgeDocumentNoteId=()=>'';export const focusEntity=()=>{};`,
          }));
        },
      },
    ],
  });
  const css =
    fs.readFileSync(root + "/src/features/notes/vaultAttachments.css", "utf8") +
    fs.readFileSync(root + "/src/features/materials/materials.css", "utf8");
  const server = http.createServer((q, r) => {
    r.setHeader(
      "content-type",
      q.url === "/app.js"
        ? "text/javascript; charset=utf-8"
        : "text/html; charset=utf-8",
    );
    r.end(
      q.url === "/app.js"
        ? built.outputFiles[0].text
        : `<meta charset="utf-8"><style>:root{--border:#34343c;--radius-sm:6px;--bg-surface:#17171d;--bg-elevated:#202028;--text-primary:#eee;--text-secondary:#bbb;--text-tertiary:#999;--accent:#9294ff;--accent-muted:#34344c}body{background:var(--bg-surface);color:var(--text-primary);font:13px sans-serif;margin:20px}#root{max-width:520px}*{box-sizing:border-box}${css}</style><main id="root"></main><script src="/app.js"></script>`,
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 600, height: 850 },
    });
    const errors = [];
    page.on("pageerror", (e) => {
      errors.push(String(e));
      console.error(e);
    });
    await page.goto("http://127.0.0.1:" + server.address().port);
    await page
      .getByRole("combobox", { name: "外部文件插入方式" })
      .selectOption("copy");
    await page.getByText("盘点与独立导出", { exact: false }).click();
    await page.getByRole("button", { name: "只读盘点附件" }).click();
    await page.getByText("已盘点 2 篇笔记", { exact: false }).waitFor();
    assert.equal(
      await page.locator(".vault-attachment-issues:visible").count(),
      0,
    );
    await page.getByText("查看待连接引用", { exact: true }).click();
    await page.getByText("长笔记.md:2", { exact: false }).waitFor();
    await page.getByRole("button", { name: "导出为独立知识库" }).click();
    await page.getByText("已导出可处理项", { exact: false }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.slice(-2)), [
      "save",
      "export",
    ]);
    await page.getByRole("button", { name: "加入素材库" }).click();
    await page.waitForFunction(() => window.calls.includes("promoted"));
    assert.equal(
      await page.getByRole("button", { name: "加入素材库" }).count(),
      0,
    );
    await page.getByText("移动或重命名文件", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "新文件路径" })
      .fill("C:/fixtures/new image.png");
    await page.getByRole("button", { name: "检查移动与引用范围" }).click();
    await page.waitForFunction(() => window.moveRequest?.kind === "move");
    assert.equal(
      await page.evaluate(() => window.moveRequest.newPath),
      "C:/fixtures/new image.png",
    );
    assert.equal(await page.evaluate(() => window.moveRequest.vaultId), "v");
    for (const width of [600, 360]) {
      await page.setViewportSize({ width, height: 1000 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "no horizontal overflow",
      );
      assert(
        await page
          .locator(".vault-attachment-settings button")
          .first()
          .evaluate((e) => getComputedStyle(e).borderTopStyle === "solid"),
        "production styles loaded",
      );
    }
    await page.getByRole("button", { name: "只读盘点附件" }).focus();
    assert(
      await page.evaluate(
        () => document.activeElement.textContent === "只读盘点附件",
      ),
    );
    if (evidenceDir) await page.screenshot({
      path: path.join(evidenceDir, "attachment-unified-ui-dark.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--bg-surface", "#f8f8fa");
      document.documentElement.style.setProperty("--bg-elevated", "#fff");
      document.documentElement.style.setProperty("--text-primary", "#222");
      document.documentElement.style.setProperty("--text-secondary", "#444");
      document.documentElement.style.setProperty("--text-tertiary", "#666");
    });
    if (evidenceDir) await page.screenshot({
      path: path.join(evidenceDir, "attachment-unified-ui-light.png"),
      fullPage: true,
    });
    await page.goto(
      "http://127.0.0.1:" + server.address().port + "/?mode=linked",
    );
    await page.getByText("暂无已登记笔记引用，附件仍保留。").waitFor();
    assert.equal(
      await page.getByText("移动或重命名文件", { exact: true }).count(),
      0,
    );
    await page.goto('http://127.0.0.1:' + server.address().port + '/?moves=1');
    await page.getByRole('button',{name:'预览更新引用'}).waitFor();
    assert.equal(await page.getByRole('dialog').count(),0,'discovery never opens a dialog without a user action');
    await page.goto('http://127.0.0.1:' + server.address().port + '/?moves=2');
    await page.getByText('暂无已登记笔记引用，附件仍保留。').waitFor();
    assert.equal(await page.getByRole('button',{name:'预览更新引用'}).count(),0,'ambiguous discovery never chooses a candidate');
    await page.goto('http://127.0.0.1:' + server.address().port + '/?noPath=1&ordinary=1');
    await page.getByText('暂无已登记笔记引用；素材仍保留。').waitFor();
    assert.equal(await page.getByText('外部位置', { exact: true }).count(), 0, 'an ordinary material without a note-identity path is not an external attachment');
    assert.equal(await page.getByText('尚未登记位置', { exact: true }).count(), 0);
    assert.equal(await page.getByText('移动或重命名文件', { exact: true }).count(), 0, 'no move action without registered attachment location');
    await page.goto('http://127.0.0.1:' + server.address().port + '/?noPath=1&noteOnly=1');
    await page.getByText('笔记附件位置尚未登记；无法仅凭此判断文件是否丢失。').waitFor();
    assert.equal(await page.getByText('外部位置', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: actual React components, shared preference, save-before-export, folded errors, null path, promotion, 360px/600px, focus, styles; synthetic ports only",
    );
  } finally {
    await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
