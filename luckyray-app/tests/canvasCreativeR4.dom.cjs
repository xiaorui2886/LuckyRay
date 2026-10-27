const assert = require("node:assert/strict"),
  path = require("node:path");
const { JSDOM } = require(process.env.LR_JSDOM_MODULE || "jsdom");
const dom = new JSDOM(
  '<button id="before">before</button><div id="root"></div>',
  { url: "https://qa.invalid" },
);
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
])
  global[key] = dom.window[key];
const { mountRail, mountDelivery, mountImageTools } = require(
    path.resolve(process.argv[2]),
  ),
  delay = () => new Promise((r) => setTimeout(r, 30));
let checks = 0;
function eq(a, b) {
  assert.deepEqual(a, b);
  checks++;
}
function ok(v) {
  assert.ok(v);
  checks++;
}
(async () => {
  let f = mountRail(document.getElementById("root"));
  await delay();
  const rail = document.querySelector("aside"),
    handle = rail.querySelector("button"),
    nav = rail.querySelector("nav");
  eq(handle.getAttribute("aria-expanded"), "false");
  ok(nav.hasAttribute("inert"));
  handle.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, buttons: 0 }));
  await new Promise(resolve => setTimeout(resolve, 280));
  eq(handle.getAttribute("aria-expanded"), "true");
  eq(nav.querySelectorAll("button").length, 5);
  nav.querySelectorAll("button")[2].click();
  await delay();
  eq(f.events, ["editImage"]);
  rail.dispatchEvent(
    new MouseEvent("pointerout", {
      bubbles: true,
      relatedTarget: document.body,
    }),
  );
  await delay();
  eq(handle.getAttribute("aria-expanded"), "false");
  handle.focus();
  await delay();
  eq(handle.getAttribute("aria-expanded"), "true");
  handle.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await delay();
  eq(handle.getAttribute("aria-expanded"), "false");
  f.root.unmount();
  f = mountRail(document.getElementById("root"), true);
  await delay();
  eq(
    document.querySelector("aside button").getAttribute("aria-expanded"),
    "true",
  );
  f.root.unmount();
  // Minimal PNG signature fixture: exporter preserves bytes and does not decode images.
  const data =
    "data:image/png;base64," +
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  f = mountDelivery(document.getElementById("root"), data);
  await delay();
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "导出原始文件",
  );
  button.click();
  for (let i = 0; i < 30 && !document.querySelector("[role=status]"); i++)
    await delay();
  eq(f.events, ["save"]);
  ok(!button.disabled);
  ok(
    document.querySelector("[role=status]").textContent.includes("ZIP 已保存"),
  );
  f.root.unmount();

  // Geometry pixels are covered separately; this fixture checks actual control events.
  global.Image = class {
    naturalWidth = 400;
    naturalHeight = 200;
    src = "";
    decode() {
      return Promise.resolve();
    }
  };
  const oldCreate = URL.createObjectURL,
    oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => "blob:qa";
  URL.revokeObjectURL = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    translate() {},
    scale() {},
    rotate() {},
    drawImage() {},
  });
  window.HTMLCanvasElement.prototype.toBlob = function (callback) {
    callback(new Blob(["png"], { type: "image/png" }));
  };
  f = mountImageTools(document.getElementById("root"), data);
  await delay();
  await delay();
  const set = async (node, value) => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    await delay();
  };
  const width = document.querySelector('[aria-label="output-width"]'),
    height = document.querySelector('[aria-label="output-height"]');
  eq(width.value, "400");
  eq(height.value, "200");
  width.focus();
  await set(width, "");
  await set(width, "1");
  await set(width, "10");
  await set(width, "100");
  width.blur();
  await delay();
  eq(width.value, "100");
  eq(height.value, "50");
  height.focus();
  await set(height, "100");
  height.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  await delay();
  eq(width.value, "200");
  eq(height.value, "100");
  width.focus();
  await set(width, "");
  width.blur();
  await delay();
  eq(width.value, "200");
  [...document.querySelectorAll("button")]
    .find((b) => b.textContent === "保存副本到画布")
    .click();
  await delay();
  eq(f.events.length, 1);
  eq(f.events[0].width, 200);
  eq(f.events[0].height, 100);
  ok(document.querySelector("[role=status]").textContent === "saved");
  f.root.unmount();
  URL.createObjectURL = oldCreate;
  URL.revokeObjectURL = oldRevoke;
  console.log(
    `R4 real React/jsdom interactions: ${checks} assertions PASS (not Windows visual acceptance)`,
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
