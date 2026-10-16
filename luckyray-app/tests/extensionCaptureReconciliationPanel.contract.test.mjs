import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Production panel logic in a synthetic DOM; no actual browser/profile/UI.
async function panelFixture() {
  const nodes = new Map(), timers = new Map(), events = {}, calls = [];
  let sequence = 0, pendingResult = { ok: true, pending: [] }, startResult;
  const receipt = { consumerVersion: 1, libraryId: "synthetic-B", requestId: "popup:synthetic",
    assetId: "asset-synthetic", disposition: "imported", assetName: "Synthetic.png" };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: "", children: [], hidden: true, disabled: false,
      textContent: "", events: {}, classList: { toggle() {} }, append(...values) { this.children.push(...values); },
      replaceChildren(...values) { this.children = values; }, querySelectorAll: () => [],
      addEventListener(name, callback) { this.events[name] = callback; }, removeAttribute() {} });
    return nodes.get(id);
  };
  const context = { URLSearchParams, Date, location: { search: "?tabId=11&mode=visible" },
    setTimeout: (callback, milliseconds) => { const id = ++sequence; timers.set(id, { callback, milliseconds }); return id; },
    clearTimeout: id => timers.delete(id), addEventListener: (name, callback) => { events[name] = callback; },
    Option: class { constructor(name, value) { this.name = name; this.value = value; } }, window: { close() {} },
    document: { getElementById: node, documentElement: {}, createElement: () => node("new"), createTextNode: value => value },
    chrome: { windows: { getCurrent: async () => ({ id: 1 }) }, runtime: { sendMessage: (payload, reply) => {
      calls.push(payload);
      if (payload.action === "pending") reply(pendingResult);
      else if (payload.action === "start") reply(startResult);
      else if (payload.action === "status") reply({ ok: true, draft: { id: receipt.requestId, libraryId: receipt.libraryId,
        mode: "visible", stage: "saved", receipt } });
      else reply({ ok: true, data: { consumerVersion: 1, libraries: [] } });
    } } } };
  context.globalThis = context; vm.createContext(context);
  vm.runInContext(await readFile(new URL("../browser-extension-prototype/capture-panel.js", import.meta.url), "utf8"), context);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await flush();
  return { context, node, timers, events, calls, receipt, flush,
    pending: value => { pendingResult = value; }, starting: value => { startResult = value; } };
}

test("saved receipt keeps controls usable and next Start creates a new capture without a reset click", async () => {
  const f = await panelFixture();
  vm.runInContext(`lock(true); render(${JSON.stringify({id:"popup:synthetic",mode:"visible",stage:"saved",libraryId:"synthetic-B",receipt:f.receipt})})`, f.context);
  await f.flush();
  for (const id of ["start","mode","library"]) assert.equal(f.node(id).disabled, false, id);
  assert.equal(f.node("receipt").hidden, false);
  f.node("mode").value="article";
  f.starting({ok:true,draft:{id:"popup:next",mode:"article",stage:"preview",libraryId:"vault-B",markdown:"New text"}});
  await f.node("start").events.click();
  assert.equal(vm.runInContext("draft.id",f.context),"popup:next");
  assert.equal(f.node("receipt").hidden,true);
  assert.equal(f.calls.filter(c=>c.action==="start").length,1);
  assert.equal(f.calls.filter(c=>["save","cancel","acknowledge"].includes(c.action)).length,0);
});

test("article target errors distinguish inactive knowledge from unsupported webpage and connection failure", async () => {
  const f=await panelFixture();
  for(const code of ["knowledge-source-inactive","knowledge-vault-required","knowledge-vault-unavailable"]){
    const text=vm.runInContext(`message(${JSON.stringify(code)})`,f.context);
    assert.match(text,/知识库/);
    assert.doesNotMatch(text,/检查 LuckyRay 连接/);
  }
  assert.match(vm.runInContext('message("no-readable-content")',f.context),/没有识别到.*正文/);
});

test("saved controls retain pending guards and clearly separate historic screenshot results",async()=>{
  const f=await panelFixture();
  f.pending({ok:true,pending:[{requestId:"popup:old",libraryId:"synthetic-B",mode:"visible"}]});
  vm.runInContext(`render(${JSON.stringify({id:"popup:synthetic",mode:"visible",stage:"saved",libraryId:"synthetic-B",receipt:f.receipt})})`,f.context);
  await f.flush();
  assert.equal(f.node("start").disabled,false);
  assert.match(f.node("pending-text").textContent,/此前.*不是本次采集/);
  f.pending({ok:true,pending:[{requestId:"popup:other",libraryId:"synthetic-B",mode:"visible",inFlight:true}]});
  await vm.runInContext("refreshPending()",f.context);
  assert.equal(f.node("start").disabled,true);
  assert.equal(f.calls.filter(c=>["save","acknowledge"].includes(c.action)).length,0);
});

