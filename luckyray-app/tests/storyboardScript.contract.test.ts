import assert from "node:assert/strict";
import test from "node:test";
import { parseStoryboardScript, SCRIPT_TEXT_LIMIT, validateScriptShots } from "../src/core/canvas/storyboardScript.ts";
import { buildStoryboardPrompt } from "../src/core/canvas/storyboard.ts";

test("Chinese numbered Markdown and English headings map explicit fields", () => {
  const result = parseStoryboardScript("# 春日广告\n说明：保留原文\n## 1. 镜头 1：开场\n**画面：** 阳光下的街道\n- 动作：缓慢推进\n台词：你好。\n时长：2.5 秒\n景别：远景\n### Shot 2: Arrival\nVisual: A red car\nAction: Pan left\nDialogue: Hello\nDuration: 3 seconds\nFraming: close-up");
  assert.equal(result.shots.length, 2);
  assert.deepEqual(result.shots[0], { title: "开场", description: "阳光下的街道", action: "缓慢推进", dialogue: "你好。", durationSeconds: 2.5, framing: "wide" });
  assert.equal(result.shots[1].framing, "close");
  assert.equal(result.shots[1].title, "Arrival");
  assert.deepEqual(result.defaultDurationIndexes, []);
  assert.equal(result.sourcePreamble, "# 春日广告\n说明：保留原文");
});

test("paragraph fallback preserves prose but never invents speech or duration", () => {
  const result = parseStoryboardScript("# Source name\n\nA woman waits.\nRain falls.\n\nA bus arrives.");
  assert.equal(result.shots.length, 2);
  assert.equal(result.shots[0].description, "A woman waits.\nRain falls.");
  assert.equal(result.shots[0].dialogue, "");
  assert.equal(result.shots[0].durationSeconds, 5);
  assert.deepEqual(result.defaultDurationIndexes, [0, 1]);
  assert.deepEqual(result.defaultFramingIndexes, [0, 1]);
  assert.equal(result.sourcePreamble, "# Source name");
});

test("multiline dialogue and unknown description lines survive parsing", () => {
  const result = parseStoryboardScript("Shot 1: Conversation\nVisual: Kitchen\nSound: Rain\nDialogue: Anna: Hello.\nBen: Hi.\nAnother line.\nAction: She turns.\nNotes: Hold the camera.");
  assert.equal(result.shots[0].description, "Kitchen\nSound: Rain\nNotes: Hold the camera.");
  assert.equal(result.shots[0].dialogue, "Anna: Hello.\nBen: Hi.\nAnother line.");
  assert.equal(result.shots[0].action, "She turns.");
});

test("title and dialogue are not copied into a visual prompt", () => {
  const parsed = parseStoryboardScript("# Source secret name\nShot 1: Shot name\nVisual: A bridge\nDialogue: Spoken words");
  const prompt = buildStoryboardPrompt({ id: "s", data: { kind: "generator", storyboardShot: { ...parsed.shots[0], version: 1, order: 0 } } }, true);
  assert.match(prompt, /A bridge/);
  assert.doesNotMatch(prompt, /secret|Shot name|Spoken words/);
});

test("invalid explicit times and framings fail visibly, never silently default", () => {
  for (const value of ["0", "-1", "3601", "5 minutes", "NaN", "Infinity", "", "1:30", "3s trailing"]) {
    assert.throws(() => parseStoryboardScript(`Shot 1\nVisual: Room\nDuration: ${value}`), /invalid-duration:1/);
  }
  for (const value of ["0.1", "3600"]) assert.equal(parseStoryboardScript(`Shot 1\nVisual: Room\nDuration: ${value}`).shots[0].durationSeconds, Number(value));
  assert.throws(() => parseStoryboardScript("Shot 1\nVisual: Room\nFraming: unknown"), /invalid-framing/);
});

test("empty, excessive, and invalid-capacity imports are rejected without truncation", () => {
  for (const value of ["", " \n ", "# Only source title", "Shot 1: Only title", "Shot 1\nDuration: 5"]) assert.throws(() => parseStoryboardScript(value), /empty/);
  assert.throws(() => parseStoryboardScript("x".repeat(SCRIPT_TEXT_LIMIT + 1)), /script-too-long/);
  assert.equal(parseStoryboardScript(Array.from({ length: 64 }, (_, i) => `Shot ${i + 1}\nVisual: Room`).join("\n")).shots.length, 64);
  assert.throws(() => parseStoryboardScript(Array.from({ length: 65 }, (_, i) => `Shot ${i + 1}\nVisual: Room`).join("\n")), /shot-limit/);
  assert.throws(() => parseStoryboardScript("One\n\nTwo", 1), /shot-limit/);
  assert.throws(() => parseStoryboardScript("One", 0), /shot-limit/);
  for (const capacity of [-1, 65, 1.5, NaN]) assert.throws(() => parseStoryboardScript("One", capacity), /invalid-capacity/);
});

test("edited previews retain strict field and content limits", () => {
  const shot = parseStoryboardScript("A room").shots[0];
  for (const patch of [{ title: "x".repeat(101) }, { description: "x".repeat(4001) }, { action: "x".repeat(2001) }, { dialogue: "x".repeat(2001) }, { durationSeconds: NaN }, { durationSeconds: 0 }]) {
    assert.throws(() => validateScriptShots([{ ...shot, ...patch }]), /invalid-shot/);
  }
  assert.throws(() => validateScriptShots([{ ...shot, description: " " }]), /empty-shot/);
  assert.throws(() => validateScriptShots([]), /empty-script/);
  validateScriptShots([{ ...shot, title: "x".repeat(100), description: "x".repeat(4000), action: "x".repeat(2000), dialogue: "x".repeat(2000) }]);
});

test("export-style Chinese and English labels keep speech and sound out of visuals", () => {
  const parsed = parseStoryboardScript("## 分镜 1：雨夜\n画面描述：雨中的屋檐\n动作 / 运镜：缓缓拉远\n台词 / 旁白：我们回来了。\n旁白：夜深了。\n环境声：雨声\n音效：钟声\n时长：6秒\n景别：全景\n## Shot 2: Dawn\nVisual description: A quiet room\nAction / camera: Pan right\nDialogue / narration: The next morning.");
  assert.equal(parsed.shots.length, 2);
  assert.equal(parsed.shots[0].description, "雨中的屋檐");
  assert.equal(parsed.shots[0].action, "缓缓拉远");
  assert.equal(parsed.shots[0].dialogue, "我们回来了。\n夜深了。\n雨声\n钟声");
  assert.equal(parsed.shots[1].description, "A quiet room");
  assert.equal(parsed.shots[1].action, "Pan right");
  assert.equal(parsed.shots[1].dialogue, "The next morning.");
  const prompt = buildStoryboardPrompt({ id: "s", data: { kind: "generator", storyboardShot: { ...parsed.shots[0], version: 1, order: 0 } } });
  assert.doesNotMatch(prompt, /我们回来了|夜深了|雨声|钟声/);
  assert.deepEqual(parsed.defaultDurationIndexes, [1]);
});
