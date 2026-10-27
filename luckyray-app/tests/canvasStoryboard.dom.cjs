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
  CanvasCreativeRail,
  defaultShot,
  patchStoryboardShot,
  moveStoryboardShot,
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
  delay = () => new Promise((r) => setTimeout(r, 25));
const button = (t) =>
  [...document.querySelectorAll("button")].find(
    (n) => n.textContent.trim() === t,
  );
const click = async (n) => {
  ok(n);
  n.click();
  await delay();
};
const input = async (n, value) => {
  n.focus();
  Object.getOwnPropertyDescriptor(
    n.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype,
    "value",
  ).set.call(n, value);
  n.dispatchEvent(new Event("input", { bubbles: true }));
  await delay();
};
(async () => {
  const root = createRoot(document.getElementById("root"));
  let nodes = [],
    created = 0,
    closed = 0,
    located = "",
    patches = 0;
  function Harness() {
    const [state, setState] = React.useState(nodes);
    const update = (n) => {
      nodes = n;
      setState(n);
    };
    return React.createElement(CanvasStoryboard, {
      nodes: state,
      selectedCount: 0,
      resolveUrl: (s) => s,
      onClose: () => closed++,
      onCreate: (name, selected) => {
        eq(selected, false);
        created++;
        update([
          {
            id: "b",
            data: { kind: "group", label: name, storyboard: { version: 1 } },
          },
          ...["a", "z"].map((id, i) => ({
            id,
            parentId: "b",
            data: {
              kind: "generator",
              generationKind: "image",
              storyboardShot: defaultShot(i),
              generationPrompt: "Original",
            },
          })),
        ]);
        return "b";
      },
      onAdd: () => {},
      onPatch: (b, id, p) => {
        patches++;
        update(patchStoryboardShot(nodes, b, id, p));
      },
      onMove: (b, id, d) => update(moveStoryboardShot(nodes, b, id, d)),
      onRemove: (b, id) =>
        update(
          nodes.map((n) => (n.id === id ? { ...n, parentId: undefined } : n)),
        ),
      onRename: (id, name) =>
        update(
          nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, label: name } } : n,
          ),
        ),
      onUnmark: (id) =>
        update(
          nodes.map((n) =>
            n.id === id
              ? { ...n, data: { ...n.data, storyboard: undefined } }
              : n,
          ),
        ),
      onLocate: (id) => (located = id),
    });
  }
  root.render(React.createElement(Harness));
  await delay();
  ok(document.querySelector('[role="dialog"]'));
  ok(button("从选中卡片创建").disabled);
  await input(document.querySelector('[aria-label="新分镜板名称"]'), "Film");
  await click(button("新建分镜板"));
  eq(created, 1);
  eq(document.querySelectorAll("article").length, 2);
  ok(document.body.textContent.includes("00:10.0"));
  let name = document.querySelector('[aria-label="镜头名称"]');
  await input(name, "Opening");
  eq(patches, 0);
  name.blur();
  await delay();
  eq(patches, 1);
  eq(nodes[1].data.storyboardShot.title, "Opening");
  eq(nodes[1].data.generationPrompt, "Original");
  const framing = document.querySelector("article select");
  framing.focus();
  Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  ).set.call(framing, "close");
  framing.dispatchEvent(new Event("change", { bubbles: true }));
  await delay();
  eq(document.activeElement, framing);
  eq(nodes[1].data.storyboardShot.framing, "close");
  let duration = document.querySelector('input[type="number"]');
  await input(duration, "2.5");
  duration.blur();
  await delay();
  eq(nodes[1].data.storyboardShot.durationSeconds, 2.5);
  ok(document.body.textContent.includes("00:07.5"));
  await input(duration, "0");
  duration.blur();
  await delay();
  eq(nodes[1].data.storyboardShot.durationSeconds, 2.5);
  eq(duration.value, "2.5");
  ok(duration.getAttribute("aria-invalid") === "true");
  await click(document.querySelector('[aria-label="镜头后移"]'));
  eq(document.querySelector('[aria-label="镜头名称"]').value, "");
  eq(document.querySelectorAll('[aria-label="镜头名称"]')[1].value, "Opening");
  await click(document.querySelector('[aria-label="打开画布卡片"]'));
  eq(located, "z");
  await click(document.querySelector('[aria-label="移出分镜，保留卡片"]'));
  await click(button("确认移出"));
  eq(document.querySelectorAll("article").length, 1);
  eq(nodes.length, 3);
  const dialogue = document.querySelector('[aria-label="台词 / 旁白"]');
  await input(dialogue, "Keep on Escape");
  dialogue.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  await delay();
  eq(closed, 1);
  eq(
    nodes.find((n) => n.id === "a").data.storyboardShot.dialogue,
    "Keep on Escape",
  );
  await click(button("取消分镜标记"));
  ok(button("确认，保留卡片"));
  await click(button("保留"));
  eq(document.querySelectorAll("article").length, 1);
  await click(button("取消分镜标记"));
  await click(button("确认，保留卡片"));
  eq(document.querySelectorAll("article").length, 0);
  eq(nodes.length, 3);
  eq(
    nodes.find((n) => n.id === "a").data.storyboardShot.dialogue,
    "Keep on Escape",
  );
  root.render(
    React.createElement(CanvasCreativeRail, {
      alwaysVisible: true,
      onAction: (k) => (located = k),
    }),
  );
  await delay();
  await click(button("分镜板"));
  eq(located, "storyboard");
  ok(button("成品导出"));
  for (const action of ["locate", "close", "remove", "unmark"]) {
    let stored = [
      {
        id: "board",
        data: { kind: "group", label: "Board", storyboard: { version: 1 } },
      },
      {
        id: "shot",
        parentId: "board",
        data: {
          kind: "generator",
          generationKind: "image",
          storyboardShot: defaultShot(0),
        },
      },
    ];
    function ClosingHarness() {
      const [state, setState] = React.useState(stored),
        [visible, setVisible] = React.useState(true);
      const update = (n) => {
        stored = n;
        setState(n);
      };
      return visible
        ? React.createElement(CanvasStoryboard, {
            nodes: state,
            selectedCount: 0,
            resolveUrl: (s) => s,
            onCreate: () => "",
            onAdd: () => {},
            onPatch: (b, id, p) =>
              update(patchStoryboardShot(stored, b, id, p)),
            onMove: () => {},
            onRemove: () =>
              update(
                stored.map((n) =>
                  n.id === "shot" ? { ...n, parentId: undefined } : n,
                ),
              ),
            onRename: () => {},
            onUnmark: () =>
              update(
                stored.map((n) =>
                  n.id === "board"
                    ? { ...n, data: { ...n.data, storyboard: undefined } }
                    : n,
                ),
              ),
            onLocate: () => setVisible(false),
            onClose: () => setVisible(false),
          })
        : null;
    }
    root.render(React.createElement(ClosingHarness, { key: action }));
    await delay();
    if (action === "unmark") await click(button("取消分镜标记"));
    const field = document.querySelector('[aria-label="动作 / 运镜"]');
    await input(field, "Keep " + action);
    if (action === "close")
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    else if (action === "locate")
      document.querySelector('[aria-label="打开画布卡片"]').click();
    else if (action === "remove")
      document.querySelector('[aria-label="移出分镜，保留卡片"]').click();
    else button("确认，保留卡片").click();
    await delay();
    if(action === "remove") await click(button("确认移出"));
    eq(
      stored.find((n) => n.id === "shot").data.storyboardShot.action,
      "Keep " + action,
    );
    eq(document.querySelectorAll("article").length, 0);
    if (action === "close" || action === "locate")
      eq(document.querySelector('[role="dialog"]'), null);
  }
  root.unmount();
  console.log(`Storyboard DOM ${checks} assertions PASS`);
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

