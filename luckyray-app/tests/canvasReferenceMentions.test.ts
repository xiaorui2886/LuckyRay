import test from "node:test";
import assert from "node:assert/strict";
import type { ReferenceEntry } from "../src/core/canvas/referencePlan.ts";
import { encodeReferenceMention, parseReferenceMentions, referenceMentionLabels, resolveReferenceMentions, ReferenceMentionError } from "../src/core/canvas/referenceMentions.ts";
const entry = (key: string, kind = "image", role: ReferenceEntry["role"] = "reference"): ReferenceEntry => ({ key, source: "connected", role, reference: { id: "shared-source", label: "Shared", kind, mediaUrl: "https://fixture.invalid/media" } });

test("ordered kind labels renumber while token identity stays pinned", () => {
  const a = entry("edge:a"), b = entry("edge:b"), t = entry("text", "text"), v = entry("video", "video");
  const value = `Use ${encodeReferenceMention(a.key)} then ${encodeReferenceMention(b.key)}.`;
  assert.equal(resolveReferenceMentions(value, [a, t, b, v]).prompt, "Use @图1 then @图2.");
  const moved = resolveReferenceMentions(value, [b, t, a, v]);
  assert.equal(moved.prompt, "Use @图2 then @图1.");
  assert.equal(moved.mentions[0].entry, a);
  assert.deepEqual([...referenceMentionLabels([b, t, a, v]).values()], ["@图1", "@文本1", "@图2", "@视频1"]);
});

test("repeated mentions preserve occurrence and exact same-id different-role source", () => {
  const first = entry("edge:first", "image", "firstFrame"), last = entry("edge:last", "image", "lastFrame");
  const value = `${encodeReferenceMention(last.key)} / ${encodeReferenceMention(first.key)} / ${encodeReferenceMention(last.key)}`;
  const resolved = resolveReferenceMentions(value, [first, last]);
  assert.equal(resolved.prompt, "@图2 / @图1 / @图2");
  assert.deepEqual(resolved.mentions.map(({ entry }) => entry.role), ["lastFrame", "firstFrame", "lastFrame"]);
});

test("removed reference fails explicitly instead of mapping to the new occupant", () => {
  const value = encodeReferenceMention("removed-edge");
  assert.throws(() => resolveReferenceMentions(value, [entry("replacement")]), (error: unknown) => error instanceof ReferenceMentionError && error.reason === "missing" && error.key === "removed-edge");
  assert.throws(() => resolveReferenceMentions(encodeReferenceMention("bad"), [{ ...entry("bad"), issue: "missing-media" }]), ReferenceMentionError);
  assert.throws(() => resolveReferenceMentions(encodeReferenceMention("same"), [entry("same"), entry("same")]), ReferenceMentionError);
});

test("encoding escapes punctuation, brackets, percent, Unicode and HTML-like keys", () => {
  const key = 'stored:你好%:[] /<img src=x onerror=alert(1)>:0';
  const token = encodeReferenceMention(key);
  assert.ok(!token.includes("<img"));
  assert.deepEqual(parseReferenceMentions(token), [{ type: "reference", key, raw: token }]);
  assert.equal(resolveReferenceMentions(token, [entry(key)]).mentions[0].key, key);
});

test("ordinary prose, manual labels, malformed and foreign syntax remain byte-for-byte", () => {
  const prose = '你好 @图1\n[[other:abc]] [[lr-ref:bad%ZZ]] [[lr-ref:]] [[lr-ref:raw space]] <b>literal</b> %20';
  assert.equal(resolveReferenceMentions(prose, []).prompt, prose);
  assert.deepEqual(parseReferenceMentions(""), []);
  const mixed = prose + encodeReferenceMention("edge:ok") + "\nend";
  assert.equal(resolveReferenceMentions(mixed, [entry("edge:ok")]).prompt, prose + "@图1\nend");
});