test("an automatically recovered PNG renders the real saved state, not the manual pending screen", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [], recovered: [{ requestId: "popup:synthetic", receipt: fixture.receipt }] });
  vm.runInContext('render({id:"popup:synthetic",mode:"visible",stage:"uncertain",libraryId:"synthetic-B"})', fixture.context);
  await fixture.flush();
  assert.equal(fixture.node("receipt").hidden, false);
  assert.equal(fixture.node("pending").hidden, true);
  assert.equal(vm.runInContext("draft.stage", fixture.context), "saved");
  assert.equal(fixture.calls.filter(value => ["save", "acknowledge"].includes(value.action)).length, 0);
});

test("a reopened panel reports automatically confirmed old receipt without needing the old PNG", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [], recovered: [{ requestId: "popup:synthetic", receipt: fixture.receipt }] });
  await vm.runInContext("refreshPending()", fixture.context);
  assert.match(fixture.node("status").textContent, /已自动确认上次素材入库/);
  assert.equal(fixture.node("start").disabled, false);
});

test("unknown PNG results poll identity status only; the manual fallback is not shown during automatic confirmation", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [{ requestId: "popup:synthetic", libraryId: "synthetic-B", mode: "visible" }] });
  await vm.runInContext("refreshPending()", fixture.context);
  assert.equal(fixture.node("acknowledge").hidden, true);
  assert.match(fixture.node("pending-text").textContent, /无需手动核对/);
  assert([...fixture.timers.values()].some(value => value.milliseconds === 5000));
  fixture.node("retry-receipt").events.click(); await fixture.flush();
  assert.equal(fixture.calls.filter(value => ["save", "acknowledge"].includes(value.action)).length, 0);
  fixture.events.pagehide();
  assert.equal(fixture.timers.size, 0);
});

test("automatic confirmation has a finite wait and never clears an unconfirmed operation", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [{ requestId: "popup:synthetic", libraryId: "synthetic-B", mode: "visible" }] });
  await vm.runInContext("refreshPending()", fixture.context);
  vm.runInContext("pendingDeadline = Date.now() - 1", fixture.context);
  await vm.runInContext("refreshPending()", fixture.context);
  assert.match(fixture.node("pending-text").textContent, /暂时无法确认/);
  assert.equal(fixture.node("start").disabled, false);
  assert.equal(fixture.node("acknowledge").hidden, true);
  assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.calls.filter(value => value.action === "acknowledge").length, 0);
});

test("historic PNG pending does not disable a new preview, but the original uncertain preview cannot save again", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [{ requestId: "popup:old", libraryId: "synthetic-B", mode: "visible" }] });
  await vm.runInContext("refreshPending()", fixture.context);
  assert.equal(fixture.node("start").disabled, false);
  vm.runInContext('render({id:"popup:new",mode:"visible",stage:"preview",libraryId:"synthetic-B",materialCapabilities:{organize:false}})', fixture.context);
  await fixture.flush();
  assert.equal(fixture.node("save").disabled, false);
  vm.runInContext('render({id:"popup:old",mode:"visible",stage:"uncertain",libraryId:"synthetic-B"})', fixture.context);
  await fixture.flush();
  assert.equal(fixture.node("save").disabled, true);
  assert.equal(fixture.node("start").disabled, false);
});

test("the unchanged article path does not promise automatic PNG receipt recovery", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [{ requestId: "popup:article", libraryId: "synthetic-vault", mode: "article" }] });
  vm.runInContext('render({id:"popup:article",mode:"article",stage:"uncertain",libraryId:"synthetic-vault"})', fixture.context);
  await fixture.flush();
  assert.match(fixture.node("status").textContent, /正文保存结果暂未确认/);
  assert.equal(fixture.node("retry-receipt").hidden, true);
  assert.equal(fixture.node("acknowledge").hidden, false);
  assert.equal(fixture.timers.size, 0);
});

test("an unresolved screenshot does not disable starting an independent article", async () => {
  const fixture = await panelFixture();
  fixture.pending({ ok: true, pending: [{ requestId: "popup:old-png", libraryId: "synthetic-B", mode: "visible" }] });
  fixture.node("mode").value = "article";
  await vm.runInContext("refreshPending()", fixture.context);
  assert.equal(fixture.node("start").disabled, false);
  assert.equal(fixture.calls.filter(value => ["save", "acknowledge"].includes(value.action)).length, 0);
});

test("the same connection code cannot claim zero-write for an uncertain dispatched draft", async () => {
  const fixture = await panelFixture();
  vm.runInContext('render({id:"popup:synthetic",mode:"visible",stage:"failed",code:"app-unavailable"})', fixture.context);
  assert.match(fixture.node("status").textContent, /本次保存未提交/);
  vm.runInContext('render({id:"popup:synthetic",mode:"visible",stage:"uncertain",code:"app-unavailable"})', fixture.context);
  await fixture.flush();
  assert.doesNotMatch(fixture.node("status").textContent, /本次保存未提交/);
  assert.match(fixture.node("status").textContent, /查询原请求/);
});
