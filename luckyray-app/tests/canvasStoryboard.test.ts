import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import * as story from "../src/core/canvas/storyboard";
import * as candidates from "../src/core/canvas/storyboardCandidates";
import * as script from "../src/core/canvas/storyboardScript";
import { reusableStoryboardDraft } from "../src/core/canvas/storyboardImport";
import { buildStoryboardDeliveryPlan, prepareStoryboardDelivery } from "../src/core/canvas/storyboardDelivery";
import { captureWorkflow } from "../src/core/canvas/workflowTemplates";
import { createCanvasHistorySnapshot } from "../src/features/canvas/canvasHistory";
import { sanitizeCanvasNodesForPersistence } from "../src/features/canvas/canvasPersistence";
import { normalizeCanvasNodeCapabilityData } from "../src/core/canvas/nodeCapabilities";
import {
  canvasNodeSize,
  attachCanvasNodesToGroup,
  ungroupCanvasNodes,
} from "../src/core/canvas/canvasArrangement";
const board: any = {
  id: "b",
  type: "group",
  position: { x: 20, y: 30 },
  data: { kind: "group", label: "Story", storyboard: { version: 1 } },
};
const shot = (id: string, order = 0): any => ({
  id,
  type: "spike",
  parentId: "b",
  position: { x: 40, y: 50 },
  data: {
    kind: "generator",
    generationKind: "image",
    generationPrompt: "Keep prompt",
    storyboardShot: story.defaultShot(order),
  },
});