test("compiler maps mentioned identity to actual media ordinal and context aliases without note titles", async () => {
  const { compileMentionedPrompt, validateReferenceMentions } = await import("../src/core/canvas/referenceMentions.ts");
  const a = entry("image-a"), b = entry("image-b"), note = entry("note", "note", "promptContext");
  note.reference.label = "PRIVATE TITLE";
  note.reference.text = "Exact note body";
  const output = compileMentionedPrompt(`${encodeReferenceMention(a.key)} ${encodeReferenceMention(note.key)}`, [b, a, note]);
  assert.ok(output.prompt.includes("@图2：本次输入的第2张图片"));
  assert.equal(output.referenceAliases[2], "@文本1");
  assert.ok(!output.prompt.includes("Exact note body"));
  assert.ok(!output.prompt.includes("PRIVATE TITLE"));
  assert.equal(output.references[1].id, a.reference.id);
  assert.equal(compileMentionedPrompt(" ordinary \n", [a]).prompt, " ordinary \n");
  assert.equal(validateReferenceMentions(encodeReferenceMention("gone"), [a])?.reason, "missing");
  assert.equal(validateReferenceMentions("ordinary", [a]), null);
});

test("copy and workflow remapping changes exact token identities only", async () => {
  const { remapReferenceMentions } = await import("../src/core/canvas/referenceMentions.ts");
  const original = `edge:a @图1 ${encodeReferenceMention("edge:a")} ${encodeReferenceMention("edge:b")} ${encodeReferenceMention("edge:a")}`;
  const portable = remapReferenceMentions(original, new Map([["edge:a", "workflow-edge:n1:n2"]]));
  assert.equal(portable, `edge:a @图1 ${encodeReferenceMention("workflow-edge:n1:n2")} ${encodeReferenceMention("edge:b")} ${encodeReferenceMention("workflow-edge:n1:n2")}`);
  const copied = remapReferenceMentions(portable, new Map([["workflow-edge:n1:n2", "new-edge"]]));
  assert.deepEqual(parseReferenceMentions(copied).filter(part => part.type === "reference").map(part => part.key), ["new-edge", "edge:b", "new-edge"]);
  assert.throws(() => resolveReferenceMentions(copied, [entry("new-edge")]), ReferenceMentionError);
});

 test("native canvas persistence retains tokens, stored keys and drag order", async () => {
  const {sanitizeCanvasNodesForPersistence}=await import("../src/features/canvas/canvasPersistence.ts");
  const value={id:"target",selected:true,data:{kind:"generator",generationPrompt:encodeReferenceMention("keep"),generationInputOrder:["keep","other"],generationReferences:[{id:"asset",kind:"image",mentionKey:"keep",role:"reference",mediaUrl:"/asset.png"}]}};
  const restored=JSON.parse(JSON.stringify(sanitizeCanvasNodesForPersistence([value])))[0];
  assert.equal(restored.data.generationPrompt,value.data.generationPrompt);
  assert.deepEqual(restored.data.generationInputOrder,["keep","other"]);
  assert.equal(restored.data.generationReferences[0].mentionKey,"keep");
  assert.equal(restored.selected,undefined);
 });

test("focus tokens serialize escaped object names and preserve exact normalized coordinates", async () => {
  const { encodeFocusReferenceMention } = await import("../src/core/canvas/referenceMentions.ts");
  const focus = { label: '猫 "甲" % [] <img onerror=x> 🐈', x: 0, y: 1 };
  const key = 'edge:图%[]';
  const token = encodeFocusReferenceMention(key, focus);
  assert.ok(!token.includes("<img"));
  assert.deepEqual(parseReferenceMentions(token), [{ type: "reference", key, raw: token, focus }]);
  assert.deepEqual(parseReferenceMentions(JSON.parse(JSON.stringify(token))), parseReferenceMentions(token));
});

