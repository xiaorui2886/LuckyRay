import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
const source = readFileSync("src/CanvasSpike.tsx", "utf8"),
  start = source.indexOf("  const saveEditedImage=useCallback("),
  end = source.indexOf("  const insertWorkflow =", start);
assert.ok(start > 0 && end > start);
const code = transformSync(source.slice(start, end), {
  loader: "ts",
  target: "es2022",
}).code;
function fixture() {
  const state = {
    currentCanvasId: "c",
    loadingCanvas: false,
    currentCanvasIdRef: { current: "c" },
    canvasLoadEpochRef: { current: 1 },
    nodesRef: { current: [{ id: "n", position: { x: 1, y: 2 } }] },
    locale: "zh-CN",
    events: [] as any[],
    file: "/qa/copy.png" as string | null,
    failImport: false,
    failWrite: false,
    writeOptions: null as null | {createNew?:boolean},
    waitImport: null as null | Promise<void>,
  };
  const bridge = {
    importAssets: async () => {
      state.events.push("import");
      await state.waitImport;
      if (state.failImport) throw Error();
      return {
        assets: [
          {
            id: "asset",
            kind: "image",
            name: "copy",
            libraryPath: "/managed/copy.png",
          },
        ],
      };
    },
  };
  const deps = {
    ...state,
    bridge,
    useCallback: (fn: any) => fn,
    save: async () => state.file,
    writeFile: async (_path: string, _bytes: Uint8Array, options: {createNew?:boolean}) => {
      state.writeOptions = options;
      if(state.failWrite) throw new Error("already-exists");
      state.events.push("write");
    },
    safeDeliveryName: () => "copy.png",
    resolveCanvasMediaUrl: (s: string) => s,
    addNode: (...args: any[]) => state.events.push(["add", ...args]),
    getViewportCreatePosition: () => ({ x: 100, y: 100 }),
    reactFlowInstance: {
      getNodesBounds: () => ({ x: 501, y: 602, width: 320, height: 200 }),
    },
  };
  const callback = Function(
    ...Object.keys(deps),
    code + ";return saveEditedImage;",
  )(...Object.values(deps));
  return {
    state,
    run: () =>
      callback(
        {
          id: "n:0",
          nodeId: "n",
          label: "image",
          kind: "image",
          source: "original",
        },
        new Blob(["test"]),
        { turns: 0 },
      ),
  };
}
test("cancelled image save creates neither file nor library/card mutation", async () => {
  const f = fixture();
  f.state.file = null;
  assert.match(await f.run(), /取消/);
  assert.deepEqual(f.state.events, []);
});
test("failed import retains chosen PNG but never creates a false-success card", async () => {
  const f = fixture();
  f.state.failImport = true;
  assert.match(await f.run(), /导入失败/);
  assert.deepEqual(f.state.events, ["write", "import"]);
});
test("same-ID canvas reload during import refuses late insertion", async () => {
  const f = fixture();
  let finish!: () => void;
  f.state.waitImport = new Promise((r) => (finish = r));
  const pending = f.run();
  await new Promise((r) => setTimeout(r, 5));
  f.state.canvasLoadEpochRef.current++;
  finish();
  assert.match(await pending, /未插入/);
  assert.deepEqual(f.state.events, ["write", "import"]);
});
test("successful copy uses absolute bounds and creates one derived card", async () => {
  const f = fixture();
  assert.match(await f.run(), /新副本/);
  const adds = f.state.events.filter(Array.isArray);
  assert.equal(adds.length, 1);
  assert.equal(adds[0][2].derivedFromNodeId, "n");
  assert.deepEqual(adds[0][3], { x: 901, y: 602 });
});

test("edited image copy is create-only and failure never imports or inserts", async () => {
 const f=fixture();f.state.failWrite=true;
 await assert.rejects(f.run(),/不会覆盖已有文件/);
 assert.equal(f.state.writeOptions?.createNew,true);
 assert.deepEqual(f.state.events,[]);
});
