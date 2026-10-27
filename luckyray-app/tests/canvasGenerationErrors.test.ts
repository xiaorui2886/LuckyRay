import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { canvasGenerationFailure, canvasGenerationTaskError } from "../src/core/canvas/generationErrors.ts";
import { createCanvasImageGenerationAdapter } from "../src/core/canvas/imageGenerationAdapter.ts";
import { createCanvasVideoGenerationAdapter } from "../src/core/canvas/videoGenerationAdapter.ts";

const request = { kind: "image" as const, model: "synthetic-image", prompt: "synthetic", references: [] };
const privateText = "synthetic-private-prompt https://private.invalid/path?key=synthetic-secret";
test("native string, structured and serialized rejections retain safe distinct error kinds", () => {
  for (const [input, kind] of [
    ["moderation_blocked", "moderation_blocked"],
    [{ error: { code: "moderation_blocked", message: privateText } }, "moderation_blocked"],
    [JSON.stringify({ code: "unsupported_endpoint", message: privateText }), "unsupported_protocol"],
    [new Error("unauthorized"), "unauthorized"],
    ["rate_limited", "rate_limited"], ["connection", "connection"],
    [{ error_kind: "model_unavailable", error_message: privateText }, "model_unavailable"],
    ["canvas-media-profile-missing", "profile_changed"],
    [new Error(privateText), "provider_error"],
    [{ error_kind: "constructor", error_message: privateText }, "provider_error"],
  ] as const) {
    const failure = canvasGenerationFailure(input);
    assert.equal(failure.error_kind, kind);
    assert.equal(failure.error_detail, null);
    assert.ok(!JSON.stringify(failure).includes(privateText));
  }
});
test("safety and configuration failures are not offered as transient retryable errors", () => {
  for (const kind of ["moderation_blocked", "unsupported_protocol", "unsupported_model_protocol", "model_unavailable", "invalid_request", "unauthorized"]) {
    assert.equal(canvasGenerationTaskError("image", kind).retryable, false);
  }
  assert.equal(canvasGenerationTaskError("image", "moderation_blocked").code, "IMAGE_CONTENT_BLOCKED");
  assert.equal(canvasGenerationTaskError("video", "unsupported_protocol").code, "VIDEO_PROTOCOL_UNSUPPORTED");
});
test("image and video adapters sanitize failed responses and thrown host errors without fallback", async () => {
  for (const media of ["image", "video"] as const) {
    for (const reject of [false, true]) {
      let calls = 0;
      const generate = async () => {
        calls++;
        const error = { error_kind: "moderation_blocked", error_message: privateText, error_detail: privateText };
        if (reject) throw error;
        return { success: false, ...error };
      };
      const adapter = media === "image" ? createCanvasImageGenerationAdapter(generate) : createCanvasVideoGenerationAdapter(generate);
      const result = await adapter.execute({ ...request, kind: media });
      assert.equal(calls, 1);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, `${media.toUpperCase()}_CONTENT_BLOCKED`);
        assert.equal(result.error.retryable, false);
        assert.equal(result.error.detail, undefined);
        assert.ok(!JSON.stringify(result).includes(privateText));
      }
    }
  }
});
test("App image invoke rejection and response both preserve safe error classifications", async () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function aiImageGenerate("), source.indexOf("async function aiVideoGenerate("));
  const code = transformSync(body, { loader: "ts", format: "cjs", target: "es2022" }).code;
  for (const reject of [true, false]) {
    const run = Function("invoke", "prepareCanvasMediaReference", "materializeCanvasGeneratedImage", "canvasGenerationFailure", code + ";return aiImageGenerate;")(
      async () => { if (reject) throw "moderation_blocked"; return { success: false, error_kind: "unsupported_protocol", error_message: privateText }; },
      async (v: string) => v, async (v: string) => v, canvasGenerationFailure,
    );
    const result = await run(request);
    assert.equal(result.error_kind, reject ? "moderation_blocked" : "unsupported_protocol");
    assert.ok(!JSON.stringify(result).includes(privateText));
  }
});
test("App video invoke retains rejection kind and never returns raw provider diagnostics", async () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function aiVideoGenerate("), source.indexOf("async function prepareCanvasMediaReference("));
  const code = transformSync(body, { loader: "ts", format: "cjs", target: "es2022" }).code;
  for (const reject of [true, false]) {
    const run = Function("invoke", "prepareCanvasMediaReference", "canvasGenerationFailure", code + ";return aiVideoGenerate;")(
      async () => { if (reject) throw { code: "rate_limited", message: privateText }; return { success: false, error_kind: "unauthorized", error_message: privateText }; },
      async (v: string) => v, canvasGenerationFailure,
    );
    const result = await run({ ...request, kind: "video" });
    assert.equal(result.error_kind, reject ? "rate_limited" : "unauthorized");
    assert.ok(!JSON.stringify(result).includes(privateText));
  }
});

test("limit copy includes quota uncertainty and provider failures do not claim user frequency", () => {
  assert.match(canvasGenerationFailure('rate_limited').error_message, /额度/);
  assert.doesNotMatch(canvasGenerationFailure('provider_error').error_message, /过于频繁|额度耗尽/);
});