test("timeline is derived from stable logical order, not coordinates; edits are immutable", () => {
  const a = shot("a", 1),
    b = shot("z", 0),
    c = shot("c", 0),
    nodes = [board, a, b, c];
  assert.deepEqual(
    story.storyboardShots(nodes, "b").map((n) => n.id),
    ["z", "c", "a"],
  );
  const next = story.patchStoryboardShot(nodes, "b", "a", {
    durationSeconds: 2.3,
    action: "Pan",
    dialogue: "Hello",
  });
  assert.equal(a.data.storyboardShot.durationSeconds, 5);
  assert.deepEqual(story.storyboardTimeline(next, "b"), {
    shots: [
      { id: "z", number: 1, start: 0, end: 5 },
      { id: "c", number: 2, start: 5, end: 10 },
      { id: "a", number: 3, start: 10, end: 12.3 },
    ],
    total: 12.3,
  });
  assert.equal(next[1].data.generationPrompt, "Keep prompt");
  const moved = story.moveStoryboardShot(next, "b", "a", -1);
  assert.deepEqual(
    story.storyboardShots(moved, "b").map((n) => n.id),
    ["z", "a", "c"],
  );
  assert.deepEqual(
    moved.map((n) => n.position),
    nodes.map((n) => n.position),
  );
  assert.deepEqual(story.moveStoryboardShot(next, "b", "z", -1), next);
});
test("malformed, foreign and detached shots do not enter a board; mutations validate", () => {
  const n = shot("a");
  for (const patch of [
    { durationSeconds: NaN },
    { durationSeconds: 0 },
    { title: "x".repeat(101) },
    { framing: "secret" },
    { order: 50 },
  ])
    assert.throws(() =>
      story.patchStoryboardShot([board, n], "b", "a", patch as any),
    );
  assert.throws(() =>
    story.patchStoryboardShot([board, n], "wrong", "a", { title: "x" }),
  );
  assert.deepEqual(story.storyboardShots([n], "b"), []);
  const detached = { ...n, parentId: undefined };
  assert.deepEqual(story.storyboardShots([board, detached], "b"), []);
  assert.equal(story.validShot({ ...story.defaultShot(0), version: 3 }), false);
  assert.equal(story.canBeShot({ id: "text", data: { kind: "text" } }), false);
});
test("native persistence/history retain shot notes; portable export rejects rather than drops", () => {
  const a = shot("a");
  a.data.storyboardShot.dialogue = "Line 1\nLine 2";
  const snapshot = createCanvasHistorySnapshot({
    canvasId: "c",
    nodes: [board, a],
    edges: [],
    generationHistory: [],
  });
  const saved = JSON.parse(
    JSON.stringify(sanitizeCanvasNodesForPersistence([board, a])),
  );
  assert.deepEqual(
    story.storyboardTimeline(saved, "b"),
    story.storyboardTimeline([board, a], "b"),
  );
  a.data.storyboardShot.dialogue = "New";
  assert.equal(
    snapshot.nodes[1].data.storyboardShot.dialogue,
    "Line 1\nLine 2",
  );
  assert.throws(
    () => captureWorkflow([board, a], [], ["b"], "test"),
    /storyboard-unsupported/,
  );
  const detached = ungroupCanvasNodes([board, a], ["b"]);
  assert.equal(detached[0].parentId, undefined);
  assert.equal(detached[0].data.storyboardShot.dialogue, "New");
  assert.throws(
    () => captureWorkflow(detached, [], ["a"], "test"),
    /storyboard-unsupported/,
  );
});
test("preview prefers still images and never returns a movie for video nodes", () => {
  const a = shot("a");
  a.data.refMediaUrl = "a.png";
  assert.equal(story.shotPreview(a), "a.png");
  a.data.generationKind = "video";
  a.data.refMediaUrl = "movie.mp4";
  assert.equal(story.shotPreview(a), "");
  a.data.refThumbnailUrl = "poster.jpg";
  assert.equal(story.shotPreview(a), "poster.jpg");
});
function rootHarness(initial: any[] = []) {
  const source = readFileSync("src/CanvasSpike.tsx", "utf8"),
    a = source.indexOf("  const commitStoryboardNodes = useCallback("),
    b = source.indexOf("  const deliveryItems=useMemo(", a);
  assert.ok(a > 0 && b > a);
  const code = transformSync(source.slice(a, b), { loader: "ts" }).code;
  let seed = 0,
    dirty = 0;
  const history: any[] = [];
  const context: any = {
    ...story,
    ...candidates,
    ...script,
    reusableStoryboardDraft,
    buildStoryboardDeliveryPlan,
    prepareStoryboardDelivery,
    edgesRef: { current: [] },
    generationHistoryRef: { current: [] },
    canvasLoadEpochRef: { current: 1 },
    storyboardExportController: { current: null },
    exportState: null,
    exportStates: [] as any[],
    setStoryboardExportState: (value: any) => {
      context.exportState = typeof value === 'function' ? value(context.exportState) : value;
      context.exportStates.push(context.exportState);
    },
    saveCalls: [] as any[],
    save: async (options: any) => { context.saveCalls.push(options); return '/tmp/test-storyboard.zip'; },
    writes: [] as any[],
    writeFile: async (path: string, bytes: Uint8Array) => { context.writes.push({path,bytes}); },
    resolveCanvasMediaUrl: (url: string) => url,
    getIncomingGenerationInputs: () => [],
    activeMediaProfile: undefined,
    canvasNodeSize,
    attachCanvasNodesToGroup,
    useCallback: (fn: any) => fn,
    loadingCanvas: false,
    currentCanvasId: "c",
    currentCanvasIdRef: { current: "c" },
    nodesRef: { current: initial },
    selectedNodeIds: [],
    locale: "zh-CN",
    saveErrors: [] as any[],
    setSaveError: (error: any) => context.saveErrors.push(error),
    generationTaskSnapshotsRef: { current: new Map() },
    generationTaskCanvasIdsRef: { current: new Map() },
    submissions: [] as string[],
    submitGenerationFromNode: (id: string) => context.submissions.push(id),
    genId: () => `id-${++seed}`,
    getViewportCreatePosition: () => ({ x: 100, y: 200 }),
    normalizeCanvasNodeCapabilityData,
    commitHistory: () =>
      history.push(structuredClone(context.nodesRef.current)),
    markDirty: () => dirty++,
    setNodes: () => {},
    reactFlowInstance: { getNodesBounds: () => ({ x: 170, y: 290 }) },
  };
  const actions = () =>
    Function(
      ...Object.keys(context),
      code +
        ";return {createStoryboard,addStoryboardShot,editStoryboardShot,reorderStoryboardShot,removeStoryboardShot,renameStoryboard,unmarkStoryboard,editStoryboardPrompt,prepareStoryboardPrompt,generateStoryboardShot,importStoryboardScript,getStoryboardCandidates,chooseStoryboardResult,clearStoryboardResult,exportStoryboardBoard};",
    )(...Object.values(context));
  return { context, actions, history, dirty: () => dirty };
}
test("actual root creates one transactional board with live generator, edits and adds without generation", () => {
  const h = rootHarness();
  const id = h.actions().createStoryboard("Scenes", false);
  assert.equal(h.history.length, 1);
  assert.equal(h.context.nodesRef.current.length, 2);
  assert.ok(h.context.nodesRef.current[0].style.width >= 430 + 84);
  assert.equal(story.storyboardShots(h.context.nodesRef.current, id).length, 1);
  const first = story.storyboardShots(h.context.nodesRef.current, id)[0];
  h.actions().editStoryboardShot(id, first.id, {
    action: "Wide opening",
    durationSeconds: 3,
  });
  h.actions().addStoryboardShot(id);
  assert.equal(story.storyboardShots(h.context.nodesRef.current, id).length, 2);
  assert.equal(h.dirty(), 3);
  assert.equal(first.data.generationTask, undefined);
  assert.equal(
    story.storyboardShots(h.context.nodesRef.current, id)[0].data
      .generationPrompt,
    "",
  );
  h.actions().removeStoryboardShot(id, first.id);
  const kept = h.context.nodesRef.current.find((n: any) => n.id === first.id);
  assert.equal(kept.parentId, undefined);
  assert.equal(
    h.context.nodesRef.current.find((n: any) => n.id === id).data
      .groupMemberCount,
    1,
  );
  assert.equal(kept.data.storyboardShot.action, "Wide opening");
  assert.deepEqual(kept.position, { x: 170, y: 290 });
  h.actions().unmarkStoryboard(id);
  assert.equal(h.context.nodesRef.current.length, 3);
  assert.deepEqual(story.storyboardShots(h.context.nodesRef.current, id), []);
});
test("actual root selection conversion preserves original coordinates/content and rejects invalid selection", () => {
  const image: any = {
      id: "i",
      position: { x: 30, y: 40 },
      data: { kind: "image", refMediaUrl: "original.png" },
    },
    h = rootHarness([image]);
  h.context.selectedNodeIds = ["i"];
  const id = h.actions().createStoryboard("Board", true);
  const nodes = h.context.nodesRef.current,
    group = nodes.find((n: any) => n.id === id),
    member = nodes.find((n: any) => n.id === "i");
  assert.equal(member.position.x + group.position.x, 30);
  assert.equal(member.data.refMediaUrl, "original.png");
  assert.equal(image.parentId, undefined);
  h.context.selectedNodeIds = ["i"];
  assert.throws(() => h.actions().createStoryboard("Other", true));
  h.context.currentCanvasIdRef.current = "other";
  assert.throws(() => h.actions().addStoryboardShot(id), /canvas-changed/);
  assert.equal(h.history.length, 1);
});
test("actual root board limit fails without a partial edit and duplicate metadata edits are isolated", () => {
  const children = Array.from({ length: 64 }, (_, i) => shot("s" + i, i)),
    h = rootHarness([board, ...children]);
  assert.throws(() => h.actions().addStoryboardShot("b"), /too-many-shots/);
  assert.equal(h.history.length, 0);
  const dupe = { ...children[0], id: "dupe", data: { ...children[0].data } };
  const next = story.patchStoryboardShot(
    [board, children[0], dupe],
    "b",
    "dupe",
    { title: "copy" },
  );
  assert.equal(next[1].data.storyboardShot.title, "");
  assert.equal(next[2].data.storyboardShot.title, "copy");
});

