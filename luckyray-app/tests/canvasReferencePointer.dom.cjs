require.extensions[".css"] = () => {};
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const tools = createRequire(process.env.LR_TEST_TOOLS + "/package.json");
const { JSDOM } = tools("jsdom");
const dom = new JSDOM('<div id="root"></div>', {
  url: "https://qa.invalid",
  pretendToBeVisual: true,
});
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
  disconnect() {}
};
window.__TAURI_INTERNALS__ = {
  convertFileSrc: (path) =>
    "http://asset.localhost/" + encodeURIComponent(path),
};
const React = require("react"),
  { createRoot } = require("react-dom/client"),
  { flushSync } = require("react-dom");
const {
  MaterialCompactComposer,
  createGenerationRequestSnapshot: compile,
  resolveStoredCanvasReferences: resolveStored,
  resolveCanvasConnectionData: edgeData,
  referenceForCanvasNode: fromNode,
  REFERENCE_TEST_PROFILE: profile,
  I18nProvider,
  ReactFlowProvider,
} = require(require("node:path").resolve(process.argv[2]));
const root = createRoot(document.getElementById("root"));
const delay = () => new Promise((resolve) => setTimeout(resolve, 35));
let checks = 0,
  patch = null,
  removed = null,
  reordered = null,
  props,
  renderId = 0;
const check = (value, message) => {
  assert.ok(value, message);
  checks++;
};
const eq = (value, expected, message) => {
  assert.deepEqual(value, expected, message);
  checks++;
};
const media = (id, role) => ({
  id,
  label: id,
  kind: "image",
  role,
  mediaUrl: "https://fixture.invalid/" + encodeURIComponent(id) + ".png",
});
const conn = (id, role = "reference") => ({
  edgeId: "e" + id,
  sourceNodeId: id,
  role,
  reference: media("node:" + id),
});
const chips = () => [...document.querySelectorAll(".canvas-reference-open")];
const item = (index) =>
  document.querySelectorAll(".canvas-composer-reference-item")[index];
async function paint() {
  // Flush the initial commit and node-reset effects before dispatching hover events.
  flushSync(() =>
    root.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          I18nProvider,
          { locale: "zh-CN" },
          React.createElement(
            ReactFlowProvider,
            null,
            React.createElement(MaterialCompactComposer, {
              key: renderId,
              ...props,
            }),
          ),
        ),
      ),
    ),
  );
  await delay();
}
async function render(data, inputs = [], extra = {}) {
  patch = removed = reordered = null;
  renderId++;
  props = {
    node: { id: "target", data: { label: "Target", ...data } },
    connectedInputs: inputs,
    mediaProfile: profile,
    imageModels: [profile.imageModel],
    defaultImageModel: profile.imageModel,
    videoModels: [profile.videoModel],
    defaultVideoModel: profile.videoModel,
    embedded: true,
    onDataChange: (value) => {
      patch = value;
    },
    onSubmit: () => {},
    onAddReference: () => {},
    onRemoveConnectedInput: (id) => {
      removed = id;
    },
    ...extra,
  };
  await paint();
}
async function applyPatch() {
  check(!!patch, "a user action produced a data patch");
  props = {
    ...props,
    node: { ...props.node, data: { ...props.node.data, ...patch } },
  };
  patch = null;
  await paint();
}
const snapshot = () =>
  compile(
    props.node,
    props.connectedInputs,
    [],
    "",
    props.imageModels,
    profile.imageModel,
    props.videoModels,
    profile.videoModel,
    props.mediaProfile,
    props.includeNoteTitles,
    props.resolvedStoredReferences,
  );
