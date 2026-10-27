const assert = require("node:assert/strict");
const { JSDOM } = require(process.env.LR_JSDOM_MODULE || "jsdom");
const dom = new JSDOM(
  '<div id="root"></div><button id="chip">Reference</button>',
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
  "CompositionEvent",
])
  global[key] = dom.window[key];
const { mountPromptEditorFixture } = require(
  require("node:path").resolve(process.argv[2]),
);
// Contract-check scoped sizing: neither a canvas image rule nor a long material
// name may turn an inline reference into a full-width/block image.
const css = require("node:fs").readFileSync(
  require("node:path").join(
    __dirname,
    "../src/features/canvas/canvasPromptEditor.css",
  ),
  "utf8",
);
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
const rules = [...style.sheet.cssRules];
const thumbRule = rules.find(
  (rule) =>
    rule.selectorText ===
    ".canvas-prompt-editor .canvas-prompt-token-remove > .canvas-prompt-token-thumb",
);
assert.equal(thumbRule.style.getPropertyValue("display"), "inline-block");
for (const dimension of [
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
])
  assert.equal(thumbRule.style.getPropertyValue(dimension), "15px");
assert.equal(
  rules
    .find(
      (rule) =>
        rule.selectorText === ".canvas-prompt-editor .canvas-prompt-token",
    )
    .style.getPropertyValue("display"),
  "inline-flex",
);
assert.equal(
  rules
    .find(
      (rule) =>
        rule.selectorText ===
        ".canvas-prompt-editor .canvas-prompt-token-label",
    )
    .style.getPropertyValue("text-overflow"),
  "ellipsis",
);
const pause = () => new Promise((resolve) => setTimeout(resolve, 25));
function caret(node, at) {
  const range = document.createRange();
  range.setStart(node, at);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}