test("R8 old shot records stay valid; title, dialogue and plan timing never leak into prepared prompts", () => {
  const old = story.defaultShot(0);
  delete old.description;
  assert.equal(story.validShot(old), true);
  const n = shot("a");
  n.data.storyboardShot = {
    ...old,
    title: "Private title",
    dialogue: "Say this",
    durationSeconds: 9,
    description: "Rainy street",
    action: "Slow pan",
    framing: "wide",
  };
  const prompt = story.buildStoryboardPrompt(n);
  assert.match(prompt, /Rainy street/);
  assert.match(prompt, /Slow pan/);
  assert.match(prompt, /远景/);
  assert.doesNotMatch(prompt, /Private title|Say this|9/);
  n.data.storyboardShot.description = "";
  n.data.storyboardShot.action = "";
  assert.equal(story.buildStoryboardPrompt(n), "");
  assert.throws(() =>
    story.patchStoryboardShot([board, n], "b", "a", {
      description: "x".repeat(4001),
    }),
  );
});
test("R8 actual prepare reads most recent notes; generation only follows explicit valid submission", () => {
  const n = shot("a"),
    h = rootHarness([board, n]);
  h.actions().editStoryboardShot("b", "a", {
    description: "Latest visual",
    action: "Track subject",
    dialogue: "Keep this line",
    title: "Scene title",
  });
  const prompt = h.actions().prepareStoryboardPrompt("b", "a");
  assert.match(prompt, /Latest visual/);
  assert.equal(h.context.submissions.length, 0);
  assert.equal(
    h.context.nodesRef.current[1].data.generationPrompt,
    "Keep prompt",
  );
  h.actions().editStoryboardPrompt("b", "a", prompt);
  const saved = h.context.nodesRef.current[1];
  assert.equal(saved.data.storyboardShot.title, "Scene title");
  assert.equal(saved.data.storyboardShot.dialogue, "Keep this line");
  h.actions().generateStoryboardShot("b", "a");
  assert.deepEqual(h.context.submissions, ["a"]);
  h.context.generationTaskSnapshotsRef.current.set("queued-task", {
    id: "queued-task",
    sourceNodeId: "a",
    status: "queued",
  });
  h.context.generationTaskCanvasIdsRef.current.set("queued-task", "c");
  assert.throws(
    () => h.actions().generateStoryboardShot("b", "a"),
    /shot-not-ready/,
  );
  h.context.generationTaskSnapshotsRef.current.clear();
  h.context.nodesRef.current = story.patchStoryboardPrompt(
    h.context.nodesRef.current,
    "b",
    "a",
    "",
  );
  assert.throws(
    () => h.actions().generateStoryboardShot("b", "a"),
    /shot-not-ready/,
  );
  h.context.nodesRef.current = [
    board,
    {
      ...saved,
      data: { ...saved.data, generationTask: { status: "running" } },
    },
  ];
  assert.throws(
    () => h.actions().generateStoryboardShot("b", "a"),
    /shot-not-ready/,
  );
  assert.equal(h.context.submissions.length, 1);
});
test("R8 explicit prompt replacement preserves all existing metadata, models, outputs and references", () => {
  const n = shot("a");
  n.data.generationModel = "keep-model";
  n.data.resultMediaUrl = "existing.png";
  n.data.generationReferences = [{ id: "ref" }];
  const next = story.patchStoryboardPrompt(
    [board, n],
    "b",
    "a",
    "New actual prompt",
  );
  assert.equal(n.data.generationPrompt, "Keep prompt");
  assert.deepEqual(
    { ...next[1].data, generationPrompt: "Keep prompt" },
    n.data,
  );
  assert.throws(() =>
    story.patchStoryboardPrompt([board, n], "wrong", "a", "bad"),
  );
  assert.throws(() =>
    story.patchStoryboardPrompt(
      [board, { ...n, data: { ...n.data, kind: "image" } }],
      "b",
      "a",
      "bad",
    ),
  );
});
test("R8 navigation resolves owner and restores last board/shot, without transferring position across canvases", () => {
  const b2 = { ...board, id: "b2" },
    n = shot("a"),
    n2 = { ...shot("z"), parentId: "b2" },
    nodes = [board, n, b2, n2];
  assert.equal(story.storyboardOwner(nodes, "a"), "b");
  assert.equal(story.storyboardOwner(nodes, "b2"), "b2");
  assert.equal(
    story.storyboardOwner([{ ...n, parentId: undefined }], "a"),
    undefined,
  );
  assert.deepEqual(
    story.resolveStoryboardPosition(nodes, undefined, {
      boardId: "b2",
      shotId: "z",
      mode: "script",
    }),
    { boardId: "b2", shotId: "z", mode: "script" },
  );
  assert.deepEqual(
    story.resolveStoryboardPosition(nodes, "a", {
      boardId: "b2",
      shotId: "z",
      mode: "script",
    }),
    { boardId: "b", shotId: "a", mode: "board" },
  );
  assert.equal(
    story.resolveStoryboardPosition([board, n], undefined, {
      boardId: "gone",
      shotId: "z",
    }).boardId,
    "b",
  );
  const source = readFileSync("src/CanvasSpike.tsx", "utf8");
  assert.match(
    source,
    /storyboardPosition\?\.canvasId===currentCanvasId\?storyboardPosition:undefined/,
  );
  assert.match(source, /nodeUi\.storyboardMemberIds\.has\(id\)/);
});