test("focus compilation pins selected objects to actual media order without duplicating source images", async () => {
  const { encodeFocusReferenceMention, compileMentionedPrompt } = await import("../src/core/canvas/referenceMentions.ts");
  const a = entry("a"), b = entry("b");
  const first = { label: "人物", x: 0.2, y: 0.3 }, second = { label: "人物", x: 0.8, y: 0.9 };
  const prompt = `${encodeFocusReferenceMention("a", first)} and ${encodeFocusReferenceMention("b", first)} then ${encodeFocusReferenceMention("a", second)}`;
  const result = compileMentionedPrompt(prompt, [b, a], { kind: "image" });
  assert.equal(result.references.length, 2);
  assert.deepEqual(result.mentions.map(m => [m.key, m.label, m.focus]), [["a", "@图2", first], ["b", "@图1", first], ["a", "@图2", second]]);
  assert.match(result.prompt, /@图2中的对象"人物"（归一化位置 x=0.2, y=0.3/);
  assert.match(result.prompt, /@图2中的对象"人物"（归一化位置 x=0.8, y=0.9/);
  assert.match(result.prompt, /@图2：本次输入的第2张图片/);
  assert.equal(result.prompt.match(/@图2：/g)?.length, 1);
  assert.ok(!result.prompt.includes("lr-focus:") && !result.prompt.includes("%7B"));
  assert.equal(compileMentionedPrompt(prompt, [a, b]).mentions[0].label, "@图1");
});

test("malformed, oversized, noncanonical and non-image focus mentions fail closed", async () => {
  const { encodeFocusReferenceMention, validateReferenceMentions, compileMentionedPrompt } = await import("../src/core/canvas/referenceMentions.ts");
  const focus = { label: "Cat", x: 0.5, y: 0.5 };
  const token = encodeFocusReferenceMention("a", focus);
  const raw = (data: unknown) => `[[lr-focus:${encodeURIComponent(JSON.stringify(data))}]]`;
  for (const bad of ["[[lr-focus:", "[[lr-focus:]]", "[[lr-focus:bad%ZZ]]", raw(null), raw({ key: "a", ...focus, x: 2 }), raw({ key: "a", ...focus, y: "0.5" }), raw({ key: "a", ...focus, label: " " }), raw({ key: "a", ...focus, label: "a".repeat(257) }), raw({ key: "a", ...focus, extra: true }), raw({ ...focus, key: "a" }), `[[lr-focus:${"x".repeat(24001)}]]`]) {
    assert.equal(validateReferenceMentions(bad, [entry("a")])?.reason, "invalid", bad.slice(0, 100));
    assert.throws(() => compileMentionedPrompt(bad, [entry("a")]), ReferenceMentionError);
  }
  for (const invalid of [{ ...focus, x: NaN }, { ...focus, y: Infinity }, { ...focus, x: -1 }, { ...focus, label: "\n" }]) assert.throws(() => encodeFocusReferenceMention("a", invalid));
  assert.equal(validateReferenceMentions(token, [])?.reason, "missing");
  assert.equal(validateReferenceMentions(token, [entry("a", "video")])?.reason, "invalid");
  assert.equal(validateReferenceMentions(token, [{ ...entry("a"), usage: "label-only" }])?.reason, "invalid");
  const noMedia = entry("a"); noMedia.reference.mediaUrl = "";
  assert.equal(validateReferenceMentions(token, [noMedia])?.reason, "invalid");
  assert.throws(() => compileMentionedPrompt(token, [entry("a")], { kind: "text" }), ReferenceMentionError);
});

test("focus remapping retains object metadata and unmapped identity", async () => {
  const { encodeFocusReferenceMention, remapReferenceMentions } = await import("../src/core/canvas/referenceMentions.ts");
  const focus = { label: "蓝色杯子", x: 0.125, y: 0.98765 };
  const original = `${encodeFocusReferenceMention("old", focus)} / ${encodeFocusReferenceMention("unmapped", focus)}`;
  assert.equal(remapReferenceMentions(original, new Map([["old", "new"]])), `${encodeFocusReferenceMention("new", focus)} / ${encodeFocusReferenceMention("unmapped", focus)}`);
});
