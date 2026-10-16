const fs = require("node:fs"),
  path = require("node:path"),
  test = require("node:test"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const esbuild = require(
  require.resolve("esbuild", {
    paths: [fs.realpathSync(root + "/node_modules/vite")],
  }),
);
const source = fs.readFileSync(
  root + "/src/features/notes/NotesPage.tsx",
  "utf8",
).replace(/\r\n/g, '\n');
function diskAttachment(text, notePath, vaultRoot) {
  const wiki=/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(text);
  const markdown=/\]\(((?:[^()]|\([^()]*\))+)\)/.exec(text);
  assert.ok(wiki || markdown, "saved note contains a real file reference");
  const destination=(wiki || markdown)[1];
  const absolute=wiki?path.resolve(vaultRoot,destination):destination.startsWith("file:")?require("node:url").fileURLToPath(destination):path.resolve(path.dirname(path.join(vaultRoot,notePath)),decodeURIComponent(destination));
  return {destination,wiki:!!wiki,absolute};
}
function callback(name, context) {
  const prefix = `const ${name} = useCallback(`;
  const start = source.indexOf(prefix) + prefix.length;
  assert.ok(start >= prefix.length);
  const end = source.indexOf("\n  }, [", start) + 4;
  const code = esbuild.transformSync(
    "const callback = " + source.slice(start, end),
    { loader: "ts" },
  ).code;
  return new Function("context", `with(context){${code};return callback;}`)(
    context,
  );
}
const blockModule = { exports: {} };
new Function("module", "exports", esbuild.transformSync(fs.readFileSync(root + "/src/core/markdown/materialBlockInsertion.ts", "utf8"), { loader: "ts", format: "cjs" }).code)(blockModule, blockModule.exports);
function fixture() {
  const state = {
    text: "",
    source: { vaultId: "A" },
    published: [],
    status: [],
    selection: { start: 0, end: 0 },
  };
  const context = {
    materialBlockInsertion: blockModule.exports.materialBlockInsertion,
    materialBlockSelection: blockModule.exports.materialBlockSelection,
    useRef: initial => ({current: initial}), useEffect: () => {},
    flushSync: fn => fn(), textareaRef: {current:null},
    editorModeSessionRef: {current: {mode: 'source', epoch: 0}},
    attachmentPaneEpochRef: {current: 0},
    sameAttachmentSelection: (a, b) => a.start === b.start && a.end === b.end,
    rememberPublishedAttachment: () => {},
    preparePublishedAttachment: async (_context, result) => ({ ...result, asset: {id:"asset-exact", libraryPath:"C:/v/picture.png"}, embed:{targetName:"md:./attachments/picture.png"} }),
    selectedNote: { id: "vault:note.md" },
    selectedNoteIdRef: { current: "vault:note.md" },
    noteLoadRequestRef: {current: 1},
    isRealVaultNoteId: () => true,
    realVaultRelativePathFromNoteId: () => "note.md",
    activeNotesSplitPaneRef: { current: "pane-1" },
    readActiveEditorSelection: () => state.selection,
    readActiveKnowledgeWriteSource: () => state.source,
    readActiveEditorValue: () => state.text,
    captureAttachmentContext: async () => ({}),
    attachmentContextIsCurrent: () => true,
    publishVaultAttachment: async (_context, input) => {
      state.published.push(input);
      return { markdown: "![picture](./attachments/picture.png)" };
    },
    insertPicker: { kind: "asset", selection: { start: 0, end: 0 } },
    autocomplete: { kind: "asset", start: 0, end: 0 },
    editorMode: "source",
    replaceEditorContent: (text, replacement, range) => ({
      content: text.slice(0, range.start) + replacement + text.slice(range.end),
      selection: { start: replacement.length, end: replacement.length },
    }),
    replaceEditorRange: (text, range = state.selection) => {
      state.text = state.text.slice(0, range.start) + text + state.text.slice(range.end);
    },
    handleContentChange: (text) => {
      state.text = text;
    },
    setSourceContentDraft: () => {},
    setInsertPicker: () => {},
    setAutocomplete: () => {},
    setStatus: (text) => state.status.push(text),
    setActiveEditorSelection: () => {},
    publishActiveNoteContext: () => {},
    focusActiveEditor: () => {},
    window: { setTimeout: (fn) => fn() },
    t: (key) => key,
    allAssets: [],
    buildDroppedAssetMarkdown: () => {
      throw Error("legacy route used");
    },
  };
  context.materialInsertionUiRef = {
    current: {
      insertPicker: context.insertPicker,
      autocomplete: context.autocomplete,
      editorMode: context.editorMode,
    },
  };
  const queueModule = {exports: {}};
  new Function('module', 'exports', esbuild.transformSync(fs.readFileSync(root + '/src/features/notes/editor/serialAttachmentInserts.ts', 'utf8'), {loader:'ts',format:'cjs'}).code)(queueModule, queueModule.exports);
  context.createSerialAttachmentInserts = queueModule.exports.createSerialAttachmentInserts;
  const helperStart = source.indexOf('const serialAttachmentInsertsRef =');
  const helperEnd = source.indexOf('// All material pickers', helperStart);
  Object.assign(context, new Function('context', `with(context){${esbuild.transformSync(source.slice(helperStart, helperEnd), {loader:'ts'}).code};return {serialAttachmentInsertsRef,captureAttachmentInsertSession,attachmentInsertSessionIsCurrent,captureAttachmentInsertCursor,resolveAttachmentInsertSelection,recordAttachmentInsertCommit};}`)(context));
  context.publishExistingAssetMarkdown = callback(
    "publishExistingAssetMarkdown",
    context,
  );
  return { state, context };
}
for (const name of [
  "insertPickedReference",
  "applyAutocompleteItem",
  "insertExistingAssetReference",
]) {
  test(`${name} uses the exact material ID and inserts the published disk path`, async () => {
    const { state, context } = fixture();
    await callback(name, context)(
      { id: "asset-exact", label: "display.png", name: "display.png" },
      { start: 0, end: 0 },
    );
    assert.deepEqual(state.published, [
      { name: "display.png", materialId: "asset-exact" },
    ]);
    assert.match(state.text, /\.\/attachments\/picture.png/);
    assert.doesNotMatch(state.text, /!\[\[display.png\]\]/);
  });
  test(`${name} leaves content untouched when physical publication fails`, async () => {
    const { state, context } = fixture();
    context.publishVaultAttachment = async () => {
      throw Error("copy failed");
    };
    await callback(name, context)(
      { id: "asset-exact", label: "display.png", name: "display.png" },
      { start: 0, end: 0 },
    );
    assert.equal(state.text, "");
    assert.ok(state.status.includes("copy failed"));
  });
}
test("material publication stops an A→B→A source change before publishing", async () => {
  const { state, context } = fixture();
  context.captureAttachmentContext = async () => {
    state.source = { vaultId: "A" };
    return {};
  };
  await assert.rejects(
    context.publishExistingAssetMarkdown({
      id: "asset-exact",
      name: "display.png",
    }),
    /编辑会话已切换/,
  );
  assert.deepEqual(state.published, []);
});
test("typing while a material is publishing keeps the draft and refuses stale insertion", async () => {
  const { state, context } = fixture();
  context.publishVaultAttachment = async () => {
    state.text = "new draft";
    return { markdown: "old result" };
  };
  await callback(
    "insertPickedReference",
    context,
  )({ id: "asset-exact", label: "display.png" });
  assert.equal(state.text, "new draft");
  assert.ok(state.status.some((message) => message.includes("文档已变化")));
});

