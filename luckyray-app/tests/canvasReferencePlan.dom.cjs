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
  // Hover remains passive. It must not recreate the rejected detail/actions card.
  await render({ kind: "image", generationPrompt: "Draw" }, [
    {
      edgeId: "en",
      sourceNodeId: "n",
      role: "promptContext",
      reference: { id: "node:n", kind: "note", label: "Only title", text: "" },
    },
  ]);
  let preview = await hover();
  eq(
    preview.querySelector("pre").textContent,
    "正文为空",
    "empty note preview never substitutes its title",
  );
  check(
    !preview.querySelector("button,header,strong"),
    "passive hover has no action row or repeated title",
  );
  check(
    !document.querySelector(".canvas-reference-detail,[role=dialog]"),
    "hover does not open a large detail dialog",
  );
  eq(patch, null, "hover does not alter prompt or references");
  check(
    !snapshot().prompt.includes("Only title"),
    "empty note title is not secretly sent",
  );
  await leave();
  check(
    !document.querySelector(".canvas-reference-hover"),
    "leaving the chip dismisses preview",
  );
  chips()[0].click();
  await delay();
  check(
    patch.generationPrompt.includes("[[lr-ref:en]]"),
    "click inserts a canonical identity token into the prompt",
  );
  eq(
    document.querySelector(".canvas-prompt-token").textContent,
    "Only title",
    "text token displays the actual material title",
  );
  check(
    !document.querySelector(".canvas-reference-detail"),
    "click does not recreate rejected details UI",
  );
  await applyPatch();
  check(
    snapshot().prompt.includes("@文本1"),
    "submitted prompt resolves inline token label",
  );
  check(
    !snapshot().prompt.includes("[[lr-ref:"),
    "internal token syntax never reaches provider prompt",
  );
  const long = " 正文" + "x".repeat(9000) + " ";
  await render(
    { kind: "image", generationPrompt: "Draw" },
    [
      {
        edgeId: "en",
        sourceNodeId: "n",
        role: "promptContext",
        reference: {
          id: "node:n",
          kind: "note",
          label: "NOTE-TITLE",
          text: long,
        },
      },
    ],
    { includeNoteTitles: true },
  );
  preview = await hover();
  const shown = preview.querySelector("pre").textContent;
  eq(shown.length, 500, "passive hover uses a short body excerpt");
  eq(shown, long.trim().slice(0, 500), "hover excerpt comes from actual body");
  const compiled = snapshot();
  eq(
    compiled.references[0].text.length,
    8000,
    "full generation body retains its 8000-character bound",
  );
  check(
    compiled.references[0].text.startsWith(shown),
    "hover excerpt matches actual compiled body",
  );
  check(
    compiled.prompt.includes("NOTE-TITLE"),
    "include-title preference remains honored",
  );
  await render({ kind: "image", generationPrompt: "Draw" }, [
    { ...conn("gone"), issue: "missing-source" },
  ]);
  check(
    document.querySelector(".canvas-composer-submit").disabled,
    "missing source blocks fresh generation",
  );
  preview = await hover();
  check(
    preview.textContent.includes("不存在"),
    "missing source is explained without an action panel",
  );
  document.querySelector(".canvas-composer-reference-remove").click();
  eq(removed, "egone", "remove targets the exact missing edge");
  eq(
    snapshot().references.length,
    0,
    "invalid source never enters immutable request",
  );
  await render({
    kind: "image",
    generationPrompt: "Draw",
    generationReferences: [
      {
        id: "thumb",
        label: "Thumbnail only",
        kind: "image",
        thumbnailUrl: "https://fixture.invalid/thumb.png",
      },
    ],
  });
  check(
    document.querySelector(".canvas-composer-submit").disabled,
    "thumbnail-only input cannot silently disappear",
  );
  preview = await hover();
  check(
    preview.textContent.includes("尚无"),
    "missing original is independent from thumbnail rendering",
  );
  document.querySelector(".canvas-composer-reference-remove").click();
  eq(
    patch.generationReferences,
    [],
    "unavailable stored reference remains removable",
  );
  const first = conn("first", "firstFrame"),
    second = conn("second", "firstFrame"),
    last = conn("last", "lastFrame");
  await render({ kind: "video", generationPrompt: "Animate" }, [
    first,
    second,
    last,
  ]);
  eq(
    chips().map((chip) => chip.getAttribute("aria-label").split(" · ")[0]),
    ["node:first", "node:second", "node:last"],
    "video display keeps canonical role order even with invalid legacy frames",
  );
  check(
    document.querySelector(".canvas-composer-submit").disabled,
    "duplicate frames remain visibly invalid",
  );
  await render({ kind: "video", generationPrompt: "Animate" }, [first, last], {
    onReorderReferences: (from, to) => {
      reordered = [from, to];
    },
  });
  check(
    !document.querySelector(".canvas-composer-submit").disabled,
    "valid first-last pair still submits",
  );
  check(
    !document.querySelector(
      ".canvas-reference-role-options,.canvas-reference-order,.canvas-reference-detail-move",
    ),
    "drag replaces role/action and arrow-button panels",
  );
  check(
    chips().every((chip) => !chip.draggable),
    "reference chips never enter native WebView drag/drop",
  );
  const swap = await drag(0, 1);
  eq(
    reordered,
    ["efirst", "elast"],
    "frame drag delegates exact source/target identities",
  );
  check(swap.droppable, "valid frame swap has a live drop indicator");
  eq(patch, null, "drag does not insert a prompt token");
  const context = {
    edgeId: "context",
    sourceNodeId: "text",
    role: "promptContext",
    reference: { id: "text", kind: "text", label: "Context", text: "Body" },
  };
  await render(
    { kind: "image", generationPrompt: "Draw" },
    [conn("a"), context],
    {
      onReorderReferences: (from, to) => {
        reordered = [from, to];
      },
    },
  );
  const rejected = await drag(0, 1);
  eq(reordered, null, "pointer drag refuses unrelated-role crossing");
  check(
    !rejected.droppable,
    "invalid crossing is not advertised as droppable",
  );
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
  const direct = [
    { ...media("node:a:reference", "reference"), mediaUrl: media("node:a").mediaUrl },
    { ...media("direct1", "reference"), mentionKey: "direct-one" },
    { ...media("direct2", "reference"), mentionKey: "direct-two" },
  ];
  await render(
    { kind: "image", generationPrompt: "Draw", generationReferences: direct },
    [conn("a")],
    {
      onReorderReferences: (from, to) => {
        reordered = [from, to];
      },
    },
  );
  eq(chips().length, 3, "same-source connected/stored shadow deduplicates");
  await drag(2, 0);
  eq(
    reordered,
    ["direct-two", "ea"],
    "drag can cross storage classes within one role",
  );
  props.node.data.generationInputOrder = ["direct-two", "ea", "direct-one"];
  await paint();
  eq(
    chips().map((chip) => chip.getAttribute("aria-label").split(" · ")[0]),
    ["direct2", "node:a", "direct1"],
    "persisted input order drives displayed chips",
  );
  eq(
    snapshot().references.map((ref) => ref.id),
    ["direct2", "node:a", "direct1"],
    "same input order drives actual request sequence",
  );
  document.querySelectorAll(".canvas-composer-reference-remove")[2].click();
  eq(
    patch.generationReferences.map((ref) => ref.id),
    ["node:a:reference", "direct2"],
    "removal uses original stored indexes after visual reorder",
  );
  // Identical source IDs must keep distinct token identities after another occurrence is removed.
  await render({
    kind: "image",
    generationPrompt: "Use ",
    generationReferences: [
      {
        ...media("same", "reference"),
        label: "First",
        mediaUrl: "https://fixture.invalid/first.png",
      },
      {
        ...media("same", "reference"),
        label: "Second",
        mediaUrl: "https://fixture.invalid/second.png",
      },
    ],
  });
  chips()[1].click();
  await delay();
  const tokenKey = document.querySelector(".canvas-prompt-token").dataset
    .referenceKey;
  check(!!tokenKey, "second occurrence token has a stable identity");
  check(
    !!document.querySelector(".canvas-prompt-token img"),
    "image mention includes its thumbnail inline",
  );
  await applyPatch();
  document.querySelectorAll(".canvas-composer-reference-remove")[0].click();
  await applyPatch();
  eq(chips().length, 1, "first repeated-source occurrence was removed");
  eq(
    document.querySelector(".canvas-prompt-token").dataset.referenceKey,
    tokenKey,
    "remaining inline token retains source identity",
  );
  eq(
    document.querySelector(".canvas-prompt-token").textContent,
    "Second",
    "material name stays stable after removing another occurrence",
  );
  check(
    !document
      .querySelector(".canvas-prompt-token")
      .classList.contains("is-invalid"),
    "surviving token does not bind to a removed occurrence",
  );
  eq(
    snapshot().references[0].mediaUrl,
    "https://fixture.invalid/second.png",
    "remaining request contains the originally mentioned second image",
  );
  check(
    snapshot().prompt.includes("@图1"),
    "submission resolves new ordinal after removal",
  );
  document.querySelector(".canvas-composer-reference-remove").click();
  await applyPatch();
  check(
    document
      .querySelector(".canvas-prompt-token")
      .classList.contains("is-invalid"),
    "removed mentioned source remains a visibly invalid token",
  );
  check(
    document.querySelector(".canvas-composer-submit").disabled,
    "removed mentioned source blocks fresh generation without a rendering exception",
  );
  assert.throws(snapshot, { code: "invalid-reference-mention" });
  checks++;
  const target = {
    id: "t",
    data: {
      kind: "image",
      label: "T",
      generationPrompt: "Draw",
      generationReferences: [media("node:source:reference", "reference")],
    },
  };
  const source = {
    id: "source",
    data: {
      kind: "image",
      label: "New title",
      refMediaUrl: "https://fixture.invalid/new.png",
    },
  };
  const resolved = resolveStored(target, [source]);
  eq(
    resolved[0].mediaUrl,
    source.data.refMediaUrl,
    "new request resolves current source content",
  );
  const old = compile(
    target,
    [],
    [],
    "",
    [profile.imageModel],
    profile.imageModel,
    [],
    "",
    profile,
    false,
    resolved,
  );
  source.data.refMediaUrl = "https://fixture.invalid/newer.png";
  eq(
    old.references[0].mediaUrl,
    "https://fixture.invalid/new.png",
    "existing request snapshot remains immutable",
  );
  eq(
    resolveStored(target, [])[0].issue,
    "missing-source",
    "removed stored source is detected",
  );
  const videoTarget = {
    id: "v",
    data: {
      kind: "generator",
      label: "V",
      generationKind: "video",
      generationReferences: [media("stored-first", "firstFrame")],
    },
  };
  const nextSource = {
    id: "s",
    data: {
      kind: "image",
      label: "S",
      refMediaUrl: "https://fixture.invalid/s.png",
    },
  };
  eq(
    edgeData(
      nextSource.data,
      videoTarget.data,
      "v",
      [],
      [videoTarget, nextSource],
    ).role,
    "lastFrame",
    "new connection respects stored first-frame occupancy",
  );
  const blank = fromNode({
    id: "blank",
    data: { kind: "generator", generationKind: "image", label: "Blank image" },
  });
  await render(
    { kind: "text", generationPrompt: "Describe names" },
    [
      {
        edgeId: "blank-edge",
        sourceNodeId: "blank",
        role: "reference",
        reference: blank,
        issue: blank.issue,
      },
    ],
    { textModels: ["text-model"], textModelsReady: true },
  );
  check(
    !document.querySelector(".canvas-composer-submit").disabled,
    "production label-only input still permits text generation",
  );
  chips()[0].click();
  await delay();
  await applyPatch();
  check(
    snapshot().prompt.includes("未传入媒体内容"),
    "text-channel mention compilation does not claim visual media was submitted",
  );
  root.unmount();
  console.log(
    `Production reference hover/token/drag DOM: ${checks} assertions PASS`,
  );
})().catch((error) => {
  console.error(error);
  root.unmount();
  process.exitCode = 1;
});
