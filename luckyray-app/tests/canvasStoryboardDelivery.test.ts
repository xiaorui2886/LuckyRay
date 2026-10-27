import test from "node:test";
import assert from "node:assert/strict";
import { defaultShot } from "../src/core/canvas/storyboard";
import { buildStoryboardDeliveryPlan, prepareStoryboardDelivery, serializeStoryboardScript } from "../src/core/canvas/storyboardDelivery";
import { crc32, DELIVERY_LIMITS } from "../src/core/canvas/mediaDelivery";
const board: any = { id: "board", data: { kind: "group", storyboard: { version: 1 }, label: "Film" } };
const shot = (id: string, order = 0, url = "https://assets.test/chosen?secret=private"): any => ({ id, parentId: "board", data: {
  kind: "generator", generationKind: "image", resultMediaUrl: "https://assets.test/latest",
  storyboardShot: { ...defaultShot(order), title: id, description: '<script>"&</script>', dialogue: "Hello\nworld", chosenResult: { key: "private-key", kind: "image", url, thumbnailUrl: "https://assets.test/poster?token=secret" } },
} });
const png = new Uint8Array([137,80,78,71,13,10,26,10]);
function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: {name: string; bytes: Uint8Array}[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true), nameLength = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(bytes.slice(at + 30, at + 30 + nameLength));
    const data = bytes.slice(at + 30 + nameLength, at + 30 + nameLength + size);
    assert.equal(view.getUint32(at + 14, true), crc32(data));
    result.push({ name, bytes: data });
    at += 30 + nameLength + size;
  }
  assert.equal(view.getUint32(at, true), 0x02014b50);
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(bytes.length - 12, true), result.length);
  return result;
}
test("ordered explicit choices produce one file per shot, readable script, safe manifest and valid ZIP", async (t) => {
  const requested: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => { requested.push(url); return new Response(png); });
  const nodes = [board, shot("second", 1), shot("first", 0)];
  const plan = buildStoryboardDeliveryPlan(nodes, "board");
  nodes[2].data.storyboardShot.title = "Changed later";
  nodes[2].data.storyboardShot.chosenResult.url = "https://assets.test/mutated";
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.shots) && Object.isFrozen(plan.shots[0].script));
  const progress: number[] = [];
  const files = unzip(await prepareStoryboardDelivery(plan, new AbortController().signal, (done) => progress.push(done)));
  assert.deepEqual(files.map((f) => f.name), ["001-first.png", "002-second.png", "manifest.json"]);
  assert.deepEqual(progress, [1,2]);
  assert.deepEqual(requested, ["https://assets.test/chosen?secret=private", "https://assets.test/chosen?secret=private"]);
  const text = new TextDecoder().decode(files[2].bytes);
  assert.ok(!/https:|secret|private-key|chosenResult|thumbnailUrl/.test(text));
  const manifest = JSON.parse(text);
  assert.deepEqual(manifest.shots.map((s: any) => [s.id, s.start, s.end]), [["first",0,5],["second",5,10]]);
  assert.equal(manifest.shots[0].script.description, '<script>"&</script>');
  assert.ok(manifest.screenplay.includes("Hello\nworld"));
  assert.ok(serializeStoryboardScript(plan).includes("001 — first"));
});
test("script supports 64 shots; ZIP retains existing 50 media limit", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(png));
  for (const count of [50,51,64]) {
    const plan = buildStoryboardDeliveryPlan([board,...Array.from({length:count}, (_,i) => shot(`shot${i}`,i))], "board");
    assert.equal(plan.overflow, count > DELIVERY_LIMITS.files);
    assert.equal(plan.shots.length, count);
    assert.ok(serializeStoryboardScript(plan).includes(`Shots: ${count}`));
    if (count === 50) assert.equal(unzip(await prepareStoryboardDelivery(plan,new AbortController().signal)).length,51);
    else await assert.rejects(prepareStoryboardDelivery(plan,new AbortController().signal), /storyboard-not-ready/);
  }
  assert.throws(() => buildStoryboardDeliveryPlan([board,...Array.from({length:65},(_,i)=>shot(String(i),i))], "board"), /too-many-shots/);
});
test("empty, duplicate and unconfirmed selections fail closed while script remains available", async () => {
  const a = shot("a"); delete a.data.storyboardShot.chosenResult;
  for (const nodes of [[board], [board,a], [board,a,shot("b",1)]]) {
    const plan = buildStoryboardDeliveryPlan(nodes,"board");
    assert.equal(plan.canExport,false);
    await assert.rejects(prepareStoryboardDelivery(plan,new AbortController().signal), /storyboard-not-ready/);
    assert.ok(serializeStoryboardScript(plan));
  }
  assert.deepEqual(buildStoryboardDeliveryPlan([board,a],"board").unconfirmedShotIds,["a"]);
  assert.throws(()=>buildStoryboardDeliveryPlan([board,shot("a"),shot("a")],"board"), /duplicate-shot-id/);
});
test("abort before, during and after reads never produces an archive", async (t) => {
  const plan = buildStoryboardDeliveryPlan([board,shot("a")],"board");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(prepareStoryboardDelivery(plan,controller.signal), { name:"AbortError" });
  const during = new AbortController();
  t.mock.method(globalThis,"fetch",async()=>{ during.abort(); return new Response(png); });
  await assert.rejects(prepareStoryboardDelivery(plan,during.signal), {name:"AbortError"});
  t.mock.restoreAll();
  t.mock.method(globalThis,"fetch",async()=>new Response(png));
  const after = new AbortController();
  await assert.rejects(prepareStoryboardDelivery(plan,after.signal,()=>after.abort()), {name:"AbortError"});
});
test("read errors, empty media, unrecognized bytes and oversized response never silently omit shots", async (t) => {
  const plan = buildStoryboardDeliveryPlan([board,shot("a"),shot("b",1)],"board");
  for (const response of [new Response(null,{status:404}),new Response(new Uint8Array()),new Response("oops"),new Response(png,{headers:{"content-length":String(DELIVERY_LIMITS.eachBytes+1)}})]) {
    let reads = 0;
    t.mock.method(globalThis,"fetch",async()=> ++reads === 1 ? new Response(png) : response);
    await assert.rejects(prepareStoryboardDelivery(plan,new AbortController().signal), /media-read-failed|empty-media|unrecognized-media|media-too-large/);
    assert.equal(reads,2);
    t.mock.restoreAll();
  }
});
test("native source resolution is applied only when reading and never leaks to manifest", async (t) => {
  const source = "C:\\private\\chosen.png";
  const plan = buildStoryboardDeliveryPlan([board,shot("native",0,source)],"board");
  const requested: string[] = [];
  t.mock.method(globalThis,"fetch", async (url: string) => { requested.push(url); return new Response(png); });
  const zip = await prepareStoryboardDelivery(plan,new AbortController().signal,undefined,(raw)=> {
    assert.equal(raw,source); return "https://asset.localhost/private/chosen.png";
  });
  assert.deepEqual(requested,["https://asset.localhost/private/chosen.png"]);
  const manifest = new TextDecoder().decode(unzip(zip).at(-1)!.bytes);
  assert.ok(!manifest.includes("private") && !manifest.includes("asset.localhost"));
});
test("mixed valid and invalid shot records never produce a partial delivery plan", () => {
  for (const mutate of [
    (node: any) => { node.data.storyboardShot.chosenResult.url = ""; },
    (node: any) => { node.data.storyboardShot.durationSeconds = -1; },
    (node: any) => { node.data.storyboardShot = null; },
    (node: any) => { node.data.kind = "text"; },
  ]) {
    const damaged = shot("damaged",1); mutate(damaged);
    assert.throws(() => buildStoryboardDeliveryPlan([board,shot("valid"),damaged],"board"), /invalid-storyboard-shot/);
    damaged.parentId = "another-board";
    assert.equal(buildStoryboardDeliveryPlan([board,shot("valid"),damaged],"board").shots.length,1);
  }
});
test("aggregate cap includes manifest bytes, not just media", async (t) => {
  const old = DELIVERY_LIMITS.totalBytes;
  t.after(() => { DELIVERY_LIMITS.totalBytes = old; });
  DELIVERY_LIMITS.totalBytes = png.length;
  t.mock.method(globalThis,"fetch",async()=>new Response(png));
  const plan = buildStoryboardDeliveryPlan([board,shot("a")],"board");
  await assert.rejects(prepareStoryboardDelivery(plan,new AbortController().signal), /delivery-too-large/);
});
