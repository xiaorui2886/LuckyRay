import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function source(path) {
  return readFile(resolve(appRoot, path), "utf8");
}

test("frozen pi-ai resolves image capability per exact model before catalog and provider defaults", async () => {
  const [adapter, packageJson] = await Promise.all([
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"),
    source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-llm-pi-ai/package.json"),
  ]);

  assert.equal(JSON.parse(packageJson).version, "0.1.5-rc.2");
  assert.match(
    adapter,
    /input:\s*declaredInput\(entry\.input\)\s*\?\?\s*base\?\.input\s*\?\?\s*\[\.\.\.request\.defaultInput\]/u,
    "one model entry must override catalog and route defaults without widening its provider siblings",
  );
  assert.match(adapter, /inputModalities:\s*\[\.\.\.resolvedModel\.input\]/u);
  assert.match(
    adapter,
    /containsImage\s*&&\s*!model\.input\.includes\("image"\)[\s\S]*?"UNSUPPORTED_CONTENT"/u,
    "text-only models must continue to reject image content at the official adapter boundary",
  );
});

test("official Host image admission consumes the adapter-owned exact-model modalities", async () => {
  // 0.1.5 moved the API session controller admission out of the retired
  // dsh-host-apiproxy package; the exact-model modality gate is unchanged.
  const hostApi = await source("src-tauri/dsh/host/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js");

  assert.match(
    hostApi,
    /\.inputModalities\s*!==\s*void 0\s*&&\s*!\w+\.inputModalities\.includes\("image"\)/u,
  );
  assert.match(hostApi, /reason:\s*"MODEL_DOES_NOT_SUPPORT_IMAGES"/u);
  assert.doesNotMatch(hostApi, /mimo-v2\.5|b-ai/u, "Host admission stays provider- and model-name neutral");
});