const importedScript = () => {
  const sourceText = '镜头 1：秘密标题\n画面：晨光中的森林\n动作：镜头推进\n台词：不要泄露这句对白\n时长：3秒\n\n镜头 2：结尾\n画面：夜色湖面';
  return {sourceText, shots: script.parseStoryboardScript(sourceText).shots};
};
test('R6 actual import reuses untouched initial identity in one undo transaction and prepares only visuals', () => {
  const original = shot('canonical'); original.data.generationPrompt = '';
  const h = rootHarness([structuredClone(board), original]);
  const before = structuredClone(h.context.nodesRef.current);
  h.actions().importStoryboardScript('b', importedScript());
  const result = story.storyboardShots(h.context.nodesRef.current, 'b');
  assert.equal(result.length, 2); assert.equal(result[0].id, 'canonical');
  assert.equal(h.history.length, 1); assert.deepEqual(h.history[0], before); assert.equal(h.dirty(), 1);
  assert.equal(h.context.nodesRef.current[0].data.storyboard.sourceScript, importedScript().sourceText);
  assert.equal(result[0].data.storyboardShot.dialogue, '不要泄露这句对白');
  assert.match(result[0].data.generationPrompt, /晨光中的森林/);
  assert.match(result[0].data.generationPrompt, /镜头推进/);
  assert.doesNotMatch(result[0].data.generationPrompt, /秘密标题|不要泄露|3秒/);
  assert.deepEqual(h.context.submissions, []); assert.deepEqual(h.context.writes, []);
});
test('R6 actual import appends instead of replacing meaningful drafts, references, edges or results', () => {
  for (const patch of [
    {generationPrompt:'Keep prompt'}, {generationReferences:[{id:'ref'}]},
    {resultMediaUrl:'old.png'}, {storyboardShot:{...story.defaultShot(0),dialogue:'Keep dialogue'}},
  ]) {
    const original = shot('canonical'); original.data.generationPrompt = ''; Object.assign(original.data,patch);
    const h = rootHarness([structuredClone(board), original]);
    const before = structuredClone(original);
    h.actions().importStoryboardScript('b', importedScript());
    assert.deepEqual(h.context.nodesRef.current.find((n:any)=>n.id==='canonical'), before);
    assert.equal(story.storyboardShots(h.context.nodesRef.current,'b').length,3);
    assert.equal(h.history.length,1);
  }
  const original = shot('canonical'); original.data.generationPrompt='';
  const h=rootHarness([structuredClone(board),original]); h.context.edgesRef.current=[{source:'ref',target:'canonical'}];
  h.actions().importStoryboardScript('b',importedScript());
  assert.equal(story.storyboardShots(h.context.nodesRef.current,'b').length,3);
  assert.deepEqual(h.context.edgesRef.current,[{source:'ref',target:'canonical'}]);
});
test('R6 actual import capacity and canvas-change failures are atomic', () => {
  for (const changed of [false,true]) {
    const initial=[structuredClone(board),...Array.from({length:changed?1:63},(_,i)=>shot('s'+i,i))];
    const h=rootHarness(initial), before=structuredClone(initial);
    if(changed)h.context.currentCanvasIdRef.current='other';
    assert.throws(()=>h.actions().importStoryboardScript('b',importedScript()), changed?/canvas-changed/:/shot-limit/);
    assert.deepEqual(h.context.nodesRef.current,before); assert.equal(h.history.length,0);
    assert.equal(h.dirty(),0); assert.deepEqual(h.context.writes,[]);
  }
});
test('R6 actual adoption touches only choice metadata, keeps history and originals, and is undoable', () => {
  const original=shot('canonical'); original.data.resultMediaUrl='accepted.png';
  original.data.generationTask={id:'old',sourceNodeId:'canonical',resultNodeId:'canonical',status:'succeeded'};
  original.data.generationReferences=[{id:'ref'}]; original.data.storyboardShot.dialogue='Keep line';
  const h=rootHarness([structuredClone(board),original]);
  h.context.generationHistoryRef.current=[{id:'history:new',taskId:'new',parentTaskId:'old',sourceNodeId:'fork',resultNodeId:'fork',kind:'image',status:'succeeded',outputMediaUrl:'candidate.png'}];
  const before=structuredClone(h.context.nodesRef.current), historyBefore=structuredClone(h.context.generationHistoryRef.current);
  const candidate=h.actions().getStoryboardCandidates('b','canonical').candidates.find((c:any)=>c.url==='candidate.png');
  h.actions().chooseStoryboardResult('b','canonical',candidate.key);
  const next=h.context.nodesRef.current[1], {chosenResult,...meta}=next.data.storyboardShot;
  assert.equal(chosenResult.url,'candidate.png'); assert.deepEqual(meta,original.data.storyboardShot);
  assert.deepEqual({...next.data,storyboardShot:meta}, original.data);
  assert.deepEqual(h.context.generationHistoryRef.current,historyBefore); assert.deepEqual(h.history,[before]);
  assert.deepEqual(h.context.submissions,[]);
  h.actions().clearStoryboardResult('b','canonical'); assert.deepEqual(h.context.nodesRef.current,before);
  assert.equal(h.history.length,2);
});
test('R6 actual generate rejects busy descendants without clearing error; ready submission clears old error', () => {
  const original=shot('canonical'); original.data.generationTask={id:'old',sourceNodeId:'canonical',status:'succeeded'};
  const h=rootHarness([structuredClone(board),original]);
  h.context.generationHistoryRef.current=[{id:'history:new',taskId:'new',parentTaskId:'old',sourceNodeId:'fork',resultNodeId:'fork',kind:'image',status:'running'}];
  assert.throws(()=>h.actions().generateStoryboardShot('b','canonical'),/shot-not-ready/);
  assert.deepEqual(h.context.saveErrors,[]); assert.deepEqual(h.context.submissions,[]);
  h.context.generationHistoryRef.current[0].status='failed';
  h.actions().generateStoryboardShot('b','canonical');
  assert.deepEqual(h.context.saveErrors,[null]); assert.deepEqual(h.context.submissions,['canonical']);
});
function exportHarness() {
  const node=shot('canonical');
  node.data.storyboardShot.chosenResult={key:'choice',kind:'image',url:'data:image/png;base64,iVBORw0KGgo='};
  return rootHarness([structuredClone(board),node]);
}
const deferred = <T,>() => { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>resolve=r); return {promise,resolve}; };
test('R6 actual ZIP export reads selected snapshot and writes exactly once under duplicate clicks', async () => {
  const h=exportHarness(), gate=deferred<string>();
  h.context.save=async(options:any)=>{h.context.saveCalls.push(options);return gate.promise;};
  const actions=h.actions(), first=actions.exportStoryboardBoard('b');
  await actions.exportStoryboardBoard('b');
  // Wait until the real media reader and ZIP preparation reach the save dialog.
  for(let i=0;!h.context.saveCalls.length&&i<100;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(h.context.saveCalls.length,1); assert.equal(h.context.writes.length,0);
  gate.resolve('/tmp/chosen.zip'); await first;
  assert.equal(h.context.writes.length,1); assert.equal(h.context.writes[0].path,'/tmp/chosen.zip');
  assert.deepEqual([...h.context.writes[0].bytes.slice(0,4)],[80,75,3,4]);
  assert.match(h.context.exportState.notice,/已保存/); assert.equal(h.context.exportState.busy,false);
  assert.equal(h.context.storyboardExportController.current,null);
});
test('R6 actual ZIP export cancellation, switched canvas, read failure and write failure never claim success', async () => {
  for(const scenario of ['cancel','canvas','epoch','read','write']) {
    const h=exportHarness();
    if(scenario==='read')h.context.prepareStoryboardDelivery=async()=>{throw Error('media-read-failed');};
    h.context.save=async(options:any)=>{
      h.context.saveCalls.push(options);
      if(scenario==='canvas')h.context.currentCanvasIdRef.current='other';
      if(scenario==='epoch')h.context.canvasLoadEpochRef.current++;
      return scenario==='cancel'?null:'/tmp/export.zip';
    };
    if(scenario==='write')h.context.writeFile=async()=>{throw Error('disk-full');};
    await h.actions().exportStoryboardBoard('b');
    assert.equal(h.context.writes.length,0,scenario);
    assert.ok(h.context.exportStates.every((s:any)=>!s?.notice?.includes('已保存')),scenario);
    assert.equal(h.context.storyboardExportController.current,null,scenario);
    assert.equal(h.context.exportState.busy,false,scenario);
    if(scenario==='cancel')assert.match(h.context.exportState.notice,/取消/);
    if(scenario==='read'||scenario==='write')assert.match(h.context.exportState.error,/未完成/);
    if(scenario==='read')assert.equal(h.context.saveCalls.length,0);
  }
});
test('R6 actual ZIP export abandons stale preparation before opening a file dialog', async () => {
  for(const scenario of ['canvas','epoch','removed','abort']) {
    const h=exportHarness(), gate=deferred<Uint8Array>();
    h.context.prepareStoryboardDelivery=async()=>gate.promise;
    const pending=h.actions().exportStoryboardBoard('b');
    if(scenario==='canvas')h.context.currentCanvasIdRef.current='other';
    if(scenario==='epoch')h.context.canvasLoadEpochRef.current++;
    if(scenario==='removed')h.context.nodesRef.current=[];
    if(scenario==='abort')h.context.storyboardExportController.current.abort();
    gate.resolve(new Uint8Array([80,75])); await pending;
    assert.equal(h.context.saveCalls.length,0,scenario); assert.equal(h.context.writes.length,0,scenario);
    assert.ok(h.context.exportStates.every((s:any)=>!s?.notice?.includes('已保存')),scenario);
    assert.equal(h.context.storyboardExportController.current,null);
  }
});
test('R6 actual ZIP export captures immutable selection before asynchronous preparation', async () => {
  const h=exportHarness(), gate=deferred<Uint8Array>(); let captured:any;
  h.context.prepareStoryboardDelivery=async(plan:any)=>{captured=plan;return gate.promise;};
  const pending=h.actions().exportStoryboardBoard('b');
  h.context.nodesRef.current[1].data.storyboardShot.chosenResult.url='new-choice.png';
  h.context.nodesRef.current[1].data.storyboardShot.dialogue='New script';
  assert.equal(captured.shots[0].media.source,'data:image/png;base64,iVBORw0KGgo=');
  assert.equal(captured.shots[0].script.dialogue,'');
  gate.resolve(new Uint8Array([80,75])); await pending;
  assert.equal(h.context.writes.length,1);
});
