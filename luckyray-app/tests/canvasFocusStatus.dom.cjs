const assert = require("node:assert/strict");
const { JSDOM } = require(process.env.LR_JSDOM_MODULE || "jsdom");
const dom = new JSDOM(
  '<div id="host"><div class="canvas-editor-floating-toolbar"></div><div id="root"></div></div>',
);
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
])
  global[key] = dom.window[key];
const observers = [];
global.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    observers.push(this);
  }
  observe(node) {
    this.observed.push(node);
  }
  disconnect() {
    this.disconnected = true;
  }
};
const { mountFocusStatusFixture } = require(
  require("node:path").resolve(process.argv[2]),
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
(async () => {
  const host = document.getElementById("host"),
    toolbar = host.querySelector(".canvas-editor-floating-toolbar");
  let bodyTop = 100,
    toolbarBottom = 164,
    reads = 0;
  host.getBoundingClientRect = () => {
    reads++;
    return { top: bodyTop };
  };
  toolbar.getBoundingClientRect = () => {
    reads++;
    return { bottom: toolbarBottom };
  };
  const fixture = mountFocusStatusFixture(
    document.getElementById("root"),
    host,
  );
  await pause();
  const status = () => document.querySelector("[role=status]");
  assert.equal(status().style.top, "76px");
  assert.equal(status().getAttribute("aria-live"), "polite");
  assert.equal(status().getAttribute("aria-busy"), "false");
  assert.equal(status().querySelector("strong").textContent, "焦点编辑");
  assert.equal(status().querySelector("span").textContent, "点击图片标记焦点");
  assert.equal(
    status().querySelector("button").getAttribute("aria-label"),
    "退出聚焦模式",
  );
  assert.deepEqual(observers[0].observed, [toolbar, host]);
  toolbarBottom = 208;
  observers[0].callback();
  await pause();
  assert.equal(status().style.top, "120px");
  bodyTop = 150;
  window.dispatchEvent(new Event("resize"));
  await pause();
  assert.equal(status().style.top, "70px");
  toolbarBottom = 120;
  observers[0].callback();
  await pause();
  assert.equal(status().style.top, "12px");
  fixture.render(true, true, "Generating focused edit");
  await pause();
  assert.equal(status().getAttribute("aria-busy"), "true");
  assert.equal(status().querySelector("strong").textContent, "Focus edit");
  assert.equal(
    status().querySelector("span").textContent,
    "Generating focused edit",
  );
  const exit = status().querySelector("button");
  assert.equal(exit.textContent, "Exit · Esc");
  assert.equal(exit.getAttribute("aria-label"), "Exit focus mode");
  exit.click();
  assert.equal(fixture.exits(), 1);
  fixture.render(false, false, "已完成");
  await pause();
  assert.equal(status().getAttribute("aria-busy"), "false");
  assert.equal(status().querySelector("button").textContent, "退出 · Esc");
  status().querySelector("button").click();
  assert.equal(fixture.exits(), 2);
  fixture.root.unmount();
  assert.equal(observers[0].disconnected, true);
  const readsAfterUnmount = reads;
  window.dispatchEvent(new Event("resize"));
  await pause();
  assert.equal(reads, readsAfterUnmount);
  // The window resize fallback remains functional where ResizeObserver is absent.
  delete global.ResizeObserver;
  toolbarBottom = 230;
  bodyTop = 100;
  const fallback = mountFocusStatusFixture(
    document.getElementById("root"),
    host,
  );
  await pause();
  assert.equal(status().style.top, "142px");
  toolbarBottom = 240;
  window.dispatchEvent(new Event("resize"));
  await pause();
  assert.equal(status().style.top, "152px");
  fallback.root.unmount();
  dom.window.close();
  console.log(
    "PASS focus status DOM: measured toolbar/body geometry, observer+resize updates, clamp, cleanup, bilingual busy state, exit, no-observer fallback",
  );
})().catch((error) => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
