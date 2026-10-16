// Production CommunityPage rendered in Edge with controlled transports.
// Catalog readiness/failures are engineering fixtures, not native API acceptance.
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(require.resolve("esbuild", { paths: [fs.realpathSync(root + "/node_modules/vite")] }));
const { chromium } = require(process.env.LUCKYRAY_PLAYWRIGHT_MODULE || "C:/Users/Administrator/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright");
const out = process.env.COMMUNITY_UI_EVIDENCE || path.join(root, ".tmp-community-ui");
const packs = JSON.parse(fs.readFileSync(root + "/plugin-sdk/examples/page-desk/example.page-desk.lrpack.json", "utf8"));
const manifestPack = JSON.parse(fs.readFileSync(root + "/plugin-sdk/examples/material-manifest/example.material-manifest.lrpack.json", "utf8"));
const themePack = JSON.parse(fs.readFileSync(root + "/examples/extensions/paper-sage.lrpack.json", "utf8"));
const report = { kind: "production-community-controlled-transports", checks: [], errors: [], screenshots: [] };

(async () => {
  fs.mkdirSync(path.join(out, "component"), { recursive: true });
  await esbuild.build({ stdin: { resolveDir: root, loader: "tsx", contents: `
    import { createRoot } from "react-dom/client";
    import "./src/core/theme/themeTokens.css";
    import "./src/app/appShell.css";
    import CommunityPage from "./src/features/community/CommunityPage";
    import { I18nProvider } from "./src/core/i18n/index";
    import { ApplicationModalIsolationProvider, createApplicationModalIsolationStore } from "./src/app/applicationModalIsolation";
    import { applyGlobalSettings } from "./src/features/settings/useSettings";
    import { setActiveKnowledgeSource, clearActiveKnowledgeSource } from "./src/core/services/knowledgeSource";
    const pack = ${JSON.stringify(packs)};
    const registry = { ready: true, revision: 1, hostVersion: "1.9.4", packages: [{ package: ${JSON.stringify(themePack)}, enabled: false, digest: "theme-component-only", grants: [], epoch: 1 }, { package: ${JSON.stringify(manifestPack)}, enabled: false, digest: "manifest-component-only", grants: ${JSON.stringify(manifestPack.manifest.permissions?.required ?? [])}, epoch: 1 }, { package: pack, enabled: false, digest: "component-only", grants: [], epoch: 1 }] };
    window.catalog = [
      {id:"test.skill.a",name:"资料整理",description:"整理登记的资料与说明。",type:"skill",enabled:true,parameters:[]},
      {id:"test.skill.b",name:"长说明能力",description:"只读说明。".repeat(350),type:"skill",enabled:false,parameters:[],available:false,unavailableReason:"当前服务不可用"},
      {id:"test.workflow.a",name:"工作流说明",description:"仅显示登记信息。",type:"workflow",enabled:true,parameters:[]},
      {id:"test.tool.a",name:"浏览器收集",description:"浏览器中的收集能力。",type:"extension",enabled:true,parameters:[]}
    ];
    window.fetches = [];
    window.__TAURI_INTERNALS__ = { invoke: async (command,args) => {
      if (command === "manage_extension_packages") { if (window.failRegistry) throw Error("component-list-failed"); return structuredClone(registry); }
      if (command === "get_local_transport_client_config") return {baseUrl:"http://127.0.0.1:1",credential:"",protocolVersion:1};
      if (command === "get_collection_server_base_url") return "http://127.0.0.1:1";
      if (command === "knowledge_activate_ui_source") return {vaultId:"component-vault",sourceEpoch:1};
      if (command === "knowledge_get_current_context") return null;
      if (command === "knowledge_create_document") throw new Error("component-unknown-write-result");
      throw Error("Unexpected component command " + command);
    }};
    window.fetch = async (url) => {
      window.fetches.push(String(url));
      if (window.delayCatalog) await new Promise(resolve => { window.releaseCatalog = resolve; });
      return new Response(JSON.stringify({capabilities:window.catalog}), {status:window.failCatalog?503:200,headers:{"Content-Type":"application/json"}});
    };
    window.base = (theme,accent="#8186ff") => applyGlobalSettings({"general.theme":theme,"appearance.accentColor":accent});
    window.activateVault = () => setActiveKnowledgeSource({mode:"real-vault",vaultId:"component-vault"},true);
    window.clearVault = clearActiveKnowledgeSource;
    window.base("light"); location.hash = "#community?tab=extensions";
    createRoot(document.getElementById("fixture-content")).render(<I18nProvider locale="zh-CN"><ApplicationModalIsolationProvider store={createApplicationModalIsolationStore()}><CommunityPage /></ApplicationModalIsolationProvider></I18nProvider>);
  ` }, bundle: true, format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, outfile: path.join(out, "component", "app.js"), logLevel: "silent" });
  // Use the production shell's sizing ancestry. No block/overflow override of the
  // page: that used to mask the deployed header/results alignment and scroll bugs.
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--theme-app-bg);color:var(--text-primary);font:13px/1.5 system-ui}.fixture-sidebar{flex:0 0 var(--fixture-sidebar,220px);background:var(--theme-sidebar-bg);border-right:1px solid var(--border)}.fixture-label{font-size:11px;color:var(--text-secondary)}#fixture-content{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;overflow:hidden}</style><div id="root" class="react-nav-shell" data-route="community"><aside class="fixture-sidebar" aria-label="隔离侧栏占位"></aside><div class="main"><div class="titlebar fixture-label">生产社区组件 · 应用布局约束 · 受控测试数据 · 非 Main 验收</div><div class="content-wrap"><div class="content"><div id="fixture-content"></div></div></div></div></div><script src="/app.js"></script></html>';
  const server = http.createServer((req,res) => { const asset = req.url === "/app.js" || req.url === "/app.css"; res.setHeader("Content-Type",asset ? req.url.endsWith("css")?"text/css":"text/javascript":"text/html"); res.end(asset ? fs.readFileSync(path.join(out,"component",req.url.slice(1))) : html); });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  const browser = await chromium.launch({channel:"msedge",headless:true});
  const page = await browser.newPage({viewport:{width:1120,height:900}});
  try {
    page.on("pageerror",error => report.errors.push(String(error)));
    page.on("console",message => { if(message.type()==="error") report.errors.push(message.text()); });
    const step = async (name,fn) => { await fn(); report.checks.push(name); console.log("PASS " + name); };
    const tab = key => page.locator("#community-tab-" + key).click();
    const shot = async name => { const file = "component/"+name+".png"; await page.screenshot({path:path.join(out,file),fullPage:true}); report.screenshots.push(file); };
    await page.goto("http://127.0.0.1:"+server.address().port);
    await page.locator(".plugin-card").first().waitFor();
    await step("community drawer stays below titlebar, within content, and compact through resize and scroll", async () => {
      await page.getByRole("button", {name:"如何安装本地扩展？",exact:true}).click();
      await page.getByRole("dialog").waitFor();
      for (const width of [1440, 1100, 768, 390, 320]) {
        await page.setViewportSize({width,height:700});
        await page.evaluate(width=>document.documentElement.style.setProperty("--fixture-sidebar",width>=900?"220px":width>=640?"64px":"0px"),width);
        await page.evaluate(()=>{document.querySelector(".community-page").scrollTop=250;});
        const geometry=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width};};
          return {content:rect("#fixture-content"),backdrop:rect(".community-drawer-backdrop"),drawer:rect(".community-drawer"),titlebar:rect(".titlebar"),overflow:document.querySelector(".community-drawer").scrollWidth-document.querySelector(".community-drawer").clientWidth};
        });
        assert.ok(geometry.backdrop.y>=geometry.titlebar.bottom,JSON.stringify({width,geometry}));
        for (const edge of ["x","y","right","bottom"]) assert.ok(Math.abs(geometry.backdrop[edge]-geometry.content[edge])<1,JSON.stringify({width,edge,geometry}));
        assert.ok(Math.abs(geometry.drawer.width-Math.min(348,geometry.content.width))<1,JSON.stringify({width,geometry}));
        assert.ok(geometry.overflow<=1,JSON.stringify({width,geometry}));
        await shot("scoped-drawer-"+width);
      }
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({state:"detached"});
      assert.match(await page.evaluate(()=>document.activeElement.textContent),/如何安装本地扩展/);
      await page.setViewportSize({width:1120,height:900});
      await page.evaluate(()=>document.documentElement.style.setProperty("--fixture-sidebar","220px"));
    });
    await step("scoped plugin and theme drawers retain focus, visible footer actions and backdrop dismissal", async () => {
      for (const key of ["extensions", "packages"]) {
        await tab(key);
        await page.getByRole("button", {name:"详情",exact:true}).first().click();
        await page.getByRole("dialog").waitFor();
        await page.setViewportSize({width:900,height:480});
        const close=page.getByRole("button",{name:"关闭",exact:true});
        assert.equal(await close.evaluate(e=>e===document.activeElement),true);
        await page.keyboard.press("Shift+Tab");
        assert.equal(await page.evaluate(()=>document.querySelector(".community-drawer").contains(document.activeElement)),true);
        assert.ok(await page.locator(".community-drawer-footer").evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=60&&r.bottom<=innerHeight&&e.scrollWidth<=e.clientWidth+1;}));
        await shot("scoped-"+key+"-short");
        const backdrop=await page.locator(".community-drawer-backdrop").boundingBox();
        await page.mouse.click(backdrop.x+8,backdrop.y+8);
        await page.getByRole("dialog").waitFor({state:"detached"});
        assert.match(await page.evaluate(()=>document.activeElement.textContent),/详情/);
        await page.setViewportSize({width:1120,height:900});
      }
      await tab("extensions");
    });
    await step("one content rail aligns header, navigation, filters, cards and guide at all window widths", async () => {
      await page.evaluate(()=>window.base("dark"));
      for (const width of [3440,2200,1440,1100,900,640,390,320]) {
        await page.setViewportSize({width,height:1000});
        await page.evaluate(width=>document.documentElement.style.setProperty("--fixture-sidebar",width>=900?"220px":width>=640?"64px":"0px"),width);
        const geometry=await page.evaluate(()=>{
          const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,right:r.right,width:r.width,y:r.y};};
          const page=document.querySelector(".community-page");
          return {boxes:[".page-header",".community-library-head",".community-browse-toolbar",".plugin-section",".community-guide"].map(rect),pageWidth:page.clientWidth,overflow:page.scrollWidth-page.clientWidth,cards:getComputedStyle(document.querySelector(".community-plugin-grid")).gridTemplateColumns.split(" ").length,titleSize:getComputedStyle(document.querySelector(".page-title")).fontSize};
        });
        for(const box of geometry.boxes) {assert.ok(Math.abs(box.x-geometry.boxes[0].x)<1,JSON.stringify({width,geometry}));assert.ok(Math.abs(box.right-geometry.boxes[0].right)<1,JSON.stringify({width,geometry}));}
        assert.ok(geometry.overflow<=1,JSON.stringify({width,geometry}));
        assert.equal(geometry.cards,geometry.pageWidth<=650?1:2);
        assert.equal(geometry.titleSize,geometry.pageWidth<=650?"28px":"32px");
        await shot("aligned-plugins-"+width);
      }
      await page.setViewportSize({width:1120,height:900});
      await page.evaluate(()=>document.documentElement.style.setProperty("--fixture-sidebar","0px"));
      for (const key of ["packages","templates","skills","status"]) {await tab(key);await shot("aligned-"+key);}
      await page.evaluate(()=>window.base("light"));
    });
    await step("five tabs keep canonical order, deep link and keyboard navigation", async () => {
      assert.deepEqual(await page.getByRole("tab").evaluateAll(tabs=>tabs.map(t=>t.id)),["extensions","packages","templates","skills","status"].map(k=>"community-tab-"+k));
      await page.locator("#community-tab-extensions").focus(); await page.keyboard.press("ArrowRight");
      assert.equal(await page.evaluate(()=>location.hash),"#community?tab=packages");
      await page.keyboard.press("End"); assert.equal(await page.evaluate(()=>location.hash),"#community?tab=status");
    });
    await tab("skills");
    await step("long catalog copy stays compact on cards and remains available in details", async () => {
      assert.ok((await page.locator(".community-capability-card").last().boundingBox()).height < 350);
    });
    await shot("skills-light");
    await step("skills stay read-only and full ID search/filter uses catalog",async()=>{
      assert.equal(await page.locator(".community-capability-card").count(),2);
      await page.getByRole("searchbox").fill("test.skill.a"); assert.equal(await page.locator(".community-capability-card").count(),1);
      await page.getByRole("button",{name:"清除搜索",exact:true}).click();
      await page.getByRole("button",{name:/^未启用/}).click(); assert.equal(await page.locator(".community-capability-card").count(),1);
      assert.equal(await page.locator(".community-capability-card .lr-cap-run").count(),0);
      await page.getByRole("button",{name:"查看能力",exact:true}).click(); await page.getByRole("dialog").waitFor();
      assert.match(await page.getByRole("dialog").innerText(),/当前服务不可用/);
      const scroller=page.locator(".community-drawer-scroll"); assert.ok(await scroller.evaluate(e=>e.scrollHeight>e.clientHeight));
      await page.keyboard.press("Escape"); assert.match(await page.evaluate(()=>document.activeElement.textContent),/查看能力/);
    });
    await tab("status"); await shot("tools-light");
    await step("clipboard failure offers manual path and no false success",async()=>{
      await page.evaluate(()=>Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async()=>{throw Error("denied");}}}));
      await page.getByRole("button",{name:"复制路径",exact:true}).click(); await page.getByRole("alert").getByText(/手动复制/).waitFor();
      assert.equal(await page.getByText("已复制仓库内插件目录",{exact:true}).count(),0);
    });
    await tab("templates");
    await step("built-in templates gate missing vault/dirty editor and unknown write is not retried",async()=>{
      assert.equal(await page.locator(".community-note-template").first().getByRole("button",{name:"新建笔记",exact:true}).isDisabled(),true);
      await page.evaluate(()=>window.activateVault());
      const create=page.locator(".community-note-template").first().getByRole("button",{name:"新建笔记",exact:true}); await create.waitFor(); await page.waitForFunction(()=>!document.querySelector(".community-note-template .lr-cap-run:not(.secondary)").disabled);
      assert.equal(await page.locator(".community-note-template").first().getByRole("button",{name:"插入当前笔记",exact:true}).isDisabled(),true);
      await create.click(); await page.getByRole("alert").getByText(/以免重复写入/).waitFor();
      await page.evaluate(()=>window.clearVault()); await shot("templates-unconfirmed-write");
    });
    await tab("skills"); await page.getByRole("button",{name:/^全部/}).click(); await page.getByRole("searchbox").fill("");
    await step("loading, empty, no match and read failure remain distinct and retryable",async()=>{
      await page.getByRole("searchbox").fill("missing-content"); await page.getByRole("heading",{name:"没有找到匹配的内容",exact:true}).waitFor();
      await page.getByRole("button",{name:"清除筛选",exact:true}).click();
      await page.evaluate(()=>{window.failCatalog=true;window.catalog=[];}); await page.getByRole("button",{name:"刷新",exact:true}).click();
      await page.getByRole("alert").getByText("加载失败，请稍后重试。",{exact:true}).waitFor(); await shot("skills-read-failure");
      await page.evaluate(()=>{window.failCatalog=false;window.delayCatalog=true;}); await page.getByRole("button",{name:"重试",exact:true}).click();
      await page.locator(".community-loading").waitFor(); await shot("skills-loading");
      await page.evaluate(()=>{window.delayCatalog=false;window.releaseCatalog();}); await page.getByText("暂无能力。",{exact:true}).waitFor();
    });
    for(const theme of ["dark","rose-tea","white-zero"]) {await page.evaluate(theme=>window.base(theme),theme); await tab("extensions"); await shot("plugins-"+theme);}
    await step("filled actions follow custom accents and keep readable foregrounds", async()=>{
      for(const accent of ["#000000","#ffffff","#579472","#8186ff"]) {
        await page.evaluate(accent=>window.base("dark",accent),accent);
        const colors=await page.locator(".community-install").evaluate(e=>{const s=getComputedStyle(e);return [s.backgroundColor,s.color];});
        const luminance=color=>{const values=color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return values[0]*.2126+values[1]*.7152+values[2]*.0722;};
        const levels=colors.map(luminance).sort((a,b)=>a-b);
        assert.ok((levels[1]+.05)/(levels[0]+.05)>=4.5,JSON.stringify({accent,colors}));
      }
    });
    for(const width of [768,390,320]) {
      await page.setViewportSize({width,height:900});
      for(const key of ["extensions","packages","templates","skills","status"]) {await tab(key); await step(key+" "+width+"px has no document or page overflow",async()=>assert.ok(await page.evaluate(()=>{const p=document.querySelector(".community-page");return document.documentElement.scrollWidth<=innerWidth+1 && p.scrollWidth<=p.clientWidth+1;})));}
      await shot("tools-"+width);
    }
    assert.deepEqual(report.errors,[]); report.ok=true;
  } catch(error) { report.ok=false; report.failure=String(error.stack||error); report.body=await page.locator("body").innerText(); await page.screenshot({path:path.join(out,"component/FAILED-current.png"),fullPage:true}); throw error; }
  finally {fs.writeFileSync(path.join(out,"component-ui-verification.json"),JSON.stringify(report,null,2)); await browser.close(); await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
