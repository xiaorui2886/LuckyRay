require.extensions[".css"] = () => {};
const assert = require("node:assert/strict");
const { JSDOM } = require(process.env.LR_JSDOM_MODULE || "jsdom");
const dom = new JSDOM(
  '<div class="react-nav-shell"><div class="canvas-editor-root" id="root"></div></div>',
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
  "localStorage",
  "navigator",
])
  Object.defineProperty(global, key, {
    value: dom.window[key],
    configurable: true,
  });
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const React = require("react"),
  { createRoot } = require("react-dom/client");
const {
  CanvasMediaProfilesPanel,
  canvasMediaProfilesClient,
  resolveCanvasTextSelection,
  CanvasImageTools,
  I18nProvider,
  ReactFlowProvider,
} = require(require("node:path").resolve(process.argv[2]));
const delay = () => new Promise((r) => setTimeout(r, 35));
let checks = 0;
const eq = (a, b) => {
  assert.deepEqual(a, b);
  checks++;
};
const ok = (v) => {
  assert.ok(v);
  checks++;
};
const button = (t) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === t,
  );
const click = async (n) => {
  ok(n);
  n.click();
  await delay();
};
const select = async (n, value) => {
  Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  ).set.call(n, value);
  n.dispatchEvent(new Event("change", { bubbles: true }));
  await delay();
};
(async () => {
  const root = createRoot(document.getElementById("root"));
  const wrap = (node) =>
    React.createElement(
      I18nProvider,
      { locale: "zh-CN" },
      React.createElement(ReactFlowProvider, null, node),
    );
  const p = {
    id: "p",
    name: "EasyCLI",
    baseUrl: "http://127.0.0.1:8317/v1",
    imageModel: "gemini-3.1-flash-image",
    videoModel: "",
    imageProtocol: "gemini-image",
    videoProtocol: "disabled",
    textModel: "chat-a",
    textProtocol: "openai-chat",
    textModels: ["chat-a", "chat-b"],
    revision: 8,
    apiKeyConfigured: true,
  };
  let snapshot = { version: 1, activeProfileId: "p", profiles: [p] },
    saved,
    query;
  canvasMediaProfilesClient.save = async (value) => {
    saved = value;
    return snapshot;
  };
  canvasMediaProfilesClient.listModels = async (...args) => {
    query = args;
    return ["chat-a", "chat-b"];
  };
  root.render(
    wrap(
      React.createElement(CanvasMediaProfilesPanel, {
        snapshot,
        onChange: () => {},
      }),
    ),
  );
  await delay();
  ok(
    document
      .querySelector(".canvas-media-profile-summary")
      .textContent.includes("chat-a"),
  );
  await click(button("编辑"));
  const field = [...document.querySelectorAll("fieldset")].find((f) =>
    f.textContent.includes("文本生成"),
  );
  ok(field);
  const textSelect = field.querySelector("select");
  eq(textSelect.value, "openai-chat");
  eq(field.querySelector("input").value, "chat-a");
  await click(
    [...field.querySelectorAll("button")].find((b) =>
      b.textContent.includes("获取模型"),
    ),
  );
  eq(query[0], p.baseUrl);
  eq(query[2], "openai-image");
  eq(query[3], { profileId: "p", profileRevision: 8, clearApiKey: false });
  await click(button("保存配置"));
  eq(saved.textModel, "chat-a");
  eq(saved.textProtocol, "openai-chat");
  eq(saved.textModels, ["chat-a", "chat-b"]);
  eq(saved.imageProtocol, "gemini-image");
  eq(saved.apiKey, "");
  await click(button("编辑"));
  await select(document.querySelector("fieldset select"), "disabled");
  ok(!document.querySelector("fieldset input"));
  await click(button("保存配置"));
  eq(saved.textProtocol, "disabled");
  eq(saved.textModels, []);
  await click(button("编辑"));
  await select(document.querySelector("fieldset select"), "legacy");
  await click(button("取消"));
  ok(
    document
      .querySelector(".canvas-media-profile-summary")
      .textContent.includes("chat-a"),
  );
  eq(
    resolveCanvasTextSelection(p, {
      model: "global",
      models: ["global"],
      providerLabel: "global",
    }),
    { model: "chat-a", models: ["chat-a", "chat-b"], providerLabel: "EasyCLI" },
  );
  eq(
    resolveCanvasTextSelection(
      { ...p, textProtocol: "disabled" },
      { model: "global", models: ["global"], providerLabel: "global" },
    ).models,
    [],
  );
  eq(
    resolveCanvasTextSelection(
      { ...p, textProtocol: "legacy" },
      { model: "global", models: ["global"], providerLabel: "global" },
    ).model,
    "global",
  );
  root.render(
    wrap(
      React.createElement(CanvasImageTools, {
        onClose: () => {},
        onSave: async () => "",
        english: false,
      }),
    ),
  );
  await delay();
  ok(
    document
      .querySelector("[role=dialog]")
      .classList.contains("canvas-image-tools-dialog"),
  );
  ok(document.querySelector("[data-dialog-close]"));
  root.unmount();
  console.log(`R6 profile and dialog interactions: ${checks} assertions PASS`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