async function hover(index = 0) {
  chips()[index].dispatchEvent(
    new MouseEvent("mouseover", { bubbles: true, relatedTarget: null }),
  );
  await delay();
  return document.querySelector(".canvas-reference-hover");
}
async function leave(index = 0) {
  item(index).dispatchEvent(
    new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }),
  );
  await delay();
}
// JSDOM has no pointer capture/hit testing; model those platform primitives,
// then send the same pointer stream (including captured outside release) as WebView.
const captures = new Map();
HTMLElement.prototype.setPointerCapture = function(id) { captures.set(id, this); };
HTMLElement.prototype.hasPointerCapture = function(id) { return captures.get(id) === this; };
HTMLElement.prototype.releasePointerCapture = function(id) { captures.delete(id); };
let hitTarget = null;
document.elementFromPoint = () => hitTarget;
function pointer(target, type, x = 10, y = 10, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: {value:id}, isPrimary: {value:true} });
  (captures.get(id) || target).dispatchEvent(event);
  return event;
}
async function drag(from, to) {
  const source = chips()[from];
  pointer(source, "pointerdown");
  hitTarget = item(to);
  pointer(source, "pointermove", 70);
  await delay();
  check(item(from).classList.contains("is-dragging"), "pointer drag advertises active reference");
  check(!document.querySelector(".canvas-reference-hover"), "drag suppresses passive preview");
  const droppable = item(to).classList.contains("is-drop-target");
  pointer(source, "pointerup", 70);
  await delay();
  source.click(); // Browser click synthesized after the captured release must not insert.
  await delay();
  check(!document.querySelector(".is-dragging"), "pointer drag cleans active state");
  eq(captures.size, 0, "pointer capture released");
  return { droppable };
}
(async () => {
  let commits = 0;
  const onReorderReferences = (from, to) => { reordered = [from, to]; commits++; };
  await render({kind:"image",generationPrompt:"Draw"}, [conn("a"),conn("b")], {onReorderReferences});
  await hover();
  const result = await drag(0,1);
  eq(reordered,["ea","eb"],"same role pointer reorder");
  eq(commits,1,"release commits once");
  check(result.droppable,"valid target marked live");
  eq(patch,null,"captured release never inserts token");
  check(chips().every(chip=>!chip.draggable),"native drag disabled");
  const native = new Event("dragstart",{bubbles:true,cancelable:true});
  chips()[0].dispatchEvent(native);
  check(native.defaultPrevented,"native image drag is blocked");
  for (const ending of ["pointercancel", "lostpointercapture", "outside", "escape", "blur"]) {
    reordered = patch = null;
    const source = chips()[0];
    pointer(source, "pointerdown");
    hitTarget = item(0);
    pointer(source, "pointermove", 80);
    await delay();
    if (ending === "outside") { hitTarget = document.body; pointer(source, "pointerup", 900); }
    else if (ending === "escape") window.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true}));
    else if (ending === "blur") window.dispatchEvent(new Event("blur"));
    else pointer(source, ending, 80);
    await delay();
    pointer(source, "pointerup", 80); // A delayed release cannot commit cancelled work.
    source.click();
    await delay();
    eq(reordered, null, ending + " cancels reorder");
    eq(patch, null, ending + " does not insert a reference token");
    eq(captures.size, 0, ending + " releases capture");
    check(!document.querySelector(".is-dragging,.is-drop-target"), ending + " clears drag UI");
  }
  // Small movement remains a click, and a fresh click works after cancellation.
  patch = null;
  pointer(chips()[0], "pointerdown");
  pointer(chips()[0], "pointermove", 12, 11);
  check(!document.querySelector(".is-dragging"), "sub-threshold movement stays a click");
  pointer(chips()[0], "pointerup", 12, 11);
  chips()[0].click();
  await delay();
  check(patch && patch.generationPrompt.includes("[[lr-ref:ea]]"), "fresh click inserts after cancelled drag");
  await render({kind:"image",generationPrompt:"Draw"}, [conn("a"),conn("b")], {onReorderReferences});
  chips()[0].dispatchEvent(new KeyboardEvent("keydown", {key:"ArrowRight",altKey:true,bubbles:true,cancelable:true}));
  await delay();
  eq(reordered,["ea","eb"],"Alt+arrow keyboard alternative retained");
  // A reference in a different composer must never be accepted.
  reordered = null;
  const external = document.createElement("span");
  external.dataset.referenceKey="eb"; document.body.append(external);
  pointer(chips()[0],"pointerdown"); hitTarget=external;
  pointer(chips()[0],"pointermove",90); await delay();
  check(!document.querySelector(".is-drop-target"),"other tray cannot be targeted");
  pointer(chips()[0],"pointerup",90); await delay();
  eq(reordered,null,"other tray release does not reorder");
  external.remove();
  // Valid frame swap and incompatible-role rejection use the same planner.
  await render({kind:"video",generationPrompt:"Animate"},[conn("first","firstFrame"),conn("last","lastFrame")],{onReorderReferences});
  await drag(0,1); eq(reordered,["efirst","elast"],"first/last frame swap retained");
  await render({kind:"image",generationPrompt:"Draw"},[conn("a"),{edgeId:"context",sourceNodeId:"text",role:"promptContext",reference:{id:"text",kind:"text",label:"Context",text:"Body"}}],{onReorderReferences});
  const invalid=await drag(0,1); eq(reordered,null,"unrelated roles cannot cross"); check(!invalid.droppable,"invalid target not indicated");
  // Unmount during a held pointer must release platform capture.
  pointer(chips()[0],"pointerdown"); hitTarget=item(0); pointer(chips()[0],"pointermove",80);
  await delay(); root.unmount(); eq(captures.size,0,"unmount releases pointer capture");
  console.log(`Production pointer reference reorder DOM: ${checks} assertions PASS (JSDOM platform capture/hit testing simulated)`);
})().catch(error=>{console.error(error);root.unmount();process.exitCode=1;});
