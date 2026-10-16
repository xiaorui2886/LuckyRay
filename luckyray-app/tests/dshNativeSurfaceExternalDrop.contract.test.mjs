import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function source(path) {
  return readFile(resolve(appRoot, path), "utf8");
}

test("the DSH child alone leaves external file drops to the official DOM attachment owner", async () => {
  const rust = await source("src-tauri/src/lib.rs");
  const openStart = rust.indexOf("fn create_dsh_native_surface_child(");
  const openEnd = rust.indexOf("async fn dsh_native_surface_open(", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "DSH native child builder remains bounded by its helpers");

  const dshOpen = rust.slice(openStart, openEnd);
  assert.match(dshOpen, /WebviewBuilder::new\(\s*DSH_NATIVE_SURFACE_WEBVIEW_LABEL,/u);
  assert.match(
    dshOpen,
    /WebviewBuilder::new\([\s\S]*?\)\s*\.disable_drag_drop_handler\(\)\s*\.on_navigation/u,
    "the DSH child must disable Tauri/WRY interception so WebView2 emits HTML5 file-drop events",
  );

  assert.equal(
    rust.match(/\.disable_drag_drop_handler\(\)/gu)?.length,
    1,
    "no main, personal-browser, or other child WebView drag/drop behavior is changed",
  );
});

test("frozen rc.2 still owns document drop, File creation, preview, and draft attachment state", async () => {
  const [attachment, conversation, attachmentPackage, conversationPackage] = await Promise.all([
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-client-ui-attachment/lib/client.js"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-client-ui-attachment/package.json"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-client-ui-conversation/package.json"),
  ]);

  // Match the actual frozen authority, not the historical Issue 189 old-engine fixture.
  const authority = JSON.parse(await source("dsh-host/runtime-authority.json"));
  assert.equal(JSON.parse(attachmentPackage).version, authority.runtimePackage.version);
  assert.equal(JSON.parse(conversationPackage).version, authority.runtimePackage.version);
  for (const event of ["dragenter", "dragover", "dragleave", "drop"]) {
    assert.match(attachment, new RegExp(`document\\.addEventListener\\("${event}"`));
  }
  assert.match(attachment, /const files = \[\.\.\.dataTransfer\.files\];\s*onAddFiles\(files, droppedDirectories\(dataTransfer, files\)\)/u);
  assert.match(conversation, /conversation\.createDrafts\(sessionId, uploads\)/u);
  assert.match(conversation, /shell\.addFiles\(references, drafts\.map\(\(draft\) => draft\.id\)\)/u);
  assert.match(conversation, /createDrafts\(sessionId, files\) \{/u);
  assert.match(conversation, /this\.draftAttachments\.set\(attachment\.id, attachment\)/u);
});
