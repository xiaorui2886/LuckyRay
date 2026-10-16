import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import {
  canvasNoteBody,
  canvasNoteTitle,
  canvasNodeLibraryCandidates,
  createCanvasSaveGate,
} from "../src/core/canvas/nodeSaving.ts";
import { createCanvasTextGenerationAdapter } from "../src/core/canvas/textGenerationAdapter.ts";
import { createCanvasGenerationTask } from "../src/core/canvas/generationTasks.ts";
import {
  historyEntryFromTask,
  normalizeGenerationHistory,
  generationTaskFromHistory,
} from "../src/core/canvas/generationHistory.ts";
import {
  rotateImageEdit,
  renderImageEdit,
} from "../src/core/canvas/imageEditing.ts";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createCanvas } = require(
  process.env.LR_CANVAS_MODULE || "@napi-rs/canvas",
);
const task = createCanvasGenerationTask({
  id: "t",
  sourceNodeId: "n",
  resultNodeId: "n",
  createdAt: "2026-10-10",
  request: {
    kind: "image",
    model: "image",
    prompt: "synthetic",
    references: [],
  },
});
const completed = { ...task, status: "succeeded" as const };
const entry = historyEntryFromTask(completed, {
  mediaUrl: "C:/a.png",
  mediaItems: [{ url: "C:/a.png" }, { url: "C:/b.png" }],
});
test("save text preserves current body, excludes placeholders and active output", () => {
  assert.equal(
    canvasNoteBody({
      kind: "text",
      label: "  # Title\n正文\n",
      result: "stale",
    }),
    "  # Title\n正文\n",
  );
  assert.equal(canvasNoteTitle("  # Title\n正文"), "Title");
  assert.equal(
    canvasNoteBody({ kind: "text", label: "双击开始编辑..." }),
    null,
  );
  assert.equal(
    canvasNoteBody({ kind: "text", label: "x", generationTask: task }),
    null,
  );
  assert.equal(canvasNoteBody({ kind: "noteRef", label: "x" }), null);
  assert.equal(
    canvasNoteBody({
      kind: "aiResult",
      resultKind: "text",
      result: "generated",
    }),
    "generated",
  );
});
test("generated media requires successful provenance and saves exact restored image", () => {
  assert.deepEqual(
    canvasNodeLibraryCandidates({ kind: "image", refMediaUrl: "C:/a.png" }, [
      entry,
    ]),
    [],
  );
  assert.deepEqual(
    canvasNodeLibraryCandidates(
      { kind: "generator", generationTask: task, resultMediaUrl: "C:/a.png" },
      [entry],
    ),
    [],
  );
  const candidates = canvasNodeLibraryCandidates(
    {
      kind: "generator",
      generationTask: completed,
      resultMediaItems: [{ url: "C:/a.png" }, { url: "C:/b.png" }],
    },
    [entry],
  );
  assert.deepEqual(
    candidates.map((x) => x.mediaUrl),
    ["C:/a.png", "C:/b.png"],
  );
  const restored = canvasNodeLibraryCandidates(
    {
      kind: "image",
      sourceGenerationHistoryId: entry.id,
      refMediaUrl: "display:C:/b.png",
    },
    [entry],
    (s) => "display:" + s,
  );
  assert.deepEqual(
    canvasNodeLibraryCandidates(
      {
        kind: "image",
        sourceGenerationHistoryId: entry.id,
        sourceGenerationMediaUrl: "C:/a.png",
        refMediaUrl: "display:C:/other.png",
      },
      [entry],
      (s) => "display:" + s,
    ),
    [],
  );
  assert.deepEqual(
    canvasNodeLibraryCandidates(
      {
        kind: "image",
        generationTask: completed,
        resultMediaUrl: "C:/a.png",
        refMediaUrl: "C:/replacement.png",
      },
      [entry],
    ),
    [],
  );
  assert.equal(restored.length, 1);
  assert.equal(restored[0].mediaUrl, "C:/b.png");
  assert.equal(
    canvasNodeLibraryCandidates(
      {
        kind: "video",
        sourceGenerationTaskId: "v",
        sourceGenerationMediaUrl: "C:/v.mp4",
        refMediaUrl: "C:/v.mp4",
      },
      [],
    )[0].kind,
    "video",
  );
});
test("save gate coalesces repeat clicks, allows changed content and retries failure", async () => {
  const gate = createCanvasSaveGate();
  let calls = 0,
    release!: () => void;
  const pause = new Promise<void>((r) => (release = r));
  const first = gate.run("same", async () => {
    calls++;
    await pause;
    return "id";
  });
  assert.equal(
    (
      await gate.run("same", async () => {
        calls++;
        return "wrong";
      })
    ).state,
    "pending",
  );
  release();
  assert.equal((await first).state, "saved");
  assert.equal(
    (
      await gate.run("same", async () => {
        calls++;
        return "wrong";
      })
    ).state,
    "already-saved",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    gate.run("changed", async () => {
      throw Error("fail");
    }),
  );
  assert.equal((await gate.run("changed", async () => "new")).id, "new");
});
test("text task and history preserve explicit profile and revision; adapter forwards binding", async () => {
  const request = {
    kind: "text" as const,
    prompt: "hello",
    model: "chat",
    references: [],
    textProfileId: "local",
    textProfileRevision: 8,
  };
  const t = createCanvasGenerationTask({
    id: "text",
    sourceNodeId: "n",
    resultNodeId: "n",
    createdAt: "now",
    request,
  });
  const roundtrip = generationTaskFromHistory(
    normalizeGenerationHistory([historyEntryFromTask(t)])[0],
  );
  assert.equal(roundtrip.request.textProfileId, "local");
  assert.equal(roundtrip.request.textProfileRevision, 8);
  let options: any;
  const adapter = createCanvasTextGenerationAdapter(async (_, o) => {
    options = o;
    return { success: true, content: "Result" };
  });
  const result = await adapter.execute(request, {} as any);
  assert.equal(result.ok, true);
  assert.equal(options.textProfileRevision, 8);
  const failure = await createCanvasTextGenerationAdapter(async () => ({
    success: false,
    error_kind: "profile_changed",
  })).execute(request, {} as any);
  assert.equal(failure.ok, false);
  if (!failure.ok) {
    assert.equal(failure.error.retryable, false);
    assert.equal(failure.error.code, "AI_PROFILE_CHANGED");
  }
});
test("four centre rotations return exact source pixels without changing source", () => {
  const source = createCanvas(6, 4),
    ctx = source.getContext("2d");
  ctx.fillStyle = "red";
  ctx.fillRect(0, 0, 3, 2);
  ctx.fillStyle = "blue";
  ctx.fillRect(3, 2, 3, 2);
  let edit = {
    turns: 0,
    flipX: false,
    flipY: false,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    width: 6,
    height: 4,
  };
  for (let i = 0; i < 4; i++) {
    edit = rotateImageEdit(edit);
    const out = renderImageEdit(source, 6, 4, edit, createCanvas);
    assert.equal(out.width, i % 2 === 0 ? 4 : 6);
    assert.equal(out.height, i % 2 === 0 ? 6 : 4);
    if (i === 3)
      assert.deepEqual(
        Buffer.from(out.getContext("2d")!.getImageData(0, 0, 6, 4).data),
        Buffer.from(ctx.getImageData(0, 0, 6, 4).data),
      );
  }
});
test("profile projection ignores credential fields and old catalogs remain legacy", () => {
  const text = readFileSync("src/core/services/canvasMediaProfiles.ts", "utf8");
  const a = text.indexOf("export function projectCanvasMediaProfiles"),
    b = text.indexOf("export function createCanvasMediaProfilesClient", a);
  const code = transformSync(
    text.slice(a, b).replace("export function", "function"),
    { loader: "ts" },
  ).code;
  const project = Function(code + ";return projectCanvasMediaProfiles;")();
  const p = {
    id: "p",
    name: "local",
    baseUrl: "http://127.0.0.1:8317/v1",
    imageModel: "image",
    videoModel: "",
    imageProtocol: "gemini-image",
    videoProtocol: "disabled",
    revision: 1,
    apiKey: "secret",
  };
  const result = project({ version: 1, activeProfileId: "p", profiles: [p] });
  assert.equal(result.profiles[0].textProtocol, "legacy");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.throws(() =>
    project({
      version: 1,
      activeProfileId: "p",
      profiles: [{ ...p, textProtocol: "untrusted" }],
    }),
  );
});
test("image tools stage and send button rules resist content and shell reset", () => {
  const css = readFileSync("src/features/canvas/canvasCreative.css", "utf8"),
    base = readFileSync("src/canvas-spike-scroll.css", "utf8");
  assert.match(
    css,
    /\.canvas-creative-dialog\.canvas-image-tools-dialog\{height:min\(760px,calc\(100dvh - 48px\)\)/,
  );
  assert.match(
    css,
    /\.canvas-image-tools-dialog \.canvas-image-tools-preview canvas\{[^}]*object-position:center/,
  );
  assert.match(
    css,
    /\.canvas-image-tools-dialog fieldset\{[^}]*overflow-y:auto/,
  );
  // (0,2,1) beats verified appShell.css `.react-nav-shell button` (0,1,1).
  assert.match(
    base,
    /\.canvas-editor-root button\.canvas-composer-submit\{background:rgba\(245,245,247,.94\)/,
  );
  assert.match(
    base,
    /\.canvas-editor-root button\.canvas-composer-submit:disabled\{[^}]*--canvas-submit-foreground:#c6c6ce/,
  );
});
test("actual context-save handler creates a new note once and suppresses stale completion", async () => {
  const source = readFileSync("src/CanvasSpike.tsx", "utf8");
  const a = source.indexOf("  const saveNodeContent = useCallback("),
    b = source.indexOf("  const runNodeCommand", a);
  assert.ok(a > 0 && b > a);
  const code = transformSync(source.slice(a, b), { loader: "ts" }).code;
  const notes: any[] = [],
    notices: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  const nodesRef = {
      current: [{ id: "n", data: { kind: "text", label: "# Draft\nBody" } }],
    },
    currentCanvasIdRef = { current: "a" },
    canvasLoadEpochRef = { current: 1 };
  const sourceIdentity = { vaultId: "vault-a" };
  const deps = {
    readActiveKnowledgeWriteSource: () => sourceIdentity,
    useCallback: (fn: any) => fn,
    nodesRef,
    currentCanvasIdRef,
    canvasLoadEpochRef,
    setNodeSaveNotice: (s: string) => notices.push(s),
    nodeSaveGate: { current: createCanvasSaveGate() },
    bridge: {
      createNote: async (input: any) => {
        notes.push(input);
        await pending;
        return { id: "new-note" };
      },
    },
    generationHistory: [],
    resolveCanvasMediaUrl: (s: string) => s,
    canvasNoteBody,
    canvasNoteTitle,
    canvasNodeLibraryCandidates,
  };
  const run = Function(
    ...Object.keys(deps),
    code + ";return saveNodeContent;",
  )(...Object.values(deps));
  const first = run("n", true);
  await run("n", true);
  assert.equal(notes.length, 1);
  assert.deepEqual(notes[0], { title: "Draft", contentText: "# Draft\nBody" });
  nodesRef.current[0].data.label = "Changed";
  canvasLoadEpochRef.current++;
  release();
  await first;
  assert.deepEqual(notices, ["正在保存…"]);
});