(async () => {
  const fixture = mountPromptEditorFixture(document.getElementById("root"));
  await pause();
  const editor = document.querySelector("[role=textbox]");
  editor.focus();
  caret(editor.firstChild, 7);
  document.getElementById("chip").focus();
  fixture.handle.current.insertReference("a");
  await pause();
  assert.equal(fixture.value(), "before [[lr-ref:a]]after");
  assert.equal(editor.querySelector("span").textContent, "Ocean study.png");
  assert.equal(editor.querySelector("span").contentEditable, "false");
  assert.equal(
    editor.querySelector(".canvas-prompt-token-thumb").getAttribute("src"),
    "https://fixture.invalid/ocean.png",
  );
  assert.equal(
    editor.querySelector(".canvas-prompt-token-thumb").getAttribute("alt"),
    "",
  );
  editor
    .querySelector(".canvas-prompt-token-thumb")
    .dispatchEvent(new Event("error"));
  assert.equal(editor.querySelector(".canvas-prompt-token-thumb"), null);
  assert.equal(
    editor.querySelector(".canvas-prompt-token-label").textContent,
    "Ocean study.png",
  );
  // Typing at the restored caret follows the token, never edits its label.
  const selection = document.getSelection();
  selection.getRangeAt(0).insertNode(document.createTextNode(" instructions "));
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  await pause();
  assert.equal(fixture.value(), "before [[lr-ref:a]] instructions after");
  fixture.reorder();
  await pause();
  assert.equal(editor.querySelector("span").textContent, "Ocean study.png");
  assert.equal(fixture.value(), "before [[lr-ref:a]] instructions after");
  // Copy the complete editor exports readable labels, never persisted keys.
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
  let copied = "";
  const copy = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(copy, "clipboardData", {
    value: { setData: (_, value) => (copied = value) },
  });
  editor.dispatchEvent(copy);
  assert.equal(copied, "before Ocean study.png instructions after");
  caret(editor, 2);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    }),
  );
  await pause();
  assert.equal(fixture.value(), "before  instructions after");
  assert.equal(editor.querySelector("span"), null);
  // Browser-created empty blocks are caret placeholders, never a leading newline.
  for (const html of [
    "<br>",
    "<div><br></div>",
    "<p><br></p>",
    "<div><div><br></div></div>",
  ]) {
    fixture.set("");
    await pause();
    editor.innerHTML = html;
    // Empty landing text nodes are not logical lines, even around browser fillers.
    editor.prepend(document.createTextNode(""));
    editor.append(document.createTextNode(""));
    editor.focus();
    caret(editor, editor.childNodes.length);
    fixture.handle.current.insertReference("a");
    await pause();
    assert.equal(fixture.value(), "[[lr-ref:a]]", html);
    assert.equal(editor.firstChild.dataset.referenceKey, "a");
  }
  // Deliberate blank lines and insertion in the middle of a line are retained.
  fixture.set("\n\n");
  await pause();
  caret(editor.firstChild, 1);
  fixture.handle.current.insertReference("a");
  await pause();
  assert.equal(fixture.value(), "\n[[lr-ref:a]]\n");
  fixture.set("");
  await pause();
  editor.focus();
  caret(editor, 0);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  await pause();
  fixture.handle.current.insertReference("a");
  await pause();
  assert.equal(fixture.value(), "\n[[lr-ref:a]]");
  // Rename redraws only presentation, keeps the saved key and full accessible name.
  fixture.rename(
    "A renamed material with a very long descriptive filename.png",
  );
  await pause();
  assert.equal(
    editor.querySelector(".canvas-prompt-token").getAttribute("aria-label"),
    "A renamed material with a very long descriptive filename.png",
  );
  assert.equal(fixture.value(), "\n[[lr-ref:a]]");
  fixture.rename("  ");
  await pause();
  assert.equal(
    editor.querySelector(".canvas-prompt-token-label").textContent,
    "未命名图片",
  );
  fixture.rename("Ocean study.png");
  await pause();
  // Plain-text paste cannot inject elements.
  fixture.set("");
  await pause();
  editor.focus();
  caret(editor, 0);
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { getData: () => "<img src=x onerror=alert(1)>\ntext" },
  });
  editor.dispatchEvent(paste);
  await pause();
  assert.equal(editor.querySelector("img"), null);
  assert.equal(fixture.value(), "<img src=x onerror=alert(1)>\ntext");
  // Removed mentions stay visibly invalid rather than changing to a different image.
  fixture.set("[[lr-ref:a]]");
  await pause();
  fixture.remove();
  await pause();
  assert.equal(editor.querySelector("span").textContent, "引用已移除");
  fixture.set("");
  await pause();
  assert.equal(editor.dataset.empty, "true");
  // Composition is not interrupted by rerender or chip insertion; queued token lands afterwards.
  editor.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
  );
  editor.textContent = "中文";
  caret(editor.firstChild, 2);
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  assert.equal(fixture.value(), "");
  fixture.handle.current.insertReference("b");
  assert.equal(editor.textContent, "中文");
  editor.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
  );
  await pause();
  assert.equal(fixture.value(), "中文[[lr-ref:b]]");
  assert.equal(editor.querySelector("span").textContent, "山间日出");
  // Local history includes composition and token insertion as separate reversible edits.
  const key = (value, shift = false) =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        ctrlKey: true,
        shiftKey: shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  key("z");
  await pause();
  assert.equal(fixture.value(), "中文");
  key("z");
  await pause();
  assert.equal(fixture.value(), "");
  key("y");
  await pause();
  assert.equal(fixture.value(), "中文");
  key("z", true);
  await pause();
  assert.equal(fixture.value(), "中文[[lr-ref:b]]");
  fixture.reorder();
  await pause();
  key("z");
  await pause();
  assert.equal(fixture.value(), "中文");
  // A new owner/external document revision cannot resurrect the old prompt.
  fixture.set("external replacement");
  await pause();
  key("z");
  await pause();
  assert.equal(fixture.value(), "external replacement");
  // Escape reaches the enclosing overlay except during composition.
  let escapes = 0;
  const escapeListener = (event) => {
    if (event.key === "Escape") escapes++;
  };
  document.addEventListener("keydown", escapeListener);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(escapes, 1);
  fixture.set("");
  await pause();
  editor.focus();
  caret(editor, 0);
  editor.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
  );
  editor.textContent = "字";
  caret(editor.firstChild, 1);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  assert.equal(escapes, 1);
  const imePaste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(imePaste, "clipboardData", {
    value: {
      getData: (type) =>
        type === "text/plain" ? "<b>plain</b>" : "<b>rich</b>",
    },
  });
  editor.dispatchEvent(imePaste);
  assert.equal(imePaste.defaultPrevented, true);
  assert.equal(editor.textContent, "字");
  editor.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true, data: "字" }),
  );
  await pause();
  assert.equal(fixture.value(), "字<b>plain</b>");
  assert.equal(editor.querySelector("b"), null);
  document.removeEventListener("keydown", escapeListener);
  // Programmatic/assistive partial selections expand to the whole token.
  fixture.set("left [[lr-ref:b]] right");
  await pause();
  const tokenText = editor.querySelector(
    ".canvas-prompt-token-label",
  ).firstChild;
  const partial = document.createRange();
  partial.setStart(tokenText, 1);
  partial.setEnd(tokenText, 2);
  selection.removeAllRanges();
  selection.addRange(partial);
  let partialCopy = "";
  const atomCopy = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(atomCopy, "clipboardData", {
    value: { setData: (_, value) => (partialCopy = value) },
  });
  editor.dispatchEvent(atomCopy);
  assert.equal(partialCopy, "山间日出");
  assert.ok(!partialCopy.includes("lr-ref"));
  const atomCut = new Event("cut", { bubbles: true, cancelable: true });
  Object.defineProperty(atomCut, "clipboardData", {
    value: { setData: (_, value) => (partialCopy = value) },
  });
  editor.dispatchEvent(atomCut);
  await pause();
  assert.equal(partialCopy, "山间日出");
  assert.equal(fixture.value(), "left  right");
  // Focus atoms use the source identity, but show/copy their selected label.
  fixture.set("");
  await pause();
  editor.focus();
  caret(editor, 0);
  fixture.handle.current.insertFocusReference("b", {
    label: "山峰焦点",
    x: 0.25,
    y: 0.75,
  });
  await pause();
  const focusRaw = fixture.value();
  assert.ok(focusRaw.startsWith("[[lr-focus:"));
  assert.equal(
    editor.querySelector(".canvas-prompt-token").dataset.referenceKey,
    "b",
  );
  assert.equal(
    editor.querySelector(".canvas-prompt-token-label").textContent,
    "山峰焦点",
  );
  const focusRange = document.createRange();
  focusRange.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(focusRange);
  let focusCopy = "";
  const focusCopyEvent = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(focusCopyEvent, "clipboardData", {
    value: { setData: (_, value) => (focusCopy = value) },
  });
  editor.dispatchEvent(focusCopyEvent);
  assert.equal(focusCopy, "山峰焦点");
  caret(editor, 1);
  editor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    }),
  );
  await pause();
  assert.equal(fixture.value(), "");
  key("z");
  await pause();
  assert.equal(fixture.value(), focusRaw);
  // Inline presentation keeps raw bodies out of the compact label, but retains
  // true names and source metadata. Preview text is never interpreted as HTML.
  const body = '<img src=x onerror="alert(1)">她总穿一身素白，衣料是最寻常的细棉。';
  const sources = [
    { key: "text", source: "connected", role: "promptContext", edgeId: "edge-text", sourceNodeId: "node-text",
      reference: { id: "node:node-text", kind: "text", label: body, text: body } },
    { key: "named", source: "stored", role: "reference", storedIndex: 0,
      reference: { id: "note-1", kind: "note", label: "人物设定", text: body } },
    { key: "image", source: "connected", role: "reference", edgeId: "edge-image", sourceNodeId: "node-image",
      reference: { id: "material-1", kind: "image", label: "Costume study.png", mediaUrl: "https://fixture.invalid/full.png", thumbnailUrl: "https://fixture.invalid/thumb.png" } },
  ];
  fixture.setEntries(sources);
  fixture.set("start [[lr-ref:text]] / [[lr-ref:named]] / [[lr-ref:image]] middle [[lr-ref:image]] end");
  await pause();
  const tokens = () => [...editor.querySelectorAll(".canvas-prompt-token")];
  assert.deepEqual(tokens().map(token => token.querySelector(".canvas-prompt-token-label").textContent),
    ["文本", "人物设定", "Costume study.png", "Costume study.png"]);
  assert.ok(tokens().every(token => token.querySelector("button.canvas-prompt-token-remove")));
  assert.equal(tokens()[0].querySelector("svg.canvas-prompt-token-icon").getAttribute("aria-hidden"), "true");
  assert.equal(tokens()[0].querySelector("button").getAttribute("aria-label"), "移除提示词引用：文本");
  const inlineImage = tokens()[2].querySelector("img");
  inlineImage.dispatchEvent(new Event("error"));
  assert.equal(inlineImage.getAttribute("src"), "https://fixture.invalid/full.png");
  inlineImage.dispatchEvent(new Event("error"));
  assert.equal(tokens()[2].querySelector("img"), null);
  assert.ok(tokens()[2].querySelector(".canvas-prompt-token-icon"));
  const hover = token => token.dispatchEvent(new Event("pointerover", { bubbles: true }));
  hover(tokens()[0]);
  await pause();
  let preview = document.querySelector(".canvas-prompt-reference-floating");
  assert.ok(preview);
  assert.equal(editor.contains(preview), false);
  assert.equal(preview.querySelector("pre").textContent, body);
  assert.equal(preview.querySelector("img"), null);
  assert.equal(tokens()[0].getAttribute("aria-describedby"), preview.id);
  editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await pause();
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  hover(tokens()[2]);
  await pause();
  preview = document.querySelector(".canvas-prompt-reference-floating");
  assert.equal(preview.querySelector("img").getAttribute("src"), "https://fixture.invalid/thumb.png");
  preview.querySelector("img").dispatchEvent(new Event("error"));
  await pause();
  assert.equal(preview.querySelector("img").getAttribute("src"), "https://fixture.invalid/full.png");
  preview.querySelector("img").dispatchEvent(new Event("error"));
  await pause();
  assert.equal(preview.querySelector("img"), null);
  assert.ok(preview.querySelector(".canvas-reference-unavailable"));
  tokens()[2].dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  await pause();
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  // Removing the second occurrence preserves every source/edge and first token.
  const beforeRemove = fixture.value();
  hover(tokens()[3]);
  await pause();
  tokens()[3].querySelector("button").click();
  await pause();
  assert.equal(fixture.value(), "start [[lr-ref:text]] / [[lr-ref:named]] / [[lr-ref:image]] middle  end");
  assert.equal(fixture.entries(), sources);
  assert.equal(fixture.entries()[2].edgeId, "edge-image");
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  assert.equal(document.activeElement, editor);
  key("z");
  await pause();
  assert.equal(fixture.value(), beforeRemove);
  key("y");
  await pause();
  assert.equal(fixture.value(), "start [[lr-ref:text]] / [[lr-ref:named]] / [[lr-ref:image]] middle  end");
  // Keyboard focus exposes the same preview/removal, and composition is not cut short.
  const textRemove = tokens()[0].querySelector("button");
  textRemove.focus();
  await pause();
  assert.ok(document.querySelector(".canvas-prompt-reference-floating"));
  textRemove.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await pause();
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  textRemove.click();
  assert.ok(fixture.value().includes("[[lr-ref:text]]"));
  editor.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await pause();
  tokens()[0].querySelector("button").focus();
  tokens()[0].querySelector("button").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await pause();
  assert.equal(fixture.value(), "start  / [[lr-ref:named]] / [[lr-ref:image]] middle  end");
  // Preview is stage-local, viewport-clamped, and closes on outside interaction.
  const stage = document.createElement("section");
  stage.className = "canvas-editor-stage";
  stage.getBoundingClientRect = () => ({ left: 40, top: 30, right: 300, bottom: 280, width: 260, height: 250 });
  document.body.append(stage);
  stage.append(document.getElementById("root"));
  tokens()[0].getBoundingClientRect = () => ({ left: 290, top: 32, right: 300, bottom: 52, width: 10, height: 20 });
  hover(tokens()[0]);
  await pause();
  preview = document.querySelector(".canvas-prompt-reference-floating");
  assert.equal(preview.parentElement, stage);
  assert.equal(preview.style.position, "absolute");
  assert.ok(parseFloat(preview.style.left) + parseFloat(preview.style.width) <= 252);
  assert.ok(parseFloat(preview.style.top) > 22); // flips below the top-edge anchor
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  await pause();
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  // A video without a poster is a glyph; never fetch its video URL as an image.
  fixture.setEntries([{ key: "video", source: "stored", role: "reference", reference: {
    id: "video-1", kind: "video", label: "Scene.mp4", mediaUrl: "https://fixture.invalid/scene.mp4",
  } }]);
  fixture.set("[[lr-ref:video]]");
  await pause();
  assert.equal(editor.querySelector("img"), null);
  assert.ok(editor.querySelector(".canvas-prompt-token-icon"));
  hover(tokens()[0]);
  await pause();
  assert.ok(document.querySelector(".canvas-prompt-reference-floating"));
  // Escape also works when the pointer hovered a token without editor focus.
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await pause();
  assert.equal(document.querySelector(".canvas-prompt-reference-floating"), null);
  fixture.root.unmount();
  dom.window.close();
  console.log(
    "PASS: inline prompt DOM checks (compact labels, safe previews, stage portal, repeated-token removal, keyboard, history, caret, clipboard, newlines, IME).",
  );
})().catch((error) => {
  console.error(error);
  dom.window.close();
  process.exitCode = 1;
});
