const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const dom = new JSDOM('<div id="root"></div>', { url: "https://qa.invalid" });
for (const key of [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "navigator",
])
  Object.defineProperty(global, key, {
    value: dom.window[key],
    configurable: true,
  });
const React = require("react"),
  { createRoot } = require("react-dom/client");
const {
  CanvasStoryboard,
  CanvasShotSummary,
  defaultShot,
  patchStoryboardShot,
  patchStoryboardPrompt,
  buildStoryboardPrompt,
  resolveStoryboardPosition,
  storyboardOwner,
} = require(require("node:path").resolve(process.argv[2]));
let checks = 0;
const eq = (a, b) => {
    assert.deepEqual(a, b);
    checks++;
  },
  ok = (v) => {
    assert.ok(v);
    checks++;
  },
  delay = () => new Promise((r) => setTimeout(r, 20));
const btn = (t) =>
  [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim() === t,
  );
const click = async (b) => {
  ok(b);
  b.click();
  await delay();
};
const input = async (el, value) => {
  ok(el);
  el.focus();
  Object.getOwnPropertyDescriptor(
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    "value",
  ).set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  await delay();
};
const field = (label) => document.querySelector(`[aria-label="${label}"]`);
(async () => {
  const root = createRoot(document.getElementById("root"));
  let state = [
    {
      id: "b",
      data: { kind: "group", label: "First story", storyboard: { version: 1 } },
    },
    {
      id: "a",
      parentId: "b",
      data: {
        kind: "generator",
        generationKind: "image",
        generationPrompt: "Keep custom prompt",
        storyboardShot: {
          ...defaultShot(0),
          title: "Opening",
          dialogue: "Hello",
        },
      },
    },
    {
      id: "b2",
      data: {
        kind: "group",
        label: "Second story",
        storyboard: { version: 1 },
      },
    },
    {
      id: "z",
      parentId: "b2",
      data: {
        kind: "generator",
        generationKind: "video",
        generationPrompt: "Video prompt",
        storyboardShot: { ...defaultShot(0), title: "Ending" },
      },
    },
  ];
  let position = { boardId: "b2", shotId: "z", mode: "board" },
    located = "",
    generated = 0,
    throwPrompt = false;
  function Harness() {
    const [nodes, setNodes] = React.useState(state),
      [visible, setVisible] = React.useState(true),
      [pos, setPos] = React.useState(position),
      [generationError, setGenerationError] = React.useState(null);
    const update = (next) => {
        state = next;
        setNodes(next);
      },
      navigate = (p) => {
        position = p;
        setPos(p);
      };
    return visible
      ? React.createElement(CanvasStoryboard, {
          nodes,
          position: pos,
          onNavigate: navigate,
          selectedCount: 0,
          resolveUrl: (s) => s,
          onCreate: () => {
            throw Error("Should not create on reopen");
          },
          onAdd: () => {},
          onPatch: (b, id, p) => update(patchStoryboardShot(state, b, id, p)),
          onPrompt: (b, id, p) => {
            if (throwPrompt) throw Error("Simulated stale canvas");
            update(patchStoryboardPrompt(state, b, id, p));
          },
          onBuildPrompt: (b, id) =>
            buildStoryboardPrompt(state.find((n) => n.id === id)),
          onGenerate: () => {
            generated++;
            setGenerationError("请先配置画布模型");
          },
          generationError,
          onMove: () => {},
          onRemove: () => {},
          onRename: () => {},
          onUnmark: () => {},
          onClose: () => setVisible(false),
          onLocate: (id) => {
            located = id;
            setVisible(false);
          },
        })
      : React.createElement(
          "div",
          {},
          React.createElement(
            "button",
            { onClick: () => setVisible(true) },
            "返回分镜板",
          ),
          React.createElement(CanvasShotSummary, {
            shot: state.find((n) => n.id === located)?.data.storyboardShot,
            onOpen: () => setVisible(true),
          }),
        );
  }
  root.render(React.createElement(Harness));
  await delay();
  eq(field("镜头名称").value, "Ending");
  eq(field("新分镜板名称"), null);
  const overlay = document.querySelector(".canvas-creative-overlay");
  overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  overlay.dispatchEvent(new Event("pointerup", { bubbles: true }));
  await delay();
  ok(field("镜头名称"));
  await click(
    [
      ...document.querySelectorAll(".canvas-storyboard-library nav button"),
    ].find((b) => b.textContent.includes("First story")),
  );
  eq(position.boardId, "b");
  eq(position.shotId, undefined);
  await input(field("镜头名称"), "NOT A PROMPT");
  field("镜头名称").blur();
  await delay();
  eq(state[1].data.generationPrompt, "Keep custom prompt");
  await input(field("画面描述"), "Latest unblurred rainy street");
  // Programmatic click deliberately does not provide native focus blur.
  document.querySelector(".canvas-storyboard-generation").open = true;
  await click(btn("用画面描述准备提示词"));
  ok(
    document
      .querySelector(".canvas-storyboard-prompt-review pre")
      .textContent.includes("Latest unblurred rainy street"),
  );
  eq(state[1].data.generationPrompt, "Keep custom prompt");
  eq(generated, 0);
  throwPrompt = true;
  await click(btn("采用此提示词"));
  ok(document.querySelector('[role="alert"]'));
  ok(document.querySelector(".canvas-storyboard-prompt-review"));
  eq(state[1].data.generationPrompt, "Keep custom prompt");
  throwPrompt = false;
  await click(btn("采用此提示词"));
  eq(document.querySelector(".canvas-storyboard-prompt-review"), null);
  ok(state[1].data.generationPrompt.includes("Latest unblurred rainy street"));
  ok(!state[1].data.generationPrompt.includes("NOT A PROMPT"));
  ok(!state[1].data.generationPrompt.includes("Hello"));
  eq(generated, 0);
  await input(field("台词 / 旁白"), "A line to keep");
  await click(document.querySelector('[aria-label="打开画布卡片"]'));
  eq(located, "a");
  eq(position.boardId, "b");
  eq(position.shotId, "a");
  ok(
    document
      .querySelector(".canvas-shot-summary")
      .textContent.includes("A line to keep"),
  );
  ok(
    document
      .querySelector(".canvas-shot-summary")
      .textContent.includes("NOT A PROMPT"),
  );
  await click(btn("返回分镜板"));
  eq(field("镜头名称").value, "NOT A PROMPT");
  eq(field("台词 / 旁白").value, "A line to keep");
  eq(field("新分镜板名称"), null);
  await click(btn("连贯脚本"));
  eq(document.querySelectorAll(".canvas-storyboard-script-shot").length, 1);
  ok(
    document
      .querySelector(".canvas-storyboard-script-shot")
      .textContent.includes("A line to keep"),
  );
  ok(
    document
      .querySelector(".canvas-storyboard-script-shot")
      .textContent.includes("中景"),
  );
  await click(btn("编辑镜头"));
  eq(field("台词 / 旁白").value, "A line to keep");
  await click(btn("生成画面"));
  eq(generated, 1);
  ok(
    [...document.querySelectorAll('[role="alert"]')].some((n) =>
      n.textContent.includes("请先配置画布模型"),
    ),
  );
  await input(field("动作 / 运镜"), "Keep on explicit close");
  field("动作 / 运镜").dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await delay();
  eq(document.querySelector('[role="dialog"]'), null);
  await click(btn("返回分镜板"));
  eq(field("动作 / 运镜").value, "Keep on explicit close");
  await click(
    [
      ...document.querySelectorAll(".canvas-storyboard-library nav button"),
    ].find((b) => b.textContent.includes("Second story")),
  );
  eq(field("镜头名称").value, "Ending");
  eq(position.shotId, undefined);
  await click(btn("连贯脚本"));
  document.querySelector("[data-dialog-close]").click();
  await delay();
  await click(btn("返回分镜板"));
  ok(document.querySelector(".canvas-storyboard-script-shot"));
  eq(position.boardId, "b2");
  await click(btn("编辑镜头"));
  document.querySelector(".canvas-storyboard-generation").open = true;
  await input(field("生成提示词"), "");
  field("生成提示词").blur();
  await delay();
  await click(btn("准备生成"));
  ok(document.querySelector(".canvas-storyboard-generation").open);
  ok(document.body.textContent.includes("请先填写画面描述"));
  eq(generated, 1);
  // Persistence round trip retains new and old metadata without inferring ownership.
  const restored = JSON.parse(JSON.stringify(state));
  eq(restored[1].data.storyboardShot.dialogue, "A line to keep");
  eq(
    restored[1].data.storyboardShot.description,
    "Latest unblurred rainy street",
  );
  eq(
    storyboardOwner([{ ...restored[1], parentId: undefined }], "a"),
    undefined,
  );
  eq(resolveStoryboardPosition(restored, undefined, position).boardId, "b2");
  root.render(
    React.createElement(CanvasShotSummary, {
      shot: restored[1].data.storyboardShot,
    }),
  );
  await delay();
  eq(btn("打开分镜"), undefined);
  ok(document.body.textContent.includes("A line to keep"));
  root.unmount();
  console.log(`Storyboard R8 DOM ${checks} assertions PASS`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