if (process.env.LUCKYRAY_NATIVE_FIXTURE_URL) {
  const native = process.env.LUCKYRAY_NATIVE_FIXTURE_URL,
    target = process.env.LUCKYRAY_NATIVE_FIXTURE_ROOT?.replace(/^\\\\\?\\/, ""),
    vaultId = process.env.LUCKYRAY_NATIVE_FIXTURE_ID;
  assert.ok(target.includes("vault-attachments-native-browser-"));
  const rpc = async (command, args) => {
    const response = await fetch(native, {
      method: "POST",
      body: JSON.stringify({ command, args }),
    }).then((r) => r.json());
    if (response.error) throw Error(JSON.stringify(response.error));
    return response.value;
  };
  for (const name of [
    "insertPickedReference",
    "insertPickedReferenceVideo",
    "applyAutocompleteItem",
    "insertExistingAssetReference",
    "insertDroppedFilesAsAssets",
    "insertClipboardImageAsAsset",
    "insertDroppedFilesAsAssetsCopy",
    "materialDetailsCurrent",
  ])
    test(`${name} publishes through real Catalog and saves an independently resolvable native document`, async () => {
      const original = path.join(
        path.dirname(target),
        "material-" + name + (name.endsWith("Video") ? " (1).mp4" : ".png"),
      );
      let bytes = Buffer.concat([
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6cAAAAABJRU5ErkJggg==",
          "base64",
        ),
        Buffer.from(name),
      ]);
      if(name.endsWith("Video")){
        require("node:child_process").execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=red:s=160x90:d=1:r=30","-c:v","libx264","-pix_fmt","yuv420p",original]);
        bytes=fs.readFileSync(original);
      }else fs.writeFileSync(original, bytes);
      const mode =
        name === "insertPickedReference"
          ? "managed"
          : name === "applyAutocompleteItem"
            ? "linked"
            : "source";
      const material = (
        await rpc("fixture_material", {
          path: original,
          options: { storageMode: mode },
        })
      ).assets[0];
      const document = await rpc("fixture_create", {
        title: name,
        content: "",
      });
      const reference = document.documentRef;
      if (name === "insertDroppedFilesAsAssetsCopy")
        await rpc("knowledge_set_attachment_handling_policy", {
          vaultId,
          sourceEpoch: Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH),
          policy: "copy",
        });
      if (name === "materialDetailsCurrent") {
        await rpc("fixture_current", {
          documentRef: reference,
          revision: document.revision,
        });
        const materialsSource=fs.readFileSync(root+"/src/core/services/materials.ts","utf8");
        const from=materialsSource.indexOf("export async function insertMaterialAssetIntoCurrentKnowledge(");
        const to=materialsSource.indexOf("\nexport async function getMaterialAssetAiSuggestion",from);
        const code=esbuild.transformSync(materialsSource.slice(from,to).replace("export ",""),{loader:"ts"}).code;
        const activeSource={vaultId};const refreshes=[];let displayedIndex;
        const insert=new Function("context",`with(context){${code};return insertMaterialAssetIntoCurrentKnowledge;}`)({
          readActiveKnowledgeWriteSource:()=>activeSource,
          flushCurrentNoteContextUpdates:async()=>{},
          ensureActiveKnowledgeUiSource:async()=>({vaultId,sourceEpoch:Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH)}),
          invokeTauriCommand:rpc,
          knowledgeDocumentNoteId:ref=>ref.relativePath,
          knowledgeStore:{invalidate:async()=>{displayedIndex=await rpc("fixture_refresh",{});refreshes.push("index");}},
          materialStore:{invalidate:async()=>{const details=await rpc("fixture_attachment_details",{assetId:material.id});assert.equal(details.referenceCount,1);refreshes.push("materials");}},
        });
        const result=await insert(material);
        assert.deepEqual(refreshes.sort(),["index","materials"]);
        assert.equal(displayedIndex.documents.find(item=>item.relativePath===reference.relativePath).embeds.length,1,"returning from details observes the new shared index without a tab click or watcher");
        const saved = await rpc("fixture_read", { documentRef: reference });
        assert.equal(
          result.noteId,
          reference.relativePath,
        );
        const parsed=diskAttachment(saved.content,reference.relativePath,target);
        const rawPath=parsed.absolute;
        assert.deepEqual(fs.readFileSync(rawPath), bytes);
        assert.doesNotMatch(saved.content, /!\[\[asset-/);
        return;
      }
      const { state, context } = fixture();
      context.realVaultRelativePathFromNoteId = () => reference.relativePath;
      context.captureAttachmentContext = async () => {
        const [active, note] = await rpc("knowledge_attachment_context", {
          documentRef: reference,
        });
        return {
          documentRef: reference,
          sourceEpoch: active.sourceEpoch,
          expectedRevision: note.revision,
        };
      };
      const serviceSource = fs.readFileSync(
        root + "/src/core/services/vaultAttachments.ts",
        "utf8",
      );
      const serviceStart = serviceSource.indexOf(
        "export async function publishVaultAttachment(",
      );
      const serviceEnd = serviceSource.indexOf(
        "export function resolveVaultAttachment",
        serviceStart,
      );
      const serviceCode = esbuild.transformSync(
        serviceSource.slice(serviceStart, serviceEnd).replace("export ", ""),
        { loader: "ts" },
      ).code;
      context.publishVaultAttachment = new Function(
        "context",
        `with(context){${serviceCode};return publishVaultAttachment;}`,
      )({
        readActiveKnowledgeWriteSource: () => ({ vaultId: reference.vaultId }),
        attachmentContextIsCurrent: () => true,
        getAttachmentHandlingPolicy: (vaultId) =>
          rpc("knowledge_get_attachment_handling_policy", { vaultId }),
        invoke: rpc,
      });
      const file = {
        name: path.basename(original),
        size: bytes.length,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      };
      if (name === "insertClipboardImageAsAsset") {
        context.isClipboardDataImageSource = () => true;
        context.clipboardDataUrlToImageFile = async () => file;
        context.insertDroppedFilesAsAssets = callback(
          "insertDroppedFilesAsAssets",
          context,
        );
        await callback(name, context)(
          { value: "data:image/png;base64," + bytes.toString("base64") },
          { start: 0, end: 0 },
        );
      } else if (name.startsWith("insertDroppedFilesAsAssets")) {
        await callback("insertDroppedFilesAsAssets", context)(
          [{ ...file, path: original }],
          { start: 0, end: 0 },
        );
      } else
        await callback(name === "insertPickedReferenceVideo" ? "insertPickedReference" : name, context)(
          { id: material.id, label: material.name, name: material.name },
          { start: 0, end: 0 },
        );
      assert.match(state.text, name.endsWith("Video") ? /\[/ : /!\[/);
      if (
        name !== "insertClipboardImageAsAsset" &&
        name !== "insertDroppedFilesAsAssetsCopy"
      )
        assert.doesNotMatch(state.text, /attachments\//);
      else
        assert.match(
          state.text,
          /attachments\//,
          "clipboard bytes must be saved once",
        );
      if (mode !== "managed") assert.doesNotMatch(state.text, /[a-f0-9]{64}/);
      await rpc("fixture_save", {
        documentRef: reference,
        content: state.text,
        expectedRevision: document.revision,
      });
      const saved = await rpc("fixture_read", { documentRef: reference });
      assert.equal(saved.content.trimEnd(), state.text.trimEnd());
      if(name.endsWith("Video")){
        const index=await rpc("fixture_refresh",{});
        const indexed=index.documents.find(item=>item.relativePath===reference.relativePath);
        assert.equal(indexed.embeds.length,1);
        assert.equal(indexed.embeds[0].kind,"mp4");
        const details=await rpc("fixture_attachment_details",{assetId:material.id});
        assert.equal(details.referenceCount,1);
      }
      const parsed=diskAttachment(saved.content,reference.relativePath,target);
      const destination=parsed.destination;
      const resolved = await rpc("knowledge_resolve_attachment", {
        documentRef: reference,
        destination,
        wiki: parsed.wiki,
      });
      assert.equal(resolved.status, "resolved");
      if (
        name !== "insertClipboardImageAsAsset" &&
        name !== "insertDroppedFilesAsAssetsCopy"
      )
        assert.equal(
          fs.realpathSync.native(resolved.absolutePath),
          fs.realpathSync.native(
            name === "insertPickedReference" ? material.libraryPath : original,
          ),
          "reference uses exact storage-mode owned path",
        );
      const rawDiskTarget = parsed.absolute;
      assert.deepEqual(
        fs.readFileSync(rawDiskTarget),
        bytes,
        "raw Markdown works without Catalog lookup",
      );
      assert.deepEqual(fs.readFileSync(resolved.absolutePath), bytes);
      assert.deepEqual(fs.readFileSync(original), bytes);
      if (name === "insertDroppedFilesAsAssetsCopy")
        await rpc("knowledge_set_attachment_handling_policy", {
          vaultId,
          sourceEpoch: Number(process.env.LUCKYRAY_NATIVE_FIXTURE_EPOCH),
          policy: "reference",
        });
    });
}

test("moving the caret during publication cancels the old insertion range", async () => {
  const { state, context } = fixture();
  context.publishVaultAttachment = async () => {
    state.selection = { start: 3, end: 3 };
    return { markdown: "old" };
  };
  await callback(
    "insertPickedReference",
    context,
  )({ id: "asset", label: "image" });
  assert.equal(state.text, "");
});
for (const [name, field] of [
  ["insertPickedReference", "insertPicker"],
  ["applyAutocompleteItem", "autocomplete"],
])
  test(`${name} cannot insert after cancellation`, async () => {
    const { state, context } = fixture();
    context.publishVaultAttachment = async () => {
      context.materialInsertionUiRef.current[field] = null;
      return { markdown: "old" };
    };
    await callback(name, context)({ id: "asset", label: "image" });
    assert.equal(state.text, "");
  });
for (const mutation of ["source", "caret", "pane"])
  test(`file insertion refuses stale ${mutation} after publication`, async () => {
    const { state, context } = fixture();
    context.publishVaultAttachment = async () => {
      if (mutation === "source") state.source = { vaultId: "A" };
      else if (mutation === "caret") state.selection = { start: 1, end: 1 };
      else context.activeNotesSplitPaneRef.current = "pane-2";
      return { markdown: "![x](../x.png)" };
    };
    await callback("insertDroppedFilesAsAssets", context)(
      [{ name: "x.png", path: "C:/x.png", size: 1 }],
      { start: 0, end: 0 },
    );
    assert.equal(state.text, "");
    assert.ok(state.status.length);
  });

for (const name of ["insertPickedReference", "applyAutocompleteItem", "insertExistingAssetReference"]) {
  for (const [text, offset, before, after] of [["# Heading", 0, "", "\n# Heading"], ["left right", 5, "left \n", "\nright"], ["left\n\nright", 6, "left\n\n", "\nright"]]) {
    test(`${name} keeps material block separate at ${JSON.stringify(text)}:${offset}`, async () => {
      const { state, context } = fixture();
      state.text = text;
      state.selection = { start: offset, end: offset };
      context.insertPicker.selection = state.selection;
      context.autocomplete.start = offset;
      context.autocomplete.end = offset;
      await callback(name, context)({ id: "asset-exact", label: "picture.png", name: "picture.png" }, state.selection);
      assert.equal(state.text, before + "![picture](./attachments/picture.png)" + after);
    });
  }
}

for (const mutation of ['source','selection','note-session','body','pane']) test('late prepared presentation refuses changed '+mutation,async()=>{
  const {state,context}=fixture();
  context.preparePublishedAttachment=async(_context,result)=>{
    if(mutation==='source')state.source={vaultId:'A'};
    if(mutation==='selection')state.selection={start:2,end:2};
    if(mutation==='note-session')context.noteLoadRequestRef.current++;
    if(mutation==='body')state.text='continued typing';
    if(mutation==='pane')context.activeNotesSplitPaneRef.current='pane-2';
    return {...result};
  };
  await assert.rejects(context.publishExistingAssetMarkdown({id:'exact',name:'same.png'}),/文档已变化/);
  assert.equal(state.text,mutation==='body'?'continued typing':'');
});
